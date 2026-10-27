-- Restore every row 20261025000001 changed to the exact values recorded in
-- swarm.permanence_grandfather_journal. Run inside one transaction as a
-- swarm_admin member; the owner-only conversion carve-out and the approval
-- family binding guard refuse the reverse direction, so both guard triggers are
-- disabled for this transaction only and re-enabled before it ends.
-- Kept on purpose: hosted resource binding rows (append-only; the pre-permanence
-- OAuth runtime already accepted such rows from the 20261003000001 backfill),
-- the journal and both proof functions (evidence; no runtime references them).
SET ROLE swarm_admin;
ALTER TABLE swarm.renewal_grants DISABLE TRIGGER renewal_grants_spend_or_revoke_only;
ALTER TABLE swarm.household_content_connections DISABLE TRIGGER aa_household_local_family_binding;
DO $restore$
DECLARE j record; n integer;
BEGIN
  FOR j IN SELECT * FROM swarm.permanence_grandfather_journal
    WHERE action IN ('converted','bound') AND restored_at IS NULL ORDER BY entry_id DESC
  LOOP
    IF j.action='converted' THEN
      UPDATE swarm.renewal_grants
        SET kind=j.previous->>'kind', max_successors=(j.previous->>'max_successors')::integer,
            horizon_expires_at=(j.previous->>'horizon_expires_at')::timestamptz
        WHERE renewal_grant_id=(j.row_key->>'renewal_grant_id')::uuid;
    ELSE
      UPDATE swarm.household_content_connections
        SET connection_id=(j.previous->>'connection_id')::uuid, renewal_grant_id=NULL,
            expires_at=(j.previous->>'expires_at')::timestamptz
        WHERE connection_id=(j.row_key->>'connection_id')::uuid AND grant_id=(j.row_key->>'grant_id')::uuid
          AND workspace_id=(j.row_key->>'workspace_id')::uuid AND principal_id=(j.row_key->>'principal_id')::uuid;
    END IF;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n<>1 THEN
      RAISE EXCEPTION 'permanence grandfather rollback: journal entry % matched % rows', j.entry_id, n;
    END IF;
    UPDATE swarm.permanence_grandfather_journal SET restored_at=clock_timestamp() WHERE entry_id=j.entry_id;
  END LOOP;
END $restore$;
ALTER TABLE swarm.household_content_connections ENABLE TRIGGER aa_household_local_family_binding;
ALTER TABLE swarm.renewal_grants ENABLE TRIGGER renewal_grants_spend_or_revoke_only;
RESET ROLE;
