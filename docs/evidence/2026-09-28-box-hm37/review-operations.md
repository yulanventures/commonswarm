# Operations Review: Production Release Plan `BOX-WINDOW.md` (v2)

**Target Surface:** CommonSwarm HM Lanes 3 and 7 (DARK)
**Release SHA:** `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d`
**Previous Edge:** `72c57e0d76d0aa86fe4f811a2cf51499919fed20`
**Migration:** `20260928000004_hm_hosted_check.sql`

---

## Technical Audit & Verification Summary

### 1. Release Inventory & Edge Diff Recomputation
- **Exact Path Count:** Verified. The diff `git diff --name-only 72c57e0d e1faa08e -- supabase/ deploy/edge-runtime/` contains exactly 13 paths, matching [BOX-WINDOW.md lines 69-86](local path):
  1. `deploy/edge-runtime/env.example`
  2. `deploy/edge-runtime/main/index.ts`
  3. `deploy/edge-runtime/main/router.ts`
  4. `supabase/functions/_shared/hosted-seat-auth.ts`
  5. `supabase/functions/_shared/protocol.js`
  6. `supabase/functions/command/index.ts`
  7. `supabase/functions/mcp/auth.ts`
  8. `supabase/functions/mcp/deno.json`
  9. `supabase/functions/mcp/index.ts`
  10. `supabase/functions/mcp/protocol.ts`
  11. `supabase/functions/mcp/tools.ts`
  12. `supabase/migrations/20260928000003_hm_oauth_store.sql`
  13. `supabase/migrations/20260928000004_hm_hosted_check.sql`
- **Changed Functions & Expanded Inventory:** Directly changed entry points are `command` and `mcp`. Because `router.ts` changed (`ROUTER_CHANGED=yes`), Section 1 expands the worker inventory to all 6 functions: `command read capability activity h0 mcp` ([BOX-WINDOW.md lines 87-88](local path); [deploy/edge-runtime/main/router.ts lines 1-8](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/edge-runtime/main/router.ts#L1-L8)).
- **Environment Inventory:** Comparing `deploy/edge-runtime/env.example` between base and release SHAs adds only `SWARM_MCP_PUBLIC_ENABLED` ([BOX-WINDOW.md lines 112-118](local path)). No new required edge environment names exist (`ADDITIONAL_REQUIRED_ENV_NAMES=''`).
- **Release Proof Files & Checksums:** Staged checksums in Section 6 ([BOX-WINDOW.md lines 315-320](local path)) match the exact proof files under `deploy/release-proofs/item-hm/`:
  - `20260928000004-catalog.sql`: `1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1`
  - `20260928000004-functional.sql`: `26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659`
  - `20260928000004-rollback.sql`: `69053ccac11d4c5ae13cef447950130fdf2b7bef2c490f62d61c8e043bdf1c29`
  - `20260928000004-rollback-catalog.sql`: `f8cf2a14ae112a927674150ad5c7d50144c9ff3d37a168cbb94ece8a71102aed`

### 2. Catalog & Functional Proof Integrity
- **Pre-apply False Without Error:** In `deploy/release-proofs/item-hm/20260928000004-catalog.sql` ([lines 4-28](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-catalog.sql#L4-L28)), all lookups use `to_regclass` and `to_regprocedure`. Unapplied tables/functions evaluate safely via `LEFT JOIN` and `COALESCE` to `catalog_ok = f` without throwing exceptions. Verified in automated suite [tests/p1-server/hosted-check.test.ts lines 345-362](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/tests/p1-server/hosted-check.test.ts#L345-L362).
- **Structural Function Contract Checks:** `20260928000004-catalog.sql` ([lines 108-185](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-catalog.sql#L108-L185)) checks OID return types, arg types, `pg_proc` properties, and explicit non-dependency on `swarm_read.signals` (`pg_depend`) rather than deparsing/text-matching source code.
- **Privilege Granularity:** Every role (`swarm_command`, `swarm_read`, `authenticated`, `anon`) and privilege (`SELECT`, `INSERT`, `UPDATE`, `EXECUTE`) is asserted individually ([lines 13-25, 114-117, 157-160](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-catalog.sql#L13-L25)).
- **Rollback Order & Inverse SQL:** Section 11 ([BOX-WINDOW.md lines 705-791](local path)) enforces Edge rollback first, SQL second. Step `hm37-reserve-schema-rollback` uses the exact verbatim inverse from `20260928000004-rollback.sql` ([lines 5-16](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-rollback.sql#L5-L16)).

### 3. Read-Only Prerequisites & Pre-Conditions
- Section 3 ([BOX-WINDOW.md lines 138-171](local path)) mandates 12 pre-opening read-only checks, including HM2 (migration 02 applied), HM6 live state (migration 03 applied, OAuth service healthy, discovery/JWKS served, public authorization off), edge `SWARM_MCP_PUBLIC_ENABLED` off, and migration 04 absent.

### 4. Controls & Boundary Verifications
- **Hosted Controls:** Section 9 ([BOX-WINDOW.md lines 584-639](local path)) defines the 11 required observation steps, explicitly covering concurrent opens, upper-case UUID ACK formatting, repeated ACK idempotency, cursor advancement validation, and cleanup.
- **Local & Stdio MCP Controls:** Section 10 ([BOX-WINDOW.md lines 641-700](local path)) validates `cswarm 0.1.80` credential shape (4 required fields), delivery ACK observation (`ack_outcome=observed`), wake eligibility, and stdio MCP cursor advancement.

### 5. Runnable Blocks & Shell Compatibility
- **Step Structure:** Every executable block is isolated in its own ` ```sh ` block starting with `# step: <id>` ([BOX-WINDOW.md lines 92, 228, 263, 361, 415, 484, 661, 720](local path)).
- **macOS `/bin/bash 3.2` Standards:** All Mac mini blocks avoid incompatible constructs (`${var,,}`, `mapfile`, `wait -n`, `|&`, `&>>`, associative arrays, or heredocs inside command substitution `$(...)`). Heredocs are passed directly to `python3` or `ssh` commands.
- **Principal Naming:** Section 4.1 ([BOX-WINDOW.md lines 215-224](local path)) derives all temporary principal names strictly from `WINDOW_PRINCIPAL_SUFFIX` (`hm37-hosted-${WINDOW_PRINCIPAL_SUFFIX}`, `hm37-local-${WINDOW_PRINCIPAL_SUFFIX}`, `hm37-sender-${WINDOW_PRINCIPAL_SUFFIX}`).

---

## Nits (Non-Blocking Recommendations)

- **Nit 1 (Prose detail):** In Section 5 `hm37-backup-gate` ([line 274](local path)), `date +%s` is invoked within bash over SSH on the Hetzner host (Linux GNU coreutils). While valid and functional on both Linux and macOS, explicit POSIX arithmetic comments can be added for clarity.

---

VERDICT: PASS (no KEEP)