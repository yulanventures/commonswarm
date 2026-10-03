/** Real adapter write shapes against backfilled M1 bindings; Docker/CI only. */
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, fixture, migrationNames, refuses, repoSql, runSql, versions } from '../support/admin-schema-db.js';

const MCP = 'https://mcp.commonswarm.com/mcp', ADMIN = 'https://api.commonswarm.com/admin';
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

test('mcp-artifacts-unchanged-after-m1: native artifacts insert/upsert/consume/rotate/destroy/revoke after hosted backfill', () => {
  const owner = randomUUID(), workspace = randomUUID(), hosted = randomUUID(), family = randomUUID();
  const client = 'ordinary-client';
  // Native fields from oidc-provider 9.12.2 models and postgres-adapter.js.
  // AccessToken JWTs normally bypass storage; include its supported adapter shape too.
  const artifacts: Array<{ model: string; id: string; payload: Record<string, unknown>; family: string | null }> = [
    { model: 'AccessToken', id: randomUUID(), family, payload: { kind: 'AccessToken', grantId: family, clientId: client, accountId: owner, scope: 'mcp', gty: 'authorization_code' } },
    { model: 'RefreshToken', id: randomUUID(), family, payload: { kind: 'RefreshToken', grantId: family, scope: 'openid offline_access mcp', rotations: 0, iiat: 1_800_000_000 } },
    { model: 'AuthorizationCode', id: randomUUID(), family, payload: { kind: 'AuthorizationCode', grantId: family, accountId: owner, scope: 'openid offline_access mcp', codeChallenge: 'P'.repeat(43), codeChallengeMethod: 'S256', redirectUri: 'https://client.example/callback' } },
    { model: 'Grant', id: family, family: null, payload: { kind: 'Grant', jti: family, clientId: client, accountId: owner, openid: { scope: 'openid offline_access' }, resources: { [MCP]: 'mcp' } } },
    { model: 'Session', id: randomUUID(), family: null, payload: { kind: 'Session', uid: randomUUID(), accountId: owner, authorizations: { [client]: { grantId: family, sid: randomUUID() } } } },
    { model: 'Interaction', id: randomUUID(), family: null, payload: { kind: 'Interaction', grantId: family, session: { accountId: owner, uid: randomUUID() }, params: { client_id: client, resource: MCP, scope: 'openid offline_access mcp' }, prompt: { name: 'consent' }, returnTo: '/authorize' } },
  ];
  for (const a of artifacts) {
    if (!['AccessToken', 'RefreshToken', 'AuthorizationCode'].includes(a.model)) a.payload.jti ??= a.id;
  }
  const hash = (id: string) => createHash('sha256').update(id).digest('base64url');
  const insert = (a: typeof artifacts[number], payload = a.payload, id = a.id) => `
INSERT INTO commonswarm_oauth.provider_artifacts AS existing(model,artifact_id_hash,payload,grant_id,expires_at,created_at,updated_at)
VALUES('${a.model}','${hash(id)}',${literal(JSON.stringify(payload))}::jsonb,${a.family ? literal(a.family) : 'NULL'},
  statement_timestamp()+interval '1 day',statement_timestamp(),statement_timestamp())
ON CONFLICT(model,artifact_id_hash) DO UPDATE SET payload=EXCLUDED.payload,grant_id=EXCLUDED.grant_id,
  expires_at=EXCLUDED.expires_at,consumed_at=existing.consumed_at,updated_at=statement_timestamp();`;
  const admin = fixture();
  runSql(`
${[...versions].reverse().map(v => repoSql(`supabase/admin-delegation-reserve/${v}-rollback.sql`)).join('\n')}
INSERT INTO auth.users(id,aud,role,email) VALUES('${owner}','authenticated','authenticated','${owner}@example.test');
INSERT INTO swarm.users(user_id,display_name) VALUES('${owner}','Hosted owner');
INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES('${workspace}','MCP backfill control','${owner}');
INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
  selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
VALUES('${hosted}','${family}','${owner}','${workspace}','${client}','${MCP}',ARRAY['${workspace}']::uuid[],
  decode(repeat('ab',32),'hex'),'mcp-interaction','active',statement_timestamp(),statement_timestamp());
SET LOCAL ROLE commonswarm_oauth_runtime;
${artifacts.map(a => insert(a)).join('\n')}
RESET ROLE;
${migrationNames.map(name => repoSql(`supabase/migrations/${name}`)).join('\n')}
${dbAssert(`SELECT grant_class='hosted_mcp' FROM commonswarm_oauth.provider_grant_resources WHERE provider_grant_id='${family}'`, 'MCP binding really backfilled')}
SET LOCAL ROLE commonswarm_oauth_runtime;
${artifacts.flatMap(a => [undefined, MCP, [MCP]].map(resource => insert(a, { ...a.payload, resource, aud: resource }))).join('\n')}
-- Grant.clean() can remove the resources map; optional principals are not a new authority source.
${insert(artifacts[3]!, { kind: 'Grant', jti: family, openid: { scope: 'openid offline_access' } })}
${artifacts.map(a => insert(a, a.payload, a.model === 'Grant' ? a.id : `new-${a.id}`)).join('\n')}
${dbAssert(`SELECT count(*)=11 FROM commonswarm_oauth.provider_artifacts`, 'every model inserted and upserted')}
UPDATE commonswarm_oauth.provider_artifacts SET expires_at=expires_at+interval '1 minute',updated_at=statement_timestamp();
-- The adapter consume CAS updates bookkeeping only; payload remains untouched.
${artifacts.map(a => {
    const model = a.model;
    return `UPDATE commonswarm_oauth.provider_artifacts SET consumed_at=statement_timestamp(),updated_at=statement_timestamp()
      WHERE model='${model}' AND artifact_id_hash='${hash(a.id)}' AND consumed_at IS NULL;
      ${dbAssert(`SELECT consumed_at IS NOT NULL FROM commonswarm_oauth.provider_artifacts WHERE model='${model}' AND artifact_id_hash='${hash(a.id)}'`, `${model} consumed after backfill`)}`;
  }).join('\n')}
${insert(artifacts[1]!, { ...artifacts[1]!.payload, resource: [MCP], rotations: 1 }, 'rotated-refresh')}
${dbAssert(`SELECT consumed_at IS NULL AND payload->>'rotations'='1' FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash='${hash('rotated-refresh')}'`, 'refresh rotation persisted')}
${artifacts.map(a => `DELETE FROM commonswarm_oauth.provider_artifacts WHERE model='${a.model}' AND artifact_id_hash='${hash(a.id)}';`).join('\n')}
${dbAssert(`SELECT count(*)=6 FROM commonswarm_oauth.provider_artifacts`, 'destroy works for every model')}
-- revokeByGrantId: same lock, durable tombstone and grant-bound artifact deletion.
SELECT pg_advisory_xact_lock(hashtextextended('${family}',484650));
INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES('${family}',statement_timestamp()) ON CONFLICT DO NOTHING;
DELETE FROM commonswarm_oauth.provider_artifacts WHERE grant_id='${family}';
${dbAssert(`SELECT count(*)=0 FROM commonswarm_oauth.provider_artifacts WHERE grant_id='${family}'`, 'revoked family artifacts removed')}
${dbAssert(`SELECT count(*)=2 FROM commonswarm_oauth.provider_artifacts`, 'unrelated session/interaction retained')}
${artifacts.filter(a => a.family === null && a.model !== 'Grant').map(a => insert(a, a.payload, `new-${a.id}`)).join('\n')}
RESET ROLE;
${admin.sql}
SET LOCAL ROLE commonswarm_oauth_runtime;
${insert({ model: 'Grant', id: admin.provider, family: null, payload: { jti: admin.provider, clientId: admin.client, accountId: admin.owner, resources: { [ADMIN]: 'admin:read' } } })}
${[ADMIN, [MCP, ADMIN]].map(resource => refuses(insert(artifacts[1]!, { ...artifacts[1]!.payload, resource }, randomUUID()), '23514')).join('\n')}
${refuses(insert(artifacts[3]!, { ...artifacts[3]!.payload, resources: { [MCP]: 'mcp', [ADMIN]: 'admin:read' } }), '23514')}
${refuses(insert({ model: 'RefreshToken', id: randomUUID(), family: admin.provider, payload: { grantId: admin.provider, clientId: client, accountId: owner, resource: ADMIN } }), '23514')}
${refuses(`UPDATE commonswarm_oauth.provider_artifacts SET payload=jsonb_set(payload,'{jti}',to_jsonb('${family}'::text)) WHERE model='Grant' AND artifact_id_hash='${hash(admin.provider)}'`, '23514')}
RESET ROLE;
`);
});
