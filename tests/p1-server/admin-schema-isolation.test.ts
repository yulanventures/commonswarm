/** admin-schema-isolation: real migration/ACL/lifecycle boundary, Docker gate only. */
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { catalog, dbAssert, fixture, issuance, migrationNames, openIssuanceForTest, refuses, repoSql, runSql, versions } from '../support/admin-schema-db.js';

test('admin-schema-isolation: prerequisite upgrade as a non-superuser and data-free reverse reserves', () => {
  const role = `ai_migration_${randomUUID().replaceAll('-', '')}`;
  const noncreator = `ai_noncreator_${randomUUID().replaceAll('-', '')}`;
  const roleGuard = repoSql('supabase/migrations/20261003000002_admin_oauth_policy.sql').match(/DO \$roles\$[\s\S]*?END \$roles\$;/)![0];
  const owner = randomUUID(), workspace = randomUUID(), hosted = randomUUID(), provider = randomUUID();
  runSql(`
${versions.map(v => catalog(v)).join('\n')}
${[...versions].reverse().map(v => repoSql(`supabase/admin-delegation-reserve/${v}-rollback.sql`) + catalog(v, true) + catalog(v, false, false)).join('\n')}
-- In the isolated rollback transaction, also exercise the non-superuser CREATE
-- ROLE path. The reserve itself retains these dormant/operator-owned roles.
DROP ROLE commonswarm_admin_release,commonswarm_dpop_verifier,commonswarm_oauth_maintenance;
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Hosted prerequisite owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','Hosted prerequisite','${owner}');
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
  selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
VALUES('${hosted}','${provider}','${owner}','${workspace}','ordinary-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],
  decode(repeat('ab',32),'hex'),'reviewed-hosted-interaction','active',statement_timestamp(),statement_timestamp());
CREATE ROLE ${role} NOLOGIN INHERIT CREATEROLE;
GRANT swarm_admin TO ${role};
SET LOCAL ROLE ${role};
${dbAssert(`SELECT NOT rolsuper AND NOT rolbypassrls FROM pg_roles WHERE rolname=current_user`, 'migration role must be constrained')}
${migrationNames.map(name => repoSql(`supabase/migrations/${name}`)).join('\n')}
${dbAssert(`SELECT count(*)=3 AND bool_and(m.admin_option AND NOT m.inherit_option AND NOT m.set_option)
  FROM pg_auth_members m JOIN pg_roles parent ON parent.oid=m.roleid JOIN pg_roles member ON member.oid=m.member
  WHERE parent.rolname IN ('commonswarm_admin_release','commonswarm_dpop_verifier','commonswarm_oauth_maintenance') AND member.rolname='${role}'`, 'constrained creator memberships retained')}
RESET ROLE;
CREATE ROLE ${noncreator} NOLOGIN INHERIT CREATEROLE;
SET LOCAL ROLE ${noncreator};
${refuses(roleGuard, 'P0001')}
RESET ROLE;
${versions.map(v => catalog(v)).join('\n')}
${dbAssert('SELECT NOT admin_issuance_enabled AND NOT legacy_closed AND measured_at IS NULL FROM commonswarm_oauth.admin_cutover_state', 'upgrade must remain dormant')}
${dbAssert(`SELECT grant_class='hosted_mcp' AND resource='https://mcp.commonswarm.com/mcp' AND hosted_grant_id='${hosted}'::uuid AND connection_id='${hosted}'::uuid
  FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id='${provider}'`, 'verified hosted binding backfilled')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT active AND grant_class='hosted_mcp' FROM commonswarm_oauth.resolve_provider_grant_status('${provider}','${owner}','test-kid')`, 'ordinary hosted status retained')}
RESET ROLE;
`);
});

test('admin-schema-isolation: immutable resource/classes, account-scoped approval, owner status and append-only controls', () => {
  const f = fixture();
  runSql(`${f.sql}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, 'matching active family')}
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.foreign}','test-kid')`, 'foreign account hidden')}
${dbAssert(`SELECT active AND grant_class='delegated_admin' FROM commonswarm_oauth.resolve_provider_grant_status('${f.provider}','${f.owner}','test-kid')`, 'explicit bound class')}
${refuses(`UPDATE commonswarm_oauth.provider_grant_resources SET resource='https://mcp.commonswarm.com/mcp' WHERE provider_grant_id='${f.provider}'`, '42501')}
${refuses(`UPDATE commonswarm_oauth.admin_grant_bindings SET scope_names=ARRAY['admin:read','seats:create'] WHERE provider_grant_id='${f.provider}'`, '23514')}
${refuses(`UPDATE commonswarm_oauth.admin_grant_bindings SET refresh_deadline=refresh_deadline+interval '1 hour' WHERE provider_grant_id='${f.provider}'`, '23514')}
${refuses(`SELECT * FROM swarm.admin_grants`, '42501')}
INSERT INTO commonswarm_oauth.provider_artifacts(model,artifact_id_hash,payload,created_at,updated_at)
VALUES('Grant',repeat('G',43),jsonb_build_object('jti','${f.provider}','clientId','${f.client}','accountId','${f.owner}',
  'resources',jsonb_build_object('https://api.commonswarm.com/admin','admin:read')),statement_timestamp(),statement_timestamp());
${refuses(`UPDATE commonswarm_oauth.provider_artifacts SET payload=jsonb_set(payload,'{resources}',
  jsonb_build_object('https://api.commonswarm.com/admin','admin:read','https://mcp.commonswarm.com/mcp','mcp')) WHERE model='Grant' AND artifact_id_hash=repeat('G',43)`, '23514')}
${refuses(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approval_event_id,approval_command_id)
  VALUES('${f.foreign}','${f.client}',1,gen_random_uuid(),'forged')`, '42501')}
RESET ROLE;
${refuses(`UPDATE commonswarm_oauth.provider_grant_resources SET client_id='other' WHERE provider_grant_id='${f.provider}'`, '55000')}
${refuses(`INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
  VALUES('wrong-owner','https://api.commonswarm.com/admin','delegated_admin','${f.foreign}','${f.client}','${f.connection}','${f.grant}')`, '23514')}
${refuses(`INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
  VALUES('wrong-class','https://mcp.commonswarm.com/mcp','delegated_admin','${f.owner}','${f.client}','${f.connection}','${f.grant}')`, '23514')}
SET LOCAL ROLE swarm_command;
${refuses(`INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approval_event_id,approval_command_id)
 SELECT '${f.foreign}',client_id,verification_version,approval_event_id,approval_command_id FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id='${f.owner}'`, '23514')}
${refuses(`UPDATE swarm.admin_events SET command_id='edited' WHERE owner_user_id='${f.owner}'`, '55000')}
RESET ROLE;
SET LOCAL ROLE commonswarm_admin_release;
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.admin_verified_clients WHERE client_id='unseeded-client'`, 'no assumed verification')}
${refuses(`UPDATE commonswarm_oauth.admin_verified_clients SET metadata_digest=repeat('b',64) WHERE client_id='${f.client}'`, '23514')}
${['http://client.example/callback', 'https://localhost/callback', 'https://127.0.0.1/callback', 'https://[::1]/callback', 'https://2130706433/callback', 'app://callback'].map((uri, i) => refuses(`INSERT INTO commonswarm_oauth.admin_verified_clients
  SELECT (jsonb_populate_record(NULL::commonswarm_oauth.admin_verified_clients,to_jsonb(v)||
    jsonb_build_object('client_id','bad-redirect-${i}','redirect_uris',ARRAY['${uri}']))).*
  FROM commonswarm_oauth.admin_verified_clients v WHERE client_id='${f.client}'`, '23514')).join('\n')}
UPDATE commonswarm_oauth.admin_verified_clients SET active=false,withdrawn_at=statement_timestamp(),withdrawal_reason='metadata_changed'
  WHERE client_id='${f.client}';
RESET ROLE;
${dbAssert(`SELECT state='suspended' FROM swarm.admin_grants WHERE grant_id='${f.grant}'`, 'verification withdrawal fences grant')}
${dbAssert(`SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id='${f.provider}')`, 'withdrawal tombstones family')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT NOT active FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, 'withdrawn family refused')}
${refuses(`UPDATE commonswarm_oauth.admin_grant_bindings SET state='active',terminal_at=NULL WHERE provider_grant_id='${f.provider}'`, '23514')}
RESET ROLE;
SET LOCAL ROLE anon;
${refuses(`SELECT * FROM commonswarm_oauth.admin_grant_bindings`, '42501')}
${refuses(`SELECT * FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, '42501')}
RESET ROLE;
${versions.map(v => refuses(repoSql(`supabase/admin-delegation-reserve/${v}-rollback.sql`), '55000')).join('\n')}
`);
});

test('admin-schema-isolation: shared key/jti replay uniqueness, nonce domain, bounded TTL cleanup and least privilege', () => {
  const proof = randomUUID(), key = 'K'.repeat(43), otherKey = 'L'.repeat(43), nonce = '12'.repeat(32);
  runSql(`
SET LOCAL ROLE commonswarm_dpop_verifier;
${dbAssert(`SELECT commonswarm_oauth.register_dpop_nonce(decode('${nonce}','hex'),'${key}','admin_resource')`, 'nonce admission positive')}
${dbAssert(`SELECT commonswarm_oauth.register_dpop_nonce(decode('${nonce}','hex'),'${key}','as')`, 'AS nonce positive')}
${dbAssert(`SELECT commonswarm_oauth.register_dpop_nonce(decode('${nonce}','hex'),'${otherKey}','admin_resource')`, 'other key nonce positive')}
${dbAssert(`SELECT commonswarm_oauth.admit_dpop_proof('${proof}','${key}','admin_mcp',floor(extract(epoch FROM clock_timestamp()))::bigint,decode('${nonce}','hex'))`, 'fresh proof accepted')}
${dbAssert(`SELECT NOT commonswarm_oauth.admit_dpop_proof('${proof}','${key}','admin_command',floor(extract(epoch FROM clock_timestamp()))::bigint,decode('${nonce}','hex'))`, 'command cross-entry replay refused')}
${dbAssert(`SELECT NOT commonswarm_oauth.admit_dpop_proof('${proof}','${key}','as',floor(extract(epoch FROM clock_timestamp()))::bigint,decode('${nonce}','hex'))`, 'AS cross-domain replay refused')}
${dbAssert(`SELECT commonswarm_oauth.admit_dpop_proof('${proof}','${otherKey}','admin_mcp',floor(extract(epoch FROM clock_timestamp()))::bigint,decode('${nonce}','hex'))`, 'jti with distinct key accepted')}
${dbAssert(`SELECT NOT commonswarm_oauth.admit_dpop_proof('old-${proof}','${key}','admin_mcp',floor(extract(epoch FROM clock_timestamp()))::bigint-61,decode('${nonce}','hex'))`, 'stale proof refused')}
${dbAssert(`SELECT NOT commonswarm_oauth.admit_dpop_proof('wrong-nonce-${proof}','${key}','admin_mcp',floor(extract(epoch FROM clock_timestamp()))::bigint,decode(repeat('ab',32),'hex'))`, 'wrong nonce refused')}
${refuses(`INSERT INTO commonswarm_oauth.dpop_proof_replays(jti,jkt,verifier_domain) VALUES('direct','${key}','admin_mcp')`, '42501')}
${refuses(`SELECT * FROM swarm.admin_events`, '42501')}
${refuses(`SELECT commonswarm_oauth.fence_admin_family('none',gen_random_uuid(),'revoked','unauthorized')`, '42501')}
RESET ROLE;
INSERT INTO commonswarm_oauth.dpop_proof_replays(jti,jkt,verifier_domain,accepted_at,expires_at)
VALUES('expired-${proof}','${key}','admin_mcp',statement_timestamp()-interval '6 minutes',statement_timestamp()-interval '1 minute');
INSERT INTO commonswarm_oauth.dpop_nonces(nonce_digest,jkt,verifier_domain,issued_at,expires_at)
VALUES(decode(repeat('34',32),'hex'),'${key}','admin_resource',statement_timestamp()-interval '2 minutes',statement_timestamp()-interval '1 minute');
SET LOCAL ROLE commonswarm_oauth_maintenance;
${refuses('SELECT * FROM commonswarm_oauth.admin_grant_bindings', '42501')}
${refuses('SELECT * FROM commonswarm_oauth.purge_expired_dpop(0)', '22023')}
SELECT * FROM commonswarm_oauth.purge_expired_dpop(10000);
RESET ROLE;
${dbAssert(`SELECT count(*)=2 FROM commonswarm_oauth.dpop_proof_replays WHERE jti='${proof}'`, 'live replays retained')}
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.dpop_proof_replays WHERE jti='expired-${proof}'`, 'expired replay cleaned')}
${dbAssert(`SELECT count(*)=3 FROM commonswarm_oauth.dpop_nonces WHERE nonce_digest=decode('${nonce}','hex')`, 'live nonces retained')}
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.dpop_nonces WHERE nonce_digest=decode(repeat('34',32),'hex')`, 'expired nonce cleaned')}
`);
});

test('admin-schema-isolation: consent interactions and orchestration stay bound to the exact account/client/resource snapshot', () => {
  const f = fixture(), uid = randomUUID(), ownReceipt = randomUUID(), foreignReceipt = randomUUID();
  runSql(`${f.sql}
INSERT INTO swarm.admin_consents(consent_receipt_id,owner_user_id,session_binding,manifest_digest,manifest,full_account_selected,expires_at)
VALUES('${ownReceipt}','${f.owner}',repeat('a',64),'${f.digest}','{}',false,statement_timestamp()+interval '5 minutes'),
  ('${foreignReceipt}','${f.foreign}',repeat('a',64),'${f.digest}','{}',false,statement_timestamp()+interval '5 minutes');
SET LOCAL ROLE commonswarm_oauth_runtime;
INSERT INTO commonswarm_oauth.browser_sessions(session_hash,user_id,expires_at)
VALUES(decode(repeat('aa',32),'hex'),'${f.owner}',statement_timestamp()+interval '10 minutes');
INSERT INTO commonswarm_oauth.interactions(interaction_uid,session_hash,client_id,redirect_uri,resource,requested_scopes,pkce_challenge,user_id,expires_at)
VALUES('${uid}',decode(repeat('aa',32),'hex'),'${f.client}','https://client.example/callback','https://api.commonswarm.com/admin',
  ARRAY['admin:read'],repeat('P',43),'${f.owner}',statement_timestamp()+interval '5 minutes');
INSERT INTO commonswarm_oauth.admin_interactions(interaction_uid,owner_user_id,client_id,resource,redirect_uri,registry_version,
  verification_version,manifest,manifest_digest,availability_digest,requested_scopes,session_binding,csrf_binding,pkce_challenge,jkt,expires_at)
SELECT interaction_uid,user_id,client_id,resource,redirect_uri,2,1,'{}','${f.digest}','${f.digest}',requested_scopes,
  decode(repeat('bb',32),'hex'),decode(repeat('cc',32),'hex'),pkce_challenge,'${f.jkt}',expires_at
FROM commonswarm_oauth.interactions WHERE interaction_uid='${uid}';
INSERT INTO commonswarm_oauth.admin_consent_orchestration(interaction_uid,owner_user_id,step_kind,command_id,receipt_id,completed_at)
VALUES('${uid}','${f.owner}','consent',gen_random_uuid(),'${ownReceipt}',statement_timestamp());
${refuses(`INSERT INTO commonswarm_oauth.admin_consent_orchestration(interaction_uid,owner_user_id,step_kind,command_id)
  VALUES('${uid}','${f.foreign}','continuation',gen_random_uuid())`, '23503')}
${refuses(`INSERT INTO commonswarm_oauth.admin_consent_orchestration(interaction_uid,owner_user_id,step_kind,command_id,receipt_id)
  VALUES('${uid}','${f.owner}','continuation',gen_random_uuid(),'${foreignReceipt}')`, '23514')}
${refuses(`UPDATE commonswarm_oauth.interactions SET resource='https://mcp.commonswarm.com/mcp' WHERE interaction_uid='${uid}'`, '23514')}
${refuses(`UPDATE commonswarm_oauth.admin_interactions SET csrf_binding=decode(repeat('dd',32),'hex') WHERE interaction_uid='${uid}'`, '23514')}
${dbAssert(`SELECT count(*)=1 FROM commonswarm_oauth.admin_consent_orchestration WHERE interaction_uid='${uid}' AND owner_user_id='${f.owner}'`, 'consent positive retained')}
RESET ROLE;
`);
});

test('admin-schema-isolation: human owner approval withdrawal fences its family and preserves approval/audit history', () => {
  const f = fixture(), event = randomUUID();
  runSql(`${f.sql}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT active FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, 'approved family positive')}
RESET ROLE;
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
VALUES('${f.owner}',2,'${event}','withdraw-command',jsonb_build_object('stream_kind','account','owner_user_id','${f.owner}',
  'seq',2,'type','AdminClientApprovalWithdrawn','actor_user','${f.owner}','payload',jsonb_build_object('client_id','${f.client}','verification_version',1)));
UPDATE commonswarm_oauth.admin_client_owner_approvals SET withdrawn_at=statement_timestamp(),withdrawal_event_id='${event}',withdrawal_reason='owner_withdrawn'
  WHERE owner_user_id='${f.owner}' AND client_id='${f.client}' AND verification_version=1;
${refuses(`UPDATE commonswarm_oauth.admin_client_owner_approvals SET withdrawn_at=NULL,withdrawal_event_id=NULL,withdrawal_reason=NULL
  WHERE owner_user_id='${f.owner}' AND client_id='${f.client}'`, '23514')}
RESET ROLE;
${dbAssert(`SELECT state='revoked' FROM swarm.admin_grants WHERE grant_id='${f.grant}'`, 'owner withdrawal terminally fences grant')}
${dbAssert(`SELECT count(*)=1 FROM commonswarm_oauth.admin_client_owner_approvals WHERE owner_user_id='${f.owner}' AND withdrawn_at IS NOT NULL`, 'approval history retained')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${dbAssert(`SELECT NOT active FROM commonswarm_oauth.resolve_admin_grant_status('${f.provider}','${f.owner}','test-kid')`, 'withdrawn approval refuses status')}
RESET ROLE;
`);
});

test('admin-schema-isolation: committed issuance required, exact token binding, old live generation, key denial and audited atomic revocation', () => {
  const f = fixture(), token = issuance(f);
  runSql(`${f.sql}${openIssuanceForTest}${token.sql}
SET LOCAL ROLE swarm_read;
${dbAssert(token.active(), 'committed access positive')}
${dbAssert(`NOT (${token.active({ jti: 'unrecorded' })})`, 'signed but unrecorded refused')}
${dbAssert(`NOT (${token.active({ digest: '43'.repeat(32) })})`, 'wrong digest refused')}
${dbAssert(`NOT (${token.active({ owner: f.foreign })})`, 'foreign owner access refused')}
RESET ROLE;
SET LOCAL ROLE commonswarm_oauth_runtime;
UPDATE commonswarm_oauth.admin_grant_bindings SET generation=generation+1 WHERE provider_grant_id='${f.provider}';
${dbAssert(token.active(), 'prior live token survives refresh generation')}
RESET ROLE;
${refuses(`UPDATE commonswarm_oauth.admin_access_issuances SET access_jti='changed' WHERE access_jti='${token.jti}'`, '55000')}
${refuses(`DELETE FROM commonswarm_oauth.admin_oauth_audit WHERE audit_id='${token.audit}'`, '55000')}
-- An audit storage failure must roll back the family/grant fence as well.
CREATE FUNCTION pg_temp.refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $fail$ BEGIN RAISE EXCEPTION 'injected audit failure' USING ERRCODE='ZX002'; END $fail$;
CREATE TRIGGER schema_test_audit_failure BEFORE INSERT ON commonswarm_oauth.admin_oauth_audit FOR EACH ROW EXECUTE FUNCTION pg_temp.refuse_audit();
SET LOCAL ROLE swarm_command;
${refuses(`SELECT commonswarm_oauth.fence_admin_family('${f.provider}','${f.owner}','revoked','test_revoke')`, 'ZX002')}
RESET ROLE;
DROP TRIGGER schema_test_audit_failure ON commonswarm_oauth.admin_oauth_audit;
${dbAssert(token.active(), 'failed revoke leaves active control intact')}
${dbAssert(`SELECT NOT EXISTS(SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones WHERE grant_id='${f.provider}')`, 'failed revoke has no tombstone')}
SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_oauth.issuer_key_denials(issuer,kid,reason,evidence_ref)
VALUES('https://mcp.commonswarm.com','test-kid','incident','reviewed-key-withdrawal');
RESET ROLE;
SET LOCAL ROLE swarm_read;
${dbAssert(`NOT (${token.active()})`, 'cached denied key cannot authorize')}
SELECT set_config('request.jwt.claims','{"sub":"${f.owner}"}',true);
${dbAssert(`SELECT jsonb_array_length(swarm_read.admin_oauth_recovery_page(50)->'grants')=1`, 'owner recovery retains grant')}
SELECT set_config('request.jwt.claims','{"sub":"${f.foreign}"}',true);
${dbAssert(`SELECT jsonb_array_length(swarm_read.admin_oauth_recovery_page(50)->'grants')=0`, 'foreign recovery isolated')}
RESET ROLE;
${dbAssert(`SELECT state='revoked' FROM swarm.admin_grants WHERE grant_id='${f.grant}'`, 'key denial terminally revokes grant')}
${dbAssert(`SELECT EXISTS(SELECT 1 FROM commonswarm_oauth.admin_oauth_audit WHERE provider_grant_id='${f.provider}' AND event_kind='revoked')`, 'terminal audit committed')}
`);
});

test('admin-schema-isolation: catalog negative control catches ACL drift alongside intact positive proofs', () => {
  runSql(`${versions.map(v => catalog(v)).join('\n')}
GRANT SELECT ON commonswarm_oauth.admin_access_issuances TO authenticated;
${catalog(versions[2], false, false)}
REVOKE SELECT ON commonswarm_oauth.admin_access_issuances FROM authenticated;
${catalog(versions[2])}
`);
});
