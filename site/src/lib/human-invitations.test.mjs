import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {createHumanInviteController} from './human-invite-controller.ts';
import {HumanInviteRefused} from '../../../src/cloud/human-invitations.ts';
const preview={status:'preview',workspace_name:'Household',preview_digest:'a'.repeat(64),audience:[],disclosure:'Shared history'};
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};};
test('sign-out and a different human clear invitation rows and suppress a late private inbox result',async()=>{
  const pending=deferred(),views=[];const controller=createHumanInviteController({inbox:()=>pending.promise},v=>views.push(v));
  controller.setAccount('person-a');const read=controller.load();controller.setAccount(null);controller.setAccount('person-b');
  pending.resolve([{invitation_id:'a-private-invite',workspace_name:'A private title'}]);await read;
  assert.equal(views.at(-1).account,'person-b');assert.deepEqual(views.at(-1).invitations,[]);assert.equal(views.at(-1).preview,null);
});
test('a delayed preview cannot replace the newly selected invitation; no acceptance occurs before the human chooses',async()=>{
  const old=deferred(),views=[];let accepts=0;
  const api={preview:ref=>ref.invitation_id==='old'?old.promise:Promise.resolve({...preview,invitation_id:'new'}),prepareAcceptance:()=>{++accepts;return {send:async()=>({status:'joined'})};}};
  const controller=createHumanInviteController(api,v=>views.push(v));controller.setAccount('recipient');
  const read=controller.review('old');await controller.review('new');old.resolve({...preview,invitation_id:'old'});await read;
  assert.equal(views.at(-1).preview.invitation_id,'new');await controller.accept('editor',false);await controller.accept('',true);assert.equal(accepts,0);
  await controller.accept('reader',true);assert.equal(accepts,1);assert.equal(views.at(-1).joined,true);
});
test('changed disclosure requires a fresh review and cannot be automatically accepted',async()=>{
  const views=[];let writes=0;
  const controller=createHumanInviteController({preview:async()=>preview,prepareAcceptance:()=>({send:async()=>{writes++;throw new HumanInviteRefused('review_changed');}})},v=>views.push(v));
  controller.setAccount('recipient');await controller.review('invite');await controller.accept('reader',true);
  assert.equal(writes,1);assert.equal(views.at(-1).preview,null);assert.equal(views.at(-1).joined,false);
  await controller.accept('editor',true);assert.equal(writes,1);
});

test('browser recipient invitation entry bundles without Node-only CLI build dependencies',async()=>{
  const result=await build({entryPoints:[fileURLToPath(new URL('./human-invitations.ts',import.meta.url))],bundle:true,write:false,
    platform:'browser',format:'esm',target:'es2022',logLevel:'silent'});
  assert.ok(result.outputFiles[0].contents.length>0);
});

test('a failed inbox read is flagged as failed, unlike an empty inbox, and a retry clears it',async()=>{
  /* R2 review: the card hid failures because an error looked like an empty list. The flag is
     explicit; a positive control proves an empty inbox is not flagged. */
  let fail=true;const views=[];
  const controller=createHumanInviteController({inbox:async()=>{if(fail)throw new Error('offline');return [];}},v=>views.push(v));
  controller.setAccount('recipient');await controller.load();
  assert.equal(views.at(-1).failed,true);assert.deepEqual(views.at(-1).invitations,[]);
  assert.match(views.at(-1).message,/could not be read/);
  fail=false;await controller.load();
  assert.equal(views.at(-1).failed,false);assert.equal(views.at(-1).message,'No pending invitations.');
});

const rows=()=>[{invitation_id:'keep',workspace_name:'Studio',inviter_display_name:'Sam'},{invitation_id:'drop',workspace_name:'Household',inviter_display_name:'Ana'}];
test('declining removes only that invitation, and only after the server confirms',async()=>{
  const sent=[],gate=deferred(),views=[];
  const controller=createHumanInviteController({inbox:async()=>rows(),prepareDecline:id=>({send:async()=>{sent.push(id);await gate.promise;return {status:'declined'};}})},v=>views.push(v));
  controller.setAccount('recipient');await controller.load();
  const declined=controller.decline('drop');
  assert.deepEqual(views.at(-1).invitations.map(row=>row.invitation_id),['keep','drop']);assert.equal(views.at(-1).busy,true);
  gate.resolve();await declined;
  assert.deepEqual(sent,['drop']);assert.deepEqual(views.at(-1).invitations.map(row=>row.invitation_id),['keep']);
  assert.equal(views.at(-1).failed,false);assert.equal(views.at(-1).message,'Invitation declined.');
  await controller.decline('not-in-the-list');assert.deepEqual(sent,['drop']);
});
test('a refused decline keeps the invitation; an unknown result retries the same request',async()=>{
  const views=[];let prepared=0,sends=0,outcome='refused';
  const controller=createHumanInviteController({inbox:async()=>rows(),prepareDecline:()=>{++prepared;return {send:async()=>{++sends;
    if(outcome==='refused')throw new HumanInviteRefused('invitation_unavailable');if(outcome==='unknown')throw new Error('offline');return {status:'declined'};}};}},v=>views.push(v));
  controller.setAccount('recipient');await controller.load();
  await controller.decline('drop');
  assert.equal(views.at(-1).failed,true);assert.deepEqual(views.at(-1).invitations.map(row=>row.invitation_id),['keep','drop']);
  outcome='unknown';await controller.decline('drop');assert.equal(prepared,2);assert.match(views.at(-1).message,/unknown/);
  outcome='ok';await controller.decline('drop');
  assert.equal(prepared,2,'the retry reuses the request whose result was unknown');assert.equal(sends,3);
  assert.deepEqual(views.at(-1).invitations.map(row=>row.invitation_id),['keep']);
});
test('a decline that settles after sign-out changes nothing for the next person',async()=>{
  const gate=deferred(),views=[];
  const controller=createHumanInviteController({inbox:async()=>rows(),prepareDecline:()=>({send:async()=>{await gate.promise;return {status:'declined'};}})},v=>views.push(v));
  controller.setAccount('person-a');await controller.load();const declined=controller.decline('drop');
  controller.setAccount('person-b');gate.resolve();await declined;
  assert.equal(views.at(-1).account,'person-b');assert.deepEqual(views.at(-1).invitations,[]);assert.equal(views.at(-1).message,'');
});
