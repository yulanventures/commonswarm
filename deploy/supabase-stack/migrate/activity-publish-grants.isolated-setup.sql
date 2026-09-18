-- Isolated fixture for activity-publish-grants tests. Not a production
-- migration. The test shell sets commonswarm.activity_publish_isolated=1
-- on an ephemeral unix-socket cluster. Fail-closed on source/target shape.

BEGIN;

DO $guard$
BEGIN
  IF current_setting('commonswarm.activity_publish_isolated', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish fixture requires commonswarm.activity_publish_isolated=1';
  END IF;
  IF inet_server_addr() IS NOT DISTINCT FROM inet '172.31.0.10' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish fixture must not run on 172.31.0.10';
  END IF;
  IF current_setting('commonswarm.stack_identity', true) IS NOT DISTINCT FROM 'n-db-target-v1' THEN
    RAISE EXCEPTION 'refusing: isolated activity-publish fixture must not run on a marked N-db target';
  END IF;
  IF to_regnamespace('swarm') IS NOT NULL THEN
    RAISE EXCEPTION 'refusing: swarm schema present (not an isolated cluster)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    RAISE EXCEPTION 'refusing: supabase_realtime_admin exists (not an isolated cluster)';
  END IF;
END
$guard$;

CREATE SCHEMA realtime;
REVOKE ALL ON SCHEMA realtime FROM PUBLIC;

CREATE TABLE realtime.messages (
  id uuid PRIMARY KEY,
  payload jsonb NOT NULL,
  event text,
  topic text NOT NULL,
  private boolean NOT NULL DEFAULT false,
  extension text NOT NULL,
  inserted_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE realtime.messages FROM PUBLIC;

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

CREATE ROLE swarm_command NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOREPLICATION NOBYPASSRLS;
CREATE ROLE commonswarm_edge NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOREPLICATION NOBYPASSRLS;
GRANT swarm_command TO commonswarm_edge;

CREATE ROLE isolated_activity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  INHERIT NOREPLICATION NOBYPASSRLS;

CREATE OR REPLACE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  generated_id uuid;
  final_payload jsonb;
BEGIN
  BEGIN
    generated_id := gen_random_uuid();

    IF payload ? 'id' THEN
      final_payload := payload;
    ELSE
      final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
    END IF;

    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      RAISE WARNING 'WarnSendingBroadcastMessage: %', SQLERRM;
  END;
END;
$function$;

CREATE POLICY "agent receives its own wake"
  ON realtime.messages
  FOR SELECT
  TO isolated_activity_reader
  USING (false);

CREATE POLICY "workspace members receive agent activity"
  ON realtime.messages
  FOR SELECT
  TO isolated_activity_reader
  USING (false);

CREATE POLICY "workspace members receive signals"
  ON realtime.messages
  FOR SELECT
  TO isolated_activity_reader
  USING (false);

COMMIT;
