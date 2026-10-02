-- swarm_command keeps INSERT-only access to the raw event log. Replay is a
-- private read for exactly one workspace, grant and locked workspace stream.
-- No future event column or payload key becomes readable automatically.
DROP VIEW IF EXISTS swarm.admin_routine_workspace_events;
CREATE FUNCTION swarm.admin_routine_workspace_history(
  p_workspace_id uuid, p_grant_id uuid, p_stream_id uuid
) RETURNS TABLE (
  seq bigint, type text, schema_version integer, actor_user uuid,
  actor_agent_principal uuid, admin_identity_id uuid, grant_id uuid,
  grant_manifest_digest text, occurred_at_server timestamptz, payload jsonb
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog
AS $history$
  SELECT e.seq, e.type, e.schema_version, e.actor_user,
    e.actor_agent_principal, e.admin_identity_id, e.grant_id,
    e.grant_manifest_digest, e.occurred_at_server,
    (SELECT coalesce(jsonb_object_agg(field.key,
      CASE field.key
        WHEN 'credential' THEN (SELECT jsonb_object_agg(c.key, c.value)
          FROM jsonb_each(field.value) AS c
          WHERE c.key = ANY(ARRAY[
            'credential_id', 'workspace_id', 'principal_id', 'worker_lineage_id',
            'parent_admin_grant_id', 'recipient_connection_id', 'worker_scope_names',
            'expires_at', 'horizon_expires_at', 'bearer_seconds', 'max_successors',
            'successors_used', 'kind', 'revoked_at', 'first_used_at', 'superseded',
            'suspended', 'device_valid', 'run_id', 'task_id', 'epoch',
            'renewal_grant_id', 'device_id'
          ]))
        WHEN 'created_workspace_policy' THEN (SELECT jsonb_object_agg(c.key, c.value)
          FROM jsonb_each(field.value) AS c WHERE c.key = 'scope_names')
        WHEN 'worker_policy' THEN CASE WHEN field.value = 'null'::jsonb THEN field.value
          ELSE (SELECT jsonb_object_agg(c.key, c.value) FROM jsonb_each(field.value) AS c
            WHERE c.key = ANY(ARRAY['kind', 'horizon_expires_at', 'max_successors',
              'bearer_seconds', 'horizon_seconds', 'successors_per_worker',
              'successors_per_grant', 'grant_kinds', 'principal_ids'])) END
        ELSE field.value END), '{}'::jsonb)
      FROM jsonb_each(e.payload) AS field
      WHERE field.key = ANY(CASE e.type
        WHEN 'AdminWorkspaceCreated' THEN ARRAY['workspace_id', 'name', 'owner_user_id',
          'created_workspace_policy', 'applied_scope_names', 'created_at']
        WHEN 'AdminSeatCreated' THEN ARRAY['workspace_id', 'principal_id', 'owner_user_id',
          'name', 'model', 'transport', 'turn_only', 'created_at', 'connection_attempt_id']
        WHEN 'AdminSeatProvisioned' THEN ARRAY['principal_id', 'credential_id',
          'recipient_connection_id', 'worker_scope_names', 'worker_policy',
          'parent_admin_grant_id', 'dependent_on_admin_grant', 'credential_expires_at',
          'delivery_state', 'credential']
        WHEN 'AdminSeatRenewed' THEN ARRAY['principal_id', 'worker_lineage_id',
          'predecessor_credential_id', 'successor_credential_id', 'parent_admin_grant_id',
          'worker_scope_names', 'expires_at', 'remaining_budget', 'policy_digest', 'credential']
        WHEN 'AdminSeatCredentialReplaced' THEN ARRAY['principal_id', 'revoked_credential_id',
          'replacement_credential_id', 'recipient_connection_id', 'parent_admin_grant_id',
          'worker_scope_names', 'worker_policy_digest', 'expires_at', 'remaining_budget',
          'delivery_state', 'credential', 'predecessor_credential_id']
        WHEN 'AdminSeatRevoked' THEN ARRAY['principal_id', 'credential_id', 'transport',
          'affected_lineage_ids', 'revoked_at', 'reason_code']
        WHEN 'AdminSeatCredentialRevoked' THEN ARRAY['principal_id', 'credential_id', 'transport',
          'affected_lineage_ids', 'revoked_at', 'reason_code']
        WHEN 'AdminMemberInvited' THEN ARRAY['invitation_id', 'workspace_id', 'recipient_ref',
          'role', 'expires_at', 'delivery_state', 'recipient_user_id', 'recipient_connection_id']
        WHEN 'AdminAgentInvitationIssued' THEN ARRAY['invitation_id', 'workspace_id',
          'intended_owner_user_id', 'recipient_connection_id', 'transport', 'seat_limit',
          'worker_scope_ceiling', 'worker_policy', 'expires_at', 'delivery_state', 'recipient_user_id']
        WHEN 'AdminInvitationRevoked' THEN ARRAY['invitation_id', 'invitation_kind',
          'workspace_id', 'revoked_at', 'reason_code']
        ELSE ARRAY[]::text[] END))
  FROM swarm.events AS e
  JOIN swarm.streams AS s ON s.stream_id = e.stream_id
    AND s.workspace_id = e.workspace_id AND s.kind = 'workspace'
  WHERE e.workspace_id = p_workspace_id AND e.grant_id = p_grant_id
    AND e.stream_id = p_stream_id AND e.type IN (
      'AdminWorkspaceCreated', 'AdminSeatCreated', 'AdminSeatProvisioned',
      'AdminSeatRenewed', 'AdminSeatCredentialReplaced', 'AdminSeatRevoked',
      'AdminSeatCredentialRevoked', 'AdminMemberInvited',
      'AdminAgentInvitationIssued', 'AdminInvitationRevoked'
    )
  ORDER BY e.seq;
$history$;
ALTER FUNCTION swarm.admin_routine_workspace_history(uuid, uuid, uuid) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm.admin_routine_workspace_history(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;
GRANT EXECUTE ON FUNCTION swarm.admin_routine_workspace_history(uuid, uuid, uuid) TO swarm_command;

-- Reserve rollback (verbatim in admin-delegation-reserve/20261001000005-rollback.sql):
-- DROP FUNCTION IF EXISTS swarm.admin_routine_workspace_history(uuid, uuid, uuid);
