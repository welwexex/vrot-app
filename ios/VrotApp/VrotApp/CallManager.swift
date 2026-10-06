import Foundation
import CallKit
import AVFoundation
import UserNotifications
import WebRTC

struct CallState {
    var active: Bool = false
    var targetId: String = ""
    var targetName: String = ""
    var isVideo: Bool = false
    var isMuted: Bool = false
    var status: String = ""
    var avatarUrl: String? = nil
    var callId: String = ""
    var incoming: Bool = false
    var answered: Bool = false
    var kind: String = "friend"
}

final class CallManager: NSObject, ObservableObject {
    static let shared = CallManager()

    @Published var state = CallState()
    private let provider: CXProvider
    private let controller = CXCallController()
    private var currentCallUUID: UUID?
    private var timeoutTimer: Timer?

    override init() {
        let config = CXProviderConfiguration(localizedName: "VROT")
        config.supportsVideo = true
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        config.includesCallsInRecents = true

        self.provider = CXProvider(configuration: config)
        super.init()
        RTCAudioSession.sharedInstance().useManualAudio = true
        RTCAudioSession.sharedInstance().isAudioEnabled = false
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
    func reportIncomingCall(friendId: String, callerName: String, avatarUrl: String? = nil, isVideo: Bool = false, callId: String, expiresAt: Double, completion: (() -> Void)? = nil) {
        guard expiresAt > Date().timeIntervalSince1970 * 1000 else { completion?(); return }
        if state.active && state.callId == callId { completion?(); return }
        let uuid = UUID()
        self.currentCallUUID = uuid
        self.state = CallState(active: true, targetId: friendId, targetName: callerName, isVideo: isVideo, status: "Входящий вызов…", avatarUrl: avatarUrl, callId: callId, incoming: true)

        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = isVideo
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        update.supportsDTMF = false

        provider.reportNewIncomingCall(with: uuid, update: update) { [weak self] error in
            completion?()
            if let error = error {
                print("Failed to report incoming call: \(error.localizedDescription)")
                self?.endCall()
            } else {
                // 15 seconds unanswered call timeout
                DispatchQueue.main.async {
                    self?.startTimeoutTimer(seconds: max(0, (expiresAt - Date().timeIntervalSince1970 * 1000) / 1000))
                }
            }
        }
    }

    // Start outgoing call
    func startOutgoingCall(targetId: String, name: String, avatarUrl: String? = nil, isVideo: Bool, kind: String = "friend") {
        self.state = CallState(active: true, targetId: targetId, targetName: name, isVideo: isVideo, status: kind == "channel" ? "Подключение к каналу…" : "Вызов… (ожидание)", avatarUrl: avatarUrl, kind: kind)
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
                // 45 seconds timer for friend calls
                DispatchQueue.main.async {
                    if kind == "friend" { self?.startTimeoutTimer(seconds: 45.0) }
                }
            }
        }

        // Notify socket
        if kind == "friend" { RealtimeService.shared.sendCallInvite(friendId: targetId, video: isVideo) }
        NativeCallMedia.shared.start(targetId: targetId, kind: kind, video: isVideo)
    }

    func startTimeoutTimer(seconds: Double) {
        timeoutTimer?.invalidate()
        let interval = max(15.0, seconds)
        timeoutTimer = Timer.scheduledTimer(withTimeInterval: interval, repeats: false) { [weak self] _ in
            guard let self = self, self.state.active else { return }
            if self.state.answered || NativeCallMedia.shared.connectedPeers > 0 {
                self.cancelTimeout()
                return
            }
            self.state.status = "Время ожидания ответа истекло"
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                if self.state.active && !self.state.answered && NativeCallMedia.shared.connectedPeers == 0 {
                    self.endCall()
                }
            }
        }
    }

    func cancelTimeout() {
        timeoutTimer?.invalidate()
        timeoutTimer = nil
    }

    func endCall() {
        cancelTimeout()
        NativeCallMedia.shared.stop()

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
        RealtimeService.shared.sendCallLeave()
        NativeCallMedia.shared.stop()
        currentCallUUID = nil
        DispatchQueue.main.async {
            self.state = CallState()
        }
    }

    func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        cancelTimeout()
        configureAudioSession()
        if !state.callId.isEmpty { RealtimeService.shared.sendCallResponse(callId: state.callId, accept: true) }
        if !state.targetId.isEmpty {
            NativeCallMedia.shared.start(targetId: state.targetId, kind: state.kind, video: state.isVideo)
        }
        DispatchQueue.main.async {
            self.state.answered = true
            self.state.status = "Подключение медиа…"
        }
        action.fulfill()
    }

    func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        cancelTimeout()
        if state.incoming && !state.answered && !state.callId.isEmpty {
            RealtimeService.shared.sendCallResponse(callId: state.callId, accept: false)
        } else if state.kind == "friend" && !state.targetId.isEmpty {
            RealtimeService.shared.sendCallCancel(friendId: state.targetId)
        }
        RealtimeService.shared.sendCallLeave()
        NativeCallMedia.shared.stop()
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
        RTCAudioSession.sharedInstance().audioSessionDidActivate(audioSession)
        RTCAudioSession.sharedInstance().isAudioEnabled = true
    }

    func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        RTCAudioSession.sharedInstance().isAudioEnabled = false
        RTCAudioSession.sharedInstance().audioSessionDidDeactivate(audioSession)
        try? audioSession.setActive(false)
    }

    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try? session.setActive(true)
    }
}
