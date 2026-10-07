import SwiftUI
import AVFoundation
import ReplayKit

struct SystemBroadcastPickerView: UIViewRepresentable {
    func makeUIView(context: Context) -> RPSystemBroadcastPickerView {
        let picker = RPSystemBroadcastPickerView(frame: CGRect(x: 0, y: 0, width: 44, height: 44))
        picker.showsMicrophoneButton = false
        for subview in picker.subviews {
            if let button = subview as? UIButton {
                button.tintColor = .white
            }
        }
        return picker
    }

    func updateUIView(_ uiView: RPSystemBroadcastPickerView, context: Context) {}
}

struct CameraPreviewView: UIViewRepresentable {
    @Binding var isCameraActive: Bool

    func makeUIView(context: Context) -> CameraPreviewUIView {
        let view = CameraPreviewUIView()
        view.setupCamera()
        return view
    }

    func updateUIView(_ uiView: CameraPreviewUIView, context: Context) {
        if isCameraActive {
            uiView.startSession()
        } else {
            uiView.stopSession()
        }
    }
}

final class CameraPreviewUIView: UIView {
    private var captureSession: AVCaptureSession?
    private var previewLayer: AVCaptureVideoPreviewLayer?

    override func layoutSubviews() {
        super.layoutSubviews()
        previewLayer?.frame = self.bounds
    }

    func setupCamera() {
        let session = AVCaptureSession()
        session.sessionPreset = .high

        let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) ?? AVCaptureDevice.default(for: .video)
        guard let camera = device, let input = try? AVCaptureDeviceInput(device: camera) else { return }

        if session.canAddInput(input) {
            session.addInput(input)
        }

        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        layer.frame = self.bounds
        self.layer.addSublayer(layer)

        self.previewLayer = layer
        self.captureSession = session
        startSession()
    }

    func startSession() {
        guard let session = captureSession, !session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            session.startRunning()
        }
    }

    func stopSession() {
        guard let session = captureSession, session.isRunning else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            session.stopRunning()
        }
    }

    deinit {
        stopSession()
    }
}

struct ActiveCallOverlay: View {
    @ObservedObject var callManager = CallManager.shared
    @ObservedObject var media = NativeCallMedia.shared
    @State private var isCameraEnabled = true
    @State private var isSpeakerOn = true
    let onMinimize: () -> Void

    private var allParticipantsCount: Int {
        max(1, media.participants.count + 1)
    }

    private var callerDisplayName: String {
        if !callManager.state.targetName.isEmpty {
            return callManager.state.targetName
        }
        if let first = media.participants.first {
            return first.name
        }
        return "Собеседник"
    }

    private func toggleSpeaker() {
        isSpeakerOn.toggle()
        let session = AVAudioSession.sharedInstance()
        do {
            if isSpeakerOn {
                try session.overrideOutputAudioPort(.speaker)
                UIDevice.current.isProximityMonitoringEnabled = false
            } else {
                try session.overrideOutputAudioPort(.none)
                UIDevice.current.isProximityMonitoringEnabled = true
            }
        } catch {
            print("Failed to toggle speaker port: \(error)")
        }
    }

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if let remote = media.remoteVideos.first {
                RTCVideoSurface(track: remote.track)
                    .ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.72)], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
            }

            VStack(spacing: 24) {
                // Header caller info
                VStack(spacing: 8) {
                    Button(action: onMinimize) {
                        Label(L("Чаты"), systemImage: "chevron.down")
                            .padding(.horizontal, 14).padding(.vertical, 9)
                    }
                    .modifier(VrotGlassBar())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)

                    Text(callerDisplayName)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                        .shadow(radius: 4)

                    HStack(spacing: 6) {
                        if callManager.state.isVideo {
                            Image(systemName: "video.fill")
                                .foregroundColor(Theme.green)
                        }
                        Text(callManager.state.status)
                            .font(.system(size: 16))
                            .foregroundColor(Theme.textPrimary)
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 6)
                    .background(Color.black.opacity(0.4))
                    .cornerRadius(12)

                    if !media.errorMessage.isEmpty {
                        Text(media.errorMessage)
                            .font(.caption)
                            .foregroundColor(Theme.red)
                    }

                    if media.participants.count > 0 {
                        Text("В звонке: \(allParticipantsCount)")
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                    }
                }
                .padding(.top, 50)

                Spacer()

                // Center area: If video is off, show avatars
                if media.remoteVideos.isEmpty {
                    if media.participants.count <= 1 {
                        // Single Person Call
                        VStack(spacing: 16) {
                            ZStack {
                                Circle()
                                    .stroke(Theme.accent.opacity(callManager.state.status == "В звонке" ? 0.6 : 0.3), lineWidth: 3)
                                    .frame(width: 144, height: 144)
                                AvatarBadgeView(
                                    avatarUrl: callManager.state.avatarUrl ?? media.participants.first?.avatarUrl,
                                    name: callerDisplayName,
                                    size: 130
                                )
                            }
                            Text(callerDisplayName)
                                .font(.system(size: 20, weight: .semibold))
                                .foregroundColor(Theme.textPrimary)
                        }
                    } else {
                        // Multiple Participants (Group Call)
                        VStack(spacing: 12) {
                            Text("Участники (\(allParticipantsCount))")
                                .font(.system(size: 14, weight: .semibold))
                                .foregroundColor(Theme.textSecondary)

                            ScrollView(.vertical, showsIndicators: false) {
                                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 12) {
                                    ForEach(media.participants) { p in
                                        VStack(spacing: 8) {
                                            AvatarBadgeView(avatarUrl: p.avatarUrl, name: p.name, size: 64)
                                            Text(p.name)
                                                .font(.system(size: 13, weight: .semibold))
                                                .foregroundColor(Theme.textPrimary)
                                                .lineLimit(1)
                                            HStack(spacing: 4) {
                                                Circle()
                                                    .fill(Theme.green)
                                                    .frame(width: 6, height: 6)
                                                Text("В сети")
                                                    .font(.system(size: 11))
                                                    .foregroundColor(Theme.textSecondary)
                                            }
                                        }
                                        .frame(maxWidth: .infinity)
                                        .padding(.vertical, 12)
                                        .background(Theme.glassCard)
                                        .cornerRadius(16)
                                        .overlay(
                                            RoundedRectangle(cornerRadius: 16)
                                                .stroke(Theme.glassBorder, lineWidth: 1)
                                        )
                                    }
                                }
                                .padding(.horizontal, 20)
                            }
                            .frame(maxHeight: 260)
                        }
                    }
                }

                // Local video preview
                if isCameraEnabled, let localTrack = media.localVideoTrack, callManager.state.isVideo {
                    RTCVideoSurface(track: localTrack)
                        .frame(width: 104, height: 142)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.3)))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.trailing, 20)
                }

                if media.remoteVideos.count > 1 {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(Array(media.remoteVideos.dropFirst())) { remote in
                                VStack(spacing: 4) {
                                    RTCVideoSurface(track: remote.track)
                                        .frame(width: 112, height: 84)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                    Text(remote.name).font(.caption2).lineLimit(1)
                                }
                                .frame(width: 112)
                            }
                        }
                        .padding(.horizontal, 16)
                    }
                }

                Spacer()

                // Call Controls
                HStack(spacing: 16) {
                    // Mute Audio
                    Button(action: {
                        callManager.state.isMuted.toggle()
                        media.setMuted(callManager.state.isMuted)
                    }) {
                        Image(systemName: callManager.state.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 20))
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 54, height: 54)
                            .background(callManager.state.isMuted ? Theme.red : Theme.card.opacity(0.85))
                            .clipShape(Circle())
                    }
                    .accessibilityLabel(callManager.state.isMuted ? "Включить микрофон" : "Выключить микрофон")

                    // Toggle Speaker / Earpiece with proximity monitoring
                    Button(action: toggleSpeaker) {
                        Image(systemName: isSpeakerOn ? "speaker.wave.3.fill" : "ear.fill")
                            .font(.system(size: 20))
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 54, height: 54)
                            .background(isSpeakerOn ? Theme.accent.opacity(0.85) : Theme.card.opacity(0.85))
                            .clipShape(Circle())
                    }
                    .accessibilityLabel(isSpeakerOn ? "Громкая связь (динамик)" : "Разговорный динамик (ухо)")

                    // Toggle Camera (if video call)
                    if callManager.state.isVideo {
                        Button(action: {
                            isCameraEnabled.toggle()
                            media.setVideoEnabled(isCameraEnabled)
                        }) {
                            Image(systemName: isCameraEnabled ? "video.fill" : "video.slash.fill")
                                .font(.system(size: 19))
                                .foregroundColor(Theme.textPrimary)
                                .frame(width: 54, height: 54)
                                .background(Theme.card.opacity(0.85))
                                .clipShape(Circle())
                        }
                    }

                    // Global System Screen Share (Broadcast Picker across all apps)
                    ZStack {
                        Image(systemName: "rectangle.on.rectangle")
                            .font(.system(size: 19))
                            .foregroundColor(.white)
                        SystemBroadcastPickerView()
                            .frame(width: 54, height: 54)
                            .opacity(0.02)
                    }
                    .frame(width: 54, height: 54)
                    .background(Theme.card.opacity(0.85))
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                    .accessibilityLabel("Трансляция экрана всего устройства")

                    // End Call
                    Button(action: {
                        callManager.endCall()
                    }) {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 62, height: 62)
                            .background(Theme.red)
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("Завершить вызов")
                }

                HStack(spacing: 8) {
                    Text(isSpeakerOn ? "Динамик: Громкая связь" : "Динамик: В ухе (экран гаснет)")
                        .font(.caption2)
                        .foregroundColor(Theme.textSecondary)
                }
                .padding(.bottom, 36)
            }
        }
        .onAppear {
            isSpeakerOn = true
            let session = AVAudioSession.sharedInstance()
            try? session.overrideOutputAudioPort(.speaker)
            UIDevice.current.isProximityMonitoringEnabled = false
        }
        .onDisappear {
            UIDevice.current.isProximityMonitoringEnabled = false
        }
    }
}
