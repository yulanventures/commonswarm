# Household approval until withdrawn

Apply `20261004000015_household_approval_until_withdrawn.sql` after migration
`20261004000010` and the existing household migrations 001–006, using the reviewed
release procedure. Run `20261004000015-catalog.sql` before enabling the new edge.
It proves nullable expiry, the exact audited three-command function, its owner,
search path and restricted EXECUTE ACL, all three triggers, and unchanged table
and column privileges from migration 005.

For rollback, first restore the old edge. In one PostgreSQL session, run `BEGIN;`,
then `20261004000015-rollback.sql` and `20261004000015-rollback-catalog.sql` inside
that same outer transaction. Run `COMMIT;` only when `rollback_ok` is `t`;
otherwise run `ROLLBACK;`. The release wrapper in `deploy/RELEASE-TO-BOX.md`
autocommits each statement unless an explicit outer transaction is used, so
running the files separately does not provide an atomic rollback and proof.
The rollback file itself must not contain `COMMIT`: the household-storage drill
pastes it inside its own `BEGIN`/`ROLLBACK` transaction.

The rollback restores the migration 005
function body exactly with CREATE OR REPLACE, keeping its owner and ACL. The
rollback catalog checks the hash of `prosrc`, the retained grants and triggers,
the restored NOT NULL expiry column with no comment, and the absence of NULL expiries.

The rollback writes `expires_at = clock_timestamp()` to every connection row
whose expiry is NULL, ending those until-withdrawn approvals. It then restores
`expires_at` to NOT NULL and removes the column comment, as in migration 001.
The old edge already refuses NULL approvals because its policy requires a finite
future expiry, so ending them changes no access under that edge; people allow
their agents again. Rows with an existing expiry keep it. No connection rows are
deleted, and consent and audit rows are kept unchanged.

Replaying an earlier approve with the same request id returns its stored success,
including `expires_at: null`. It does not restore access: the connection row
remains ended. Allowing the agent again requires a new request id; the old edge's
behaviour for that new request is outside this proof's scope.

Forward, rollback and
rollback-catalog SQL have byte-identical reserve copies in
`supabase/household-approval-reserve/`.

No schema or runtime change was applied by this lane.
