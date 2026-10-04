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
rollback catalog checks the hash of `prosrc`, the retained grants and triggers,
the restored NOT NULL expiry column with no comment, and the absence of NULL expiries.

The rollback writes `expires_at = clock_timestamp()` to every connection row
whose expiry is NULL, ending those until-withdrawn approvals. It then restores
`expires_at` to NOT NULL and removes the column comment, as in migration 001.
The old edge already refuses NULL approvals because its policy requires a finite
future expiry, so ending them changes no access under that edge; people allow
their agents again. Rows with an existing expiry keep it. No connection rows are
deleted, and consent and audit rows are kept unchanged. Forward, rollback and
rollback-catalog SQL have byte-identical reserve copies in
`supabase/household-approval-reserve/`.

No schema or runtime change was applied by this lane.
