### Review Scope: Part D1a of 4 (Documents)

Files reviewed in this part:
- [`deploy/edge-runtime/VERIFICATION.md`](file:///deploy/edge-runtime/VERIFICATION.md)
- [`deploy/supabase-stack/VERSIONS.md`](file:///deploy/supabase-stack/VERSIONS.md)
- [`docs/evidence/2026-09-22-doc-lane/CLAIMS.md`](file:///docs/evidence/2026-09-22-doc-lane/CLAIMS.md)

---

### Production & Rigour Analysis

#### 1. [`deploy/edge-runtime/VERIFICATION.md:11`](file:///deploy/edge-runtime/VERIFICATION.md#L11)
- **Diff:** Replaces the pre-cutover statement that custom-domain TLS, Supabase Management API deactivation, DNS, and rollback have not run with:
  `1. The API cutover is done. This "not established" item is closed.`
- **Production check:** Does not direct an agent or user to contact deleted hosted Supabase (`ukezjcnxjvkpkeezxaew`) or run defunct Management API calls. Items 2 and 3 remain intact to preserve known unverified operational bounds.
- **Rigour check:** Retaining item 1 in place as closed under `## NOT ESTABLISHED` preserves numbered index stability for items 2 and 3 across reference docs and verification audits.
- **Finding:** None.

#### 2. [`deploy/supabase-stack/VERSIONS.md:13`](file:///deploy/supabase-stack/VERSIONS.md#L13)
- **Diff:** Replaces pre-cutover rehearsal instructions (which directed operators to run public version checks and dump the old hosted project) with:
  `The cutover is done. Production is the server yulan-vps-1. Not established: there is no written procedure yet for how image pins are checked. See docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md. PostgreSQL stays on the ruled 17.6.1.x line. Keep the recorded local CLI pins for services that publish no version.`
- **Production check:** Accurately designates `yulan-vps-1` as production and prevents operators from attempting database dumps against deleted Supabase Cloud infrastructure. Explicitly states as NOT ESTABLISHED how image pins are checked.
- **Rigour check:** Preserves rule constraint on PostgreSQL (17.6.1.x) and local CLI pins for unversioned services.
- **Finding:** None.

#### 3. [`docs/evidence/2026-09-22-doc-lane/CLAIMS.md`](file:///docs/evidence/2026-09-22-doc-lane/CLAIMS.md)
- **Structure & Completeness:**
  - Contains exactly 76 original claims from the initial research pass: 70 marked `fixed`, 6 marked `deferred: owner decision` (rows 53, 60–64 on `site/src/pages/privacy.astro`), and 0 marked false.
  - Contains exactly 21 newly discovered claims found during re-run outside the initial list (rows 77–97), all marked `fixed`. Total table entries: 97 rows.
  - Verification of claims directly in scope for Part D1a:
    - Row 25 ([`deploy/edge-runtime/VERIFICATION.md:11-14`](file:///deploy/edge-runtime/VERIFICATION.md#L11-L14)): Marked `fixed`; verified against the diff.
    - Row 35 ([`deploy/supabase-stack/VERSIONS.md:13`](file:///deploy/supabase-stack/VERSIONS.md#L13)): Marked `fixed`; verified against the diff.
  - Documents intentional exclusions and unedited fixtures (e.g., `deploy/edge-runtime/commonswarm.caddy` retained as fallback/fixture while `deploy/supabase-stack/commonswarm-api.caddy` serves live local container routes; CORS allowances in `supabase/functions/`).
  - File counts in the re-run manifest match (8 + 82 + 13 + 165 + 102 + 174 + 2 external brain files = 546 total files).
- **Finding:** None.

---

### Unchecked Dependencies (Deferred to Subsequent Parts)

Because Part D1a only includes the diff for the 3 files listed above, verification of the following claims and targets must be completed in Parts D1b, D2, and D3:
1. **Core Documentation & Runbooks (Part D1b):** Changes in [`AGENTS.md`](file:///AGENTS.md), [`README.md`](file:///README.md), [`SECURITY.md`](file:///SECURITY.md), [`TODO.md`](file:///TODO.md), [`deploy/site/RUNBOOK.md`](file:///deploy/site/RUNBOOK.md), [`deploy/edge-runtime/RUNBOOK.md`](file:///deploy/edge-runtime/RUNBOOK.md), [`deploy/edge-runtime/README.md`](file:///deploy/edge-runtime/README.md), [`deploy/supabase-stack/RUNBOOK.md`](file:///deploy/supabase-stack/RUNBOOK.md), and design specs in [`docs/design/`](file:///docs/design/).
2. **Code & Behavior Changes (Part D2):** Capability link and invite link handling in [`src/cli.ts`](file:///src/cli.ts), [`src/cloud/capability-link.ts`](file:///src/cloud/capability-link.ts), [`src/cloud/config.ts`](file:///src/cloud/config.ts), [`src/cloud/current-target.ts`](file:///src/cloud/current-target.ts), [`src/cloud/invite-link.ts`](file:///src/cloud/invite-link.ts), and [`src/cloud/files.ts`](file:///src/cloud/files.ts).
3. **Test Fixtures & Pins (Part D3):** Verification of assertions in [`tests/p1-cli/cli-errors.test.ts`](file:///tests/p1-cli/cli-errors.test.ts), [`tests/p1-cli/accept-link.test.ts`](file:///tests/p1-cli/accept-link.test.ts), [`tests/p1-cli/edge-runtime-box.test.ts`](file:///tests/p1-cli/edge-runtime-box.test.ts), and site observer tests.
4. **External Files & Owner Decisions:** External brain files (`brain-releases.md`, `brain-shared-host`), referenced document [`docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md`](file:///docs/org/2026-09-22-PRODUCTION-BOX-RESUME-HERE.md), and the 6 deferred items on [`site/src/pages/privacy.astro`](file:///site/src/pages/privacy.astro).

---

VERDICT: PASS - All statements in the three target documents are accurate, eliminate references to deleted infrastructure, correctly document unestablished procedures, and accurately record all 97 claim resolutions.
