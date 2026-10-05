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
        // Socket.IO EIO packet parser: 42["event", data]
        if text.hasPrefix("42") {
            let jsonString = String(text.dropFirst(2))
            guard let data = jsonString.data(using: .utf8),
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [Any],
                  let event = arr.first as? String else { return }

            let payload = arr.count > 1 ? (arr[1] as? [String: Any] ?? [:]) : [:]

            DispatchQueue.main.async { [weak self] in
                switch event {
                case "call:incoming":
                    let friendId = payload["friendId"] as? String ?? ""
                    let name = payload["callerName"] as? String ?? (payload["username"] as? String ?? "Собеседник")
                    let isVideo = payload["video"] as? Bool ?? false
                    CallManager.shared.reportIncomingCall(friendId: friendId, callerName: name, isVideo: isVideo)
                    CallManager.shared.sendLocalNotification(title: "Входящий вызов", body: "\(name) звонит вам в VROT")

                case "call:peer-left":
                    CallManager.shared.state.status = "Собеседник завершил вызов"
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
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
        } else if text == "2" {
            // Engine.IO Ping -> respond with Pong (3)
            webSocketTask?.send(.string("3")) { _ in }
        }
    }

    func sendCallInvite(friendId: String, video: Bool) {
        let packet = "42[\"call:invite\",{\"friendId\":\"\(friendId)\",\"video\":\(video)}]"
        webSocketTask?.send(.string(packet)) { _ in }
    }
}
