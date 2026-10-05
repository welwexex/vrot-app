import SwiftUI

struct CommunityDetailView: View {
    let community: [String: Any]
    let onBack: () -> Void

    @State private var channels: [[String: Any]] = []
    @State private var members: [[String: Any]] = []
    @State private var activeChannel: [String: Any]?
    @State private var showAddChannel = false
    @State private var newChannelName = ""
    @State private var newChannelKind = "text"
    @State private var isLoading = true

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if let ch = activeChannel {
                ChannelChatView(community: community, channel: ch, onBack: { activeChannel = nil })
            } else {
                VStack(spacing: 0) {
                    // Header
                    let commName = community["name"] as? String ?? "Сообщество"
                    HStack(spacing: 12) {
                        Button(action: onBack) {
                            Image(systemName: "chevron.left")
                                .font(.system(size: 18, weight: .semibold))
                                .foregroundColor(Theme.textPrimary)
                        }

                        RoundedRectangle(cornerRadius: 8)
                            .fill(Theme.accent)
                            .frame(width: 36, height: 36)
                            .overlay(
                                Text(String(commName.prefix(1)).uppercased())
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(Theme.textPrimary)
                            )

                        Text(commName)
                            .font(.system(size: 18, weight: .bold))
                            .foregroundColor(Theme.textPrimary)

                        Spacer()

                        Button(action: { showAddChannel = true }) {
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(Theme.accent)
                                .padding(8)
                                .background(Theme.card)
                                .clipShape(Circle())
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 12)
                    .background(Theme.surface)

                    // Channels list
                    List {
                        Section(header: Text("КАНАЛЫ").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.textSecondary)) {
                            ForEach(channels, id: \.description) { ch in
                                let name = ch["name"] as? String ?? ""
                                let kind = ch["kind"] as? String ?? "text"

                                HStack(spacing: 12) {
                                    Image(systemName: kind == "voice" ? "speaker.wave.2.fill" : "number")
                                        .foregroundColor(Theme.textSecondary)

                                    Text(name)
                                        .foregroundColor(Theme.textPrimary)
                                        .font(.system(size: 16, weight: .medium))

                                    Spacer()

                                    if kind == "voice" {
                                        Button(action: {
                                            CallManager.shared.startOutgoingCall(targetId: ch["id"] as? String ?? "", name: "# \(name)", isVideo: false)
                                        }) {
                                            Text("Войти")
                                                .font(.system(size: 12, weight: .bold))
                                                .foregroundColor(Theme.green)
                                                .padding(.horizontal, 10)
                                                .padding(.vertical, 4)
                                                .background(Theme.card)
                                                .cornerRadius(6)
                                        }
                                        .buttonStyle(BorderlessButtonStyle())
                                    }
                                }
                                .padding(.vertical, 6)
                                .listRowBackground(Theme.darkBg)
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    if kind == "text" {
                                        activeChannel = ch
                                    } else {
                                        CallManager.shared.startOutgoingCall(targetId: ch["id"] as? String ?? "", name: "# \(name)", isVideo: false)
                                    }
                                }
                            }
                        }

                        Section(header: Text("УЧАСТНИКИ").font(.system(size: 12, weight: .bold)).foregroundColor(Theme.textSecondary)) {
                            ForEach(members, id: \.description) { m in
                                let name = m["displayName"] as? String ?? (m["username"] as? String ?? "Участник")
                                let role = m["role"] as? String ?? "member"
                                let presence = m["presence"] as? String ?? "offline"

                                HStack(spacing: 10) {
                                    Circle()
                                        .fill(Theme.accent.opacity(0.3))
                                        .frame(width: 32, height: 32)
                                        .overlay(
                                            Text(String(name.prefix(1)).uppercased())
                                                .font(.system(size: 13, weight: .bold))
                                                .foregroundColor(Theme.textPrimary)
                                        )

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(name)
                                            .foregroundColor(Theme.textPrimary)
                                            .font(.system(size: 14, weight: .medium))
                                        Text(role == "owner" ? "Владелец" : (role == "admin" ? "Администратор" : "Участник"))
                                            .font(.system(size: 11))
                                            .foregroundColor(Theme.textSecondary)
                                    }

                                    Spacer()

                                    Circle()
                                        .fill(presence == "online" ? Theme.green : Theme.textSecondary)
                                        .frame(width: 8, height: 8)
                                }
                                .padding(.vertical, 4)
                                .listRowBackground(Theme.darkBg)
                            }
                        }
                    }
                    .listStyle(.plain)
                }
            }
        }
        .onAppear(perform: loadCommunityData)
        .sheet(isPresented: $showAddChannel) {
            AddChannelSheet(communityId: community["id"] as? String ?? "") {
                loadCommunityData()
            }
        }
    }

    private func loadCommunityData() {
        guard let id = community["id"] as? String else { return }
        Task {
            do {
                let chs = try await ApiService.shared.getArray(path: "/api/communities/\(id)/channels")
                let mbrs = try await ApiService.shared.getArray(path: "/api/communities/\(id)/members")
                await MainActor.run {
                    self.channels = chs
                    self.members = mbrs
                    self.isLoading = false
                }
            } catch {
                print("Failed to load community data: \(error)")
            }
        }
    }
}

struct AddChannelSheet: View {
    let communityId: String
    let onCreated: () -> Void
    @Environment(\.dismiss) var dismiss

    @State private var name = ""
    @State private var kind = "text"
    @State private var isLoading = false

    var body: some View {
        ZStack {
            Theme.surface.ignoresSafeArea()

            VStack(spacing: 20) {
                Text("Создать канал")
                    .font(.system(size: 20, weight: .bold))
                    .foregroundColor(Theme.textPrimary)

                CustomTextField(placeholder: "Название канала", text: $name)

                Picker("Тип канала", selection: $kind) {
                    Text("Текстовый (#)").tag("text")
                    Text("Голосовой 🔊").tag("voice")
                }
                .pickerStyle(.segmented)

                Button(action: createChannel) {
                    if isLoading {
                        ProgressView()
                    } else {
                        Text("Создать")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(Theme.textPrimary)
                    }
                }
                .frame(maxWidth: .infinity)
                .frame(height: 44)
                .background(Theme.accent)
                .cornerRadius(10)
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isLoading)

                Spacer()
            }
            .padding(24)
        }
    }

    private func createChannel() {
        isLoading = true
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/communities/\(communityId)/channels", body: [
                    "name": name.trimmingCharacters(in: .whitespaces),
                    "kind": kind
                ])
                await MainActor.run {
                    dismiss()
                    onCreated()
                }
            } catch {
                await MainActor.run { isLoading = false }
            }
        }
    }
}

struct ChannelChatView: View {
    let community: [String: Any]
    let channel: [String: Any]
    let onBack: () -> Void

    @State private var messages: [[String: Any]] = []
    @State private var inputText = ""

    var body: some View {
        VStack(spacing: 0) {
            let channelName = channel["name"] as? String ?? "канал"
            let channelId = channel["id"] as? String ?? ""

            // Header
            HStack(spacing: 12) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(Theme.textPrimary)
                }

                Text("# \(channelName)")
                    .font(.system(size: 18, weight: .bold))
                    .foregroundColor(Theme.textPrimary)

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Theme.surface)

            // Message list
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 12) {
                        ForEach(0..<messages.count, id: \.self) { idx in
                            let msg = messages[idx]
                            let text = msg["content"] as? String ?? ""
                            let author = msg["author"] as? [String: Any]
                            let authorName = author?["displayName"] as? String ?? (author?["username"] as? String ?? "Пользователь")

                            VStack(alignment: .leading, spacing: 4) {
                                Text(authorName)
                                    .font(.system(size: 13, weight: .bold))
                                    .foregroundColor(Theme.accent)
                                Text(text)
                                    .font(.system(size: 15))
                                    .foregroundColor(Theme.textPrimary)
                            }
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(10)
                            .background(Theme.card)
                            .cornerRadius(10)
                            .id(idx)
                        }
                    }
                    .padding(16)
                }
                .onChange(of: messages.count) { _ in
                    if !messages.isEmpty { proxy.scrollTo(messages.count - 1) }
                }
            }

            // Input bar
            HStack(spacing: 10) {
                TextField("Отправить в #\(channelName)", text: $inputText)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.card)
                    .foregroundColor(Theme.textPrimary)
                    .cornerRadius(20)

                Button(action: sendMessage) {
                    Image(systemName: "paperplane.fill")
                        .foregroundColor(Theme.textPrimary)
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
        guard let id = channel["id"] as? String else { return }
        Task {
            do {
                let msgs = try await ApiService.shared.getArray(path: "/api/channels/\(id)/messages")
                await MainActor.run { self.messages = msgs }
            } catch {
                print("Failed to load channel messages: \(error)")
            }
        }

        RealtimeService.shared.onChannelMessage = { newMsg in
            if (newMsg["channelId"] as? String) == id {
                DispatchQueue.main.async { self.messages.append(newMsg) }
            }
        }
    }

    private func sendMessage() {
        guard let id = channel["id"] as? String else { return }
        let text = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        inputText = ""

        Task {
            do {
                let sent = try await ApiService.shared.post(path: "/api/channels/\(id)/messages", body: ["content": text])
                await MainActor.run { self.messages.append(sent) }
            } catch {
                print("Failed to send channel message: \(error)")
            }
        }
    }
}
