/** D3 authenticated request audit and anonymous shared bucket, CI/Docker only. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catalog, dbAssert, fixture, issuance, openIssuanceForTest, refuses, repoSql, runSql } from '../support/admin-schema-db.js';

function request(token: { jti: string; tokenDigest: string }, kind: string, outcome = 'committed', digest = token.tokenDigest, reason = 'NULL', events = "'{}'::uuid[]") {
  const { jti } = token;
  return `commonswarm_oauth.record_admin_request_audit('${jti}',decode('${digest}','hex'),'${kind}',
    '${randomUUID()}','${outcome}',${reason},NULL,NULL,${events})`;
}

test('admin-request-audit: derive authenticated binding, narrow ACL, wrong/unknown issuance and direct insertion refusals with active control', () => {
  const f = fixture(), token = issuance(f);
  runSql(`${f.sql}${openIssuanceForTest}${token.sql}
${['commonswarm_oauth_runtime','swarm_command'].map(role => `SET LOCAL ROLE ${role};
${dbAssert(`SELECT ${request(token,'init')} IS NOT NULL`, `${role} authenticated initialization control`)}
${dbAssert(`SELECT ${request(token,'action','committed',token.tokenDigest,'NULL',`ARRAY['${token.event}']::uuid[]`)} IS NOT NULL`, `${role} event-bound action control`)}
${refuses(`SELECT ${request(token,'read','committed','99'.repeat(32))}`,'28000')}
${refuses(`SELECT ${request({ ...token, jti: 'unknown-jti' },'list')}`,'28000')}
${refuses(`SELECT ${request(token,'invented')}`,'22023')}
${refuses(`SELECT ${request(token,'read','refused')}`,'22023')}
${refuses(`SELECT ${request(token,'action','committed',token.tokenDigest,'NULL',`ARRAY['${randomUUID()}']::uuid[]`)}`,'23514')}
${refuses('SELECT * FROM commonswarm_oauth.admin_oauth_audit_daily','42501')}
RESET ROLE;`).join('\n')}
${dbAssert(`SELECT count(*)=4 AND bool_and(owner_user_id='${f.owner}' AND admin_identity_id='${f.identity}'
  AND admin_grant_id='${f.grant}' AND connection_id='${f.connection}' AND provider_grant_id='${f.provider}'
  AND manifest_digest='${f.digest}') FROM commonswarm_oauth.admin_oauth_audit WHERE event_kind IN ('init','action')`, 'derived exact binding; negative probes inserted nothing')}
SET LOCAL ROLE commonswarm_oauth_runtime;
INSERT INTO commonswarm_oauth.admin_oauth_audit(owner_user_id,admin_identity_id,admin_grant_id,connection_id,provider_grant_id,
  manifest_digest,event_kind,outcome,reason_code) VALUES('${f.owner}','${f.identity}','${f.grant}','${f.connection}',
  '${f.provider}','${f.digest}','refused','refused','test_control');
${refuses(`INSERT INTO commonswarm_oauth.admin_oauth_audit(owner_user_id,admin_identity_id,admin_grant_id,connection_id,provider_grant_id,
  manifest_digest,event_kind,outcome) VALUES('${f.owner}','${f.identity}','${f.grant}','${f.connection}',
  '${f.provider}','${f.digest}','read','committed')`,'42501')}
RESET ROLE;
${['anon','authenticated','swarm_read','commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance','commonswarm_admin_issuer'].map(role => `SET LOCAL ROLE ${role};
${refuses(`SELECT ${request(token,'read')}`,'42501')}
${refuses("SELECT commonswarm_oauth.record_admin_security_failure('invalid_token')",'42501')}
RESET ROLE;`).join('\n')}
SET LOCAL ROLE swarm_command;
SELECT commonswarm_oauth.fence_admin_family('${f.provider}','${f.owner}','revoked','audit_test');
${refuses(`SELECT ${request(token,'read')}`,'28000')}
${dbAssert(`SELECT ${request(token,'read','refused',token.tokenDigest,"'inactive'")} IS NOT NULL`, 'revoked authenticated refusal remains attributed')}
RESET ROLE;
${catalog('20261003000003')}
`);
});

test('admin-request-audit: one per-grant UTC daily cap counts every suppressed read and never drops actions; counters cannot reset', () => {
  const f = fixture(), token = issuance(f), independent = fixture(), second = issuance(independent);
  runSql(`${f.sql}${independent.sql}${openIssuanceForTest}${token.sql}${second.sql}
INSERT INTO commonswarm_oauth.admin_oauth_audit_daily(admin_grant_id,audit_day,read_requests,read_rows)
VALUES('${independent.grant}',(clock_timestamp() AT TIME ZONE 'UTC')::date-1,1000,1000);
SET LOCAL ROLE commonswarm_oauth_runtime;
DO $fill$ DECLARE n integer; inserted uuid; BEGIN
 FOR n IN 1..1003 LOOP
  SELECT commonswarm_oauth.record_admin_request_audit('${token.jti}',decode('${token.tokenDigest}','hex'),
    CASE n%3 WHEN 0 THEN 'init' WHEN 1 THEN 'list' ELSE 'read' END,'request-'||n,'committed',NULL,NULL,NULL,'{}') INTO inserted;
  IF (n<=1000 AND inserted IS NULL) OR (n>1000 AND inserted IS NOT NULL) THEN RAISE EXCEPTION 'cap boundary mismatch'; END IF;
 END LOOP;
END $fill$;
${dbAssert(`SELECT ${request(token,'action')} IS NOT NULL`, 'action after exhausted read cap still inserts')}
${dbAssert(`SELECT ${request(token,'action','refused',token.tokenDigest,"'forbidden'")} IS NOT NULL`, 'refused action is never dropped')}
${dbAssert(`SELECT ${request(second,'read')} IS NOT NULL`, 'independent grant retains its own cap')}
RESET ROLE;
${dbAssert(`SELECT read_requests=1003 AND read_rows=1000 AND suppressed_read_rows=3 AND action_rows=2
  AND audit_day=(clock_timestamp() AT TIME ZONE 'UTC')::date FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id='${f.grant}'`, 'counted suppressed rows and action rows reconcile')}
${dbAssert(`SELECT count(*)=1000 FROM commonswarm_oauth.admin_oauth_audit WHERE admin_grant_id='${f.grant}' AND event_kind IN ('init','list','read')`, 'exact retained read cap')}
${dbAssert(`SELECT count(*)=2 FROM commonswarm_oauth.admin_oauth_audit WHERE admin_grant_id='${f.grant}' AND event_kind='action'`, 'both action outcomes retained')}
${dbAssert(`SELECT read_rows=1000 FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id='${independent.grant}' AND audit_day=(clock_timestamp() AT TIME ZONE 'UTC')::date-1`, 'prior UTC day retained')}
${dbAssert(`SELECT read_rows=1 FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id='${independent.grant}' AND audit_day=(clock_timestamp() AT TIME ZONE 'UTC')::date`, 'current UTC day gets its own cap')}
ALTER TABLE commonswarm_oauth.admin_oauth_audit ADD CONSTRAINT request_audit_fault CHECK(event_kind<>'action') NOT VALID;
SET LOCAL ROLE commonswarm_oauth_runtime;
${refuses(`SELECT ${request(token,'action')}`,'23514')}
RESET ROLE;
ALTER TABLE commonswarm_oauth.admin_oauth_audit DROP CONSTRAINT request_audit_fault;
${dbAssert(`SELECT action_rows=2 FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id='${f.grant}'`, 'failed action insert rolls back its counter')}
SET LOCAL ROLE swarm_admin;
${refuses(`DELETE FROM commonswarm_oauth.admin_oauth_audit_daily WHERE admin_grant_id='${f.grant}'`,'55000')}
${refuses(`UPDATE commonswarm_oauth.admin_oauth_audit_daily SET read_requests=1000,suppressed_read_rows=0 WHERE admin_grant_id='${f.grant}'`,'55000')}
${refuses(`UPDATE commonswarm_oauth.admin_oauth_audit_daily SET audit_day=audit_day+1 WHERE admin_grant_id='${f.grant}'`,'55000')}
${refuses(`UPDATE commonswarm_oauth.admin_oauth_audit SET request_id='edited' WHERE event_kind='action'`,'55000')}
${refuses(`DELETE FROM commonswarm_oauth.admin_oauth_audit WHERE event_kind='action'`,'55000')}
RESET ROLE;
${refuses(repoSql('supabase/admin-delegation-reserve/20261003000003-rollback.sql'),'55000')}
${catalog('20261003000003')}
ALTER TABLE commonswarm_oauth.admin_oauth_audit DISABLE TRIGGER admin_oauth_request_audit;
${catalog('20261003000003',false,false)}
ALTER TABLE commonswarm_oauth.admin_oauth_audit ENABLE TRIGGER admin_oauth_request_audit;
GRANT UPDATE ON commonswarm_oauth.admin_oauth_audit_daily TO commonswarm_oauth_runtime;
${catalog('20261003000003',false,false)}
REVOKE UPDATE ON commonswarm_oauth.admin_oauth_audit_daily FROM commonswarm_oauth_runtime;
${catalog('20261003000003')}
`);
});

test('admin-request-audit: anonymous failures charge the existing shared bucket, bounded reasons and rows, no victim binding or authority mutation', () => {
  runSql(`CREATE TEMP TABLE anonymous_authority_snapshot AS SELECT to_jsonb(a) AS row FROM swarm.admin_accounts a;
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert("SELECT commonswarm_oauth.record_admin_security_failure('invalid_dpop')", 'AS first security failure is counted and retained')}
${refuses("SELECT commonswarm_oauth.record_admin_security_failure('caller-supplied-victim-or-secret')",'22P02')}
${refuses('SELECT commonswarm_oauth.record_admin_security_failure(NULL)','22023')}
RESET ROLE;
SET LOCAL ROLE swarm_command;
DO $fill$ DECLARE n integer; allowed boolean; BEGIN
 FOR n IN 2..61 LOOP
  SELECT commonswarm_oauth.record_admin_security_failure('invalid_token') INTO allowed;
  IF allowed IS DISTINCT FROM (n<=60) THEN RAISE EXCEPTION 'shared security budget mismatch'; END IF;
 END LOOP;
END $fill$;
RESET ROLE;
${dbAssert("SELECT count(*)=1 AND bool_and(bucket_key='security:unknown_admin_credential' AND attempts=61) FROM swarm.admin_rate_buckets", 'one shared bucket, every attempt counted')}
${dbAssert("SELECT count(*)=60 AND bool_and(reason_code IN ('invalid_token','invalid_dpop')) FROM swarm.admin_security_audit", 'bounded retained rows and reason enum')}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_oauth_audit', 'anonymous failures never bind to grant audit')}
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_oauth_audit_daily', 'anonymous failures never charge a victim grant')}
${dbAssert('SELECT count(*)=0 FROM swarm.admin_events', 'anonymous failure writes no authority event')}
${dbAssert('SELECT NOT EXISTS((SELECT to_jsonb(a) FROM swarm.admin_accounts a EXCEPT SELECT row FROM anonymous_authority_snapshot) UNION ALL (SELECT row FROM anonymous_authority_snapshot EXCEPT SELECT to_jsonb(a) FROM swarm.admin_accounts a))', 'anonymous failure cannot create/change an account')}
${catalog('20261003000003')}
GRANT EXECUTE ON FUNCTION commonswarm_oauth.record_admin_security_failure(commonswarm_oauth.admin_security_reason) TO swarm_read;
${catalog('20261003000003',false,false)}
REVOKE EXECUTE ON FUNCTION commonswarm_oauth.record_admin_security_failure(commonswarm_oauth.admin_security_reason) FROM swarm_read;
${catalog('20261003000003')}
`);
});

test('admin-request-audit: suppress-count-only evidence blocks every M1-M3 inverse', () => {
 const f = fixture(1);
 runSql(`${f.sql}
INSERT INTO commonswarm_oauth.admin_oauth_audit_daily(admin_grant_id,audit_day,read_requests,read_rows,suppressed_read_rows)
VALUES('${f.grant}',(clock_timestamp() AT TIME ZONE 'UTC')::date,1001,1000,1);
${dbAssert('SELECT count(*)=0 FROM commonswarm_oauth.admin_oauth_audit', 'no retained OAuth audit rows in counter-only control')}
${['20261003000001','20261003000002','20261003000003'].map(v => refuses(repoSql(`supabase/admin-delegation-reserve/${v}-rollback.sql`),'55000')).join('\n')}
${catalog('20261003000003')}
`);
});
