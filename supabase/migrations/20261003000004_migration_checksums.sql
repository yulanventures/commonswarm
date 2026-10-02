-- D2: independent release checksum evidence, applied in the next schema window.
-- No backfill or activation occurs here. The release worker inserts each hash
-- in the SAME transaction as its supabase_migrations.schema_migrations insert.
-- Existing versions are backfilled from files at the actually released SHA,
-- with source='backfill'; expected activation hashes are never observed evidence.
CREATE SCHEMA IF NOT EXISTS commonswarm_ops AUTHORIZATION swarm_admin;
DO $schema$ BEGIN
  IF (SELECT nspowner FROM pg_catalog.pg_namespace WHERE nspname='commonswarm_ops')<>'swarm_admin'::regrole THEN
    RAISE EXCEPTION 'commonswarm_ops has unexpected owner';
  END IF;
END $schema$;
REVOKE ALL ON SCHEMA commonswarm_ops FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
GRANT USAGE ON SCHEMA commonswarm_ops TO commonswarm_admin_release,commonswarm_oauth_runtime,swarm_command;
CREATE TABLE commonswarm_ops.migration_checksums (
  version text PRIMARY KEY,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  applied_at timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL CHECK (source IN ('release','backfill')),
  released_sha text NOT NULL CHECK (released_sha ~ '^[0-9a-f]{40}$')
);
ALTER TABLE commonswarm_ops.migration_checksums OWNER TO swarm_admin;
ALTER TABLE commonswarm_ops.migration_checksums ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON commonswarm_ops.migration_checksums FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
CREATE POLICY checksum_release_insert ON commonswarm_ops.migration_checksums FOR INSERT TO commonswarm_admin_release WITH CHECK(true);
CREATE POLICY checksum_runtime_read ON commonswarm_ops.migration_checksums FOR SELECT TO commonswarm_oauth_runtime,swarm_command USING(true);
GRANT INSERT ON commonswarm_ops.migration_checksums TO commonswarm_admin_release;
GRANT SELECT ON commonswarm_ops.migration_checksums TO commonswarm_oauth_runtime,swarm_command;

CREATE FUNCTION commonswarm_ops.guard_migration_checksums() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $fn$
BEGIN
  -- Invoker security: even a mistaken non-owner UPDATE/DELETE grant cannot
  -- rewrite evidence. Only the table owner has the administrative exception.
  IF current_user IS DISTINCT FROM pg_get_userbyid((SELECT relowner FROM pg_class
    WHERE oid=TG_RELID)) THEN
    RAISE EXCEPTION 'migration checksums are append-only' USING ERRCODE='55000';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
ALTER FUNCTION commonswarm_ops.guard_migration_checksums() OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_ops.guard_migration_checksums() FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
CREATE TRIGGER migration_checksums_append_only BEFORE UPDATE OR DELETE ON commonswarm_ops.migration_checksums
  FOR EACH ROW EXECUTE FUNCTION commonswarm_ops.guard_migration_checksums();

-- A nonempty JSON array of exact {version,sha256} records. Reject malformed or
-- duplicate requirements, rather than letting an empty/NULL list look complete.
-- Activation callers must supply all five admin prerequisites, OAuth store,
-- DCR and M1-M3 from their reviewed required set, on every gate call.
GRANT USAGE ON SCHEMA supabase_migrations TO swarm_admin;
GRANT SELECT ON supabase_migrations.schema_migrations TO swarm_admin;
CREATE FUNCTION commonswarm_ops.migration_checksum_failures(p_required jsonb)
RETURNS TABLE(version text,required_sha256 text,recorded_sha256 text,reason text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
BEGIN
  IF p_required IS NULL OR jsonb_typeof(p_required) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'invalid migration requirements' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(p_required) NOT BETWEEN 1 AND 512 THEN
    RAISE EXCEPTION 'invalid migration requirement count' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_required) e WHERE jsonb_typeof(e) IS DISTINCT FROM 'object'
    OR e->>'version' IS NULL OR e->>'version' !~ '^[0-9]{14}$'
    OR e->>'sha256' IS NULL OR e->>'sha256' !~ '^[0-9a-f]{64}$'
    OR (e-ARRAY['version','sha256'])<>'{}'::jsonb)
    OR (SELECT count(*)<>count(DISTINCT e->>'version') FROM jsonb_array_elements(p_required) e) THEN
    RAISE EXCEPTION 'invalid migration requirement entry' USING ERRCODE='22023';
  END IF;
  RETURN QUERY
    SELECT r->>'version',r->>'sha256',c.sha256,
      CASE WHEN l.version IS NULL THEN 'missing_ledger'
           WHEN c.version IS NULL THEN 'missing_checksum' ELSE 'checksum_mismatch' END
    FROM jsonb_array_elements(p_required) r
    LEFT JOIN commonswarm_ops.migration_checksums c ON c.version=r->>'version'
    LEFT JOIN supabase_migrations.schema_migrations l ON l.version=r->>'version'
    WHERE l.version IS NULL OR c.version IS NULL OR c.sha256 IS DISTINCT FROM r->>'sha256'
    ORDER BY r->>'version';
END $fn$;
ALTER FUNCTION commonswarm_ops.migration_checksum_failures(jsonb) OWNER TO swarm_admin;
REVOKE ALL ON FUNCTION commonswarm_ops.migration_checksum_failures(jsonb) FROM PUBLIC,anon,authenticated,swarm_read,swarm_command,commonswarm_oauth_runtime,commonswarm_admin_release;
GRANT EXECUTE ON FUNCTION commonswarm_ops.migration_checksum_failures(jsonb) TO commonswarm_oauth_runtime,swarm_command;

-- Reserve rollback (verbatim sibling reserve; data-free only):
-- -- Data-free reserve ONLY. Never drops data once OAuth/admin artifacts exist.
-- -- Retain all release/backfill evidence; an occupied ledger forbids this inverse.
-- DO $reserve$ BEGIN
--   IF EXISTS(SELECT 1 FROM commonswarm_ops.migration_checksums) THEN
--     RAISE EXCEPTION 'reserve rollback refused: migration checksum evidence' USING ERRCODE='55000';
--   END IF;
-- END $reserve$;
-- DROP TABLE commonswarm_ops.migration_checksums;
-- DROP FUNCTION commonswarm_ops.migration_checksum_failures(jsonb);
-- DROP FUNCTION commonswarm_ops.guard_migration_checksums();
-- REVOKE USAGE ON SCHEMA commonswarm_ops FROM commonswarm_admin_release,commonswarm_oauth_runtime,swarm_command;
-- -- Retain the possibly pre-existing schema and owner's migration-ledger read ACL.
