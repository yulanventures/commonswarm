# Post-C1 household integration — Lead checklist

**DRAFT, incomplete; do not activate.** Branch `lane/hh-int-packet`, starting SHA
`38986a9aa6c2fd8d92ee138efc87f6fe48921a69`. No commit, push, CI dispatch or deployment.
The [file inventory](FILES.md) enumerates every changed/new file and its reason;
the [worker report](WORKER-REPORT.md) records gates and incomplete work.

| Files (each brace item is a separate file) | Reason |
| --- | --- |
| `src/protocol/{index.ts,household-objects.ts,household-tool-registry.ts}`; `scripts/build-admin-types.mjs` | Export reducer/registry, share patch and local-seat constants, generate edge types. |
| `supabase/functions/_shared/{protocol.js,household-object-events.d.ts,household-object-policy.d.ts,household-objects.d.ts,household-tool-registry.d.ts,reducer.d.ts,hosted-seat-auth.ts}` | Generated core/types; exact hosted-tool capability with existing live-parent checks. |
| `supabase/functions/command/{index.ts,household-objects.ts,household-transfers.ts,household-legacy-adapter.ts,household-integration.ts,household-permissions.ts,household-legacy-integration.ts,household-attachments.ts}` | Verified identity dispatch, content consent, storage preparation and legacy translation. |
| `supabase/functions/{read/index.ts,mcp/index.ts,mcp/tools.ts}` | Authorized content reads and registry-derived hosted admission. |
| `src/{cloud/household-http.ts,mcp/server.ts,mcp/tools.ts,cli.ts}` | Local authenticated transport, MCP tools, registry CLI commands/help. |
| `site/src/{components/app/LiveDashboard.astro,lib/household-dashboard.ts,lib/household-dashboard.test.mjs}` | Mount 6B, explicit human consent, paginated reads and session/workspace clearing. |
| `supabase/migrations/20261004000005_household_permission_provisioning.sql`; `tests/support/admin-issuer-privileges.json` | Audited provisioning and eleven new reasoned ACL entries. |
| `supabase/household-storage-reserve/20261004000005-{catalog.sql,rollback.sql,rollback-catalog.sql}`; `deploy/release-proofs/household-storage/20261004000005-{catalog.sql,rollback.sql,rollback-catalog.sql}`; `deploy/release-proofs/household-storage/README.md` | Matching proof/inverse copies and overlay sequencing. |
| `tests/{household-integration.test.ts,hosted-mcp-protocol.test.ts,p1-cli/household-integration.test.ts,p1-server/household-permission-provisioning.test.ts,p1-server/household-storage.test.ts,lists/test.txt,lists/test:p1-server.txt}` | Admission/attachment/transport/help/SQL tests; preserve coordination assertions; undo 05 before older catalog drill; register only new files. |
| This directory: `LEAD-CHECKLIST.md`, `FILES.md`, `WORKER-REPORT.md`, `focused-tests.txt`, `check-tests-baseline.txt`, `check-tests-current.txt` | Review inventory, limitations and measured evidence. |

**C1 conflict points:** `command/index.ts`: `handleTransaction`, `readBody`,
`hostedToolAllowsCommand`, command/workspace-kind lists; `read/index.ts`:
`handle`, `handleHostedRead`; `mcp/index.ts`: seat capability and tool
execution; `mcp/tools.ts`: table/validation; `hosted-seat-auth.ts`: `resolveSeat`
and content revalidation. Also reconcile protocol exports/type generation,
`LiveDashboard` workspace/session navigation, CLI command/help tables, local MCP
dispatch, issuer ACL inventory and the schema window. Regenerate the ignored
management command artifact from the reconciled source; never merge generated
bundle hunks independently. B/C/D admin implementation and OAuth provider files
are unchanged. **OAuth scope changes: none.**

**Grant review:** only command INSERT on the three consent tables; column UPDATE
on role/receipt/time/revocation and connection operations/receipt/expiry/revocation.
No DELETE or table UPDATE. Existing key-column lock grants remain. Review the
invoker audit trigger, human-only self-confirmation, owner-only initial boundary,
workspace-bound replay digest, exact credential binding, reader ceiling and
24-hour hosted/credential-expiry local consent. The inverse preserves consent/audit.

**Proof:** focused 148/148; core/build/edge exit 0; test type-check exit 2, identical
eight starting-SHA diagnostics. New root test owns hosted admission/protected
multipart parsing; new CLI test owns HTTP dispatch/auth refresh/help; new site
test owns stale-load clearing/refusal guidance. New server test owns ACL/audit/
rollback; touched storage test owns overlay inversion. Server/browser suites and
the SQL proofs remain CI work; [WORKER-REPORT.md](WORKER-REPORT.md) names their limits.

**Release order:** close C1 → resolve conflicts and remaining transport/legacy
blockers → HezLead's cross-family check and CI → reviewed exact SHA on `main` →
Anvil under HezLead applies 01–04 with their catalogs, then 05 with its catalog →
edge/management → site/CLI → explicit content consent. For an inverse drill,
undo 05 first. Household pilots still require Tom's authorization.
