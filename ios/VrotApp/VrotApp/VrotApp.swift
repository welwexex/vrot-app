import SwiftUI

@main
struct VrotApp: App {
    @StateObject private var callKit = CallKitManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .preferredColorScheme(.dark)
                .edgesIgnoringSafeArea(.all)
        }
    }
}

struct ContentView: View {
    @StateObject private var callKit = CallKitManager.shared

    var body: some View {
        ZStack {
            Color(red: 30/255, green: 31/255, blue: 34/255)
                .edgesIgnoringSafeArea(.all)

            WebContainerView(url: URL(string: "https://vrot.fun")!)
                .edgesIgnoringSafeArea(.all)
        }
    }
}
