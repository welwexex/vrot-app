import SwiftUI

struct ChatView: View {
    let friend: [String: Any]
    let onBack: () -> Void

    @State private var messages: [[String: Any]] = []
    @State private var inputText: String = ""
    @State private var isLoading = true

    var body: some View {
        VStack(spacing: 0) {
            // Header
            let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "Чат")
            let friendId = friend["id"] as? String ?? ""

            HStack(spacing: 12) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(.white)
                }

                Circle()
                    .fill(Theme.accent)
                    .frame(width: 36, height: 36)
                    .overlay(
                        Text(String(name.prefix(1)).uppercased())
                            .font(.system(size: 14, weight: .bold))
                            .foregroundColor(.white)
                    )

                VStack(alignment: .leading, spacing: 2) {
                    Text(name)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(.white)
                    Text("В сети")
                        .font(.system(size: 11))
                        .foregroundColor(Theme.green)
                }

                Spacer()

                Button(action: {
                    CallManager.shared.startOutgoingCall(targetId: friendId, name: name, isVideo: false)
                }) {
                    Image(systemName: "phone.fill")
                        .foregroundColor(.white)
                        .padding(8)
                        .background(Theme.card)
                        .clipShape(Circle())
                }

                Button(action: {
                    CallManager.shared.startOutgoingCall(targetId: friendId, name: name, isVideo: true)
                }) {
                    Image(systemName: "video.fill")
                        .foregroundColor(.white)
                        .padding(8)
                        .background(Theme.card)
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.surface)

            // Message List
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(0..<messages.count, id: \.self) { idx in
                            let msg = messages[idx]
                            let text = msg["content"] as? String ?? ""
                            let author = msg["author"] as? [String: Any]
                            let isMe = (author?["id"] as? String) != (friend["id"] as? String)

                            HStack {
                                if isMe { Spacer() }

                                Text(text)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 10)
                                    .background(isMe ? Theme.accent : Theme.card)
                                    .foregroundColor(.white)
                                    .cornerRadius(16)
                                    .frame(maxWidth: 280, alignment: isMe ? .trailing : .leading)

                                if !isMe { Spacer() }
                            }
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

            // Input Bar
            HStack(spacing: 10) {
                TextField("Сообщение…", text: $inputText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.card)
                    .foregroundColor(.white)
                    .cornerRadius(20)

                Button(action: sendMessage) {
                    Image(systemName: "paperplane.fill")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                        .padding(10)
                        .background(Theme.accent)
                        .clipShape(Circle())
                }
                .disabled(inputText.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(Theme.surface)
        }
        .background(Theme.darkBg)
        .onAppear(perform: loadMessages)
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
}
