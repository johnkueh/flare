package com.johnkueh.sync.client

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * The space's live WebSocket: stays connected while the app is in front,
 * backing off between tries, and asks for a sync when another phone pushed
 * something this one hasn't pulled. The Kotlin side of the Swift package's
 * `LiveSocket`. Run [run] in a coroutine and cancel it to stop.
 */
object LiveSocket {
    class Handlers(
        /** The space to listen to, or null to stop (left, or sync off). */
        val spaceId: () -> String?,
        /** The store's cursor, to compare with the server's version. */
        val cursor: () -> ULong,
        /** Run a sync pass: on every connect, and when the server is ahead. */
        val sync: () -> Unit,
        /** Told whenever the socket connects or drops. */
        val live: (Boolean) -> Unit = {},
        /** After a dropped connection's back-off: a chance to push writes
         *  made while offline. */
        val retry: () -> Unit = {},
        val log: (String) -> Unit = {},
    )

    /** Each connection starts with a sync, so coming back online catches
     *  up without waiting. */
    suspend fun run(client: SpaceClient, handlers: Handlers) {
        var backoff = 1_000L
        while (true) {
            val id = handlers.spaceId() ?: return
            val closed = CompletableDeferred<Unit>()
            val socket = try {
                client.live(id, object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        backoff = 1_000L
                        handlers.live(true)
                        handlers.sync()
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        val version = runCatching {
                            SyncJson.parseToJsonElement(text).jsonObject["version"]?.jsonPrimitive?.content?.toULong()
                        }.getOrNull() ?: return
                        if (version > runCatching { handlers.cursor() }.getOrDefault(0u)) handlers.sync()
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                        closed.complete(Unit)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        closed.complete(Unit)
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        handlers.log("live socket closed: ${t.message}")
                        closed.complete(Unit)
                    }
                })
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                handlers.log("live socket didn't open: ${error.message}")
                null
            }
            try {
                if (socket != null) closed.await()
            } finally {
                socket?.cancel()
                handlers.live(false)
            }
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000L)
            handlers.retry()
        }
    }
}
