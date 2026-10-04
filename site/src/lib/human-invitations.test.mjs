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
