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
                        FriendsTabView(friends: friends, onSelectFriend: { friend in
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
    let onSelectFriend: ([String: Any]) -> Void
    let onCallFriend: ([String: Any], Bool) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Друзья и сообщения")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(.white)
                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)

            if friends.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "person.2.slash")
                        .font(.system(size: 40))
                        .foregroundColor(Theme.textSecondary)
                    Text("Список друзей пока пуст")
                        .foregroundColor(Theme.textSecondary)
                    Spacer()
                }
                .frame(maxWidth: .infinity)
            } else {
                List(friends, id: \.description) { friend in
                    let name = friend["displayName"] as? String ?? (friend["username"] as? String ?? "")
                    let status = friend["status"] as? String ?? "offline"

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
                            Text(status == "online" ? "В сети" : "Не в сети")
                                .font(.system(size: 12))
                                .foregroundColor(status == "online" ? Theme.green : Theme.textSecondary)
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
    }
}

struct CommunitiesTabView: View {
    let communities: [[String: Any]]
    let onSelectCommunity: ([String: Any]) -> Void
    let onCommunityCreated: () -> Void

    @State private var showCreateCommunity = false
    @State private var newName = ""
    @State private var newDesc = ""
    @State private var isCreating = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                Text("Сообщества")
                    .font(.system(size: 24, weight: .bold))
                    .foregroundColor(.white)
                Spacer()
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

            if communities.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.system(size: 40))
                        .foregroundColor(Theme.textSecondary)
                    Text("Нет доступных сообществ")
                        .foregroundColor(Theme.textSecondary)
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
