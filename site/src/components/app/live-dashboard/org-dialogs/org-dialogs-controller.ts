import * as A from './approval-remedy-cards.js';
type St=string;type SN=St|null;type B=boolean;type N=A.OrgDialogsMountNode|null;type S=A.OrgDialogsControllerState;
const gG=globalThis as{document?:{activeElement?:N};navigator?:{clipboard?:{writeText?(t:St):unknown}}},FS='dialog[open] :is(button,input,select,textarea):not([disabled])',IM=Object.fromEntries([['orgCrud','org_display_name:org_name,initial_workspace_name,invite_workspace,agent_specialty,agent_runtime,agent_model'],['createWorkspace','workspace_name,workspace_slug'],['moveWorkspace','move_ws_target_org:selected_target_org_id,transfer_members'],['workspaceMembers','ws_candidate_id:selected_candidate_id'],['channelMembers','channel_invite_handle:invite_handle']].flatMap(([g,ks])=>ks.split(',').map((x)=>{const[k,p]=x.split(':');return[k,[g,p||k]];}))) as Record<St,[keyof S,St]>,ga=(x:N,k:St)=>x?.getAttribute?.(k)??null,setA=(el:N,k:'disabled'|'hidden'|'inert',on:B)=>{if(el){el[k]=on;on?el.setAttribute?.(k,''):el.removeAttribute?.(k);}},mv=(v:'list'|'detail')=>({mobileView:v,mobile_view:v});
export function createOrgDialogsController(init:S){
const s=A.initOrgDialogsState(init),m0=s.members,inFl=new Set<St>(),docEl=()=>gG.document?.activeElement??null;
let rt:N=null,trE:N=null,trS:SN=null,lF:SN=null,pendN:SN=null,pendR:SN=null,mO=false;
const selOf=(t?:N):SN=>{if(!t)return null;const id=ga(t,'id'),n=t.name??ga(t,'name'),v=t.value,a=ga(t,'data-action'),m=ga(t,'data-member-id'),c=ga(t,'data-creation-action');return a?`[data-action="${a}"]${m?`[data-member-id="${m}"]`:''}`:id?`#${id}`:n?`[name="${n}"]${v&&/^(transfer_members|channel_(notify_pref|visibility|member_id))$/.test(n)?`[value="${v}"]`:''}`:c?`[data-creation-action="${c}"]`:null;};
const html=()=>A.renderOrgDialogsHtml(s),q=(sel:St)=>rt?.querySelector?.(sel)??null,qP=(p:B)=>Boolean(p&&rt?.querySelector);
const syncM=()=>{const id=m0?.pending_removal?'confirm-remove-org-member':s.activeDialog,d=id?q(`[data-dialog="${id}"]`):null,on=Boolean(d&&(mO||m0||!ga(rt?.parentElement,'class')?.includes('dialog-grid')));for(let c=rt;c?.parentElement;c=c.parentElement)for(const b of c.parentElement.children??[])if(b!==c&&(on?!b.inert&&ga(b,'inert')==null||ga(b,'data-m-in'):ga(b,'data-m-in'))){setA(b,'inert',on);on?(b.setAttribute?.('data-m-in','1'),b.setAttribute?.('aria-hidden','true')):(b.removeAttribute?.('aria-hidden'),b.removeAttribute?.('data-m-in'));}if(d?.showModal){try{d.removeAttribute?.('open');d.showModal();}catch{d.setAttribute?.('open','');}d.addEventListener?.('cancel',(e)=>{e.preventDefault?.();m0?.pending_removal?ctrl.cancelRemoveFromOrg():ctrl.closeDialog(s.activeDialog);});}};
const up=()=>{const f=lF??selOf(docEl());lF=null;if(rt){rt.innerHTML=html();syncM();if(f)q(f)?.focus?.();}return s;};
const sDis=(act:St,d:B)=>setA(q(`[data-action="${act}"]`),'disabled',d);
const svTr=(t?:N)=>{trE=t??docEl();trS=selOf(trE);},rstF=()=>{((trS&&q(trS))??trE)?.focus?.();};
const vis=(el?:N):B=>{if(!el||el.disabled||ga(el,'disabled')!=null)return false;for(let c:N|undefined=el;c&&c!==rt;c=c.parentElement)if(c.hidden||ga(c,'hidden')!=null||ga(c,'inert')!=null)return false;return true;};
const fDlg=(id?:St)=>{const v=rt?.querySelectorAll?[...rt.querySelectorAll(FS)].filter(vis):[];if(v[0])return void v[0].focus?.();if(id)q(`[data-dialog="${id}"] ${FS.slice(13)}`)?.focus?.();};
const isObj=(r:unknown):r is A.OrgDialogsActionResult=>Boolean(r&&typeof r==='object'&&!('then' in r));
const tx=(kind:St,cli_command:St,payload:Record<St,unknown>,onAck?:(res:A.OrgDialogsActionResult)=>void,mcp_tool=kind)=>{
const kId=kind==='org_confirm_action'?`approval:${payload.approval_id}`:kind;if(inFl.has(kId))return s;
s.lastCommand={kind,mcp_tool,cli_command,payload};if(typeof s.onAction!=='function')return s;
const fin=(r:unknown,err?:unknown)=>{inFl.delete(kId);s.pendingActions=[...inFl];pendN=pendR=null;if(!err&&isObj(r)&&r.ok===true){s.actionError=null;onAck?.(r);up();}else if(err||(isObj(r)&&r.ok===false)){if(isObj(r)&&r.refusal)s.refusals=[...(s.refusals??[]),r.refusal];s.actionError=err instanceof Error?err.message:(isObj(r)&&r.refusal?.code)||'Action failed — please retry.';up();}};
let raw:unknown;try{raw=s.onAction(s.lastCommand);}catch(e){fin(undefined,e);return s;}
if(raw&&typeof(raw as{then?:unknown}).then==='function'){inFl.add(kId);s.pendingActions=[...inFl];s.actionError=null;up();void(raw as Promise<unknown>).then(fin,(e)=>fin(undefined,e??new Error('Action failed')));}else fin(raw);
return s;
};
const findM=(id:St)=>m0?.members.find((x)=>x.principal_id===id),bPar=(w:St,m:A.OrgRosterMemberItem)=>A.buildOrgMemberParityCommands(m0!.org_slug,w,m),mp=(m:A.OrgRosterMemberItem,ex?:Record<St,unknown>)=>({org_id:m0!.org_id,org_slug:m0!.org_slug,principal_kind:m.principal_kind,principal_id:m.principal_id,...ex});
const rmWs=(m:A.OrgRosterMemberItem,wid:St,ws?:St)=>{const g=m.workspace_grants.find((x)=>x.workspace_id===wid||x.workspace_slug===ws);if((g?.active_seat_id&&m.active_seat_id===g.active_seat_id)||(ws&&m.active_seat_workspace_slug===ws))m.active_seat_id=m.active_seat_workspace_slug=null;m.workspace_grants=m.workspace_grants.filter((x)=>x.workspace_id!==wid&&x.workspace_slug!==ws);};
const ctrl={
getState:()=>s,renderToHtml:html,
openDialog(id:St,t?:N){if(id==='create-workspace'&&m0)s.createWorkspace??={org_id:m0.org_id,org_slug:m0.org_slug,org_name:m0.org_name,workspace_slug:m0.current_workspace_slug,workspace_name:m0.current_workspace_name,actor_role:m0.actor_role};if(!A.DLGS.some(([k,d])=>d===id&&s[k]))return s;svTr(t);mO=true;if(m0)m0.pending_removal=null;s.activeDialog=id;lF=null;up();fDlg(id);return s;},
closeDialog(id?:SN){mO=false;if(m0&&(!id||id==='confirm-remove-org-member'))m0.pending_removal=null;s.activeDialog=null;lF=null;up();rstF();return s;},
selectMember(id:St){if(m0)Object.assign(m0,{selected_principal_id:id,pending_removal:null,...mv('detail')});return up();},
backToMemberList(){if(m0)Object.assign(m0,mv('list'));lF=null;up();if(m0?.selected_principal_id)q(`.member-row[data-member-id="${m0.selected_principal_id}"]`)?.focus?.();return s;},
setFilter:(f:A.OrgRosterFilter)=>(m0&&(m0.active_filter=f),up()),
setDetailTab:(tab:'profile'|'skills')=>(m0&&(m0.active_detail_tab=tab),up()),
toggleCreationMenu:()=>(m0&&(m0.creation_menu_open=!m0.creation_menu_open),up()),
messageMember(id:St){const m=findM(id);if(!m0||!m)return s;const g=m.workspace_grants.find((x)=>x.workspace_id===m0.current_workspace_id||x.workspace_slug===m0.current_workspace_slug)??m.workspace_grants[0],wid=g?.workspace_id??m0.current_workspace_id,ws=g?.workspace_slug??m0.current_workspace_slug;return tx('signal_dm_open',`cswarm signal --org ${m0.org_slug} --workspace ${m0.org_slug}/${ws} --to ${id}`,mp(m,{workspace_id:wid,workspace_slug:ws,handle:m.handle}),()=>{m0.active_message_member_id=id;});},
changeMemberRole(id:St,role:A.OrgRole){const m=findM(id);if(!m0||!m||!A.canChangeOrgRole(m0.actor_role,m.role,role))return s;lF=`[data-action="change-org-role"][data-member-id="${id}"]`;const c=bPar(m0.current_workspace_slug,{...m,role});return tx('org_set_member_role',c.cli_member_role,mp(m,{role}),()=>{m.role=role;},c.mcp_member_role);},
addWorkspaceGrant(id:St,wsId?:St){const m=findM(id),w=m0?.available_workspaces.find((x)=>(wsId?x.workspace_id===wsId:!m?.workspace_grants.some((g)=>g.workspace_id===x.workspace_id)));if(!m0||!m||!w)return s;const c=bPar(w.slug,m);return tx('org_assign_workspace_member',c.cli_workspace_grant,mp(m,{workspace_id:w.workspace_id,workspace_slug:w.slug,role:m.role}),()=>{m.workspace_grants.push({workspace_id:w.workspace_id,workspace_slug:w.slug,workspace_name:w.name,role:m.role});},c.mcp_workspace_grant);},
revokeWorkspaceGrant(id:St,wsId:St){const m=findM(id),g=m?.workspace_grants.find((x)=>x.workspace_id===wsId);if(!m0||!m||!g)return s;const c=bPar(g.workspace_slug,m);return tx('org_remove_workspace_member',c.cli_workspace_revoke,mp(m,{workspace_id:wsId,workspace_slug:g.workspace_slug}),()=>rmWs(m,wsId),c.mcp_workspace_revoke);},
requestRemoveFromOrg(scope:'workspace'|'organization'='organization',t?:N){svTr(t);mO=true;s.activeDialog=null;if(m0)m0.pending_removal={principal_id:m0.selected_principal_id??m0.members[0]?.principal_id??'',scope};lF=null;up();fDlg('confirm-remove-org-member');return s;},
cancelRemoveFromOrg(){mO=false;if(m0)m0.pending_removal=null;lF=null;up();rstF();return s;},
confirmRemoveFromOrg(){const rem=m0?.pending_removal,m=findM(rem?.principal_id??'');if(!m0||!rem||!m)return s;const c=bPar(m0.current_workspace_slug,m),isO=rem.scope==='organization';return tx(isO?'org_remove_member':'org_remove_workspace_member',isO?c.cli_org_remove:c.cli_workspace_revoke,mp(m,{scope:rem.scope,workspace_id:m0.current_workspace_id,workspace_slug:m0.current_workspace_slug}),()=>{mO=false;m0.pending_removal=null;if(isO){m0.members=m0.members.filter((x)=>x.principal_id!==m.principal_id);m0.selected_principal_id=m0.members[0]?.principal_id??null;}else rmWs(m,m0.current_workspace_id,m0.current_workspace_slug);},isO?c.mcp_org_remove:c.mcp_workspace_revoke);},
setChannelStep(step:1|2|3){if(s.createChannel)s.createChannel.step=step;lF=null;up();fDlg('create-channel');return s;},
updateChannelDraft(p:Partial<A.CreateChannelModalProps>,inP=false){if(!s.createChannel)return s;Object.assign(s.createChannel,p);if(qP(inP)){const c=q('[data-channel-cli-preview]');if(c)c.textContent=A.chCliPreview(s.createChannel);return s;}return up();},
setOrgDeleteInput(v:St,inP=false){if(!s.orgCrud)return s;s.orgCrud.typed_delete_input=v;return qP(inP)?(sDis('confirm-delete-org',s.orgCrud.actor_role!=='owner'||!A.isTypedDeleteMatch(s.orgCrud.org_name,v)),s):up();},
setChannelDeleteInput(v:St,inP=false){if(!s.channelMembers)return s;s.channelMembers.typed_delete_input=v;return qP(inP)?(sDis('confirm-delete-channel',!A.isTypedDeleteMatch(s.channelMembers.channel_slug,v)),s):up();},
validateLogoUpload(input:{mimeType:St;sizeBytes:number;svgText?:St;bytes?:Uint8Array|null;previewUrl?:SN},inP=false){const lg=s.logoUpload,res=A.validateOrgLogoUpload({actorRole:lg?.actor_role??s.orgCrud?.actor_role??m0?.actor_role??'owner',...input}),err=res.ok?null:(res.error??'Invalid logo');if(lg){lg.upload_error=err;if(res.ok){lg.sanitized_svg=res.sanitizedSvg??null;lg.preview_url=res.previewUrl??null;}}if(res.ok||!qP(inP))up();else{const el=q('[data-logo-error]');if(el)el.textContent=err??'';setA(el,'hidden',!err);sDis('submit-logo-upload',!res.ok);}return res;},
decideApproval(id:St,d:'approve'|'reject'){const c=(s.approvals??[]).find((a)=>a.approval_id===id);if(!c||c.state!=='pending')return s;return tx('org_confirm_action',A.buildApprovalCliCommand(id,d),{approval_id:id,decision:d},(r)=>{c.state=d==='approve'?'approved':'rejected';if(r.decided_by!==undefined)c.decided_by=r.decided_by;if(r.decided_at!==undefined)c.decided_at=r.decided_at;});},
mount(root:A.OrgDialogsMountNode){
rt=root;up();if(typeof root.addEventListener!=='function')return ctrl;
const find=(ev:{target?:N},a:St):N=>{for(let cur=ev.target??null;cur&&cur!==root;cur=cur.parentElement??null)if(ga(cur,a)!=null)return cur;return null;};
const opIv=(t:N,mode:A.OrgCrudMode)=>{if(m0)m0.creation_menu_open=false;const oc=s.orgCrud??{org_id:m0?.org_id??'org-1',org_slug:m0?.org_slug??'org',org_name:m0?.org_name??'Org',actor_role:m0?.actor_role??'owner'},isP=mode==='invite-person';s.orgCrud={...oc,mode,invite_target:(isP?oc.person_invite_target:oc.agent_invite_target)??'',invite_role:(isP?oc.person_invite_role:oc.agent_invite_role)??'member',invite_workspace:oc.invite_workspace??m0?.current_workspace_slug??'ops'};ctrl.openDialog('org-crud',t);};
root.addEventListener('click',(ev)=>{
const cp=find(ev,'data-copy-cmd');if(cp){s.lastCopiedCommand=ga(cp,'data-copy-cmd');if(s.lastCopiedCommand)gG.navigator?.clipboard?.writeText?.(s.lastCopiedCommand);return;}
const tabEl=find(ev,'data-detail-tab');if(tabEl)return void ctrl.setDetailTab(ga(tabEl,'data-detail-tab') as 'profile'|'skills');
const ca=find(ev,'data-creation-action');if(ca){const cid=ga(ca,'data-creation-action');return void opIv(ca,cid==='new-agent'?'new-agent':cid==='connect-agent'?'connect-agent':'invite-person');}
const ae=find(ev,'data-action'),a=ga(ae,'data-action')??'',mid=ga(ae,'data-member-id')??m0?.selected_principal_id??'';
if(a==='toggle-creation-menu')ctrl.toggleCreationMenu();
else if(a==='invite-person'||a==='connect-grant-agent'||a==='open-org-settings')opIv(ae,a==='open-org-settings'?'rename':a==='invite-person'?a:'connect-agent');
else if(a==='open-workspace-settings')ctrl.openDialog('create-workspace',ae);
else if(a==='member-list-back')ctrl.backToMemberList();
else if(a==='message-member')ctrl.messageMember(mid);
else if(a==='close-dialog')ctrl.closeDialog(ga(ae,'data-dialog-id')??ga(find(ev,'data-dialog'),'data-dialog'));
else if(a==='open-remove-org'||a==='remove-from-org'||a==='open-remove-workspace')ctrl.requestRemoveFromOrg(a.endsWith('workspace')?'workspace':'organization',ae);
else if(a.startsWith('cancel-remove'))ctrl.cancelRemoveFromOrg();
else if(a.startsWith('confirm-remove'))ctrl.confirmRemoveFromOrg();
else if(a==='add-workspace-grant')ctrl.addWorkspaceGrant(mid,q(`[data-add-workspace-for="${mid}"]`)?.value);
else if(a==='revoke-workspace-grant')ctrl.revokeWorkspaceGrant(mid,ga(ae,'data-workspace-id')??'');
else if(a==='ws-remove-member'&&s.workspaceMembers){const wm=s.workspaceMembers,{org_slug,workspace_id,workspace_slug}=wm,pk=wm.workspace_members.find((x)=>x.principal_id===mid)?.principal_kind??(mid.startsWith('ag-')?'agent':'user');tx('org_remove_workspace_member',`cswarm org members revoke ${mid} --org ${org_slug} --workspace ${org_slug}/${workspace_slug} --kind ${pk}`,{org_slug,workspace_id,workspace_slug,principal_kind:pk,principal_id:mid},()=>{wm.workspace_members=wm.workspace_members.filter((x)=>x.principal_id!==mid);});}
else if((a==='next-channel-step'||a==='prev-channel-step')&&s.createChannel)ctrl.setChannelStep(Math.max(1,Math.min(3,s.createChannel.step+(a==='next-channel-step'?1:-1))) as 1|2|3);
else if(A.dispatchModalSubmit(a,s,q,tx,ctrl.validateLogoUpload))return;
else if(a==='approve-request'||a==='reject-request')ctrl.decideApproval(ga(ae,'data-approval-id')??'',a==='approve-request'?'approve':'reject');
else{const st=find(ev,'data-step-indicator'),fl=find(ev,'data-roster-filter'),me=find(ev,'data-member-id');if(st)ctrl.setChannelStep(Number(ga(st,'data-step-indicator')) as 1|2|3);else if(fl)ctrl.setFilter(ga(fl,'data-roster-filter') as A.OrgRosterFilter);else if(me&&!a)ctrl.selectMember(ga(me,'data-member-id')??'');}
});
const onIn=(ev:{target?:N})=>{
const t=ev.target,v=t?.value??'',n=t?.name??(ga(t,'data-action')==='change-org-role'?'member_org_role':''),mIn=IM[n];lF=selOf(t);
if(n==='channel_slug')ctrl.updateChannelDraft({channel_slug:v,channel_name:v},true);
else if(/^channel_(topic|guidelines|icon|visibility)$/.test(n))ctrl.updateChannelDraft({[n==='channel_icon'?n:n.slice(8)]:v},true);
else if(n==='channel_member_id'&&s.createChannel){const cur=s.createChannel.selected_principal_ids,want=t?.checked!==undefined?Boolean(t.checked):!cur.includes(v);ctrl.updateChannelDraft({selected_principal_ids:want?[...new Set([...cur,v])]:cur.filter((x)=>x!==v)},true);}
else if((n==='invite_target'||n==='invite_role')&&s.orgCrud){(s.orgCrud as Record<St,unknown>)[n]=(s.orgCrud as Record<St,unknown>)[`${s.orgCrud.mode==='invite-person'?'person':'agent'}_${n}`]=v;}
else if(mIn&&s[mIn[0]]){(s[mIn[0]] as Record<St,unknown>)[mIn[1]]=v;if(mIn[0]==='moveWorkspace'&&s.moveWorkspace){const mw=s.moveWorkspace,to=mw.target_orgs.find((o)=>o.org_id===mw.selected_target_org_id)??mw.target_orgs[0],ok=Boolean(to?.actor_is_owner),mc=q('[data-move-warning] code'),me=q('[data-move-error]');if(mc)mc.textContent=`cswarm workspace move ${mw.source_org_slug}/${mw.workspace_slug} --to-org ${to?.slug??'target-org'} --transfer-members ${mw.transfer_members}`;if(me)me.textContent=ok?'':'ORG_MOVE_REQUIRES_DUAL_OWNER';setA(me,'hidden',ok);sDis('submit-move-workspace',!ok);}}
else if(n==='org_slug'){if(s.orgCrud)s.orgCrud.org_slug=v;if(s.createWorkspace)s.createWorkspace.org_slug=v;}
else if(n==='org_logo_file'){const f=t?.files?.[0]??(v?{name:v,type:'image/png',size:512}:null);s.selectedLogoFile=f;if(f)A.readLogoFile(f,(svgText,bytes)=>{if(s.selectedLogoFile===f)ctrl.validateLogoUpload({mimeType:f.type||'image/png',sizeBytes:f.size??(svgText?.length||bytes?.byteLength||512),svgText,bytes},true);});}
else if(n==='channel_notify_pref'&&s.channelMembers){const cm=s.channelMembers,{org_slug,workspace_slug,channel_id,channel_slug}=cm,nk=`${channel_id}:${v}`;if(v===cm.notify_pref||pendN===nk)return;pendN=nk;tx('channel_set_notify_pref',`cswarm channel notify ${channel_slug} ${v} --workspace ${org_slug}/${workspace_slug}`,{org_slug,workspace_slug,channel_id,channel_slug,notify_pref:v},()=>{cm.notify_pref=v as A.NotifyPref;});}
else if(n==='member_org_role'){const mid=ga(t,'data-member-id')??m0?.selected_principal_id??'',rk=`${mid}:${v}`,cur=findM(mid);if(!cur||cur.role===v||pendR===rk)return;pendR=rk;ctrl.changeMemberRole(mid,v as A.OrgRole);}
else if(n==='typed_delete_input'){const trg=ga(t,'data-delete-confirm-target');if(s.orgCrud&&trg===s.orgCrud.org_name)ctrl.setOrgDeleteInput(v,true);else if(s.channelMembers&&trg===s.channelMembers.channel_slug)ctrl.setChannelDeleteInput(v,true);}
};
root.addEventListener('input',onIn);root.addEventListener('change',onIn);
root.addEventListener('keydown',(ev)=>{if(ev.key==='Escape'){m0?.pending_removal?ctrl.cancelRemoveFromOrg():m0?.creation_menu_open?ctrl.toggleCreationMenu():s.activeDialog&&ctrl.closeDialog(s.activeDialog);}else if(ev.key==='Tab'&&(s.activeDialog||m0?.pending_removal)&&root.querySelectorAll){const it=[...root.querySelectorAll(FS)].filter(vis),f0=it[0],l0=it.at(-1),nx=ev.shiftKey?ev.target===f0&&l0:ev.target===l0&&f0;if(nx){ev.preventDefault?.();nx.focus?.();}}});
return ctrl;
}
};
return ctrl;
}
export const mountOrgDialogsController=(root:A.OrgDialogsMountNode,init:S)=>createOrgDialogsController(init).mount(root);
