# VROT iOS

Native SwiftUI project: `VrotApp/VrotApp.xcodeproj`. Open with Xcode 26 on macOS.

Implemented in source: account/session access, friends, communities, direct messages, avatar and media display, image/video/file attachments, voice messages, profile editing, dark/light preference, partial Russian/English interface, CallKit UI, PushKit registration, APNs device registration, and a 15-second unanswered-call timeout. On iOS 26 the bottom navigation uses Apple's native Liquid Glass; older iOS uses system material.

Important release blockers:

- **Audio/video calls are not yet functional on iOS.** The current camera view is local preview only; no native WebRTC media transport or remote video rendering is connected. CallKit alone does not carry media. Do not distribute this build as a working calling app.
- Screen sharing is not implemented in the iOS client. It needs ScreenCaptureKit capture connected to the native WebRTC video sender and on-device testing.
- PushKit/locked-screen incoming calls need an Apple Developer Team, Push Notifications entitlement, a VoIP-capable provisioning profile, and an APNs `.p8` key. Configure server `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=fun.vrot.ios`, and either `APNS_KEY_BASE64` or `APNS_KEY_PATH` (mounted inside the app container). Use `APNS_ENV=sandbox` for development; production otherwise.
- `IOS_VOIP_ENABLED` defaults to false. Do not enable it until native media works and two-device call tests pass; a CallKit screen without audio/video is not a working call.
- A signed, installable IPA requires Apple signing credentials and Xcode. The GitHub workflow builds an **unsigned, non-installable** artifact for compile verification only.
- Russian and English preference is present, but many legacy screens still have Russian-only copy; full localization remains to be completed.

Test on two physical iPhones before release: registration/login, APNs alert/VoIP delivery while locked, decline/answer/15-second expiry, reconnect, message and attachment transfer, audio/video media, screen sharing, and logout token removal.
