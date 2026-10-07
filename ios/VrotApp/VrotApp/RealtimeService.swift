import Foundation

final class RealtimeService: NSObject, URLSessionWebSocketDelegate {
    static let shared = RealtimeService()

    private var webSocketTask: URLSessionWebSocketTask?
    private var isConnected = false
    private var isReady = false
    private var pingTimer: Timer?
    private var pendingPackets: [String] = []
    private var nextAckId = 1
    private var joinCallbacks: [Int: ([String: Any]) -> Void] = [:]

    var onDirectMessage: (([String: Any]) -> Void)?
    var onChannelMessage: (([String: Any]) -> Void)?
    var onDirectMessageReaction: (([String: Any]) -> Void)?
    var onChannelMessageReaction: (([String: Any]) -> Void)?
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
        isReady = false

        receiveMessage()
        startPingTimer()
    }

    func disconnect() {
        pingTimer?.invalidate()
        pingTimer = nil
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
        webSocketTask = nil
        isConnected = false
        isReady = false
        pendingPackets.removeAll()
        joinCallbacks.removeAll()
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
                self?.isReady = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                    guard SessionStore.shared.cookie() != nil else { return }
                    self?.connect()
                }
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

        if text.hasPrefix("40") {
            isReady = true
            for packet in pendingPackets { webSocketTask?.send(.string(packet)) { _ in } }
            pendingPackets.removeAll()
            return
        }

        if text.hasPrefix("43") {
            let suffix = text.dropFirst(2)
            let digits = String(suffix.prefix(while: { $0.isNumber }))
            guard let ackId = Int(digits), let start = suffix.firstIndex(of: "[") else { return }
            let json = String(suffix[start...])
            guard let data = json.data(using: .utf8),
                  let values = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]],
                  let response = values.first else { return }
            DispatchQueue.main.async { [weak self] in
                self?.joinCallbacks.removeValue(forKey: ackId)?(response)
            }
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
                    CallManager.shared.state.answered = true
                    CallManager.shared.state.status = "Подключение медиа…"
                    if let userObj = payload["user"] as? [String: Any],
                       let socketId = payload["socketId"] as? String {
                        NativeCallMedia.shared.peerJoined(socketId: socketId, user: userObj)
                    }

                case "call:signal":
                    CallManager.shared.cancelTimeout()
                    CallManager.shared.state.answered = true
                    NativeCallMedia.shared.receiveSignal(payload)

                case "call:answered":
                    CallManager.shared.cancelTimeout()
                    CallManager.shared.state.answered = true
                    CallManager.shared.state.status = "Подключение медиа…"

                case "call:ended":
                    let callId = payload["callId"] as? String ?? ""
                    let reason = payload["reason"] as? String ?? ""
                    let calleeId = payload["calleeId"] as? String ?? ""
                    let state = CallManager.shared.state
                    if reason == "answered" {
                        CallManager.shared.cancelTimeout()
                        CallManager.shared.state.answered = true
                        CallManager.shared.state.status = "Подключение медиа…"
                    } else if state.active && !state.answered && NativeCallMedia.shared.connectedPeers == 0 && (state.callId == callId || (!state.incoming && state.targetId == calleeId)) {
                        CallManager.shared.state.status = reason == "timeout" ? "Время ожидания истекло" : "Вызов завершён"
                        CallManager.shared.endCall()
                    }

                case "call:peer-left", "call:cancelled":
                    if let socketId = payload["socketId"] as? String { NativeCallMedia.shared.peerLeft(socketId) }
                    if CallManager.shared.state.kind == "friend" {
                        CallManager.shared.state.status = "Собеседник завершил вызов"
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                            CallManager.shared.endCall()
                        }
                    }

                case "dm:new":
                    self?.onDirectMessage?(payload)
                    let author = (payload["author"] as? [String: Any])?["displayName"] as? String ?? "Новое сообщение"
                    let body = payload["content"] as? String ?? ""
                    CallManager.shared.sendLocalNotification(title: author, body: body)

                case "dm:reaction":
                    self?.onDirectMessageReaction?(payload)

                case "message:new":
                    self?.onChannelMessage?(payload)

                case "message:reaction":
                    self?.onChannelMessageReaction?(payload)

                case "friend:updated":
                    self?.onFriendUpdate?()

                default: break
                }
            }
        }
    }

    func sendCallInvite(friendId: String, video: Bool) {
        sendEvent("call:invite", payload: ["friendId": friendId, "video": video])
    }

    func sendCallJoin(targetId: String, kind: String, completion: @escaping ([String: Any]) -> Void) {
        let ackId = nextAckId
        nextAckId += 1
        joinCallbacks[ackId] = completion
        sendEvent("call:join", payload: ["kind": kind, "id": targetId], ackId: ackId)
    }

    func sendCallResponse(callId: String, accept: Bool) {
        sendEvent("call:respond", payload: ["callId": callId, "accept": accept])
    }

    func sendCallLeave() {
        sendEvent("call:leave", payload: [:])
    }

    func sendCallCancel(friendId: String) {
        sendEvent("call:cancel", payload: ["friendId": friendId])
    }

    func sendEvent(_ name: String, payload: [String: Any], ackId: Int? = nil) {
        guard let data = try? JSONSerialization.data(withJSONObject: [name, payload]),
              let json = String(data: data, encoding: .utf8) else { return }
        let packet = "42\(ackId.map(String.init) ?? "")\(json)"
        if isReady { webSocketTask?.send(.string(packet)) { _ in } }
        else { pendingPackets.append(packet) }
    }
}
