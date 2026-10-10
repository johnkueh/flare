package com.johnkueh.sync.client

import com.johnkueh.sync.ffi.Change
import com.johnkueh.sync.ffi.SyncStore

/**
 * One round with the server: push every local write, then pull pages until
 * caught up. The app decides when to run one (launch, foreground, after a
 * local write, when the live socket reports a newer version) and what the
 * changes mean for its screens. The Kotlin side of the Swift package's
 * `SyncPass`.
 *
 * [changes] and [reset] hold what reached the store even when [run] throws
 * part way, so the app can still show those.
 */
class SyncPass {
    /** Every change applied to the store, pushed or pulled. */
    val changes = mutableListOf<Change>()

    /** The server asked for a reset: re-read everything. */
    var reset = false
        private set

    /** A push that fails is put back (`failPush`) for the next pass, and
     *  the error is rethrown. [pushed] runs after each accepted push. */
    suspend fun run(store: SyncStore, client: SpaceClient, spaceId: String, pushed: () -> Unit = {}) {
        while (true) {
            val body = store.takePush() ?: break
            try {
                changes += store.ackPush(client.push(spaceId, body))
            } catch (error: Exception) {
                store.failPush()
                throw error
            }
            pushed()
        }
        var more = true
        while (more) {
            val outcome = store.applyPull(client.changes(spaceId, store.cursor().toLong()))
            more = outcome.more
            reset = reset || outcome.reset
            changes += outcome.changes
        }
    }
}
