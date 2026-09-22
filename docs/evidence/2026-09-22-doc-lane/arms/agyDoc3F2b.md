### Scope & Context

This review covers **PART F2b OF 5** of the `lane/doc-box-production` review at commit `aaa8a914ffb24fe364a88b46094d9da3014bad5d` (Round 3 fold).

The 12 files reviewed in this part are:
1. `deploy/edge-runtime/build-caddy-validation-fixture.mjs`
2. `deploy/edge-runtime/check-caddy-adapted.mjs`
3. `tests/p1-cli/edge-runtime-box.test.ts`
4. `src/cloud/capability-link.ts`
5. `src/cloud/invite-link.ts`
6. `tests/p1-cli/accept-link.test.ts`
7. `tests/p1-cli/citation-drift.test.ts`
8. `src/cloud/files.ts`
9. `site/public/api.md`
10. `site/public/llms.txt`
11. `site/src/components/auth/ProviderButtons.astro`
12. `supabase/functions/command/cors.ts`

---

### File-by-File Analysis

#### 1. Caddy Validation Fixture & Adapted Config Verification
- **`deploy/edge-runtime/build-caddy-validation-fixture.mjs`**:
  - Replaced the hardcoded copy of the deleted pre-cutover `commonswarm.caddy` with `resolve(process.argv[4] ?? join(sourceDirectory, "..", "supabase-stack", "commonswarm-api.caddy"))`.
  - Now defaults to the live box Caddyfile (`deploy/supabase-stack/commonswarm-api.caddy`), while allowing an optional 4th CLI argument (`site-caddy`) to target the maintenance config (`commonswarm-api-maintenance.caddy`).
  - Correctly copies the target file to `sites/10-commonswarm-api.caddy` for Caddy adaptation.
- **`deploy/edge-runtime/check-caddy-adapted.mjs`**:
  - Requires `<live|maintenance>` as the profile argument.
  - Recursively traverses all keys and string values in the adapted Caddy JSON (`collectStrings`) and asserts `supabase.co` does not appear anywhere.
  - For `live`: verifies all 5 expected local dials (`127.0.0.1:18001..18004` and `9000`), checks function proxy headers (`X-Forwarded-For: {http.request.client_ip}`, timeout 165s), Realtime HTTP/1.1 with `flush_interval: -1` and `Host: realtime-dev`, confirms zero CORS origin headers on success routes, and validates function error CORS handling across both `api.commonswarm.com` and `edge-staging.commonswarm.com`.
  - For `maintenance`: extracts `publicSite` (`api.commonswarm.com`) and `stagingSite` (`edge-staging.commonswarm.com`). Verifies `proxyDials(publicSite)` is empty (zero upstream proxies), while `stagingSite` preserves access to the local dials. Verifies `publicSite` static responses are strictly preflight 204 (OPTIONS) and 503 Service Unavailable with `Retry-After: 300`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`, and JSON error body `{"error":"maintenance","message":"writes are paused for database migration"}`.

#### 2. Edge Runtime & Box Tests
- **`tests/p1-cli/edge-runtime-box.test.ts`**:
  - Validates `deploy/supabase-stack/commonswarm-api.caddy` and `deploy/supabase-stack/commonswarm-api-maintenance.caddy` rather than deleted pre-cutover edge configs.
  - Tests that neither `live` nor `maintenance` contains any reference to `supabase.co`.
  - Retains all critical parity checks from prior rounds: edge functions matching, timeout 165s, error CORS headers, and Realtime HTTP/1.1 with `flush_interval -1`.
  - Adds direct assertions for local stack reverse proxies: `/auth/v1/*` (`18001`), `/rest/v1/*` (`18002`), `/storage/v1/*` (`18004`), and Realtime (`18003`).
  - Asserts that `publicSite` in the maintenance config has zero `reverse_proxy` and zero `import` directives, matches the 503 maintenance response with CORS, and that `edge-staging.commonswarm.com` imports `box_routes`.
  - Ensures neither `live` nor `maintenance` contains a global options block.

#### 3. Capability Links & Origin Pinning
- **`src/cloud/capability-link.ts`**:
  - `CAPABILITY_SITE_ORIGIN` now defaults to `"https://commonswarm.com"`.
  - Removed `"coswarm-site.vercel.app"` from `CAPABILITY_ALLOWED_HOSTS` (now only `"commonswarm.com"` and `"www.commonswarm.com"`).
  - Error messages updated to clarify that links may only point to a CommonSwarm site and explicitly note that opening `/see` on the site returns 404 (as the token is in the URL fragment).
- **`src/cloud/invite-link.ts`**:
  - `PRODUCTION_CLOUD_ORIGINS` now strictly contains only `"https://api.commonswarm.com"`.
  - The deleted Supabase origin `https://ukezjcnxjvkpkeezxaew.supabase.co` is defined as `RETIRED_CLOUD_ORIGIN`.
  - `requirePinnedOrigin()` explicitly checks `target.url === RETIRED_CLOUD_ORIGIN` before origin pin checks and immediately throws: `invite link targets retired host ${RETIRED_CLOUD_ORIGIN}. Ask for a new invite.`
- **`tests/p1-cli/accept-link.test.ts`**:
  - Verifies that `https://api.commonswarm.com` (including normalization of casing, trailing slash, and port 443) passes silently without prompt.
  - Uses `assert.rejects` to test that `https://ukezjcnxjvkpkeezxaew.supabase.co` is rejected in both non-interactive mode and interactive mode (even if the user attempts to retype the origin).

#### 4. Documentation, Public APIs & Web Assets
- **`site/public/api.md`**:
  - Removed references to `<ref>.supabase.co`. Clarifies that `<PROJECT_URL>` represents the service base URL (`https://api.commonswarm.com` for the hosted service, or a self-hosted deployment's own base URL).
- **`site/public/llms.txt`**:
  - Removed references to deleted Vercel host `coswarm-site.vercel.app` and Supabase host; all links (API reference, agent skill `SKILL.md`, Home, Start, Download, App) now point to `https://commonswarm.com`.
  - The `curl` command for installing the Claude Code skill now fetches from `https://commonswarm.com/skills/cswarm/SKILL.md`.
- **`site/src/components/auth/ProviderButtons.astro`**:
  - Comments updated to remove references to the Supabase dashboard; describes configuring GoTrue on the server followed by rebuild and running `deploy/site/deploy.sh`.
- **`src/cloud/files.ts`**:
  - Comment updated to remove references to `supabase.co` origin vs custom domain.
- **`supabase/functions/command/cors.ts`**:
  - Removed `"https://coswarm-site.vercel.app"` from `DEFAULT_COMMAND_ALLOWED_ORIGINS`, leaving only `"https://commonswarm.com"` and `"https://www.commonswarm.com"`.
- **`tests/p1-cli/citation-drift.test.ts`**:
  - Citations updated to reflect the +2 / +1 line number shifts in `src/cli.ts` from help text and string adjustments.

---

### Core Checks & Intent Verification

1. **Did any test lose its intent when moving to the live file?**
   - **No.** The previous checks in `edge-runtime-box.test.ts` ensured parity with Supabase upstream routing (functions timeout, error CORS, realtime WebSocket/HTTP 1.1). Those guarantees are preserved for the local container stack (`127.0.0.1:18001..18004`, `9000`), and new assertions guarantee that the dead Supabase domain is never referenced.
2. **Does the maintenance file still do what a maintenance pause needs?**
   - **Yes.** In maintenance mode, `api.commonswarm.com` terminates all traffic directly: OPTIONS preflight returns 204 with required CORS headers, and all request methods receive 503 Service Unavailable with `Retry-After: 300`, `Cache-Control: no-store`, `Access-Control-Allow-Origin: *`, and JSON body. It has no upstream reverse proxy, preventing traffic from leaking or failing against down services. Meanwhile, `edge-staging.commonswarm.com` continues to route to the box services for operator migrations.
3. **Does anything live still point at a deleted host?**
   - **No.** All live configs, default URLs, allowlists, and public documentation in these 12 files point to `commonswarm.com` or `api.commonswarm.com`. The deleted Supabase host is strictly intercepted and refused with an actionable message.

---

### Dependencies Outside This Part
The following dependencies cannot be checked directly within Part F2b and are deferred to their respective review parts:
- The exact Caddyfile contents on disk (`deploy/supabase-stack/commonswarm-api.caddy`, `deploy/supabase-stack/commonswarm-api-maintenance.caddy`, and `deploy/edge-runtime/caddy-global-servers.caddy`).
- The CLI implementation and help text changes in `src/cli.ts` and baseline fixture `tests/p1-cli/fixtures/command-dispatch-baseline.json`.
- Root/deployment scripts (e.g., `package.json` scripts) invoking `check-caddy-adapted.mjs` with the `<live|maintenance>` parameter.
- Documentation updates in `AGENTS.md`, `README.md`, `SECURITY.md`, `SUCCESSION-PLAN.md`, and `docs/evidence/2026-09-22-doc-lane/CLAIMS.md`.

---

VERDICT: PASS (All 12 files cleanly eliminate references to deleted Supabase and Vercel hosts, maintain runtime test parity, enforce strict refusal of the retired host, and provide a fully self-contained maintenance configuration with no upstream dependencies.)
