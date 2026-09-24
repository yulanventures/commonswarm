-- Opus r6: cost and locks of the migration's index build when no row matches, on a scratch copy
-- (no lock on swarm.signal_deliveries). Rolled back.
\set ON_ERROR_STOP 1
\timing on
BEGIN;
SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '300s';
CREATE TABLE public.opus_r6_sd (LIKE swarm.signal_deliveries INCLUDING DEFAULTS);
-- 1,000,000 rows shaped like production: 90% replied with a lease pair, 10% unacked.
INSERT INTO public.opus_r6_sd (signal_id, workspace_id, recipient_agent_principal_id, enqueued_at,
  last_lease_id, last_leased_by, delivered_at, acked_at, ack_outcome, attempt_count)
SELECT gen_random_uuid(), ('00000000-0000-4000-8000-' || lpad((g % 50)::text, 12, '0'))::uuid,
  ('00000000-0000-4000-8001-' || lpad((g % 2000)::text, 12, '0'))::uuid,
  now() - (g * interval '1 second'),
  CASE WHEN g % 10 <> 0 THEN gen_random_uuid() END, CASE WHEN g % 10 <> 0 THEN gen_random_uuid() END,
  CASE WHEN g % 10 <> 0 THEN now() END, CASE WHEN g % 10 <> 0 THEN now() END,
  CASE WHEN g % 10 <> 0 THEN 'replied' END, CASE WHEN g % 10 <> 0 THEN 1 ELSE 0 END
FROM generate_series(1, 1000000) g;
CREATE INDEX opus_r6_sd_unacked ON public.opus_r6_sd (recipient_agent_principal_id, workspace_id, enqueued_at, signal_id) WHERE acked_at IS NULL;
ALTER TABLE public.opus_r6_sd ADD PRIMARY KEY (signal_id, recipient_agent_principal_id);
SELECT pg_size_pretty(pg_relation_size('public.opus_r6_sd')) AS heap;
\echo ---- the migration's ALTER pair, then the index, as one transaction step
ALTER TABLE public.opus_r6_sd ADD CONSTRAINT opus_r6_check9 CHECK (acked_at IS NULL OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL) OR ack_outcome = 'expired' OR (ack_outcome = 'observed' AND last_error_code IS NULL)) NOT VALID;
ALTER TABLE public.opus_r6_sd VALIDATE CONSTRAINT opus_r6_check9;
CREATE INDEX opus_r6_idx ON public.opus_r6_sd (workspace_id, recipient_agent_principal_id)
  WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL;
SELECT pg_size_pretty(pg_relation_size('public.opus_r6_idx')) AS new_index_size,
  (SELECT count(*) FROM public.opus_r6_sd WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL) AS matching_rows;
SELECT mode, granted FROM pg_locks WHERE relation = 'public.opus_r6_sd'::regclass AND pid = pg_backend_pid() ORDER BY mode;
\echo ---- a second build, warm cache
DROP INDEX public.opus_r6_idx;
CREATE INDEX opus_r6_idx ON public.opus_r6_sd (workspace_id, recipient_agent_principal_id)
  WHERE ack_outcome = 'observed' AND last_lease_id IS NULL AND last_leased_by IS NULL;
\echo ---- insert cost: 10,000 more rows with and without the partial index present
INSERT INTO public.opus_r6_sd (signal_id, workspace_id, recipient_agent_principal_id)
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8001-000000000001' FROM generate_series(1,10000);
DROP INDEX public.opus_r6_idx;
INSERT INTO public.opus_r6_sd (signal_id, workspace_id, recipient_agent_principal_id)
SELECT gen_random_uuid(), '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8001-000000000001' FROM generate_series(1,10000);
ROLLBACK;
SELECT 'leftover: ' || count(*) FROM pg_class WHERE relname LIKE 'opus_r6_%';
