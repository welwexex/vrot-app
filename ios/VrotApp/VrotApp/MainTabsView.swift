import SwiftUI

struct MainTabsView: View {
    @Binding var isLoggedIn: Bool
    @State private var selectedTab = 0
    @State private var friends: [[String: Any]] = []
    @State private var communities: [[String: Any]] = []
    @State private var currentUser: [String: Any] = [:]
    @State private var activeChatFriend: [String: Any]?
    @State private var activeCommunity: [String: Any]?
    @State private var isLoading = true

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if let friend = activeChatFriend {
                ChatView(friend: friend, onBack: { activeChatFriend = nil })
            } else if let comm = activeCommunity {
                CommunityDetailView(community: comm, onBack: { activeCommunity = nil })
            } else {
                VStack(spacing: 0) {
                    // Content
                    TabView(selection: $selectedTab) {
                        FriendsTabView(friends: friends, onRefresh: {
                            loadData()
                        }, onSelectFriend: { friend in
                            activeChatFriend = friend
                        }, onCallFriend: { friend, isVideo in
                            let id = friend["id"] as? String ?? ""
                            let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "Друг")
                            CallManager.shared.startOutgoingCall(targetId: id, name: name, isVideo: isVideo)
                        })
                        .tag(0)

                        CommunitiesTabView(communities: communities, onSelectCommunity: { comm in
                            activeCommunity = comm
                        }, onCommunityCreated: {
                            loadData()
                        })
                        .tag(1)

                        ProfileTabView(user: currentUser, onLogout: logout)
                            .tag(2)

                        LiquidGalaxyTabView()
                            .tag(3)
                    }
                    .tabViewStyle(.page(indexDisplayMode: .never))

                    // Custom Bottom Navigation Bar
                    HStack {
                        TabBarButton(icon: "message.fill", title: "Чаты", isSelected: selectedTab == 0) {
                            selectedTab = 0
                        }
                        TabBarButton(icon: "person.3.fill", title: "Сообщества", isSelected: selectedTab == 1) {
                            selectedTab = 1
                        }
                        TabBarButton(icon: "sparkles", title: "Galaxy", isSelected: selectedTab == 3) {
                            selectedTab = 3
                        }
                        TabBarButton(icon: "person.crop.circle.fill", title: "Профиль", isSelected: selectedTab == 2) {
                            selectedTab = 2
                        }
                    }
                    .padding(.vertical, 8)
                    .background(Theme.surface)
                }
            }
        }
        .onAppear(perform: loadData)
    }

    private func loadData() {
        Task {
            do {
                let userObj = try await ApiService.shared.getObject(path: "/api/auth/me")
                let friendsArr = try await ApiService.shared.getArray(path: "/api/friends")
                let commArr = try await ApiService.shared.getArray(path: "/api/communities")

                await MainActor.run {
                    self.currentUser = userObj["user"] as? [String: Any] ?? [:]
                    self.friends = friendsArr
                    self.communities = commArr
                    self.isLoading = false
                }
            } catch {
                print("Failed to load initial data: \(error)")
            }
        }
    }

    private func logout() {
        Task {
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
                    .font(.system(size: 20))
                Text(title)
                    .font(.system(size: 11, weight: .medium))
            }
            .foregroundColor(isSelected ? Theme.accent : Theme.textSecondary)
            .frame(maxWidth: .infinity)
        }
    }
}

struct FriendsTabView: View {
    let friends: [[String: Any]]
    let onRefresh: () -> Void
    let onSelectFriend: ([String: Any]) -> Void
    let onCallFriend: ([String: Any], Bool) -> Void

    @State private var selectedSubtab = 0 // 0: В сети, 1: Все, 2: Ожидание, 3: Добавить
    @State private var searchUsername = ""
    @State private var searchResults: [[String: Any]] = []
    @State private var isSearching = false
    @State private var actionMessage = ""

    private var acceptedFriends: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "accepted" }
    }

    private var onlineFriends: [[String: Any]] {
        acceptedFriends.filter { ($0["presence"] as? String ?? "") == "online" }
    }

    private var pendingIncoming: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "pending" && ($0["direction"] as? String ?? "") == "incoming" }
    }

    private var pendingOutgoing: [[String: Any]] {
        friends.filter { ($0["status"] as? String ?? "") == "pending" && ($0["direction"] as? String ?? "") == "outgoing" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Text("Друзья")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(.white)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)

            // Subtabs: В сети | Все | Ожидание | Добавить
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    FriendSubtabButton(title: "В сети (\(onlineFriends.count))", isSelected: selectedSubtab == 0) {
                        selectedSubtab = 0
                    }
                    FriendSubtabButton(title: "Все (\(acceptedFriends.count))", isSelected: selectedSubtab == 1) {
                        selectedSubtab = 1
                    }
                    FriendSubtabButton(title: "Ожидание (\(pendingIncoming.count + pendingOutgoing.count))", isSelected: selectedSubtab == 2) {
                        selectedSubtab = 2
                    }
                    FriendSubtabButton(title: "Добавить в друзья", isSelected: selectedSubtab == 3, isAdd: true) {
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
                    friendsListView(list: onlineFriends, emptyText: "Никого из друзей нет в сети")
                case 1:
                    friendsListView(list: acceptedFriends, emptyText: "Список друзей пуст. Найдите людей во вкладке «Добавить в друзья»")
                case 2:
                    pendingListView
                case 3:
                    addFriendView
                default:
                    EmptyView()
                }
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

                HStack(spacing: 12) {
                    Circle()
                        .fill(Theme.accent.opacity(0.3))
                        .frame(width: 44, height: 44)
                        .overlay(
                            Text(String(name.prefix(1)).uppercased())
                                .font(.system(size: 18, weight: .bold))
                                .foregroundColor(.white)
                        )

                    VStack(alignment: .leading, spacing: 4) {
                        Text(name)
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(.white)
                        Text(presence == "online" ? "В сети" : "Не в сети")
                            .font(.system(size: 12))
                            .foregroundColor(presence == "online" ? Theme.green : Theme.textSecondary)
                    }

                    Spacer()

                    // Call buttons
                    Button(action: { onCallFriend(friend, false) }) {
                        Image(systemName: "phone.fill")
                            .foregroundColor(Theme.green)
                            .padding(8)
                            .background(Theme.card)
                            .clipShape(Circle())
                    }
                    .buttonStyle(BorderlessButtonStyle())

                    Button(action: { onCallFriend(friend, true) }) {
                        Image(systemName: "video.fill")
                            .foregroundColor(Theme.accent)
                            .padding(8)
                            .background(Theme.card)
                            .clipShape(Circle())
                    }
                    .buttonStyle(BorderlessButtonStyle())

                    // Delete friend button
                    Button(action: { removeFriend(id: id) }) {
                        Image(systemName: "xmark")
                            .foregroundColor(Theme.red)
                            .padding(8)
                            .background(Theme.card)
                            .clipShape(Circle())
                    }
                    .buttonStyle(BorderlessButtonStyle())
                }
                .padding(.vertical, 4)
                .listRowBackground(Theme.darkBg)
                .contentShape(Rectangle())
                .onTapGesture {
                    onSelectFriend(friend)
                }
            }
            .listStyle(.plain)
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
                                            .foregroundColor(.white)
                                            .fontWeight(.bold)
                                    )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(name)
                                        .foregroundColor(.white)
                                        .font(.system(size: 15, weight: .semibold))
                                    Text("Входящий запрос")
                                        .foregroundColor(Theme.textSecondary)
                                        .font(.system(size: 12))
                                }

                                Spacer()

                                Button(action: { acceptFriend(id: id) }) {
                                    Image(systemName: "checkmark")
                                        .foregroundColor(.white)
                                        .padding(8)
                                        .background(Theme.green)
                                        .clipShape(Circle())
                                }

                                Button(action: { removeFriend(id: id) }) {
                                    Image(systemName: "xmark")
                                        .foregroundColor(.white)
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
                                            .foregroundColor(.white)
                                            .fontWeight(.bold)
                                    )

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(name)
                                        .foregroundColor(.white)
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
                            .foregroundColor(.white)
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
                                                .foregroundColor(.white)
                                                .fontWeight(.bold)
                                        )

                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(dname)
                                            .foregroundColor(.white)
                                            .font(.system(size: 15, weight: .semibold))
                                        Text("@\(uname)")
                                            .foregroundColor(Theme.textSecondary)
                                            .font(.system(size: 12))
                                    }

                                    Spacer()

                                    Button(action: { sendFriendRequest(username: uname) }) {
                                        Text("Отправить заявку")
                                            .font(.system(size: 12, weight: .bold))
                                            .foregroundColor(.white)
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
                    .foregroundColor(.white)
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
                                    .foregroundColor(.white)
                                    .font(.system(size: 15, weight: .semibold))
                                Text("От @\(inviter)")
                                    .foregroundColor(Theme.textSecondary)
                                    .font(.system(size: 12))
                            }

                            Spacer()

                            Button(action: { respondToInvitation(id: id, accept: true) }) {
                                Text("Вступить")
                                    .font(.system(size: 12, weight: .bold))
                                    .foregroundColor(.white)
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
                List(communities, id: \.description) { comm in
                    let name = comm["name"] as? String ?? "Сообщество"
                    let desc = comm["description"] as? String ?? ""

                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 10)
                            .fill(Theme.accent)
                            .frame(width: 44, height: 44)
                            .overlay(
                                Text(String(name.prefix(1)).uppercased())
                                    .font(.system(size: 18, weight: .bold))
                                    .foregroundColor(.white)
                            )

                        VStack(alignment: .leading, spacing: 4) {
                            Text(name)
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundColor(.white)
                            if !desc.isEmpty {
                                Text(desc)
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.textSecondary)
                                    .lineLimit(1)
                            }
                        }
                        Spacer()
                    }
                    .padding(.vertical, 4)
                    .listRowBackground(Theme.darkBg)
                    .contentShape(Rectangle())
                    .onTapGesture {
                        onSelectCommunity(comm)
                    }
                }
                .listStyle(.plain)
            }
        }
        .onAppear(perform: loadInvitations)
        .sheet(isPresented: $showJoinByCode) {
            ZStack {
                Theme.surface.ignoresSafeArea()
                VStack(spacing: 20) {
                    Text("Присоединиться по коду")
                        .font(.system(size: 20, weight: .bold))
                        .foregroundColor(.white)

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
                                .foregroundColor(.white)
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
                        .foregroundColor(.white)

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
                                .foregroundColor(.white)
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

    @State private var showSettingsModal = false
    @State private var displayName = ""
    @State private var bio = ""
    @State private var selectedStatus = "online"
    @State private var currentPassword = ""
    @State private var newPassword = ""
    @State private var isSaving = false
    @State private var noticeMessage = ""

    var body: some View {
        ScrollView {
            VStack(spacing: 20) {
                let name = user["displayName"] as? String ?? (user["username"] as? String ?? "Пользователь")
                let username = user["username"] as? String ?? ""
                let email = user["email"] as? String ?? ""
                let userBio = user["bio"] as? String ?? ""
                let isVerified = user["verified"] as? Bool ?? false
                let isDonator = user["donator"] as? Bool ?? false

                // Header Card
                VStack(spacing: 12) {
                    Circle()
                        .fill(Theme.accent)
                        .frame(width: 88, height: 88)
                        .overlay(
                            Text(String(name.prefix(1)).uppercased())
                                .font(.system(size: 36, weight: .bold))
                                .foregroundColor(.white)
                        )

                    HStack(spacing: 6) {
                        Text(name)
                            .font(.system(size: 22, weight: .bold))
                            .foregroundColor(.white)

                        if isVerified {
                            Image(systemName: "checkmark.seal.fill")
                                .foregroundColor(Theme.accent)
                        }
                        if isDonator {
                            Image(systemName: "star.fill")
                                .foregroundColor(Color(red: 255/255, green: 215/255, blue: 0/255))
                        }
                    }

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
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 16)
                            .padding(.top, 4)
                    }
                }
                .padding(.vertical, 24)
                .frame(maxWidth: .infinity)
                .background(Theme.surface)
                .cornerRadius(16)
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

                    Button(action: {
                        displayName = user["displayName"] as? String ?? (user["username"] as? String ?? "")
                        bio = user["bio"] as? String ?? ""
                        selectedStatus = user["status"] as? String ?? "online"
                        showSettingsModal = true
                    }) {
                        HStack {
                            Image(systemName: "person.crop.circle.badge.checkmark")
                                .font(.system(size: 18))
                                .foregroundColor(Theme.accent)
                            Text("Редактировать профиль и статус")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(.white)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 14))
                                .foregroundColor(Theme.textSecondary)
                        }
                        .padding(14)
                        .background(Theme.surface)
                        .cornerRadius(12)
                    }

                    // System Notifications / Call status info
                    HStack {
                        Image(systemName: "bell.badge.fill")
                            .font(.system(size: 18))
                            .foregroundColor(Theme.green)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Уведомления и звонки")
                                .font(.system(size: 15, weight: .medium))
                                .foregroundColor(.white)
                            Text("CallKit и WebSocket звонки активны")
                                .font(.system(size: 12))
                                .foregroundColor(Theme.textSecondary)
                        }
                        Spacer()
                    }
                    .padding(14)
                    .background(Theme.surface)
                    .cornerRadius(12)
                }
                .padding(.horizontal, 16)

                Spacer(minLength: 20)

                // Logout Button
                Button(action: onLogout) {
                    Text("Выйти из аккаунта")
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundColor(Theme.red)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(Theme.card)
                        .cornerRadius(12)
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 30)
            }
        }
        .sheet(isPresented: $showSettingsModal) {
            ZStack {
                Theme.surface.ignoresSafeArea()

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("Настройки профиля")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(.white)
                            .padding(.top, 10)

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

                        VStack(alignment: .leading, spacing: 6) {
                            Text("Статус")
                                .font(.system(size: 13, weight: .medium))
                                .foregroundColor(Theme.textSecondary)

                            Picker("Статус", selection: $selectedStatus) {
                                Text("В сети").tag("online")
                                Text("Не активен").tag("idle")
                                Text("Не беспокоить").tag("dnd")
                                Text("Невидимый").tag("offline")
                            }
                            .pickerStyle(.segmented)
                            .colorScheme(.dark)
                        }

                        Divider().background(Theme.card).padding(.vertical, 8)

                        Text("Смена пароля (необязательно)")
                            .font(.system(size: 15, weight: .bold))
                            .foregroundColor(.white)

                        CustomSecureField(placeholder: "Текущий пароль", text: $currentPassword)
                        CustomSecureField(placeholder: "Новый пароль (мин. 12 симв.)", text: $newPassword)

                        Button(action: saveSettings) {
                            if isSaving {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            } else {
                                Text("Сохранить изменения")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(Theme.accent)
                        .cornerRadius(12)
                        .disabled(isSaving)
                        .padding(.top, 10)
                    }
                    .padding(24)
                }
            }
        }
    }

    private func saveSettings() {
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

                if !currentPassword.isEmpty && !newPassword.isEmpty {
                    _ = try await ApiService.shared.put(path: "/api/profile/password", body: [
                        "currentPassword": currentPassword,
                        "newPassword": newPassword
                    ])
                }

                await MainActor.run {
                    self.isSaving = false
                    self.showSettingsModal = false
                    self.noticeMessage = "Настройки успешно сохранены!"
                    self.currentPassword = ""
                    self.newPassword = ""
                }
            } catch {
                await MainActor.run {
                    self.isSaving = false
                    self.noticeMessage = error.localizedDescription
                }
            }
        }
    }
}

struct LiquidGalaxyTabView: View {
    @State private var rotationAngle: Double = 0
    @State private var pulseScale: CGFloat = 1.0
    @State private var selectedScreen = 0
    @State private var isSpinning = true

    let galaxyScreens = [
        ("Главный купол (Rig-1)", "Звездная система VROT & Орион", "globe.europe.africa.fill", Color.purple),
        ("Левый экран (Rig-2)", "Панорама туманности Андромеды", "sparkles", Color.cyan),
        ("Правый экран (Rig-3)", "Космический радар связи", "antenna.radiowaves.left.and.right", Color.blue),
        ("Нижняя консоль (Kiosk)", "Liquid Galaxy Master Controller", "display.2", Color.indigo)
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                VStack(spacing: 8) {
                    HStack {
                        Image(systemName: "sparkles")
                            .foregroundColor(.purple)
                            .font(.system(size: 24))
                        Text("LIQUID GALAXY")
                            .font(.system(size: 24, weight: .black))
                            .foregroundColor(.white)
                        Image(systemName: "sparkles")
                            .foregroundColor(.purple)
                            .font(.system(size: 24))
                    }

                    Text("Панорамная многоэкранная система визуализации")
                        .font(.system(size: 13))
                        .foregroundColor(Theme.textSecondary)
                }
                .padding(.top, 24)

                // Interactive Galaxy Orb
                ZStack {
                    Circle()
                        .fill(
                            RadialGradient(
                                gradient: Gradient(colors: [Color.purple.opacity(0.8), Color.blue.opacity(0.4), Color.clear]),
                                center: .center,
                                startRadius: 10,
                                endRadius: 120
                            )
                        )
                        .frame(width: 220, height: 220)
                        .scaleEffect(pulseScale)

                    // Outer orbit ring
                    Circle()
                        .stroke(Color.cyan.opacity(0.6), style: StrokeStyle(lineWidth: 2, dash: [8, 8]))
                        .frame(width: 180, height: 180)
                        .rotationEffect(.degrees(rotationAngle))

                    // Inner orbit ring
                    Circle()
                        .stroke(Color.purple.opacity(0.7), style: StrokeStyle(lineWidth: 3, dash: [4, 6]))
                        .frame(width: 120, height: 120)
                        .rotationEffect(.degrees(-rotationAngle * 1.5))

                    // Core icon
                    Image(systemName: "globe.americas.fill")
                        .font(.system(size: 54))
                        .foregroundColor(.white)
                        .shadow(color: .purple, radius: 15)
                }
                .padding(.vertical, 10)
                .onAppear {
                    withAnimation(Animation.linear(duration: 12).repeatForever(autoreverses: false)) {
                        rotationAngle = 360
                    }
                    withAnimation(Animation.easeInOut(duration: 2).repeatForever(autoreverses: true)) {
                        pulseScale = 1.15
                    }
                }

                // Panoramic Screens Grid (Liquid Galaxy Rig Display)
                VStack(alignment: .leading, spacing: 14) {
                    Text("Экраны панорамы Liquid Galaxy:")
                        .font(.system(size: 16, weight: .bold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 16)

                    ForEach(0..<galaxyScreens.count, id: \.self) { idx in
                        let item = galaxyScreens[idx]
                        Button(action: {
                            selectedScreen = idx
                        }) {
                            HStack(spacing: 14) {
                                Image(systemName: item.2)
                                    .font(.system(size: 22))
                                    .foregroundColor(item.3)
                                    .frame(width: 44, height: 44)
                                    .background(item.3.opacity(0.2))
                                    .cornerRadius(12)

                                VStack(alignment: .leading, spacing: 4) {
                                    Text(item.0)
                                        .font(.system(size: 15, weight: .semibold))
                                        .foregroundColor(.white)
                                    Text(item.1)
                                        .font(.system(size: 12))
                                        .foregroundColor(Theme.textSecondary)
                                }

                                Spacer()

                                if selectedScreen == idx {
                                    Image(systemName: "checkmark.circle.fill")
                                        .foregroundColor(Theme.green)
                                        .font(.system(size: 20))
                                }
                            }
                            .padding(14)
                            .background(selectedScreen == idx ? Theme.card.opacity(0.9) : Theme.card.opacity(0.5))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14)
                                    .stroke(selectedScreen == idx ? item.3 : Color.clear, lineWidth: 1.5)
                            )
                            .cornerRadius(14)
                        }
                        .padding(.horizontal, 16)
                    }
                }

                // Controls
                VStack(spacing: 12) {
                    Button(action: {
                        isSpinning.toggle()
                        if isSpinning {
                            withAnimation(Animation.linear(duration: 12).repeatForever(autoreverses: false)) {
                                rotationAngle += 360
                            }
                        }
                    }) {
                        HStack {
                            Image(systemName: "arrow.triangle.2.circlepath")
                            Text("Синхронизировать Liquid Galaxy Rig")
                        }
                        .font(.system(size: 15, weight: .bold))
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(LinearGradient(gradient: Gradient(colors: [Color.purple, Color.blue]), startPoint: .leading, endPoint: .trailing))
                        .cornerRadius(14)
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.bottom, 30)
            }
        }
        .background(Theme.darkBg)
    }
}

