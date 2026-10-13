-- Read-only section-5 proof for 20261014000001_oauth_session_binding.sql.
-- RELEASE-TO-BOX.md:1762-1772 defines catalog_ok and the file's own \gset;
-- :2034-2107 applies one migration, ledger insert and catalog in one transaction;
-- :1567 sets ON_ERROR_STOP. No function/view source-text qualification checks.
-- Safe before apply: a wholly absent database postcondition returns f. A
-- partial installation or a difference in the installed catalog raises.
SELECT EXISTS (
  SELECT 1 FROM pg_attribute
  WHERE attrelid = to_regclass('commonswarm_oauth.browser_sessions')
    AND attname = 'gotrue_session_id' AND NOT attisdropped
) OR to_regclass('commonswarm_oauth.browser_sessions_gotrue_idx') IS NOT NULL
  OR to_regprocedure('commonswarm_oauth.live_gotrue_session(uuid,uuid)') IS NOT NULL
  OR to_regprocedure('commonswarm_oauth.invalidate_gotrue_session()') IS NOT NULL
  OR EXISTS (
    SELECT 1 FROM pg_policy
    WHERE (polname = 'oauth_session_guard_read' AND polrelid IN (
      to_regclass('auth.sessions'), to_regclass('auth.users'), to_regclass('auth.mfa_amr_claims')
    )) OR (polrelid = to_regclass('commonswarm_oauth.browser_sessions')
      AND polname IN ('oauth_guard_read', 'oauth_guard_revoke'))
  ) OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = to_regclass('auth.sessions')
      AND tgname = 'commonswarm_oauth_session_revocation'
  ) AS item_b38_session_present
\gset

\if :item_b38_session_present
DO $catalog$
DECLARE
  guard_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_session_guard');
  runtime_oid oid := (SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime');
  sessions_oid oid := to_regclass('commonswarm_oauth.browser_sessions');
  item record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE oid = guard_oid
      AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
      AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls
  ) OR runtime_oid IS NULL THEN
    RAISE EXCEPTION 'B38 session role attributes differ';
  END IF;
  -- The owner path has SET only. The non-superuser creator has an ADMIN-only
  -- row and may also have a self-granted row with all options revoked.
  IF (SELECT count(*) FROM pg_auth_members
      WHERE roleid = guard_oid AND member = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
        AND NOT admin_option AND NOT inherit_option AND set_option) <> 1
    OR EXISTS (
      SELECT 1 FROM pg_auth_members AS m
      WHERE m.member = guard_oid OR (m.roleid = guard_oid AND (
        (m.member = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
          AND (m.admin_option OR m.inherit_option OR NOT m.set_option))
        OR (m.member <> (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin')
          AND (m.inherit_option OR m.set_option OR (m.admin_option AND (m.grantor <> 10 OR NOT EXISTS (SELECT 1 FROM pg_roles AS c WHERE c.oid = m.member AND c.rolcreaterole AND NOT c.rolsuper)))))
      ))
    ) THEN
    RAISE EXCEPTION 'B38 session role memberships differ';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = sessions_oid
      AND relkind = 'r' AND relrowsecurity AND NOT relforcerowsecurity
      AND relowner = (SELECT oid FROM pg_roles WHERE rolname = 'swarm_admin'))
    OR (SELECT array_agg(a.attname::text || ':' || format_type(a.atttypid, a.atttypmod)
        || ':' || a.attnotnull::text || ':' || COALESCE(pg_get_expr(d.adbin, d.adrelid), '')
        ORDER BY a.attnum)
      FROM pg_attribute AS a LEFT JOIN pg_attrdef AS d
        ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = sessions_oid AND a.attnum > 0 AND NOT a.attisdropped)
      IS DISTINCT FROM ARRAY[
        'session_hash:bytea:true:', 'user_id:uuid:false:', 'user_email:text:false:',
        'user_display_name:text:false:', 'authenticated_at:timestamp with time zone:false:',
        'expires_at:timestamp with time zone:true:', 'invalidated_at:timestamp with time zone:false:',
        'created_at:timestamp with time zone:true:statement_timestamp()', 'gotrue_session_id:uuid:false:'
      ]::text[] THEN
    RAISE EXCEPTION 'B38 browser session table or columns differ';
  END IF;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname)
      FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid WHERE i.indrelid = sessions_oid)
      IS DISTINCT FROM ARRAY['browser_sessions_expiry_idx', 'browser_sessions_gotrue_idx', 'browser_sessions_pkey']::text[]
    OR NOT EXISTS (
      SELECT 1 FROM pg_index AS i JOIN pg_class AS c ON c.oid = i.indexrelid
      JOIN pg_am AS am ON am.oid = c.relam
      WHERE i.indexrelid = to_regclass('commonswarm_oauth.browser_sessions_gotrue_idx')
        AND i.indrelid = sessions_oid AND i.indisvalid AND i.indisready AND i.indislive
        AND NOT i.indisunique AND NOT i.indisprimary AND i.indnkeyatts = 1 AND i.indnatts = 1
        AND i.indexprs IS NULL AND am.amname = 'btree'
        AND i.indkey::text = (SELECT attnum::text FROM pg_attribute
          WHERE attrelid = sessions_oid AND attname = 'gotrue_session_id' AND NOT attisdropped)
        AND pg_get_expr(i.indpred, i.indrelid) = '(gotrue_session_id IS NOT NULL)'
    ) THEN
    RAISE EXCEPTION 'B38 session binding index differs';
  END IF;

  -- Compare the complete direct schema/table/column grants of this isolated
  -- owner role. Both EXCEPT directions catch missing and wider grants.
  IF EXISTS (
    WITH actual(kind, object_name, privilege, grantable) AS (
      SELECT 'SCHEMA', n.nspname::text, a.privilege_type, a.is_grantable
      FROM pg_namespace AS n CROSS JOIN LATERAL aclexplode(n.nspacl) AS a
      WHERE a.grantee = guard_oid
      UNION ALL
      SELECT 'TABLE', n.nspname || '.' || c.relname, a.privilege_type, a.is_grantable
      FROM pg_class AS c JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(c.relacl) AS a WHERE a.grantee = guard_oid
      UNION ALL
      SELECT 'COLUMN', n.nspname || '.' || c.relname || '.' || col.attname,
        a.privilege_type, a.is_grantable
      FROM pg_attribute AS col JOIN pg_class AS c ON c.oid = col.attrelid
      JOIN pg_namespace AS n ON n.oid = c.relnamespace
      CROSS JOIN LATERAL aclexplode(col.attacl) AS a
      WHERE a.grantee = guard_oid AND col.attnum > 0 AND NOT col.attisdropped
      UNION ALL
      SELECT 'FUNCTION', n.nspname || '.' || p.proname, a.privilege_type, a.is_grantable
      FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      CROSS JOIN LATERAL aclexplode(p.proacl) AS a
      WHERE a.grantee = guard_oid AND p.proowner <> guard_oid
    ), expected(kind, object_name, privilege, grantable) AS (
      VALUES
        ('SCHEMA', 'auth', 'USAGE', false),
        ('SCHEMA', 'commonswarm_oauth', 'USAGE', false),
        ('COLUMN', 'auth.sessions.id', 'SELECT', false),
        ('COLUMN', 'auth.sessions.user_id', 'SELECT', false),
        ('COLUMN', 'auth.sessions.not_after', 'SELECT', false),
        ('COLUMN', 'auth.users.id', 'SELECT', false),
        ('COLUMN', 'auth.users.deleted_at', 'SELECT', false),
        ('COLUMN', 'auth.users.banned_until', 'SELECT', false),
        ('COLUMN', 'auth.mfa_amr_claims.session_id', 'SELECT', false),
        ('COLUMN', 'auth.mfa_amr_claims.created_at', 'SELECT', false),
        ('COLUMN', 'auth.mfa_amr_claims.authentication_method', 'SELECT', false),
        ('COLUMN', 'commonswarm_oauth.browser_sessions.gotrue_session_id', 'SELECT', false),
        ('COLUMN', 'commonswarm_oauth.browser_sessions.user_id', 'SELECT', false),
        ('COLUMN', 'commonswarm_oauth.browser_sessions.invalidated_at', 'SELECT', false),
        ('COLUMN', 'commonswarm_oauth.browser_sessions.invalidated_at', 'UPDATE', false)
    )
    (SELECT * FROM actual EXCEPT SELECT * FROM expected)
    UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)
    UNION ALL SELECT 'COUNT', '', '', false WHERE (SELECT count(*) FROM actual) <> 15
  ) OR has_schema_privilege(guard_oid, 'commonswarm_oauth', 'CREATE') THEN
    RAISE EXCEPTION 'B38 session guard grants differ';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('auth.sessions'), ('auth.users'), ('auth.mfa_amr_claims')
  ) AS required(table_name) LOOP
    IF has_table_privilege(guard_oid, item.table_name, 'SELECT')
      OR has_any_column_privilege(runtime_oid, item.table_name, 'SELECT') THEN
      RAISE EXCEPTION 'B38 auth reads exceed column guard boundary: %', item.table_name;
    END IF;
  END LOOP;

  FOR item IN SELECT * FROM (VALUES
    ('auth.sessions', 'oauth_session_guard_read', 'r', false),
    ('auth.users', 'oauth_session_guard_read', 'r', false),
    ('auth.mfa_amr_claims', 'oauth_session_guard_read', 'r', false),
    ('commonswarm_oauth.browser_sessions', 'oauth_guard_read', 'r', false),
    ('commonswarm_oauth.browser_sessions', 'oauth_guard_revoke', 'w', true)
  ) AS required(table_name, policy_name, command, has_check) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy AS p
      WHERE p.polrelid = to_regclass(item.table_name) AND p.polname = item.policy_name
        AND p.polcmd::text = item.command AND p.polpermissive
        AND p.polroles = ARRAY[guard_oid]
        AND pg_get_expr(p.polqual, p.polrelid) = 'true'
        AND CASE WHEN item.has_check THEN pg_get_expr(p.polwithcheck, p.polrelid) = 'true'
          ELSE p.polwithcheck IS NULL END
    ) THEN
      RAISE EXCEPTION 'B38 session policy differs: %.%', item.table_name, item.policy_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy WHERE guard_oid = ANY(polroles)) <> 5
    OR (SELECT count(*) FROM pg_policy WHERE polrelid = sessions_oid) <> 3 THEN
    RAISE EXCEPTION 'B38 session policy set differs';
  END IF;

  IF (SELECT count(*) FROM pg_proc AS p JOIN pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'commonswarm_oauth'
        AND p.proname IN ('live_gotrue_session', 'invalidate_gotrue_session')) <> 2
    OR (SELECT count(*) FROM pg_proc WHERE proowner = guard_oid) <> 2
    OR EXISTS (SELECT 1 FROM pg_namespace WHERE nspowner = guard_oid)
    OR EXISTS (SELECT 1 FROM pg_class WHERE relowner = guard_oid) THEN
    RAISE EXCEPTION 'B38 session function or ownership set differs';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS p JOIN pg_language AS l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure('commonswarm_oauth.live_gotrue_session(uuid,uuid)')
      AND md5(p.prosrc) = 'a2394266c806734e5c9d526dca883282'
      AND p.prokind = 'f' AND p.proowner = guard_oid AND p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND p.provolatile = 's' AND p.proparallel = 'u' AND l.lanname = 'sql'
      AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND p.prorettype = 'record'::regtype AND p.proretset
      AND p.proargnames = ARRAY['wanted_session', 'wanted_user', 'session_id', 'user_id', 'authenticated_at']::text[]
      AND p.proallargtypes = ARRAY['uuid'::regtype, 'uuid'::regtype, 'uuid'::regtype,
        'uuid'::regtype, 'timestamptz'::regtype]::oid[]
      AND p.proargmodes = ARRAY['i','i','t','t','t']::"char"[] AND p.pronargdefaults = 0
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc AS p JOIN pg_language AS l ON l.oid = p.prolang
    WHERE p.oid = to_regprocedure('commonswarm_oauth.invalidate_gotrue_session()')
      AND md5(p.prosrc) = '30ef8875201c61ac23835c7d1e5c1650'
      AND p.prokind = 'f' AND p.proowner = guard_oid AND p.prosecdef AND NOT p.proleakproof
      AND NOT p.proisstrict AND p.provolatile = 'v' AND p.proparallel = 'u' AND l.lanname = 'plpgsql'
      AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
      AND p.prorettype = 'trigger'::regtype AND NOT p.proretset AND p.pronargs = 0
  ) THEN
    RAISE EXCEPTION 'B38 session function contracts differ';
  END IF;
  FOR item IN SELECT oid, proname FROM pg_proc WHERE proowner = guard_oid LOOP
    IF (SELECT array_agg(a.grantee::text || ':' || a.privilege_type || ':' || a.is_grantable::text
          ORDER BY a.grantee, a.privilege_type)
        FROM aclexplode(COALESCE((SELECT proacl FROM pg_proc WHERE oid = item.oid),
          acldefault('f', guard_oid))) AS a)
      IS DISTINCT FROM (SELECT array_agg(grant_row ORDER BY grant_oid)
        FROM (SELECT guard_oid AS grant_oid, guard_oid::text || ':EXECUTE:false' AS grant_row
          UNION ALL SELECT runtime_oid, runtime_oid::text || ':EXECUTE:false'
          WHERE item.proname = 'live_gotrue_session') AS expected) THEN
      RAISE EXCEPTION 'B38 session function ACL differs: %', item.proname;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger AS t
    WHERE t.tgrelid = to_regclass('auth.sessions') AND t.tgname = 'commonswarm_oauth_session_revocation'
      AND NOT t.tgisinternal AND t.tgenabled = 'O' AND t.tgtype = 9
      AND t.tgfoid = to_regprocedure('commonswarm_oauth.invalidate_gotrue_session()')
      AND t.tgnargs = 0 AND t.tgqual IS NULL AND t.tgconstraint = 0
      AND t.tgattr::text = '' AND t.tgoldtable IS NULL AND t.tgnewtable IS NULL
  ) OR (SELECT count(*) FROM pg_trigger
    WHERE tgfoid = to_regprocedure('commonswarm_oauth.invalidate_gotrue_session()')) <> 1 THEN
    RAISE EXCEPTION 'B38 session revocation trigger differs';
  END IF;
END
$catalog$;
\endif

SELECT :'item_b38_session_present'::boolean AS catalog_ok
\gset
