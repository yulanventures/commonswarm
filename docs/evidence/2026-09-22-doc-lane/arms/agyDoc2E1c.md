### PART E1c REVIEW: Documentation & Runbooks

**Reviewed files in this part:**
- `AGENTS.md`
- `README.md`
- `TODO.md`
- `deploy/edge-runtime/RUNBOOK.md`
- `deploy/edge-runtime/VERIFICATION.md`
- `deploy/site/RUNBOOK.md`
- `deploy/supabase-stack/VERSIONS.md`
- `docs/design/2026-08-18-FILE-ARTIFACTS.md`
- `docs/design/WEB-ONBOARDING.md`

---

### 1. Pre-Cutover Caddy Fixtures Judgment

**Judgment on `deploy/edge-runtime/commonswarm.caddy`, `deploy/supabase-stack/commonswarm-api-fallback.caddy`, `commonswarm-api-maintenance.caddy`, and `deploy/edge-runtime/check-caddy-adapted.mjs`:**

**Yes, leaving `commonswarm-api-fallback.caddy` and `commonswarm-api-maintenance.caddy` in `deploy/supabase-stack/` is an operator trap.**

- **File / Context:** `deploy/supabase-stack/commonswarm-api-fallback.caddy` and `deploy/supabase-stack/commonswarm-api-maintenance.caddy`
- **Label:** RIGOUR (Operational Trap)
- **Concrete Sequence:**
  1. A service degradation or container failure occurs on `yulan-vps-1`.
  2. An on-call operator or incident responder inspects the deployment directory `deploy/supabase-stack/` looking for a degraded or fallback routing configuration.
  3. The operator spots `commonswarm-api-fallback.caddy`, assumes it is an emergency fallback mechanism for the live `commonswarm-api.caddy` in the same directory, and applies it to `/etc/caddy/sites/`.
  4. Caddy reloads and proxies Auth, REST, Storage, and Realtime upstream to `https://ukezjcnxjvkpkeezxaew.supabase.co`.
- **What an agent or user sees:**
  - Complete service outage: requests fail immediately with connection or DNS resolution errors because `cloud-swarm-dev` (`ukezjcnxjvkpkeezxaew`) was deleted on 2026-09-20.
  - Potential security exposure: if that project reference is ever reclaimed or re-registered in the future, customer bearer tokens and API requests would route to an external third party.
- **Contrast with `deploy/edge-runtime/commonswarm.caddy`:**
  - `deploy/edge-runtime/RUNBOOK.md` (lines 3 and 88) explicitly warns: *"Do not install deploy/edge-runtime/commonswarm.caddy as the live API file... That file proxies Auth, REST, Storage, and Realtime to the deleted host."*
  - In contrast, neither `deploy/supabase-stack/VERSIONS.md` nor the runbooks contain a corresponding negative warning for `commonswarm-api-fallback.caddy` or `commonswarm-api-maintenance.caddy`.
- **Recommendation:** In a follow-up lane, either delete these files, move them to an `archive/` or `fixtures/` directory, rename them to `*.deprecated`, or replace their upstreams with local static 503 maintenance responses.

---

### 2. Production & Rigour Findings (Diff Review)

No blocking false statements or regressions were introduced in this part. Detailed checks:

#### A. New Statements & Negative Instructions
- **`AGENTS.md:56, 310–324`**: Correctly identifies production as `yulan-vps-1` in Falkenstein, Germany. Explicitly enumerates commands never to run (`supabase db push`, `supabase functions deploy`, `supabase link`, `--linked`, `supabase projects api-keys`, `vercel deploy`). Accurately points site deployments to `deploy/site/deploy.sh yulan-vps-1`.
- **`AGENTS.md:318`**: Accurately establishes boundaries: explicitly states that procedures for schema migrations and stack/edge version deployment onto the box are not established, and points to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.
- **`AGENTS.md:330–365`**: Deploy script requirements (`site/.env`, JWT anon key check, service-role prohibition), clean archive build steps, symlink atomicity (`ln -sfn` + `mv -Tf`), and smoke check `curl` commands using `curl -sS` are accurate and operational.
- **`README.md:103`**: Target updated from hosted Supabase to `https://api.commonswarm.com`.
- **`TODO.md:44, 85, 211, 316, 322`**: Stale claims regarding Vercel project status removed. Item 5 and table row 5 accurately record Falkenstein, Germany as the database location and note the privacy policy is deferred to the owner. Row 11 accurately records Resend SMTP on the server with unestablished send rates.
- **`deploy/edge-runtime/RUNBOOK.md:3, 8–16, 88, 151, 153`**: Cutover and rollback procedures targeting `ukezjcnxjvkpkeezxaew.supabase.co` are removed. Replaced with clear statements that the API cutover is complete, live routes reside in `deploy/supabase-stack/commonswarm-api.caddy`, and negative warnings prevent copying `commonswarm.caddy` or rewriting headers to `supabase.co`.
- **`deploy/edge-runtime/VERIFICATION.md:11`**: Correctly marks cutover verification item 1 as done and closed.
- **`deploy/site/RUNBOOK.md:3, 87`**: Correctly marks the site cutover complete on `yulan-vps-1`. Rollback instructions to Vercel and the "Retire Vercel" section are removed; replaced with server-side `current` symlink rollback and explicit instructions never to repoint DNS at Vercel.
- **`deploy/supabase-stack/VERSIONS.md:13`**: Correctly documents cutover state and pins PostgreSQL to 17.6.1.x, while deferring unestablished image pin verification to `RESUME-HERE.md`.
- **`docs/design/2026-08-18-FILE-ARTIFACTS.md:392`**: Milestone S6 accurately updated to cite `deploy/site/deploy.sh yulan-vps-1` and `RESUME-HERE.md`.
- **`docs/design/WEB-ONBOARDING.md:138, 176–188, 218, 241`**: Stale Supabase CLI deployment (`supabase functions deploy`, `supabase secrets set`) and Vercel dashboard deploy traps removed. Steps now describe GoTrue on the server, `site/.env` compilation, and point unestablished mechanisms to `RESUME-HERE.md`.

#### B. Removed Statements
- All statements removed across these 9 files pertained to the deleted Vercel project `coswarm-site`, the deleted hosted Supabase project `cloud-swarm-dev` (`ukezjcnxjvkpkeezxaew`), or superseded proxy/rollback paths. No valid operational or architectural guidance was removed.

---

### 3. Dependencies Outside Part E1c

The following components belong to other review parts and could not be checked within Part E1c:
- CLI implementation, help strings, error handlers, and test suites (`src/`, `tests/p1-cli/`, `command-dispatch-baseline.json`).
- Edge function CORS origins and runtime code (`supabase/functions/`).
- Full claims accounting in `docs/evidence/2026-09-22-doc-lane/CLAIMS.md`.
- Static site assets (`site/public/llms.txt`, `site/src/`).
- Server configuration files (`deploy/supabase-stack/commonswarm-api.caddy`, `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`, `SECURITY.md`).

---

VERDICT: PASS Part E1c diff accurately reflects the Hetzner single-box cutover, cleanly removes deleted Supabase and Vercel references, adds necessary negative operational guards, and properly identifies unestablished workflows.
