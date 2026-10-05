import SwiftUI

@main
struct VrotApp: App {
    @StateObject private var callManager = CallManager.shared
    @State private var isLoggedIn = (SessionStore.shared.cookie() != nil)

    var body: some Scene {
        WindowGroup {
            RootView(isLoggedIn: $isLoggedIn)
                .preferredColorScheme(.dark)
                .onAppear {
                    if isLoggedIn {
                        RealtimeService.shared.connect()
                    }
                }
        }
    }
}

struct RootView: View {
    @Binding var isLoggedIn: Bool
    @ObservedObject var callManager = CallManager.shared

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if callManager.state.active {
                ActiveCallOverlay()
            } else if isLoggedIn {
                MainTabsView(isLoggedIn: $isLoggedIn)
            } else {
                AuthView(isLoggedIn: $isLoggedIn)
            }
        }
    }
}
