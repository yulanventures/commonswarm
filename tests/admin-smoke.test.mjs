import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { createServer } from 'node:http';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { readFile, writeFile, stat, chmod, symlink } from 'node:fs/promises';
import { lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';

const script = fileURLToPath(new URL('../scripts/admin-smoke.mjs', import.meta.url));
const preload = fileURLToPath(new URL('./support/admin-smoke-transport.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/c1-smoke-client.json', import.meta.url));
const ISSUER = 'https://mcp.commonswarm.com', RESOURCE = 'https://api.commonswarm.com/admin';
const CLIENT = 'https://commonswarm.com/oauth/c1-smoke/client.json';
const REDIRECT = 'https://commonswarm.com/oauth/c1-smoke/callback';
const SCOPE = 'admin:read workspaces:create seats:create seats:revoke';
const SCOPES = SCOPE.split(' ');
const hash = v => createHash('sha256').update(v).digest('base64url');
const grantId = '11111111-1111-4111-8111-111111111111';
const ownerId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const connectionId = '44444444-4444-4444-8444-444444444444';
const seatId = '55555555-5555-4555-8555-555555555555';
const allowedCommands = ['admin_read_metadata', 'admin_create_workspace', 'admin_create_seat', 'admin_revoke_seat'];
const noFetch = 'data:text/javascript,' + encodeURIComponent("globalThis.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); };");

// Portable secret windows: every OS uses a fresh 0700 anvil-secret.XXXXXX
// directory under a task-owned parent in the OS temporary root. The executable
// accepts that parent only through the test preload; production keeps
// /private/tmp (proved below). Tests never resolve under the real home.
const temporaryRoot = realpathSync(tmpdir()), realHome = realpathSync(homedir());
const secretRoot = mkdtempSync(join(temporaryRoot, 'admin-smoke-secret-root.'));
assert.equal(lstatSync(secretRoot).mode & 0o777, 0o700);
assert.ok(secretRoot !== realHome && !secretRoot.startsWith(realHome + sep), 'test secret root resolves under the real home');
const SECRET_STAGE = /^anvil-secret\.[A-Za-z0-9]{6}$/;
function guardStage(dir, parent) {
  const stat = lstatSync(dir);
  assert.ok(dirname(dir) === parent && SECRET_STAGE.test(basename(dir)) && realpathSync(dir) === dir, `unexpected stage ${dir}`);
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, `unsafe stage ${dir}`);
  assert.ok(dir !== realHome && !dir.startsWith(realHome + sep), 'stage resolves under the real home');
}
function makeStage(parent = secretRoot) {
  const dir = mkdtempSync(join(parent, 'anvil-secret.'));
  guardStage(dir, parent);
  return dir;
}
// Remove only the exact stage this file created, after re-checking it.
function removeStage(dir, parent = secretRoot) { guardStage(dir, parent); rmSync(dir, { recursive: true }); }
after(() => {
  assert.ok(dirname(secretRoot) === temporaryRoot && /^admin-smoke-secret-root\.[A-Za-z0-9]{6}$/.test(basename(secretRoot)));
  rmSync(secretRoot, { recursive: true });
});

async function exercise(config = {}) {
  // Even synthetic codes/authorize URLs use a secret window with the mandated
  // name, mode and guards; cleanup removes only this exact created path.
  const dir = makeStage();
  await chmod(dir, 0o700);
  const paths = Object.fromEntries(['authorize', 'callback', 'receipt', 'fence'].map(k => [k, `${dir}/${k}.txt`]));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'ES256', use: 'sig' };
  const claimsBase = { iss: ISSUER, aud: RESOURCE, sub: ownerId, grant_class: 'delegated_admin', grant_id: 'fixture-provider-family',
    admin_grant_id: grantId, admin_identity_id: principalId, connection_id: connectionId, client_id: CLIENT,
    scope: SCOPE, registry_version: 2, manifest_digest: 'a'.repeat(64) };
  const grant = { grant_id: grantId, state: 'active', expires_at: Date.now() + 86_400_000, refresh_deadline: Date.now() + 86_400_000 };
  const secrets = [randomBytes(24).toString('base64url'), 'fixture-owner@private.example'];
  const code = secrets[0], attempts = [], seenProofs = new Set(), failures = [], commandRetries = new Map();
  let authorize, initialKey, currentToken, refreshToken, generation = 0, workspaceId, fenced = false, callbackMode, actionChallenged = false;
  let wireRunId = null, fencedRunId = null;
  let out = '', err = '', child, readyAt = 0;
  const check = (value, reason) => { if (!value) throw new Error(reason); };
  const emit = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(data === null ? undefined : JSON.stringify(data)); };
  const event = (type, payload) => ({ type, event_id: randomUUID(), payload });
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString('utf8');
      const row = { path: req.url, method: req.method, body, proof: req.headers.dpop };
      attempts.push(row);
      if (req.method === 'GET') {
        if (req.url === '/.well-known/oauth-authorization-server') return emit(res, 200, { issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks`,
          code_challenge_methods_supported: ['S256'], dpop_signing_alg_values_supported: ['ES256'] });
        if (req.url === '/admin/.well-known/oauth-protected-resource') return emit(res, 200, { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: SCOPES });
        if (req.url === '/jwks') return emit(res, 200, { keys: [jwk] });
        throw new Error('unexpected_get');
      }
      check(['/token', '/admin'].includes(req.url) && req.method === 'POST', 'unexpected_request');
      const [head, payload, signature] = String(req.headers.dpop).split('.');
      const header = JSON.parse(Buffer.from(head, 'base64url')), proof = JSON.parse(Buffer.from(payload, 'base64url'));
      check(header.typ === 'dpop+jwt' && header.alg === 'ES256' && header.jwk.kty === 'EC' && header.jwk.crv === 'P-256' && !header.jwk.d, 'invalid_proof_header');
      check(verify('sha256', Buffer.from(`${head}.${payload}`), { key: createPublicKey({ key: header.jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), 'invalid_proof_signature');
      const key = hash(JSON.stringify({ crv: header.jwk.crv, kty: header.jwk.kty, x: header.jwk.x, y: header.jwk.y }));
      check(key === authorize.searchParams.get('dpop_jkt') && (!initialKey || key === initialKey), 'key_changed'); initialKey = key;
      check(proof.htm === 'POST' && proof.htu === (req.url === '/token' ? `${ISSUER}/token` : RESOURCE), 'proof_uri');
      check(Number.isSafeInteger(proof.iat) && Math.abs(proof.iat * 1000 - Date.now()) < 10_000 && !seenProofs.has(proof.jti), 'proof_replay_or_time');
      seenProofs.add(proof.jti);
      row.rpc = req.url === '/admin' ? JSON.parse(body) : null;
      row.params = req.url === '/token' ? new URLSearchParams(body) : null;
      if (req.url === '/admin') {
        check(req.headers.authorization === `DPoP ${currentToken}` && proof.ath === hash(currentToken), 'access_proof_binding');
        if (row.rpc.method === 'tools/call') {
          const args = row.rpc.params.arguments;
          check(Object.keys(args).sort().join(',') === 'command,command_id' && args.command.kind === row.rpc.params.name && args.command.grant_id === grantId, 'mcp_call_shape');
          const prior = commandRetries.get(args.command_id); if (prior) check(prior === body, 'retry_changed_command'); else commandRetries.set(args.command_id, body);
          const commandRun = /^c1_([a-f0-9]{16})_/.exec(args.command_id)?.[1];
          check(commandRun && (!wireRunId || wireRunId === commandRun), 'command_run_id'); wireRunId = commandRun;
        }
      } else check(!proof.ath && !req.headers.authorization, 'token_ath_present');
      const expectedNonce = req.url === '/token' ? 'fixture_as_nonce' : actionChallenged ? 'fixture_action_nonce' : 'fixture_resource_nonce';
      if (config.nonce && (proof.nonce !== expectedNonce || config.repeatNonce)) {
        return emit(res, req.url === '/token' ? 400 : 401, { error: 'use_dpop_nonce' }, { 'dpop-nonce': expectedNonce, 'www-authenticate': 'DPoP error="use_dpop_nonce"' });
      }
      if (req.url === '/token') {
        if (config.hangToken) return; // Runner must cancel its timed-out request.
        const p = row.params;
        check(p.getAll('resource').length === 1 && p.get('resource') === RESOURCE && p.get('client_id') === CLIENT, 'token_resource_client');
        if (p.get('grant_type') === 'authorization_code') {
          check(generation === 0 && p.get('code') === code && p.get('redirect_uri') === REDIRECT && hash(p.get('code_verifier')) === authorize.searchParams.get('code_challenge'), 'code_pkce_contract');
          secrets.push(p.get('code_verifier'));
        } else check(p.get('grant_type') === 'refresh_token' && generation === 1 && p.get('refresh_token') === refreshToken, 'refresh_contract');
        generation++;
        const now = Math.floor(Date.now() / 1000);
        const accessClaims = { ...claimsBase, cnf: { jkt: config.wrongKey ? 'invalid' : key }, iat: now,
          exp: now + (config.shortToken ? 1 : 300), jti: randomUUID() };
        const h = Buffer.from(JSON.stringify({ typ: 'at+jwt', alg: 'ES256', kid: 'fixture-key' })).toString('base64url');
        const c = Buffer.from(JSON.stringify(accessClaims)).toString('base64url');
        currentToken = `${h}.${c}.${sign('sha256', Buffer.from(`${h}.${c}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
        refreshToken = randomBytes(32).toString('base64url'); secrets.push(currentToken, refreshToken);
        return emit(res, 200, { access_token: currentToken, refresh_token: refreshToken, token_type: 'DPoP', expires_in: config.shortToken ? 1 : 300,
          scope: SCOPE, ignored_cookie: secrets[1] });
      }
      const rpc = row.rpc;
      if (config.actionNonce && !actionChallenged && rpc.params?.name === 'admin_create_seat') {
        actionChallenged = true;
        return emit(res, 401, { error: 'use_dpop_nonce' }, { 'dpop-nonce': 'fixture_action_nonce', 'www-authenticate': 'DPoP error="use_dpop_nonce"' });
      }
      if (fenced && config.fenceRefusal !== false) {
        if (config.fenceStatus === 500) return emit(res, 500, { error: secrets[1] });
        if (config.slowRefusalMs) await new Promise(done => setTimeout(done, config.slowRefusalMs));
        return emit(res, 403, { jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'grant_inactive' } });
      }
      if (rpc.method === 'notifications/initialized') return emit(res, 204, null);
      let result;
      if (rpc.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'commonswarm-admin', version: '1' } };
      else if (rpc.method === 'tools/list') result = { tools: allowedCommands.map(name => ({ name })) };
      else {
        check(rpc.method === 'tools/call' && allowedCommands.includes(rpc.params.name), 'unexpected_admin_command');
        const command = rpc.params.arguments.command;
        let returned = { status: 'accepted', events: [], email: secrets[1], cookie: secrets[0] };
        if (command.kind === 'admin_read_metadata') {
          check(command.resource_kind === 'grant' && command.workspace_id === null, 'metadata_shape');
          returned.grant = { ...grant, ...(config.extendDeadline && generation === 2 ? { expires_at: grant.expires_at + 1000 } : {}) };
        } else if (command.kind === 'admin_create_workspace') {
          check(!workspaceId && /^c1-smoke-[a-f0-9]{16} \(test, archive me\)$/.test(command.name), 'workspace_count_name');
          workspaceId = command.workspace_id; returned.events = [event('AdminWorkspaceCreated', { workspace_id: workspaceId, name: command.name })];
        } else if (command.kind === 'admin_create_seat') {
          check(command.workspace_id === workspaceId && command.model === null && command.transport === 'local', 'seat_shape');
          returned.events = [event('AdminSeatCreated', { workspace_id: workspaceId, principal_id: seatId })];
        } else {
          check(command.workspace_id === workspaceId && command.principal_id === seatId && command.reason_code === 'smoke_cleanup', 'seat_revoke_shape');
          returned.events = [event('AdminSeatRevoked', { principal_id: seatId })];
        }
        if (config.failSeat && command.kind === 'admin_create_seat') return emit(res, 503, { error: secrets[1] });
        result = { content: [{ type: 'text', text: JSON.stringify(returned) }] };
      }
      return emit(res, 200, { jsonrpc: '2.0', id: rpc.id, result });
    } catch (error) { failures.push(error.message); if (!res.headersSent) emit(res, 500, { error: 'fixture_contract_failed' }); else res.end(); }
  });
  try {
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const address = server.address();
    const args = [script, '--authorize-url-file', paths.authorize, '--callback-file', paths.callback, '--receipt-file', paths.receipt,
      '--consent-timeout-ms', '2000', '--fence-timeout-ms', '2000', '--request-timeout-ms', '1000', '--total-timeout-ms', '6000',
      ...(config.fence ? ['--verify-fenced', '--fence-file', paths.fence] : [])];
    let handoff = Promise.resolve(), handledConsent = false, handledFence = false;
    child = spawn(process.execPath, ['--import', preload, ...args], { env: { ...process.env, ADMIN_SMOKE_TEST_TRANSPORT: '1', ADMIN_SMOKE_FIXTURE_ORIGIN: `http://127.0.0.1:${address.port}`, ADMIN_SMOKE_SECRET_ROOT: secretRoot, ...(config.slowFenceOpenMs ? { ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS: String(config.slowFenceOpenMs) } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => {
      out += chunk;
      if (!handledConsent && out.includes('consent_handoff_ready')) {
        handledConsent = true;
        handoff = handoff.then(async () => {
          authorize = new URL((await readFile(paths.authorize, 'utf8')).trim());
          check(authorize.origin === ISSUER && authorize.pathname === '/authorize' && authorize.searchParams.get('client_id') === CLIENT &&
            authorize.searchParams.get('redirect_uri') === REDIRECT && authorize.searchParams.get('resource') === RESOURCE &&
            authorize.searchParams.get('code_challenge_method') === 'S256' && authorize.searchParams.get('scope') === `openid offline_access ${SCOPE}`, 'authorize_contract');
          secrets.push(authorize.href, authorize.searchParams.get('state'));
          const url = new URL(REDIRECT); url.search = new URLSearchParams({ state: config.badState ? 'wrong-state' : authorize.searchParams.get('state'),
            iss: config.wrongIssuer ? 'https://other.invalid' : ISSUER, code }).toString();
          if (config.missingIssuer) url.searchParams.delete('iss');
          if (config.callbackFifo) execFileSync('mkfifo', ['-m', '600', paths.callback]);
          else if (config.callbackSymlink) { await writeFile(`${dir}/target`, url.href, { mode: 0o600 }); await symlink(`${dir}/target`, paths.callback); }
          else if (!config.noCallback) await writeFile(paths.callback, url.href, { mode: config.unsafeCallback ? 0o644 : 0o600 });
          if (!config.noCallback && !config.callbackSymlink && !config.callbackFifo) callbackMode = (await stat(paths.callback)).mode & 0o777;
        }).catch(e => failures.push(e.message));
      }
      if (!handledFence && out.includes('agent_steps_complete_awaiting_human_fence')) {
        handledFence = true; readyAt = Date.now();
        // The human writes the run id that this run sent on the wire. Do not
        // re-read the receipt here: a failing run may be rewriting it now.
        // After exit the final receipt must name the same run id.
        handoff = handoff.then(async () => {
          check(wireRunId, 'fence_run_id_unobserved'); fencedRunId = wireRunId;
          fenced = true; await writeFile(paths.fence, fencedRunId, { mode: 0o600 });
        }).catch(e => failures.push(e.message));
      }
    });
    child.stderr.on('data', chunk => { err += chunk; });
    const exitCode = await new Promise((done, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('executable_timeout')); }, 15_000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); done(code); });
    });
    await handoff;
    const text = await readFile(paths.receipt, 'utf8'), receipt = JSON.parse(text);
    if (fencedRunId) assert.equal(receipt.run_id, fencedRunId, 'fence carried a different run id than the receipt');
    const modes = { directory: (await stat(dir)).mode & 0o777, authorize: (await stat(paths.authorize)).mode & 0o777, callback: callbackMode,
      receipt: (await stat(paths.receipt)).mode & 0o777, ...(config.fence && handledFence ? { fence: (await stat(paths.fence)).mode & 0o777 } : {}) };
    // Check raw artifacts/output, including arbitrary upstream strings, JWTs,
    // PKCE, code, email, full identifiers and state. No projection self-test.
    for (const value of [...secrets, grantId, ownerId, principalId, connectionId, seatId, workspaceId].filter(Boolean)) {
      assert.ok(!text.includes(value), 'receipt leaked private data');
      assert.ok(!(out + err).includes(value), 'console leaked private data');
    }
    assert.ok(!/"(?:access_token|refresh_token|code_verifier|cookie|email|private_key)"/.test(text), 'secret receipt key');
    assert.deepEqual(failures, [], 'fake AS/MCP wire contract failed');
    return { exitCode, receipt, attempts, modes, out, err, readyAt };
  } finally {
    if (child?.exitCode === null) child.kill();
    server.closeAllConnections(); await new Promise(done => server.close(done));
    removeStage(dir);
  }
}

test('C1 happy path executes real PKCE/DPoP wire flow, one workspace/seat/revoke/refresh and redacts its receipt', async () => {
  const r = await exercise(); assert.equal(r.exitCode, 0); assert.equal(r.receipt.ok, true);
  assert.deepEqual(r.modes, { directory: 0o700, authorize: 0o600, callback: 0o600, receipt: 0o600 });
  assert.deepEqual(r.attempts.filter(a => a.rpc?.method === 'tools/call').map(a => a.rpc.params.name),
    ['admin_read_metadata', 'admin_create_workspace', 'admin_create_seat', 'admin_revoke_seat', 'admin_read_metadata']);
  assert.deepEqual(r.attempts.filter(a => a.params).map(a => a.params.get('grant_type')), ['authorization_code', 'refresh_token']);
  assert.deepEqual(r.receipt.audit_counts, { init: null, list: null, read: null, action: null });
  assert.equal(r.receipt.refused_after_fence, null); assert.equal(r.receipt.human_grant_state, null);
  assert.equal(r.receipt.workspace.accepted_residue, true); assert.match(r.receipt.workspace.id_prefix, /^[a-f0-9]{8}$/);
  assert.equal(r.receipt.seat_id_prefix, seatId.slice(0, 8));
  for (const step of ['create_workspace', 'create_seat', 'revoke_seat', 'read_metadata', 'read_metadata_after_refresh']) {
    assert.equal(r.receipt.steps[step].result, 'pass'); assert.match(r.receipt.steps[step].command_id, /^c1_[a-f0-9]{16}_/);
  }
});

test('AS and resource nonce retries use fresh signed proofs, separate nonces and identical command IDs', async () => {
  const r = await exercise({ nonce: true, actionNonce: true }); assert.equal(r.exitCode, 0);
  assert.equal(r.attempts.filter(a => a.path === '/token').length, 3);
  assert.equal(r.attempts.filter(a => a.rpc?.method === 'initialize').length, 2);
  const seatAttempts = r.attempts.filter(a => a.rpc?.params?.name === 'admin_create_seat');
  assert.equal(seatAttempts.length, 2); assert.equal(seatAttempts[0].body, seatAttempts[1].body);
  assert.notEqual(seatAttempts[0].proof, seatAttempts[1].proof);
  assert.equal(r.receipt.steps.refresh.result, 'pass');
});

test('repeated nonce challenge stops at one retry without exchanging or mutating', async () => {
  const r = await exercise({ nonce: true, repeatNonce: true }); assert.equal(r.exitCode, 1);
  assert.equal(r.receipt.failed_step, 'token'); assert.equal(r.receipt.failure_code, 'nonce_retry_failed');
  assert.equal(r.attempts.filter(a => a.path === '/token').length, 2); assert.equal(r.attempts.filter(a => a.path === '/admin').length, 0);
});

for (const [name, config, failure] of [
  ['bad state', { badState: true }, 'state_mismatch'], ['wrong issuer', { wrongIssuer: true }, 'issuer_mismatch'],
  ['missing issuer', { missingIssuer: true }, 'issuer_mismatch'], ['unsafe callback permissions', { unsafeCallback: true }, 'unsafe_handoff_file'],
  ['symlink callback', { callbackSymlink: true }, 'unsafe_handoff_file'], ['FIFO callback', { callbackFifo: true }, 'unsafe_handoff_file'],
  ['bounded consent wait', { noCallback: true }, 'handoff_timeout'],
]) test(`${name} fails before code exchange, with happy-path control in this suite`, async () => {
  const r = await exercise(config); assert.equal(r.exitCode, 1); assert.equal(r.receipt.failed_step, 'consent');
  assert.equal(r.receipt.failure_code, failure); assert.equal(r.attempts.filter(a => a.path === '/token').length, 0);
});

test('wrong DPoP token binding refuses before any admin request', async () => {
  const r = await exercise({ wrongKey: true }); assert.equal(r.exitCode, 1); assert.equal(r.receipt.failure_code, 'access_binding');
  assert.equal(r.attempts.filter(a => a.path === '/admin').length, 0);
});

test('refresh cannot extend the original grant deadline', async () => {
  const r = await exercise({ extendDeadline: true }); assert.equal(r.exitCode, 1);
  assert.equal(r.receipt.failed_step, 'read_metadata_after_refresh'); assert.equal(r.receipt.failure_code, 'refresh_deadline_changed');
});

test('post-human-fence admin call is refused with the code recorded and all human audit fields still null', async () => {
  const r = await exercise({ fence: true, nonce: true }); assert.equal(r.exitCode, 0); assert.equal(r.modes.fence, 0o600);
  assert.equal(r.receipt.refused_after_fence.http_status, 403); assert.equal(r.receipt.refused_after_fence.refusal_code, 'grant_inactive');
  assert.equal(r.receipt.refused_after_fence.rpc_code, -32000); assert.equal(r.receipt.steps.verify_fenced.result, 'pass');
  assert.equal(r.receipt.human_grant_state, null); assert.deepEqual(r.receipt.audit_counts, { init: null, list: null, read: null, action: null });
  // The runner prints its actual fence cutoff right before the ready line: here the 2000 ms fence wait bounds it.
  const cutoff = fenceCutoff(r.out);
  assert.ok(cutoff > r.readyAt - 500 && cutoff <= r.readyAt + 2000, `cutoff ${cutoff - r.readyAt} ms after ready`);
});
function fenceCutoff(out) {
  const lines = out.split('\n'), i = lines.indexOf('agent_steps_complete_awaiting_human_fence');
  assert.ok(i > 0); const m = /^fence_cutoff_epoch_ms=(\d+)$/.exec(lines[i - 1]); assert.ok(m, 'cutoff line precedes the ready line');
  assert.equal(lines.filter(l => l.startsWith('fence_cutoff_epoch_ms=')).length, 1); return Number(m[1]);
}

for (const config of [{ fenceRefusal: false }, { fenceStatus: 500 }]) test(`fence verification rejects ${config.fenceRefusal === false ? 'a successful follow-up call' : 'a server failure'}`, async () => {
  const r = await exercise({ fence: true, ...config }); assert.equal(r.exitCode, 1);
  assert.equal(r.receipt.failed_step, 'verify_fenced'); assert.equal(r.receipt.failure_code, 'fence_not_proven'); assert.equal(r.receipt.refused_after_fence, null);
});

// The published cutoff is enforced after the handoff read and around the follow-up request (2000 ms fence wait here).
test('a fence read or a refused follow-up that crosses the published cutoff is not proof', async () => {
  const slowRead = await exercise({ fence: true, slowFenceOpenMs: 2500 }); assert.equal(slowRead.exitCode, 1);
  assert.equal(slowRead.receipt.failed_step, 'human_fence'); assert.equal(slowRead.receipt.failure_code, 'handoff_timeout');
  assert.equal(slowRead.receipt.refused_after_fence, null); assert.equal(slowRead.receipt.ok, false);
  const slowRefusal = await exercise({ fence: true, slowRefusalMs: 2500 }); assert.equal(slowRefusal.exitCode, 1);
  assert.equal(slowRefusal.receipt.failed_step, 'verify_fenced'); assert.equal(slowRefusal.receipt.refused_after_fence, null); assert.equal(slowRefusal.receipt.ok, false);
  // Control: the same refusal inside the cutoff is proof.
  const inTime = await exercise({ fence: true, slowRefusalMs: 200 }); assert.equal(inTime.exitCode, 0); assert.equal(inTime.receipt.refused_after_fence.refusal_code, 'grant_inactive');
});

test('fence verification cannot pass solely because the access token expired', async () => {
  const r = await exercise({ fence: true, shortToken: true }); assert.equal(r.exitCode, 1);
  assert.equal(r.receipt.refused_after_fence, null); assert.equal(r.receipt.failed_step, 'human_fence');
  // A shortened token moves the printed cutoff before the ready line itself: a fence driver must refuse at once.
  assert.ok(fenceCutoff(r.out) < r.readyAt, 'token-bound cutoff is already past');
});

test('mid-run failure records accepted workspace residue and does not archive or revoke the human delegation', async () => {
  const r = await exercise({ failSeat: true }); assert.equal(r.exitCode, 1); assert.equal(r.receipt.failed_step, 'create_seat');
  assert.equal(r.receipt.workspace.accepted_residue, true); assert.equal(r.receipt.seat_id_prefix, null);
  assert.ok(!r.attempts.some(a => a.rpc?.params?.name?.includes('archive') || a.rpc?.params?.name?.includes('delegation')));
  assert.match(r.err, /^admin_smoke_fail step=create_seat code=mcp_refused\n$/);
});

test('request timeout stops a hung token endpoint without an admin mutation', async () => {
  const r = await exercise({ hangToken: true }); assert.equal(r.exitCode, 1);
  assert.equal(r.receipt.failed_step, 'token'); assert.equal(r.receipt.failure_code, 'io_or_transport_failure');
  assert.equal(r.attempts.filter(a => a.path === '/token').length, 1); assert.equal(r.attempts.filter(a => a.path === '/admin').length, 0);
});

test('dry-run makes no network request or file handoff and prints the agent/human plan', () => {
  const r = spawnSync(process.execPath, ['--import', noFetch, script, '--dry-run', '--verify-fenced'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); const plan = JSON.parse(r.stdout);
  assert.equal(plan.client_id, CLIENT); assert.equal(plan.resource, RESOURCE);
  assert.equal(plan.scope, `openid offline_access ${SCOPE}`); assert.ok(plan.steps.includes('verify_fenced'));
  assert.ok(!plan.steps.some(s => /registration|archive|revoke_delegation|audit_read/.test(s)));
});

test('printed CIMD metadata matches the independently pinned lane-11 fixture byte for byte, without fetch', async () => {
  const r = spawnSync(process.execPath, ['--import', noFetch, script, '--print-client-metadata'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(r.status, 0); assert.equal(r.stderr, ''); assert.equal(r.stdout, await readFile(fixture, 'utf8'));
  const metadata = JSON.parse(r.stdout);
  assert.equal(Object.hasOwn(metadata, 'scope'), false, 'admin scopes belong to the resource authorization request');
  assert.equal(metadata.dpop_bound_access_tokens, true);
  assert.equal(metadata.dpop_signing_alg, 'ES256', 'AS admin verification reads this algorithm field');
});

test('secret window: without the test preload the executable refuses an anvil-secret stage outside /private/tmp', () => {
  const dir = makeStage();
  try {
    const paths = ['authorize', 'callback', 'receipt'].map(k => join(dir, `${k}.txt`));
    const r = spawnSync(process.execPath, ['--import', noFetch, script, '--authorize-url-file', paths[0], '--callback-file', paths[1], '--receipt-file', paths[2]],
      { encoding: 'utf8', timeout: 5000 });
    assert.equal(r.status, 1); assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'admin_smoke_fail step=files code=secret_window_required\n');
  } finally { removeStage(dir); }
});

test('secret window: the preload refuses a fixture parent that is not a private task directory', () => {
  const loose = mkdtempSync(join(temporaryRoot, 'admin-smoke-loose-root.'));
  try {
    for (const [root, mode] of [[loose, 0o755], [temporaryRoot, null], [realHome, null]]) {
      if (mode !== null) execFileSync('chmod', [mode.toString(8), root]);
      const r = spawnSync(process.execPath, ['--import', preload, script, '--dry-run'], { encoding: 'utf8', timeout: 5000,
        env: { ...process.env, ADMIN_SMOKE_TEST_TRANSPORT: '1', ADMIN_SMOKE_FIXTURE_ORIGIN: 'http://127.0.0.1:9', ADMIN_SMOKE_SECRET_ROOT: root } });
      assert.notEqual(r.status, 0, `preload accepted ${root}`); assert.match(r.stderr, /invalid_fixture_secret_root/);
    }
    const control = spawnSync(process.execPath, ['--import', preload, script, '--dry-run'], { encoding: 'utf8', timeout: 5000,
      env: { ...process.env, ADMIN_SMOKE_TEST_TRANSPORT: '1', ADMIN_SMOKE_FIXTURE_ORIGIN: 'http://127.0.0.1:9', ADMIN_SMOKE_SECRET_ROOT: secretRoot } });
    assert.equal(control.status, 0, control.stderr);
  } finally {
    assert.ok(dirname(loose) === temporaryRoot && /^admin-smoke-loose-root\.[A-Za-z0-9]{6}$/.test(basename(loose)));
    rmSync(loose, { recursive: true });
  }
});

test('production launch: an inherited test preload and fixture variables cannot activate the test transport', () => {
  const inherited = { ...process.env, NODE_OPTIONS: `--import=${preload}`, ADMIN_SMOKE_FIXTURE_ORIGIN: 'http://127.0.0.1:9', ADMIN_SMOKE_FIXTURE_SLOW_FENCE_OPEN_MS: '5', ADMIN_SMOKE_SECRET_ROOT: secretRoot };
  delete inherited.ADMIN_SMOKE_TEST_TRANSPORT;
  // Plain node with the inherited preload (ai-w6-start without its unset line): the preload refuses, node never runs the runner.
  const viaPreload = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', timeout: 5000, env: inherited });
  assert.notEqual(viaPreload.status, 0); assert.match(viaPreload.stderr, /test_transport_requires_ADMIN_SMOKE_TEST_TRANSPORT/); assert.equal(viaPreload.stdout, '');
  // Fixture variables without the preload: the runner itself refuses.
  const { NODE_OPTIONS: _drop, ...noPreload } = inherited;
  const viaEnv = spawnSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8', timeout: 5000, env: noPreload });
  assert.equal(viaEnv.status, 1); assert.equal(viaEnv.stderr, 'admin_smoke_fail step=options code=test_inputs_in_production\n'); assert.equal(viaEnv.stdout, '');
  // The plan's own production launch line clears them first: native fetch and fs, the runner's plan prints.
  const plan = readFileSync(new URL('../docs/evidence/2026-10-03-admin-issuance-release/RELEASE.md', import.meta.url), 'utf8');
  const start = plan.split('\n```sh\n').find(b => b.startsWith('# step: ai-w6-start\n'));
  const unset = start.split('\n').find(l => l.startsWith('unset NODE_OPTIONS '));
  assert.ok(unset, 'ai-w6-start clears the preload inputs');
  const cleared = spawnSync('/bin/bash', ['-c', `${unset}\nexec "$NODE" "$SCRIPT" --dry-run`], { encoding: 'utf8', timeout: 5000, env: { ...inherited, NODE: process.execPath, SCRIPT: script } });
  assert.equal(cleared.status, 0, cleared.stderr); assert.ok(Array.isArray(JSON.parse(cleared.stdout).steps), 'the runner ran with native transport');
});

// The production default is macOS-specific: /private/tmp exists only there.
test('secret window: the production default accepts a fresh /private/tmp/anvil-secret.* stage on darwin',
  { skip: process.platform !== 'darwin' && 'production secret window /private/tmp exists only on macOS' }, () => {
    const dir = makeStage('/private/tmp');
    try {
      const paths = ['authorize', 'callback', 'receipt'].map(k => join(dir, `${k}.txt`));
      const r = spawnSync(process.execPath, ['--import', noFetch, script, '--authorize-url-file', paths[0], '--callback-file', paths[1], '--receipt-file', paths[2],
        '--total-timeout-ms', '2000'], { encoding: 'utf8', timeout: 5000 });
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /secret_window_required|step=files/);
      const receipt = JSON.parse(readFileSync(paths[2], 'utf8'));
      assert.equal(receipt.failed_step, 'discovery', 'window accepted; the next step is the first network call');
    } finally { removeStage(dir, '/private/tmp'); }
  });
