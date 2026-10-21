import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P0 from '../../src/protocol/org-channels-contract.js';
import * as U from '../../site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.js';
const{equal:eq,deepEqual:deq,ok}=assert;
type R=U.OrgRole;type K='user'|'agent';
const NOW='2026-10-20T00:00:00Z',Y='yulan',H='household',O1='org-1',O2='org-2',W1='ws-1a',YV='Yulan',TL='Tom',AL='Argon',OPS='Ops',SI='sec',D='submit-create-channel" disabled';
const Y_OPS={org_slug:Y,workspace_slug:'ops',workspace_name:OPS},WS1={workspace_id:W1,org_id:O1,slug:'ops',name:OPS};
const org=(id:string,slug:string)=>({id,slug,display_name:slug,created_by:'u',created_at:NOW,updated_at:NOW});
const wg=(a:string,b:string,c:string,d:R,e?:string)=>({workspace_id:a,workspace_slug:b,workspace_name:c,role:d,active_seat_id:e});
const om=(a:string,b:K,c:string,d:R)=>({org_id:a,principal_kind:b,principal_id:c,role:d,created_at:NOW});
const rf=(a:K,b:string,c:string,d:string,e:string,f:R,g:string,h:any,x={}):U.OrgRosterMemberItem=>({principal_kind:a,principal_id:b,display_name:c,handle:d,initials:e,role:f,specialty:g,workspace_grants:h,...x});
const m=(h:string,...ps:Array<RegExp|string>)=>ps.forEach((p)=>(typeof p==='string'?ok(h.includes(p),p):assert.match(h,p)));
const ROSTER:U.OrgRosterMemberItem[]=[
rf('user','u-owner',TL,'@tom','TL','owner','Owner',[wg(W1,'ops',OPS,'owner'),wg('ws-1b','product','Product','owner')],{other_org_roles:[{org_id:O2,org_slug:H,org_name:H,role:'owner'}]}),
rf('agent','ag-1',AL,'@argon','AL','admin','UI',[wg(W1,'ops',OPS,'admin','seat-1a')],{skills:['Kylon','Audit'],provider:'Gemini',model:'Argon',owner_user_id:'u-owner',owner_display_name:TL,inherits_owner_access:true,connection_state:'working',active_seat_id:'seat-1a',active_seat_workspace_slug:'ops',other_org_roles:[{org_id:O2,org_slug:H,org_name:H,role:'member'}]}),
rf('user','u-guest','Guest','@g','ER','guest','G',[wg(W1,'ops',OPS,'guest')]),
rf('user','inv-1','a@b.c','invite:1','AX','member','P',[],{invite_pending:true}),
];
const PC=U.buildOrgMemberParityCommands(Y,'ops',ROSTER[1]!);
const stM=()=>{const ms=[om(O1,'user','u-owner','owner'),om(O2,'user','u-owner','owner'),om(O1,'agent','ag-1','admin'),om(O1,'user','u-a','admin')];return{organizations:[org(O1,Y),org(O2,H)],workspaces:[{...WS1}],channels:[],agentIdentities:[{id:'ag-1',owner_user_id:'u-owner',display_name:'A',created_at:NOW}],orgMemberships:ms,workspaceGrants:ms.slice(2).map((x)=>({workspace_id:W1,...x})),channelMemberships:[],seats:[{seat_id:'seat-1a',workspace_id:W1,principal_id:'ap-1',agent_identity_id:'ag-1'}]};};
const bsp=():U.OrgMembersScreenProps=>({org_id:O1,org_slug:Y,org_name:YV,current_workspace_id:W1,current_workspace_slug:'ops',current_workspace_name:OPS,actor_role:'owner',active_filter:'all',selected_principal_id:'ag-1',active_detail_tab:'profile',available_workspaces:[WS1,{workspace_id:'ws-1b',slug:'product',name:'Product'}],members:ROSTER});
test('roster filters, 4-tier roles & parity',()=>{
const rm=(p?:Partial<U.OrgMembersScreenProps>)=>U.renderOrgMembersScreen({...bsp(),...p});
deq(U.ORG_ROSTER_FILTER_TABS.map((t)=>t.id),['all','people','agents','guests','invites']);
deq(U.CREATION_MENU_ACTIONS.map((a)=>a.id),['new-agent','invite-person','connect-agent']);
for(const s of 'all:3,people:2,agents:1,guests:1,invites:1'.split(',')){const[f,n]=s.split(':');eq(U.filterOrgRosterMembers(ROSTER,f as U.OrgRosterFilter).length,Number(n));}
m(rm(),/class="org-members-mode"[^>]*data-mobile-view="list"/,'members-list-pane','member-detail-pane','class="identity"',AL,`Owner: ${TL}`,'Active seat · seat-1a','+ Invite Person','+ Connect / Grant Agent','+ Add to workspace',U.REVOCATION_SCOPE_DISCLOSURE,PC.cli_member_add,PC.cli_workspace_grant);
m(rm({mobileView:'detail'}),'data-mobile-view="detail"','← Back to members');
m(rm({active_detail_tab:'skills'}),'Kylon','Audit','org_invite_member','org_assign_workspace_member');
m(rm({pending_removal:{principal_id:'ag-1',scope:'organization'}}),'role="alertdialog"','aria-modal="true"','confirm-remove-org-member','confirm-remove-member','cancel-remove-member');
m(rm({members:[ROSTER[0]!,{...ROSTER[1]!,connection_state:'unavailable',active_seat_id:undefined,inherits_owner_access:false}]}),'Unavailable · connection offline','Direct workspace grants only');
deq(U.ORG_ROLES,['owner','admin','member','guest']);
for(const s of 'owner:admin:owner:1,owner:owner:admin:1,admin:member:admin:1,admin:member:owner:0,admin:owner:admin:0,member:guest:member:0,guest:guest:member:0'.split(',')){const[a,c,n,e]=s.split(':');eq(U.canChangeOrgRole(a as R,c as R,n as R),e==='1');}
eq(PC.cli_member_add,'cswarm org invite ag-1 --org yulan --kind agent --role admin');
eq(PC.cli_workspace_grant,'cswarm org members grant ag-1 --org yulan --workspace yulan/ops --kind agent --role admin');
eq(PC.mcp_member_add,'org_invite_member');eq(PC.mcp_workspace_grant,'org_assign_workspace_member');
});
test('workspace move,SVG,raster logo & CRUD',()=>{
m(U.renderWorkspaceMembersPanel({...Y_OPS,workspace_id:W1,actor_role:'admin',workspace_members:[ROSTER[0]!,ROSTER[1]!],org_candidates:[ROSTER[2]!]}),U.REVOCATION_SCOPE_DISCLOSURE,'Active seat seat-1a (closes immediately on removal)');
m(U.renderWorkspaceMoveModal({...Y_OPS,workspace_id:W1,source_org_id:O1,source_org_slug:Y,source_org_name:YV,target_orgs:[{org_id:O2,slug:H,display_name:H,actor_is_owner:true}],selected_target_org_id:O2,transfer_members:'owners_only',affected_non_owner_count:2,affected_agent_seat_count:1}),'value="all"','value="owners_only" checked','Non-transferred principals lose grants','cswarm workspace move yulan/ops --to-org household --transfer-members owners_only','data-action="close-dialog"');
const mR=P0.reconcileWorkspaceMove(stM(),{workspace_id:W1,target_org_id:O2,actor_user_id:'u-owner',transfer_members:'owners_only'});
eq(mR.ok,true);if(mR.ok)deq(mR.closed_seat_ids,['seat-1a']);
deq(U.LOGO_RENDITION_SIZES,[64,128,256]);
const lH=U.renderOrgLogoUploadModal({org_id:O1,org_slug:Y,org_name:YV,actor_role:'owner'});
for(const px of [64,128,256])m(lH,`orgs/org-1/logo/${px}.webp`);
const cSvg=(svgText:string)=>U.validateOrgLogoUpload({actorRole:'admin',mimeType:'image/svg+xml',sizeBytes:512,svgText});
for(const u of ['<script>1</script>','<a href="javascript:1"/>','<set to="javascript:1"/>','<x:s/>','<g fill="&#x6a;"/>','<style>@import"x"</style>','<use xlink:href="#x"/>'])eq(cSvg(`<svg>${u}</svg>`).ok,false);
deq(cSvg('<svg><filter><feGaussianBlur/></filter></svg>'),{ok:false,error:'Disallowed SVG element'});
const cS='<svg><g><rect/><path/><circle/></g></svg>';deq(cSvg(cS),{ok:true,sanitizedSvg:cS});
const PNG1=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64')),mkP=(w:number)=>{const b=PNG1.slice();new DataView(b.buffer).setUint32(16,w);return b;},PL=PNG1.length;
for(const [r,sz,b,ex] of [['owner',PL,mkP(1),1],['owner',PL,mkP(4096),0],['owner',24,PNG1.slice(0,24),0],['owner',24,undefined,0],['member',PL,mkP(1),0],['owner',2e6,mkP(1),0]] as const)eq(U.validateOrgLogoUpload({actorRole:r,mimeType:'image/png',sizeBytes:sz,bytes:b}).ok,Boolean(ex));
const crud=(mode:'create'|'rename'|'delete',typed_delete_input?:string)=>U.renderOrganizationCrudModal({mode,org_slug:Y,org_name:YV,actor_role:'owner',typed_delete_input});
for(const k of ['create','rename'] as const)ok(!crud(k).includes('typed-delete-box'));
m(crud('create'),'Create Organization','initial_workspace_name','submit-create-org');
m(crud('rename'),`Rename ${YV}`,'Save changes');
m(crud('delete'),'<dialog open aria-modal="true"',`Delete ${YV}`,'confirm-delete-org" disabled');
ok(!crud('delete',YV).includes('confirm-delete-org" disabled'));
m(U.renderCreateWorkspaceModal({...Y_OPS,org_name:YV,actor_role:'admin'}),'<dialog open aria-modal="true"','create-workspace','workspace_name','#general','submit-create-workspace');
});
test('3-step private channel wizard',()=>{
const rc=(step:1|2|3)=>U.renderCreateChannelModal({...Y_OPS,step,private_channels_enabled:true,visibility:'private',channel_icon:'lock',channel_slug:SI,topic:'Sec',guidelines:'Strict',available_principals:[ROSTER[1]!],selected_principal_ids:['ag-1']});
m(rc(1),'PRIVATE_CHANNELS_ENABLED: true','Private channels cannot later become public','do not automatically gain access','PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC','CHANNEL_HAS_PUBLIC_HISTORY',/data-step-pane="1"\s*>/,'data-step-pane="2" hidden>','data-step-pane="3" hidden>','Next step',D);
m(rc(2),'data-step-pane="1" hidden>',/data-step-pane="2"\s*>/,'name="channel_icon"',`value="${SI}"`,'value="Sec"','Strict</textarea>',D);
m(rc(3),/data-step-pane="3"\s*>/);ok(!rc(3).includes(D));
const flip=P0.validateChannelVisibilityTransition({currentVisibility:'private',nextVisibility:'workspace',nextJoinPolicy:'open'});
eq(flip.ok,false);if(!flip.ok)eq(flip.refusal.code,'PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC');
deq(U.NOTIFY_PREF_OPTIONS.map((o)=>o.id),['all','mentions','mute']);
const cmHtml=U.renderChannelMembersModal({...Y_OPS,channel_id:'ch-priv',channel_slug:'x<img src=x onerror=1>',visibility:'private',actor_channel_role:null,actor_org_role:'admin',notify_pref:'mentions',members:[{...ROSTER[0]!,channel_role:'owner',notify_pref:'all'}],typed_delete_input:'wrong'});
m(cmHtml,'PRIVATE_CHANNEL_OWNER_REQUIRED','confirm-delete-channel" disabled','Delete #x&lt;img src=x onerror=1&gt;','data-action="close-dialog"');ok(!cmHtml.includes('<img'));
eq(U.isTypedDeleteMatch(SI,'wrong'),false);eq(U.isTypedDeleteMatch(SI,SI),true);
const mod=P0.canModifyChannelMembership({...stM(),privateChannelsEnabled:true,channels:[{channel_id:'ch-priv',workspace_id:W1,slug:SI,visibility:'private',join_policy:'invite_only'}]},{principal_kind:'user',principal_id:'u-a'},'ch-priv',{principal_kind:'agent',principal_id:'ag-1'});
eq(mod.ok,false);if(!mod.ok)eq(mod.refusal.code,'PRIVATE_CHANNEL_OWNER_REQUIRED');
});
test('approvals,refusals & controller',async()=>{
const AP0:U.ApprovalCardData={approval_id:'a1',org_id:O1,org_slug:Y,requested_by_agent_identity_id:'ag-1',agent_display_name:AL,owner_user_id:'u-owner',owner_display_name:TL,action_kind:'org_assign_workspace_member',target_scope:{org:Y,workspace:'ops',channel:SI},payload:{principal_id:'ag-2',principal_name:'HezLead',role:'admin',target_org_slug:H,transfer_members:'owners_only'},state:'pending',created_at:NOW};
eq(U.buildApprovalCliCommand('a1','approve'),'cswarm org confirm a1');
eq(U.buildApprovalMcpCall('a1','approve').mcp_tool,'org_confirm_action');
m(U.renderInlineApprovalCard(AP0),`yulan / ops / ${SI}`,'HezLead (<code>ag-2</code>)','Role: <span class="badge">admin</span>','Destination org: <code>household</code>','transfer_members=owners_only','org_confirm_action {&quot;approval_id&quot;:&quot;a1&quot;,&quot;decision&quot;:&quot;approve&quot;}');
for(const u of ['javascript:1','data:text/html,1','https://e.x/x','//e.x/x'])eq(U.sanitizeRemedyUrl(u),'https://commonswarm.com/app');
for(const u of ['/app/ops','https://commonswarm.com/app/ops'])eq(U.sanitizeRemedyUrl(u),u);
const ref=P0.buildOrgChannelRefusal({code:'AMBIGUOUS_WORKSPACE_SELECTOR',missing:'org_qualifier',scope:{workspace:'ops'},choices:[[O1,Y,W1],[O2,H,'w2']].map(([o,s,w])=>({org_id:o!,org_slug:s!,workspace_id:w!,workspace_slug:'ops',selector:`${s}/ops`}))});
m(U.renderActionableRefusalBanner(ref),'AMBIGUOUS_WORKSPACE_SELECTOR','https://commonswarm.com/app/ops','workspace_list','cswarm workspaces list');
const hb=U.renderActionableRefusalBanner({...ref,remedy_url:'javascript:1'});
ok(!hb.includes('javascript:'));m(hb,'href="https://commonswarm.com/app"');
const P='pending';
for(const [fn,s0,b0] of [[0,P],[()=>{},P],[async()=>({ok:false}),P],[()=>({ok:false}),P],[()=>{throw 1;},P],[()=>({ok:true}),'approved'],[()=>({ok:true,decided_by:'u1'}),'approved','u1']] as const){const c=U.createOrgDialogsController({approvals:[{...AP0}],onAction:fn as any});c.decideApproval('a1','approve');const a=c.getState().approvals![0]!;eq(a.state,s0);eq(a.decided_by,b0);}
let rlv!:(v:any)=>void,pN=0;
const pC=U.createOrgDialogsController({approvals:[{...AP0}],onAction:()=>(pN++,new Promise((r)=>{rlv=r;}))});
pC.decideApproval('a1','approve');pC.decideApproval('a1','approve');eq(pN,1);deq(pC.getState().pendingActions,['approval:a1']);
rlv({ok:false});await 0;eq(pC.getState().pendingActions?.length,0);m(pC.renderToHtml(),'data-action-error="true"');
const base:U.OrgDialogsControllerState={
createChannel:{...Y_OPS,step:1,private_channels_enabled:true,visibility:'private',channel_slug:SI,topic:'Init',guidelines:'G',available_principals:[],selected_principal_ids:[]},
orgCrud:{mode:'delete',org_slug:Y,org_name:YV,actor_role:'owner'},
channelMembers:{...Y_OPS,channel_id:'c1',channel_slug:SI,visibility:'workspace',actor_channel_role:'owner',actor_org_role:'owner',notify_pref:'all',members:[],invite_handle:'@alice',typed_delete_input:SI},
logoUpload:{org_id:O1,org_slug:Y,org_name:YV,actor_role:'owner'},
};
let rej=false,wr=0,foc='',h='';
const acts:string[]=[],prev={textContent:''},delB={disabled:true,setAttribute(){},removeAttribute(){}},ls:Record<string,(e:any)=>void>={},b1={focus:()=>{foc='first';}},b2={focus:()=>{foc='last';}};
const root:U.OrgDialogsMountNode={get innerHTML(){return h;},set innerHTML(v){h=v;wr++;},addEventListener:(t,fn)=>{ls[t]=fn as any;},querySelector:(s)=>(s.includes('cli-preview')?prev:s.includes('confirm-delete-org')?delB:{focus:()=>{foc=s;}}),querySelectorAll:()=>[{hidden:true},b1,b2]};
const ctrl=U.mountOrgDialogsController(root,{...base,members:bsp(),workspaceMembers:{...Y_OPS,workspace_id:W1,actor_role:'owner',workspace_members:[],org_candidates:[ROSTER[0]!,ROSTER[2]!]},approvals:[AP0],onAction:(cmd)=>{acts.push(cmd.kind);return rej?{ok:false,refusal:ref}:{ok:true,decided_by:'u-owner',decided_at:NOW};}});
const st=ctrl.getState(),w0=wr,clk=(a:string,k='data-action')=>ls.click!({target:{getAttribute:(x:string)=>(x===k?a:null),parentElement:root}}),inp=(name:string,value:string)=>ls.input!({target:{name,value,getAttribute:()=>'RO'}}),chg=(name:string,value:string)=>ls.change!({target:{name,value}});
for(const s of 'channel_slug:ops-war,org_display_name:RO,org_slug:ro,initial_workspace_name:Ops,channel_invite_handle:@bob,typed_delete_input:RO'.split(',')){const[n,v]=s.split(':');inp(n!,v!);}
chg('ws_candidate_id','u-guest');eq(wr,w0);m(prev.textContent,'cswarm channel create ops-war');eq(delB.disabled,false);
deq([st.orgCrud?.org_name,st.orgCrud?.org_slug,st.orgCrud?.initial_workspace_name,st.channelMembers?.invite_handle],['RO','ro','Ops','@bob']);
const E0=['org_create','org_rename','org_create_workspace','org_move_workspace','channel_add_member','org_assign_workspace_member','channel_delete'];
for(const a of 'create-org,rename-org,create-workspace,move-workspace,logo-upload'.split(',').map((s)=>'submit-'+s).concat('channel-invite-submit','ws-add-member','confirm-delete-channel','invite-person','submit-invite-member'))clk(a);
deq(acts,E0);eq(st.lastCommand?.cli_command,`cswarm channel delete ${SI} --workspace yulan/ops --confirm ${SI}`);
inp('invite_target','pat@yulan.io');chg('invite_role','owner');
clk('connect-grant-agent');eq(st.orgCrud?.invite_target,'');eq(st.orgCrud?.invite_role,'member');
clk('new-agent','data-creation-action');m(h,'org_create_agent','agent_runtime','agent_model','Create agent');
inp('invite_target','ag-new');clk('submit-invite-member');eq(st.lastCommand?.kind,'org_create_agent');
clk('invite-person');eq(st.orgCrud?.invite_target,'pat@yulan.io');eq(st.orgCrud?.invite_role,'owner');clk('submit-invite-member');
ctrl.openDialog('org-logo-upload');
ls.change!({target:{name:'org_logo_file',files:[{name:'ok.svg',type:'image/svg+xml',size:20,text:()=>'<svg><circle/></svg>'}]}});
eq(st.logoUpload?.sanitized_svg,'<svg><circle/></svg>');m(h,'data-logo-preview="svg"');clk('submit-logo-upload');
deq(acts,[...E0,'org_create_agent','org_invite_member','org_upload_logo']);
ctrl.validateLogoUpload({mimeType:'image/svg+xml',sizeBytes:32,svgText:'<svg><script>1</script></svg>'},true);
eq(st.logoUpload?.sanitized_svg,'<svg><circle/></svg>');m(h,'data-logo-preview="svg"');
eq(st.workspaceMembers?.workspace_members[0]?.principal_id,'u-guest');
inp('channel_notify_pref','mute');chg('channel_notify_pref','mute');
eq(acts.filter((x)=>x==='channel_set_notify_pref').length,1);eq(st.lastCommand?.payload.channel_id,'c1');eq(st.lastCommand?.payload.workspace_slug,'ops');
rej=true;ctrl.decideApproval('a1','approve');eq(st.approvals?.[0]?.state,P);eq(st.refusals?.length,1);m(h,'data-action-error="true"');
rej=false;ctrl.decideApproval('a1','approve');eq(st.approvals?.[0]?.state,'approved');
ctrl.requestRemoveFromOrg('workspace');m(h,'data-pending-removal-scope="workspace"','inert');ctrl.confirmRemoveFromOrg();
const agRem=st.members?.members.find((x)=>x.principal_id==='ag-1')!;
eq(agRem.workspace_grants.length,0);eq(agRem.active_seat_id,null);
ctrl.selectMember('u-owner');eq(st.members?.mobileView,'detail');ctrl.backToMemberList();eq(st.members?.mobileView,'list');m(foc,'member-row[data-member-id="u-owner"]');
ctrl.openDialog('create-channel');m(h,'class="org-dialogs-bg" inert');foc='';ctrl.setChannelStep(2);eq(foc,'first');
ls.keydown!({key:'Tab',shiftKey:false,target:b2,preventDefault(){}});eq(foc,'first');
ls.keydown!({key:'Escape'});eq(st.activeDialog,null);
});
test('Slice 5 token budget',()=>{
const d='site/src/components/app/live-dashboard/org-dialogs';
for(const f of fs.readdirSync(d).filter((x)=>/\.(ts|css|html)$/.test(x)).map((x)=>`${d}/${x}`).concat('tests/org-channels/slice5-ui-dialogs.test.ts'))ok(fs.readFileSync(f,'utf8').length<=18000,f);
const css=fs.readFileSync(`${d}/org-dialogs.css`,'utf8');
for(const t of 'canvas:#f5f5f2,surface:#ffffff,subtle:#f5f5f2,selected:#eeefea,ink:#282720,secondary:#655e53,muted:#716b60,line:#e9e7e2,control:#7e887c,accent:#697344,focus:#586339,sidebar:390px'.split(','))ok(css.includes('--cs-'+t.replace(':',': ')));
});
