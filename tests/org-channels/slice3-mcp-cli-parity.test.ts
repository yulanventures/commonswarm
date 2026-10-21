import assert from 'node:assert/strict';
import test from 'node:test';
import{deflateSync}from 'node:zlib';
import{type CliCallerContext as Ctx,effCallerOrgRole as effRole,executeOrgChannelsCli as execCli,formatOrgChannelRefusal as fmtRef,parseOrgChannelsCliArgs as parseCli,resetDefaultOrgChannelCliState as resetCli}from '../../src/cloud/org-channels-cli.js';
import{ORG_CHANNEL_MCP_TOOLS as TOOLS,ORG_CHANNEL_TOOL_NAMES as NAMES,type OrgChannelSlice3State as St,enrichOrgChannelRefusal as enrich,executeMultiOrgWhoami as whoami,executeOrgChannelMcpTool as mcp,isOrgChannelToolName as isTool,resolveMcpOrgWorkspaceChannel as resSel,validateOrgChannelToolArguments as valArgs}from '../../supabase/functions/mcp/org-channels-tools.js';
import{buildOrgChannelRefusal as mkRef,type OrgRole,type PrincipalKind}from '../../src/protocol/org-channels-contract.js';
const eq=assert.equal,deq=assert.deepEqual,ok=assert.ok,th=assert.throws,NOW='2026-10-20T12:00:00Z';
const OY='o-y',OA='o-a',WC='w-yc',WO='w-yo',WA='w-ao',AG='ag-argon',CN='cn-a',WYC='yulan/core',Y='yulan';
const T='u-tom',AL='u-alice',B='u-bob',G='u-guest';
const R:Record<string,OrgRole>={ o:'owner',d:'admin',m:'member',g:'guest' },K=(k:string):PrincipalKind=>(k==='a'?'agent':'user');
const U=(principal_id:string,connection_id?:string):Ctx=>({ principal_kind:'user',principal_id,connection_id });
const A=(principal_id=AG,connection_id?:string,seat?:string):Ctx=>({ principal_kind:'agent',principal_id,connection_id,seat });
const uT=U(T,'ct'),uA=U(AL),uB=U(B),uG=U(G),cA=A(AG,CN);
const cli=(state:St,caller:Ctx,argv:string[])=>execCli(argv,{state,caller }),sh=(s:St,c:Ctx,cmd:string)=>cli(s,c,cmd.split(' '));
const rCode=(r:Record<string,unknown>)=>(r.refusal as{code:string }).code,rc=(s:St,c:Ctx,t:string,a:Record<string,unknown>)=>rCode(mcp(s,c,t,a)),rs=(s:St,c:Ctx,a:Record<string,string>)=>rCode(resSel(s,c,a));
const addS=(s:St,seat_id:string,workspace_id:string,principal_id:string,agent_identity_id:string)=>s.seats!.push({ seat_id,workspace_id,principal_id,agent_identity_id,revoked_at:null });
const addH=(s:St,handle_id:string,seat_id:string,workspace_id:string,revoked_at:string | null=null)=>s.seatHandles!.push({ handle_id,seat_id,workspace_id,revoked_at });
function makeFixture():St {
return {
privateChannelsEnabled:true,
organizations:([[OY,Y,'Yulan'],[OA,'acme','Acme']] as const).map(([id,slug,display_name])=>({ id,slug,display_name,logo_object_key:null,logo_updated_at:null,created_by:T,created_at:NOW,updated_at:NOW,archived_at:null })),
orgMemberships:([[OY,'u',T,'o'],[OY,'u',AL,'d'],[OY,'u',B,'m'],[OY,'u',G,'g'],[OY,'a',AG,'d'],[OA,'u',T,'o'],[OA,'a',AG,'m']] as const).map(([o,k,id,r])=>({ org_id:o,principal_kind:K(k),principal_id:id,role:R[r]!,created_at:NOW,revoked_at:null })),
workspaces:([[WC,OY,'core','Core'],[WO,OY,'ops','Ops'],[WA,OA,'ops','Ops']] as const).map(([workspace_id,org_id,slug,name])=>({ workspace_id,org_id,slug,name,archived_at:null })),
workspaceGrants:([[WC,OY,'u',T,'o'],[WC,OY,'u',AL,'d'],[WC,OY,'u',B,'m'],[WC,OY,'a',AG,'d'],[WO,OY,'u',T,'o'],[WO,OY,'a',AG,'d'],[WA,OA,'u',T,'o'],[WA,OA,'a',AG,'m']] as const).map(([w,o,k,id,r])=>({ workspace_id:w,org_id:o,principal_kind:K(k),principal_id:id,role:R[r]!,created_at:NOW,revoked_at:null })),
channels:([['c-yg',WC,OY,'general',0],['c-ys',WC,OY,'security',1],['c-yo',WO,OY,'general',0],['c-ag',WA,OA,'general',0]] as const).map(([channel_id,workspace_id,org_id,slug,p])=>({ channel_id,workspace_id,org_id,slug,visibility:(p?'private':'workspace') as 'workspace' | 'private',join_policy:(p?'invite_only':'open') as 'open' | 'invite_only',is_default:slug==='general',created_at:NOW })),
channelMemberships:([['u',T,'owner'],['a',AG,'member']] as const).map(([k,id,role])=>({ channel_id:'c-ys',workspace_id:WC,principal_kind:K(k),principal_id:id,role,notify_pref:'all' as const,joined_at:NOW,revoked_at:null })),
agentIdentities:[{ id:AG,owner_user_id:T,display_name:'Argon',created_at:NOW }],
agentPrincipals:[],seats:[],seatHandles:[],
connectionPolicies:[{ connection_id:CN,default_org_id:OY,default_workspace_id:WC,revoked_at:null }],
fileChannelBindings:[{ file_id:'f-s1',workspace_id:WC,channel_id:'c-ys',bound_by_kind:'user',created_at:NOW }],
signals:[{ signal_id:'s-s1',workspace_id:WC,channel_id:'c-ys',thread_id:'t-s1' }],
};
}
test('schemas',()=>{
deq([NAMES.length,TOOLS.length],[34,34]);
for (const t of TOOLS) for (const sel of ['seat','seat_id','org','workspace','channel']) ok(sel in t.inputSchema.properties);
const inv=TOOLS.find((t)=>t.name==='org_invite_member')!.inputSchema.properties,arrT={ type:'array',items:{type:'string'}};
deq([inv.workspace_ids,inv.request_approval,TOOLS.find((t)=>t.name==='whoami')!.inputSchema.properties.allowed_org_ids],[arrT,{type:'boolean' },arrT]);
for (const fn of [()=>valArgs('unknown_tool',{}),()=>valArgs('org_create',{slug:'only' }),()=>parseCli(['org','list','--bogus'])]) th(fn);
for (const [t,bad] of [
['org_set_member_role',{principal_id:'u',role:'x' }],['channel_add_member',{principal_id:'u',role:'admin' }],
['channel_create',{slug:'s',visibility:'x' }],['channel_create',{slug:'s',join_policy:'x' }],
['channel_set_notify_pref',{notify_pref:'x' }],['org_move_workspace',{target_org:'a',transfer_members:'x' }],
['org_confirm_action',{approval_id:'a',decision:'x' }],['org_invite_member',{workspace_ids:'x' }],
['org_delete',{confirm_slug:'y',request_approval:'x' }],['org_update',{display_name:null }],
] as const) th(()=>valArgs(t,bad),/INVALID/);
});
test('whoami+cli',()=>{
const s=makeFixture(),pre=whoami(s,cA,{}),j=(cmd:string)=>JSON.parse(sh(s,cA,cmd).stdout);
if (!pre.ok) assert.fail('whoami');
const disc=mcp(s,cA,'discover',{});
deq([pre.active_seat,pre.organizations[0]?.role,pre.organizations[1]?.role,(s.agentPrincipals?.length??0) + (s.seats?.length??0),rCode(whoami(s,cA,{org:Y,workspace:'acme/ops' }) as Record<string,unknown>),rCode(whoami(s,uB,{workspace:WYC,channel:'security' }) as Record<string,unknown>),j('cswarm whoami --json'),disc.total_organizations,disc.total_workspaces,disc.total_channels,j('discover --json')],[null,'admin','member',0,'WORKSPACE_SEAT_MISMATCH','CHANNEL_ACCESS_DENIED',pre,2,3,4,disc]);
s.agentPrincipals!.push({ principal_id:'ap-argon',workspace_id:WC,agent_identity_id:AG,owner_user_id:T,name:'Argon',revoked_at:null });
addS(s,'seat-1',WC,'ap-argon',AG); addH(s,'h-live','seat-1',WC);
Object.assign(s.connectionPolicies![0]!,{default_org_id:OA,default_workspace_id:'ws-del' });
const fb=whoami(s,cA,{});
if (fb.ok) deq([fb.default_org_id,fb.default_workspace_id],[OA,WA]);
Object.assign(s.connectionPolicies![0]!,{default_org_id:'org-del',default_workspace_id:'ws-del' });
const post=whoami(s,A('ap-argon',CN,'h-live'),{});
if (!post.ok) assert.fail('post');
let tx='';
eq(execCli(['org','list','--json'],{transport:(t)=>((tx=t),{ok:true,organizations:[] }) }).exitCode,0);
resetCli();
deq([post.active_seat?.seat_id,post.default_org_id,post.default_workspace_id,tx,execCli(['org','create','solo-org','--name','Solo']).exitCode,(JSON.parse(execCli(['org','list','--json']).stdout).organizations as Array<{ slug:string }>)[0]?.slug],['seat-1',null,null,'org_list',0,'solo-org']);
});
test('selectors',()=>{
const s=makeFixture();
addS(s,'seat-1',WC,'ap-argon',AG); addH(s,'h-live','seat-1',WC); addH(s,'h-rev','seat-1',WC,NOW);
deq([(resSel(s,cA,{}) as{source?:string }).source,(resSel(s,cA,{seat:'h-live' }) as{source?:string }).source,rs(s,cA,{seat:'h-rev' }),rs(s,cA,{seat:'h-live',seat_id:'s2' }),rs(s,cA,{seat:'h-live',workspace:'acme/ops' }),rs(s,cA,{org:Y,workspace:WA }),rc(s,cA,'org_get',{org:Y,workspace:'acme/ops' }),rc(s,cA,'org_create',{slug:'b',display_name:'B',org:'none' })],['connection_default','seat','WORKSPACE_ACCESS_DENIED','WORKSPACE_SEAT_MISMATCH','WORKSPACE_SEAT_MISMATCH','WORKSPACE_SEAT_MISMATCH','WORKSPACE_SEAT_MISMATCH','ORG_ACCESS_DENIED']);
const ambig=resSel(s,A(),{workspace:'ops' });
if (!ambig.ok) deq([ambig.refusal.code,ambig.refusal.choices?.map((x)=>x.selector),isTool(ambig.refusal.mcp_tool),/yulan\/ops, acme\/ops/.test(fmtRef(ambig.refusal))],['AMBIGUOUS_WORKSPACE_SELECTOR',['yulan/ops','acme/ops'],true,true]);
const sigD=resSel(s,uB,{workspace:WYC,signal_id:'s-s1' });
if (!sigD.ok) deq([sigD.refusal.code,sigD.refusal.mcp_tool,parseCli(sigD.refusal.grant_command_hint.split(' ')).tool],['CHANNEL_ACCESS_DENIED','channel_add_member','channel_add_member']);
deq([parseCli(enrich(mkRef({ code:'CHANNEL_ACCESS_DENIED',missing:'ch',scope:{org:Y,workspace:'core'}})).grant_command_hint.split(' ')).tool,rs(s,uB,{workspace:WYC,file_id:'f-s1' })],['channel_add_member','CHANNEL_ACCESS_DENIED']);
});
test('org+logos',()=>{
const s=makeFixture(),shY=(c:Ctx,sub:string)=>sh(s,c,`org ${sub} --org yulan`),rcY=(c:Ctx,t:string,a:Record<string,unknown>)=>rc(s,c,t,{org:Y,...a });
deq([sh(s,uT,'org list').exitCode,sh(s,uT,'org get yulan').exitCode],[0,0]);
const newOrgId=(sh(s,uT,'org create ridge --name Ridge').payload.organization as{id:string }).id,rb=(n:'64' | '256')=>s.orgLogos?.[newOrgId]?.rendition_blobs?.[n]!;
deq([effRole(s,A(),newOrgId),rc(s,cA,'org_update',{org:'ridge',display_name:'X' })],['member','ORG_ADMIN_REQUIRED']);
const svg='<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><foreignObject/><image href="//e.io/x"/><a href="&#x6a;avascript:x()"><circle r="9" style="fill:url(&#x2f;&#x2f;e.io/p)"/></a></svg>';
eq(cli(s,uT,['org','logo','upload','--org','ridge','--content-type','image/svg+xml','--svg',svg]).exitCode,0);
ok(['<script>','onload=','foreignObject','e.io','&#x6a;'].every((bad)=>!s.orgLogos?.[newOrgId]?.sanitized_svg?.includes(bad)));
deq([rb('64').width,Buffer.from(rb('64').data_base64,'base64').subarray(8,16).toString('ascii'),rb('256').sha256.length],[64,'WEBPVP8L',64]);
const upL=(ct:string,d:string)=>mcp(s,uT,'org_logo_upload',{org:'ridge',content_type:ct,data_base64:d }),h64=(ct:string,d:string)=>(upL(ct,d),rb('64').sha256);
const hSvg=(body:string)=>(mcp(s,uT,'org_logo_upload',{org:'ridge',content_type:'image/svg+xml',svg:`<svg width="16" height="16"><rect width="16" height="16" fill="#ff0000"/>${body}</svg>` }),rb('64').sha256);
const mkPlte=(al:number)=>{
const z=deflateSync(Uint8Array.from([0,0])),b=Buffer.alloc(69 + z.length);
Buffer.from([137,80,78,71,13,10,26,10,0,0,0,13,73,72,68,82,0,0,0,1,0,0,0,1,8,3,0,0,0,0,0,0,0,0,0,0,3,80,76,84,69,250,20,30,0,0,0,0,0,0,0,1,116,82,78,83,al]).copy(b);
b.writeUInt32BE(z.length,61); b.write('IDAT',65); z.copy(b,69);
return b.toString('base64');
};
const jPfx=`/9j/2wBDAAE${'BAQE'.repeat(21)}BAQH/wAALCAAIABABAREA/8QAFQABAQ${'A'.repeat(19)}AT/xAAUEAE${'A'.repeat(21)}`;
const hP0=h64('image/png',mkPlte(255)),hP1=h64('image/png',mkPlte(64)),hW=h64('image/webp','UklGRiwAAABXRUJQVlA4TCAAAAAvBcAAALmM6H/sIqL/AYVsI0Dndf5kP8KUzEpMAMBKDw==');
ok(hP0!==hP1&&hW===h64('image/png','iVBORw0KGgoAAAANSUhEUgAAAAYAAAAECAYAAACtBE5DAAAAHUlEQVR4nGNkYGD4r8qgzYCOWRistRkYGDAx6RIAeh8GVIL1eRQAAAAASUVORK5CYII=')&&h64('image/webp',rb('64').data_base64)===hW&&h64('image/jpeg',`${jPfx}/9oACAEBAAA/ALEb/9k=`)===h64('image/jpeg',`${jPfx}/90ABAAB/9oACAEBAAA/ALH/0D//2Q==`)&&hSvg('<circle cx="0" cy="0" r="6" fill="#0000ff"/>')!==hSvg('<circle cx="8" cy="8" r="6" fill="#0000ff"/>')&&hSvg('<circle cx="8" cy="8" r="0" fill="#0000ff"/>')===hSvg(''));
deq([rCode(upL('image/png','iVBORw==')),sh(s,uT,'org logo remove --org ridge').exitCode,sh(s,cA,'org switch acme --workspace ops').exitCode,sh(s,uT,'org update ridge --name RidgeInc').exitCode,s.connectionPolicies![0]!.default_org_id],['INVALID_LOGO_FORMAT',0,0,0,OA]);
deq([rcY(uA,'org_invite_member',{principal_id:T,role:'member' }),rcY(uT,'org_invite_member',{principal_id:T,role:'admin' }),rcY(uT,'org_invite_member',{principal_id:'u-bw',role:'member',workspace_ids:['bad'] }),s.orgMemberships.some((m)=>m.principal_id==='u-bw')],['ORG_OWNER_ROLE_REQUIRED','LAST_ORG_OWNER_REQUIRED','WORKSPACE_ACCESS_DENIED',false]);
s.orgMemberships[0]!.role='guest';
deq([effRole(s,cA,OY),rcY(cA,'org_set_member_role',{principal_id:T,role:'admin' })],['guest','ORG_ADMIN_REQUIRED']);
s.orgMemberships[0]!.role='owner';
deq([shY(uT,`invite c@y.io --principal u-c --role guest --workspace ${WC}`).exitCode,(shY(uT,'members --kind guest').payload.members as unknown[]).length,shY(uT,'role u-c member').exitCode,shY(uT,'remove u-c').exitCode,rcY(uT,'org_set_member_role',{principal_id:T,role:'admin' })],[0,2,0,0,'CANNOT_REMOVE_LAST_ORG_OWNER']);
for (const [cmd,dec,end] of [['org set-role u-tom admin --org yulan --request-approval','approve',0],['org delete ridge --confirm ridge','typo',1]] as const) {
const req=sh(s,cA,cmd),id=(req.payload.approval as{approval_id:string }).approval_id;
deq([/pending_owner_approval/.test(req.stdout),rc(s,uT,'org_confirm_action',{approval_id:id,decision:'approve',org:'acme' }),mcp(s,uT,'org_confirm_action',{approval_id:id,decision:dec }).ok,s.approvalRequests?.find((a)=>a.approval_id===id)?.state],[true,'WORKSPACE_SEAT_MISMATCH',false,'pending']);
if (end) eq(sh(s,uT,`org confirm ${id} --approve`).payload.status,'approved');
}
ok(s.organizations.find((o)=>o.id===newOrgId)?.archived_at);
});
test('workspaces',()=>{
const s=makeFixture(),yr='yulan/research';
deq([sh(s,uT,'workspace list --org yulan').exitCode,sh(s,uA,'workspace members yulan/ops').exitCode,sh(s,uA,'org members grant u-bob --org yulan --workspace yulan/ops --role member').exitCode,sh(s,uA,'org invite f@y.io --workspace yulan/ops').exitCode],[0,0,0,0]);
const defCh=sh(s,uT,'workspace create research --org yulan --name Research').payload.default_channel as{slug:string; is_default?:boolean };
deq([defCh.slug,defCh.is_default,rCode(sh(s,uG,`workspace join ${yr}`).payload),sh(s,uT,'org invite ag-h --org yulan --kind agent --role member').exitCode],['general',true,'GUEST_WORKSPACE_GRANT_REQUIRED',0]);
const grantAg=sh(s,uT,`org members grant ag-h --org yulan --workspace ${WYC} --kind agent --role member`);
addS(s,'s-h',WC,String(grantAg.payload.agent_principal_id),'ag-h'); addH(s,'h-h','s-h',WC);
eq(rc(s,A('ag-h',undefined,'h-h'),'workspace_join',{workspace:yr }),'WORKSPACE_SEAT_MISMATCH');
const revAg=sh(s,uT,`org members revoke ag-h --org yulan --workspace ${WYC} --kind agent`);
deq([revAg.payload.closed_seat_ids,revAg.payload.closed_handle_ids],[['s-h'],['h-h']]);
for (const [c,cmd] of [[uT,`workspace members ${WYC}`],[uA,`workspace join ${yr}`],[uA,`workspace leave ${yr}`],[uT,`workspace move ${yr} --to-org acme`]] as const) eq(sh(s,c,cmd).exitCode,0);
eq(s.workspaces.find((w)=>w.slug==='research')?.org_id,OA);
});
test('channels',()=>{
const s=makeFixture(),shC=(c:Ctx,sub:string)=>sh(s,c,`channel ${sub} --workspace ${WYC}`),rcC=(c:Ctx,t:string,channel:string,a:Record<string,unknown>)=>rc(s,c,t,{workspace:WYC,channel,...a });
mcp(s,uT,'org_assign_workspace_member',{org:Y,workspace:'core',principal_id:G,role:'guest' });
mcp(s,uT,'org_assign_workspace_member',{org:Y,workspace:'ops',principal_id:B,role:'guest' });
delete s.privateChannelsEnabled;
deq([rCode(shC(uG,'create g1').payload),rCode(sh(s,uB,'channel create g2 --workspace yulan/ops').payload),rCode(shC(cA,'create war-room --visibility private').payload)],['CHANNEL_CREATE_FORBIDDEN','CHANNEL_CREATE_FORBIDDEN','PRIVATE_CHANNELS_DISABLED']);
s.privateChannelsEnabled=true;
shC(uT,'create pub1');
deq([rcC(uT,'channel_rename','pub1',{new_slug:'bad!',visibility:'private' }),s.channels.find((c)=>c.slug==='pub1')?.visibility],['INVALID_CHANNEL_SLUG','workspace']);
const privId=(shC(cA,'create war-room --visibility private --topic Sev-1').payload.channel as{channel_id:string }).channel_id;
deq([(shC(uT,'members war-room').payload.members as unknown[]).length,shC(uT,'notify mentions --channel war-room').exitCode,s.channelMemberships.find((m)=>m.channel_id===privId&&m.principal_id===T)?.role],[2,0,'owner']);
ok(!(shC(uB,'list').payload.channels as Array<{ slug:string }>).some((c)=>c.slug==='war-room'));
deq(['join war-room','add-member --channel war-room --principal u-bob','topic Resolved --channel war-room','notify mentions --channel war-room'].map((c,i)=>shC(i===1?uT:uB,c).exitCode),[1,0,0,0]);
deq([
rcC(uB,'channel_add_member','war-room',{principal_id:B,role:'owner' }),
rcC(uB,'channel_add_member','general',{principal_id:B,role:'owner' }),
rcC(uB,'channel_remove_member','general',{principal_id:T }),
rcC(uT,'channel_rename','general',{visibility:'private' }),
],['PRIVATE_CHANNEL_INVITE_REQUIRED','CHANNEL_ADMIN_REQUIRED','CHANNEL_ADMIN_REQUIRED','DEFAULT_CHANNEL_MUST_BE_PUBLIC']);
s.signals!.push({ signal_id:'sig-gen-1',workspace_id:WC,channel_id:'c-yg' });
eq(rcC(uT,'channel_rename','general',{visibility:'private' }),'CHANNEL_HAS_PUBLIC_HISTORY');
for (const [c,sub] of [[uB,'leave general'],[uB,'archive war-room'],[uG,'archive general'],[uG,'topic B --channel general'],[uT,'archive general'],[uT,'rename m --channel general']] as const) eq(shC(c,sub).exitCode,1);
deq([shC(uT,'remove-member u-bob --channel war-room').exitCode,shC(uT,'archive war-room').exitCode,parseCli(['cswarm','org','list','--json']).tool],[0,0,'org_list']);
ok(s.channels.find((c)=>c.channel_id===privId)?.archived_at&&/Identity: ag-argon[\s\S]*Org yulan/.test(sh(s,cA,'whoami').stdout));
});
