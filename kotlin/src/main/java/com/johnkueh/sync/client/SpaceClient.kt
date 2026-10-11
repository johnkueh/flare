package com.johnkueh.sync.client

import java.io.IOException
import java.net.URLEncoder
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener

// SpaceInfo, InvitePreview, NewSpace and JoinSpace are generated from the
// server's contract (WireTypes.kt).

val SpaceInfo.isOwner: Boolean get() = owner == you

/** The server refused a request. [code] is the protocol's (`NOT_MEMBER`,
 *  `NOT_FOUND`, `FULL`, …) or the app's own (`ATTESTATION_REQUIRED`). */
class SpaceServerException(val status: Int, val code: String, override val message: String?) : IOException(message ?: code) {
    /** Removed by the owner, or the space is gone. */
    val isGone: Boolean get() = code == "NOT_MEMBER" || code == "NOT_FOUND"
}

/** The bearer token every request carries. The app decides how a device
 *  proves itself (e.g. Android key attestation buys a token). */
interface SpaceTokens {
    suspend fun token(): String

    /** Forgets the token, so the next [token] gets a fresh one. */
    fun clear()
}

/** JSON as the server writes it. */
val SyncJson = Json {
    ignoreUnknownKeys = true
    explicitNulls = true
    encodeDefaults = true
}

/**
 * `/spaces` over HTTP (`PROTOCOL.md`, "HTTP"), the Kotlin side of the Swift
 * package's `SpaceClient`. A request that comes back `ATTESTATION_REQUIRED`
 * gets a fresh token and is tried once more.
 *
 * Every request says which device it's from (`X-Device-Platform`, and
 * `X-Device-Name` when [deviceName] is given), so a server with accounts can
 * list this phone under its user.
 */
class SpaceClient(
    baseUrl: String,
    private val tokens: SpaceTokens,
    private val platform: String = "android",
    private val http: OkHttpClient = defaultHttp(),
    private val deviceName: String? = null,
) {
    private val baseUrl = baseUrl.trimEnd('/')

    @Serializable private data class ErrorBody(val code: String, val message: String? = null)

    suspend fun create(name: String, deviceName: String): SpaceInfo =
        json("POST", "/spaces", SyncJson.encodeToString(NewSpace.serializer(), NewSpace(name, deviceName, platform)), SpaceInfo.serializer())

    suspend fun preview(code: String): InvitePreview = json("GET", "/invites/$code", null, InvitePreview.serializer())

    suspend fun join(spaceId: String, code: String, deviceName: String): SpaceInfo =
        json("POST", "/spaces/$spaceId/join", SyncJson.encodeToString(JoinSpace.serializer(), JoinSpace(code, deviceName, platform)), SpaceInfo.serializer())

    suspend fun info(spaceId: String): SpaceInfo = json("GET", "/spaces/$spaceId", null, SpaceInfo.serializer())

    suspend fun leave(spaceId: String) {
        text("POST", "/spaces/$spaceId/leave", "{}".toRequestBody(JSON))
    }

    /** `body` comes from `SyncStore.takePush()`; the answer goes to `ackPush`. */
    suspend fun push(spaceId: String, body: String): String = text("POST", "/spaces/$spaceId/push", body.toRequestBody(JSON))

    /** One page of changes, for `SyncStore.applyPull`. */
    suspend fun changes(spaceId: String, since: Long): String = text("GET", "/spaces/$spaceId/changes?since=$since", null)

    /** Stores a file under the hex SHA-256 of its bytes. */
    suspend fun putBlob(spaceId: String, hash: String, data: ByteArray, contentType: String = "image/jpeg") {
        text("PUT", "/spaces/$spaceId/blobs/$hash", data.toRequestBody(contentType.toMediaType()))
    }

    /** A file the space stored with [putBlob]. */
    suspend fun blob(spaceId: String, hash: String): ByteArray = call("GET", "/spaces/$spaceId/blobs/$hash", null) { it.bytes() }

    /** Opens the space's WebSocket, which sends `{"version": N}` after
     *  every push that changed something. */
    suspend fun live(spaceId: String, listener: WebSocketListener): WebSocket {
        val url = "$baseUrl/spaces/$spaceId/live".toHttpUrl()
        val request = Request.Builder().url(url).header("Authorization", "Bearer ${tokens.token()}").describeDevice().build()
        return http.newWebSocket(request, listener)
    }

    // Plumbing

    private fun Request.Builder.describeDevice(): Request.Builder {
        header("X-Device-Platform", platform)
        // Header values are ASCII; a name like "Zoë's Pixel" goes percent-encoded.
        if (deviceName != null) header("X-Device-Name", URLEncoder.encode(deviceName, "UTF-8").replace("+", "%20"))
        return this
    }

    private suspend fun <T> json(method: String, path: String, body: String?, serializer: KSerializer<T>): T =
        SyncJson.decodeFromString(serializer, text(method, path, body?.toRequestBody(JSON)))

    private suspend fun text(method: String, path: String, body: RequestBody?): String = call(method, path, body) { it.string() }

    private suspend fun <T> call(method: String, path: String, body: RequestBody?, read: (okhttp3.ResponseBody) -> T): T =
        withContext(Dispatchers.IO) {
            try {
                attempt(method, path, body, read)
            } catch (error: SpaceServerException) {
                if (error.code != "ATTESTATION_REQUIRED") throw error
                // The token expired or the server forgot it: get another, once.
                tokens.clear()
                attempt(method, path, body, read)
            }
        }

    private suspend fun <T> attempt(method: String, path: String, body: RequestBody?, read: (okhttp3.ResponseBody) -> T): T {
        val request = Request.Builder()
            .url(baseUrl + path)
            .header("Accept", "application/json")
            .header("Authorization", "Bearer ${tokens.token()}")
            .describeDevice()
            .method(method, body)
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val error = runCatching { SyncJson.decodeFromString(ErrorBody.serializer(), text) }.getOrNull()
                throw SpaceServerException(response.code, error?.code ?: "UNKNOWN", error?.message)
            }
            return read(response.body!!)
        }
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        fun defaultHttp(): OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            // Keeps the live socket open through NATs and notices a dead one.
            .pingInterval(25, TimeUnit.SECONDS)
            .build()
    }
}
