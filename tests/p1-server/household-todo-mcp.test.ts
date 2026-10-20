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
  return { owner, other, workspace, foreign, principal, sibling, grant, connection, local, run, credential, handle, setup };
}

const harness = `
import assert from 'node:assert/strict';
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const api = await import(${JSON.stringify(new URL('../../supabase/functions/command/index.ts', import.meta.url).href)});
const auth = await import(${JSON.stringify(new URL('../../supabase/functions/_shared/hosted-seat-auth.ts', import.meta.url).href)});
const surface = await import(${JSON.stringify(new URL('../../supabase/functions/command/household-integration.ts', import.meta.url).href)});
const protocol = await import(${JSON.stringify(new URL('../../supabase/functions/_shared/protocol.js', import.meta.url).href)});
const reads=(tool: string)=>protocol.HOUSEHOLD_TOOL_REGISTRY.some(row=>row.name===tool&&row.effect==='read');
globalThis.fetch = async () => { throw new Error('Unexpected HTTP or Storage access'); };
class FixtureRollback extends Error {}
const originalBegin = api.db.begin.bind(api.db);
try {
  await assert.rejects(originalBegin(async tx => {
    await tx.unsafe(input.schema); await tx.unsafe(input.setup);
    // One top-level transaction, so a notice signal keeps the outer xmin.
    // RESET ROLE clears a transaction-local role at once. Handlers also set
    // other transaction-local settings, so each call restores those from the
    // fixture snapshot. The hosted pre-check uses this same wrapper. Auth,
    // decisions, notices and receipts stay real.
    const settingQuery = "SELECT current_setting('search_path', true) AS search_path, current_setting('lock_timeout', true) AS lock_timeout, current_setting('statement_timeout', true) AS statement_timeout, current_setting('row_security', true) AS row_security, current_setting('check_function_bodies', true) AS check_function_bodies, current_setting('request.jwt.claims', true) AS jwt_claims, current_setting('cswarm.household_actor', true) AS household_actor, current_setting('cswarm.household_request', true) AS household_request, current_setting('cswarm.household_digest', true) AS household_digest, current_setting('cswarm.household_command', true) AS household_command";
    const settingNames = { search_path: 'search_path', lock_timeout: 'lock_timeout', statement_timeout: 'statement_timeout', row_security: 'row_security', check_function_bodies: 'check_function_bodies', jwt_claims: 'request.jwt.claims', household_actor: 'cswarm.household_actor', household_request: 'cswarm.household_request', household_digest: 'cswarm.household_digest', household_command: 'cswarm.household_command' } as const;
    type SettingKey = keyof typeof settingNames;
    type SettingRow = Record<SettingKey, string | null>;
    const readSettings = async (sql: typeof tx) => {
      const [row] = await sql.unsafe<[SettingRow]>(settingQuery);
      return row!;
    };
    const baseline = await readSettings(tx);
    await tx.unsafe("SELECT set_config('role', 'swarm_command', true)");
    const [switched] = await tx.unsafe<[{ actor: string }]>("SELECT current_user AS actor");
    assert.equal(switched!.actor, 'swarm_command');
    await tx.unsafe('RESET ROLE');
    const [cleared] = await tx.unsafe<[{ actor: string; login: string }]>("SELECT current_user AS actor, session_user AS login");
    assert.equal(cleared!.actor, cleared!.login, 'RESET ROLE clears a transaction-local role at once');
    const restoreSession = async (sql: typeof tx) => {
      await sql.unsafe("SELECT set_config('role', 'none', true)");
      const live = await readSettings(sql);
      for (const key of Object.keys(settingNames) as SettingKey[]) {
        const prior = baseline[key] ?? '';
        if ((live[key] ?? '') !== prior) await sql.unsafe('SELECT set_config($1, $2, true)', [settingNames[key], prior]);
      }
    };
    const isolate = async <T>(run: (sql: typeof tx) => Promise<T>): Promise<T> => {
      await restoreSession(tx);
      let failed = false;
      try {
        return await run(tx);
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        if (failed) { try { await restoreSession(tx); } catch { /* the caller's error stands */ } }
        else await restoreSession(tx);
      }
    };
    const asCommand = async <T>(run: (sql: typeof tx) => Promise<T>): Promise<T> => isolate(async (sql) => {
      await sql.unsafe("SELECT set_config('role', 'swarm_command', true), set_config('search_path', 'swarm, pg_catalog', true), set_config('lock_timeout', '5s', true)");
      return await run(sql);
    });
    api.db.begin = (async (...args: unknown[]) => isolate(args.at(-1) as (sql: typeof tx) => Promise<unknown>)) as typeof api.db.begin;
    const f = input.f;
    await tx.unsafe("DO $edge$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='commonswarm_edge') THEN CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOREPLICATION NOBYPASSRLS; END IF; END $edge$; GRANT swarm_command,swarm_read,swarm_capability TO commonswarm_edge;");
    const runtimeMembership = await tx.unsafe("SELECT to_jsonb(m)::text AS row FROM pg_auth_members m WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole ORDER BY grantor");
    type Result = { status: number; body: Record<string, any> };
    const envelope = (command: Record<string, unknown>, id=crypto.randomUUID(), workspace=f.workspace) => ({ command_id:id, client_version:'0.1.80', workspace_id:workspace, stream:{kind:'workspace'}, command });
    const human = async (command: Parameters<typeof api.handleHostedManagementCommand>[0]): Promise<Result> => api.handleHostedManagementCommand(command, {
      userId:f.owner, email:null, displayName:'Synthetic owner', identityVerified:true, interactiveAuthAtSeconds:null });
    const capability = async (tool: string) => {
      const use = reads(tool) ? 'read' : 'command';
      const cap = await isolate(async (sql) => {
        await sql.unsafe('SELECT set_config($1, $2, true)', ['role', use === 'read' ? 'swarm_read' : 'swarm_command']);
        return auth.authenticateHostedSeatCapability(sql, { grantId:f.grant, providerGrantId:'synthetic-'+f.grant,
          handle:f.handle, tool, providerStatus:async (provider: string) => {
            const [prior] = await sql.unsafe("SELECT current_setting('role') AS value");
            await sql.unsafe("SELECT set_config('role','swarm_read',true)");
            try { const [row] = await sql.unsafe('SELECT commonswarm_oauth.provider_family_active($1) AS active',[provider]); return {active:row?.active===true}; }
            finally { await sql.unsafe('SELECT set_config($1,$2,true)',['role',String(prior!.value)]); }
          } }, use);
      });
      assert.ok(cap, 'live, approved hosted capability'); return cap;
    };
    const asEdge=async <T>(run:()=>Promise<T>):Promise<T>=>isolate(async sql=>{
      await sql.unsafe('SET LOCAL SESSION AUTHORIZATION commonswarm_edge');
      try { const [identity]=await sql.unsafe('SELECT session_user AS login'); assert.equal(identity!.login,'commonswarm_edge'); return await run(); }
      finally { await sql.unsafe('RESET SESSION AUTHORIZATION'); }
    });
    const call = async (tool: string, fields: Record<string, unknown>={}, id=crypto.randomUUID(), workspace=f.workspace): Promise<Result> => {
      const args={seat:f.handle, ...(reads(tool)?{}:{request_id:id}), ...fields};
      return asEdge(async()=>api.handleHostedCommand(envelope({kind:'household_tool',tool,arguments:args},id,workspace), await capability(tool)));
    };

    const listing=async()=>{
      const result=await human(envelope({kind:'household_connections'}));
      assert.equal(result.body.status,'ok');
      return result.body.connections.find((row: Record<string,unknown>)=>row.connection_id===f.connection);
    };
    // Missing approval is the regression: real hosted auth + command handler,
    // running with the production session identity and no mocked provider check.
    await tx\x60DELETE FROM swarm.household_content_connections WHERE hosted_grant_id=\x24{f.grant}::uuid\x60;
    const approvalCount=async()=>Number((await tx\x60SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE hosted_grant_id=\x24{f.grant}::uuid\x60)[0]!.n);
    await tx\x60UPDATE swarm.household_member_content_roles SET content_role='reader' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    const ownerReader = await call('todo_list');
    if (ownerReader.body.status !== 'ok') {
      // Never emit arbitrary response strings, IDs, tokens, or the raw body.
      const knownFields = ['status','error','reason','code','retryable','next_action','todos','queue','ok','event_ids','events'];
      const classify = (value: unknown) => {
        const known = ['ok','refused','accepted','committed','forbidden','invalid_request','upgrade_required',
          'workspace_access_refused','content_consent_required','connection_access_refused','household_service_updating'];
        return typeof value === 'string' && known.includes(value) ? value : value == null ? 'absent' : 'other';
      };
      const keys = Object.keys(ownerReader.body);
      console.error('OWNER_READER_DIAG:'+JSON.stringify({
        http_status:Number.isInteger(ownerReader.status) && ownerReader.status>=100 && ownerReader.status<=599 ? ownerReader.status : null,
        status:classify(ownerReader.body.status),error:classify(ownerReader.body.error),
        reason:classify(ownerReader.body.reason),code:classify(ownerReader.body.code),
        fields:knownFields.filter(key=>keys.includes(key)),unknown_field_count:keys.filter(key=>!knownFields.includes(key)).length,
        classification:ownerReader.status===403?'authorization_refusal':ownerReader.status===426?'client_version_refusal':
          ownerReader.status===503?'service_gate':ownerReader.body.status==='refused'?'content_refusal':'unclassified',
      }));
    }
    assert.equal(ownerReader.body.status,'ok','owner reader inherits without Allow');
    assert.equal((await call('todo_create',{title:'Reader cannot write'})).body.status,'refused');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read');
    assert.equal(await approvalCount(),0,'reader access invents no approval');
    const inheritedListing=await listing();
    assert.equal(inheritedListing.approval,null);
    assert.deepEqual(inheritedListing.effective_access,{source:'inherited',operations:['read'],restricted:false,restrictions:[]});
    await tx\x60UPDATE swarm.household_member_content_roles SET content_role='editor' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    assert.equal((await call('todo_queue')).body.queue.content_access,'read_write');
    assert.equal(await approvalCount(),0,'editor access invents no approval');

    assert.equal((await call('todo_create',{title:'Inherited editor write'})).body.status,'committed');
    assert.equal(await approvalCount(),0,'an inherited editor write inserts no approval');
    const fences=[
      ["content role",\x60UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp() WHERE workspace_id='\x24{f.workspace}' AND user_id='\x24{f.owner}'\x60],
      ["membership",\x60UPDATE swarm.memberships SET revoked_at=clock_timestamp() WHERE workspace_id='\x24{f.workspace}' AND user_id='\x24{f.owner}'\x60],
      ["archive",\x60UPDATE swarm.workspaces SET archived_at=clock_timestamp() WHERE workspace_id='\x24{f.workspace}'\x60],
      ["principal",\x60UPDATE swarm.agent_principals SET revoked_at=clock_timestamp() WHERE principal_id='\x24{f.principal}'\x60],
      ["seat",\x60UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id='\x24{f.connection}'\x60],
      ["handle",\x60UPDATE swarm.hosted_mcp_seat_handles SET revoked_at=clock_timestamp() WHERE handle='\x24{f.handle}'\x60],
      ["binding",\x60UPDATE swarm.hosted_mcp_grant_workspaces SET revoked_at=clock_timestamp() WHERE grant_id='\x24{f.grant}'\x60],
      ["grant",\x60UPDATE swarm.hosted_mcp_grants SET state='revoked',revoked_at=clock_timestamp() WHERE grant_id='\x24{f.grant}'\x60],
      ["provider family",\x60INSERT INTO commonswarm_oauth.refresh_family_tombstones(grant_id,revoked_at) VALUES('synthetic-\x24{f.grant}',clock_timestamp())\x60],
    ];
    for (const [label,mutation] of fences) {
      assert.equal((await call('todo_list')).body.status,'ok',label+' positive control');
      const cap=await capability('todo_list');
      await tx.unsafe('SAVEPOINT owner_fence');
      await tx.unsafe(mutation!);
      const denied=await asEdge(()=>api.handleHostedCommand(envelope({kind:'household_tool',tool:'todo_list',arguments:{seat:f.handle}}),cap));
      assert.ok(denied.status===403||denied.body.status==='refused',label+' fences an already issued capability');
      if(label==='handle'||label==='provider family') assert.deepEqual((await listing()).effective_access.operations,[],label+' also fences human connection listing');
      await tx.unsafe('ROLLBACK TO SAVEPOINT owner_fence'); await tx.unsafe('RELEASE SAVEPOINT owner_fence');
      assert.equal((await call('todo_list')).body.status,'ok',label+' rollback positive control');
    }

    // Real two-session Storage linearization lives at the MCP HTTP boundary
    // in hosted-authority.test.ts; this rollback fixture has one SQL session.
    for (const condition of ['consent','boundary']) {
      await tx.unsafe('SAVEPOINT missing_bootstrap');
      await tx\x60DELETE FROM swarm.household_content_connections WHERE workspace_id=\x24{f.workspace}::uuid\x60;
      if (condition==='consent') await tx\x60DELETE FROM swarm.household_member_content_roles WHERE workspace_id=\x24{f.workspace}::uuid\x60;
      else await tx\x60DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id=\x24{f.workspace}::uuid\x60;
      const missing=await call('todo_list');
      assert.equal(missing.body.reason,condition==='consent'?'content_consent_required':'owner_confirmation_required');
      assert.equal(await approvalCount(),0,'bootstrap refusal manufactures no approval');
      await tx.unsafe('ROLLBACK TO SAVEPOINT missing_bootstrap'); await tx.unsafe('RELEASE SAVEPOINT missing_bootstrap');
      assert.equal((await call('todo_list')).body.status,'ok');
    }
    for (const role of ['admin','member']) {
      await tx\x60UPDATE swarm.memberships SET role=\x24{role} WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
      assert.equal((await call('todo_list')).body.status,'refused','non-owner still needs exact approval');
    }
    await tx\x60UPDATE swarm.memberships SET role='owner' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    const original={principal:f.principal,connection:f.connection,handle:f.handle};
    const siblingSeat=crypto.randomUUID(),siblingHandle='seat_'+crypto.randomUUID().replaceAll('-','');
    await tx\x60INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES (\x24{siblingSeat}::uuid,\x24{f.grant}::uuid,\x24{f.workspace}::uuid,\x24{f.owner}::uuid,\x24{f.sibling}::uuid,'Sibling restriction probe',clock_timestamp())\x60;
    await tx\x60INSERT INTO swarm.hosted_mcp_seat_handles(handle,seat_id,grant_id,workspace_id,principal_id,created_at)
      VALUES (\x24{siblingHandle},\x24{siblingSeat}::uuid,\x24{f.grant}::uuid,\x24{f.workspace}::uuid,\x24{f.sibling}::uuid,clock_timestamp())\x60;
    const withdraw={kind:'household_withdraw_connection',principal_id:f.principal};
    const withdrawn=await human(envelope(withdraw)); assert.equal(withdrawn.body.status,'committed'); assert.equal(withdrawn.body.withdrawn,0);
    const [restriction]=await tx\x60SELECT origin,changed_by,operations FROM swarm.household_hosted_content_restrictions
      WHERE grant_id=\x24{f.grant}::uuid AND workspace_id=\x24{f.workspace}::uuid AND principal_id=\x24{f.principal}::uuid\x60;
    assert.deepEqual(restriction,{origin:'human_withdraw',changed_by:f.owner,operations:[]});
    assert.equal((await call('todo_list')).body.reason,'connection_access_refused');
    const deniedListing=await listing();
    assert.equal(deniedListing.approval,null);
    assert.deepEqual(deniedListing.effective_access.operations,[]);
    assert.equal(deniedListing.effective_access.restricted,true);
    assert.equal(deniedListing.effective_access.restrictions[0].origin,'human_withdraw');
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await call('todo_list')).body.reason,'connection_access_refused','same grant cannot escape withdrawal via another seat/name');
    Object.assign(f,original);
    // An expired sibling stays an ambiguous deny until that exact target is reallowed.
    await tx\x60INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      SELECT \x24{siblingSeat}::uuid,\x24{f.grant}::uuid,\x24{f.workspace}::uuid,\x24{f.sibling}::uuid,\x24{f.owner}::uuid,'shared',ARRAY['read'],content_consent_id,clock_timestamp()-interval '1 hour',\x24{f.grant}::uuid
      FROM swarm.household_member_content_roles WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    const allow=(operations: string[])=>({kind:'household_approve_connection',connection:{kind:'hosted',connection_id:f.connection,grant_id:f.grant,principal_id:f.principal,operations}});
    assert.equal((await human(envelope(allow(['read'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'refused','Allow A cannot discard expired legacy B');
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await human(envelope(allow(['read'])))).body.status,'committed');
    Object.assign(f,original);
    assert.equal((await call('todo_list')).body.status,'ok','only targeted reallow replaces each expired constraint');
    assert.equal((await call('todo_create',{title:'Human chose read only'})).body.status,'refused');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read');
    const explicitListing=await listing();
    assert.equal(explicitListing.effective_access.source,'explicit');
    assert.deepEqual(explicitListing.approval.operations,['read']);
    assert.deepEqual(explicitListing.effective_access.operations,['read']);
    const [replacement]=await tx\x60SELECT origin,changed_by,operations FROM swarm.household_hosted_content_restrictions
      WHERE grant_id=\x24{f.grant}::uuid AND workspace_id=\x24{f.workspace}::uuid AND principal_id=\x24{f.principal}::uuid\x60;
    assert.deepEqual(replacement,{origin:'human_allow',changed_by:f.owner,operations:['read']});
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    Object.assign(f,original);
    assert.equal((await call('todo_create',{title:'Allow B cannot broaden read-only A'})).body.status,'refused');
    assert.deepEqual((await listing()).approval.operations,['read']);
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await human(envelope(allow(['read'])))).body.status,'committed');
    Object.assign(f,original);
    // Expired approval withdrawal still persists and never guesses its origin.
    await tx\x60UPDATE swarm.household_content_connections SET expires_at=clock_timestamp()-interval '1 hour' WHERE connection_id=\x24{f.connection}::uuid\x60;
    assert.equal((await human(envelope(withdraw))).body.withdrawn,0);
    assert.equal((await call('todo_list')).body.reason,'connection_access_refused');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read','Allow A cannot broaden explicit read-only B');
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    Object.assign(f,original);
    assert.equal((await call('todo_queue')).body.queue.content_access,'read_write','each target was truthfully reallowed');

    // Closed targets cannot force a new browser grant: only a current owner's
    // explicit Allow may replace exact retired versions, retaining live C.
    await tx.unsafe('SAVEPOINT closed_target_reallow');
    const liveSibling=crypto.randomUUID(),liveSiblingSeat=crypto.randomUUID();
    await tx\x60INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
      VALUES(\x24{liveSibling}::uuid,\x24{f.workspace}::uuid,\x24{f.owner}::uuid,'Live read-only C','hosted_mcp',true)\x60;
    await tx\x60INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at)
      VALUES(\x24{liveSiblingSeat}::uuid,\x24{f.grant}::uuid,\x24{f.workspace}::uuid,\x24{f.owner}::uuid,\x24{liveSibling}::uuid,'Live read-only C',clock_timestamp())\x60;
    await tx\x60INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      SELECT \x24{liveSiblingSeat}::uuid,\x24{f.grant}::uuid,\x24{f.workspace}::uuid,\x24{liveSibling}::uuid,\x24{f.owner}::uuid,'shared',ARRAY['read'],content_consent_id,NULL,\x24{f.grant}::uuid
      FROM swarm.household_member_content_roles WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    assert.equal((await human(envelope(withdraw))).body.status,'committed');
    const [closedBefore]=await tx\x60SELECT to_jsonb(r) AS row FROM swarm.household_hosted_content_restrictions r
      WHERE grant_id=\x24{f.grant}::uuid AND workspace_id=\x24{f.workspace}::uuid AND principal_id=\x24{f.principal}::uuid\x60;
    await tx\x60UPDATE swarm.hosted_mcp_seats SET revoked_at=clock_timestamp() WHERE seat_id=\x24{f.connection}::uuid\x60;
    await tx\x60UPDATE swarm.agent_principals SET revoked_at=clock_timestamp() WHERE principal_id=\x24{f.principal}::uuid\x60;
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await call('todo_list')).body.status,'refused','automatic same-grant inheritance never replaces a closed withdrawal');
    await tx\x60UPDATE swarm.memberships SET role='admin' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'refused','role lowering or non-owner Allow never replaces closed targets');
    await tx\x60UPDATE swarm.memberships SET role='owner' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    assert.equal((await call('todo_list')).body.status,'refused','role restoration alone never clears withdrawal');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'ok','human Allow recovers the same live grant');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read','live sibling C read-only ceiling survives retired-target replacement');
    // Keep B broad so only live C can supply the read ceiling.
    await tx.unsafe(input.ownerRollback);
    assert.equal((await call('todo_queue')).status,503,'new source retries while the compatibility gate exists');
    for (const kind of ['expired','revoked']) {
      await tx\x60UPDATE swarm.household_content_connections SET operations=ARRAY['read','create','update'],
        expires_at=CASE WHEN \x24{kind}='expired' THEN clock_timestamp()-interval '1 hour' ELSE NULL END,
        revoked_at=CASE WHEN \x24{kind}='revoked' THEN clock_timestamp() ELSE NULL END
        WHERE connection_id=\x24{liveSiblingSeat}::uuid\x60;
      const [visible]=await asCommand(sql=>sql\x60SELECT count(*)::int AS n FROM swarm.household_content_connections
        WHERE connection_id=\x24{liveSiblingSeat}::uuid\x60);
      assert.equal(visible.n,1,kind+' denial stays visible under actual rollback policy');
      assert.equal((await call('todo_list')).status,503,kind+' remains a transient refusal until gate drop');
    }
    await tx.unsafe('DROP POLICY hosted_owner_content_rollback_gate ON swarm.household_content_connections');
    assert.equal((await call('todo_list')).body.status,'refused','same denial remains after explicit forward gate drop');
    await tx\x60UPDATE swarm.household_content_connections SET operations=ARRAY['read'],expires_at=NULL,revoked_at=NULL
      WHERE connection_id=\x24{liveSiblingSeat}::uuid\x60;
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read','forward live control retains C ceiling');
    const [closedAfter]=await tx\x60SELECT to_jsonb(r) AS row FROM swarm.household_hosted_content_restrictions r
      WHERE grant_id=\x24{f.grant}::uuid AND workspace_id=\x24{f.workspace}::uuid AND principal_id=\x24{original.principal}::uuid\x60;
    assert.deepEqual(closedAfter,closedBefore,'replacement retains the original closed restriction and its provenance');
    const [marker]=await tx\x60SELECT closed_target_replacements FROM swarm.household_hosted_content_restrictions
      WHERE grant_id=\x24{f.grant}::uuid AND workspace_id=\x24{f.workspace}::uuid AND principal_id=\x24{f.principal}::uuid\x60;
    assert.equal(marker.closed_target_replacements.length,2,'only closed A restriction and legacy approval versions are replaced');
    assert.equal((await human(envelope({kind:'household_withdraw_connection',principal_id:liveSibling}))).body.status,'committed');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'refused','Allow B never replaces live C withdrawal');
    assert.equal((await human(envelope({kind:'household_approve_connection',connection:{kind:'hosted',connection_id:liveSiblingSeat,
      grant_id:f.grant,principal_id:liveSibling,operations:['read']}}))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'ok');
    await tx\x60UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
      WHERE connection_id=\x24{original.connection}::uuid\x60;
    assert.equal((await call('todo_list')).body.status,'refused','changed closed legacy version invalidates all stale replacement snapshots');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_queue')).body.queue.content_access,'read');
    const [replacementHistory]=await tx\x60SELECT count(*)::int AS n FROM swarm.household_object_audit
      WHERE workspace_id=\x24{f.workspace}::uuid AND reason_code LIKE 'closed_target_replacements:%'\x60;
    assert.ok(replacementHistory.n>=2,'append-only audit records old and new replacement marker versions');
    Object.assign(f,original);
    await tx.unsafe('ROLLBACK TO SAVEPOINT closed_target_reallow');
    await tx.unsafe('RELEASE SAVEPOINT closed_target_reallow');

    // A and B withdrawals must coexist. Allow B cannot erase A, even after
    // ownership is lowered and B keeps its own live manual approval.
    assert.equal((await human(envelope(withdraw))).body.status,'committed');
    Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
    assert.equal((await human(envelope({kind:'household_withdraw_connection',principal_id:f.principal}))).body.status,'committed');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'refused','Allow B retains explicit withdrawal A');
    await tx\x60UPDATE swarm.memberships SET role='member' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
    assert.equal((await call('todo_list')).body.status,'refused','owner-origin grant restriction survives role lowering');
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'refused','lowered-role Allow B still cannot clear A');
    Object.assign(f,original);
    assert.equal((await human(envelope(allow(['read','create','update'])))).body.status,'committed');
    assert.equal((await call('todo_list')).body.status,'ok','human may reallow the same owner-origin target after downgrade');
    await tx\x60UPDATE swarm.memberships SET role='owner' WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;

    // Ordinary nonowners with no owner-origin restriction retain independent
    // per-seat approval semantics. Narrowing/withdrawing B leaves A's write.
    for(const role of ['admin','member']) {
      await tx.unsafe('SAVEPOINT ordinary_nonowner');
      await tx\x60DELETE FROM swarm.household_hosted_content_restrictions WHERE workspace_id=\x24{f.workspace}::uuid\x60;
      await tx\x60UPDATE swarm.memberships SET role=\x24{role} WHERE workspace_id=\x24{f.workspace}::uuid AND user_id=\x24{f.owner}::uuid\x60;
      assert.equal((await call('todo_create',{title:'Unrelated approved A'})).body.status,'committed');
      Object.assign(f,{principal:f.sibling,connection:siblingSeat,handle:siblingHandle});
      assert.equal((await human(envelope(allow(['read'])))).body.status,'committed');
      Object.assign(f,original);
      assert.equal((await call('todo_create',{title:'B read-only leaves A unchanged'})).body.status,'committed');
      assert.equal((await human(envelope({kind:'household_withdraw_connection',principal_id:f.sibling}))).body.status,'committed');
      assert.equal((await call('todo_create',{title:'B withdrawn leaves A unchanged'})).body.status,'committed');
      assert.equal(Number((await tx\x60SELECT count(*)::int AS n FROM swarm.household_hosted_content_restrictions WHERE workspace_id=\x24{f.workspace}::uuid\x60)[0].n),0);
      await tx.unsafe('ROLLBACK TO SAVEPOINT ordinary_nonowner'); await tx.unsafe('RELEASE SAVEPOINT ordinary_nonowner');
    }
    assert.equal((await call('todo_list')).body.status,'ok');
    const agentWithdraw=await asEdge(async()=>api.handleHostedCommand(envelope(withdraw),await capability('todo_create')));
    assert.equal(agentWithdraw.status,403,'agent cannot clear or change restriction');
    const forged=await asEdge(()=>api.handleHostedCommand(envelope({kind:'household_tool',tool:'todo_list',arguments:{seat:f.handle}}),{} as never));
    assert.equal(forged.status,403,'JSON cannot fabricate a capability');
    assert.deepEqual(await tx.unsafe("SELECT to_jsonb(m)::text AS row FROM pg_auth_members m WHERE roleid='commonswarm_oauth_runtime'::regrole AND member='commonswarm_edge'::regrole ORDER BY grantor"),runtimeMembership,'content adds no OAuth-runtime SET or rights');
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
    const [privilege] = await tx.unsafe<[{ command_role: boolean; read_role: boolean }]>(
      "SELECT has_function_privilege('swarm_command', 'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)', 'EXECUTE') AS command_role, has_function_privilege('swarm_read', 'swarm.resolve_hosted_seat_read_authorization(uuid,text,text)', 'EXECUTE') AS read_role");
    assert.equal(privilege!.command_role, false, 'command role cannot execute the hosted read resolver');
    assert.equal(privilege!.read_role, true, 'read role can execute the hosted read resolver');
    await isolate(async (sql) => {
      await sql.unsafe("SELECT set_config('role', 'swarm_read', true)");
      const [row] = await sql.unsafe<[{ principal_id: string }]>(
        "SELECT principal_id FROM swarm.resolve_hosted_seat_read_authorization($1::uuid, $2, 'members')",
        [f.grant, f.handle]);
      assert.equal(row?.principal_id, f.principal, 'read role resolves the hosted reader');
    });
    let commandDenial = 'completed';
    // ROLLBACK TO starts a new subtransaction and leaves the savepoint open.
    // Release it before the next notice so that notice keeps the top-level xmin.
    await tx.unsafe('SAVEPOINT command_denial');
    try {
      await tx.unsafe("SELECT set_config('role', 'swarm_command', true)");
      await tx.unsafe(
        "SELECT principal_id FROM swarm.resolve_hosted_seat_read_authorization($1::uuid, $2, 'members')",
        [f.grant, f.handle]);
    } catch (error) {
      const code = (error as { code?: string }).code;
      commandDenial = typeof code === 'string' ? code : 'unknown';
    }
    await tx.unsafe('ROLLBACK TO SAVEPOINT command_denial');
    await tx.unsafe('RELEASE SAVEPOINT command_denial');
    assert.equal(commandDenial, '42501', 'command role is refused the hosted read resolver');
    const [stillFresh] = await tx.unsafe<[{ fresh: boolean }]>(
      "SELECT xmin::text::bigint=(pg_current_xact_id()::text::bigint & 4294967295) AS fresh FROM swarm.signals WHERE id=$1::uuid",
      [signal]);
    assert.equal(stillFresh!.fresh, true, 'resolver probe leaves the notice on the top-level transaction');
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
    const localControl=await asCommand(sql => surface.executeHouseholdSurface(sql,f.workspace,localIdentity,localWriteId,
      {kind:'household_tool',tool:'todo_create',arguments:{seat:'seat_0000000000000000000000',request_id:localWriteId,title:'Local positive control'}},yes));
    assert.equal(localControl.status,'committed');
    const localListing=async()=>{
      const result=await human(envelope({kind:'household_connections'}));
      assert.equal(result.body.status,'ok');
      return result.body.connections.find((row: Record<string,unknown>)=>row.connection_id===f.credential);
    };
    const listedLocal=await localListing();
    assert.deepEqual(listedLocal.approval.operations,['read','create','update'],'real local approval remains visible');
    assert.equal(listedLocal.effective_access,null,'listing does not infer canonical local liveness');
    assert.equal(listedLocal.effective_access_reason,'local_credential_liveness_not_computed');
    await tx.unsafe('SAVEPOINT local_listing_tombstone');
    await isolate(async sql=>{
      await sql\x60INSERT INTO swarm.revocation_tombstones(kind,target_id) VALUES('run',\x24{f.run}::uuid)\x60;
      const tombstoned=await localListing();
      assert.deepEqual(tombstoned.approval,listedLocal.approval,'tombstone never fabricates or removes human approval');
      assert.equal(tombstoned.effective_access,null,'uncomputed stays truthful when canonical local path would refuse');
    });
    await tx.unsafe('ROLLBACK TO SAVEPOINT local_listing_tombstone');
    await tx.unsafe('RELEASE SAVEPOINT local_listing_tombstone');
    const humanCommands=[
      {kind:'household_todo_answer',todo_id:done.todo_id,offer_id:crypto.randomUUID(),answer:'accept'},
      {kind:'household_todo_steer',todo_id:done.todo_id,base_version:done.version,action:{kind:'start_now'}},
      {kind:'household_agent_work_policy',principal_id:f.principal,accepts_from:'anyone'},
      {kind:'household_activity',since:'2020-01-01T00:00:00Z',limit:100},
    ];
    for (const command of humanCommands) {
      const hosted=await api.handleHostedCommand(envelope(command),await capability('todo_create'));
      assert.equal(hosted.status,403); assert.deepEqual(hosted.body,{error:'forbidden'});
      assert.deepEqual(await asCommand(sql => surface.executeHouseholdSurface(sql,f.workspace,localIdentity,crypto.randomUUID(),command,yes)),
        {status:'refused',reason:'human_confirmation_required'});
    }
    const offeredResult=await call('todo_create',{title:'Sibling request',assign:{to:{kind:'agent',id:f.sibling},start:'now'}});
    const offered=committed(offeredResult);
    assert.equal(offered.assignee,null); assert.equal(offered.queue_rank,null); assert.equal(offered.offer.decider_user_id,f.owner);
    assert.equal(offeredResult.body.notices.length,1); assert.equal(offeredResult.body.notices[0].status,'sent');
    const offeredSignal=offeredResult.body.notices[0].signal_id;
    assert.notEqual(offeredSignal, signal);
    const offeredFresh=await tx\x60SELECT xmin::text::bigint=(pg_current_xact_id()::text::bigint & 4294967295) AS fresh
      FROM swarm.signals WHERE id=\x24{offeredSignal}::uuid\x60;
    assert.equal(offeredFresh[0]!.fresh,true,'a notice after the resolver probe uses the top-level transaction');
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
  const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as { DB_URL: string; API_URL: string; SERVICE_ROLE_KEY: string };
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(local.API_URL).hostname),'local Storage only');
  const f = fixture();
  const schema = emptyApplicationSchema() + repoSql('supabase/household-todo-reserve/20261006000001-rollback.sql')
    + repoSql('supabase/migrations/20261006000001_household_todos.sql');
  const result = spawnSync('deno', ['eval', '--no-lock', '--config', 'supabase/functions/command/deno.json', harness], {
    cwd: process.cwd(), encoding: 'utf8', input: JSON.stringify({ f, schema, setup: f.setup,
      ownerRollback: repoSql('deploy/release-proofs/hosted-owner-content/20261019000006-rollback.sql'),
      catalog: releaseCatalogQuery(repoSql('deploy/release-proofs/household-todo/20261006000001-catalog.sql'), 'catalog_ok') }),
    env: { PATH: process.env.PATH ?? '', ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
      SWARM_ENV: 'test', SWARM_DATABASE_URL: localClusterAdminUrl(local.DB_URL),
      SUPABASE_URL: local.API_URL, SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY },
    timeout: 110_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, `L4 harness failed: ${result.stderr}`);
  assert.match(result.stdout, /L4_RESULT:ok/);
});
