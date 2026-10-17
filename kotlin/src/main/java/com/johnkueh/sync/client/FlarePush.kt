package com.johnkueh.sync.client

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.Settings
import java.util.Locale
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/** Where this phone stands on notifications, the same four states as the
 *  Swift package's `PushPermission` (`PUSH.md`). */
enum class PushPermission(val wire: String) {
    /** Never asked, or denied once: the system dialog is still available. */
    NOT_ASKED("not_asked"),
    /** iOS provisional only; Android never reports it. */
    QUIET("quiet"),
    ALLOWED("allowed"),
    /** Denied for good (twice on Android 13+, or switched off in
     *  Settings). Only Settings can turn them back on. */
    BLOCKED("blocked"),
}

/**
 * Push notifications from a Flare server (`@flare/push`): the permission,
 * the FCM token, the app's notification channels, and keeping the
 * server's copy of all three current. The Kotlin side of the Swift
 * package's `FlarePush`.
 *
 * No UI and no Firebase dependency. The app keeps Firebase Messaging and
 * declares [FlarePushMessagingService], which hands tokens over and shows
 * notifications that arrive while the app is open. It shows its own
 * inline ask where the feature lives and launches the system dialog from
 * its button:
 *
 * ```kotlin
 * val push = FlarePush(context, "https://api.example.com/v1", auth)
 * push.createChannels(context.assets.open("notifications.json").reader().readText())
 *
 * // At launch (FlarePushMessagingService handles new tokens after that):
 * scope.launch { push.syncFcmToken() }
 *
 * // Compose
 * val launcher = rememberLauncherForActivityResult(RequestPermission()) { granted ->
 *     scope.launch { push.onPermissionResult(activity, granted) }
 * }
 * Button(onClick = { push.willAsk(); launcher.launch(Manifest.permission.POST_NOTIFICATIONS) }) { … }
 *
 * // onResume
 * scope.launch { push.refresh(activity) }
 * ```
 *
 * The app's manifest declares `android.permission.POST_NOTIFICATIONS`.
 */
class FlarePush(
    context: Context,
    baseUrl: String,
    private val tokens: SpaceTokens,
    private val http: OkHttpClient = SpaceClient.defaultHttp(),
    private val name: String = "flare.push",
    /** Gets `push_prompt_shown`, `push_permission_result`,
     *  `push_permission_changed` and `push_opened`; hand them to your
     *  telemetry client for an opt-in funnel. */
    private val onEvent: ((String, Map<String, String>) -> Unit)? = null,
) {
    private val app = context.applicationContext
    private val baseUrl = baseUrl.trimEnd('/')
    private val prefs = app.getSharedPreferences(name, Context.MODE_PRIVATE)
    private val manager = app.getSystemService(NotificationManager::class.java)
    private val state = MutableStateFlow(saved())

    init {
        installed = this
    }

    /** The current state. */
    val permission: StateFlow<PushPermission> = state.asStateFlow()

    /** Whether to show an ask now: the system dialog is available and the
     *  app hasn't been snoozed recently. */
    val canAsk: Boolean
        get() = state.value == PushPermission.NOT_ASKED && System.currentTimeMillis() >= prefs.getLong(SNOOZED_UNTIL, 0)

    /** Android 13+ needs the runtime permission; older versions show
     *  notifications unless the person switched them off. */
    val needsRuntimePermission: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU

    // Permission

    /** Reads the system state (the person may have changed it in
     *  Settings) and updates the server. Call it from `onResume`. With an
     *  [activity], a permission denied before is checked for "don't ask
     *  again". */
    suspend fun refresh(activity: Activity? = null) {
        update(current(activity))
        upload()
    }

    /** Call right before launching the permission dialog. */
    fun willAsk() {
        prefs.edit().putInt(ASKED, prefs.getInt(ASKED, 0) + 1).apply()
        emit("push_prompt_shown", mapOf("mode" to "full"))
    }

    /** The dialog's answer. A denial the system won't ask about again
     *  makes the state [PushPermission.BLOCKED]. */
    suspend fun onPermissionResult(activity: Activity, granted: Boolean) {
        val blocked = !granted && needsRuntimePermission && !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
        prefs.edit().putBoolean(DENIED_FOR_GOOD, blocked).apply()
        update(current(activity))
        emit("push_permission_result", mapOf("mode" to "full", "granted" to granted.toString(), "permission" to state.value.wire))
        upload()
    }

    /** The person dismissed your ask: [canAsk] is false for [days]. */
    fun snooze(days: Int = 14) {
        prefs.edit().putLong(SNOOZED_UNTIL, System.currentTimeMillis() + days * 86_400_000L).apply()
    }

    /** This app's notification settings, the only way back from blocked. */
    fun openSettings(context: Context, channel: String? = null) {
        val intent = if (channel != null) {
            Intent(Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_CHANNEL_ID, channel)
        } else {
            Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS)
        }
        intent.putExtra(Settings.EXTRA_APP_PACKAGE, app.packageName)
        if (context !is Activity) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
    }

    private fun current(activity: Activity?): PushPermission {
        if (!manager.areNotificationsEnabled()) {
            if (!needsRuntimePermission) return PushPermission.BLOCKED
            val granted = app.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
            // Granted but switched off in Settings.
            if (granted) return PushPermission.BLOCKED
            if (prefs.getInt(ASKED, 0) == 0) return PushPermission.NOT_ASKED
            if (activity != null && prefs.getBoolean(DENIED_FOR_GOOD, false)) {
                // Still true? The person may have reset it in Settings.
                val forGood = !activity.shouldShowRequestPermissionRationale(Manifest.permission.POST_NOTIFICATIONS)
                if (!forGood) prefs.edit().putBoolean(DENIED_FOR_GOOD, false).apply()
                return if (forGood) PushPermission.BLOCKED else PushPermission.NOT_ASKED
            }
            return if (prefs.getBoolean(DENIED_FOR_GOOD, false)) PushPermission.BLOCKED else PushPermission.NOT_ASKED
        }
        prefs.edit().putBoolean(DENIED_FOR_GOOD, false).apply()
        return PushPermission.ALLOWED
    }

    private fun update(next: PushPermission) {
        val previous = state.value
        state.value = next
        prefs.edit().putString(PERMISSION, next.wire).apply()
        if (previous != next) emit("push_permission_changed", mapOf("from" to previous.wire, "to" to next.wire))
    }

    private fun saved(): PushPermission {
        val wire = prefs.getString(PERMISSION, null)
        return PushPermission.entries.firstOrNull { it.wire == wire } ?: PushPermission.NOT_ASKED
    }

    // Channels

    /** Creates the channels in notifications.json's `channels` (safe to
     *  call on every launch; Android keeps the person's choices). */
    fun createChannels(notificationsJson: String) {
        val channels = Json.parseToJsonElement(notificationsJson).jsonObject["channels"]?.jsonObject ?: return
        for ((id, value) in channels) {
            val spec = value.jsonObject
            val importance = when (spec["importance"]?.jsonPrimitive?.contentOrNull) {
                "min" -> NotificationManager.IMPORTANCE_MIN
                "low" -> NotificationManager.IMPORTANCE_LOW
                "high" -> NotificationManager.IMPORTANCE_HIGH
                else -> NotificationManager.IMPORTANCE_DEFAULT
            }
            val channel = NotificationChannel(id, spec["name"]?.jsonPrimitive?.contentOrNull ?: id, importance)
            spec["description"]?.jsonPrimitive?.contentOrNull?.let { channel.description = it }
            manager.createNotificationChannel(channel)
        }
        prefs.edit().putStringSet(CHANNELS, channels.keys).apply()
    }

    /** The app's channels the person switched off. */
    private fun mutedChannels(): List<String> =
        prefs.getStringSet(CHANNELS, emptySet()).orEmpty().filter { id ->
            manager.getNotificationChannel(id)?.importance == NotificationManager.IMPORTANCE_NONE
        }.sorted()

    // Token

    /** The FCM token, from `FirebaseMessagingService.onNewToken` and at launch. */
    suspend fun setToken(token: String) {
        prefs.edit().putString(TOKEN, token).apply()
        upload()
    }

    /** Stops notifications to this phone (signing out, say). */
    suspend fun unregister() {
        prefs.edit().remove(TOKEN).remove(UPLOADED).apply()
        runCatching { send("DELETE", null) }
    }

    /** Records the open of a notification. Call it with the intent extras
     *  or `RemoteMessage.data`; returns the notification's key. */
    fun opened(data: Map<String, String>): String? {
        val key = data["key"] ?: return null
        emit("push_opened", mapOf("key" to key))
        return key
    }

    /** The same, from the intent a notification tap opened the app with
     *  (its extras are the notification's data). */
    fun opened(intent: Intent?): String? {
        val extras = intent?.extras ?: return null
        return opened(extras.keySet().mapNotNull { k -> extras.getString(k)?.let { k to it } }.toMap())
    }

    /** Sends the token, permission and muted channels when one changed,
     *  or once a week so the server knows the device is still around. */
    private suspend fun upload() {
        val token = prefs.getString(TOKEN, null) ?: return
        val muted = mutedChannels()
        val signature = "$token|${state.value.wire}|${muted.joinToString(",")}"
        val last = prefs.getString(UPLOADED, null)
        val at = prefs.getLong(UPLOADED_AT, 0)
        if (last == signature && System.currentTimeMillis() - at < 7 * 86_400_000L) return
        val body = buildJsonObject {
            put("platform", "android")
            put("token", token)
            put("appId", app.packageName)
            put("permission", state.value.wire)
            put("locale", Locale.getDefault().toLanguageTag())
            putJsonArray("mutedChannels") { muted.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        }
        val ok = runCatching { send("PUT", body) }.isSuccess
        // Tried again on the next refresh otherwise.
        if (ok) prefs.edit().putString(UPLOADED, signature).putLong(UPLOADED_AT, System.currentTimeMillis()).apply()
    }

    private suspend fun send(method: String, body: JsonObject?) = withContext(Dispatchers.IO) {
        try {
            sendOnce(method, body)
        } catch (error: SpaceServerException) {
            if (error.status != 401) throw error
            tokens.clear()
            sendOnce(method, body)
        }
    }

    private suspend fun sendOnce(method: String, body: JsonObject?) {
        val request = Request.Builder()
            .url("$baseUrl/push/device")
            .header("Authorization", "Bearer ${tokens.token()}")
            .method(method, body?.toString()?.toRequestBody(JSON))
            .build()
        http.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val text = response.body?.string().orEmpty()
                val code = runCatching { Json.parseToJsonElement(text).jsonObject["code"]?.jsonPrimitive?.contentOrNull }.getOrNull()
                throw SpaceServerException(response.code, code ?: "HTTP_${response.code}", null)
            }
        }
    }

    private fun emit(event: String, params: Map<String, String>) {
        onEvent?.invoke(event, params)
    }

    companion object {
        /** The last FlarePush made; [FlarePushMessagingService] hands it tokens. */
        @Volatile
        internal var installed: FlarePush? = null
        private val background = CoroutineScope(SupervisorJob() + Dispatchers.IO)

        /** A new FCM token: uploaded now if a FlarePush exists, else kept for
         *  its next refresh. */
        internal fun receivedToken(context: Context, token: String, name: String = "flare.push") {
            val push = installed
            if (push != null) {
                background.launch { runCatching { push.setToken(token) } }
            } else {
                context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().putString(TOKEN, token).apply()
            }
        }

        private val JSON = "application/json".toMediaType()
        private const val PERMISSION = "permission"
        private const val ASKED = "asked"
        private const val DENIED_FOR_GOOD = "deniedForGood"
        private const val SNOOZED_UNTIL = "snoozedUntil"
        private const val TOKEN = "token"
        private const val CHANNELS = "channels"
        private const val UPLOADED = "uploaded"
        private const val UPLOADED_AT = "uploadedAt"
    }
}
