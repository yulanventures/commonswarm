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
ALTER TABLE commonswarm_oauth.admin_interactions DROP CONSTRAINT admin_interaction_verified_client;
ALTER TABLE commonswarm_oauth.admin_grant_bindings DROP CONSTRAINT admin_binding_owner_approval;
ALTER TABLE commonswarm_oauth.admin_grant_bindings DROP CONSTRAINT admin_binding_verified_client;
DROP TABLE commonswarm_oauth.admin_client_owner_approvals;
DROP TABLE commonswarm_oauth.admin_verified_clients;
DROP TABLE commonswarm_oauth.dpop_proof_replays;
DROP TABLE commonswarm_oauth.dpop_nonces;
DROP TABLE commonswarm_oauth.issuer_key_denials;
DROP FUNCTION commonswarm_oauth.guard_owner_approval();
DROP FUNCTION commonswarm_oauth.guard_verified_client();
DROP FUNCTION commonswarm_oauth.resolve_provider_grant_status(text,uuid,text);
DROP FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer);
DROP FUNCTION commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid);
DROP FUNCTION commonswarm_oauth.resolve_admin_grant_status(text,uuid,text);
DROP FUNCTION commonswarm_oauth.fence_admin_family(text,uuid,text,text);
DROP FUNCTION commonswarm_oauth.lock_issuer_key_denial();
DROP FUNCTION commonswarm_oauth.issuer_key_allowed(text,text);
DROP FUNCTION commonswarm_oauth.purge_expired_dpop(integer);
DROP FUNCTION commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea);
DROP TYPE commonswarm_oauth.dpop_admission_status;
DROP FUNCTION commonswarm_oauth.register_dpop_nonce(bytea,text,text);
DROP POLICY command_binding_read ON commonswarm_oauth.admin_grant_bindings;
REVOKE SELECT(provider_grant_id,admin_grant_id,owner_user_id,client_id,verification_version) ON commonswarm_oauth.admin_grant_bindings FROM swarm_command;
REVOKE USAGE ON SCHEMA commonswarm_oauth FROM commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance,swarm_command;
-- Retain dormant NOLOGIN roles; never remove an operator-owned/pre-existing role.
-- Retain safe admin-only creator memberships; rollback never grants SET/INHERIT.
-- REVOKE without GRANTED BY only targets the applying role's selected grantor.
-- Enumerate the actual edges, including grants from a prior release principal.
-- PostgreSQL refuses an unauthorized GRANTED BY; never leave a partial fence.
DO $issuer_memberships$
DECLARE edge record;
BEGIN
  FOR edge IN SELECT parent.rolname AS parent_name,grantor.rolname AS grantor_name
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
    JOIN pg_catalog.pg_roles grantor ON grantor.oid=m.grantor
    WHERE m.member='commonswarm_admin_issuer'::regrole
    ORDER BY parent.rolname,grantor.rolname LOOP
    EXECUTE format('REVOKE %I FROM commonswarm_admin_issuer GRANTED BY %I',edge.parent_name,edge.grantor_name);
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole) THEN
    RAISE EXCEPTION 'reserve rollback refused: issuer memberships remain' USING ERRCODE='55000';
  END IF;
END $issuer_memberships$;
-- Retain the constrained issuer login; it has no direct privileges or SET memberships.
