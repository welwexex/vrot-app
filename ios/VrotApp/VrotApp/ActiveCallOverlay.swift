import SwiftUI
import AVFoundation

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

        // Use front-facing camera for video calls
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
    let onMinimize: () -> Void

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if let remote = media.remoteVideos.first {
                RTCVideoSurface(track: remote.track)
                    .ignoresSafeArea()
                LinearGradient(colors: [.black.opacity(0.65), .clear, .black.opacity(0.72)], startPoint: .top, endPoint: .bottom)
                    .ignoresSafeArea()
            }

            VStack(spacing: 30) {
                // Header caller info
                VStack(spacing: 8) {
                    Button(action: onMinimize) {
                        Label(L("Чаты"), systemImage: "chevron.down")
                            .padding(.horizontal, 14).padding(.vertical, 9)
                    }
                    .modifier(VrotGlassBar())
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    Text(callManager.state.targetName.isEmpty ? "Собеседник" : callManager.state.targetName)
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
                    if media.connectedPeers > 0 {
                        Text("Участников в звонке: \(media.connectedPeers + 1)")
                            .font(.caption)
                            .foregroundColor(Theme.textSecondary)
                    }
                }
                .padding(.top, 60)

                Spacer()

                if media.remoteVideos.isEmpty {
                    AvatarBadgeView(avatarUrl: callManager.state.avatarUrl, name: callManager.state.targetName, size: 120)
                }

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
                HStack(spacing: 30) {
                    // Mute Audio
                    Button(action: {
                        callManager.state.isMuted.toggle()
                        media.setMuted(callManager.state.isMuted)
                    }) {
                        Image(systemName: callManager.state.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 64, height: 64)
                            .background(callManager.state.isMuted ? Theme.red : Theme.card.opacity(0.85))
                            .clipShape(Circle())
                    }

                    // Toggle Camera (if video call)
                    if callManager.state.isVideo {
                        Button(action: {
                            isCameraEnabled.toggle()
                            media.setVideoEnabled(isCameraEnabled)
                        }) {
                            Image(systemName: isCameraEnabled ? "video.fill" : "video.slash.fill")
                                .font(.system(size: 22))
                                .foregroundColor(Theme.textPrimary)
                                .frame(width: 64, height: 64)
                                .background(Theme.card.opacity(0.85))
                                .clipShape(Circle())
                        }
                    }

                    Button(action: {
                        if media.isScreenSharing { media.stopScreenShare() }
                        else { media.startScreenShare() }
                    }) {
                        Image(systemName: media.isScreenSharing ? "rectangle.on.rectangle.slash" : "rectangle.on.rectangle")
                            .font(.system(size: 22))
                            .foregroundColor(.white)
                            .frame(width: 64, height: 64)
                            .background(media.isScreenSharing ? Theme.accent : Theme.card.opacity(0.85))
                            .clipShape(Circle())
                    }
                    .accessibilityLabel(media.isScreenSharing ? "Остановить показ экрана VROT" : "Показать экран VROT")

                    // End Call
                    Button(action: {
                        callManager.endCall()
                    }) {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 28))
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 72, height: 72)
                            .background(Theme.red)
                            .clipShape(Circle())
                    }
                }
                Text("Показ экрана доступен внутри VROT")
                    .font(.caption2)
                    .foregroundColor(Theme.textSecondary)
                .padding(.bottom, 50)
            }
        }
    }
}
