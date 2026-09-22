### Scope: Part F1a of 5
Files reviewed in this part:
1. [`README.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/README.md)
2. [`SECURITY.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/SECURITY.md)
3. [`deploy/supabase-stack/commonswarm-api.caddy`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/commonswarm-api.caddy)
4. [`docs/design/CAPABILITY-URL-ONRAMP.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/CAPABILITY-URL-ONRAMP.md)
5. [`docs/design/contracts/V015-RELEASE-CHECKLIST.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/contracts/V015-RELEASE-CHECKLIST.md)
6. [`site/README.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/site/README.md)
7. [`docs/evidence/2026-09-22-doc-lane/CLAIMS.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/evidence/2026-09-22-doc-lane/CLAIMS.md)

---

### External Dependencies (Out of Scope for Part F1a)
The following referenced artifacts are reviewed in separate calls and cannot be verified within this part:
- `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md` (migration & edge function status tracker)
- `deploy/site/deploy.sh` and `deploy/site/RUNBOOK.md` (site deployment script and runbook)
- `deploy/supabase-stack/commonswarm-api-maintenance.caddy` (maintenance Caddy configuration)
- CLI and backend source code (`src/cloud/*.ts`, `supabase/functions/**`)
- Test suites (`tests/p1-cli/*.test.ts`)
- Other docs (`AGENTS.md`, `SUCCESSION-PLAN.md`, `TODO.md`, `brain-releases.md`)

---

### Detailed Review

#### 1. [`README.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/README.md#L100-L106)
- **Change:** Line 103 updates the CLI target description from targeting hosted Supabase to "the local Supabase CLI, or the production API at https://api.commonswarm.com".
- **Verification:** Accurate and removes the dead hosted Supabase target reference.

#### 2. [`SECURITY.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/SECURITY.md#L30-L65)
- **Change:** Out-of-scope services updated to Cloudflare, Hetzner, Resend, and upstream container images; explicitly states that the service is not on Supabase Cloud or Vercel. Policy links updated from `https://CommonSwarm-site.vercel.app/*` to `https://commonswarm.com/*` (`terms`, `privacy`, `acceptable-use`), and clarifies they remain drafts (`draft={true}`).
- **Verification:** All URLs point to the live domain, dead third-party hosting references are removed from the vulnerability scope, and no false promises or invalid instructions are given to security researchers.

#### 3. [`deploy/supabase-stack/commonswarm-api.caddy`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/supabase-stack/commonswarm-api.caddy#L1-L60)
- **Change:** Comments updated at lines 1–2 and 59–60 to document that Auth, REST, Storage, Realtime, and functions route to local containers on this server without upstream fallback, and that maintenance uses `commonswarm-api-maintenance.caddy` (answering 503 on the public site without an upstream).
- **Verification:** The live API routing configuration is unchanged, and header comments match the post-cutover architecture and round 2 removal of the fallback caddy file.

#### 4. [`docs/design/CAPABILITY-URL-ONRAMP.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/CAPABILITY-URL-ONRAMP.md#L58-L95)
- **Change:** Example output updated from `https://coswarm-site.vercel.app/see#...` to `https://commonswarm.com/see#...`. Allowlist section updated: `commonswarm.com` is default, `www.commonswarm.com` permitted, loopback permitted, `coswarm-site.vercel.app` removed. Explicitly notes that the `/see` page does not exist (returns 404).
- **Verification:** Matches the CLI runtime allowlist changes and prevents minting links to dead domains.

#### 5. [`docs/design/contracts/V015-RELEASE-CHECKLIST.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/design/contracts/V015-RELEASE-CHECKLIST.md#L1-L165)
- **Change:** Added header banner stating this checklist is the historical record of the v0.1.5 plan, that the named Supabase and Vercel projects are deleted, forbidding `supabase db push --linked` and `vercel deploy`, noting that migrations and edge function deploys to the box are not yet established (pointing to `docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`), and replacing the site deployment step with `deploy/site/deploy.sh yulan-vps-1` on Caddy. Steps 1, 4, 5, and 7 are updated with explicit disclaimers.
- **Verification:** Prevents automated agents or operators from attempting mutations against the deleted Supabase project or Vercel scope during verification.

#### 6. [`site/README.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/site/README.md#L175-L184)
- **Change:** Replaces `vercel deploy dist --prod ...` with `deploy/site/deploy.sh yulan-vps-1`. Adds instructions for running from repository root vs `site/` (`../deploy/site/deploy.sh yulan-vps-1`), mentions `site/.env` requirement, and references `deploy/site/RUNBOOK.md`.
- **Verification:** Correctly specifies the production deployment mechanism and avoids working directory confusion.

#### 7. [`docs/evidence/2026-09-22-doc-lane/CLAIMS.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/evidence/2026-09-22-doc-lane/CLAIMS.md)
- **Accounting Verification:**
  - Original claims: 76 total (70 marked `fixed`, 6 marked `deferred: owner decision` on privacy.astro).
  - Maker additions: 21 rows (all marked `fixed`).
  - Review fold additions: 6 rows (all marked `fixed`).
  - Round 2 additions: 2 rows (`commonswarm-api-maintenance.caddy` / fallback / edge caddy cleanup, and `SUCCESSION-PLAN.md`, both marked `fixed`).
  - Total rows: 105 rows.
- **Cross-check against Part F1a diffs:**
  - `README.md:103` (Row 10) -> `fixed`. Confirmed in `README.md`.
  - `SECURITY.md:33` (Row 65) -> `fixed`. Confirmed in `SECURITY.md`.
  - `SECURITY.md:61-66` (Row 66) -> `fixed`. Confirmed in `SECURITY.md`.
  - `deploy/supabase-stack/commonswarm-api.caddy` (Rows 76, 104) -> Confirmed updated.
  - `docs/design/CAPABILITY-URL-ONRAMP.md:61, 92` (Rows 58, 59) -> `fixed`. Confirmed in `CAPABILITY-URL-ONRAMP.md`.
  - `docs/design/contracts/V015-RELEASE-CHECKLIST.md:135, 160` (Rows 91, 92) -> `fixed`. Confirmed in checklist.
  - `site/README.md:179` (Row 46) -> `fixed`. Confirmed in `site/README.md`.
- **Verification:** All CLAIMS.md entries corresponding to Part F1a files are genuinely fixed in the tree diff; notes on Round 2 correctly describe the maintenance 503 behavior and the removal of the fallback/pre-cutover edge configs.

---

### Findings
No PRODUCTION or RIGOUR findings in the files reviewed for Part F1a.

VERDICT: PASS Part F1a docs, contracts, Caddy comments, and CLAIMS.md accounting accurately reflect the single-box Hetzner deployment with no remaining references to deleted Supabase or Vercel targets.
