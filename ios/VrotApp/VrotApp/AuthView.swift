import SwiftUI

struct Theme {
    static var isLight: Bool { UserDefaults.standard.string(forKey: "vrot_theme") == "light" }
    static var darkBg: Color { isLight ? Color(red: 244/255, green: 245/255, blue: 251/255) : Color(red: 7/255, green: 9/255, blue: 17/255) }
    static var surface: Color { isLight ? .white : Color(red: 15/255, green: 19/255, blue: 32/255) }
    static var card: Color { isLight ? Color(red: 250/255, green: 250/255, blue: 254/255) : Color(red: 24/255, green: 29/255, blue: 45/255) }
    static let accent = Color(red: 40/255, green: 188/255, blue: 147/255)
    static var textPrimary: Color { isLight ? Color(red: 24/255, green: 27/255, blue: 39/255) : Color(red: 247/255, green: 248/255, blue: 255/255) }
    static var textSecondary: Color { isLight ? Color(red: 83/255, green: 91/255, blue: 112/255) : Color(red: 155/255, green: 165/255, blue: 188/255) }
    static let red = Color(red: 1, green: 101/255, blue: 125/255)
    static let green = Color(red: 92/255, green: 226/255, blue: 194/255)
    static var glassBg: Color { isLight ? Color.white.opacity(0.75) : Color.white.opacity(0.08) }
    static var glassBorder: Color { isLight ? Color.black.opacity(0.1) : Color.white.opacity(0.18) }
    static var glassCard: Color { isLight ? Color.white.opacity(0.86) : Color(red: 18/255, green: 23/255, blue: 38/255).opacity(0.72) }
}

func L(_ ru: String) -> String {
    guard UserDefaults.standard.string(forKey: "vrot_language") == "en" else { return ru }
    let translations: [String: String] = [
        "Чаты": "Chats", "Сообщества": "Communities", "Профиль": "Profile", "Друзья": "Friends",
        "Добавить": "Add", "В сети": "Online", "Не в сети": "Offline", "Ожидание": "Pending",
        "Настройки профиля": "Profile settings", "Оформление": "Appearance", "Тема": "Theme", "Язык": "Language",
        "Тёмная": "Dark", "Светлая": "Light", "Русский": "Russian", "Английский": "English",
        "Выйти из аккаунта": "Log out", "Входящий вызов…": "Incoming call…", "Время ожидания истекло": "Call timed out",
        "Подключение медиа…": "Connecting media…", "Вызов завершён": "Call ended"
    ]
    return translations[ru] ?? ru
}

struct AuthView: View {
    @Binding var isLoggedIn: Bool
    @State private var mode = "login"
    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var selectedBirthDate = Calendar.current.date(byAdding: .year, value: -18, to: Date()) ?? Date()
    @State private var legalAccepted = false
    @State private var errorMessage = ""
    @State private var isLoading = false
    @State private var twoFaTempToken = ""
    @State private var twoFaCode = ""
    @State private var challengeUserId = ""
    @State private var emailChallenge = ""
    @State private var registrationChallenge = ""

    private var maxBirthDate: Date {
        Calendar.current.date(byAdding: .year, value: -18, to: Date()) ?? Date()
    }

    private var birthDateFormatted: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: selectedBirthDate)
    }

    @State private var showForm = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()
            Circle().fill(Theme.accent.opacity(0.12)).frame(width: 320, height: 320).blur(radius: 80).offset(y: -200)
            if !showForm {
                VStack(spacing: 24) {
                    Spacer()
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 70, weight: .light)).foregroundStyle(Theme.accent)
                        .frame(width: 156, height: 156).liquidGlass(cornerRadius: 48)
                    Text("ВРОТ").font(.system(size: 48, weight: .black, design: .rounded))
                    Text("Ваши люди. Ваши разговоры.").font(.title3).foregroundStyle(Theme.textSecondary)
                    Spacer()
                    Button { mode = "login"; showForm = true } label: {
                        Text("Войти").font(.headline).frame(maxWidth: .infinity).padding(18)
                    }.buttonStyle(.plain).background(Theme.accent, in: Capsule()).foregroundStyle(.white)
                    Button { mode = "register"; showForm = true } label: {
                        Text("Создать аккаунт").font(.headline).frame(maxWidth: .infinity).padding(18)
                    }.buttonStyle(.plain).liquidGlass(cornerRadius: 30)
                }.padding(28)
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        Button { showForm = false; mode = "login"; errorMessage = "" } label: {
                            Label("Назад", systemImage: "chevron.left")
                        }.padding(.bottom, 16)
                        Text(mode == "login" ? "С возвращением" : mode == "register" ? "Создать аккаунт" : "Подтвердите вход")
                            .font(.system(size: 32, weight: .bold, design: .rounded))
                        Text(mode == "register" ? "Начните с адреса почты. Мы проверим его кодом перед созданием аккаунта." : "Добро пожаловать в Врот.")
                            .foregroundStyle(Theme.textSecondary)
                        if mode == "2fa" || mode == "email-code" || mode == "register-code" {
                            Text(mode == "2fa" ? "Код из Google Authenticator, Apple Passwords или Aegis. Можно использовать резервный код." : "Введите код из письма. Он действует 10 минут.")
                                .foregroundStyle(Theme.textSecondary)
                            TextField("Код подтверждения", text: $twoFaCode)
                                .textContentType(.oneTimeCode).textInputAutocapitalization(.never)
                                .autocorrectionDisabled().padding(18).background(Theme.card, in: RoundedRectangle(cornerRadius: 18))
                        } else {
                            if mode == "register" { CustomTextField(placeholder: "Имя пользователя", text: $username) }
                            CustomTextField(placeholder: mode == "login" ? "Email или имя пользователя" : "Email", text: $email)
                                .textContentType(.username)
                            CustomSecureField(placeholder: "Пароль", text: $password)
                                .textContentType(mode == "register" ? .newPassword : .password)
                            if mode == "register" {
                                DatePicker("Дата рождения", selection: $selectedBirthDate, in: ...maxBirthDate, displayedComponents: .date)
                                Toggle("Мне не менее 18 лет, принимаю правила VROT", isOn: $legalAccepted).tint(Theme.accent)
                                Link("Правила и конфиденциальность", destination: URL(string: "https://vrot.fun")!)
                            }
                        }
                        if !errorMessage.isEmpty { Text(errorMessage).foregroundStyle(Theme.red).accessibilityAddTraits(.isStaticText) }
                        Button(action: performAuth) {
                            HStack {
                                Spacer()
                                if isLoading { ProgressView().tint(.white) }
                                else { Text(mode == "login" ? "Войти" : mode == "register" ? "Отправить код" : "Подтвердить").font(.headline) }
                                Spacer()
                            }.padding(18).contentShape(Rectangle())
                        }.buttonStyle(.plain).background(Theme.accent, in: Capsule()).foregroundStyle(.white)
                            .disabled(isLoading || (mode == "register" && !legalAccepted))
                        if mode == "login" {
                            Button("Создать аккаунт") { mode = "register"; errorMessage = "" }
                        } else {
                            Button("Вернуться ко входу") { mode = "login"; twoFaCode = ""; errorMessage = "" }
                        }
                    }.padding(28)
                }.scrollDismissesKeyboard(.interactively)
            }
        }.foregroundStyle(Theme.textPrimary)
            .animation(reduceMotion ? nil : .easeInOut(duration: 0.25), value: showForm)
    }

    private func performAuth() {
        isLoading = true
        errorMessage = ""

        Task { @MainActor in
            do {
                if mode == "2fa" {
                    let body: [String: Any] = [
                        "tempToken": twoFaTempToken,
                        "code": twoFaCode.trimmingCharacters(in: .whitespacesAndNewlines),
                        "userId": challengeUserId
                    ]
                    _ = try await ApiService.shared.post(path: "/api/auth/login/2fa", body: body)
                } else if mode == "email-code" || mode == "register-code" {
                    let body: [String: Any] = mode == "email-code"
                        ? ["loginChallenge": emailChallenge, "userId": challengeUserId, "code": twoFaCode]
                        : ["registrationChallenge": registrationChallenge, "code": twoFaCode]
                    let response = try await ApiService.shared.post(path: mode == "email-code" ? "/api/auth/login/email-code" : "/api/auth/register/confirm", body: body)
                    if await advanceChallenge(response) { return }
                    guard response["user"] != nil else { throw APIError.decodingError }
                } else if mode == "login" {
                    let body: [String: Any] = [
                        "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                        "password": password
                    ]
                    let resp = try await ApiService.shared.post(path: "/api/auth/login", body: body)
                    if await advanceChallenge(resp) { return }
                    if let req2fa = resp["requires2FA"] as? Bool, req2fa,
                       let token = resp["tempToken"] as? String {
                        await MainActor.run {
                            self.twoFaTempToken = token
                            self.mode = "2fa"
                            self.isLoading = false
                            self.twoFaCode = ""
                        }
                        return
                    }
                } else {
                    let body: [String: Any] = [
                        "username": username.trimmingCharacters(in: .whitespacesAndNewlines),
                        "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                        "password": password,
                        "birthDate": birthDateFormatted,
                        "legalAccepted": legalAccepted
                    ]
                    let response = try await ApiService.shared.post(path: "/api/auth/register", body: body)
                    if await advanceChallenge(response) { return }
                    guard response["user"] != nil else { throw APIError.decodingError }
                }

                await MainActor.run {
                    isLoading = false
                    isLoggedIn = true
                    RealtimeService.shared.connect()
                }
            } catch {
                await MainActor.run {
                    isLoading = false
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    @MainActor private func advanceChallenge(_ response: [String: Any]) -> Bool {
        if let token = response["registrationChallenge"] as? String {
            registrationChallenge = token; mode = "register-code"
        } else if let token = response["loginChallenge"] as? String {
            emailChallenge = token; challengeUserId = response["userId"] as? String ?? ""; mode = "email-code"
        } else if let token = response["tempToken"] as? String, response["requires2FA"] as? Bool == true {
            twoFaTempToken = token; challengeUserId = response["userId"] as? String ?? ""; mode = "2fa"
        } else { return false }
        twoFaCode = ""; isLoading = false
        return true
    }
}

struct CustomTextField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundColor(Theme.textSecondary)
                    .padding(.horizontal, 14)
            }
            TextField("", text: $text)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .foregroundColor(Theme.textPrimary)
                .autocapitalization(.none)
                .disableAutocorrection(true)
        }
        .background(Theme.card)
        .cornerRadius(10)
    }
}

struct CustomSecureField: View {
    let placeholder: String
    @Binding var text: String

    var body: some View {
        ZStack(alignment: .leading) {
            if text.isEmpty {
                Text(placeholder)
                    .foregroundColor(Theme.textSecondary)
                    .padding(.horizontal, 14)
            }
            SecureField("", text: $text)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .foregroundColor(Theme.textPrimary)
                .autocapitalization(.none)
                .disableAutocorrection(true)
        }
        .background(Theme.card)
        .cornerRadius(10)
    }
}
