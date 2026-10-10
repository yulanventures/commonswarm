/** CI only. A hosted household read enters the same command transaction as an
 * object read. The fixture rolls back. No Storage call and no network. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { emptyApplicationSchema, localClusterAdminUrl, repoSql } from '../support/admin-schema-db.js';

function fixture(seedContexts = true) {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), foreign = randomUUID(), consent = randomUUID();
  const principal = randomUUID(), grant = randomUUID(), connection = randomUUID();
  const foreignPrincipal = randomUUID(), foreignGrant = randomUUID(), foreignConnection = randomUUID(), foreignReceipt = randomUUID();
  const handle = `seat_${'L'.repeat(22)}`, foreignHandle = `seat_${'M'.repeat(22)}`;
  const setup = `
    INSERT INTO auth.users(id,aud,role,email) VALUES
      ('${owner}','authenticated','authenticated','${owner}@example.test'),
      ('${other}','authenticated','authenticated','${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic other');
    INSERT INTO swarm.config(key,value) VALUES ('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES
      ('${workspace}','Synthetic household','${owner}'),('${foreign}','Synthetic foreign','${other}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES
      ('${workspace}','${owner}','owner'),('${foreign}','${other}','owner');
    INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES
      ('${randomUUID()}','${workspace}','workspace'),('${randomUUID()}','${foreign}','workspace');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared'),('${foreign}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${owner}','editor','${consent}',clock_timestamp());
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES
      ('${principal}','${workspace}','${owner}','Synthetic hosted to-do agent','hosted_mcp',true),
      ('${foreignPrincipal}','${foreign}','${other}','Synthetic foreign agent','hosted_mcp',true);
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES
      ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp()),
      ('${foreignGrant}','synthetic-${foreignGrant}','${other}','${foreign}','synthetic-client-foreign','https://mcp.commonswarm.com/mcp',ARRAY['${foreign}']::uuid[],decode(repeat('b',64),'hex'),'synthetic-consent-foreign','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at) VALUES
      ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp()),
      ('${foreignGrant}','${foreign}','${other}',decode(repeat('b',64),'hex'),'${foreignReceipt}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at) VALUES
      ('${connection}','${grant}','${workspace}','${owner}','${principal}','Synthetic hosted to-do agent',clock_timestamp()),
      ('${foreignConnection}','${foreignGrant}','${foreign}','${other}','${foreignPrincipal}','Synthetic foreign agent',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at) VALUES
      ('${handle}','${connection}','${grant}','${workspace}','${principal}',clock_timestamp()),
      ('${foreignHandle}','${foreignConnection}','${foreignGrant}','${foreign}','${foreignPrincipal}',clock_timestamp());
    ${seedContexts ? `
    INSERT INTO swarm.hosted_agent_contexts(context_id,handle,seat_id,kind,created_at,last_business_at,idle_expires_at,absolute_expires_at,origin)
      SELECT gen_random_uuid(),h.handle,h.seat_id,'chat',h.created_at,h.created_at,NULL,NULL,'legacy'
      FROM swarm.hosted_mcp_seat_handles h;
    ` : ""}
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES ('${connection}','${grant}','${workspace}','${principal}','${owner}','shared',ARRAY['read','create','update'],'${consent}',NULL,'${grant}');
  `;
  return { owner, workspace, foreign, principal, grant, handle, foreignGrant, foreignHandle, setup };
}

const commandUrl = JSON.stringify(new URL('../../supabase/functions/command/index.ts', import.meta.url).href);
const readUrl = JSON.stringify(new URL('../../supabase/functions/read/index.ts', import.meta.url).href);
const authUrl = JSON.stringify(new URL('../../supabase/functions/_shared/hosted-seat-auth.ts', import.meta.url).href);

const harness = `
import assert from 'node:assert/strict';
import type postgres from 'postgres';
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const api = await import(${commandUrl});
const readApi = await import(${readUrl});
const auth = await import(${authUrl});
globalThis.fetch = async () => { throw new Error('Unexpected HTTP or Storage access'); };
class FixtureRollback extends Error {}
const originalBegin = api.db.begin.bind(api.db);
try {
  await assert.rejects(originalBegin(async (tx: postgres.TransactionSql<Record<string, unknown>>) => {
    const restore = async () => {
      await tx\`SELECT set_config('role', 'none', true), set_config('search_path', 'pg_catalog', true),
        set_config('lock_timeout', '0', true), set_config('statement_timeout', '0', true)\`;
    };
    await tx.unsafe(input.schema);
    await tx.unsafe(input.setup);
    if (input.lifecycle) await tx.unsafe(input.lifecycle);
    api.db.begin = (async (...args: unknown[]) => {
      await restore();
      const result = await (args.at(-1) as (sql: typeof tx) => Promise<unknown>)(tx);
      await restore();
      return result;
    }) as typeof api.db.begin;
    const f = input.f;
    const readNames = new Set(['object_list','object_read','object_history','file_read','todo_list','todo_read','todo_queue','comment_list']);
    const capability = async (tool: string, binding: { grantId: string; providerGrantId: string; handle: string }) => {
      const use = readNames.has(tool) ? 'read' as const : 'command' as const;
      await tx\`SELECT set_config('role', \${use === 'read' ? 'swarm_read' : 'swarm_command'}, true)\`;
      const cap = await auth.authenticateHostedSeatCapability(tx, {
        grantId: binding.grantId, providerGrantId: binding.providerGrantId, handle: binding.handle, tool,
        providerStatus: async () => ({ active: true }),
      }, use);
      await restore();
      assert.ok(cap, 'live hosted capability for ' + tool);
      return cap;
    };
    const home = { grantId: f.grant, providerGrantId: 'synthetic-' + f.grant, handle: f.handle };
    const away = { grantId: f.foreignGrant, providerGrantId: 'synthetic-' + f.foreignGrant, handle: f.foreignHandle };
    if (input.lifecycle) {
      const contexts = await tx\`SELECT h.handle, c.kind, c.origin, c.created_at=h.created_at AS original_created,
        c.last_business_at=h.created_at AS original_activity, c.idle_expires_at, c.absolute_expires_at,
        c.closed_at, c.close_reason, c.parent_context
        FROM swarm.hosted_mcp_seat_handles h LEFT JOIN swarm.hosted_agent_contexts c USING(handle,seat_id)\`;
      assert.equal(contexts.length, 2, 'migration maps both pre-phase-3 handles');
      for (const c of contexts) assert.deepEqual({ ...c, handle: undefined }, {
        handle: undefined, kind: 'chat', origin: 'legacy', original_created: true, original_activity: true,
        idle_expires_at: null, absolute_expires_at: null, closed_at: null, close_reason: null, parent_context: null,
      }, 'exact durable legacy backfill shape');
      const checkCap = await capability('check', home);
      const checked = await api.handleHostedCommand({ command_id: crypto.randomUUID(), client_version: '0.1.80',
        workspace_id: f.workspace, stream: { kind: 'workspace' },
        command: { kind: 'open_hosted_mcp_check_batch', seat: f.handle },
      }, checkCap);
      assert.equal(checked.status, 200, 'pre-phase-3 handle checks immediately after migration');
    }

    const read = async (tool: string, fields: Record<string, unknown>, binding = home, workspace: string = f.workspace) => readApi.handleHostedRead({
      resource: 'household', workspace_id: workspace, tool,
      arguments: { seat: binding.handle, ...fields },
    }, await capability(tool, binding));
    const write = async (tool: string, fields: Record<string, unknown>, id: string = crypto.randomUUID()) => api.handleHostedCommand({
      command_id: id, client_version: '0.1.80', workspace_id: f.workspace, stream: { kind: 'workspace' },
      command: { kind: 'household_tool', tool, arguments: { seat: f.handle, request_id: id, ...fields } },
    }, await capability(tool, home));
    const committed = (result: { status: number; body: { status?: unknown; value?: { todo_id: string; version: number } } }) => {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.status, 'committed', JSON.stringify(result.body));
      assert.ok(result.body.value);
      return result.body.value;
    };

    const listed = await read('object_list', { offset: 0, limit: 10 });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.status, 'ok', JSON.stringify(listed.body));
    assert.equal(listed.body.kind, 'object_list');
    assert.ok(Array.isArray(listed.body.objects));

    const createCap = await capability('todo_create', home);
    const writeOnReadEntry = await readApi.handleHostedRead({
      resource: 'household', workspace_id: f.workspace, tool: 'todo_create',
      arguments: { seat: f.handle, title: 'Read path control' },
    }, createCap);
    assert.equal(writeOnReadEntry.status, 403);
    assert.deepEqual(writeOnReadEntry.body, { error: 'forbidden' });

    const title = 'Read path control';
    const created = committed(await write('todo_create', { title }));
    const assigned = committed(await write('todo_assign', {
      todo_id: created.todo_id, base_version: created.version, to: { kind: 'agent', id: f.principal },
    }));
    assert.equal(assigned.todo_id, created.todo_id);

    const queue = await read('todo_queue', {});
    const queued = queue.body as { status?: unknown; queue?: { up_next?: { todo_id: string }[] } };
    assert.equal(queue.status, 200, JSON.stringify(queue.body));
    assert.equal(queued.status, 'ok', JSON.stringify(queue.body));
    assert.deepEqual((queued.queue?.up_next ?? []).map((item) => item.todo_id), [created.todo_id]);

    const seen = await read('todo_read', { todo_id: created.todo_id });
    const seenTodo = seen.body as { status?: unknown; todo?: { title?: string; todo_id?: string } };
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seenTodo.status, 'ok');
    assert.equal(seenTodo.todo?.title, title);
    assert.equal(seenTodo.todo?.todo_id, created.todo_id);

    const otherWorkspace = await read('todo_read', { todo_id: created.todo_id }, home, f.foreign);
    assert.equal(otherWorkspace.status, 403, JSON.stringify(otherWorkspace.body));
    assert.deepEqual(otherWorkspace.body, { error: 'forbidden' });
    const otherSeat = await read('todo_read', { todo_id: created.todo_id }, away, f.workspace);
    assert.equal(otherSeat.status, 403, JSON.stringify(otherSeat.body));
    assert.deepEqual(otherSeat.body, { error: 'forbidden' });

    const again = await read('todo_read', { todo_id: created.todo_id });
    const againTodo = again.body as { todo?: { title?: string } };
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(againTodo.todo?.title, title);
    throw new FixtureRollback();
  }), FixtureRollback);
  console.log('L4D_RESULT:ok');
} finally {
  api.db.begin = originalBegin;
  await api.db.end();
}
`;

// The migration case owns the upgrade regression: older coverage seeded a
// context after schema restore, so it could not detect a missing live backfill.
for (const upgrade of [false, true]) test(upgrade
  ? 'pre-phase-3 handles keep check and to-do access immediately after migration 0004'
  : 'hosted to-do reads use the household read path and refuse another workspace', { timeout: 120_000 }, () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  const f = fixture(!upgrade);
  // Reverse lifecycle while its triggers still exist, before rebuilding to-dos.
  // The normal fixture reinstalls lifecycle; the upgrade fixture seeds old handles first.
  const schema = emptyApplicationSchema() + repoSql('deploy/release-proofs/session-identity/20261006000004-rollback.sql')
    + repoSql('supabase/household-todo-reserve/20261006000001-rollback.sql')
    + repoSql('supabase/migrations/20261006000001_household_todos.sql')
    + (upgrade ? '' : repoSql('supabase/migrations/20261006000004_hosted_context_lifecycle.sql'));
  const lifecycle = upgrade ? repoSql('supabase/migrations/20261006000004_hosted_context_lifecycle.sql') : '';
  const result = spawnSync('deno', ['eval', '--no-lock', '--config', 'supabase/functions/command/deno.json', harness], {
    cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({ f, schema, setup: f.setup, lifecycle }),
    env: { PATH: process.env.PATH ?? '', ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: 'test', SWARM_DATABASE_URL: localClusterAdminUrl(local.DB_URL),
      SUPABASE_URL: 'https://storage.example.test', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage' },
    timeout: 110_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `hosted to-do read path failed: ${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /L4D_RESULT:ok/);
});
