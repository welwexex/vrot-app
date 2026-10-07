import Foundation
import Security

final class SessionStore {
    static let shared = SessionStore()
    private let key = "vrot_session_cookie"
    private var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "fun.vrot.ios",
         kSecAttrAccount as String: key]
    }

    func save(cookie: String) {
        SecItemDelete(query as CFDictionary)
        var attributes = query
        attributes[kSecValueData as String] = Data(cookie.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecSuccess { UserDefaults.standard.removeObject(forKey: key) }
    }

    func cookie() -> String? {
        var lookup = query
        lookup[kSecReturnData as String] = true
        lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        if SecItemCopyMatching(lookup as CFDictionary, &result) == errSecSuccess,
           let data = result as? Data,
           let saved = String(data: data, encoding: .utf8) { return saved }
        if let saved = UserDefaults.standard.string(forKey: key), !saved.isEmpty {
            save(cookie: saved)
            return saved
        }
        if let cookies = HTTPCookieStorage.shared.cookies {
            for c in cookies {
                if c.name == "vrot_session" {
                    let formatted = "\(c.name)=\(c.value)"
                    save(cookie: formatted)
                    return formatted
                }
            }
        }
        return nil
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
        UserDefaults.standard.removeObject(forKey: key)
        if let cookies = HTTPCookieStorage.shared.cookies {
            for c in cookies {
                if c.name == "vrot_session" {
                    HTTPCookieStorage.shared.deleteCookie(c)
                }
            }
        }
    }
}

enum APIError: LocalizedError {
    case invalidURL
    case serverError(Int, String)
    case decodingError

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Неверный URL сервера"
        case .serverError(_, let msg): return msg
        case .decodingError: return "Ошибка обработки ответа сервера"
        }
    }
}

final class ApiService: NSObject {
    static let shared = ApiService()
    let baseURL = "https://api.vrot.fun"

    private var session: URLSession!

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 20
        config.timeoutIntervalForResource = 30
        self.session = URLSession(configuration: config)
    }

    func request(path: String, method: String = "GET", body: [String: Any]? = nil) async throws -> Any {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("https://vrot.fun", forHTTPHeaderField: "Origin")
        req.setValue("VrotApp-iOS/1.0", forHTTPHeaderField: "User-Agent")

        if let cookie = SessionStore.shared.cookie() {
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }

        if let body = body {
            req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.decodingError }

        // Update cookie if Set-Cookie header exists
        if let setCookie = http.allHeaderFields["Set-Cookie"] as? String {
            if let first = setCookie.components(separatedBy: ";").first, first.hasPrefix("vrot_session=") {
                SessionStore.shared.save(cookie: first)
            }
        } else if let fields = (response as? HTTPURLResponse)?.allHeaderFields as? [String: String],
                  let setCookie = fields["Set-Cookie"] {
            if let first = setCookie.components(separatedBy: ";").first, first.hasPrefix("vrot_session=") {
                SessionStore.shared.save(cookie: first)
            }
        } else if let url = req.url, let cookies = HTTPCookieStorage.shared.cookies(for: url) {
            for c in cookies where c.name == "vrot_session" {
                SessionStore.shared.save(cookie: "\(c.name)=\(c.value)")
            }
        }

        if http.statusCode < 200 || http.statusCode >= 300 {
            var errMsg = "Ошибка сервера (\(http.statusCode))"
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                if let err = obj["error"] as? String {
                    errMsg = err
                    if let fields = obj["fields"] as? [String: [String]], !fields.isEmpty {
                        let details = fields.compactMap { "\($0.key): \($0.value.joined(separator: ", "))" }.joined(separator: "; ")
                        errMsg += " (\(details))"
                    }
                } else if let msg = obj["message"] as? String {
                    errMsg = msg
                }
            }
            throw APIError.serverError(http.statusCode, errMsg)
        }

        if data.isEmpty { return [String: Any]() }
        return try JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    func get(path: String) async throws -> [String: Any] {
        return try await getObject(path: path)
    }

    func getObject(path: String) async throws -> [String: Any] {
        return (try await request(path: path, method: "GET")) as? [String: Any] ?? [:]
    }

    func getArray(path: String) async throws -> [[String: Any]] {
        return (try await request(path: path, method: "GET")) as? [[String: Any]] ?? []
    }

    func post(path: String, body: [String: Any]) async throws -> [String: Any] {
        return (try await request(path: path, method: "POST", body: body)) as? [String: Any] ?? [:]
    }

    func put(path: String, body: [String: Any]) async throws -> [String: Any] {
        return (try await request(path: path, method: "PUT", body: body)) as? [String: Any] ?? [:]
    }

    func delete(path: String) async throws -> [String: Any] {
        return (try await request(path: path, method: "DELETE")) as? [String: Any] ?? [:]
    }

    func uploadBinary(path: String, data: Data, mimeType: String, fileName: String) async throws -> [String: Any] {
        guard let url = URL(string: baseURL + path) else { throw APIError.invalidURL }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("https://vrot.fun", forHTTPHeaderField: "Origin")
        req.setValue("VrotApp-iOS/1.0", forHTTPHeaderField: "User-Agent")
        req.setValue(mimeType, forHTTPHeaderField: "Content-Type")
        req.setValue(fileName.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? fileName, forHTTPHeaderField: "X-File-Name")
        if let cookie = SessionStore.shared.cookie() {
            req.setValue(cookie, forHTTPHeaderField: "Cookie")
        }
        req.httpBody = data

        let (respData, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else { throw APIError.decodingError }
        if http.statusCode < 200 || http.statusCode >= 300 {
            throw APIError.serverError(http.statusCode, "Ошибка загрузки файла")
        }
        return (try? JSONSerialization.jsonObject(with: respData) as? [String: Any]) ?? [:]
    }

    static func resolveMediaURL(_ raw: String?) -> URL? {
        guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        if raw.hasPrefix("http://") || raw.hasPrefix("https://") {
            return URL(string: raw)
        }
        let clean = raw.hasPrefix("/") ? raw : "/" + raw
        return URL(string: ApiService.shared.baseURL + clean)
    }
}
