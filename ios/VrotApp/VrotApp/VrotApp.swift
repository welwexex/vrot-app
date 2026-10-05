import SwiftUI
import UIKit
import PushKit

final class VrotAppDelegate: NSObject, UIApplicationDelegate, PKPushRegistryDelegate {
    private var voipRegistry: PKPushRegistry?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
        application.registerForRemoteNotifications()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        storePushToken(deviceToken, kind: "apns")
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        storePushToken(pushCredentials.token, kind: "voip")
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        let old = UserDefaults.standard.string(forKey: "vrot_push_voip") ?? ""
        UserDefaults.standard.removeObject(forKey: "vrot_push_voip")
        if !old.isEmpty { Task { _ = try? await ApiService.shared.request(path: "/api/ios/devices", method: "DELETE", body: ["token": old, "kind": "voip"]) } }
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        let data = payload.dictionaryPayload
        guard let callId = data["callId"] as? String,
              let friendId = data["friendId"] as? String,
              let expiresAt = (data["expiresAt"] as? NSNumber)?.doubleValue else { completion(); return }
        let name = data["callerName"] as? String ?? "VROT"
        CallManager.shared.reportIncomingCall(friendId: friendId, callerName: name, isVideo: data["video"] as? Bool ?? false, callId: callId, expiresAt: expiresAt, completion: completion)
    }

    private func storePushToken(_ data: Data, kind: String) {
        let token = data.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "vrot_push_\(kind)")
        Self.registerStoredTokens()
    }

    static func registerStoredTokens() {
        guard SessionStore.shared.cookie() != nil else { return }
        for kind in ["apns", "voip"] {
            guard let token = UserDefaults.standard.string(forKey: "vrot_push_\(kind)") else { continue }
            Task { _ = try? await ApiService.shared.post(path: "/api/ios/devices", body: ["token": token, "kind": kind]) }
        }
    }

    static func unregisterStoredTokens() async {
        for kind in ["apns", "voip"] {
            guard let token = UserDefaults.standard.string(forKey: "vrot_push_\(kind)") else { continue }
            _ = try? await ApiService.shared.request(path: "/api/ios/devices", method: "DELETE", body: ["token": token, "kind": kind])
        }
    }
}

@main
struct VrotApp: App {
    @UIApplicationDelegateAdaptor(VrotAppDelegate.self) private var appDelegate
    @StateObject private var callManager = CallManager.shared
    @State private var isLoggedIn = (SessionStore.shared.cookie() != nil)
    @AppStorage("vrot_theme") private var theme = "dark"
    @AppStorage("vrot_language") private var language = "ru"

    var body: some Scene {
        WindowGroup {
            RootView(isLoggedIn: $isLoggedIn)
                .preferredColorScheme(theme == "light" ? .light : .dark)
                .environment(\.locale, Locale(identifier: language))
                .onAppear {
                    if isLoggedIn {
                        RealtimeService.shared.connect()
                        VrotAppDelegate.registerStoredTokens()
                    }
                }
        }
    }
}

struct RootView: View {
    @Binding var isLoggedIn: Bool
    @ObservedObject var callManager = CallManager.shared
    @State private var showCallScreen = true

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if callManager.state.active && showCallScreen {
                ActiveCallOverlay(onMinimize: { showCallScreen = false })
            } else if isLoggedIn {
                MainTabsView(isLoggedIn: $isLoggedIn)
                    .overlay(alignment: .top) {
                        if callManager.state.active {
                            Button(action: { showCallScreen = true }) {
                                Label(callManager.state.targetName, systemImage: "phone.fill")
                                    .padding(.horizontal, 16).padding(.vertical, 10)
                            }
                            .modifier(VrotGlassBar())
                            .padding(.top, 8)
                        }
                    }
            } else {
                AuthView(isLoggedIn: $isLoggedIn)
            }
        }
        .onChange(of: isLoggedIn) { loggedIn in
            if loggedIn { RealtimeService.shared.connect(); VrotAppDelegate.registerStoredTokens() }
        }
        .onChange(of: callManager.state.active) { active in
            if active { showCallScreen = true }
        }
    }
}
