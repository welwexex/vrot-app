import Foundation

final class RealtimeService: NSObject, URLSessionWebSocketDelegate {
    static let shared = RealtimeService()

    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var pingTimer: Timer?

    var onDirectMessage: (([String: Any]) -> Void)?
    var onChannelMessage: (([String: Any]) -> Void)?
    var onFriendUpdate: (() -> Void)?

    func connect() {
        guard !isConnected else { return }
        guard let cookie = SessionStore.shared.cookie() else { return }

        // Socket.IO raw engine.io websocket url
        guard let url = URL(string: "wss://api.vrot.fun/socket.io/?EIO=4&transport=websocket") else { return }
        var request = URLRequest(url: url)
        request.setValue("https://vrot.fun", forHTTPHeaderField: "Origin")
        request.setValue("VrotApp-iOS/1.0", forHTTPHeaderField: "User-Agent")
        request.setValue(cookie, forHTTPHeaderField: "Cookie")

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: OperationQueue())
        webSocketTask = session.webSocketTask(with: request)
        webSocketTask?.resume()
        isConnected = true

        receiveMessage()
        startPingTimer()
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        isConnected = false
    }

    private func startPingTimer() {
        pingTimer?.invalidate()
        pingTimer = Timer.scheduledTimer(withTimeInterval: 25.0, repeats: true) { [weak self] _ in
            self?.webSocketTask?.sendPing { error in
                if let error = error {
                    print("WebSocket ping failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func receiveMessage() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleIncomingText(text)
                case .data(let data):
                    if let str = String(data: data, encoding: .utf8) {
                        self?.handleIncomingText(str)
                    }
                @unknown default: break
                }
                self?.receiveMessage()
            case .failure(let error):
                print("WebSocket error: \(error.localizedDescription)")
                self?.isConnected = false
            }
        }
    }

    private func handleIncomingText(_ text: String) {
        // Engine.IO Open handshake packet: 0{"sid":...} -> send Socket.IO CONNECT (40)
        if text.hasPrefix("0") {
            webSocketTask?.send(.string("40")) { error in
                if let error = error {
                    print("Failed to send socket.io connect packet: \(error.localizedDescription)")
                }
            }
            return
        }

        // Engine.IO Ping (2) -> respond with Pong (3)
        if text == "2" {
            webSocketTask?.send(.string("3")) { _ in }
            return
        }

        // Socket.IO event packet: 42["event", data]
        if text.hasPrefix("42") {
            let jsonString = String(text.dropFirst(2))
            guard let data = jsonString.data(using: .utf8),
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
                  let event = arr.first as? String else { return }

            let payload = arr.count > 1 ? (arr[1] as? [String: Any] ?? [:]) : [:]

            DispatchQueue.main.async { [weak self] in
                switch event {
                case "call:incoming":
                    let fromObj = payload["from"] as? [String: Any] ?? [:]
                    let friendId = fromObj["id"] as? String ?? (payload["friendId"] as? String ?? "")
                    let name = fromObj["displayName"] as? String ?? (fromObj["username"] as? String ?? (payload["username"] as? String ?? "Собеседник"))
                    let isVideo = payload["video"] as? Bool ?? false
                    let callId = payload["callId"] as? String ?? ""
                    let expiresAt = (payload["expiresAt"] as? NSNumber)?.doubleValue ?? 0
                    guard !callId.isEmpty else { break }
                    CallManager.shared.reportIncomingCall(friendId: friendId, callerName: name, avatarUrl: fromObj["avatarUrl"] as? String, isVideo: isVideo, callId: callId, expiresAt: expiresAt)

                case "call:peer-joined":
                    CallManager.shared.cancelTimeout()
                    CallManager.shared.state.status = "Подключение медиа…"

                case "call:ended":
                    let callId = payload["callId"] as? String ?? ""
                    let reason = payload["reason"] as? String ?? ""
                    let calleeId = payload["calleeId"] as? String ?? ""
                    let state = CallManager.shared.state
                    if reason != "answered" && state.active && (state.callId == callId || (!state.incoming && state.targetId == calleeId)) {
                        CallManager.shared.state.status = reason == "timeout" ? "Время ожидания истекло" : "Вызов завершён"
                        CallManager.shared.endCall()
                    }

                case "call:peer-left", "call:cancelled":
                    CallManager.shared.state.status = "Собеседник завершил вызов"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        CallManager.shared.endCall()
                    }

                case "dm:new":
                    self?.onDirectMessage?(payload)
                    let author = (payload["author"] as? [String: Any])?["displayName"] as? String ?? "Новое сообщение"
                    let body = payload["content"] as? String ?? ""
                    CallManager.shared.sendLocalNotification(title: author, body: body)

                case "message:new":
                    self?.onChannelMessage?(payload)

                case "friend:updated":
                    self?.onFriendUpdate?()

                default: break
                }
            }
        }
    }

    func sendCallInvite(friendId: String, video: Bool) {
        let packet = "42[\"call:invite\",{\"friendId\":\"\(friendId)\",\"video\":\(video)}]"
        webSocketTask?.send(.string(packet)) { error in
            if let error = error {
                print("Failed to send call invite packet: \(error.localizedDescription)")
            }
        }
    }

    func sendCallJoin(friendId: String) {
        let packet = "42[\"call:join\",{\"kind\":\"friend\",\"id\":\"\(friendId)\"}]"
        webSocketTask?.send(.string(packet)) { error in
            if let error = error {
                print("Failed to send call join packet: \(error.localizedDescription)")
            }
        }
    }

    func sendCallResponse(callId: String, accept: Bool) {
        let packet = "42[\"call:respond\",{\"callId\":\"\(callId)\",\"accept\":\(accept)}]"
        webSocketTask?.send(.string(packet)) { error in
            if let error = error { print("Failed to respond to call: \(error.localizedDescription)") }
        }
    }

    func sendCallLeave() {
        let packet = "42[\"call:leave\"]"
        webSocketTask?.send(.string(packet)) { error in
            if let error = error {
                print("Failed to send call leave packet: \(error.localizedDescription)")
            }
        }
    }

    func sendCallCancel(friendId: String) {
        let packet = "42[\"call:cancel\",{\"friendId\":\"\(friendId)\"}]"
        webSocketTask?.send(.string(packet)) { error in
            if let error = error {
                print("Failed to send call cancel packet: \(error.localizedDescription)")
            }
        }
    }
}
