### Part E1a Review: `docs/evidence/2026-09-22-doc-lane/CLAIMS.md` and `deploy/supabase-stack/migration.env.example`

#### 1. Scope & Unchecked Dependencies
* **Files reviewed in this part:**
  * [`deploy/supabase-stack/migration.env.example`](file:///deploy/supabase-stack/migration.env.example)
  * [`docs/evidence/2026-09-22-doc-lane/CLAIMS.md`](file:///docs/evidence/2026-09-22-doc-lane/CLAIMS.md)
* **Dependencies outside Part E1a not checked in this call:**
  * The actual file content and diffs of the other 3 review parts (documentation files `AGENTS.md`, `README.md`, `SECURITY.md`, runbooks, CLI code, Edge functions, and tests).
  * Direct execution of gates (`npm test`, `test:p1-cli`, etc.).
  * Verification here is limited to the accuracy of `CLAIMS.md`, the diff in `migration.env.example`, and their alignment with the migration from the deleted hosted project (`cloud-swarm-dev` / `ukezjcnxjvkpkeezxaew` and `coswarm-site.vercel.app`) to the single Hetzner box (`yulan-vps-1`).

---

#### 2. Findings

##### PRODUCTION Findings
* **None.**
  * In `deploy/supabase-stack/migration.env.example:10`, the rehearsal value pointing to `https://ukezjcnxjvkpkeezxaew.supabase.co/storage/v1` was replaced with a clear directive: `# The hosted project's Storage API is gone. Do not set this to a supabase.co host.`, with `SOURCE_STORAGE_URL=` left blank. This prevents agents or operators from attempting to connect to the deleted hosted project.
  * In `docs/evidence/2026-09-22-doc-lane/CLAIMS.md`, all entries accurately catalog the 76 original claims (70 fixed, 6 deferred privacy rows), the 21 re-run findings (all fixed), and the 6 review fold findings (all fixed). No statement instructs an agent or operator to touch a deleted host.

##### RIGOUR Findings: The Pre-Cutover Caddy Fixtures as an Operator Trap
* **Files:** [`deploy/edge-runtime/commonswarm.caddy`](file:///deploy/edge-runtime/commonswarm.caddy), [`deploy/supabase-stack/commonswarm-api-fallback.caddy`](file:///deploy/supabase-stack/commonswarm-api-fallback.caddy), [`deploy/supabase-stack/commonswarm-api-maintenance.caddy`](file:///deploy/supabase-stack/commonswarm-api-maintenance.caddy), [`deploy/edge-runtime/check-caddy-adapted.mjs`](file:///deploy/edge-runtime/check-caddy-adapted.mjs).
* **Concrete Sequence:**
  1. An operator experiencing an incident or performing maintenance on `yulan-vps-1` checks `deploy/supabase-stack/` or `deploy/edge-runtime/` for maintenance or fallback configurations.
  2. Seeing `commonswarm-api-fallback.caddy` or `commonswarm-api-maintenance.caddy` co-located alongside the live configuration [`deploy/supabase-stack/commonswarm-api.caddy`](file:///deploy/supabase-stack/commonswarm-api.caddy), the operator deploys or links one of them to handle degraded traffic.
  3. All incoming production API traffic is forwarded to `ukezjcnxjvkpkeezxaew.supabase.co`, which was deleted on 2026-09-20.
  4. Users and clients immediately receive DNS resolution failures or 502 Bad Gateway responses.
* **Assessment:**
  * Leaving these files with operational names in production deployment directories is indeed a latent operator trap.
  * However, for this lane:
    1. CLAIMS.md and the updated runbooks ([`deploy/edge-runtime/RUNBOOK.md`](file:///deploy/edge-runtime/RUNBOOK.md) row 94 and [`deploy/edge-runtime/README.md`](file:///deploy/edge-runtime/README.md) row 95) explicitly warn that these files must not be copied/installed and that they exist solely as pre-cutover fixtures required by [`check-caddy-adapted.mjs`](file:///deploy/edge-runtime/check-caddy-adapted.mjs) and `tests/p1-cli/supabase-stack.test.ts`.
    2. Because changing or removing them would break the pinned regression tests without a broader refactor of the test suite, keeping them documented as non-live fixtures is acceptable for this pass. In a future cleanup lane, renaming them (e.g., adding `.fixture` or moving them into a `fixtures/` directory) and adding top-of-file warnings would eliminate the hazard entirely.

---

VERDICT: PASS Part E1a correctly eliminates the deleted Storage URL in migration.env.example and accurately accounts for all 103 claims in CLAIMS.md.
