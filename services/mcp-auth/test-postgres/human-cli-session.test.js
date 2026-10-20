// Real-server owner for H's unknown-successor ceiling and immediate revocation.
// Authoring gate: protects transport loss/death against pinned GoTrue, which the
// p1-cli synthetic server cannot model. A cache/journal removal on base087 is a
// credible regression; server outcomes remain observations, never guessed rules.
// No product export, dependency, fake realm, clock change or expiry override.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { goTrueFixture } from './finish-flow-fixture.js';

const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const pause = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
const knownCodes = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found',
  'session_expired', 'bad_jwt', 'user_not_found', 'human_session_missing', 'human_session_transient', 'human_session_refresh_failed']);
const codeEnum = code => knownCodes.has(code) ? code : code ? 'other' : 'none';

// Check the actual daemon and this run's nested database before creating files,
// users, containers or databases. Environment markers alone are insufficient.
function requirePrivateNamespace() {
  assert.equal(process.platform, 'linux');
  assert.equal(process.env.CI, 'true');
  assert.equal(process.env.STANDALONE_CI, '1');
  assert.equal(/^csci-[a-f0-9]{32}$/u.test(process.env.CSCI_PROJECT ?? ''), true);
  assert.equal(process.env.DOCKER_HOST === 'tcp://127.0.0.1:2375', true);
  assert.equal(existsSync('/.dockerenv'), true);
  assert.equal(existsSync('/var/run/docker.sock'), false, 'worker must not mount a host Docker socket');
  const docker = args => {
    try { return execFileSync('docker', args, { encoding: 'utf8', stdio: 'pipe', timeout: 10000 }); }
    catch { throw new Error('private_namespace_inspection_failed'); }
  };
  const info = JSON.parse(docker(['info', '--format', '{{json .}}']));
  assert.match(info.Name, /^[a-f0-9]{12}$/u, 'nested daemon hostname required');
  assert.equal(info.Name === hostname(), false, 'worker shares network, not daemon identity');
  const name = `supabase_db_${process.env.CSCI_PROJECT}`;
  const [db] = JSON.parse(docker(['inspect', name]));
  assert.equal(db.Name === `/${name}` && db.State.Running === true, true);
  const bindings = db.NetworkSettings.Ports['5432/tcp'];
  assert.equal(Array.isArray(bindings) && bindings.length === 1 &&
    bindings[0].HostIp === '127.0.0.1' && bindings[0].HostPort === '54322', true, 'run-owned loopback database required');
}

async function childMain() {
  try {
    const config = JSON.parse(readFileSync(process.argv[3], 'utf8'));
    const { credentialStore } = await import('../../../src/cloud/storage.ts');
    const { refreshedCredential, logout, humanSessionFetch } = await import('../../../src/cloud/auth.ts');
    const { createClient } = await import('@supabase/supabase-js');
    const store = await credentialStore({ target: config.target, stateDirectory: config.stateDirectory,
      forceFile: true, warn: () => {} });
    if (config.mode === 'journal-death') {
      // Real process death at the existing public persistence boundary, after
      // production auth has durably published its real GoTrue response.
      store.write = async () => { process.kill(process.pid, 'SIGKILL'); await new Promise(() => {}); };
    }
    if (config.mode === 'logout') {
      process.stdout.write(JSON.stringify({ outcome: await logout(config.target, store, 'global') }));
      return;
    }
    const initial = await refreshedCredential(config.target, store);
    const sdk = createClient(config.target.url, config.target.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: humanSessionFetch(config.target, store, initial) },
    });
    const getUser = async () => {
      const result = await sdk.auth.getUser(initial.accessToken);
      return { outcome: result.data.user ? 'ok' : 'refused', status: result.error?.status ?? (result.data.user ? 200 : 0),
        code: codeEnum(result.error?.code), generation: (await store.read())?.generation ?? -1 };
    };
    if (config.mode === 'held-cache') {
      const probe = new Promise(resolve => process.once('message', resolve));
      process.send(await getUser());
      await probe;
    }
    process.stdout.write(JSON.stringify(await getUser()));
  } catch (error) {
    process.stdout.write(JSON.stringify({ outcome: 'failed', status: 0, code: codeEnum(error?.code) }));
  } finally { process.disconnect?.(); }
}

if (process.argv[2] === 'human-session-child') {
  await childMain();
} else {
const { test } = await import('node:test');
test('CI GoTrue: lost rotation, real CLI deadline, journal adoption and immediate cached-client revocation', {
  skip: process.env.CI === 'true' ? false : 'CI only: private disposable PostgreSQL/GoTrue namespace', timeout: 90000,
}, async t => {
  requirePrivateNamespace();
  let h, bootstrapping;
  const servers = new Set(), children = new Set(), failures = [];
  t.after(async () => {
    await bootstrapping?.catch(() => {});
    try {
      await Promise.all([...children].map(async handle => { handle.child.kill('SIGKILL'); await handle.done; }));
      const closed = await Promise.allSettled([...servers].map(async server => {
        server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
      }));
      assert.equal(closed.every(row => row.status === 'fulfilled'), true, 'proxy_cleanup_failed');
    } finally { await h?.close(); }
  });
  bootstrapping = goTrueFixture(t);
  h = await bootstrapping;
  const receipt = row => t.diagnostic(JSON.stringify(row));
  const requireReady = (name, ok) => { if (!ok) failures.push(name); };
  const family = async () => {
    // Separate generated users also isolate any account-wide server response to
    // token reuse. No sibling observation can revoke another lane's family.
    const identity = { email: `human-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') };
    await h.auth('signup', identity);
    return h.auth('token?grant_type=password', identity);
  };
  const counts = async session => {
    const id = JSON.parse(Buffer.from(session.access_token.split('.')[1], 'base64url')).session_id;
    assert.equal(typeof id === 'string' && /^[a-f0-9-]{36}$/iu.test(id), true, 'real session claim required');
    const result = await h.pool.query(`SELECT
      (SELECT count(*)::int FROM auth.sessions WHERE id=$1) AS sessions,
      count(*)::int AS tokens, count(*) FILTER (WHERE revoked)::int AS revoked
      FROM auth.refresh_tokens WHERE session_id=$1`, [id]);
    return result.rows[0];
  };
  const requestRefresh = async (origin, token) => {
    try {
      const response = await fetch(`${origin}/auth/v1/token?grant_type=refresh_token`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-supabase-api-version': '2024-01-01' },
        body: JSON.stringify({ refresh_token: token }), signal: AbortSignal.timeout(15000) });
      const body = await response.json().catch(() => null);
      return { status: response.status, code: codeEnum(body?.code ?? body?.error_code), session: response.ok ? body : null };
    } catch { return { status: 0, code: 'none', session: null }; }
  };
  const userStatus = async token => {
    const response = await h.wire(`${h.root}/user`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
    await response.arrayBuffer(); return response.status;
  };
  const proxy = async ({ fault = 'pass', faultAt = 1, outsideRetry = false } = {}) => {
    t.signal.throwIfAborted();
    const refreshes = [], logouts = [], users = [];
    let resolveFault;
    const faulted = new Promise(resolve => { resolveFault = resolve; });
    const server = createServer(async (req, res) => {
      res.on('error', () => {});
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        assert.equal(url.pathname.startsWith('/auth/v1/'), true);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const refresh = url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'refresh_token';
        const entry = { ingress: performance.now(), forwarded: 0, at: 0, status: 0 };
        let sequence = 0;
        if (refresh) {
          refreshes.push(entry); sequence = refreshes.length;
          if (outsideRetry && refreshes.length === 2) {
            // A real transport queue, not a clock/deadline change. Retain both
            // ingress and forwarding times; guarantee GoTrue sees the retry
            // beyond 10.15s even if the first upstream took a few milliseconds.
            await pause(refreshes[0].at + 10175 - performance.now());
          }
        }
        const headers = {};
        for (const key of ['authorization', 'apikey', 'content-type', 'x-supabase-api-version', 'x-request-id'])
          if (req.headers[key]) headers[key] = req.headers[key];
        entry.forwarded = performance.now();
        const response = await h.wire(`${h.root.replace(/\/auth\/v1$/u, '')}${url.pathname}${url.search}`, {
          method: req.method, headers, ...(req.method === 'GET' ? {} : { body: Buffer.concat(chunks) }),
          redirect: 'error', signal: AbortSignal.timeout(12000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        entry.status = response.status; entry.at = performance.now();
        if (url.pathname === '/auth/v1/logout') logouts.push(response.status);
        if (url.pathname === '/auth/v1/user') users.push(response.status);
        if (refresh && sequence === faultAt && fault !== 'pass') {
          // The observer privately owns this body; the CLI never receives it.
          resolveFault({ status: response.status, at: entry.at });
          if (fault === 'drop') res.destroy();
          return; // withhold: the actual CLI AbortSignal closes its connection.
        }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' });
        res.end(body);
      } catch { res.destroy(); }
    });
    servers.add(server);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    return { origin: `http://127.0.0.1:${server.address().port}`, refreshes, logouts, users, faulted };
  };
  const { credentialStore } = await import('../../../src/cloud/storage.ts');
  const { cloudTarget } = await import('../../../src/cloud/config.ts');
  const setup = async (session, wire, name) => {
    t.signal.throwIfAborted();
    const target = cloudTarget(wire.origin, h.anonKey), stateDirectory = join(h.directory, name);
    await mkdir(stateDirectory, { mode: 0o700 });
    const store = await credentialStore({ target, stateDirectory, forceFile: true, warn: () => {} });
    await store.withLock(async () => {
      await store.write({ version: 1, refreshToken: session.refresh_token, generation: 0, userId: session.user.id, deviceId: randomUUID() });
      await store.writeProfile({ version: 1, userId: session.user.id, workspaceId: null, pendingCommands: {} });
    });
    return { target, stateDirectory, store };
  };
  const start = (state, mode = 'refresh') => {
    t.signal.throwIfAborted();
    const configPath = join(h.directory, `child-${randomUUID()}.json`);
    writeFileSync(configPath, JSON.stringify({ target: state.target, stateDirectory: state.stateDirectory, mode }), { mode: 0o600 });
    const childEnv = { ...process.env }; delete childEnv.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, ['--import', rootRequire.resolve('tsx'), fileURLToPath(import.meta.url), 'human-session-child', configPath],
      { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env: childEnv, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let stdout = '', readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    child.on('message', row => readyResolve(row));
    child.stdout.on('data', chunk => { if (stdout.length < 4096) stdout += chunk; });
    child.stderr.resume(); // Never retain or forward dependency stderr/raw bodies.
    const handle = { child, ready };
    handle.done = new Promise(resolve => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 35000);
      let settled = false;
      const finish = (exit, signal) => {
        if (settled) return; settled = true; clearTimeout(timer); children.delete(handle);
        let row = { outcome: 'child_failed', status: 0, code: 'none' };
        try { if (stdout) row = JSON.parse(stdout); } catch { /* Sanitized process failure. */ }
        readyResolve(row); resolve({ ...row, exit, signal: signal ?? 'none' });
      };
      child.once('error', () => finish(-1, 'spawn_failed'));
      child.once('close', finish);
    });
    children.add(handle); return handle;
  };

  // All real-time reuse waits overlap; one bootstrap and fresh independent
  // families keep normal added runtime below 90s without changing any clock.
  const observations = ['inside', 'outside', 'parent_of_active', 'older_ancestor'].map(async name => {
    const session = await family(), further = name === 'parent_of_active' || name === 'older_ancestor';
    const wire = await proxy({ fault: 'drop', faultAt: further ? 2 : 1 });
    let retryToken = session.refresh_token;
    if (further) {
      const received = await requestRefresh(wire.origin, retryToken);
      assert.equal(received.status, 200, 'positive rotation control');
      if (name === 'parent_of_active') retryToken = received.session.refresh_token;
      const lost = await requestRefresh(wire.origin, received.session.refresh_token);
      assert.equal(lost.status, 0, 'successful rotation response must be lost');
    } else assert.equal((await requestRefresh(wire.origin, retryToken)).status, 0);
    assert.equal(wire.refreshes[further ? 1 : 0]?.status, 200, 'upstream loss control');
    const lost = await wire.faulted;
    assert.equal(lost.status, 200, 'loss must follow a real successful GoTrue rotation');
    const before = await counts(session);
    await pause(lost.at + (name === 'inside' ? 20 : 10200) - performance.now());
    const result = await requestRefresh(wire.origin, retryToken), retry = wire.refreshes.at(-1);
    const elapsed = retry.forwarded - lost.at;
    assert.equal(name === 'inside' ? elapsed < 10000 : elapsed >= 10150, true, 'measured reuse boundary');
    receipt({ case: name, status: result.status, code: result.code, retry_ms: Math.floor(elapsed),
      before, after: await counts(session), refresh_requests: wire.refreshes.length });
  });
  const awaitFault = (wire, handle) => Promise.race([wire.faulted,
    handle.done.then(() => { throw new Error('child_exited_before_observed_rotation'); })]);
  const recovery = async (name, fault, outsideRetry = false) => {
    const session = await family(), wire = await proxy({ fault, outsideRetry });
    const state = await setup(session, wire, name), child = start(state);
    const lost = await awaitFault(wire, child);
    assert.equal(lost.status, 200);
    const result = await child.done, retry = wire.refreshes[1];
    const elapsed = retry ? retry.forwarded - lost.at : 0;
    if (outsideRetry) assert.equal(elapsed >= 10150, true, 'first GoTrue retry outside 10.15s');
    const row = { case: name, outcome: result.outcome, status: result.status, code: result.code,
      generation: (await state.store.read())?.generation ?? -1, refresh_requests: wire.refreshes.length,
      retry_ingress_ms: retry ? Math.floor(retry.ingress - lost.at) : 0, retry_ms: Math.floor(elapsed),
      deadline_retry_ms: retry ? Math.floor(retry.ingress - wire.refreshes[0].ingress) : 0,
      elapsed_ms: Math.floor(performance.now() - wire.refreshes[0].ingress), after: await counts(session) };
    receipt(row);
    requireReady(name, result.exit === 0 && result.outcome === 'ok' && result.status === 200 && row.generation === 1);
    if (outsideRetry) requireReady('actual_cli_deadline', retry && retry.ingress - wire.refreshes[0].ingress >= 9900 &&
      retry.ingress - wire.refreshes[0].ingress <= 11000);
  };
  const restarts = async () => {
    const lostSession = await family(), lostWire = await proxy({ fault: 'withhold' });
    const lostState = await setup(lostSession, lostWire, 'parent-only'), dying = start(lostState);
    const lost = await awaitFault(lostWire, dying);
    assert.equal(lost.status, 200); dying.child.kill('SIGKILL');
    assert.equal((await dying.done).signal, 'SIGKILL');
    assert.equal((await lostState.store.readProfile()).humanSession === undefined, true, 'unseen response must never be injected into a journal');
    assert.equal((await lostState.store.read()).refreshToken === lostSession.refresh_token, true);
    const journalSession = await family(), journalWire = await proxy();
    const journalState = await setup(journalSession, journalWire, 'journal'), publishing = start(journalState, 'journal-death');
    assert.equal((await publishing.done).signal, 'SIGKILL');
    assert.equal(Boolean((await journalState.store.readProfile()).humanSession?.successor), true, 'production must publish the actual successor');
    assert.equal((await journalState.store.read()).refreshToken === journalSession.refresh_token, true);
    await pause(Math.max(lost.at, journalWire.refreshes[0].at) + 10200 - performance.now());
    const unknown = await start(lostState).done, published = await start(journalState).done;
    const afterJournal = await journalState.store.readProfile();
    receipt({ case: 'parent_only_restart', outcome: unknown.outcome, status: unknown.status, code: unknown.code,
      refresh_requests: lostWire.refreshes.length, retry_ms: Math.floor(lostWire.refreshes[1].forwarded - lost.at), after: await counts(lostSession) });
    receipt({ case: 'published_journal_restart', outcome: published.outcome, status: published.status,
      refresh_requests: journalWire.refreshes.length, generation: (await journalState.store.read())?.generation ?? -1,
      journal_count: afterJournal.humanSession?.successor ? 1 : 0, after: await counts(journalSession) });
    requireReady('parent_only_restart', unknown.exit === 0 && unknown.outcome === 'ok' && unknown.status === 200);
    requireReady('published_journal_restart', published.exit === 0 && published.outcome === 'ok' && published.status === 200 &&
      journalWire.refreshes.length === 1 && (await journalState.store.read()).generation === 1 && !afterJournal.humanSession?.successor);
  };
  // Observe every lane before making readiness assertions. One refusal must not
  // hide unrelated server evidence or leave sibling work running past cleanup.
  const lanes = await Promise.allSettled([...observations, recovery('lost_response_inside', 'drop'),
    recovery('actual_10s_timeout', 'withhold', true), restarts()]);
  const laneNames = ['inside', 'outside', 'parent_of_active', 'older_ancestor', 'lost_response_inside', 'actual_10s_timeout', 'restarts'];
  for (const [index, lane] of lanes.entries()) if (lane.status === 'rejected') {
    receipt({ case: laneNames[index], outcome: 'setup_or_assertion_failed' }); failures.push(laneNames[index]);
  }

  t.signal.throwIfAborted();
  // Global logout runs last, after every independent family observation.
  const session = await family(), wire = await proxy(), state = await setup(session, wire, 'revocation');
  const cached = start(state, 'held-cache'), positive = await cached.ready;
  requireReady('getUser_positive_control', positive.status === 200 && positive.outcome === 'ok');
  const saved = await state.store.read(), cache = (await state.store.readProfile()).humanSession;
  assert.equal(Boolean(cache?.accessToken), true, 'actual CLI cache required');
  const positiveRaw = await userStatus(cache.accessToken), before = await counts(session);
  const loggedOut = await start(state, 'logout').done;
  const afterLogout = await userStatus(cache.accessToken);
  cached.child.send('probe', () => {});
  const cachedAfter = await cached.done;
  const oldRefresh = await requestRefresh(wire.origin, saved.refreshToken), after = await counts(session);
  receipt({ case: 'logout_cached_getUser', outcome: loggedOut.outcome, logout_status: wire.logouts.at(-1) ?? 0,
    positive_status: positiveRaw, cached_access_status: afterLogout, cached_client_status: cachedAfter.status,
    cached_client_user_requests: wire.users.length, cached_client_positive_status: wire.users[0] ?? 0,
    old_refresh_status: oldRefresh.status, old_refresh_code: oldRefresh.code, before, after,
    credential_count: await state.store.read() ? 1 : 0, cache_count: (await state.store.readProfile()).humanSession ? 1 : 0 });
  requireReady('real_logout', loggedOut.outcome === 'revoked' && wire.logouts.at(-1) === 204);
  requireReady('immediate_server_revocation', positiveRaw === 200 && afterLogout >= 400 && afterLogout < 500);
  requireReady('cached_client_refusal', cachedAfter.outcome === 'refused' && cachedAfter.status >= 400 && cachedAfter.status < 500 &&
    wire.users.length === 2 && wire.users[0] === 200 && wire.users[1] === cachedAfter.status);
  requireReady('old_refresh_refusal', oldRefresh.status >= 400 && oldRefresh.status < 500);
  requireReady('session_and_local_revocation', after.sessions === 0 && await state.store.read() === null &&
    !(await state.store.readProfile()).humanSession);
  receipt({ case: 'H_readiness', outcome: failures.length ? 'failed_backend_or_H_SCR_required' : 'ready', failures: failures.length });
  assert.deepEqual(failures, [], 'H requires actual silent recovery and immediate revocation; backend/H SCR required on failure');
});
}
