/** CI only. Real application DDL, PostgreSQL ACLs and rollback-only synthetic rows.
 * This file uses the local docker/psql boundary, never HTTP or customer data.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';
import { householdAccessRefusal, type HouseholdAccessFacts } from '../../src/protocol/household-object-policy.js';

const proofRoot = 'deploy/release-proofs/home-overview/20261006000002';
const catalog = (suffix: 'catalog' | 'rollback-catalog') => releaseCatalogQuery(repoSql(`${proofRoot}-${suffix}.sql`), suffix === 'catalog' ? 'catalog_ok' : 'rollback_ok').trimEnd().replace(/;$/, '');
const migration = () => repoSql(`${proofRoot}-rollback.sql`)
  + repoSql('supabase/migrations/20261006000002_home_overview.sql');
const claims = (user: string, extra: Record<string, unknown> = {}) =>
  `SELECT set_config('request.jwt.claims','${JSON.stringify({ sub: user, role: 'authenticated', ...extra })}',true);`;
const snapshot = () => `CREATE TEMP TABLE overview_result AS SELECT swarm_read.home_overview() AS value;`;
const refresh = () => `TRUNCATE overview_result; INSERT INTO overview_result SELECT swarm_read.home_overview();`;
const overviewWorkspace = `(SELECT value->'workspaces'->0 FROM overview_result)`;
const check = (predicate: string, label: string) => dbAssert(`SELECT ${predicate} FROM overview_result`, label);
const userSql = (id: string) => `INSERT INTO auth.users(id,aud,role,email) VALUES ('${id}','authenticated','authenticated','${id}@example.test');
 INSERT INTO swarm.users(user_id,display_name) VALUES ('${id}','Synthetic person');`;
const workspaceSql = (workspace: string, owner: string) => `INSERT INTO swarm.workspaces(workspace_id,name,created_by)
 VALUES ('${workspace}','Synthetic home','${owner}');
 INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${workspace}','${owner}','owner');`;
const boundarySql = (workspace: string) => `INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES ('${workspace}','shared');`;
const consentSql = (workspace: string, user: string, role = 'editor') => `INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
 VALUES ('${workspace}','${user}','${role}','${randomUUID()}',statement_timestamp());`;
const agentSql = (workspace: string, owner: string, principal: string, removed = false) => `INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,revoked_at)
 VALUES ('${principal}','${workspace}','${owner}','Synthetic ${principal}',${removed ? 'statement_timestamp()' : 'NULL'});`;
function todoSql(workspace: string, owner: string, id: string, fields: Record<string, string> = {}) {
  const values: Record<string, string> = {
    workspace_id: `'${workspace}'`, todo_id: `'${id}'`, version: '1', title: "'Synthetic private title'", state: "'open'",
    created_by_user: `'${owner}'`, created_at: 'statement_timestamp()', state_by_user: `'${owner}'`,
    state_at: 'statement_timestamp()', last_seq: '0', ...fields,
  };
  if (fields.assignee_user || fields.assignee_principal) {
    values.assigned_by_user ??= `'${owner}'`; values.assigned_at ??= 'statement_timestamp()';
  }
  if (fields.offer_id) {
    values.offer_start ??= "'queue'"; values.offer_gate ??= "'{\"kind\":\"none\"}'";
    values.offer_by_user ??= `'${owner}'`; values.offered_at ??= 'statement_timestamp()';
  }
  return `INSERT INTO swarm.household_todos(${Object.keys(values).join(',')}) VALUES (${Object.values(values).join(',')});`;
}
function signalSql(workspace: string, from: string, id: string, fields: Record<string, string> = {}) {
  const values: Record<string, string> = {
    id: `'${id}'`, workspace_id: `'${workspace}'`, from_principal: `'${from}'`, from_kind: "'user'", kind: "'note'",
    body: "'Synthetic message'", created_at: "statement_timestamp()-interval '1 minute'", until: "statement_timestamp()+interval '1 day'", ...fields,
  };
  return `INSERT INTO swarm.signals(${Object.keys(values).join(',')}) VALUES (${Object.values(values).join(',')});`;
}
function localCredential(workspace: string, owner: string, principal: string) {
  const run = randomUUID(), device = randomUUID();
  return `INSERT INTO swarm.devices(device_id,user_id,label) VALUES ('${device}','${owner}','Synthetic device');
   INSERT INTO swarm.agent_runs(run_id,principal_id,device_id) VALUES ('${run}','${principal}','${device}');
   INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id)
    VALUES ('${randomUUID()}','${principal}','${run}','[]',decode(replace('${randomUUID()}${randomUUID()}','-',''),'hex'),
    statement_timestamp()+interval '1 hour','${randomUUID()}');`;
}

// Contract owner: access parity. A copied SQL condition cannot serve as its oracle;
// each scenario has an explicit ruling, compared to both the pure core and SQL.
test('SQL human content access agrees with the core and explicit consent/membership rulings', () => {
  const cases = [
    { name: 'shared editor', allowed: true },
    { name: 'shared reader', contentRole: 'reader', allowed: true },
    { name: 'personal owner', personal: true, allowed: true },
    { name: 'personal other', personal: true, boundaryOther: true, allowed: false },
    { name: 'archived workspace', archived: true, allowed: false },
    { name: 'removed member', removed: true, allowed: false },
    { name: 'missing membership', noMember: true, allowed: false },
    { name: 'revoked content rights', rightsRevoked: true, allowed: false },
    { name: 'no content approval', noRights: true, allowed: false },
    { name: 'missing boundary', noBoundary: true, allowed: false },
  ];
  let sql = migration();
  for (const c of cases) {
    const workspace = randomUUID(), user = randomUUID(), other = randomUUID();
    const facts: HouseholdAccessFacts = {
      workspace_id: workspace, archived_at: c.archived ? 1 : null,
      boundary: c.personal ? { kind: 'personal', owner_user_id: c.boundaryOther ? other : user } : { kind: 'shared' },
      actor: { user_id: user, principal_id: null, run_id: null }, credential: { kind: 'human' },
      member: c.noMember ? null : { workspace_id: workspace, user_id: user,
        revoked_at: c.removed || c.rightsRevoked ? 1 : null,
        content_role: c.noRights ? null : c.contentRole === 'reader' ? 'reader' : 'editor',
        content_consent_id: c.noRights ? null : randomUUID() },
    };
    // Missing boundary is refused by store.access before the pure core.
    const coreAllows = !c.noBoundary && householdAccessRefusal(facts, workspace, 'read', 2) === null;
    assert.equal(coreAllows, c.allowed, c.name);
    sql += userSql(user) + userSql(other) + workspaceSql(workspace, user);
    if (c.noMember) sql += `DELETE FROM swarm.memberships WHERE workspace_id='${workspace}';`;
    if (c.removed) sql += `UPDATE swarm.memberships SET revoked_at=statement_timestamp() WHERE workspace_id='${workspace}';`;
    if (c.archived) sql += `UPDATE swarm.workspaces SET archived_at=statement_timestamp() WHERE workspace_id='${workspace}';`;
    if (!c.noBoundary) sql += `INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id)
     VALUES ('${workspace}','${c.personal ? 'personal' : 'shared'}',${c.personal ? `'${c.boundaryOther ? other : user}'` : 'NULL'});`;
    if (!c.noRights && !c.noMember) sql += consentSql(workspace, user, c.contentRole ?? 'editor');
    if (c.rightsRevoked) sql += `UPDATE swarm.household_member_content_roles SET revoked_at=statement_timestamp() WHERE workspace_id='${workspace}';`;
    sql += dbAssert(`SELECT swarm.household_human_can_read('${workspace}','${user}') = ${c.allowed}`, c.name);
  }
  runSql(sql);
});

test('overview isolates live workspaces, consent, viewer-directed asks, receipt max and message counts', () => {
  const owner = randomUUID(), other = randomUUID(), w = randomUUID(), foreign = randomUUID(), archived = randomUUID();
  const principal = randomUUID(), removed = randomUUID(), directed = randomUUID(), multi = randomUUID(), answered = randomUUID();
  const agentAnswered = randomUUID(), oldReceipt = randomUUID(), newReceipt = randomUUID();
  const own = randomUUID(), after = randomUUID(), hold = randomUUID(), lost = randomUUID(), offer = randomUUID();
  const visibleMessages = [directed, multi, answered, agentAnswered, randomUUID()];
  const privateMessage = randomUUID();
  const seen = new Date(Date.now() - 2 * 3600_000).toISOString();
  runSql(`
   ${migration()} ${userSql(owner)} ${userSql(other)} ${workspaceSql(w, owner)}
   INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${w}','${other}','member');
   ${workspaceSql(foreign, other)} ${workspaceSql(archived, owner)}
   UPDATE swarm.workspaces SET archived_at=statement_timestamp() WHERE workspace_id='${archived}';
   ${boundarySql(w)} ${agentSql(w,owner,principal)} ${agentSql(w,owner,removed,true)}
   ${todoSql(w,owner,own,{assignee_user:`'${owner}'`})}
   ${todoSql(w,owner,after,{gate_kind:"'after'",gate_todo_id:`'${own}'`,assignee_principal:`'${principal}'`})}
   ${todoSql(w,owner,hold,{gate_kind:"'hold'",assignee_principal:`'${principal}'`})}
   ${todoSql(w,owner,lost,{assignee_principal:`'${removed}'`})}
   ${todoSql(w,owner,offer,{offer_id:`'${randomUUID()}'`,offer_user:`'${owner}'`,offer_decider:`'${owner}'`})}
   ${signalSql(w,other,directed,{kind:"'ask'",to_user_id:`'${owner}'`})}
   ${signalSql(w,other,multi,{kind:"'ask'",to_user_id:`'${other}'`})}
   INSERT INTO swarm.signal_recipients(signal_id,workspace_id,recipient_user_id,position)
    VALUES ('${multi}','${w}','${other}',0),('${multi}','${w}','${owner}',1);
   ${signalSql(w,other,answered,{kind:"'ask'",to_user_id:`'${owner}'`})}
   ${signalSql(w,owner,randomUUID(),{in_reply_to:`'${answered}'`})}
   ${signalSql(w,other,agentAnswered,{kind:"'ask'",to_user_id:`'${owner}'`})}
   ${signalSql(w,principal,randomUUID(),{from_kind:"'agent'",in_reply_to:`'${agentAnswered}'`})}
   ${signalSql(w,other,visibleMessages[4]!)}
   ${signalSql(w,other,privateMessage,{to_user_id:`'${other}'`})}
   ${signalSql(w,other,randomUUID(),{kind:"'ask'",to_agent_principal_id:`'${principal}'`})}
   ${signalSql(w,other,randomUUID(),{kind:"'ask'",to_user_id:`'${owner}'`,until:"statement_timestamp()-interval '1 second'"})}
   ${signalSql(w,other,oldReceipt,{created_at:"statement_timestamp()-interval '3 hours'"})}
   ${signalSql(w,other,newReceipt,{created_at:`'${seen}'::timestamptz`})}
   INSERT INTO swarm.signal_human_receipts(workspace_id,signal_id,user_id,first_seen_at) VALUES
    ('${w}','${oldReceipt}','${owner}',statement_timestamp()-interval '3 hours'),
    ('${w}','${newReceipt}','${owner}','${seen}'),
    ('${w}','${privateMessage}','${other}',statement_timestamp());
   SET CONSTRAINTS ALL IMMEDIATE;
   INSERT INTO swarm.household_object_streams(workspace_id,stream_id,projection) VALUES ('${w}','${randomUUID()}',
    '{"objects":{"a":{"kind":"list","history":[]},"b":{"kind":"doc","history":[]},"c":{"kind":"file","history":[]}},"drafts":{"hidden":{"kind":"doc"}}}');
   ${claims(owner)} SET LOCAL ROLE authenticated; ${snapshot()}
   ${check(`jsonb_array_length(value->'workspaces')=1 AND value->'workspaces'->0->>'workspace_id'='${w}'`, 'only live member workspace')}
   ${check(`value->'workspaces'->0->'content'='null'::jsonb AND value->'workspaces'->0->'needs_you'->'assigned'='[]'::jsonb
    AND value->'workspaces'->0->'needs_you'->'waiting'='[]'::jsonb`, 'no content without approval')}
   ${check(`NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'workspaces'->0->'people') person
    CROSS JOIN LATERAL jsonb_array_elements(person->'agents') agent WHERE agent->'queue' <> 'null'::jsonb)`, 'queue counts require consent')}
   ${check(`(value->'workspaces'->0->>'new_messages')::int=7`, 'counts visible other-authored messages only including expired messages and agent-directed messages')}
   ${check(`(value->'workspaces'->0->>'last_seen_at')::timestamptz='${seen}'::timestamptz`, 'viewer receipt maximum ignores another viewer')}
   ${check(`(SELECT array_agg(a->>'signal_id' ORDER BY a->>'signal_id') FROM jsonb_array_elements(value->'workspaces'->0->'needs_you'->'asks') a)
    = ARRAY[${[directed,multi].sort().map(id=>`'${id}'`).join(',')}]::text[]`, 'only unanswered live asks addressed to viewer')}
   RESET ROLE; ${consentSql(w,owner,'reader')}
   SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`(value->'workspaces'->0->'content'->>'open_todos')::int=5`, 'reader consent permits content')}
   ${check(`(value->'workspaces'->0->'content'->>'lists')::int=1 AND (value->'workspaces'->0->'content'->>'docs')::int=1
    AND (value->'workspaces'->0->'content'->>'files')::int=1`, 'projection objects counted without drafts')}
   ${check(`value->'workspaces'->0->'content'->>'new_activity' IS NULL`, 'activity never contributes to since-last-looked count')}
   ${check(`jsonb_array_length(value->'workspaces'->0->'needs_you'->'assigned')=1`, 'viewer assigned only')}
   ${check(`(SELECT array_agg(a->>'reason' ORDER BY a->>'reason') FROM jsonb_array_elements(value->'workspaces'->0->'needs_you'->'waiting') a)
    = ARRAY['after','agent_removed','hold','request']::text[]`, 'four independent waiting causes')}
   RESET ROLE; UPDATE swarm.household_member_content_roles SET revoked_at=statement_timestamp() WHERE workspace_id='${w}' AND user_id='${owner}';
   SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value->'workspaces'->0->'content'='null'::jsonb AND value->'workspaces'->0->'needs_you'->'assigned'='[]'::jsonb`, 'rights revocation takes effect on next read')}
   RESET ROLE; UPDATE swarm.memberships SET revoked_at=statement_timestamp() WHERE workspace_id='${w}' AND user_id='${owner}';
   SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value->'workspaces'='[]'::jsonb`, 'removed member sees no workspace')}
   RESET ROLE; ${claims(owner,{agent_principal_id:principal})} SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value IS NULL`, 'agent claims refused')}
   RESET ROLE; ${claims(owner,{role:'anon'})} SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value IS NULL`, 'anon claims refused even with execute-capable role')}
   RESET ROLE; SELECT set_config('request.jwt.claims','{"role":"authenticated"}',true); SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value IS NULL`, 'missing subject refused')}
   RESET ROLE; ${claims(owner,{sub:'invalid'})} SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`value IS NULL`, 'malformed subject refused')}
   RESET ROLE; SET LOCAL ROLE anon;
   ${refuses('SELECT swarm_read.home_overview()', '42501')}
   RESET ROLE; SET LOCAL ROLE swarm_command;
   ${refuses('SELECT swarm_read.home_overview()', '42501')}
   RESET ROLE;
  `);
});

test('overview gates use statement time and status uses credential facts plus recent server activity', () => {
  const owner = randomUUID(), w = randomUUID(), working = randomUUID(), idle = randomUUID(), stale = randomUUID(), removed = randomUUID();
  const doing = randomUUID(), done = randomUUID(), dropped = randomUUID(), blocked = randomUUID(), timed = randomUUID();
  const doingRow = `${overviewWorkspace}->'people'->0->'agents'`;
  const agents = `jsonb_array_elements(${doingRow}) a`;
  const queue = (field: string, count: number) => check(`(SELECT (a->'queue'->>'${field}')::int FROM ${agents} WHERE a->>'principal_id'='${working}')=${count}`, `gate section ${field}`);
  runSql(`
   ${migration()} ${userSql(owner)} ${workspaceSql(w,owner)} ${boundarySql(w)} ${consentSql(w,owner)}
   ${agentSql(w,owner,working)} ${agentSql(w,owner,idle)} ${agentSql(w,owner,stale)} ${agentSql(w,owner,removed,true)}
   ${localCredential(w,owner,working)} ${localCredential(w,owner,idle)} ${localCredential(w,owner,stale)}
   ${signalSql(w,working,randomUUID(),{from_kind:"'agent'",kind:"'working-on'"})}
   ${signalSql(w,stale,randomUUID(),{from_kind:"'agent'",kind:"'working-on'",created_at:"statement_timestamp()-interval '3 hours'"})}
   ${todoSql(w,owner,doing,{assignee_principal:`'${stale}'`,state:"'doing'"})}
   ${todoSql(w,owner,done,{state:"'done'"})} ${todoSql(w,owner,dropped,{state:"'dropped'"})} ${todoSql(w,owner,blocked)}
   ${todoSql(w,owner,randomUUID(),{assignee_principal:`'${working}'`})}
   ${todoSql(w,owner,randomUUID(),{assignee_principal:`'${working}'`,gate_kind:"'hold'"})}
   ${todoSql(w,owner,randomUUID(),{assignee_principal:`'${working}'`,gate_kind:"'after'",gate_todo_id:`'${done}'`})}
   ${todoSql(w,owner,randomUUID(),{assignee_principal:`'${working}'`,gate_kind:"'after'",gate_todo_id:`'${dropped}'`})}
   ${todoSql(w,owner,randomUUID(),{assignee_principal:`'${working}'`,gate_kind:"'after'",gate_todo_id:`'${blocked}'`})}
   ${todoSql(w,owner,timed,{assignee_principal:`'${working}'`,gate_kind:"'at'",gate_at:"statement_timestamp()+interval '1 day'"})}
   ${signalSql(w,owner,randomUUID(),{to_agent_principal_id:`'${idle}'`})}
   ${claims(owner)} SET LOCAL ROLE authenticated; ${snapshot()}
   ${queue('working',0)} ${queue('up_next',3)} ${queue('not_yet',3)}
   ${check(`(SELECT a->'status'->>'work' FROM ${agents} WHERE a->>'principal_id'='${working}')='working'`, 'recent live working-on')}
   ${check(`(SELECT a->'status'->>'work' FROM ${agents} WHERE a->>'principal_id'='${stale}')='idle'`, 'old Doing and working-on claims are idle')}
   ${check(`(SELECT a->'status'->>'work' FROM ${agents} WHERE a->>'principal_id'='${idle}')='idle'
    AND (SELECT a->'status'->'facts'->>'messages_waiting_since' FROM ${agents} WHERE a->>'principal_id'='${idle}') IS NOT NULL`, 'waiting messages do not imply disconnection')}
   ${check(`(SELECT a->'status'->>'work' FROM ${agents} WHERE a->>'principal_id'='${removed}')='disconnected'`, 'revocation determines disconnected')}
   RESET ROLE; UPDATE swarm.household_todos SET gate_at=statement_timestamp()+interval '25 milliseconds' WHERE workspace_id='${w}' AND todo_id='${timed}';
   SELECT pg_sleep(0.05);
   SET LOCAL ROLE authenticated; ${refresh()} ${queue('up_next',4)} ${queue('not_yet',2)}
   RESET ROLE; UPDATE swarm.household_member_content_roles SET revoked_at=statement_timestamp() WHERE workspace_id='${w}';
   SET LOCAL ROLE authenticated; ${refresh()}
   ${check(`(SELECT a->'status'->'facts'->'doing'->'title' FROM ${agents} WHERE a->>'principal_id'='${stale}')='null'::jsonb
    AND (SELECT a->'queue' FROM ${agents} WHERE a->>'principal_id'='${stale}')='null'::jsonb`, 'Doing title and queue masked without consent')}
   RESET ROLE;
  `);
});

test('every overview bound is enforced with an excess-row control; rollback preserves history and ACLs', () => {
  const owner = randomUUID(), other = randomUUID(), w = randomUUID();
  let setup = migration() + userSql(owner) + userSql(other) + workspaceSql(w,owner) + boundarySql(w) + consentSql(w,owner);
  setup += `UPDATE swarm.workspaces SET created_at=statement_timestamp()-interval '1 day' WHERE workspace_id='${w}';`;
  for (let i=0;i<50;i++) setup += workspaceSql(randomUUID(),owner);
  const members: string[] = [];
  for (let i=0;i<25;i++) {
    const person = randomUUID(); members.push(person); setup += userSql(person) + `INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${w}','${person}','member');`;
  }
  members.sort();
  for (let i=0;i<51;i++) setup += agentSql(w,i < 26 ? owner : members[0]!,randomUUID());
  for (let i=0;i<100;i++) setup += signalSql(w,other,randomUUID(),{ kind:i<11 ? "'ask'" : "'note'", to_user_id:i<11 ? `'${owner}'` : 'NULL' });
  const retainedTodo = randomUUID();
  for (let i=0;i<21;i++) setup += todoSql(w,owner,i === 0 ? retainedTodo : randomUUID(),{assignee_user:`'${owner}'`,offer_id:`'${randomUUID()}'`,offer_user:`'${owner}'`,offer_decider:`'${owner}'`});
  const stream = randomUUID(), event = randomUUID(), objectStream = randomUUID(), objectEvent = randomUUID();
  setup += `INSERT INTO swarm.household_todo_streams(workspace_id,stream_id,last_seq) VALUES ('${w}','${stream}',0);
   INSERT INTO swarm.household_todo_events(workspace_id,seq,event_id,occurred_at,event) VALUES ('${w}',0,'${event}',statement_timestamp(),
    jsonb_build_object('workspace_id','${w}','stream_id','${stream}','seq',0,'event_id','${event}','type','TodoCreated',
     'command_id','synthetic-create','schema_version',1,'actor_user','${owner}','actor_agent_principal',NULL,'actor_run',NULL,
     'occurred_at_server',extract(epoch FROM statement_timestamp())*1000,'payload',jsonb_build_object('todo_id','${retainedTodo}')));
   INSERT INTO swarm.household_comments(workspace_id,comment_id,target_kind,target_id,author_user,body,mentions,seq,created_at)
    VALUES ('${w}','${randomUUID()}','todo','${retainedTodo}','${owner}','Synthetic comment','[]',0,statement_timestamp());
   INSERT INTO swarm.household_agent_work_policies(workspace_id,principal_id,accepts_from,set_by_user,set_at)
    SELECT '${w}',principal_id,'owner','${owner}',statement_timestamp() FROM swarm.agent_principals WHERE workspace_id='${w}' ORDER BY principal_id LIMIT 1;
   INSERT INTO swarm.household_todo_receipts(workspace_id,principal,command_id,request_digest,outcome,created_at)
    VALUES ('${w}','${owner}','synthetic-create',repeat('a',64),'{"status":"committed"}',statement_timestamp());
   INSERT INTO swarm.household_object_streams(workspace_id,stream_id,last_seq,projection) VALUES ('${w}','${objectStream}',0,'{"objects":{}}');
   INSERT INTO swarm.household_object_events(workspace_id,seq,event_id,event) VALUES ('${w}',0,'${objectEvent}',
    jsonb_build_object('workspace_id','${w}','stream_id','${objectStream}','seq',0,'event_id','${objectEvent}','type','HouseholdObjectCreated',
     'command_id','synthetic-object','schema_version',1,'actor_user','${owner}','actor_agent_principal',NULL,'actor_run',NULL,
     'occurred_at_server',extract(epoch FROM statement_timestamp())*1000,'payload','{}'::jsonb));
   INSERT INTO swarm.household_object_audit(audit_id,workspace_id,command_id,actor_user,occurred_at,command_kind,request_digest,outcome)
    VALUES ('${randomUUID()}','${w}','synthetic-create','${owner}',statement_timestamp(),'todo_create',repeat('a',64),'committed');`;
  const retained = ['household_todo_streams','household_todo_events','household_todos','household_comments','household_agent_work_policies','household_todo_receipts','household_object_streams','household_object_events','household_object_audit'];
  const data = retained.map(name => `SELECT '${name}' AS name,to_jsonb(t) AS row FROM swarm.${name} t`).join(' UNION ALL ');
  const acl = `SELECT c.oid,c.relacl,att.attnum,att.attacl FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   JOIN pg_attribute att ON att.attrelid=c.oid AND att.attnum>0 AND NOT att.attisdropped
   WHERE n.nspname='swarm' AND c.relname IN (${retained.map(name=>`'${name}'`).join(',')})`;
  runSql(`
   ${setup}
   ${dbAssert(`SELECT count(*)=51 FROM swarm.workspaces WHERE created_by='${owner}'`, 'excess workspace control')}
   ${dbAssert(`SELECT count(*)=26 FROM swarm.memberships WHERE workspace_id='${w}'`, 'excess people control')}
   ${dbAssert(`SELECT count(*)=51 FROM swarm.agent_principals WHERE workspace_id='${w}'`, 'excess agents control')}
   ${dbAssert(`SELECT count(*)=100 FROM swarm.signals WHERE workspace_id='${w}'`, 'excess message control')}
   ${claims(owner)} SET LOCAL ROLE authenticated; ${snapshot()}
   ${check(`jsonb_array_length(value->'workspaces')=50`, 'workspace bound')}
   ${check(`jsonb_array_length(value->'workspaces'->0->'people')=25`, 'people bound')}
   ${check(`(SELECT sum(jsonb_array_length(p->'agents')) FROM jsonb_array_elements(value->'workspaces'->0->'people') p)=50`, 'agents bound per workspace rather than per person')}
   ${check(`jsonb_array_length(value->'workspaces'->0->'needs_you'->'asks')=10`, 'asks bound')}
   ${check(`jsonb_array_length(value->'workspaces'->0->'needs_you'->'assigned')=20`, 'assigned bound')}
   ${check(`jsonb_array_length(value->'workspaces'->0->'needs_you'->'waiting')=20`, 'waiting bound')}
   ${check(`(value->'workspaces'->0->>'new_messages')::int=99 AND value->'workspaces'->0->'last_seen_at'='null'::jsonb`, 'no-receipt seven-day message cap')}
   RESET ROLE;
   ${dbAssert(catalog('catalog'), 'forward catalog')}
   ${dbAssert(`SELECT count(DISTINCT name)=9 FROM (${data}) populated`, 'nonempty history in every retained table')}
   CREATE TEMP TABLE overview_before_rows AS ${data};
   CREATE TEMP TABLE overview_before_acl AS ${acl};
   ${repoSql(`${proofRoot}-rollback.sql`)}
   ${dbAssert(catalog('rollback-catalog'), 'rollback catalog')}
   ${dbAssert(`SELECT NOT EXISTS ((SELECT * FROM overview_before_rows EXCEPT (${data})) UNION ALL ((${data}) EXCEPT SELECT * FROM overview_before_rows))`, 'rollback preserves all nine tables row for row')}
   ${dbAssert(`SELECT NOT EXISTS ((SELECT * FROM overview_before_acl EXCEPT (${acl})) UNION ALL ((${acl}) EXCEPT SELECT * FROM overview_before_acl))`, 'rollback preserves all retained table and column ACLs')}
  `);
});

test('without receipts only the last seven days of other-authored visible messages count', () => {
  const owner = randomUUID(), other = randomUUID(), w = randomUUID();
  runSql(`
   ${migration()} ${userSql(owner)} ${userSql(other)} ${workspaceSql(w,owner)} ${boundarySql(w)} ${consentSql(w,owner)}
   INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES ('${w}','${other}','member');
   ${signalSql(w,other,randomUUID())}
   ${signalSql(w,other,randomUUID(),{created_at:"statement_timestamp()-interval '8 days'"})}
   ${signalSql(w,owner,randomUUID())}
   ${todoSql(w,other,randomUUID())}
   ${claims(owner)} SET LOCAL ROLE authenticated; ${snapshot()}
   ${check(`(value->'workspaces'->0->>'new_messages')::int=1 AND value->'workspaces'->0->'last_seen_at'='null'::jsonb`, 'seven-day window counts messages alone')}
   ${check(`(value->'workspaces'->0->'content'->>'open_todos')::int=1`, 'to-do still appears in content')}
   RESET ROLE;
  `);
});

test('hosted activity comes from check batches; waiting messages stay idle and revoked hosted credentials disconnect', () => {
  const owner = randomUUID(), w = randomUUID();
  const cases = [
    { name:'doing after check', work:'working', doing:true },
    { name:'waiting without work', work:'idle' },
    { name:'seat removed', work:'disconnected', seatRemoved:true },
    { name:'binding removed', work:'disconnected', bindingRemoved:true },
    { name:'grant removed', work:'disconnected', grantRemoved:true },
  ];
  let sql = migration() + userSql(owner) + workspaceSql(w,owner) + boundarySql(w) + consentSql(w,owner);
  const principals: string[] = [];
  for (const c of cases) {
    const principal = randomUUID(), grant = randomUUID(), seat = randomUUID(), signal = randomUUID();
    principals.push(principal);
    sql += `INSERT INTO swarm.agent_principals(principal_id,workspace_id,owner_user_id,name,transport,turn_only)
     VALUES ('${principal}','${w}','${owner}','Synthetic ${principal}','hosted_mcp',true);
     INSERT INTO swarm.hosted_mcp_grants(grant_id,provider_grant_id,owner_user_id,home_workspace_id,client_id,resource,
      selected_workspace_ids,manifest_digest,interaction_ref,state,created_at,activated_at,revoked_at)
     VALUES ('${grant}','synthetic-${grant}','${owner}','${w}','synthetic-client','https://mcp.commonswarm.com/mcp',
      ARRAY['${w}']::uuid[],decode(repeat('a',64),'hex'),'synthetic-confirmation','${c.grantRemoved ? 'revoked' : 'active'}',
      statement_timestamp(),statement_timestamp(),${c.grantRemoved ? 'statement_timestamp()' : 'NULL'});
     INSERT INTO swarm.hosted_mcp_grant_workspaces(grant_id,workspace_id,owner_user_id,manifest_digest,consent_receipt_id,consented_at,revoked_at)
     VALUES ('${grant}','${w}','${owner}',decode(repeat('a',64),'hex'),'${randomUUID()}',statement_timestamp(),${c.bindingRemoved ? 'statement_timestamp()' : 'NULL'});
     INSERT INTO swarm.hosted_mcp_seats(seat_id,grant_id,workspace_id,owner_user_id,principal_id,name,created_at,revoked_at)
     VALUES ('${seat}','${grant}','${w}','${owner}','${principal}','Synthetic ${principal}',statement_timestamp(),${c.seatRemoved ? 'statement_timestamp()' : 'NULL'});
     ${signalSql(w,owner,signal,{to_agent_principal_id:`'${principal}'`})}
    `;
    if (c.doing) {
      sql += todoSql(w,owner,randomUUID(),{state:"'doing'",assignee_principal:`'${principal}'`});
      sql += `INSERT INTO swarm.hosted_mcp_check_cursors(seat_id,grant_id,workspace_id,principal_id)
       VALUES ('${seat}','${grant}','${w}','${principal}');
       INSERT INTO swarm.hosted_mcp_check_batches(batch_id,seat_id,grant_id,workspace_id,principal_id,signal_ids,terminal_created_at,terminal_signal_id)
       SELECT '${randomUUID()}','${seat}','${grant}','${w}','${principal}',ARRAY[id],date_trunc('milliseconds',created_at),id
        FROM swarm.signals WHERE id='${signal}';`;
    }
  }
  sql += `${claims(owner)} SET LOCAL ROLE authenticated; ${snapshot()}`;
  for (const [i,c] of cases.entries()) {
    sql += check(`(SELECT a->'status'->>'work' FROM jsonb_array_elements(value->'workspaces'->0->'people'->0->'agents') a
     WHERE a->>'principal_id'='${principals[i]}')='${c.work}'`, c.name);
  }
  sql += check(`(SELECT a->'status'->'facts'->>'messages_waiting_since' FROM jsonb_array_elements(value->'workspaces'->0->'people'->0->'agents') a
   WHERE a->>'principal_id'='${principals[1]}') IS NOT NULL`, 'hosted waiting-time fact retained');
  sql += 'RESET ROLE;';
  runSql(sql);
});
