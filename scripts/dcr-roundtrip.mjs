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
const CONSENT_MS = 10 * 60_000;
const VERSION = '2025-06-18';
const SCOPES = new Set(['openid', 'offline_access', 'mcp']);

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
  };
}

export function dryRunPlan() {
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
    const finish = (error) => {
      clearTimeout(timer);
      input.off('data', data); input.off('end', ended); input.off('error', failed);
      if (input.isTTY) input.setRawMode(wasRaw === true);
      input.pause();
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

async function roundtrip() {
  const receipt = { ok: false, requests: {} };
  let stage = 'discovery';
  async function request(key, url, { method = 'GET', body, headers = {}, status = 200 } = {}) {
    stage = key;
    const response = await fetch(url, { method, body, headers: {
      'User-Agent': UA, Accept: 'application/json', ...headers,
    }, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS) });
    receipt.requests[key] = { status: response.status, content_type: response.headers.get('content-type') };
    requireThat(response.status === status, 'unexpected_http_status');
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
  if (args.length === 1 && args[0] === '--dry-run') {
    process.stdout.write(`${JSON.stringify(dryRunPlan(), null, 2)}\n`);
  } else if (args.length === 0) {
    requireThat(Number(process.versions.node.split('.')[0]) >= 22, 'node_22_required');
    await roundtrip();
  } else {
    process.stderr.write('Usage: node scripts/dcr-roundtrip.mjs [--dry-run]\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
