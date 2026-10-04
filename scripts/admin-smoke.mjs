#!/usr/bin/env node
// C1 agent half only. Human consent/revoke, SQL audit counts and archive belong
// to the release plan. No browser, registration, credential store or env secrets.
import { constants } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash, generateKeyPairSync, createPublicKey, randomBytes, randomUUID, sign, verify } from 'node:crypto';

const ISSUER = 'https://mcp.commonswarm.com';
const RESOURCE = 'https://api.commonswarm.com/admin';
const CLIENT = 'https://commonswarm.com/oauth/c1-smoke/client.json';
const REDIRECT = 'https://commonswarm.com/oauth/c1-smoke/callback';
const VERSION = '2025-11-25';
const SCOPES = ['admin:read', 'workspaces:create', 'seats:create', 'seats:revoke'];
const SCOPE = ['openid', 'offline_access', ...SCOPES].join(' ');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMMANDS = ['admin_read_metadata', 'admin_create_workspace', 'admin_create_seat', 'admin_revoke_seat'];
const METADATA = {
  client_id: CLIENT, client_name: 'CommonSwarm C1 smoke', client_uri: 'https://commonswarm.com',
  application_type: 'web', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
  // Admin scopes are resource-only: request them at authorization, not in CIMD.
  // The provider reads the binding boolean; admin verification reads the alg.
  dpop_bound_access_tokens: true, dpop_signing_alg: 'ES256',
};
const hash = value => createHash('sha256').update(value).digest('base64url');
const record = value => value && typeof value === 'object' && !Array.isArray(value);
class Failure extends Error { constructor(code) { super(code); this.code = code; } }
const demand = (condition, code) => { if (!condition) throw new Failure(code); };
const sleep = ms => new Promise(done => setTimeout(done, ms));
// Production secret window: a fresh 0700 /private/tmp/anvil-secret.* directory.
// Only the test preload can move the parent (no env or CLI seam); the name
// pattern and every privatePath guard stay identical.
const SECRET_ROOT = globalThis[Symbol.for('commonswarm.admin-smoke.secret-root')] ?? '/private/tmp';
const SECRET_WINDOW = new RegExp(`^${SECRET_ROOT.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/anvil-secret\\.[A-Za-z0-9]+$`);

function options(args) {
  const out = { consentMs: 1_500_000, fenceMs: 240_000, requestMs: 10_000, totalMs: 1_800_000 };
  const paths = { '--authorize-url-file': 'authorize', '--callback-file': 'callback', '--receipt-file': 'receipt', '--fence-file': 'fence' };
  const times = { '--consent-timeout-ms': ['consentMs', 1_500_000], '--fence-timeout-ms': ['fenceMs', 240_000],
    '--request-timeout-ms': ['requestMs', 10_000], '--total-timeout-ms': ['totalMs', 1_800_000] };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]; demand(!seen.has(arg), 'duplicate_option'); seen.add(arg);
    if (paths[arg]) { demand(args[i + 1] && !args[i + 1].startsWith('--'), 'missing_option_value'); out[paths[arg]] = resolve(args[++i]); }
    else if (times[arg]) { const [key, max] = times[arg]; const n = Number(args[++i]); demand(Number.isSafeInteger(n) && n > 0 && n <= max, 'invalid_timeout'); out[key] = n; }
    else if (['--dry-run', '--print-client-metadata', '--verify-fenced', '--help'].includes(arg)) out[arg.slice(2)] = true;
    else throw new Failure('unknown_option');
  }
  return out;
}
function plan(o) {
  return { dry_run: true, client_id: CLIENT, redirect_uri: REDIRECT, resource: RESOURCE, scope: SCOPE,
    request_timeout_ms: o.requestMs, total_timeout_ms: o.totalMs,
    steps: ['discovery', 'resource_metadata', 'jwks', 'consent_file_handoff', 'dpop_code_exchange',
      'initialize', 'initialized', 'tools_list', 'read_metadata', 'create_workspace', 'create_seat', 'revoke_seat',
      'dpop_refresh', 'read_metadata_after_refresh', ...(o['verify-fenced'] ? ['wait_for_human_revoke_file', 'verify_fenced'] : [])],
    human_fence: 'Write the receipt run_id to --fence-file (0600) only after human revoke commits; same process retains the key.',
    residue: 'c1-smoke-<runid> (test, archive me)', audit_counts: { init: null, list: null, read: null, action: null } };
}

// Private handoffs must be in the operator's fresh secret window. Do not follow
// symlinks or overwrite stale callbacks. The caller owns guarded window cleanup.
async function privatePath(path, secret) {
  demand(path, 'missing_file_option');
  const parent = dirname(path), actual = await realpath(parent);
  demand(parent === actual, 'symlink_parent');
  const stat = await lstat(parent);
  demand(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700, 'unsafe_directory');
  if (secret) demand(SECRET_WINDOW.test(actual), 'secret_window_required');
}
async function absent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Failure('stale_handoff_file');
}
async function newFile(path) {
  return open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
}
async function privateRead(path) {
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (error.code === 'ENOENT') return null; throw new Failure('unsafe_handoff_file'); }
  try {
    const stat = await fd.stat();
    demand(stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o777) === 0o600, 'unsafe_handoff_file');
    demand(stat.size <= 16_384, 'handoff_too_large');
    const bytes = Buffer.alloc(16_385); const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    demand(bytesRead <= 16_384, 'handoff_too_large');
    return bytes.subarray(0, bytesRead).toString('utf8').trim();
  } finally { await fd.close(); }
}
async function waitFile(path, ms, deadline) {
  const end = Math.min(Date.now() + ms, deadline);
  for (let n = 0; n <= Math.ceil(ms / 100); n++) {
    demand(Date.now() < end, 'handoff_timeout');
    const value = await privateRead(path); if (value) return value;
    await sleep(Math.min(100, end - Date.now()));
  }
  throw new Failure('handoff_timeout');
}
function callback(value, state) {
  let url; try { url = new URL(value); } catch { throw new Failure('invalid_callback'); }
  demand(url.origin + url.pathname === REDIRECT && !url.hash && !url.username && !url.password, 'wrong_callback');
  demand(url.searchParams.getAll('state').length === 1 && url.searchParams.get('state') === state, 'state_mismatch');
  demand(url.searchParams.getAll('iss').length === 1 && url.searchParams.get('iss') === ISSUER, 'issuer_mismatch');
  demand(!url.searchParams.has('error'), 'consent_refused');
  const code = url.searchParams.get('code');
  demand(url.searchParams.getAll('code').length === 1 && code && code.length <= 4096, 'code_missing');
  return code;
}
function endpoint(value) {
  let url; try { url = new URL(value); } catch { throw new Failure('invalid_endpoint'); }
  demand(url.origin === ISSUER && !url.search && !url.hash && !url.username && !url.password, 'unexpected_endpoint');
  return url.href;
}
async function boundedJson(response) {
  demand(response.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'expected_json');
  const reader = response.body?.getReader(); demand(reader, 'missing_response');
  const chunks = []; let size = 0;
  try {
    for (let n = 0; n < 131_073; n++) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.length; demand(size <= 131_072, 'response_too_large'); chunks.push(next.value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Failure('invalid_json'); }
  demand(record(value), 'invalid_response'); return value;
}

async function run(o) {
  let stage = 'files', receiptFd;
  const runId = randomBytes(8).toString('hex');
  const receipt = { ok: false, run_id: runId, client_id: CLIENT,
    workspace: { id_prefix: null, name: `c1-smoke-${runId} (test, archive me)`, accepted_residue: false },
    seat_id_prefix: null, steps: {}, refused_after_fence: null,
    audit_counts: { init: null, list: null, read: null, action: null }, human_grant_state: null,
    human_client_approval_withdrawn: null, human_workspace_archived: null, failed_step: null, failure_code: null };
  const deadline = Date.now() + o.totalMs;
  const save = async () => { if (receiptFd) { await receiptFd.truncate(0); await receiptFd.write(JSON.stringify(receipt, null, 2) + '\n', 0, 'utf8'); await receiptFd.sync(); } };
  const step = async (name, work, commandId) => {
    stage = name; receipt.steps[name] = { result: 'pending', ...(commandId ? { command_id: commandId } : {}) };
    const result = await work(); receipt.steps[name].result = 'pass'; return result;
  };
  try {
    for (const key of ['authorize', 'callback', 'receipt', ...(o['verify-fenced'] ? ['fence'] : [])]) await privatePath(o[key], key !== 'receipt');
    demand(new Set([o.authorize, o.callback, o.receipt, o.fence].filter(Boolean)).size === (o['verify-fenced'] ? 4 : 3), 'file_path_collision');
    await absent(o.callback); if (o['verify-fenced']) await absent(o.fence);
    receiptFd = await newFile(o.receipt); await save();
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const jkt = hash(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }));
    const nonces = new Map();
    const proof = (url, token, nonce) => {
      const header = Buffer.from(JSON.stringify({ typ: 'dpop+jwt', alg: 'ES256', jwk })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ htm: 'POST', htu: url, iat: Math.floor(Date.now() / 1000), jti: randomUUID(),
        ...(token ? { ath: hash(token) } : {}), ...(nonce ? { nonce } : {}) })).toString('base64url');
      const input = `${header}.${claims}`;
      return `${input}.${sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
    };
    const request = async (url, { body, token, protectedRequest = false } = {}) => {
      for (let attempt = 0; attempt < (protectedRequest ? 2 : 1); attempt++) {
        demand(Date.now() < deadline, 'total_timeout');
        const response = await fetch(url, { method: body === undefined ? 'GET' : 'POST', body,
          headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': url === `${ISSUER}/token` ? 'application/x-www-form-urlencoded' : 'application/json' }),
            ...(protectedRequest ? { DPoP: proof(url, token, nonces.get(url)) } : {}), ...(token ? { Authorization: `DPoP ${token}` } : {}) },
          redirect: 'error', signal: AbortSignal.timeout(Math.min(o.requestMs, deadline - Date.now())) });
        const data = response.status === 204 ? null : await boundedJson(response);
        const nonce = response.headers.get('dpop-nonce');
        if (nonce) { demand(nonce.length <= 512 && /^[A-Za-z0-9_-]+$/.test(nonce), 'invalid_nonce'); nonces.set(url, nonce); }
        const challenged = data?.error === 'use_dpop_nonce' || /error="use_dpop_nonce"/.test(response.headers.get('www-authenticate') ?? '');
        if (challenged && [400, 401].includes(response.status)) { demand(nonce && attempt === 0, 'nonce_retry_failed'); continue; }
        return { status: response.status, data };
      }
      throw new Failure('nonce_retry_failed');
    };
    const get = async url => { const r = await request(url); demand(r.status === 200, 'unexpected_http_status'); return r.data; };
    const discovery = await step('discovery', () => get(`${ISSUER}/.well-known/oauth-authorization-server`));
    demand(discovery.issuer === ISSUER && discovery.code_challenge_methods_supported?.includes('S256') &&
      discovery.dpop_signing_alg_values_supported?.includes('ES256') && !discovery.require_pushed_authorization_requests, 'discovery_contract');
    const authorizeEndpoint = endpoint(discovery.authorization_endpoint), tokenEndpoint = endpoint(discovery.token_endpoint);
    demand(tokenEndpoint === `${ISSUER}/token`, 'unexpected_token_endpoint');
    const metadata = await step('resource_metadata', () => get(`${RESOURCE}/.well-known/oauth-protected-resource`));
    demand(metadata.resource === RESOURCE && metadata.authorization_servers?.includes(ISSUER) && SCOPES.every(s => metadata.scopes_supported?.includes(s)), 'resource_contract');
    const jwks = await step('jwks', () => get(endpoint(discovery.jwks_uri)));
    demand(Array.isArray(jwks.keys) && jwks.keys.length <= 32, 'invalid_jwks');
    let claims, tokens, grant;
    const validateTokens = value => {
      demand(value.token_type === 'DPoP' && typeof value.access_token === 'string' && value.access_token.length <= 16_384 &&
        typeof value.refresh_token === 'string' && value.refresh_token.length > 0 && value.refresh_token.length <= 8192 &&
        Number.isSafeInteger(value.expires_in) && value.expires_in > 0 && value.expires_in <= 300, 'token_contract');
      const scopes = typeof value.scope === 'string' ? value.scope.split(' ') : [];
      demand(SCOPES.every(s => scopes.includes(s)) && scopes.every(s => SCOPE.split(' ').includes(s)), 'scope_mismatch');
      const parts = value.access_token.split('.'); demand(parts.length === 3, 'invalid_access_token');
      let header, jwt; try { header = JSON.parse(Buffer.from(parts[0], 'base64url')); jwt = JSON.parse(Buffer.from(parts[1], 'base64url')); } catch { throw new Failure('invalid_access_token'); }
      demand(header.typ === 'at+jwt' && header.alg === 'ES256' && typeof header.kid === 'string' && header.kid.length <= 200 &&
        !header.crit && !header.jku && !header.x5u && !header.jwk, 'invalid_access_header');
      const keys = jwks.keys.filter(k => k.kid === header.kid && k.kty === 'EC' && k.crv === 'P-256' && !k.d && (!k.alg || k.alg === 'ES256'));
      demand(keys.length === 1 && verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`),
        { key: createPublicKey({ key: keys[0], format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url')), 'access_signature');
      const now = Math.floor(Date.now() / 1000);
      demand(jwt.iss === ISSUER && jwt.aud === RESOURCE && jwt.client_id === CLIENT && jwt.grant_class === 'delegated_admin' &&
        UUID.test(jwt.sub) && UUID.test(jwt.admin_grant_id) && UUID.test(jwt.admin_identity_id) && UUID.test(jwt.connection_id) &&
        typeof jwt.grant_id === 'string' && jwt.grant_id.length > 0 && jwt.grant_id.length <= 200 &&
        typeof jwt.jti === 'string' && jwt.jti.length > 0 && jwt.jti.length <= 200 &&
        jwt.cnf?.jkt === jkt && Number.isSafeInteger(jwt.iat) && Number.isSafeInteger(jwt.exp) && jwt.iat <= now + 5 &&
        jwt.exp > now && jwt.exp > jwt.iat && jwt.exp - jwt.iat <= 300 &&
        (jwt.nbf === undefined || Number.isSafeInteger(jwt.nbf) && jwt.nbf <= now) &&
        jwt.registry_version === 2 && /^[a-f0-9]{64}$/.test(jwt.manifest_digest) &&
        typeof jwt.scope === 'string' && SCOPES.every(s => jwt.scope.split(' ').includes(s)) &&
        jwt.scope.split(' ').every(s => SCOPES.includes(s)), 'access_binding');
      if (claims) demand(['sub', 'grant_id', 'admin_grant_id', 'admin_identity_id', 'connection_id', 'client_id', 'registry_version', 'manifest_digest', 'scope']
        .every(k => jwt[k] === claims[k]) && jwt.jti !== claims.jti && value.refresh_token !== tokens.refresh_token, 'refresh_binding');
      if (grant) demand(jwt.exp * 1000 <= grant.expires_at && jwt.exp * 1000 <= grant.refresh_deadline, 'deadline_extended');
      claims = jwt; tokens = value;
    };
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    const auth = new URL(authorizeEndpoint);
    auth.search = new URLSearchParams({ client_id: CLIENT, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
      resource: RESOURCE, state, code_challenge: hash(verifier), code_challenge_method: 'S256', dpop_jkt: jkt }).toString();
    const code = await step('consent', async () => {
      const fd = await newFile(o.authorize); try { await fd.writeFile(auth.href + '\n'); } finally { await fd.close(); }
      process.stdout.write('consent_handoff_ready\n');
      return callback(await waitFile(o.callback, o.consentMs, deadline), state);
    });
    await step('token', async () => {
      const r = await request(tokenEndpoint, { protectedRequest: true, body: new URLSearchParams({ grant_type: 'authorization_code',
        client_id: CLIENT, redirect_uri: REDIRECT, code, code_verifier: verifier, resource: RESOURCE }).toString() });
      demand(r.status === 200, 'token_refused'); validateTokens(r.data);
    });
    const rpc = async (method, params, commandId) => {
      const id = randomUUID();
      const r = await request(RESOURCE, { protectedRequest: true, token: tokens.access_token,
        body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id }), method, ...(params ? { params } : {}) }) });
      if (method === 'notifications/initialized') { demand(r.status === 204, 'notification_refused'); return null; }
      demand(r.status === 200 && r.data?.jsonrpc === '2.0' && r.data.id === id && !r.data.error && record(r.data.result), 'mcp_refused');
      if (!commandId) return r.data.result;
      const content = r.data.result.content;
      demand(!r.data.result.isError && Array.isArray(content) && content.length === 1 && content[0].type === 'text', 'invalid_tool_result');
      let result; try { result = JSON.parse(content[0].text); } catch { throw new Failure('invalid_tool_result'); }
      demand(result.status === 'accepted' && Array.isArray(result.events), 'command_not_accepted');
      return result;
    };
    const call = (name, command) => {
      const commandId = `c1_${runId}_${name}`;
      return step(name, () => rpc('tools/call', { name: command.kind, arguments: { command_id: commandId, command } }, commandId), commandId);
    };
    const read = name => call(name, { kind: 'admin_read_metadata', grant_id: claims.admin_grant_id, resource_kind: 'grant', workspace_id: null });
    const init = await step('initialize', () => rpc('initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'c1-smoke', version: '1' } }));
    demand(init.protocolVersion === VERSION && init.serverInfo?.name === 'commonswarm-admin', 'initialize_contract');
    await step('initialized', () => rpc('notifications/initialized'));
    const list = await step('tools_list', () => rpc('tools/list'));
    demand(COMMANDS.every(c => list.tools?.some(t => t.name === c)), 'required_tool_missing');
    grant = (await read('read_metadata')).grant;
    demand(grant?.grant_id === claims.admin_grant_id && grant.state === 'active' && Number.isSafeInteger(grant.expires_at) &&
      Number.isSafeInteger(grant.refresh_deadline) && claims.exp * 1000 <= Math.min(grant.expires_at, grant.refresh_deadline), 'grant_contract');
    const workspaceId = randomUUID();
    const created = await call('create_workspace', { kind: 'admin_create_workspace', grant_id: claims.admin_grant_id, workspace_id: workspaceId, name: receipt.workspace.name });
    demand(created.events.some(e => e.type === 'AdminWorkspaceCreated' && e.payload?.workspace_id === workspaceId && e.payload?.name === receipt.workspace.name), 'workspace_event_missing');
    receipt.workspace.id_prefix = workspaceId.slice(0, 8); receipt.workspace.accepted_residue = true; await save();
    const seat = await call('create_seat', { kind: 'admin_create_seat', grant_id: claims.admin_grant_id, workspace_id: workspaceId, name: `c1-smoke-${runId}`, model: null, transport: 'local' });
    const seatEvent = seat.events.find(e => e.type === 'AdminSeatCreated' && e.payload?.workspace_id === workspaceId);
    demand(UUID.test(seatEvent?.payload?.principal_id), 'seat_event_missing'); const seatId = seatEvent.payload.principal_id;
    receipt.seat_id_prefix = seatId.slice(0, 8); await save();
    const revoked = await call('revoke_seat', { kind: 'admin_revoke_seat', grant_id: claims.admin_grant_id, workspace_id: workspaceId, principal_id: seatId, reason_code: 'smoke_cleanup' });
    demand(revoked.events.some(e => e.type === 'AdminSeatRevoked' && e.payload?.principal_id === seatId), 'revoke_event_missing');
    await step('refresh', async () => {
      const r = await request(tokenEndpoint, { protectedRequest: true, body: new URLSearchParams({ grant_type: 'refresh_token',
        client_id: CLIENT, refresh_token: tokens.refresh_token, resource: RESOURCE }).toString() });
      demand(r.status === 200, 'refresh_refused'); validateTokens(r.data);
    });
    const after = (await read('read_metadata_after_refresh')).grant;
    demand(after?.state === 'active' && after.grant_id === grant.grant_id && after.expires_at === grant.expires_at && after.refresh_deadline === grant.refresh_deadline, 'refresh_deadline_changed');
    if (o['verify-fenced']) {
      // The actual nonsecret fence cutoff (fence wait, token expiry and total deadline), written with the ready line so
      // a fence driver derives its deadline from it rather than from when it noticed the line.
      const fenceCutoff = Math.min(Date.now() + o.fenceMs, deadline, claims.exp * 1000 - o.requestMs * 2);
      await save(); process.stdout.write(`fence_cutoff_epoch_ms=${fenceCutoff}\nagent_steps_complete_awaiting_human_fence\n`);
      await step('human_fence', async () => {
        demand(await waitFile(o.fence, o.fenceMs, fenceCutoff) === runId, 'fence_run_mismatch');
      });
      const commandId = `c1_${runId}_verify_fenced`;
      await step('verify_fenced', async () => {
        demand(Date.now() + o.requestMs * 2 < claims.exp * 1000, 'fence_token_expired');
        const r = await request(RESOURCE, { protectedRequest: true, token: tokens.access_token, body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call',
          params: { name: 'admin_read_metadata', arguments: { command_id: commandId, command: { kind: 'admin_read_metadata', grant_id: claims.admin_grant_id, resource_kind: 'grant', workspace_id: null } } } }) });
        const reason = r.data?.error === 'unauthenticated' ? 'unauthenticated' : r.data?.error?.message === 'grant_inactive' ? 'grant_inactive' : null;
        demand([401, 403].includes(r.status) && reason, 'fence_not_proven');
        receipt.refused_after_fence = { http_status: r.status, refusal_code: reason, rpc_code: r.data?.error?.code === -32000 ? -32000 : null, command_id: commandId };
      }, commandId);
    }
    receipt.ok = true; stage = 'receipt'; await save(); process.stdout.write('admin_smoke_pass\n');
  } catch (error) {
    receipt.failed_step = stage; receipt.failure_code = error instanceof Failure ? error.code : 'io_or_transport_failure';
    if (receipt.steps[stage]) receipt.steps[stage].result = 'fail';
    try { await save(); } catch { /* Never echo filesystem or upstream errors. */ }
    process.stderr.write(`admin_smoke_fail step=${receipt.failed_step} code=${receipt.failure_code}\n`); process.exitCode = 1;
  } finally { await receiptFd?.close(); }
}

try {
  const o = options(process.argv.slice(2));
  if (o.help) process.stdout.write('admin-smoke.mjs --authorize-url-file PATH --callback-file PATH --receipt-file PATH [--verify-fenced --fence-file PATH]\nPrivate handoffs: fresh 0700 /private/tmp/anvil-secret.* directory, files 0600. Callback: full redirect URL. Fence: receipt run_id, written only after human revoke commits. Caller removes the secret window with guarded rm.\n--print-client-metadata | --dry-run\nTimeouts may be shortened with --consent-timeout-ms, --fence-timeout-ms, --request-timeout-ms, --total-timeout-ms.\n');
  else if (o['print-client-metadata']) process.stdout.write(JSON.stringify(METADATA, null, 2) + '\n');
  else if (o['dry-run']) process.stdout.write(JSON.stringify(plan(o), null, 2) + '\n');
  else { demand(!o.fence || o['verify-fenced'], 'fence_option_requires_verify'); await run(o); }
} catch (error) { process.stderr.write(`admin_smoke_fail step=options code=${error instanceof Failure ? error.code : 'io_failure'}\n`); process.exitCode = 1; }
