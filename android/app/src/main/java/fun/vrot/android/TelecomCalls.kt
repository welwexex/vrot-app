package `fun`.vrot.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.telecom.Connection
import android.telecom.ConnectionRequest
import android.telecom.ConnectionService
import android.telecom.DisconnectCause
import android.telecom.PhoneAccount
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import androidx.core.app.NotificationCompat

object SystemCalls {
    const val CHANNEL_CALLS = "vrot_incoming_calls"
    const val CHANNEL_MESSAGES = "vrot_messages"
    private const val ACCOUNT_ID = "vrot_telecom_account"

    fun getPhoneAccountHandle(context: Context): PhoneAccountHandle {
        val component = ComponentName(context, VrotConnectionService::class.java)
        return PhoneAccountHandle(component, ACCOUNT_ID)
    }

    fun registerPhoneAccount(context: Context) {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager ?: return
        val handle = getPhoneAccountHandle(context)
        val account = PhoneAccount.builder(handle, "Врот")
            .setCapabilities(PhoneAccount.CAPABILITY_SELF_MANAGED or PhoneAccount.CAPABILITY_SUPPORTS_VIDEO_CALLING)
            .setIcon(android.graphics.drawable.Icon.createWithResource(context, R.drawable.ic_vrot))
            .setHighlightColor(Color.parseColor("#5865F2"))
            .build()
        runCatching { telecomManager.registerPhoneAccount(account) }
    }

    fun createChannels(context: Context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

            val callSound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            val callAttrs = AudioAttributes.Builder()
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .build()

            val callChannel = NotificationChannel(
                CHANNEL_CALLS,
                "Входящие звонки",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Уведомления о входящих аудио- и видеозвонках"
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 1000, 1000, 1000, 1000)
                setSound(callSound, callAttrs)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
            }
            manager.createNotificationChannel(callChannel)

            val msgChannel = NotificationChannel(
                CHANNEL_MESSAGES,
                "Сообщения",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Личные сообщения и уведомления каналов"
                enableVibration(true)
                lockscreenVisibility = android.app.Notification.VISIBILITY_PRIVATE
            }
            manager.createNotificationChannel(msgChannel)
        }
    }

    fun startIncomingCall(context: Context, friendId: String, callerName: String, video: Boolean, callId: String) {
        val telecomManager = context.getSystemService(Context.TELECOM_SERVICE) as? TelecomManager
        val handle = getPhoneAccountHandle(context)

        var telecomStarted = false
        if (telecomManager != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                val extras = Bundle().apply {
                    putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, handle)
                    putParcelable(TelecomManager.EXTRA_INCOMING_CALL_ADDRESS, Uri.fromParts("vrot", friendId, null))
                    putString("friendId", friendId)
                    putString("callerName", callerName)
                    putBoolean("video", video)
                    putString("callId", callId)
                }
                telecomManager.addNewIncomingCall(handle, extras)
                telecomStarted = true
            } catch (_: Exception) {
                telecomStarted = false
            }
        }

        if (!telecomStarted) {
            showIncomingCallNotification(context, friendId, callerName, video, callId)
        }
    }

    fun showIncomingCallNotification(context: Context, friendId: String, callerName: String, video: Boolean, callId: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return

        val fullScreenIntent = Intent(context, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("friendId", friendId)
            putExtra("callerName", callerName)
            putExtra("video", video)
            putExtra("callId", callId)
        }
        val fullScreenPending = PendingIntent.getActivity(
            context,
            callId.hashCode(),
            fullScreenIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val acceptIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_ACCEPT
            putExtra("friendId", friendId)
            putExtra("callerName", callerName)
            putExtra("video", video)
            putExtra("callId", callId)
        }
        val acceptPending = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 1,
            acceptIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val declineIntent = Intent(context, CallActionReceiver::class.java).apply {
            action = CallActionReceiver.ACTION_DECLINE
            putExtra("callId", callId)
        }
        val declinePending = PendingIntent.getBroadcast(
            context,
            callId.hashCode() + 2,
            declineIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notif = NotificationCompat.Builder(context, CHANNEL_CALLS)
            .setSmallIcon(R.drawable.ic_vrot)
            .setContentTitle(if (video) "Входящий видеозвонок" else "Входящий звонок")
            .setContentText(callerName)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(fullScreenPending, true)
            .setAutoCancel(true)
            .setOngoing(true)
            .addAction(android.R.drawable.ic_menu_call, "Ответить", acceptPending)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Отклонить", declinePending)
            .build()

        manager.notify(callId.hashCode(), notif)
    }

    fun cancelCallNotification(context: Context, callId: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        manager.cancel(callId.hashCode())
        IncomingCallActivity.dismissActive()
        VrotConnectionService.currentConnection?.let {
            it.setDisconnected(DisconnectCause(DisconnectCause.MISSED))
            it.destroy()
            VrotConnectionService.currentConnection = null
        }
    }

    fun showMessageNotification(context: Context, userId: String, title: String, text: String) {
        val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("dm", userId)
        }
        val pendingIntent = PendingIntent.getActivity(
            context,
            userId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notif = NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_vrot)
            .setContentTitle(title)
            .setContentText(text)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .build()
        manager.notify(userId.hashCode(), notif)
    }
}

class VrotConnectionService : ConnectionService() {
    companion object {
        var currentConnection: VrotConnection? = null
    }

    override fun onCreateIncomingConnection(
        connectionManagerPhoneAccount: PhoneAccountHandle?,
        request: ConnectionRequest?
    ): Connection {
        val extras = request?.extras ?: Bundle()
        val friendId = extras.getString("friendId").orEmpty()
        val callerName = extras.getString("callerName").orEmpty()
        val video = extras.getBoolean("video", false)
        val callId = extras.getString("callId").orEmpty()

        val conn = VrotConnection(this, friendId, callerName, video, callId)
        conn.connectionCapabilities = Connection.CAPABILITY_SUPPORT_HOLD or Connection.CAPABILITY_MUTE
        if (video) {
            conn.connectionCapabilities = conn.connectionCapabilities or Connection.CAPABILITY_SUPPORTS_VT_LOCAL_BIDIRECTIONAL
        }
        conn.setCallerDisplayName(callerName, TelecomManager.PRESENTATION_ALLOWED)
        conn.setAddress(Uri.fromParts("vrot", friendId, null), TelecomManager.PRESENTATION_ALLOWED)
        conn.setRinging()
        currentConnection = conn

        val fullScreenIntent = Intent(this, IncomingCallActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra("friendId", friendId)
            putExtra("callerName", callerName)
            putExtra("video", video)
            putExtra("callId", callId)
            putExtra("fromTelecom", true)
        }
        startActivity(fullScreenIntent)

        return conn
    }
}

class VrotConnection(
    private val service: Context,
    val friendId: String,
    val callerName: String,
    val video: Boolean,
    val callId: String
) : Connection() {

    override fun onAnswer() {
        setActive()
        val app = service.applicationContext as? VrotApplication
        app?.calls?.accept(friendId, callerName, video)
        CallService.start(service, callerName, video)
        val intent = Intent(service, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        service.startActivity(intent)
    }

    override fun onDisconnect() {
        setDisconnected(DisconnectCause(DisconnectCause.LOCAL))
        destroy()
        VrotConnectionService.currentConnection = null
        val app = service.applicationContext as? VrotApplication
        app?.calls?.end()
    }

    override fun onReject() {
        setDisconnected(DisconnectCause(DisconnectCause.REJECTED))
        destroy()
        VrotConnectionService.currentConnection = null
        val app = service.applicationContext as? VrotApplication
        app?.calls?.end()
    }
}

class CallActionReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_ACCEPT = "fun.vrot.android.ACTION_ACCEPT"
        const val ACTION_DECLINE = "fun.vrot.android.ACTION_DECLINE"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val callId = intent.getStringExtra("callId").orEmpty()
        val friendId = intent.getStringExtra("friendId").orEmpty()
        val callerName = intent.getStringExtra("callerName").orEmpty()
        val video = intent.getBooleanExtra("video", false)

        SystemCalls.cancelCallNotification(context, callId)

        val app = context.applicationContext as? VrotApplication
        when (intent.action) {
            ACTION_ACCEPT -> {
                VrotConnectionService.currentConnection?.onAnswer() ?: run {
                    app?.calls?.accept(friendId, callerName, video)
                    CallService.start(context, callerName, video)
                    val mainIntent = Intent(context, MainActivity::class.java).apply {
                        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                    }
                    context.startActivity(mainIntent)
                }
            }
            ACTION_DECLINE -> {
                VrotConnectionService.currentConnection?.onDisconnect() ?: run {
                    app?.calls?.end()
                }
            }
        }
    }
}
