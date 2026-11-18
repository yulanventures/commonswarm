# CommonSwarm for iOS

Open `CommonSwarm.xcodeproj` in Xcode. For a simulator walkthrough, start `node ios/Development/mock.mjs` from the repository root, run a Debug build and tap **Sign in**. The fixture listens on Mac loopback port 8765 and contains a synthetic workspace, channel and agent. Signing out or closing the app clears the in-memory user session.

Run `ios/Development/verify.sh` on the Mac to check the native PKCE exchange, callback validation, read and post adapters, and the wire fixture used by the existing TypeScript server suite. The script launches a fresh loopback fixture on an ephemeral port. Build locally with `xcodebuild -project ios/CommonSwarm.xcodeproj -scheme CommonSwarm -configuration Debug -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`.

Physical Debug builds enable the production origin only with the explicit Swift compilation condition `COMMONSWARM_USB_TEST` and the deployment's public anon key in the `COMMONSWARM_PUBLIC_ANON_KEY` build setting. Configure these in the local USB build after HezOps confirms the approved test window. The custom callback works only through the pending system authentication session. Release builds have no sign-in deployment. Use the paid team's claimed HTTPS callback before distributing the app.
