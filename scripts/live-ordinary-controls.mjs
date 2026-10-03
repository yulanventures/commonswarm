#!/usr/bin/env node
// Live controls only: no browser, environment credentials or test-pass switches.
// Build src/ with `npm run build` before using the CLI library legs.
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, lstat, realpath, readdir, readFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const ISSUER = 'https://mcp.commonswarm.com';
const API = 'https://api.commonswarm.com';
const RESOURCE = `${ISSUER}/mcp`;
const CLIENT = 'https://commonswarm.com/oauth/c1-controls/client.json';
const REDIRECT = 'https://commonswarm.com/oauth/c1-controls/callback';
const SCOPE = 'openid offline_access mcp';
const UA = 'curl/8.7.1';
const VERSION = '2025-06-18';
const TOOLS = ['claim_seat', 'whoami', 'members', 'ask', 'check', 'reply', 'note', 'working_on'];
const WORKSPACE = 'c1-controls (test)';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const utc = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;
const idOK = id => typeof id === 'string' && /^[A-Za-z0-9_-]{24,200}$/.test(id);
class Failure extends Error {
  constructor(expected, got) { super('control_failed'); this.expected = expected; this.got = got; }
}
const demand = (ok, expected, got = 'contract mismatch') => { if (!ok) throw new Failure(expected, got); };

function options(args) {
  const o = { command: args.shift(), requestMs: 10_000, consentMs: 600_000, totalMs: 1_300_000 };
  demand(['consent', 'window', 'final-cleanup'].includes(o.command), 'consent, window or final-cleanup', 'invalid subcommand');
  const common = ['release-sha', 'cred-dir', 'out', ...(o.command === 'final-cleanup' ? [] : ['phase'])];
  const allowed = [...common, ...(o.command === 'consent' ? ['pointer-dir', 'prior-consent'] :
    o.command === 'window' ? ['window', 'window-id', 'consent-receipt', 'human-profile', 'seat-profile'] : ['consent-receipt'])];
  const timeouts = { 'request-timeout-ms': ['requestMs', 10_000], 'consent-timeout-ms': ['consentMs', 600_000], 'total-timeout-ms': ['totalMs', 1_300_000] };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const name = args[i].slice(2);
    demand(args[i].startsWith('--') && !seen.has(name), 'unique named options', 'unknown or duplicate option'); seen.add(name);
    if (name === 'dry-run') o.dry = true;
    else if (timeouts[name]) {
      const [key, max] = timeouts[name]; const n = Number(args[++i]);
      demand(Number.isSafeInteger(n) && n > 0 && n <= max, 'bounded positive timeout', 'invalid timeout'); o[key] = n;
    } else {
      demand(allowed.includes(name) && args[i + 1] && !args[i + 1].startsWith('--'), 'supported option with value', 'invalid option');
      o[name] = args[++i];
    }
  }
  demand(/^[a-f0-9]{40}$/.test(o['release-sha'] ?? ''), '40 hex release SHA', 'invalid SHA');
  demand(o.command === 'final-cleanup' || (o.command === 'consent' ? ['pre-W1', 'post-W5'] : ['before', 'after', 'recovery']).includes(o.phase), 'valid phase', 'invalid phase');
  const required = [...common, ...(o.command === 'consent' ? ['pointer-dir', ...(o.phase === 'post-W5' ? ['prior-consent'] : [])] :
    o.command === 'window' ? ['window', 'window-id', 'consent-receipt', 'human-profile', 'seat-profile'] : ['consent-receipt'])];
  demand(required.every(k => typeof o[k] === 'string' && o[k].length > 0), 'all required options', 'missing option');
  if (o.command === 'window') demand(/^W[1-7]$/.test(o.window) && /^[A-Za-z0-9]{6}$/.test(o['window-id']), 'W1..W7 and 6 alnum window ID');
  for (const k of allowed.filter(k => k.endsWith('-dir') || k.endsWith('-profile') || ['out', 'prior-consent', 'consent-receipt'].includes(k))) {
    if (o[k]) { demand(o[k].startsWith('/'), 'absolute file paths', 'relative path'); o[k] = resolve(o[k]); }
  }
  return o;
}

async function directory(path) {
  demand(await realpath(path) === path, 'real owner-only directory', 'symlink ancestor');
  const s = await lstat(path);
  demand(s.isDirectory() && s.uid === process.getuid() && (s.mode & 0o777) === 0o700, 'owned 0700 directory', 'unsafe directory');
}
async function privateRead(path, optional = false) {
  await directory(dirname(path));
  let fd;
  try { fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (e) { if (optional && e.code === 'ENOENT') return null; throw new Failure('owned 0600 regular file', 'missing or unsafe file'); }
  try {
    const s = await fd.stat();
    demand(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600, 'owned 0600 single-link regular file', 'unsafe file');
    demand(s.size <= 131_072, 'bounded file', 'file too large');
    const b = Buffer.alloc(131_073), { bytesRead } = await fd.read(b, 0, b.length, 0);
    demand(bytesRead <= 131_072, 'bounded file', 'file too large'); return b.subarray(0, bytesRead);
  } finally { await fd.close(); }
}
async function absent(path) {
  try { await lstat(path); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  throw new Failure('fresh output or handoff file', 'existing path');
}
async function writePrivate(path, bytes, fresh = true) {
  await directory(dirname(path));
  if (!fresh) await privateRead(path); // Validate existing state before updating in place.
  const fd = await open(path, constants.O_WRONLY | constants.O_NOFOLLOW |
    (fresh ? constants.O_CREAT | constants.O_EXCL : 0), 0o600);
  try {
    const s = await fd.stat();
    demand(s.isFile() && s.nlink === 1 && s.uid === process.getuid() && (s.mode & 0o777) === 0o600, 'owned 0600 state file');
    await fd.truncate(0); await fd.writeFile(bytes); await fd.sync();
  } finally { await fd.close(); }
}
function json(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new Failure('valid JSON', 'invalid JSON'); }
}
function consentReceipt(bytes, release, producer, phase) {
  const r = json(bytes);
  demand(exact(r, ['kind', 'release_sha', 'consent_phase', 'measured_at', 'producer_sha256', 'controls', 'dcr_client_ids', 'cleanup']) &&
    r.kind === 'c1-consent' && r.release_sha === release && r.producer_sha256 === producer &&
    ['pre-W1', 'post-W5'].includes(r.consent_phase) && (!phase || r.consent_phase === phase) &&
    typeof r.measured_at === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(r.measured_at) && Number.isFinite(Date.parse(r.measured_at)) &&
    exact(r.controls, ['cimd_consent', 'dcr_registration_consent']) && Object.values(r.controls).every(v => v === true) &&
    Array.isArray(r.dcr_client_ids) && r.dcr_client_ids.length > 0 && r.dcr_client_ids.every(idOK), 'release-bound consent schema');
  demand(r.consent_phase === 'pre-W1' ? r.cleanup === null :
    exact(r.cleanup, ['grants_revoked', 'dcr_clients_expiring']) && r.cleanup.grants_revoked === true &&
    Array.isArray(r.cleanup.dcr_clients_expiring) && r.cleanup.dcr_clients_expiring.length > 0 &&
    new Set(r.cleanup.dcr_clients_expiring.map(c => c.client_id)).size === r.cleanup.dcr_clients_expiring.length &&
    r.cleanup.dcr_clients_expiring.every(c => exact(c, ['client_id', 'expires_after']) && idOK(c.client_id) &&
      utc(c.expires_after) && Date.parse(c.expires_after) > Date.now() && !r.dcr_client_ids.includes(c.client_id)), 'consent cleanup schema');
  return r;
}
function endpoint(value) {
  let u; try { u = new URL(value); } catch { throw new Failure('issuer endpoint', 'invalid URL'); }
  demand(u.origin === ISSUER && !u.username && !u.password && !u.search && !u.hash, 'pinned issuer endpoint', 'unexpected endpoint'); return u.href;
}
function authorization(authorize, clientId) {
  const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('base64url');
  const url = new URL(authorize);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPE,
    resource: RESOURCE, prompt: 'consent', state, code_challenge: challenge(verifier), code_challenge_method: 'S256' }).toString();
  return { verifier, state, url: url.href };
}
function callback(bytes, state) {
  let u; try { u = new URL(bytes.toString('utf8').trim()); } catch { throw new Failure('callback URL', 'invalid callback'); }
  demand(u.origin + u.pathname === REDIRECT && !u.hash && !u.username && !u.password &&
    u.searchParams.getAll('state').length === 1 && u.searchParams.get('state') === state &&
    u.searchParams.getAll('iss').length === 1 && u.searchParams.get('iss') === ISSUER && !u.searchParams.has('error') &&
    u.searchParams.getAll('code').length === 1 && u.searchParams.get('code')?.length > 0 && u.searchParams.get('code').length <= 4096,
  'issuer, redirect, state and code binding', 'callback rejected'); return u.searchParams.get('code');
}
function tokenContract(t) {
  demand(object(t) && t.token_type === 'Bearer' && typeof t.access_token === 'string' && t.access_token.length > 0 && t.access_token.length <= 16384 &&
    typeof t.refresh_token === 'string' && t.refresh_token.length > 0 && t.refresh_token.length <= 8192 &&
    Number.isSafeInteger(t.expires_in) && t.expires_in > 0 && typeof t.scope === 'string' && t.scope.split(' ').includes('mcp') &&
    t.scope.split(' ').every(s => SCOPE.split(' ').includes(s)), 'ordinary Bearer token and refresh credential', 'token contract mismatch'); return t;
}
async function boundedBody(response) {
  const chunks = []; let n = 0; const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; n += r.value.length;
      demand(n <= 131072, 'bounded response', 'response too large'); chunks.push(r.value); }
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); reader.releaseLock(); }
}
function plan(o) {
  const requests = [{ method: 'GET', url: `${ISSUER}/.well-known/oauth-authorization-server` },
    { method: 'GET', url: `${ISSUER}/.well-known/oauth-protected-resource/mcp` }];
  const fence = { method: 'POST', url: '<revocation endpoint if advertised; otherwise token endpoint>',
    body: 'revoke bound CIMD grant; rotation/replay fallback, then require refresh invalid_grant' };
  const expiry = { method: 'REPORT', body: 'leave recorded DCR clients to expire; journal last registration/token time + 30 days; no deletion' };
  if (o.command === 'final-cleanup') requests.push(fence, expiry);
  else if (o.command === 'consent') {
    if (o.phase === 'post-W5') requests.push({ ...fence, grant: 'pre-W1' }, expiry);
    const flow = clientId => [
      { method: 'HANDOFF', url: '<authorize endpoint>', client_id: clientId, pkce: 'S256',
        files: '<leg>-authorize-url.txt, <leg>-callback-url.txt (0600)', expected: 'human consent; bound full callback' },
      { method: 'POST', url: '<token endpoint>', body: 'authorization_code and verifier (memory only)', client_id: clientId },
      { method: 'POST', url: RESOURCE, rpc: 'initialize' },
      { method: 'POST', url: RESOURCE, rpc: 'notifications/initialized' },
      { method: 'POST', url: RESOURCE, rpc: 'tools/list' },
    ];
    requests.push({ method: 'GET', url: CLIENT }, ...flow(CLIENT),
      { method: 'POST', url: '<registration endpoint>', body: 'fresh public web client' }, ...flow('<fresh DCR id>'));
  }
  else requests.push(
    { method: 'POST', url: '<token endpoint>', body: 'refresh retained CIMD grant' },
    { method: 'POST', url: RESOURCE, rpc: 'initialize, notifications/initialized, tools/list' },
    { method: 'POST', url: '<registration endpoint>', body: 'fresh public client; journal id immediately' },
    { method: 'GET', url: CLIENT }, { method: 'GET', url: '<authorize endpoint>', expected: '303 /interaction/, no consent click' },
    { method: 'POST', url: `${API}/auth/v1/token?grant_type=refresh_token`, via: 'CLI refreshedCredential + forced file store' },
    { method: 'GET', url: `${API}/rest/v1/workspaces`, via: 'human read; test workspace only' },
    { method: 'POST', url: `${API}/functions/v1/read`, via: 'CLI directory; verify live test workspace and seat' },
    { method: 'POST', url: `${API}/functions/v1/command`, via: 'CLI sendSignal note to test workspace' },
    { method: 'POST', url: `${API}/functions/v1/read`, via: 'CLI readSignals; exact note readback' });
  return { dry_run: true, subcommand: o.command, user_agent: UA, request_timeout_ms: o.requestMs,
    consent_timeout_ms: o.consentMs, total_timeout_ms: o.totalMs, requests };
}

async function run(o) {
  let leg = 'files';
  const deadline = Date.now() + o.totalMs;
  // Hard process bound also covers library locks/imports, not just HTTP.
  const timer = setTimeout(() => { process.stderr.write(`FAIL ${leg}: completion expected bounded run got total timeout; STOP\n`); process.exit(1); }, o.totalMs);
  const producer = sha256(await readFile(new URL(import.meta.url)));
  const release = o['release-sha'], cred = o['cred-dir'];
  let lock, receiptBytes; const rawFetch = globalThis.fetch;
  // Libraries use the identical transport policy. No URL, token or exception is logged.
  const transport = async (input, init = {}) => {
    const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    demand([ISSUER, API, 'https://commonswarm.com'].includes(u.origin) && !u.username && !u.password, 'pinned public origins', 'unexpected request origin');
    demand(Date.now() < deadline, 'bounded run', 'total timeout');
    const headers = new Headers(init.headers); headers.set('User-Agent', UA);
    const signal = AbortSignal.any([AbortSignal.timeout(Math.min(o.requestMs, deadline - Date.now())), ...(init.signal ? [init.signal] : [])]);
    const response = await rawFetch(input, { ...init, headers, signal, redirect: 'manual' });
    const bytes = await boundedBody(response);
    return new Response([204, 205, 304].includes(response.status) ? null : bytes, { status: response.status, headers: response.headers });
  };
  globalThis.fetch = transport;
  try {
    await directory(cred); await directory(dirname(o.out));
    const reserved = ['live-controls.lock', 'live-controls-state.json', 'dcr-client-ids.json'].map(name => join(cred, name));
    if (o.command === 'consent') for (const name of ['cimd', 'dcr']) for (const suffix of ['authorize-url', 'callback-url']) {
      reserved.push(join(o['pointer-dir'], `${name}-${suffix}.txt`));
    }
    demand(!reserved.includes(o.out), 'receipt distinct from credentials and handoffs', 'file path collision');
    await absent(o.out);
    const lockPath = join(cred, 'live-controls.lock');
    await absent(lockPath); lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    // Exclusive lock serializes refresh rotation and client-id journal updates.
    await lock.writeFile('running\n');
    const journalPath = join(cred, 'live-controls-state.json'), idsPath = join(cred, 'dcr-client-ids.json');
    let journalBytes = await privateRead(journalPath, true), idsBytes = await privateRead(idsPath, true);
    let journal = journalBytes ? json(journalBytes) : { release_sha: release, grants: [] };
    let ids = idsBytes ? json(idsBytes) : { release_sha: release, ids: [] };
    demand(exact(journal, ['release_sha', 'grants']) && journal.release_sha === release && Array.isArray(journal.grants) &&
      journal.grants.every(g => exact(g, ['client_id', 'refresh_token', 'consent_sha256', 'revoked']) &&
        (g.client_id === CLIENT || idOK(g.client_id)) && typeof g.refresh_token === 'string' && /^[a-f0-9]{64}$/.test(g.consent_sha256) && typeof g.revoked === 'boolean'), 'same-release grant journal');
    demand(exact(ids, ['release_sha', 'ids']) && ids.release_sha === release && Array.isArray(ids.ids) &&
      ids.ids.every(c => exact(c, ['client_id', 'last_used_at']) && idOK(c.client_id) && utc(c.last_used_at) && Date.parse(c.last_used_at) <= Date.now()) &&
      new Set(ids.ids.map(c => c.client_id)).size === ids.ids.length, 'same-release timestamped DCR ids journal');
    if (o.command === 'final-cleanup' || (o.command === 'consent' && o.phase === 'post-W5')) {
      demand(journalBytes && idsBytes && ids.ids.length > 0, 'retained grant and complete DCR journals', 'missing journal');
      demand(journal.grants.filter(g => g.client_id !== CLIENT).every(g => ids.ids.some(c => c.client_id === g.client_id)),
        'complete consent DCR journal', 'missing journal ids');
    }
    const saveGrants = async () => { await writePrivate(journalPath, JSON.stringify(journal) + '\n', !journalBytes); journalBytes = true; };
    const saveIds = async () => { await writePrivate(idsPath, JSON.stringify(ids) + '\n', !idsBytes); idsBytes = true; };
    const request = async (url, { status = 200, ...init } = {}) => {
      const r = await transport(url, { headers: { Accept: 'application/json', ...init.headers }, ...init });
      demand((Array.isArray(status) ? status : [status]).includes(r.status), `HTTP ${[].concat(status).join('/')}`, `HTTP ${r.status}`);
      const b = await boundedBody(r);
      if ([202, 204].includes(r.status)) return null;
      demand(r.headers.get('content-type')?.split(';')[0].trim() === 'application/json', 'JSON response', 'wrong content type');
      const value = json(b); demand(object(value), 'JSON object'); return value;
    };
    const form = params => ({ method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams(params).toString() });
    leg = 'discovery';
    const discovery = await request(`${ISSUER}/.well-known/oauth-authorization-server`);
    demand(discovery.issuer === ISSUER && discovery.code_challenge_methods_supported?.includes('S256') &&
      discovery.scopes_supported?.includes('mcp') && !discovery.require_pushed_authorization_requests, 'ordinary discovery, PKCE and scope');
    const authorize = endpoint(discovery.authorization_endpoint), tokenUrl = endpoint(discovery.token_endpoint), registerUrl = endpoint(discovery.registration_endpoint);
    const metadata = await request(`${ISSUER}/.well-known/oauth-protected-resource/mcp`);
    demand(metadata.resource === RESOURCE && metadata.authorization_servers?.includes(ISSUER) && metadata.scopes_supported?.includes('mcp'), 'ordinary protected resource');
    const register = async () => {
      const body = { application_type: 'web', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE };
      const c = await request(registerUrl, { method: 'POST', status: 201, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      demand(idOK(c.client_id), 'safe DCR client id');
      demand(!ids.ids.some(entry => entry.client_id === c.client_id), 'fresh DCR client id', 'duplicate registration id');
      ids.ids.push({ client_id: c.client_id, last_used_at: new Date().toISOString() }); await saveIds(); // Retain id even if echoed metadata is wrong.
      demand(c.token_endpoint_auth_method === 'none' && !c.client_secret && !c.registration_access_token &&
        c.application_type === body.application_type && JSON.stringify(c.redirect_uris) === JSON.stringify(body.redirect_uris) &&
        JSON.stringify(c.grant_types) === JSON.stringify(body.grant_types) && JSON.stringify(c.response_types) === JSON.stringify(body.response_types) && c.scope === SCOPE,
      '201 public registration with metadata echoed'); return c.client_id;
    };
    const cimd = async () => {
      const c = await request(CLIENT);
      demand(c.client_id === CLIENT && c.application_type === 'web' && c.token_endpoint_auth_method === 'none' &&
        c.redirect_uris?.length === 1 && c.redirect_uris[0] === REDIRECT && c.grant_types?.includes('authorization_code') &&
        c.grant_types?.includes('refresh_token') && c.response_types?.length === 1 && c.response_types[0] === 'code' &&
        c.scope === SCOPE && !c.dpop_bound_access_tokens && !c.client_secret, 'ordinary public CIMD metadata');
    };
    const mcp = async t => {
      const headers = { Authorization: `Bearer ${t.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
      const rpc = (id, method, params) => request(RESOURCE, { method: 'POST', headers,
        ...(id === null ? { status: [202, 204] } : {}), body: JSON.stringify({ jsonrpc: '2.0', ...(id === null ? {} : { id }), method, ...(params ? { params } : {}) }) });
      const init = await rpc(1, 'initialize', { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'c1-live-controls', version: '1' } });
      demand(init.jsonrpc === '2.0' && init.id === 1 && !init.error && init.result?.serverInfo?.name === 'commonswarm' &&
        ['2025-03-26', VERSION, '2025-11-25'].includes(init.result?.protocolVersion), 'MCP initialize');
      headers['MCP-Protocol-Version'] = init.result.protocolVersion;
      await rpc(null, 'notifications/initialized'); const list = await rpc(2, 'tools/list', {});
      const names = list.result?.tools?.map(t => t.name);
      demand(list.jsonrpc === '2.0' && list.id === 2 && !list.error && !list.result?.nextCursor && Array.isArray(names) &&
        names.length === TOOLS.length && new Set(names).size === TOOLS.length && TOOLS.every(n => names.includes(n)), 'exact ordinary MCP tool set');
    };
    const refresh = async g => tokenContract(await request(tokenUrl, form({ grant_type: 'refresh_token', client_id: g.client_id,
      refresh_token: g.refresh_token, resource: RESOURCE })));
    const boundGrant = bytes => {
      const g = journal.grants.find(g => g.client_id === CLIENT && g.consent_sha256 === sha256(bytes));
      demand(g, 'retained CIMD grant bound to consent receipt', 'missing grant'); return g;
    };
    const expiring = entries => entries.map(c => ({ client_id: c.client_id,
      expires_after: new Date(Date.parse(c.last_used_at) + EXPIRY_MS).toISOString() }));
    const completeIds = clientIds => demand(clientIds.every(id => ids.ids.some(c => c.client_id === id)),
      'complete receipt DCR journal', 'missing journal ids');
    const fence = async g => {
      const rejected = async refreshToken => {
        const response = await transport(tokenUrl, form({ grant_type: 'refresh_token', client_id: g.client_id,
          refresh_token: refreshToken, resource: RESOURCE }));
        demand([200, 400].includes(response.status) && response.headers.get('content-type')?.split(';')[0].trim() === 'application/json',
          'HTTP 400 JSON invalid_grant proof', `HTTP ${response.status} or wrong content type`);
        const result = json(await boundedBody(response));
        if (response.status !== 400 || result.error !== 'invalid_grant') {
          // Retain rotation if a dishonest revocation still issued a token.
          if (typeof result.refresh_token === 'string' && result.refresh_token.length > 0 && result.refresh_token.length <= 8192) {
            g.refresh_token = result.refresh_token; g.revoked = false; await saveGrants();
          }
          throw new Failure('revoked refresh rejected with invalid_grant', 'revocation unproven');
        }
      };
      if (!g.revoked) {
        if (discovery.revocation_endpoint) {
          const r = await transport(endpoint(discovery.revocation_endpoint), form({ client_id: g.client_id, token: g.refresh_token, token_type_hint: 'refresh_token' }));
          demand([200, 204].includes(r.status), 'grant revocation success', `HTTP ${r.status}`); await boundedBody(r);
        } else {
          // This issuer's rotation/replay path fences the entire grant family.
          const old = g.refresh_token, rotated = await refresh(g);
          demand(rotated.refresh_token !== old, 'rotating refresh credential', 'unchanged refresh token');
          g.refresh_token = rotated.refresh_token; await saveGrants(); await rejected(old);
        }
      }
      await rejected(g.refresh_token); g.revoked = true; await saveGrants();
    };
    let receipt;
    if (o.command === 'consent') {
      leg = 'consent_files'; await directory(o['pointer-dir']);
      for (const name of ['cimd', 'dcr']) for (const suffix of ['authorize-url', 'callback-url']) await absent(join(o['pointer-dir'], `${name}-${suffix}.txt`));
      let cleanup = null;
      if (o.phase === 'post-W5') {
        leg = 'cleanup';
        const priorBytes = await privateRead(o['prior-consent']);
        const prior = consentReceipt(priorBytes, release, producer, 'pre-W1');
        completeIds(prior.dcr_client_ids);
        cleanup = { grants_revoked: true, dcr_clients_expiring: expiring(ids.ids) };
        demand(cleanup.dcr_clients_expiring.every(c => Date.parse(c.expires_after) > Date.now()),
          'future DCR expiration deadlines', 'journal deadline elapsed');
        // Prove the old grant is fenced BEFORE either new consent handoff.
        await fence(boundGrant(priorBytes));
      }
      receipt = { kind: 'c1-consent', release_sha: release, consent_phase: o.phase, measured_at: '', producer_sha256: producer,
        controls: { cimd_consent: false, dcr_registration_consent: false }, dcr_client_ids: [], cleanup };
      const newGrants = [];
      for (const name of ['cimd', 'dcr']) {
        leg = name === 'cimd' ? 'cimd_consent' : 'dcr_registration_consent';
        if (name === 'cimd') await cimd();
        const clientId = name === 'cimd' ? CLIENT : await register();
        if (name === 'dcr') receipt.dcr_client_ids.push(clientId);
        const a = authorization(authorize, clientId), callbackPath = join(o['pointer-dir'], `${name}-callback-url.txt`);
        await writePrivate(join(o['pointer-dir'], `${name}-authorize-url.txt`), a.url + '\n');
        const end = Math.min(Date.now() + o.consentMs, deadline); let bytes;
        while (Date.now() < end) { bytes = await privateRead(callbackPath, true); if (bytes?.length) break; await sleep(100); }
        demand(bytes?.length, 'callback within consent timeout', 'handoff timeout');
        const code = callback(bytes, a.state);
        const issued = await request(tokenUrl, form({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: REDIRECT,
          code, code_verifier: a.verifier, resource: RESOURCE }));
        if (name === 'dcr') {
          ids.ids.find(c => c.client_id === clientId).last_used_at = new Date().toISOString(); await saveIds();
        }
        const t = tokenContract(issued);
        const g = { client_id: clientId, refresh_token: t.refresh_token, consent_sha256: '0'.repeat(64), revoked: false };
        journal.grants.push(g); newGrants.push(g); await saveGrants();
        await mcp(t); receipt.controls[leg] = true;
      }
      if (cleanup) demand(receipt.dcr_client_ids.every(id => !cleanup.dcr_clients_expiring.some(c => c.client_id === id)),
        'cleanup disjoint from new consent ids', 'own ids in cleanup');
      receipt.measured_at = new Date().toISOString();
      const bytes = JSON.stringify(receipt, null, 2) + '\n';
      if (cleanup) leg = 'cleanup';
      consentReceipt(Buffer.from(bytes), release, producer, o.phase);
      for (const g of newGrants) g.consent_sha256 = sha256(bytes);
      await saveGrants(); receiptBytes = bytes;
    } else if (o.command === 'final-cleanup') {
      leg = 'final_cleanup';
      const bytes = await privateRead(o['consent-receipt']);
      const consent = consentReceipt(bytes, release, producer, 'post-W5');
      completeIds([...consent.dcr_client_ids, ...consent.cleanup.dcr_clients_expiring.map(c => c.client_id)]);
      for (const c of consent.cleanup.dcr_clients_expiring) {
        const entry = ids.ids.find(entry => entry.client_id === c.client_id);
        demand(expiring([entry])[0].expires_after === c.expires_after, 'unchanged prior DCR expiration journal', 'journal time mismatch');
      }
      await fence(boundGrant(bytes));
      const earlier = new Set(consent.cleanup.dcr_clients_expiring.map(c => c.client_id));
      receipt = { kind: 'c1-final-cleanup', release_sha: release, measured_at: new Date().toISOString(), producer_sha256: producer,
        grants_revoked: true, dcr_clients_expiring: expiring(ids.ids.filter(c => !earlier.has(c.client_id))) };
      receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
    } else {
      leg = 'consent_binding'; const bytes = await privateRead(o['consent-receipt']);
      const expectedPhase = ['W6', 'W7'].includes(o.window) || (o.window === 'W5' && o.phase !== 'before') ? 'post-W5' : 'pre-W1';
      const consent = consentReceipt(bytes, release, producer, expectedPhase);
      if (o.window === 'W1' && o.phase === 'before') {
        const age = Date.now() - Date.parse(consent.measured_at);
        demand(age >= 0 && age <= 6 * 60 * 60 * 1000, 'pre-W1 consent no older than 6 hours and not in future', 'stale or future consent');
      }
      const consentHash = sha256(bytes), grant = journal.grants.find(g => g.client_id === CLIENT && g.consent_sha256 === consentHash && !g.revoked);
      demand(grant, 'unrevoked CIMD grant bound to consent receipt', 'missing or revoked grant');
      // Validate both profiles before consuming any grant or creating a client.
      leg = 'profiles';
      for (const dir of [o['human-profile'], o['seat-profile']]) { await directory(dir);
        for (const name of await readdir(dir)) { const s = await lstat(join(dir, name)); if (s.isDirectory()) await directory(join(dir, name)); else await privateRead(join(dir, name)); } }
      const targetDocument = json(await privateRead(join(o['human-profile'], 'target.json')));
      demand(exact(targetDocument, ['url', 'anon_key']) && targetDocument.url === API && typeof targetDocument.anon_key === 'string' && targetDocument.anon_key.length > 0, 'human test target file');
      const { cloudTarget } = await import('../dist/cloud/config.js');
      const { credentialStore } = await import('../dist/cloud/storage.js');
      const { refreshedCredential } = await import('../dist/cloud/auth.js');
      const { readAgentProfile, readProfileCredential } = await import('../dist/cloud/agent-profile.js');
      const { readAgentSignalDirectory, readSignals } = await import('../dist/cloud/signals.js');
      const { ThinCommandClient } = await import('../dist/cloud/command-client.js');
      const target = cloudTarget(API, targetDocument.anon_key);
      const store = await credentialStore({ target, stateDirectory: o['human-profile'], forceFile: true, allowFileFallback: true, warn: () => {} });
      await privateRead(store.location); await privateRead(join(o['human-profile'], `${target.profileId}.profile.json`));
      const humanProfile = await store.readProfile();
      const seat = await readAgentProfile(join(o['seat-profile'], 'profile.json'));
      demand(seat.url === API && seat.workspace_id === humanProfile.workspaceId, 'same test workspace and hosted target');
      await privateRead(seat.credential_file); const agent = await readProfileCredential(seat);
      receipt = { release_sha: release, window_id: o['window-id'], window: o.window, phase: o.phase,
        controls: { hosted_mcp_consent_refresh: false, dcr_registration_consent: false, cimd_consent: false, human_recovery: false, worker_command_read: false },
        consent_receipt_sha256: consentHash, producer_sha256: producer, dcr_client_ids: [] };
      leg = 'hosted_mcp_consent_refresh'; const t = await refresh(grant); grant.refresh_token = t.refresh_token; await saveGrants(); await mcp(t); receipt.controls[leg] = true;
      leg = 'dcr_registration_consent'; receipt.dcr_client_ids.push(await register()); receipt.controls[leg] = true;
      leg = 'cimd_consent'; await cimd();
      const r = await transport(authorization(authorize, CLIENT).url); await boundedBody(r);
      let location; try { location = new URL(r.headers.get('location'), ISSUER); } catch { throw new Failure('interaction redirect', 'missing location'); }
      demand(r.status === 303 && location.origin === ISSUER && /^\/interaction\/[A-Za-z0-9_-]+$/.test(location.pathname) && !location.username && !location.password,
        '303 to issuer interaction', `HTTP ${r.status} or unexpected location`); receipt.controls[leg] = true;
      leg = 'human_recovery'; const human = await refreshedCredential(target, store);
      demand(human.userId === humanProfile.userId, 'same human session after refresh');
      const w = new URL(`${API}/rest/v1/workspaces`); w.search = new URLSearchParams({ select: 'workspace_id,name', workspace_id: `eq.${seat.workspace_id}`, limit: '1' });
      const hr = await transport(w, { headers: { Authorization: `Bearer ${human.accessToken}`, apikey: target.anonKey, 'Accept-Profile': 'swarm_read', Accept: 'application/json' } });
      demand(hr.status === 200, 'successful human read', `HTTP ${hr.status}`); const rows = json(await boundedBody(hr));
      demand(Array.isArray(rows) && rows.length === 1 && rows[0].workspace_id === seat.workspace_id && rows[0].name === WORKSPACE, 'live human read of test workspace'); receipt.controls[leg] = true;
      leg = 'worker_command_read'; const seatTarget = cloudTarget(seat.url, seat.anon_key);
      const directoryResult = await readAgentSignalDirectory(seatTarget, agent.token, seat.workspace_id, transport);
      demand(directoryResult.identity?.credential_valid === true && directoryResult.identity.workspace_id === seat.workspace_id &&
        directoryResult.identity.principal_id === seat.principal_id && directoryResult.identity.workspace_name === WORKSPACE, 'live test seat and workspace identity');
      const body = `C1 ordinary control ${o.window}/${o['window-id']}/${o.phase} ${randomBytes(12).toString('hex')}`;
      const result = await new ThinCommandClient(seatTarget, transport, { signalRequestTimeoutMs: o.requestMs }).sendSignal({ workspaceId: seat.workspace_id, credential: agent.token,
        commandId: `c1_controls_${randomBytes(12).toString('hex')}`, command: { kind: 'post_signal', signal_kind: 'note', body,
          to_user_id: null, to_agent_principal_id: null, in_reply_to: null, about: null }, signal: AbortSignal.timeout(o.requestMs) });
      const signal = result.response.signal;
      demand(result.response.status === 'accepted' && typeof signal?.id === 'string' && signal.body === body && signal.kind === 'note', 'accepted synthetic worker note');
      const readback = await readSignals(seatTarget, { kind: 'agent', token: agent.token }, { workspaceId: seat.workspace_id, inbox: false, kind: 'note', limit: 100, includeStale: false }, transport);
      demand(readback.some(s => s.id === signal.id && s.workspace_id === seat.workspace_id && s.from === seat.principal_id && s.kind === 'note' && s.body === body), 'exact synthetic note readback'); receipt.controls[leg] = true;
      receiptBytes = JSON.stringify(receipt, null, 2) + '\n';
    }

  } catch (e) {
    process.stderr.write(`FAIL ${leg}: control expected ${e instanceof Failure ? e.expected : 'successful bounded operation'} got ${e instanceof Failure ? e.got : 'request, file or runtime failure'}; STOP\n`);
    process.exitCode = 1;
  } finally {
    globalThis.fetch = rawFetch; clearTimeout(timer);
    if (lock) {
      await lock.close();
      // Use the machine's deletion guard, never unlink/rm around it.
      try { await promisify(execFile)('rm', [join(cred, 'live-controls.lock')], { timeout: 5000 }); }
      catch { process.stderr.write('FAIL lock_cleanup: removal expected guarded rm success got refusal; live-controls.lock retained; STOP\n'); process.exitCode = 1; }
    }
  }
  if (receiptBytes && !process.exitCode) {
    try { await writePrivate(o.out, receiptBytes); process.stdout.write(`PASS live ordinary controls; ${o.command === 'final-cleanup' ? 'final-cleanup report' : 'receipt'} written\n`); }
    catch { process.stderr.write('FAIL receipt: output expected fresh 0600 receipt got file failure; STOP\n'); process.exitCode = 1; }
  }
}
try {
  const o = options(process.argv.slice(2));
  demand(Number(process.versions.node.split('.')[0]) >= 22, 'Node 22 or newer');
  if (o.dry) process.stdout.write(JSON.stringify(plan(o), null, 2) + '\n'); else await run(o);
} catch (e) {
  process.stderr.write(`FAIL options: invocation expected ${e instanceof Failure ? e.expected : 'valid invocation'} got ${e instanceof Failure ? e.got : 'invalid invocation'}; STOP\n`); process.exitCode = 1;
}
