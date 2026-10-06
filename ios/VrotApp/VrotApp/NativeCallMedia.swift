import Foundation
import AVFoundation
import SwiftUI
import WebRTC
import ReplayKit

struct RemoteCallVideo: Identifiable {
    let id: String
    let name: String
    let track: RTCVideoTrack
}

struct CallParticipant: Identifiable, Equatable {
    let id: String
    let name: String
    let avatarUrl: String?
}

struct RTCVideoSurface: UIViewRepresentable {
    let track: RTCVideoTrack
    final class Coordinator {
        let track: RTCVideoTrack
        init(track: RTCVideoTrack) { self.track = track }
    }

    func makeCoordinator() -> Coordinator { Coordinator(track: track) }

    func makeUIView(context: Context) -> RTCMTLVideoView {
        let view = RTCMTLVideoView(frame: .zero)
        view.videoContentMode = .scaleAspectFit
        track.add(view)
        return view
    }

    func updateUIView(_ view: RTCMTLVideoView, context: Context) {}

    static func dismantleUIView(_ view: RTCMTLVideoView, coordinator: Coordinator) {
        coordinator.track.remove(view)
    }
}

final class NativeCallMedia: ObservableObject {
    static let shared = NativeCallMedia()

    @Published private(set) var remoteVideos: [RemoteCallVideo] = []
    @Published private(set) var participants: [CallParticipant] = []
    @Published private(set) var localVideoTrack: RTCVideoTrack?
    @Published private(set) var connectedPeers = 0
    @Published private(set) var errorMessage = ""
    @Published private(set) var isScreenSharing = false

    private let factory: RTCPeerConnectionFactory
    private var audioTrack: RTCAudioTrack?
    private var videoCapturer: RTCCameraVideoCapturer?
    private var videoSource: RTCVideoSource?
    private var cameraEnabled = false
    private var peers: [String: RTCPeerConnection] = [:]
    private var delegates: [String: NativePeerDelegate] = [:]
    private var pendingCandidates: [String: [RTCIceCandidate]] = [:]
    private var iceServers: [RTCIceServer] = []
    private var target: [String: Any]?
    private var active = false

    private init() {
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }

    func start(targetId: String, kind: String = "friend", video: Bool) {
        stop()
        target = ["kind": kind, "id": targetId]
        active = true
        errorMessage = ""
        Task {
            do {
                let config = try await ApiService.shared.getObject(path: "/api/calls/ice")
                let entries = config["iceServers"] as? [[String: Any]] ?? []
                let servers = entries.compactMap { entry -> RTCIceServer? in
                    guard let urls = entry["urls"] as? [String] else { return nil }
                    return RTCIceServer(urlStrings: urls,
                                        username: entry["username"] as? String ?? "",
                                        credential: entry["credential"] as? String ?? "")
                }
                DispatchQueue.main.async {
                    guard self.active, (self.target?["id"] as? String) == targetId else { return }
                    self.iceServers = servers
                    self.prepareTracks(video: video)
                    RealtimeService.shared.sendCallJoin(targetId: targetId, kind: kind) { response in
                        guard response["ok"] as? Bool == true else {
                            self.errorMessage = response["error"] as? String ?? "Не удалось войти в звонок"
                            return
                        }
                        self.participants.removeAll()
                        for peer in response["peers"] as? [[String: Any]] ?? [] {
                            guard let socketId = peer["socketId"] as? String else { continue }
                            let user = peer["user"] as? [String: Any] ?? [:]
                            let name = user["displayName"] as? String ?? (user["username"] as? String ?? "Участник")
                            let avatar = user["avatarUrl"] as? String
                            self.participants.append(CallParticipant(id: socketId, name: name, avatarUrl: avatar))
                            self.createOffer(to: socketId, user: user)
                        }
                        if !self.participants.isEmpty {
                            self.connectedPeers = self.participants.count
                            CallManager.shared.cancelTimeout()
                            CallManager.shared.state.answered = true
                            CallManager.shared.state.status = "В звонке"
                        }
                    }
                }
            } catch {
                DispatchQueue.main.async { self.errorMessage = error.localizedDescription }
            }
        }
    }

    private func prepareTracks(video: Bool) {
        let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        audioTrack = factory.audioTrack(with: source, trackId: "vrot-audio")
        let videoSource = factory.videoSource()
        self.videoSource = videoSource
        let track = factory.videoTrack(with: videoSource, trackId: "vrot-video")
        localVideoTrack = track
        track.isEnabled = video
        let capturer = RTCCameraVideoCapturer(delegate: videoSource)
        videoCapturer = capturer
        cameraEnabled = video
        if video {
            if let camera = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }),
               let format = RTCCameraVideoCapturer.supportedFormats(for: camera).first(where: {
                   CMVideoFormatDescriptionGetDimensions($0.formatDescription).width >= 640
               }) ?? RTCCameraVideoCapturer.supportedFormats(for: camera).first {
                capturer.startCapture(with: camera, format: format, fps: 24)
            }
        }
    }

    private func peer(for socketId: String, user: [String: Any]) -> RTCPeerConnection? {
        if let existing = peers[socketId] { return existing }
        guard active else { return nil }
        let configuration = RTCConfiguration()
        configuration.iceServers = iceServers
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: ["DtlsSrtpKeyAgreement": "true"])
        let delegate = NativePeerDelegate(socketId: socketId, name: user["displayName"] as? String ?? user["username"] as? String ?? "Участник", owner: self)
        guard let connection = factory.peerConnection(with: configuration, constraints: constraints, delegate: delegate) else { return nil }
        delegates[socketId] = delegate
        peers[socketId] = connection
        if let audioTrack { connection.add(audioTrack, streamIds: ["vrot"]) }
        if let localVideoTrack { connection.add(localVideoTrack, streamIds: ["vrot"]) }
        return connection
    }

    private func createOffer(to socketId: String, user: [String: Any]) {
        guard let connection = peer(for: socketId, user: user) else { return }
        let constraints = RTCMediaConstraints(mandatoryConstraints: [
            kRTCMediaConstraintsOfferToReceiveAudio: kRTCMediaConstraintsValueTrue,
            kRTCMediaConstraintsOfferToReceiveVideo: kRTCMediaConstraintsValueTrue
        ], optionalConstraints: nil)
        connection.offer(for: constraints) { [weak self] description, error in
            guard let description else { self?.report(error); return }
            connection.setLocalDescription(description) { error in
                if let error { self?.report(error); return }
                self?.sendSignal(to: socketId, data: ["description": ["type": "offer", "sdp": description.sdp]])
            }
        }
    }

    func receiveSignal(_ payload: [String: Any]) {
        guard active, let socketId = payload["from"] as? String else { return }
        let connection = peer(for: socketId, user: payload["user"] as? [String: Any] ?? [:])
        guard let connection else { return }
        if let description = payload["description"] as? [String: Any],
           let type = description["type"] as? String,
           let sdp = description["sdp"] as? String {
            let rtcType: RTCSdpType = type == "offer" ? .offer : .answer
            connection.setRemoteDescription(RTCSessionDescription(type: rtcType, sdp: sdp)) { [weak self] error in
                if let error { self?.report(error); return }
                DispatchQueue.main.async {
                    self?.flushCandidates(for: socketId, connection: connection)
                    self?.updateRemoteVideo(for: socketId)
                }
                if rtcType == .offer {
                    let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
                    connection.answer(for: constraints) { [weak self] answer, error in
                        guard let answer else { self?.report(error); return }
                        connection.setLocalDescription(answer) { error in
                            if let error { self?.report(error); return }
                            self?.sendSignal(to: socketId, data: ["description": ["type": "answer", "sdp": answer.sdp]])
                        }
                    }
                }
            }
        }
        if let candidate = payload["candidate"] as? [String: Any],
           let sdp = candidate["candidate"] as? String {
            let line = (candidate["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0
            let ice = RTCIceCandidate(sdp: sdp, sdpMLineIndex: line, sdpMid: candidate["sdpMid"] as? String)
            if connection.remoteDescription == nil {
                pendingCandidates[socketId, default: []].append(ice)
            } else {
                connection.add(ice) { [weak self] error in if let error { self?.report(error) } }
            }
        }
    }

    private func flushCandidates(for id: String, connection: RTCPeerConnection) {
        for ice in pendingCandidates.removeValue(forKey: id) ?? [] {
            connection.add(ice) { [weak self] error in if let error { self?.report(error) } }
        }
    }

    private func updateRemoteVideo(for id: String) {
        guard let connection = peers[id], let delegate = delegates[id] else { return }
        guard let track = connection.transceivers.compactMap({ $0.receiver.track as? RTCVideoTrack }).first else { return }
        remoteVideos.removeAll { $0.id == id }
        remoteVideos.append(RemoteCallVideo(id: id, name: delegate.name, track: track))
    }

    fileprivate func candidate(_ candidate: RTCIceCandidate, from id: String) {
        sendSignal(to: id, data: ["candidate": [
            "candidate": candidate.sdp,
            "sdpMid": candidate.sdpMid as Any? ?? NSNull(),
            "sdpMLineIndex": candidate.sdpMLineIndex
        ]])
    }

    fileprivate func stateChanged(_ state: RTCIceConnectionState, for id: String) {
        DispatchQueue.main.async {
            if state == .connected || state == .completed {
                self.connectedPeers = self.peers.values.filter { $0.iceConnectionState == .connected || $0.iceConnectionState == .completed }.count
                self.updateRemoteVideo(for: id)
                CallManager.shared.cancelTimeout()
                CallManager.shared.state.answered = true
                CallManager.shared.state.status = "В звонке"
            } else if state == .failed {
                self.errorMessage = "Не удалось установить медиасоединение"
            }
        }
    }

    func peerJoined(socketId: String, user: [String: Any]) {
        guard active else { return }
        let name = user["displayName"] as? String ?? (user["username"] as? String ?? "Участник")
        let avatar = user["avatarUrl"] as? String
        if !participants.contains(where: { $0.id == socketId }) {
            participants.append(CallParticipant(id: socketId, name: name, avatarUrl: avatar))
        }
        connectedPeers = max(connectedPeers, participants.count)
        CallManager.shared.cancelTimeout()
        CallManager.shared.state.answered = true
        CallManager.shared.state.status = "В звонке"
    }

    func peerLeft(_ id: String) {
        peers.removeValue(forKey: id)?.close()
        delegates.removeValue(forKey: id)
        pendingCandidates.removeValue(forKey: id)
        remoteVideos.removeAll { $0.id == id }
        participants.removeAll { $0.id == id }
        connectedPeers = max(0, participants.count)
    }

    func setMuted(_ muted: Bool) { audioTrack?.isEnabled = !muted }
    func setVideoEnabled(_ enabled: Bool) {
        cameraEnabled = enabled
        guard !isScreenSharing else { return }
        localVideoTrack?.isEnabled = enabled
        if enabled, let capturer = videoCapturer,
           let camera = RTCCameraVideoCapturer.captureDevices().first(where: { $0.position == .front }),
           let format = RTCCameraVideoCapturer.supportedFormats(for: camera).first {
            capturer.startCapture(with: camera, format: format, fps: 24)
        } else if !enabled { videoCapturer?.stopCapture() }
    }

    func startScreenShare() {
        guard active, !isScreenSharing, let source = videoSource, let capturer = videoCapturer else { return }
        videoCapturer?.stopCapture()
        RPScreenRecorder.shared().startCapture(handler: { [weak self] buffer, kind, error in
            if let error { self?.report(error); return }
            guard kind == .video, let pixelBuffer = CMSampleBufferGetImageBuffer(buffer) else { return }
            let stamp = Int64(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer)) * 1_000_000_000)
            let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixelBuffer), rotation: ._0, timeStampNs: stamp)
            source.capturer(capturer, didCapture: frame)
        }, completionHandler: { [weak self] error in
            DispatchQueue.main.async {
                if let error { self?.report(error); return }
                self?.isScreenSharing = true
                self?.localVideoTrack?.isEnabled = true
            }
        })
    }

    func stopScreenShare() {
        guard isScreenSharing else { return }
        RPScreenRecorder.shared().stopCapture { [weak self] error in
            if let error { self?.report(error) }
            DispatchQueue.main.async {
                self?.isScreenSharing = false
                self?.setVideoEnabled(self?.cameraEnabled ?? false)
            }
        }
    }

    func stop() {
        active = false
        for connection in peers.values { connection.close() }
        peers.removeAll()
        delegates.removeAll()
        pendingCandidates.removeAll()
        if isScreenSharing { RPScreenRecorder.shared().stopCapture { _ in } }
        isScreenSharing = false
        videoCapturer?.stopCapture()
        videoCapturer = nil
        videoSource = nil
        localVideoTrack = nil
        audioTrack = nil
        remoteVideos = []
        participants = []
        connectedPeers = 0
        target = nil
    }

    private func sendSignal(to id: String, data: [String: Any]) {
        guard let target else { return }
        RealtimeService.shared.sendEvent("call:signal", payload: data.merging(["target": target, "to": id]) { current, _ in current })
    }

    private func report(_ error: Error?) {
        guard let error else { return }
        DispatchQueue.main.async { self.errorMessage = error.localizedDescription }
    }
}

private final class NativePeerDelegate: NSObject, RTCPeerConnectionDelegate {
    let socketId: String
    let name: String
    weak var owner: NativeCallMedia?

    init(socketId: String, name: String, owner: NativeCallMedia) {
        self.socketId = socketId
        self.name = name
        self.owner = owner
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) { owner?.stateChanged(newState, for: socketId) }
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) { owner?.candidate(candidate, from: socketId) }
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
}
