import SwiftUI

struct ActiveCallOverlay: View {
    @ObservedObject var callManager = CallManager.shared

    var body: some View {
        ZStack {
            Theme.darkBg.ignoresSafeArea()

            VStack(spacing: 30) {
                Spacer()

                Circle()
                    .fill(Theme.accent.opacity(0.3))
                    .frame(width: 120, height: 120)
                    .overlay(
                        Image(systemName: callManager.state.isVideo ? "video.fill" : "person.fill")
                            .font(.system(size: 50))
                            .foregroundColor(.white)
                    )

                VStack(spacing: 8) {
                    Text(callManager.state.targetName.isEmpty ? "Собеседник" : callManager.state.targetName)
                        .font(.system(size: 26, weight: .bold))
                        .foregroundColor(.white)

                    Text(callManager.state.status)
                        .font(.system(size: 16))
                        .foregroundColor(Theme.textSecondary)
                }

                Spacer()

                HStack(spacing: 40) {
                    Button(action: {
                        callManager.state.isMuted.toggle()
                    }) {
                        Image(systemName: callManager.state.isMuted ? "mic.slash.fill" : "mic.fill")
                            .font(.system(size: 24))
                            .foregroundColor(.white)
                            .frame(width: 64, height: 64)
                            .background(Theme.card)
                            .clipShape(Circle())
                    }

                    Button(action: {
                        callManager.endCall()
                    }) {
                        Image(systemName: "phone.down.fill")
                            .font(.system(size: 28))
                            .foregroundColor(.white)
                            .frame(width: 72, height: 72)
                            .background(Theme.red)
                            .clipShape(Circle())
                    }
                }
                .padding(.bottom, 50)
            }
        }
    }
}
