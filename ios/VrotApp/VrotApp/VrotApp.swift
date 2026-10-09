import SwiftUI
import UIKit
import PushKit

import UserNotifications
import CryptoKit
import Security
import LocalAuthentication
import CommonCrypto

final class VrotAppDelegate: NSObject, UIApplicationDelegate, PKPushRegistryDelegate, UNUserNotificationCenterDelegate {
    private var voipRegistry: PKPushRegistry?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        let center = UNUserNotificationCenter.current()
        center.delegate = self

        let registry = PKPushRegistry(queue: .main)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
        voipRegistry = registry
        application.registerForRemoteNotifications()
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound, .badge])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable : Any], fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        if let kind = userInfo["kind"] as? String, kind == "call" {
            let friendId = userInfo["friendId"] as? String ?? ""
            let aps = userInfo["aps"] as? [String: Any]
            let alert = aps?["alert"] as? [String: Any]
            let title = alert?["title"] as? String ?? ""
            let callerName = title.replacingOccurrences(of: "Входящий вызов: ", with: "").isEmpty ? "Собеседник" : title.replacingOccurrences(of: "Входящий вызов: ", with: "")
            let callId = userInfo["callId"] as? String ?? UUID().uuidString
            let video = (userInfo["video"] as? Bool) ?? false
            let expiresAt = (userInfo["expiresAt"] as? NSNumber)?.doubleValue ?? (Date().timeIntervalSince1970 * 1000 + 15000)
            CallManager.shared.reportIncomingCall(friendId: friendId, callerName: callerName, isVideo: video, callId: callId, expiresAt: expiresAt)
        }
        completionHandler(.newData)
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
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            if granted { DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() } }
        }
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
    @AppStorage("vrot_onboarding_v3") private var onboarded = false
    @Environment(\.scenePhase) private var scenePhase
    @State private var unlocked = false

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            if !onboarded && !isLoggedIn {
                VrotWelcomeSlides { onboarded = true }
            } else if isLoggedIn && VrotAppLock.hasCode && !unlocked && !callManager.state.active {
                VrotUnlockView { unlocked = true }
            } else if callManager.state.active && showCallScreen {
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
        .onChange(of: scenePhase) { phase in
            if phase == .background { unlocked = false }
        }
    }
}

struct VrotWelcomeSlides: View {
    let onFinish: () -> Void
    @State private var page = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private let slides = [
        ("bubble.left.and.bubble.right.fill", "Добро пожаловать\nв Врот", "Место, где ваши люди всегда рядом."),
        ("phone.waveform.fill", "Ближе, чем кажется", "Голос, видео и живые разговоры с друзьями."),
        ("lock.shield.fill", "Ваш аккаунт\nпод защитой", "Коды входа, двухэтапная защита и управление устройствами."),
        ("gamecontroller.fill", "Вместе — интереснее", "Делитесь моментами, собирайте друзей и оставайтесь на связи.")
    ]
    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()
            Circle().fill(Theme.accent.opacity(0.18)).frame(width: 340, height: 340).blur(radius: 70).offset(x: 100, y: -160)
            VStack(spacing: 28) {
                HStack { Text("VROT").font(.headline); Spacer(); Button("Пропустить", action: onFinish) }.padding(.horizontal, 28)
                TabView(selection: $page) {
                    ForEach(0..<slides.count, id: \.self) { index in
                        VStack(spacing: 28) {
                            Image(systemName: slides[index].0).font(.system(size: 84, weight: .light)).foregroundStyle(Theme.accent)
                                .frame(width: 180, height: 180).liquidGlass(cornerRadius: 54)
                            Text(slides[index].1).font(.system(size: 38, weight: .bold, design: .rounded)).multilineTextAlignment(.center)
                            Text(slides[index].2).font(.title3).foregroundStyle(Theme.textSecondary).multilineTextAlignment(.center).padding(.horizontal, 32)
                        }.tag(index).padding(.bottom, 40)
                    }
                }.tabViewStyle(.page(indexDisplayMode: .always))
                Button {
                    if page == slides.count - 1 { onFinish() }
                    else { withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.35)) { page += 1 } }
                } label: { Text(page == slides.count - 1 ? "Начать общение" : "Продолжить").font(.headline).frame(maxWidth: .infinity).padding(18) }
                .buttonStyle(.plain).background(Theme.accent, in: Capsule()).foregroundStyle(.white).padding(.horizontal, 28)
            }.padding(.vertical, 24)
        }.foregroundStyle(Theme.textPrimary)
    }
}

enum VrotAppLock {
    private static func derive(_ code: String, salt: String) -> String {
        let saltBytes = Array(salt.utf8)
        var output = [UInt8](repeating: 0, count: 32)
        let status = code.withCString { password in
            saltBytes.withUnsafeBufferPointer { buffer in
                CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), password, code.utf8.count, buffer.baseAddress, buffer.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256), 210_000, &output, output.count)
            }
        }
        guard status == kCCSuccess else { return "" }
        return output.map { String(format: "%02x", $0) }.joined()
    }
    private static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "fun.vrot.applock", kSecAttrAccount as String: "pin"]
    private static var saved: String? {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }
    static var hasCode: Bool { saved != nil }
    static func set(_ code: String) throws {
        let salt = UUID().uuidString
        let hash = derive(code, salt: salt)
        guard !hash.isEmpty else { throw APIError.decodingError }
        var q = query; q[kSecValueData as String] = Data((salt + ":" + hash).utf8)
        q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        SecItemDelete(query as CFDictionary)
        guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw APIError.decodingError }
    }
    static func verify(_ code: String) -> Bool {
        guard let parts = saved?.split(separator: ":"), parts.count == 2 else { return false }
        return derive(code, salt: String(parts[0])) == String(parts[1])
    }
}

struct VrotUnlockView: View {
    let onUnlock: () -> Void
    @State private var code = ""
    @State private var error = ""
    @State private var blockedUntil = Date.distantPast
    @State private var failures = 0
    var body: some View {
        VStack(spacing: 24) {
            Image(systemName: "lock.fill").font(.system(size: 48)).foregroundStyle(Theme.accent)
            Text("Врот защищён").font(.largeTitle.bold())
            SecureField("Код приложения", text: $code).keyboardType(.numberPad).textContentType(.password).padding().background(Theme.card, in: RoundedRectangle(cornerRadius: 16))
            if !error.isEmpty { Text(error).foregroundStyle(Theme.red) }
            Button("Открыть") {
                guard Date() >= blockedUntil else { error = "Подождите 30 секунд"; return }
                if VrotAppLock.verify(code) { onUnlock() }
                else { failures += 1; code = ""; error = "Неверный код"; if failures >= 5 { blockedUntil = Date().addingTimeInterval(30); failures = 0 } }
            }.buttonStyle(.borderedProminent).tint(Theme.accent)
            Button("Face ID / Touch ID") {
                let context = LAContext()
                context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: "Открыть Врот") { success, _ in
                    if success { DispatchQueue.main.async { onUnlock() } }
                }
            }
        }.padding(32)
    }
}

struct VrotLockSettings: View {
    @State private var oldCode = ""
    @State private var code = ""
    @State private var confirm = ""
    @State private var message = ""
    var body: some View {
        Form {
            Section("Код приложения") {
                if VrotAppLock.hasCode { SecureField("Текущий код", text: $oldCode).keyboardType(.numberPad) }
                SecureField("Новый код — 6 цифр", text: $code).keyboardType(.numberPad)
                SecureField("Повторите код", text: $confirm).keyboardType(.numberPad)
                Button("Сохранить код") {
                    guard !VrotAppLock.hasCode || VrotAppLock.verify(oldCode) else { message = "Неверный текущий код"; return }
                    guard code.count == 6, code.allSatisfy({ $0.isNumber }), code == confirm else { message = "Введите и повторите код из 6 цифр"; return }
                    do { try VrotAppLock.set(code); message = "Код сохранён"; oldCode = ""; code = ""; confirm = "" } catch { message = "Не удалось сохранить код" }
                }
            }
            Text(message)
        }.navigationTitle("Код и Face ID")
    }
}
