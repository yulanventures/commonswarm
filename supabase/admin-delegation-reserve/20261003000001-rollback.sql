-- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- Closure/attestations are permanent; an artifact-bearing release rolls back
-- binaries with issuance closed and retains all schema, tombstones and history.
DO $reserve$
DECLARE t text; occupied boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_grant_resources','admin_grant_bindings','admin_interactions','admin_consent_orchestration',
    'admin_verified_clients','admin_client_owner_approvals','dpop_proof_replays','dpop_nonces','issuer_key_denials',
    'admin_access_issuances','admin_oauth_audit'] LOOP
    IF to_regclass('commonswarm_oauth.'||t) IS NOT NULL THEN
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.%I)',t) INTO occupied;
      IF occupied THEN RAISE EXCEPTION 'reserve rollback refused: durable artifacts in %',t USING ERRCODE='55000'; END IF;
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version>1) THEN
    RAISE EXCEPTION 'reserve rollback refused: versioned admin grants' USING ERRCODE='55000';
  END IF;
  IF to_regclass('commonswarm_oauth.admin_cutover_state') IS NOT NULL THEN
    EXECUTE 'SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE legacy_closed OR admin_issuance_enabled
      OR approved_edge_release_sha IS NOT NULL OR measured_at IS NOT NULL OR release_generation<>0
      OR legacy_closed_at IS NOT NULL OR legacy_fence_evidence_ref IS NOT NULL OR auth_contract_version IS NOT NULL
      OR required_migrations<>''{}''::jsonb OR lane8_evidence_digest IS NOT NULL OR measured_edge_release_sha IS NOT NULL
      OR measured_edge_target IS NOT NULL OR measured_artifact_digest IS NOT NULL OR measured_image_digest IS NOT NULL
      OR measured_mount IS NOT NULL OR measured_generation IS NOT NULL OR measurement_evidence_ref IS NOT NULL OR invalidated_at IS NOT NULL)' INTO occupied;
    IF occupied THEN RAISE EXCEPTION 'reserve rollback refused: cutover evidence' USING ERRCODE='55000'; END IF;
  END IF;
END $reserve$;
DROP TRIGGER provider_artifact_resource_guard ON commonswarm_oauth.provider_artifacts;
DROP FUNCTION commonswarm_oauth.guard_provider_artifact_resource();
DROP TRIGGER admin_parent_interaction_guard ON commonswarm_oauth.interactions;
DROP TRIGGER hosted_resource_guard ON swarm.hosted_mcp_grants;
DROP TABLE commonswarm_oauth.admin_consent_orchestration;
DROP TABLE commonswarm_oauth.admin_interactions;
DROP TABLE commonswarm_oauth.admin_grant_bindings;
DROP TABLE commonswarm_oauth.provider_grant_resources;
DROP FUNCTION commonswarm_oauth.guard_hosted_resource();
DROP FUNCTION commonswarm_oauth.guard_admin_interaction();
DROP FUNCTION commonswarm_oauth.guard_admin_parent_interaction();
DROP FUNCTION commonswarm_oauth.guard_admin_consent_orchestration();
DROP FUNCTION commonswarm_oauth.guard_admin_binding();
DROP FUNCTION commonswarm_oauth.guard_provider_resource();
ALTER TABLE commonswarm_oauth.interactions DROP CONSTRAINT interactions_resource_check;
ALTER TABLE commonswarm_oauth.interactions ADD CONSTRAINT interactions_resource_check CHECK (resource='https://mcp.commonswarm.com/mcp');
ALTER TABLE swarm.admin_grants DROP CONSTRAINT admin_grants_registry_version_check;
ALTER TABLE swarm.admin_grants ADD CONSTRAINT admin_grants_registry_version_check CHECK (registry_version=1);
