-- M3: committed access issuance, append-only audit and dormant cutover mechanism.
-- This migration DOES NOT apply the legacy fence, attest a release or enable AS.
CREATE TABLE commonswarm_oauth.admin_oauth_audit (
  audit_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  admin_identity_id uuid NOT NULL,
  admin_grant_id uuid NOT NULL REFERENCES swarm.admin_grants(grant_id),
  connection_id uuid NOT NULL,
  provider_grant_id text NOT NULL REFERENCES commonswarm_oauth.admin_grant_bindings(provider_grant_id),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  event_kind text NOT NULL CHECK (event_kind IN ('issued','rotated','revoked','suspended','expired','refused','replay')),
  request_id text CHECK (request_id IS NULL OR octet_length(request_id) BETWEEN 1 AND 200),
  target_id text CHECK (target_id IS NULL OR octet_length(target_id) BETWEEN 1 AND 200),
  workspace_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('committed','refused')),
  reason_code text CHECK (reason_code IS NULL OR octet_length(reason_code) BETWEEN 1 AND 128),
  related_event_ids uuid[] NOT NULL DEFAULT '{}' CHECK (cardinality(related_event_ids)<=100 AND array_position(related_event_ids,NULL) IS NULL)
);
CREATE INDEX admin_oauth_audit_owner_time ON commonswarm_oauth.admin_oauth_audit(owner_user_id,occurred_at,audit_id);
CREATE TRIGGER admin_oauth_audit_append_only BEFORE UPDATE OR DELETE ON commonswarm_oauth.admin_oauth_audit
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();
CREATE TABLE commonswarm_oauth.admin_access_issuances (
  access_jti text PRIMARY KEY CHECK (octet_length(access_jti) BETWEEN 1 AND 200),
  access_token_digest bytea NOT NULL UNIQUE CHECK (octet_length(access_token_digest)=32),
  provider_grant_id text NOT NULL REFERENCES commonswarm_oauth.admin_grant_bindings(provider_grant_id),
  admin_grant_id uuid NOT NULL REFERENCES swarm.admin_grants(grant_id),
  generation integer NOT NULL CHECK (generation>=0),
  client_id text NOT NULL,
  resource text NOT NULL CHECK (resource='https://api.commonswarm.com/admin'),
  jkt text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  scope_names text[] NOT NULL CHECK (cardinality(scope_names) BETWEEN 1 AND 32 AND array_position(scope_names,NULL) IS NULL),
  issuer text NOT NULL CHECK (issuer='https://mcp.commonswarm.com'),
  kid text NOT NULL CHECK (octet_length(kid) BETWEEN 1 AND 200),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  event_id uuid NOT NULL UNIQUE REFERENCES swarm.admin_events(event_id),
  audit_id uuid NOT NULL UNIQUE REFERENCES commonswarm_oauth.admin_oauth_audit(audit_id),
  CHECK (issued_at=date_trunc('second',issued_at) AND expires_at=date_trunc('second',expires_at)),
  CHECK (expires_at>issued_at AND expires_at<=issued_at+interval '300 seconds'),
  UNIQUE(provider_grant_id,generation)
);
CREATE INDEX admin_issuances_family ON commonswarm_oauth.admin_access_issuances(provider_grant_id,expires_at);
CREATE TRIGGER admin_issuances_append_only BEFORE UPDATE OR DELETE ON commonswarm_oauth.admin_access_issuances
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE FUNCTION commonswarm_oauth.valid_admin_migration_requirements(p_requirements jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $fn$
  SELECT CASE WHEN jsonb_typeof(p_requirements) IS DISTINCT FROM 'object' THEN false
    WHEN p_requirements='{}'::jsonb THEN true
    ELSE p_requirements ?& ARRAY['20261003000001','20261003000002','20261003000003']
      AND NOT EXISTS(SELECT 1 FROM jsonb_each_text(p_requirements) e WHERE e.key !~ '^[0-9]{14}$' OR e.value IS NULL OR e.value !~ '^[0-9a-f]{64}$') END
$fn$;
CREATE TABLE commonswarm_oauth.admin_cutover_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  admin_issuance_enabled boolean NOT NULL DEFAULT false,
  legacy_closed boolean NOT NULL DEFAULT false,
  legacy_closed_at timestamptz,
  legacy_fence_evidence_ref text CHECK (octet_length(legacy_fence_evidence_ref) BETWEEN 1 AND 2048),
  approved_edge_release_sha text CHECK (approved_edge_release_sha ~ '^[0-9a-f]{40}$'),
  auth_contract_version integer CHECK (auth_contract_version>=2),
  required_migrations jsonb NOT NULL DEFAULT '{}' CHECK (commonswarm_oauth.valid_admin_migration_requirements(required_migrations)),
  lane8_evidence_digest text CHECK (lane8_evidence_digest ~ '^[0-9a-f]{64}$'),
  measured_edge_release_sha text CHECK (measured_edge_release_sha ~ '^[0-9a-f]{40}$'),
  measured_edge_target text,
  measured_artifact_digest text CHECK (measured_artifact_digest ~ '^[0-9a-f]{64}$'),
  measured_image_digest text CHECK (measured_image_digest ~ '^sha256:[0-9a-f]{64}$'),
  measured_mount text,
  release_generation bigint NOT NULL DEFAULT 0 CHECK (release_generation>=0),
  measured_generation bigint CHECK (measured_generation>=0),
  measured_at timestamptz,
  measurement_evidence_ref text CHECK (octet_length(measurement_evidence_ref) BETWEEN 1 AND 2048),
  invalidated_at timestamptz,
  CHECK ((NOT legacy_closed AND legacy_closed_at IS NULL) OR (legacy_closed AND legacy_closed_at IS NOT NULL)),
  CHECK (NOT admin_issuance_enabled OR (legacy_closed AND legacy_fence_evidence_ref IS NOT NULL
    AND approved_edge_release_sha IS NOT NULL AND auth_contract_version IS NOT NULL AND required_migrations<>'{}'::jsonb
    AND lane8_evidence_digest IS NOT NULL AND measured_edge_release_sha IS NOT NULL AND measured_edge_release_sha=approved_edge_release_sha
    AND measured_edge_target IS NOT NULL AND measured_mount IS NOT NULL AND measured_generation IS NOT NULL
    AND measured_edge_target='/home/commonswarm/edge/releases/'||approved_edge_release_sha
    AND measured_mount=measured_edge_target AND measured_artifact_digest IS NOT NULL AND measured_image_digest IS NOT NULL
    AND measured_generation=release_generation AND measured_at IS NOT NULL AND measurement_evidence_ref IS NOT NULL AND invalidated_at IS NULL))
);
INSERT INTO commonswarm_oauth.admin_cutover_state(singleton) VALUES(true);

CREATE FUNCTION commonswarm_oauth.guard_cutover_state() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND OLD.legacy_closed AND
    ROW(NEW.legacy_closed,NEW.legacy_closed_at) IS DISTINCT FROM ROW(OLD.legacy_closed,OLD.legacy_closed_at)) THEN
    RAISE EXCEPTION 'legacy closure is permanent' USING ERRCODE='55000';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.release_generation<OLD.release_generation OR
    (ROW(NEW.approved_edge_release_sha,NEW.measured_edge_release_sha,NEW.measured_edge_target,NEW.measured_artifact_digest,
      NEW.measured_image_digest,NEW.measured_mount,NEW.release_generation) IS DISTINCT FROM
     ROW(OLD.approved_edge_release_sha,OLD.measured_edge_release_sha,OLD.measured_edge_target,OLD.measured_artifact_digest,
      OLD.measured_image_digest,OLD.measured_mount,OLD.release_generation)
     AND (OLD.admin_issuance_enabled OR NEW.admin_issuance_enabled))) THEN
    RAISE EXCEPTION 'close issuance before release measurement changes' USING ERRCODE='23514';
  END IF;
  IF NEW.legacy_closed AND NOT OLD.legacy_closed AND (
    NOT EXISTS(SELECT 1 FROM pg_class WHERE oid=to_regclass('swarm.admin_credentials') AND relforcerowsecurity)
    OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('swarm.admin_credentials'))
    OR has_table_privilege('swarm_command','swarm.admin_credentials','SELECT,INSERT,UPDATE')
    OR EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version=1 AND state='active')) THEN
    RAISE EXCEPTION 'legacy database fence must precede closure' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_cutover_guard BEFORE UPDATE OR DELETE ON commonswarm_oauth.admin_cutover_state
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_cutover_state();

CREATE FUNCTION commonswarm_oauth.guard_oauth_audit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF NEW.event_kind IN ('issued','rotated') THEN
    -- Serialize issuance with a release-role closure; terminal/refusal audit stays available.
    PERFORM 1 FROM commonswarm_oauth.admin_cutover_state
      WHERE singleton AND admin_issuance_enabled AND legacy_closed FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'admin issuance closed' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.admin_grant_bindings b WHERE b.provider_grant_id=NEW.provider_grant_id
    AND ROW(b.owner_user_id,b.admin_identity_id,b.admin_grant_id,b.connection_id,b.manifest_digest) IS NOT DISTINCT FROM
      ROW(NEW.owner_user_id,NEW.admin_identity_id,NEW.admin_grant_id,NEW.connection_id,NEW.manifest_digest)) THEN
    RAISE EXCEPTION 'audit binding mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_oauth_audit_binding BEFORE INSERT ON commonswarm_oauth.admin_oauth_audit
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_oauth_audit();

CREATE FUNCTION commonswarm_oauth.guard_access_issuance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b commonswarm_oauth.admin_grant_bindings%ROWTYPE; e jsonb;
BEGIN
  PERFORM 1 FROM commonswarm_oauth.admin_cutover_state
    WHERE singleton AND admin_issuance_enabled AND legacy_closed FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin issuance closed' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.resolve_admin_grant_status(NEW.provider_grant_id,
    (SELECT owner_user_id FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=NEW.provider_grant_id),NEW.kid)
      WHERE active AND NEW.expires_at<=expires_at) THEN
    RAISE EXCEPTION 'issuance family inactive' USING ERRCODE='23514';
  END IF;
  SELECT * INTO b FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=NEW.provider_grant_id;
  SELECT event INTO e FROM swarm.admin_events WHERE event_id=NEW.event_id AND owner_user_id=b.owner_user_id;
  IF ROW(NEW.admin_grant_id,NEW.generation,NEW.client_id,NEW.resource,NEW.jkt,NEW.manifest_digest) IS DISTINCT FROM
       ROW(b.admin_grant_id,b.generation,b.client_id,b.resource,b.jkt,b.manifest_digest)
    OR b.initial_issued_at IS NULL OR NEW.issued_at<b.initial_issued_at
    OR NEW.issued_at>clock_timestamp()+interval '5 seconds' OR NEW.expires_at>least(b.expires_at,b.refresh_deadline)
    OR NOT (NEW.scope_names<@b.scope_names) OR e IS NULL
    OR e->>'type' IS DISTINCT FROM (CASE WHEN NEW.generation=0 THEN 'AdminCredentialIssued' ELSE 'AdminCredentialRotated' END)
    OR e->>'grant_id' IS DISTINCT FROM b.admin_grant_id::text
    OR e->'payload'->>'provider_grant_id' IS DISTINCT FROM b.provider_grant_id
    OR e->'payload'->>'generation' IS DISTINCT FROM NEW.generation::text
    OR e->'payload'->>'version' IS DISTINCT FROM '2'
    OR NOT EXISTS (SELECT 1 FROM commonswarm_oauth.admin_oauth_audit a WHERE a.audit_id=NEW.audit_id
      AND a.provider_grant_id=NEW.provider_grant_id AND a.outcome='committed'
      AND a.event_kind=CASE WHEN NEW.generation=0 THEN 'issued' ELSE 'rotated' END AND NEW.event_id=ANY(a.related_event_ids)) THEN
    RAISE EXCEPTION 'issuance binding or audit mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_access_issuance_binding BEFORE INSERT ON commonswarm_oauth.admin_access_issuances
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_access_issuance();

CREATE FUNCTION commonswarm_oauth.admin_access_is_active(p_jti text,p_digest bytea,p_provider_grant_id text,
  p_admin_grant_id uuid,p_owner_user_id uuid,p_generation integer,p_client_id text,p_resource text,
  p_jkt text,p_manifest_digest text,p_issued_at timestamptz,p_expires_at timestamptz,p_kid text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  RETURN EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton AND admin_issuance_enabled AND legacy_closed)
    AND EXISTS(SELECT 1 FROM commonswarm_oauth.resolve_admin_grant_status(p_provider_grant_id,p_owner_user_id,p_kid) s
    JOIN commonswarm_oauth.admin_access_issuances i ON i.provider_grant_id=p_provider_grant_id
    WHERE s.active AND i.access_jti=p_jti AND i.access_token_digest=p_digest AND i.admin_grant_id=p_admin_grant_id
      AND i.generation=p_generation AND i.client_id=p_client_id AND i.resource=p_resource
      AND i.jkt=p_jkt AND i.manifest_digest=p_manifest_digest AND i.issued_at=p_issued_at
      AND i.expires_at=p_expires_at AND i.kid=p_kid AND i.expires_at>clock_timestamp()
      AND i.expires_at<=s.expires_at AND i.scope_names<@s.scope_names);
END $fn$;

-- Ensure a human grant state change and every family tombstone commit together,
-- even if a caller forgets the narrow fence helper. Terminal audit is mandatory.
CREATE FUNCTION commonswarm_oauth.admin_grant_family_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b record;
BEGIN
  IF ROW(NEW.owner_user_id,NEW.admin_identity_id,NEW.connection_id,NEW.client_id,NEW.resource,NEW.created_at) IS DISTINCT FROM
       ROW(OLD.owner_user_id,OLD.admin_identity_id,OLD.connection_id,OLD.client_id,OLD.resource,OLD.created_at)
    AND EXISTS(SELECT 1 FROM commonswarm_oauth.admin_grant_bindings WHERE admin_grant_id=OLD.grant_id) THEN
    RAISE EXCEPTION 'bound grant identity is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.state IN ('revoked','suspended','expired') AND NEW.state='active' AND
    EXISTS(SELECT 1 FROM commonswarm_oauth.admin_grant_bindings WHERE admin_grant_id=NEW.grant_id) THEN
    RAISE EXCEPTION 'bound grant cannot resurrect' USING ERRCODE='23514';
  END IF;
  IF NEW.state IN ('revoked','suspended','expired') AND OLD.state IS DISTINCT FROM NEW.state THEN
    FOR b IN SELECT * FROM commonswarm_oauth.admin_grant_bindings WHERE admin_grant_id=NEW.grant_id ORDER BY provider_grant_id LOOP
      UPDATE commonswarm_oauth.admin_grant_bindings SET state=NEW.state,terminal_at=statement_timestamp()
        WHERE provider_grant_id=b.provider_grant_id AND state IN ('active','pending');
      INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at)
        VALUES(b.provider_grant_id,statement_timestamp()) ON CONFLICT DO NOTHING;
      INSERT INTO commonswarm_oauth.admin_oauth_audit(owner_user_id,admin_identity_id,admin_grant_id,connection_id,
        provider_grant_id,manifest_digest,event_kind,outcome,reason_code)
        VALUES(b.owner_user_id,b.admin_identity_id,b.admin_grant_id,b.connection_id,b.provider_grant_id,b.manifest_digest,NEW.state,'committed',NEW.reason_code);
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_grant_oauth_fence AFTER UPDATE ON swarm.admin_grants
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.admin_grant_family_fence();

CREATE FUNCTION commonswarm_oauth.binding_terminal_fence() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF NEW.state IN ('revoked','suspended','expired') AND NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM commonswarm_oauth.fence_admin_family(NEW.provider_grant_id,NEW.owner_user_id,NEW.state,'family_terminal');
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_binding_terminal_fence AFTER UPDATE ON commonswarm_oauth.admin_grant_bindings
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.binding_terminal_fence();

CREATE FUNCTION commonswarm_oauth.tombstone_admin_family() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b commonswarm_oauth.admin_grant_bindings%ROWTYPE;
BEGIN
  SELECT * INTO b FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=NEW.grant_id;
  IF FOUND THEN PERFORM commonswarm_oauth.fence_admin_family(b.provider_grant_id,b.owner_user_id,'revoked','provider_family_revoked'); END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER oauth_tombstone_admin_fence AFTER INSERT ON commonswarm_oauth.refresh_family_tombstones
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.tombstone_admin_family();
CREATE TRIGGER oauth_tombstones_append_only BEFORE UPDATE OR DELETE ON commonswarm_oauth.refresh_family_tombstones
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE FUNCTION commonswarm_oauth.deny_issuer_admin_families() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b record;
BEGIN
  FOR b IN SELECT DISTINCT f.provider_grant_id,f.owner_user_id,f.client_id,f.verification_version,f.admin_grant_id
    FROM commonswarm_oauth.admin_access_issuances i JOIN commonswarm_oauth.admin_grant_bindings f USING(provider_grant_id)
    WHERE i.issuer=NEW.issuer AND i.kid=NEW.kid
    ORDER BY f.client_id,f.verification_version,f.owner_user_id,f.admin_grant_id LOOP
    PERFORM commonswarm_oauth.fence_admin_family(b.provider_grant_id,b.owner_user_id,'revoked','issuer_key_denied');
  END LOOP;
  RETURN NEW;
END $fn$;
CREATE TRIGGER issuer_denial_admin_fence AFTER INSERT ON commonswarm_oauth.issuer_key_denials
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.deny_issuer_admin_families();

CREATE FUNCTION commonswarm_oauth.guard_legacy_admin_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE legacy_closed) THEN
    IF TG_TABLE_NAME='admin_credentials' THEN
      RAISE EXCEPTION 'legacy admin authentication permanently closed' USING ERRCODE='42501';
    END IF;
    IF (TG_OP='INSERT' AND NEW.registry_version=1)
      OR (TG_OP='UPDATE' AND NEW.registry_version=1 AND NEW.state='active' AND OLD.state<>'active') THEN
      RAISE EXCEPTION 'legacy admin authentication permanently closed' USING ERRCODE='42501';
    END IF;
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_credentials_legacy_guard BEFORE INSERT OR UPDATE OR DELETE ON swarm.admin_credentials
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_legacy_admin_write();
CREATE TRIGGER admin_grants_legacy_guard BEFORE INSERT OR UPDATE ON swarm.admin_grants
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_legacy_admin_write();

-- ONLY the separately authorized release role can invoke this. Not called by
-- this migration. The evidence identifies a reviewed inventory/cutover step;
-- it is not an edge release attestation and cannot enable issuance.
CREATE FUNCTION commonswarm_oauth.apply_legacy_admin_fence(p_evidence_ref text) RETURNS void
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_evidence_ref IS NULL OR octet_length(p_evidence_ref) NOT BETWEEN 1 AND 2048 THEN
    RAISE EXCEPTION 'fence evidence required' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM commonswarm_oauth.admin_cutover_state WHERE singleton FOR UPDATE;
  IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE legacy_closed) THEN RETURN; END IF;
  -- Table lock drains all old-binary operations before permanent ACL/RLS closure.
  LOCK TABLE swarm.admin_credentials IN ACCESS EXCLUSIVE MODE;
  LOCK TABLE swarm.admin_grants IN SHARE ROW EXCLUSIVE MODE;
  UPDATE swarm.admin_credentials SET revoked_at=coalesce(revoked_at,statement_timestamp());
  UPDATE swarm.admin_grants SET state='revoked',revoked_at=coalesce(revoked_at,statement_timestamp()),reason_code='legacy_cutover'
    WHERE registry_version=1 AND state='active';
  REVOKE ALL ON swarm.admin_credentials FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime;
  DROP POLICY IF EXISTS swarm_command_all ON swarm.admin_credentials;
  ALTER TABLE swarm.admin_credentials FORCE ROW LEVEL SECURITY;
  UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=false,legacy_closed=true,
    legacy_closed_at=statement_timestamp(),legacy_fence_evidence_ref=p_evidence_ref,invalidated_at=statement_timestamp();
END $fn$;

CREATE FUNCTION swarm_read.admin_oauth_recovery_page(p_limit integer DEFAULT 50) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE viewer uuid:=nullif(nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub','')::uuid;
BEGIN
  IF viewer IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RETURN jsonb_build_object('error','forbidden'); END IF;
  RETURN jsonb_build_object('grants',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
    SELECT b.admin_grant_id,b.connection_id,b.client_id,b.verification_version,b.owner_user_id AS approving_owner_user_id,
      a.approved_at,a.withdrawn_at,b.state,b.expires_at,b.manifest_digest
    FROM commonswarm_oauth.admin_grant_bindings b JOIN commonswarm_oauth.admin_client_owner_approvals a
      USING(owner_user_id,client_id,verification_version) WHERE b.owner_user_id=viewer ORDER BY b.consented_at DESC LIMIT p_limit) r),'[]'::jsonb),
    'audit',coalesce((SELECT jsonb_agg(to_jsonb(r)) FROM (
      SELECT audit_id,occurred_at,admin_grant_id,admin_identity_id,connection_id,event_kind,outcome,reason_code,related_event_ids
      FROM commonswarm_oauth.admin_oauth_audit WHERE owner_user_id=viewer ORDER BY occurred_at DESC,audit_id DESC LIMIT p_limit) r),'[]'::jsonb));
END $fn$;

DO $permissions$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_oauth_audit','admin_access_issuances','admin_cutover_state'] LOOP
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I OWNER TO swarm_admin',t);
    -- RLS is intentionally not FORCE: owner-definer ledger/recovery functions need it (C+D).
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON commonswarm_oauth.%I FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['admin_oauth_audit','admin_access_issuances'] LOOP
    EXECUTE format('CREATE POLICY oauth_ledger_read ON commonswarm_oauth.%I FOR SELECT TO commonswarm_oauth_runtime USING(true)',t);
    EXECUTE format('CREATE POLICY oauth_ledger_insert ON commonswarm_oauth.%I FOR INSERT TO commonswarm_oauth_runtime WITH CHECK(true)',t);
    EXECUTE format('GRANT SELECT,INSERT ON commonswarm_oauth.%I TO commonswarm_oauth_runtime',t);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['valid_admin_migration_requirements(jsonb)','guard_cutover_state()','guard_oauth_audit()','guard_access_issuance()',
    'admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)',
    'admin_grant_family_fence()','binding_terminal_fence()','tombstone_admin_family()','deny_issuer_admin_families()',
    'guard_legacy_admin_write()','apply_legacy_admin_fence(text)'] LOOP
    EXECUTE 'ALTER FUNCTION commonswarm_oauth.'||f||' OWNER TO swarm_admin';
    EXECUTE 'REVOKE ALL ON FUNCTION commonswarm_oauth.'||f||' FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance';
  END LOOP;
END $permissions$;
CREATE POLICY cutover_release ON commonswarm_oauth.admin_cutover_state FOR ALL TO commonswarm_admin_release USING(true) WITH CHECK(true);
CREATE POLICY cutover_runtime_read ON commonswarm_oauth.admin_cutover_state FOR SELECT TO commonswarm_oauth_runtime USING(true);
GRANT SELECT,UPDATE ON commonswarm_oauth.admin_cutover_state TO commonswarm_admin_release;
GRANT SELECT ON commonswarm_oauth.admin_cutover_state TO commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.apply_legacy_admin_fence(text) TO commonswarm_admin_release;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.valid_admin_migration_requirements(jsonb) TO commonswarm_admin_release;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text)
  TO commonswarm_oauth_runtime,swarm_command,swarm_read;
ALTER FUNCTION swarm_read.admin_oauth_recovery_page(integer) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION swarm_read.admin_oauth_recovery_page(integer) FROM PUBLIC,anon,authenticated,swarm_command,commonswarm_oauth_runtime;
GRANT EXECUTE ON FUNCTION swarm_read.admin_oauth_recovery_page(integer) TO swarm_read;

-- Reserve rollback (verbatim sibling reserve; data-free only):
-- -- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- -- Closure/attestations are permanent; an artifact-bearing release rolls back
-- -- binaries with issuance closed and retains all schema, tombstones and history.
-- DO $reserve$
-- DECLARE t text; occupied boolean;
-- BEGIN
--   FOREACH t IN ARRAY ARRAY['provider_grant_resources','admin_grant_bindings','admin_interactions','admin_consent_orchestration',
--     'admin_verified_clients','admin_client_owner_approvals','dpop_proof_replays','dpop_nonces','issuer_key_denials',
--     'admin_access_issuances','admin_oauth_audit'] LOOP
--     IF to_regclass('commonswarm_oauth.'||t) IS NOT NULL THEN
--       EXECUTE format('SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.%I)',t) INTO occupied;
--       IF occupied THEN RAISE EXCEPTION 'reserve rollback refused: durable artifacts in %',t USING ERRCODE='55000'; END IF;
--     END IF;
--   END LOOP;
--   IF EXISTS(SELECT 1 FROM swarm.admin_grants WHERE registry_version>1) THEN
--     RAISE EXCEPTION 'reserve rollback refused: versioned admin grants' USING ERRCODE='55000';
--   END IF;
--   IF to_regclass('commonswarm_oauth.admin_cutover_state') IS NOT NULL THEN
--     EXECUTE 'SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_cutover_state WHERE legacy_closed OR admin_issuance_enabled
--       OR approved_edge_release_sha IS NOT NULL OR measured_at IS NOT NULL OR release_generation<>0
--       OR legacy_closed_at IS NOT NULL OR legacy_fence_evidence_ref IS NOT NULL OR auth_contract_version IS NOT NULL
--       OR required_migrations<>''{}''::jsonb OR lane8_evidence_digest IS NOT NULL OR measured_edge_release_sha IS NOT NULL
--       OR measured_edge_target IS NOT NULL OR measured_artifact_digest IS NOT NULL OR measured_image_digest IS NOT NULL
--       OR measured_mount IS NOT NULL OR measured_generation IS NOT NULL OR measurement_evidence_ref IS NOT NULL OR invalidated_at IS NOT NULL)' INTO occupied;
--     IF occupied THEN RAISE EXCEPTION 'reserve rollback refused: cutover evidence' USING ERRCODE='55000'; END IF;
--   END IF;
-- END $reserve$;
-- DROP TRIGGER admin_grants_legacy_guard ON swarm.admin_grants;
-- DROP TRIGGER admin_credentials_legacy_guard ON swarm.admin_credentials;
-- DROP TRIGGER admin_binding_terminal_fence ON commonswarm_oauth.admin_grant_bindings;
-- DROP TRIGGER admin_grant_oauth_fence ON swarm.admin_grants;
-- DROP TRIGGER oauth_tombstones_append_only ON commonswarm_oauth.refresh_family_tombstones;
-- DROP TRIGGER oauth_tombstone_admin_fence ON commonswarm_oauth.refresh_family_tombstones;
-- DROP TRIGGER issuer_denial_admin_fence ON commonswarm_oauth.issuer_key_denials;
-- DROP TABLE commonswarm_oauth.admin_access_issuances;
-- DROP TABLE commonswarm_oauth.admin_oauth_audit;
-- DROP TABLE commonswarm_oauth.admin_cutover_state;
-- DROP FUNCTION swarm_read.admin_oauth_recovery_page(integer);
-- DROP FUNCTION commonswarm_oauth.apply_legacy_admin_fence(text);
-- DROP FUNCTION commonswarm_oauth.guard_legacy_admin_write();
-- DROP FUNCTION commonswarm_oauth.admin_grant_family_fence();
-- DROP FUNCTION commonswarm_oauth.binding_terminal_fence();
-- DROP FUNCTION commonswarm_oauth.valid_admin_migration_requirements(jsonb);
-- DROP FUNCTION commonswarm_oauth.tombstone_admin_family();
-- DROP FUNCTION commonswarm_oauth.deny_issuer_admin_families();
-- DROP FUNCTION commonswarm_oauth.admin_access_is_active(text,bytea,text,uuid,uuid,integer,text,text,text,text,timestamptz,timestamptz,text);
-- DROP FUNCTION commonswarm_oauth.guard_access_issuance();
-- DROP FUNCTION commonswarm_oauth.guard_oauth_audit();
-- DROP FUNCTION commonswarm_oauth.guard_cutover_state();
