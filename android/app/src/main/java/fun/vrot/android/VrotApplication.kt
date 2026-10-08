package `fun`.vrot.android


import android.app.Application
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import org.json.JSONObject

class VrotApplication: Application() {
    lateinit var session: SessionStore
    lateinit var api: Api
    lateinit var realtime: Realtime
    lateinit var calls: VoiceCalls
    override fun onCreate() {
        super.onCreate()
        session = SessionStore(this)
        api = Api(session)
        realtime = Realtime(session)
        calls = VoiceCalls(this, api, realtime)
        SystemCalls.createChannels(this)
        SystemCalls.registerPhoneAccount(this)

        realtime.onIncomingCall = { data ->
            val from = data.optJSONObject("from")
            val friendId = from?.optString("id").orEmpty()
            val callerName = from?.optString("displayName")?.ifBlank { from.optString("username") } ?: "Собеседник"
            val video = data.optBoolean("video", false)
            val callId = data.optString("callId").ifBlank { java.util.UUID.randomUUID().toString() }
            SystemCalls.startIncomingCall(this, friendId, callerName, video, callId)
        }

        realtime.onCallCancelled = { data ->
            val callId = data.optString("callId")
            IncomingCallActivity.dismissActive()
            if (callId.isNotEmpty()) {
                SystemCalls.cancelCallNotification(this, callId)
            }
        }

        realtime.onDirectMessage = { msg ->
            val author = msg.optJSONObject("author")
            val authorName = author?.optString("displayName")?.ifBlank { author.optString("username") } ?: "Новое сообщение"
            val text = msg.optString("content").ifBlank { "Вложение" }
            val authorId = author?.optString("id").orEmpty()
            SystemCalls.showMessageNotification(this, authorId, authorName, text)
        }

        registerPush()
    }
    fun registerPush() {
        if (api.cookie() == null || FirebaseApp.getApps(this).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { api.obj("/api/android/devices", "POST", JSONObject().put("token", token)) }
            }
        }
    }
    fun unregisterPush() {
        if (FirebaseApp.getApps(this).isEmpty()) return
        FirebaseMessaging.getInstance().token.addOnSuccessListener { token ->
            CoroutineScope(Dispatchers.IO).launch {
                runCatching { api.obj("/api/android/devices", "DELETE", JSONObject().put("token", token)) }
            }
        }
    }
}
