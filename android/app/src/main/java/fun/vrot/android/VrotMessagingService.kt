package `fun`.vrot.android

import android.util.Log
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

class VrotMessagingService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        super.onNewToken(token)
        Log.d("VrotFCM", "New push token: $token")
        (applicationContext as? VrotApplication)?.registerPush()
    }

    override fun onMessageReceived(remoteMessage: RemoteMessage) {
        super.onMessageReceived(remoteMessage)
        val data = remoteMessage.data
        val type = data["type"].orEmpty()
        val title = data["title"].orEmpty().ifBlank { remoteMessage.notification?.title.orEmpty() }
        val body = data["body"].orEmpty().ifBlank { remoteMessage.notification?.body.orEmpty() }
        val friendId = data["friendId"].orEmpty()
        val channelId = data["channelId"].orEmpty()
        val callId = data["callId"].orEmpty()
        val video = data["video"]?.toBoolean() ?: false

        when (type) {
            "call" -> {
                SystemCalls.startIncomingCall(
                    context = this,
                    friendId = friendId,
                    callerName = title.removePrefix("Входящий вызов: ").ifBlank { "Собеседник" },
                    video = video,
                    callId = callId.ifBlank { System.currentTimeMillis().toString() }
                )
            }
            "message", "channel", "invite" -> {
                // Show incoming message notification
                val manager = getSystemService(NOTIFICATION_SERVICE) as? android.app.NotificationManager ?: return
                val intent = android.content.Intent(this, MainActivity::class.java).apply {
                    flags = android.content.Intent.FLAG_ACTIVITY_NEW_TASK or android.content.Intent.FLAG_ACTIVITY_SINGLE_TOP
                    if (friendId.isNotBlank()) putExtra("dm", friendId)
                    if (channelId.isNotBlank()) putExtra("channel", channelId)
                }
                val pending = android.app.PendingIntent.getActivity(
                    this,
                    (friendId + channelId).hashCode(),
                    intent,
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE
                )

                val notif = androidx.core.app.NotificationCompat.Builder(this, SystemCalls.CHANNEL_MESSAGES)
                    .setSmallIcon(R.drawable.ic_vrot)
                    .setContentTitle(title.ifBlank { "Врот" })
                    .setContentText(body)
                    .setAutoCancel(true)
                    .setContentIntent(pending)
                    .setPriority(androidx.core.app.NotificationCompat.PRIORITY_HIGH)
                    .build()

                manager.notify((friendId + channelId + System.currentTimeMillis().toString()).hashCode(), notif)
            }
        }
    }
}
