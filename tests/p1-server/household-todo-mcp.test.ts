/** CI only. Real command handlers, hosted capability auth, private SQL store
 * and signal delivery triggers. All fixture work rolls back; no Storage I/O. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { emptyApplicationSchema, localClusterAdminUrl, repoSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

function fixture() {
  const owner = randomUUID(), other = randomUUID(), workspace = randomUUID(), foreign = randomUUID(), consent = randomUUID();
  const principal = randomUUID(), sibling = randomUUID(), grant = randomUUID(), connection = randomUUID();
  const local = randomUUID(), device = randomUUID(), run = randomUUID(), credential = randomUUID();
  const name = 'Synthetic hosted to-do agent', handle = `seat_${'L'.repeat(22)}`;
  const setup = `
    INSERT INTO auth.users(id,aud,role,email) VALUES ('${owner}','authenticated','authenticated','${owner}@example.test'),('${other}','authenticated','authenticated','${other}@example.test');
    INSERT INTO swarm.users(user_id,display_name) VALUES ('${owner}','Synthetic owner'),('${other}','Synthetic other');
    INSERT INTO swarm.config(key,value) VALUES ('min_client_version','"0.1.0"') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
    INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES ('${workspace}','Synthetic household','${owner}'),('${foreign}','Synthetic foreign','${other}');
    INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner'),('${foreign}','${other}','owner');
    INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES ('${randomUUID()}','${workspace}','workspace'),('${randomUUID()}','${foreign}','workspace');
    INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared'),('${foreign}','shared');
    INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES ('${workspace}','${owner}','editor','${consent}',clock_timestamp());
    INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES ('${principal}','${workspace}','${owner}','${name}','hosted_mcp',true),('${sibling}','${workspace}','${owner}','Synthetic sibling','hosted_mcp',true),
        ('${local}','${workspace}','${owner}','Synthetic local','local',false);
    INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at)
      VALUES ('${grant}','synthetic-${grant}','${owner}','${workspace}','synthetic-client','https://mcp.commonswarm.com/mcp',ARRAY['${workspace}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-consent','active',clock_timestamp(),clock_timestamp());
    INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at)
      VALUES ('${grant}','${workspace}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES ('${connection}','${grant}','${workspace}','${owner}','${principal}','${name}',clock_timestamp());
    INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
      VALUES ('${handle}','${connection}','${grant}','${workspace}','${principal}',clock_timestamp());
    INSERT INTO swarm.devices(device_id,user_id,label) VALUES ('${device}','${owner}','Synthetic device');
    INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES ('${run}','${local}','${device}');
    INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id)
      VALUES ('${credential}','${local}','${run}','[]',decode(repeat('b',64),'hex'),clock_timestamp()+interval '1 hour','${randomUUID()}');
    INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES ('${connection}','${grant}','${workspace}','${principal}','${owner}','shared',ARRAY['read','create','update'],'${consent}',NULL,'${grant}'),
        ('${credential}','${run}','${workspace}','${local}','${owner}','shared',ARRAY['read','create','update'],'${consent}',clock_timestamp()+interval '1 hour',NULL);
  `;
  return { owner, workspace, foreign, principal, sibling, grant, connection, local, run, credential, handle, setup };
}

const harness = `
import assert from 'node:assert/strict';
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const api = await import(${JSON.stringify(new URL('../../supabase/functions/command/index.ts', import.meta.url).href)});
const auth = await import(${JSON.stringify(new URL('../../supabase/functions/_shared/hosted-seat-auth.ts', import.meta.url).href)});
const surface = await import(${JSON.stringify(new URL('../../supabase/functions/command/household-integration.ts', import.meta.url).href)});
globalThis.fetch = async () => { throw new Error('Unexpected HTTP or Storage access'); };
class FixtureRollback extends Error {}
const originalBegin = api.db.begin.bind(api.db);
try {
  await assert.rejects(originalBegin(async tx => {
    await tx.unsafe(input.schema); await tx.unsafe(input.setup);
    // Keep each real handler on the fixture's top-level transaction. A
    // savepoint gives inserted rows a subtransaction xmin, which the normal
    // directed-signal recipient guard refuses. All fixture work rolls back;
    // no auth, decision, notice or receipt is mocked.
    api.db.begin = (async (...args: unknown[]) => {
      await tx\x60RESET ROLE\x60;
      const result=await (args.at(-1) as (sql: typeof tx) => Promise<unknown>)(tx);
      await tx\x60RESET ROLE\x60; return result;
    }) as typeof api.db.begin;
    const f = input.f;
    type Result = { status: number; body: Record<string, any> };
    const envelope = (command: Record<string, unknown>, id=crypto.randomUUID(), workspace=f.workspace) => ({ command_id:id, client_version:'0.1.80', workspace_id:workspace, stream:{kind:'workspace'}, command });
    const human = async (command: Parameters<typeof api.handleHostedManagementCommand>[0]): Promise<Result> => api.handleHostedManagementCommand(command, {
      userId:f.owner, email:null, displayName:'Synthetic owner', identityVerified:true, interactiveAuthAtSeconds:null });
    const capability = async (tool: string) => {
      const use = ['todo_list','todo_read','todo_queue','comment_list'].includes(tool) ? 'read' : 'command';
      const cap = await auth.authenticateHostedSeatCapability(tx, { grantId:f.grant, providerGrantId:'synthetic-'+f.grant,
        handle:f.handle, tool, providerStatus:async () => ({active:true}) }, use);
      assert.ok(cap, 'live, approved hosted capability'); return cap;
    };
    const call = async (tool: string, fields: Record<string, unknown>={}, id=crypto.randomUUID(), workspace=f.workspace): Promise<Result> => {
      const args={seat:f.handle, ...(['todo_list','todo_read','todo_queue','comment_list'].includes(tool)?{}:{request_id:id}), ...fields};
      return api.handleHostedCommand(envelope({kind:'household_tool',tool,arguments:args},id,workspace), await capability(tool));
    };
    const committed = (result: Result) => { assert.equal(result.status,200); assert.equal(result.body.status,'committed'); return result.body.value; };
    const created = committed(await call('todo_create',{title:'Hosted round trip'}));
    const noticeSpend=async()=>Number((await tx\x60SELECT coalesce(sum(count),0)::int AS n FROM swarm.rate_buckets WHERE bucket_key LIKE 'spend:signal_post:%'\x60)[0]!.n);
    const spendBefore=await noticeSpend();
    const request = crypto.randomUUID();
    const assign = {todo_id:created.todo_id, base_version:created.version, to:{kind:'agent',id:f.principal}};
    const assignedResult=await call('todo_assign',assign,request), assigned=committed(assignedResult);
    assert.deepEqual(assigned.assignee,{kind:'agent',id:f.principal});
    assert.equal(assignedResult.body.notices.length,1); assert.equal(assignedResult.body.notices[0].status,'sent');
    assert.equal(await noticeSpend(),spendBefore+1,'the committed notice is metered');
    const signal=assignedResult.body.notices[0].signal_id;
    const fresh=await tx\x60SELECT xmin::text::bigint=(pg_current_xact_id()::text::bigint & 4294967295) AS fresh
      FROM swarm.signals WHERE id=\x24{signal}::uuid\x60;
    assert.equal(fresh[0]!.fresh,true,'notice uses the normal directed-signal transaction');
    const deliveries=await tx\x60SELECT signal_id FROM swarm.signal_deliveries WHERE workspace_id=\x24{f.workspace}::uuid AND recipient_agent_principal_id=\x24{f.principal}::uuid\x60;
    assert.deepEqual(deliveries.map(r=>r.signal_id),[signal]);
    const replay=await call('todo_assign',assign,request);
    assert.equal(replay.body.replayed,true); assert.deepEqual(replay.body.notices,assignedResult.body.notices);
    const signals=await tx\x60SELECT count(*)::int AS n FROM swarm.signals WHERE workspace_id=\x24{f.workspace}::uuid\x60;
    assert.equal(signals[0]!.n,1,'replay posts no second signal');
    assert.equal(await noticeSpend(),spendBefore+1,'replay adds no notice spend');
    const queue=await call('todo_queue'); assert.equal(queue.status,200); assert.equal(queue.body.status,'ok');
    assert.equal(queue.body.queue.status.work,'idle');
    assert.equal(queue.body.queue.status.facts.connection,'live');
    assert.deepEqual(queue.body.queue.up_next.map((t: {todo_id: string})=>t.todo_id),[created.todo_id]);
    const started=committed(await call('todo_start')); assert.equal(started.state,'doing');
    const done=committed(await call('todo_set_state',{todo_id:started.todo_id,base_version:started.version,state:'done'}));
    assert.equal(done.state,'done');
    const foreign=await call('todo_read',{todo_id:done.todo_id},crypto.randomUUID(),f.foreign);
    assert.equal(foreign.status,403,'hosted capability cannot choose another workspace');
    assert.equal((await call('todo_read',{todo_id:done.todo_id})).body.todo.state,'done');

    const ownerFields={user_id:f.owner,principal_id:null,run_id:null,connection:null};
    const localIdentity={user_id:f.owner,principal_id:f.local,run_id:f.run,connection:{connection_id:f.credential,grant_id:f.run}};
    const yes=async ()=>true;
    const localWriteId=crypto.randomUUID();
    await tx\x60SET LOCAL ROLE swarm_command\x60;
    const localControl=await surface.executeHouseholdSurface(tx,f.workspace,localIdentity,localWriteId,
      {kind:'household_tool',tool:'todo_create',arguments:{seat:'seat_0000000000000000000000',request_id:localWriteId,title:'Local positive control'}},yes);
    assert.equal(localControl.status,'committed');
    await tx\x60RESET ROLE\x60;
    const humanCommands=[
      {kind:'household_todo_answer',todo_id:done.todo_id,offer_id:crypto.randomUUID(),answer:'accept'},
      {kind:'household_todo_steer',todo_id:done.todo_id,base_version:done.version,action:{kind:'start_now'}},
      {kind:'household_agent_work_policy',principal_id:f.principal,accepts_from:'anyone'},
      {kind:'household_activity',since:'2020-01-01T00:00:00Z',limit:100},
    ];
    for (const command of humanCommands) {
      const hosted=await api.handleHostedCommand(envelope(command),await capability('todo_create'));
      assert.equal(hosted.status,403); assert.deepEqual(hosted.body,{error:'forbidden'});
      assert.deepEqual(await surface.executeHouseholdSurface(tx,f.workspace,localIdentity,crypto.randomUUID(),command,yes),
        {status:'refused',reason:'human_confirmation_required'});
    }
    const offered=committed(await call('todo_create',{title:'Sibling request',assign:{to:{kind:'agent',id:f.sibling},start:'now'}}));
    assert.equal(offered.assignee,null); assert.equal(offered.queue_rank,null); assert.equal(offered.offer.decider_user_id,f.owner);
    const answered=committed(await human(envelope({kind:'household_todo_answer',todo_id:offered.todo_id,offer_id:offered.offer.offer_id,answer:'accept'})));
    assert.equal(answered.assignee.id,f.sibling); assert.equal(answered.offer,null);
    const acceptedId=crypto.randomUUID();
    const accepted=committed(await human(envelope({kind:'household_tool',tool:'todo_create',arguments:{seat:'seat_0000000000000000000000',request_id:acceptedId,
      title:'Human starts now',assign:{to:{kind:'agent',id:f.sibling},start:'now'}}},acceptedId)));
    assert.equal(accepted.offer,null); assert.equal(accepted.queue_rank,1);
    const steered=committed(await human(envelope({kind:'household_todo_steer',todo_id:answered.todo_id,base_version:answered.version,action:{kind:'move',after_todo_id:null}})));
    assert.equal(steered.todo_id,answered.todo_id);
    assert.equal(committed(await human(envelope({kind:'household_agent_work_policy',principal_id:f.principal,accepts_from:'anyone'}))).accepts_from,'anyone');

    // Exhaust only signal limits. The to-do still commits and its durable
    // replay carries the not_sent receipt instead of trying again.
    await tx\x60INSERT INTO swarm.rate_buckets(bucket_key,window_start,count) VALUES (\x24{'signal:credential:hosted_seat:'+f.connection},date_trunc('hour',statement_timestamp()),10000)
      ON CONFLICT(bucket_key,window_start) DO UPDATE SET count=EXCLUDED.count\x60;
    const limitedId=crypto.randomUUID(), limitedFields={title:'Rate limited notice',assign:{to:{kind:'agent',id:f.principal}}};
    const limited=await call('todo_create',limitedFields,limitedId); committed(limited);
    assert.equal(limited.body.notices[0].status,'not_sent'); assert.equal(limited.body.notices[0].reason,'signal_rate_limited');
    const limitedReplay=await call('todo_create',limitedFields,limitedId);
    assert.equal(limitedReplay.body.replayed,true); assert.deepEqual(limitedReplay.body.notices,limited.body.notices);

    // Committed revisions appear once each; private drafts do not enter the
    // activity source. Seed projection metadata without uploading any bytes.
    const revision={revision:{workspace_id:f.workspace,object_id:'doc-one',token:'revision_committed'},parent:null,title:'Committed doc',kind:'doc',
      file_metadata:null,blob:{storage_key:'synthetic',size_bytes:1,sha256:'a'.repeat(64)},author:{...ownerFields},occurred_at_server:Date.now(),command_id:'synthetic_doc'};
    const projection={workspace_id:f.workspace,stream_id:crypto.randomUUID(),last_seq:0,objects:{'doc-one':{object_id:'doc-one',kind:'doc',history:[revision]}},
      reservations:{},drafts:{'hidden':{title:'Private draft'}},receipts:{}};
    await tx\x60INSERT INTO swarm.household_object_streams(workspace_id,stream_id,last_seq,projection) VALUES (\x24{f.workspace}::uuid,\x24{projection.stream_id}::uuid,0,\x24{tx.json(projection)})\x60;
    const activity=await human(envelope(humanCommands[3]!)); assert.equal(activity.body.status,'ok');
    assert.ok(activity.body.activity.some((r: {object: {id: string}; event: string})=>r.object.id===done.todo_id&&r.event==='done'));
    assert.deepEqual(activity.body.activity.filter((r: {object: {kind: string}})=>r.object.kind==='doc').map((r: {title: string})=>r.title),['Committed doc']);
    assert.ok(!JSON.stringify(activity.body).includes('Private draft'));
    const ordered=await tx\x60SELECT event_id,event->'payload'->'todo_ids' AS ids FROM swarm.household_todo_events
      WHERE workspace_id=\x24{f.workspace}::uuid AND event->>'type'='TodoQueueOrdered' ORDER BY seq DESC LIMIT 1\x60;
    assert.ok(ordered[0]);
    assert.deepEqual(activity.body.activity.filter((r: {key: string})=>r.key.startsWith('todo:'+ordered[0]!.event_id+':'))
      .map((r: {object: {id: string}})=>r.object.id).sort(), (ordered[0]!.ids as string[]).sort());
    const bounded=await human(envelope({...humanCommands[3],limit:1})); assert.equal(bounded.body.activity.length,1);
    await tx\x60DELETE FROM swarm.household_content_connections WHERE workspace_id=\x24{f.workspace}::uuid AND owner_user_id=\x24{f.owner}::uuid\x60;
    await tx\x60DELETE FROM swarm.household_member_content_roles WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    const hidden=await human(envelope(humanCommands[3]!)); assert.equal(hidden.body.reason,'content_consent_required');

    // A grant on a live column is forbidden; after dropping that column,
    // dropped pg_attribute entries must not invalidate the exact ACL proof.
    assert.equal((await tx.unsafe(input.catalog))[0]!.catalog_ok,true);
    await tx\x60ALTER TABLE swarm.household_todo_receipts ADD COLUMN retired_field text\x60;
    await tx\x60GRANT SELECT(retired_field) ON swarm.household_todo_receipts TO authenticated\x60;
    assert.equal((await tx.unsafe(input.catalog))[0]!.catalog_ok,false);
    await tx\x60ALTER TABLE swarm.household_todo_receipts DROP COLUMN retired_field\x60;
    assert.equal((await tx.unsafe(input.catalog))[0]!.catalog_ok,true);
    throw new FixtureRollback();
  }),FixtureRollback);
  console.log('L4_RESULT:ok');
} finally { api.db.begin=originalBegin; await api.db.end(); }
`;

test('hosted to-do round trip preserves notices, replay, tenant isolation and human-only steering', { timeout: 120_000 }, () => {
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { DB_URL: string };
  const f = fixture();
  const schema = emptyApplicationSchema() + repoSql('supabase/household-todo-reserve/20261006000001-rollback.sql')
    + repoSql('supabase/migrations/20261006000001_household_todos.sql');
  const result = spawnSync('deno', ['eval', '--no-lock', '--config', 'supabase/functions/command/deno.json', harness], {
    cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({ f, schema, setup: f.setup,
      catalog: releaseCatalogQuery(repoSql('deploy/release-proofs/household-todo/20261006000001-catalog.sql'), 'catalog_ok') }),
    env: { PATH: process.env.PATH ?? '', ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: 'test', SWARM_DATABASE_URL: localClusterAdminUrl(local.DB_URL),
      SUPABASE_URL: 'https://storage.example.test', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-storage' },
    timeout: 110_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `L4 harness failed: ${result.stderr}`);
  assert.match(result.stdout, /L4_RESULT:ok/);
});
