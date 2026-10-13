-- Read-only section-5 proof for 20261014000002_oauth_finish.sql.
-- RELEASE-TO-BOX.md:1762-1772 requires catalog_ok followed by \gset;
-- :2034-2107 covers the migration/ledger/catalog transaction; :1567 sets ON_ERROR_STOP.
-- An absent table returns f before apply. Every installed-schema difference raises.
SELECT to_regclass('commonswarm_oauth.finish_records') IS NOT NULL
  OR to_regclass('commonswarm_oauth.finish_records_pkey') IS NOT NULL
  OR to_regtype('commonswarm_oauth.finish_records') IS NOT NULL AS item_b38_finish_present
\gset

\if :item_b38_finish_present
DO $catalog$
DECLARE
  finish_oid oid := to_regclass('commonswarm_oauth.finish_records');
  runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime');
  item record;
BEGIN
  IF runtime_oid IS NULL OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE oid = runtime_oid
      AND rolcanlogin AND NOT rolinherit AND NOT rolsuper AND NOT rolcreatedb
      AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls)
    OR NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = finish_oid
      AND relkind = 'r' AND relpersistence = 'p' AND relrowsecurity AND NOT relforcerowsecurity
      AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')) THEN
    RAISE EXCEPTION 'B38 finish table, role or owner differs';
  END IF;
  IF (SELECT array_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
      || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
      ORDER BY a.attnum)
    FROM pg_attribute AS a LEFT JOIN pg_attrdef AS d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = finish_oid AND a.attnum > 0 AND NOT a.attisdropped)
    IS DISTINCT FROM ARRAY[
      'interaction_uid:text:true:', 'session_hash:bytea:true:', 'user_id:uuid:true:',
      'provider_grant_id:text:true:', 'commonswarm_grant_id:uuid:true:',
      'validated_request:jsonb:true:', 'display_model:jsonb:true:', 'provider_result:jsonb:true:',
      'state:text:true:''prepared''::text', 'resume_response:jsonb:false:',
      'created_at:timestamp with time zone:true:statement_timestamp()',
      'expires_at:timestamp with time zone:true:'
    ]::text[] THEN
    RAISE EXCEPTION 'B38 finish columns or defaults differ';
  END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = finish_oid) <> 10
    OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = finish_oid
      AND (NOT convalidated OR condeferrable OR condeferred OR NOT conislocal OR coninhcount <> 0)) THEN
    RAISE EXCEPTION 'B38 finish constraint set differs';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('finish_records_validated_request_check', $expr$(jsonb_typeof(validated_request) = 'object'::text)$expr$),
    ('finish_records_display_model_check', $expr$(jsonb_typeof(display_model) = 'object'::text)$expr$),
    ('finish_records_provider_result_check', $expr$(jsonb_typeof(provider_result) = 'object'::text)$expr$),
    ('finish_records_state_check', $expr$(state = ANY (ARRAY['prepared'::text, 'preparing_resume'::text, 'resume_ready'::text]))$expr$),
    ('finish_records_resume_response_check', $expr$(jsonb_typeof(resume_response) = 'object'::text)$expr$),
    ('finish_records_check', $expr$((expires_at > created_at) AND (expires_at <= (created_at + '00:02:00'::interval)))$expr$),
    ('finish_records_check1', $expr$((state = 'resume_ready'::text) = (resume_response IS NOT NULL))$expr$)
  ) AS expected(constraint_name, expression) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint AS c
      WHERE c.conrelid = finish_oid AND c.conname = item.constraint_name AND c.contype = 'c'
        AND regexp_replace(pg_get_expr(c.conbin, c.conrelid), 'pg_catalog[.]', '', 'g') = item.expression) THEN
      RAISE EXCEPTION 'B38 finish check differs: %', item.constraint_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = finish_oid
      AND conname = 'finish_records_pkey' AND contype = 'p' AND conkey = ARRAY[1]::smallint[])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = finish_oid
      AND conname = 'finish_records_interaction_uid_fkey' AND contype = 'f'
      AND conkey = ARRAY[1]::smallint[] AND confrelid = to_regclass('commonswarm_oauth.interactions')
      AND confkey = ARRAY[1]::smallint[] AND confdeltype = 'c' AND confupdtype = 'a' AND confmatchtype = 's')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = finish_oid
      AND conname = 'finish_records_session_hash_fkey' AND contype = 'f'
      AND conkey = ARRAY[2]::smallint[] AND confrelid = to_regclass('commonswarm_oauth.browser_sessions')
      AND confkey = ARRAY[1]::smallint[] AND confdeltype = 'a' AND confupdtype = 'a' AND confmatchtype = 's') THEN
    RAISE EXCEPTION 'B38 finish primary or foreign keys differ';
  END IF;
  IF (SELECT count(*) FROM pg_index WHERE indrelid = finish_oid) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_am AS am ON am.oid = c.relam
      WHERE i.indexrelid = to_regclass('commonswarm_oauth.finish_records_pkey')
        AND i.indrelid = finish_oid AND i.indisprimary AND i.indisunique
        AND i.indisvalid AND i.indisready AND i.indislive AND i.indnkeyatts = 1 AND i.indnatts = 1
        AND i.indkey::text = '1' AND i.indpred IS NULL AND i.indexprs IS NULL AND am.amname = 'btree')
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = finish_oid AND NOT tgisinternal)
    OR (SELECT count(*) FROM pg_trigger WHERE tgrelid = finish_oid AND tgisinternal) <> 4
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = finish_oid AND (tgenabled <> 'O' OR tgqual IS NOT NULL)) THEN
    RAISE EXCEPTION 'B38 finish indexes or triggers differ';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = finish_oid) <> 1
    OR NOT EXISTS (SELECT 1 FROM pg_policy AS p WHERE p.polrelid = finish_oid
      AND p.polname = 'oauth_runtime_finish' AND p.polcmd = '*' AND p.polpermissive
      AND p.polroles = ARRAY[runtime_oid] AND pg_get_expr(p.polqual, p.polrelid) = 'true'
      AND pg_get_expr(p.polwithcheck, p.polrelid) = 'true') THEN
    RAISE EXCEPTION 'B38 finish policy differs';
  END IF;
  -- Owners retain their normal ACLs. No other role, including PUBLIC, may
  -- have any table/column grant outside the runtime's exact narrow set.
  IF EXISTS (
    WITH actual(kind, role_oid, column_name, privilege, grantable) AS (
      SELECT 'TABLE', a.grantee, ''::text, a.privilege_type, a.is_grantable
      FROM pg_class AS c CROSS JOIN LATERAL aclexplode(c.relacl) AS a
      WHERE c.oid = finish_oid AND a.grantee <> c.relowner
      UNION ALL
      SELECT 'COLUMN', a.grantee, col.attname::text, a.privilege_type, a.is_grantable
      FROM pg_attribute AS col JOIN pg_class AS c ON c.oid = col.attrelid
      CROSS JOIN LATERAL aclexplode(col.attacl) AS a
      WHERE col.attrelid = finish_oid AND col.attnum > 0 AND NOT col.attisdropped
        AND a.grantee <> c.relowner
    ), expected(kind, role_oid, column_name, privilege, grantable) AS (
      SELECT 'TABLE', runtime_oid, ''::text, 'SELECT', false
      UNION ALL SELECT 'COLUMN', runtime_oid, column_name, 'INSERT', false
      FROM unnest(ARRAY['interaction_uid', 'session_hash', 'user_id', 'provider_grant_id',
        'commonswarm_grant_id', 'validated_request', 'display_model', 'provider_result', 'expires_at']) AS cols(column_name)
      UNION ALL SELECT 'COLUMN', runtime_oid, column_name, 'UPDATE', false
      FROM unnest(ARRAY['state', 'resume_response']) AS cols(column_name)
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL SELECT 'COUNT', 0::oid, '', '', false WHERE (SELECT count(*) FROM actual) <> 12
  ) THEN
    RAISE EXCEPTION 'B38 finish table or column grants differ';
  END IF;
  IF NOT has_schema_privilege(runtime_oid, 'commonswarm_oauth', 'USAGE')
    OR NOT has_table_privilege(runtime_oid, finish_oid, 'SELECT')
    OR has_table_privilege(runtime_oid, finish_oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
    RAISE EXCEPTION 'B38 finish effective runtime boundary differs';
  END IF;
END
$catalog$;
\endif

SELECT :'item_b38_finish_present'::boolean AS catalog_ok
\gset
