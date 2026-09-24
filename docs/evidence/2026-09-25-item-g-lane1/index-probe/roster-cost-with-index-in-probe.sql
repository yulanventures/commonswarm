-- Opus r5: cost of the fold-5 heal join. Rolled back. Triggers/FKs off via replica role.
\set ON_ERROR_STOP 1
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '60s';
CREATE INDEX signal_deliveries_unclaimed_observed ON swarm.signal_deliveries (workspace_id, recipient_agent_principal_id) WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL;
SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE ctx AS SELECT '0f5e0000-0000-4000-8000-00000000b001'::uuid AS w, '0f5e0000-0000-4000-8000-00000000b002'::uuid AS u;
INSERT INTO swarm.workspaces (workspace_id, name, created_by) SELECT w, 'opus-r5-cost', u FROM ctx;
INSERT INTO swarm.memberships (workspace_id, user_id, role) SELECT w, u, 'owner' FROM ctx;
CREATE TEMP TABLE seats AS SELECT gen_random_uuid() AS p, g FROM generate_series(1,200) g;
INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
  SELECT p, (SELECT w FROM ctx), (SELECT u FROM ctx), 'opus-r5-cost-' || g FROM seats;
-- 250 directed asks per seat = 50,000 signals; the last 5 per seat stay unobserved.
CREATE TEMP TABLE sig AS
  SELECT gen_random_uuid() AS id, s.p, n, statement_timestamp() - interval '50 minutes' + (n * interval '10 seconds') + (s.g * interval '1 millisecond') AS at
  FROM seats s, generate_series(1,250) n;
INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, created_at, to_agent_principal_id)
  SELECT id, (SELECT w FROM ctx), (SELECT u FROM ctx), 'user', 'ask', 'cost', at + interval '1 day', at, p FROM sig;
INSERT INTO swarm.signal_deliveries (signal_id, workspace_id, recipient_agent_principal_id, enqueued_at, acked_at, ack_outcome, delivered_at, surfaced_at)
  SELECT id, (SELECT w FROM ctx), p, at,
    CASE WHEN n <= 245 THEN statement_timestamp() END,
    CASE WHEN n <= 245 THEN 'observed' END,
    CASE WHEN n <= 245 THEN statement_timestamp() END,
    CASE WHEN n <= 245 THEN statement_timestamp() END
  FROM sig;
SET LOCAL session_replication_role = origin;
UPDATE swarm.wake_path_release SET applied_at = statement_timestamp() - interval '2 hours' WHERE singleton;
ANALYZE swarm.signals; ANALYZE swarm.signal_deliveries; ANALYZE swarm.agent_principals;
\echo ---- eligible rows (expect 0: every unobserved row is before... no: last 5 per seat are AFTER the observed ones, so 1000)
SELECT count(*) FROM swarm.wake_path_eligible_deliveries WHERE workspace_id = (SELECT w FROM ctx);
\echo ---- roster aggregate as the owner
SELECT set_config('request.jwt.claims', json_build_object('sub', (SELECT u FROM ctx), 'role', 'authenticated')::text, true);
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY ON)
  SELECT * FROM swarm_read.agent_wake_path WHERE workspace_id = (SELECT w FROM ctx);
ROLLBACK;
SELECT 'leftover: ' || count(*) FROM swarm.agent_principals WHERE name LIKE 'opus-r5-%';
