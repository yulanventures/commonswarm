/** M2 first-approval verification lock: real PostgreSQL, CI/Docker only. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catalog, dbAssert, refuses, runSql } from '../support/admin-schema-db.js';

function verification(client: string, version = 1, active = true): string {
  return `SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_oauth.admin_verified_clients(client_id,verification_version,application_type,registration_source,
  publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,pkce_s256_tested,dpop_tested,redirect_tested,
  origin_control_verified,review_evidence_ref,reviewed_by,active)
VALUES('${client}',${version},'web','static','Lock test publisher','contact@example.test',repeat('a',64),
  ARRAY['https://client.example/callback'],ARRAY['admin:read'],true,true,true,true,'lock-test-evidence','lock-test',${active});
RESET ROLE;`;
}

test('admin-schema-isolation: command locks exact first-approval verification facts without writing any application row', () => {
  const client = `https://client.example/${randomUUID()}`;
  runSql(`${verification(client)}${verification(client, 2, false)}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_client_owner_approvals', 'first approval has no approval rows')}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_grant_bindings', 'first approval has no provider binding')}
-- Snapshot every application table, not only the target verification row.
CREATE TEMP TABLE lock_test_snapshot(name text PRIMARY KEY, rows jsonb);
DO $snapshot$ DECLARE t record; BEGIN
  FOR t IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('swarm','commonswarm_oauth') AND c.relkind='r' LOOP
    EXECUTE format('INSERT INTO lock_test_snapshot SELECT %L,coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM %I.%I r',
      t.nspname||'.'||t.relname,t.nspname,t.relname);
  END LOOP;
END $snapshot$;
SET LOCAL ROLE swarm_command;
-- Direct locking is the pre-fix failure: SELECT alone cannot take FOR SHARE.
${refuses(`SELECT * FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}' AND verification_version=1 FOR SHARE`, '42501')}
${dbAssert(`SELECT count(*)=1 AND bool_and(client_id='${client}' AND verification_version=1 AND active AND withdrawn_at IS NULL
  AND metadata_digest=repeat('a',64) AND application_type='web' AND redirect_class='hosted_https'
  AND redirect_uris=ARRAY['https://client.example/callback'])
  FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'exact active verification control')}
${dbAssert(`SELECT count(*)=1 AND bool_and(verification_version=2 AND NOT active AND withdrawn_at IS NULL)
  FROM commonswarm_oauth.lock_admin_client_verification('${client}',2)`, 'exact inactive version control')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('absent-client',1)`, 'P0001')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',3)`, 'P0001')}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',NULL)`, 'P0001')}
${refuses(`UPDATE commonswarm_oauth.admin_verified_clients SET active=false WHERE client_id='${client}'`, '42501')}
${refuses(`DELETE FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}'`, '42501')}
${refuses(`INSERT INTO commonswarm_oauth.admin_verified_clients SELECT * FROM commonswarm_oauth.admin_verified_clients WHERE client_id='${client}'`, '42501')}
RESET ROLE;
DO $unchanged$ DECLARE t record; actual jsonb; expected jsonb; BEGIN
  FOR t IN SELECT n.nspname,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN ('swarm','commonswarm_oauth') AND c.relkind='r' LOOP
    SELECT rows INTO STRICT expected FROM lock_test_snapshot WHERE name=t.nspname||'.'||t.relname;
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY to_jsonb(r)::text),''[]''::jsonb) FROM %I.%I r',t.nspname,t.relname) INTO actual;
    IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'locking changed %.%',t.nspname,t.relname; END IF;
  END LOOP;
END $unchanged$;
${dbAssert('SELECT NOT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state', 'issuance remains closed')}
`);
});

test('admin-schema-isolation: withdrawn facts remain readable only through the command verification lock', () => {
  const client = `https://client.example/${randomUUID()}`;
  runSql(`${verification(client)}
SET LOCAL ROLE swarm_command;
${dbAssert(`SELECT active AND withdrawn_at IS NULL FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'active control before withdrawal')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='operator_withdrawn'
  WHERE client_id='${client}' AND verification_version=1;
RESET ROLE;
SET LOCAL ROLE swarm_command;
${dbAssert(`SELECT NOT active AND withdrawn_at IS NOT NULL AND verification_version=1 AND metadata_digest=repeat('a',64)
  AND redirect_class='hosted_https' FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'withdrawn status is returned, not hidden')}
RESET ROLE;
${['commonswarm_oauth_runtime', 'swarm_read', 'anon', 'authenticated', 'commonswarm_admin_release',
    'commonswarm_dpop_verifier', 'commonswarm_oauth_maintenance'].map(role => `SET LOCAL ROLE ${role};
${dbAssert(`SELECT NOT has_function_privilege(current_user,'commonswarm_oauth.lock_admin_client_verification(text,integer)','EXECUTE')`, `${role} lacks EXECUTE`)}
${refuses(`SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, '42501')}
RESET ROLE;`).join('\n')}
-- Pair denied execution with existing runtime/read status execution; both roles
-- have schema usage, so their refusal reaches the new function's EXECUTE ACL.
${['commonswarm_oauth_runtime', 'swarm_read'].map(role => `SET LOCAL ROLE ${role};
${dbAssert("SELECT has_schema_privilege(current_user,'commonswarm_oauth','USAGE')", `${role} schema control`)}
${dbAssert("SELECT commonswarm_oauth.issuer_key_allowed('https://mcp.commonswarm.com','lock-test-kid')", `${role} permitted function control`)}
RESET ROLE;`).join('\n')}
SET LOCAL ROLE swarm_command;
${dbAssert(`SELECT NOT active FROM commonswarm_oauth.lock_admin_client_verification('${client}',1)`, 'command execution still permitted')}
RESET ROLE;
${catalog('20261003000002')}
-- An accidentally exposed ACL must make the executable release proof fail.
GRANT EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer) TO commonswarm_oauth_runtime;
${catalog('20261003000002', false, false)}
REVOKE EXECUTE ON FUNCTION commonswarm_oauth.lock_admin_client_verification(text,integer) FROM commonswarm_oauth_runtime;
${catalog('20261003000002')}
`);
});

test('admin-schema-isolation: verification locking retains a transaction-held RowShareLock after return', () => {
  const client = `https://client.example/${randomUUID()}`;
  // runSql creates the real schemas and fixtures inside one rollback transaction.
  // A second backend cannot see those uncommitted schemas/rows; a two-session
  // withdrawal race would test DDL visibility instead of the verification lock.
  // Use the task-approved pg_locks alternative. RowShareLock proves a locking
  // SELECT survives function return; the release catalog pins the exact FOR SHARE
  // body. pg_locks does not normally expose uncontended tuple locks, so this
  // relation lock alone does not distinguish FOR SHARE from FOR KEY SHARE.
  runSql(`${verification(client)}
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
  AND relation='commonswarm_oauth.admin_verified_clients'::regclass AND mode='RowShareLock' AND granted)`, 'no pre-existing locking SELECT control')}
SET LOCAL ROLE swarm_command;
SELECT * FROM commonswarm_oauth.lock_admin_client_verification('${client}',1);
${dbAssert(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='relation'
  AND relation='commonswarm_oauth.admin_verified_clients'::regclass AND mode='RowShareLock' AND granted)`, 'transaction retains verification RowShareLock')}
RESET ROLE;
${catalog('20261003000002')}
`);
});
