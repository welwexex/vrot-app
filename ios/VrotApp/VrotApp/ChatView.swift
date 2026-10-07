import SwiftUI
import AVFoundation
import PhotosUI
import UniformTypeIdentifiers
import AVKit

func deduplicatedMessages(_ messages: [[String: Any]]) -> [[String: Any]] {
    var ids = Set<String>()
    return messages.filter { message in
        guard let id = message["id"] as? String else { return true }
        return ids.insert(id).inserted
    }
}

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
    @State private var selectedMedia: PhotosPickerItem?
    @State private var showFiles = false
    @State private var attachmentError = ""
    @State private var showBotCommands = false
    @State private var botCommands: [[String: String]] = []
    @StateObject private var recorder = AudioRecorderManager.shared
    @StateObject private var player = AudioPlayerManager.shared

    private var isBot: Bool {
        if let b = friend["isBot"] as? Bool, b { return true }
        if (friend["presence"] as? String) == "bot" || (friend["status"] as? String) == "bot" { return true }
        if let u = friend["username"] as? String, u.lowercased().hasSuffix("bot") { return true }
        return false
    }

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
            RealtimeService.shared.onDirectMessage = nil
            RealtimeService.shared.onDirectMessageReaction = nil
        }
        .onChange(of: selectedMedia) { item in
            guard let item else { return }
            Task {
                guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                let mime = item.supportedContentTypes.first?.preferredMIMEType ?? "image/jpeg"
                await uploadAttachment(data: data, mime: mime, name: "media-\(UUID().uuidString)")
                selectedMedia = nil
            }
        }
        .fileImporter(isPresented: $showFiles, allowedContentTypes: [.image, .movie, .audio, .pdf]) { result in
            guard case .success(let url) = result else { return }
            let access = url.startAccessingSecurityScopedResource()
            defer { if access { url.stopAccessingSecurityScopedResource() } }
            guard let data = try? Data(contentsOf: url) else { attachmentError = "Не удалось прочитать файл"; return }
            let mime = (try? url.resourceValues(forKeys: [.contentTypeKey]).contentType)?.preferredMIMEType ?? "application/octet-stream"
            Task { await uploadAttachment(data: data, mime: mime, name: url.lastPathComponent) }
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
                    .foregroundColor(Theme.textPrimary)
            }

            Button(action: { showUserProfile = true }) {
                HStack(spacing: 10) {
                    AvatarBadgeView(avatarUrl: avatarUrl, name: name, size: 38)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(Theme.textPrimary)
                        Text(isBot ? "Бот" : ((friend["presence"] as? String) == "online" ? L("В сети") : L("Не в сети")))
                            .font(.system(size: 11))
                            .foregroundColor(isBot ? Color(red: 0.65, green: 0.55, blue: 0.98) : Theme.green)
                    }
                }
            }
            .buttonStyle(.plain)

            Spacer()

            if !isBot {
                Button(action: {
                    CallManager.shared.startOutgoingCall(targetId: friendId, name: name, avatarUrl: avatarUrl, isVideo: false)
                }) {
                    Image(systemName: "phone.fill")
                        .foregroundColor(Theme.textPrimary)
                        .padding(9)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                }

                Button(action: {
                    CallManager.shared.startOutgoingCall(targetId: friendId, name: name, avatarUrl: avatarUrl, isVideo: true)
                }) {
                    Image(systemName: "video.fill")
                        .foregroundColor(Theme.textPrimary)
                        .padding(9)
                        .background(Color.white.opacity(0.12))
                        .clipShape(Circle())
                        .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                }
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
                        let msgId = msg["id"] as? String ?? "\(idx)"
                        ChatMessageItemView(msg: msg, idx: idx, isMe: isMe, player: player, onReact: { emoji in
                            toggleReaction(messageId: msgId, emoji: emoji)
                        })
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
                    .foregroundColor(Theme.textPrimary)
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
            VStack(spacing: 4) {
              if showBotCommands {
                botCommandsView
              }
              if !attachmentError.isEmpty { Text(attachmentError).foregroundColor(Theme.red).font(.caption) }
              HStack(spacing: 8) {
                if isBot {
                    Button(action: {
                        withAnimation(.spring()) {
                            showBotCommands.toggle()
                        }
                    }) {
                        HStack(spacing: 4) {
                            Image(systemName: "line.3.horizontal")
                                .font(.system(size: 12, weight: .bold))
                            Text("Меню")
                                .font(.system(size: 12, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Color(red: 99/255, green: 102/255, blue: 241/255).opacity(0.35))
                        .cornerRadius(14)
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .stroke(Color(red: 99/255, green: 102/255, blue: 241/255).opacity(0.6), lineWidth: 1)
                        )
                    }
                } else {
                    PhotosPicker(selection: $selectedMedia, matching: .any(of: [.images, .videos])) {
                        Image(systemName: "photo.on.rectangle.angled").foregroundColor(Theme.accent)
                    }
                    Button(action: { showFiles = true }) {
                        Image(systemName: "paperclip").foregroundColor(Theme.accent)
                    }
                }
                TextField("Сообщение…", text: $inputText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.08))
                    .foregroundColor(Theme.textPrimary)
                    .cornerRadius(20)
                    .overlay(
                        RoundedRectangle(cornerRadius: 20)
                            .stroke(Color.white.opacity(0.18), lineWidth: 1)
                    )

                if inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    Button(action: { recorder.startRecording() }) {
                        Image(systemName: "mic.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(Theme.textPrimary)
                            .padding(10)
                            .background(Color.white.opacity(0.12))
                            .clipShape(Circle())
                            .overlay(Circle().stroke(Color.white.opacity(0.2), lineWidth: 1))
                    }
                } else {
                    Button(action: sendMessage) {
                        Image(systemName: "paperplane.fill")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(Theme.textPrimary)
                            .padding(10)
                            .background(Theme.accent)
                            .clipShape(Circle())
                    }
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

    @ViewBuilder
    private var botCommandsView: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("КОМАНДЫ БОТА")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(Theme.textSecondary)
                Spacer()
                Button(action: { withAnimation { showBotCommands = false } }) {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                }
            }
            .padding(.horizontal, 6)
            .padding(.top, 4)

            if botCommands.isEmpty {
                Text("Команды не настроены")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.textSecondary)
                    .padding(8)
            } else {
                ForEach(0..<botCommands.count, id: \.self) { idx in
                    let c = botCommands[idx]["command"] ?? ""
                    let d = botCommands[idx]["description"] ?? ""
                    Button(action: { selectBotCommand(c) }) {
                        HStack {
                            Text("/" + c)
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundColor(Color(red: 165/255, green: 180/255, blue: 252/255))
                            Spacer()
                            Text(d)
                                .font(.system(size: 12))
                                .foregroundColor(Theme.textSecondary)
                        }
                        .padding(.horizontal, 10)
                        .padding(.vertical, 7)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(8)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(10)
        .background(Color(red: 20/255, green: 24/255, blue: 38/255).opacity(0.96))
        .cornerRadius(14)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.white.opacity(0.15), lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.5), radius: 14, x: 0, y: 6)
        .padding(.horizontal, 8)
        .padding(.bottom, 6)
        .transition(.move(edge: .bottom).combined(with: .opacity))
    }

    private func selectBotCommand(_ cmd: String) {
        showBotCommands = false
        guard let id = friend["id"] as? String else { return }
        let text = "/" + cmd
        Task {
            do {
                let sent = try await ApiService.shared.post(path: "/api/friends/\(id)/messages", body: ["content": text, "clientMessageId": UUID().uuidString])
                await MainActor.run {
                    self.messages = deduplicatedMessages(self.messages + [sent])
                }
            } catch {
                print("Failed to send command: \(error)")
            }
        }
    }

    private func loadMessages() {
        guard let id = friend["id"] as? String else { return }
        if isBot {
            if let cmds = friend["botCommands"] as? [[String: Any]] {
                self.botCommands = cmds.map { [
                    "command": $0["command"] as? String ?? "",
                    "description": $0["description"] as? String ?? ""
                ]}
            }
            Task {
                if let resp = try? await ApiService.shared.getObject(path: "/api/bots/\(id)/commands"),
                   let list = resp["commands"] as? [[String: Any]] {
                    await MainActor.run {
                        self.botCommands = list.map { [
                            "command": $0["command"] as? String ?? "",
                            "description": $0["description"] as? String ?? ""
                        ]}
                    }
                }
            }
        }
        Task {
            do {
                let msgs = try await ApiService.shared.getArray(path: "/api/friends/\(id)/messages")
                await MainActor.run {
                    self.messages = deduplicatedMessages(msgs + self.messages)
                    self.isLoading = false
                }
            } catch {
                print("Failed to load messages: \(error)")
            }
        }

        RealtimeService.shared.onDirectMessage = { newMsg in
            DispatchQueue.main.async {
                guard let authorId = (newMsg["author"] as? [String: Any])?["id"] as? String,
                      authorId == id || (newMsg["recipientId"] as? String) == id else { return }
                self.messages = deduplicatedMessages(self.messages + [newMsg])
            }
        }

        RealtimeService.shared.onDirectMessageReaction = { payload in
            DispatchQueue.main.async {
                guard let messageId = payload["messageId"] as? String,
                      let reactions = payload["reactions"] as? [[String: Any]] else { return }
                self.updateMessageReactions(messageId: messageId, reactions: reactions)
            }
        }
    }

    private func toggleReaction(messageId: String, emoji: String) {
        Task {
            do {
                let res = try await ApiService.shared.post(
                    path: "/api/direct-messages/\(messageId)/reactions",
                    body: ["emoji": emoji]
                )
                if let newReactions = res["reactions"] as? [[String: Any]] {
                    await MainActor.run {
                        self.updateMessageReactions(messageId: messageId, reactions: newReactions)
                    }
                }
            } catch {
                print("Failed to toggle reaction: \(error)")
            }
        }
    }

    private func updateMessageReactions(messageId: String, reactions: [[String: Any]]) {
        for i in 0..<messages.count {
            if let id = messages[i]["id"] as? String, id == messageId {
                var updated = messages[i]
                updated["reactions"] = reactions
                messages[i] = updated
                break
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
                let sent = try await ApiService.shared.post(path: "/api/friends/\(id)/messages", body: ["content": text, "clientMessageId": UUID().uuidString])
                await MainActor.run {
                    self.messages = deduplicatedMessages(self.messages + [sent])
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
                        "attachmentId": attId,
                        "clientMessageId": UUID().uuidString
                    ]
                )
                await MainActor.run {
                    self.messages = deduplicatedMessages(self.messages + [sent])
                }
            } catch {
                print("Failed to send voice message: \(error)")
            }
        }
    }

    @MainActor private func uploadAttachment(data: Data, mime: String, name: String) async {
        guard let id = friend["id"] as? String else { return }
        guard data.count <= 20_000_000 else { attachmentError = "Файл больше 20 МБ"; return }
        do {
            let uploaded = try await ApiService.shared.uploadBinary(path: "/api/uploads", data: data, mimeType: mime, fileName: name)
            guard let attachmentId = uploaded["id"] as? String else { throw APIError.decodingError }
            let sent = try await ApiService.shared.post(path: "/api/friends/\(id)/messages", body: ["content": "", "attachmentId": attachmentId, "clientMessageId": UUID().uuidString])
            messages = deduplicatedMessages(messages + [sent])
            attachmentError = ""
        } catch { attachmentError = error.localizedDescription }
    }
}

struct VoiceMessageBubbleView: View {
    let isMe: Bool
    let msgId: String
    let attUrl: String
    @ObservedObject var player: AudioPlayerManager

    var body: some View {
        HStack(spacing: 10) {
            Button(action: {
                player.togglePlay(attachmentUrl: attUrl, messageId: msgId)
            }) {
                Image(systemName: (player.currentlyPlayingId == msgId && player.isPlaying) ? "pause.fill" : "play.fill")
                    .font(.system(size: 16))
                    .foregroundColor(Theme.textPrimary)
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
                        .foregroundColor(Theme.textPrimary)
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
            LinearGradient(colors: [Theme.accent, Color.purple.opacity(0.8)], startPoint: .topLeading, endPoint: .bottomTrailing)
            : LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing)
        )
        .cornerRadius(18)
        .overlay(
            RoundedRectangle(cornerRadius: 18)
                .stroke(Color.white.opacity(isMe ? 0.25 : 0.18), lineWidth: 1)
        )
    }
}

struct TextMessageBubbleView: View {
    let text: String
    let isMe: Bool

    var body: some View {
        Text(text)
            .font(.system(size: 15))
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                isMe ?
                LinearGradient(colors: [Theme.accent, Color.purple.opacity(0.8)], startPoint: .topLeading, endPoint: .bottomTrailing)
                : LinearGradient(colors: [Color.white.opacity(0.12), Color.white.opacity(0.06)], startPoint: .topLeading, endPoint: .bottomTrailing)
            )
            .foregroundColor(Theme.textPrimary)
            .cornerRadius(18)
            .overlay(
                RoundedRectangle(cornerRadius: 18)
                    .stroke(Color.white.opacity(isMe ? 0.25 : 0.18), lineWidth: 1)
            )
            .frame(maxWidth: 280, alignment: isMe ? .trailing : .leading)
    }
}

struct MessageInlineKeyboardView: View {
    let inlineKeyboard: [[[String: Any]]]
    let authorId: String
    let messageId: String

    var body: some View {
        VStack(spacing: 6) {
            ForEach(0..<inlineKeyboard.count, id: \.self) { rowIdx in
                let row = inlineKeyboard[rowIdx]
                HStack(spacing: 6) {
                    ForEach(0..<row.count, id: \.self) { btnIdx in
                        let btn = row[btnIdx]
                        let btnText = btn["text"] as? String ?? ""
                        let btnUrl = btn["url"] as? String
                        let callbackData = btn["callback_data"] as? String

                        Button(action: {
                            if let urlStr = btnUrl, let url = URL(string: urlStr) {
                                UIApplication.shared.open(url)
                            } else if let cb = callbackData {
                                Task {
                                    _ = try? await ApiService.shared.post(path: "/api/bots/callback", body: [
                                        "messageId": messageId,
                                        "authorId": authorId,
                                        "callbackData": cb
                                    ])
                                }
                            }
                        }) {
                            Text(btnText)
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.vertical, 8)
                                .padding(.horizontal, 12)
                                .frame(maxWidth: .infinity)
                                .background(Theme.glassCard)
                                .cornerRadius(12)
                                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.glassBorder, lineWidth: 1))
                        }
                    }
                }
            }
        }
        .frame(maxWidth: 280)
    }
}

struct ChatMessageItemView: View {
    let msg: [String: Any]
    let idx: Int
    let isMe: Bool
    @ObservedObject var player: AudioPlayerManager
    let onReact: (String) -> Void

    @State private var showReactionsBar = false

    var body: some View {
        let text = msg["content"] as? String ?? ""
        let attachment = msg["attachment"] as? [String: Any]
        let msgId = msg["id"] as? String ?? "\(idx)"
        let authorId = (msg["author"] as? [String: Any])?["id"] as? String ?? (msg["author_id"] as? String ?? "")
        let replyMarkup = msg["replyMarkup"] as? [String: Any]
        let inlineKeyboard = replyMarkup?["inline_keyboard"] as? [[[String: Any]]]
        let rawReactions = msg["reactions"] as? [[String: Any]] ?? []

        HStack {
            if isMe { Spacer() }

            VStack(alignment: isMe ? .trailing : .leading, spacing: 6) {
                if showReactionsBar {
                    HStack(spacing: 6) {
                        ForEach(["👍", "❤️", "😂", "🔥", "💎", "🚀", "🎉", "💩"], id: \.self) { emoji in
                            Button(action: {
                                withAnimation(.spring(response: 0.3, dampingFraction: 0.7)) {
                                    showReactionsBar = false
                                }
                                onReact(emoji)
                            }) {
                                Text(emoji)
                                    .font(.system(size: 22))
                                    .padding(3)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 22)
                            .fill(Color(red: 24/255, green: 28/255, blue: 44/255).opacity(0.96))
                            .overlay(RoundedRectangle(cornerRadius: 22).stroke(Color.white.opacity(0.2), lineWidth: 1))
                            .shadow(color: .black.opacity(0.5), radius: 12, y: 4)
                    )
                    .transition(.scale(scale: 0.8).combined(with: .opacity))
                }

                HStack(alignment: .bottom, spacing: 6) {
                    if isMe {
                        Button(action: {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                                showReactionsBar.toggle()
                            }
                        }) {
                            Image(systemName: "face.smiling")
                                .font(.system(size: 13))
                                .foregroundColor(Color.white.opacity(0.35))
                                .padding(4)
                        }
                        .buttonStyle(.plain)
                    }

                    VStack(alignment: isMe ? .trailing : .leading, spacing: 6) {
                        if let att = attachment,
                           let mime = att["mime"] as? String,
                           mime.hasPrefix("image/"),
                           let attUrl = att["url"] as? String {
                            AuthenticatedAttachmentView(path: attUrl, mime: mime, name: att["name"] as? String ?? "Фото")
                        } else if let att = attachment,
                           let mime = att["mime"] as? String,
                           mime.hasPrefix("audio/"),
                           let attUrl = att["url"] as? String {
                            VoiceMessageBubbleView(isMe: isMe, msgId: msgId, attUrl: attUrl, player: player)
                        } else if let att = attachment, let path = att["url"] as? String {
                            AuthenticatedAttachmentView(path: path, mime: att["mime"] as? String ?? "", name: att["name"] as? String ?? "Файл")
                        } else if !text.isEmpty {
                            TextMessageBubbleView(text: text, isMe: isMe)
                        }

                        if let keyboard = inlineKeyboard {
                            MessageInlineKeyboardView(inlineKeyboard: keyboard, authorId: authorId, messageId: msgId)
                        }
                    }
                    .onLongPressGesture {
                        let impact = UIImpactFeedbackGenerator(style: .medium)
                        impact.impactOccurred()
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                            showReactionsBar.toggle()
                        }
                    }

                    if !isMe {
                        Button(action: {
                            withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                                showReactionsBar.toggle()
                            }
                        }) {
                            Image(systemName: "face.smiling")
                                .font(.system(size: 13))
                                .foregroundColor(Color.white.opacity(0.35))
                                .padding(4)
                        }
                        .buttonStyle(.plain)
                    }
                }

                if !rawReactions.isEmpty {
                    HStack(spacing: 5) {
                        ForEach(0..<rawReactions.count, id: \.self) { rIdx in
                            let r = rawReactions[rIdx]
                            let emoji = r["emoji"] as? String ?? ""
                            let count = r["count"] as? Int ?? ((r["users"] as? [Any])?.count ?? 0)
                            let reacted = r["reacted"] as? Bool ?? false
                            if count > 0 && !emoji.isEmpty {
                                Button(action: { onReact(emoji) }) {
                                    HStack(spacing: 3) {
                                        Text(emoji).font(.system(size: 13))
                                        Text("\(count)")
                                            .font(.system(size: 11, weight: .bold))
                                            .foregroundColor(reacted ? .white : Theme.textSecondary)
                                    }
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(reacted ? Theme.accent.opacity(0.4) : Color.white.opacity(0.12))
                                    .cornerRadius(12)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 12)
                                            .stroke(reacted ? Theme.accent : Color.white.opacity(0.18), lineWidth: 1)
                                    )
                                }
                                .buttonStyle(.plain)
                            }
                        }

                        Button(action: {
                            withAnimation(.spring()) { showReactionsBar.toggle() }
                        }) {
                            Image(systemName: "plus")
                                .font(.system(size: 10, weight: .bold))
                                .foregroundColor(Theme.textSecondary)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 4)
                                .background(Color.white.opacity(0.08))
                                .cornerRadius(10)
                        }
                        .buttonStyle(.plain)
                    }
                }
            }

            if !isMe { Spacer() }
        }
    }
}

struct AuthenticatedAttachmentView: View {
    let path: String
    let mime: String
    let name: String
    @State private var image: UIImage?
    @State private var localURL: URL?
    @State private var showVideo = false
    @State private var expanded = false

    var body: some View {
        Group {
            if mime.hasPrefix("image/"), let image {
                Button(action: { expanded = true }) {
                    Image(uiImage: image).resizable().scaledToFit().frame(maxWidth: 250, maxHeight: 300).clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .sheet(isPresented: $expanded) { Image(uiImage: image).resizable().scaledToFit().background(.black).ignoresSafeArea() }
            } else if mime.hasPrefix("video/"), let localURL {
                Button(action: { showVideo = true }) { Label(name, systemImage: "play.rectangle.fill") }
                    .sheet(isPresented: $showVideo) { VideoPlayer(player: AVPlayer(url: localURL)) }
            } else if let localURL {
                ShareLink(item: localURL) { Label(name, systemImage: "square.and.arrow.up") }
            } else {
                Label(name, systemImage: mime.hasPrefix("video/") ? "video" : "paperclip")
                    .foregroundColor(Theme.textSecondary)
            }
        }
        .task(id: path) {
            guard let url = ApiService.resolveMediaURL(path) else { return }
            var request = URLRequest(url: url)
            if let cookie = SessionStore.shared.cookie() { request.setValue(cookie, forHTTPHeaderField: "Cookie") }
            guard let (data, response) = try? await URLSession.shared.data(for: request),
                  (response as? HTTPURLResponse)?.statusCode == 200 else { return }
            if mime.hasPrefix("image/") { image = UIImage(data: data) }
            else {
                let destination = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + "-" + name)
                if (try? data.write(to: destination, options: .atomic)) != nil { localURL = destination }
            }
        }
    }
}
