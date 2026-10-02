/** Isolated local PostgreSQL boundary. No service credentials or browser use. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const versions = ['20261003000001', '20261003000002', '20261003000003'] as const;
export const migrationNames = [
  '20261003000001_admin_oauth_bindings.sql',
  '20261003000002_admin_oauth_policy.sql',
  '20261003000003_admin_oauth_cutover.sql',
] as const;
export function repoSql(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
}
export function databaseContainer(): string {
  const names = execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' })
    .trim().split('\n').filter(name => /^supabase_db_/.test(name));
  assert.equal(names.length, 1, 'exclusive local Supabase database required');
  return names[0]!;
}
export function runSql(sql: string): void {
  const result = spawnSync('docker', ['exec', '-i', databaseContainer(), 'psql', '-X', '-Atq',
    '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'], {
    input: `BEGIN;\n${sql}\nROLLBACK;\n`, encoding: 'utf8', timeout: 60_000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
}
export function dbAssert(expression: string, label: string): string {
  return `DO $assert$ BEGIN IF NOT coalesce((${expression}),false) THEN RAISE EXCEPTION '${label}'; END IF; END $assert$;`;
}
export function refuses(statement: string, sqlstate: string): string {
  assert.match(sqlstate, /^[A-Z0-9]{5}$/);
  return `DO $deny$ BEGIN BEGIN ${statement}; RAISE EXCEPTION 'negative control admitted' USING ERRCODE='ZX001';
    EXCEPTION WHEN SQLSTATE '${sqlstate}' THEN NULL; END; END $deny$;`;
}
export function catalog(version: string, rollback = false, expect = true): string {
  const alias = rollback ? 'rollback_ok' : 'catalog_ok';
  // Execute exactly the release proof, including its psql gset contract.
  return repoSql(`deploy/release-proofs/item-ai/${version}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`)
    + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass\n\\gset\n\\if :proof_pass\n\\else\n`
    + `DO $fail$ BEGIN RAISE EXCEPTION 'catalog ${version} mismatch'; END $fail$;\n\\endif\n`;
}

export function fixture(version = 2) {
  const owner = randomUUID(), foreign = randomUUID(), grant = randomUUID(), identity = randomUUID(), connection = randomUUID();
  const client = `https://client.example/${randomUUID()}`, provider = `family-${randomUUID()}`, event = randomUUID();
  const digest = 'a'.repeat(64), jkt = 'K'.repeat(43);
  const sql = `
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test'),
  ('${foreign}','authenticated','authenticated','${foreign}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Schema owner'),('${foreign}','Foreign owner');
INSERT INTO swarm.admin_accounts(owner_user_id,stream_id) VALUES('${owner}','${randomUUID()}'),('${foreign}','${randomUUID()}');
INSERT INTO swarm.admin_grants(grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
  workspace_ids,created_workspace_policy,target_rules,worker_scope_ceiling,role_ceiling,renewal_limits,issuance_limits,
  expires_at,refresh_deadline,state,consent_receipt_id,manifest_digest,created_at)
VALUES('${grant}','${owner}','${identity}','${connection}','${client}','https://api.commonswarm.com/admin',${version},
  '{}','{"scope_names":[]}','{}','{}','member','{}','{}',date_trunc('second',statement_timestamp())+interval '1 day',
  date_trunc('second',statement_timestamp())+interval '1 day','active','${randomUUID()}','${digest}',date_trunc('second',statement_timestamp()));
SET LOCAL ROLE commonswarm_admin_release;
INSERT INTO commonswarm_oauth.admin_verified_clients(client_id,verification_version,application_type,registration_source,
  publisher_identity,publisher_contact,metadata_digest,redirect_uris,scope_ceiling,pkce_s256_tested,dpop_tested,redirect_tested,
  origin_control_verified,review_evidence_ref,reviewed_by,active)
VALUES('${client}',1,'web','static','Test publisher','contact@example.test','${digest}',ARRAY['https://client.example/callback'],
  ARRAY['admin:read'],true,true,true,true,'test-reviewed-evidence','schema-test',true);
RESET ROLE;
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
VALUES('${owner}',1,'${event}','approval-command',jsonb_build_object('stream_kind','account','owner_user_id','${owner}',
  'seq',1,'type','AdminClientApproved','actor_user','${owner}','payload',jsonb_build_object('client_id','${client}','verification_version',1)));
INSERT INTO commonswarm_oauth.admin_client_owner_approvals(owner_user_id,client_id,verification_version,approval_event_id,approval_command_id)
VALUES('${owner}','${client}',1,'${event}','approval-command');
RESET ROLE;
${version >= 2 ? `SET LOCAL ROLE commonswarm_oauth_runtime;
INSERT INTO commonswarm_oauth.provider_grant_resources(provider_grant_id,resource,grant_class,owner_user_id,client_id,connection_id,admin_grant_id)
VALUES('${provider}','https://api.commonswarm.com/admin','delegated_admin','${owner}','${client}','${connection}','${grant}');
RESET ROLE;
INSERT INTO commonswarm_oauth.admin_grant_bindings(provider_grant_id,admin_grant_id,owner_user_id,admin_identity_id,connection_id,
  client_id,resource,registry_version,capabilities,scope_names,availability_digest,manifest_digest,verification_version,jkt,
  consented_at,expires_at,refresh_deadline,initial_issued_at,state)
SELECT '${provider}',grant_id,owner_user_id,admin_identity_id,connection_id,client_id,resource,registry_version,
  ARRAY['list_admin_grants'],scope_names,'${digest}',manifest_digest,1,'${jkt}',created_at,expires_at,refresh_deadline,created_at,'active'
FROM swarm.admin_grants WHERE grant_id='${grant}';` : ''}
`;
  return { owner, foreign, grant, identity, connection, client, provider, digest, jkt, sql };
}

export function issuance(f: ReturnType<typeof fixture>, generation = 0) {
  const jti = `access-${randomUUID()}`, event = randomUUID(), audit = randomUUID();
  const tokenDigest = '42'.repeat(32);
  const eventInsert = `INSERT INTO swarm.admin_events(owner_user_id,seq,event_id,command_id,event)
VALUES('${f.owner}',${generation + 2},'${event}','issue-${generation}',jsonb_build_object('stream_kind','account','owner_user_id','${f.owner}',
  'seq',${generation + 2},'type','${generation === 0 ? 'AdminCredentialIssued' : 'AdminCredentialRotated'}','grant_id','${f.grant}',
  'payload',jsonb_build_object('provider_grant_id','${f.provider}','generation',${generation},'version',2)));
`;
  const auditInsert = `INSERT INTO commonswarm_oauth.admin_oauth_audit(audit_id,owner_user_id,admin_identity_id,admin_grant_id,connection_id,
  provider_grant_id,manifest_digest,event_kind,outcome,related_event_ids)
VALUES('${audit}','${f.owner}','${f.identity}','${f.grant}','${f.connection}','${f.provider}','${f.digest}',
  '${generation === 0 ? 'issued' : 'rotated'}','committed',ARRAY['${event}']::uuid[]);
`;
  const accessInsert = `INSERT INTO commonswarm_oauth.admin_access_issuances(access_jti,access_token_digest,provider_grant_id,admin_grant_id,generation,
  client_id,resource,jkt,manifest_digest,scope_names,issuer,kid,issued_at,expires_at,event_id,audit_id)
SELECT '${jti}',decode('${tokenDigest}','hex'),provider_grant_id,admin_grant_id,${generation},client_id,resource,jkt,manifest_digest,
  scope_names,'https://mcp.commonswarm.com','test-kid',date_trunc('second',statement_timestamp()),
  date_trunc('second',statement_timestamp())+interval '5 minutes','${event}','${audit}'
FROM commonswarm_oauth.admin_grant_bindings WHERE provider_grant_id='${f.provider}';
`;
  const sql = `SET LOCAL ROLE swarm_command;\n${eventInsert}\nRESET ROLE;\nSET LOCAL ROLE commonswarm_oauth_runtime;\n${auditInsert}\n${accessInsert}\nRESET ROLE;\n`;
  const active = (overrides: { jti?: string; owner?: string; digest?: string } = {}) =>
    `SELECT commonswarm_oauth.admin_access_is_active('${overrides.jti ?? jti}',decode('${overrides.digest ?? tokenDigest}','hex'),
    '${f.provider}','${f.grant}','${overrides.owner ?? f.owner}',${generation},'${f.client}','https://api.commonswarm.com/admin',
    '${f.jkt}','${f.digest}',i.issued_at,i.expires_at,'test-kid') FROM commonswarm_oauth.admin_access_issuances i WHERE i.access_jti='${jti}'`;
  return { jti, event, audit, sql, eventInsert, auditInsert, accessInsert, active };
}

/** Test-only transaction, rolled back by runSql. Uses the real fence and release constraints. */
export const openIssuanceForTest = `
SET LOCAL ROLE commonswarm_admin_release;
SELECT commonswarm_oauth.apply_legacy_admin_fence('test-only-cutover');
UPDATE commonswarm_oauth.admin_cutover_state SET approved_edge_release_sha=repeat('a',40),auth_contract_version=2,
  required_migrations=jsonb_build_object('20261003000001',repeat('a',64),'20261003000002',repeat('b',64),'20261003000003',repeat('c',64)),
  lane8_evidence_digest=repeat('d',64),measured_edge_release_sha=repeat('a',40),
  measured_edge_target='/home/commonswarm/edge/releases/'||repeat('a',40),
  measured_mount='/home/commonswarm/edge/releases/'||repeat('a',40),measured_artifact_digest=repeat('e',64),
  measured_image_digest='sha256:'||repeat('f',64),measured_generation=release_generation,
  measured_at=statement_timestamp(),measurement_evidence_ref='test-only-measurement',invalidated_at=NULL;
UPDATE commonswarm_oauth.admin_cutover_state SET admin_issuance_enabled=true;
RESET ROLE;
`;
