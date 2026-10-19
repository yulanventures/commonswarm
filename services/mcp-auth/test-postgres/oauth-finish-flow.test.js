// P9c merge gate: real pinned provider/PostgreSQL and synthetic loopback client.
// Inputs are disposable CI identities; outputs are status-only acceptance proof.
// A lost response cannot mint another code; real logout fences pending/reused login.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { AUTH_PROVIDER_CATALOG } from '../src/auth-provider-catalog.js';

test('CI only: first connect, durable finish replay, one redemption, reuse, logout and flag-off', {
  skip: process.env.CI === 'true' ? false : 'CI only: requires PostgreSQL, Docker and Deno', timeout: 240000,
}, async t => {
  assert.equal(process.platform, 'linux', 'CI requires Linux host networking; missing prerequisites must fail');
  const { finishFlowFixture } = await import('./finish-flow-fixture.js');
  const h = await finishFlowFixture(t), verifier = 'DUMMYVERIFIER-for-PKCE-0123456789abcdef0123456789';
  const state = 'DUMMYSTATE', callbackResponses = new Set(), issuedCodes = [];
  const completed = t.mock.method(h.provider, 'interactionFinished');
  const pendingSnapshots = [];
  const originalSave = h.provider.Grant.prototype.save;
  t.mock.method(h.provider.Grant.prototype, 'save', async function (...args) {
    const id = await originalSave.apply(this,args);
    const row = (await h.pool.query("SELECT expires_at,payload FROM commonswarm_oauth.provider_artifacts WHERE model='Grant' AND payload->>'jti'=$1",[id])).rows[0];
    pendingSnapshots.push(row);
    return id;
  });
  const view = async target => {
    for (let i = 0; i < 10; i++) { const res = await h.request(target);
      if (res.status === 200) return res;
      assert.ok([302, 303].includes(res.status), `AS navigation status=${res.status}`);
      target = res.headers.get('location'); assert.equal(new URL(target, h.issuer).origin === h.issuer, true);
    } assert.fail('AS navigation did not reach a page');
  };
  const authorize = () => view(`/authorize?${new URLSearchParams({ client_id: h.clientId, redirect_uri: h.callback,
    response_type: 'code', scope: 'openid mcp', prompt: 'consent', state, resource: h.resource,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })}`);
  const assertChooser = page => {
    for (const { id, name } of AUTH_PROVIDER_CATALOG) {
      assert.ok(page.body.includes(`/sign-in?provider=${id}`));
      assert.ok(page.body.includes(`Continue with ${name}`));
    }
  };
  const consent = async page => {
    assert.equal(page.body.includes('Continue as'), true); assert.doesNotMatch(page.body, /\/sign-in\?provider=/u);
    const field = name => new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'u').exec(page.body)?.[1];
    const csrf = field('csrf_token'), version = field('selection_version'); assert.ok(csrf && version !== undefined);
    return h.request(`${page.path}/consent`, { method: 'POST', headers: { origin: h.issuer,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf_token: csrf,
        selection_version: version, workspace_ids: h.workspace, home_workspace_id: h.workspace }).toString() });
  };
  const countCodes = async () => (await h.pool.query("SELECT count(*)::int AS n FROM commonswarm_oauth.provider_artifacts WHERE model='AuthorizationCode'")).rows[0].n;
  const live = async () => (await h.pool.query("SELECT count(*)::int AS n FROM commonswarm_oauth.browser_sessions WHERE user_id IS NOT NULL AND invalidated_at IS NULL")).rows[0].n;
  const redeem = code => h.request('/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: h.clientId, code, code_verifier: verifier, redirect_uri: h.callback,
      resource: h.resource, grant_type: 'authorization_code' }).toString() });
  const receive = async resume => {
    const res = await h.request(resume); assert.equal(res.status, 303);
    const location = new URL(res.headers.get('location')); assert.equal(location.origin + location.pathname === h.callback, true);
    assert.equal(location.searchParams.get('state') === state, true); assert.equal(location.searchParams.get('iss') === h.issuer, true);
    assert.deepEqual([...location.searchParams.keys()].sort(), ['code', 'iss', 'state']);
    callbackResponses.add(res); // Only this validated protocol Location may carry code/state/callback.
    const code = location.searchParams.get('code'); assert.equal(typeof code === 'string' && code.length > 0, true); issuedCodes.push(code);
    assert.equal(await countCodes(), 1, 'provider persisted one code before client receipt');
    assert.equal((await fetch(location, { redirect: 'manual' })).status, 200); assert.equal(h.received.length, issuedCodes.length);
    assert.equal(h.received.at(-1).searchParams.get('code') === code, true); assert.equal(h.received.at(-1).searchParams.get('state') === state, true);
    const initial = await redeem(code); assert.equal(initial.status, 200);
    let tokens = JSON.parse(initial.body);
    assert.equal(typeof tokens.refresh_token,'string','real completed consent issues the first refresh credential');
    const family = (await h.pool.query("SELECT payload->>'grantId' AS family FROM commonswarm_oauth.provider_artifacts WHERE model='RefreshToken' AND artifact_id_hash=$1",
      [createHash('sha256').update(tokens.refresh_token).digest('base64url')])).rows[0].family;
    // Old issued-at/initial-issued-at values exercise the dependency's actual
    // rotation lifetime logic, without changing the browser or database clock.
    await h.pool.query(`UPDATE commonswarm_oauth.provider_artifacts SET
      payload=jsonb_set(jsonb_set(payload,'{iat}',to_jsonb(extract(epoch FROM clock_timestamp()-interval '40 days')::bigint)),
        '{iiat}',to_jsonb(extract(epoch FROM clock_timestamp()-interval '40 days')::bigint))
      WHERE grant_id=$1 AND model='RefreshToken'`,[family]);
    for (let rotation=0; rotation<3; rotation++) {
      const next = await h.request('/token',{ method: 'POST',headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: h.clientId,resource: h.resource,grant_type: 'refresh_token',refresh_token: tokens.refresh_token }).toString() });
      assert.equal(next.status,200,'refresh after the old 30-day age, including the first rotation');
      const rotated = JSON.parse(next.body);
      assert.notEqual(rotated.refresh_token,tokens.refresh_token);
      assert.equal(rotated.expires_in,300,'expires_in describes only the finite access token');
      assert.equal(Object.hasOwn(rotated,'refresh_expires_in'),false);
      tokens=rotated;
    }
    const rows = (await h.pool.query(`SELECT model,payload,expires_at FROM commonswarm_oauth.provider_artifacts
      WHERE (model='Grant' AND payload->>'jti'=$1) OR (model='RefreshToken' AND grant_id=$1)`,[family])).rows;
    assert.ok(rows.length>=5);
    for (const row of rows) { assert.equal(row.expires_at,null); assert.equal(Object.hasOwn(row.payload,'exp'),false); }
    const replay = await redeem(code);
    assert.equal(replay.status, 400); assert.equal(JSON.parse(replay.body).error, 'invalid_grant');
  };
  const chooser = await authorize();
  assertChooser(chooser);
  const signedIn = await h.signIn(chooser.path); assert.equal(signedIn.status, 303);
  const first = await consent(await view(signedIn.headers.get('location'))); assert.equal(first.status, 303);
  assert.ok(pendingSnapshots[0].expires_at>new Date(),'initial unbound/pending Grant is finite');
  assert.equal(typeof pendingSnapshots[0].payload.exp,'number');
  const initialGrant = (await h.pool.query("SELECT payload,expires_at FROM commonswarm_oauth.provider_artifacts WHERE model='Grant'")).rows[0];
  assert.equal(initialGrant.expires_at,null,'activation promotes the initial Grant before finish or code');
  assert.equal(Object.hasOwn(initialGrant.payload,'exp'),false);
  assert.equal((await h.provider.Grant.find(initialGrant.payload.jti)).exp,undefined,'the real provider reload sees the promoted Grant');
  const connectedPath = first.headers.get('location'); assert.equal(connectedPath.endsWith('/connected'), true);
  const page = await h.request(connectedPath); assert.equal(page.status, 200); assert.equal(page.body.includes('>Connected</h1>'), true);
  const finish = page.body.match(/id="finish-continue" href="([^"]+)"/u)?.[1]; assert.ok(finish);
  const finishPath = page.body.match(/data-finish-path="([^"]+)"/u)?.[1]; assert.equal(finishPath, finish);
  const script = page.body.match(/<script src="([^"]+)"/u)?.[1]; assert.ok(script);
  const nodes = new Map(), timers = [], navigations = [];
  const node = id => { if (!nodes.has(id)) nodes.set(id, { addEventListener() {},
    getAttribute: name => id === 'finish-continue' && name === 'href' ? finish : null }); return nodes.get(id); };
  node('finish-page').dataset = { finishPath, remainingMs: page.body.match(/data-remaining-ms="(\d+)"/u)?.[1] };
  const timer = await h.request(script); assert.equal(timer.status, 200);
  runInNewContext(timer.body, { document: { getElementById: node }, window: { addEventListener() {},
    location: { replace: path => navigations.push(path) } }, setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {} });
  assert.equal(node('finish-pause').hidden, false); assert.equal(node('finish-pause').disabled, false);
  assert.ok(timers.find(x => x.ms === 3000)); timers.find(x => x.ms === 3000).fn(); assert.deepEqual(navigations, [finish]);
  assert.equal(await countCodes(), 0); assert.equal(h.resumeCookiesPresent(), true); const calls = completed.mock.callCount();
  await h.request(finish, {}, true); // Deliberately discard the first response and all its cookies.
  const saved = (await h.pool.query('SELECT resume_response FROM commonswarm_oauth.finish_records WHERE interaction_uid=$1', [finish.split('/')[2]])).rows[0].resume_response;
  // 9.12.2 normally emits no cookies here; signed resume cookies already exist.
  // Compare every emitted cookie and prove that the retained jar can resume.
  assert.equal(Array.isArray(saved.cookies), true);
  for (let i = 0; i < 2; i++) { const retry = await h.request(finish); assert.equal(retry.status, 303);
    assert.equal(retry.headers.get('location') === saved.location, true);
    assert.equal(JSON.stringify(retry.headers.getSetCookie()) === JSON.stringify(saved.cookies), true);
    assert.equal(retry.headers.get('cache-control'), 'no-store'); assert.equal(retry.headers.get('referrer-policy'), 'no-referrer');
  }
  const resume = new URL(saved.location, h.issuer); assert.equal(resume.origin === h.issuer && !resume.search && !resume.hash, true);
  assert.equal(completed.mock.callCount() - calls, 1); assert.equal(await countCodes(), 0);
  await receive(saved.location); assert.equal((await h.request(finish)).status, 410);
  const pending = await consent(await authorize()); assert.equal(pending.status, 303); // Reused account still needs consent.
  assert.equal((await h.request(pending.headers.get('location'))).status, 200);
  assert.ok(await live() > 0, 'positive control: a live bound session exists before logout');
  const beforeLogout = completed.mock.callCount(); await h.logout();
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM auth.sessions')).rows[0].n, 0);
  assert.equal(await live(), 0, 'P1 trigger must invalidate every live bound session at logout');
  assert.equal((await h.request(pending.headers.get('location').replace(/connected$/u, 'finish'))).status, 410);
  assert.equal(completed.mock.callCount(), beforeLogout);
  const afterLogout = await authorize(); assertChooser(afterLogout);
  h.setEnabled(false);
  for (const suffix of ['connected', 'finish']) {
    const off = await h.request(pending.headers.get('location').replace(/connected$/u, suffix));
    assert.equal(off.status, 404); assert.equal(off.headers.has('location'), false);
  }
  const offTimer = await h.request(script); assert.equal(offTimer.status, 410);
  assert.ok(offTimer.body.includes('<h1>Start the connection again</h1>'));
  assert.equal(offTimer.headers.get('referrer-policy'), 'same-origin');
  const oldSignIn = await h.signIn(afterLogout.path);
  const old = await consent(await view(oldSignIn.headers.get('location'))); assert.equal(old.status, 303);
  assert.equal(new URL(old.headers.get('location'), h.issuer).pathname.startsWith('/authorize/'), true);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commonswarm_oauth.finish_records')).rows[0].n, 2);
  await receive(old.headers.get('location'));
  // A real canonical removal between activation and provider promotion must
  // produce the retry page, with no finish record or authorization code.
  const adapter = h.provider.Grant.adapter, originalPromote = adapter.promoteHostedGrant;
  const finishCount = (await h.pool.query('SELECT count(*)::int AS n FROM commonswarm_oauth.finish_records')).rows[0].n;
  const removal = t.mock.method(adapter,'promoteHostedGrant',async function (id,binding) {
    const c = await h.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT stream_id FROM swarm.streams WHERE workspace_id=$1 AND kind='workspace' FOR UPDATE",[h.workspace]);
      await c.query("UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE grant_id=$1",[binding.hostedGrantId]);
      await c.query('COMMIT');
    } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
    return originalPromote.call(this,id,binding);
  });
  const codeCount = await countCodes();
  const removed = await consent(await authorize());
  assert.equal(removed.status,502); assert.equal(await countCodes(),codeCount);
  const retryRemoved = await consent({ ...removed,path: removed.path.replace(/\/consent$/u,'') });
  assert.equal(retryRemoved.status,502,'activation/promotion retries cannot revive removed consent');
  assert.equal(await countCodes(),codeCount);
  assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commonswarm_oauth.finish_records')).rows[0].n,finishCount);
  removal.mock.restore();
  const observable = [...h.responses.flatMap(res => [res.body, JSON.stringify([...res.headers]
    .filter(([name]) => name !== 'location' || !callbackResponses.has(res)))]), ...h.logs].join('\n');
  assert.ok(observable.includes(saved.location), 'positive control: saved resume Location is observable');
  for (const value of [state, h.callback, 'DUMMYCODE', ...issuedCodes, ...h.privateValues]) {
    assert.equal(typeof value, 'string');
    assert.equal(observable.includes(value), false, 'credential/callback leakage');
  }
  assert.ok(h.logs.some(line => line.includes('request_complete')), 'positive log control');
  t.diagnostic('first connect; timer; dropped/repeated 303+cookies; single redemption; reuse; real global logout; flag-off: pass');
});
