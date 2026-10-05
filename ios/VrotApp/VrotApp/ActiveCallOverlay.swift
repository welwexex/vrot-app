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
    @State private var isCameraEnabled = true
    let onMinimize: () -> Void

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if callManager.state.isVideo && isCameraEnabled {
                // Live camera feed
                CameraPreviewView(isCameraActive: $isCameraEnabled)
                    .ignoresSafeArea()

                // Dark vignette overlay so text and controls remain crisp
                LinearGradient(
                    gradient: Gradient(colors: [Color.black.opacity(0.65), Color.clear, Color.black.opacity(0.8)]),
                    startPoint: .top,
                    endPoint: .bottom
                )
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
                    Text("Передача аудио и видео в iOS пока не подключена")
                        .font(.caption)
                        .foregroundColor(Theme.textSecondary)
                }
                .padding(.top, 60)

                Spacer()

                if !callManager.state.isVideo || !isCameraEnabled {
                    AvatarBadgeView(avatarUrl: callManager.state.avatarUrl, name: callManager.state.targetName, size: 120)
                }

                Spacer()

                // Call Controls
                HStack(spacing: 30) {
                    // Mute Audio
                    Button(action: {
                        callManager.state.isMuted.toggle()
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
                        }) {
                            Image(systemName: isCameraEnabled ? "video.fill" : "video.slash.fill")
                                .font(.system(size: 22))
                                .foregroundColor(Theme.textPrimary)
                                .frame(width: 64, height: 64)
                                .background(Theme.card.opacity(0.85))
                                .clipShape(Circle())
                        }
                    }

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
                .padding(.bottom, 50)
            }
        }
    }
}
