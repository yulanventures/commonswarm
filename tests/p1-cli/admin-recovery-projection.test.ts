import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { ADMIN_READ_RESOURCES, ADMIN_RENEWAL, adminReadRequest, parseAdminGate, parseAdminRecoveryPage } from '../../src/cloud/admin-delegations-contract.js';
import { readAdminDelegations, readAdminIssuanceGate } from '../../src/cloud/admin-delegations.js';
import { cloudTarget } from '../../src/cloud/config.js';

const id=randomUUID(), at='2026-10-03T00:00:00.000Z', digest='a'.repeat(64);
const approval={owner_user_id:id,verification_version:1,approved_at:at,approval_event_id:id,
  approval_command_id:'human-approval',withdrawn_at:null,withdrawal_event_id:null,withdrawal_reason:null};
const client={client_id:'https://client.example/metadata',publisher_identity:'Reviewed publisher',verification_version:1,
  active:true,reviewed_at:at,withdrawn_at:null,metadata_digest:digest,reapproval_required:false,approval};
const grant={grant_id:id,admin_identity_id:id,connection_id:id,client_id:client.client_id,owner_user_id:id,
  mode:'granular',scope_names:['admin:read'],workspace_selector:'selected',workspace_ids:[id],withdrawn_workspace_ids:[],
  created_at:at,expires_at:at,refresh_deadline:at,state:'expired',reason_code:null,registry_version:2,
  capability_names:['list_admin_grants'],availability_digest:digest,manifest_digest:digest,
  created_workspace_policy:{scope_names:[]},target_rules:{seat_ids:[],own_seats:true,grant_created_seats:false,
    recipient_user_ids:[id],recipient_connection_ids:[],transports:['local']},worker_scope_ceiling:['read'],role_ceiling:'member',
  renewal_limits:{grant_kinds:['timeboxed'],principal_ids:[],bearer_seconds:60,horizon_seconds:3600,successors_per_worker:1,successors_per_grant:2},
  issuance_limits:{workspaces:1,live_seats:1,total_seats:2,invitations:0,live_agent_invitations:0,worker_credentials:2,connection_attempts:2},
  client,family:{provider_grant_id:'family-public-id',state:'expired'},issuance_status:'committed',last_use_at:at,replaces_grant_id:null,
  worker_count:1,coverage_count:0};
const page={grants:[grant],clients:[client],workers:[{principal_id:id,grant_id:id,workspace_id:id,created_at:at,revoked_at:null,state:'stopped'}],
  coverage:[{workspace_id:id,grant_id:id}],actions:[],next_before:null,renewal:ADMIN_RENEWAL,
  active:{grant_count:0,full_account_count:0,expires_at:null,full_account_expires_at:null}};

test('admin-site-lifecycle read contract retains consent, approval, issuance and dependency data across both parsing boundaries',()=>{
  const result=parseAdminRecoveryPage(page);
  assert.deepEqual(parseAdminRecoveryPage(result),result);
  assert.equal(result.grants[0]!.registry_version,2);
  assert.deepEqual(result.grants[0]!.capability_names,['list_admin_grants']);
  assert.equal(result.grants[0]!.target_rules.own_seats,true);
  assert.equal(result.grants[0]!.client!.approval!.approval_event_id,id);
  assert.equal(result.grants[0]!.issuance_status,'committed');
  assert.equal(result.workers[0]!.state,'stopped');
  assert.equal(result.renewal,'client-initiated');
  const uncertain=parseAdminRecoveryPage({...page,grants:[{...grant,family:null,issuance_status:'unknown'}]});
  assert.equal(uncertain.grants[0]!.family,null);assert.equal(uncertain.grants[0]!.issuance_status,'unknown');
  const changed=parseAdminRecoveryPage({...page,clients:[{...client,verification_version:2,approval:null,reapproval_required:true}]});
  assert.equal(changed.clients[0]!.reapproval_required,true);assert.equal(changed.clients[0]!.approval,null);
  const history=parseAdminRecoveryPage({...page,actions:[{seq:'1',event_id:id,occurred_at_server:at,grant_id:null,
    admin_identity_id:null,actor_user:id,owner_user_id:id,provider_grant_id:null,action:'approve_admin_client',
    target_kind:'admin_client',target_id:client.client_id,workspace_id:null,outcome:'accepted',reason_code:null,
    next_action:'Review permissions',recovery_kind:'none',related_event_ids:[]}]});
  assert.equal(history.actions[0]!.target_id,client.client_id);
});
test('admin human projection drops private material at every nested boundary and refuses malformed lifecycle pages',()=>{
  const privateMarker='PRIVATE_RECOVERY_TEST_MARKER';
  const result=parseAdminRecoveryPage({...page,gate:{state:'open'},session_binding:privateMarker,
    grants:[{...grant,jkt:privateMarker,target_rules:{...grant.target_rules,csrf_binding:privateMarker},
      client:{...client,publisher_contact:privateMarker,approval:{...approval,session_binding:privateMarker}},
      family:{...grant.family,access_token_digest:privateMarker}}],
    clients:[{...client,review_evidence_ref:privateMarker}],workers:[{...page.workers[0],token_hash:privateMarker}],
    coverage:[{...page.coverage[0],credentials:privateMarker}]});
  assert.ok(!JSON.stringify(result).includes(privateMarker));assert.ok(!Object.hasOwn(result,'gate'));
  for(const invalid of [{...page,clients:Array(101).fill(client)},{...page,workers:[{...page.workers[0],state:'connected'}]},
    {...page,coverage:[{...page.coverage[0],grant_id:"bad"}]},{...page,grants:[{...grant,manifest_digest:'bad'}]},
    {...page,renewal:'site-initiated'},{...page,clients:[{...client,approval:{...approval,owner_user_id:'foreign'}}]}]) assert.throws(()=>parseAdminRecoveryPage(invalid));
});
test('all human recovery resources use the bounded owner-free HTTP request contract',async()=>{
  const target=cloudTarget('https://api.example.test','public-test-key');
  for(const resource of ADMIN_READ_RESOURCES){
    let captured:unknown;
    const fetcher:typeof fetch=async(_url,options)=>{captured=JSON.parse(String(options?.body));return Response.json(page);};
    const result=await readAdminDelegations(target,'synthetic-human',{resource,limit:1},fetcher);
    assert.deepEqual(captured,{resource,workspace_id:null,limit:1,before:null});assert.equal(result.renewal,'client-initiated');
    assert.equal(adminReadRequest({...captured as object,owner_user_id:id}),null);
  }
  assert.equal(adminReadRequest({resource:'admin_gate',workspace_id:null,limit:1,before:null}),null);
  assert.equal(adminReadRequest({resource:'admin_clients',workspace_id:id,limit:1,before:null}),null);
  for(const state of ['closed','open','unavailable']) assert.deepEqual(parseAdminGate({state}),{state});
  for(const value of [{state:'ready'},{state:'open',measured_edge_target:'private'},null]) assert.throws(()=>parseAdminGate(value));
});
test('projection release proof pins the actual body and reserve restores the predecessor without dropping historical data',()=>{
  const read=(path:string)=>readFileSync(new URL(`../../${path}`,import.meta.url),'utf8');
  const migration=read('supabase/migrations/20261003000005_admin_recovery_projection.sql');
  const body=migration.split('AS $fn$')[1]!.split('$fn$;')[0]!;
  const proof=read('deploy/release-proofs/item-ai/20261003000005-catalog.sql');
  assert.ok(proof.includes(`md5(p.prosrc)='${createHash('md5').update(body).digest('hex')}'`));
  const inverse=read('supabase/admin-delegation-reserve/20261003000005-rollback.sql');
  const marker='-- Reserve rollback (verbatim sibling reserve; read-only, preserves all rows):\n';
  assert.equal(migration.split(marker)[1]!.trimEnd().split('\n').map(line=>line.slice(3)).join('\n')+'\n',inverse);
  const previous=read('supabase/migrations/20261001000003_admin_recovery_read.sql').replace('CREATE FUNCTION','CREATE OR REPLACE FUNCTION');
  assert.equal(inverse.split('\n').slice(1).join('\n'),previous);
  assert.doesNotMatch(inverse.replace(/^--.*$/gmu,''),/\b(?:DROP|DELETE|TRUNCATE)\b/u);
});

test('AS gate client sends no credentials and maps transport, HTTP and schema failures to unavailable',async()=>{
  for(const state of ['closed','open','unavailable']) {
    const fetcher:typeof fetch=async(url,options)=>{
      assert.equal(String(url),'https://mcp.commonswarm.com/admin/gate');
      assert.equal(options?.credentials,'omit');assert.equal(options?.cache,'no-store');assert.equal(options?.headers,undefined);
      return Response.json({state});
    };
    assert.deepEqual(await readAdminIssuanceGate(fetcher),{state});
  }
  for(const fetcher of [async()=>Response.json({state:'open'},{status:503}),async()=>Response.json({state:'open',private:'measurement'}),
    async()=>new Response('not-json'),async()=>{throw new Error('transport');}]) assert.deepEqual(await readAdminIssuanceGate(fetcher),{state:'unavailable'});
});
