-- Activity publish grants for commonswarm_edge.
--
-- realtime.send is SECURITY INVOKER, owned by supabase_realtime_admin,
-- and INSERTs (id, payload, event, topic, private, extension). It catches
-- every INSERT failure as WARNING and returns, so a 202 from the activity
-- handler is not proof that a private activity message was stored.
--
-- This file grants only:
--   USAGE on schema realtime
--   INSERT on those six columns of realtime.messages
--   INSERT policy commonswarm_edge_activity_insert (message shape only)
-- The activity handler remains the workspace authorization boundary.
--
-- Apply on an operator session whose identity is already verified.
-- Source: existing assert_source_identity (SOURCE_SYSTEM_IDENTIFIER).
-- Target: existing assert_target_identity; prepare-target.sh runs this
-- file in a separate target_psql after it creates commonswarm_edge.
-- Fail-closed if commonswarm_edge does not exist (SQLSTATE 42704).
-- Fail-closed if realtime.messages row security is off (SQLSTATE 55000).
-- A policy does not apply while row security is off. One transaction.
-- Do not include this file inside another open transaction.
--
-- Does not replace realtime.send, change PUBLIC EXECUTE, alter other
-- policies on realtime.messages, or change role memberships.

BEGIN;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_edge') THEN
    RAISE EXCEPTION 'commonswarm_edge role does not exist'
      USING ERRCODE = '42704';
  END IF;

  IF to_regclass('realtime.messages') IS NULL THEN
    RAISE EXCEPTION 'realtime.messages does not exist'
      USING ERRCODE = '42P01';
  END IF;

  IF (
    SELECT COUNT(*)
    FROM pg_attribute AS a
    JOIN pg_class AS c ON c.oid = a.attrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    JOIN pg_type AS t ON t.oid = a.atttypid
    WHERE n.nspname = 'realtime'
      AND c.relname = 'messages'
      AND NOT a.attisdropped
      AND (
        (a.attname = 'id' AND t.typname = 'uuid')
        OR (a.attname = 'payload' AND t.typname = 'jsonb')
        OR (a.attname = 'event' AND t.typname = 'text')
        OR (a.attname = 'topic' AND t.typname = 'text')
        OR (a.attname = 'private' AND t.typname = 'bool')
        OR (a.attname = 'extension' AND t.typname = 'text')
      )
  ) <> 6 THEN
    RAISE EXCEPTION 'realtime.messages must have send() columns id uuid, payload jsonb, event text, topic text, private bool, extension text';
  END IF;

  IF (
    SELECT c.relrowsecurity
    FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'realtime'
      AND c.relname = 'messages'
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'realtime.messages row security is off'
      USING ERRCODE = '55000';
  END IF;
END
$do$;

GRANT USAGE ON SCHEMA realtime TO commonswarm_edge;

GRANT INSERT (id, payload, event, topic, private, extension)
  ON TABLE realtime.messages
  TO commonswarm_edge;

DROP POLICY IF EXISTS commonswarm_edge_activity_insert ON realtime.messages;

CREATE POLICY commonswarm_edge_activity_insert
  ON realtime.messages
  AS PERMISSIVE
  FOR INSERT
  TO commonswarm_edge
  WITH CHECK (
    (extension = 'broadcast'::text)
    AND (private IS TRUE)
    AND (event = 'activity'::text)
    AND (topic ~ '^cswarm-activity:([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$'::text)
  );

COMMIT;
