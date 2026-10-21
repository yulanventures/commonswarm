import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as P0 from '../../src/protocol/org-channels-contract.js';
import * as U from '../../site/src/components/app/live-dashboard/org-dialogs/approval-remedy-cards.js';
const{equal:eq,deepEqual:deq,ok}=assert;
type R=U.OrgRole;type K='user'|'agent';
const NOW='2026-10-20T00:00:00Z',Y='yulan',H='household',O1='org-1',O2='org-2',W1='ws-1a',W2='ws-1b',PR='product',YV='Yulan',TL='Tom',AL='Argon',OPS='Ops',SI='sec',U0='u-owner',A1='ag-1',S1='seat-1a',OW='owner',AD='admin',MB='member',PV='private',SV='image/svg+xml',C0='<svg><circle/></svg>',CA='https://commonswarm.com/app',D='submit-create-channel" disabled',L0='data-logo-preview="svg"',OO='owners_only',noop=()=>{};
const Y_OPS={org_slug:Y,workspace_slug:'ops',workspace_name:OPS},WS1={workspace_id:W1,org_id:O1,slug:'ops',name:OPS};
const wg=(a:string,b:string,c:string,d:R,e?:string)=>({workspace_id:a,workspace_slug:b,workspace_name:c,role:d,active_seat_id:e});
const om=(a:string,b:K,c:string,d:R)=>({org_id:a,principal_kind:b,principal_id:c,role:d,created_at:NOW});
const rf=(a:K,b:string,c:string,d:string,e:string,f:R,g:string,h:any,x={}):U.OrgRosterMemberItem=>({principal_kind:a,principal_id:b,display_name:c,handle:d,initials:e,role:f,specialty:g,workspace_grants:h,...x});
const m=(h:string,...ps:Array<RegExp|string>)=>ps.forEach((p)=>(typeof p==='string'?ok(h.includes(p),p):assert.match(h,p)));
const ROSTER:U.OrgRosterMemberItem[]=[
rf('user',U0,TL,'@tom','TL',OW,'Owner',[wg(W1,'ops',OPS,OW),wg(W2,PR,'Product',OW)],{other_org_roles:[{org_id:O2,org_slug:H,org_name:H,role:OW}]}),
rf('agent',A1,AL,'@argon','AL',AD,'UI',[wg(W1,'ops',OPS,AD,S1)],{skills:['Kylon','Audit'],provider:'Gemini',model:'Argon',owner_user_id:U0,owner_display_name:TL,inherits_owner_access:true,connection_state:'working',active_seat_id:S1,active_seat_workspace_slug:'ops',other_org_roles:[{org_id:O2,org_slug:H,org_name:H,role:MB}]}),
rf('user','u-guest','Guest','@g','ER','guest','G',[wg(W1,'ops',OPS,'guest')]),
rf('user','inv-1','a@b.c','invite:1','AX',MB,'P',[],{invite_pending:true}),
];
const PC=U.buildOrgMemberParityCommands(Y,'ops',ROSTER[1]!);
const stM=()=>{const ms=[om(O1,'user',U0,OW),om(O2,'user',U0,OW),om(O1,'agent',A1,AD),om(O1,'user','u-a',AD)];return{organizations:[[O1,Y],[O2,H]].map(([id,s])=>({id:id!,slug:s!,display_name:s!,created_by:'u',created_at:NOW,updated_at:NOW})),workspaces:[{...WS1}],channels:[],agentIdentities:[{id:A1,owner_user_id:U0,display_name:'A',created_at:NOW}],orgMemberships:ms,workspaceGrants:ms.slice(2).map((x)=>({workspace_id:W1,...x})),channelMemberships:[],seats:[{seat_id:S1,workspace_id:W1,principal_id:'ap-1',agent_identity_id:A1}]};};
const bsp=():U.OrgMembersScreenProps=>({org_id:O1,org_slug:Y,org_name:YV,current_workspace_id:W1,current_workspace_slug:'ops',current_workspace_name:OPS,actor_role:OW,active_filter:'all',selected_principal_id:A1,active_detail_tab:'profile',available_workspaces:[WS1,{workspace_id:W2,slug:PR,name:'Product'}],members:ROSTER});
test('roster & dialogs',()=>{
const rm=(p?:Partial<U.OrgMembersScreenProps>)=>U.renderOrgMembersScreen({...bsp(),...p});
deq(U.ORG_ROSTER_FILTER_TABS.map((t)=>t.id),'all,people,agents,guests,invites'.split(','));
deq(U.CREATION_MENU_ACTIONS.map((a)=>a.id),'new-agent,invite-person,connect-agent'.split(','));
for(const s of'all:3,people:2,agents:1,guests:1,invites:1'.split(',')){const[f,n]=s.split(':');eq(U.filterOrgRosterMembers(ROSTER,f as U.OrgRosterFilter).length,+n!);}
m(rm(),/class="org-members-mode"[^>]*data-mobile-view="list"/,'members-list-pane','member-detail-pane','class="identity"',AL,`Owner: ${TL}`,`Active seat · ${S1}`,'+ Invite Person','+ Connect / Grant Agent','+ Add to workspace',U.REVOCATION_SCOPE_DISCLOSURE,PC.cli_member_add,PC.cli_workspace_grant);
m(rm({mobileView:'detail'}),'data-mobile-view="detail"','← Back to members');
m(rm({active_detail_tab:'skills'}),'Kylon','Audit','org_invite_member','org_assign_workspace_member');
m(rm({pending_removal:{principal_id:A1,scope:'organization'}}),'role="alertdialog"','aria-modal="true"','confirm-remove-org-member','confirm-remove-member','cancel-remove-member');
m(rm({members:[ROSTER[0]!,{...ROSTER[1]!,connection_state:'unavailable',active_seat_id:undefined,inherits_owner_access:false}]}),'Unavailable · connection offline','Direct workspace grants only');
for(const[a,c,n,e]of'0101,0011,1211,1200,1010,2320,3320'.split(','))eq(U.canChangeOrgRole(U.ORG_ROLES[+a!]!,U.ORG_ROLES[+c!]!,U.ORG_ROLES[+n!]!),e==='1');
eq(PC.cli_member_add,'cswarm org invite ag-1 --org yulan --kind agent --role admin');
eq(PC.cli_workspace_grant,'cswarm org members grant ag-1 --org yulan --workspace yulan/ops --kind agent --role admin');
m(U.renderWorkspaceMembersPanel({...Y_OPS,workspace_id:W1,actor_role:AD,workspace_members:[ROSTER[0]!,ROSTER[1]!],org_candidates:[ROSTER[2]!]}),U.REVOCATION_SCOPE_DISCLOSURE,`Active seat ${S1} (closes immediately on removal)`);
m(U.renderWorkspaceMoveModal({...Y_OPS,workspace_id:W1,source_org_id:O1,source_org_slug:Y,source_org_name:YV,target_orgs:[{org_id:O2,slug:H,display_name:H,actor_is_owner:true}],selected_target_org_id:O2,transfer_members:OO,affected_non_owner_count:2,affected_agent_seat_count:1}),'value="all"','value="owners_only" checked','Non-transferred principals lose grants','cswarm workspace move yulan/ops --to-org household --transfer-members owners_only');
const mR=P0.reconcileWorkspaceMove(stM(),{workspace_id:W1,target_org_id:O2,actor_user_id:U0,transfer_members:OO});
eq(mR.ok,true);if(mR.ok)deq(mR.closed_seat_ids,[S1]);
const lH=U.renderOrgLogoUploadModal({org_id:O1,org_slug:Y,org_name:YV,actor_role:OW});
for(const px of[64,128,256])m(lH,`orgs/org-1/logo/${px}.webp`);
const cSvg=(svgText:string)=>U.validateOrgLogoUpload({actorRole:AD,mimeType:SV,sizeBytes:512,svgText});
for(const u of'<script>1</script>|<a href="javascript:1"/>|<set to="javascript:1"/>|<x:s/>|<g fill="&#x6a;"/>|<style>@import"x"</style>|<use xlink:href="#x"/>|<rect style="background:\\75rl(https://e.x)"/>'.split('|'))eq(cSvg(`<svg xmlns="http://www.w3.org/2000/svg">${u}</svg>`).ok,false);
deq(cSvg('<svg><filter><feGaussianBlur/></filter></svg>'),{ok:false,error:'Disallowed SVG element'});
const cS='<svg><g><rect/><path/><circle/></g></svg>';deq(cSvg(cS),{ok:true,sanitizedSvg:cS});
const PNG1=new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=','base64')),mkP=(w:number)=>{const b=PNG1.slice();new DataView(b.buffer).setUint32(16,w);return b;},PL=PNG1.length;
for(const[r,sz,b,ex]of[[OW,PL,mkP(1),1],[OW,PL,mkP(4096),0],[OW,24,PNG1.slice(0,24),0],[OW,24,undefined,0],[MB,PL,mkP(1),0],[OW,2e6,mkP(1),0]]as const)eq(U.validateOrgLogoUpload({actorRole:r,mimeType:'image/png',sizeBytes:sz,bytes:b}).ok,!!ex);
const crud=(mode:'create'|'rename'|'delete',typed_delete_input?:string)=>U.renderOrganizationCrudModal({mode,org_slug:Y,org_name:YV,actor_role:OW,typed_delete_input}),DC='confirm-delete-org" disabled';
for(const k of['create','rename']as const)ok(!crud(k).includes('typed-delete-box'));
m(crud('create'),'Create Organization','initial_workspace_name','submit-create-org');
m(crud('delete'),'<dialog open aria-modal="true"',`Delete ${YV}`,DC);ok(!crud('delete',YV).includes(DC));
const rc=(step:1|2|3)=>U.renderCreateChannelModal({...Y_OPS,step,private_channels_enabled:true,visibility:PV,channel_icon:'lock',channel_slug:SI,topic:'Sec',guidelines:'Strict',available_principals:[ROSTER[1]!],selected_principal_ids:[A1]});
m(rc(1),'PRIVATE_CHANNELS_ENABLED: true','Private channels cannot later become public','do not automatically gain access','PRIVATE_CHANNEL_CANNOT_BECOME_PUBLIC','CHANNEL_HAS_PUBLIC_HISTORY',/data-step-pane="1"\s*>/,'data-step-pane="2" hidden>',D);
m(rc(2),'data-step-pane="1" hidden>',/data-step-pane="2"\s*>/,'name="channel_icon"',`value="${SI}"`,D);
m(rc(3),/data-step-pane="3"\s*>/);ok(!rc(3).includes(D));
eq(P0.validateChannelVisibilityTransition({currentVisibility:PV,nextVisibility:'workspace',nextJoinPolicy:'open'}).ok,false);
const cmHtml=U.renderChannelMembersModal({...Y_OPS,channel_id:'ch-priv',channel_slug:'x<img src=x onerror=1>',visibility:PV,actor_channel_role:null,actor_org_role:AD,notify_pref:'mentions',members:[{...ROSTER[0]!,channel_role:OW,notify_pref:'all'}],typed_delete_input:'wrong'});
m(cmHtml,'PRIVATE_CHANNEL_OWNER_REQUIRED','confirm-delete-channel" disabled','Delete #x&lt;img src=x onerror=1&gt;');ok(!cmHtml.includes('<img'));
eq(P0.canModifyChannelMembership({...stM(),privateChannelsEnabled:true,channels:[{channel_id:'ch-priv',workspace_id:W1,slug:SI,visibility:PV,join_policy:'invite_only'}]},{principal_kind:'user',principal_id:'u-a'},'ch-priv',{principal_kind:'agent',principal_id:A1}).ok,false);
});
test('controller',async()=>{
const AP0:U.ApprovalCardData={approval_id:'a1',org_id:O1,org_slug:Y,requested_by_agent_identity_id:A1,agent_display_name:AL,owner_user_id:U0,owner_display_name:TL,action_kind:'org_assign_workspace_member',target_scope:{org:Y,workspace:'ops',channel:SI},payload:{principal_id:'ag-2',principal_name:'HezLead',role:AD,target_org_slug:H,transfer_members:OO},state:'pending',created_at:NOW};
eq(U.buildApprovalCliCommand('a1','approve'),'cswarm org confirm a1');eq(U.buildApprovalMcpCall('a1','approve').mcp_tool,'org_confirm_action');
m(U.renderInlineApprovalCard(AP0),`yulan / ops / ${SI}`,'HezLead (<code>ag-2</code>)','Role: <span class="badge">admin</span>','Destination org: <code>household</code>','transfer_members=owners_only','org_confirm_action {&quot;approval_id&quot;:&quot;a1&quot;,&quot;decision&quot;:&quot;approve&quot;}');
for(const u of'javascript:1,data:text/html,https://e.x/x,//e.x/x'.split(','))eq(U.sanitizeRemedyUrl(u),CA);
for(const u of['/app/ops',`${CA}/ops`])eq(U.sanitizeRemedyUrl(u),u);
const ref=P0.buildOrgChannelRefusal({code:'AMBIGUOUS_WORKSPACE_SELECTOR',missing:'org_qualifier',scope:{workspace:'ops'},choices:[[O1,Y,W1],[O2,H,'w2']].map(([o,s,w])=>({org_id:o!,org_slug:s!,workspace_id:w!,workspace_slug:'ops',selector:`${s}/ops`}))});
m(U.renderActionableRefusalBanner(ref),'AMBIGUOUS_WORKSPACE_SELECTOR',`${CA}/ops`,'workspace_list','cswarm workspaces list');
const hb=U.renderActionableRefusalBanner({...ref,remedy_url:'javascript:1'});ok(!hb.includes('javascript:'));m(hb,`href="${CA}"`);
const P='pending',AV='approved',ER='data-action-error="true"',SM='submit-invite-member',IT='invite_target',PT='pat@yulan.io',AP='approve';
for(const[fn,s0,b0]of[[0,P],[noop,P],[async()=>({ok:false}),P],[()=>({ok:false}),P],[()=>{throw 1;},P],[()=>({ok:true}),AV],[()=>({ok:true,decided_by:'u1'}),AV,'u1']]as const){const a=U.createOrgDialogsController({approvals:[{...AP0}],onAction:fn as any}).decideApproval('a1',AP).approvals![0]!;eq(a.state,s0);eq(a.decided_by,b0);}
let rlv!:(v:any)=>void,pN=0,rej=false,wr=0,foc='',h='',mS=0;const pC=U.createOrgDialogsController({approvals:[{...AP0}],onAction:()=>(pN++,new Promise((r)=>{rlv=r;}))});
pC.decideApproval('a1',AP);pC.decideApproval('a1',AP);eq(pN,1);deq(pC.getState().pendingActions,['approval:a1']);rlv({ok:false});await 0;eq(pC.getState().pendingActions?.length,0);m(pC.renderToHtml(),ER);
const acts:string[]=[],prev={textContent:''},delB={disabled:true,setAttribute:noop,removeAttribute:noop},ls:Record<string,(e:any)=>void>={},b1={focus:()=>{foc='first';}},b2={focus:()=>{foc='last';}},rA:Record<string,string>={},rS:U.OrgDialogsMountNode={inert:false,getAttribute:(k)=>rA[k]??null,setAttribute:(k,v)=>{rA[k]=v;},removeAttribute:(k)=>{delete rA[k];}},dN={showModal:()=>{mS++;},removeAttribute:noop,setAttribute:noop,addEventListener:noop,focus:noop},root:U.OrgDialogsMountNode={get innerHTML(){return h;},set innerHTML(v){h=v;wr++;},addEventListener:(t,fn)=>{ls[t]=fn as any;},querySelector:(s)=>(s.startsWith('[data-dialog=')?dN:s.includes('cli-preview')?prev:s.includes('confirm-delete-org')?delB:{focus:()=>{foc=s;}}),querySelectorAll:()=>[{hidden:true},b1,b2],parentElement:undefined};root.parentElement={children:[rS,root]};
const ctrl=U.mountOrgDialogsController(root,{createChannel:{...Y_OPS,step:1,private_channels_enabled:true,visibility:PV,channel_slug:SI,topic:'Init',guidelines:'G',available_principals:[],selected_principal_ids:[]},orgCrud:{mode:'delete',org_slug:Y,org_name:YV,actor_role:OW},channelMembers:{...Y_OPS,channel_id:'c1',channel_slug:SI,visibility:'workspace',actor_channel_role:OW,actor_org_role:OW,notify_pref:'all',members:[],invite_handle:'@alice',typed_delete_input:SI},logoUpload:{org_id:O1,org_slug:Y,org_name:YV,actor_role:OW},members:bsp(),workspaceMembers:{...Y_OPS,workspace_id:W1,actor_role:OW,workspace_members:[],org_candidates:[ROSTER[0]!,ROSTER[2]!]},approvals:[AP0],onAction:(cmd)=>{acts.push(cmd.kind);return rej?{ok:false,refusal:ref}:{ok:true,decided_by:U0,decided_at:NOW};}});
const st=ctrl.getState(),w0=wr,clk=(a:string,k='data-action')=>ls.click!({target:{getAttribute:(x:string)=>(x===k?a:null),parentElement:root}}),inp=(n:string,v:string)=>ls.input!({target:{name:n,value:v,getAttribute:()=>'RO'}}),chg=(n:string,v:string)=>ls.change!({target:{name:n,value:v}});
for(const s of'channel_slug:ops-war,org_display_name:RO,org_slug:ro,initial_workspace_name:Ops,channel_invite_handle:@bob,typed_delete_input:RO'.split(',')){const[n,v]=s.split(':');inp(n!,v!);}
chg('ws_candidate_id','u-guest');eq(wr,w0);m(prev.textContent,'cswarm channel create ops-war');eq(delB.disabled,false);
deq([st.orgCrud?.org_name,st.orgCrud?.org_slug,st.orgCrud?.initial_workspace_name,st.channelMembers?.invite_handle],['RO','ro','Ops','@bob']);
const E0='org_create,org_rename,org_create_workspace,org_move_workspace,channel_add_member,org_assign_workspace_member,channel_delete'.split(',');
`submit-create-org,submit-rename-org,submit-create-workspace,submit-move-workspace,submit-logo-upload,channel-invite-submit,ws-add-member,confirm-delete-channel,invite-person,${SM}`.split(',').forEach((a)=>clk(a));
deq(acts,E0);eq(st.lastCommand?.cli_command,`cswarm channel delete ${SI} --workspace yulan/ops --confirm ${SI}`);
inp(IT,PT);chg('invite_role',OW);clk('connect-grant-agent');eq(st.orgCrud?.invite_target,'');eq(st.orgCrud?.invite_role,MB);
clk('new-agent','data-creation-action');m(h,'org_create_agent','agent_runtime','agent_model','Create agent');
inp(IT,'ag-new');clk(SM);eq(st.lastCommand?.kind,'org_create_agent');
clk('invite-person');eq(st.orgCrud?.invite_target,PT);eq(st.orgCrud?.invite_role,OW);clk(SM);
ctrl.openDialog('org-logo-upload');ls.change!({target:{name:'org_logo_file',files:[{name:'ok.svg',type:SV,size:20,text:()=>C0}]}});
eq(st.logoUpload?.sanitized_svg,C0);m(h,L0);clk('submit-logo-upload');
deq(acts,[...E0,'org_create_agent','org_invite_member','org_upload_logo']);
ctrl.validateLogoUpload({mimeType:SV,sizeBytes:32,svgText:'<svg><script>1</script></svg>'},true);eq(st.logoUpload?.sanitized_svg,C0);m(h,L0);
eq(st.workspaceMembers?.workspace_members[0]?.principal_id,'u-guest');
const CN='channel_notify_pref';inp(CN,'mute');chg(CN,'mute');eq(acts.filter((x)=>x==='channel_set_notify_pref').length,1);eq(st.lastCommand?.payload.channel_id,'c1');eq(st.lastCommand?.payload.workspace_slug,'ops');
for(const[r,e]of[[true,P],[false,AV]]as const){rej=r;ctrl.decideApproval('a1',AP);eq(st.approvals?.[0]?.state,e);}eq(st.refusals?.length,1);
ctrl.requestRemoveFromOrg('workspace');m(h,'data-pending-removal-scope="workspace"','inert');ctrl.confirmRemoveFromOrg();
eq(st.members!.members[1]!.workspace_grants.length,0);eq(st.members!.members[1]!.active_seat_id,null);
ctrl.selectMember(U0);eq(st.members?.mobileView,'detail');ctrl.backToMemberList();eq(st.members?.mobileView,'list');m(foc,'member-row[data-member-id="u-owner"]');
mS=0;ctrl.openDialog('create-channel');eq(mS,1);eq(rS.inert,true);eq(rA['aria-hidden'],'true');m(h,'class="org-dialogs-bg" inert');foc='';ctrl.setChannelStep(2);eq(foc,'first');
ls.keydown!({key:'Tab',shiftKey:false,target:b2,preventDefault:noop});eq(foc,'first');
ls.keydown!({key:'Escape'});eq(st.activeDialog,null);eq(rS.inert,false);eq(rA['aria-hidden'],undefined);
clk('message-member');eq(st.lastCommand?.kind,'signal_dm_open');deq(st.lastCommand?.payload,{org_id:O1,org_slug:Y,workspace_id:W1,workspace_slug:'ops',principal_kind:'user',principal_id:U0,handle:'@tom'});m(h,'data-active-message-member="u-owner"');
const mc=(p?:Partial<U.OrgMembersScreenProps>)=>{const q:any[]=[],c=U.createOrgDialogsController({members:{...bsp(),...p},onAction:(x)=>(q.push(x.payload),{ok:true})});return[c,q]as const;},[c1,q1]=mc(),[c2,q2]=mc({org_id:O2,org_slug:H,org_name:H,current_workspace_id:'w2',current_workspace_slug:'h'}),bP=(o:string,s:string,x={})=>({org_id:o,org_slug:s,principal_kind:'agent',principal_id:A1,...x});
c1.changeMemberRole(A1,MB);c2.changeMemberRole(A1,OW);c1.addWorkspaceGrant(A1,W2);c1.revokeWorkspaceGrant(A1,W1);c1.messageMember(A1);c2.requestRemoveFromOrg();c2.confirmRemoveFromOrg();
c2.openDialog('x');eq(c2.getState().activeDialog,null);c1.openDialog('create-workspace');m(c1.renderToHtml(),'data-dialog="create-workspace"');
deq(q1,[bP(O1,Y,{role:MB}),bP(O1,Y,{workspace_id:W2,workspace_slug:PR,role:MB}),bP(O1,Y,{workspace_id:W1,workspace_slug:'ops'}),bP(O1,Y,{workspace_id:W2,workspace_slug:PR,handle:'@argon'})]);
deq(q2,[bP(O2,H,{role:OW}),bP(O2,H,{scope:'organization',workspace_id:'w2',workspace_slug:'h'})]);
});
test('Slice 5 token budget',()=>{
const d='site/src/components/app/live-dashboard/org-dialogs',css=fs.readFileSync(`${d}/org-dialogs.css`,'utf8'),rf=(f:string)=>fs.readFileSync(f,'utf8');
for(const f of fs.readdirSync(d).filter((x)=>/\.(ts|css|html)$/.test(x)).map((x)=>`${d}/${x}`).concat('tests/org-channels/slice5-ui-dialogs.test.ts'))ok(rf(f).length<=18e3,f);
m(css,':not(:modal)',':modal',...('canvas:#f5f5f2,surface:#ffffff,subtle:#f5f5f2,selected:#eeefea,ink:#282720,secondary:#655e53,muted:#716b60,line:#e9e7e2,control:#7e887c,accent:#697344,focus:#586339,sidebar:390px'.split(',').map((t)=>'--cs-'+t.replace(':',': '))));
});
