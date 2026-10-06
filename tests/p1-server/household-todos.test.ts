/** CI only. Real local PostgreSQL, real household access recheck, no HTTP or Storage.
 * Pure tests own transitions; this boundary owns ACLs, transactions and paging.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import postgres from 'postgres';
import * as todos from '../../src/protocol/household-todos.js';
import * as todoPolicy from '../../src/protocol/household-todo-policy.js';
import * as objectPolicy from '../../src/protocol/household-object-policy.js';
import * as objects from '../../src/protocol/household-objects.js';
import * as transfers from '../../supabase/functions/command/household-transfers.js';
import { createHouseholdObjectStore, type HouseholdIdentity } from '../../supabase/functions/command/household-objects.js';
import { createHouseholdTodoStore, type HouseholdTodoNoticePort } from '../../supabase/functions/command/household-todos.js';
import { runSql, repoSql, dbAssert, refuses, emptyApplicationSchema, localClusterAdminUrl } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const proofRoot = 'deploy/release-proofs/household-todo/20261006000001';
const rollback = () => repoSql(`${proofRoot}-rollback.sql`);
const migration = () => repoSql('supabase/migrations/20261006000001_household_todos.sql');
const core = { ...todos, ...todoPolicy, ...objectPolicy };
class RollbackProof extends Error {}
function fixture() {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), foreign = randomUUID(), consent = randomUUID();
  const grant = randomUUID(), principal = randomUUID(), sibling = randomUUID(), connection = randomUUID();
  const setup = `
    INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','${owner}@example.test'),('${other}','authenticated','authenticated','${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','To-do owner'),('${other}','To-do reader');
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic to-dos','${owner}'),('${foreign}','Synthetic foreign','${other}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'),('${workspace}','${other}','member'),('${foreign}','${other}','owner');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared'),('${foreign}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at) VALUES ('${workspace}','${owner}','editor','${consent}',clock_timestamp()),('${workspace}','${other}','reader','${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only) VALUES ('${principal}','${workspace}','${owner}','Synthetic first','hosted_mcp',true),('${sibling}','${workspace}','${owner}','Synthetic second','hosted_mcp',true);
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at) VALUES ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at) VALUES ('${connection}','${grant}','${workspace}','${owner}','${principal}','Synthetic first',clock_timestamp());
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES ('${connection}','${grant}','${workspace}','${principal}','${owner}','shared',ARRAY['read','create','update'],'${consent}',NULL,'${grant}');`;
  const human: HouseholdIdentity = { user_id: owner, principal_id: null, run_id: null, connection: null };
  const agent: HouseholdIdentity = { user_id: owner, principal_id: principal, run_id: null, connection: { connection_id: connection, grant_id: grant } };
  return { owner, other, workspace, foreign, principal, sibling, grant, connection, setup, human, agent };
}
const f = fixture();
function proof(suffix: 'catalog' | 'rollback-catalog', expect = true) {
  const alias = suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok';
  return repoSql(`${proofRoot}-${suffix}.sql`) + `\nSELECT :'${alias}'::boolean=${expect} AS proof_pass
\\gset\n\\if :proof_pass\n\\else\nDO $$ BEGIN RAISE EXCEPTION 'to-do proof failed'; END $$;\n\\endif\n`;
}

test('migration has exact private ACLs/RLS, envelope/offer checks, append-only history, and a lossless sibling rollback', () => {
  const todo = randomUUID(), event = randomUUID(), comment = randomUUID();
  const insertEvent = (seq: number, overrides = '') => `INSERT INTO swarm.household_todo_events(workspace_id,seq,event_id,occurred_at,event) VALUES ('${f.workspace}',${seq},'${seq ? randomUUID() : event}',clock_timestamp(),jsonb_build_object('workspace_id','${f.workspace}','seq',${seq},'event_id','${event}')${overrides})`;
  runSql(`${rollback()} ${migration()} ${f.setup}
    ${proof('catalog')}
    GRANT SELECT ON swarm.household_todos TO authenticated;
    ${proof('catalog', false)}
    REVOKE SELECT ON swarm.household_todos FROM authenticated;
    ${proof('catalog')}
    GRANT swarm_command TO authenticated;
    ${proof('catalog', false)}
    REVOKE swarm_command FROM authenticated;
    ${proof('catalog')}
    SET LOCAL ROLE swarm_command;
    INSERT INTO swarm.household_todo_streams VALUES ('${f.workspace}','${randomUUID()}',-1);
    ${insertEvent(0)};
    ${refuses(insertEvent(1), '23514')}
    INSERT INTO swarm.household_todos(workspace_id,todo_id,version,title,state,created_by_user,created_at,state_by_user,state_at,last_seq) VALUES ('${f.workspace}','${todo}',1,'Valid title','open','${f.owner}',clock_timestamp(),'${f.owner}',clock_timestamp(),0);
    ${refuses(`UPDATE swarm.household_todos SET offer_id='${randomUUID()}',offer_decider='${f.owner}',offer_user='${f.owner}',offer_principal='${f.principal}' WHERE todo_id='${todo}'`, '23514')}
    ${refuses(`UPDATE swarm.household_todos SET offer_id='${randomUUID()}',offer_decider='${f.owner}' WHERE todo_id='${todo}'`, '23514')}
    UPDATE swarm.household_todos SET offer_id='${randomUUID()}',offer_decider='${f.owner}',offer_user='${f.owner}' WHERE todo_id='${todo}';
    ${refuses(`UPDATE swarm.household_todos SET notes=chr(1) WHERE todo_id='${todo}'`, '23514')}
    UPDATE swarm.household_todos SET notes=E'Allowed\\n\\ttext' WHERE todo_id='${todo}';
    INSERT INTO swarm.household_comments(workspace_id,comment_id,target_kind,target_id,author_user,body,mentions,seq,created_at) VALUES ('${f.workspace}','${comment}','todo','${todo}','${f.owner}',E'Allowed\\n\\ttext','[]',0,clock_timestamp());
    ${refuses(`INSERT INTO swarm.household_comments(workspace_id,comment_id,target_kind,target_id,author_user,body,mentions,seq,created_at) VALUES ('${f.workspace}','${randomUUID()}','todo','${todo}','${f.owner}',chr(1),'[]',1,clock_timestamp())`, '23514')}
    INSERT INTO swarm.household_todo_receipts VALUES ('${f.workspace}','${f.owner}','synthetic',repeat('a',64),'{}',clock_timestamp());
    ${refuses(`DELETE FROM swarm.household_todos WHERE todo_id='${todo}'`, '42501')}
    RESET ROLE;
    ${['household_todo_events','household_comments','household_todo_receipts'].map(table => refuses(`UPDATE swarm.${table} SET workspace_id=workspace_id WHERE workspace_id='${f.workspace}'`, '55000') + refuses(`DELETE FROM swarm.${table} WHERE workspace_id='${f.workspace}'`, '55000')).join('\n')}
    SET LOCAL ROLE authenticated;
    SELECT set_config('request.jwt.claims','{"role":"authenticated","sub":"${f.owner}"}',true);
    ${refuses('SELECT * FROM swarm.household_todos', '42501')}
    RESET ROLE;
    INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,occurred_at,command_kind,request_digest,outcome)
      VALUES ('${randomUUID()}','${f.workspace}','sibling-control','${f.owner}',clock_timestamp(),'synthetic',repeat('b',64),'committed');
    CREATE TEMP TABLE todo_before_audit AS SELECT to_jsonb(a) AS row FROM swarm.household_object_audit a;
    CREATE TEMP TABLE todo_before_catalog AS SELECT c.relname,c.relowner,c.relacl,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='swarm' AND c.relname LIKE 'household_object_%';
    ${rollback()} ${proof('rollback-catalog')}
    REVOKE UPDATE ON swarm.household_object_streams FROM swarm_command;
    ${proof('rollback-catalog', false)}
    GRANT UPDATE ON swarm.household_object_streams TO swarm_command;
    ${proof('rollback-catalog')}
    ${dbAssert('SELECT NOT EXISTS ((SELECT row FROM todo_before_audit EXCEPT SELECT to_jsonb(a) FROM swarm.household_object_audit a) UNION ALL (SELECT to_jsonb(a) FROM swarm.household_object_audit a EXCEPT SELECT row FROM todo_before_audit))', 'rollback preserves audit bytes')}
    ${dbAssert("SELECT NOT EXISTS ((SELECT * FROM todo_before_catalog EXCEPT SELECT c.relname,c.relowner,c.relacl,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='swarm' AND c.relname LIKE 'household_object_%') UNION ALL (SELECT c.relname,c.relowner,c.relacl,c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='swarm' AND c.relname LIKE 'household_object_%' EXCEPT SELECT * FROM todo_before_catalog))", 'rollback preserves sibling catalog')}
  `);
});

function database() {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { DB_URL: string };
  return postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 3 });
}
const noStorage = { putImmutable: async () => { throw new Error('Unexpected Storage I/O'); }, read: async () => { throw new Error('Unexpected Storage I/O'); } };
function store(post: HouseholdTodoNoticePort) {
  const access = createHouseholdObjectStore({ core: { ...objects, ...objectPolicy }, transfers, storage: noStorage, fileContentAllowed: () => false,
    recheckCredential: async () => true }).access;
  return createHouseholdTodoStore({ core, access, notice: post });
}
const postNotice: HouseholdTodoNoticePort = async (tx, workspace, identity, intent) => {
  const signal = randomUUID(), first = intent.to[0]!;
  await tx`INSERT INTO swarm.signals(id,workspace_id,from_principal,from_kind,to_user_id,to_agent_principal_id,about,kind,body,until)
    VALUES (${signal}::uuid,${workspace}::uuid,${identity.principal_id ?? identity.user_id}::uuid,${identity.principal_id ? 'agent' : 'user'},
      ${first.kind === 'user' ? first.id : null}::uuid,${first.kind === 'agent' ? first.id : null}::uuid,${intent.about},${intent.kind},${intent.body},statement_timestamp()+interval '1 day')`;
  for (const [position, to] of intent.to.entries()) await tx`INSERT INTO swarm.signal_recipients(signal_id,workspace_id,recipient_user_id,recipient_agent_principal_id,position)
    VALUES (${signal}::uuid,${workspace}::uuid,${to.kind === 'user' ? to.id : null}::uuid,${to.kind === 'agent' ? to.id : null}::uuid,${position})`;
  return { to: intent.to, status: 'sent', signal_id: signal };
};
function committed(result: { outcome: todos.TodoOutcome }): todos.Todo {
  assert.equal(result.outcome.status, 'committed');
  if (result.outcome.status !== 'committed' || !('todo_id' in result.outcome.value)) throw new Error('Expected a to-do');
  return result.outcome.value;
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(JSON.stringify(value)));

test('store rechecks access, commits multiple events once, persists notice receipts and applies human-only front placement', async t => {
  const db = database(), adapter = store(postNotice), g = fixture();
  try {
    await assert.rejects(db.begin(async tx => {
      await tx.unsafe(emptyApplicationSchema()); await tx.unsafe(rollback()); await tx.unsafe(migration()); await tx.unsafe(g.setup);
      const write = async (command: todos.TodoCommand, identity = g.human, request = randomUUID(), workspace = g.workspace) => {
        await tx`SET LOCAL ROLE swarm_command`;
        const result = await adapter.write(tx, workspace, identity, request, command);
        await tx`RESET ROLE`; return result;
      };
      const counts = async () => (await tx`SELECT (SELECT count(*)::int FROM swarm.household_todo_events WHERE workspace_id=${g.workspace}::uuid) AS events,
        (SELECT count(*)::int FROM swarm.signals WHERE workspace_id=${g.workspace}::uuid) AS notices`)[0]!;
      const request = randomUUID(), command: todos.TodoCommand = { kind: 'todo_create', title: 'Start this', assign: { to: { kind: 'agent', id: g.principal }, start: 'now' } };
      const first = await write(command, g.human, request), todo = committed(first);
      assert.deepEqual(first.events.map(e => e.type), ['TodoCreated','TodoAssigned','TodoQueueOrdered','TodoStartAsked']);
      assert.deepEqual(await counts(), { events: 4, notices: 1 });
      const retry = await write(command, g.human, request);
      assert.equal(retry.replayed, true); assert.deepEqual(retry.outcome, first.outcome); assert.deepEqual(retry.notices, first.notices); assert.equal(retry.events.length, 0);
      assert.deepEqual(await counts(), { events: 4, notices: 1 });
      assert.deepEqual((await write({ ...command, title: 'Changed' }, g.human, request)).outcome, { status: 'refused', reason: 'request_id_reused' });
      assert.deepEqual(await counts(), { events: 4, notices: 1 });
      const [delivery] = await tx`SELECT count(*)::int AS count FROM swarm.signal_deliveries WHERE workspace_id=${g.workspace}::uuid AND recipient_agent_principal_id=${g.principal}::uuid`;
      assert.equal(delivery!.count, 1);
      const offer = committed(await write({ kind: 'todo_create', title: 'Agent asks now', assign: { to: { kind: 'agent', id: g.sibling }, start: 'now' } }, g.agent));
      assert.equal(offer.assignee, null); assert.equal(offer.offer?.decider_user_id, g.owner); assert.equal(offer.queue_rank, null);
      const accepted = committed(await write({ kind: 'todo_create', title: 'Human asks now', assign: { to: { kind: 'agent', id: g.sibling }, start: 'now' } }));
      assert.equal(accepted.assignee?.id, g.sibling); assert.equal(accepted.offer, null); assert.equal(accepted.queue_rank, 1);
      await t.test('foreign workspace, reader, revoked principal and absent approval refuse beside successful controls', async () => {
        const control: todos.TodoCommand = { kind: 'todo_create', title: 'Access control' };
        committed(await write(control));
        assert.deepEqual((await write(control, g.human, randomUUID(), g.foreign)).outcome, { status: 'refused', reason: 'workspace_access_refused' });
        assert.deepEqual((await write(control, { ...g.human, user_id: g.other })).outcome, { status: 'refused', reason: 'content_read_only' });
        await tx`UPDATE swarm.agent_principals SET revoked_at=clock_timestamp() WHERE principal_id=${g.principal}::uuid`;
        assert.deepEqual((await write(control, g.agent)).outcome, { status: 'refused', reason: 'workspace_access_refused' });
        await tx`UPDATE swarm.agent_principals SET revoked_at=NULL WHERE principal_id=${g.principal}::uuid`;
        committed(await write(control, g.agent));
        await tx`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE connection_id=${g.connection}::uuid`;
        assert.deepEqual((await write(control, g.agent)).outcome, { status: 'refused', reason: 'connection_access_refused' });
        await tx`UPDATE swarm.household_content_connections SET revoked_at=NULL WHERE connection_id=${g.connection}::uuid`;
        committed(await write(control, g.agent));
      });
      await t.test('human reads need content consent; missing queue principal has a dedicated refusal', async () => {
        const read = async (identity: HouseholdIdentity, query: Parameters<typeof adapter.read>[3]) => {
          await tx`SET LOCAL ROLE swarm_command`;
          const result = await adapter.read(tx, g.workspace, identity, query);
          await tx`RESET ROLE`; return result;
        };
        const reader = { ...g.human, user_id: g.other };
        const query = { kind: 'todo_read' as const, todo_id: todo.todo_id };
        assert.equal((await read(reader, query) as { todo: { title: string } }).todo.title, 'Start this');
        await tx`DELETE FROM swarm.household_member_content_roles WHERE workspace_id=${g.workspace}::uuid AND user_id=${g.other}::uuid`;
        assert.deepEqual(await read(reader, query), { status: 'refused', reason: 'content_consent_required' });
        await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
          VALUES (${g.workspace}::uuid,${g.other}::uuid,'reader',${randomUUID()}::uuid,clock_timestamp())`;
        assert.equal((await read(reader, query) as { todo: { title: string } }).todo.title, 'Start this');
        assert.deepEqual(await read(g.human, { kind: 'todo_queue' }), { status: 'refused', reason: 'principal_required' });
        assert.equal((await read(g.human, { kind: 'todo_queue', principal_id: g.principal }) as { principal_id: string }).principal_id, g.principal);
      });
      await t.test('Doing titles belong to the viewer; each dead hosted connection reports connection_off', async () => {
        const doing = committed(await write({ kind: 'todo_start', todo_id: todo.todo_id }, g.agent));
        assert.equal(doing.state, 'doing');
        const read = async () => {
          await tx`SET LOCAL ROLE swarm_command`;
          const queue = await adapter.read(tx, g.workspace, g.human, { kind: 'todo_queue', principal_id: g.principal }) as {
            status: { work: string; facts: { connection: string; doing: { title: string } } }; content_access: string;
          };
          await tx`RESET ROLE`; return queue;
        };
        const check = async (connection: string, contentAccess: string) => {
          const queue = await read();
          assert.equal(queue.status.facts.connection, connection);
          assert.equal(queue.status.facts.doing.title, 'Start this');
          assert.equal(queue.content_access, contentAccess);
          if (connection === 'connection_off') assert.equal(queue.status.work, 'disconnected');
        };
        await check('live', 'read_write');
        await tx`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp() WHERE connection_id=${g.connection}::uuid`;
        await check('live', 'none');
        await tx`UPDATE swarm.household_content_connections SET revoked_at=NULL WHERE connection_id=${g.connection}::uuid`;
        await check('live', 'read_write');
        for (const table of ['hosted_mcp_seats', 'hosted_mcp_grant_workspaces', 'hosted_mcp_grants'] as const) {
          const revoke = table === 'hosted_mcp_grants' ? "state='revoked',revoked_at=clock_timestamp()" : 'revoked_at=clock_timestamp()';
          const restore = table === 'hosted_mcp_grants' ? "state='active',revoked_at=NULL" : 'revoked_at=NULL';
          await tx.unsafe(`UPDATE swarm.${table} SET ${revoke} WHERE grant_id=$1::uuid`, [g.grant]);
          await check('connection_off', 'none');
          await tx.unsafe(`UPDATE swarm.${table} SET ${restore} WHERE grant_id=$1::uuid`, [g.grant]);
          await check('live', 'read_write');
        }
        await tx`UPDATE swarm.hosted_mcp_grants SET state='pending',activated_at=NULL WHERE grant_id=${g.grant}::uuid`;
        await check('connection_off', 'none');
        await tx`UPDATE swarm.hosted_mcp_grants SET state='active',activated_at=clock_timestamp() WHERE grant_id=${g.grant}::uuid`;
        await check('live', 'read_write');
      });
      await t.test('rate-limited notice commits the to-do and is never retried', async () => {
        let calls = 0;
        const limited = store(async (_tx, _workspace, _identity, intent) => { calls++; return { to: intent.to, status: 'not_sent', reason: 'signal_rate_limited' }; });
        const id = randomUUID();
        await tx`SET LOCAL ROLE swarm_command`;
        const result = await limited.write(tx, g.workspace, g.human, id, command); committed(result);
        const replay = await limited.write(tx, g.workspace, g.human, id, command);
        await tx`RESET ROLE`;
        assert.equal(calls, 1); assert.equal(result.notices[0]?.status, 'not_sent'); assert.deepEqual(replay.notices, result.notices);
      });
      await t.test('a failed notice rolls events, projection, receipt and audit back', async () => {
        const failed = store(async () => { throw new RollbackProof(); });
        const before = await counts(), id = randomUUID();
        const snapshot = async () => (await tx`SELECT
          (SELECT jsonb_agg(to_jsonb(t) ORDER BY todo_id) FROM swarm.household_todos t WHERE workspace_id=${g.workspace}::uuid) AS todos,
          (SELECT jsonb_agg(to_jsonb(a) ORDER BY audit_id) FROM swarm.household_object_audit a WHERE workspace_id=${g.workspace}::uuid) AS audit,
          (SELECT last_seq FROM swarm.household_todo_streams WHERE workspace_id=${g.workspace}::uuid) AS last_seq`)[0]!;
        const prior = await snapshot();
        await assert.rejects(tx.savepoint(async sql => { await sql`SET LOCAL ROLE swarm_command`; await failed.write(sql, g.workspace, g.human, id, command); }), RollbackProof);
        await tx`RESET ROLE`;
        assert.deepEqual(await counts(), before);
        assert.deepEqual(await snapshot(), prior);
        const [receipt] = await tx`SELECT count(*)::int AS count FROM swarm.household_todo_receipts WHERE command_id=${id}`;
        assert.equal(receipt!.count, 0);
      });
      assert.ok(todo.todo_id);
      throw new RollbackProof();
    }), RollbackProof);
  } finally { await db.end(); }
});

test('read pages fit the double-serialized 28 KiB transport budget and keep section order and pagination progress', async t => {
  const db = database(), adapter = store(postNotice), g = fixture();
  try {
    await assert.rejects(db.begin(async tx => {
      await tx.unsafe(emptyApplicationSchema()); await tx.unsafe(rollback()); await tx.unsafe(migration()); await tx.unsafe(g.setup);
      await tx`INSERT INTO swarm.household_todo_streams(workspace_id,stream_id) VALUES (${g.workspace}::uuid,${randomUUID()}::uuid)`;
      const ids = Array.from({ length: 200 }, () => randomUUID());
      for (const [i, id] of ids.entries()) await tx`INSERT INTO swarm.household_todos(workspace_id,todo_id,version,title,notes,state,created_by_user,created_at,assignee_principal,queue_rank,gate_kind,gate_note,offer_id,offer_principal,offer_decider,offer_start,offer_gate,offer_by_user,offered_at,state_by_user,state_at,last_seq)
        VALUES (${g.workspace}::uuid,${id}::uuid,1,'Synthetic','Never in a summary',${i < 80 ? 'doing' : 'open'},${g.owner}::uuid,clock_timestamp(),
          ${i >= 190 ? null : g.principal}::uuid,${i >= 190 ? null : i + 1},${i >= 160 && i < 190 ? 'hold' : 'none'},${i >= 160 && i < 190 ? 'Private gate note' : null},
          ${i >= 190 ? randomUUID() : null}::uuid,${i >= 190 ? g.principal : null}::uuid,${i >= 190 ? g.owner : null}::uuid,${i >= 190 ? 'queue' : null},${i >= 190 ? tx.json({ kind: 'hold', note: 'Private offer gate note' }) : null},
          ${i >= 190 ? g.owner : null}::uuid,${i >= 190 ? new Date() : null},${g.owner}::uuid,clock_timestamp(),0)`;
      const read = async (query: Parameters<typeof adapter.read>[3]) => {
        await tx`SET LOCAL ROLE swarm_command`;
        const result = await adapter.read(tx, g.workspace, g.human, query);
        await tx`RESET ROLE`;
        assert.ok(bytes(result) <= 28 * 1024, `double-serialized bytes ${bytes(result)}`);
        return result;
      };
      for (const title of ['界'.repeat(200), '"'.repeat(200), '\\'.repeat(200)]) await t.test(`pages with ${title.codePointAt(0)} titles`, async () => {
        await tx`UPDATE swarm.household_todos SET title=${title} WHERE workspace_id=${g.workspace}::uuid`;
        const seen: string[] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page = await read({ kind: 'todo_list', scope: 'all', offset, limit: 50 }) as { todos: Array<{ todo_id: string; notes?: string }>; next_offset: number | null };
          assert.ok(page.todos.length > 0); assert.ok(page.todos.every(todo => !Object.hasOwn(todo, 'notes')));
          if (page.next_offset !== null) assert.ok(page.next_offset > offset);
          seen.push(...page.todos.map(todo => todo.todo_id)); offset = page.next_offset;
        }
        assert.deepEqual([...seen].sort(), [...ids].sort());
        const queue = await read({ kind: 'todo_queue', principal_id: g.principal }) as Record<string, unknown> & { next_offset: Record<string, number | null> };
        assert.ok(queue.next_offset.working !== null);
        assert.deepEqual(queue.next_offset, { working: (queue.working as unknown[]).length, up_next: 0, not_yet: 0, requests: 0 });
        for (const [section, count] of [['working',80],['up_next',80],['not_yet',30],['requests',10]] as const) {
          let cursor: number | null = 0, total = 0;
          while (cursor !== null) {
            const page = await read({ kind: 'todo_queue', principal_id: g.principal, section, offset: cursor, limit: 50 }) as Record<string, unknown> & { next_offset: Record<string, number | null> };
            const rows = page[section] as Array<Record<string, unknown>>;
            assert.ok(rows.length > 0); assert.ok(rows.every(row => !Object.hasOwn(row,'notes')));
            for (const row of rows) {
              assert.equal(Object.hasOwn(row, 'gate_note'), false);
              assert.equal(Object.hasOwn(row, 'gate_clear'), false);
              assert.equal(Object.hasOwn(row.gate as object, 'note'), false);
              if (row.offer) assert.equal(Object.hasOwn((row.offer as { gate: object }).gate, 'note'), false);
            }
            total += rows.length;
            const next = page.next_offset[section]!;
            if (next !== null) assert.ok(next > cursor);
            cursor = next;
          }
          assert.equal(total, count);
        }
      });
      const heldDetail = await read({ kind: 'todo_read', todo_id: ids[160]! }) as { todo: { gate: { kind: string; note: string } } };
      assert.deepEqual(heldDetail.todo.gate, { kind: 'hold', note: 'Private gate note' });
      const offeredDetail = await read({ kind: 'todo_read', todo_id: ids[190]! }) as { todo: { offer: { gate: { kind: string; note: string } } } };
      assert.deepEqual(offeredDetail.todo.offer.gate, { kind: 'hold', note: 'Private offer gate note' });
      for (let i=0;i<20;i++) await tx`INSERT INTO swarm.household_comments(workspace_id,comment_id,target_kind,target_id,author_user,body,mentions,seq,created_at)
        VALUES (${g.workspace}::uuid,${randomUUID()}::uuid,'todo',${ids[0]!},${g.owner}::uuid,${'"'.repeat(4000)},'[]',${i},clock_timestamp())`;
      const first = await read({ kind: 'comment_list', target: { kind: 'todo', id: ids[0]! }, limit: 20 }) as { comments: unknown[]; next_offset: number | null };
      assert.ok(first.comments.length >= 1 && first.comments.length < 20); assert.equal(first.next_offset, first.comments.length);
      let offset: number | null = 0, count = 0;
      while (offset !== null) {
        const page = await read({ kind: 'comment_list', target: { kind: 'todo', id: ids[0]! }, offset, limit: 20 }) as typeof first;
        assert.ok(page.comments.length >= 1); count += page.comments.length; offset = page.next_offset;
      }
      assert.equal(count, 20);
      for (const notes of ['"'.repeat(4000), '\\'.repeat(4000), '\n'.repeat(4000), '😀'.repeat(4000)]) {
        await tx`UPDATE swarm.household_todos SET notes=${notes} WHERE todo_id=${ids[0]!}::uuid`;
        const detail = await read({ kind: 'todo_read', todo_id: ids[0]! }) as { todo: { notes: string }; comments: unknown[]; next_comment_offset: number | null };
        assert.equal(detail.todo.notes, notes); assert.equal(detail.next_comment_offset, detail.comments.length);
      }
      await tx`SET LOCAL ROLE swarm_command`;
      assert.deepEqual((await adapter.write(tx,g.workspace,g.human,randomUUID(),{ kind:'todo_create', title:'Bad notes', notes:'\u0001' })).outcome, { status:'refused',reason:'notes_invalid' });
      committed(await adapter.write(tx,g.workspace,g.human,randomUUID(),{kind:'todo_create',title:'Good notes',notes:'\n\t'}));
      assert.deepEqual((await adapter.write(tx,g.workspace,g.human,randomUUID(),{ kind:'todo_comment',target:{kind:'todo',id:ids[0]!},body:'\u0001' })).outcome, {status:'refused',reason:'comment_invalid'});
      assert.equal((await adapter.write(tx,g.workspace,g.human,randomUUID(),{ kind:'todo_comment',target:{kind:'todo',id:ids[0]!},body:'Allowed\n\t' })).outcome.status,'committed');
      await tx`RESET ROLE`;
      const [catalog] = await tx.unsafe(releaseCatalogQuery(repoSql(`${proofRoot}-catalog.sql`),'catalog_ok'));
      assert.equal(catalog!.catalog_ok, true);
      throw new RollbackProof();
    }), RollbackProof);
  } finally { await db.end(); }
});

test('concurrent queue moves serialize through the workspace lock without losing either order event', async () => {
  // This one uses the CI migration-applied schema, because two transactions
  // cannot see each other's uncommitted schema copy. Synthetic append-only
  // history remains in the disposable CI database, like the storage suite.
  const db = database(), adapter = store(postNotice), g = fixture();
  try {
    await db.begin(async tx => { await tx.unsafe(g.setup); });
    const write = (command: todos.TodoCommand) => db.begin(async tx => {
      await tx`SET LOCAL ROLE swarm_command`;
      return adapter.write(tx,g.workspace,g.human,randomUUID(),command);
    });
    const created = [];
    for (let i=0;i<3;i++) created.push(committed(await write({kind:'todo_create',title:`Move ${i}`,assign:{to:{kind:'agent',id:g.principal}}})));
    const moves = await Promise.all(created.slice(1).map(todo => write({kind:'household_todo_steer',todo_id:todo.todo_id,base_version:todo.version,action:{kind:'move',after_todo_id:null}})));
    assert.deepEqual(moves.map(r => r.outcome.status), ['committed','committed']);
    assert.ok(moves.every(r => r.events.length === 1 && r.events[0]!.type === 'TodoQueueOrdered'));
    const rows = await db`SELECT todo_id,queue_rank FROM swarm.household_todos WHERE workspace_id=${g.workspace}::uuid ORDER BY queue_rank`;
    assert.deepEqual(rows.map(r => Number(r.queue_rank)), [1,2,3]);
    const later = moves.reduce((a,b) => a.events[0]!.seq > b.events[0]!.seq ? a : b);
    const order = later.events[0]!;
    assert.equal(order.type, 'TodoQueueOrdered');
    if (order.type !== 'TodoQueueOrdered') throw new Error('Expected queue order');
    assert.deepEqual(rows.map(r => String(r.todo_id)), order.payload.todo_ids);
    const events = await db`SELECT seq FROM swarm.household_todo_events WHERE workspace_id=${g.workspace}::uuid ORDER BY seq`;
    assert.deepEqual(events.map(r => Number(r.seq)), Array.from({length:events.length},(_,i)=>i));
  } finally { await db.end(); }
});
