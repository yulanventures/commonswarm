#!/usr/bin/env node
// No persistence, browser launch, dependencies, or registration retries.
import { createHash, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const ISSUER = 'https://mcp.commonswarm.com';
const RESOURCE = `${ISSUER}/mcp`;
// This HTTPS redirect was accepted by the DCR release probe. It never receives
// a request at a third-party server; the browser retains the failed URL locally.
const REDIRECT = 'https://dcr-release-probe.invalid/callback';
const UA = 'curl/8.7.1';
const REQUEST_MS = 10_000;
const CONSENT_MS = 25 * 60_000;
const VERSION = '2025-06-18';
const SCOPES = new Set(['openid', 'offline_access', 'mcp']);
// Must match supabase/functions/mcp/tools.ts after this release. The service-free
// DCR exercise test compares this explicit release inventory with the hosted table.
const TOOL_NAMES = new Set(['claim_seat', 'whoami', 'close_session', 'check', 'ask', 'note', 'reply', 'working_on', 'members']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HANDLE = /^seat_[A-Za-z0-9_-]{22,64}$/u;
const SHAPE_KEYS = new Set(['grant_id', 'seat_id', 'handle', 'workspace_id', 'principal_id',
  'name', 'transport', 'turn_only', 'members', 'agents', 'signal_id', 'kind', 'created_at',
  'in_reply_to', 'batch_id', 'signals', 'cursor', 'acknowledged_batch_id', 'error', 'reused',
  'status', 'object_id', 'revision', 'objects', 'next_offset', 'revisions', 'content',
  'value', 'notices', 'request_id', 'replayed', 'todo', 'todos', 'comments', 'next_comment_offset',
  'owner_user_id', 'content_access', 'accepts_from', 'read_at', 'queue', 'working', 'up_next', 'not_yet', 'requests']);

function parseOptions(args) {
  const options = { dryRun: false, exerciseTools: false, workspaceId: undefined };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) return null;
    seen.add(arg);
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--exercise-tools') options.exerciseTools = true;
    else if (arg === '--test-workspace') options.workspaceId = args[++i];
    else return null;
  }
  if (options.exerciseTools !== (options.workspaceId !== undefined)) return null;
  if (options.exerciseTools && (!UUID.test(options.workspaceId) ||
    options.workspaceId.toLowerCase() === '00000000-0000-4000-8000-000000000000')) return null;
  if (options.workspaceId) options.workspaceId = options.workspaceId.toLowerCase();
  return options;
}

class Failure extends Error {}
function requireThat(condition, reason) {
  if (!condition) throw new Failure(reason);
}

export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function registrationBody() {
  return {
    redirect_uris: [REDIRECT],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code'],
    response_types: ['code'],
  };
}

function authorizeUrl(endpoint, clientId, state, challenge) {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: REDIRECT,
    response_type: 'code', scope: 'mcp', resource: RESOURCE, state,
    code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  return url.href;
}

export function callbackCode(value, state) {
  let url;
  try { url = new URL(value); } catch { throw new Failure('invalid_callback_url'); }
  requireThat(url.origin + url.pathname === REDIRECT && !url.hash &&
    !url.username && !url.password, 'wrong_callback');
  requireThat(url.searchParams.getAll('state').length === 1 &&
    url.searchParams.get('state') === state, 'state_mismatch');
  if (url.searchParams.has('iss')) {
    requireThat(url.searchParams.getAll('iss').length === 1 &&
      url.searchParams.get('iss') === ISSUER, 'issuer_mismatch');
  }
  requireThat(!url.searchParams.has('error'), 'consent_refused');
  const code = url.searchParams.get('code');
  requireThat(url.searchParams.getAll('code').length === 1 &&
    typeof code === 'string' && code.length > 0, 'code_missing');
  return code;
}

function mediaType(value) {
  const type = typeof value === 'string' ? value.split(';')[0].trim().toLowerCase() : '';
  return ['application/json', 'text/event-stream', 'text/html'].includes(type) ? type : 'other';
}

// Project an allowlist instead of serializing arbitrary remote payloads. Even
// the allowed string fields cannot carry an attacker-supplied token or code.
export function redactedReceipt(receipt) {
  const scope = typeof receipt.token?.scope === 'string' ? receipt.token.scope.split(' ') : [];
  const clientId = receipt.clientId;
  return {
    ok: receipt.ok === true,
    requests: Object.fromEntries(Object.entries(receipt.requests ?? {}).filter(([key]) =>
      ['discovery', 'resource_metadata', 'registration', 'token', 'initialize', 'initialized', 'tools_list'].includes(key)
    ).map(([key, row]) => [key, {
      status: Number.isInteger(row.status) && row.status >= 100 && row.status <= 599 ? row.status : null,
      content_type: mediaType(row.content_type),
    }])),
    client_id_prefix: typeof clientId === 'string' && /^[A-Za-z0-9_-]{24,}$/u.test(clientId)
      ? clientId.slice(0, 8) : null,
    token_type: receipt.token?.token_type === 'Bearer' ? 'Bearer' : null,
    expires_in: Number.isSafeInteger(receipt.token?.expires_in) && receipt.token.expires_in >= 0
      ? receipt.token.expires_in : null,
    scope: scope.length > 0 && scope.length <= 3 && scope.every(item => SCOPES.has(item))
      ? scope.join(' ') : null,
    tool_count: Number.isSafeInteger(receipt.toolCount) && receipt.toolCount >= 0 ? receipt.toolCount : null,
    mcp_server_name: receipt.serverName === 'commonswarm' ? 'commonswarm' : null,
    ...(receipt.toolCalls ? { tool_calls: receipt.toolCalls.map(safeToolReceipt) } : {}),
  };
}

function safeToolReceipt(row) {
  return {
    tool: TOOL_NAMES.has(row.tool) || row.tool === 'directory_review_unknown_tool' ? row.tool : 'other',
    ok: row.ok === true,
    error_code: [-32602, 'hosted_seat_forbidden', 'upgrade_required'].includes(row.error_code) ? row.error_code
      : row.error_code == null ? null : 'other',
    duration_ms: Number.isSafeInteger(row.duration_ms) && row.duration_ms >= 0 &&
      row.duration_ms <= 60_000 ? row.duration_ms : null,
    result_shape: Array.isArray(row.result_shape) ? [...new Set(row.result_shape.map(key =>
      SHAPE_KEYS.has(key) ? key : '[redacted-key]'))].sort() : [],
  };
}

// Check constructed arguments against the advertised schemas before any writes.
// This intentionally supports only the bounded schema vocabulary used by these tools.
function matchesSchema(value, schema) {
  if (!schema || typeof schema !== 'object') return false;
  if (schema.oneOf) return schema.oneOf.filter(choice => matchesSchema(value, choice)).length === 1;
  if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
  if (schema.type === 'null') return value === null;
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'integer') return Number.isSafeInteger(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.not?.enum?.includes(value)) return false;
  if (schema.type === 'string') return typeof value === 'string' &&
    Array.from(value).length >= (schema.minLength ?? 0) &&
    Array.from(value).length <= (schema.maxLength ?? Infinity) &&
    (!schema.pattern || new RegExp(schema.pattern, 'u').test(value));
  if (schema.type === 'array') return Array.isArray(value) &&
    value.length >= (schema.minItems ?? 0) && value.length <= (schema.maxItems ?? Infinity) &&
    value.every(item => matchesSchema(item, schema.items));
  if (schema.type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (schema.required ?? []).every(key => Object.hasOwn(value, key)) &&
    Object.entries(value).every(([key, item]) => Object.hasOwn(schema.properties ?? {}, key) &&
      matchesSchema(item, schema.properties[key]));
  return false;
}

async function exerciseHostedTools(catalog, workspaceId, rpc, receipts) {
  requireThat(catalog.length === TOOL_NAMES.size && new Set(catalog.map(t => t.name)).size === TOOL_NAMES.size &&
    catalog.every(t => TOOL_NAMES.has(t.name) && t.annotations?.openWorldHint === false), 'exercise_catalog_failed');
  const schemas = new Map(catalog.map(t => [t.name, t.inputSchema]));
  const run = randomBytes(12).toString('hex');
  const requestId = tag => `review_${run}_${tag}`;
  let sequence = 2;
  async function call(name, args, expectedError = null) {
    if (expectedError === null) requireThat(matchesSchema(args, schemas.get(name)), 'exercise_schema_failed');
    const started = performance.now();
    const row = { tool: name,
      ok: false, error_code: 'other', duration_ms: null, result_shape: [] };
    receipts.push(row);
    let envelope;
    try { envelope = await rpc(++sequence, name, args); }
    finally { row.duration_ms = Math.round(performance.now() - started); }
    requireThat(envelope.jsonrpc === '2.0' && envelope.id === sequence, 'exercise_rpc_failed');
    let output = {};
    if (!envelope.error) {
      requireThat(Array.isArray(envelope.result?.content) && envelope.result.content.length === 1 &&
        envelope.result.content[0].type === 'text', 'exercise_result_failed');
      try { output = JSON.parse(envelope.result.content[0].text); }
      catch { throw new Failure('exercise_result_failed'); }
      requireThat(output !== null && typeof output === 'object' && !Array.isArray(output), 'exercise_result_failed');
    }
    const code = envelope.error?.code ?? (envelope.result?.isError === true ? output.error ?? 'other' : null);
    Object.assign(row, safeToolReceipt({ ...row, ok: code === null, error_code: code,
      result_shape: Object.keys(output) }));
    requireThat(code === expectedError, 'exercise_unexpected_outcome');
    return output;
  }
  // These probes never reach a state-changing tool executor.
  await call('directory_review_unknown_tool', {}, -32602);
  await call('whoami', { seat: `seat_${randomBytes(24).toString('base64url')}` }, 'hosted_seat_forbidden');
  const claim = async tag => {
    const result = await call('claim_seat', { workspace_id: workspaceId,
      name: `Directory Review ${tag} ${run}`, request_id: requestId(`claim_${tag}`) });
    requireThat(HANDLE.test(result.handle) && result.workspace_id === workspaceId, 'exercise_workspace_failed');
    return result.handle;
  };
  const a = await claim('A'), b = await claim('B');
  requireThat(a !== b, 'exercise_seats_failed');
  const identity = async seat => {
    const result = await call('whoami', { seat });
    requireThat(result.handle === seat && result.workspace_id === workspaceId && UUID.test(result.principal_id),
      'exercise_workspace_failed');
    return result;
  };
  const identityA = await identity(a), identityB = await identity(b);
  requireThat(identityA.principal_id !== identityB.principal_id, 'exercise_seats_failed');
  await call('whoami', { seat: a, unexpected: true }, -32602);
  const roster = await call('members', { seat: a });
  requireThat(Array.isArray(roster.agents) && roster.agents.some(row => row.principal_id === identityB.principal_id),
    'exercise_roster_failed');
  const askBody = 'Is the synthetic review checklist ready?';
  const replyBody = 'Yes, the synthetic checklist is ready.';
  const ask = await call('ask', { seat: a, recipients: [{ kind: 'agent', id: identityB.principal_id }],
    body: askBody, request_id: requestId('ask') });
  requireThat(UUID.test(ask.signal_id) && ask.kind === 'ask', 'exercise_signal_failed');
  const inboxB = await call('check', { seat: b });
  requireThat(Array.isArray(inboxB.signals) && inboxB.signals.some(s => s.id === ask.signal_id && s.body === askBody), 'exercise_readback_failed');
  const reply = await call('reply', { seat: b, signal_id: ask.signal_id,
    body: replyBody, request_id: requestId('reply') });
  requireThat(UUID.test(reply.signal_id) && reply.kind === 'reply' && reply.in_reply_to === ask.signal_id, 'exercise_reply_failed');
  const inboxA = await call('check', { seat: a });
  requireThat(Array.isArray(inboxA.signals) && inboxA.signals.some(s =>
    s.id === reply.signal_id && s.body === replyBody && s.in_reply_to === ask.signal_id), 'exercise_readback_failed');
  const note = await call('note', { seat: a, recipients: [{ kind: 'agent', id: identityB.principal_id }],
    body: 'The synthetic review fixture is ready.', request_id: requestId('note') });
  requireThat(UUID.test(note.signal_id) && note.kind === 'note', 'exercise_signal_failed');
  const work = await call('working_on', { seat: a, body: 'Checking the synthetic review checklist.', request_id: requestId('work') });
  requireThat(UUID.test(work.signal_id) && work.kind === 'working_on', 'exercise_signal_failed');
  // Phase 2 advertises the close contract; phase 4 will wire its lifecycle.
  // Require the current fail-closed scaffold rather than fabricate cleanup.
  const closeArgs = { seat: a, request_id: requestId('close') };
  requireThat(matchesSchema(closeArgs, schemas.get('close_session')), 'exercise_schema_failed');
  await call('close_session', closeArgs, 'upgrade_required');
  // Do not ACK: a batch can also include existing workspace signals.
}

export function dryRunPlan({ exerciseTools = false, workspaceId } = {}) {
  return {
    dry_run: true, user_agent: UA, request_timeout_ms: REQUEST_MS,
    consent_timeout_ms: CONSENT_MS, callback_mode: 'hidden-stdin-full-url',
    requests: [
      { method: 'GET', url: `${ISSUER}/.well-known/oauth-authorization-server` },
      { method: 'GET', url: `${ISSUER}/.well-known/oauth-protected-resource/mcp` },
      { method: 'POST', url: '<advertised registration_endpoint>', body: registrationBody() },
      { method: 'GET (human)', url: authorizeUrl(`${ISSUER}/authorize`, '<new client_id>', '<state>', '<S256 challenge>') },
      { method: 'POST', url: '<advertised token_endpoint>', content_type: 'application/x-www-form-urlencoded',
        body: { grant_type: 'authorization_code', client_id: '<new client_id>', redirect_uri: REDIRECT,
          code: '<memory only>', code_verifier: '<memory only>', resource: RESOURCE } },
      { method: 'POST', url: RESOURCE, authorization: 'Bearer <memory only>', rpc: 'initialize' },
      { method: 'POST', url: RESOURCE, authorization: 'Bearer <memory only>', rpc: 'notifications/initialized' },
      { method: 'POST', url: RESOURCE, authorization: 'Bearer <memory only>', rpc: 'tools/list' },
      ...(exerciseTools ? [{ method: 'POST', url: RESOURCE, rpc: 'tools/call',
        plan: 'two synthetic seats; identity/roster; ask/check/reply/check; note/current work; three negative probes; close_session unavailable control',
        workspace_id_prefix: workspaceId.slice(0, 8), cleanup: 'close_session must return upgrade_required until lifecycle wiring; no cleanup or ACK of existing signals.' }] : []),
    ],
  };
}

function endpoint(value) {
  let url;
  try { url = new URL(value); } catch { throw new Failure('invalid_discovery_endpoint'); }
  requireThat(url.origin === ISSUER && !url.username && !url.password && !url.search && !url.hash,
    'unexpected_discovery_endpoint');
  return url.href;
}

function hiddenCallback() {
  // Raw TTY mode suppresses echo without changing HOME or launching stty.
  // Pipes are supported for a direct, private producer; never use shell history.
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    const wasRaw = input.isRaw;
    let value = '';
    let finished = false;
    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.off('data', data); input.off('end', ended); input.off('error', failed);
      if (input.isTTY) input.setRawMode(wasRaw === true);
      input.pause();
      // Stdin is consumed only once. Pausing an open pipe can retain its handle
      // after the receipt, so close the reader without waiting for producer EOF.
      input.destroy();
      if (error) reject(error); else resolve(value);
    };
    const data = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') return finish(new Failure('cancelled'));
        if (character === '\r' || character === '\n') return finish();
        if (character === '\u007f' || character === '\b') value = value.slice(0, -1);
        else value += character;
        if (value.length > 16_384) return finish(new Failure('callback_too_large'));
      }
    };
    const ended = () => finish(new Failure('callback_input_closed'));
    const failed = () => finish(new Failure('callback_input_failed'));
    const timer = setTimeout(() => finish(new Failure('consent_timeout')), CONSENT_MS);
    if (input.isTTY) input.setRawMode(true);
    input.on('data', data); input.once('end', ended); input.once('error', failed); input.resume();
  });
}

async function roundtrip({ exerciseTools = false, workspaceId } = {}) {
  const receipt = { ok: false, requests: {} };
  let stage = 'discovery';
  async function request(key, url, { method = 'GET', body, headers = {}, status = 200 } = {}) {
    stage = key;
    const response = await fetch(url, { method, body, headers: {
      'User-Agent': UA, Accept: 'application/json', ...headers,
    }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) });
    receipt.requests[key] = { status: response.status, content_type: response.headers.get('content-type') };
    requireThat((Array.isArray(status) ? status : [status]).includes(response.status), 'unexpected_http_status');
    if (status === 202) { await response.body?.cancel(); return null; }
    requireThat(mediaType(response.headers.get('content-type')) === 'application/json', 'expected_json');
    const text = await response.text();
    requireThat(text.length <= 1_048_576, 'response_too_large');
    let result;
    try { result = JSON.parse(text); } catch { throw new Failure('invalid_json'); }
    requireThat(result && typeof result === 'object' && !Array.isArray(result), 'invalid_response');
    return result;
  }
  try {
    const discovery = await request('discovery', `${ISSUER}/.well-known/oauth-authorization-server`);
    requireThat(discovery.issuer === ISSUER && discovery.registration_endpoint &&
      !discovery.pushed_authorization_request_endpoint && !discovery.require_pushed_authorization_requests,
      'discovery_contract_failed');
    requireThat(discovery.code_challenge_methods_supported?.includes('S256') &&
      discovery.scopes_supported?.includes('mcp'), 'discovery_pkce_or_scope_missing');
    const registrationEndpoint = endpoint(discovery.registration_endpoint);
    const authorizationEndpoint = endpoint(discovery.authorization_endpoint);
    const tokenEndpoint = endpoint(discovery.token_endpoint);
    const metadata = await request('resource_metadata', `${ISSUER}/.well-known/oauth-protected-resource/mcp`);
    requireThat(metadata.resource === RESOURCE && metadata.authorization_servers?.includes(ISSUER) &&
      metadata.scopes_supported?.includes('mcp'), 'resource_metadata_contract_failed');
    const client = await request('registration', registrationEndpoint, { method: 'POST', status: 201,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registrationBody()) });
    requireThat(typeof client.client_id === 'string' && /^[A-Za-z0-9_-]{24,}$/u.test(client.client_id) &&
      client.token_endpoint_auth_method === 'none' && !client.client_secret && !client.registration_access_token &&
      client.redirect_uris?.length === 1 && client.redirect_uris[0] === REDIRECT, 'registration_contract_failed');
    receipt.clientId = client.client_id;
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(32).toString('base64url');
    stage = 'consent';
    // Start hidden input before publishing the URL, so a quick paste cannot echo.
    const callback = hiddenCallback();
    process.stderr.write('Approve in the task-owned browser tab; paste the full callback URL here (hidden), then Enter.\n');
    process.stdout.write(`${authorizeUrl(authorizationEndpoint, client.client_id, state, pkceChallenge(verifier))}\n`);
    const code = callbackCode(await callback, state);
    const token = await request('token', tokenEndpoint, { method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', client_id: client.client_id,
        redirect_uri: REDIRECT, code, code_verifier: verifier, resource: RESOURCE }).toString() });
    requireThat(typeof token.access_token === 'string' && token.access_token.length > 0 &&
      token.token_type === 'Bearer' && Number.isSafeInteger(token.expires_in) && token.expires_in > 0 &&
      token.scope === 'mcp', 'token_contract_failed');
    receipt.token = token;
    const headers = { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream' };
    const initialized = await request('initialize', RESOURCE, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: VERSION, capabilities: {}, clientInfo: { name: 'dcr-roundtrip', version: '1.0.0' },
      } }) });
    requireThat(initialized.jsonrpc === '2.0' && initialized.id === 1 && !initialized.error &&
      initialized.result?.serverInfo?.name === 'commonswarm' &&
      ['2025-03-26', VERSION].includes(initialized.result?.protocolVersion), 'initialize_contract_failed');
    receipt.serverName = initialized.result.serverInfo.name;
    headers['MCP-Protocol-Version'] = initialized.result.protocolVersion;
    await request('initialized', RESOURCE, { method: 'POST', headers, status: 202,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const tools = await request('tools_list', RESOURCE, { method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) });
    requireThat(tools.jsonrpc === '2.0' && tools.id === 2 && !tools.error &&
      Array.isArray(tools.result?.tools) && tools.result.tools.length > 0 &&
      !tools.result.nextCursor, 'tools_list_contract_failed');
    receipt.toolCount = tools.result.tools.length;
    if (exerciseTools) {
      receipt.toolCalls = [];
      await exerciseHostedTools(tools.result.tools, workspaceId, async (id, name, arguments_) =>
        await request('tool_call', RESOURCE, { method: 'POST', headers, status: [200, 400],
          body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: arguments_ } }) }),
      receipt.toolCalls);
    }
    receipt.ok = true;
  } catch (error) {
    // Never serialize an exception, remote error description, or response body.
    process.stderr.write(`DCR round trip failed at ${stage}: ${error instanceof Failure ? error.message : 'request_or_runtime_failed'}.\n`);
    process.exitCode = 1;
  } finally {
    process.stdout.write(`${JSON.stringify(redactedReceipt(receipt), null, 2)}\n`);
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (!options) {
    process.stderr.write('Usage: node scripts/dcr-roundtrip.mjs [--dry-run] [--exercise-tools --test-workspace <UUID>]\n');
    process.exitCode = 2;
  } else if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(dryRunPlan(options), null, 2)}\n`);
  } else {
    requireThat(Number(process.versions.node.split('.')[0]) >= 22, 'node_22_required');
    await roundtrip(options);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
