package com.johnkueh.sync.client

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Build
import android.os.Bundle
import com.johnkueh.sync.ffi.FlagStore
import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Feature flags from the app's `flags.json`, evaluated by Cloudflare
 * Flagship through the app's Worker (`@flare/flags`).
 *
 * Apply Flare's `flare-flags.gradle` in the app module and each flag
 * becomes a typed property (`flags.newCheckout`), generated on every
 * build. Start it once, in `Application.onCreate`:
 *
 * ```kotlin
 * val flags = Flags.start(this, "https://api.example.com")
 * if (flags.newCheckout) …
 * ```
 *
 * Reads never wait and never fail: the last values the server sent (kept
 * on disk), else the defaults in flags.json. It refreshes when it starts,
 * when the app comes to the foreground and every few minutes. A flag the
 * app has read keeps its value until the app next comes to the foreground,
 * so a screen doesn't change under the user; flags marked `"live": true`
 * change at once. In Compose, `flags.flow { newCheckout }.collectAsState(flags.newCheckout)`
 * redraws when a flag changes.
 */
class Flags(
    context: Context,
    server: String,
    schemaJson: String,
    user: String? = null,
    private val options: Options = Options(),
) {
    data class Options(
        /** How often to refresh while the app is open, in ms (0: only on
         *  launch, foreground and [refresh]). */
        val refreshIntervalMs: Long = 5 * 60_000L,
        /** Extra headers on each request, such as Authorization. */
        val headers: suspend () -> Map<String, String> = { emptyMap() },
        /** Extra attributes for targeting. Platform, app version, OS version
         *  and locale are sent already. */
        val context: Map<String, String> = emptyMap(),
        /** Mounted under a prefix on the Worker, such as "/v1". */
        val prefix: String = "",
        val http: OkHttpClient? = null,
    )

    /** The generated `Flags.start(context, server)` hangs off this. */
    companion object {}

    private val app = context.applicationContext
    private val store = FlagStore.open(schemaJson, File(app.filesDir, "flare/flags.json").path, user)
    private val endpoint = server.trimEnd('/') + options.prefix + "/ofrep/v1/evaluate/flags"
    private val http = options.http ?: OkHttpClient.Builder().callTimeout(15, TimeUnit.SECONDS).build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val lock = Mutex()
    private var inflight: Deferred<List<String>>? = null
    private var ticker: Job? = null

    private val _revision = MutableStateFlow(0L)
    /** Bumped when any value changes. */
    val revision: StateFlow<Long> = _revision.asStateFlow()

    private val _changes = MutableSharedFlow<List<String>>(extraBufferCapacity = 16)
    /** The flags whose values changed, as they change. */
    val changes: SharedFlow<List<String>> = _changes.asSharedFlow()

    /** When the Worker last answered (ms since 1970), or null. */
    val fetchedAt: Long? get() = store.fetchedAt()?.toLong()

    /** Why the last refresh failed, or null. */
    @Volatile var lastError: Throwable? = null
        private set

    /** The id flags are evaluated for: the user, else this install. */
    val identity: String get() = store.identity()

    init {
        watchForeground()
        scope.launch { refresh() }
    }

    // reads (the generated properties call these)

    fun bool(key: String): Boolean = store.boolValue(key)

    fun int(key: String): Int = store.intValue(key).toInt()

    fun double(key: String): Double = store.numberValue(key)

    fun string(key: String): String = store.stringValue(key)

    fun json(key: String): FlagJson = FlagJson(store.valueJson(key) ?: "null")

    /** Every flag's value as JSON, without holding any (for a debug screen). */
    val snapshot: String get() = store.snapshotJson()

    /** [read] now and whenever a flag changes: `flags.flow { newCheckout }`. */
    fun <T> flow(read: Flags.() -> T): Flow<T> = revision.map { read() }.distinctUntilChanged()

    // updates

    /** Asks the Worker for fresh values; returns the flags that changed.
     *  Offline or a server error keeps the values you have (see [lastError]). */
    suspend fun refresh(): List<String> {
        val job = lock.withLock { inflight ?: scope.async { fetch() }.also { inflight = it } }
        return try {
            job.await()
        } finally {
            lock.withLock { if (inflight === job) inflight = null }
        }
    }

    /** Lets flags that were read take their latest values. Called when the
     *  app comes to the foreground; call it yourself at other safe moments. */
    fun activate(): List<String> = store.activate().also(::publish)

    /** Evaluates for a signed-in user from now on (null: this install, after
     *  signing out). Values go back to their defaults until the user's
     *  arrive, which apply at once. */
    suspend fun setUser(user: String?) {
        lock.withLock { inflight }?.await()
        publish(store.setUser(user))
        refresh()
    }

    /** Stops refreshing. */
    fun close() {
        scope.coroutineContext[Job]?.cancel()
    }

    private suspend fun fetch(): List<String> = withContext(Dispatchers.IO) {
        try {
            val context = buildJsonObject {
                for ((k, v) in deviceContext() + options.context) put(k, JsonPrimitive(v))
            }
            val asked = store.identity()
            val request = Request.Builder()
                .url(endpoint)
                .post(store.requestBody(context.toString()).toRequestBody("application/json".toMediaType()))
                .apply {
                    store.etag()?.let { header("If-None-Match", it) }
                    for ((k, v) in options.headers()) header(k, v)
                }
                .build()
            http.newCall(request).execute().use { response ->
                // Signed in or out meanwhile: this answer is for someone else.
                if (asked != store.identity()) return@withContext emptyList()
                val body = if (response.code == 200) response.body?.string().orEmpty() else ""
                val changed = store.applyResponse(response.code.toUShort(), response.header("ETag"), body)
                lastError = null
                publish(changed)
                changed
            }
        } catch (e: Exception) {
            lastError = e
            emptyList()
        }
    }

    private fun publish(changed: List<String>) {
        if (changed.isEmpty()) return
        _revision.value += 1
        _changes.tryEmit(changed)
    }

    private fun deviceContext(): Map<String, String> = buildMap {
        put("platform", "android")
        put("osVersion", Build.VERSION.RELEASE ?: "")
        put("locale", Locale.getDefault().toLanguageTag())
        runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull()?.let { put("appVersion", it) }
    }

    /** Foreground = at least one activity started. Coming back: activate,
     *  refresh, and tick while open. */
    private fun watchForeground() {
        val application = app as? Application ?: return
        application.registerActivityLifecycleCallbacks(object : Application.ActivityLifecycleCallbacks {
            private var started = 0

            override fun onActivityStarted(activity: Activity) {
                if (started++ > 0) return
                activate()
                // Values that arrive within a moment of coming back still
                // count as this foreground's; later ones wait for the next.
                val start = System.nanoTime()
                scope.launch {
                    refresh()
                    if (System.nanoTime() - start < 2_000_000_000L) activate()
                }
                if (options.refreshIntervalMs > 0) {
                    ticker = scope.launch {
                        while (isActive) {
                            delay(options.refreshIntervalMs)
                            refresh()
                        }
                    }
                }
            }

            override fun onActivityStopped(activity: Activity) {
                if (--started > 0) return
                ticker?.cancel()
                ticker = null
            }

            override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
            override fun onActivityResumed(activity: Activity) {}
            override fun onActivityPaused(activity: Activity) {}
            override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(activity: Activity) {}
        })
    }
}

/** An object or array flag. Decode it into your own @Serializable type:
 *  `flags.paywall.decode<Paywall>()`. */
class FlagJson(val text: String) {
    val element: JsonElement get() = FlagJsonFormat.parseToJsonElement(text)

    fun <T> decode(deserializer: DeserializationStrategy<T>): T? = runCatching { FlagJsonFormat.decodeFromString(deserializer, text) }.getOrNull()

    inline fun <reified T> decode(): T? = runCatching { FlagJsonFormat.decodeFromString<T>(text) }.getOrNull()

    override fun equals(other: Any?) = other is FlagJson && other.text == text

    override fun hashCode() = text.hashCode()

    override fun toString() = text
}

val FlagJsonFormat = Json { ignoreUnknownKeys = true }
