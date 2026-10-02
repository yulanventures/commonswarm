-- M2: client policy, shared DPoP admission and bounded lifecycle boundaries.
-- No client is seeded, no runtime gets swarm membership, no issuance is enabled.
DO $roles$
DECLARE n text; creator_is_cluster_administrator boolean;
BEGIN
  SELECT rolsuper INTO creator_is_cluster_administrator FROM pg_catalog.pg_roles WHERE rolname=current_user;
  FOREACH n IN ARRAY ARRAY['commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=n) THEN
      SET LOCAL createrole_self_grant='';
      EXECUTE format('CREATE ROLE %I NOLOGIN NOINHERIT NOCREATEDB NOCREATEROLE',n);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=n AND
      (rolcanlogin OR rolinherit OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.roleid
        WHERE r.rolname=n AND (m.inherit_option OR m.set_option))
      OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member WHERE r.rolname=n) THEN
      RAISE EXCEPTION 'unsafe admin policy role: %',n;
    END IF;
    -- Preserve the oauth-store creator-membership contract (20260928000003:48-95),
    -- including pre-existing roles: only a non-superuser creator's admin-only edge.
    IF creator_is_cluster_administrator AND EXISTS (
      SELECT 1 FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=m.member
      WHERE parent.rolname=n AND member.rolname=current_user) THEN
      RAISE EXCEPTION 'admin policy administrator membership is unnecessary: %',n;
    ELSIF NOT creator_is_cluster_administrator AND (
      SELECT count(*)<>1 OR NOT coalesce(bool_and(m.admin_option AND NOT m.inherit_option AND NOT m.set_option),false)
      FROM pg_catalog.pg_auth_members m
      JOIN pg_catalog.pg_roles parent ON parent.oid=m.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=m.member
      WHERE parent.rolname=n AND member.rolname=current_user) THEN
      RAISE EXCEPTION 'admin policy creator membership is unsafe: %',n;
    END IF;
  END LOOP;
END $roles$;
GRANT USAGE ON SCHEMA commonswarm_oauth TO commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance,swarm_command;
REVOKE ALL ON SCHEMA swarm FROM commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance;

CREATE TABLE commonswarm_oauth.admin_verified_clients (
  client_id text NOT NULL CHECK (octet_length(client_id) BETWEEN 1 AND 2048),
  verification_version integer NOT NULL CHECK (verification_version>0),
  application_type text NOT NULL CHECK (application_type='web'),
  registration_source text NOT NULL CHECK (registration_source IN ('static','cimd')),
  publisher_identity text NOT NULL CHECK (octet_length(publisher_identity) BETWEEN 1 AND 512),
  publisher_contact text NOT NULL CHECK (octet_length(publisher_contact) BETWEEN 1 AND 512),
  metadata_digest text NOT NULL CHECK (metadata_digest ~ '^[0-9a-f]{64}$'),
  redirect_uris text[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 32 AND array_position(redirect_uris,NULL) IS NULL),
  scope_ceiling text[] NOT NULL CHECK (cardinality(scope_ceiling) BETWEEN 1 AND 32 AND array_position(scope_ceiling,NULL) IS NULL
    AND NOT ('admin:delegate'=ANY(scope_ceiling)) AND NOT ('mcp'=ANY(scope_ceiling))),
  full_account_eligible boolean NOT NULL DEFAULT false,
  delegation_eligible boolean NOT NULL DEFAULT false CHECK (NOT delegation_eligible),
  native_loopback_eligible boolean NOT NULL DEFAULT false CHECK (NOT native_loopback_eligible),
  pkce_s256_tested boolean NOT NULL CHECK (pkce_s256_tested),
  dpop_tested boolean NOT NULL CHECK (dpop_tested),
  redirect_tested boolean NOT NULL CHECK (redirect_tested),
  origin_control_verified boolean NOT NULL CHECK (origin_control_verified),
  review_evidence_ref text NOT NULL CHECK (octet_length(review_evidence_ref) BETWEEN 1 AND 2048),
  reviewed_by text NOT NULL CHECK (octet_length(reviewed_by) BETWEEN 1 AND 256),
  reviewed_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  active boolean NOT NULL DEFAULT false,
  withdrawn_at timestamptz,
  withdrawal_reason text CHECK (octet_length(withdrawal_reason) BETWEEN 1 AND 128),
  PRIMARY KEY (client_id,verification_version),
  CHECK ((active AND withdrawn_at IS NULL) OR NOT active)
);
CREATE UNIQUE INDEX admin_client_active_version ON commonswarm_oauth.admin_verified_clients(client_id) WHERE active;
CREATE TABLE commonswarm_oauth.admin_client_owner_approvals (
  owner_user_id uuid NOT NULL REFERENCES swarm.admin_accounts(owner_user_id),
  client_id text NOT NULL,
  verification_version integer NOT NULL,
  approved_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  approval_event_id uuid NOT NULL REFERENCES swarm.admin_events(event_id),
  approval_command_id text NOT NULL CHECK (octet_length(approval_command_id) BETWEEN 1 AND 200),
  withdrawn_at timestamptz,
  withdrawal_event_id uuid REFERENCES swarm.admin_events(event_id),
  withdrawal_reason text CHECK (octet_length(withdrawal_reason) BETWEEN 1 AND 128),
  PRIMARY KEY (owner_user_id,client_id,verification_version),
  FOREIGN KEY (client_id,verification_version) REFERENCES commonswarm_oauth.admin_verified_clients,
  CHECK ((withdrawn_at IS NULL AND withdrawal_event_id IS NULL AND withdrawal_reason IS NULL)
    OR (withdrawn_at IS NOT NULL AND withdrawal_event_id IS NOT NULL AND withdrawal_reason IS NOT NULL))
);
ALTER TABLE commonswarm_oauth.admin_grant_bindings ADD CONSTRAINT admin_binding_verified_client
  FOREIGN KEY (client_id,verification_version) REFERENCES commonswarm_oauth.admin_verified_clients;
ALTER TABLE commonswarm_oauth.admin_grant_bindings ADD CONSTRAINT admin_binding_owner_approval
  FOREIGN KEY (owner_user_id,client_id,verification_version) REFERENCES commonswarm_oauth.admin_client_owner_approvals;
ALTER TABLE commonswarm_oauth.admin_interactions ADD CONSTRAINT admin_interaction_verified_client
  FOREIGN KEY (client_id,verification_version) REFERENCES commonswarm_oauth.admin_verified_clients;

CREATE TABLE commonswarm_oauth.dpop_proof_replays (
  jti text NOT NULL CHECK (octet_length(jti) BETWEEN 1 AND 200),
  jkt text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  verifier_domain text NOT NULL CHECK (verifier_domain IN ('as','admin_mcp','admin_command')),
  accepted_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '5 minutes',
  PRIMARY KEY (jti,jkt),
  CHECK (expires_at=accepted_at+interval '5 minutes')
);
CREATE INDEX dpop_replays_expiry ON commonswarm_oauth.dpop_proof_replays(expires_at);
CREATE TABLE commonswarm_oauth.dpop_nonces (
  nonce_digest bytea NOT NULL CHECK (octet_length(nonce_digest)=32),
  jkt text NOT NULL CHECK (jkt ~ '^[A-Za-z0-9_-]{43}$'),
  verifier_domain text NOT NULL CHECK (verifier_domain IN ('as','admin_resource')),
  issued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT statement_timestamp()+interval '60 seconds',
  PRIMARY KEY (nonce_digest,jkt,verifier_domain),
  CHECK (expires_at=issued_at+interval '60 seconds')
);
CREATE INDEX dpop_nonces_expiry ON commonswarm_oauth.dpop_nonces(expires_at);
CREATE INDEX dpop_nonces_key_domain ON commonswarm_oauth.dpop_nonces(jkt,verifier_domain,expires_at);
CREATE TABLE commonswarm_oauth.issuer_key_denials (
  issuer text NOT NULL CHECK (issuer='https://mcp.commonswarm.com'),
  kid text NOT NULL CHECK (octet_length(kid) BETWEEN 1 AND 200),
  denied_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  reason text NOT NULL CHECK (octet_length(reason) BETWEEN 1 AND 128),
  evidence_ref text NOT NULL CHECK (octet_length(evidence_ref) BETWEEN 1 AND 2048),
  PRIMARY KEY (issuer,kid)
);
CREATE TRIGGER issuer_key_denials_append_only BEFORE UPDATE OR DELETE ON commonswarm_oauth.issuer_key_denials
  FOR EACH ROW EXECUTE FUNCTION swarm.prevent_append_only_mutation();

-- Calls happen after cryptographic checks. Caller commits admission separately
-- before authority dispatch; no raw proof/token/key/nonce is stored here.
CREATE FUNCTION commonswarm_oauth.register_dpop_nonce(p_digest bytea,p_jkt text,p_domain text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE n integer;
BEGIN
  IF p_digest IS NULL OR octet_length(p_digest)<>32 OR p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$'
    OR p_domain IS NULL OR p_domain NOT IN ('as','admin_resource') THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('dpop-nonce:'||p_jkt||':'||p_domain,0));
  IF (SELECT count(*) FROM commonswarm_oauth.dpop_nonces WHERE jkt=p_jkt AND verifier_domain=p_domain
      AND expires_at>clock_timestamp())>=8 THEN RETURN false; END IF;
  INSERT INTO commonswarm_oauth.dpop_nonces(nonce_digest,jkt,verifier_domain,issued_at,expires_at)
    SELECT p_digest,p_jkt,p_domain,t,t+interval '60 seconds' FROM (SELECT clock_timestamp() AS t) accepted
    ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT;
  RETURN n=1;
END $fn$;

CREATE FUNCTION commonswarm_oauth.resolve_provider_grant_status(p_provider_grant_id text,p_owner_user_id uuid,p_kid text)
RETURNS TABLE(grant_id uuid,grant_class text,client_id text,resource text,active boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE class_name text;
BEGIN
  SELECT r.grant_class INTO class_name FROM commonswarm_oauth.provider_grant_resources r
    WHERE r.provider_grant_id=p_provider_grant_id AND r.owner_user_id=p_owner_user_id;
  IF class_name='delegated_admin' THEN
    RETURN QUERY SELECT s.admin_grant_id,'delegated_admin'::text,s.client_id,s.resource,s.active
      FROM commonswarm_oauth.resolve_admin_grant_status(p_provider_grant_id,p_owner_user_id,p_kid) s;
  ELSIF class_name='hosted_mcp' THEN
    RETURN QUERY SELECT s.grant_id,'hosted_mcp'::text,s.client_id,s.resource,s.active
      FROM commonswarm_oauth.resolve_hosted_grant_status(p_provider_grant_id) s WHERE s.owner_user_id=p_owner_user_id;
  END IF;
END $fn$;
CREATE TYPE commonswarm_oauth.dpop_admission_status AS ENUM ('accepted','nonce_required','stale_proof','replay');

CREATE FUNCTION commonswarm_oauth.admit_dpop_proof(p_jti text,p_jkt text,p_domain text,p_iat bigint,p_nonce_digest bytea) RETURNS commonswarm_oauth.dpop_admission_status
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE n integer; at_time timestamptz:=clock_timestamp(); nonce_domain text;
BEGIN
  IF p_jti IS NULL OR octet_length(p_jti) NOT BETWEEN 1 AND 200 OR p_jkt IS NULL OR p_jkt !~ '^[A-Za-z0-9_-]{43}$'
    OR p_domain IS NULL OR p_domain NOT IN ('as','admin_mcp','admin_command') OR p_iat IS NULL
    OR p_iat<extract(epoch FROM at_time)-60 OR p_iat>extract(epoch FROM at_time)+5 THEN RETURN 'stale_proof'; END IF;
  IF p_nonce_digest IS NULL OR octet_length(p_nonce_digest)<>32 THEN RETURN 'nonce_required'; END IF;
  nonce_domain:=CASE WHEN p_domain='as' THEN 'as' ELSE 'admin_resource' END;
  IF NOT EXISTS (SELECT 1 FROM commonswarm_oauth.dpop_nonces WHERE nonce_digest=p_nonce_digest
    AND jkt=p_jkt AND verifier_domain=nonce_domain AND issued_at<=at_time AND expires_at>at_time) THEN RETURN 'nonce_required'; END IF;
  INSERT INTO commonswarm_oauth.dpop_proof_replays(jti,jkt,verifier_domain,accepted_at,expires_at)
    VALUES(p_jti,p_jkt,p_domain,at_time,at_time+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING 1 INTO n;
  RETURN CASE WHEN n=1 THEN 'accepted'::commonswarm_oauth.dpop_admission_status
    ELSE 'replay'::commonswarm_oauth.dpop_admission_status END;
END $fn$;
CREATE FUNCTION commonswarm_oauth.purge_expired_dpop(p_limit integer DEFAULT 1000)
RETURNS TABLE(replays_deleted integer,nonces_deleted integer)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 10000 THEN RAISE EXCEPTION 'invalid cleanup bound' USING ERRCODE='22023'; END IF;
  WITH expired AS (SELECT jti,jkt FROM commonswarm_oauth.dpop_proof_replays WHERE expires_at<=statement_timestamp()
    ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM commonswarm_oauth.dpop_proof_replays r USING expired e WHERE r.jti=e.jti AND r.jkt=e.jkt;
  GET DIAGNOSTICS replays_deleted=ROW_COUNT;
  WITH expired AS (SELECT nonce_digest,jkt,verifier_domain FROM commonswarm_oauth.dpop_nonces WHERE expires_at<=statement_timestamp()
    ORDER BY expires_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  DELETE FROM commonswarm_oauth.dpop_nonces n USING expired e
    WHERE n.nonce_digest=e.nonce_digest AND n.jkt=e.jkt AND n.verifier_domain=e.verifier_domain;
  GET DIAGNOSTICS nonces_deleted=ROW_COUNT;
  RETURN NEXT;
END $fn$;

CREATE FUNCTION commonswarm_oauth.issuer_key_allowed(p_issuer text,p_kid text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_issuer IS NULL OR p_issuer<>'https://mcp.commonswarm.com' OR p_kid IS NULL
    OR octet_length(p_kid) NOT BETWEEN 1 AND 200 THEN RETURN false; END IF;
  -- Even an absent denial row has a lock, shared with denial insertion.
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer-key:'||p_issuer||':'||p_kid,0));
  RETURN NOT EXISTS (SELECT 1 FROM commonswarm_oauth.issuer_key_denials WHERE issuer=p_issuer AND kid=p_kid);
END $fn$;
CREATE FUNCTION commonswarm_oauth.lock_issuer_key_denial() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('issuer-key:'||NEW.issuer||':'||NEW.kid,0));
  RETURN NEW;
END $fn$;
CREATE TRIGGER issuer_key_denial_lock BEFORE INSERT ON commonswarm_oauth.issuer_key_denials
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.lock_issuer_key_denial();

-- First owner approval has no provider binding yet. Hold this exact verification
-- before the account/grant locks, without giving command callers verification DML.
-- M2's web-only constraints and redirect guard enforce the hosted HTTPS class.
-- Returned scalar facts carry no table row type or write authority.
CREATE FUNCTION commonswarm_oauth.lock_admin_client_verification(p_client_id text,p_verification_version integer)
RETURNS TABLE(client_id text,verification_version integer,active boolean,withdrawn_at timestamptz,
  metadata_digest text,application_type text,redirect_uris text[],redirect_class text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v commonswarm_oauth.admin_verified_clients%ROWTYPE;
BEGIN
  SELECT c.* INTO v FROM commonswarm_oauth.admin_verified_clients c
    WHERE c.client_id=p_client_id AND c.verification_version=p_verification_version FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'admin client verification not found'; END IF;
  RETURN QUERY SELECT v.client_id,v.verification_version,v.active,v.withdrawn_at,
    v.metadata_digest,v.application_type,v.redirect_uris,'hosted_https'::text;
END $fn$;

-- AS consent has no family yet. Lock verification before owner/grant locks,
-- then the consenting account and its exact approval; never create authority.
-- Facts are explicit scalars, not a private row type. Missing approval is false.
CREATE FUNCTION commonswarm_oauth.lock_admin_consent_policy(p_client_id text,p_verification_version integer,p_owner_user_id uuid)
RETURNS TABLE(client_id text,verification_version integer,metadata_digest text,redirect_uris text[],scope_ceiling text[],
  full_account_eligible boolean,active boolean,owner_approved boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v commonswarm_oauth.admin_verified_clients%ROWTYPE; approved boolean:=false;
BEGIN
  IF p_client_id IS NULL OR octet_length(p_client_id) NOT BETWEEN 1 AND 2048
    OR p_verification_version IS NULL OR p_verification_version<=0 OR p_owner_user_id IS NULL THEN RETURN; END IF;
  SELECT c.* INTO v FROM commonswarm_oauth.admin_verified_clients c
    WHERE c.client_id=p_client_id AND c.verification_version=p_verification_version FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM swarm.admin_accounts WHERE owner_user_id=p_owner_user_id FOR UPDATE;
  PERFORM 1 FROM commonswarm_oauth.admin_client_owner_approvals a WHERE a.owner_user_id=p_owner_user_id
    AND a.client_id=p_client_id AND a.verification_version=p_verification_version AND a.withdrawn_at IS NULL FOR SHARE;
  approved:=FOUND;
  RETURN QUERY SELECT v.client_id,v.verification_version,v.metadata_digest,v.redirect_uris,v.scope_ceiling,
    v.full_account_eligible,v.active AND v.withdrawn_at IS NULL,approved;
END $fn$;

CREATE FUNCTION commonswarm_oauth.resolve_admin_grant_status(p_provider_grant_id text,p_owner_user_id uuid,p_kid text)
RETURNS TABLE(admin_grant_id uuid,admin_identity_id uuid,connection_id uuid,client_id text,resource text,
  jkt text,manifest_digest text,registry_version integer,scope_names text[],capabilities text[],expires_at timestamptz,active boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b commonswarm_oauth.admin_grant_bindings%ROWTYPE; g swarm.admin_grants%ROWTYPE;
  v commonswarm_oauth.admin_verified_clients%ROWTYPE; approved boolean; key_ok boolean;
BEGIN
  key_ok:=commonswarm_oauth.issuer_key_allowed('https://mcp.commonswarm.com',p_kid);
  SELECT * INTO b FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=p_provider_grant_id AND owner_user_id=p_owner_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT * INTO v FROM commonswarm_oauth.admin_verified_clients WHERE
    admin_verified_clients.client_id=b.client_id AND verification_version=b.verification_version FOR SHARE;
  PERFORM 1 FROM swarm.admin_accounts WHERE owner_user_id=b.owner_user_id FOR SHARE;
  SELECT * INTO g FROM swarm.admin_grants WHERE grant_id=b.admin_grant_id FOR SHARE;
  SELECT * INTO b FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=p_provider_grant_id FOR SHARE;
  SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_client_owner_approvals a WHERE
    a.owner_user_id=b.owner_user_id AND a.client_id=b.client_id AND a.verification_version=b.verification_version
    AND a.withdrawn_at IS NULL) INTO approved;
  RETURN QUERY SELECT b.admin_grant_id,b.admin_identity_id,b.connection_id,b.client_id,b.resource,b.jkt,b.manifest_digest,
    b.registry_version,b.scope_names,b.capabilities,least(b.expires_at,g.expires_at,b.refresh_deadline,g.refresh_deadline),
    COALESCE(key_ok AND v.active AND v.withdrawn_at IS NULL AND approved AND b.scope_names<@v.scope_ceiling
      AND (g.mode<>'full_account' OR v.full_account_eligible) AND g.state='active' AND g.revoked_at IS NULL
      AND g.suspended_at IS NULL AND b.state='active' AND b.terminal_at IS NULL
      AND b.scope_names<@g.scope_names AND g.manifest_digest=b.manifest_digest AND g.registry_version=b.registry_version
      AND least(b.expires_at,g.expires_at,b.refresh_deadline,g.refresh_deadline)>clock_timestamp()
      AND NOT EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones t WHERE t.grant_id=b.provider_grant_id),false);
END $fn$;

-- Caller is the trusted transaction coordinator/human command path. This can
-- only remove authority. Domain events are added by that path in the SAME tx.
CREATE FUNCTION commonswarm_oauth.fence_admin_family(p_provider_grant_id text,p_owner_user_id uuid,p_state text,p_reason text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE b commonswarm_oauth.admin_grant_bindings%ROWTYPE;
BEGIN
  IF p_state IS NULL OR p_state NOT IN ('revoked','suspended','expired') OR p_reason IS NULL
    OR octet_length(p_reason) NOT BETWEEN 1 AND 128 THEN RAISE EXCEPTION 'invalid fence' USING ERRCODE='22023'; END IF;
  SELECT * INTO b FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=p_provider_grant_id AND owner_user_id=p_owner_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM commonswarm_oauth.admin_verified_clients WHERE client_id=b.client_id AND verification_version=b.verification_version FOR SHARE;
  PERFORM 1 FROM swarm.admin_accounts WHERE owner_user_id=b.owner_user_id FOR UPDATE;
  PERFORM 1 FROM swarm.admin_grants WHERE grant_id=b.admin_grant_id FOR UPDATE;
  PERFORM 1 FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id=b.provider_grant_id FOR UPDATE;
  UPDATE swarm.admin_grants SET state=p_state,reason_code=p_reason,
    revoked_at=CASE WHEN p_state='revoked' THEN statement_timestamp() ELSE revoked_at END,
    suspended_at=CASE WHEN p_state='suspended' THEN statement_timestamp() ELSE suspended_at END
    WHERE grant_id=b.admin_grant_id AND state='active';
  UPDATE commonswarm_oauth.admin_grant_bindings SET state=p_state,terminal_at=statement_timestamp()
    WHERE provider_grant_id=b.provider_grant_id AND state IN ('active','pending');
  INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at)
    VALUES(b.provider_grant_id,statement_timestamp()) ON CONFLICT DO NOTHING;
  RETURN true;
END $fn$;

CREATE FUNCTION commonswarm_oauth.guard_verified_client() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE uri text; b record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'verification history is immutable' USING ERRCODE='55000'; END IF;
  FOREACH uri IN ARRAY NEW.redirect_uris LOOP
    IF octet_length(uri)>4096 OR uri ~ '[[:space:][:cntrl:]]'
      OR uri !~ '^https://[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z][A-Za-z0-9-]*(:443)?(/|$)'
      OR uri ~* '^https://(localhost|[^/]*\.localhost|127\.[^/]*|0\.0\.0\.0)(:|/|$)' THEN
      RAISE EXCEPTION 'admin redirect must be public HTTPS' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF TG_OP='UPDATE' THEN
    IF (to_jsonb(NEW)-ARRAY['active','withdrawn_at','withdrawal_reason']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['active','withdrawn_at','withdrawal_reason'])
      OR (OLD.withdrawn_at IS NOT NULL AND to_jsonb(NEW) IS DISTINCT FROM to_jsonb(OLD))
      OR (OLD.active AND NOT NEW.active AND (NEW.withdrawn_at IS NULL OR NEW.withdrawal_reason IS NULL)) THEN
      RAISE EXCEPTION 'changed verification requires a new reviewed version' USING ERRCODE='23514';
    END IF;
    IF OLD.active AND NOT NEW.active THEN
      FOR b IN SELECT provider_grant_id,owner_user_id FROM commonswarm_oauth.admin_grant_bindings
        WHERE client_id=OLD.client_id AND verification_version=OLD.verification_version ORDER BY owner_user_id,admin_grant_id LOOP
        PERFORM commonswarm_oauth.fence_admin_family(b.provider_grant_id,b.owner_user_id,'suspended',NEW.withdrawal_reason);
      END LOOP;
    END IF;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_verification_guard BEFORE INSERT OR UPDATE OR DELETE ON commonswarm_oauth.admin_verified_clients
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_verified_client();

-- Invoker security: only swarm_command can write this table, after the
-- human-only reducer. Approval evidence must name that owner and command.
-- Verification prep/OAuth/definer status functions cannot create an approval.
CREATE FUNCTION commonswarm_oauth.guard_owner_approval() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
DECLARE e jsonb; b record;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'approval history is immutable' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT event INTO e FROM swarm.admin_events WHERE event_id=NEW.approval_event_id
      AND owner_user_id=NEW.owner_user_id AND command_id=NEW.approval_command_id;
    IF e IS NULL OR e->>'type' IS DISTINCT FROM 'AdminClientApproved'
      OR e->>'actor_user' IS DISTINCT FROM NEW.owner_user_id::text
      OR e->'payload'->>'client_id' IS DISTINCT FROM NEW.client_id
      OR e->'payload'->>'verification_version' IS DISTINCT FROM NEW.verification_version::text
      OR NEW.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'human approval evidence required' USING ERRCODE='23514'; END IF;
  ELSE
    IF (to_jsonb(NEW)-ARRAY['withdrawn_at','withdrawal_event_id','withdrawal_reason']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['withdrawn_at','withdrawal_event_id','withdrawal_reason']) OR OLD.withdrawn_at IS NOT NULL THEN
      RAISE EXCEPTION 'approval cannot rebind or resurrect' USING ERRCODE='23514';
    END IF;
    SELECT event INTO e FROM swarm.admin_events WHERE event_id=NEW.withdrawal_event_id AND owner_user_id=NEW.owner_user_id;
    IF e IS NULL OR e->>'type' IS DISTINCT FROM 'AdminClientApprovalWithdrawn'
      OR e->>'actor_user' IS DISTINCT FROM NEW.owner_user_id::text
      OR e->'payload'->>'client_id' IS DISTINCT FROM NEW.client_id
      OR e->'payload'->>'verification_version' IS DISTINCT FROM NEW.verification_version::text THEN
      RAISE EXCEPTION 'human withdrawal evidence required' USING ERRCODE='23514';
    END IF;
    FOR b IN SELECT provider_grant_id FROM commonswarm_oauth.admin_grant_bindings WHERE owner_user_id=NEW.owner_user_id
      AND client_id=NEW.client_id AND verification_version=NEW.verification_version ORDER BY admin_grant_id LOOP
      PERFORM commonswarm_oauth.fence_admin_family(b.provider_grant_id,NEW.owner_user_id,'revoked',NEW.withdrawal_reason);
    END LOOP;
  END IF;
  RETURN NEW;
END $fn$;
CREATE TRIGGER admin_owner_approval_guard BEFORE INSERT OR UPDATE OR DELETE ON commonswarm_oauth.admin_client_owner_approvals
  FOR EACH ROW EXECUTE FUNCTION commonswarm_oauth.guard_owner_approval();

DO $permissions$
DECLARE t text; f text;
BEGIN
  FOREACH t IN ARRAY ARRAY['admin_verified_clients','admin_client_owner_approvals','dpop_proof_replays','dpop_nonces','issuer_key_denials'] LOOP
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I OWNER TO swarm_admin',t);
    -- RLS is intentionally not FORCE: owner-definer proof/lifecycle functions need it (C+D).
    EXECUTE format('ALTER TABLE commonswarm_oauth.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON commonswarm_oauth.%I FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_dpop_verifier,commonswarm_oauth_maintenance,commonswarm_admin_release',t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['admin_verified_clients','admin_client_owner_approvals'] LOOP
    EXECUTE format('CREATE POLICY policy_read ON commonswarm_oauth.%I FOR SELECT TO commonswarm_oauth_runtime,swarm_command USING(true)',t);
    EXECUTE format('GRANT SELECT ON commonswarm_oauth.%I TO commonswarm_oauth_runtime,swarm_command',t);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['register_dpop_nonce(bytea,text,text)','admit_dpop_proof(text,text,text,bigint,bytea)',
    'purge_expired_dpop(integer)','issuer_key_allowed(text,text)','lock_issuer_key_denial()',
    'lock_admin_client_verification(text,integer)','lock_admin_consent_policy(text,integer,uuid)',
    'resolve_admin_grant_status(text,uuid,text)','resolve_provider_grant_status(text,uuid,text)',
    'fence_admin_family(text,uuid,text,text)','guard_verified_client()','guard_owner_approval()'] LOOP
    EXECUTE 'ALTER FUNCTION commonswarm_oauth.'||f||' OWNER TO swarm_admin';
    EXECUTE 'REVOKE ALL ON FUNCTION commonswarm_oauth.'||f||' FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_dpop_verifier,commonswarm_oauth_maintenance,commonswarm_admin_release';
  END LOOP;
END $permissions$;
ALTER TYPE commonswarm_oauth.dpop_admission_status OWNER TO swarm_admin;
REVOKE ALL ON TYPE commonswarm_oauth.dpop_admission_status FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_admin_release,commonswarm_oauth_maintenance;
GRANT USAGE ON TYPE commonswarm_oauth.dpop_admission_status TO commonswarm_oauth_runtime,commonswarm_dpop_verifier;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid) TO commonswarm_oauth_runtime;

CREATE POLICY verification_release ON commonswarm_oauth.admin_verified_clients FOR ALL TO commonswarm_admin_release USING(true) WITH CHECK(true);
GRANT SELECT,INSERT,UPDATE ON commonswarm_oauth.admin_verified_clients TO commonswarm_admin_release;
CREATE POLICY approval_insert ON commonswarm_oauth.admin_client_owner_approvals FOR INSERT TO swarm_command WITH CHECK(true);
CREATE POLICY approval_update ON commonswarm_oauth.admin_client_owner_approvals FOR UPDATE TO swarm_command USING(true) WITH CHECK(true);
GRANT INSERT,UPDATE ON commonswarm_oauth.admin_client_owner_approvals TO swarm_command;
-- The invoker withdrawal trigger reads only family locators, never mutates them.
CREATE POLICY command_binding_read ON commonswarm_oauth.admin_grant_bindings FOR SELECT TO swarm_command USING(true);
GRANT SELECT(provider_grant_id,admin_grant_id,owner_user_id,client_id,verification_version)
  ON commonswarm_oauth.admin_grant_bindings TO swarm_command;
CREATE POLICY denial_release_read ON commonswarm_oauth.issuer_key_denials FOR SELECT TO commonswarm_admin_release USING(true);
CREATE POLICY denial_release_insert ON commonswarm_oauth.issuer_key_denials FOR INSERT TO commonswarm_admin_release WITH CHECK(true);
GRANT SELECT,INSERT ON commonswarm_oauth.issuer_key_denials TO commonswarm_admin_release;
-- Human account-command path only. No runtime, worker, hosted-seat or public grant.
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer) TO swarm_command;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.register_dpop_nonce(bytea,text,text),
  commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea) TO commonswarm_oauth_runtime,commonswarm_dpop_verifier;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.purge_expired_dpop(integer) TO commonswarm_oauth_maintenance;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.issuer_key_allowed(text,text),
  commonswarm_oauth.resolve_admin_grant_status(text,uuid,text),commonswarm_oauth.resolve_provider_grant_status(text,uuid,text)
  TO commonswarm_oauth_runtime,swarm_command,swarm_read;
GRANT EXECUTE ON FUNCTION commonswarm_oauth.fence_admin_family(text,uuid,text,text)
  TO commonswarm_oauth_runtime,swarm_command,commonswarm_admin_release;

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
-- ALTER TABLE commonswarm_oauth.admin_interactions DROP CONSTRAINT admin_interaction_verified_client;
-- ALTER TABLE commonswarm_oauth.admin_grant_bindings DROP CONSTRAINT admin_binding_owner_approval;
-- ALTER TABLE commonswarm_oauth.admin_grant_bindings DROP CONSTRAINT admin_binding_verified_client;
-- DROP TABLE commonswarm_oauth.admin_client_owner_approvals;
-- DROP TABLE commonswarm_oauth.admin_verified_clients;
-- DROP TABLE commonswarm_oauth.dpop_proof_replays;
-- DROP TABLE commonswarm_oauth.dpop_nonces;
-- DROP TABLE commonswarm_oauth.issuer_key_denials;
-- DROP FUNCTION commonswarm_oauth.guard_owner_approval();
-- DROP FUNCTION commonswarm_oauth.guard_verified_client();
-- DROP FUNCTION commonswarm_oauth.resolve_provider_grant_status(text,uuid,text);
-- DROP FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer);
-- DROP FUNCTION commonswarm_oauth.lock_admin_consent_policy(text,integer,uuid);
-- DROP FUNCTION commonswarm_oauth.resolve_admin_grant_status(text,uuid,text);
-- DROP FUNCTION commonswarm_oauth.fence_admin_family(text,uuid,text,text);
-- DROP FUNCTION commonswarm_oauth.lock_issuer_key_denial();
-- DROP FUNCTION commonswarm_oauth.issuer_key_allowed(text,text);
-- DROP FUNCTION commonswarm_oauth.purge_expired_dpop(integer);
-- DROP FUNCTION commonswarm_oauth.admit_dpop_proof(text,text,text,bigint,bytea);
-- DROP TYPE commonswarm_oauth.dpop_admission_status;
-- DROP FUNCTION commonswarm_oauth.register_dpop_nonce(bytea,text,text);
-- DROP POLICY command_binding_read ON commonswarm_oauth.admin_grant_bindings;
-- REVOKE SELECT(provider_grant_id,admin_grant_id,owner_user_id,client_id,verification_version) ON commonswarm_oauth.admin_grant_bindings FROM swarm_command;
-- REVOKE USAGE ON SCHEMA commonswarm_oauth FROM commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance,swarm_command;
-- -- Retain dormant NOLOGIN roles; never remove an operator-owned/pre-existing role.
-- -- Retain safe admin-only creator memberships; rollback never grants SET/INHERIT.
