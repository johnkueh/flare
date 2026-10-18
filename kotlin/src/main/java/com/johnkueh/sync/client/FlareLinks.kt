package com.johnkueh.sync.client

import android.content.Context
import android.content.Intent
import android.net.Uri
import java.net.URLDecoder
import java.net.URLEncoder
import kotlin.coroutines.resume
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/** A link the app understands (`LINKS.md`): its kind from links.json, the
 *  parts of its path, and the canonical https URL. */
data class FlareLink(val kind: String, val params: Map<String, String>, val url: String) {
    operator fun get(param: String): String? = params[param]
}

/**
 * Links that open the app (`@flare/links`), the Kotlin side of the Swift
 * package's `FlareLinks`: reads the ones the app is opened with, makes new
 * ones to share, and picks up the one someone tapped before installing.
 *
 * On Android the link from before the install comes through Google Play's
 * Install Referrer, with no tap. The app adds
 * `com.android.installreferrer:installreferrer` itself.
 *
 * ```kotlin
 * val links = FlareLinks(context, context.assets.open("links.json").reader().readText())
 * links.opened(intent)?.let(router::open)                    // onCreate, onNewIntent
 * scope.launch { links.claimDeferred()?.let(router::open) }  // first launch
 * ```
 */
class FlareLinks(
    context: Context,
    linksJson: String,
    name: String = "flare.links",
    private val onEvent: ((String, Map<String, String>) -> Unit)? = null,
) {
    private val appContext = context.applicationContext
    private val prefs = appContext.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val parser = FlareLinkParser(linksJson)

    val domain: String get() = parser.domain

    private val _mayHavePendingLink = MutableStateFlow(parser.hasDeferred && !prefs.getBoolean(SETTLED, false))
    /** True until a link is claimed or [settle] is called. */
    val mayHavePendingLink: StateFlow<Boolean> = _mayHavePendingLink.asStateFlow()

    /** The link a URL points at: https on the links domain (or www.), or
     *  `<scheme>://link?url=…` from the landing page's Open button. */
    fun link(url: String): FlareLink? = parser.parse(url)

    /** The link in some text ("Join Flat on Cooked: https://…"), or null. */
    fun linkIn(text: String): FlareLink? = parser.find(text)

    /** For onCreate and onNewIntent: the link the app was opened with, also
     *  reported as `link_opened`. */
    fun opened(intent: Intent?): FlareLink? {
        val data: Uri = intent?.data ?: return null
        val link = parser.parse(data.toString()) ?: return null
        onEvent?.invoke("link_opened", mapOf("kind" to link.kind))
        settle()
        return link
    }

    /** The https link for a kind and its parts. */
    fun url(kind: String, params: Map<String, String>): String = parser.url(kind, params)

    /**
     * The link tapped before this install, from Google Play's Install
     * Referrer, once: later calls return null. Null too when the app wasn't
     * installed from Play, or the referrer library isn't in the app.
     */
    suspend fun claimDeferred(): FlareLink? {
        if (!_mayHavePendingLink.value) return null
        val referrer = withTimeoutOrNull(5_000) { installReferrer() } ?: return null
        val link = parseReferrer(referrer)?.let(parser::parse)
        settle()
        if (link != null) onEvent?.invoke("link_deferred_claimed", mapOf("kind" to link.kind, "via" to "referrer"))
        return link
    }

    /** The link in pasted text, for an app that also offers a paste. */
    fun claim(pasted: String): FlareLink? {
        val link = parser.find(pasted) ?: return null
        onEvent?.invoke("link_deferred_claimed", mapOf("kind" to link.kind, "via" to "paste"))
        settle()
        return link
    }

    /** Stop looking for a link from before the install. */
    fun settle() {
        if (!_mayHavePendingLink.value) return
        _mayHavePendingLink.value = false
        prefs.edit().putBoolean(SETTLED, true).apply()
    }

    private suspend fun installReferrer(): String? = try {
        suspendCancellableCoroutine { cont ->
            val client = com.android.installreferrer.api.InstallReferrerClient.newBuilder(appContext).build()
            client.startConnection(object : com.android.installreferrer.api.InstallReferrerStateListener {
                override fun onInstallReferrerSetupFinished(responseCode: Int) {
                    val value = if (responseCode == com.android.installreferrer.api.InstallReferrerClient.InstallReferrerResponse.OK) {
                        runCatching { client.installReferrer.installReferrer }.getOrNull()
                    } else {
                        null
                    }
                    runCatching { client.endConnection() }
                    if (cont.isActive) cont.resume(value)
                }

                override fun onInstallReferrerServiceDisconnected() {
                    if (cont.isActive) cont.resume(null)
                }
            })
            cont.invokeOnCancellation { runCatching { client.endConnection() } }
        }
    } catch (_: NoClassDefFoundError) {
        null // the app didn't add the installreferrer library
    }

    companion object {
        private const val SETTLED = "settled"

        /** The query key the Play referrer carries the link under. */
        const val REFERRER_KEY = "flare_link"

        /** `flare_link=https%3A…` (Play's referrer string) → the link URL. */
        fun parseReferrer(referrer: String): String? = referrer.split("&").firstNotNullOfOrNull { pair ->
            val (key, value) = pair.split("=", limit = 2).let { it[0] to it.getOrNull(1) }
            if (key == REFERRER_KEY && value != null) URLDecoder.decode(value, "UTF-8") else null
        }
    }
}

/** The same rules as `@flare/links` and the Swift package, without Android
 *  types, so they run anywhere. */
class FlareLinkParser(linksJson: String) {
    private class Kind(val path: String, val deferred: Boolean)

    val domain: String
    private val scheme: String?
    private val kinds: Map<String, Kind>

    init {
        val root = Json.parseToJsonElement(linksJson).jsonObject
        domain = root.getValue("domain").jsonPrimitive.content.lowercase()
        scheme = root["scheme"]?.jsonPrimitive?.content?.lowercase()
        kinds = root.getValue("links").jsonObject.entries.sortedBy { it.key }.associate { (kind, value) ->
            val obj = value.jsonObject
            kind to Kind(obj.getValue("path").jsonPrimitive.content, obj["deferred"]?.jsonPrimitive?.booleanOrNull == true)
        }
    }

    val hasDeferred: Boolean get() = kinds.values.any { it.deferred }

    fun parse(url: String): FlareLink? {
        val uri = runCatching { java.net.URI(url) }.getOrNull() ?: return null
        val protocol = uri.scheme?.lowercase() ?: return null
        if (scheme != null && protocol == scheme) {
            if (uri.host != "link") return null
            val inner = uri.rawQuery?.split("&")?.firstNotNullOfOrNull { pair ->
                val parts = pair.split("=", limit = 2)
                if (parts[0] == "url" && parts.size == 2) URLDecoder.decode(parts[1], "UTF-8") else null
            } ?: return null
            return parse(inner)
        }
        if (protocol != "https" && protocol != "http") return null
        val host = uri.host?.lowercase() ?: return null
        if (host != domain && host != "www.$domain") return null
        val got = segments(uri.rawPath ?: "")
        for ((kind, pattern) in kinds) {
            val want = segments(pattern.path)
            if (want.size != got.size) continue
            val params = mutableMapOf<String, String>()
            var matches = true
            for ((part, raw) in want.zip(got)) {
                val value = runCatching { URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8") }.getOrNull()
                if (value.isNullOrEmpty()) { matches = false; break }
                if (part.startsWith(":")) params[part.drop(1)] = value
                else if (part != value) { matches = false; break }
            }
            if (matches) return FlareLink(kind, params, url(kind, params))
        }
        return null
    }

    fun find(text: String): FlareLink? = text.split(Regex("\\s+"))
        .filter { "://" in it }
        .firstNotNullOfOrNull { parse(it.trim(')', '.', ',', ';', '!', '?', '"', '\'', '<', '>')) }

    fun url(kind: String, params: Map<String, String>): String {
        val pattern = requireNotNull(kinds[kind]) { "no link kind \"$kind\" in links.json" }
        val path = segments(pattern.path).joinToString("/") { part ->
            if (!part.startsWith(":")) return@joinToString part
            val value = params[part.drop(1)]
            require(!value.isNullOrEmpty()) { "link \"$kind\" needs $part" }
            URLEncoder.encode(value, "UTF-8").replace("+", "%20")
        }
        return "https://$domain/$path"
    }

    private fun segments(path: String) = path.split("/").filter { it.isNotEmpty() }
}
