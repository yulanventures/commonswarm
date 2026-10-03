/** D1 effective application privileges: literal reviewed ACL inventory, CI/Docker only. */
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { catalog, dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

const allowlist = JSON.parse(readFileSync(new URL('../support/admin-issuer-privileges.json', import.meta.url), 'utf8'));
const literal = JSON.stringify(allowlist).replaceAll("'", "''");
// Enumerate explicit ACLs across the whole database, not a selected set of known
// tables. The saved schemas belong to runSql's rollback-only isolation fixture.
// Default PUBLIC EXECUTE on system functions is the platform baseline. Explicit
// grants to issuer/parents and PUBLIC grants beyond initial ACLs are inventoried.
// PUBLIC grants on user
// objects remain in the inventory; only pinned extension-member EXECUTE and
// built-in language/database/schema privileges are allowed below. Extension
// signatures are literal PostgreSQL 17 contrib definitions (REL_17_STABLE);
// membership in an extension alone does not allow a new callable function.
const inventory = `
CREATE TEMP VIEW issuer_acl_inventory AS
WITH objects(kind,name,owner,acl,object_id) AS (
 SELECT CASE WHEN c.relkind='S' THEN 'SEQUENCE' ELSE 'TABLE' END,n.nspname||'.'||c.relname,c.relowner,c.relacl,c.oid
 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname !~ '^(pg_|ai_saved_)' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'COLUMN',n.nspname||'.'||c.relname||'.'||a.attname,c.relowner,a.attacl,c.oid
 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname !~ '^(pg_|ai_saved_)' AND n.nspname<>'information_schema' AND a.attnum>0 AND NOT a.attisdropped
 UNION ALL SELECT 'SCHEMA',nspname,nspowner,nspacl,oid FROM pg_namespace WHERE nspname !~ '^(pg_|ai_saved_)' AND nspname<>'information_schema'
 UNION ALL SELECT 'FUNCTION',n.nspname||'.'||p.proname||'('||regexp_replace(oidvectortypes(p.proargtypes),'\\s','','g')||')',p.proowner,coalesce(p.proacl,acldefault('f',p.proowner)),p.oid
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname !~ '^ai_saved_'
 UNION ALL SELECT 'TYPE',n.nspname||'.'||t.typname,t.typowner,t.typacl,t.oid FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname !~ '^(pg_|ai_saved_)' AND n.nspname<>'information_schema'
 UNION ALL SELECT 'DATABASE',datname,datdba,datacl,oid FROM pg_database
 UNION ALL SELECT 'LANGUAGE',lanname,lanowner,lanacl,oid FROM pg_language
 UNION ALL SELECT 'TABLESPACE',spcname,spcowner,spcacl,oid FROM pg_tablespace
 UNION ALL SELECT 'FDW',fdwname,fdwowner,fdwacl,oid FROM pg_foreign_data_wrapper
 UNION ALL SELECT 'SERVER',srvname,srvowner,srvacl,oid FROM pg_foreign_server
 UNION ALL SELECT 'PARAMETER',parname,0,paracl,oid FROM pg_parameter_acl
 UNION ALL SELECT 'DEFAULT',d.defaclobjtype::text||':'||coalesce(n.nspname,'global'),d.defaclrole,d.defaclacl,d.oid
 FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace WHERE coalesce(n.nspname,'') !~ '^ai_saved_'
)
SELECT coalesce(r.rolname::text,'PUBLIC') AS grantee,
 CASE WHEN a.grantee=0 AND ext.extname IS NOT NULL THEN 'EXTENSION_'||kind ELSE kind END AS kind,
 CASE WHEN a.grantee=0 AND ext.extname IS NOT NULL THEN ext.extname||'.'||
   regexp_replace(substring(o.name FROM position('.' in o.name)+1),'(extensions|public)[.]','','g') ELSE name END AS name,
 a.privilege_type,a.is_grantable
FROM objects o CROSS JOIN LATERAL aclexplode(o.acl) a LEFT JOIN pg_roles r ON r.oid=a.grantee
LEFT JOIN LATERAL (SELECT e.extname FROM pg_depend d JOIN pg_extension e ON e.oid=d.refobjid
 WHERE d.classid=CASE WHEN o.kind='FUNCTION' THEN 'pg_proc'::regclass ELSE 'pg_class'::regclass END
   AND o.kind IN ('FUNCTION','TABLE','SEQUENCE') AND d.objid=o.object_id AND d.deptype='e'
   AND e.extname IN ('pgcrypto','uuid-ossp','pg_stat_statements','pg_trgm')) ext ON true
WHERE a.grantee<>o.owner
 AND NOT (o.kind='FUNCTION' AND split_part(o.name,'.',1) IN ('pg_catalog','information_schema') AND a.grantee=0
   AND EXISTS(SELECT 1 FROM aclexplode(coalesce((SELECT i.initprivs FROM pg_init_privs i
     WHERE i.classoid='pg_proc'::regclass AND i.objoid=o.object_id AND i.objsubid=0 AND i.privtype='i'),acldefault('f',o.owner))) initial
     WHERE initial.grantee=a.grantee AND initial.privilege_type=a.privilege_type AND initial.is_grantable=a.is_grantable))
 AND (r.rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command')
 OR (a.grantee=0 AND (position('.' in o.name)=0
   OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname=split_part(o.name,'.',1)
     AND (has_schema_privilege('commonswarm_admin_issuer',n.oid,'USAGE')
       OR has_schema_privilege('commonswarm_oauth_runtime',n.oid,'USAGE')
       OR has_schema_privilege('swarm_command',n.oid,'USAGE'))))));
CREATE TEMP VIEW issuer_widening AS
SELECT jsonb_build_array(grantee,kind,name,privilege_type,is_grantable) AS privilege FROM issuer_acl_inventory
WHERE NOT (grantee='commonswarm_oauth_runtime' AND kind='DATABASE' AND name=current_database() AND privilege_type='CONNECT' AND NOT is_grantable)
EXCEPT SELECT value FROM jsonb_array_elements('${literal}'::jsonb);
CREATE FUNCTION pg_temp.assert_issuer() RETURNS void LANGUAGE plpgsql AS $check$
DECLARE unexpected text;
BEGIN
 SELECT string_agg(privilege::text,E'\n' ORDER BY privilege::text) INTO unexpected FROM issuer_widening;
 IF unexpected IS NOT NULL THEN
   RAISE EXCEPTION 'issuer privilege widening (grantee/kind/object/privilege/grantable):%',E'\n'||unexpected USING ERRCODE='ZX002';
 END IF;
 IF (SELECT array_agg(r.rolname::text ORDER BY r.rolname) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.roleid
   WHERE m.member='commonswarm_admin_issuer'::regrole AND NOT m.admin_option AND NOT m.inherit_option AND m.set_option)
   IS DISTINCT FROM ARRAY['commonswarm_oauth_runtime','swarm_command']::text[]
   OR (SELECT count(*) FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole)<>2
   OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member IN ('commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole))
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command')
     AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcanlogin))
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime') AND rolinherit)
   OR EXISTS(SELECT 1 FROM pg_shdepend WHERE refclassid='pg_authid'::regclass
     AND refobjid IN ('commonswarm_admin_issuer'::regrole,'commonswarm_oauth_runtime'::regrole,'swarm_command'::regrole) AND deptype='o') THEN
   -- Catalog metadata only: show each edge, role option and owned object that
   -- failed the assertion. Include the grantor so duplicate PG17 edges are clear.
   SELECT string_agg(privilege::text,E'\n' ORDER BY privilege::text) INTO unexpected FROM (
     SELECT jsonb_build_array(member.rolname,'MEMBERSHIP',parent.rolname||' GRANTED BY '||grantor.rolname,
       format('ADMIN=%s INHERIT=%s SET=%s',m.admin_option,m.inherit_option,m.set_option),m.admin_option) AS privilege
     FROM pg_auth_members m JOIN pg_roles member ON member.oid=m.member
     JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles grantor ON grantor.oid=m.grantor
     WHERE member.rolname IN ('commonswarm_oauth_runtime','swarm_command')
       OR (member.rolname='commonswarm_admin_issuer' AND (parent.rolname NOT IN ('commonswarm_oauth_runtime','swarm_command')
         OR m.admin_option OR m.inherit_option OR NOT m.set_option
         OR (SELECT count(*) FROM pg_auth_members edge WHERE edge.member=m.member AND edge.roleid=m.roleid)<>1))
     UNION ALL
     SELECT jsonb_build_array(r.rolname,'ROLE',r.rolname,
       format('LOGIN=%s INHERIT=%s SUPERUSER=%s CREATEDB=%s CREATEROLE=%s REPLICATION=%s BYPASSRLS=%s',
         r.rolcanlogin,r.rolinherit,r.rolsuper,r.rolcreatedb,r.rolcreaterole,r.rolreplication,r.rolbypassrls),false)
     FROM pg_roles r WHERE r.rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command')
       AND (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR NOT r.rolcanlogin
         OR (r.rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime') AND r.rolinherit))
     UNION ALL
     SELECT jsonb_build_array(r.rolname,'OWNERSHIP',
       CASE WHEN d.dbid IN (0,(SELECT oid FROM pg_database WHERE datname=current_database()))
         THEN pg_describe_object(d.classid,d.objid,d.objsubid)
         ELSE format('database=%s catalog=%s object=%s subobject=%s',d.dbid,d.classid,d.objid,d.objsubid) END,'OWNER',false)
     FROM pg_shdepend d JOIN pg_roles r ON r.oid=d.refobjid
     WHERE d.refclassid='pg_authid'::regclass AND r.rolname IN ('commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command')
       AND d.deptype='o'
   ) failures;
   RAISE EXCEPTION 'issuer role widening (grantee/kind/object/privilege/grantable):%',E'\n'||coalesce(unexpected,'missing required issuer membership') USING ERRCODE='ZX002';
 END IF;
END $check$;
REVOKE EXECUTE ON FUNCTION pg_temp.assert_issuer() FROM PUBLIC;
`;

test('admin-issuer-privileges: enumerate reachable roles, options, ownership and direct grants against literal allowlist with mutation controls', () => {
  const grantor = `ai_issuer_grantor_${randomUUID().replaceAll('-', '')}`;
  const issuerGuard = repoSql('supabase/migrations/20261003000002_admin_oauth_policy.sql').match(/DO \$issuer\$[\s\S]*?END \$issuer\$;/)![0];
  runSql(`${inventory}
SELECT pg_temp.assert_issuer();
${catalog('20261003000002')}
-- Reproduce production's constrained applying principal even when CI initially
-- applied M2 as a superuser. All role/edge changes roll back with this fixture.
${repoSql('supabase/admin-delegation-reserve/20261003000002-rollback.sql').match(/DO \$issuer_memberships\$[\s\S]*?END \$issuer_memberships\$;/)![0]}
CREATE ROLE ${grantor} NOLOGIN NOINHERIT CREATEROLE NOSUPERUSER NOBYPASSRLS;
GRANT commonswarm_admin_issuer,commonswarm_oauth_runtime,swarm_command TO ${grantor} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
SET LOCAL ROLE ${grantor};
${issuerGuard}
RESET ROLE;
${dbAssert(`SELECT count(*)=2 AND bool_and(grantor='${grantor}'::regrole) FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole`, 'both issuer edges have a different constrained grantor')}
SELECT pg_temp.assert_issuer();
SAVEPOINT duplicate_grantor;
GRANT swarm_command TO commonswarm_admin_issuer WITH ADMIN FALSE, INHERIT FALSE, SET TRUE;
${dbAssert("SELECT count(*)=3 FROM pg_auth_members WHERE member='commonswarm_admin_issuer'::regrole", 'unqualified administrator grant creates a third edge')}
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
ROLLBACK TO SAVEPOINT duplicate_grantor;
SELECT pg_temp.assert_issuer();
GRANT EXECUTE ON FUNCTION pg_temp.assert_issuer() TO PUBLIC;
${dbAssert("SELECT count(*)=1 AND bool_and(privilege=jsonb_build_array('PUBLIC','FUNCTION',(SELECT nspname FROM pg_namespace WHERE oid=pg_my_temp_schema())||'.assert_issuer()','EXECUTE',false)) FROM issuer_widening", 'temporary PUBLIC EXECUTE is the offending inventory row')}
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE EXECUTE ON FUNCTION pg_temp.assert_issuer() FROM PUBLIC;
SELECT pg_temp.assert_issuer();
${dbAssert('SELECT count(*)>200 FROM issuer_acl_inventory', 'enumeration positive control includes existing command and runtime grants')}
${dbAssert("SELECT NOT pg_has_role('commonswarm_admin_issuer','swarm_command','USAGE') AND pg_has_role('commonswarm_admin_issuer','swarm_command','SET')", 'no inherited command authority')}
-- SET ROLE checks the session user, not a previously selected current_user.
-- Use the cluster admin only to establish the real issuer session identity.
SET LOCAL SESSION AUTHORIZATION commonswarm_admin_issuer;
${dbAssert("SELECT session_user='commonswarm_admin_issuer' AND current_user=session_user", 'issuer session identity positive')}
${refuses('SELECT * FROM swarm.admin_accounts','42501')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert("SELECT session_user='commonswarm_admin_issuer' AND current_user='commonswarm_oauth_runtime'", 'issuer can select OAuth parent')}
SELECT * FROM commonswarm_oauth.provider_artifacts;
RESET ROLE;
SET LOCAL ROLE swarm_command;
${dbAssert("SELECT session_user='commonswarm_admin_issuer' AND current_user='swarm_command'", 'issuer can select command parent')}
SELECT * FROM swarm.admin_accounts;
RESET ROLE;
DO $role_denials$
DECLARE target text; tested integer := 0;
BEGIN
  FOR target IN SELECT rolname FROM pg_roles WHERE rolname NOT IN
    ('commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command') LOOP
    BEGIN
      EXECUTE format('SET LOCAL ROLE %I',target);
      RAISE EXCEPTION 'issuer admitted unexpected role: %',target USING ERRCODE='ZX001';
    EXCEPTION WHEN insufficient_privilege THEN tested := tested + 1;
    END;
  END LOOP;
  IF tested=0 THEN RAISE EXCEPTION 'no other roles tested'; END IF;
END $role_denials$;
${dbAssert("SELECT session_user='commonswarm_admin_issuer' AND current_user=session_user", 'role denials retain issuer identity')}
${refuses('SELECT * FROM swarm.admin_accounts','42501')}
RESET SESSION AUTHORIZATION;
${catalog('20261003000002')}
GRANT SELECT ON swarm.admin_accounts TO commonswarm_admin_issuer;
${catalog('20261003000002',false,false)}
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE SELECT ON swarm.admin_accounts FROM commonswarm_admin_issuer;
GRANT DELETE ON swarm.admin_accounts TO swarm_command;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE DELETE ON swarm.admin_accounts FROM swarm_command;
-- Mutate the existing edge, not a second edge owned by the test administrator.
-- M2 may have been applied by a different, constrained release principal.
${['ADMIN TRUE','INHERIT TRUE','SET FALSE'].map(option => `DO $membership_mutation$
DECLARE grantor_name text;
BEGIN
  SELECT grantor.rolname INTO STRICT grantor_name FROM pg_auth_members m JOIN pg_roles grantor ON grantor.oid=m.grantor
    WHERE m.member='commonswarm_admin_issuer'::regrole AND m.roleid='swarm_command'::regrole;
  EXECUTE format('GRANT swarm_command TO commonswarm_admin_issuer WITH ${option} GRANTED BY %I',grantor_name);
END $membership_mutation$;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
DO $membership_restore$
DECLARE grantor_name text;
BEGIN
  SELECT grantor.rolname INTO STRICT grantor_name FROM pg_auth_members m JOIN pg_roles grantor ON grantor.oid=m.grantor
    WHERE m.member='commonswarm_admin_issuer'::regrole AND m.roleid='swarm_command'::regrole;
  EXECUTE format('GRANT swarm_command TO commonswarm_admin_issuer WITH ADMIN FALSE, INHERIT FALSE, SET TRUE GRANTED BY %I',grantor_name);
END $membership_restore$;
SELECT pg_temp.assert_issuer();`).join('\n')}
GRANT swarm_read TO swarm_command WITH INHERIT TRUE, SET TRUE;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE swarm_read FROM swarm_command;
CREATE TABLE public.issuer_mutation_control(id integer);
GRANT INSERT ON public.issuer_mutation_control TO commonswarm_oauth_runtime;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE INSERT ON public.issuer_mutation_control FROM commonswarm_oauth_runtime;
GRANT SELECT ON public.issuer_mutation_control TO PUBLIC;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE SELECT ON public.issuer_mutation_control FROM PUBLIC;
ALTER TABLE public.issuer_mutation_control OWNER TO commonswarm_admin_issuer;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
ALTER TABLE public.issuer_mutation_control OWNER TO supabase_admin;
SELECT pg_temp.assert_issuer();
CREATE FUNCTION public.issuer_function_mutation() RETURNS boolean LANGUAGE sql AS 'SELECT true';
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE ALL ON FUNCTION public.issuer_function_mutation() FROM PUBLIC;
GRANT USAGE ON TYPE commonswarm_oauth.admin_security_reason TO PUBLIC;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE USAGE ON TYPE commonswarm_oauth.admin_security_reason FROM PUBLIC;
${['commonswarm_admin_issuer','commonswarm_oauth_runtime','swarm_command'].map(role => `GRANT EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) TO ${role};
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
REVOKE EXECUTE ON FUNCTION pg_catalog.pg_read_file(text) FROM ${role};`).join('\n')}
ALTER ROLE commonswarm_admin_issuer INHERIT;
${refuses('SELECT pg_temp.assert_issuer()','ZX002')}
ALTER ROLE commonswarm_admin_issuer NOINHERIT;
SELECT pg_temp.assert_issuer();
`);
});
