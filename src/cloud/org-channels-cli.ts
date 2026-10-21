import {
type CallerContext,type OrgApprovalRequest,type OrgChannelAuthorityState,type OrgChannelRefusal,type OrgRole,type PrincipalKind,orgRole,canReadOrg,agentOwner,} from '../protocol/org-channels-contract.js';
import { executeOrgChannelMcpTool } from '../../supabase/functions/mcp/org-channels-handlers.js';
export interface CliCallerContext extends CallerContext { seat?:string | null; seat_id?:string | null; }
export interface CliOrgChannelState extends OrgChannelAuthorityState {
orgInvites?: Array<{ invite_id:string; org_id:string; email?:string | null; principal_kind?: PrincipalKind; principal_id?:string | null; role: OrgRole; workspace_ids:string[]; invited_by:string; expires_at:string; created_at:string; revoked_at?:string | null }>;
approvalRequests?: OrgApprovalRequest[];
orgLogos?: Record<string,{ org_id:string; object_key:string; content_type:string; byte_length:number; renditions: Record<string,string>; rendition_blobs?: Record<string,{ object_key:string; width:number; height:number; content_type:string; byte_length:number; sha256:string; data_base64:string }>; sanitized_svg?:string; updated_at:string }>;
signals?: Array<{ signal_id:string; workspace_id:string; channel_id?:string | null; thread_id?:string | null }>; }
export interface ParsedOrgChannelCliCommand { tool:string; arguments: Record<string,unknown>; json:boolean; }
const BOOL_FLAGS = new Set(['json','approve','reject','request-approval']); const KNOWN_FLAGS = new Set([
...BOOL_FLAGS,'org','workspace','channel','seat','seat-id','slug','new-slug','name','display-name',
'confirm','confirm-slug','principal','principal-id','kind','role','email','approval-id','decision',
'to-org','target-org','transfer-members','content-type','data-base64','svg','visibility','join-policy','topic','purpose','notify',
]); function mkSt(): CliOrgChannelState { return { privateChannelsEnabled: true,organizations: [],workspaces: [],channels: [],agentIdentities: [],
orgMemberships: [],workspaceGrants: [],channelMemberships: [],agentPrincipals: [],seats: [],
seatHandles: [],connectionPolicies: [],fileChannelBindings: [],orgInvites: [],approvalRequests: [],orgLogos: {},signals: [],
}; } let defSt: CliOrgChannelState = mkSt();
export const getDefaultOrgChannelCliState = (): CliOrgChannelState => defSt;
export function resetDefaultOrgChannelCliState(next?: CliOrgChannelState): CliOrgChannelState { defSt = next??mkSt(); return defSt; }
export function parseOrgChannelsCliArgs(argv: readonly string[]): ParsedOrgChannelCliCommand { const tokens = argv[0]==='cswarm' ? argv.slice(1) : [...argv];
const pos:string[] = []; const f = new Map<string,string>(); for (let i = 0; i < tokens.length; i += 1) { const tok = tokens[i]!;
if (!tok.startsWith('--')) { pos.push(tok); continue; } const eq = tok.indexOf('='); if (eq!==-1) { const k = tok.slice(2,eq);
if (!KNOWN_FLAGS.has(k)) throw new Error(`Unknown option: --${k}`); f.set(k,tok.slice(eq + 1)); continue; } const name = tok.slice(2);
if (!KNOWN_FLAGS.has(name)) throw new Error(`Unknown option: --${name}`); if (BOOL_FLAGS.has(name)) { f.set(name,'true'); continue; } const next = tokens[i + 1];
if (next===undefined||next.startsWith('--')) throw new Error(`--${name} requires a value`); f.set(name,next); i += 1; } const json = f.get('json')==='true';
const b: Record<string,unknown> = {};
for (const [flag,key] of [['org','org'],['workspace','workspace'],['channel','channel'],['seat','seat'],['seat-id','seat_id']] as const) {
if (f.has(flag)) b[key] = f.get(flag); } if (f.get('request-approval')==='true') b.request_approval = true;
const opt = (flag:string,key = flag) => (f.has(flag) ? { [key]: f.get(flag) } : {}); const [cmd,sub,a1,a2] = pos;
if(cmd==='whoami'||cmd==='discover') return {tool:cmd,arguments: b,json}; if(cmd==='org'||cmd==='orgs') {
if (!sub||sub==='list'||sub==='ls') return {tool:'org_list',arguments: b,json};
if(sub==='get'||sub==='show') return {tool:'org_get',arguments:{ ...b,...(a1 ? { org: a1 } : {}) },json}; if(sub==='create') { const slug = a1??f.get('slug')??'';
return {tool:'org_create',arguments:{ ...b,slug,display_name: f.get('name')??f.get('display-name')??a2??slug },json}; }
if(sub==='update') return {tool:'org_update',arguments:{ ...b,...(a1&&!b.org ? { org: a1 } : {}),...opt('name','display_name'),...opt('slug','new_slug') },json};
if(sub==='delete'||sub==='rm') return {tool:'org_delete',arguments:{ ...b,...(a1&&!b.org ? { org: a1 } : {}),confirm_slug: f.get('confirm')??f.get('confirm-slug')??'' },json};
if(sub==='switch'||sub==='default') return {tool:'org_switch_default',arguments:{ ...b,org: a1??b.org },json}; if(sub==='members') {
const pId = a2??f.get('principal')??f.get('principal-id');
if (a1==='grant') return {tool:'org_assign_workspace_member',arguments:{ ...b,principal_id: pId,...opt('kind','principal_kind'),...opt('role') },json};
if (a1==='revoke') return {tool:'org_remove_workspace_member',arguments:{ ...b,principal_id: pId,...opt('kind','principal_kind') },json};
return {tool:'org_list_members',arguments:{ ...b,...opt('kind') },json}; } if(sub==='invite') {
const isEmail = a1?.includes('@'),wArg = f.get('workspace'),{ workspace: _w,...bO } = b; if (wArg?.includes('/')&&!bO.org) bO.org = wArg.split('/',2)[0];
return {tool:'org_invite_member',arguments:{ ...bO,...(isEmail ? { email: a1 } : a1 ? { principal_id: a1 } : {}),...opt('email'),...opt('principal','principal_id'),...opt('kind','principal_kind'),...opt('role'),...(wArg ? { workspace_ids: [wArg] } : {}) },json};
}
if(sub==='role'||sub==='set-role') return {tool:'org_set_member_role',arguments:{ ...b,principal_id: a1??f.get('principal'),role: a2??f.get('role'),...opt('kind','principal_kind') },json};
if(sub==='remove'||sub==='remove-member') return {tool:'org_remove_member',arguments:{ ...b,principal_id: a1??f.get('principal'),...opt('kind','principal_kind') },json};
if(sub==='confirm') { const decision = f.get('approve')==='true' ? 'approve' : f.get('reject')==='true' ? 'reject' : (f.get('decision')??a2??'approve');
return {tool:'org_confirm_action',arguments:{ ...b,approval_id: a1??f.get('approval-id'),decision },json}; }
if(sub==='grant') return {tool:'org_assign_workspace_member',arguments:{ ...b,principal_id: a1??f.get('principal'),...opt('kind','principal_kind'),...opt('role') },json};
if(sub==='revoke-grant') return {tool:'org_remove_workspace_member',arguments:{ ...b,principal_id: a1??f.get('principal'),...opt('kind','principal_kind') },json};
if(sub==='move-workspace') return {tool:'org_move_workspace',arguments:{ ...b,...(a1&&!b.workspace ? { workspace: a1 } : {}),target_org: f.get('to-org')??f.get('target-org')??a2,...opt('transfer-members','transfer_members') },json};
if(sub==='logo') { if (a1==='remove'||a1==='rm') return {tool:'org_logo_remove',arguments: b,json};
return {tool:'org_logo_upload',arguments:{ ...b,content_type: f.get('content-type')??'image/png',...opt('data-base64','data_base64'),...opt('svg') },json}; } }
if(cmd==='workspace'||cmd==='workspaces') { if (!sub||sub==='list'||sub==='ls') return {tool:'workspace_list',arguments: b,json};
if(sub==='create') return {tool:'workspace_create',arguments:{ ...b,slug: a1??f.get('slug'),name: f.get('name')??a2??a1 },json};
if(sub==='join') return {tool:'workspace_join',arguments:{ ...b,...(a1 ? { workspace: a1 } : {}) },json};
if(sub==='leave') return {tool:'workspace_leave',arguments:{ ...b,...(a1 ? { workspace: a1 } : {}) },json};
if(sub==='members') return {tool:'workspace_list_members',arguments:{ ...b,...(a1 ? { workspace: a1 } : {}) },json};
if(sub==='move') return {tool:'org_move_workspace',arguments:{ ...b,...(a1&&!b.workspace ? { workspace: a1 } : {}),target_org: f.get('to-org')??f.get('target-org')??a2,...opt('transfer-members','transfer_members') },json};
} if(cmd==='channel'||cmd==='channels') { if (!sub||sub==='list'||sub==='ls') return {tool:'channel_list',arguments: b,json};
if(sub==='create') return {tool:'channel_create',arguments:{ ...b,slug: a1??f.get('slug'),...opt('visibility'),...opt('join-policy','join_policy'),...opt('topic'),...opt('purpose') },json};
if(sub==='join') return {tool:'channel_join',arguments:{ ...b,...(a1 ? { channel: a1 } : {}) },json};
if(sub==='leave') return {tool:'channel_leave',arguments:{ ...b,...(a1 ? { channel: a1 } : {}) },json}; if(sub==='add-member'||sub==='invite') {
const pId = f.get('principal')??f.get('principal-id')??a1; const ch = f.get('channel')??(f.has('principal')&&a1 ? a1 : b.channel);
return {tool:'channel_add_member',arguments:{ ...b,...(ch ? { channel: ch } : {}),principal_id: pId,...opt('kind','principal_kind'),...opt('role') },json}; }
if(sub==='remove-member'||sub==='kick') return {tool:'channel_remove_member',arguments:{ ...b,principal_id: a1??f.get('principal'),...opt('kind','principal_kind') },json};
if(sub==='members') return {tool:'channel_list_members',arguments:{ ...b,...(a1 ? { channel: a1 } : {}) },json};
if(sub==='archive') return {tool:'channel_archive',arguments:{ ...b,...(a1 ? { channel: a1 } : {}) },json};
if(sub==='rename') return {tool:'channel_rename',arguments:{ ...b,new_slug: a1??f.get('new-slug')??f.get('slug'),...opt('visibility'),...opt('join-policy','join_policy') },json};
if(sub==='topic') return {tool:'channel_set_topic',arguments:{ ...b,topic: a1??f.get('topic')??'',...opt('purpose') },json};
if(sub==='notify') return {tool:'channel_set_notify_pref',arguments:{ ...b,notify_pref: a1??f.get('notify')??'all' },json}; }
throw new Error(`Unknown org/workspace/channel CLI command: ${pos.join(' ')}`); }
export function formatOrgChannelRefusal(refusal: OrgChannelRefusal & { grant_command_hint?:string }):string { const hint = refusal.grant_command_hint??refusal.cli_command;
const ln = [
`Refused (${refusal.code}): missing ${refusal.missing}.`,
`Scope: org=${refusal.scope.org??'-'} workspace=${refusal.scope.workspace??'-'} channel=${refusal.scope.channel??'-'}`,
]; if (refusal.choices?.length) ln.push(`Matching workspaces: ${refusal.choices.map((c) => c.selector).join(', ')}`);
ln.push(`Remedy URL: ${refusal.remedy_url}`,`MCP tool: ${refusal.mcp_tool}`,`Run next: ${hint}`); return ln.join('\n'); }
export type OrgChannelToolDispatcher = (
state: CliOrgChannelState,
caller: CliCallerContext,
tool:string,
args: Record<string,unknown>,
) => Record<string,unknown>; var defDisp: OrgChannelToolDispatcher | null = null;
export function registerDefaultOrgChannelCliExecutor(fn: OrgChannelToolDispatcher): void { defDisp = fn; } function resDisp(): OrgChannelToolDispatcher {
return defDisp??((s,c,t,a) => executeOrgChannelMcpTool(s,c,t,a)); } const ROLE_RANK: Record<OrgRole,number> = { guest: 1,member: 2,admin: 3,owner: 4 };
export function effCallerOrgRole(s: CliOrgChannelState,c: CallerContext,orgId:string): OrgRole | null { if (!canReadOrg(s,c,orgId)) return null;
if (c.principal_kind==='user') return orgRole(s,orgId,'user',c.principal_id); const owner = agentOwner(s,c); const ownerRole = owner ? orgRole(s,orgId,'user',owner) : null;
if (!ownerRole) return null; const ownerCap: OrgRole = ownerRole==='owner' ? 'admin' : ownerRole; const explicit = orgRole(s,orgId,'agent',c.principal_id);
if (!explicit) return ownerRole==='guest' ? 'guest' : 'member'; const expCap: OrgRole = explicit==='owner' ? 'admin' : explicit;
return ROLE_RANK[expCap] <= ROLE_RANK[ownerCap] ? expCap : ownerCap; }
export function formatOrgChannelCliOutput(tool:string,stLbl:string,p: Record<string,unknown>):string { const ln = [`${tool}: ${stLbl}`];
if (typeof p.agent_identity_id==='string') {
ln.push(`Identity: ${p.agent_identity_id} (owner=${String(p.owner_user_id??'-')},seat=${(p.active_seat as { seat_id?:string } | null)?.seat_id??'none'},default_org=${String(p.default_org_id??'none')})`);
} if (typeof p.total_organizations==='number') {
ln.push(`Totals: orgs=${p.total_organizations} workspaces=${String(p.total_workspaces??0)} channels=${String(p.total_channels??0)}`); } if (Array.isArray(p.organizations)) {
for (const o of p.organizations as Record<string,unknown>[]) { const wsList = Array.isArray(o.workspaces)
? (o.workspaces as Record<string,unknown>[]).map((w) => {
const chs = Array.isArray(w.channels) ? (w.channels as Array<{ slug:string }>).map((c) => `#${c.slug}`).join(', ') : '';
return `${String(w.slug)}(${String(w.role??'-')})${chs ? `[${chs}]` : ''}`; }).join(', ')
: `workspaces=${String(o.workspace_count??0)}`; ln.push(`Org ${String(o.slug??o.org_id)} [${String(o.role??'-')}]: ${wsList}`); } }
const orgObj = p.organization as Record<string,unknown> | undefined;
if (orgObj) ln.push(`Organization: ${String(orgObj.slug)} (${String(orgObj.display_name??orgObj.id)}) role=${String(p.role??'owner')}`); if (Array.isArray(p.workspaces)) {
ln.push(`Workspaces: ${(p.workspaces as Record<string,unknown>[]).map((w) => `${String(w.selector??w.slug)} (${String(w.name??w.workspace_id)})`).join(', ')||'none'}`); }
if (Array.isArray(p.channels)) {
ln.push(`Channels: ${(p.channels as Record<string,unknown>[]).map((c) => `#${String(c.slug)} (${String(c.visibility??'workspace')})`).join(', ')||'none'}`); }
if (Array.isArray(p.members)) {
ln.push(`Members: ${(p.members as Record<string,unknown>[]).map((m) => `${String(m.principal_kind??'user')}:${String(m.principal_id)} (${String(m.role)})`).join(', ')||'none'}`);
} const apr = (p.approval??p.approval_request) as Record<string,unknown> | undefined;
if (apr) ln.push(`Approval ${String(apr.approval_id)}: action=${String(apr.action_kind)} state=${String(apr.state)}${p.cli_command ? ` | confirm: ${String(p.cli_command)}` : ''}`);
return ln.join('\n'); }
export interface ExecuteOrgChannelsCliOptions { state?: CliOrgChannelState; caller?: CliCallerContext; executeTool?: OrgChannelToolDispatcher;
transport?: (tool:string,args: Record<string,unknown>,caller: CliCallerContext) => Record<string,unknown>; }
let defCal: CliCallerContext = { principal_kind: 'user',principal_id: 'u-cli-default' };
export function registerDefaultOrgChannelCliCaller(caller: CliCallerContext): void { defCal = caller; }
export function executeOrgChannelsCli(argv: readonly string[],options: ExecuteOrgChannelsCliOptions = {}) { const parsed = parseOrgChannelsCliArgs(argv);
const state = options.state??defSt; const caller: CliCallerContext = options.caller??defCal; const aSeat: Record<string,unknown> = { ...(caller.seat ? { seat: caller.seat } : {}),
...(caller.seat_id ? { seat_id: caller.seat_id } : {}),
...parsed.arguments,
}; const run = options.executeTool??resDisp(); const payload = options.transport ? options.transport(parsed.tool,aSeat,caller) : run(state,caller,parsed.tool,aSeat);
const ok = payload.ok===true; if (!ok&&payload.refusal) { const text = parsed.json ? JSON.stringify(payload) : formatOrgChannelRefusal(payload.refusal as OrgChannelRefusal);
return { exitCode: 1,ok: false,tool: parsed.tool,payload,stdout: parsed.json ? text : '',stderr: parsed.json ? '' : text }; }
const pendA = payload.status==='pending_owner_approval'||payload.status==='approval_required'; const stLbl = pendA
? 'pending_owner_approval'
: typeof payload.status==='string'&&payload.status.length > 0
? payload.status
: ok
? 'ok'
: String(payload.error??'error'); const stdout = parsed.json ? JSON.stringify(payload) : formatOrgChannelCliOutput(parsed.tool,stLbl,payload);
return { exitCode: ok ? 0 : 1,ok,tool: parsed.tool,payload,stdout,stderr: ok ? '' : stdout }; }
export function decodeJpegRgb(b: Uint8Array): [number,number,number] | null {
const qt: Record<number,number> = {},dcT: Record<number,Map<string,number>> = {},acT: Record<number,Map<string,number>> = {},comp: Array<[number,number,number]> = [];
for (let i = 2; i + 4 <= b.length; ) { if (b[i]!==0xff) { i++; continue; } while (i < b.length&&b[i]===0xff) i++; const m = b[i++]??0;
if (m===0xd9||(m >= 0xd0&&m <= 0xd8)||m===0x01) continue; const L = ((b[i]??0) << 8) | (b[i + 1]??0),s = b.subarray(i + 2,i + L);
if (m===0xdb) for (let p = 0; p + 65 <= s.length; p += 65) qt[s[p]! & 15] = s[p + 1]!;
else if (m===0xc0) for (let k = 0; k < (s[5]??0); k++) comp.push([s[6 + 3 * k]!,(s[7 + 3 * k]! >> 4) * (s[7 + 3 * k]! & 15),s[8 + 3 * k]!]); else if (m===0xc4) {
for (let p = 0; p + 17 <= s.length; ) { const tc = s[p]! >> 4,th = s[p]! & 15,cnt = s.subarray(p + 1,p + 17),mp = new Map<string,number>(); p += 17;
for (let l = 1,c = 0; l <= 16; l++,c <<= 1) for (let z = 0; z < cnt[l - 1]!; z++,c++) mp.set(`${l}:${c}`,s[p++]!); (tc ? acT : dcT)[th] = mp; } } else if (m===0xda) {
const ns = s[0]??0,ent:number[] = []; for (let j = i + L; j < b.length - 1; j++) {
if (b[j]===0xff) { if (b[j + 1]===0) { ent.push(0xff); j++; continue; } if (b[j + 1]! >= 0xd0&&b[j + 1]! <= 0xd7) { j++; continue; } break; } ent.push(b[j]!); } let bp = 0;
const gb = (n:number) => { let v = 0; for (let z = 0; z < n; z++,bp++) v = (v << 1) | (((ent[bp >> 3]??0) >> (7 - (bp & 7))) & 1); return v; };
const hf = (mp?: Map<string,number>) => { for (let l = 1,c = 0; l <= 16; l++) { c = (c << 1) | gb(1); const v = mp?.get(`${l}:${c}`); if (v!==undefined) return v; } return 0; };
const dcs: Record<number,number> = {}; for (let k = 0; k < ns; k++) {
const cid = s[1 + 2 * k]!,td = s[2 + 2 * k]! >> 4,ta = s[2 + 2 * k]! & 15,ci = comp.find((x) => x[0]===cid); if (!ci) return null; let dc = 0;
for (let bIdx = 0; bIdx < ci[1]; bIdx++) { const sz = hf(dcT[td]),dv = sz ? gb(sz) : 0; dc += sz&&dv < (1 << (sz - 1)) ? dv - ((1 << sz) - 1) : dv;
for (let ac = 1; ac < 64; ) { const rs = hf(acT[ta]),r = rs >> 4,a = rs & 15; if (!a) { if (r===15) ac += 16; else break; } else { gb(a); ac += r + 1; } } }
dcs[cid] = dc * (qt[ci[2]]??1); } const Y = (dcs[1]??0) / 8 + 128,Cb = (dcs[2]??0) / 8,Cr = (dcs[3]??0) / 8,cl = (x:number) => Math.max(0,Math.min(255,Math.round(x)));
return [cl(Y + 1.402 * Cr),cl(Y - 0.344136 * Cb - 0.714136 * Cr),cl(Y + 1.772 * Cb)]; } i += L; } return null; }
