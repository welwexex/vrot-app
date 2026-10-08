package `fun`.vrot.android


import android.content.Context
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import io.socket.client.Socket
import io.socket.emitter.Emitter
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import org.json.JSONObject
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DataChannel
import org.webrtc.EglBase
import org.webrtc.IceCandidate
import org.webrtc.JavaI420Buffer
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule
import java.util.concurrent.ConcurrentHashMap

data class CallState(val active:Boolean=false,val targetId:String="",val targetKind:String="friend",val label:String="",val video:Boolean=false,val muted:Boolean=false,val status:String="",val peerCount:Int=0)

class VoiceCalls(private val context:Context,private val api:Api,private val realtime:Realtime){
    val state=MutableStateFlow(CallState())
    val remoteVideos=MutableStateFlow<Map<String,VideoTrack>>(emptyMap())
    var localVideo:VideoTrack?=null
        private set
    val egl:EglBase=EglBase.create()
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.IO)
    private val main=Handler(Looper.getMainLooper())
    private val peers=ConcurrentHashMap<String,PeerConnection>()
    private val candidates=ConcurrentHashMap<String,MutableList<IceCandidate>>()
    private var factory:PeerConnectionFactory?=null
    private var audioSource:AudioSource?=null
    private var audioTrack:AudioTrack?=null
    private var videoSource:VideoSource?=null
    private var capturer:VideoCapturer?=null
    private var textureHelper:SurfaceTextureHelper?=null
    private var socket:Socket?=null
    private var iceServers:List<PeerConnection.IceServer> = emptyList()
    private val audioManager=context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

    private var callTimeoutRunnable: Runnable? = null

    fun outgoing(friendId:String,label:String,video:Boolean=false){start("friend",friendId,label,video,true)}
    fun accept(friendId:String,label:String,video:Boolean=false){start("friend",friendId,label,video,false)}
    fun joinChannel(channelId:String,label:String,video:Boolean=false){start("channel",channelId,label,video,false)}
    private fun start(kind:String,id:String,label:String,video:Boolean,invite:Boolean){
        if(state.value.active)end()
        cancelTimeout()
        state.value=CallState(true,id,kind,label,video,status=if(invite) "Вызов… (ожидание)" else "Подключение…")
        realtime.connect()
        val s=realtime.active ?: run { state.value=state.value.copy(status="Нет подключения к серверу");return }
        socket=s

        // 15 seconds timer for outgoing calls
        if(invite && kind == "friend") {
            callTimeoutRunnable = Runnable {
                if (state.value.active && peers.isEmpty()) {
                    status("Время ожидания ответа истекло")
                    main.postDelayed({
                        end()
                    }, 2500)
                }
            }
            main.postDelayed(callTimeoutRunnable!!, 15000)
        }

        val proceed={ scope.launch { prepareAndJoin(s) } }
        if(!s.connected())s.once(Socket.EVENT_CONNECT,Emitter.Listener { proceed() }) else proceed()
        if(invite&&kind=="friend")s.emit("call:invite",JSONObject().put("friendId",id).put("video",video))
    }
    private suspend fun prepareAndJoin(s:Socket){
        try{
            val ice=api.obj("/api/calls/ice").getJSONArray("iceServers")
            iceServers=buildList { for(i in 0 until ice.length()){
                val entry=ice.getJSONObject(i);val urls=entry.getJSONArray("urls")
                for(j in 0 until urls.length())add(PeerConnection.IceServer.builder(urls.getString(j)).setUsername(entry.optString("username")).setPassword(entry.optString("credential")).createIceServer())
            }}
            PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions())
            val module=JavaAudioDeviceModule.builder(context).createAudioDeviceModule()
            factory=PeerConnectionFactory.builder().setAudioDeviceModule(module).createPeerConnectionFactory()
            module.release()
            audioSource=factory!!.createAudioSource(MediaConstraints())
            audioTrack=factory!!.createAudioTrack("vrot-audio",audioSource)
            audioManager.mode=AudioManager.MODE_IN_COMMUNICATION
            if(state.value.video)startCamera()
            s.on("call:signal",signalListener)
            s.on("call:peer-left",leftListener)
            s.on("call:peer-joined",joinedListener)
            val target=JSONObject().put("kind",state.value.targetKind).put("id",state.value.targetId)
            s.emit("call:join",target,io.socket.client.Ack { args ->
                val ack=args.firstOrNull() as? JSONObject ?: return@Ack
                if(!ack.optBoolean("ok")){status(ack.optString("error","Нет доступа к звонку"));return@Ack}
                val participants=ack.optJSONArray("peers") ?: return@Ack
                if (participants.length() > 0) {
                    cancelTimeout()
                    status("Соединение установлено")
                    for(i in 0 until participants.length())createPeer(participants.getJSONObject(i).getString("socketId"),true)
                } else {
                    if (state.value.targetKind == "friend") {
                        status("Вызов…")
                    } else {
                        status("Ожидание участников…")
                    }
                }
            })
        }catch(e:Exception){status("Ошибка звонка: ${e.message ?: "не удалось подключиться"}")}
    }
    private fun startCamera(){
        try{
            val enumerator=Camera2Enumerator(context)
            val names=enumerator.deviceNames
            val name=names.firstOrNull { enumerator.isFrontFacing(it) } ?: names.firstOrNull() ?: return
            capturer=enumerator.createCapturer(name,null)
            videoSource=factory!!.createVideoSource(false)
            textureHelper=SurfaceTextureHelper.create("VrotCamera",egl.eglBaseContext)
            capturer?.initialize(textureHelper,context,videoSource!!.capturerObserver)
            capturer?.startCapture(1280,720,24)
            localVideo=factory!!.createVideoTrack("vrot-video",videoSource)
        }catch(e:Exception){status("Камера недоступна: ${e.message}")}
    }
    private fun createPeer(id:String,initiator:Boolean):PeerConnection? {
        peers[id]?.let{return it}
        val pc=factory?.createPeerConnection(PeerConnection.RTCConfiguration(iceServers),object:PeerConnection.Observer {
            override fun onSignalingChange(state:PeerConnection.SignalingState?){}
            override fun onIceConnectionChange(iceState:PeerConnection.IceConnectionState?){
                if(iceState==PeerConnection.IceConnectionState.CONNECTED||iceState==PeerConnection.IceConnectionState.COMPLETED){
                    cancelTimeout()
                    status("На связи")
                } else if(iceState==PeerConnection.IceConnectionState.DISCONNECTED||iceState==PeerConnection.IceConnectionState.FAILED||iceState==PeerConnection.IceConnectionState.CLOSED) {
                    if (this@VoiceCalls.state.value.targetKind == "friend") {
                        status("Собеседник завершил вызов")
                        main.postDelayed({ end() }, 1500)
                    }
                }
            }
            override fun onIceConnectionReceivingChange(receiving:Boolean){}
            override fun onIceGatheringChange(state:PeerConnection.IceGatheringState?){}
            override fun onIceCandidate(candidate:IceCandidate?){if(candidate!=null)socket?.emit("call:signal",signal(id).put("candidate",JSONObject().put("candidate",candidate.sdp).put("sdpMid",candidate.sdpMid).put("sdpMLineIndex",candidate.sdpMLineIndex)))}
            override fun onIceCandidatesRemoved(candidates:Array<out IceCandidate>?){}
            override fun onAddStream(stream:MediaStream?){stream?.videoTracks?.firstOrNull()?.let { publishVideo(id,it) }}
            override fun onRemoveStream(stream:MediaStream?){}
            override fun onDataChannel(channel:DataChannel?){}
            override fun onRenegotiationNeeded(){}
            override fun onAddTrack(receiver:RtpReceiver?, streams:Array<out MediaStream>?){(receiver?.track() as? VideoTrack)?.let { publishVideo(id,it) }}
        }) ?: return null
        peers[id]=pc
        pc.addTrack(audioTrack ?: return pc,listOf("vrot-stream"))
        localVideo?.let { pc.addTrack(it,listOf("vrot-stream")) }
        state.value=state.value.copy(peerCount=peers.size,status="Соединяемся…")
        if(initiator)pc.createOffer(object:SimpleSdpObserver(){override fun onCreateSuccess(desc:SessionDescription?){if(desc!=null)setLocalAndSignal(pc,id,desc)}},MediaConstraints())
        return pc
    }
    private fun publishVideo(id:String,track:VideoTrack){remoteVideos.value=remoteVideos.value + (id to track)}
    private fun signal(id:String)=JSONObject().put("target",JSONObject().put("kind",state.value.targetKind).put("id",state.value.targetId)).put("to",id)
    private fun setLocalAndSignal(pc:PeerConnection,id:String,description:SessionDescription){
        pc.setLocalDescription(object:SimpleSdpObserver(){override fun onSetSuccess(){socket?.emit("call:signal",signal(id).put("description",JSONObject().put("type",description.type.canonicalForm()).put("sdp",description.description))) }},description)
    }
    private val signalListener=Emitter.Listener { args ->
        val data=args.firstOrNull() as? JSONObject ?: return@Listener
        val id=data.optString("from");if(id.isBlank())return@Listener
        val pc=createPeer(id,false) ?: return@Listener
        data.optJSONObject("description")?.let { obj ->
            val description=SessionDescription(SessionDescription.Type.fromCanonicalForm(obj.getString("type")),obj.getString("sdp"))
            pc.setRemoteDescription(object:SimpleSdpObserver(){override fun onSetSuccess(){
                candidates.remove(id)?.forEach { pc.addIceCandidate(it) }
                if(description.type==SessionDescription.Type.OFFER)pc.createAnswer(object:SimpleSdpObserver(){override fun onCreateSuccess(answer:SessionDescription?){if(answer!=null)setLocalAndSignal(pc,id,answer)}},MediaConstraints())
            }},description)
        }
        data.optJSONObject("candidate")?.let { obj ->
            val c=IceCandidate(obj.optString("sdpMid"),obj.optInt("sdpMLineIndex"),obj.optString("candidate"))
            if(pc.remoteDescription!=null)pc.addIceCandidate(c) else candidates.getOrPut(id){ mutableListOf() }.add(c)
        }
    }
    private val leftListener=Emitter.Listener { args ->
        val id=(args.firstOrNull() as? JSONObject)?.optString("socketId") ?: return@Listener
        peers.remove(id)?.close()
        remoteVideos.value=remoteVideos.value-id
        if (state.value.targetKind == "friend") {
            status("Собеседник завершил вызов")
            main.postDelayed({ end() }, 1500)
        } else {
            state.value=state.value.copy(peerCount=peers.size,status=if(peers.isEmpty())"Ожидание собеседника…" else "На связи")
        }
    }
    private val joinedListener=Emitter.Listener {
        cancelTimeout()
        status("Подключаем участника…")
    }
    fun mute(){audioTrack?.setEnabled(state.value.muted);state.value=state.value.copy(muted=!state.value.muted)}
    fun end(){
        cancelTimeout()
        if (state.value.targetKind == "friend" && state.value.targetId.isNotEmpty()) {
            socket?.emit("call:cancel", JSONObject().put("friendId", state.value.targetId))
        }
        socket?.emit("call:leave");socket?.off("call:signal",signalListener);socket?.off("call:peer-left",leftListener);socket?.off("call:peer-joined",joinedListener)
        peers.values.forEach { it.close() };peers.clear();candidates.clear();remoteVideos.value=emptyMap()
        runCatching { capturer?.stopCapture() };capturer?.dispose();capturer=null;textureHelper?.dispose();textureHelper=null
        localVideo?.dispose();localVideo=null;videoSource?.dispose();videoSource=null;audioTrack?.dispose();audioTrack=null;audioSource?.dispose();audioSource=null;factory?.dispose();factory=null
        audioManager.mode=AudioManager.MODE_NORMAL
        state.value=CallState()
        CallService.stop(context)
    }
    private fun cancelTimeout() {
        callTimeoutRunnable?.let { main.removeCallbacks(it) }
        callTimeoutRunnable = null
    }
    private fun status(value:String){main.post { state.value=state.value.copy(status=value) }}
}
open class SimpleSdpObserver: SdpObserver {
    override fun onCreateSuccess(description:SessionDescription?){}
    override fun onSetSuccess(){}
    override fun onCreateFailure(error:String?){}
    override fun onSetFailure(error:String?){}
}
