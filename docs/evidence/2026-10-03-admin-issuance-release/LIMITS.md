# Execution limits and required follow-ups

This directory is a reviewable preparation, not a production-ready activation
plan. Stop the affected window before mutation when any named input is absent.

| Window | Exact missing support / required input | Stop behavior |
| --- | --- | --- |
| W1 | Box measurements; actual historical released-SHA archives for every applied migration; current backup verification; independent real PostgreSQL upgrade/reserve/ACL/D2/D3 receipts; reviewed live authenticated ordinary MCP/DCR/CIMD/human/worker probe procedure and protected client inputs | No apply without them. The plan includes anonymous route probes, but these cannot stand in for the live authenticated procedure. Its execution blocks must be incorporated in a newly reviewed revision before open. |
| W2 | Same-build capped image and ordinary path evidence; box baseline and source-compatible two-file Compose configuration | No guessed baseline/config; no issuer credential is installed here. Gate closed is proven at AS loopback before Caddy exists. |
| W3 | Explicit irreversible terminal-fence approval; actual Caddy import/route baseline; exact edge image/override; same-build legacy-unreachable/DB-fence proofs | Stop on baseline drift. Recycle is paused/restored within this window; closing issuance and invalidating the release record precede each source change. |
| W4 | Generalized site's exact named inputs, explicit headless QA assignment and build/lifecycle/CI receipts | No execution of browser blocks without that assignment; no production release by this preparation worker. |
| W5 | `services/mcp-auth/src/admin-consent.js` exports `ADMIN_AS_ISSUANCE_ENABLED = false`; there is no production activation config. `deploy/mcp-auth/compose.yaml` / `compose.management.yaml` do not mount the optional `MCP_OAUTH_ADMIN_ISSUER_DATABASE_CREDENTIALS_FILE`. No reviewed production issuer credential provisioning/rotation step accompanies them. `services/mcp-auth/src/admin-gate.js` timeout races the coordinator without AbortSignal. The global authenticated `admin_clients` registry decision in 05 is unsettled. The existing six-hour `commonswarm-edge-recycle.service` restarts edge without release-record invalidation/remeasurement. Generic edge release/recreation/rollback plans likewise need this sequence before activation. | Explicit implementation STOP even with approval. Do not flip only the database row, patch the image or invent a switch. A new code/plan revision and complete same-build gates are required. |
| W6 | Hard-false pin; no checked-in production admin client smoke runner with saved command IDs, hosted full-account second confirmation, token/DPoP-nonce/store/refresh/audit/cleanup handling. `scripts/dcr-roundtrip.mjs` is ordinary MCP, Bearer and hidden stdin, not the task-described callback-file protocol. No verified reviewer client/owner approval/live C1 receipt is supplied. | Intentional `smoke-runtime-path-unavailable` and `smoke-runtime-delivery-unavailable` FAIL, before files/consent/workspace mutations. Complete private authorize-URL/callback-wait/pointer-cleanup blocks are prepared in RELEASE.md, behind the STOP gate and an independent live gate-open check. Token exchange and audited MCP action/cleanup runner blocks still need a separate reviewed implementation task. |
| W7 | Explicit retirement approval and a real C1 report cannot currently be supplied through this build | Refuse without approval/C1. Runtime mint is already removed by lane 5; DB closure is W3. W7 attests final retirement and never drops history or restores opaque access. |

The requested `tests/plan-baseline-inputs.test.ts` example does not exist in the
supplied tree. This lane creates it using the existing line-anchored shell-block
parser convention (`tests/plan-readonly-marker.test.ts` and
`tests/box-window-plans.test.ts`), adds executable input/approval negative
controls and syntax-checks complete shell/Python bodies with Bash 3.2.

The reserve siblings are byte copies, not rewritten inverses. Their actual
database verification belongs to the required independent same-build schema
receipt. No Docker/database suite ran in this worker. A successful W1 makes
04's inverse refuse because checksum evidence exists; retain additive schema.
No reserve deletes evidence to make itself usable. Future activation must also
require recovery migration 05 (the present zero-argument checksum function
checks 01–04); this plan independently reconciles 05 and includes it in the
expected set and named activation proof contract.
