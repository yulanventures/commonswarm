-- Poll catalog contract, checked on apply and on the idempotent skip path.
-- The relation check reads every live column, so a missing or extra column fails.
SET LOCAL search_path = pg_catalog;
DO $h0poll$
DECLARE
  lock_columns jsonb;
  batch_columns jsonb;
  relation_name text;
BEGIN
  SELECT jsonb_agg(jsonb_build_array(attname, format_type(atttypid, atttypmod), attnotnull)
                   ORDER BY attnum)
  INTO lock_columns
  FROM pg_attribute
  WHERE attrelid = to_regclass('swarm.h0_poll_locks') AND attnum > 0 AND NOT attisdropped;
  IF lock_columns IS DISTINCT FROM '[
    ["workspace_id","uuid",true],["principal_id","uuid",true],
    ["holder","uuid",true],["listener_instance_id","uuid",true],
    ["acquired_at","timestamp with time zone",true],
    ["expires_at","timestamp with time zone",true],["waiting","boolean",true]
  ]'::jsonb THEN
    RAISE EXCEPTION 'H0 poll lock columns mismatch';
  END IF;

  SELECT jsonb_agg(jsonb_build_array(attname, format_type(atttypid, atttypmod), attnotnull)
                   ORDER BY attnum)
  INTO batch_columns
  FROM pg_attribute
  WHERE attrelid = to_regclass('swarm.h0_poll_batches') AND attnum > 0 AND NOT attisdropped;
  IF batch_columns IS DISTINCT FROM '[
    ["workspace_id","uuid",true],["principal_id","uuid",true],
    ["batch_id","uuid",true],["lease_ids","uuid[]",true],
    ["status","text",true],["expires_at","timestamp with time zone",true],
    ["closed_at","timestamp with time zone",false],
    ["created_at","timestamp with time zone",true]
  ]'::jsonb THEN
    RAISE EXCEPTION 'H0 poll batch columns mismatch';
  END IF;

  FOREACH relation_name IN ARRAY ARRAY['h0_poll_locks','h0_poll_batches'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'swarm' AND c.relname = relation_name
        AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity
        AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    ) THEN RAISE EXCEPTION 'H0 poll relation metadata mismatch: %', relation_name; END IF;
    IF NOT has_table_privilege('swarm_command', 'swarm.' || relation_name, 'SELECT')
      OR NOT has_table_privilege('swarm_command', 'swarm.' || relation_name, 'INSERT')
      OR NOT has_table_privilege('swarm_command', 'swarm.' || relation_name, 'UPDATE')
      OR has_table_privilege('swarm_command', 'swarm.' || relation_name, 'DELETE')
      OR has_table_privilege('anon', 'swarm.' || relation_name, 'SELECT')
      OR has_table_privilege('authenticated', 'swarm.' || relation_name, 'SELECT')
    THEN RAISE EXCEPTION 'H0 poll grants mismatch: %', relation_name; END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = to_regclass('swarm.' || relation_name)
        AND t.tgname = relation_name || '_guard' AND t.tgenabled = 'O'
        AND t.tgtype = 27 -- row, before, update, delete
    ) THEN RAISE EXCEPTION 'H0 poll guard trigger mismatch: %', relation_name; END IF;
    IF (SELECT count(*) FROM pg_policy p
        WHERE p.polrelid = to_regclass('swarm.' || relation_name)
          AND p.polname = 'swarm_command_all'
          AND p.polpermissive AND p.polcmd = '*'
          AND p.polroles = ARRAY[(SELECT oid FROM pg_roles WHERE rolname = 'swarm_command')]) <> 1
    THEN RAISE EXCEPTION 'H0 poll policy mismatch: %', relation_name; END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('swarm.h0_poll_batches_one_active')
      AND i.indrelid = to_regclass('swarm.h0_poll_batches')
      AND i.indisvalid AND i.indisready AND i.indisunique
      AND pg_get_indexdef(i.indexrelid) LIKE '%(workspace_id, principal_id) WHERE%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%status%active%'
  ) THEN RAISE EXCEPTION 'H0 active batch index mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('swarm.h0_poll_batches_closed_at')
      AND i.indrelid = to_regclass('swarm.h0_poll_batches')
      AND i.indisvalid AND i.indisready
      AND pg_get_indexdef(i.indexrelid) LIKE '%(closed_at, workspace_id, principal_id, batch_id) WHERE%'
      AND pg_get_expr(i.indpred, i.indrelid) LIKE '%status%closed%'
  ) THEN RAISE EXCEPTION 'H0 closed batch index mismatch'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('swarm.h0_poll_locks_waiting')
      AND i.indrelid = to_regclass('swarm.h0_poll_locks')
      AND i.indisvalid AND i.indisready
  ) THEN RAISE EXCEPTION 'H0 waiting index mismatch'; END IF;

  -- These are SHA256 values of the exact AS $$ bodies in the pinned files.
  -- The retention migration replaces the batch guard from 000001.
  IF (
    SELECT count(*) FROM (VALUES
      ('swarm.h0_poll_locks_guard()',
       'b7bf808fa8566359f0e531264e23a3d40678f9afcad13ac7d3e9e71d855c8fa1', false),
      ('swarm.h0_poll_batches_guard()',
       '1130f232a81557fdc12b8a78f12246ef0b26be7894d6d8bb02f21b53dc556a67', false),
      ('swarm.h0_poll_batch_retention_days()',
       'dfa6c6beee913799a85e4c73ba61f27be100cda85a5aac6c5dfd452e16d65349', true),
      ('swarm.purge_expired_h0_poll_batches(integer)',
       '3cde2f3afedc55186a59384e805ca4498c7619ee65d4fca105aeb3081ce6ecb4', true),
      ('swarm.purge_expired_h0_poll_batches()',
       '0f963ce284042223db12d0996973daeb67ec04aef76f2a58b3179bbf39851982', true)
    ) AS expected(signature, body_sha256, security_definer)
    JOIN pg_proc p ON p.oid = to_regprocedure(expected.signature)
    WHERE pg_get_userbyid(p.proowner) = 'swarm_admin'
      AND p.prosecdef = expected.security_definer
      AND encode(sha256(convert_to(p.prosrc, 'UTF8')), 'hex') = expected.body_sha256
      AND NOT EXISTS (
        SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
        WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
      )
  ) <> 5 THEN RAISE EXCEPTION 'H0 poll function mismatch'; END IF;
  IF (SELECT count(*) FROM cron.job WHERE jobname = 'swarm-purge-h0-poll-batches'
      AND schedule = '29 4 * * *'
      AND command = 'SELECT swarm.purge_expired_h0_poll_batches()'
      AND database = current_database() AND username = current_user AND active) <> 1
    OR (SELECT count(*) FROM cron.job WHERE jobname = 'swarm-purge-h0-poll-batches') <> 1
  THEN RAISE EXCEPTION 'H0 poll purge cron mismatch'; END IF;
END;
$h0poll$;
