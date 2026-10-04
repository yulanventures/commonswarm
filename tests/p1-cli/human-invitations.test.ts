import assert from 'node:assert/strict';
import {test} from 'node:test';
import {humanInvitationClient,HumanInviteUnknown,HumanInviteRefused} from '../../src/cloud/human-invitations.js';
test('recipient transport refreshes identity and retries an uncertain join with the same consent/request without credentials in the body',async()=>{
  const requests:{body:any;headers:any}[]=[];let calls=0;let auth=0;
  const api=humanInvitationClient({url:'https://api.example.test',anonKey:'public-test-key',authenticate:async()=>`human-${++auth}`,requestId:()=>`request_${calls++}`,
    fetcher:async(_url,init)=>{const body=JSON.parse(String(init!.body));requests.push({body,headers:init!.headers});
      if(body.command.action==='preview')return Response.json({status:'preview',workspace_id:'shared',workspace_name:'Shared',invitation_id:'invite',audience:[],disclosure:'Shared history',expires_at:200,preview_digest:'a'.repeat(64),consent_version:'household-join-v1'});
      if(requests.length===2)throw new TypeError('lost reply');
      return Response.json({status:'joined',workspace_id:'shared',workspace_name:'Shared',agents_provisioned_by_join:false});}});
  const ref={source:'delegated' as const,invitation_id:'11111111-1111-4111-8111-111111111111'};
  const preview=await api.preview(ref);assert.ok(preview.status==='preview');
  const join=api.prepareAcceptance(ref,preview,'reader');
  await assert.rejects(join.send(),HumanInviteUnknown);assert.equal((await join.send()).status,'joined');await join.send();
  assert.equal(requests.length,3);assert.deepEqual(requests[1]!.body,requests[2]!.body);
  assert.equal(requests[2]!.body.command.content_role,'reader');assert.equal(requests[2]!.body.workspace_id,undefined);
  assert.deepEqual(requests.map(r=>r.headers.authorization),['Bearer human-1','Bearer human-2','Bearer human-3']);
  assert.ok(!JSON.stringify(requests.map(r=>r.body)).includes('Bearer'));
});
test('inbox delivery carries only the human session and no caller-chosen recipient/account selector',async()=>{
  let captured:any;
  const api=humanInvitationClient({url:'https://api.example.test',anonKey:'public',authenticate:async()=>'recipient',requestId:()=> 'req',fetcher:async(url,init)=>{
    captured={url,body:JSON.parse(String(init!.body))};return Response.json({invitations:[{invitation_id:'id',workspace_name:'Household'}]});}});
  assert.equal((await api.inbox()).length,1);assert.deepEqual(captured,{url:'https://api.example.test/functions/v1/read',body:{resource:'human_invitations'}});
  const refused=humanInvitationClient({url:'https://api.example.test',anonKey:'public',authenticate:async()=>'worker',requestId:()=> 'req',fetcher:async()=>Response.json({reason:'human_sign_in_required'},{status:403})});
  await assert.rejects(refused.preview({source:'delegated',invitation_id:'id'}),HumanInviteRefused);
});
test('an acceptance response that still says pending cannot become a joined receipt',async()=>{
  const api=humanInvitationClient({url:'https://api.example.test',anonKey:'public',authenticate:async()=>'human',requestId:()=> 'same_intent',fetcher:async()=>Response.json({status:'pending',workspace_name:'Household'})});
  const attempt=api.prepareAcceptance({source:'delegated',invitation_id:'invite'},{status:'preview',workspace_id:'shared',workspace_name:'Household',invitation_id:'invite',audience:[],disclosure:'Shared history',expires_at:100,preview_digest:'a'.repeat(64),consent_version:'household-join-v1'},'reader');
  await assert.rejects(attempt.send(),HumanInviteUnknown);
});
