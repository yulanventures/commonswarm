-- Isolated permission/RLS assertions. Not a production migration.
BEGIN;

DO $guard$
BEGIN
  IF current_setting('commonswarm.activity_publish_isolated', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish assert requires commonswarm.activity_publish_isolated=1';
  END IF;
  IF inet_server_addr() IS NOT DISTINCT FROM inet '172.31.0.10' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish assert must not run on 172.31.0.10';
  END IF;
  IF current_setting('commonswarm.stack_identity', true) IS NOT DISTINCT FROM 'n-db-target-v1' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish assert must not run on a marked N-db target';
  END IF;
  IF to_regnamespace('swarm') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: swarm schema present (not an isolated cluster)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    RAISE EXCEPTION 'refusing: supabase_realtime_admin exists (not an isolated cluster)';
  END IF;
END
$guard$;

CREATE FUNCTION pg_temp.expect_denied_as(role_name text, stmt text, expected_sqlstate text)
RETURNS void
LANGUAGE plpgsql
AS $h$
BEGIN
  BEGIN
    PERFORM set_config('role', role_name, true);
    EXECUTE stmt;
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLSTATE IS DISTINCT FROM expected_sqlstate THEN
        RAISE EXCEPTION 'role % expected SQLSTATE %, got % (%): %',
          role_name, expected_sqlstate, SQLSTATE, SQLERRM, stmt;
      END IF;
      RETURN;
  END;
  RAISE EXCEPTION 'role % expected SQLSTATE %, statement succeeded: %',
    role_name, expected_sqlstate, stmt;
END;
$h$;

DO $priv$
BEGIN
  IF NOT has_schema_privilege('commonswarm_edge', 'realtime', 'USAGE') THEN
    RAISE EXCEPTION 'commonswarm_edge should have realtime USAGE';
  END IF;
  IF has_schema_privilege('swarm_command', 'realtime', 'USAGE') THEN
    RAISE EXCEPTION 'swarm_command must not have realtime USAGE';
  END IF;
  IF has_table_privilege('commonswarm_edge', 'realtime.messages', 'INSERT') THEN
    RAISE EXCEPTION 'INSERT must be column-scoped, not table-level';
  END IF;
  IF has_table_privilege('commonswarm_edge', 'realtime.messages', 'SELECT')
     OR has_table_privilege('commonswarm_edge', 'realtime.messages', 'UPDATE')
     OR has_table_privilege('commonswarm_edge', 'realtime.messages', 'DELETE')
     OR has_table_privilege('commonswarm_edge', 'realtime.messages', 'TRUNCATE')
  THEN
    RAISE EXCEPTION 'commonswarm_edge must not SELECT/UPDATE/DELETE/TRUNCATE realtime.messages';
  END IF;
  IF has_table_privilege('swarm_command', 'realtime.messages', 'INSERT')
     OR has_column_privilege('swarm_command', 'realtime.messages', 'id', 'INSERT')
  THEN
    RAISE EXCEPTION 'swarm_command must not INSERT realtime.messages';
  END IF;
  IF NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'id', 'INSERT')
     OR NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'payload', 'INSERT')
     OR NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'event', 'INSERT')
     OR NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'topic', 'INSERT')
     OR NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'private', 'INSERT')
     OR NOT has_column_privilege('commonswarm_edge', 'realtime.messages', 'extension', 'INSERT')
  THEN
    RAISE EXCEPTION 'commonswarm_edge must INSERT the six send() columns';
  END IF;
  IF has_column_privilege('commonswarm_edge', 'realtime.messages', 'inserted_at', 'INSERT') THEN
    RAISE EXCEPTION 'commonswarm_edge must not INSERT inserted_at';
  END IF;
  IF NOT has_function_privilege(
       'commonswarm_edge',
       'realtime.send(jsonb,text,text,boolean)',
       'EXECUTE'
     )
     OR NOT has_function_privilege(
       'swarm_command',
       'realtime.send(jsonb,text,text,boolean)',
       'EXECUTE'
     )
  THEN
    RAISE EXCEPTION 'PUBLIC EXECUTE on realtime.send must remain';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('commonswarm_edge', 'swarm_command')
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'commonswarm_edge/swarm_command must not be superuser or BYPASSRLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime'
      AND c.relname = 'messages'
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
  ) THEN
    RAISE EXCEPTION 'realtime.messages must have RLS on and FORCE RLS off';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policy WHERE polrelid = 'realtime.messages'::regclass) <> 4 THEN
    RAISE EXCEPTION 'expected 4 policies on realtime.messages';
  END IF;
  IF (SELECT COUNT(*) FROM pg_policy WHERE polrelid = 'realtime.messages'::regclass AND polcmd = 'a') <> 1 THEN
    RAISE EXCEPTION 'expected exactly one INSERT policy on realtime.messages';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'realtime.messages'::regclass
      AND polname = 'commonswarm_edge_activity_insert'
      AND polcmd = 'a'
      AND polpermissive
      AND polqual IS NULL
      AND polwithcheck IS NOT NULL
      AND (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_edge') = ANY (polroles)
      AND NOT (0::oid = ANY (polroles))
  ) THEN
    RAISE EXCEPTION 'commonswarm_edge_activity_insert is missing or not scoped to commonswarm_edge INSERT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'realtime.messages'::regclass
      AND polname = 'agent receives its own wake'
      AND polcmd = 'r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'realtime.messages'::regclass
      AND polname = 'workspace members receive agent activity'
      AND polcmd = 'r'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'realtime.messages'::regclass
      AND polname = 'workspace members receive signals'
      AND polcmd = 'r'
  ) THEN
    RAISE EXCEPTION 'existing SELECT policies on realtime.messages were not preserved';
  END IF;
END
$priv$;

SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'wakeup',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             true, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             false, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-signals:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             true, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE',
             true, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:not-a-uuid',
             true, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             true, 'presence')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension, inserted_at)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             true, 'broadcast', now())$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  'SELECT id FROM realtime.messages',
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  $s$UPDATE realtime.messages SET event = 'activity'$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  'DELETE FROM realtime.messages',
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'commonswarm_edge',
  'TRUNCATE realtime.messages',
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'swarm_command',
  $s$INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
     VALUES (gen_random_uuid(), '{}'::jsonb, 'activity',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
             true, 'broadcast')$s$,
  '42501'
);
SELECT pg_temp.expect_denied_as(
  'swarm_command',
  $s$SELECT realtime.send('{}'::jsonb, 'activity',
             'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', true)$s$,
  '42501'
);

SET ROLE commonswarm_edge;
INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
VALUES (
  gen_random_uuid(),
  '{"probe":"insert"}'::jsonb,
  'activity',
  'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  true,
  'broadcast'
);
SELECT realtime.send(
  '{"probe":"send"}'::jsonb,
  'activity',
  'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  true
);
SELECT realtime.send(
  '{"probe":"wakeup"}'::jsonb,
  'wakeup',
  'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  true
);
SELECT realtime.send(
  '{"probe":"public"}'::jsonb,
  'activity',
  'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  false
);
SELECT realtime.send(
  '{"probe":"signals"}'::jsonb,
  'activity',
  'cswarm-signals:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
  true
);
RESET ROLE;

DO $ok$
DECLARE
  n integer;
BEGIN
  SELECT COUNT(*) INTO n
  FROM realtime.messages
  WHERE event = 'activity'
    AND private IS TRUE
    AND extension = 'broadcast'
    AND topic = 'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    AND payload ? 'probe';
  IF n < 2 THEN
    RAISE EXCEPTION 'valid activity rows missing after INSERT/send (got %); send() void is not proof', n;
  END IF;
  IF EXISTS (
    SELECT 1 FROM realtime.messages
    WHERE payload->>'probe' IN ('wakeup', 'public', 'signals')
  ) THEN
    RAISE EXCEPTION 'realtime.send stored a forbidden activity shape';
  END IF;
END
$ok$;

COMMIT;
