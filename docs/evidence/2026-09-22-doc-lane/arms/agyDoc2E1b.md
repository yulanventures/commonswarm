### D-036 Review — Part E1b of 4

**Files Reviewed:**
1. [SECURITY.md](file:///SECURITY.md)
2. [deploy/edge-runtime/README.md](file:///deploy/edge-runtime/README.md)
3. [deploy/supabase-stack/RUNBOOK.md](file:///deploy/supabase-stack/RUNBOOK.md)
4. [docs/design/2026-08-02-V015-MASTER-PLAN.md](file:///docs/design/2026-08-02-V015-MASTER-PLAN.md)
5. [docs/design/2026-09-04-GOOGLE-SIGNIN.md](file:///docs/design/2026-09-04-GOOGLE-SIGNIN.md)
6. [docs/design/CAPABILITY-URL-ONRAMP.md](file:///docs/design/CAPABILITY-URL-ONRAMP.md)
7. [docs/design/SWARM-CLOUD.md](file:///docs/design/SWARM-CLOUD.md)
8. [docs/design/contracts/V015-RELEASE-CHECKLIST.md](file:///docs/design/contracts/V015-RELEASE-CHECKLIST.md)
9. [site/README.md](file:///site/README.md)

---

### Unchecked Dependencies (Separate Calls)
Because this review is strictly partitioned into Part E1b, the following referenced targets and files outside this slice cannot be independently verified here:
- `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md` (referenced in RUNBOOK.md, MASTER-PLAN.md, and V015-RELEASE-CHECKLIST.md).
- `deploy/site/deploy.sh` and `deploy/site/RUNBOOK.md` (referenced in site/README.md and GOOGLE-SIGNIN.md).
- `deploy/supabase-stack/commonswarm-api.caddy` (the live API Caddyfile).
- CLI implementation and tests (`cswarm link`, invite link handling, capability origin validation).

---

### Production Findings
**None.** 
Across all 9 files in Part E1b:
- No new false statements were introduced.
- No instructions tell agents or operators to touch deleted systems (Supabase Cloud or Vercel); in fact, explicit guards, disclaimers, and warnings against running `supabase db push --linked` or `vercel deploy` were systematically added to historical plans and runbooks.
- No true statements were improperly removed.
- User-facing origin changes correctly align with `https://commonswarm.com`, and the fact that `/see` returns 404 is documented.
- The relative deploy path discrepancy in [site/README.md](file:///site/README.md#L178) from Round 1 has been properly resolved by providing both repository-root (`deploy/site/deploy.sh yulan-vps-1`) and `site/`-relative (`../deploy/site/deploy.sh yulan-vps-1`) forms.

---

### Rigour Findings & Evaluation of Caddy Fixtures

#### 1. Pre-cutover Caddy Files as Operational Traps
- **Files:** `deploy/supabase-stack/commonswarm-api-fallback.caddy`, `deploy/supabase-stack/commonswarm-api-maintenance.caddy`, `deploy/edge-runtime/commonswarm.caddy`, `deploy/edge-runtime/check-caddy-adapted.mjs`
- **Evaluation:**
  - **`commonswarm-api-fallback.caddy` is a genuine operational trap:** If an operator experiences an outage on `yulan-vps-1` and inspects `/etc/caddy/sites/` or `deploy/supabase-stack/`, the filename `commonswarm-api-fallback.caddy` strongly suggests a valid degraded-mode or fallback configuration. However, its upstream targets `ukezjcnxjvkpkeezxaew.supabase.co` (a permanently deleted Supabase Cloud project). Deploying it during an incident would immediately convert a recoverable failure into total outage (502 / NXDOMAIN / TLS failure). While [deploy/supabase-stack/RUNBOOK.md](file:///deploy/supabase-stack/RUNBOOK.md#L385) says *"Never install the fallback Caddy file after this point. Fix later failures forward"*, runbook text does not prevent an operator from grabbing the file directly from the filesystem during an emergency.
  - **`commonswarm-api-maintenance.caddy` is similarly misleading:** It routes read traffic to the dead Supabase Cloud host while blocking writes. If an operator attempts to enable maintenance mode by symlinking or copying this file, user reads fail outright.
  - **`deploy/edge-runtime/commonswarm.caddy`:** [deploy/edge-runtime/README.md](file:///deploy/edge-runtime/README.md#L78-L83) now explicitly warns: *"The live routes are in deploy/supabase-stack/commonswarm-api.caddy. deploy/edge-runtime/commonswarm.caddy is not the live API file. Do not validate commonswarm.caddy by itself, and do not install it as the live API file."* This documentation warning mitigates confusion for this specific file, though keeping a dead proxy config as an active test fixture in `check-caddy-adapted.mjs` remains a technical debt risk.
  - **Recommendation:** In a follow-up cleanup lane, rename `commonswarm-api-fallback.caddy` and `commonswarm-api-maintenance.caddy` to `.retired` or move them under a historical `fixtures/` directory so they cannot be accidentally selected by globbing or tab-completion in production.

---

VERDICT: PASS — All documentation changes accurately reflect the single-box architecture, neutralize references to deleted cloud services, document unestablished migration procedures honestly, and resolve the previous Round 1 path issues.
