import SwiftUI

struct Theme {
    static let darkBg = Color(red: 15/255, green: 18/255, blue: 28/255)
    static let surface = Color(red: 24/255, green: 28/255, blue: 42/255)
    static let card = Color(red: 34/255, green: 39/255, blue: 56/255)
    static let accent = Color(red: 88/255, green: 101/255, blue: 242/255)
    static let textPrimary = Color(red: 227/255, green: 229/255, blue: 232/255)
    static let textSecondary = Color(red: 154/255, green: 164/255, blue: 178/255)
    static let red = Color(red: 237/255, green: 66/255, blue: 69/255)
    static let green = Color(red: 87/255, green: 242/255, blue: 135/255)
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
                        Text("VROT.FUN")
                            .font(.system(size: 32, weight: .black, design: .rounded))
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
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        if !errorMessage.isEmpty {
                            Text(errorMessage)
                                .font(.system(size: 13))
                                .foregroundColor(Theme.red)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if mode == "register" {
                            CustomTextField(placeholder: "Имя пользователя", text: $username)
                        }

                        CustomTextField(placeholder: "Email", text: $email)
                            .keyboardType(.emailAddress)
                            .autocapitalization(.none)

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
                            if isLoading {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            } else {
                                Text(mode == "login" ? "Войти" : "Зарегистрироваться")
                                    .font(.system(size: 16, weight: .bold))
                                    .foregroundColor(.white)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .frame(height: 48)
                        .background(Theme.accent)
                        .cornerRadius(12)
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
                .foregroundColor(.white)
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
                .foregroundColor(.white)
                .autocapitalization(.none)
                .disableAutocorrection(true)
        }
        .background(Theme.card)
        .cornerRadius(10)
    }
}
