package com.johnkueh.sync.client

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.pm.PackageManager
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Firebase Messaging for [FlarePush]: hands new tokens to it, and shows a
 * notification that arrives while the app is open (Android shows the rest
 * itself). The app declares it, next to the permission:
 *
 * ```xml
 * <uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>
 * <service android:name="com.johnkueh.sync.client.FlarePushMessagingService" android:exported="false">
 *     <intent-filter><action android:name="com.google.firebase.MESSAGING_EVENT"/></intent-filter>
 * </service>
 * ```
 *
 * and depends on `com.google.firebase:firebase-messaging` itself (this
 * library only compiles against it). A tap opens the launch activity with
 * the notification's `key` and data as extras, as Android does for the ones
 * it shows; pass them to [FlarePush.opened]. Subclass it to handle data
 * messages, calling `super`.
 */
open class FlarePushMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        FlarePush.receivedToken(applicationContext, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val shown = message.notification ?: return
        val manager = getSystemService(NotificationManager::class.java)
        val channel = shown.channelId?.takeIf { manager.getNotificationChannel(it) != null } ?: fallbackChannel(manager)
        val launch = packageManager.getLaunchIntentForPackage(packageName)?.apply {
            for ((k, v) in message.data) putExtra(k, v)
        }
        val tap = launch?.let {
            PendingIntent.getActivity(this, shown.tag.hashCode(), it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        }
        val notification = Notification.Builder(this, channel)
            .setSmallIcon(smallIcon())
            .setContentTitle(shown.title)
            .setContentText(shown.body)
            .setStyle(Notification.BigTextStyle().bigText(shown.body))
            .setAutoCancel(true)
            .apply { if (tap != null) setContentIntent(tap) }
            .build()
        // Same tag, same notification: a newer one replaces it (collapse).
        runCatching { manager.notify(shown.tag, 0, notification) }
    }

    /** The icon Firebase uses (its default_notification_icon meta-data), else the app's. */
    private fun smallIcon(): Int {
        val meta = runCatching { packageManager.getApplicationInfo(packageName, PackageManager.GET_META_DATA).metaData }.getOrNull()
        return meta?.getInt("com.google.firebase.messaging.default_notification_icon", 0)?.takeIf { it != 0 } ?: applicationInfo.icon
    }

    private fun fallbackChannel(manager: NotificationManager): String {
        if (manager.getNotificationChannel(FALLBACK_CHANNEL) == null) {
            manager.createNotificationChannel(NotificationChannel(FALLBACK_CHANNEL, "Notifications", NotificationManager.IMPORTANCE_DEFAULT))
        }
        return FALLBACK_CHANNEL
    }

    private companion object {
        const val FALLBACK_CHANNEL = "flare_default"
    }
}

/** Reads the current FCM token and uploads it. Call once at launch;
 *  [FlarePushMessagingService] takes care of new ones after that. */
suspend fun FlarePush.syncFcmToken() {
    val token = suspendCancellableCoroutine { cont ->
        FirebaseMessaging.getInstance().token
            .addOnSuccessListener { cont.resume(it) }
            .addOnFailureListener { cont.resume(null) }
    }
    if (token != null) setToken(token)
}

