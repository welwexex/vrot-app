import SwiftUI

struct Theme {
    static var isLight: Bool { UserDefaults.standard.string(forKey: "vrot_theme") == "light" }
    static var darkBg: Color { isLight ? Color(red: 239/255, green: 242/255, blue: 248/255) : Color(red: 15/255, green: 18/255, blue: 28/255) }
    static var surface: Color { isLight ? .white : Color(red: 24/255, green: 28/255, blue: 42/255) }
    static var card: Color { isLight ? Color(red: 248/255, green: 249/255, blue: 253/255) : Color(red: 34/255, green: 39/255, blue: 56/255) }
    static let accent = Color(red: 88/255, green: 101/255, blue: 242/255)
    static var textPrimary: Color { isLight ? Color(red: 31/255, green: 36/255, blue: 49/255) : Color(red: 227/255, green: 229/255, blue: 232/255) }
    static var textSecondary: Color { isLight ? Color(red: 88/255, green: 97/255, blue: 115/255) : Color(red: 154/255, green: 164/255, blue: 178/255) }
    static let red = Color(red: 237/255, green: 66/255, blue: 69/255)
    static let green = Color(red: 87/255, green: 242/255, blue: 135/255)
    static var glassBg: Color { isLight ? Color.white.opacity(0.75) : Color.white.opacity(0.08) }
    static var glassBorder: Color { isLight ? Color.black.opacity(0.1) : Color.white.opacity(0.18) }
    static var glassCard: Color { isLight ? Color.white.opacity(0.85) : Color(red: 28/255, green: 34/255, blue: 52/255).opacity(0.65) }
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
    @State private var mode = "login" // "login" or "register"
    @State private var email = ""
    @State private var password = ""
    @State private var username = ""
    @State private var selectedBirthDate = Calendar.current.date(byAdding: .year, value: -18, to: Date()) ?? Date()
    @State private var legalAccepted = false
    @State private var errorMessage = ""
    @State private var isLoading = false

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

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            ScrollView {
                VStack(spacing: 20) {
                    Spacer(minLength: 40)

                    // Logo & Slogan
                    VStack(spacing: 8) {
                        Text("VROT")
                            .font(.system(size: 36, weight: .black, design: .rounded))
                            .foregroundColor(Theme.accent)
                        Text("Своё место для своих.")
                            .font(.system(size: 14))
                            .foregroundColor(Theme.textSecondary)
                    }

                    // Card Container
                    VStack(spacing: 16) {
                        // Picker Tab
                        HStack(spacing: 0) {
                            Button(action: { mode = "login"; errorMessage = "" }) {
                                Text("Вход")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(mode == "login" ? .white : Theme.textSecondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(mode == "login" ? Theme.accent : Color.clear)
                                    .cornerRadius(8)
                            }
                            Button(action: { mode = "register"; errorMessage = "" }) {
                                Text("Регистрация")
                                    .font(.system(size: 14, weight: .semibold))
                                    .foregroundColor(mode == "register" ? .white : Theme.textSecondary)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .background(mode == "register" ? Theme.accent : Color.clear)
                                    .cornerRadius(8)
                            }
                        }
                        .padding(4)
                        .background(Theme.card)
                        .cornerRadius(12)

                        // Title
                        Text(mode == "login" ? "С возвращением" : "Создать аккаунт")
                            .font(.system(size: 20, weight: .bold))
                            .foregroundColor(Theme.textPrimary)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if !errorMessage.isEmpty {
                            Text(errorMessage)
                                .font(.system(size: 13))
                                .foregroundColor(Theme.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if mode == "register" {
                            CustomTextField(placeholder: "Имя пользователя", text: $username)
                            CustomTextField(placeholder: "Email", text: $email)
                                .keyboardType(.emailAddress)
                                .autocapitalization(.none)
                        } else {
                            CustomTextField(placeholder: "Email или имя пользователя", text: $email)
                                .autocapitalization(.none)
                        }

                        CustomSecureField(placeholder: "Пароль", text: $password)

                        if mode == "register" {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Дата рождения")
                                    .font(.system(size: 13, weight: .medium))
                                    .foregroundColor(Theme.textSecondary)

                                HStack {
                                    DatePicker(
                                        "",
                                        selection: $selectedBirthDate,
                                        in: ...maxBirthDate,
                                        displayedComponents: .date
                                    )
                                    .datePickerStyle(.compact)
                                    .labelsHidden()
                                    .colorScheme(.dark)

                                    Spacer()

                                    Text(birthDateFormatted)
                                        .font(.system(size: 14, weight: .semibold))
                                        .foregroundColor(Theme.textPrimary)
                                }
                                .padding(.horizontal, 14)
                                .padding(.vertical, 8)
                                .background(Theme.card)
                                .cornerRadius(10)
                            }

                            Toggle(isOn: $legalAccepted) {
                                Text("Мне не менее 18 лет, принимаю правила")
                                    .font(.system(size: 12))
                                    .foregroundColor(Theme.textSecondary)
                            }
                            .toggleStyle(SwitchToggleStyle(tint: Theme.accent))
                        }

                        // Submit Button
                        Button(action: performAuth) {
                            HStack {
                                Spacer()
                                if isLoading {
                                    ProgressView()
                                        .progressViewStyle(CircularProgressViewStyle(tint: .white))
                                } else {
                                    Text(mode == "login" ? "Войти" : "Зарегистрироваться")
                                        .font(.system(size: 16, weight: .bold))
                                        .foregroundColor(Theme.textPrimary)
                                }
                                Spacer()
                            }
                            .frame(height: 48)
                            .contentShape(Rectangle())
                        }
                        .background(Theme.accent)
                        .cornerRadius(12)
                        .buttonStyle(.plain)
                        .disabled(isLoading)
                    }
                    .padding(24)
                    .background(Theme.surface)
                    .cornerRadius(20)
                    .padding(.horizontal, 20)
                }
            }
        }
    }

    private func performAuth() {
        isLoading = true
        errorMessage = ""

        Task {
            do {
                if mode == "login" {
                    let body: [String: Any] = [
                        "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                        "password": password
                    ]
                    _ = try await ApiService.shared.post(path: "/api/auth/login", body: body)
                } else {
                    let body: [String: Any] = [
                        "username": username.trimmingCharacters(in: .whitespacesAndNewlines),
                        "email": email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
                        "password": password,
                        "birthDate": birthDateFormatted,
                        "legalAccepted": legalAccepted
                    ]
                    _ = try await ApiService.shared.post(path: "/api/auth/register", body: body)
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
