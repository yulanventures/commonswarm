# Changed/new file inventory

Enumerated from Git: **51 files** (23 modified tracked; 28 new). No files deleted.

| File | State | Reason |
| --- | --- | --- |
| `deploy/release-proofs/household-storage/20261004000005-catalog.sql` | New | Byte-identical release copy of the reserve forward catalog. |
| `deploy/release-proofs/household-storage/20261004000005-rollback-catalog.sql` | New | Byte-identical release copy of the reserve inverse catalog. |
| `deploy/release-proofs/household-storage/20261004000005-rollback.sql` | New | Byte-identical release copy of the reserve inverse. |
| `deploy/release-proofs/household-storage/README.md` | Modified | Document migration-05 overlay, original catalog ordering and inverse sequence. |
| `docs/evidence/2026-10-04-household-integration/FILES.md` | New | Enumerated changed/new path inventory with one reason per file. |
| `docs/evidence/2026-10-04-household-integration/LEAD-CHECKLIST.md` | New | Compact review checklist: file groups, C1 conflict functions, grants, proof limits and release order. |
| `docs/evidence/2026-10-04-household-integration/WORKER-REPORT.md` | New | Worker report: scope delivered, new tests, final gate exits and incomplete integration work. |
| `docs/evidence/2026-10-04-household-integration/check-tests-baseline.txt` | New | Actual type-check output from the clean starting-SHA archive using the same dependencies. |
| `docs/evidence/2026-10-04-household-integration/check-tests-current.txt` | New | Actual final draft type-check output; same eight starting-SHA diagnostics. |
| `docs/evidence/2026-10-04-household-integration/focused-tests.txt` | New | Actual final focused Node output: 148 passed, zero failures/skips. |
| `scripts/build-admin-types.mjs` | Modified | Generate household declarations and rewrite their relative edge type imports alongside admin types. |
| `site/src/components/app/LiveDashboard.astro` | Modified | Import/mount household components, add navigation and explicit consent, clear stale workspace/session content. |
| `site/src/lib/household-dashboard.test.mjs` | New | Refused access stops reads; late workspace loads cannot repopulate cleared content. |
| `site/src/lib/household-dashboard.ts` | New | Authenticated paginated object/history loading and 6B save/draft callbacks with generation guards. |
| `src/cli.ts` | Modified | Registry-derived object commands, input-file dispatch, mutability/schema metadata and complete help registration. |
| `src/cloud/household-http.ts` | New | Per-attempt authentication and exact workspace/request wire mapping for the 6A client. |
| `src/mcp/server.ts` | Modified | Dispatch local household tools through 6A and the authenticated HTTP transport. |
| `src/mcp/tools.ts` | Modified | Expose household registry tools in the public local catalog. |
| `src/protocol/household-objects.ts` | Modified | Export the existing pure patch operation for host-side verified proposal preparation. |
| `src/protocol/household-tool-registry.ts` | Modified | Export schema type and one shared local-seat placeholder constant. |
| `src/protocol/index.ts` | Modified | Export household core/policy/registry and canonical pure brain naming helpers into the generated bundle. |
| `supabase/functions/_shared/hosted-seat-auth.ts` | Modified | Admit exact registry tools while preserving capability binding and existing parent/provider liveness checks. |
| `supabase/functions/_shared/household-object-events.d.ts` | New | Generated household/reducer declaration dependency; no hand edits. |
| `supabase/functions/_shared/household-object-policy.d.ts` | New | Generated household/reducer declaration dependency; no hand edits. |
| `supabase/functions/_shared/household-objects.d.ts` | New | Generated household/reducer declaration dependency; no hand edits. |
| `supabase/functions/_shared/household-tool-registry.d.ts` | New | Generated household/reducer declaration dependency; no hand edits. |
| `supabase/functions/_shared/protocol.js` | Modified | Regenerated protocol bundle; no hand edits. |
| `supabase/functions/_shared/reducer.d.ts` | New | Generated household/reducer declaration dependency; no hand edits. |
| `supabase/functions/command/household-attachments.ts` | New | Bound multipart bytes and accept exactly metadata plus protected attachment; reject foreign/extra parts. |
| `supabase/functions/command/household-integration.ts` | New | Prepare verified content/patches, explicit access/connection queries, safe metadata, structured reads/drafts and writes. |
| `supabase/functions/command/household-legacy-adapter.ts` | Modified | Use generated edge type declarations and structural canonical brain-helper injection. |
| `supabase/functions/command/household-legacy-integration.ts` | New | Connect 4B to actual store, aliases, durable receipts/audit and rollback-safe transaction savepoints. |
| `supabase/functions/command/household-objects.ts` | Modified | Use generated edge types, expose host access/state, retain requested legacy aliases and stabilize upload retry digests. |
| `supabase/functions/command/household-permissions.ts` | New | Human-only self/owned-connection consent, exact credential checks, workspace-bound replay digest and transaction provenance. |
| `supabase/functions/command/household-transfers.ts` | Modified | Resolve household event types through generated Deno declarations. |
| `supabase/functions/command/index.ts` | Modified | Authenticate/rout household surfaces, admit bounded protected multipart bytes and fence opted-in legacy file commands. |
| `supabase/functions/mcp/index.ts` | Modified | Registry-driven hosted read/write dispatch with verified seat capabilities. |
| `supabase/functions/mcp/tools.ts` | Modified | Generate household admission/schema/annotations from the canonical registry. |
| `supabase/functions/read/index.ts` | Modified | Reuse verified command transaction for content reads and exact hosted content tools. |
| `supabase/household-storage-reserve/20261004000005-catalog.sql` | New | Exact new grants, unchanged narrow access, RLS/ownership and audit function/trigger fingerprint proof. |
| `supabase/household-storage-reserve/20261004000005-rollback-catalog.sql` | New | Check new privileges/triggers/function are removed and prior SELECT/key-column lock grants remain. |
| `supabase/household-storage-reserve/20261004000005-rollback.sql` | New | Remove only new grants/triggers/function; retain existing consent, audit and lock grants. |
| `supabase/migrations/20261004000005_household_permission_provisioning.sql` | New | Three INSERT/eight column UPDATE grants, provenance-enforcing permission audit triggers and commented exact inverse. |
| `tests/hosted-mcp-protocol.test.ts` | Modified | Expect 13 admitted tools with protected file transport OFF, preserving original coordination schema assertions. |
| `tests/household-integration.test.ts` | New | New hosted admission/annotations and protected multipart positive/negative boundary tests. |
| `tests/lists/test.txt` | Modified | Register only this packet's new household-integration and household-feature-gates tests. |
| `tests/lists/test:p1-server.txt` | Modified | Register only the new household-permission-provisioning test; existing glob deduplicates it. |
| `tests/p1-cli/household-integration.test.ts` | New | New HTTP transport/authentication/retry and shipped CLI help tests. |
| `tests/p1-server/household-permission-provisioning.test.ts` | New | New isolated PostgreSQL permission provenance, independent confirmation, audit and inverse proof; CI only. |
| `tests/p1-server/household-storage.test.ts` | Modified | Undo/check overlay 05 inside the existing transaction before original exact catalogs and inverses. |
| `tests/support/admin-issuer-privileges.json` | Modified | Eleven new reasoned household ACL entries; existing key-lock entries retain their values. |

Generated ignored runtime artifacts (`dist/`, `dist-release/`, `services/mcp-auth/src/management-command.generated.js`) were rebuilt locally and are not delivery changes. Package files/lockfiles, OAuth scopes/provider consent code and original migrations 01–04 are unchanged.

Security fold against `92a21537` adds `supabase/functions/_shared/household-feature-gates.ts`
and `tests/household-feature-gates.test.ts`, and modifies `command/index.ts`,
`mcp/tools.ts`, `tests/household-integration.test.ts`, the hosted protocol test and
`tests/lists/test.txt`. Gate definitions and real admission tests make the three
incomplete paths default OFF. `LEAD-CHECKLIST.md` lists activation prerequisites;
`FOLD-REPORT.md` records the refutation/fix/test table and final gate exits.
The new `fold-*.txt` files retain regression baseline, focused test, generation,
build and type-check output. The generated core was regenerated unchanged.

## Fold 2 — CI repair

[FOLD2-REPORT.md](FOLD2-REPORT.md) records the incremental file inventory, causes,
fixes and gate exits. Fold 1 remains in place. Dispatcher shards and focused
service-free checks pass. `check:tests` retains the same eight diagnostics; real
server proofs and the host-blocked `ps` test remain CI work. No commit or push.
