package com.johnkueh.flare.groceries

import android.content.Context
import android.net.Uri
import android.os.Build
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.johnkueh.sync.client.FlareAuth
import com.johnkueh.sync.client.SpaceClient
import com.johnkueh.sync.client.SpaceInfo
import com.johnkueh.sync.client.SpaceServerException
import com.johnkueh.sync.client.SyncJson
import com.johnkueh.sync.ffi.parseInvite
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import okhttp3.Request

@Serializable
data class SavedList(val id: String, val name: String)

/** Who's signed in and which lists they have. */
class AppModel(private val context: Context) {
    private val prefs = context.getSharedPreferences("groceries", Context.MODE_PRIVATE)
    private val http = SpaceClient.defaultHttp()
    private val deviceName = Build.MODEL

    // The emulator can't attest its keys, so it signs in unattested (the
    // server needs FLARE_AUTH_ALLOW_UNATTESTED). A real phone attests.
    private val isEmulator = Build.HARDWARE == "ranchu" || Build.HARDWARE == "goldfish"
    val auth = FlareAuth(context, "${BuildConfig.SERVER}/v1/auth", allowUnattested = isEmulator, http = http)
    val client = SpaceClient("${BuildConfig.SERVER}/v1", tokens = auth, http = http, deviceName = deviceName)
    val flags = (context.applicationContext as GroceriesApp).flags

    var lists by mutableStateOf(savedLists())
        private set

    /** The account's email, or null while the user is anonymous. */
    var email by mutableStateOf(prefs.getString("email", null))
        private set
    var error by mutableStateOf<String?>(null)

    @Serializable
    private data class Me(val user: String, val spaces: List<SpaceInfo> = emptyList())

    /** The lists this user is in, from the server. The first call signs in
     *  anonymously. Offline, the saved ones stay. */
    suspend fun refresh() {
        try {
            val me = withContext(Dispatchers.IO) {
                val request = Request.Builder().url("${BuildConfig.SERVER}/v1/me/spaces")
                    .header("Authorization", "Bearer ${auth.token()}")
                    .header("X-Device-Platform", "android")
                    .header("X-Device-Name", Uri.encode(deviceName))
                    .build()
                http.newCall(request).execute().use { response ->
                    if (response.code == 401) null
                    else SyncJson.decodeFromString(Me.serializer(), response.body!!.string())
                }
            }
            if (me == null) {
                // The session ended on the server: start again as a new user.
                auth.clear()
                keepEmail(null)
                return refresh()
            }
            save(me.spaces.map { SavedList(it.spaceId, it.name) })
            error = null
            flags.setUser(me.user)
        } catch (e: Exception) {
            error = "Can't reach the server. ${e.message}"
        }
    }

    suspend fun create(name: String): SavedList? = adding { client.create(name, deviceName) }

    /** Joins with an invite code as typed or pasted (`7KQ2-M9XD`, or a link). */
    suspend fun join(text: String): SavedList? {
        val code = parseInvite(text)
        if (code == null) {
            error = "That doesn't look like an invite code."
            return null
        }
        return adding { client.join(client.preview(code).spaceId, code, deviceName) }
    }

    private suspend fun adding(work: suspend () -> SpaceInfo): SavedList? =
        try {
            val info = work()
            val list = SavedList(info.spaceId, info.name)
            save(lists.filter { it.id != list.id } + list)
            error = null
            list
        } catch (e: SpaceServerException) {
            error = if (e.code == "NOT_FOUND") "No list has that code." else e.message
            null
        } catch (e: Exception) {
            error = e.message
            null
        }

    // Account

    suspend fun sendCode(email: String): Boolean =
        try {
            auth.sendEmailCode(email)
            error = null
            true
        } catch (e: Exception) {
            error = e.message
            false
        }

    /** Signs in to an account. The anonymous user's lists move to it on the
     *  server (`relinkMember`), so they're still here afterwards. */
    suspend fun signIn(email: String, code: String): Boolean =
        try {
            auth.signInWithEmailCode(email, code)
            keepEmail(email)
            refresh()
            true
        } catch (e: Exception) {
            error = "That code didn't work. Check it, or send a new one."
            false
        }

    /** Back to a new anonymous user, with no lists. */
    suspend fun signOut() {
        auth.signOut()
        keepEmail(null)
        lists.forEach { ListModel.forget(context, it.id) }
        save(emptyList())
        refresh()
    }

    private fun keepEmail(value: String?) {
        email = value
        prefs.edit().putString("email", value).apply()
    }

    private fun save(value: List<SavedList>) {
        lists = value
        prefs.edit().putString("lists", SyncJson.encodeToString(ListSerializer(SavedList.serializer()), value)).apply()
    }

    private fun savedLists(): List<SavedList> =
        runCatching {
            SyncJson.decodeFromString(ListSerializer(SavedList.serializer()), prefs.getString("lists", null) ?: "[]")
        }.getOrDefault(emptyList())
}
