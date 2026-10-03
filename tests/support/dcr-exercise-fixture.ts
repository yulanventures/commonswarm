// Service-free CLI transport fixture. Uses the real MCP catalog and validator.
// @ts-expect-error TS5097: Deno source extension is required.
import { createMcpProtocolHandler } from '../../supabase/functions/mcp/protocol.ts';
// @ts-expect-error TS5097: Deno source extension is required.
import { HOSTED_TOOL_TABLE } from '../../supabase/functions/mcp/tools.ts';

const issuer = 'https://mcp.commonswarm.com';
const workspace = '12345678-1234-4234-8234-123456789abc';
const scenario = (globalThis as any).__exerciseScenario;
const privateValue = 'PRIVATE_RESPONSE_CONTENT_TOKEN_abcdefgh';
const calls: { name: string; arguments: any }[] = [];
const seats = new Map<string, any>();
const signals: any[] = [];
let claims = 0;
const serve = createMcpProtocolHandler({
  issuer, resource: issuer + '/mcp', publicEnabled: true, allowedOrigins: new Set(),
  limits: { maxBodyBytes: 128 * 1024, maxResponseBytes: 64 * 1024, requestTimeoutMs: 2000, maxConcurrentRequests: 2 },
  verifyToken: async () => ({ providerGrantId: 'synthetic-grant', subject: workspace, expiresAt: 1900000000 }),
  executeTool: async ({ name, arguments: args }) => {
    if (name === 'claim_seat') {
      claims++;
      const handle = `seat_${String(claims).padStart(32, 'a')}`;
      const seat = { handle, workspace_id: scenario === 'wrong_workspace' ? '87654321-1234-4234-8234-123456789abc' : workspace,
        principal_id: `00000000-0000-4000-8000-${String(claims).padStart(12, '0')}`, name: args.name };
      seats.set(handle, seat);
      return seat;
    }
    const seat = seats.get(String(args.seat));
    if (!seat) throw new Error('hosted_seat_forbidden');
    if (name === 'whoami') return { ...seat, [privateValue]: privateValue };
    if (name === 'members') return { members: [], agents: [...seats.values()] };
    if (name === 'check') return { batch_id: workspace, signals: signals.filter(s =>
      s.recipients.some((r: any) => r.id === seat.principal_id)), cursor: null, acknowledged_batch_id: null };
    const parent = signals.find(s => s.id === args.signal_id);
    const signal = { id: `00000000-0000-4000-8000-${String(signals.length + 10).padStart(12, '0')}`,
      body: args.body, from: seat.principal_id, kind: name,
      recipients: name === 'reply' ? [{ kind: 'agent', id: parent.from }] : args.recipients ?? [],
      in_reply_to: args.signal_id ?? null };
    signals.push(signal);
    return { signal_id: signal.id, kind: name, created_at: privateValue, in_reply_to: signal.in_reply_to,
      [privateValue]: privateValue };
  },
});

process.on('beforeExit', () => process.send?.({ calls }));
globalThis.fetch = async (url: any, options: any) => {
  let body: any, status = 200;
  switch (String(url)) {
    case issuer + '/.well-known/oauth-authorization-server':
      body = { issuer, registration_endpoint: issuer + '/register', authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token', code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp'] }; break;
    case issuer + '/.well-known/oauth-protected-resource/mcp':
      body = { resource: issuer + '/mcp', authorization_servers: [issuer], scopes_supported: ['mcp'] }; break;
    case issuer + '/register':
      status = 201;
      body = { client_id: 'synthetic-client-1234567890123456', token_endpoint_auth_method: 'none',
        redirect_uris: ['https://dcr-release-probe.invalid/callback'] }; break;
    case issuer + '/token':
      body = { access_token: privateValue, token_type: 'Bearer', expires_in: 300, scope: 'mcp' }; break;
    case issuer + '/mcp': {
      const rpc = JSON.parse(options.body);
      if (rpc.method === 'tools/call') {
        calls.push(rpc.params);
        if (scenario === 'transport_failure' && rpc.params.name === 'note') throw new Error(privateValue);
        if (scenario === 'negative_succeeds' && rpc.params.name === 'directory_review_unknown_tool') {
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { content: [{ type: 'text', text: '{}' }] } });
        }
      }
      if (scenario === 'schema_changed' && rpc.method === 'tools/list') {
        const tools = structuredClone(HOSTED_TOOL_TABLE) as any;
        tools.find((t: any) => t.name === 'claim_seat').inputSchema.properties.request_id.pattern = '^impossible$';
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools } });
      }
      return await serve(new Request(String(url), options));
    }
    default: throw new Error('unexpected_stub_url');
  }
  return Response.json(body, { status });
};
