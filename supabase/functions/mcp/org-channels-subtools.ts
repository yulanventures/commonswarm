import { inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
type CallerContext,type ChannelSummary,type OrgApprovalRequest,type OrganizationSummary,type OrgRole,type PrincipalKind,
agentOwner, isLive,isPrin,norm,orgRole,
} from '../../../src/protocol/org-channels-contract.js';
import { decodeJpegFull } from '../../../src/cloud/org-channels-cli.js';
import { type McpCallerAuth,type OrgChannelSlice3State } from './org-channels-tools.js';
import { executeWorkspaceJoinTool,executeWorkspaceScopeTool,ref } from './org-channels-channels.js';
export { executeWorkspaceJoinTool,executeWorkspaceScopeTool,ref };
export const SLUG_RE=/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LOGO=1_048_576;
export const toCtx=(c: McpCallerAuth): CallerContext => ({ principal_kind: c.principal_kind,principal_id: c.principal_id,owner_user_id: c.owner_user_id ?? null,connection_id: c.connection_id ?? null });
export function upsertWsGrant(s: OrgChannelSlice3State,wsId: string,orgId: string,k: PrincipalKind,id: string,role: OrgRole,now: string,ownFb: string) {
const ex=s.workspaceGrants.find((g) => g.workspace_id===wsId&&isPrin(g,k,id));
if(ex) { ex.role=role;ex.revoked_at=null;} else s.workspaceGrants.push({ workspace_id: wsId,org_id: orgId,principal_kind: k,principal_id: id,role,created_at: now,revoked_at: null });
if(k!=='agent') return null;s.agentPrincipals=s.agentPrincipals ?? [];const ai=s.agentIdentities.find((a) => a.id===id);
let ap=s.agentPrincipals.find((a) => a.workspace_id===wsId&&a.agent_identity_id===id);if(ap) ap.revoked_at=null;
else s.agentPrincipals.push(ap={ principal_id: `ap-${wsId}-${id}`,workspace_id: wsId,agent_identity_id: id,owner_user_id: ai?.owner_user_id ?? ownFb,name: ai?.display_name ?? id,revoked_at: null });
return ap.principal_id;}
export function enqueueApproval(s: OrgChannelSlice3State,caller: McpCallerAuth,org: { id: string;slug: string },action_kind: string,payload: Record<string,unknown>,workspace_id: string | null=null) {
const ownerId=caller.principal_kind==='agent'?agentOwner(s,toCtx(caller)):null;
if(!ownerId||orgRole(s,org.id,'user',ownerId)!=='owner') return ref('ORG_OWNER_REQUIRED','org_owner_role',{ org: org.slug });
s.approvalRequests=s.approvalRequests ?? [];const card: OrgApprovalRequest={
approval_id: `apr_${s.approvalRequests.length+1}`,org_id: org.id,workspace_id,channel_id: null,
requested_by_agent_identity_id: caller.principal_id,owner_user_id: ownerId,action_kind,
target_scope: { org: org.slug,workspace_id },payload,state: 'pending',created_at: new Date().toISOString(),
};s.approvalRequests.push(card);
return { ok: true as const,status: 'approval_required' as const,approval: card,approval_request: card,mcp_tool: 'org_confirm_action',cli_command: `cswarm org confirm ${card.approval_id} --approve --org ${org.slug}` };
} const ENT: Record<string,string>={ colon: ':',tab: '\t',newline: '\n',quot: '"',apos: "'",amp: '&',lt: '<',gt: '>' };
const decEnt=(v: string): string => v.replace(/&#x([0-9a-f]+);?/gi,(_,h) => String.fromCodePoint(parseInt(h,16)||0)).replace(/&#([0-9]+);?/g,(_,d) => String.fromCodePoint(parseInt(d,10)||0)).replace(/&(colon|tab|newline|quot|apos|amp|lt|gt);/gi,(_,n: string) => ENT[n.toLowerCase()] ?? '').replace(/\\([0-9a-f]{1,6})\s?/gi,(_,h) => String.fromCodePoint(parseInt(h,16)||0));
export function checkLogo(ct: string,b64?: string,svg?: string) { if(ct==='image/svg+xml') {
const raw=(svg ?? (b64?Buffer.from(b64,'base64').toString('utf8'):'')).trim(),len=Buffer.byteLength(raw,'utf8');
if(len===0||len > MAX_LOGO||!raw.toLowerCase().includes('<svg')) return { ok: false as const,reason: (len > MAX_LOGO?'size':'format') as 'size' | 'format' };
const sSvg=raw.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(script|foreignObject|iframe|object|embed|image|use)[\s\S]*?>[\s\S]*?<\/\1>|<\/?(script|foreignObject|iframe|object|embed|image|use)[^>]*>/gi,'').replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi,'').replace(/\s([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi,(f,a,_q,dq,sq,uq) => {
const n=String(a).toLowerCase(),val=decEnt(String(dq ?? sq ?? uq ?? '')).replace(/[\u0000-\u0020]+/g,'');if(n.startsWith('on')) return '';
if(n==='xmlns'&&val==='http://www.w3.org/2000/svg') return f;
return /(javascript|data|vbscript):|https?:|\/\/|@import/i.test(val)?(n==='style'?' style="url()"':''):f;});
return { ok: true as const,bytes: len,srcB: Buffer.from(sSvg,'utf8'),sSvg };} if(!b64) return { ok: false as const,reason: 'format' as const };
const b=Buffer.from(b64,'base64'),n=b.byteLength;
if(n===0||n > MAX_LOGO) return { ok: false as const,reason: (n > MAX_LOGO?'size':'format') as 'size' | 'format' };
const ok=(ct==='image/png'&&n >= 24&&b[0]===0x89&&b[1]===0x50&&b[2]===0x4e&&b[3]===0x47&&b.subarray(12,16).toString('ascii')==='IHDR')
|| (ct==='image/jpeg'&&n >= 4&&b[0]===0xff&&b[1]===0xd8&&b[2]===0xff)
|| (ct==='image/webp'&&n >= 12&&b.subarray(0,4).toString('ascii')==='RIFF'&&b.subarray(8,12).toString('ascii')==='WEBP');
return ok?{ ok: true as const,bytes: n,srcB: b }:{ ok: false as const,reason: 'format' as const };}
function decodeLogoRgba(ct: string,src: Buffer,svg?: string) {
 if(ct==='image/png'&&src.length>=29){
  try {
   const w=Math.max(1,Math.min(1024,src.readUInt32BE(16))),h=Math.max(1,Math.min(1024,src.readUInt32BE(20))),bd=src[24]!,cT=src[25]!;
   const ch=cT===6?4:cT===2?3:cT===4?2:1,bpp=Math.max(1,(ch*bd)>>3),st=Math.ceil((w*ch*bd)/8),idats:Buffer[]=[];
   let plte:Buffer|null=null,trns:Buffer|null=null;
   for(let p=8;p+8<=src.length;){const l=src.readUInt32BE(p),tp=src.subarray(p+4,p+8).toString('ascii');if(tp==='IDAT'&&p+8+l<=src.length)idats.push(src.subarray(p+8,p+8+l));else if(tp==='PLTE'&&p+8+l<=src.length)plte=src.subarray(p+8,p+8+l);else if(tp==='tRNS'&&p+8+l<=src.length)trns=src.subarray(p+8,p+8+l);p+=12+l;}
   const raw=inflateSync(Buffer.concat(idats)),rec=new Uint8Array(h*st),rgba=new Uint8Array(w*h*4);
   for(let y=0;y<h;y++){const f=raw[y*(st+1)]??0,rO=y*(st+1)+1,oO=y*st;for(let i=0;i<st;i++){const x=raw[rO+i]??0,a=i>=bpp?rec[oO+i-bpp]!:0,b=y>0?rec[oO-st+i]!:0,c=y>0&&i>=bpp?rec[oO-st+i-bpp]!:0,pa=Math.abs(b-c),pb=Math.abs(a-c),pc=Math.abs(a+b-2*c);rec[oO+i]=(x+(f===1?a:f===2?b:f===3?(a+b)>>1:f===4?(pa<=pb&&pa<=pc?a:pb<=pc?b:c):0))&0xff;}}
   for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const d=(y*w+x)*4,bo=x*bd,v0=bd<8?(rec[y*st+(bo>>3)]!>>(8-bd-(bo&7)))&((1<<bd)-1):rec[y*st+x*bpp]!;
    if(cT===3&&plte){const pi=v0*3;rgba.set([plte[pi]??0,plte[pi+1]??0,plte[pi+2]??0,trns?.[v0]??255],d);}
    else{const o=y*st+x*bpp;rgba.set([v0,ch>=3?rec[o+1]!:v0,ch>=3?rec[o+2]!:v0,ch===4?rec[o+3]!:ch===2?rec[o+1]!:255],d);}
   }
   return {w,h,rgba};
  } catch {}
 }
 if(ct==='image/webp'&&src.length>=26&&src.subarray(12,16).toString('ascii')==='VP8L'&&src[20]===0x2f){const wp=decodeVp8lFull(src);if(wp)return wp;}
 if(ct==='image/jpeg'){const jp=decodeJpegFull(src);if(jp)return jp;}
 const sTxt=svg??(ct==='image/svg+xml'?src.toString('utf8'):''),ga=(t:string,n:string,df:number)=>{const m=t.match(new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)`)),v=m?parseFloat(m[1]!):NaN;return Number.isNaN(v)?df:v;};
 const sw=Math.max(1,Math.min(256,ga(sTxt,'width',64)||64)),sh=Math.max(1,Math.min(256,ga(sTxt,'height',64)||64)),rgba=new Uint8Array(sw*sh*4),hd=createHash('sha256').update(src).digest();
 let painted=false;
 for(const m of sTxt.matchAll(/<(svg|rect|circle)\b([^>]*)>/gi)){
  const tp=m[1]!.toLowerCase(),at=m[2]!,cm=at.match(/#([0-9a-f]{6})/i);if(!cm)continue;
  const c=[parseInt(cm[1]!.slice(0,2),16),parseInt(cm[1]!.slice(2,4),16),parseInt(cm[1]!.slice(4,6),16),255];painted=true;
  if(tp==='circle'){const cx=ga(at,'cx',sw/2),cy=ga(at,'cy',sh/2),r=ga(at,'r',Math.min(sw,sh)/2);if(r>0)for(let y=0;y<sh;y++)for(let x=0;x<sw;x++)if((x-cx)**2+(y-cy)**2<=r*r)rgba.set(c,(y*sw+x)*4);}
  else{const rx=ga(at,'x',0),ry=ga(at,'y',0),rw=ga(at,'width',sw),rh=ga(at,'height',sh);for(let y=Math.max(0,ry);y<Math.min(sh,ry+rh);y++)for(let x=Math.max(0,rx);x<Math.min(sw,rx+rw);x++)rgba.set(c,(y*sw+x)*4);}
 }
 if(!painted)for(let i=0;i<sw*sh;i++){const b=src[i%src.length]??0;rgba.set([(hd[0]!+b)&255,(hd[1]!+(b>>1))&255,(hd[2]!^b)&255,255],i*4);}
 return {w:sw,h:sh,rgba};
}
function makeRenditionBlob(orgId: string,dim: 64 | 128 | 256,src: Buffer,ct='image/png',svg?: string) {
const dec=decodeLogoRgba(ct,src,svg),dst=new Uint8Array(dim * dim * 4);for(let y=0;y < dim;y++) {
const sy=Math.min(dec.h-1,Math.floor((y * dec.h) / dim));
for(let x=0;x < dim;x++) { const o=(sy * dec.w+Math.min(dec.w-1,Math.floor((x * dec.w) / dim))) * 4;dst.set(dec.rgba.subarray(o,o+4),(y * dim+x) * 4);}
} let bitBuf=0n,bitCnt=0;const hdr=((dim-1) & 0x3fff) | (((dim-1) & 0x3fff) << 14) | (1 << 28);
const bytes=[0x2f,hdr & 0xff,(hdr >> 8) & 0xff,(hdr >> 16) & 0xff,(hdr >> 24) & 0xff];
const put=(v: number,n: number) => { bitBuf |= BigInt(v) << BigInt(bitCnt);bitCnt += n;while (bitCnt >= 8) { bytes.push(Number(bitBuf & 0xffn));bitBuf >>= 8n;bitCnt -= 8;} };
const rev8=(x: number) => { let r=0;for(let i=0;i < 8;i++) r=(r << 1) | ((x >> i) & 1);return r;};put(0,3);
for(let t=0;t < 4;t++) { put(0,1);put(8,4);for(let i=0;i < 12;i++) put(i===2||i===11?1:0,3);
if(t===0) { put(1,1);put(3,3);put(254,8);} else put(0,1);for(let i=0;i < 256;i++) put(1,1);} put(1,1);put(0,3);
for(let i=0;i < dim * dim;i++) { const o=i * 4;
put(rev8(dst[o+1]!),8);put(rev8(dst[o]!),8);put(rev8(dst[o+2]!),8);put(rev8(dst[o+3]!),8);}
if(bitCnt > 0) bytes.push(Number(bitBuf & 0xffn));const vp8l=Buffer.from(bytes),pad=vp8l.length & 1,p=Buffer.alloc(20+vp8l.length+pad);
p.write('RIFF',0,'ascii');p.writeUInt32LE(12+vp8l.length+pad,4);p.write('WEBPVP8L',8,'ascii');p.writeUInt32LE(vp8l.length,16);vp8l.copy(p,20);
return { object_key: `orgs/${orgId}/logo/${dim}.webp`,width: dim,height: dim,content_type: 'image/webp',byte_length: p.byteLength,sha256: createHash('sha256').update(p).digest('hex'),data_base64: p.toString('base64') };
}
export function executeOrgLogoOrWorkspaceCreate(s: OrgChannelSlice3State,caller: McpCallerAuth,ctx: CallerContext,org: OrganizationSummary,name: string,args: Record<string,unknown>,now: string): Record<string,unknown> {
if(name==='workspace_create') { const slug=norm(String(args.slug)),wsName=String(args.name).trim();
if(!SLUG_RE.test(slug)||!wsName) return ref('INVALID_WORKSPACE_SLUG','valid_workspace_slug',{ org: org.slug,workspace: slug });
if(s.workspaces.some((w) => w.org_id===org.id&&norm(w.slug)===slug&&isLive(w))) return ref('WORKSPACE_SLUG_TAKEN','unique_workspace_slug_in_org',{ org: org.slug,workspace: slug });
const ws={ workspace_id: `ws-${s.workspaces.length+1}`,org_id: org.id,slug,name: wsName,archived_at: null };s.workspaces.push(ws);
upsertWsGrant(s,ws.workspace_id,org.id,caller.principal_kind,caller.principal_id,'owner',now,caller.principal_id);
if(caller.principal_kind==='agent') { const ownerId=agentOwner(s,ctx);
if(ownerId) upsertWsGrant(s,ws.workspace_id,org.id,'user',ownerId,'owner',now,ownerId);}
const genCh: ChannelSummary & { is_default: boolean }={ channel_id: `ch-${s.channels.length+1}`,workspace_id: ws.workspace_id,org_id: org.id,slug: 'general',visibility: 'workspace',join_policy: 'open',is_default: true,created_at: now };
s.channels.push(genCh);return { ok: true,workspace: ws,default_channel: genCh };} if(name==='org_logo_upload') {
const ct=String(args.content_type),chk=checkLogo(ct,args.data_base64 as string | undefined,args.svg as string | undefined);
if(!chk.ok) return ref(chk.reason==='size'?'LOGO_TOO_LARGE':'INVALID_LOGO_FORMAT',chk.reason==='size'?'logo_under_1mb':'valid_png_jpeg_webp_svg',{ org: org.slug });
s.orgLogos=s.orgLogos ?? {};const mB=(d: 64 | 128 | 256) => makeRenditionBlob(org.id,d,chk.srcB,ct,chk.sSvg);
const rb={ '64': mB(64),'128': mB(128),'256': mB(256) },renditions={ '64': rb['64'].object_key,'128': rb['128'].object_key,'256': rb['256'].object_key };
const logo={ org_id: org.id,object_key: renditions['256'],content_type: ct as 'image/png',byte_length: chk.bytes,renditions,rendition_blobs: rb,...(chk.sSvg?{ sanitized_svg: chk.sSvg }:{}),updated_at: now };
s.orgLogos[org.id]=logo;org.logo_object_key=logo.object_key;org.logo_updated_at=now;return { ok: true,org_id: org.id,logo };}
if(s.orgLogos) delete s.orgLogos[org.id];org.logo_object_key=null;org.logo_updated_at=now;return { ok: true,org_id: org.id,logo: null };}
function decodeVp8lFull(src:Uint8Array):{w:number;h:number;rgba:Uint8Array}|null {
try {
const hdr=(src[21]!|(src[22]!<<8)|(src[23]!<<16)|(src[24]!<<24))>>>0,w=(hdr&0x3fff)+1,h=((hdr>>14)&0x3fff)+1;
let pos=200;const rb=(n:number)=>{let v=0;for(let i=0;i<n;i++,pos++)v|=(((src[pos>>3]??0)>>(pos&7))&1)<<i;return v;};
const KO=[17,18,0,1,2,3,4,5,16,6,7,8,9,10,11,12,13,14,15],DM=Buffer.from('FwgYFicJKCYZFSklNwo4NhoUOTUqJEcLSEYbEzo0SUUrI1dKRDszDFhWHBJZVSwiS0NaVDwyZw1oZh0RaWUtIVtTTEJqZD0xdw54dlxSHhBrY01BeXUuIHp0PjBsYl1RD3tzTkAfL21hP3xyXlBPfXFuYF9+cG9/','base64');
const bT=(ln:number[])=>{const mx=Math.max(0,...ln);if(!mx)return new Map([[`0:0`,0]]);const bc=Array(mx+1).fill(0),nc=Array(mx+1).fill(0),mp=new Map<string,number>();ln.forEach(l=>l&&bc[l]++);for(let b=1,c=0;b<=mx;b++){c=(c+bc[b-1]!)<<1;nc[b]=c;}ln.forEach((l,s)=>{if(l){let c=nc[l]++,rc=0;for(let b=0;b<l;b++)if((c>>(l-1-b))&1)rc|=1<<b;mp.set(`${l}:${rc}`,s);}});return mp;};
const rS=(mp:Map<string,number>)=>{if(mp.has(`0:0`))return mp.get(`0:0`)!;for(let l=1,c=0;l<16;l++){c|=rb(1)<<(l-1);const v=mp.get(`${l}:${c}`);if(v!==undefined)return v;}return 0;};
const rH=(asz:number)=>{if(rb(1)){const ns=rb(1)+1,s0=rb(rb(1)?8:1);return ns===1?new Map([[`0:0`,s0]]):new Map([[`1:0`,s0],[`1:1`,rb(8)]]);}const ncl=rb(4)+4,cl=Array(19).fill(0);for(let i=0;i<ncl;i++)cl[KO[i]!]=rb(3);const ct=bT(cl);let ms=rb(1)?2+rb(2+2*rb(3)):asz,pr=8;const ln:number[]=[];while(ln.length<asz&&ms-->0){const c=rS(ct);if(c<16){ln.push(c);if(c)pr=c;}else{const rp=c===16?rb(2)+3:c===17?rb(3)+3:rb(7)+11,v=c===16?pr:0;for(let k=0;k<rp;k++)ln.push(v);}}while(ln.length<asz)ln.push(0);return bT(ln.slice(0,asz));};
const rSub=(iw:number,ih:number,mn:boolean)=>{const cb=rb(1)?rb(4):0,cc=cb?Array.from({length:1<<cb},()=>[0,0,0,0]):null;if(mn&&rb(1))rb(3);const tr=[256+24+(cb?1<<cb:0),256,256,256,40].map(rH),rE=(s:number)=>{if(s<4)return s+1;const eb=(s-2)>>1;return((2+(s&1))<<eb)+rb(eb)+1;},px:number[][]=[],inC=(p:number[])=>{if(cc){const v=(((p[0]!<<24)|(p[1]!<<16)|(p[2]!<<8)|p[3]!)>>>0);cc[Math.imul(v,0x1e35a7bd)>>>(32-cb)]=p;}};while(px.length<iw*ih){const s=rS(tr[0]!);if(s<256){const r=rS(tr[1]!),b=rS(tr[2]!),a=rS(tr[3]!),p=[a,r,s,b];px.push(p);inC(p);}else if(s<280){const ln=rE(s-256),dc=rE(rS(tr[4]!)),dm=dc<=120?(DM[dc-1]??17):0,dt=dm?Math.max(1,(dm>>4)*iw+(dm&15)-7):dc-120;for(let k=0;k<ln&&px.length<iw*ih;k++){const p=[...(px[px.length-dt]??[255,0,0,0])];px.push(p);inC(p);}}else{const p=[...(cc?.[s-280]??[255,0,0,0])];px.push(p);inC(p);}}return px;};
const tfs:Array<[string,unknown]>=[];let cw=w;
while(rb(1)){const tt=rb(2);if(tt<2){const sb=rb(3)+2,bw=(cw+(1<<sb)-1)>>sb,bh=(h+(1<<sb)-1)>>sb;tfs.push([tt?`c`:`r`,[sb,bw,rSub(bw,bh,false)]]);}else if(tt===2)tfs.push([`g`,0]);else{const nc=rb(8)+1,pl=rSub(nc,1,false);for(let i=1;i<pl.length;i++)pl[i]=pl[i]!.map((v,k)=>(v+pl[i-1]![k]!)&255);const b=nc<=2?1:nc<=4?2:nc<=16?4:8,xs=8/b,ow=cw;cw=Math.ceil(cw/xs);tfs.push([`p`,[pl,b,ow,cw]]);}}
let px=rSub(cw,h,true);const av=(u:number[],v:number[])=>u.map((x,k)=>(x+v[k]!)>>1),cl=(v:number)=>Math.max(0,Math.min(255,v)),s8=(v:number)=>v>127?v-256:v;
for(const [tn,td] of tfs.reverse()){if(tn===`p`){const [pl,b,ow,pw]=td as [number[][],number,number,number],xs=8/b,mk=(1<<b)-1,o:number[][]=[];for(let y=0;y<h;y++)for(let x=0;x<ow;x++)o.push(pl[(px[y*pw+Math.floor(x/xs)]![2]!>>((x%xs)*b))&mk]??[255,0,0,0]);px=o;cw=ow;}else if(tn===`g`)px=px.map(([a,r,g,b])=>[a!,(r!+g!)&255,g!,(b!+g!)&255]);else if(tn===`c`){const [sb,bw,bl]=td as [number,number,number[][]];for(let y=0;y<h;y++)for(let x=0;x<cw;x++){const p=px[y*cw+x]!,m=bl[(y>>sb)*bw+(x>>sb)]!,g=s8(p[2]!),r=(p[1]!+((s8(m[3]!)*g)>>5))&255,b=(p[3]!+((s8(m[2]!)*g)>>5)+((s8(m[1]!)*s8(r))>>5))&255;p[1]=r;p[3]=b;}}else{const [sb,bw,bl]=td as [number,number,number[][]];for(let y=0;y<h;y++)for(let x=0;x<cw;x++){const i=y*cw+x,p=px[i]!;let pr=[255,0,0,0];if(y===0){if(x>0)pr=px[i-1]!;}else if(x===0)pr=px[i-cw]!;else{const L=px[i-1]!,T=px[i-cw]!,TL=px[i-cw-1]!,TR=x+1<cw?px[i-cw+1]!:px[y*cw]!,md=bl[(y>>sb)*bw+(x>>sb)]![2]!&15;pr=md===0?[255,0,0,0]:md===1?L:md===2?T:md===3?TR:md===4?TL:md===5?av(av(L,TR),T):md===6?av(L,TL):md===7?av(L,T):md===8?av(TL,T):md===9?av(T,TR):md===10?av(av(L,TL),av(T,TR)):md===11?(L.reduce((s,v,k)=>s+Math.abs(T[k]!-TL[k]!),0)<L.reduce((s,v,k)=>s+Math.abs(v-TL[k]!),0)?L:T):md===12?L.map((v,k)=>cl(v+T[k]!-TL[k]!)):av(L,T).map((v,k)=>cl(v+Math.trunc((v-TL[k]!)/2)));}for(let k=0;k<4;k++)p[k]=(p[k]!+pr[k]!)&255;}}}
const rgba=new Uint8Array(w*h*4);px.forEach(([a,r,g,b],i)=>rgba.set([r!,g!,b!,a!],i*4));return {w,h,rgba};
} catch { return null;}
}
