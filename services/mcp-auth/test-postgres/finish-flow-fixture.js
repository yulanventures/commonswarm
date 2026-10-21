// P9c CI fixture: dummy sign-in inputs enter the real HTTP/provider/command path.
// Outputs collect every AS response privately for leak checks; PostgreSQL owns state.
// Only external OAuth is synthetic; GoTrue verification/logout use v2.197.0.
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, readFileSync, writeFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { format } from 'node:util';
import { Pool } from 'pg';
import { adminEdgeDatabase } from '../../../tests/support/admin-edge-database.ts';
import { createGoTrueClient, readGoTrueSession } from '../src/gotrue.js';
import { createMcpProvider, ISSUER, RESOURCE } from '../src/provider.js';
import { createHandler, createProductionFindAccount } from '../src/server.js';
import { createPostgresAdapter } from '../src/postgres-adapter.js';
import { createPostgresRegistrationStore } from '../src/registration.js';
import { InteractionStore } from '../src/interaction-store.js';
import { FinishStore } from '../src/finish-store.js';
import { createFinishFlow } from '../src/finish-flow.js';
import { createInteractionHandler } from '../src/interactions.js';
import { createConsentOrchestrator, createPostgresConsentProgress } from '../src/consent.js';
import { createLogger } from '../src/logger.js';
import { GOTRUE_IMAGE_TAG, pullBoxMatchedGoTrue } from './gotrue-image.js';

// Shared disposable GoTrue bootstrap. Callers register close before awaiting setup;
// setup failure cleans its own allocations. No provider/edge authority is needed.
export async function goTrueFixture(t) {
  t.signal?.throwIfAborted();
  const sourceUrl = process.env.MCP_OAUTH_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';
  assert.equal(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(sourceUrl).hostname), true, 'local database required');
  const temporaryRoot = realpathSync(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'cs-oauth-fixture-'));
  chmodSync(directory, 0o700);
  const name = `oauth-finish-${randomUUID()}`;
  let isolated, pool, reservation, attempted = false, closed = false, phase = 'database';
  // Docker/driver exceptions can contain private response or env-file contents.
  const docker = args => {
    try { return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 90_000 }); }
    catch { throw new Error('disposable_gotrue_docker_failed'); }
  };
  const close = async () => {
    if (closed) return; closed = true;
    let failed = false;
    try {
      if (reservation?.listening) await new Promise(resolve => reservation.close(resolve));
      if (attempted && docker(['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}']).trim()) {
        const [owned] = JSON.parse(docker(['inspect', name]));
        assert.equal(owned.Name === `/${name}` && owned.Config.Labels?.['cs.fixture'] === name, true);
        docker(['rm', '--force', name]);
      }
    } catch { failed = true; }
    try { await pool?.end(); } catch { failed = true; }
    try { await isolated?.close(); } catch { failed = true; }
    assert.equal(dirname(directory), temporaryRoot);
    assert.match(basename(directory), /^cs-oauth-fixture-[A-Za-z0-9]+$/u);
    try { execFileSync('rm', ['-r', '--', directory], { stdio: 'pipe' }); } catch { failed = true; }
    assert.equal(failed, false, 'disposable_gotrue_cleanup_failed');
  };
  try {
    isolated = await adminEdgeDatabase(sourceUrl);
    t.signal?.throwIfAborted();
    pool = new Pool({ connectionString: isolated.url, max: 3, connectionTimeoutMillis: 3000 });
    const source = new URL(sourceUrl); source.username = 'supabase_admin';
    const ledgerPool = new Pool({ connectionString: source.href, max: 1 });
    try {
      const ledger = await ledgerPool.query('SELECT version FROM auth.schema_migrations ORDER BY version');
      assert.ok(ledger.rowCount > 0, 'GoTrue schema ledger required');
      for (const { version } of ledger.rows) await pool.query('INSERT INTO auth.schema_migrations(version) VALUES($1)', [version]);
    } finally { await ledgerPool.end(); }
    t.signal?.throwIfAborted();
    phase = 'image';
    const resolved = pullBoxMatchedGoTrue(docker, t);
    t.signal?.throwIfAborted();
    // Reserve a dynamic loopback port; release it only immediately before start.
    reservation = createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const port = reservation.address().port, root = `http://127.0.0.1:${port}/auth/v1`;
    const jwtSecret = randomBytes(32).toString('hex');
    writeFileSync(`${directory}/env`, ['GOTRUE_API_HOST=127.0.0.1', `GOTRUE_API_PORT=${port}`, 'GOTRUE_DB_DRIVER=postgres',
      `GOTRUE_DB_DATABASE_URL=${isolated.url}`, `API_EXTERNAL_URL=${root}`, `GOTRUE_JWT_ISSUER=${root}`, 'GOTRUE_SITE_URL=http://localhost',
      `GOTRUE_JWT_SECRET=${jwtSecret}`, 'GOTRUE_JWT_AUD=authenticated',
      'GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true', 'GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10',
      'GOTRUE_EXTERNAL_EMAIL_ENABLED=true', 'GOTRUE_MAILER_AUTOCONFIRM=true', 'GOTRUE_DISABLE_SIGNUP=false',
      'GOTRUE_LOG_LEVEL=error', ''].join('\n'), { mode: 0o600 });
    await new Promise(resolve => reservation.close(resolve));
    phase = 'health'; attempted = true;
    docker(['run', '--detach', '--name', name, '--label', `cs.fixture=${name}`,
      '--label', 'cs.owner=mcp-auth', '--label', `cs.project=${process.env.CSCI_PROJECT ?? name}`,
      '--label', `cs.job=${name}`, '--network', 'host', '--env-file', `${directory}/env`, resolved]);
    const wire = (url, options) => { const u = new URL(url); u.pathname = u.pathname.replace(/^\/auth\/v1/u, ''); return fetch(u, options); };
    let health;
    for (let i = 0; i < 120; i++) {
      t.signal?.throwIfAborted();
      health = await wire(`${root}/health`, { signal: AbortSignal.timeout(1000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      if (health) break; await new Promise(resolve => setTimeout(resolve, 250));
    }
    t.signal?.throwIfAborted();
    assert.equal(health?.version, 'v2.197.0');
    t.diagnostic(`production=${GOTRUE_IMAGE_TAG}; CI=${health.version}`);
    const auth = async (path, body, token) => {
      const res = await wire(`${root}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
      assert.ok(res.ok, `GoTrue ${path.split('?')[0]} status=${res.status}`);
      return res.status === 204 ? null : res.json();
    };
    const claims = Buffer.from(JSON.stringify({ role: 'anon', iss: 'supabase', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const unsigned = `${Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url')}.${claims}`;
    const anonKey = `${unsigned}.${createHmac('sha256', jwtSecret).update(unsigned).digest('base64url')}`;
    return { directory, pool, root, wire, auth, anonKey, databaseUrl: isolated.url, close };
  } catch {
    await close();
    throw new Error(`disposable_gotrue_setup_failed:${phase}`);
  }
}

export async function finishFlowFixture(t) {
  assert.equal(JSON.parse(readFileSync(new URL('../node_modules/oidc-provider/package.json', import.meta.url))).version, '9.12.2');
  const logs = [], responses = [], privateValues = [], cookies = new Map();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'])
    t.mock.method(console, method, (...args) => logs.push(format(...args)));
  let fixture, bootstrapping, runtime, server, loopback, edge, enabled = true, passwordSet = false;
  t.after(async () => {
    await bootstrapping?.catch(() => {});
    try {
      for (const s of [server, loopback]) if (s) { s.closeAllConnections(); await new Promise(resolve => s.close(resolve)); }
      if (edge && edge.exitCode === null && edge.signalCode === null) {
        const exited = new Promise(resolve => edge.once('exit', resolve)); edge.kill('SIGKILL'); await exited; }
    } finally {
      try { await runtime?.end(); if (passwordSet) await fixture.pool.query('ALTER ROLE commonswarm_oauth_runtime PASSWORD NULL'); }
      finally { await fixture?.close(); }
    }
  });
  bootstrapping = goTrueFixture(t);
  fixture = await bootstrapping;
  const { directory, pool, root, wire, auth } = fixture;
  const email = `finish-${randomUUID()}@example.test`, password = 'DUMMYPASSWORD-for-CI-42!';
  const signup = await auth('signup', { email, password }), userId = signup.user?.id ?? signup.id, workspace = randomUUID();
  await pool.query("INSERT INTO swarm.users(user_id,display_name) VALUES($1,'TEST human')", [userId]);
  await pool.query("INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES($1,'TEST Home',$2)", [workspace, userId]);
  await pool.query("INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, userId]);
  await pool.query("INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES($1,$2,'workspace')", [randomUUID(), workspace]);
  const runtimeUrl = new URL(fixture.databaseUrl); runtimeUrl.username = 'commonswarm_oauth_runtime'; runtimeUrl.password = 'DUMMYRUNTIME';
  await pool.query("ALTER ROLE commonswarm_oauth_runtime PASSWORD 'DUMMYRUNTIME'"); passwordSet = true;
  runtime = new Pool({ connectionString: runtimeUrl.href, max: 4 });
  const received = [];
  loopback = createServer((req, res) => { received.push(new URL(req.url, 'http://127.0.0.1')); res.end('TEST client received response'); });
  const listen = async s => { await new Promise(resolve => s.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${s.address().port}`; };
  const callback = `${await listen(loopback)}/callback`, clientId = `https://finish-${randomUUID()}.example/oauth.json`;
  const provider = await createMcpProvider({ adapter: createPostgresAdapter(runtime), registrationStore: createPostgresRegistrationStore(runtime),
    nativeLoopbackEnabled: true, findAccount: createProductionFindAccount(runtime),
    fetch: async () => Response.json({ client_id: clientId, client_name: 'TEST client', application_type: 'native',
      redirect_uris: [callback], response_types: ['code'], grant_types: ['authorization_code'], token_endpoint_auth_method: 'none' }),
    providerGrantResource: async id => (await runtime.query('SELECT resource FROM commonswarm_oauth.resolve_hosted_grant_status($1)', [id])).rows[0]?.resource,
    providerGrantActive: async id => (await runtime.query('SELECT active FROM commonswarm_oauth.resolve_hosted_grant_status($1)', [id])).rows[0]?.active === true });
  writeFileSync(`${directory}/edge.json`, JSON.stringify({ databaseUrl: fixture.databaseUrl, gotrueUrl: root,
    authOrigin: 'http://127.0.0.1:1', bridgeKey: 'DUMMYBRIDGE' }), { mode: 0o600 });
  edge = spawn('deno', ['run', '--quiet', '--no-check', '--allow-env', '--allow-read', '--allow-net=127.0.0.1,localhost,[::1]',
    new URL('./fixtures/oauth-edge.mjs', import.meta.url).pathname, `${directory}/edge.json`], { stdio: ['ignore', 'pipe', 'pipe'] });
  edge.stderr.on('data', chunk => logs.push(chunk.toString()));
  const edgeOrigin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge startup timeout')), 60000); let output = '';
    edge.stdout.on('data', chunk => { output += chunk; const port = /OAUTH_EDGE_PORT=(\d+)/u.exec(output)?.[1];
      if (port) { clearTimeout(timer); resolve(`http://127.0.0.1:${port}`); } });
    edge.once('error', () => { clearTimeout(timer); reject(new Error('edge startup failed')); });
    edge.once('exit', () => { clearTimeout(timer); reject(new Error('edge exited')); });
  });
  const bridge = async (path, body) => (await fetch(`${edgeOrigin}/${path}`, { method: 'POST',
    headers: { 'x-contract-bridge': 'DUMMYBRIDGE', 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
  let challenge, loginToken;
  const gotrue = createGoTrueClient({ pool: runtime, baseUrl: root, providers: ['google', 'github'], fetch: async (url, options) => {
    if (new URL(url).searchParams.get('grant_type') !== 'pkce') return wire(url, options);
    const body = JSON.parse(options.body);
    assert.equal(body.auth_code === 'DUMMYCODE' && createHash('sha256').update(body.code_verifier).digest('base64url') === challenge, true);
    const tokens = await auth('token?grant_type=password', { email, password }); loginToken = tokens.access_token;
    privateValues.push(loginToken, tokens.refresh_token); return Response.json({ access_token: loginToken });
  } });
  const store = new InteractionStore(runtime), finishStore = new FinishStore(runtime, { issuer: ISSUER, verifySession: async (browser, db) => {
    const live = await readGoTrueSession(db, { sessionId: browser.gotrue_session_id, userId: browser.user_id });
    return live !== null && live.interactiveAuthAtSeconds === Math.floor(new Date(browser.authenticated_at).getTime() / 1000);
  } });
  const finishFlow = createFinishFlow({ provider, store, finishStore }), logger = createLogger(line => logs.push(line));
  const handlers = [false, true].map(finishEnabled => createHandler({ provider, pool: runtime, logger, finishEnabled,
    finishFlow, publicAuthorizationEnabled: true, maxBodyBytes: 65536, interactionHandler: createInteractionHandler({ provider, store, gotrue,
      finishFlow: finishEnabled ? finishFlow : undefined, allowedOrigins: new Set([ISSUER]), callbackUrl: `${ISSUER}/oauth/callback/gotrue`,
      workspaceReader: identity => bridge('workspaces', identity), consentOrchestrator: createConsentOrchestrator({
        progress: createPostgresConsentProgress(runtime), command: (input, identity) => bridge('management', { input, identity }) }) }) }));
  server = createServer((req, res) => handlers[Number(enabled)](req, res)); const origin = await listen(server);
  const request = async (target, options = {}, drop = false) => {
    const u = new URL(target, ISSUER); assert.equal(u.origin === ISSUER, true, 'AS requests stay at issuer');
    const headers = { host: new URL(ISSUER).host, 'x-forwarded-host': new URL(ISSUER).host,
      'x-forwarded-proto': 'https', ...options.headers,
      cookie: [...cookies.values()].filter(c => u.pathname === c.path || u.pathname.startsWith(c.path.endsWith('/') ? c.path : `${c.path}/`)).map(c => c.pair).join('; ') };
    if (drop) return new Promise((resolve, reject) => { const req = httpRequest(`${origin}${u.pathname}${u.search}`, { headers }, res => {
      responses.push({ status: res.statusCode, headers: new Headers(res.headers), body: '', path: u.pathname });
      res.destroy(); resolve(); }); req.on('error', reject); req.end(); });
    const res = await fetch(`${origin}${u.pathname}${u.search}`, { ...options, headers, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    for (const value of res.headers.getSetCookie()) { const [pair, ...attrs] = value.split(';').map(x => x.trim());
      const path = attrs.find(x => /^path=/iu.test(x))?.slice(5) ?? '/', key = `${pair.split('=')[0]}:${path}`;
      if (attrs.some(x => /^max-age=0$/iu.test(x))) cookies.delete(key); else cookies.set(key, { pair, path }); }
    const response = { status: res.status, headers: res.headers, body: await res.text(), path: u.pathname };
    responses.push(response); return response;
  };
  return { request, pool, runtime, provider, responses, logs, privateValues, workspace, callback, clientId, received,
    issuer: ISSUER, resource: RESOURCE, setEnabled(value) { enabled = value; },
    resumeCookiesPresent: () => [provider.cookieName('resume'), `${provider.cookieName('resume')}.sig`]
      .every(name => [...cookies.values()].some(c => c.pair.startsWith(`${name}=`))),
    async signIn(path) { const res = await request(`${path}?provider=github`), u = new URL(res.headers.get('location'));
      challenge = u.searchParams.get('code_challenge'); const redirect = new URL(u.searchParams.get('redirect_to'));
      redirect.searchParams.set('code', 'DUMMYCODE'); return request(redirect); },
    logout: () => auth('logout?scope=global', {}, loginToken) };
}
