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

-- Exact JSON contract for the poll relations. This checks the entire set of
-- constraints, indexes, triggers and policies, not only named members.
DO $h0poll_exact$
DECLARE
  item jsonb;
  actual jsonb;
  obj oid;
  expected jsonb := $expected$[
    {"name":"h0_poll_locks","acl":"{swarm_admin=arwdDxtm/swarm_admin,swarm_command=arw/swarm_admin}",
     "columns":[
       ["workspace_id","uuid",true,null],["principal_id","uuid",true,null],
       ["holder","uuid",true,null],["listener_instance_id","uuid",true,null],
       ["acquired_at","timestamp with time zone",true,"statement_timestamp()"],
       ["expires_at","timestamp with time zone",true,null],["waiting","boolean",true,"false"]],
     "constraints":[
       ["h0_poll_locks_expires_at_check","c","CHECK (expires_at >= acquired_at)"],
       ["h0_poll_locks_pkey","p","PRIMARY KEY (workspace_id, principal_id)"],
       ["h0_poll_locks_principal_id_workspace_id_fkey","f","FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id)" ]],
     "indexes":[
       ["h0_poll_locks_pkey",true,true,true,"CREATE UNIQUE INDEX h0_poll_locks_pkey ON swarm.h0_poll_locks USING btree (workspace_id, principal_id)"],
       ["h0_poll_locks_waiting",true,true,false,"CREATE INDEX h0_poll_locks_waiting ON swarm.h0_poll_locks USING btree (expires_at) WHERE waiting"]],
     "triggers":[["h0_poll_locks_guard","O","CREATE TRIGGER h0_poll_locks_guard BEFORE DELETE OR UPDATE ON swarm.h0_poll_locks FOR EACH ROW EXECUTE FUNCTION swarm.h0_poll_locks_guard()"]]},
    {"name":"h0_poll_batches","acl":"{swarm_admin=arwdDxtm/swarm_admin,swarm_command=arw/swarm_admin}",
     "columns":[
       ["workspace_id","uuid",true,null],["principal_id","uuid",true,null],
       ["batch_id","uuid",true,null],["lease_ids","uuid[]",true,null],
       ["status","text",true,null],["expires_at","timestamp with time zone",true,null],
       ["closed_at","timestamp with time zone",false,null],
       ["created_at","timestamp with time zone",true,"statement_timestamp()"]],
     "constraints":[
       ["h0_poll_batches_check","c","CHECK (status = 'active'::text AND closed_at IS NULL OR status = 'closed'::text AND closed_at IS NOT NULL)"],
       ["h0_poll_batches_lease_ids_check","c","CHECK (cardinality(lease_ids) >= 1 AND cardinality(lease_ids) <= 10)"],
       ["h0_poll_batches_pkey","p","PRIMARY KEY (workspace_id, principal_id, batch_id)"],
       ["h0_poll_batches_principal_id_workspace_id_fkey","f","FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id)"],
       ["h0_poll_batches_status_check","c","CHECK (status = ANY (ARRAY['active'::text, 'closed'::text]))"]],
     "indexes":[
       ["h0_poll_batches_closed_at",true,true,false,"CREATE INDEX h0_poll_batches_closed_at ON swarm.h0_poll_batches USING btree (closed_at, workspace_id, principal_id, batch_id) WHERE (status = 'closed'::text)"],
       ["h0_poll_batches_one_active",true,true,true,"CREATE UNIQUE INDEX h0_poll_batches_one_active ON swarm.h0_poll_batches USING btree (workspace_id, principal_id) WHERE (status = 'active'::text)"],
       ["h0_poll_batches_pkey",true,true,true,"CREATE UNIQUE INDEX h0_poll_batches_pkey ON swarm.h0_poll_batches USING btree (workspace_id, principal_id, batch_id)"]],
     "triggers":[["h0_poll_batches_guard","O","CREATE TRIGGER h0_poll_batches_guard BEFORE DELETE OR UPDATE ON swarm.h0_poll_batches FOR EACH ROW EXECUTE FUNCTION swarm.h0_poll_batches_guard()"]]}
  ]$expected$::jsonb;
BEGIN
  FOR item IN SELECT value FROM jsonb_array_elements(expected) LOOP
    obj := to_regclass('swarm.' || (item->>'name'));
    SELECT jsonb_build_object('kind',c.relkind,'owner',pg_get_userbyid(c.relowner),
      'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'options',to_jsonb(c.reloptions),
      'acl',c.relacl::text) INTO actual FROM pg_class c WHERE c.oid=obj;
    IF actual IS DISTINCT FROM jsonb_build_object('kind','r','owner','swarm_admin',
      'rls',true,'force_rls',false,'options',NULL,'acl',item->>'acl')
    THEN RAISE EXCEPTION 'H0 poll relation metadata mismatch: %',item->>'name'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,pg_get_expr(d.adbin,d.adrelid,true)) ORDER BY a.attnum),'[]'::jsonb)
      INTO actual FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=obj AND a.attnum>0 AND NOT a.attisdropped;
    IF actual IS DISTINCT FROM item->'columns' THEN RAISE EXCEPTION 'H0 poll columns mismatch: %',item->>'name'; END IF;
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=obj
      AND (NOT c.convalidated OR c.condeferrable OR c.condeferred))
    THEN RAISE EXCEPTION 'H0 poll constraint flags mismatch: %',item->>'name'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_array(c.conname,c.contype,pg_get_constraintdef(c.oid,true)) ORDER BY c.conname),'[]'::jsonb)
      INTO actual FROM pg_constraint c WHERE c.conrelid=obj AND c.convalidated
        AND NOT c.condeferrable AND NOT c.condeferred;
    IF actual IS DISTINCT FROM item->'constraints' THEN RAISE EXCEPTION 'H0 poll constraints mismatch: %',item->>'name'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,i.indisvalid,i.indisready,i.indisunique,
      pg_get_indexdef(i.indexrelid)) ORDER BY c.relname),'[]'::jsonb)
      INTO actual FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=obj;
    IF actual IS DISTINCT FROM item->'indexes' THEN RAISE EXCEPTION 'H0 poll indexes mismatch: %',item->>'name'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_array(t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true)) ORDER BY t.tgname),'[]'::jsonb)
      INTO actual FROM pg_trigger t WHERE t.tgrelid=obj AND NOT t.tgisinternal;
    IF actual IS DISTINCT FROM item->'triggers' THEN RAISE EXCEPTION 'H0 poll triggers mismatch: %',item->>'name'; END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_array(p.polname,p.polpermissive,p.polcmd,
      (SELECT jsonb_agg(CASE WHEN role_id=0 THEN 'public' ELSE pg_get_userbyid(role_id)::text END ORDER BY role_id)
       FROM unnest(p.polroles) role_id),pg_get_expr(p.polqual,p.polrelid,true),
       pg_get_expr(p.polwithcheck,p.polrelid,true)) ORDER BY p.polname),'[]'::jsonb)
      INTO actual FROM pg_policy p WHERE p.polrelid=obj;
    IF actual IS DISTINCT FROM '[["swarm_command_all",true,"*",["swarm_command"],"true","true"]]'::jsonb
    THEN RAISE EXCEPTION 'H0 poll policies mismatch: %',item->>'name'; END IF;
  END LOOP;
  SELECT COALESCE(jsonb_agg(jsonb_build_array(p.oid::regprocedure::text,to_jsonb(p.proconfig),p.proacl::text)
    ORDER BY p.oid::regprocedure::text),'[]'::jsonb) INTO actual
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='swarm' AND p.proname IN ('h0_poll_locks_guard','h0_poll_batches_guard',
    'h0_poll_batch_retention_days','purge_expired_h0_poll_batches');
  IF actual IS DISTINCT FROM '[
    ["swarm.h0_poll_batch_retention_days()",["search_path=swarm, pg_catalog"],"{swarm_admin=X/swarm_admin}"],
    ["swarm.h0_poll_batches_guard()",["search_path=pg_catalog"],"{swarm_admin=X/swarm_admin}"],
    ["swarm.h0_poll_locks_guard()",["search_path=pg_catalog"],"{swarm_admin=X/swarm_admin}"],
    ["swarm.purge_expired_h0_poll_batches()",["search_path=swarm, pg_catalog"],"{swarm_admin=X/swarm_admin}"],
    ["swarm.purge_expired_h0_poll_batches(integer)",["search_path=swarm, pg_catalog"],"{swarm_admin=X/swarm_admin}"]
  ]'::jsonb THEN RAISE EXCEPTION 'H0 poll function config or ACL mismatch'; END IF;
END;
$h0poll_exact$;
