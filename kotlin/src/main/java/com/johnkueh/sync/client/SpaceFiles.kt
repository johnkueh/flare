package com.johnkueh.sync.client

import kotlinx.coroutines.CancellationException

/** Where an app keeps a space's files (photos) on the phone, by the hex
 *  SHA-256 of their bytes, and which ones the server still needs. */
interface SpaceFileStore {
    /** Files written here that the server doesn't have yet. */
    val pending: List<String>

    /** The file's bytes, or null if it's gone (it's then dropped from [pending]). */
    fun data(hash: String): ByteArray?
    fun uploaded(hash: String)
    fun has(hash: String): Boolean

    /** Keeps a downloaded file. Return false if its bytes don't match. */
    suspend fun save(hash: String, data: ByteArray): Boolean
}

/**
 * Moves files between the phone and the space. Files sync separately from
 * documents: a document naming a file that hasn't arrived yet is fine, and
 * the next pass tries again.
 */
object SpaceFiles {
    /** Sends pending files in order and stops at the first failure. Each
     *  upload is checked against its hash, and sending one twice is
     *  harmless. */
    suspend fun upload(
        files: SpaceFileStore, client: SpaceClient, spaceId: String, contentType: String = "image/jpeg",
        failed: (String, Exception) -> Unit = { _, _ -> },
    ) {
        for (hash in files.pending) {
            try {
                val data = files.data(hash)
                if (data != null) client.putBlob(spaceId, hash, data, contentType)
                files.uploaded(hash)
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                failed(hash, error)
                break
            }
        }
    }

    /** Fetches the files in [wanted] this phone hasn't got. One that isn't
     *  on the server yet (its phone hasn't uploaded it) is skipped. Returns
     *  the ones that arrived. */
    suspend fun download(
        wanted: Collection<String>, files: SpaceFileStore, client: SpaceClient, spaceId: String,
        failed: (String, Exception) -> Unit = { _, _ -> },
    ): List<String> {
        val arrived = mutableListOf<String>()
        for (hash in wanted.filterNot(files::has)) {
            try {
                if (files.save(hash, client.blob(spaceId, hash))) arrived += hash
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                failed(hash, error)
            }
        }
        return arrived
    }
}
