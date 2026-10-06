# Household member removal

Apply `20261005000001_household_member_removal.sql` after migration
`20261004000015`, using the reviewed release procedure. Run
`20261005000001-catalog.sql` before enabling the new edge. It proves the
audited function now accepts `remove_member` as a fourth command kind, and
that owner, search path, EXECUTE ACL, the three triggers, and table and column
privileges are unchanged from migration 015.

Before applying, run `20261005000001-precount.sql` and retain its one row in
the release notes. Each count is revoked memberships with at least one
affected row, not a count of content rows or invitations. Absent household
tables return zero; the query performs reads only. The fourth count covers
unaccepted delegated invitations, including expired ones.
In one release transaction at READ COMMITTED, run the migration, then the
precount again. If any count is nonzero, ROLLBACK and retry; commit only when
all four counts are zero. The repair locks workspaces that already have a
revoked membership. A first removal in another workspace can still run, and
the recount catches only removals committed before that recount's snapshot.
The locks do not protect the interval after the migration commits.
Catalog proofs check structure only; later data changes do not invalidate them.

After the new edge is live and all requests using the previous edge have
finished, run `20261005000001-precount.sql` again and retain the row in the
release notes. This check is required even if the migration recount was zero:
the previous edge can make membership-only removals between schema and edge
release. If any count is nonzero, run `BEGIN ISOLATION LEVEL READ COMMITTED;`,
then `20261005000001-backfill.sql` as the privileged migration operator, then
the precount in that same session. If any count is still nonzero, ROLLBACK and
retry; otherwise COMMIT. Retain the before and after rows. Do not declare the
repair complete until this check after the edge switch reports four zeros.
The release-proof backfill is the migration's verbatim idempotent DO block;
it does not replace the trigger function or change the migration ledger.

The migration also repairs previously removed members: it revokes their live
content roles, every owned content connection (including expired ones), all
unaccepted delegated invitations, and unconsumed, unrevoked, unexpired link
invitations matched by the person's stored email in that workspace. Both kinds
of invitation are repaired only when created at or before the removal; later
re-invitations stay unchanged. It locks
workspaces, memberships, roles, connections, delegated invitations, then link
invitations, in stable key order. Live members and existing revocations stay
unchanged; rerunning the repair with no new removals writes nothing. Revocation
timestamps use the membership's `revoked_at`, preserving the actual removal time. Pending link
expiry is evaluated once at statement time. No consent or history is rewritten.

The live content trigger records the removing human's audit. For historical
removals that actor and request are unknown, and the audit schema requires a
non-null human `actor_user`. The privileged backfill therefore writes no audit
rows rather than attribute a system repair to a person. Existing audit rows
are preserved. The SQL repair also writes no `InvitationRevoked` events for
link invitations, so these historical revocations do not appear in activity
history. Release notes retain the before and after counts as repair evidence.
The repair locks every workspace with a revoked membership until the release
transaction commits; concurrent work in those workspaces waits for that commit.

For rollback, first restore the previous edge. In one PostgreSQL session, run
`BEGIN;`, then `20261005000001-rollback.sql` and
`20261005000001-rollback-catalog.sql` inside that same outer transaction. Run
`COMMIT;` only when `rollback_ok` is `t`; otherwise run `ROLLBACK;`. The
release wrapper in `deploy/RELEASE-TO-BOX.md` autocommits each statement
unless an explicit outer transaction is used, so running the files separately
does not provide an atomic rollback and proof. The rollback file itself must
not contain `COMMIT`.

The rollback restores the migration 015 function body exactly with CREATE OR
REPLACE, keeping its owner and ACL. It does not delete, truncate, or update
roles, connections, consent receipts, invitations, or audit rows. Nullable
connection expiry from migration 015 stays nullable.
Every revocation written by the backfill stays in place after the reserve
rollback: data is preserved, as in the other household rollbacks. The
rollback-catalog proof checks the restored function and unchanged privileges.
It remains valid after a later re-invitation or a membership-only removal by
the restored edge; it does not require repaired data to stay in a fixed state.

Removal does not recall a signed download URL issued before it; such a URL expires within 300 seconds.

Catalog, rollback, rollback-catalog and backfill SQL have byte-identical reserve copies
in `supabase/household-member-removal-reserve/`.

Follow-up: members removed by the previous edge who rejoined before this
repair have `memberships.revoked_at=NULL`. This repair cannot identify their
old content approvals from that row; they are outside its revoked-membership
scope. A separate history-based review is needed for that population.
