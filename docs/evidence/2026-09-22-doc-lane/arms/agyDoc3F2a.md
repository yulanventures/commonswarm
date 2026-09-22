### Review of Part F2a (lane/doc-box-production @ `aaa8a914ffb24fe364a88b46094d9da3014bad5d`)

#### Scope of Part F2a
- **CLI & Target Configuration**: `src/cli.ts`, `src/cloud/config.ts`, `src/cloud/current-target.ts`
- **CLI Error & Capability Link Tests**: `tests/p1-cli/cli-errors.test.ts`, `tests/p1-cli/capability-link.test.ts`
- **Caddy Stack & Adaptation Tests**: `tests/p1-cli/supabase-stack.test.ts`
- **CORS & Edge Functions**: `supabase/functions/capability/index.ts`, `tests/command-cors.test.ts`
- **Site Library & Astro Components**: `site/src/layouts/Base.astro`, `site/src/components/app/LiveDashboard.astro`, `site/src/lib/auth-providers.ts`, `site/src/lib/commonswarm.ts`, `site/src/components/auth/provider-buttons.observer.test.ts`

---

### Detailed Findings & Verification

#### 1. CLI Usage & Target Errors (`src/cli.ts`, `src/cloud/config.ts`, `src/cloud/current-target.ts`, `tests/p1-cli/cli-errors.test.ts`)
- **Dead Hosts & Wording**:
  - In `src/cli.ts`, the deleted default origin `https://coswarm-site.vercel.app` was removed. The help text now sources `${CAPABILITY_SITE_ORIGIN}` (`https://commonswarm.com`) and dynamically enumerates `${CAPABILITY_ALLOWED_HOSTS}`. It explicitly alerts users that the path is `/see`, which returns 404 because the page is not on the site.
  - In `src/cloud/config.ts` and `src/cloud/current-target.ts`, all references to `<ref>.supabase.co`, "Supabase project base URL", and assumptions regarding inviters were removed. Both messages cleanly point users to `https://api.commonswarm.com` (the service we run) or a self-hosted deployment's own base URL, and direct the user to the public anon key at `https://commonswarm.com/start`.
  - In `tests/p1-cli/cli-errors.test.ts`, regex assertions match the updated wording (`service base URL`, `The service we run is https://api.commonswarm.com`), verify the absence of `supabase.co` and `Supabase project`, and assert the exact set of 4 extracted URLs. A new test verifies that passing a path into `--url` fails with `--url must be the service base URL, with no path`.

#### 2. Capability Link & CORS (`supabase/functions/capability/index.ts`, `tests/command-cors.test.ts`, `tests/p1-cli/capability-link.test.ts`)
- **Edge Defaults**:
  - `supabase/functions/capability/index.ts` sets `DEFAULT_ALLOWED_ORIGIN = "https://commonswarm.com"` and deletes the old reference to the Vercel project alias.
  - In `tests/command-cors.test.ts`, CORS preflight is tested with `productionOrigin` (`https://commonswarm.com`), `wwwOrigin` (`https://www.commonswarm.com`), and verifies that the deleted origin `https://coswarm-site.vercel.app` receives `null` for `access-control-allow-origin`. Source verification (`capabilityDefaultIsPublicSite`) ensures that `DEFAULT_ALLOWED_ORIGIN` is pinned to `https://commonswarm.com` and fails if `vercel.app` is present.
  - `tests/p1-cli/capability-link.test.ts` thoroughly validates defaults (`https://commonswarm.com`), allowlists, rejection of `coswarm-site.vercel.app` with expected error messages, and tests that `usage()` output matches the expected host list and 404 disclosure without mentioning the deleted host.

#### 3. Site Comments & Documentation Integrity
- In `site/src/layouts/Base.astro`, comments describe the local build and publishing via `deploy/site/deploy.sh` rather than Vercel builds.
- In `site/src/components/app/LiveDashboard.astro`, `site/src/lib/auth-providers.ts`, and `site/src/components/auth/provider-buttons.observer.test.ts`, references to "Supabase dashboard" are updated to "GoTrue on the server" / "GoTrue".
- In `site/src/lib/commonswarm.ts`, obsolete commentary about Supabase's built-in 2-email/hour limit is replaced with factual notation that emails are dispatched via Resend and the server send rate is not established.

#### 4. Caddy & Maintenance Verification (`tests/p1-cli/supabase-stack.test.ts`)
- **Intent Preservation**:
  - In `routeFrame()`, the directive matcher was updated to extract directives independent of the top-level block label. This allows comparing the live block (`api.commonswarm.com, edge-staging.commonswarm.com { ... }`) against the maintenance configuration's staging block `(box_routes) { ... }`, ensuring no route definitions drift between live and staging.
  - `maintenanceProblems()` verifies that the public maintenance site (`api.commonswarm.com`) has **no** `reverse_proxy` or `import` directives (addressing the Round 2 finding where maintenance public site forwarded to the deleted project), includes `OPTIONS` preflight handling, includes `Retry-After: 300` and CORS headers, returns the 503 maintenance JSON body, ensures staging imports `box_routes`, and forbids `supabase.co` hosts.
  - Negative control assertions in `supabase-stack.test.ts` verify that mutations (injecting an upstream into the public site, breaking the staging routes import, stripping `Retry-After`) trigger immediate test failures.
  - `test("no deploy Caddy file names a supabase.co host")` scans all `.caddy` files under `deploy/`, verifies deletion of `commonswarm-api-fallback.caddy` and `edge-runtime/commonswarm.caddy`, verifies required live files exist, and tests sensitivity by asserting that `# supabase.com` passes while `# https://example.supabase.co` fails.
  - Adaptation checks under Docker Caddy 2.11 validate both `live` and `maintenance` profiles across proxy modes, with mutated JSON checks testing rejection of `supabase.co` hosts and missing `Retry-After` headers.

---

### Dependencies Outside Part F2a
The following referenced files belong to other parts and could not be directly inspected in this review slice:
- `src/cloud/capability-link.ts` (Part F2b): supplies `CAPABILITY_SITE_ORIGIN`, `CAPABILITY_ALLOWED_HOSTS`, and `capabilitySiteOrigin()`.
- `deploy/supabase-stack/commonswarm-api.caddy`, `deploy/supabase-stack/commonswarm-api-maintenance.caddy`, and `deploy/edge-runtime/check-caddy-adapted.mjs` (Part F1).

---

VERDICT: PASS
