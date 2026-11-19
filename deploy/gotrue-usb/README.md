# GoTrue USB test build

This overlay applies to GoTrue v2.197.0. It provides a temporary GitHub sign-in for the owner's private iOS USB build. `prepare.sh <new-directory>` fetches the pinned upstream commit, applies the integration patch and copies the native callback and its tests. Build the resulting directory with the upstream Dockerfile. The production Compose file continues to select the stock image.

The switch is `GOTRUE_IOS_USB_OWNER_ID`. Its default is empty. A canonical existing GoTrue user UUID enables the exception for that user’s already-linked GitHub identity. Keep the native scheme outside `GOTRUE_URI_ALLOW_LIST`. A successful native response contains only the saved app state and the code. GoTrue verifies its own provider state, and the app verifies its state in the pending system authentication session. Native code redemption requires the original verifier and the configured owner. Disabling the switch also blocks pending exchanges. Sessions already issued use ordinary revocation.

HezSec reviews the implementation. Production enablement is a separate HezOps operation requiring the owner’s yes. Back up the current image reference and auth environment before any authorized USB test. Restore them at the end and verify the browser login and refusal of the native flow. Distribution uses a claimed HTTPS callback.

## Supervised Google USB attempt

The Google switch is independently disabled by default. The reviewed native base is `commonswarm://auth/callback`. Keep both native schemes outside the shared URI allowlist. Google continues to use the existing web client, its server-side secret and its HTTPS GoTrue callback. The Google branch adds the OpenID scope, verifies the signed ID token through the pinned issuer and web client audience, then looks up an already-linked Google subject on the configured, confirmed owner. It never creates or links an account.

1. After security review and separate production approval, HezOps backs up the existing auth configuration, image and database before the schema change. Use the matching patched image and set only `GOTRUE_IOS_GOOGLE_USB_OWNER_ID` for this window. Leave the GitHub switch off. Check ordinary web Google sign-in.
2. On the paired, unlocked owner phone with the approved USB build, tap **Continue with Google** once to prepare. The verifier stays in memory. Collect only the binding digest from the signed app’s data container over the trusted USB connection:

   ```sh
   xcrun devicectl device copy from --device "$device_udid" \
     --domain-type appDataContainer --domain-identifier com.commonswarm.ios \
     --source Library/Caches/google-usb-attempt.sha256 --destination "$digest_file"
   ```

3. HezOps runs the included arm SQL through a trusted operator connection with psql variables `owner_id` (the configured owner UUID) and `binding` (the exact digest read from USB). The script requires an existing linked Google identity and refuses to replace a live attempt. The tag is the lowercase SHA-256 of the UTF-8 prefix `commonswarm-google-usb-v1`, LF, the app’s base64url S256 challenge, LF, and the lowercase hex state. Use a fresh attempt if it expires. Do not accept a digest supplied via a URL, chat or email.
4. Within five minutes of preparing, tap **Continue with Google** again. Only one authorize request can claim the binding. A separate random GoTrue state tracks the upstream Google login. The native success returns only the code and the saved app state. Redemption rechecks the verifier, owner, switch, deadline and claim inside the flow lock.
5. Disable by clearing the Google owner setting on the patched image and deleting the owner’s approval row. Check that pending callbacks and exchanges fail, and ordinary web Google sign-in still works. Keep the guard in place until all native flow records are expired or have been removed under the approved rollback procedure before returning to stock. Browser and proxy logging must omit request queries, Location headers and auth bodies. An issued session follows the normal revocation policy.
