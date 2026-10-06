# Household member removal

Apply `20261005000001_household_member_removal.sql` after migration
`20261004000015`, using the reviewed release procedure. Run
`20261005000001-catalog.sql` before enabling the new edge. It proves the
audited function now accepts `remove_member` as a fourth command kind, and
that owner, search path, EXECUTE ACL, the three triggers, and table and column
privileges are unchanged from migration 015.

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

Forward, rollback and rollback-catalog SQL have byte-identical reserve copies
in `supabase/household-member-removal-reserve/`.
