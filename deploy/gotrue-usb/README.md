# GoTrue USB test build

This overlay applies to GoTrue v2.197.0. It provides a temporary GitHub sign-in for the owner's private iOS USB build. `prepare.sh <new-directory>` fetches the pinned upstream commit, applies the integration patch and copies the native callback and its tests. Build the resulting directory with the upstream Dockerfile. The production Compose file continues to select the stock image.

The switch is `GOTRUE_IOS_USB_OWNER_ID`. Its default is empty. A canonical existing GoTrue user UUID enables the exception for that user’s already-linked GitHub identity. Keep the native scheme outside `GOTRUE_URI_ALLOW_LIST`. A successful native response contains only the saved app state and the code. GoTrue verifies its own provider state, and the app verifies its state in the pending system authentication session. Native code redemption requires the original verifier and the configured owner. Disabling the switch also blocks pending exchanges. Sessions already issued use ordinary revocation.

HezSec reviews the implementation. Production enablement is a separate HezOps operation requiring the owner’s yes. Back up the current image reference and auth environment before any authorized USB test. Restore them at the end and verify the browser login and refusal of the native flow. Distribution uses a claimed HTTPS callback.
