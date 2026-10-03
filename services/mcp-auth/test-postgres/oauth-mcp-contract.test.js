import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { createLocalJWKSet, exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { Pool } from 'pg';

import { hashOpaque, SESSION_COOKIE } from '../src/browser-security.js';
import { InteractionStore } from '../src/interaction-store.js';
import { ISSUER, RESOURCE } from '../src/provider.js';
import { startServer } from '../src/server.js';
import { localClusterAdminUrl } from '../../../tests/support/admin-schema-db.js';

const exec = promisify(execFile);
const clientHost = 'metadata.oauth-contract.example';
const redirectUri = 'https://connector.oauth-contract.example/oauth/callback';
const databaseUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ??
  'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeIdleConnections();
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

// A logical HTTPS cookie jar: only issuer cookies whose Path matches are sent
// through the loopback proxy. Callback URLs never receive issuer cookies.
class Agent {
  cookies = new Map();
  constructor(origin, sessions) { this.origin = origin; this.sessions = sessions; }
  async request(target, options = {}) {
    const url = new URL(target, ISSUER);
    assert.ok(url.origin === ISSUER, 'only authorization issuer traffic may use the proxy');
    const headers = new Headers(options.headers);
    headers.set('host', new URL(ISSUER).host);
    headers.set('x-forwarded-host', new URL(ISSUER).host);
    headers.set('x-forwarded-proto', 'https');
    const cookies = [...this.cookies.values()].filter(cookie =>
      url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith('/') ? cookie.path : `${cookie.path}/`));
    if (cookies.length) headers.set('cookie', cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; '));
    const response = await fetch(`${this.origin}${url.pathname}${url.search}`, {
      ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    for (const source of response.headers.getSetCookie()) {
      const [pair, ...attributes] = source.split(';').map(part => part.trim());
      const split = pair.indexOf('=');
      const name = pair.slice(0, split), value = pair.slice(split + 1);
      const path = attributes.find(value => /^path=/iu.test(value))?.slice(5) ?? '/';
      const key = `${name}:${path}`;
      if (attributes.some(value => /^max-age=0$/iu.test(value))) this.cookies.delete(key);
      else this.cookies.set(key, { name, value, path });
      if (name === SESSION_COOKIE && value) this.sessions.add(value);
    }
    return response;
  }
}

function form(html) {
  const action = /<form[^>]*action="([^"]+)"/u.exec(html)?.[1];
  const field = name => new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`, 'u').exec(html)?.[1];
  const csrf = field('csrf_token'), version = field('selection_version');
  assert.ok(action && csrf && version !== undefined, 'consent form has action, CSRF and selection version');
  return { action, csrf, version, home: field('home_workspace_id') };
}

function assertConsentHeaders(response) {
  assert.equal(response.headers.get('referrer-policy'), 'same-origin', 'R6: same-origin forms retain their Origin');
  const policy = response.headers.get('content-security-policy') ?? '';
  const actions = /(?:^|;)\s*form-action\s+([^;]+)/u.exec(policy)?.[1].split(/\s+/u) ?? [];
  assert.deepEqual(actions, ["'self'", new URL(redirectUri).origin], 'R8: only the validated callback origin joins self');
}

async function startEdge(directory, config) {
  const file = `${directory}/edge.json`;
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  const child = spawn('deno', ['run', '--quiet', '--no-check', '--allow-env',
    '--allow-read', '--allow-net=127.0.0.1,localhost,[::1]',
    new URL('./fixtures/oauth-edge.mjs', import.meta.url).pathname, file],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  // Runtime diagnostics may carry fixture credentials. Keep them off stdout.
  child.stderr.resume();
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Deno edge startup timed out')), 60_000);
      let output = '';
      child.stdout.on('data', chunk => {
        output += chunk.toString();
        const port = /OAUTH_EDGE_PORT=(\d+)/u.exec(output)?.[1];
        if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); }
      });
      child.once('error', () => { clearTimeout(timer); reject(new Error('Deno edge launch failed')); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Deno edge exited during startup (${code})`)); });
    });
    child.stdout.resume();
    const request = (path, options = {}) => fetch(`${origin}${path}`, {
      ...options, headers: { ...options.headers, 'x-contract-bridge': config.bridgeKey },
      redirect: 'manual', signal: AbortSignal.timeout(15_000),
    });
    return { request, async close() {
      const exited = new Promise(resolve => child.once('exit', resolve));
      await request('/shutdown', { method: 'POST' }).catch(() => {});
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    } };
  } catch (error) { child.kill('SIGKILL'); throw error; }
}

test('hosted OAuth contract: CIMD and DCR discovery through real consent, PKCE tokens and edge MCP',
  { timeout: 180_000 }, async t => {
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname), 'local CI database required');
    const pool = new Pool({ connectionString: localClusterAdminUrl(databaseUrl), max: 2, connectionTimeoutMillis: 3_000 });
    t.after(() => pool.end());
    const catalog = await pool.query("SELECT to_regclass('commonswarm_oauth.registered_clients') IS NOT NULL AS ready");
    assert.equal(catalog.rows[0]?.ready, true, 'reset the CI stack through the real migrations before this test');
    const { stdout } = await exec('mktemp', ['-d', '/private/tmp/anvil-secret.XXXXXX']);
    const directory = stdout.trim();
    assert.ok(/^\/private\/tmp\/anvil-secret\.[A-Za-z0-9]+$/u.test(directory));
    await chmod(directory, 0o700);
    const sessions = new Set(), clients = new Set();
    let running, edge, metadataServer, gotrue;
    let runtimePasswordConfigured = false;
    try {
      // Match the adapter fixture and production's dedicated runtime login.
      // The migration creator's ADMIN-only membership cannot SET ROLE; a
      // postgres login with a startup role override is not that product path.
      const runtimeDatabaseUrl = new URL(databaseUrl);
      runtimeDatabaseUrl.username = 'commonswarm_oauth_runtime';
      runtimeDatabaseUrl.password = randomBytes(32).toString('hex');
      await pool.query(`ALTER ROLE commonswarm_oauth_runtime PASSWORD '${runtimeDatabaseUrl.password}'`);
      runtimePasswordConfigured = true;
      const owner = randomUUID(), other = randomUUID();
      const workspaces = [randomUUID(), randomUUID()].sort();
      // Synthetic identities replace only external interactive sign-in. All
      // authority, OAuth storage and migrations remain the real CI database.
      await pool.query('INSERT INTO auth.users (id, email) VALUES ($1, $2), ($3, $4)',
        [owner, `${owner}@example.test`, other, `${other}@example.test`]);
      await pool.query("INSERT INTO swarm.users (user_id, display_name) VALUES ($1, 'OAuth owner'), ($2, 'Other OAuth user')", [owner, other]);
      for (const [index, workspace] of workspaces.entries()) {
        await pool.query('INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES ($1, $2, $3)', [workspace, `OAuth contract ${index}`, owner]);
        await pool.query("INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES ($1, $2, 'owner')", [workspace, owner]);
        await pool.query("INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES ($1, $2, 'workspace')", [randomUUID(), workspace]);
      }
      const signins = new Map();
      gotrue = createServer(async (request, response) => {
        const url = new URL(request.url, 'http://fixture');
        if (request.method === 'GET' && url.pathname === '/authorize') {
          const code = randomBytes(32).toString('base64url');
          signins.set(code, url.searchParams.get('code_challenge'));
          const callback = new URL(url.searchParams.get('redirect_to'));
          callback.searchParams.set('code', code);
          response.writeHead(303, { location: callback.toString() }); response.end();
        } else if (request.method === 'POST' && url.pathname === '/token') {
          const chunks = []; for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(Buffer.concat(chunks));
          const valid = signins.get(body.auth_code) === createHash('sha256').update(body.code_verifier).digest('base64url');
          signins.delete(body.auth_code);
          response.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' });
          response.end(JSON.stringify(valid ? { access_token: 'synthetic-login', expires_in: 3600 } : { error: 'invalid_grant' }));
        } else if (request.method === 'GET' && url.pathname === '/user' && request.headers.authorization === 'Bearer synthetic-login') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ id: owner, email: `${owner}@example.test`, user_metadata: { display_name: 'OAuth owner' } }));
        } else { response.writeHead(404); response.end(); }
      });
      const gotrueUrl = await listen(gotrue);
      const metadata = new Map();
      let metadataReads = 0;
      await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-keyout', `${directory}/fixture.key`, '-out', `${directory}/fixture.crt`,
        '-subj', `/CN=${clientHost}`, '-addext', `subjectAltName=DNS:${clientHost}`]);
      await chmod(`${directory}/fixture.key`, 0o600);
      const cert = await readFile(`${directory}/fixture.crt`);
      metadataServer = https.createServer({ key: await readFile(`${directory}/fixture.key`), cert }, (request, response) => {
        const document = metadata.get(request.url);
        metadataReads++;
        response.writeHead(document ? 200 : 404, { 'content-type': 'application/json' });
        response.end(JSON.stringify(document ?? { error: 'not_found' }));
      });
      await listen(metadataServer);
      const originalLookup = dns.lookup, originalRequest = https.request;
      // Scope the transport mapping to this fixture hostname. Keep the real
      // pinned fetch (DNS policy, TLS verification, parsing, limits) in use.
      t.mock.method(dns, 'lookup', async (hostname, options) => hostname === clientHost
        ? [{ address: '93.184.216.34', family: 4 }] : originalLookup(hostname, options));
      t.mock.method(https, 'request', (options, callback) => {
        assert.equal(options.servername, clientHost, 'no external CIMD fetch is permitted');
        assert.equal(options.hostname, '93.184.216.34', 'real pinned fetch selects the validated DNS address');
        assert.equal(options.rejectUnauthorized, true, 'real pinned fetch requires TLS verification');
        return originalRequest({ ...options, hostname: '127.0.0.1', port: metadataServer.address().port, ca: cert }, callback);
      });
      syncBuiltinESMExports();
      const { privateKey } = await generateKeyPair('ES256', { extractable: true });
      let bridgeReady, faultWorkspace;
      const commandCalls = [];
      const bridge = async (path, body) => {
        await bridgeReady;
        const response = await edge.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(response.status, 200, 'real Deno management bridge responds');
        return await response.json();
      };
      running = await startServer({
        config: {
          issuer: ISSUER, resource: RESOURCE, publicAuthorizationEnabled: true, port: 0,
          database: { connectionString: runtimeDatabaseUrl.toString(), max: 2 },
          jwks: { keys: [{ ...await exportJWK(privateKey), kid: 'oauth-contract', alg: 'ES256', use: 'sig' }] },
          cookieKeys: [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')],
          allowedOrigins: new Set([ISSUER]), gotrueUrl, gotrueProvider: 'github',
          supabaseAnonKey: 'synthetic-contract-key', maxBodyBytes: 64 * 1024, requestTimeoutMs: 10_000,
        },
        writeLog: () => {},
        managementWorkspaceReader: identity => bridge('/workspaces', identity),
        managementCommand: async (input, identity) => {
          commandCalls.push(input);
          if (input.command.kind === 'consent_hosted_mcp_workspace' && input.workspace_id === faultWorkspace) {
            faultWorkspace = undefined;
            return { status: 503, body: { error: 'fixture_interruption' } };
          }
          return await bridge('/management', { input, identity });
        },
      });
      const principal = await running.pool.query('SELECT session_user AS principal, current_user AS role');
      assert.deepEqual(principal.rows[0], {
        principal: 'commonswarm_oauth_runtime', role: 'commonswarm_oauth_runtime',
      }, 'OAuth storage uses the dedicated runtime login and its migrated privileges');
      const authOrigin = `http://127.0.0.1:${running.server.address().port}`;
      bridgeReady = startEdge(directory, { databaseUrl, gotrueUrl, authOrigin, bridgeKey: randomBytes(32).toString('base64url') });
      edge = await bridgeReady;

      for (const mode of ['CIMD', 'DCR']) await t.test(mode, async () => {
        const agent = new Agent(authOrigin, sessions);
        const resourceResponse = await edge.request('/.well-known/oauth-protected-resource/mcp');
        assert.equal(resourceResponse.status, 200);
        const resourceMetadata = await resourceResponse.json();
        assert.equal(resourceMetadata.resource, RESOURCE);
        assert.deepEqual(resourceMetadata.authorization_servers, [ISSUER]);
        const discoveryResponse = await agent.request('/.well-known/oauth-authorization-server');
        assert.equal(discoveryResponse.status, 200);
        const discovery = await discoveryResponse.json();
        assert.equal(discovery.issuer, ISSUER);
        assert.equal(discovery.authorization_endpoint, `${ISSUER}/authorize`);
        assert.ok(discovery.code_challenge_methods_supported.includes('S256'));
        assert.equal(discovery.client_id_metadata_document_supported, true);
        const oidcResponse = await agent.request('/.well-known/openid-configuration');
        assert.equal(oidcResponse.status, 200);
        const oidc = await oidcResponse.json();
        assert.ok(oidc.id_token_signing_alg_values_supported.includes('ES256'), 'R1: advertised algorithms support the signing key');
        const jwksResponse = await agent.request(discovery.jwks_uri);
        assert.equal(jwksResponse.status, 200);
        const jwks = await jwksResponse.json();
        assert.ok(jwks.keys.length > 0 && jwks.keys.every(key => key.alg === 'ES256' && !Object.hasOwn(key, 'd')));
        const clientDocument = { client_name: `OAuth contract ${mode}`, redirect_uris: [redirectUri],
          response_types: ['code'], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' };
        let clientId;
        if (mode === 'CIMD') {
          const path = `/client-${randomUUID()}.json`;
          clientId = `https://${clientHost}${path}`;
          metadata.set(path, { ...clientDocument, client_id: clientId });
        } else {
          assert.ok(typeof discovery.registration_endpoint === 'string', 'DCR endpoint is advertised');
          const rejected = await agent.request(discovery.registration_endpoint, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...clientDocument, redirect_uris: ['http://untrusted.example/callback'] }) });
          assert.equal(rejected.status, 400, 'DCR refuses an unsafe redirect before registration');
          const registered = await agent.request(discovery.registration_endpoint, { method: 'POST',
            headers: { 'content-type': 'application/json' }, body: JSON.stringify(clientDocument) });
          assert.equal(registered.status, 201, 'RFC 7591 public client registration succeeds');
          const result = await registered.json();
          clientId = result.client_id;
          assert.ok(typeof clientId === 'string' && !clientId.startsWith('https://'));
          assert.equal(result.id_token_signed_response_alg, 'ES256', 'R1: omitted client algorithm defaults to ES256');
        }
        clients.add(clientId);
        const verifier = randomBytes(32).toString('base64url'), state = randomUUID();
        const parameters = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code',
          scope: 'openid mcp offline_access', prompt: 'consent', resource: RESOURCE, state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' };
        const authorize = async (overrides = {}) => agent.request(`${discovery.authorization_endpoint}?${new URLSearchParams({ ...parameters, ...overrides })}`);
        const unsafeResource = await authorize({ resource: `${RESOURCE}/wrong` });
        assert.equal(unsafeResource.status, 303);
        assert.equal(new URL(unsafeResource.headers.get('location')).searchParams.get('error'), 'invalid_target');
        const noPkce = await authorize({ code_challenge: '', code_challenge_method: '' });
        assert.equal(noPkce.status, 303);
        assert.ok(new URL(noPkce.headers.get('location')).searchParams.has('error'), 'PKCE omission cannot authorize');
        let response = await authorize();
        assert.equal(response.status, 303, 'authorization reaches a real login interaction');
        let interactionUrl = new URL(response.headers.get('location'), ISSUER);
        assert.ok(interactionUrl.pathname.startsWith('/interaction/'));
        response = await agent.request(interactionUrl);
        assert.equal(response.status, 303);
        const signin = new URL(response.headers.get('location'));
        assert.equal(signin.origin, gotrueUrl, 'interaction goes only to synthetic GoTrue');
        const signed = await fetch(signin, { redirect: 'manual', signal: AbortSignal.timeout(10_000) });
        assert.equal(signed.status, 303);
        const callback = new URL(signed.headers.get('location'));
        const swappedState = new URL(callback); swappedState.searchParams.set('state', 'swapped-signin-state');
        const deniedSignin = await agent.request(swappedState, { headers: { accept: 'application/json' } });
        assert.equal(deniedSignin.status, 409, 'sign-in state is bound to the interaction');
        response = await agent.request(callback);
        assert.equal(response.status, 303);
        assert.equal(response.headers.get('location'), interactionUrl.pathname, 'R2: sign-in resumes the original interaction');
        const replayedSignin = await agent.request(callback, { headers: { accept: 'application/json' } });
        assert.equal(replayedSignin.status, 409, 'sign-in callback is single-use after rotation');
        response = await agent.request(response.headers.get('location'));
        assert.equal(response.status, 303, 'R5: real login submission resumes provider authorization');
        const loginResume = new URL(response.headers.get('location'), ISSUER);
        assert.ok(loginResume.pathname.startsWith('/authorize/'), 'R3: provider resume uses /authorize/*');
        response = await agent.request(loginResume);
        assert.equal(response.status, 303, 'R3: server routes provider resume');
        interactionUrl = new URL(response.headers.get('location'), ISSUER);
        response = await agent.request(interactionUrl);
        assert.equal(response.status, 200, 'R4: newly authenticated account can render consent');
        assertConsentHeaders(response);
        let page = form(await response.text());
        const uid = decodeURIComponent(interactionUrl.pathname.split('/').at(-1));
        const binding = (await pool.query('SELECT user_id FROM commonswarm_oauth.interactions WHERE interaction_uid = $1', [uid])).rows[0];
        assert.ok(binding.user_id === owner, 'R4: consent interaction is bound to the authenticated account');
        const submit = async (fields, origin = ISSUER, sender = agent) => sender.request(page.action, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin === null ? {} : { origin }) },
          body: new URLSearchParams(fields),
        });
        const fields = () => [['csrf_token', page.csrf], ['selection_version', page.version],
          ...workspaces.map(id => ['workspace_ids', id]), ['home_workspace_id', workspaces[0]]];
        const nullOrigin = await submit(fields(), 'null');
        assert.equal(nullOrigin.status, 403, 'null Origin remains denied');
        assert.equal((await nullOrigin.json()).error, 'origin_forbidden');
        const foreignOrigin = await submit(fields(), 'https://attacker.example');
        assert.equal(foreignOrigin.status, 403);
        const missingOrigin = await submit(fields(), null);
        assert.equal(missingOrigin.status, 403);
        const noCsrf = await submit(fields().filter(([name]) => name !== 'csrf_token'));
        assert.equal(noCsrf.status, 403); assert.equal((await noCsrf.json()).error, 'csrf_required');
        const wrongCsrf = await submit(fields().map(([name, value]) => [name, name === 'csrf_token' ? 'x'.repeat(43) : value]));
        assert.equal(wrongCsrf.status, 409, 'a swapped CSRF token cannot consume consent');
        const staleVersion = await submit(fields().map(([name, value]) => [name, name === 'selection_version' ? String(Number(value) + 1) : value]));
        assert.equal(staleVersion.status, 409, 'stale selection versions cannot consume consent');
        const swappedSession = await new InteractionStore(pool).createSession();
        sessions.add(swappedSession);
        await pool.query('UPDATE commonswarm_oauth.browser_sessions SET user_id = $1, authenticated_at = statement_timestamp() WHERE session_hash = $2', [owner, hashOpaque(swappedSession)]);
        const otherBrowser = new Agent(authOrigin, sessions);
        otherBrowser.cookies = new Map(agent.cookies);
        otherBrowser.cookies.set(`${SESSION_COOKIE}:/`, { name: SESSION_COOKIE, value: swappedSession, path: '/' });
        const otherSession = await submit(fields(), ISSUER, otherBrowser);
        assert.equal(otherSession.status, 409, 'consent cannot move to another browser session for the same account');
        const session = [...agent.cookies.values()].find(cookie => cookie.name === SESSION_COOKIE).value;
        await pool.query('UPDATE commonswarm_oauth.browser_sessions SET user_id = $1 WHERE session_hash = $2', [other, hashOpaque(session)]);
        const otherAccount = await submit(fields());
        assert.equal(otherAccount.status, 403, 'interaction cannot be submitted by another authenticated account');
        assert.equal((await otherAccount.json()).error, 'authentication_required');
        await pool.query('UPDATE commonswarm_oauth.browser_sessions SET user_id = $1 WHERE session_hash = $2', [owner, hashOpaque(session)]);
        const noHome = await submit(fields().filter(([name]) => name !== 'home_workspace_id'));
        assert.equal(noHome.status, 400, 'R7: multiple selected workspaces require a home');
        assertConsentHeaders(noHome); page = form(await noHome.text());
        const callsBefore = commandCalls.length;
        if (mode === 'DCR') faultWorkspace = workspaces[1];
        response = await submit(fields());
        if (mode === 'DCR') {
          assert.equal(response.status, 502, 'R7: interrupted consent remains resumable');
          assertConsentHeaders(response); page = form(await response.text());
          const pending = await pool.query('SELECT state FROM swarm.hosted_mcp_grants WHERE interaction_ref = $1', [uid]);
          assert.equal(pending.rows[0]?.state, 'pending', 'failed consent never activates partial authority');
          const reloaded = await agent.request(interactionUrl);
          assert.equal(reloaded.status, 200, 'R7: GET reload restores consent progress');
          assertConsentHeaders(reloaded); page = form(await reloaded.text());
          assert.equal(page.home, workspaces[0], 'R7: the reloaded form retains its locked home workspace');
          const changedSelection = await submit(fields().filter(([name, value]) => name !== 'workspace_ids' || value === workspaces[0]));
          assert.equal(changedSelection.status, 409, 'resume cannot replace its persisted workspace manifest');
          response = await submit(fields());
          const executed = commandCalls.slice(callsBefore);
          assert.equal(executed.filter(input => input.command.kind === 'begin_hosted_mcp_grant').length, 1, 'resume does not repeat completed begin');
          assert.equal(executed.filter(input => input.command.kind === 'consent_hosted_mcp_workspace' && input.workspace_id === workspaces[0]).length, 1);
          assert.equal(executed.filter(input => input.command.kind === 'consent_hosted_mcp_workspace' && input.workspace_id === workspaces[1]).length, 2);
        }
        assert.equal(response.status, 303, 'consent submission returns to provider');
        const consentResume = new URL(response.headers.get('location'), ISSUER);
        assert.ok(consentResume.pathname.startsWith('/authorize/'));
        response = await agent.request(consentResume);
        assert.equal(response.status, 303, 'R7: provider resumes the persisted consent grant');
        const authorizationCallback = new URL(response.headers.get('location'));
        assert.equal(authorizationCallback.origin + authorizationCallback.pathname, redirectUri);
        assert.ok(authorizationCallback.searchParams.get('state') === state && authorizationCallback.searchParams.has('code') && !authorizationCallback.searchParams.has('error'));
        const code = authorizationCallback.searchParams.get('code');
        const tokenFields = { client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code', code, code_verifier: verifier, resource: RESOURCE };
        const tokenRequest = overrides => agent.request(discovery.token_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...tokenFields, ...overrides }),
        });
        const wrongVerifier = await tokenRequest({ code_verifier: 'x'.repeat(43) });
        assert.equal(wrongVerifier.status, 400); assert.equal((await wrongVerifier.json()).error, 'invalid_grant');
        response = await tokenRequest({});
        assert.equal(response.status, 200, 'R9: real HTTP token body reaches the provider parser');
        const tokens = await response.json();
        assert.ok(typeof tokens.access_token === 'string' && typeof tokens.refresh_token === 'string' && typeof tokens.id_token === 'string');
        assert.equal(tokens.token_type.toLowerCase(), 'bearer'); assert.equal(tokens.expires_in, 300);
        const keys = createLocalJWKSet(jwks);
        const idProof = await jwtVerify(tokens.id_token, keys, { issuer: ISSUER, audience: clientId, algorithms: ['ES256'] });
        assert.ok(idProof.payload.sub === owner, 'R1: real ID token verifies with the advertised ES256 JWKS');
        const rpc = (body, token = tokens.access_token, version = '2025-11-25') => edge.request('/mcp', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'mcp-protocol-version': version }, body: JSON.stringify(body),
        });
        const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: `contract-${mode}`, version: '1' } } };
        const badToken = tokens.access_token.split('.'); badToken[2] = `${badToken[2][0] === 'a' ? 'b' : 'a'}${badToken[2].slice(1)}`;
        const deniedMcp = await rpc(initialize, badToken.join('.'));
        assert.equal(deniedMcp.status, 401, 'edge rejects a tampered real access token');
        assert.ok(deniedMcp.headers.get('www-authenticate')?.includes('resource_metadata='));
        const malformedInitialize = await rpc({ ...initialize, params: {} });
        assert.equal(malformedInitialize.status, 400);
        response = await rpc(initialize);
        assert.equal(response.status, 200, 'R10: early unsupported header cannot veto initialize negotiation');
        const initialized = await response.json();
        assert.equal(initialized.result.protocolVersion, '2025-06-18');
        assert.deepEqual(initialized.result.capabilities.tools, { listChanged: false });
        const notification = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, tokens.access_token, initialized.result.protocolVersion);
        assert.equal(notification.status, 202);
        const badVersion = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
        assert.equal(badVersion.status, 400, 'subsequent requests must use the negotiated protocol version');
        response = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, tokens.access_token, initialized.result.protocolVersion);
        assert.equal(response.status, 200);
        const listed = await response.json();
        assert.equal(listed.result.tools.length, 8, 'hosted MCP exposes the reviewed eight-tool contract');
        assert.equal(new Set(listed.result.tools.map(tool => tool.name)).size, 8);
        assert.ok(listed.result.tools.every(tool => tool.inputSchema?.type === 'object'));
        const grant = await pool.query('SELECT state FROM swarm.hosted_mcp_grants WHERE interaction_ref = $1', [uid]);
        assert.equal(grant.rows[0]?.state, 'active', 'token and MCP success follows actual authority activation');
        const replay = await tokenRequest({});
        assert.equal(replay.status, 400); assert.equal((await replay.json()).error, 'invalid_grant');
      });
      assert.ok(metadataReads > 0, 'CIMD metadata came from the HTTPS fixture server');
    } finally {
      try {
        const stopped = await Promise.allSettled([
          edge?.close(),
          running ? close(running.server).finally(() => running.pool.end()) : undefined,
          metadataServer ? close(metadataServer) : undefined,
          gotrue ? close(gotrue) : undefined,
        ]);
        t.mock.restoreAll(); syncBuiltinESMExports();
        for (const clientId of clients) {
          await pool.query("DELETE FROM commonswarm_oauth.provider_artifacts WHERE payload->>'clientId' = $1", [clientId]);
          await pool.query('DELETE FROM commonswarm_oauth.cimd_cache WHERE client_id = $1', [clientId]);
          await pool.query('DELETE FROM commonswarm_oauth.registered_clients WHERE client_id = $1', [clientId]);
          await pool.query('DELETE FROM commonswarm_oauth.interactions WHERE client_id = $1', [clientId]);
        }
        for (const session of sessions) await pool.query('DELETE FROM commonswarm_oauth.browser_sessions WHERE session_hash = $1', [hashOpaque(session)]);
        assert.ok(stopped.every(result => result.status === 'fulfilled'), 'all task-owned fixture services stopped');
      } finally {
        try {
          if (runtimePasswordConfigured) await pool.query('ALTER ROLE commonswarm_oauth_runtime PASSWORD NULL');
        } finally {
          assert.equal(resolve(directory), directory);
          await exec('rm', ['-rf', directory]);
        }
      }
    }
  });
