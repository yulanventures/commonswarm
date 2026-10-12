// Acceptance: real migrated PostgreSQL, independent runtime connections and
// disposable auth sessions produce one durable resume; restart, binding changes,
// revocation and expiry cannot create another. Missing CI prerequisites fail.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { FinishStore } from '../src/finish-store.js';
import { hashOpaque } from '../src/browser-security.js';

const issuer = 'https://mcp.commonswarm.com';
const safe = { status: 303, location: `${issuer}/authorize/DUMMYRESUME`, cookies: ['resume=DUMMYCOOKIE; Secure; HttpOnly'] };
const denied = { code: 'interaction_expired' };

test('only code-free AS resume responses and complete cookies can be retained', () => {
  const store = new FinishStore(null, { issuer, verifySession: async () => false });
  assert.deepEqual(store.validateResponse(safe), safe);
  for (const location of [
    `${issuer}/authorize/DUMMYRESUME?code=DUMMYCODE`, `${issuer}/authorize/DUMMYRESUME#access_token=DUMMYTOKEN`,
    `${issuer}/auth/DUMMYRESUME`,
    'https://client.example/callback', '//client.example/auth/DUMMYRESUME',
  ]) assert.throws(() => store.validateResponse({ ...safe, location }), denied);
  assert.throws(() => store.validateResponse({ ...safe, cookies: ['DUMMY\r\nInjected: value'] }), denied);
  assert.throws(() => new FinishStore(null, { issuer }), TypeError);
});

test('malformed resume URLs expose only the safe restart error', () => {
  const store = new FinishStore(null, { issuer, verifySession: async () => false });
  assert.throws(() => store.validateResponse({ ...safe, location: 'https://[DUMMYCODE' }), error => {
    assert.equal(error.code, denied.code);
    assert.equal(error.input, undefined);
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(store.validateResponse(safe), safe);
});

test('CI: concurrent finish, restart, crash fence, immutable binding, expiry and revoked auth session', {
  skip: process.env.CI !== 'true' && !process.env.MCP_OAUTH_TEST_DATABASE_URL ? 'CI only: migrated PostgreSQL required' : false,
}, async () => {
  const { Pool } = await import('pg');
  const target = new URL(process.env.MCP_OAUTH_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres');
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(target.hostname), "isolated local CI database required");
  // The migration principal's runtime membership is ADMIN-only, without SET.
  // The local cluster administrator can start a connection as the actual runtime.
  target.username = "supabase_admin";
  const connectionString = target.href;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  const runtimeOptions = { connectionString, options: '-c role=commonswarm_oauth_runtime', max: 2, connectionTimeoutMillis: 2000 };
  const first = new Pool(runtimeOptions);
  let second = new Pool(runtimeOptions);
  const userId = randomUUID(), authId = randomUUID(), grantId = randomUUID();
  const sessionId = `DUMMYSESSION-${randomUUID()}`, sessionHash = hashOpaque(sessionId);
  const uids = [randomUUID(), randomUUID()];
  const request = { clientId: 'https://client.example/oauth.json', redirectUri: 'https://client.example/callback',
    resource: `${issuer}/mcp`, scopes: ['openid', 'mcp'], pkceChallenge: 'a'.repeat(43), oauthState: 'DUMMYSTATE' };
  const binding = { interactionUid: uids[0], sessionId, userId, request };
  const input = { displayModel: { client: 'TEST client', workspace: 'TEST workspace' }, providerResult: { consent: { grantId: 'DUMMYGRANT' } } };
  // Fixture models the auth.sessions deletion boundary; P1/P9c own real GoTrue
  // global-logout HTTP proof. Production wires P1's restricted live checker.
  const verifySession = async browser => (await admin.query(
    'SELECT 1 FROM auth.sessions WHERE id=$1 AND user_id=$2', [authId, browser.user_id])).rowCount === 1;
  const make = pool => new FinishStore(pool, { issuer, verifySession });
  let calls = 0;
  try {
    assert.equal((await first.query("SELECT current_user AS role")).rows[0].role, "commonswarm_oauth_runtime");
    assert.ok((await admin.query("SELECT to_regclass('commonswarm_oauth.finish_records') AS name")).rows[0].name,
      'CI must apply the reserved finish migration');
    await admin.query("INSERT INTO auth.users(id,aud,role,email) VALUES($1,'authenticated','authenticated',$2)", [userId, `${userId}@example.test`]);
    await admin.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [authId, userId]);
    await admin.query(`INSERT INTO commonswarm_oauth.browser_sessions(session_hash,user_id,authenticated_at,expires_at)
      VALUES($1,$2,statement_timestamp(),statement_timestamp()+interval '1 hour')`, [sessionHash, userId]);
    for (const uid of uids) await admin.query(`INSERT INTO commonswarm_oauth.interactions
      (interaction_uid,session_hash,user_id,client_id,redirect_uri,resource,requested_scopes,pkce_challenge,
       oauth_state,provider_grant_id,commonswarm_grant_id,consent_token_consumed_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'DUMMYGRANT',$10,statement_timestamp(),statement_timestamp()+interval '10 minutes')`,
    [uid, sessionHash, userId, request.clientId, request.redirectUri, request.resource, request.scopes, request.pkceChallenge, request.oauthState, grantId]);
    const prepared = await make(first).prepareFinish(binding, input);
    assert.ok(prepared.expires_at.getTime() - prepared.created_at.getTime() <= 120000);
    await assert.rejects(first.query(`INSERT INTO commonswarm_oauth.finish_records
      (interaction_uid,session_hash,user_id,provider_grant_id,commonswarm_grant_id,
       validated_request,display_model,provider_result,expires_at,state,resume_response)
      SELECT $1,session_hash,user_id,provider_grant_id,commonswarm_grant_id,
        validated_request,display_model,provider_result,expires_at,'resume_ready',$2::jsonb
      FROM commonswarm_oauth.finish_records WHERE interaction_uid=$3`,
    [uids[1], JSON.stringify(safe), uids[0]]), { code: '42501' });
    const repeated = await make(second).prepareFinish(binding, { ...input, displayModel: { client: 'CHANGED' } });
    assert.equal(repeated.expires_at.getTime(), prepared.expires_at.getTime());
    assert.deepEqual(repeated.display_model, input.displayModel);
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const pending = make(first).ensureResume(binding, async () => { calls++; entered(); await held; return safe; });
    await started;
    const concurrent = make(second).ensureResume(binding, async () => { calls++; return safe; });
    release();
    assert.deepEqual(await Promise.all([pending, concurrent]), [safe, safe]);
    await second.end(); second = new Pool(runtimeOptions); // New connections read the durable result.
    assert.deepEqual(await make(second).ensureResume(binding, () => { throw Error('must not recreate'); }), safe);
    assert.equal(calls, 1);
    await admin.query('UPDATE commonswarm_oauth.interactions SET completed_at=statement_timestamp() WHERE interaction_uid=$1', [uids[0]]);
    assert.deepEqual(await make(second).ensureResume(binding, () => assert.fail('completed replay recreated')), safe);
    for (const changed of [{ sessionId: 'DUMMYOTHERBROWSER' }, { userId: randomUUID() }, { request: { ...request, oauthState: 'SWAPPED' } }]) {
      await assert.rejects(make(first).ensureResume({ ...binding, ...changed }, () => assert.fail('binding escaped')), denied);
    }
    const crashBinding = { ...binding, interactionUid: uids[1] };
    await make(first).prepareFinish(crashBinding, input);
    await assert.rejects(make(first).ensureResume(crashBinding, () => { throw Error('synthetic process failure'); }));
    await assert.rejects(make(second).ensureResume(crashBinding, () => assert.fail('ambiguous retry recreated')), denied);
    assert.deepEqual(await make(first).ensureResume(binding, () => assert.fail('positive control recreated')), safe);
    await admin.query('UPDATE commonswarm_oauth.browser_sessions SET user_id=$1 WHERE session_hash=$2', [randomUUID(), sessionHash]);
    await assert.rejects(make(first).getFinish(binding), denied);
    await admin.query('UPDATE commonswarm_oauth.browser_sessions SET user_id=$1 WHERE session_hash=$2', [userId, sessionHash]);
    await admin.query('DELETE FROM auth.sessions WHERE id=$1', [authId]);
    await assert.rejects(make(first).ensureResume(binding, () => assert.fail('revoked auth resumed')), denied);
    await admin.query('INSERT INTO auth.sessions(id,user_id) VALUES($1,$2)', [authId, userId]);
    assert.deepEqual(await make(first).ensureResume(binding, () => assert.fail('positive control recreated')), safe);
    await admin.query(`UPDATE commonswarm_oauth.finish_records SET created_at=statement_timestamp()-interval '3 minutes',
      expires_at=statement_timestamp()-interval '1 minute' WHERE interaction_uid=$1`, [uids[0]]);
    await assert.rejects(make(first).ensureResume(binding, () => assert.fail('expired resume recreated')), denied);
    await assert.rejects(first.query('UPDATE commonswarm_oauth.finish_records SET validated_request=$1 WHERE interaction_uid=$2',
      [JSON.stringify({}), uids[1]]), { code: '42501' });
  } finally {
    await first.end(); await second.end();
    try {
      await admin.query('DELETE FROM commonswarm_oauth.interactions WHERE interaction_uid=ANY($1::text[])', [uids]);
      await admin.query('DELETE FROM commonswarm_oauth.browser_sessions WHERE session_hash=$1', [sessionHash]);
      await admin.query('DELETE FROM auth.users WHERE id=$1', [userId]);
    } finally { await admin.end(); }
  }
});
