### Part E2 Review: Site, CLI Strings, Cloud Target/Link Logic, Edge CORS, and Associated Tests

**Commit SHAs reviewed:**
- `803117ffa675fc20eb1d96293b7421c553b50f0e` (Round 2 review folds: `llms.txt`, edge CORS defaults, test restores)
- `e6c30851` (CLI strings, link targets, target remedies)
- `fcc04050` (Docs base commit)

---

### 1. Analysis of Round 2 Folds (Fixes from Round 1)

All three issues raised by Codex in Round 1 have been resolved in the files comprising Part E2:
1. **[site/public/llms.txt](file:///site/public/llms.txt#L35-L73)**: All references to `https://coswarm-site.vercel.app` (API reference link, Claude Code skill download `curl` command, home, start, download, and app links) have been updated to `https://commonswarm.com`. No deleted host remains in agent documentation.
2. **[supabase/functions/capability/index.ts](file:///supabase/functions/capability/index.ts#L181-L185)** & **[supabase/functions/command/cors.ts](file:///supabase/functions/command/cors.ts#L1-L6)**:
   - `DEFAULT_ALLOWED_ORIGIN` in capability edge function now defaults to `https://commonswarm.com` (removing `coswarm-site.vercel.app`).
   - `DEFAULT_COMMAND_ALLOWED_ORIGINS` in command CORS now contains only `https://commonswarm.com` and `https://www.commonswarm.com`.
   - Verified by tests in [tests/command-cors.test.ts](file:///tests/command-cors.test.ts#L10-L50) and [tests/command-cors.test.ts](file:///tests/command-cors.test.ts#L175-L201).
3. **[site/src/layouts/Base.astro](file:///site/src/layouts/Base.astro#L88-L94)** & **[site/src/lib/commonswarm.ts](file:///site/src/lib/commonswarm.ts#L252-L266)**: Code comments referencing Vercel builds or Supabase cloud dashboard configuration were updated to reflect server-side GoTrue configuration and publishing via `deploy/site/deploy.sh`.

---

### 2. File-by-File Evaluation for Part E2

#### A. Public Site & Documentation
- **[site/public/api.md](file:///site/public/api.md#L39-L44)**:
  - `<PROJECT_URL>` definition replaces the old `https://<ref>.supabase.co` self-hosted example with `https://api.commonswarm.com` for the service we run, specifying that any separate deployment uses its own base URL. Accurately describes origin requirements (`bare origin: no path, query, fragment, or credentials`).
- **[site/public/llms.txt](file:///site/public/llms.txt#L35-L73)**:
  - Agent instructions no longer reference `https://<ref>.supabase.co`.
  - Skill install instructions point to `https://commonswarm.com/skills/cswarm/SKILL.md`.

#### B. Site Components & Libs
- **[site/src/components/app/LiveDashboard.astro](file:///site/src/components/app/LiveDashboard.astro#L75-L80)** & **[site/src/components/app/LiveDashboard.astro](file:///site/src/components/app/LiveDashboard.astro#L1075-L1080)**:
  - Clarified comments explaining that OAuth provider discovery queries `/auth/v1/settings` from GoTrue directly on the server rather than via a hosted Supabase dashboard.
- **[site/src/components/auth/ProviderButtons.astro](file:///site/src/components/auth/ProviderButtons.astro#L14-L31)** & **[site/src/components/auth/provider-buttons.observer.test.ts](file:///site/src/components/auth/provider-buttons.observer.test.ts#L724-L728)**:
  - Updated operational comments to reference GoTrue settings on the server and `deploy/site/deploy.sh`.
- **[site/src/lib/auth-providers.ts](file:///site/src/lib/auth-providers.ts#L25-L30)** & **[site/src/lib/commonswarm.ts](file:///site/src/lib/commonswarm.ts#L252-L303)**:
  - Removed obsolete advice regarding Supabase's built-in 2-email-per-hour limit; correctly notes that transactional sign-in email runs through Resend and server-side rate limits are not established.

#### C. CLI & Target Resolution
- **[src/cli.ts](file:///src/cli.ts#L173-L181)** & **[src/cli.ts](file:///src/cli.ts#L984-L1000)**:
  - Help text for `cswarm link new` explicitly interpolates `CAPABILITY_SITE_ORIGIN` (`https://commonswarm.com`) and `CAPABILITY_ALLOWED_HOSTS` (`https://commonswarm.com`, `https://www.commonswarm.com`).
  - Transparently states: `"The path is /see. That page is not on the site, so opening the link returns 404."`
- **[src/cloud/capability-link.ts](file:///src/cloud/capability-link.ts#L1-L24)** & **[src/cloud/capability-link.ts](file:///src/cloud/capability-link.ts#L91-L106)**:
  - `CAPABILITY_SITE_ORIGIN` is pinned to `https://commonswarm.com`.
  - `CAPABILITY_ALLOWED_HOSTS` drops `coswarm-site.vercel.app`.
  - Disallowed hosts throw a clear error explaining allowed hosts and that `/see` returns 404.
- **[src/cloud/config.ts](file:///src/cloud/config.ts#L13-L28)**:
  - Missing `--url` error message points to `https://api.commonswarm.com`.
  - URL validation error for non-root paths changed from `"--url must be the Supabase project base URL"` to `"--url must be the service base URL, with no path"`.
- **[src/cloud/current-target.ts](file:///src/cloud/current-target.ts#L324-L330)**:
  - Missing target error guides the user to `cswarm accept --link-stdin` or `cswarm target set --url https://api.commonswarm.com --anon-key <key>`, explaining where to find the public anon key (`https://commonswarm.com/start`) and eliminating dead `<ref>.supabase.co` placeholders.
- **[src/cloud/files.ts](file:///src/cloud/files.ts#L330-L336)**:
  - Docstring in `absoluteStorageUrl` updated to remove mentions of `supabase.co`.
- **[src/cloud/invite-link.ts](file:///src/cloud/invite-link.ts#L21-L32)** & **[src/cloud/invite-link.ts](file:///src/cloud/invite-link.ts#L282-L290)**:
  - Defines `RETIRED_CLOUD_ORIGIN = "https://ukezjcnxjvkpkeezxaew.supabase.co"`.
  - `requirePinnedOrigin` intercepts this target immediately and rejects with:
    `invite link targets retired host https://ukezjcnxjvkpkeezxaew.supabase.co. Ask for a new invite.`
  - Rejection happens before any interactive prompt can accept it.

#### D. Edge Functions & Tests
- **[supabase/functions/command/cors.ts](file:///supabase/functions/command/cors.ts#L1-L6)** & **[supabase/functions/capability/index.ts](file:///supabase/functions/capability/index.ts#L181-L185)**:
  - Default allowed origins reflect production domains and reject deleted hosts.
- **[tests/command-cors.test.ts](file:///tests/command-cors.test.ts#L10-L49)** & **[tests/command-cors.test.ts](file:///tests/command-cors.test.ts#L175-L201)**:
  - Asserts that preflights with `deletedSiteOrigin` (`https://coswarm-site.vercel.app`) receive no `access-control-allow-origin`.
  - Reads `supabase/functions/capability/index.ts` to assert that `DEFAULT_ALLOWED_ORIGIN` is `https://commonswarm.com` and contains no reference to `vercel.app` (including a negative mutation test).
- **[tests/p1-cli/accept-link.test.ts](file:///tests/p1-cli/accept-link.test.ts#L297-L335)**:
  - Exercises `requirePinnedOrigin` with `RETIRED_CLOUD_ORIGIN` in both interactive and non-interactive modes, verifying rejection.
- **[tests/p1-cli/capability-link.test.ts](file:///tests/p1-cli/capability-link.test.ts#L1-L53)**:
  - New test file verifying `CAPABILITY_SITE_ORIGIN`, `CAPABILITY_ALLOWED_HOSTS`, rejection of `coswarm-site.vercel.app`, and `usage()` disclosure of 404.
- **[tests/p1-cli/citation-drift.test.ts](file:///tests/p1-cli/citation-drift.test.ts#L41-L81)**:
  - Exact line arithmetic: +2 lines added at import in `src/cli.ts` (lines 176–177) shifted lines 375–391 by +2; net -1 line in `usage()` help paragraph shifted lines 6223+ by +1. Line pins match `src/cli.ts`.
- **[tests/p1-cli/cli-errors.test.ts](file:///tests/p1-cli/cli-errors.test.ts#L38-L88)**:
  - Updates URL extraction assertions to match the two instances of `https://api.commonswarm.com` in `missingTargetError`.
  - Adds dedicated test for URL path validation (`--url must be the service base URL, with no path`).
- **[tests/p1-cli/edge-runtime-box.test.ts](file:///tests/p1-cli/edge-runtime-box.test.ts#L464-L495)**:
  - Switches assertion from pre-cutover Caddy fixture to `deploy/supabase-stack/commonswarm-api.caddy`, asserting local proxy ports (18001 auth, 18002 rest, 18004 storage, 18003 realtime) and absence of `ukezjcnxjvkpkeezxaew.supabase.co`.

---

### 3. Judgment on Pre-Cutover Caddy Fixtures (Operator Trap Analysis)

**Question:** Are `deploy/edge-runtime/commonswarm.caddy`, `deploy/supabase-stack/commonswarm-api-fallback.caddy`, `commonswarm-api-maintenance.caddy`, and `deploy/edge-runtime/check-caddy-adapted.mjs` a trap an operator could fall into?

**Evaluation:**
**YES, leaving these files in place is an operational trap.**
- **Sequence:** An operator responding to an outage, migration issue, or scheduled maintenance inspects `deploy/supabase-stack/` or follows an old runbook and encounters `commonswarm-api-fallback.caddy` or `commonswarm-api-maintenance.caddy`. Believing it to be a valid fallback configuration, the operator applies it (`caddy reload --config deploy/supabase-stack/commonswarm-api-fallback.caddy`).
- **Outcome:** Traffic is immediately proxied to `ukezjcnxjvkpkeezxaew.supabase.co`. Because that Supabase hosted project was deleted on 2026-09-20, clients receive DNS failures or `502 Bad Gateway`, turning a recoverable degraded state into a total outage.
- **Fixture ambiguity:** Keeping pre-cutover fragments inside active deployment directories (`deploy/supabase-stack/` and `deploy/edge-runtime/`) rather than an explicit archive or fixture path (e.g. `tests/fixtures/` or `docs/evidence/`) violates the principle of least astonishment.
- **Scope Note:** While [tests/p1-cli/edge-runtime-box.test.ts](file:///tests/p1-cli/edge-runtime-box.test.ts#L464-L475) correctly documents that `commonswarm-api-fallback.caddy` is an obsolete pre-cutover fragment and points its live assertions at `commonswarm-api.caddy`, leaving the fixture files in `deploy/` remains a trap for operators.

---

### 4. Findings

#### Finding 1: Retained fallback and maintenance Caddy files proxy to deleted Supabase host
- **Label:** RIGOUR (Operational Hazard)
- **Location:** [tests/p1-cli/edge-runtime-box.test.ts:467-472](file:///tests/p1-cli/edge-runtime-box.test.ts#L467-L472) (referencing `deploy/supabase-stack/commonswarm-api-fallback.caddy` and `deploy/edge-runtime/commonswarm.caddy`)
- **Concrete Sequence:** An operator in an incident attempts to switch Caddy to fallback using `commonswarm-api-fallback.caddy`. Caddy forwards upstream requests to `ukezjcnxjvkpkeezxaew.supabase.co`.
- **What an Operator/User Sees:** DNS resolution fails or returns `502 Bad Gateway` for all `/auth/v1/*`, `/rest/v1/*`, and `/storage/v1/*` requests because the upstream project was deleted on 2026-09-20.
- **Remedy:** In a follow-up lane, remove `commonswarm-api-fallback.caddy` and obsolete edge-runtime caddy fixtures, or update them to proxy to local stack fallbacks / maintenance static responses.

---

### 5. External Dependencies Not Checked in Part E2
- The Caddy configuration files themselves (`deploy/supabase-stack/commonswarm-api-fallback.caddy`, `deploy/edge-runtime/commonswarm.caddy`, etc.) belong to separate deployment review parts.
- Root documentation files (`AGENTS.md`, `README.md`, `SECURITY.md`, `CLAIMS.md`, runbooks, and spec) belong to Part 1.
- Untracked site privacy page edits mentioned as deferred to the project owner.
- The 337-line baseline diff in `tests/p1-cli/fixtures/command-dispatch-baseline.json`.

---

VERDICT: PASS Part E2 code, CLI strings, and tests correctly retire deleted hosts, secure CORS and capability defaults, accurately disclose `/see` 404 status, and pass all gate criteria.
