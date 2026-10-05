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

    var body: some View {
        VStack(spacing: 24) {
            let name = user["displayName"] as? String ?? (user["username"] as? String ?? "Пользователь")
            let email = user["email"] as? String ?? ""

            VStack(spacing: 12) {
                Circle()
                    .fill(Theme.accent)
                    .frame(width: 80, height: 80)
                    .overlay(
                        Text(String(name.prefix(1)).uppercased())
                            .font(.system(size: 32, weight: .bold))
                            .foregroundColor(.white)
                    )

                Text(name)
                    .font(.system(size: 22, weight: .bold))
                    .foregroundColor(.white)

                Text(email)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.textSecondary)
            }
            .padding(.top, 40)

            Spacer()

            Button(action: onLogout) {
                Text("Выйти из аккаунта")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Theme.red)
                    .frame(maxWidth: .infinity)
                    .frame(height: 48)
                    .background(Theme.card)
                    .cornerRadius(12)
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 20)
        }
    }
}
