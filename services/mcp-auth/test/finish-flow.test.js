// Acceptance: synthetic HTTP messages and storage with real oidc-provider
// 9.12.2 exercise navigation, response capture/replay and binding refusals.
// No network/browser; P4/P9c own PostgreSQL concurrency and final redemption.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { format } from 'node:util';
import { test } from 'node:test';
import Provider from 'oidc-provider';
import { generateKeyPair, exportJWK } from 'jose';
import { createAtomicMemoryAdapter } from '../src/memory-adapter.js';
import { hashOpaque, SESSION_COOKIE } from '../src/browser-security.js';
import { FinishStore } from '../src/finish-store.js';
import { createFinishFlow } from '../src/finish-flow.js';

const issuer = 'https://mcp.commonswarm.com';
const sessionId = 'DUMMYSESSION-long-enough', userId = 'DUMMYUSER';
const validated = { clientId: 'https://client.example/oauth.json', redirectUri: 'https://client.example/callback',
  resource: `${issuer}/mcp`, scopes: ['openid', 'mcp'], pkceChallenge: 'a'.repeat(43), oauthState: 'DUMMYSTATE' };
const input = { displayModel: { clientDisplay: { verified: true, primary: 'client.example', metadataHost: 'client.example' },
  identity: { displayName: 'TEST human', email: 'human@example.test' }, workspaceNames: ['TEST workspace'],
  homeWorkspaceName: 'TEST workspace' }, providerResult: { consent: { grantId: 'DUMMYGRANT' } } };
function response() {
  return Object.assign(new EventEmitter(), { statusCode: 200, headers: {}, body: '', writable: true,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    removeHeader(k) { delete this.headers[k.toLowerCase()]; },
    writeHead(status, headers) { this.statusCode = status; Object.entries(headers).forEach(([k, v]) => this.setHeader(k, v)); },
    end(body = '') { this.body += body; this.emit('finish'); } });
}
async function harness(t) {
  const responses = [], logs = [];
  const respond = () => { const res = response(); responses.push(res); return res; };
  for (const method of ['log', 'info', 'warn', 'error', 'debug']) t.mock.method(console, method, (...args) => logs.push(args));
  const { privateKey } = await generateKeyPair('ES256', { extractable: true });
  const provider = new Provider(issuer, { adapter: createAtomicMemoryAdapter(),
    jwks: { keys: [{ ...await exportJWK(privateKey), alg: 'ES256', use: 'sig', kid: 'DUMMYKEY' }] },
    clients: [{ client_id: validated.clientId, redirect_uris: [validated.redirectUri],
      response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none',
      id_token_signed_response_alg: 'ES256' }],
    features: { devInteractions: { enabled: false }, resourceIndicators: { enabled: true,
      getResourceServerInfo: async () => ({ audience: validated.resource, scope: 'mcp' }) } },
    routes: { authorization: '/authorize' },
    cookies: { keys: ['DUMMYCOOKIEKEY'], short: { signed: true, secure: true } } });
  provider.proxy = true;
  // Synthetic code exists only in provider storage, never in the finish record.
  const code = await new provider.AuthorizationCode({ jti: 'DUMMYCODE', accountId: userId,
    client: await provider.Client.find(validated.clientId), redirectUri: validated.redirectUri,
    codeChallenge: validated.pkceChallenge, codeChallengeMethod: 'S256', expiresIn: 120 }).save();
  assert.ok(await provider.AuthorizationCode.find(code));
  const params = { client_id: validated.clientId, redirect_uri: validated.redirectUri,
    resource: validated.resource, scope: validated.scopes.join(' '), code_challenge: validated.pkceChallenge, state: validated.oauthState };
  const request = (path, method = 'GET', cookie) => Object.assign(Readable.from([]), {
    method, url: path, headers: { host: new URL(issuer).host, 'x-forwarded-proto': 'https',
      cookie: cookie ?? `${SESSION_COOKIE}=${sessionId}` }, socket: { encrypted: true } });
  const authorization = new URLSearchParams({ ...params, response_type: 'code', code_challenge_method: 'S256' });
  const authorize = async () => {
    const res = respond(); await provider.callback()(request(`/authorize?${authorization}`), res);
    assert.equal(res.statusCode, 303, res.body); return res;
  };
  const authorized = await authorize();
  const uid = new URL(authorized.headers.location, issuer).pathname.split('/').at(-1);
  const interaction = await provider.Interaction.find(uid);
  assert.ok(interaction);
  const resume = new URL(interaction.returnTo);
  assert.equal(resume.origin, issuer); assert.match(resume.pathname, /^\/authorize\/[A-Za-z0-9_-]+$/u);
  assert.equal(resume.search, ''); assert.equal(resume.hash, '');
  const binding = { interactionUid: uid, sessionId, userId, request: validated };
  const providerCookies = authorized.headers['set-cookie'].map(c => c.split(';', 1)[0]).join('; ');
  const browser = { user_id: userId, authenticated_at: new Date() };
  let row, calls = 0, completed = 0, live = true;
  // Synthetic SQL boundary exercises the real FinishStore capture/validation.
  // SQL durability/locking are intentionally tested by P4, not this fixture.
  const pool = { async connect() { return { query: this.query.bind(this), release() {} }; },
    async query(sql, values) {
      if (sql.includes('INSERT INTO')) row ??= { interaction_uid: uid, session_hash: values[1], user_id: values[2],
        display_model: JSON.parse(values[3]), provider_result: JSON.parse(values[4]),
        validated_request: JSON.parse(values[5]), state: 'prepared', expires_at: new Date(Date.now() + 120000) };
      if (sql.includes('SELECT f.*')) {
        const valid = row && values[0] === uid && row.session_hash.equals(values[1]) && row.user_id === values[2] &&
          JSON.stringify(row.validated_request) === values[3] && row.expires_at > new Date();
        return { rows: valid ? [{ ...row, browser }] : [] };
      }
      if (sql.includes("SET state='preparing_resume'")) row.state = 'preparing_resume';
      if (sql.includes("SET state='resume_ready'")) Object.assign(row, { state: 'resume_ready', resume_response: JSON.parse(values[1]) });
      return { rows: [], rowCount: 1 };
    } };
  const finishStore = new FinishStore(pool, { issuer, verifySession: async () => live });
  const store = { requireSession: async id => id === sessionId ? browser : null,
    complete: async () => { completed++; } };
  const realFinished = provider.interactionFinished.bind(provider);
  provider.interactionFinished = async (...args) => { calls++; return realFinished(...args); };
  const flow = createFinishFlow({ provider, store, finishStore });
  async function run(path, cookie) {
    const req = request(path, 'GET', cookie ?? `${SESSION_COOKIE}=${sessionId}; ${providerCookies}`);
    const res = respond(); await flow.handle(req, res); return res;
  }
  return { uid, binding, code, responses, logs, response: respond, authorize, resumeLocation: interaction.returnTo, flow, provider, finishStore, run, request, browser, setLive: value => { live = value; },
    record: () => row, counts: () => ({ calls, completed }), providerCookies };
}
function noLeaks(h) {
  const surfaces = h.responses.flatMap(res => [res.body, JSON.stringify(res.headers)]).concat(h.logs.map(args => format(...args)));
  for (const value of [validated.redirectUri, h.code, validated.oauthState, validated.pkceChallenge, 'DUMMYGRANT', 'DUMMYSESSION']) {
    for (const surface of surfaces) assert.ok(!surface.includes(value), `finish response/log leaked ${value}`);
  }
}
function secured(res) {
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/u);
}

test('form and JSON consent navigate through 303/GET; fetch caller uses the bound response.url', async t => {
  for (const contentType of ['application/x-www-form-urlencoded', 'application/json']) {
    const h = await harness(t), { uid, binding } = h;
    const post = h.request(`/interaction/${uid}/consent`, 'POST'), res = h.response();
    post.headers['content-type'] = contentType;
    await h.flow.prepareFinish(post, res, binding, input);
    assert.equal(res.statusCode, 303); secured(res);
    assert.equal(res.headers.location, `/interaction/${uid}/connected`);
    assert.equal(res.body, '');
    const page = await h.run(res.headers.location);
    assert.equal(page.statusCode, 200); secured(page);
    assert.match(page.body, /<h1 id="finish-title">Connected<\/h1>/u);
    assert.match(page.body, /TEST workspace/u);
    // In-process fetch boundary follows the server's actual 303 and supplies
    // its final URL; caller checks it before performing top-level navigation.
    if (contentType === 'application/json') {
      const fetchFixture = async () => {
        const target = new URL(res.headers.location, issuer);
        const followed = await h.run(target.pathname);
        return { ok: followed.statusCode === 200, url: target.href };
      };
      const fetchResult = await fetchFixture();
      let navigated;
      const location = { replace(url) { navigated = url; } };
      const caller = result => {
        const target = new URL(result.url);
        if (!result.ok || target.origin !== issuer || target.pathname !== `/interaction/${uid}/connected` || target.search || target.hash) return;
        location.replace(result.url);
      };
      caller({ ...fetchResult, url: 'https://attacker.example/' }); assert.equal(navigated, undefined);
      caller(fetchResult); assert.equal(navigated, `${issuer}/interaction/${uid}/connected`);
    }
    assert.deepEqual(h.counts(), { calls: 0, completed: 1 });
    noLeaks(h);
  }
});

test('real provider produces code-free resume; a dropped response replays cookies without a second finish', async t => {
  const h = await harness(t);
  const { uid, binding } = h;
  await h.flow.prepareFinish(h.request('/consent', 'POST'), h.response(), binding, input);
  const finished = h.provider.interactionFinished.bind(h.provider);
  h.provider.interactionFinished = async (req, res, result) => {
    // Cookie-emission control exercises retention even if this provider version
    // needs only the signed resume cookies already held by the browser.
    res.setHeader('set-cookie', ['resume=DUMMYCOOKIE; Secure; HttpOnly', 'second=DUMMYCOOKIE; Secure']);
    return finished(req, res, result);
  };
  const first = await h.run(`/interaction/${uid}/finish`); // Deliberately discard delivery.
  const repeat = await h.run(`/interaction/${uid}/finish?redirect_uri=https://attacker.example/`);
  assert.equal(first.statusCode, 303); secured(first); secured(repeat);
  assert.equal(first.headers.location, h.resumeLocation);
  assert.deepEqual(repeat.headers, first.headers);
  assert.deepEqual(first.headers['set-cookie'], ['resume=DUMMYCOOKIE; Secure; HttpOnly', 'second=DUMMYCOOKIE; Secure']);
  assert.ok(h.providerCookies.includes(h.provider.cookieName('resume')));
  assert.deepEqual((await h.provider.Interaction.find(uid)).result, input.providerResult);
  assert.deepEqual(h.counts(), { calls: 1, completed: 1 });
  await (await h.provider.Interaction.find(uid)).destroy();
  const consumed = await h.run(`/interaction/${uid}/finish`);
  assert.equal(consumed.statusCode, 410); assert.match(consumed.body, /Return link expired/u);
  assert.equal(h.counts().calls, 1);
  noLeaks(h);
});

test('another browser, mismatched interaction UID, changed account/request, logout, expiry and crash fence refuse continuation with a positive control', async t => {
  const h = await harness(t), { uid, binding } = h;
  await h.flow.prepareFinish(h.request('/consent', 'POST'), h.response(), binding, input);
  const reject = async cookie => {
    const res = await h.run(`/interaction/${uid}/finish`, cookie);
    assert.equal(res.statusCode, 410); secured(res); assert.equal(res.headers.location, undefined);
    assert.doesNotMatch(res.body, /Connected/u);
  };
  await reject(`${SESSION_COOKIE}=DUMMYOTHERBROWSER; ${h.providerCookies}`);
  const other = await h.authorize();
  assert.notEqual(new URL(other.headers.location, issuer).pathname.split('/').at(-1), uid);
  await reject(`${SESSION_COOKIE}=${sessionId}; ${other.headers['set-cookie'].map(c => c.split(';', 1)[0]).join('; ')}`);
  h.browser.user_id = 'CHANGED'; await reject(); h.browser.user_id = userId;
  h.record().validated_request = { ...validated, oauthState: 'CHANGED' }; await reject(); h.record().validated_request = validated;
  h.setLive(false); await reject(); h.setLive(true);
  h.record().expires_at = new Date(0); await reject(); h.record().expires_at = new Date(Date.now() + 120000);
  h.record().state = 'preparing_resume'; await reject(); h.record().state = 'prepared';
  assert.equal(h.counts().calls, 0);
  assert.equal((await h.run(`/interaction/${uid}/finish`)).statusCode, 303);
  assert.equal(h.counts().calls, 1);
  noLeaks(h);
});
