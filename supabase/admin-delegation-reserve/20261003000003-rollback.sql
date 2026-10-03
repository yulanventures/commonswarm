-- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- Closure/attestations are permanent; an artifact-bearing release rolls back
-- binaries with issuance closed and retains all schema, tombstones and history.
DO $reserve$
DECLARE t text; occupied boolean;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_grant_resources','admin_grant_bindings','admin_interactions','admin_consent_orchestration',
    'admin_verified_clients','admin_client_owner_approvals','dpop_proof_replays','dpop_nonces','issuer_key_denials',
    'admin_access_issuances','admin_oauth_audit','admin_oauth_audit_daily'] LOOP
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
DROP TRIGGER admin_grants_legacy_guard ON swarm.admin_grants;
DROP TRIGGER admin_credentials_legacy_guard ON swarm.admin_credentials;
DROP TRIGGER admin_binding_terminal_fence ON commonswarm_oauth.admin_grant_bindings;
DROP TRIGGER admin_grant_oauth_fence ON swarm.admin_grants;
DROP TRIGGER oauth_tombstones_append_only ON commonswarm_oauth.refresh_family_tombstones;
DROP TRIGGER oauth_tombstone_admin_fence ON commonswarm_oauth.refresh_family_tombstones;
DROP TRIGGER issuer_denial_admin_fence ON commonswarm_oauth.issuer_key_denials;
DROP TABLE commonswarm_oauth.admin_access_issuances;
DROP TABLE commonswarm_oauth.admin_oauth_audit;
DROP TABLE commonswarm_oauth.admin_oauth_audit_daily;
DROP FUNCTION commonswarm_oauth.record_admin_request_audit(text,bytea,text,text,text,commonswarm_oauth.admin_security_reason,text,uuid,uuid[]);
DROP FUNCTION commonswarm_oauth.record_admin_security_failure(commonswarm_oauth.admin_security_reason);
DROP FUNCTION commonswarm_oauth.guard_admin_request_audit();
DROP FUNCTION commonswarm_oauth.guard_audit_daily();
DROP TYPE commonswarm_oauth.admin_security_reason;
DROP TABLE commonswarm_oauth.admin_cutover_state;
DROP FUNCTION swarm_read.admin_oauth_recovery_page(integer);
DROP FUNCTION commonswarm_oauth.apply_legacy_admin_fence(text);
DROP FUNCTION commonswarm_oauth.guard_legacy_admin_write();
DROP FUNCTION commonswarm_oauth.admin_grant_family_fence();
DROP FUNCTION commonswarm_oauth.binding_terminal_fence();
DROP FUNCTION commonswarm_oauth.valid_admin_migration_requirements(jsonb);
DROP FUNCTION commonswarm_oauth.tombstone_admin_family();
DROP FUNCTION commonswarm_oauth.deny_issuer_admin_families();
DROP FUNCTION commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text);
DROP FUNCTION commonswarm_oauth.guard_access_issuance();
DROP FUNCTION commonswarm_oauth.guard_oauth_audit();
DROP FUNCTION commonswarm_oauth.guard_cutover_state();
