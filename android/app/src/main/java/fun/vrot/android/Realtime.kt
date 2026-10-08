package `fun`.vrot.android


import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONObject
import java.net.URI

class Realtime(private val session: SessionStore) {
    private var socket: Socket? = null
    var onDirectMessage: ((JSONObject)->Unit)? = null
    var onChannelMessage: ((JSONObject)->Unit)? = null
    var onFriendChange: (()->Unit)? = null
    var onIncomingCall: ((JSONObject)->Unit)? = null
    var onCallCancelled: ((JSONObject)->Unit)? = null
    val active: Socket? get() = socket

    fun connect() {
        if (socket?.connected() == true) return
        val cookie = session.cookie() ?: return
        disconnect()
        val options = IO.Options.builder().setForceNew(true)
            .setTransports(arrayOf("websocket"))
            .setExtraHeaders(mapOf("Cookie" to listOf(cookie)))
            .setReconnection(true).build()
        socket = IO.socket(URI.create(BuildConfig.API_BASE), options).also { s ->
            s.on("dm:new", Emitter.Listener { args -> (args.firstOrNull() as? JSONObject)?.let { onDirectMessage?.invoke(it) } })
            s.on("message:new", Emitter.Listener { args -> (args.firstOrNull() as? JSONObject)?.let { onChannelMessage?.invoke(it) } })
            s.on("friend:updated", Emitter.Listener { onFriendChange?.invoke() })
            s.on("call:incoming", Emitter.Listener { args -> (args.firstOrNull() as? JSONObject)?.let { onIncomingCall?.invoke(it) } })
            s.on("call:cancelled", Emitter.Listener { args -> (args.firstOrNull() as? JSONObject)?.let { onCallCancelled?.invoke(it) } })
            s.connect()
        }
    }
    fun joinChannel(id: String) { socket?.emit("channel:join", id) }
    fun disconnect() { socket?.disconnect(); socket?.off(); socket = null }
}
