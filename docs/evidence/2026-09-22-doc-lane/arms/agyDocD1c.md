### D-036 Review — Part D1c of 4 (Documents)

**Scope of this part**:
- [`deploy/edge-runtime/RUNBOOK.md`](file:///deploy/edge-runtime/RUNBOOK.md)
- [`AGENTS.md`](file:///AGENTS.md)
- [`TODO.md`](file:///TODO.md)
- [`docs/design/WEB-ONBOARDING.md`](file:///docs/design/WEB-ONBOARDING.md)
- [`docs/design/2026-08-18-FILE-ARTIFACTS.md`](file:///docs/design/2026-08-18-FILE-ARTIFACTS.md)
- [`deploy/site/RUNBOOK.md`](file:///deploy/site/RUNBOOK.md)
- [`docs/design/SWARM-CLOUD.md`](file:///docs/design/SWARM-CLOUD.md)
- [`README.md`](file:///README.md)

---

### Dependencies Not Checkable in this Call
1. **Parts D1a & D1b**: Remaining doc and specification files in the docs commit (`SECURITY.md`, `docs/evidence/2026-09-22-doc-lane/CLAIMS.md`, `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`, etc.).
2. **Part D2**: The code commit diffs and test suites (CLI strings, invite link rejection logic, capability link defaults, `tests/p1-cli/fixtures/command-dispatch-baseline.json`).
3. **Live Box State**: Server environment on `yulan-vps-1` (`deploy/site/deploy.sh`, `deploy/supabase-stack/commonswarm-api.caddy`, `deploy/site/finalize-release.sh`, and local systemd/Caddy configs), which cannot be directly inspected under the rules.

---

### Production Review

#### 1. [`AGENTS.md`](file:///AGENTS.md#L53-L368)
- **Production Guardrails**: Successfully replaces the obsolete `cloud-swarm-dev IS PRODUCTION` section with explicit prohibitions against running `supabase db push`, `supabase functions deploy`, `supabase link`, `--linked`, `supabase projects api-keys`, and `vercel deploy`.
- **Site Deployment & Rollback**: Replaces Vercel instructions with `deploy/site/deploy.sh yulan-vps-1`, documenting the required `.env` variables (`PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_ANON_KEY`), verification against service-role leakage (`InNlcnZpY2Vfcm9sZSI` grep), and server rollback via symlink switching (`ln -sfn` + `mv -Tf`).
- **Honest Disclosures**: Transparently documents that schema migrations and edge-function rollout procedures to the box are not yet established, pointing to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.

#### 2. [`deploy/edge-runtime/RUNBOOK.md`](file:///deploy/edge-runtime/RUNBOOK.md#L1-L157)
- **Dead Host Prevention**: Explicitly warns operators not to copy `deploy/edge-runtime/commonswarm.caddy` to `/etc/caddy/sites/10-commonswarm-api.caddy`, as that configuration proxied Auth, REST, Storage, and Realtime to the deleted Supabase host (`ukezjcnxjvkpkeezxaew.supabase.co`).
- **Removal of Misleading Procedures**: Cleanly excises sections 6, 7, and 8 that previously directed operators to de-register custom domains via the Supabase Management API, inspect hosted Supabase metrics dashboards, or roll back DNS to `ukezjcnxjvkpkeezxaew.supabase.co`.
- **Current Architecture**: Directs to `deploy/supabase-stack/commonswarm-api.caddy` where Caddy sends Auth, REST, Storage, and Realtime to local containers.

#### 3. [`deploy/site/RUNBOOK.md`](file:///deploy/site/RUNBOOK.md#L1-L87)
- **Cutover Status**: Updated to state that the site cutover is done, served by Caddy on `yulan-vps-1`.
- **Prevention of Dead Rollbacks**: Excised the "Retire Vercel" section and the former DNS rollback to Vercel. Adds explicit directive: *"Roll back a site release on the server by moving the current symlink. Do not point DNS at Vercel."*

#### 4. [`docs/design/WEB-ONBOARDING.md`](file:///docs/design/WEB-ONBOARDING.md#L135-L245)
- **Edge Functions & Auth Configuration**: Removes `supabase functions deploy` and instructions to open the Supabase web dashboard. Updates Step 3 to direct configuration of GoTrue on the server (GitHub via `yulanventures` OAuth app, Google, email via Resend SMTP).
- **Redirects & Error Screens**: Removes references to `coswarm-site.vercel.app` from the redirect allow-list, keeping only `https://commonswarm.com/app`. Corrects the failure mode description to state that OAuth errors render from GoTrue on `api.commonswarm.com` rather than Supabase's hosted domain.
- **Environment & Build Trap**: Replaces the Vercel-specific deployment instructions with `deploy/site/deploy.sh yulan-vps-1` reading from `site/.env`.
- **Secrets Management**: Removes `supabase secrets set SWARM_SELF_SERVE=1`, documenting that runtime reading of `SWARM_SELF_SERVE` on the server is not established while noting its production value remains 1.

#### 5. [`docs/design/2026-08-18-FILE-ARTIFACTS.md`](file:///docs/design/2026-08-18-FILE-ARTIFACTS.md#L392), [`docs/design/SWARM-CLOUD.md`](file:///docs/design/SWARM-CLOUD.md#L21-L26), [`README.md`](file:///README.md#L100-L105), and [`TODO.md`](file:///TODO.md#L41-L325)
- All references to the deleted Vercel alias (`coswarm-site.vercel.app`) and project are marked deleted or superseded.
- Database location is accurately noted as Falkenstein, Germany; dashboard lookups are forbidden; privacy policy edits are correctly scoped as owner items.
- Target endpoints in the README correctly identify the local Supabase CLI and the production API at `https://api.commonswarm.com`.

---

### Rigour Review

- **No Active Traps**: No document in this set directs an operator or agent to touch `ukezjcnxjvkpkeezxaew.supabase.co`, access the Supabase hosted dashboard, run `vercel` CLI commands, or configure deleted Vercel DNS.
- **Precision of Limitations**: Every area where operational mechanics are not yet finalized (schema migrations, edge runtime function deployments, server-side secret reading) is consistently flagged with a pointer to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`.
- **Integrity of Kept Assertions**: Historical context in design docs is kept appropriately framed as superseded history, avoiding misleading present-tense claims.

---

VERDICT: PASS — All documentation changes in Part D1c accurately reflect the move to the single Hetzner server, remove all instructions to interact with deleted Supabase and Vercel services, provide valid site deployment and rollback procedures, and clearly declare unestablished procedures.
