# Hosted seat name reclaim 010

Apply `20261004000010_hosted_seat_name_reclaim.sql` after
`20261004000006_household_human_invitations.sql`, then run the 010 catalog.
Apply and roll back in a transaction through the reviewed release procedure.
This lane changes no grants or ACLs.

The catalog proves that the old permanent name constraint is gone and that the
workspace/name index is unique, valid, and partial on `revoked_at IS NULL`, with
exactly the two required columns and the expected definition.
The rollback restores the original named `(grant_id, workspace_id, name)`
constraint and drops the live-name index. The rollback catalog proves both.
The three reserve SQL files are byte-identical to the release-proof files.

Rollback is valid only while no two seats share `(grant_id, workspace_id, name)`.
After a same-grant reclaim exists, ADD CONSTRAINT fails. In a transaction,
rollback changes nothing; never delete historical seats to force it through.
The old edge is safe on the forward schema: it refuses every reused name.
Migration 010 can stay in place when the edge is rolled back.

No schema or runtime change was applied by this lane.
