-- M1: additive single-resource OAuth bindings. This does not enable issuance.
-- The migration runner owns the transaction. Applied predecessors are untouched.
ALTER TABLE swarm.admin_grants DROP CONSTRAINT admin_grants_registry_version_check;
ALTER TABLE swarm.admin_grants ADD CONSTRAINT admin_grants_registry_version_check CHECK (registry_version >= 1);
ALTER TABLE commonswarm_oauth.interactions DROP CONSTRAINT interactions_resource_check;
-- Spec M1 reserves both resources; the live AS still refuses admin in getResourceServerInfo.
ALTER TABLE commonswarm_oauth.interactions ADD CONSTRAINT interactions_resource_check
  CHECK (resource IN ('https://mcp.commonswarm.com/mcp','https://api.commonswarm.com/admin'));

CREATE TABLE commonswarm_oauth.provider_grant_resources (
  provider_grant_id text PRIMARY KEY CHECK (octet_length(provider_grant_id) BETWEEN 1 AND 2048),
  resource text NOT NULL,
  grant_class text NOT NULL CHECK (grant_class IN ('hosted_mcp','delegated_admin')),
  owner_user_id uuid NOT NULL REFERENCES swarm.users(user_id),
  client_id text NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  connection_id uuid NOT NULL,
  hosted_grant_id uuid UNIQUE REFERENCES swarm.hosted_mcp_grants(grant_id),
  admin_grant_id uuid UNIQUE REFERENCES swarm.admin_grants(grant_id),
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  CHECK ((grant_class='hosted_mcp' AND resource='https://mcp.commonswarm.com/mcp'
          AND hosted_grant_id IS NOT NULL AND admin_grant_id IS NULL)
      OR (grant_class='delegated_admin' AND resource='https://api.commonswarm.com/admin'
          AND admin_grant_id IS NOT NULL AND hosted_grant_id IS NULL)),
  UNIQUE (provider_grant_id,admin_grant_id,owner_user_id,client_id,connection_id,resource,grant_class)
);
CREATE TABLE commonswarm_oauth.admin_grant_bindings (
  provider_grant_id text PRIMARY KEY,
  admin_grant_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  admin_identity_id uuid NOT NULL,
  connection_id uuid NOT NULL,
  client_id text NOT NULL,
  resource text NOT NULL CHECK (resource='https://api.commonswarm.com/admin'),
  grant_class text NOT NULL DEFAULT 'delegated_admin' CHECK (grant_class='delegated_admin'),
  registry_version integer NOT NULL CHECK (registry_version >= 2),
  capabilities text[] NOT NULL CHECK (cardinality(capabilities) BETWEEN 1 AND 128 AND array_position(capabilities,NULL) IS NULL),
  scope_names text[] NOT NULL CHECK (cardinality(scope_names) BETWEEN 1 AND 32
    AND array_position(scope_names,NULL) IS NULL AND NOT ('admin:delegate'=ANY(scope_names)) AND NOT ('mcp'=ANY(scope_names))),
  availability_digest text NOT NULL CHECK (availability_digest ~ '^[0-9a-f]{64}$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  verification_version integer NOT NULL CHECK (verification_version > 0),
  jkt text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  consented_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  refresh_deadline timestamptz NOT NULL,
  initial_issued_at timestamptz,
  generation integer NOT NULL DEFAULT 0 CHECK (generation >= 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','active','revoked','suspended','expired')),
  terminal_at timestamptz,
  CHECK (expires_at>consented_at AND expires_at<=refresh_deadline AND refresh_deadline<=consented_at+interval '30 days'),
  CHECK (initial_issued_at IS NULL OR (initial_issued_at>=consented_at AND initial_issued_at<expires_at)),
  CHECK ((state IN ('pending','active') AND terminal_at IS NULL) OR
         (state IN ('revoked','suspended','expired') AND terminal_at IS NOT NULL)),
  FOREIGN KEY (provider_grant_id,admin_grant_id,owner_user_id,client_id,connection_id,resource,grant_class)
    REFERENCES commonswarm_oauth.provider_grant_resources
      (provider_grant_id,admin_grant_id,owner_user_id,client_id,connection_id,resource,grant_class),
  FOREIGN KEY (admin_grant_id,owner_user_id) REFERENCES swarm.admin_grants(grant_id,owner_user_id)
);
CREATE UNIQUE INDEX admin_binding_live_connection ON commonswarm_oauth.admin_grant_bindings(owner_user_id,connection_id)
  WHERE state IN ('pending','active');
CREATE INDEX admin_binding_client_owner ON commonswarm_oauth.admin_grant_bindings(client_id,verification_version,owner_user_id);

CREATE TABLE commonswarm_oauth.admin_interactions (
  interaction_uid text PRIMARY KEY REFERENCES commonswarm_oauth.interactions(interaction_uid),
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  client_id text NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  resource text NOT NULL CHECK (resource='https://api.commonswarm.com/admin'),
  redirect_uri text NOT NULL CHECK (octet_length(redirect_uri) BETWEEN 1 AND 4096 AND redirect_uri ~ '^https://'),
  registry_version integer NOT NULL CHECK (registry_version >= 2),
  verification_version integer NOT NULL CHECK (verification_version > 0),
  manifest jsonb NOT NULL CHECK (jsonb_typeof(manifest)='object'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  availability_digest text NOT NULL CHECK (availability_digest ~ '^[0-9a-f]{64}$'),
  requested_scopes text[] NOT NULL CHECK (cardinality(requested_scopes) BETWEEN 1 AND 32
    AND array_position(requested_scopes,NULL) IS NULL AND NOT ('admin:delegate'=ANY(requested_scopes)) AND NOT ('mcp'=ANY(requested_scopes))),
  session_binding bytea NOT NULL CHECK (octet_length(session_binding)=32),
  csrf_binding bytea NOT NULL CHECK (octet_length(csrf_binding)=32),
  second_confirmation_binding bytea CHECK (second_confirmation_binding IS NULL OR octet_length(second_confirmation_binding)=32),
  full_account boolean NOT NULL DEFAULT false,
  second_confirmed_at timestamptz,
  pkce_challenge text NOT NULL CHECK (pkce_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  pkce_method text NOT NULL DEFAULT 'S256' CHECK (pkce_method='S256'),
  jkt text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  replacement_grant_id uuid,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  UNIQUE(interaction_uid,owner_user_id),
  FOREIGN KEY (replacement_grant_id,owner_user_id) REFERENCES swarm.admin_grants(grant_id,owner_user_id),
  CHECK (expires_at>created_at AND expires_at<=created_at+interval '10 minutes'),
  CHECK (consumed_at IS NULL OR (consumed_at>=created_at AND consumed_at<=expires_at)),
  CHECK (second_confirmed_at IS NULL OR (second_confirmed_at>=created_at AND second_confirmed_at<=expires_at
    AND (consumed_at IS NULL OR second_confirmed_at<=consumed_at))),
  CHECK (NOT full_account OR consumed_at IS NULL OR
    (second_confirmation_binding IS NOT NULL AND second_confirmed_at IS NOT NULL))
);
CREATE INDEX admin_interactions_expiry ON commonswarm_oauth.admin_interactions(expires_at);
CREATE TABLE commonswarm_oauth.admin_consent_orchestration (
  interaction_uid text NOT NULL,
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  step_kind text NOT NULL CHECK (step_kind IN ('consent','continuation','replacement')),
  command_id uuid NOT NULL UNIQUE,
  receipt_id uuid REFERENCES swarm.admin_consents(consent_receipt_id),
  completed_at timestamptz,
  CHECK (completed_at IS NULL OR receipt_id IS NOT NULL),
  PRIMARY KEY (interaction_uid,step_kind),
  FOREIGN KEY (interaction_uid,owner_user_id) REFERENCES commonswarm_oauth.admin_interactions(interaction_uid,owner_user_id)
);

CREATE FUNCTION commonswarm_oauth.guard_provider_resource() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-resource:'||NEW.provider_grant_id,0));
  IF NEW.grant_class='hosted_mcp' THEN
    IF NOT EXISTS (SELECT 1 FROM swarm.hosted_mcp_grants g WHERE g.grant_id=NEW.hosted_grant_id
      AND g.provider_grant_id=NEW.provider_grant_id AND g.owner_user_id=NEW.owner_user_id
      AND g.client_id=NEW.client_id AND g.resource=NEW.resource FOR SHARE) THEN
      RAISE EXCEPTION 'provider binding mismatch' USING ERRCODE='23514';
    END IF;
  ELSE
    IF EXISTS (SELECT 1 FROM swarm.hosted_mcp_grants g WHERE g.provider_grant_id=NEW.provider_grant_id)
      OR NOT EXISTS (SELECT 1 FROM swarm.admin_grants g WHERE g.grant_id=NEW.admin_grant_id
      AND g.owner_user_id=NEW.owner_user_id AND g.client_id=NEW.client_id
      AND g.connection_id=NEW.connection_id AND g.resource=NEW.resource FOR SHARE) THEN
      RAISE EXCEPTION 'provider binding mismatch' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER provider_resource_match BEFORE INSERT ON commonswarm_oauth.provider_grant_resources
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_provider_resource();
CREATE TRIGGER provider_resource_immutable BEFORE UPDATE OR DELETE ON commonswarm_oauth.provider_grant_resources
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

CREATE FUNCTION commonswarm_oauth.guard_admin_binding() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE g swarm.admin_grants%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'binding history is immutable' USING ERRCODE='55000'; END IF;
  SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=NEW.admin_grant_id FOR SHARE;
  IF NOT FOUND OR ROW(NEW.owner_user_id,NEW.admin_identity_id,NEW.connection_id,NEW.client_id,NEW.resource,NEW.consented_at) IS DISTINCT FROM
    ROW(g.owner_user_id,g.admin_identity_id,g.connection_id,g.client_id,g.resource,g.created_at)
    OR (NEW.state IN ('pending','active') AND (NEW.registry_version<>g.registry_version OR NEW.manifest_digest<>g.manifest_digest
      OR NOT (NEW.scope_names <@ g.scope_names) OR NEW.expires_at>g.expires_at OR NEW.refresh_deadline>g.refresh_deadline)) THEN
    RAISE EXCEPTION 'admin binding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    (to_jsonb(NEW)-ARRAY['scope_names','capabilities','expires_at','refresh_deadline','initial_issued_at','generation','state','terminal_at'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['scope_names','capabilities','expires_at','refresh_deadline','initial_issued_at','generation','state','terminal_at'])
    OR NOT (NEW.scope_names <@ OLD.scope_names) OR NOT (NEW.capabilities <@ OLD.capabilities)
    OR NEW.expires_at>OLD.expires_at OR NEW.refresh_deadline>OLD.refresh_deadline
    OR NEW.generation<OLD.generation OR NEW.generation>OLD.generation+1
    OR (OLD.initial_issued_at IS NOT NULL AND NEW.initial_issued_at IS DISTINCT FROM OLD.initial_issued_at)
    OR (OLD.state IN ('revoked','suspended','expired') AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
    OR (OLD.state='active' AND NEW.state='pending')) THEN
    RAISE EXCEPTION 'admin binding cannot widen or resurrect' USING ERRCODE='23514';
  END IF;
  IF EXISTS (SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=NEW.provider_grant_id)
    AND NEW.state IN ('pending','active') THEN
    RAISE EXCEPTION 'family is fenced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_binding_guard BEFORE INSERT OR UPDATE OR DELETE ON commonswarm_oauth.admin_grant_bindings
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_admin_binding();

CREATE FUNCTION commonswarm_oauth.guard_admin_interaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'interaction history is immutable' USING ERRCODE='55000'; END IF;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.interactions i WHERE i.interaction_uid=NEW.interaction_uid
    AND i.user_id=NEW.owner_user_id AND i.client_id=NEW.client_id AND i.resource=NEW.resource
    AND i.redirect_uri=NEW.redirect_uri AND i.pkce_challenge=NEW.pkce_challenge
    AND i.requested_scopes=NEW.requested_scopes AND i.expires_at>=NEW.expires_at) THEN
    RAISE EXCEPTION 'interaction binding mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    (to_jsonb(NEW)-ARRAY['second_confirmation_binding','second_confirmed_at','consumed_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['second_confirmation_binding','second_confirmed_at','consumed_at'])
    OR (OLD.second_confirmation_binding IS NOT NULL AND NEW.second_confirmation_binding IS DISTINCT FROM OLD.second_confirmation_binding)
    OR (OLD.second_confirmed_at IS NOT NULL AND NEW.second_confirmed_at IS DISTINCT FROM OLD.second_confirmed_at)
    OR (OLD.consumed_at IS NOT NULL AND NEW.consumed_at IS DISTINCT FROM OLD.consumed_at)) THEN
    RAISE EXCEPTION 'interaction cannot rebind or consume twice' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_interaction_guard BEFORE INSERT OR UPDATE OR DELETE ON commonswarm_oauth.admin_interactions
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_admin_interaction();

CREATE FUNCTION commonswarm_oauth.guard_admin_parent_interaction() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF EXISTS(SELECT 1 FROM commonswarm_oauth.admin_interactions WHERE interaction_uid=OLD.interaction_uid)
    AND ROW(NEW.user_id,NEW.client_id,NEW.resource,NEW.redirect_uri,NEW.pkce_challenge,NEW.requested_scopes,NEW.session_hash,NEW.expires_at)
      IS DISTINCT FROM ROW(OLD.user_id,OLD.client_id,OLD.resource,OLD.redirect_uri,OLD.pkce_challenge,OLD.requested_scopes,OLD.session_hash,OLD.expires_at) THEN
    RAISE EXCEPTION 'admin parent interaction cannot rebind' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_parent_interaction_guard BEFORE UPDATE ON commonswarm_oauth.interactions
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_admin_parent_interaction();

CREATE FUNCTION commonswarm_oauth.guard_admin_consent_orchestration() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'consent orchestration history is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM swarm.admin_consents
    WHERE consent_receipt_id=NEW.receipt_id AND owner_user_id=NEW.owner_user_id) THEN
    RAISE EXCEPTION 'consent receipt owner mismatch' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND (
    (to_jsonb(NEW)-ARRAY['receipt_id','completed_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['receipt_id','completed_at'])
    OR (OLD.receipt_id IS NOT NULL AND NEW.receipt_id IS DISTINCT FROM OLD.receipt_id)
    OR (OLD.completed_at IS NOT NULL AND NEW.completed_at IS DISTINCT FROM OLD.completed_at)) THEN
    RAISE EXCEPTION 'consent command cannot rebind or complete twice' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_consent_orchestration_guard BEFORE INSERT OR UPDATE OR DELETE ON commonswarm_oauth.admin_consent_orchestration
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_admin_consent_orchestration();

CREATE FUNCTION commonswarm_oauth.guard_hosted_resource() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-resource:'||NEW.provider_grant_id,0));
  IF EXISTS (SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
    WHERE r.provider_grant_id=NEW.provider_grant_id AND
      ROW(r.grant_class,r.hosted_grant_id,r.owner_user_id,r.client_id,r.resource)
      IS DISTINCT FROM ROW('hosted_mcp'::text,NEW.grant_id,NEW.owner_user_id,NEW.client_id,NEW.resource))
    OR (TG_OP='UPDATE' AND EXISTS (SELECT 1 FROM commonswarm_oauth.provider_grant_resources r
      WHERE r.hosted_grant_id=OLD.grant_id AND
        ROW(r.provider_grant_id,r.owner_user_id,r.client_id,r.resource)
        IS DISTINCT FROM ROW(NEW.provider_grant_id,NEW.owner_user_id,NEW.client_id,NEW.resource))) THEN
    RAISE EXCEPTION 'hosted resource binding mismatch' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER hosted_resource_guard BEFORE INSERT OR UPDATE ON swarm.hosted_mcp_grants
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_hosted_resource();

CREATE FUNCTION commonswarm_oauth.guard_provider_artifact_resource() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE family text; old_family text; r commonswarm_oauth.provider_grant_resources%ROWTYPE; resource_map jsonb;
BEGIN
  family:=CASE WHEN NEW.model='Grant' THEN NEW.payload->>'jti' ELSE NEW.grant_id END;
  IF TG_OP='UPDATE' THEN
    old_family:=CASE WHEN OLD.model='Grant' THEN OLD.payload->>'jti' ELSE OLD.grant_id END;
    IF family IS DISTINCT FROM old_family AND EXISTS(SELECT 1 FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=old_family) THEN
      RAISE EXCEPTION 'artifact cannot change family' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT * INTO r FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id=family;
  resource_map:=NEW.payload->'resources';
  IF NOT FOUND OR r.grant_class='hosted_mcp' THEN
    -- MCP payloads (including backfilled families) retain the provider's native
    -- optional principals and scalar/array/absent resource fields. Only admin
    -- authority and immutable family changes are guarded here. In particular,
    -- consume/expiry bookkeeping must not revalidate an ordinary MCP payload.
    IF NEW.payload->'resource' @> to_jsonb('https://api.commonswarm.com/admin'::text)
      OR NEW.payload->'aud' @> to_jsonb('https://api.commonswarm.com/admin'::text) OR NEW.payload->>'grant_class'='delegated_admin'
      OR (jsonb_typeof(resource_map)='object' AND resource_map ? 'https://api.commonswarm.com/admin') THEN
      RAISE EXCEPTION 'admin artifact requires admin binding' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.payload->>'clientId' IS DISTINCT FROM r.client_id OR NEW.payload->>'accountId' IS DISTINCT FROM r.owner_user_id::text
    OR (NEW.payload ? 'grantId' AND NEW.payload->>'grantId' IS DISTINCT FROM family)
    OR (NEW.payload ? 'resource' AND NEW.payload->'resource' IS DISTINCT FROM to_jsonb(r.resource))
    OR (NEW.payload ? 'aud' AND NEW.payload->'aud' IS DISTINCT FROM to_jsonb(r.resource))
    OR (NEW.payload ? 'grant_class' AND NEW.payload->>'grant_class' IS DISTINCT FROM r.grant_class) THEN
    RAISE EXCEPTION 'artifact resource or principal mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.model='Grant' OR resource_map IS NOT NULL THEN
    IF resource_map IS NULL OR jsonb_typeof(resource_map)<>'object' THEN
      RAISE EXCEPTION 'grant resource map required' USING ERRCODE='23514';
    END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(resource_map))<>1 OR NOT (resource_map ? r.resource) THEN
      RAISE EXCEPTION 'grant must have exactly one bound resource' USING ERRCODE='23514';
    END IF;
    IF r.grant_class='delegated_admin' AND (jsonb_typeof(resource_map->r.resource)<>'string' OR NOT EXISTS(
      SELECT 1 FROM commonswarm_oauth.admin_grant_bindings b WHERE b.provider_grant_id=family
        AND regexp_split_to_array(btrim(resource_map->>r.resource),'\s+')<@b.scope_names)) THEN
      RAISE EXCEPTION 'grant resource scopes exceed consent' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.payload->'openid'->>'scope' ~ '(^|[[:space:]])admin:' THEN
    RAISE EXCEPTION 'admin scopes are resource only' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id=family) THEN
    RAISE EXCEPTION 'artifact family fenced' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER provider_artifact_resource_guard BEFORE INSERT OR UPDATE ON commonswarm_oauth.provider_artifacts
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_provider_artifact_resource();

-- Existing verified hosted authority is the only backfill source. Its grant UUID
-- supplies a stable connection identity; provider payloads alone supply nothing.
INSERT INTO commonswarm_oauth.provider_grant_resources
  (provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,hosted_grant_id,created_at)
SELECT provider_grant_id,resource,'hosted_mcp',owner_user_id,client_id,grant_id,grant_id,created_at
FROM swarm.hosted_mcp_grants;

DO $permissions$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_grant_resources','admin_grant_bindings','admin_interactions','admin_consent_orchestration'] LOOP
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I OWNER TO swarm_admin',t);
    -- RLS is intentionally not FORCE: owner-definer guards need private reads/writes (C+D).
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON commonswarm_oauth.%I FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime',t);
    EXECUTE format('CREATE POLICY oauth_runtime_select ON commonswarm_oauth.%I FOR SELECT TO commonswarm_oauth_runtime USING(true)',t);
    EXECUTE format('CREATE POLICY oauth_runtime_insert ON commonswarm_oauth.%I FOR INSERT TO commonswarm_oauth_runtime WITH CHECK(true)',t);
    EXECUTE format('GRANT SELECT,INSERT ON commonswarm_oauth.%I TO commonswarm_oauth_runtime',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['admin_grant_bindings','admin_interactions','admin_consent_orchestration'] LOOP
    EXECUTE format('CREATE POLICY oauth_runtime_update ON commonswarm_oauth.%I FOR UPDATE TO commonswarm_oauth_runtime USING(true) WITH CHECK(true)',t);
    EXECUTE format('GRANT UPDATE ON commonswarm_oauth.%I TO commonswarm_oauth_runtime',t);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['guard_provider_resource()','guard_admin_binding()','guard_admin_interaction()',
    'guard_admin_parent_interaction()','guard_admin_consent_orchestration()',
    'guard_hosted_resource()','guard_provider_artifact_resource()'] LOOP
    EXECUTE 'ALTER FUNCTION commonswarm_oauth.'||f||' OWNER TO swarm_admin';
    EXECUTE 'REVOKE ALL ON FUNCTION commonswarm_oauth.'||f||' FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime';
  END LOOP;
END $permissions$;

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
-- DROP TRIGGER provider_artifact_resource_guard ON commonswarm_oauth.provider_artifacts;
-- DROP FUNCTION commonswarm_oauth.guard_provider_artifact_resource();
-- DROP TRIGGER admin_parent_interaction_guard ON commonswarm_oauth.interactions;
-- DROP TRIGGER hosted_resource_guard ON swarm.hosted_mcp_grants;
-- DROP TABLE commonswarm_oauth.admin_consent_orchestration;
-- DROP TABLE commonswarm_oauth.admin_interactions;
-- DROP TABLE commonswarm_oauth.admin_grant_bindings;
-- DROP TABLE commonswarm_oauth.provider_grant_resources;
-- DROP FUNCTION commonswarm_oauth.guard_hosted_resource();
-- DROP FUNCTION commonswarm_oauth.guard_admin_interaction();
-- DROP FUNCTION commonswarm_oauth.guard_admin_parent_interaction();
-- DROP FUNCTION commonswarm_oauth.guard_admin_consent_orchestration();
-- DROP FUNCTION commonswarm_oauth.guard_admin_binding();
-- DROP FUNCTION commonswarm_oauth.guard_provider_resource();
-- ALTER TABLE commonswarm_oauth.interactions DROP CONSTRAINT interactions_resource_check;
-- ALTER TABLE commonswarm_oauth.interactions ADD CONSTRAINT interactions_resource_check CHECK (resource='https://mcp.commonswarm.com/mcp');
-- ALTER TABLE swarm.admin_grants DROP CONSTRAINT admin_grants_registry_version_check;
-- ALTER TABLE swarm.admin_grants ADD CONSTRAINT admin_grants_registry_version_check CHECK (registry_version=1);
