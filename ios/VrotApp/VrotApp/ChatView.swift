import SwiftUI
import AVFoundation

final class AudioRecorderManager: NSObject, ObservableObject, AVAudioRecorderDelegate {
    static let shared = AudioRecorderManager()

    @Published var isRecording = false
    @Published var recordDuration: TimeInterval = 0

    private var audioRecorder: AVAudioRecorder?
    private var timer: Timer?
    private var recordedURL: URL?

    override init() {
        super.init()
    }

    func startRecording() {
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
            try audioSession.setActive(true)

            let docDir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let audioFilename = docDir.appendingPathComponent("voice_\(UUID().uuidString).m4a")
            self.recordedURL = audioFilename

            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44100.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]

            audioRecorder = try AVAudioRecorder(url: audioFilename, settings: settings)
            audioRecorder?.delegate = self
            audioRecorder?.record()

            isRecording = true
            recordDuration = 0

            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                guard let self = self else { return }
                self.recordDuration += 0.1
            }
        } catch {
            print("Failed to start audio recording: \(error.localizedDescription)")
            isRecording = false
        }
    }

    func stopRecording() -> (Data, String)? {
        guard isRecording else { return nil }
        timer?.invalidate()
        timer = nil
        isRecording = false

        audioRecorder?.stop()
        audioRecorder = nil

        if let url = recordedURL, let data = try? Data(contentsOf: url) {
            let fileName = url.lastPathComponent
            try? FileManager.default.removeItem(at: url)
            return (data, fileName)
        }
        return nil
    }

    func cancelRecording() {
        timer?.invalidate()
        timer = nil
        isRecording = false
        audioRecorder?.stop()
        audioRecorder = nil
        if let url = recordedURL {
            try? FileManager.default.removeItem(at: url)
        }
        recordedURL = nil
    }
}

final class AudioPlayerManager: NSObject, ObservableObject, AVAudioPlayerDelegate {
    static let shared = AudioPlayerManager()

    @Published var currentlyPlayingId: String? = nil
    @Published var isPlaying = false
    @Published var progress: Double = 0

    private var player: AVAudioPlayer?
    private var progressTimer: Timer?

    func togglePlay(attachmentUrl: String, messageId: String) {
        if currentlyPlayingId == messageId && isPlaying {
            pause()
            return
        }

        stop()
        currentlyPlayingId = messageId

        let fullUrlString = attachmentUrl.hasPrefix("http") ? attachmentUrl : "https://api.vrot.fun" + attachmentUrl
        guard let url = URL(string: fullUrlString) else { return }

        // Download or stream data
        Task {
            var req = URLRequest(url: url)
            if let cookie = SessionStore.shared.cookie() {
                req.setValue(cookie, forHTTPHeaderField: "Cookie")
            }
            req.setValue("https://vrot.fun", forHTTPHeaderField: "Origin")

            guard let (data, _) = try? await URLSession.shared.data(for: req) else { return }

            await MainActor.run {
                do {
                    let audioSession = AVAudioSession.sharedInstance()
                    try audioSession.setCategory(.playback, mode: .default)
                    try audioSession.setActive(true)

                    self.player = try AVAudioPlayer(data: data)
                    self.player?.delegate = self
                    self.player?.play()
                    self.isPlaying = true

                    self.progressTimer?.invalidate()
                    self.progressTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                        guard let self = self, let p = self.player else { return }
                        self.progress = p.duration > 0 ? (p.currentTime / p.duration) : 0
                    }
                } catch {
                    print("Error playing audio: \(error)")
                    self.isPlaying = false
                    self.currentlyPlayingId = nil
                }
            }
        }
    }

    func pause() {
        player?.pause()
        isPlaying = false
        progressTimer?.invalidate()
    }

    func stop() {
        player?.stop()
        player = nil
        isPlaying = false
        currentlyPlayingId = nil
        progress = 0
        progressTimer?.invalidate()
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            self.stop()
        }
    }
}

struct ChatView: View {
    let friend: [String: Any]
    let onBack: () -> Void

    @State private var messages: [[String: Any]] = []
    @State private var inputText: String = ""
    @State private var isLoading = true
    @State private var showUserProfile = false
    @StateObject private var recorder = AudioRecorderManager.shared
    @StateObject private var player = AudioPlayerManager.shared

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            VStack(spacing: 0) {
                chatHeader

                messageList

                chatInputSection
            }

            if showUserProfile {
                UserProfileCardModal(user: friend, onDismiss: {
                    showUserProfile = false
                })
                .transition(.opacity)
            }
        }
        .onAppear(perform: loadMessages)
        .onDisappear {
            player.stop()
        }
    }

    private var chatHeader: some View {
        let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "Чат")
        let friendId = friend["id"] as? String ?? ""
        let avatarUrl = friend["avatarUrl"] as? String

        return HStack(spacing: 12) {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(.white)
            }

            Button(action: { showUserProfile = true }) {
                HStack(spacing: 10) {
                    AvatarBadgeView(avatarUrl: avatarUrl, name: name, size: 38)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        Text("В сети")
                            .font(.system(size: 11))
                            .foregroundColor(Theme.green)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer()

            Button(action: {
                CallManager.shared.startOutgoingCall(targetId: friendId, name: name, isVideo: false)
            }) {
                Image(systemName: "phone.fill")
                    .foregroundColor(.white)
                    .padding(9)
                    .background(Color.white.opacity(0.12))
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
            }

            Button(action: {
                CallManager.shared.startOutgoingCall(targetId: friendId, name: name, isVideo: true)
            }) {
                Image(systemName: "video.fill")
                    .foregroundColor(.white)
                    .padding(9)
                    .background(Color.white.opacity(0.12))
                    .clipShape(Circle())
                    .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color.white.opacity(0.08))
        .background(Color(red: 24/255, green: 28/255, blue: 42/255).opacity(0.85))
        .overlay(
            Rectangle()
                .frame(height: 1)
                .foregroundColor(Color.white.opacity(0.15)),
            alignment: .bottom
        )
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(0..<messages.count, id: \.self) { idx in
                        let msg = messages[idx]
                        let author = msg["author"] as? [String: Any]
                        let isMe = (author?["id"] as? String) != (friend["id"] as? String)
                        ChatMessageItemView(msg: msg, idx: idx, isMe: isMe, player: player)
                            .id(idx)
                    }
                }
                .padding(16)
            }
            .onChange(of: messages.count) { _ in
                if !messages.isEmpty {
                    proxy.scrollTo(messages.count - 1)
                }
            }
        }
    }

    @ViewBuilder
    private var chatInputSection: some View {
        if recorder.isRecording {
            HStack(spacing: 16) {
                Circle().fill(Theme.red).frame(width: 12, height: 12)
                Text(String(format: "Запись: %.1f сек", recorder.recordDuration))
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundColor(.white)
                Spacer()
                Button(action: { recorder.cancelRecording() }) {
                    Text("Отмена").font(.system(size: 14, weight: .medium)).foregroundColor(Theme.textSecondary)
                }
                Button(action: sendRecordedVoice) {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 32)).foregroundColor(Theme.accent)
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.08))
            .background(Color(red: 24/255, green: 28/255, blue: 42/255).opacity(0.85))
        } else {
            HStack(spacing: 10) {
                TextField("Сообщение…", text: $inputText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.08))
                    .foregroundColor(.white)
                    .cornerRadius(20)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20)
                            .stroke(Color.white.opacity(0.18), lineWidth: 1)
                    )

                if inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: { recorder.startRecording() }) {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                    }
                } else {
                    Button(action: sendMessage) {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Theme.accent)
                            .clipShape(Circle())
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Color.white.opacity(0.08))
            .background(Color(red: 24/255, green: 28/255, blue: 42/255).opacity(0.85))
            .overlay(
                Rectangle()
                    .frame(height: 1)
                    .foregroundColor(Color.white.opacity(0.15)),
                alignment: .top
            )
        }
    }

            // User Profile Modal Sheet Overlay
            if showUserProfile {
                UserProfileCardModal(user: friend, onDismiss: {
                    showUserProfile = false
                })
                .transition(.opacity)
            }
        }
        .onAppear(perform: loadMessages)
        .onDisappear {
            player.stop()
        }
    }

    private func loadMessages() {
        guard let id = friend["id"] as? String else { return }
        Task {
            do {
                let msgs = try await ApiService.shared.getArray(path: "/api/friends/\(id)/messages")
                await MainActor.run {
                    self.messages = msgs
                    self.isLoading = false
                }
            } catch {
                print("Failed to load messages: \(error)")
            }
        }

        RealtimeService.shared.onDirectMessage = { newMsg in
            DispatchQueue.main.async {
                self.messages.append(newMsg)
            }
        }
    }

    private func sendMessage() {
        guard let id = friend["id"] as? String else { return }
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""

        Task {
            do {
                let sent = try await ApiService.shared.post(path: "/api/friends/\(id)/messages", body: ["content": text])
                await MainActor.run {
                    self.messages.append(sent)
                }
            } catch {
                print("Failed to send message: \(error)")
            }
        }
    }

    private func sendRecordedVoice() {
        guard let (audioData, fileName) = recorder.stopRecording(),
              let id = friend["id"] as? String else { return }

        Task {
            do {
                // Upload binary voice audio
                let uploadResp = try await ApiService.shared.uploadBinary(
                    path: "/api/uploads",
                    data: audioData,
                    mimeType: "audio/mp4",
                    fileName: fileName
                )
                guard let attId = uploadResp["id"] as? String else { return }

                // Post message with attachmentId
                let sent = try await ApiService.shared.post(
                    path: "/api/friends/\(id)/messages",
                    body: [
                        "content": "🎤 Голосовое сообщение",
                        "attachmentId": attId
                    ]
                )
                await MainActor.run {
                    self.messages.append(sent)
                }
            } catch {
                print("Failed to send voice message: \(error)")
            }
        }
    }
}

struct ChatMessageItemView: View {
    let msg: [String: Any]
    let idx: Int
    let isMe: Bool
    @ObservedObject var player: AudioPlayerManager

    var body: some View {
        let text = msg["content"] as? String ?? ""
        let attachment = msg["attachment"] as? [String: Any]
        let msgId = msg["id"] as? String ?? "\(idx)"

        HStack {
            if isMe { Spacer() }

            VStack(alignment: isMe ? .trailing : .leading, spacing: 6) {
                if let att = attachment,
                   let mime = att["mime"] as? String,
                   mime.hasPrefix("audio/"),
                   let attUrl = att["url"] as? String {
                    // Voice message bubble
                    HStack(spacing: 10) {
                        Button(action: {
                            player.togglePlay(attachmentUrl: attUrl, messageId: msgId)
                        }) {
                            Image(systemName: (player.currentlyPlayingId == msgId && player.isPlaying) ? "pause.fill" : "play.fill")
                                .font(.system(size: 16))
                                .foregroundColor(.white)
                                .padding(10)
                                .background(isMe ? Color.white.opacity(0.25) : Theme.accent)
                                .clipShape(Circle())
                        }

                        VStack(alignment: .leading, spacing: 4) {
                            HStack {
                                Image(systemName: "waveform")
                                    .font(.system(size: 13))
                                    .foregroundColor(.white.opacity(0.85))
                                Text("Голосовое сообщение")
                                    .font(.system(size: 12, weight: .medium))
                                    .foregroundColor(.white)
                            }

                            if player.currentlyPlayingId == msgId {
                                GeometryReader { geo in
                                    ZStack(alignment: .leading) {
                                        Rectangle()
                                            .fill(Color.white.opacity(0.25))
                                            .frame(height: 4)
                                            .cornerRadius(2)
                                        Rectangle()
                                            .fill(Color.white)
                                            .frame(width: geo.size.width * CGFloat(player.progress), height: 4)
                                            .cornerRadius(2)
                                    }
                                }
                                .frame(height: 4)
                            }
                        }
                        .frame(minWidth: 140)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(
                        isMe ?
                        LinearGradient(colors: [Theme.accent, Theme.accentGradientEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
                        : LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    )
                    .cornerRadius(18)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18)
                            .stroke(Color.white.opacity(isMe ? 0.25 : 0.18), lineWidth: 1)
                    )
                } else if !text.isEmpty {
                    Text(text)
                        .font(.system(size: 15))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            isMe ?
                            LinearGradient(colors: [Theme.accent, Theme.accentGradientEnd], startPoint: .topLeading, endPoint: .bottomTrailing)
                            : LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing)
                        )
                        .foregroundColor(.white)
                        .cornerRadius(18)
                        .overlay(
                            RoundedRectangle(cornerRadius: 18)
                                .stroke(Color.white.opacity(isMe ? 0.25 : 0.18), lineWidth: 1)
                        )
                        .frame(maxWidth: 280, alignment: isMe ? .trailing : .leading)
                }
            }

            if !isMe { Spacer() }
        }
    }
}
