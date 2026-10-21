import * as A from './approval-remedy-cards.js';
export type {OrgDialogsActionResult,OrgDialogsCommand,OrgDialogsControllerState,OrgDialogsMountNode} from './approval-remedy-cards.js';
type N=A.OrgDialogsMountNode|null;type S=A.OrgDialogsControllerState;
const FOCUS_SEL='dialog[open] :is(button,input,select,textarea):not([disabled])',CH_KEYS:Record<string,string>={channel_topic:'topic',channel_guidelines:'guidelines',channel_icon:'channel_icon',channel_visibility:'visibility'},IN_MAP:Record<string,[keyof S,string]>={org_display_name:['orgCrud','org_name'],initial_workspace_name:['orgCrud','initial_workspace_name'],workspace_name:['createWorkspace','workspace_name'],workspace_slug:['createWorkspace','workspace_slug'],move_ws_target_org:['moveWorkspace','selected_target_org_id'],transfer_members:['moveWorkspace','transfer_members'],ws_candidate_id:['workspaceMembers','selected_candidate_id'],channel_invite_handle:['channelMembers','invite_handle'],invite_workspace:['orgCrud','invite_workspace'],agent_specialty:['orgCrud','agent_specialty']},ga=(x:N,k:string)=>x?.getAttribute?.(k)??null,setA=(el:N,k:'disabled'|'hidden',on:boolean)=>{if(el){el[k]=on;if(on)el.setAttribute?.(k,'');else el.removeAttribute?.(k);}};
export function createOrgDialogsController(init:S){
  const s=A.initOrgDialogsState(init);
  let rootEl:N=null,trigEl:N=null,trigSel:string|null=null,lastFoc:string|null=null,pendN:string|null=null,pendR:string|null=null;
  const docEl=()=>((globalThis as{document?:{activeElement?:N}}).document?.activeElement??null);
  const selOf=(t?:N):string|null=>{if(!t)return null;const id=ga(t,'id'),n=t.name??ga(t,'name'),v=t.value,a=ga(t,'data-action'),m=ga(t,'data-member-id'),c=ga(t,'data-creation-action');return a&&m?`[data-action="${a}"][data-member-id="${m}"]`:id?`#${id}`:n&&v&&/^(channel_notify_pref|transfer_members|channel_visibility|channel_member_id)$/.test(n)?`[name="${n}"][value="${v}"]`:n?`[name="${n}"]`:a?`[data-action="${a}"]`:c?`[data-creation-action="${c}"]`:null;};
  const html=()=>A.renderOrgDialogsHtml(s),q=(sel:string)=>rootEl?.querySelector?.(sel)??null;
  const up=()=>{const fSel=lastFoc??selOf(docEl());lastFoc=null;if(rootEl){rootEl.innerHTML=html();if(fSel)q(fSel)?.focus?.();}return s;};
  const sDis=(act:string,d:boolean)=>setA(q(`[data-action="${act}"]`),'disabled',d);
  const svTr=(t?:N)=>{const el=t??docEl();trigEl=el;trigSel=selOf(el);},rstF=()=>{((trigSel&&q(trigSel))??trigEl)?.focus?.();};
  const isVis=(el?:N):boolean=>{if(!el||el.disabled||ga(el,'disabled')!=null)return false;for(let c:N|undefined=el;c&&c!==rootEl;c=c.parentElement)if(c.hidden||ga(c,'hidden')!=null||ga(c,'inert')!=null)return false;return true;};
  const fDlg=(id?:string)=>{const v=rootEl?.querySelectorAll?[...rootEl.querySelectorAll(FOCUS_SEL)].filter(isVis):[];if(v[0])return void v[0].focus?.();if(id)q(`[data-dialog="${id}"] :is(button,input,select,textarea):not([disabled])`)?.focus?.();};
  const isObj=(r:unknown):r is A.OrgDialogsActionResult=>Boolean(r&&typeof r==='object'&&typeof(r as Promise<unknown>).then!=='function');
  const tx=(kind:string,cli_command:string,payload:Record<string,unknown>,onAck?:(res:A.OrgDialogsActionResult)=>void,mcp_tool=kind)=>{
    s.lastCommand={kind,mcp_tool,cli_command,payload};if(typeof s.onAction!=='function')return{ok:false as const,res:undefined};
    const raw=s.onAction(s.lastCommand),fin=(r:unknown)=>{pendN=pendR=null;if(isObj(r)&&r.ok===true){onAck?.(r);up();return{ok:true as const,res:r};}if(isObj(r)&&r.ok===false&&r.refusal){s.refusals=[...(s.refusals??[]),r.refusal];up();}return{ok:false as const,res:isObj(r)?r:undefined};};
    if(raw&&typeof(raw as Promise<unknown>).then==='function'){void(raw as Promise<unknown>).then(fin,()=>{pendN=pendR=null;});return{ok:false as const,res:undefined};}
    return fin(raw);
  };
  const findM=(id:string)=>s.members?.members.find((x)=>x.principal_id===id);
  const rmWs=(m:A.OrgRosterMemberItem,wid:string,ws?:string)=>{const g=m.workspace_grants.find((x)=>x.workspace_id===wid||x.workspace_slug===ws);if((g?.active_seat_id&&m.active_seat_id===g.active_seat_id)||(ws&&m.active_seat_workspace_slug===ws))m.active_seat_id=m.active_seat_workspace_slug=null;m.workspace_grants=m.workspace_grants.filter((x)=>x.workspace_id!==wid&&x.workspace_slug!==ws);};
  const ctrl={
    getState:()=>s,renderToHtml:html,
    openDialog(id:string,t?:N){svTr(t);if(s.members?.pending_removal)s.members.pending_removal=null;s.activeDialog=id;lastFoc=null;up();fDlg(id);return s;},
    closeDialog(id?:string|null){if(s.members?.pending_removal&&(!id||id==='confirm-remove-org-member'))s.members.pending_removal=null;s.activeDialog=null;lastFoc=null;up();rstF();return s;},
    selectMember(id:string){if(s.members)Object.assign(s.members,{selected_principal_id:id,pending_removal:null,mobileView:'detail',mobile_view:'detail'});return up();},
    backToMemberList(){if(s.members)Object.assign(s.members,{mobileView:'list',mobile_view:'list'});lastFoc=null;up();if(s.members?.selected_principal_id)q(`.member-row[data-member-id="${s.members.selected_principal_id}"]`)?.focus?.();return s;},
    setFilter(f:A.OrgRosterFilter){if(s.members)s.members.active_filter=f;return up();},
    setDetailTab(tab:'profile'|'skills'){if(s.members)s.members.active_detail_tab=tab;return up();},
    toggleCreationMenu(){if(s.members)s.members.creation_menu_open=!s.members.creation_menu_open;return up();},
    changeMemberRole(id:string,role:A.OrgRole){const m=findM(id);if(!s.members||!m||!A.canChangeOrgRole(s.members.actor_role,m.role,role))return s;lastFoc=`[data-action="change-org-role"][data-member-id="${id}"]`;const c=A.buildOrgMemberParityCommands(s.members.org_slug,s.members.current_workspace_slug,{...m,role});return tx('org_set_member_role',c.cli_member_role,{principal_id:id,role},()=>{m.role=role;},c.mcp_member_role),s;},
    addWorkspaceGrant(id:string,wsId?:string){const m=findM(id),w=s.members?.available_workspaces.find((x)=>(wsId?x.workspace_id===wsId:!m?.workspace_grants.some((g)=>g.workspace_id===x.workspace_id)));if(!s.members||!m||!w)return s;const c=A.buildOrgMemberParityCommands(s.members.org_slug,w.slug,m);return tx('org_assign_workspace_member',c.cli_workspace_grant,{principal_id:id,workspace_id:w.workspace_id},()=>{m.workspace_grants=[...m.workspace_grants,{workspace_id:w.workspace_id,workspace_slug:w.slug,workspace_name:w.name,role:m.role}];},c.mcp_workspace_grant),s;},
    revokeWorkspaceGrant(id:string,wsId:string){const m=findM(id),g=m?.workspace_grants.find((x)=>x.workspace_id===wsId);if(!s.members||!m||!g)return s;const c=A.buildOrgMemberParityCommands(s.members.org_slug,g.workspace_slug,m);return tx('org_remove_workspace_member',c.cli_workspace_revoke,{principal_id:id,workspace_id:wsId},()=>rmWs(m,wsId),c.mcp_workspace_revoke),s;},
    requestRemoveFromOrg(scope:'workspace'|'organization'='organization',t?:N){svTr(t);s.activeDialog=null;if(s.members)s.members.pending_removal={principal_id:s.members.selected_principal_id??s.members.members[0]?.principal_id??'',scope};lastFoc=null;up();fDlg('confirm-remove-org-member');return s;},
    cancelRemoveFromOrg(){if(s.members)s.members.pending_removal=null;lastFoc=null;up();rstF();return s;},
    confirmRemoveFromOrg(){const rem=s.members?.pending_removal,m=findM(rem?.principal_id??'');if(!s.members||!rem||!m)return s;const c=A.buildOrgMemberParityCommands(s.members.org_slug,s.members.current_workspace_slug,m),isO=rem.scope==='organization';return tx(isO?'org_remove_member':'org_remove_workspace_member',isO?c.cli_org_remove:c.cli_workspace_revoke,{principal_id:m.principal_id,scope:rem.scope,workspace_id:s.members.current_workspace_id},()=>{if(!s.members)return;if(isO){const nx=s.members.members.filter((x)=>x.principal_id!==m.principal_id);Object.assign(s.members,{members:nx,selected_principal_id:nx[0]?.principal_id??null,pending_removal:null});}else{rmWs(m,s.members.current_workspace_id,s.members.current_workspace_slug);s.members.pending_removal=null;}},isO?c.mcp_org_remove:c.mcp_workspace_revoke),s;},
    setChannelStep(step:1|2|3){if(s.createChannel)s.createChannel.step=step;lastFoc=null;up();fDlg('create-channel');return s;},
    updateChannelDraft(p:Partial<A.CreateChannelModalProps>,inP=false){if(!s.createChannel)return s;Object.assign(s.createChannel,p);if(inP&&rootEl?.querySelector){const c=q('[data-channel-cli-preview]');if(c)c.textContent=A.chCliPreview(s.createChannel);return s;}return up();},
    setOrgDeleteInput(v:string,inP=false){if(!s.orgCrud)return s;s.orgCrud.typed_delete_input=v;return inP&&rootEl?.querySelector?(sDis('confirm-delete-org',s.orgCrud.actor_role!=='owner'||!A.isTypedDeleteMatch(s.orgCrud.org_name,v)),s):up();},
    setChannelDeleteInput(v:string,inP=false){if(!s.channelMembers)return s;s.channelMembers.typed_delete_input=v;return inP&&rootEl?.querySelector?(sDis('confirm-delete-channel',!A.isTypedDeleteMatch(s.channelMembers.channel_slug,v)),s):up();},
    validateLogoUpload(input:{mimeType:string;sizeBytes:number;svgText?:string;bytes?:Uint8Array|null;previewUrl?:string|null},inP=false){const res=A.validateOrgLogoUpload({actorRole:s.logoUpload?.actor_role??s.orgCrud?.actor_role??s.members?.actor_role??'owner',...input}),err=res.ok?null:(res.error??'Invalid logo');if(s.logoUpload){s.logoUpload.upload_error=err;if(res.ok){s.logoUpload.sanitized_svg=res.sanitizedSvg??null;s.logoUpload.preview_url=res.previewUrl??null;}}if(inP&&rootEl?.querySelector){const el=q('[data-logo-error]');if(el)el.textContent=err??'';setA(el,'hidden',!err);return sDis('submit-logo-upload',!res.ok),res;}return up(),res;},
    decideApproval(id:string,d:'approve'|'reject'){const c=(s.approvals??[]).find((a)=>a.approval_id===id);if(!c||c.state!=='pending')return s;return tx('org_confirm_action',A.buildApprovalCliCommand(id,d),{approval_id:id,decision:d},(res)=>{c.state=d==='approve'?'approved':'rejected';if(res.decided_by!==undefined)c.decided_by=res.decided_by;if(res.decided_at!==undefined)c.decided_at=res.decided_at;}),s;},
    mount(root:A.OrgDialogsMountNode){
      rootEl=root;up();if(typeof root.addEventListener!=='function')return ctrl;
      const find=(ev:{target?:N},a:string):N=>{for(let cur=ev.target??null;cur&&cur!==root;cur=cur.parentElement??null)if(ga(cur,a)!=null)return cur;return null;};
      const opIv=(t:N,mode:A.OrgCrudMode)=>{if(s.members)s.members.creation_menu_open=false;const oc=s.orgCrud??{org_id:s.members?.org_id??'org-1',org_slug:s.members?.org_slug??'org',org_name:s.members?.org_name??'Org',actor_role:s.members?.actor_role??'owner'},isP=mode==='invite-person';s.orgCrud={...oc,mode,invite_target:isP?(oc.person_invite_target??''):(oc.agent_invite_target??''),invite_role:isP?(oc.person_invite_role??'member'):(oc.agent_invite_role??'member'),invite_workspace:oc.invite_workspace??s.members?.current_workspace_slug??'ops'};ctrl.openDialog('org-crud',t);};
      root.addEventListener('click',(ev)=>{
        const cp=find(ev,'data-copy-cmd');if(cp){s.lastCopiedCommand=ga(cp,'data-copy-cmd');if(s.lastCopiedCommand)(globalThis as{navigator?:{clipboard?:{writeText?(t:string):unknown}}}).navigator?.clipboard?.writeText?.(s.lastCopiedCommand);return;}
        const tabEl=find(ev,'data-detail-tab');if(tabEl)return void ctrl.setDetailTab(ga(tabEl,'data-detail-tab') as 'profile'|'skills');
        const ca=find(ev,'data-creation-action');if(ca){const cid=ga(ca,'data-creation-action');return void opIv(ca,cid==='new-agent'?'new-agent':cid==='connect-agent'?'connect-agent':'invite-person');}
        const ae=find(ev,'data-action'),a=ga(ae,'data-action')??'',mid=ga(ae,'data-member-id')??s.members?.selected_principal_id??'';
        if(a==='toggle-creation-menu')ctrl.toggleCreationMenu();
        else if(a==='invite-person'||a==='connect-grant-agent')opIv(ae,a==='invite-person'?'invite-person':'connect-agent');
        else if(a==='open-org-settings')opIv(ae,'rename');
        else if(a==='open-workspace-settings')ctrl.openDialog('create-workspace',ae);
        else if(a==='member-list-back')ctrl.backToMemberList();
        else if(a==='close-dialog')ctrl.closeDialog(ga(ae,'data-dialog-id')??ga(find(ev,'data-dialog'),'data-dialog')??undefined);
        else if(a==='open-remove-org'||a==='remove-from-org')ctrl.requestRemoveFromOrg('organization',ae);
        else if(a==='open-remove-workspace')ctrl.requestRemoveFromOrg('workspace',ae);
        else if(a.startsWith('cancel-remove'))ctrl.cancelRemoveFromOrg();
        else if(a.startsWith('confirm-remove'))ctrl.confirmRemoveFromOrg();
        else if(a==='add-workspace-grant')ctrl.addWorkspaceGrant(mid,q(`[data-add-workspace-for="${mid}"]`)?.value);
        else if(a==='revoke-workspace-grant')ctrl.revokeWorkspaceGrant(mid,ga(ae,'data-workspace-id')??'');
        else if(a==='ws-remove-member'&&s.workspaceMembers){const wm=s.workspaceMembers;tx('org_remove_workspace_member',`cswarm org members revoke ${mid} --org ${wm.org_slug} --workspace ${wm.org_slug}/${wm.workspace_slug}`,{principal_id:mid,workspace_id:wm.workspace_id,workspace_slug:wm.workspace_slug,org_slug:wm.org_slug},()=>{wm.workspace_members=wm.workspace_members.filter((x)=>x.principal_id!==mid);});}
        else if((a==='next-channel-step'||a==='prev-channel-step')&&s.createChannel)ctrl.setChannelStep(Math.max(1,Math.min(3,s.createChannel.step+(a==='next-channel-step'?1:-1))) as 1|2|3);
        else if(A.dispatchModalSubmit(a,s,q,tx,ctrl.validateLogoUpload))return;
        else if(a==='approve-request'||a==='reject-request')ctrl.decideApproval(ga(ae,'data-approval-id')??'',a==='approve-request'?'approve':'reject');
        else{const st=find(ev,'data-step-indicator'),fl=find(ev,'data-roster-filter'),me=find(ev,'data-member-id');if(st)ctrl.setChannelStep(Number(ga(st,'data-step-indicator')) as 1|2|3);else if(fl)ctrl.setFilter(ga(fl,'data-roster-filter') as A.OrgRosterFilter);else if(me&&!a)ctrl.selectMember(ga(me,'data-member-id')??'');}
      });
      const onIn=(ev:{target?:N})=>{
        const t=ev.target,v=t?.value??'',n=t?.name??(ga(t,'data-action')==='change-org-role'?'member_org_role':''),mIn=IN_MAP[n];lastFoc=selOf(t);
        if(n==='channel_slug')ctrl.updateChannelDraft({channel_slug:v,channel_name:v},true);
        else if(CH_KEYS[n])ctrl.updateChannelDraft({[CH_KEYS[n]!]:v as A.ChannelIcon&A.ChannelVisibility},true);
        else if(n==='channel_member_id'&&s.createChannel){const cur=s.createChannel.selected_principal_ids,want=t?.checked!==undefined?Boolean(t.checked):!cur.includes(v);ctrl.updateChannelDraft({selected_principal_ids:want?(cur.includes(v)?cur:[...cur,v]):cur.filter((x)=>x!==v)},true);}
        else if((n==='invite_target'||n==='invite_role')&&s.orgCrud){const isP=s.orgCrud.mode==='invite-person';if(n==='invite_target'){s.orgCrud.invite_target=v;if(isP)s.orgCrud.person_invite_target=v;else s.orgCrud.agent_invite_target=v;}else{s.orgCrud.invite_role=v as A.OrgRole;if(isP)s.orgCrud.person_invite_role=v as A.OrgRole;else s.orgCrud.agent_invite_role=v as A.OrgRole;}}
        else if(mIn&&s[mIn[0]]){(s[mIn[0]] as Record<string,unknown>)[mIn[1]]=v;if(mIn[0]==='moveWorkspace'&&s.moveWorkspace){const mw=s.moveWorkspace,to=mw.target_orgs.find((o)=>o.org_id===mw.selected_target_org_id)??mw.target_orgs[0],ok=Boolean(to?.actor_is_owner),mc=q('[data-move-warning] code'),me=q('[data-move-error]');if(mc)mc.textContent=`cswarm workspace move ${mw.source_org_slug}/${mw.workspace_slug} --to-org ${to?.slug??'target-org'} --transfer-members ${mw.transfer_members}`;if(me)me.textContent=ok?'':'ORG_MOVE_REQUIRES_DUAL_OWNER';setA(me,'hidden',ok);sDis('submit-move-workspace',!ok);}}
        else if(n==='org_slug'){if(s.orgCrud)s.orgCrud.org_slug=v;if(s.createWorkspace)s.createWorkspace.org_slug=v;}
        else if(n==='org_logo_file'){const f=t?.files?.[0]??(v?{name:v,type:'image/png',size:512}:null);s.selectedLogoFile=f;if(f)A.readLogoFile(f,(svgText,bytes)=>{if(s.selectedLogoFile===f)ctrl.validateLogoUpload({mimeType:f.type||'image/png',sizeBytes:f.size??(svgText?.length||bytes?.byteLength||512),svgText,bytes},true);});}
        else if(n==='channel_notify_pref'&&s.channelMembers){if(v===(pendN??s.channelMembers.notify_pref))return;pendN=v;tx('channel_set_notify_pref',`cswarm channel notify ${v}`,{notify_pref:v},()=>{if(s.channelMembers)s.channelMembers.notify_pref=v as A.NotifyPref;});}
        else if(n==='member_org_role'){const mid=ga(t,'data-member-id')??s.members?.selected_principal_id??'',rk=`${mid}:${v}`,cur=findM(mid);if(!cur||cur.role===v||pendR===rk)return;pendR=rk;ctrl.changeMemberRole(mid,v as A.OrgRole);}
        else if(n==='typed_delete_input'){const trg=ga(t,'data-delete-confirm-target');if(s.orgCrud&&trg===s.orgCrud.org_name)ctrl.setOrgDeleteInput(v,true);else if(s.channelMembers&&trg===s.channelMembers.channel_slug)ctrl.setChannelDeleteInput(v,true);}
      };
      root.addEventListener('input',onIn);root.addEventListener('change',onIn);
      root.addEventListener('keydown',(ev)=>{if(ev.key==='Escape'){if(s.members?.pending_removal)ctrl.cancelRemoveFromOrg();else if(s.members?.creation_menu_open)ctrl.toggleCreationMenu();else if(s.activeDialog)ctrl.closeDialog(s.activeDialog);}else if(ev.key==='Tab'&&(s.activeDialog||s.members?.pending_removal)&&root.querySelectorAll){const items=[...root.querySelectorAll(FOCUS_SEL)].filter(isVis);if(items.length){const first=items[0]!,last=items[items.length-1]!;if(ev.shiftKey&&ev.target===first){ev.preventDefault?.();last.focus?.();}else if(!ev.shiftKey&&ev.target===last){ev.preventDefault?.();first.focus?.();}}}});
      return ctrl;
    }
  };
  return ctrl;
}
export const mountOrgDialogsController=(root:A.OrgDialogsMountNode,init:S)=>createOrgDialogsController(init).mount(root);
