import SwiftUI
import PhotosUI
import UIKit

struct LiquidGlassModifier: ViewModifier {
    var cornerRadius: CGFloat = 24
    @Environment(\.accessibilityReduceTransparency) var reduceTransparency

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *), !reduceTransparency {
            content.glassEffect(.regular, in: RoundedRectangle(cornerRadius: cornerRadius))
        } else {
        content
            .background {
                if reduceTransparency {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .fill(Theme.surface)
                } else {
                    ZStack {
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .fill(.ultraThinMaterial)
                        RoundedRectangle(cornerRadius: cornerRadius)
                            .fill(LinearGradient(
                                colors: [
                                    Theme.accent.opacity(0.12),
                                    Color.white.opacity(0.025)
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            ))
                    }
                }
            }
            .overlay(
                RoundedRectangle(cornerRadius: cornerRadius)
                    .strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(color: Color.white.opacity(0.30), location: 0.0),
                                .init(color: Theme.accent.opacity(0.20), location: 0.45),
                                .init(color: Color.white.opacity(0.04), location: 1.0)
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing
                        ),
                        lineWidth: 1
                    )
            )
            .shadow(color: Theme.accent.opacity(0.10), radius: 20, x: 0, y: 8)
        }
    }
}

extension View {
    func liquidGlass(cornerRadius: CGFloat = 24) -> some View {
        self.modifier(LiquidGlassModifier(cornerRadius: cornerRadius))
    }
}

struct VrotGlassBar: ViewModifier {
    func body(content: Content) -> some View {
        content.liquidGlass(cornerRadius: 24)
    }
}

struct DockTabButton: View {
    let icon: String
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 20, weight: isSelected ? .bold : .medium))
                    .foregroundColor(isSelected ? Theme.accent : Theme.textSecondary)
                Text(title)
                    .font(.system(size: 11, weight: isSelected ? .bold : .medium))
                    .foregroundColor(isSelected ? .white : Theme.textSecondary)
            }
            .frame(minWidth: 54)
        }
        .buttonStyle(.plain)
    }
}

struct MainTabsView: View {
    @Binding var isLoggedIn: Bool
    @State private var selectedTab = 0
    @State private var friends: [[String: Any]] = []
    @State private var communities: [[String: Any]] = []
    @State private var currentUser: [String: Any] = [:]
    @State private var activeChatFriend: [String: Any]?
    @State private var activeCommunity: [String: Any]?
    @State private var isLoading = true
    @State private var loadError = ""

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if let friend = activeChatFriend {
                ChatView(friend: friend, onBack: { activeChatFriend = nil })
            } else if let comm = activeCommunity {
                CommunityDetailView(community: comm, onBack: { activeCommunity = nil; loadData() })
            } else {
                TabView(selection: $selectedTab) {
                    NavigationStack {
                            FriendsTabView(friends: friends, communities: communities, onRefresh: {
                                loadData()
                            }, onSelectFriend: { friend in
                                activeChatFriend = friend
                            }, onSelectCommunity: { comm in
                                activeCommunity = comm
                            }, onCallFriend: { friend, isVideo in
                                let id = friend["id"] as? String ?? ""
                                let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "Друг")
                                CallManager.shared.startOutgoingCall(targetId: id, name: name, avatarUrl: friend["avatarUrl"] as? String, isVideo: isVideo)
                            })
                    }
                    .tabItem { Label("Чаты", systemImage: "bubble.left.and.bubble.right") }.tag(0)
                    NavigationStack {
                            CommunitiesTabView(communities: communities, onSelectCommunity: { comm in
                                activeCommunity = comm
                            }, onCommunityCreated: {
                                loadData()
                            })
                    }
                    .tabItem { Label("Сообщества", systemImage: "person.3") }.tag(1)
                    NavigationStack {
                            ProfileTabView(user: currentUser, onLogout: logout, onUpdated: loadData)
                    }
                    .tabItem { Label("Профиль", systemImage: "person.crop.circle") }.tag(2)
                }
                .tint(Theme.accent)
            }
        }
        .onAppear(perform: loadData)
        .alert("Не удалось загрузить данные", isPresented: Binding(get: { !loadError.isEmpty }, set: { if !$0 { loadError = "" } })) {
            Button("Повторить") { loadError = ""; loadData() }
            Button("Закрыть", role: .cancel) { loadError = "" }
        } message: { Text(loadError) }
    }

    private func loadData() {
        Task {
            do {
                let userObj = try await ApiService.shared.getObject(path: "/api/auth/me")
                await MainActor.run {
                    self.currentUser = userObj["user"] as? [String: Any] ?? [:]
                    self.isLoading = false
                }
                // A slow community request must not hide the profile or chats.
                async let friendResult: Void = loadFriends()
                async let communityResult: Void = loadCommunities()
                _ = await (friendResult, communityResult)
            } catch {
                await MainActor.run { isLoading = false; loadError = error.localizedDescription }
            }
        }
    }

    private func loadFriends() async {
        do {
            let result = try await ApiService.shared.getArray(path: "/api/friends")
            await MainActor.run { friends = result }
        } catch { await MainActor.run { loadError = error.localizedDescription } }
    }

    private func loadCommunities() async {
        do {
            let result = try await ApiService.shared.getArray(path: "/api/communities")
            await MainActor.run { communities = result }
        } catch { await MainActor.run { loadError = error.localizedDescription } }
    }

    private func logout() {
        Task {
            await VrotAppDelegate.unregisterStoredTokens()
            _ = try? await ApiService.shared.request(path: "/api/auth/logout", method: "POST")
            await MainActor.run {
                SessionStore.shared.clear()
                RealtimeService.shared.disconnect()
                isLoggedIn = false
            }
        }
    }
}

struct TabBarButton: View {
    let icon: String
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 21))
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
            }
            .foregroundColor(isSelected ? .white : Theme.textSecondary)
            .padding(.vertical, 4)
            .padding(.horizontal, 16)
            .background(
                isSelected ?
                LinearGradient(colors: [Theme.accent.opacity(0.4), Theme.accent.opacity(0.2)], startPoint: .top, endPoint: .bottom)
                : LinearGradient(colors: [Color.clear, Color.clear], startPoint: .top, endPoint: .bottom)
            )
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? Color.white.opacity(0.3) : Color.clear, lineWidth: 1)
            )
            .frame(maxWidth: .infinity)
        }
    }
}

struct FriendsTabView: View {
    let friends: [[String: Any]]
    let communities: [[String: Any]]
    let onRefresh: () -> Void
    let onSelectFriend: ([String: Any]) -> Void
    let onSelectCommunity: ([String: Any]) -> Void
    let onCallFriend: ([String: Any], Bool) -> Void

    @State private var selectedSubtab = 0 // 0: Все, 1: В сети, 2: Группы, 3: Ожидание
    @State private var showAddFriendSheet = false
    @State private var showCreateGroupSheet = false
    @State private var showCreateCommunitySheet = false
    @State private var selectedProfileUser: [String: Any]? = nil
    @State private var searchUsername = ""
    @State private var searchResults: [[String: Any]] = []
    @State private var isSearching = false
    @State private var actionMessage = ""
    @State private var searchText = ""

    private var acceptedFriends: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "accepted" }
    }

    private var filteredAcceptedFriends: [[String: Any]] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return acceptedFriends }
        return acceptedFriends.filter {
            let name = ($0["displayName"] as? String ?? "").lowercased()
            let u = ($0["username"] as? String ?? "").lowercased()
            return name.contains(q) || u.contains(q)
        }
    }

    private var onlineFriends: [[String: Any]] {
        acceptedFriends.filter { ($0["presence"] as? String ?? "") == "online" }
    }

    private var filteredOnlineFriends: [[String: Any]] {
        let q = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        if q.isEmpty { return onlineFriends }
        return onlineFriends.filter {
            let name = ($0["displayName"] as? String ?? "").lowercased()
            let u = ($0["username"] as? String ?? "").lowercased()
            return name.contains(q) || u.contains(q)
        }
    }

    private var pendingIncoming: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "pending" && ($0["direction"] as? String ?? "") == "incoming" }
    }

    private var pendingOutgoing: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "pending" && ($0["direction"] as? String ?? "") == "outgoing" }
    }

    var body: some View {
        ZStack {
            VStack(alignment: .leading, spacing: 12) {
                // Header with unified + Action Menu
                HStack {
                    Text(L("Чаты"))
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Spacer()

                    Menu {
                        Button(action: { showAddFriendSheet = true }) {
                            Label("Начать личный чат", systemImage: "bubble.left.and.bubble.right.fill")
                        }
                        Button(action: { showCreateGroupSheet = true }) {
                            Label("Создать группу", systemImage: "person.3.fill")
                        }
                        Button(action: { showCreateCommunitySheet = true }) {
                            Label("Создать сообщество", systemImage: "globe.americas.fill")
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Theme.accent)
                            .clipShape(Circle())
                            .shadow(color: Theme.accent.opacity(0.35), radius: 6, y: 2)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 16)

                // Telegram-style search bar
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.textSecondary)
                    TextField("Поиск пользователей, ботов, групп…", text: $searchText)
                        .font(.system(size: 14))
                        .foregroundColor(Theme.textPrimary)
                    if !searchText.isEmpty {
                        Button(action: { searchText = "" }) {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(Theme.textSecondary)
                                .font(.system(size: 14))
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(Color.white.opacity(0.08))
                .cornerRadius(12)
                .padding(.horizontal, 16)

                // Subtabs: Все | В сети | Группы | Ожидание
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        FriendSubtabButton(title: "Все (\(filteredAcceptedFriends.count))", isSelected: selectedSubtab == 0) {
                            selectedSubtab = 0
                        }
                        FriendSubtabButton(title: "В сети (\(filteredOnlineFriends.count))", isSelected: selectedSubtab == 1) {
                            selectedSubtab = 1
                        }
                        FriendSubtabButton(title: "Группы (\(communities.count))", isSelected: selectedSubtab == 2) {
                            selectedSubtab = 2
                        }
                        FriendSubtabButton(title: "Ожидание (\(pendingIncoming.count + pendingOutgoing.count))", isSelected: selectedSubtab == 3) {
                            selectedSubtab = 3
                        }
                    }
                    .padding(.horizontal, 16)
                }

                if !actionMessage.isEmpty {
                    Text(actionMessage)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.accent)
                        .padding(.horizontal, 16)
                }

                // Subtab Content
                Group {
                    switch selectedSubtab {
                    case 0:
                        friendsListView(list: filteredAcceptedFriends, emptyText: "Список чатов пуст. Нажмите «+», чтобы начать")
                    case 1:
                        friendsListView(list: filteredOnlineFriends, emptyText: "Никого из друзей нет в сети")
                    case 2:
                        groupsListView
                    case 3:
                        pendingListView
                    default:
                        EmptyView()
                    }
                }
            }

            if let pUser = selectedProfileUser {
                UserProfileCardModal(user: pUser, onDismiss: { selectedProfileUser = nil })
            }
        }
        .sheet(isPresented: $showAddFriendSheet) {
            ZStack {
                Theme.surface.ignoresSafeArea()
                addFriendView
            }
        }
        .sheet(isPresented: $showCreateGroupSheet) {
            CreateGroupSheet(friends: friends) { created in
                onRefresh()
                onSelectCommunity(created)
            }
        }
        .sheet(isPresented: $showCreateCommunitySheet) {
            CreateCommunitySheet {
                onRefresh()
            }
        }
    }

    private var groupsListView: some View {
        ScrollView {
            if communities.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "person.3")
                        .font(.system(size: 40))
                        .foregroundColor(Theme.textSecondary)
                    Text("У вас пока нет групп. Нажмите «Группа», чтобы создать групповой чат и пригласить друзей!")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                }
                .padding(.top, 40)
            } else {
                LazyVStack(spacing: 8) {
                    ForEach(communities, id: \.description) { comm in
                        let name = comm["name"] as? String ?? "Группа"
                        HStack(spacing: 12) {
                            CommunityAvatarView(url: comm["avatarUrl"] as? String, name: name, size: 44)

                            VStack(alignment: .leading, spacing: 3) {
                                Text(name)
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundColor(Theme.textPrimary)
                                Text("Групповой чат и звонки")
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.textSecondary)
                            }

                            Spacer()

                            // 1-tap Group Call button
                            Button(action: {
                                startGroupCall(for: comm)
                            }) {
                                Image(systemName: "phone.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(Theme.green)
                                    .frame(width: 36, height: 36)
                                    .background(Theme.glassCard)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(Theme.glassBorder, lineWidth: 1))
                            }
                            .buttonStyle(BorderlessButtonStyle())

                            // Open Group Chat
                            Button(action: {
                                onSelectCommunity(comm)
                            }) {
                                Image(systemName: "message.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(Theme.accent)
                                    .frame(width: 36, height: 36)
                                    .background(Theme.glassCard)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(Theme.glassBorder, lineWidth: 1))
                            }
                            .buttonStyle(BorderlessButtonStyle())
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.glassCard)
                        .cornerRadius(14)
                        .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))
                        .contentShape(Rectangle())
                        .onTapGesture {
                            onSelectCommunity(comm)
                        }
                    }
                }
                .padding(.horizontal, 16)
            }
        }
    }

    private func startGroupCall(for comm: [String: Any]) {
        guard let commId = comm["id"] as? String else { return }
        let commName = comm["name"] as? String ?? "Группа"
        Task {
            do {
                let channels = try await ApiService.shared.getArray(path: "/api/communities/\(commId)/channels")
                var voiceChannel = channels.first(where: { ($0["kind"] as? String) == "voice" })
                if voiceChannel == nil {
                    let created = try await ApiService.shared.post(path: "/api/communities/\(commId)/channels", body: ["name": "голосовой", "kind": "voice"])
                    voiceChannel = created
                }
                if let chId = voiceChannel?["id"] as? String {
                    await MainActor.run {
                        CallManager.shared.startOutgoingCall(targetId: chId, name: commName, isVideo: false, kind: "channel")
                    }
                }
            } catch {
                print("Failed to start group call: \(error)")
            }
        }
    }

    @ViewBuilder
    private func friendsListView(list: [[String: Any]], emptyText: String) -> some View {
        if list.isEmpty {
            VStack(spacing: 12) {
                Spacer()
                Image(systemName: "person.2.slash")
                    .font(.system(size: 40))
                    .foregroundColor(Theme.textSecondary)
                Text(emptyText)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.textSecondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                Spacer()
            }
            .frame(maxWidth: .infinity)
        } else {
            List(list, id: \.description) { friend in
                let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "")
                let presence = friend["presence"] as? String ?? "offline"
                let id = friend["id"] as? String ?? ""
                let avatarUrl = friend["avatarUrl"] as? String
                let isVerified = friend["verified"] as? Bool ?? false
                let isDonator = friend["donator"] as? Bool ?? false
                let isBot = (friend["isBot"] as? Bool ?? false) || presence == "bot"

                HStack(spacing: 12) {
                    AvatarBadgeView(avatarUrl: avatarUrl, name: name, size: 44, presence: isBot ? nil : presence)

                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 4) {
                            Text(name)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(Theme.textPrimary)

                            if isBot {
                                Text("БОТ")
                                    .font(.system(size: 10, weight: .bold))
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Theme.accent.opacity(0.3))
                                    .foregroundColor(Theme.accent)
                                    .cornerRadius(6)
                            }
                            if isVerified {
                                Image(systemName: "checkmark.seal.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.accent)
                            }
                            if isDonator {
                                Image(systemName: "star.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(Color(red: 255/255, green: 215/255, blue: 0/255))
                            }
                        }

                        if isBot {
                            Text("БОТ")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(Theme.accent)
                        } else {
                            Text(presence == "online" ? "В сети" : (presence == "dnd" ? "Не беспокоить" : (presence == "idle" ? "Неактивен" : "Не в сети")))
                                .font(.system(size: 12))
                                .foregroundColor(presence == "online" ? Theme.green : Theme.textSecondary)
                        }
                    }

                    Spacer()
                }
                .padding(.vertical, 4)
                .listRowBackground(Theme.darkBg)
                .contentShape(Rectangle())
                .contextMenu {
                    Button {
                        onSelectFriend(friend)
                    } label: {
                        Label("Открыть", systemImage: "bubble.left.and.bubble.right")
                    }
                    Button {
                        archiveChat(id: id)
                    } label: {
                        Label("В архив", systemImage: "archivebox")
                    }
                    Button(role: .destructive) {
                        removeFriend(id: id)
                    } label: {
                        Label("Удалить из друзей", systemImage: "trash")
                    }
                    Button(role: .destructive) {
                        blockUser(id: id)
                    } label: {
                        Label("Заблокировать", systemImage: "hand.raised")
                    }
                }
                .onTapGesture {
                    onSelectFriend(friend)
                }
            }
            .listStyle(.plain)
            .refreshable {
                onRefresh()
            }
        }
    }

    private var pendingListView: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if !pendingIncoming.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("ВХОДЯЩИЕ ЗАЯВКИ — \(pendingIncoming.count)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(Theme.textSecondary)
                            .padding(.horizontal, 16)

                        ForEach(pendingIncoming, id: \.description) { item in
                            let name = item["displayName"] as? String ?? (item["username"] as? String ?? "")
                            let id = item["id"] as? String ?? ""

                            HStack {
                                Circle()
                                    .fill(Theme.accent.opacity(0.3))
                                    .frame(width: 40, height: 40)
                                    .overlay(
                                        Text(String(name.prefix(1)).uppercased())
                                            .foregroundColor(Theme.textPrimary)
                                            .fontWeight(.bold)
                                    )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(name)
                                        .foregroundColor(Theme.textPrimary)
                                        .font(.system(size: 15, weight: .semibold))
                                    Text("Входящий запрос")
                                        .foregroundColor(Theme.textSecondary)
                                        .font(.system(size: 12))
                                }

                                Spacer()

                                Button(action: { acceptFriend(id: id) }) {
                                    Image(systemName: "checkmark")
                                        .foregroundColor(Theme.textPrimary)
                                        .padding(8)
                                        .background(Theme.green)
                                        .clipShape(Circle())
                                }

                                Button(action: { removeFriend(id: id) }) {
                                    Image(systemName: "xmark")
                                        .foregroundColor(Theme.textPrimary)
                                        .padding(8)
                                        .background(Theme.red)
                                        .clipShape(Circle())
                                }
                            }
                            .padding(12)
                            .background(Theme.card)
                            .cornerRadius(12)
                            .padding(.horizontal, 16)
                        }
                    }
                }

                if !pendingOutgoing.isEmpty {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("ИСХОДЯЩИЕ ЗАЯВКИ — \(pendingOutgoing.count)")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(Theme.textSecondary)
                            .padding(.horizontal, 16)

                        ForEach(pendingOutgoing, id: \.description) { item in
                            let name = item["displayName"] as? String ?? (item["username"] as? String ?? "")
                            let id = item["id"] as? String ?? ""

                            HStack {
                                Circle()
                                    .fill(Theme.accent.opacity(0.3))
                                    .frame(width: 40, height: 40)
                                    .overlay(
                                        Text(String(name.prefix(1)).uppercased())
                                            .foregroundColor(Theme.textPrimary)
                                            .fontWeight(.bold)
                                    )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(name)
                                        .foregroundColor(Theme.textPrimary)
                                        .font(.system(size: 15, weight: .semibold))
                                    Text("Ожидает подтверждения")
                                        .foregroundColor(Theme.textSecondary)
                                        .font(.system(size: 12))
                                }

                                Spacer()

                                Button(action: { removeFriend(id: id) }) {
                                    Text("Отменить")
                                        .font(.system(size: 12, weight: .semibold))
                                        .foregroundColor(Theme.red)
                                        .padding(.horizontal, 10)
                                        .padding(.vertical, 6)
                                        .background(Theme.surface)
                                        .cornerRadius(8)
                                }
                            }
                            .padding(12)
                            .background(Theme.card)
                            .cornerRadius(12)
                            .padding(.horizontal, 16)
                        }
                    }
                }

                if pendingIncoming.isEmpty && pendingOutgoing.isEmpty {
                    VStack(spacing: 12) {
                        Spacer(minLength: 60)
                        Image(systemName: "clock")
                            .font(.system(size: 40))
                            .foregroundColor(Theme.textSecondary)
                        Text("Нет входящих и исходящих заявок")
                            .font(.system(size: 14))
                            .foregroundColor(Theme.textSecondary)
                    }
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.top, 8)
        }
    }

    private var addFriendView: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("ДОБАВИТЬ В ДРУЗЬЯ")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)
                .padding(.horizontal, 16)

            Text("Вы можете добавить друга по его имени пользователя.")
                .font(.system(size: 13))
                .foregroundColor(Theme.textSecondary)
                .padding(.horizontal, 16)

            HStack(spacing: 8) {
                CustomTextField(placeholder: "Введите имя пользователя", text: $searchUsername)

                Button(action: performUserSearch) {
                    if isSearching {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            .frame(width: 44, height: 44)
                    } else {
                        Image(systemName: "magnifyingglass")
                            .foregroundColor(Theme.textPrimary)
                            .frame(width: 44, height: 44)
                    }
                }
                .background(Theme.accent)
                .cornerRadius(10)
                .disabled(searchUsername.trimmingCharacters(in: .whitespaces).isEmpty || isSearching)
            }
            .padding(.horizontal, 16)

            if !searchResults.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("РЕЗУЛЬТАТЫ ПОИСКА")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 16)

                    ScrollView {
                        VStack(spacing: 8) {
                            ForEach(searchResults, id: \.description) { u in
                                let uname = u["username"] as? String ?? ""
                                let dname = u["displayName"] as? String ?? uname

                                HStack {
                                    Circle()
                                        .fill(Theme.accent)
                                        .frame(width: 40, height: 40)
                                        .overlay(
                                            Text(String(dname.prefix(1)).uppercased())
                                                .foregroundColor(Theme.textPrimary)
                                                .fontWeight(.bold)
                                        )

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(dname)
                                            .foregroundColor(Theme.textPrimary)
                                            .font(.system(size: 15, weight: .semibold))
                                        Text("@\(uname)")
                                            .foregroundColor(Theme.textSecondary)
                                            .font(.system(size: 12))
                                    }

                                    Spacer()

                                    Button(action: { sendFriendRequest(username: uname) }) {
                                        Text("Отправить заявку")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundColor(Theme.textPrimary)
                                            .padding(.horizontal, 12)
                                            .padding(.vertical, 8)
                                            .background(Theme.accent)
                                            .cornerRadius(8)
                                    }
                                }
                                .padding(12)
                                .background(Theme.card)
                                .cornerRadius(12)
                                .padding(.horizontal, 16)
                            }
                        }
                    }
                }
            }

            Spacer()
        }
        .padding(.top, 8)
    }

    private func performUserSearch() {
        let q = searchUsername.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return }
        isSearching = true
        actionMessage = ""

        Task {
            do {
                let encoded = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
                let res = try await ApiService.shared.getArray(path: "/api/users/search?q=\(encoded)")
                await MainActor.run {
                    self.searchResults = res
                    self.isSearching = false
                    if res.isEmpty {
                        self.actionMessage = "Пользователи не найдены"
                    }
                }
            } catch {
                await MainActor.run {
                    self.isSearching = false
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }

    private func sendFriendRequest(username: String) {
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/friends/requests", body: ["username": username])
                await MainActor.run {
                    self.actionMessage = "Заявка отправлена пользователю \(username)"
                    self.searchResults.removeAll { ($0["username"] as? String) == username }
                    self.onRefresh()
                }
            } catch {
                await MainActor.run {
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }

    private func acceptFriend(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/friends/\(id)/accept", body: [:])
                await MainActor.run {
                    self.actionMessage = "Заявка принята"
                    self.onRefresh()
                }
            } catch {
                await MainActor.run {
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }

    private func removeFriend(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.delete(path: "/api/friends/\(id)")
                await MainActor.run {
                    self.actionMessage = "Удалено"
                    self.onRefresh()
                }
            } catch {
                await MainActor.run {
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }

    private func archiveChat(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/chats/\(id)/archive", body: ["isChannel": false])
                await MainActor.run {
                    self.actionMessage = "В архиве"
                    self.onRefresh()
                }
            } catch {
                await MainActor.run {
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }

    private func blockUser(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/blocks", body: ["userId": id])
                await MainActor.run {
                    self.actionMessage = "Пользователь заблокирован"
                    self.onRefresh()
                }
            } catch {
                await MainActor.run {
                    self.actionMessage = error.localizedDescription
                }
            }
        }
    }
}

struct CreateGroupSheet: View {
    let friends: [[String: Any]]
    let onCreated: ([String: Any]) -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var groupName = ""
    @State private var selectedFriendIds: Set<String> = []
    @State private var isCreating = false
    @State private var errorMessage = ""

    private var acceptedFriends: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "accepted" }
    }

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 18) {
                headerView
                groupNameSection
                friendsSelectorSection

                if !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.red)
                        .padding(.horizontal, 16)
                }

                Spacer()
                createButton
            }
        }
    }

    private var headerView: some View {
        HStack {
            Text("Создать группу")
                .font(.system(size: 20, weight: .bold))
                .foregroundColor(Theme.textPrimary)
            Spacer()
            Button(action: { dismiss() }) {
                Image(systemName: "xmark.circle.fill")
                    .font(.system(size: 22))
                    .foregroundColor(Theme.textSecondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 20)
    }

    private var groupNameSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("НАЗВАНИЕ ГРУППЫ")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)
                .padding(.horizontal, 16)

            CustomTextField(placeholder: "Например: Друзья или Тусовка", text: $groupName)
                .padding(.horizontal, 16)
        }
    }

    private var friendsSelectorSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ДОБАВИТЬ ДРУЗЕЙ (\(selectedFriendIds.count))")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)
                .padding(.horizontal, 16)

            if acceptedFriends.isEmpty {
                Text("У вас пока нет друзей для добавления в группу")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.textSecondary)
                    .padding(.horizontal, 16)
                    .padding(.top, 8)
            } else {
                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(acceptedFriends, id: \.description) { f in
                            let fid = f["id"] as? String ?? ""
                            let name = f["displayName"] as? String ?? (f["username"] as? String ?? "Друг")
                            let isSelected = selectedFriendIds.contains(fid)

                            HStack(spacing: 12) {
                                AvatarBadgeView(avatarUrl: f["avatarUrl"] as? String, name: name, size: 36)

                                Text(name)
                                    .font(.system(size: 15, weight: .medium))
                                    .foregroundColor(Theme.textPrimary)

                                Spacer()

                                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                                    .font(.system(size: 20))
                                    .foregroundColor(isSelected ? Theme.accent : Theme.textSecondary)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Theme.glassCard)
                            .cornerRadius(12)
                            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.glassBorder, lineWidth: 1))
                            .contentShape(Rectangle())
                            .onTapGesture {
                                if isSelected {
                                    selectedFriendIds.remove(fid)
                                } else {
                                    selectedFriendIds.insert(fid)
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .frame(maxHeight: 280)
            }
        }
    }

    private var createButton: some View {
        Button(action: createGroup) {
            HStack {
                Spacer()
                if isCreating {
                    ProgressView()
                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                } else {
                    Text("Создать группу")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                }
                Spacer()
            }
            .padding(.vertical, 14)
            .background(groupName.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.card : Theme.accent)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2), lineWidth: 1))
        }
        .disabled(groupName.trimmingCharacters(in: .whitespaces).isEmpty || isCreating)
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
    }

    private func createGroup() {
        let name = groupName.trimmingCharacters(in: .whitespaces)
        guard !name.isEmpty else { return }
        isCreating = true
        errorMessage = ""

        Task {
            do {
                let created = try await ApiService.shared.post(path: "/api/communities", body: [
                    "name": name,
                    "description": "Групповой чат"
                ])
                guard let commId = created["id"] as? String else {
                    await MainActor.run { isCreating = false }
                    return
                }

                // Automatically create voice channel for group calls
                _ = try? await ApiService.shared.post(path: "/api/communities/\(commId)/channels", body: [
                    "name": "голосовой",
                    "kind": "voice"
                ])

                // Invite all selected friends
                for fid in selectedFriendIds {
                    _ = try? await ApiService.shared.post(path: "/api/communities/\(commId)/invite-friend", body: [
                        "friendId": fid
                    ])
                }

                await MainActor.run {
                    isCreating = false
                    dismiss()
                    onCreated(created)
                }
            } catch {
                await MainActor.run {
                    isCreating = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

struct CreateCommunitySheet: View {
    let onCreated: () -> Void
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var description = ""
    @State private var isCreating = false
    @State private var errorMessage = ""

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            VStack(alignment: .leading, spacing: 18) {
                HStack {
                    Text("Создать сообщество")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                    Button(action: { dismiss() }) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 22))
                            .foregroundColor(Theme.textSecondary)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 20)

                VStack(alignment: .leading, spacing: 6) {
                    Text("НАЗВАНИЕ")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 16)
                    CustomTextField(placeholder: "Название сообщества", text: $name)
                        .padding(.horizontal, 16)
                }

                VStack(alignment: .leading, spacing: 6) {
                    Text("ОПИСАНИЕ (НЕОБЯЗАТЕЛЬНО)")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 16)
                    CustomTextField(placeholder: "Кратко о вашем сообществе", text: $description)
                        .padding(.horizontal, 16)
                }

                if !errorMessage.isEmpty {
                    Text(errorMessage)
                        .font(.system(size: 12))
                        .foregroundColor(Theme.red)
                        .padding(.horizontal, 16)
                }

                Spacer()

                Button(action: createCommunity) {
                    HStack {
                        Spacer()
                        if isCreating {
                            ProgressView().tint(.white)
                        } else {
                            Text("Создать сообщество")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(.white)
                        }
                        Spacer()
                    }
                    .padding(.vertical, 14)
                    .background(name.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.card : Theme.accent)
                    .cornerRadius(14)
                    .overlay(RoundedRectangle(cornerRadius: 14).stroke(Color.white.opacity(0.2), lineWidth: 1))
                }
                .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isCreating)
                .padding(.horizontal, 16)
                .padding(.bottom, 24)
            }
        }
    }

    private func createCommunity() {
        let n = name.trimmingCharacters(in: .whitespaces)
        guard !n.isEmpty else { return }
        isCreating = true
        errorMessage = ""

        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/communities", body: [
                    "name": n,
                    "description": description.trimmingCharacters(in: .whitespaces)
                ])
                await MainActor.run {
                    isCreating = false
                    dismiss()
                    onCreated()
                }
            } catch {
                await MainActor.run {
                    isCreating = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }
}

struct FriendSubtabButton: View {
    let title: String
    let isSelected: Bool
    var isAdd: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(.system(size: 13, weight: .semibold))
                .foregroundColor(isSelected ? (isAdd ? Theme.green : .white) : Theme.textSecondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(isSelected ? Theme.card : Theme.surface)
                .cornerRadius(8)
        }
    }
}

struct CommunitiesTabView: View {
    let communities: [[String: Any]]
    let onSelectCommunity: ([String: Any]) -> Void
    let onCommunityCreated: () -> Void

    @State private var showCreateCommunity = false
    @State private var showJoinByCode = false
    @State private var newName = ""
    @State private var newDesc = ""
    @State private var inviteCode = ""
    @State private var isCreating = false
    @State private var isJoining = false
    @State private var invitations: [[String: Any]] = []
    @State private var statusNotice = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Сообщества")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(Theme.textPrimary)
                Spacer()

                // Join by invite code button
                Button(action: { showJoinByCode = true }) {
                    HStack(spacing: 4) {
                        Image(systemName: "ticket.fill")
                        Text("По коду")
                            .font(.system(size: 13, weight: .semibold))
                    }
                    .foregroundColor(Theme.accent)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .background(Theme.card)
                    .cornerRadius(8)
                }

                // Create community button
                Button(action: { showCreateCommunity = true }) {
                    Image(systemName: "plus")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(Theme.accent)
                        .padding(8)
                        .background(Theme.card)
                        .clipShape(Circle())
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)

            if !statusNotice.isEmpty {
                Text(statusNotice)
                    .font(.system(size: 12))
                    .foregroundColor(Theme.accent)
                    .padding(.horizontal, 16)
            }

            // Invitations section
            if !invitations.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("ПРИГЛАШЕНИЯ В СООБЩЕСТВА")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                        .padding(.horizontal, 16)

                    ForEach(invitations, id: \.description) { inv in
                        let id = inv["id"] as? String ?? ""
                        let cName = inv["communityName"] as? String ?? "Сообщество"
                        let inviter = inv["inviterUsername"] as? String ?? ""

                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(cName)
                                    .foregroundColor(Theme.textPrimary)
                                    .font(.system(size: 15, weight: .semibold))
                                Text("От @\(inviter)")
                                    .foregroundColor(Theme.textSecondary)
                                    .font(.system(size: 12))
                            }

                            Spacer()

                            Button(action: { respondToInvitation(id: id, accept: true) }) {
                                Text("Вступить")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(Theme.textPrimary)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Theme.green)
                                    .cornerRadius(8)
                            }

                            Button(action: { respondToInvitation(id: id, accept: false) }) {
                                Text("Отклонить")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(Theme.textSecondary)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Theme.card)
                                    .cornerRadius(8)
                            }
                        }
                        .padding(12)
                        .background(Theme.surface)
                        .cornerRadius(12)
                        .padding(.horizontal, 16)
                    }
                }
            }

            if communities.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 40))
                        .foregroundColor(Theme.textSecondary)
                    Text("Нет доступных сообществ")
                        .foregroundColor(Theme.textSecondary)
                    Text("Создайте первое или присоединитесь по коду приглашения")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 32)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                // Discord-style two-pane view: Left server rail, right channel/server overview
                HStack(spacing: 0) {
                    // Left rail of server icons
                    ScrollView(.vertical, showsIndicators: false) {
                        VStack(spacing: 12) {
                            ForEach(communities, id: \.description) { comm in
                                let name = comm["name"] as? String ?? "С"
                                Button(action: { onSelectCommunity(comm) }) {
                                    CommunityAvatarView(url: comm["avatarUrl"] as? String, name: name, size: 48)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 16)
                                            .stroke(Color.white.opacity(0.25), lineWidth: 1)
                                    )
                                    .shadow(color: Color.black.opacity(0.3), radius: 4, y: 2)
                                }
                            }

                            // Add server button in rail
                            Button(action: { showCreateCommunity = true }) {
                                Image(systemName: "plus")
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundColor(Theme.green)
                                    .frame(width: 48, height: 48)
                                    .background(Color.white.opacity(0.08))
                                    .clipShape(RoundedRectangle(cornerRadius: 16))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 16)
                                            .stroke(Theme.green.opacity(0.4), lineWidth: 1)
                                    )
                            }
                        }
                        .padding(.vertical, 8)
                        .padding(.horizontal, 8)
                    }
                    .frame(width: 68)
                    .background(Color(red: 18/255, green: 20/255, blue: 30/255))

                    // Right list: Server cards with direct entrance
                    ScrollView {
                        VStack(spacing: 12) {
                            ForEach(communities, id: \.description) { comm in
                                let name = comm["name"] as? String ?? "Сообщество"
                                let desc = comm["description"] as? String ?? ""
                                let isVerified = comm["verified"] as? Bool ?? false

                                Button(action: { onSelectCommunity(comm) }) {
                                    HStack(spacing: 12) {
                                        CommunityAvatarView(url: comm["avatarUrl"] as? String, name: name, size: 42)
                                        VStack(alignment: .leading, spacing: 4) {
                                            HStack(spacing: 6) {
                                                Text(name)
                                                    .font(.system(size: 16, weight: .bold))
                                                    .foregroundColor(Theme.textPrimary)
                                                if isVerified {
                                                    Image(systemName: "checkmark.seal.fill")
                                                        .font(.system(size: 12))
                                                        .foregroundColor(Theme.accent)
                                                }
                                            }

                                            if !desc.isEmpty {
                                                Text(desc)
                                                    .font(.system(size: 12))
                                                    .foregroundColor(Theme.textSecondary)
                                                    .lineLimit(2)
                                                    .multilineTextAlignment(.leading)
                                            } else {
                                                Text("Каналы: # общий, голосовой")
                                                    .font(.system(size: 11))
                                                    .foregroundColor(Theme.textSecondary.opacity(0.7))
                                            }
                                        }

                                        Spacer()

                                        Image(systemName: "chevron.right")
                                            .foregroundColor(Theme.textSecondary)
                                            .font(.system(size: 14))
                                    }
                                    .padding(14)
                                    .background(Color.white.opacity(0.06))
                                    .cornerRadius(14)
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 14)
                                            .stroke(Color.white.opacity(0.12), lineWidth: 1)
                                    )
                                }
                            }
                        }
                        .padding(16)
                    }
                }
            }
        }
        .onAppear(perform: loadInvitations)
        .sheet(isPresented: $showJoinByCode) {
            ZStack {
                Theme.surface.ignoresSafeArea()
                VStack(spacing: 20) {
                    Text("Присоединиться по коду")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(Theme.textPrimary)

                    Text("Введите 8-значный код приглашения, чтобы вступить в сообщество.")
                        .font(.system(size: 13))
                        .foregroundColor(Theme.textSecondary)
                        .multilineTextAlignment(.center)

                    CustomTextField(placeholder: "Код приглашения", text: $inviteCode)

                    Button(action: joinByCode) {
                        if isJoining {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .white))
                        } else {
                            Text("Присоединиться")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(Theme.textPrimary)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .background(Theme.accent)
                    .cornerRadius(10)
                    .disabled(inviteCode.trimmingCharacters(in: .whitespaces).isEmpty || isJoining)

                    Spacer()
                }
                .padding(24)
            }
        }
        .sheet(isPresented: $showCreateCommunity) {
            ZStack {
                Theme.surface.ignoresSafeArea()
                VStack(spacing: 20) {
                    Text("Создать сообщество")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(Theme.textPrimary)

                    CustomTextField(placeholder: "Название", text: $newName)
                    CustomTextField(placeholder: "Описание (необязательно)", text: $newDesc)

                    Button(action: {
                        isCreating = true
                        Task {
                            do {
                                _ = try await ApiService.shared.post(path: "/api/communities", body: [
                                    "name": newName.trimmingCharacters(in: .whitespaces),
                                    "description": newDesc.trimmingCharacters(in: .whitespaces)
                                ])
                                await MainActor.run {
                                    isCreating = false
                                    showCreateCommunity = false
                                    newName = ""
                                    newDesc = ""
                                    onCommunityCreated()
                                }
                            } catch {
                                await MainActor.run { isCreating = false }
                            }
                        }
                    }) {
                        if isCreating {
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
                    .disabled(newName.trimmingCharacters(in: .whitespaces).isEmpty || isCreating)

                    Spacer()
                }
                .padding(24)
            }
        }
    }

    private func loadInvitations() {
        Task {
            do {
                let inv = try await ApiService.shared.getArray(path: "/api/community-invitations")
                await MainActor.run {
                    self.invitations = inv
                }
            } catch {}
        }
    }

    private func respondToInvitation(id: String, accept: Bool) {
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/community-invitations/\(id)/respond", body: ["accept": accept])
                await MainActor.run {
                    self.invitations.removeAll { ($0["id"] as? String) == id }
                    if accept {
                        self.onCommunityCreated()
                        self.statusNotice = "Вы вступили в сообщество!"
                    }
                }
            } catch {
                await MainActor.run {
                    self.statusNotice = error.localizedDescription
                }
            }
        }
    }

    private func joinByCode() {
        let code = inviteCode.trimmingCharacters(in: .whitespaces)
        guard !code.isEmpty else { return }
        isJoining = true

        Task {
            do {
                let encoded = code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
                _ = try await ApiService.shared.post(path: "/api/invites/\(encoded)/join", body: [:])
                await MainActor.run {
                    self.isJoining = false
                    self.showJoinByCode = false
                    self.inviteCode = ""
                    self.statusNotice = "Вы успешно присоединились!"
                    self.onCommunityCreated()
                }
            } catch {
                await MainActor.run {
                    self.isJoining = false
                    self.statusNotice = error.localizedDescription
                }
            }
        }
    }
}

struct ProfileTabView: View {
    let user: [String: Any]
    let onLogout: () -> Void
    let onUpdated: () -> Void
    @AppStorage("vrot_theme") private var appTheme = "dark"
    @AppStorage("vrot_language") private var appLanguage = "ru"
    @AppStorage("vrot_chat_wallpaper") private var chatWallpaper = ""

    @State private var showSettingsModal = false
    @State private var settingsSection = "profile_appearance"
    @State private var displayName = ""
    @State private var bio = ""
    @State private var selectedStatus = "online"
    @State private var allowMessages = "everyone"
    @State private var allowCalls = "everyone"
    @State private var showBio = "everyone"
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var isSaving = false
    @State private var noticeMessage = ""
    @State private var currentAvatar: String? = nil
    @State private var currentBanner: String? = nil
    @State private var selectedAvatarItem: PhotosPickerItem? = nil
    @State private var selectedBannerItem: PhotosPickerItem? = nil
    @State private var selectedWallpaperItem: PhotosPickerItem? = nil
    @State private var blockedUsers: [[String: Any]] = []
    @State private var isLoadingBlocks = false

    // Security tab states
    @State private var isEmailVerified = false
    @State private var userEmail = ""
    @State private var isTotpEnabled = false
    @State private var totpSetupData: [String: Any]? = nil
    @State private var totpInputCode = ""
    @State private var backupCodes: [String] = []
    @State private var showTotpDisableModal = false
    @State private var totpDisableCode = ""
    @State private var activeSessions: [[String: Any]] = []
    @State private var userPasskeys: [[String: Any]] = []
    @State private var isLoadingSecurity = false
    @State private var isSendingEmail = false
    @State private var emailVerificationCode = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                let name = user["displayName"] as? String ?? (user["username"] as? String ?? "Пользователь")
                let username = user["username"] as? String ?? ""
                let email = user["email"] as? String ?? ""
                let userBio = user["bio"] as? String ?? ""
                let isVerified = user["verified"] as? Bool ?? false
                let isDonator = user["donator"] as? Bool ?? false
                let banner = currentBanner ?? (user["bannerUrl"] as? String)
                let avatar = currentAvatar ?? (user["avatarUrl"] as? String)

                // Header Card with Liquid Glass aesthetic
                VStack(spacing: 0) {
                    ZStack(alignment: .bottomLeading) {
                        if let bUrl = banner, !bUrl.isEmpty {
                            if bUrl.hasPrefix("data:") {
                                let cleanBase64 = (bUrl.components(separatedBy: ",").last ?? "")
                                    .trimmingCharacters(in: .whitespacesAndNewlines)
                                    .replacingOccurrences(of: "\n", with: "")
                                    .replacingOccurrences(of: "\r", with: "")
                                if let data = Data(base64Encoded: cleanBase64, options: [.ignoreUnknownCharacters]),
                                   let uiImg = UIImage(data: data) {
                                    Image(uiImage: uiImg)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(height: 110)
                                        .clipped()
                                } else {
                                    LinearGradient(colors: [Theme.accent.opacity(0.8), Color.purple.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing)
                                        .frame(height: 110)
                                }
                            } else {
                                AsyncImage(url: ApiService.resolveMediaURL(bUrl)) { img in
                                    img.resizable().scaledToFill()
                                } placeholder: {
                                    LinearGradient(colors: [Theme.accent.opacity(0.8), Color.purple.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing)
                                }
                                .frame(height: 110)
                                .clipped()
                            }
                        } else {
                            LinearGradient(colors: [Theme.accent.opacity(0.8), Color.purple.opacity(0.5)], startPoint: .topLeading, endPoint: .bottomTrailing)
                                .frame(height: 110)
                        }

                        AvatarBadgeView(avatarUrl: avatar, name: name, size: 76)
                            .overlay(Circle().stroke(Color.black, lineWidth: 3))
                            .offset(x: 16, y: 38)
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 6) {
                            Text(name)
                                .font(.system(size: 22, weight: .bold))
                                .foregroundColor(Theme.textPrimary)

                            if isVerified {
                                Image(systemName: "checkmark.seal.fill")
                                    .foregroundColor(Theme.accent)
                            }
                            if isDonator {
                                Image(systemName: "star.fill")
                                    .foregroundColor(Color(red: 255/255, green: 215/255, blue: 0/255))
                            }
                        }
                        .padding(.top, 44)

                        Text("@\(username)")
                            .font(.system(size: 14))
                            .foregroundColor(Theme.textSecondary)

                        Text(email)
                            .font(.system(size: 13))
                            .foregroundColor(Theme.textSecondary.opacity(0.8))

                        if !userBio.isEmpty {
                            Text(userBio)
                                .font(.system(size: 14))
                                .foregroundColor(Theme.textPrimary)
                                .padding(.top, 4)
                        }
                        if let role = user["adminRole"] as? String, role != "user" {
                            Label(role == "owner" ? "Основатель VROT" : (role == "moderator" ? "Модератор VROT" : "Администратор VROT"), systemImage: "shield.lefthalf.filled")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(Theme.accent)
                        }
                    }
                    .padding(20)
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .modifier(VrotGlassBar())
                .padding(.horizontal, 16)
                .padding(.top, 16)

                if !noticeMessage.isEmpty {
                    Text(noticeMessage)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Theme.accent)
                        .padding(.horizontal, 16)
                }

                // Settings Section
                VStack(spacing: 12) {
                    Text("НАСТРОЙКИ ПРОФИЛЯ")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(Theme.textSecondary)
                        .frame(maxWidth: .infinity, alignment: .leading)

                    ForEach(["profile_appearance", "security", "customization"], id: \.self) { section in
                    Button(action: {
                        settingsSection = section
                        displayName = user["displayName"] as? String ?? (user["username"] as? String ?? "")
                        bio = user["bio"] as? String ?? ""
                        selectedStatus = user["status"] as? String ?? "online"
                        currentAvatar = user["avatarUrl"] as? String
                        currentBanner = user["bannerUrl"] as? String
                        if let p = user["privacySettings"] as? [String: Any] {
                            allowMessages = p["allowMessages"] as? String ?? "everyone"
                            allowCalls = p["allowCalls"] as? String ?? "everyone"
                            showBio = p["showBio"] as? String ?? "everyone"
                        }
                        if let sWall = user["chatWallpaper"] as? String, !sWall.isEmpty, chatWallpaper.isEmpty {
                            chatWallpaper = sWall
                        }
                        showSettingsModal = true
                        loadSecurityData()
                        loadBlockedUsers()
                    }) {
                        HStack {
                            Image(systemName: section == "security" ? "lock.shield" : (section == "customization" ? "paintbrush.pointed" : "person.crop.circle"))
                                .font(.system(size: 18))
                                .foregroundColor(Theme.accent)
                            Text(section == "security" ? "Безопасность" : (section == "customization" ? "Кастомизация" : "Профиль и оформление"))
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(Theme.textPrimary)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 14))
                                .foregroundColor(Theme.textSecondary)
                        }
                        .padding(14)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.12), lineWidth: 1))
                    }
                    }
                    NavigationLink(destination: VrotLockSettings()) {
                        Label("Код приложения и Face ID", systemImage: "lock.iphone").frame(maxWidth: .infinity, alignment: .leading).padding(16)
                    }
                }
                .padding(.horizontal, 16)

                Spacer(minLength: 80)

                // Logout Button
                Button(action: onLogout) {
                    Text(L("Выйти из аккаунта"))
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(Theme.red)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(Color.white.opacity(0.06))
                        .cornerRadius(12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.red.opacity(0.3), lineWidth: 1))
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 90)
            }
        }
        .sheet(isPresented: $showSettingsModal) {
            ZStack {
                Theme.surface.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        HStack {
                            Text(L("Настройки профиля"))
                                .font(.system(size: 20, weight: .bold))
                                .foregroundColor(Theme.textPrimary)
                            Spacer()
                            Button(action: { showSettingsModal = false }) {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 22))
                                    .foregroundColor(Theme.textSecondary)
                            }
                        }
                        .padding(.top, 10)


                        if settingsSection == "profile_appearance" {
                            profileAndAppearanceSection
                        } else if settingsSection == "security" {
                            securitySection
                        } else if settingsSection == "customization" {
                            customizationSection
                        }

                        if !noticeMessage.isEmpty {
                            Text(noticeMessage)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(Theme.accent)
                                .padding(.top, 4)
                        }
                    }
                    .padding(24)
                }
            }
        }
    }

    // MARK: - 1. Профиль и оформление
    private var profileAndAppearanceSection: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ОФОРМЛЕНИЕ")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)

            // Avatar & Banner Buttons
            HStack(spacing: 12) {
                PhotosPicker(selection: $selectedAvatarItem, matching: .images) {
                    HStack(spacing: 6) {
                        Image(systemName: "photo.circle.fill")
                        Text("Сменить аватар")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Theme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Theme.accent)
                    .cornerRadius(12)
                }
                .onChange(of: selectedAvatarItem) { item in
                    uploadImage(item: item, isBanner: false)
                }

                PhotosPicker(selection: $selectedBannerItem, matching: .images) {
                    HStack(spacing: 6) {
                        Image(systemName: "rectangle.fill.on.rectangle.angled.fill")
                        Text("Сменить шапку")
                    }
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(Theme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 12)
                    .background(Color.white.opacity(0.12))
                    .cornerRadius(12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Color.white.opacity(0.2), lineWidth: 1))
                }
                .onChange(of: selectedBannerItem) { item in
                    uploadImage(item: item, isBanner: true)
                }
            }

            // Chat Wallpaper (Обои в чатах)
            VStack(alignment: .leading, spacing: 8) {
                Text("ОБОИ В ЧАТАХ")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.textSecondary)

                if !chatWallpaper.isEmpty {
                    HStack(spacing: 12) {
                        if chatWallpaper.hasPrefix("data:"),
                           let data = Data(base64Encoded: chatWallpaper.components(separatedBy: ",").last ?? ""),
                           let uiImg = UIImage(data: data) {
                            Image(uiImage: uiImg)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 60, height: 48)
                                .cornerRadius(8)
                                .clipped()
                        } else if chatWallpaper.hasPrefix("http") {
                            AsyncImage(url: ApiService.resolveMediaURL(chatWallpaper)) { phase in
                                if let img = phase.image {
                                    img.resizable().scaledToFill().frame(width: 60, height: 48).cornerRadius(8).clipped()
                                }
                            }
                        }

                        VStack(alignment: .leading, spacing: 2) {
                            Text("Свои обои активны")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(Theme.textPrimary)
                            Text("Отображаются во всех чатах")
                                .font(.system(size: 11))
                                .foregroundColor(Theme.textSecondary)
                        }

                        Spacer()

                        Button(action: resetWallpaper) {
                            Text("Сбросить")
                                .font(.system(size: 12, weight: .semibold))
                                .foregroundColor(Theme.red)
                                .padding(.horizontal, 10)
                                .padding(.vertical, 6)
                                .background(Color.white.opacity(0.08))
                                .cornerRadius(8)
                        }
                    }
                    .padding(10)
                    .background(Theme.glassCard)
                    .cornerRadius(12)
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.glassBorder, lineWidth: 1))
                }

                PhotosPicker(selection: $selectedWallpaperItem, matching: .images) {
                    HStack(spacing: 6) {
                        Image(systemName: "photo.on.rectangle.angled")
                        Text(chatWallpaper.isEmpty ? "Выбрать обои для чатов" : "Изменить обои для чатов")
                    }
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textPrimary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(Color.white.opacity(0.08))
                    .cornerRadius(10)
                    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.15), lineWidth: 1))
                }
                .onChange(of: selectedWallpaperItem) { item in
                    uploadWallpaper(item: item)
                }
            }

            Divider().background(Theme.card).padding(.vertical, 4)

            // Profile fields
            Text("ДАННЫЕ ПРОФИЛЯ")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Отображаемое имя")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textSecondary)
                CustomTextField(placeholder: "Ваше имя", text: $displayName)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("О себе (био)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textSecondary)
                CustomTextField(placeholder: "Напишите что-нибудь о себе", text: $bio)
            }

            Button(action: saveProfile) {
                HStack {
                    Spacer()
                    if isSaving {
                        ProgressView().tint(.white)
                    } else {
                        Text("Сохранить профиль")
                            .font(.system(size: 16, weight: .bold))
                            .foregroundColor(.white)
                    }
                    Spacer()
                }
                .frame(height: 48)
                .contentShape(Rectangle())
            }
            .background(Theme.accent)
            .cornerRadius(12)
            .buttonStyle(.plain)
            .disabled(isSaving)
            .padding(.top, 6)
        }
    }

    // MARK: - 2. Безопасность
    private var securitySection: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Email Status Card
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Электронная почта", systemImage: "envelope.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                    Text(isEmailVerified ? "✅ Подтверждён" : "⚠️ Не подтверждён")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(isEmailVerified ? Theme.green : Theme.red)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background((isEmailVerified ? Theme.green : Theme.red).opacity(0.15))
                        .cornerRadius(6)
                }

                if !userEmail.isEmpty {
                    Text(userEmail)
                        .font(.system(size: 13))
                        .foregroundColor(Theme.textSecondary)
                }

                if !isEmailVerified && !userEmail.isEmpty {
                    Button(action: resendVerificationEmail) {
                        HStack {
                            if isSendingEmail {
                                ProgressView().tint(.white).scaleEffect(0.8)
                            } else {
                                Image(systemName: "paperplane.fill")
                                Text("Отправить письмо с подтверждением")
                            }
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(Theme.textPrimary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Theme.accent)
                        .cornerRadius(8)
                    }
                    .disabled(isSendingEmail)
                    TextField("6-значный код из письма", text: $emailVerificationCode)
                        .keyboardType(.numberPad)
                        .textContentType(.oneTimeCode)
                    Button("Подтвердить почту", action: confirmVerificationEmail)
                        .disabled(isSendingEmail || emailVerificationCode.count != 6)
                    if !noticeMessage.isEmpty {
                        Text(noticeMessage).font(.footnote).foregroundColor(Theme.textSecondary)
                    }
                }
            }
            .padding(14)
            .background(Theme.glassCard)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))

            // 2FA TOTP Card
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Двухфакторная защита (TOTP)", systemImage: "lock.shield.fill")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                    Text(isTotpEnabled ? "✅ Включена" : "⚪ Выключена")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(isTotpEnabled ? Theme.green : Theme.textSecondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background((isTotpEnabled ? Theme.green : Color.white).opacity(0.12))
                        .cornerRadius(6)
                }

                Text("Защита аккаунта с помощью Apple Passwords, Google Authenticator или Aegis.")
                    .font(.system(size: 12))
                    .foregroundColor(Theme.textSecondary)

                if !isTotpEnabled && totpSetupData == nil {
                    Button(action: startTotpSetup) {
                        HStack {
                            Image(systemName: "plus.shield.fill")
                            Text("Включить 2FA")
                        }
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .background(Theme.accent)
                        .cornerRadius(8)
                    }
                }

                if let setup = totpSetupData {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("Секретный ключ для аутентификатора:")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Theme.textSecondary)

                        let secret = setup["secret"] as? String ?? ""
                        HStack {
                            Text(secret)
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundColor(Theme.textPrimary)
                            Spacer()
                            Button(action: { UIPasteboard.general.string = secret; noticeMessage = "Ключ скопирован" }) {
                                Image(systemName: "doc.on.doc.fill")
                                    .font(.system(size: 14))
                                    .foregroundColor(Theme.accent)
                            }
                        }
                        .padding(10)
                        .background(Color.white.opacity(0.08))
                        .cornerRadius(8)

                        CustomTextField(placeholder: "6 цифр из приложения", text: $totpInputCode)
                            .keyboardType(.numberPad)

                        HStack(spacing: 10) {
                            Button("Подтвердить") {
                                verifyTotpCode()
                            }
                            .font(.system(size: 13, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(Theme.green)
                            .cornerRadius(8)
                            .disabled(totpInputCode.count < 6)

                            Button("Отмена") {
                                totpSetupData = nil
                                totpInputCode = ""
                            }
                            .font(.system(size: 13))
                            .foregroundColor(Theme.textSecondary)
                        }
                    }
                    .padding(10)
                    .background(Color.white.opacity(0.04))
                    .cornerRadius(10)
                }

                if !backupCodes.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("⚠️ Сохраните ваши резервные коды:")
                            .font(.system(size: 12, weight: .bold))
                            .foregroundColor(Theme.green)
                        ForEach(backupCodes, id: \.self) { code in
                            Text(code)
                                .font(.system(size: 13, weight: .bold, design: .monospaced))
                                .foregroundColor(Theme.textPrimary)
                        }
                    }
                    .padding(10)
                    .background(Theme.green.opacity(0.1))
                    .cornerRadius(8)
                }

                if isTotpEnabled {
                    if showTotpDisableModal {
                        VStack(alignment: .leading, spacing: 8) {
                            CustomTextField(placeholder: "Код 2FA или пароль", text: $totpDisableCode)
                            HStack {
                                Button("Отключить 2FA") {
                                    disableTotp()
                                }
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 6)
                                .background(Theme.red)
                                .cornerRadius(8)

                                Button("Отмена") {
                                    showTotpDisableModal = false
                                }
                                .font(.system(size: 13))
                                .foregroundColor(Theme.textSecondary)
                            }
                        }
                    } else {
                        Button("Отключить 2FA") {
                            showTotpDisableModal = true
                        }
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Theme.red)
                    }
                }
            }
            .padding(14)
            .background(Theme.glassCard)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))

            // Active Sessions Card
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Label("Активные сеансы", systemImage: "laptopcomputer.and.iphone")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(Theme.textPrimary)
                    Spacer()
                    if activeSessions.count > 1 {
                        Button("Завершить другие") {
                            revokeOtherSessions()
                        }
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Theme.red)
                    }
                }

                ForEach(activeSessions, id: \.description) { s in
                    let dev = s["deviceName"] as? String ?? "Устройство"
                    let ip = s["ipAddress"] as? String ?? "—"
                    let isCur = s["isCurrent"] as? Bool ?? false
                    let sid = s["id"] as? String ?? ""

                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack(spacing: 4) {
                                Text(isCur ? "🟢" : "⚪")
                                Text(dev)
                                    .font(.system(size: 13, weight: .semibold))
                                    .foregroundColor(Theme.textPrimary)
                                if isCur {
                                    Text("Текущее")
                                        .font(.system(size: 10, weight: .bold))
                                        .foregroundColor(Theme.green)
                                        .padding(.horizontal, 5)
                                        .padding(.vertical, 2)
                                        .background(Theme.green.opacity(0.15))
                                        .cornerRadius(4)
                                }
                            }
                            Text("IP: \(ip)")
                                .font(.system(size: 11))
                                .foregroundColor(Theme.textSecondary)
                        }
                        Spacer()
                        if !isCur {
                            Button(action: { revokeSession(id: sid) }) {
                                Text("Завершить")
                                    .font(.system(size: 11, weight: .semibold))
                                    .foregroundColor(Theme.red)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 4)
                                    .background(Color.white.opacity(0.08))
                                    .cornerRadius(6)
                            }
                        }
                    }
                    .padding(8)
                    .background(Color.white.opacity(0.04))
                    .cornerRadius(8)
                }
            }
            .padding(14)
            .background(Theme.glassCard)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))

            // Passkeys Card
            VStack(alignment: .leading, spacing: 10) {
                Label("Ключи доступа (Passkeys)", systemImage: "key.fill")
                    .font(.system(size: 14, weight: .bold))
                    .foregroundColor(Theme.textPrimary)

                if userPasskeys.isEmpty {
                    Text("Нет привязанных ключей доступа.")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.textSecondary)
                } else {
                    ForEach(userPasskeys, id: \.description) { pk in
                        let dname = pk["deviceName"] as? String ?? "Passkey"
                        let pkid = pk["id"] as? String ?? ""
                        HStack {
                            Text("🛡️ \(dname)")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(Theme.textPrimary)
                            Spacer()
                            Button(action: { deletePasskey(id: pkid) }) {
                                Image(systemName: "trash.fill")
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.red)
                            }
                        }
                        .padding(8)
                        .background(Color.white.opacity(0.04))
                        .cornerRadius(8)
                    }
                }
            }
            .padding(14)
            .background(Theme.glassCard)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))

            // Password Change
            VStack(alignment: .leading, spacing: 10) {
                Text("СМЕНА ПАРОЛЯ")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.textSecondary)

                CustomSecureField(placeholder: "Текущий пароль", text: $currentPassword)
                CustomSecureField(placeholder: "Новый пароль (мин. 12 симв.)", text: $newPassword)

                Button(action: changePassword) {
                    HStack {
                        Spacer()
                        Text("Обновить пароль")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.white)
                        Spacer()
                    }
                    .frame(height: 44)
                    .contentShape(Rectangle())
                }
                .background(currentPassword.isEmpty || newPassword.count < 12 ? Theme.card : Theme.accent)
                .cornerRadius(12)
                .buttonStyle(.plain)
                .disabled(currentPassword.isEmpty || newPassword.count < 12 || isSaving)
            }
            .padding(14)
            .background(Theme.glassCard)
            .cornerRadius(14)
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Theme.glassBorder, lineWidth: 1))

            // Privacy settings
            Text("ПРИВАТНОСТЬ")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)

            VStack(alignment: .leading, spacing: 6) {
                Text("Кто может писать мне")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textSecondary)

                Picker("Кто может писать", selection: $allowMessages) {
                    Text("Все").tag("everyone")
                    Text("Друзья").tag("contacts")
                    Text("Никто").tag("nobody")
                }
                .pickerStyle(.segmented)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Кто может звонить мне")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textSecondary)

                Picker("Кто может звонить", selection: $allowCalls) {
                    Text("Все").tag("everyone")
                    Text("Друзья").tag("contacts")
                    Text("Никто").tag("nobody")
                }
                .pickerStyle(.segmented)
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("Кто может видеть моё описание (био)")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundColor(Theme.textSecondary)

                Picker("Кто видит описание", selection: $showBio) {
                    Text("Все").tag("everyone")
                    Text("Друзья").tag("contacts")
                    Text("Никто").tag("nobody")
                }
                .pickerStyle(.segmented)
            }

            Button(action: savePrivacy) {
                HStack {
                    Spacer()
                    if isSaving {
                        ProgressView().tint(.white)
                    } else {
                        Text("Сохранить приватность")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.white)
                    }
                    Spacer()
                }
                .frame(height: 44)
                .contentShape(Rectangle())
            }
            .background(Theme.accent)
            .cornerRadius(12)
            .buttonStyle(.plain)
            .disabled(isSaving)

            Divider().background(Theme.card).padding(.vertical, 4)

            // Blocked Users
            Text("ЧЁРНЫЙ СПИСОК")
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(Theme.textSecondary)

            if isLoadingBlocks {
                ProgressView().tint(.white).padding(.vertical, 8)
            } else if blockedUsers.isEmpty {
                Text("В чёрном списке никого нет")
                    .font(.system(size: 13))
                    .foregroundColor(Theme.textSecondary)
                    .padding(.vertical, 4)
            } else {
                VStack(spacing: 8) {
                    ForEach(blockedUsers, id: \.description) { b in
                        let bid = b["id"] as? String ?? ""
                        let bname = b["displayName"] as? String ?? (b["username"] as? String ?? "Пользователь")
                        let bavatar = b["avatarUrl"] as? String

                        HStack(spacing: 12) {
                            AvatarBadgeView(avatarUrl: bavatar, name: bname, size: 36)
                            Text(bname)
                                .font(.system(size: 14, weight: .medium))
                                .foregroundColor(Theme.textPrimary)
                            Spacer()
                            Button(action: { unblockUser(id: bid) }) {
                                Text("Разблокировать")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundColor(Theme.accent)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 6)
                                    .background(Color.white.opacity(0.08))
                                    .cornerRadius(8)
                            }
                        }
                        .padding(10)
                        .background(Theme.glassCard)
                        .cornerRadius(12)
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.glassBorder, lineWidth: 1))
                    }
                }
            }
        }
    }

    // MARK: - 3. Кастомизация
    private var customizationSection: some View {
        VStack(alignment: .leading, spacing: 20) {
            // Status Picker
            VStack(alignment: .leading, spacing: 8) {
                Text("СЕТЕВОЙ СТАТУС")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.textSecondary)

                HStack(spacing: 8) {
                    StatusOptionButton(title: "В сети", iconColor: Theme.green, isSelected: selectedStatus == "online") {
                        updateStatus("online")
                    }
                    StatusOptionButton(title: "Неактивен", iconColor: Color.orange, isSelected: selectedStatus == "idle") {
                        updateStatus("idle")
                    }
                    StatusOptionButton(title: "Не беспокоить", iconColor: Theme.red, isSelected: selectedStatus == "dnd") {
                        updateStatus("dnd")
                    }
                    StatusOptionButton(title: "Невидимый", iconColor: Theme.textSecondary, isSelected: selectedStatus == "offline") {
                        updateStatus("offline")
                    }
                }
            }

            Divider().background(Theme.card).padding(.vertical, 4)

            // App Theme
            VStack(alignment: .leading, spacing: 8) {
                Text("ТЕМА ОФОРМЛЕНИЯ")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.textSecondary)

                Picker(L("Тема"), selection: $appTheme) {
                    Text(L("Тёмная")).tag("dark")
                    Text(L("Светлая")).tag("light")
                }
                .pickerStyle(.segmented)
            }

            // App Language
            VStack(alignment: .leading, spacing: 8) {
                Text("ЯЗЫК ИНТЕРФЕЙСА")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundColor(Theme.textSecondary)

                Picker(L("Язык"), selection: $appLanguage) {
                    Text(L("Русский")).tag("ru")
                    Text(L("Английский")).tag("en")
                }
                .pickerStyle(.segmented)
            }
        }
    }

    private func uploadImage(item: PhotosPickerItem?, isBanner: Bool) {
        guard let item = item else { return }
        Task {
            if let data = try? await item.loadTransferable(type: Data.self),
               let uiImg = UIImage(data: data) {
                let maxDimension: CGFloat = isBanner ? 500 : 250
                let resized = resizeImage(image: uiImg, maxDimension: maxDimension)
                if let jpegData = resized.jpegData(compressionQuality: 0.6) {
                    let base64 = "data:image/jpeg;base64," + jpegData.base64EncodedString()
                    let path = isBanner ? "/api/profile/banner" : "/api/profile/avatar"
                    let bodyKey = isBanner ? "bannerUrl" : "avatarUrl"
                    do {
                        _ = try await ApiService.shared.put(path: path, body: [bodyKey: base64])
                        await MainActor.run {
                            if isBanner {
                                self.currentBanner = base64
                            } else {
                                self.currentAvatar = base64
                            }
                            self.noticeMessage = isBanner ? "Шапка успешно обновлена!" : "Аватар успешно обновлен!"
                            self.onUpdated()
                        }
                    } catch {
                        await MainActor.run {
                            self.noticeMessage = "Ошибка загрузки: \(error.localizedDescription)"
                        }
                    }
                }
            }
        }
    }

    private func uploadWallpaper(item: PhotosPickerItem?) {
        guard let item = item else { return }
        Task {
            if let data = try? await item.loadTransferable(type: Data.self),
               let uiImg = UIImage(data: data) {
                let resized = resizeImage(image: uiImg, maxDimension: 1200)
                if let jpegData = resized.jpegData(compressionQuality: 0.7) {
                    let base64 = "data:image/jpeg;base64," + jpegData.base64EncodedString()
                    do {
                        _ = try await ApiService.shared.put(path: "/api/profile/wallpaper", body: [
                            "chatWallpaper": base64
                        ])
                        await MainActor.run {
                            self.chatWallpaper = base64
                            self.noticeMessage = "Обои для чатов успешно установлены!"
                            self.onUpdated()
                        }
                    } catch {
                        await MainActor.run {
                            self.noticeMessage = "Ошибка установки обоев: \(error.localizedDescription)"
                        }
                    }
                }
            }
        }
    }

    private func resetWallpaper() {
        Task {
            do {
                _ = try await ApiService.shared.put(path: "/api/profile/wallpaper", body: [
                    "chatWallpaper": NSNull()
                ])
                await MainActor.run {
                    self.chatWallpaper = ""
                    self.noticeMessage = "Обои чатов сброшены"
                    self.onUpdated()
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func resizeImage(image: UIImage, maxDimension: CGFloat) -> UIImage {
        let size = image.size
        let ratio = min(maxDimension / max(size.width, 1), maxDimension / max(size.height, 1))
        if ratio >= 1.0 { return image }
        let newSize = CGSize(width: size.width * ratio, height: size.height * ratio)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: newSize))
        }
    }

    private func saveProfile() {
        isSaving = true
        noticeMessage = ""

        Task {
            do {
                let uname = user["username"] as? String ?? ""
                let body: [String: Any] = [
                    "username": uname,
                    "displayName": displayName.trimmingCharacters(in: .whitespaces),
                    "bio": bio.trimmingCharacters(in: .whitespaces),
                    "status": selectedStatus
                ]
                _ = try await ApiService.shared.put(path: "/api/profile", body: body)

                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = "Профиль успешно сохранен!"
                    self.onUpdated()
                }
            } catch {
                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func savePrivacy() {
        isSaving = true
        noticeMessage = ""

        Task {
            do {
                _ = try await ApiService.shared.put(path: "/api/profile/privacy", body: [
                    "allowMessages": allowMessages,
                    "allowCalls": allowCalls,
                    "showBio": showBio
                ])
                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = "Настройки приватности сохранены!"
                    self.onUpdated()
                }
            } catch {
                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func changePassword() {
        guard !currentPassword.isEmpty, newPassword.count >= 12 else { return }
        isSaving = true
        noticeMessage = ""

        Task {
            do {
                _ = try await ApiService.shared.put(path: "/api/profile/password", body: [
                    "currentPassword": currentPassword,
                    "newPassword": newPassword
                ])
                await MainActor.run {
                    self.isSaving = false
                    self.currentPassword = ""
                    self.newPassword = ""
                    self.noticeMessage = "Пароль успешно обновлен!"
                }
            } catch {
                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func updateStatus(_ newStatus: String) {
        selectedStatus = newStatus
        Task {
            let uname = user["username"] as? String ?? ""
            _ = try? await ApiService.shared.put(path: "/api/profile", body: [
                "username": uname,
                "displayName": displayName.isEmpty ? (user["displayName"] as? String ?? uname) : displayName,
                "bio": bio,
                "status": newStatus
            ])
            await MainActor.run {
                self.onUpdated()
            }
        }
    }

    private func loadBlockedUsers() {
        isLoadingBlocks = true
        Task {
            do {
                let blocks = try await ApiService.shared.getArray(path: "/api/blocks")
                await MainActor.run {
                    self.blockedUsers = blocks
                    self.isLoadingBlocks = false
                }
            } catch {
                await MainActor.run {
                    self.isLoadingBlocks = false
                }
            }
        }
    }

    private func unblockUser(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.delete(path: "/api/blocks/\(id)")
                await MainActor.run {
                    self.blockedUsers.removeAll { ($0["id"] as? String) == id }
                    self.noticeMessage = "Пользователь разблокирован"
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func loadSecurityData() {
        isLoadingSecurity = true
        isEmailVerified = user["emailVerified"] as? Bool ?? false
        userEmail = user["email"] as? String ?? ""
        isTotpEnabled = user["totpEnabled"] as? Bool ?? false

        Task {
            do {
                let sess = try await ApiService.shared.getArray(path: "/api/auth/sessions")
                let pks = try await ApiService.shared.getArray(path: "/api/auth/passkeys")
                await MainActor.run {
                    self.activeSessions = sess
                    self.userPasskeys = pks
                    self.isLoadingSecurity = false
                }
            } catch {
                await MainActor.run {
                    self.isLoadingSecurity = false
                }
            }
        }
    }

    private func resendVerificationEmail() {
        isSendingEmail = true
        Task {
            do {
                let res = try await ApiService.shared.post(path: "/api/auth/verify-email/resend", body: [:])
                await MainActor.run {
                    self.isSendingEmail = false
                    self.noticeMessage = (res["message"] as? String) ?? "Письмо с подтверждением отправлено!"
                }
            } catch {
                await MainActor.run {
                    self.isSendingEmail = false
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func confirmVerificationEmail() {
        isSendingEmail = true
        Task { @MainActor in
            defer { isSendingEmail = false }
            do {
                _ = try await ApiService.shared.post(path: "/api/auth/verify-email", body: ["email": userEmail, "code": emailVerificationCode])
                isEmailVerified = true
                emailVerificationCode = ""
                noticeMessage = "Почта подтверждена"
                onUpdated()
            } catch { noticeMessage = error.localizedDescription }
        }
    }

    private func startTotpSetup() {
        Task {
            do {
                let setup = try await ApiService.shared.post(path: "/api/auth/2fa/setup", body: [:])
                await MainActor.run {
                    self.totpSetupData = setup
                    self.totpInputCode = ""
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func verifyTotpCode() {
        guard let setup = totpSetupData, totpInputCode.count >= 6 else { return }
        let secret = setup["secret"] as? String ?? ""
        Task {
            do {
                let res = try await ApiService.shared.post(path: "/api/auth/2fa/verify", body: [
                    "code": totpInputCode,
                    "secret": secret
                ])
                await MainActor.run {
                    self.isTotpEnabled = true
                    self.backupCodes = (res["backupCodes"] as? [String]) ?? []
                    self.totpSetupData = nil
                    self.noticeMessage = "2FA успешно активирована! Сохраните резервные коды."
                    self.onUpdated()
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func disableTotp() {
        guard !totpDisableCode.isEmpty else { return }
        Task {
            do {
                _ = try await ApiService.shared.post(path: "/api/auth/2fa/disable", body: [
                    "code": totpDisableCode
                ])
                await MainActor.run {
                    self.isTotpEnabled = false
                    self.showTotpDisableModal = false
                    self.totpDisableCode = ""
                    self.backupCodes = []
                    self.noticeMessage = "2FA отключена"
                    self.onUpdated()
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func revokeSession(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.delete(path: "/api/auth/sessions/\(id)")
                await MainActor.run {
                    self.loadSecurityData()
                    self.noticeMessage = "Сеанс завершен"
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func revokeOtherSessions() {
        Task {
            do {
                _ = try await ApiService.shared.delete(path: "/api/auth/sessions-other")
                await MainActor.run {
                    self.loadSecurityData()
                    self.noticeMessage = "Все остальные сеансы завершены"
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }

    private func deletePasskey(id: String) {
        Task {
            do {
                _ = try await ApiService.shared.delete(path: "/api/auth/passkeys/\(id)")
                await MainActor.run {
                    self.loadSecurityData()
                    self.noticeMessage = "Passkey удален"
                }
            } catch {
                await MainActor.run {
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }
}

struct StatusOptionButton: View {
    let title: String
    let iconColor: Color
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                Circle()
                    .fill(iconColor)
                    .frame(width: 12, height: 12)
                Text(title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(isSelected ? .white : Theme.textSecondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                isSelected ?
                Color.white.opacity(0.18) :
                Color.white.opacity(0.06)
            )
            .cornerRadius(12)
            .overlay(
                RoundedRectangle(cornerRadius: 12)
                    .stroke(isSelected ? Color.white.opacity(0.4) : Color.white.opacity(0.1), lineWidth: 1)
            )
        }
    }
}

struct UserProfileCardModal: View {
    let user: [String: Any]
    let onDismiss: () -> Void
    @State private var fullProfile: [String: Any] = [:]

    private var profile: [String: Any] { user.merging(fullProfile) { _, new in new } }

    var body: some View {
        ZStack {
            Color.black.opacity(0.6).ignoresSafeArea()
                .onTapGesture(perform: onDismiss)

            VStack(spacing: 0) {
                // Banner
                let bannerUrl = profile["bannerUrl"] as? String
                let avatarUrl = profile["avatarUrl"] as? String
                let name = profile["displayName"] as? String ?? (profile["username"] as? String ?? "Пользователь")
                let username = profile["username"] as? String ?? ""
                let bio = profile["bio"] as? String ?? ""
                let presence = profile["status"] as? String ?? (profile["presence"] as? String ?? "offline")
                let isVerified = profile["verified"] as? Bool ?? false
                let isDonator = profile["donator"] as? Bool ?? false

                ZStack(alignment: .bottomLeading) {
                    if let bUrl = bannerUrl, !bUrl.isEmpty {
                        if bUrl.hasPrefix("data:") {
                            let cleanBase64 = (bUrl.components(separatedBy: ",").last ?? "")
                                .trimmingCharacters(in: .whitespacesAndNewlines)
                                .replacingOccurrences(of: "\n", with: "")
                                .replacingOccurrences(of: "\r", with: "")
                            if let data = Data(base64Encoded: cleanBase64, options: [.ignoreUnknownCharacters]),
                               let uiImg = UIImage(data: data) {
                                Image(uiImage: uiImg)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(height: 120)
                                    .clipped()
                            } else {
                                Color.purple.opacity(0.4).frame(height: 120)
                            }
                        } else {
                            AsyncImage(url: ApiService.resolveMediaURL(bUrl)) { img in
                                img.resizable().scaledToFill()
                            } placeholder: {
                                Color.purple.opacity(0.4)
                            }
                            .frame(height: 120)
                            .clipped()
                        }
                    } else {
                        LinearGradient(colors: [Theme.accent.opacity(0.8), Color.purple.opacity(0.6)], startPoint: .topLeading, endPoint: .bottomTrailing)
                            .frame(height: 120)
                    }

                    // Avatar overlapping banner
                    HStack(spacing: 12) {
                        AvatarBadgeView(avatarUrl: avatarUrl, name: name, size: 70)
                            .overlay(Circle().stroke(Color.black, lineWidth: 3))
                            .offset(y: 35)

                        Spacer()

                        Button(action: onDismiss) {
                            Image(systemName: "xmark")
                                .font(.system(size: 14, weight: .bold))
                                .foregroundColor(Theme.textPrimary)
                                .padding(8)
                                .background(Color.black.opacity(0.5))
                                .clipShape(Circle())
                        }
                    }
                    .padding(.horizontal, 16)
                }

                let isBot = (profile["isBot"] as? Bool ?? false) || presence == "bot"

                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 6) {
                        Text(name)
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(Theme.textPrimary)

                        if isBot {
                            Text("БОТ")
                                .font(.system(size: 11, weight: .bold))
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Theme.accent.opacity(0.3))
                                .foregroundColor(Theme.accent)
                                .cornerRadius(6)
                        }
                        if isVerified {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundColor(Theme.accent)
                        }
                        if isDonator {
                            Image(systemName: "star.fill")
                                .foregroundColor(Color(red: 255/255, green: 215/255, blue: 0/255))
                        }

                        Spacer()

                        if isBot {
                            Text("БОТ")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(Theme.accent)
                        } else {
                            Circle()
                                .fill(presence == "online" ? Theme.green : (presence == "idle" ? Color.orange : Theme.textSecondary))
                                .frame(width: 10, height: 10)
                            Text(presence == "online" ? "В сети" : (presence == "idle" ? "Не активен" : "Не в сети"))
                                .font(.system(size: 12))
                                .foregroundColor(Theme.textSecondary)
                        }
                    }
                    .padding(.top, 40)

                    Text("@\(username)")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.textSecondary)

                    if !bio.isEmpty {
                        Text(bio)
                            .font(.system(size: 14))
                            .foregroundColor(Theme.textPrimary)
                            .padding(.top, 4)
                    }
                    if let adminRole = profile["adminRole"] as? String, adminRole != "user" {
                        Label(adminRole == "owner" ? "Основатель VROT" : (adminRole == "moderator" ? "Модератор VROT" : "Администратор VROT"), systemImage: "shield.lefthalf.filled")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundColor(Theme.accent)
                    }
                    if let role = user["role"] as? String {
                        let topRole = (user["roles"] as? [[String: Any]])?.first
                        Text(role == "owner" ? "Владелец сообщества" : (role == "admin" ? "Администратор сообщества" : (topRole?["name"] as? String ?? "Участник сообщества")))
                            .font(.system(size: 12, weight: .medium))
                            .foregroundColor(Color(hex: topRole?["color"] as? String ?? "") ?? Theme.textSecondary)
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: 340)
            .modifier(VrotGlassBar())
            .shadow(color: Color.black.opacity(0.6), radius: 30)
            .padding(.horizontal, 20)
        }
        .task(id: user["id"] as? String) {
            guard let id = user["id"] as? String else { return }
            if let result = try? await ApiService.shared.getObject(path: "/api/users/\(id)/profile") {
                fullProfile = result["user"] as? [String: Any] ?? [:]
            }
        }
    }
}

struct AvatarBadgeView: View {
    let avatarUrl: String?
    let name: String
    var size: CGFloat = 44
    var presence: String? = nil

    private var statusColor: Color? {
        guard let p = presence else { return nil }
        switch p {
        case "online": return Theme.green
        case "dnd": return Theme.red
        case "idle": return Color.orange
        case "offline": return Color.gray.opacity(0.6)
        default: return nil
        }
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            avatarContent

            if let col = statusColor {
                Circle()
                    .fill(col)
                    .frame(width: max(10, size * 0.26), height: max(10, size * 0.26))
                    .overlay(Circle().stroke(Color(red: 16/255, green: 20/255, blue: 32/255), lineWidth: 2))
                    .offset(x: 1, y: 1)
            }
        }
    }

    @ViewBuilder
    private var avatarContent: some View {
        if let aUrl = avatarUrl, !aUrl.isEmpty {
            if aUrl.hasPrefix("data:") {
                let cleanBase64 = (aUrl.components(separatedBy: ",").last ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: "\n", with: "")
                    .replacingOccurrences(of: "\r", with: "")
                if let data = Data(base64Encoded: cleanBase64, options: [.ignoreUnknownCharacters]),
                   let uiImg = UIImage(data: data) {
                    Image(uiImage: uiImg)
                        .resizable()
                        .scaledToFill()
                        .frame(width: size, height: size)
                        .clipShape(Circle())
                } else {
                    fallbackCircle
                }
            } else {
                AsyncImage(url: ApiService.resolveMediaURL(aUrl)) { phase in
                    switch phase {
                    case .success(let img):
                        img.resizable().scaledToFill()
                            .frame(width: size, height: size)
                            .clipShape(Circle())
                    default:
                        fallbackCircle
                    }
                }
            }
        } else {
            fallbackCircle
        }
    }

    private var fallbackCircle: some View {
        Circle()
            .fill(Theme.accent.opacity(0.35))
            .frame(width: size, height: size)
            .overlay(
                Text(String(name.prefix(1)).uppercased())
                    .font(.system(size: size * 0.42, weight: .bold))
                    .foregroundColor(Theme.textPrimary)
            )
    }
}

