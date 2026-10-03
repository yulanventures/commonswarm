import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, chmod, stat, lstat, symlink, link, rm, unlink } from 'node:fs/promises';
import { join, dirname, sep, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const script = fileURLToPath(new URL('../scripts/live-ordinary-controls.mjs', import.meta.url));
const preload = 'data:text/javascript;base64,' + Buffer.from((await readFile(new URL('./support/live-ordinary-controls-transport.mjs', import.meta.url), 'utf8'))
  .replace("'https://commonswarm.com'", "'https://yulanventures.com'")).toString('base64');
const issuer = 'https://mcp.commonswarm.com', api = 'https://api.commonswarm.com';
const client = 'https://yulanventures.com/oauth/c1-controls/client.json';
const redirect = 'https://c1-controls.invalid/callback', resource = `${issuer}/mcp`;
const release = 'a'.repeat(40), scope = 'openid offline_access mcp';
const tools = ['claim_seat', 'whoami', 'members', 'ask', 'check', 'reply', 'note', 'working_on'];
const hash = b => createHash('sha256').update(b).digest('hex');
const b64hash = b => createHash('sha256').update(b).digest('base64url');
const uid = '11111111-1111-4111-8111-111111111111', wid = 'c2ea0541-f56d-4c73-bf71-56c5405c4934';
const pid = '33333333-3333-4333-8333-333333333333';
const keys = (v, names) => assert.deepEqual(Object.keys(v).sort(), [...names].sort());
const privateWrite = (p, b) => writeFile(p, typeof b === 'string' ? b : JSON.stringify(b), { mode: 0o600 });
async function missing(p) { await assert.rejects(lstat(p), { code: 'ENOENT' }); }

// The fixture checks the wire independently: PKCE, code single-use, refresh
// rotation/replay/family fencing, bearer use, CLI note ordering and tenancy.
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'anvil-secret.')); await chmod(root, 0o700);
  const creds = join(root, 'credentials'), human = join(root, 'human'), seat = join(root, 'seat');
  for (const dir of [creds, human, seat]) await mkdir(dir, { mode: 0o700 });
  const clientTimes = new Map();
  const secrets = [], clients = new Set(), families = new Map(), codes = new Map(), access = new Set(), events = [], violations = [];
  const secret = () => { const s = randomBytes(32).toString('base64url'); secrets.push(s); return s; };
  const seatToken = `swm_agt_${secret()}`, anon = secret(); let humanRefresh = secret();
  const clientMetadata = { client_id: client, client_name: 'CommonSwarm C1 ordinary controls', client_uri: 'https://yulanventures.com',
    application_type: 'web', redirect_uris: [redirect], token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope };
  const emit = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(body === null ? undefined : JSON.stringify(body));
  };
  const token = (res, f) => {
    const a = secret(), r = secret(); access.add(a); families.set(r, { family: f, consumed: false });
    return emit(res, 200, { token_type: 'Bearer', access_token: a, refresh_token: r, expires_in: 300, scope: 'mcp', ignored_cookie: secret() });
  };
  let signal;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers['user-agent'], 'curl/8.7.1');
      const url = new URL(req.url, issuer), chunks = [];
      for await (const b of req) chunks.push(b);
      const raw = Buffer.concat(chunks).toString('utf8');
      const p = req.headers['content-type']?.startsWith('application/x-www-form-urlencoded') ? new URLSearchParams(raw) : null;
      const body = raw && !p ? JSON.parse(raw) : null;
      const event = { at: Date.now(), path: url.pathname, method: req.method, grant: p?.get('grant_type'), client: p?.get('client_id'), rpc: body?.method, command: body?.command?.kind }; events.push(event);
      if (config.failPath === url.pathname) return emit(res, 500, { error: secret() });
      if (url.pathname === '/.well-known/oauth-authorization-server') return emit(res, 200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, registration_endpoint: `${issuer}/reg`,
        code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'offline_access', 'mcp'],
        ...(config.rfcRevoke ? { revocation_endpoint: `${issuer}/revoke` } : {}),
      });
      if (url.pathname === '/.well-known/oauth-protected-resource/mcp') return emit(res, 200, { resource, authorization_servers: [issuer], scopes_supported: ['mcp'] });
      if (url.pathname === '/oauth/c1-controls/client.json') return emit(res, 200, config.badMetadata ? { ...clientMetadata, dpop_bound_access_tokens: true } : clientMetadata);
      if (url.pathname === '/reg') {
        assert.equal(req.method, 'POST'); assert.equal(body.token_endpoint_auth_method, 'none');
        assert.deepEqual(body.redirect_uris, [redirect]); assert.deepEqual(body.grant_types, ['authorization_code', 'refresh_token']);
        assert.equal(body.scope, scope);
        const id = config.duplicateRegistration ? [...clients][0] : randomBytes(24).toString('base64url'); clients.add(id); clientTimes.set(id, event.at);
        return emit(res, 201, { ...body, client_id: id, ...(config.badRegistration ? { token_endpoint_auth_method: 'client_secret_basic' } : {}) });
      }
      if (url.pathname === '/authorize') {
        assert.equal(url.searchParams.get('resource'), resource); assert.equal(url.searchParams.get('scope'), scope);
        assert.equal(url.searchParams.get('redirect_uri'), redirect); assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(url.searchParams.get('response_type'), 'code'); assert.equal(url.searchParams.get('prompt'), 'consent');
        if (url.searchParams.get('client_id') !== client && !clients.has(url.searchParams.get('client_id'))) {
          if (config.expiryHTML) { res.writeHead(400, { 'Content-Type': 'text/html' }); return res.end('<pre><strong>error</strong>: invalid_client</pre>'); }
          return emit(res, 400, { error: 'invalid_client' });
        }
        if (config.authorizeError) return emit(res, 400, { error: 'invalid_request' });
        res.writeHead(config.badRedirect ? 302 : 303, { location: `${issuer}/interaction/${randomBytes(12).toString('hex')}`, 'set-cookie': `session=${secret()}; HttpOnly` }); return res.end();
      }
      if (url.pathname === '/token') {
        assert.equal(req.method, 'POST'); assert.equal(p.get('resource'), resource);
        if (config.hangToken) return;
        const id = p.get('client_id');
        if (p.get('grant_type') === 'authorization_code') {
          const c = codes.get(p.get('code')); assert.ok(c, 'callback code was approved');
          assert.equal(c.clientId, id); assert.equal(p.get('redirect_uri'), redirect);
          assert.equal(b64hash(p.get('code_verifier')), c.challenge); secrets.push(p.get('code_verifier')); codes.delete(p.get('code'));
          event.family = { clientId: id, revoked: false };
          if (id !== client) clientTimes.set(id, event.at);
          return token(res, event.family);
        }
        assert.equal(p.get('grant_type'), 'refresh_token'); const stored = families.get(p.get('refresh_token'));
        if (!stored || stored.family.revoked) { event.rejected = true; event.family = stored?.family;
          return emit(res, config.proofStatus200 ? 200 : 400, { error: config.wrongRejection ? 'invalid_request' : 'invalid_grant' }); }
        assert.equal(stored.family.clientId, id); event.family = stored.family;
        if (stored.consumed) { if (!config.replayLies) stored.family.revoked = true;
          event.rejected = true; return emit(res, 400, { error: config.wrongRejection ? 'invalid_request' : 'invalid_grant' }); }
        stored.consumed = true; return token(res, stored.family);
      }
      if (url.pathname === '/revoke') {
        const stored = families.get(p.get('token')); assert.ok(stored); assert.equal(stored.family.clientId, p.get('client_id'));
        if (!config.revokeLies) stored.family.revoked = true;
        return emit(res, 204, null);
      }
      if (url.pathname === '/mcp') {
        assert.ok(access.has(req.headers.authorization?.slice(7))); assert.equal(body.jsonrpc, '2.0');
        if (body.method === 'notifications/initialized') return emit(res, 202, null);
        let result;
        if (body.method === 'initialize') {
          assert.equal(body.params.clientInfo.name, 'c1-live-controls'); result = { protocolVersion: '2025-06-18', serverInfo: { name: 'commonswarm' } };
        } else if (body.method === 'tools/call') {
          assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
          assert.equal(body.params.name, 'claim_seat');
          assert.deepEqual(body.params.arguments, { workspace_id: wid, name: 'c1-controls-runner',
            request_id: `c1_controls_claim_${hash(`${release}:${wid}:c1-controls-runner`).slice(0, 40)}` });
          event.claim = body.params.arguments;
          result = { ...(config.claimError ? { isError: true } : {}),
            content: [{ type: 'text', text: JSON.stringify({ workspace_id: config.wrongClaimWorkspace ? randomUUID() : wid, name: 'c1-controls-runner',
              seat_id: '44444444-4444-4444-8444-444444444444', handle: config.badClaimHandle ? 'unsafe' : 'seat_' + 'a'.repeat(32) }) }] };
        } else {
          assert.equal(body.method, 'tools/list'); assert.equal(req.headers['mcp-protocol-version'], '2025-06-18');
          result = { tools: (config.badTools ? tools.slice(1) : tools).map(name => ({ name })) };
        }
        return emit(res, 200, { jsonrpc: '2.0', id: body.id, result });
      }
      if (url.pathname === '/auth/v1/token') {
        if (config.holdHuman) await config.holdHuman;
        assert.equal(url.searchParams.get('grant_type'), 'refresh_token'); assert.equal(body.refresh_token, humanRefresh); assert.equal(req.headers.apikey, anon);
        const now = new Date().toISOString(); humanRefresh = secret(); return emit(res, 200, { access_token: secret(), refresh_token: humanRefresh, token_type: 'bearer', expires_in: 3600,
          user: { id: uid, aud: 'authenticated', role: 'authenticated', email: 'fixture@example.test', app_metadata: {}, user_metadata: {}, identities: [], created_at: now } });
      }
      if (url.pathname === '/rest/v1/workspaces') {
        assert.equal(req.headers.apikey, anon); assert.equal(req.headers['accept-profile'], 'swarm_read');
        assert.equal(url.searchParams.get('workspace_id'), `eq.${wid}`);
        return emit(res, 200, [{ workspace_id: config.wrongWorkspace ? randomUUID() : wid, name: 'Cold Agent Test 0.1.12' }]);
      }
      if (url.pathname === '/functions/v1/read') {
        assert.equal(req.headers.authorization, `Bearer ${seatToken}`); assert.equal(req.headers.apikey, anon); assert.equal(body.workspace_id, wid);
        if (body.resource === 'members') return emit(res, 200, { members: [], agents: [], identity: {
          credential_valid: true, workspace_id: config.wrongSeat ? randomUUID() : wid, principal_id: pid, owner_user_id: uid,
          workspace_name: 'Cold Agent Test 0.1.12',
        } });
        assert.equal(body.resource, 'signals'); assert.ok(signal, 'write precedes read');
        return emit(res, 200, { signals: config.noReadback ? [] : [signal] });
      }
      if (url.pathname === '/functions/v1/command') {
        assert.equal(req.headers.authorization, `Bearer ${seatToken}`); assert.equal(body.workspace_id, wid);
        assert.equal(body.command.kind, 'post_signal'); assert.equal(body.command.signal_kind, 'note'); assert.match(body.command.body, /^C1 ordinary control W[1-7]\//);
        assert.deepEqual(body.stream, { kind: 'workspace' }); assert.equal(body.command.to_user_id, null); assert.equal(body.command.to_agent_principal_id, null);
        signal = { id: randomUUID(), workspace_id: wid, from: pid, from_kind: 'agent', to: null, to_agent: null, in_reply_to: null, about: null,
          kind: 'note', body: body.command.body, until: new Date(Date.now() + 60000).toISOString(), created_at: new Date().toISOString() };
        return emit(res, 200, { status: 'accepted', ok: true, event_ids: [], signal });
      }
      throw new Error('unexpected wire request');
    } catch { violations.push({ path: req.url.split('?')[0], reason: 'wire contract failure' }); emit(res, 500, { error: 'fixture_contract_violation' }); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r));
    assert.deepEqual(violations, [], 'independent wire contract');
    assert.ok(root.startsWith(join(realpathSync(tmpdir()), 'anvil-secret.')));
    assert.equal(realpathSync(root), root, 'cleanup stays at the test-owned mkdtemp root');
    await rm(root, { recursive: true }); });
  const profileId = hash(api).slice(0, 24);
  await privateWrite(join(human, 'target.json'), { url: api, anon_key: anon });
  await privateWrite(join(human, `${profileId}.json`), { version: 1, refreshToken: humanRefresh, generation: 0, deviceId: randomUUID(), userId: uid });
  await privateWrite(join(human, `${profileId}.profile.json`), { version: 1, userId: uid, workspaceId: wid, pendingCommands: {} });
  await privateWrite(join(seat, 'profile.json'), { version: 1, url: api, anon_key: anon, workspace_id: wid, principal_id: pid, credential_file: join(seat, 'credential.json') });
  await privateWrite(join(seat, 'credential.json'), { message: 'Agent credential minted. It is bound to this run, so the agent\'s work is attributable to it.',
    status: 'accepted', principal_id: pid, token_id: randomUUID(), run_id: randomUUID(), agent_token: seatToken });
  let sequence = 0;
  async function run(command, extra = [], { handoff = true, outName, workspaceId = wid, credDir = creds, env = {} } = {}) {
    const pointer = join(root, `pointers${sequence++}`); await mkdir(pointer, { mode: 0o700 });
    const out = outName ?? join(root, `receipt${sequence}.json`);
    const args = command === 'consent' ? ['consent', '--phase', 'pre-W1', '--pointer-dir', pointer] :
      command === 'final-cleanup' ? ['final-cleanup', '--consent-receipt', f.consent] : ['window', '--phase', 'before', '--window', 'W1', '--window-id', 'ABC123', '--consent-receipt', f.consent, '--human-profile', human, '--seat-profile', seat];
    // Overrides replace their original pair, so the runner still tests duplicate refusal.
    for (let i = 0; i < extra.length; i++) { const arg = extra[i]; const n = args.indexOf(arg);
      if (n >= 0) args.splice(n, 2);
      args.push(arg); if (arg !== '--dry-run') args.push(extra[++i]); }
    const child = spawn(process.execPath, ['--import', preload, script, ...args, ...(command === 'final-cleanup' || workspaceId === null ? [] : ['--workspace-id', workspaceId]), '--release-sha', release, '--cred-dir', credDir, '--out', out,
      '--request-timeout-ms', '1000', '--consent-timeout-ms', '2000', '--total-timeout-ms', '12000'], { env: { ...process.env, LIVE_CONTROLS_FIXTURE_ORIGIN: origin, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', done = false, handoffError;
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const completed = new Promise((r, j) => { child.once('error', j); child.once('exit', code => { done = true; r(code); }); });
    const handoffs = (async () => {
      if (command !== 'consent' || !handoff) return;
      for (const name of ['cimd', 'dcr']) {
        const path = join(pointer, `${name}-authorize-url.txt`); let a;
        while (!done) {
          try {
            const text = (await readFile(path, 'utf8')).trim();
            if (!text) { await sleep(10); continue; }
            a = new URL(text); break;
          }
          catch (e) { if (e.code !== 'ENOENT') throw e; await sleep(10); }
        }
        if (!a) break;
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        const code = secret(); codes.set(code, { clientId: a.searchParams.get('client_id'), challenge: a.searchParams.get('code_challenge') });
        const cb = new URL(redirect); cb.search = new URLSearchParams({ code, state: config.wrongState ? secret() : a.searchParams.get('state'), iss: issuer });
        await writeFile(join(pointer, `${name}-callback-url.txt`), cb.href, { mode: config.unsafeCallback ? 0o644 : 0o600 });
      }
    })().catch(e => { handoffError = e; child.kill(); });
    const exit = await completed; await handoffs; if (handoffError) throw handoffError;
    for (const value of secrets) assert.ok(!output.includes(value), 'no secret in process output');
    let receipt, bytes;
    try { bytes = await readFile(out); receipt = JSON.parse(bytes); for (const value of secrets) assert.ok(!bytes.includes(Buffer.from(value)), 'no secret in receipt'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    let report;
    try { const reportBytes = await readFile(`${out}.report.json`); report = JSON.parse(reportBytes);
      for (const value of secrets) assert.ok(!reportBytes.includes(Buffer.from(value)), 'no secret in run report'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    return { exit, output, receipt, bytes, out, pointer, report };
  }
  const f = { root, creds, human, seat, clients, clientTimes, families, config, events, run, consent: undefined };
  return f;
}

function consentSchema(r, phase, producer) {
  keys(r, ['kind', 'release_sha', 'consent_phase', 'measured_at', 'producer_sha256', 'controls', 'dcr_client_ids', 'cleanup']);
  assert.equal(r.kind, 'c1-consent'); assert.equal(r.release_sha, release); assert.equal(r.consent_phase, phase);
  assert.equal(r.producer_sha256, producer); assert.equal(new Date(r.measured_at).toISOString(), r.measured_at);
  assert.ok(Date.parse(r.measured_at) <= Date.now()); assert.deepEqual(r.controls, { cimd_consent: true, dcr_registration_consent: true });
  assert.equal(r.dcr_client_ids.length, 1); assert.match(r.dcr_client_ids[0], /^[A-Za-z0-9_-]{24,200}$/);
  if (phase === 'pre-W1') assert.equal(r.cleanup, null);
  else { keys(r.cleanup, ['grants_revoked', 'dcr_clients_expiring']); assert.equal(r.cleanup.grants_revoked, true);
    assert.ok(r.cleanup.dcr_clients_expiring.length > 0);
    for (const c of r.cleanup.dcr_clients_expiring) {
      keys(c, ['client_id', 'expires_after']); assert.equal(typeof c.client_id, 'string');
      assert.ok(!r.dcr_client_ids.includes(c.client_id));
      assert.equal(new Date(c.expires_after).toISOString(), c.expires_after); assert.ok(Date.parse(c.expires_after) > Date.now());
    }
  }
}
async function pre(f) {
  const r = await f.run('consent'); assert.equal(r.exit, 0, r.output); f.consent = r.out; return r;
}

test('executable produces exact consent/live bytes with real PKCE, rotating refresh, CLI file persistence and synthetic readback', async t => {
  const f = await fixture(t), p = await pre(f), producer = hash(await readFile(script));
  consentSchema(p.receipt, 'pre-W1', producer); assert.equal((await stat(p.out)).mode & 0o777, 0o600);
  assert.equal(p.bytes.toString(), JSON.stringify(p.receipt, null, 2) + '\n');
  let generation = 0;
  for (const [window, phase] of [['W1', 'before'], ['W2', 'after'], ['W3', 'recovery']]) {
    const r = await f.run('window', ['--window', window, '--phase', phase]); assert.equal(r.exit, 0, r.output);
    keys(r.receipt, ['release_sha', 'window_id', 'window', 'phase', 'controls', 'consent_receipt_sha256', 'producer_sha256', 'dcr_client_ids']);
    assert.deepEqual(r.receipt.controls, { hosted_mcp_consent_refresh: true, dcr_registration_consent: true, cimd_consent: true, human_recovery: true, worker_command_read: true });
    assert.equal(r.receipt.release_sha, release); assert.equal(r.receipt.window_id, 'ABC123'); assert.equal(r.receipt.window, window); assert.equal(r.receipt.phase, phase);
    assert.equal(r.receipt.consent_receipt_sha256, hash(p.bytes)); assert.equal(r.receipt.producer_sha256, producer);
    assert.equal(r.receipt.dcr_client_ids.length, 1); assert.equal((await stat(r.out)).mode & 0o777, 0o600);
    assert.equal(r.bytes.toString(), JSON.stringify(r.receipt, null, 2) + '\n');
    assert.equal((await stat(`${r.out}.report.json`)).mode & 0o777, 0o600);
    assert.equal(r.report.workspace_id, wid);
    assert.deepEqual(r.report.seat, { name: 'c1-controls-runner',
      request_id: `c1_controls_claim_${hash(`${release}:${wid}:c1-controls-runner`).slice(0, 40)}`,
      seat_id: '44444444-4444-4444-8444-444444444444', handle: 'seat_' + 'a'.repeat(32) });
    for (const name of ['live-controls-state.json', 'dcr-client-ids.json']) assert.equal((await stat(join(f.creds, name))).mode & 0o777, 0o600);
    const record = JSON.parse(await readFile(join(f.human, `${hash(api).slice(0, 24)}.json`))); assert.equal(record.generation, ++generation);
    const ids = JSON.parse(await readFile(join(f.creds, 'dcr-client-ids.json'))); assert.deepEqual(ids.ids.map(c => c.client_id), [...f.clients]);
  }
  assert.equal(f.events.filter(e => e.command === 'post_signal').length, 3);
  assert.equal(f.events.filter(e => e.claim).length, 3);
  assert.equal(new Set(f.events.filter(e => e.claim).map(e => e.claim.request_id)).size, 1, 'claim replay uses the same request id across windows');
  await missing(join(f.human, 'live-controls.lock'));
});

test('dry-run of all subcommands makes zero requests and writes no files', async t => {
  const f = await fixture(t); f.consent = join(f.root, 'nonexistent-consent');
  for (const command of ['consent', 'window', 'final-cleanup']) {
    const r = await f.run(command, ['--dry-run']); assert.equal(r.exit, 0, r.output); await missing(r.out);
    const plan = JSON.parse(r.output); assert.equal(plan.dry_run, true); assert.equal(plan.user_agent, 'curl/8.7.1'); assert.ok(plan.requests.length >= 4);
  }
  assert.equal(f.events.length, 0);
});

test('timeout defaults allow two 25-minute consent legs and CLI overrides stay bounded', async t => {
  const root = join(realpathSync(tmpdir()), 'live-controls-timeout-dry-run');
  for (const command of ['consent', 'window', 'final-cleanup']) await t.test(command, () => {
    const args = [command, '--dry-run', '--release-sha', release, '--cred-dir', root, '--out', join(root, 'receipt.json')];
    if (command !== 'final-cleanup') args.push('--workspace-id', wid);
    if (command === 'consent') args.push('--phase', 'pre-W1', '--pointer-dir', root);
    else {
      args.push('--consent-receipt', join(root, 'consent.json'));
      if (command === 'window') args.push('--phase', 'before', '--window', 'W1', '--window-id', 'ABC123', '--human-profile', root, '--seat-profile', root);
    }
    const run = extra => {
      const r = spawnSync(process.execPath, [script, ...args, ...extra], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(r.error); assert.equal(r.signal, null); return r;
    };
    const defaults = run([]); assert.equal(defaults.status, 0, defaults.stderr);
    const plan = JSON.parse(defaults.stdout);
    assert.equal(plan.request_timeout_ms, 10_000);
    assert.equal(plan.consent_timeout_ms, 1_500_000);
    assert.equal(plan.total_timeout_ms, 3_300_000);
    assert.ok(plan.total_timeout_ms > 2 * plan.consent_timeout_ms, 'total leaves time for requests after both consent legs');
    for (const [option, field, max] of [
      ['request-timeout-ms', 'request_timeout_ms', 10_000],
      ['consent-timeout-ms', 'consent_timeout_ms', 1_500_000],
      ['total-timeout-ms', 'total_timeout_ms', 3_300_000],
    ]) {
      for (const value of [1, max]) {
        const r = run([`--${option}`, String(value)]); assert.equal(r.status, 0, r.stderr);
        assert.equal(JSON.parse(r.stdout)[field], value);
      }
      const refused = run([`--${option}`, String(max + 1)]);
      assert.equal(refused.status, 1); assert.equal(refused.stdout, '');
      assert.match(refused.stderr, /FAIL options:.*bounded positive timeout.*invalid timeout/);
    }
  });
});

test('consent and window require a valid workspace UUID even for dry-run', async t => {
  const f = await fixture(t); f.consent = join(f.root, 'nonexistent-consent');
  for (const command of ['consent', 'window']) {
    const positive = await f.run(command, ['--dry-run']); assert.equal(positive.exit, 0, positive.output);
    for (const workspaceId of [null, 'bad', '00000000-0000-0000-0000-000000000000', '00000000-0000-4000-8000-000000000000']) {
      const r = await f.run(command, ['--dry-run'], { workspaceId });
      assert.equal(r.exit, 1, r.output); await missing(r.out);
      assert.match(r.output, workspaceId === null ? /FAIL options:.*missing option/ : /FAIL options:.*invalid --workspace-id/);
    }
  }
  assert.equal(f.events.length, 0);
});

test('selected workspace must match both supplied CLI profiles before any writes', async t => {
  const f = await fixture(t); await pre(f); const start = f.events.length;
  const r = await f.run('window', [], { workspaceId: randomUUID() });
  assert.equal(r.exit, 1, r.output); assert.match(r.output, /FAIL profiles:/); await missing(r.out);
  assert.ok(f.events.slice(start).every(e => e.method === 'GET' && e.path.includes('.well-known')));
});

test('seat claim failures withhold receipts and a later failure retains the private setup report', async t => {
  for (const config of [{ claimError: true }, { wrongClaimWorkspace: true }, { badClaimHandle: true }, { noReadback: true }]) {
    const f = await fixture(t); await pre(f); Object.assign(f.config, config);
    const r = await f.run('window'); assert.equal(r.exit, 1, r.output); await missing(r.out);
    assert.match(r.output, config.noReadback ? /FAIL worker_command_read:/ : /FAIL seat_setup:/);
    if (config.noReadback) {
      assert.equal(r.report.seat.name, 'c1-controls-runner'); assert.equal(r.report.workspace_id, wid);
      assert.equal((await stat(`${r.out}.report.json`)).mode & 0o777, 0o600);
    } else { await missing(`${r.out}.report.json`); assert.ok(!f.events.some(e => e.command === 'post_signal')); }
  }
});

test('human profile runs serialize across credential directories and retain the caller PATH', async t => {
  const f = await fixture(t); await pre(f);
  const otherCreds = join(f.root, 'other-credentials'), bin = join(f.root, 'bin'), log = join(f.root, 'path.jsonl');
  for (const dir of [otherCreds, bin]) await mkdir(dir, { mode: 0o700 });
  for (const name of ['live-controls-state.json', 'dcr-client-ids.json']) await privateWrite(join(otherCreds, name), await readFile(join(f.creds, name), 'utf8'));
  const located = spawnSync('which', ['rm'], { encoding: 'utf8' }); assert.equal(located.status, 0);
  const guardedRm = located.stdout.trim(); assert.ok(guardedRm.startsWith('/'));
  await writeFile(join(bin, 'rm'), `#!${process.execPath}\n` +
    `const {appendFileSync}=require('node:fs'); const {execFileSync}=require('node:child_process');\n` +
    `appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),path:process.env.PATH})+'\\n',{mode:0o600});\n` +
    `execFileSync(${JSON.stringify(guardedRm)},process.argv.slice(2),{stdio:'inherit'});\n`, { mode: 0o700 });
  const callerPath = `${bin}${delimiter}${process.env.PATH}`, env = { PATH: callerPath };
  let releaseHuman; f.config.holdHuman = new Promise(r => { releaseHuman = r; });
  const firstRun = f.run('window', [], { env });
  let first;
  try {
    const end = Date.now() + 3000;
    while (!f.events.some(e => e.path === '/auth/v1/token') && Date.now() < end) await sleep(10);
    assert.ok(f.events.some(e => e.path === '/auth/v1/token'), 'first run entered human refresh');
    const start = f.events.length;
    const refused = await f.run('window', [], { credDir: otherCreds, env });
    assert.equal(refused.exit, 1, refused.output); assert.match(refused.output, /FAIL files:.*existing path/);
    await missing(refused.out); assert.equal(f.events.length, start, 'overlap refuses before HTTP');
    assert.equal((await stat(join(f.human, 'live-controls.lock'))).mode & 0o777, 0o600, 'first run still owns profile lock');
  } finally { releaseHuman(); first = await firstRun; }
  assert.equal(first.exit, 0, first.output);
  assert.equal(f.events.filter(e => e.path === '/auth/v1/token').length, 1);
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.length >= 3); assert.ok(calls.every(c => c.path === callerPath));
  assert.ok(calls.some(c => c.args[0] === join(f.human, 'live-controls.lock')));
  for (const dir of [f.human, f.creds, otherCreds]) await missing(join(dir, 'live-controls.lock'));
  const next = await f.run('window', [], { env }); assert.equal(next.exit, 0, next.output);
});

test('every failed window leg withholds the entire receipt and redacts remote failures', async t => {
  for (const [control, config] of [
    ['hosted_mcp_consent_refresh', { failPath: '/mcp' }], ['dcr_registration_consent', { badRegistration: true }], ['dcr_registration_consent', { duplicateRegistration: true }],
    ['cimd_consent', { badRedirect: true }], ['human_recovery', { wrongWorkspace: true }], ['worker_command_read', { noReadback: true }],
  ]) await t.test(`${control} (${Object.keys(config)[0]})`, async t => {
    const f = await fixture(t), p = await pre(f); Object.assign(f.config, config);
    const r = await f.run('window'); assert.equal(r.exit, 1, r.output); assert.match(r.output, new RegExp(`FAIL ${control}:`)); await missing(r.out);
    assert.ok(p.receipt.controls.cimd_consent);
  });
});

test('consent callback binding, timeout, catalog and metadata failures produce no receipt', async t => {
  for (const [name, config, handoff] of [['state', { wrongState: true }, true], ['timeout', {}, false], ['catalog', { badTools: true }, true], ['metadata', { badMetadata: true }, true], ['callback-mode', { unsafeCallback: true }, true]]) {
    await t.test(name, async t => { const f = await fixture(t, config), r = await f.run('consent', [], { handoff });
      assert.equal(r.exit, 1, r.output); await missing(r.out); assert.match(r.output, /FAIL cimd_consent:/); });
  }
});

test('private path and profile refusals happen before refresh, registration or note writes', async t => {
  for (const kind of ['directory', 'file', 'symlink', 'hardlink', 'wrong-seat', 'receipt-bind']) await t.test(kind, async t => {
    const f = await fixture(t); await pre(f); const count = f.events.length;
    if (kind === 'directory') await chmod(f.seat, 0o755);
    if (kind === 'file') await chmod(join(f.seat, 'credential.json'), 0o644);
    if (kind === 'symlink') await symlink(join(f.seat, 'credential.json'), join(f.seat, 'unsafe.json'));
    if (kind === 'hardlink') await link(join(f.seat, 'credential.json'), join(f.seat, 'unsafe.json'));
    if (kind === 'wrong-seat') {
      const path = join(f.seat, 'profile.json'), p = JSON.parse(await readFile(path)); p.workspace_id = randomUUID(); await privateWrite(path, p);
    }
    if (kind === 'receipt-bind') {
      const p = JSON.parse(await readFile(f.consent)); p.release_sha = 'b'.repeat(40); await privateWrite(f.consent, p);
    }
    const r = await f.run('window'); assert.equal(r.exit, 1, r.output); await missing(r.out);
    assert.ok(f.events.slice(count).every(e => e.method === 'GET' && e.path.includes('.well-known')));
  });
});

async function post(f, p) {
  const r = await f.run('consent', ['--phase', 'post-W5', '--prior-consent', p.out]);
  assert.equal(r.exit, 0, r.output); f.consent = r.out; return r;
}
function expirationTimes(entries, journal, f) {
  for (const entry of entries) {
    const last = journal.ids.find(c => c.client_id === entry.client_id).last_used_at;
    assert.equal(Date.parse(entry.expires_after), Date.parse(last) + 30 * 24 * 60 * 60 * 1000);
    // The journal must reflect the independent fixture's latest registration/token request,
    // including token issuance renewing the consent DCR client after registration.
    assert.ok(Date.parse(last) >= f.clientTimes.get(entry.client_id));
    assert.ok(Date.parse(last) - f.clientTimes.get(entry.client_id) < 1000);
  }
}

test('post-W5 proves pre-W1 CIMD revocation before new consent and retains the new grant through final cleanup', async t => {
  for (const [name, config] of [['rotation-replay', {}], ['RFC7009', { rfcRevoke: true }]]) await t.test(name, async t => {
    const f = await fixture(t, config), p = await pre(f);
    const preFamily = f.events.find(e => e.grant === 'authorization_code' && e.client === client).family;
    const earlierIds = [...p.receipt.dcr_client_ids];
    for (const window of ['W1', 'W2', 'W3', 'W4', 'W5']) {
      const w = await f.run('window', ['--window', window]); assert.equal(w.exit, 0, w.output);
      earlierIds.push(...w.receipt.dcr_client_ids);
      assert.equal(f.events.filter(e => e.grant === 'refresh_token').at(-1).family, preFamily);
    }
    // A failed window still created a client: cleanup must include its journal entry.
    f.config.badRegistration = true;
    const failedBefore = await f.run('window', ['--window', 'W5']); assert.equal(failedBefore.exit, 1); await missing(failedBefore.out);
    earlierIds.push([...f.clients].at(-1)); f.config.badRegistration = false;
    const start = f.events.length, q = await post(f, p);
    consentSchema(q.receipt, 'post-W5', hash(await readFile(script)));
    assert.equal(q.bytes.toString(), JSON.stringify(q.receipt, null, 2) + '\n');
    assert.deepEqual(q.receipt.cleanup.dcr_clients_expiring.map(c => c.client_id), earlierIds);
    assert.ok(preFamily.revoked);
    const events = f.events.slice(start), newToken = events.findIndex(e => e.grant === 'authorization_code');
    const proofs = events.filter(e => e.grant === 'refresh_token' && e.rejected);
    assert.ok(proofs.length > 0); assert.ok(events.indexOf(proofs.at(-1)) < newToken);
    assert.ok(proofs.every(e => e.family === preFamily));
    const postFamily = events.find(e => e.grant === 'authorization_code' && e.client === client).family;
    assert.notEqual(preFamily, postFamily); assert.equal(postFamily.revoked, false);
    assert.ok([...f.clients].length > 0, 'registrations remain live; expiry is scheduled, never removed');
    assert.ok(f.events.every(e => e.method !== 'DELETE'));
    const afterIds = [...q.receipt.dcr_client_ids];
    for (const [window, phase] of [['W5', 'after'], ['W5', 'recovery'], ['W6', 'before'], ['W6', 'after'], ['W7', 'before'], ['W7', 'after']]) {
      const w = await f.run('window', ['--window', window, '--phase', phase]); assert.equal(w.exit, 0, w.output);
      assert.equal(w.receipt.consent_receipt_sha256, hash(q.bytes)); afterIds.push(...w.receipt.dcr_client_ids);
      assert.equal(f.events.filter(e => e.grant === 'refresh_token').at(-1).family, postFamily);
    }
    f.config.badRegistration = true;
    const failedAfter = await f.run('window', ['--window', 'W7', '--phase', 'after']); assert.equal(failedAfter.exit, 1); await missing(failedAfter.out);
    afterIds.push([...f.clients].at(-1)); f.config.badRegistration = false;
    const journal = JSON.parse(await readFile(join(f.creds, 'dcr-client-ids.json')));
    expirationTimes(q.receipt.cleanup.dcr_clients_expiring, journal, f);
    const final = await f.run('final-cleanup'); assert.equal(final.exit, 0, final.output);
    keys(final.receipt, ['kind', 'release_sha', 'measured_at', 'producer_sha256', 'grants_revoked', 'dcr_clients_expiring']);
    assert.equal(final.receipt.kind, 'c1-final-cleanup'); assert.equal(final.receipt.release_sha, release);
    assert.equal(final.receipt.producer_sha256, hash(await readFile(script))); assert.equal(final.receipt.grants_revoked, true);
    assert.equal(new Date(final.receipt.measured_at).toISOString(), final.receipt.measured_at);
    assert.deepEqual(final.receipt.dcr_clients_expiring.map(c => c.client_id), afterIds);
    expirationTimes(final.receipt.dcr_clients_expiring, journal, f);
    assert.equal((await stat(final.out)).mode & 0o777, 0o600); assert.ok(postFamily.revoked);
    assert.equal(final.bytes.toString(), JSON.stringify(final.receipt, null, 2) + '\n');
    const blocked = await f.run('window', ['--window', 'W7', '--phase', 'after']);
    assert.equal(blocked.exit, 1); assert.match(blocked.output, /missing or revoked grant/); await missing(blocked.out);
  });
});

test('post-W5 and final cleanup refuse unproven revocation without publishing evidence', async t => {
  for (const command of ['consent', 'final-cleanup']) for (const [name, config] of [
    ['RFC7009-lies', { rfcRevoke: true, revokeLies: true }], ['replay-lies', { replayLies: true }],
    ['wrong-error', { wrongRejection: true }], ['wrong-status', { rfcRevoke: true, proofStatus200: true }],
  ]) await t.test(`${command}/${name}`, async t => {
    const f = await fixture(t), p = await pre(f);
    if (command === 'final-cleanup') await post(f, p);
    Object.assign(f.config, config); const start = f.events.length;
    const r = await f.run(command, command === 'consent' ? ['--phase', 'post-W5', '--prior-consent', p.out] : []);
    assert.equal(r.exit, 1, r.output); await missing(r.out);
    assert.match(r.output, /FAIL (cleanup|final_cleanup):/);
    assert.ok(f.events.slice(start).some(e => e.grant === 'refresh_token'));
    assert.ok(f.events.slice(start).every(e => e.grant !== 'authorization_code' && e.path !== '/reg'));
    if (command === 'consent') await missing(join(r.pointer, 'cimd-authorize-url.txt'));
  });
});

test('cleanup refuses incomplete or unsafe journals before any grant change', async t => {
  for (const command of ['consent', 'final-cleanup']) for (const kind of ['missing-id', 'missing-journal', 'missing-grant', 'missing-time', 'unsafe-file']) await t.test(`${command}/${kind}`, async t => {
    const f = await fixture(t), p = await pre(f);
    if (command === 'final-cleanup') await post(f, p);
    const idPath = join(f.creds, 'dcr-client-ids.json'), grantPath = join(f.creds, 'live-controls-state.json');
    const ids = JSON.parse(await readFile(idPath));
    if (kind === 'missing-id') { ids.ids.shift(); await privateWrite(idPath, ids); }
    if (kind === 'missing-journal') {
      assert.ok(idPath.startsWith(`${f.root}${sep}`), 'journal is inside the test-owned mkdtemp root');
      await unlink(idPath);
    }
    if (kind === 'missing-grant') { const j = JSON.parse(await readFile(grantPath)); j.grants = []; await privateWrite(grantPath, j); }
    if (kind === 'missing-time') { delete ids.ids[0].last_used_at; await privateWrite(idPath, ids); }
    if (kind === 'unsafe-file') await chmod(idPath, 0o644);
    const start = f.events.length;
    const r = await f.run(command, command === 'consent' ? ['--phase', 'post-W5', '--prior-consent', p.out] : []);
    assert.equal(r.exit, 1, r.output); await missing(r.out);
    assert.match(r.output, /journal|missing grant|unsafe file/);
    assert.ok(f.events.slice(start).every(e => e.method === 'GET' && e.path.includes('.well-known')));
  });
});

test('post-W5 refuses journal deadlines that have already elapsed before revoking the grant', async t => {
  const f = await fixture(t), p = await pre(f), path = join(f.creds, 'dcr-client-ids.json');
  const ids = JSON.parse(await readFile(path)); ids.ids[0].last_used_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  await privateWrite(path, ids); const start = f.events.length;
  const r = await f.run('consent', ['--phase', 'post-W5', '--prior-consent', p.out]);
  assert.equal(r.exit, 1, r.output); await missing(r.out); assert.match(r.output, /journal deadline elapsed/);
  assert.ok(f.events.slice(start).every(e => e.method === 'GET' && e.path.includes('.well-known')));
});

test('post-W5 cleanup schema refuses own ids, empty lists, obsolete keys and invalid expiry times', async t => {
  for (const command of ['window', 'final-cleanup']) for (const kind of ['own-id', 'empty', 'obsolete', 'past', 'non-UTC', 'extra-key']) await t.test(`${command}/${kind}`, async t => {
    const f = await fixture(t), p = await pre(f), q = await post(f, p), r = q.receipt;
    const c = r.cleanup.dcr_clients_expiring[0];
    if (kind === 'own-id') c.client_id = r.dcr_client_ids[0];
    if (kind === 'empty') r.cleanup.dcr_clients_expiring = [];
    if (kind === 'obsolete') { r.cleanup.dcr_clients_removed = [c.client_id]; delete r.cleanup.dcr_clients_expiring; }
    if (kind === 'past') c.expires_after = new Date(Date.now() - 1000).toISOString();
    if (kind === 'non-UTC') c.expires_after = c.expires_after.replace('Z', '+00:00');
    if (kind === 'extra-key') c.removed = true;
    await privateWrite(q.out, r); const start = f.events.length;
    const failed = await f.run(command, command === 'window' ? ['--window', 'W6'] : []);
    assert.equal(failed.exit, 1, failed.output); await missing(failed.out); assert.match(failed.output, /consent cleanup schema/);
    assert.ok(f.events.slice(start).every(e => e.method === 'GET' && e.path.includes('.well-known')));
  });
});

test('window enforces the schema consent phase, producer identity and exact input keys', async t => {
  for (const name of ['phase', 'producer', 'extra-key', 'control', 'future', 'stale']) await t.test(name, async t => {
    const f = await fixture(t); await pre(f);
    const p = JSON.parse(await readFile(f.consent));
    if (name === 'producer') p.producer_sha256 = 'b'.repeat(64);
    if (name === 'extra-key') p.extra = true;
    if (name === 'control') p.controls.cimd_consent = 'true';
    if (name === 'future') p.measured_at = new Date(Date.now() + 60000).toISOString();
    if (name === 'stale') p.measured_at = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    await privateWrite(f.consent, p);
    const r = await f.run('window', name === 'phase' ? ['--window', 'W5', '--phase', 'after'] : []);
    assert.equal(r.exit, 1, r.output); assert.match(r.output, /FAIL consent_binding:/); await missing(r.out);
  });
});

test('HTTP timeout is bounded and emits neither a token nor a receipt', async t => {
  const f = await fixture(t, { hangToken: true }), started = Date.now();
  const r = await f.run('consent'); assert.equal(r.exit, 1, r.output); await missing(r.out);
  assert.match(r.output, /FAIL cimd_consent:/); assert.ok(Date.now() - started < 5000);
});

test('a refused public registration remains journaled for cleanup', async t => {
  const f = await fixture(t); await pre(f); f.config.badRegistration = true;
  const r = await f.run('window'); assert.equal(r.exit, 1); await missing(r.out);
  const ids = JSON.parse(await readFile(join(f.creds, 'dcr-client-ids.json')));
  assert.deepEqual(ids.ids.map(c => c.client_id), [...f.clients]); assert.equal(ids.ids.length, 2);
});

test('consent rejects unsafe credential directories and existing run locks without HTTP', async t => {
  for (const kind of ['directory', 'lock']) await t.test(kind, async t => {
    const f = await fixture(t);
    if (kind === 'directory') await chmod(f.creds, 0o755);
    else await privateWrite(join(f.creds, 'live-controls.lock'), 'running\n');
    const r = await f.run('consent'); assert.equal(r.exit, 1, r.output); await missing(r.out); assert.equal(f.events.length, 0);
    assert.match(r.output, /FAIL files:/);
  });
});

test('receipt cannot alias a credential journal and leave secrets at the requested output', async t => {
  const f = await fixture(t), outName = join(f.creds, 'live-controls-state.json');
  const r = await f.run('consent', [], { outName }); assert.equal(r.exit, 1, r.output);
  assert.match(r.output, /file path collision/); await missing(outName); assert.equal(f.events.length, 0);
});
