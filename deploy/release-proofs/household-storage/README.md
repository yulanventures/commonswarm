# Household storage lane H2

Prepared modules and schema, not activated routes or release evidence. No schema
application, server run, commit, push, or deployment occurred in this lane.

Apply IDs 20261004000001 through 20261004000004 in order only after the reviewed
C1 schema window. Dependencies are existing workspace, membership, principal,
hosted grant/seat, file/version and Storage tables; no C1-only object is referenced.

Each ID has a forward catalog, exact reserve rollback, and rollback catalog.
The rollback in `supabase/household-storage-reserve/` is byte-identical to its
release-proof copy and is also retained as commented SQL in the migration.
Reverse rollbacks remove H2 data and restore the prior file view and purge body.
Run only through an approved release procedure. The server test runs them inside
one transaction and rolls that transaction back.

## Integration contract for lane 4

`createHouseholdObjectStore` receives the lane-1 core and policy exports, the
household transfer module, the existing `fileContentAllowed` predicate, Storage,
and a mandatory credential recheck. This keeps source imports type-only until
lane 4 regenerates the protocol bundle. Direct Deno type checks of these prepared
modules use `--sloppy-imports` to resolve the source's `.js` type imports.

Call write/read/byte methods inside `db.begin`, using the command role. Identity
comes from verified host authentication, never request content. Recheck must
validate the actual session or agent credential/handle, including token, run,
device, principal and parent-grant withdrawal/expiry. It must respect the host's
lock order. The module independently locks and checks membership, explicit
content consent, member ceiling, connection purpose/operations/expiry and hosted
parent grants/workspace bindings/seats. Provision boundary, role and connection
rows only through lane 4's audited, human-confirmed commands; no permissions are
backfilled from administrative roles or ordinary MCP consent.

Reads return authorized metadata; `readBytes` returns a bounded buffer after
verifying its recorded size/digest and checking access again. The host decodes
list/doc buffers for bounded object reads, supplies protected file attachments,
enforces the measured pagination/read bounds from lane 4,
and renders Markdown/file metadata as untrusted content. Never expose the
service credential, a signed URL, or a local path in model text.

For upload-begin, supply a protected attachment's bytes with the core reserve
command. H2 stages and measures them before returning `pending`. Commit loads
and measures that reservation again, then rechecks rights and base under the
workspace lock. This follows lane 1's verified-content reservation contract;
there is no model-visible presigned upload credential. Explicit release queues
bytes for the existing purge drain and frees their declared storage quota.

New managed keys use `<workspace>/<stable file UUID>/<immutable version UUID>`
in the existing private bucket, with ordinary numeric `version_n` rows retained.
Using an immutable UUID prevents a successful PUT followed by a DB rollback
from blocking the next version behind upsert-off. Existing keys are unchanged.
As with the existing file path, Storage cannot roll back with PostgreSQL; a blob
from a rolled-back transaction is collected by the existing orphan sweep after
three hours. The host must keep transaction failure responses truthful and use
its durable failure/audit path, including abnormal failed-attempt metering; a thrown I/O error is never a committed receipt.

Private H2 events and projection receipts remain inaccessible to member/raw
workspace-event readers. Lane 4 must integrate their canonical stream/reducer
routing without exposing other people's drafts, migrate legacy file mutations,
fence every legacy command/read/byte route with the same content rights, and
bridge existing brain files as docs. H2 hides managed objects from the existing
member-only file view and protects them from the legacy purge cron, but does not
change HTTP dispatch or the existing signed-URL handlers.

## CI ownership

`tests/p1-server/household-storage.test.ts` is registered by the existing
`test:p1-server` glob. It uses the local stack and real private Storage. Cases
cover concurrent stale writes and private drafts, exact retries, member and
connection ceilings, hosted grant withdrawal, measured digest failures,
reservations surviving legacy pending GC, quota/name races, shared durable write ceilings and recovery, retired-byte reads,
failed transaction recovery, immutable artifact/event rows, catalog drift and
reverse rollback. They require CI; none ran on this worker.

The local gate results are reported separately. A direct Deno check covers the
prepared modules because the required `check:edge` gate only visits activated
entry points. HezLead owns the independent family check and subsequent CI.

## Worker report

24 new files: two modules, four migrations, four reserve rollbacks, twelve SQL
release proofs, this integration note, and one server test file with eleven cases.
No pre-existing tracked file was edited.

| Required local gate | Exit | Result |
| --- | --- | --- |
| `npm run build` | 0 | Passed |
| `npm run check:edge` | 0 | Passed; activated entry points only |
| `npm run check:tests` | 2 | 111 existing diagnostics, identical with H2 excluded |
| `node --import tsx --test tests/household-objects.test.ts` | 0 | 16 passed |

The prepared modules also passed a direct Deno check with `--sloppy-imports`.
All required gates used `env HOME="$T"` with a worker-created absolute temporary
home. Dependencies were absent initially and installed with `npm ci --ignore-scripts`.

Implementation choices for review: upload-begin stages a verified protected
attachment before returning pending, as lane 1 requires; new managed keys use
immutable version UUIDs rather than numeric path suffixes. Existing keys remain
valid. Canonical routing, legacy/brain parity, credential adapters, activation
metering and host failure recovery are lane 4 dependencies, not live claims.
Server tests/catalogs/rollback have not run. HezLead arranges the family check
and CI. No Actions run was triggered.

## Draft integration overlay 05

The post-C1 packet adds `20261004000005_household_permission_provisioning.sql`.
It grants command-role INSERT on the three consent tables and column UPDATE on
confirmed role/receipt/time/revocation and connection operations/receipt/expiry/revocation.
Human confirmation is explicit and audited; memberships and OAuth grants are not backfilled.
No table UPDATE, DELETE, public content access or OAuth scope is added.

Run catalogs 01–04 before applying 05, then the 05 catalog. Catalog 01 deliberately
rejects the permissions that 05 adds; it is not a post-05 aggregate catalog.
For an inverse drill, undo 05 and verify its rollback catalog before testing or
undoing 01–04. The 05 inverse preserves existing consent and audit rows.
All three 05 proof files have byte-identical reserve/release copies; the inverse
is also included verbatim as commented SQL in the migration.

See [the integration checklist](../../../docs/evidence/2026-10-04-household-integration/LEAD-CHECKLIST.md)
for the incomplete transport/legacy work and the required review/CI sequence.
This packet does not authorize applying schema or activating household content.
