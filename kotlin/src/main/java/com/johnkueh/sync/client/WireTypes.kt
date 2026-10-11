// The JSON bodies of the /spaces calls (PROTOCOL.md, "HTTP"); the server
// builds them in server/src/space.ts and server/src/spaces.ts. First
// generated from an OpenAPI contract, now kept by hand: change them
// with the server, in the same commit.

package com.johnkueh.sync.client

import kotlinx.serialization.Serializable

/** A space as the server describes it (`Info` in PROTOCOL.md). */
@Serializable
data class SpaceInfo(
    val spaceId: String,
    val name: String,
    val code: String,
    val owner: String,
    val you: String,
    val version: Int = 0,
    val time: Long = 0,
    val devices: List<SpaceInfo.Device> = emptyList(),
) {
    /** A member of the space. Times are milliseconds since 1970. With
     *  accounts (AUTH.md) the member is a user, and [devices] are the phones
     *  and browsers they've used here, newest first. */
    @Serializable
    data class Device(
        val id: String,
        val name: String,
        val platform: String,
        val joinedAt: Long = 0,
        val lastSeen: Long = 0,
        val devices: List<MemberDevice> = emptyList(),
    )

    /** A phone or browser a member has used in the space. */
    @Serializable
    data class MemberDevice(
        val id: String,
        val name: String,
        val platform: String,
        val lastSeen: Long = 0,
    )
}

/** What an invite code would join. */
@Serializable
data class InvitePreview(
    val spaceId: String,
    val name: String,
    val devices: Int = 0,
    val collections: Map<String, Int> = emptyMap(),
    val time: Long = 0,
)

/** `POST /spaces`. */
@Serializable
data class NewSpace(
    val name: String,
    val deviceName: String,
    val platform: String,
)

/** `POST /spaces/{spaceId}/join`. */
@Serializable
data class JoinSpace(
    val code: String,
    val deviceName: String,
    val platform: String,
)
