# VROT iOS

Native SwiftUI project: `VrotApp/VrotApp.xcodeproj`. Open with Xcode 26 on macOS.

Implemented in source: account/session access, friends, communities, direct messages, avatar and media display, image/video/file attachments, voice messages, profile/community editing, dark/light preference, partial Russian/English interface, CallKit UI, PushKit registration, APNs device registration, and a 15-second unanswered-call timeout. The native system tab bar adopts Liquid Glass on iOS 26; older iOS uses its native material.

Native WebRTC audio/video now uses the existing Socket.IO call signaling and TURN configuration from `/api/calls/ice`. Incoming remote video is rendered in the call UI. ReplayKit can share the VROT app screen over the video track during a call. These paths compile on Xcode 26 but **have not yet been verified between two physical devices**.

Important release blockers:

- **Calling remains unverified on physical iPhones.** Test microphone routing, camera, remote audio/video, ICE/TURN, interruptions, and reconnection before describing the build as a working calling app.
- Screen sharing currently captures only the VROT app. Device-wide sharing/background capture requires a separate ScreenCaptureKit or broadcast-extension implementation and additional on-device testing.
- PushKit/locked-screen incoming calls need an Apple Developer Team, Push Notifications entitlement, a VoIP-capable provisioning profile, and an APNs `.p8` key. Configure server `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=fun.vrot.ios`, and either `APNS_KEY_BASE64` or `APNS_KEY_PATH` (mounted inside the app container). Use `APNS_ENV=sandbox` for development; production otherwise.
- `IOS_VOIP_ENABLED` defaults to false. Do not enable it until two-device media and locked-screen tests pass; a CallKit screen alone is not proof of a working call.
- A signed, installable IPA requires Apple signing credentials and Xcode. The GitHub workflow builds an **unsigned, non-installable** artifact for compile verification only.
- Russian and English preference is present, but many legacy screens still have Russian-only copy; full localization remains to be completed.

Test on two physical iPhones before release: registration/login, APNs alert/VoIP delivery while locked, decline/answer/15-second expiry, reconnect, message and attachment transfer, audio/video media, screen sharing, and logout token removal.
