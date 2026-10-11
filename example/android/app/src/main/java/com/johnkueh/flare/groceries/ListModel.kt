package com.johnkueh.flare.groceries

import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.johnkueh.sync.client.LiveSocket
import com.johnkueh.sync.client.SpaceClient
import com.johnkueh.sync.client.SpaceInfo
import com.johnkueh.sync.client.SpaceServerException
import com.johnkueh.sync.client.SyncJson
import com.johnkueh.sync.client.SyncPass
import com.johnkueh.sync.ffi.SyncStore
import java.io.File
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

@Serializable
data class Item(val id: String, val name: String? = null, val done: Boolean? = null, val position: String? = null)

/** One grocery list: its store on this phone, and the sync that keeps it
 *  level with everyone else's. */
class ListModel(context: Context, val spaceId: String, private val client: SpaceClient) {
    private val store = SyncStore.open(path(context, spaceId), SCHEMA)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var syncing = false
    private var syncAgain = false

    var items by mutableStateOf(emptyList<Item>())
        private set
    var info by mutableStateOf<SpaceInfo?>(null)
        private set
    var isLive by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    init {
        reload()
    }

    /** Opens the live socket, which syncs on every connect and whenever
     *  someone else pushes. Its callbacks come from OkHttp's threads. */
    fun start() {
        scope.launch {
            LiveSocket.run(client, LiveSocket.Handlers(
                spaceId = { spaceId },
                cursor = { store.cursor() },
                sync = { sync() },
                live = { live -> scope.launch { isLive = live } },
                retry = { sync() },
            ))
        }
    }

    fun stop() {
        scope.cancel()
    }

    fun add(name: String) {
        val id = UUID.randomUUID().toString().replace("-", "")
        // Ordered by when it was added, as the web page does.
        val position = System.currentTimeMillis().toString().padStart(15, '0')
        write {
            store.putDoc("groceries", id, buildJsonObject {
                put("name", name)
                put("done", false)
                put("position", position)
            }.toString())
        }
    }

    fun toggle(item: Item) {
        write { store.put("groceries", item.id, "done", if (item.done == true) "false" else "true") }
    }

    /** Writes land in the store first, so they show at once and survive
     *  being offline; the sync pass pushes them. */
    private fun write(change: () -> Unit) {
        try {
            change()
            reload()
            sync()
        } catch (e: Exception) {
            error = e.message
        }
    }

    /** One pass at a time; a request during a pass runs another after it. */
    fun sync() {
        scope.launch {
            if (syncing) {
                syncAgain = true
                return@launch
            }
            syncing = true
            do {
                syncAgain = false
                try {
                    SyncPass().run(store, client, spaceId)
                    error = null
                } catch (e: SpaceServerException) {
                    error = if (e.isGone) "You're no longer in this list." else e.message
                } catch (e: Exception) {
                    error = "Offline. Changes will sync when you're back."
                }
                reload()
            } while (syncAgain)
            syncing = false
            // Someone may have joined since.
            runCatching { info = client.info(spaceId) }
        }
    }

    private fun reload() {
        items = runCatching {
            SyncJson.decodeFromString(ListSerializer(Item.serializer()), store.list("groceries", "position"))
        }.getOrDefault(items)
    }

    companion object {
        /** The same collection and fields the web page writes. */
        private const val SCHEMA = """{"groceries": {"name": "value", "done": "value", "position": "position"}}"""

        private fun path(context: Context, spaceId: String) = File(context.filesDir, "$spaceId.sqlite").path

        /** Drops a list's local copy (after signing out). */
        fun forget(context: Context, spaceId: String) {
            for (suffix in listOf("", "-wal", "-shm")) File(path(context, spaceId) + suffix).delete()
        }
    }
}
