import Foundation
import CallKit
import AVFoundation
import UserNotifications

struct CallState {
    var active: Bool = false
    var targetId: String = ""
    var targetName: String = ""
    var isVideo: Bool = false
    var isMuted: Bool = false
    var status: String = ""
}

final class CallManager: NSObject, ObservableObject {
    static let shared = CallManager()

    @Published var state = CallState()
    private let provider: CXProvider
    private let controller = CXCallController()
    private var currentCallUUID: UUID?
    private var timeoutTimer: Timer?

    override init() {
        let config = CXProviderConfiguration(localizedName: "Vrot.fun")
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true

        self.provider = CXProvider(configuration: config)
        super.init()
        self.provider.setDelegate(self, queue: nil)

        setupNotifications()
    }

    private func setupNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            print("Notification permission granted: \(granted)")
        }
    }

    // Trigger local push notification
    func sendLocalNotification(title: String, body: String) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default

        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: 0.5, repeats: false)
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: trigger)
        UNUserNotificationCenter.current().add(request)
    }

    // Show native system incoming call (CallKit lock screen)
    func reportIncomingCall(friendId: String, callerName: String, isVideo: Bool = false) {
        let uuid = UUID()
        self.currentCallUUID = uuid
        self.state = CallState(active: true, targetId: friendId, targetName: callerName, isVideo: isVideo, status: "Входящий вызов…")

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = isVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            if let error = error {
                print("Failed to report incoming call: \(error.localizedDescription)")
                self?.endCall()
            } else {
                // 15 seconds unanswered call timeout
                DispatchQueue.main.async {
                    self?.startTimeoutTimer(seconds: 15.0)
                }
            }
        }
    }

    // Start outgoing call
    func startOutgoingCall(targetId: String, name: String, isVideo: Bool) {
        self.state = CallState(active: true, targetId: targetId, targetName: name, isVideo: isVideo, status: "Вызов… (ожидание)")
        let handle = CXHandle(type: .generic, value: name)
        let uuid = UUID()
        self.currentCallUUID = uuid

        let startCallAction = CXStartCallAction(call: uuid, handle: handle)
        startCallAction.isVideo = isVideo
        let transaction = CXTransaction(action: startCallAction)

        controller.request(transaction) { [weak self] error in
            if let error = error {
                print("Failed to start outgoing call: \(error.localizedDescription)")
            } else {
                // 15 seconds timer
                DispatchQueue.main.async {
                    self?.startTimeoutTimer(seconds: 15.0)
                }
            }
        }

        // Notify socket
        RealtimeService.shared.sendCallInvite(friendId: targetId, video: isVideo)
    }

    func startTimeoutTimer(seconds: Double) {
        timeoutTimer?.invalidate()
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
            guard let self = self, self.state.active else { return }
            self.state.status = "Время ожидания ответа истекло"
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                self.endCall()
            }
        }
    }

    func cancelTimeout() {
        timeoutTimer?.invalidate()
        timeoutTimer = nil
    }

    func endCall() {
        cancelTimeout()
        guard let uuid = currentCallUUID else {
            DispatchQueue.main.async {
                self.state = CallState()
            }
            return
        }

        let endAction = CXEndCallAction(call: uuid)
        let transaction = CXTransaction(action: endAction)
        controller.request(transaction) { [weak self] _ in
            DispatchQueue.main.async {
                self?.currentCallUUID = nil
                self?.state = CallState()
            }
        }
    }
}

extension CallManager: CXProviderDelegate {
    func providerDidReset(_ provider: CXProvider) {
        cancelTimeout()
        currentCallUUID = nil
        DispatchQueue.main.async {
            self.state = CallState()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        cancelTimeout()
        configureAudioSession()
        DispatchQueue.main.async {
            self.state.status = "Идёт разговор"
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        cancelTimeout()
        currentCallUUID = nil
        DispatchQueue.main.async {
            self.state = CallState()
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        configureAudioSession()
        action.fulfill()
    }

    func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        configureAudioSession()
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        try? audioSession.setActive(false)
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try? session.setActive(true)
    }
}
