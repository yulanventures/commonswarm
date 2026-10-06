// Service-free CLI transport fixture. Uses the real MCP catalog and validator.
import { createHash } from 'node:crypto';
// @ts-expect-error TS5097: Deno source extension is required.
import { createMcpProtocolHandler } from '../../supabase/functions/mcp/protocol.ts';
// @ts-expect-error TS5097: Deno source extension is required.
import { HOSTED_TOOL_TABLE } from '../../supabase/functions/mcp/tools.ts';
// @ts-expect-error TS5097: Deno source extension is required.
import { HostedToolFailure } from '../../supabase/functions/mcp/tool-errors.ts';
import { HOUSEHOLD_TOOL_REGISTRY, householdToolInvocation } from '../../src/protocol/household-tool-registry.js';
import { decideTodo, emptyHouseholdTodoState, reduceTodoEvents } from '../../src/protocol/household-todos.js';

const issuer = 'https://mcp.commonswarm.com';
const workspace = '12345678-1234-4234-8234-123456789abc';
const scenario = (globalThis as any).__exerciseScenario;
const privateValue = 'PRIVATE_RESPONSE_CONTENT_TOKEN_abcdefgh';
const calls: { name: string; arguments: any }[] = [];
const seats = new Map<string, any>();
const signals: any[] = [];
let claims = 0;
const objects = new Map<string, any>();
let todoState = emptyHouseholdTodoState(workspace, 'synthetic-todo-stream');
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
    if (!seat) throw new HostedToolFailure('hosted_seat_forbidden');
    if (name === 'whoami') return { ...seat, [privateValue]: privateValue };
    if (name === 'members') return { members: [], agents: [...seats.values()] };
    if (name === 'check') return { batch_id: workspace, signals: signals.filter(s =>
      s.recipients.some((r: any) => r.id === seat.principal_id)), cursor: null, acknowledged_batch_id: null };
    if (name === 'object_create') {
      const revision = { workspace_id: workspace, object_id: args.object_id, token: 'r'.repeat(32) };
      objects.set(String(args.object_id), { revision: { revision, kind: 'doc', title: args.title }, content: args.content });
      return { status: 'committed', object_id: args.object_id, revision };
    }
    if (name === 'object_list') return { status: 'ok', objects: [...objects.keys()].map(object_id => ({ object_id })), next_offset: null };
    if (name === 'object_read') return { status: 'ok', kind: 'object_read', live: true, ...objects.get(String(args.object_id)) };
    if (name === 'object_update') {
      const row = objects.get(String(args.object_id));
      row.content = { kind: 'doc', markdown: (args.patch as { splices: { after: string }[] }).splices[0]!.after };
      row.revision = { ...row.revision, revision: { ...row.revision.revision, token: 'u'.repeat(32) } };
      return { status: 'committed', object_id: args.object_id, revision: row.revision.revision };
    }
    if (name === 'object_history') return { status: 'ok', revisions: [objects.get(String(args.object_id))], next_offset: null };
    if (HOUSEHOLD_TOOL_REGISTRY.some(tool => tool.name === name && tool.objectTypes.includes('todo'))) {
      const invocation = householdToolInvocation(name, args, { workspace_id: workspace });
      if ('query' in invocation) {
        const query = invocation.query;
        const todos = Object.values(todoState.todos), comments = Object.values(todoState.comments);
        if (query.kind === 'todo_list') return { status: 'ok', todos, next_offset: null };
        if (query.kind === 'todo_read') return { status: 'ok', todo: todoState.todos[query.todo_id],
          comments: comments.filter(c => c.target.kind === 'todo' && c.target.id === query.todo_id), next_comment_offset: null };
        if (query.kind === 'comment_list') return { status: 'ok', comments: comments.filter(c =>
          c.target.kind === query.target.kind && c.target.id === query.target.id), next_offset: null };
        if (query.kind === 'todo_queue') return { status: 'ok', queue: { working: [], up_next: todos.filter(t =>
          t.assignee?.id === seat.principal_id && t.state === 'open'), not_yet: [], requests: [],
          next_offset: { working: null, up_next: null, not_yet: null, requests: null } } };
        throw new Error('unexpected_fixture_query');
      }
      // Real decisions produce versions, IDs, comments and transitions. This
      // fixture replaces transport/persistence, not the acceptance policy.
      const context: Parameters<typeof decideTodo>[2] = {
        access: { workspace_id: workspace, archived_at: null, boundary: { kind: 'shared' },
          actor: { user_id: workspace, principal_id: seat.principal_id, run_id: null },
          member: { user_id: workspace, workspace_id: workspace, revoked_at: null, content_role: 'editor', content_consent_id: 'synthetic' },
          credential: { kind: 'agent', connection: { principal_id: seat.principal_id, owner_user_id: workspace,
            workspace_id: workspace, connection_id: 'synthetic', grant_id: 'synthetic', revoked_at: null,
            expires_at: null, operations: ['read', 'create', 'update'], purpose: 'shared' } } },
        now: Date.parse('2026-10-05T12:00:00Z'), seq: todoState.last_seq + 1, command_id: String(args.request_id),
        request_digest: createHash('sha256').update(JSON.stringify(invocation.command)).digest('hex'), event_ids: Array.from({ length: 16 }, () => crypto.randomUUID()),
        todo_id: crypto.randomUUID(), offer_id: crypto.randomUUID(), comment_id: crypto.randomUUID(),
        members: [{ user_id: workspace, workspace_id: workspace, revoked_at: null, role: 'owner' }],
        agents: [...seats.values()].map(s => ({ principal_id: s.principal_id, owner_user_id: workspace,
          workspace_id: workspace, revoked_at: null })), objects: [], identity_write_attempts: 0, workspace_write_attempts: 0,
      };
      const decision = decideTodo(todoState, invocation.command as Parameters<typeof decideTodo>[1], context);
      todoState = reduceTodoEvents(todoState, decision.events);
      if (scenario === 'comment_version_advanced' && invocation.command.kind === 'todo_comment') {
        const concurrent = decideTodo(todoState, { ...invocation.command, body: 'Another synthetic comment.' }, {
          ...context, seq: todoState.last_seq + 1, command_id: crypto.randomUUID(),
          request_digest: createHash('sha256').update('another-comment').digest('hex'),
          comment_id: crypto.randomUUID(), event_ids: Array.from({ length: 16 }, () => crypto.randomUUID()),
        });
        if (concurrent.outcome.status !== 'committed') throw new Error('concurrent_fixture_comment_failed');
        todoState = reduceTodoEvents(todoState, concurrent.events);
      }
      return { ...decision.outcome, notices: [], replayed: decision.replayed };
    }
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
      if (['unexpected_tool', 'missing_tool'].includes(scenario) && rpc.method === 'tools/list') {
        const tools = structuredClone(HOSTED_TOOL_TABLE) as any;
        if (scenario === 'unexpected_tool') tools.push({ ...tools[0], name: 'unexpected_tool' });
        else tools.pop();
        return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { tools } });
      }
      return await serve(new Request(String(url), options));
    }
    default: throw new Error('unexpected_stub_url');
  }
  return Response.json(body, { status });
};
