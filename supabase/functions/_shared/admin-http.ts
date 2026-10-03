import { ADMIN_RESOURCE, ADMIN_AVAILABILITY, ADMIN_REGISTRY_VERSION, adminEffectiveCapabilities, adminRecord } from './protocol.js';
// @ts-ignore Deno uses explicit source extensions; Node harness executes this through tsx.
import { AdminProofError, type AdminAdmission, type AdminRequestVerifier, type AdminInput, type AdminAuditKind, type AdminSecurityReason } from './admin-oauth-auth.ts';
import type { AdminManifest } from './admin-policy.d.ts';

type Result = { status: number; body: Record<string, unknown> };
export interface AdminHttpDependencies {
  verifier: Pick<AdminRequestVerifier, 'verify'>;
  transact(input: AdminInput, admission: AdminAdmission, kind: AdminAuditKind, signal: AbortSignal): Promise<Result>;
  securityFailure(reason: AdminSecurityReason): Promise<void>;
}
const response = (status: number, body: unknown, headers: Record<string, string> = {}) => {
  const encoded = JSON.stringify(body);
  if (new TextEncoder().encode(encoded).length > 128 * 1024) return new Response('{"error":"response_too_large"}', { status: 503, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  return new Response(encoded, { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers } });
};
async function boundedBody(request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!request.body) throw new Error('invalid_request');
  const reader = request.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const next = await reader.read(); if (signal.aborted) throw new Error('request_expired'); if (next.done) break;
      size += next.value.length;
      if (size > 128 * 1024) { await reader.cancel(); throw new Error('invalid_request'); }
      chunks.push(next.value);
    }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const c of chunks) { bytes.set(c, offset); offset += c.length; }
  const result = adminRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  if (!result) throw new Error('invalid_request');
  return result;
}

/** Both transports enter the same raw proof verifier and authority transaction.
 * Discovery is public; all MCP messages, including init/notifications, are protected. */
export function createAdminHttpHandler(deps: AdminHttpDependencies, surface: 'admin_command' | 'admin_mcp') {
  let running = 0;
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (surface === 'admin_mcp' && request.method === 'GET' && url.pathname === '/admin/.well-known/oauth-protected-resource' && !url.search) {
      return response(200, { resource: ADMIN_RESOURCE, authorization_servers: ['https://mcp.commonswarm.com'],
        scopes_supported: [...new Set(Object.values(ADMIN_AVAILABILITY[ADMIN_REGISTRY_VERSION]!).filter(d => d.available).map(d => d.scope))],
        bearer_methods_supported: [], dpop_signing_alg_values_supported: ['ES256'] });
    }
    if (running >= 4) {
      try { await deps.securityFailure('rate_limited'); } catch { return response(503, { error: 'admin_failure_audit_unavailable' }); }
      return response(429, { error: 'rate_limited' });
    }
    running++;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 25_000);
    const abort = () => timeout.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    let admission: AdminAdmission | null = null;
    let kind: AdminAuditKind = 'action';
    let input: AdminInput | null = null;
    let attempted = false;
    try {
      const expectedPaths = surface === 'admin_command' ? ['/functions/v1/command', '/command'] : ['/admin'];
      if (!expectedPaths.includes(url.pathname) || url.search || url.hash) throw new Error('invalid_endpoint');
      admission = await deps.verifier.verify(request, surface);
      let body: Record<string, unknown>;
      try { body = request.method === 'POST' ? await boundedBody(request, timeout.signal) : {}; }
      catch { body = {}; }
      if (timeout.signal.aborted) throw new Error('request_expired');
      if (surface === 'admin_command') {
        input = body;
        kind = adminRecord(input.command)?.kind === 'admin_read_metadata' ? 'read' : 'action';
        attempted = true;
        const result = await deps.transact(input, admission, kind, timeout.signal);
        if (Date.now() >= admission.token.expires_at || timeout.signal.aborted) return response(401, { error: 'credential_expired' });
        return response(result.status, result.body);
      }
      const rpcId = typeof body.id === 'string' && body.id.length <= 128 || typeof body.id === 'number' && Number.isSafeInteger(body.id) ? body.id : null;
      const params = adminRecord(body.params);
      const supported = body.jsonrpc === '2.0' && request.method === 'POST' &&
        ['initialize','notifications/initialized','ping','tools/list','tools/call'].includes(String(body.method));
      kind = body.method === 'initialize' || body.method === 'notifications/initialized' || body.method === 'ping' ? 'init' : body.method === 'tools/list' ? 'list' : 'action';
      if (supported && body.method === 'tools/call') {
        const args = adminRecord(params?.arguments);
        const command = adminRecord(args?.command);
        input = { command_id: args?.command_id, stream: { kind: 'account' }, resource: ADMIN_RESOURCE,
          command: params?.name === command?.kind && args && Object.keys(args).every(k => ['command_id','command'].includes(k)) ? command : null };
        if (command?.kind === 'admin_read_metadata') kind = 'read';
      } else {
        input = { command_id: `adminmcp_${crypto.randomUUID()}`, stream: { kind: 'account' }, resource: ADMIN_RESOURCE,
          command: supported ? { kind: 'admin_read_metadata', grant_id: admission.token.admin_grant_id, resource_kind: 'grant', workspace_id: null } : null };
      }
      attempted = true;
        const result = await deps.transact(input, admission, kind, timeout.signal);
      if (Date.now() >= admission.token.expires_at || timeout.signal.aborted) return response(401, { error: 'credential_expired' });
      if (result.status !== 200) return response(result.status, { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message: String(result.body.error ?? 'forbidden') } });
      let output: unknown = result.body;
      if (body.method === 'initialize') output = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'commonswarm-admin', version: '1' } };
      if (body.method === 'ping') output = {};
      if (body.method === 'notifications/initialized') return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
      if (body.method === 'tools/list') {
        const grant = result.body.grant as AdminManifest;
        const effective = adminEffectiveCapabilities(grant, admission.token.scope_names).filter((name: string) => !Array.isArray(result.body.effective_capability_names) || result.body.effective_capability_names.includes(name));
        output = { tools: effective.map((name: string) => ({
          name, description: ADMIN_AVAILABILITY[grant.registry_version]?.[name]?.label,
          inputSchema: { type: 'object', properties: { command_id: { type: 'string', maxLength: 128 }, command: { type: 'object', properties: { kind: { const: name } } } }, required: ['command_id','command'], additionalProperties: false },
        })) };
      }
      if (body.method === 'tools/call') output = { content: [{ type: 'text', text: JSON.stringify(result.body) }] };
      return response(200, { jsonrpc: '2.0', id: rpcId, result: output });
    } catch (error) {
      if (admission && !attempted) {
        // Even a cancelled/malformed authenticated request reaches the adapter's
        // separate rollback audit. No unchecked body can supply a victim binding.
        try { await deps.transact(input ?? {}, admission, kind, timeout.signal); }
        catch { return response(503, { error: 'admin_failure_audit_unavailable' }); }
      }
      const reason: AdminSecurityReason = error instanceof AdminProofError ? error.code : admission ? 'transaction_failed' : 'invalid_token';
      try { if (!admission) await deps.securityFailure(reason); }
      catch { return response(503, { error: 'admin_failure_audit_unavailable' }); }
      if (error instanceof AdminProofError && error.code === 'nonce_required') return response(401, { error: 'use_dpop_nonce' }, {
        'www-authenticate': 'DPoP error="use_dpop_nonce"', 'dpop-nonce': error.nonce!, 'access-control-expose-headers': 'DPoP-Nonce',
      });
      return response(admission ? 503 : 401, { error: admission ? 'admin_command_failed' : 'unauthenticated' });
    } finally {
      clearTimeout(timer); request.signal.removeEventListener('abort', abort); running--;
    }
  };
}
