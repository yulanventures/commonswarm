# Household approval until withdrawn

Apply `20261004000015_household_approval_until_withdrawn.sql` after migration
`20261004000010` and the existing household migrations 001–006, using the reviewed
release procedure. Run `20261004000015-catalog.sql` before enabling the new edge.
It proves nullable expiry, the exact audited three-command function, its owner,
search path and restricted EXECUTE ACL, all three triggers, and unchanged table
and column privileges from migration 005.

For rollback, restore the old edge and run `20261004000015-rollback.sql`, then
`20261004000015-rollback-catalog.sql`. The rollback restores the migration 005
function body exactly with CREATE OR REPLACE, keeping its owner and ACL. The
rollback catalog checks the hash of `prosrc` and the retained grants and triggers.

Leave `expires_at` nullable. The old edge refuses NULL approvals because its
policy requires a finite expiry, so it fails closed; people allow their agents
again. Never delete or rewrite consent or audit rows. Forward, rollback and
rollback-catalog SQL have byte-identical reserve copies in
`supabase/household-approval-reserve/`.

No schema or runtime change was applied by this lane.
