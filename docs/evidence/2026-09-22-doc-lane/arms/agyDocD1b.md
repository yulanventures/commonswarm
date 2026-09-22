### Review Scope & Unchecked Dependencies

This review covers **PART D1b OF 4 (documents)**:
- `SECURITY.md`
- `deploy/edge-runtime/README.md`
- `deploy/supabase-stack/RUNBOOK.md`
- `docs/design/2026-08-02-V015-MASTER-PLAN.md`
- `docs/design/2026-09-04-GOOGLE-SIGNIN.md`
- `docs/design/CAPABILITY-URL-ONRAMP.md`
- `docs/design/contracts/V015-RELEASE-CHECKLIST.md`
- `site/README.md`

**Dependencies not checkable in this pass:**
- The other 3 parts (CLI code, tests, dispatch fixtures, and other docs such as `AGENTS.md`, `README.md`, and `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`).
- Exact line contents outside the provided diff hunks in the 8 files under review.
- Live server / DNS state (per review rules, no production hosts contacted).

---

### Detailed Review by Document

#### 1. `SECURITY.md`
- **Lines 30–34**: Replaces out-of-scope third parties (Supabase/Vercel) with Cloudflare, Hetzner, Resend, and upstream container images; explicitly declares that the service is no longer on Supabase Cloud or Vercel.
- **Lines 58–65**: Points Terms, Privacy, and Acceptable Use links to `https://commonswarm.com/...` instead of the deleted `CommonSwarm-site.vercel.app` project. Preserves note that documents remain drafts (`draft={true}`).
- **Finding**: None. Changes are accurate and do not instruct users or security researchers to interact with deleted systems.

#### 2. `deploy/edge-runtime/README.md`
- **Lines 70–80**: Updates the upstream service map to local loopback ports on the server (`127.0.0.1:18001` for GoTrue, `18002` for PostgREST, `18003` for Realtime HTTP/1.1, `18004` for Storage API) and sets fallback routes to return `404` JSON.
- **Lines 81–87**: Explicitly directs operators to `deploy/supabase-stack/commonswarm-api.caddy` as the live API configuration, warning that `deploy/edge-runtime/commonswarm.caddy` is only a validation fragment and not the live file.
- **Lines 94–97**: Replaces the old latency benchmark (which compared against hosted Supabase Cloud) with confirmation that N-db landed and adds a critical safety check: **"Do not roll DNS back to supabase.co."**
- **Finding**: None. Prevents dangerous rollbacks to deleted hosts and clarifies routing.

#### 3. `deploy/supabase-stack/RUNBOOK.md`
- **Lines 1–8**: Top-level banner clarifies that database cutover is completed, prohibits re-running commands against a source project, and explicitly marks schema migration delivery procedures as not yet established, linking to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.
- **Line 110**: Clarifies that hosted storage is gone, files reside in Cloudflare R2 via the local Storage API on loopback, and notes that Caddy strips `/storage/v1`.
- **Lines 271, 312, 385**: Contextualizes window steps (explaining DNS state during cutover vs. current production, removing advice to audit hosted logs or keep hosted project frozen).
- **Line 442**: Details active GoTrue authentication providers (GitHub via yulanventures OAuth app, Google, email via Resend) and callbacks (`https://api.commonswarm.com/auth/v1/callback`).
- **Finding**: None. Safely preserves the cutover record without leaving active instructions that could touch deleted infrastructure.

#### 4. `docs/design/2026-08-02-V015-MASTER-PLAN.md`
- **Lines 1–6**: Header explicitly states this document is a historical record of the v0.1.5 rollout. Explicitly forbids running `vercel deploy` or `supabase db push --linked`.
- **Lines 272–276**: Replaces Vercel deployment instructions with `deploy/site/deploy.sh yulan-vps-1` and preserves verification rigor (verifying deployed pages with positive and negative checks).
- **Finding**: None. Prevents accidental execution of dead tooling while recording historical plan context.

#### 5. `docs/design/2026-09-04-GOOGLE-SIGNIN.md`
- **Lines 1–8, 18–25**: Updates status from "written and dark" to enabled on server GoTrue; documents Resend as SMTP sender; notes server email send rate is unestablished.
- **Lines 225–245**: Replaces `vercel deploy dist` with `deploy/site/deploy.sh` and clarifies GoTrue server-side settings handling.
- **Lines 270–273, 430–445**: Explicitly removes instructions to add `ukezjcnxjvkpkeezxaew.supabase.co` callback ("That host is retired") and warns operators: "Change GoTrue settings on the server. Do not open the Supabase dashboard."
- **Lines 572–595**: Replaces Supabase dashboard setup steps with server GoTrue instructions; preserves the 2026-09-06 measurement note; updates deployment commands to `deploy/site/deploy.sh yulan-vps-1`.
- **Finding**: None. Eliminates references to the Supabase Cloud dashboard and points operators directly to server configuration.

#### 6. `docs/design/CAPABILITY-URL-ONRAMP.md`
- **Line 58**: Updates example capability link from `https://coswarm-site.vercel.app/see#...` to `https://commonswarm.com/see#...`.
- **Line 89**: Updates allowlist specification (`CSWARM_SITE_ORIGIN` / `--site`) to default to `https://commonswarm.com`, permits `www.commonswarm.com` or loopback, removes the deleted Vercel host, and explicitly notes that the `/see` page does not exist (returns 404).
- **Finding**: None. Accurately reflects CLI allowlist enforcement and capability link generation.

#### 7. `docs/design/contracts/V015-RELEASE-CHECKLIST.md`
- **Lines 1–6**: Marks checklist as the historical record of the v0.1.5 plan. Forbids `supabase db push --linked` and `vercel deploy`. Explicitly records that schema migration and edge-function rollout to the box are unestablished, linking to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.
- **Lines 132–150**: Replaces steps 1, 4, 5, and 7 with explicit warnings that the hosted project is deleted and delivery procedures for `command` and `read` functions are unestablished.
- **Lines 156–162**: Updates site deployment to `deploy/site/deploy.sh yulan-vps-1` and verification to Caddy on `yulan-vps-1`.
- **Finding**: None. Prevents agents from attempting to run release commands against deleted projects.

#### 8. `site/README.md`
- **Lines 176–181**: Replaces `vercel deploy dist ...` with `deploy/site/deploy.sh yulan-vps-1`; documents that the script builds from a clean archive, requires `site/.env`, and references `deploy/site/RUNBOOK.md`.
- **Finding**: None. Correctly documents the deployment pipeline to Hetzner.

---

### Verification Against Review Criteria

1. **New statements that are false or instruct wrong action**: None found. Decommissioned systems (`ukezjcnxjvkpkeezxaew.supabase.co`, Vercel `coswarm-site`) are explicitly flagged as deleted/retired, and commands referencing them are guarded by historical record notices or replaced with server commands (`deploy/site/deploy.sh yulan-vps-1`).
2. **True statements removed**: None. Historical context is preserved where needed, and obsolete operational steps for hosted cloud services have been safely retired or marked historical.
3. **Behavioral regressions or broken fixes**: The documentation aligns with the code changes (capability URLs default to `commonswarm.com`, dead Vercel host rejected, `/see` page 404 documented).
4. **CLAIMS.md alignment**: The document changes accurately reflect the single-box deployment on `yulan-vps-1` and respect the owner deferrals (draft privacy documents).

VERDICT: PASS The documentation changes in Part D1b accurately reflect the decommissioned Supabase and Vercel infrastructure, safeguard against contacting deleted hosts or rolling back DNS, document the Caddy/Hetzner server deployment path, and clearly identify unestablished migration and edge-delivery procedures.
