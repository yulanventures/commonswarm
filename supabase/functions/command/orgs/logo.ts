import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { type CallerContext, fail } from '../../../../src/protocol/org-channels-contract.js';
import { decodePng } from './crud.js';
import {
 type OrgAuthorityState, type OrgSqlExecutor,
 authorizeOrgAction, execOrgSql, findLiveOrg, registerOrgActionExecutor, syncLockedOrgRows, withOrgTx,
} from './invites.js';
import { decodeJpeg, encodeJpeg } from './members.js';
import { CLO, decodeWebp } from './workspace-grants.js';
export const ORG_LOGO_MAX_BYTES = 1_048_576;
export const ORG_LOGO_RENDITION_SIZES = [64, 128, 256] as const;
export const ORG_LOGO_ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type OrgLogoContentType = (typeof ORG_LOGO_ALLOWED_CONTENT_TYPES)[number];
export interface OrgLogoPendingUpload {
 upload_id: string; org_id: string; content_type: OrgLogoContentType;
 max_bytes: number; object_prefix: string; rendition_keys: { 64: string; 128: string; 256: string };
 requested_by: string; created_at: string; finalized_at?: string | null;
}
export interface OrgLogoObjectRecord {
 key: string; org_id: string; size: 64 | 128 | 256; width?: number; height?: number;
 content_type: string; byte_length: number; sha256: string; data: Uint8Array | string;
}
const SVG_TAGS: Record<string, string> = {
 svg: 'svg', g: 'g', path: 'path', rect: 'rect', circle: 'circle', ellipse: 'ellipse',
 line: 'line', polyline: 'polyline', polygon: 'polygon', defs: 'defs',
 lineargradient: 'linearGradient', radialgradient: 'radialGradient', stop: 'stop',
 clippath: 'clipPath', title: 'title', desc: 'desc',
};
const SVG_ATTRS = new Set('xmlns,viewbox,width,height,x,y,x1,y1,x2,y2,cx,cy,r,rx,ry,d,points,fill,fill-rule,fill-opacity,stroke,stroke-width,stroke-linecap,stroke-linejoin,stroke-dasharray,stroke-dashoffset,stroke-miterlimit,stroke-opacity,opacity,transform,id,class,clip-path,gradientunits,gradienttransform,spreadmethod,offset,stop-color,stop-opacity,preserveaspectratio,version,role,aria-label,aria-hidden,focusable,style,data-rendition'.split(','));
const BAD_SVG_RE = /<(script|foreignObject|style|iframe|object|embed|image|use|a|animate|animateTransform|animateMotion|set|feImage|handler|listener|audio|video)\b[^>]*>[\s\S]*?<\/\1>|<(?:script|foreignObject|style|iframe|object|embed|image|use|a|animate|animateTransform|animateMotion|set|feImage|handler|listener|audio|video)\b[^>]*\/?>/gi;
const extFor = (ct: OrgLogoContentType): 'png' | 'jpg' | 'webp' | 'svg' => ct === 'image/png' ? 'png' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/webp' ? 'webp' : 'svg';
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
function decEntCss(v: string): string {
 return v.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 0))
  .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10) || 0))
  .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
  .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&')
  .replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 0)).replace(/\\(.)/g, '$1');
}
function isUnsafeAttr(raw: string): boolean {
 if (/&#/i.test(raw)) return true;
 const d = decEntCss(raw).replace(/\/\*[\s\S]*?\*\//g, '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
 if (/(?:javascript|vbscript|data|http|https|ftp|file):|\/\/|@import|expression\(|-moz-binding|behavior:/i.test(d)) return true;
 const u = d.match(/url\(([^)]*)\)/gi);
 return Boolean(u?.some((m) => !/^#[a-z0-9_-]+$/i.test(m.slice(4, -1).replace(/^['"]|['"]$/g, ''))));
}
export function sanitizeOrgLogoSvg(rawSvg: string): { sanitized: string; stripped: boolean } {
 let s = rawSvg, stripped = false, ok = true, root = false;
 const mark = (n: string) => { if (n !== s) stripped = true; s = n; };
 mark(s.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!ENTITY[\s\S]*?>|<!--[\s\S]*?-->|<![a-z[][\s\S]*?>/gi, ''));
 mark(s.replace(BAD_SVG_RE, ''));
 const st: string[] = [];
 s = s.replace(/<(\/?)([a-zA-Z0-9:_-]+)([^>]*)>/g, (_f, sl: string, rt: string, rest: string) => {
  const tag = SVG_TAGS[rt.toLowerCase()];
  if (!tag || rt.includes(':')) { stripped = true; return ''; }
  if (sl === '/') { if (st.pop() !== tag) ok = false; return `</${tag}>`; }
  const sc = /\/\s*$/.test(rest), ap = sc ? rest.replace(/\/\s*$/, '') : rest;
  if (tag === 'svg' && !st.length) root = true;
  if (!sc) st.push(tag);
  const kept: string[] = [], re = /([a-zA-Z0-9:_-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m: RegExpExecArray | null, hasNs = false;
  while ((m = re.exec(ap)) !== null) {
   const nm = m[1]!, low = nm.toLowerCase(), val = m[2] ?? m[3] ?? m[4] ?? '';
   if (low === 'xmlns') {
    if (tag === 'svg' && val.trim() === 'http://www.w3.org/2000/svg') { hasNs = true; kept.push('xmlns="http://www.w3.org/2000/svg"'); }
    else stripped = true;
    continue;
   }
   if (low.includes(':') || low.startsWith('on') || low === 'href' || low === 'src' || !SVG_ATTRS.has(low) || isUnsafeAttr(val)) { stripped = true; continue; }
   kept.push(`${nm}="${val.replace(/"/g, '&quot;')}"`);
  }
  if (tag === 'svg' && !hasNs) kept.unshift('xmlns="http://www.w3.org/2000/svg"');
  return `<${tag}${kept.length ? ` ${kept.join(' ')}` : ''}${sc ? '/>' : '>'}`;
 });
 return !ok || !root || st.length ? { sanitized: '', stripped: true } : { sanitized: s.trim(), stripped };
}
export function resizeSvgRendition(svgText: string, size: 64 | 128 | 256): string {
 return svgText.replace(/<svg\b([^>]*)>/i, (_f, attrs: string) => {
  const sc = /\/\s*$/.test(attrs), b = sc ? attrs.replace(/\/\s*$/, '') : attrs;
  const w = b.match(/\bwidth\s*=\s*"([0-9.]+)"/i)?.[1] ?? size, h = b.match(/\bheight\s*=\s*"([0-9.]+)"/i)?.[1] ?? size;
  const cl = b.replace(/\s*\b(?:width|height|data-rendition)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').trim();
  const ns = /\bxmlns\s*=/i.test(cl) ? '' : ' xmlns="http://www.w3.org/2000/svg"';
  const vb = /\bviewBox\s*=\s*"[^"]*"/i.test(b) ? '' : ` viewBox="0 0 ${w} ${h}"`;
  return `<svg${ns}${cl ? ` ${cl}` : ''}${vb} width="${size}" height="${size}" data-rendition="${size}x${size}"${sc ? '/>' : '>'}`;
 });
}
function pngChunk(t: string, d: Uint8Array): Uint8Array {
 const o = new Uint8Array(12 + d.byteLength), dv = new DataView(o.buffer);
 dv.setUint32(0, d.byteLength); for (let i = 0; i < 4; i++) o[4 + i] = t.charCodeAt(i);
 o.set(d, 8); dv.setUint32(8 + d.byteLength, crc32(o.subarray(4, 8 + d.byteLength)) >>> 0);
 return o;
}
function encodeWebp(rgba: Uint8Array, sz: number): Uint8Array {
 const bytes = [0x2f]; let bb = 0, bc = 0;
 const pb = (v: number, n: number) => { for (let i = 0; i < n; i++) { bb |= ((v >> i) & 1) << bc; if (++bc === 8) { bytes.push(bb); bb = 0; bc = 0; } } };
 pb(sz - 1, 14); pb(sz - 1, 14); pb(1, 1); pb(0, 3); pb(0, 3);
 for (const tail of [true, false, false, false]) {
  pb(0, 1); pb(8, 4);
  for (let i = 0; i < 12; i++) { const s = CLO[i]!; pb(s === 8 || (tail && s === 0) ? 1 : 0, 3); }
  pb(0, 1);
  if (tail) { for (let k = 0; k < 256; k++) pb(1, 1); for (let k = 0; k < 24; k++) pb(0, 1); }
 }
 pb(1, 1); pb(0, 3);
 const rv = (b: number) => { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((b >> i) & 1); return r; };
 for (let i = 0; i < sz * sz; i++) { pb(rv(rgba[i * 4 + 1]!), 8); pb(rv(rgba[i * 4]!), 8); pb(rv(rgba[i * 4 + 2]!), 8); pb(rv(rgba[i * 4 + 3]!), 8); }
 if (bc) bytes.push(bb);
 const vp = new Uint8Array(bytes), pad = vp.byteLength & 1, o = new Uint8Array(20 + vp.byteLength + pad), dv = new DataView(o.buffer);
 dv.setUint32(0, 0x52494646); dv.setUint32(4, 12 + vp.byteLength + pad, true); dv.setUint32(8, 0x57454250); dv.setUint32(12, 0x5650384c); dv.setUint32(16, vp.byteLength, true);
 o.set(vp, 20); return o;
}
export function decodeRasterLogo(raw: Uint8Array, ct: 'image/png' | 'image/jpeg' | 'image/webp') {
 return ct === 'image/png' ? decodePng(raw) : ct === 'image/jpeg' ? decodeJpeg(raw) : decodeWebp(raw);
}
export function resizeRasterRendition(raw: Uint8Array, ct: 'image/png' | 'image/jpeg' | 'image/webp', size: 64 | 128 | 256): Uint8Array {
 const dec = decodeRasterLogo(raw, ct) ?? decodePng(raw) ?? decodeJpeg(raw) ?? decodeWebp(raw);
 if (!dec) throw new Error(`Invalid ${ct} raster logo`);
 const rgba = new Uint8Array(size * size * 4);
 for (let y = 0; y < size; y++) {
  const sy = Math.min(dec.height - 1, Math.floor((y * dec.height) / size));
  for (let x = 0; x < size; x++) {
   const sx = Math.min(dec.width - 1, Math.floor((x * dec.width) / size));
   rgba.set(dec.rgba.subarray((sy * dec.width + sx) * 4, (sy * dec.width + sx) * 4 + 4), (y * size + x) * 4);
  }
 }
 if (ct === 'image/png') {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size); ihdr[8] = 8; ihdr[9] = 6;
  const st = 1 + size * 4, scan = new Uint8Array(size * st);
  for (let y = 0; y < size; y++) scan.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * st + 1);
  return new Uint8Array(Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(deflateSync(scan))), pngChunk('IEND', new Uint8Array(0))]));
 }
 return ct === 'image/jpeg' ? encodeJpeg(rgba, size) : encodeWebp(rgba, size);
}
export function detectAndVerifyOrgLogo(inputBytes: Uint8Array | string, declaredType?: string | null, orgSlug?: string | null) {
 const scope = { org: orgSlug ?? null }, raw = typeof inputBytes === 'string' ? new TextEncoder().encode(inputBytes) : inputBytes;
 if (raw.byteLength === 0) return fail('ORG_LOGO_EMPTY', 'non_empty_logo_bytes', scope);
 if (raw.byteLength > ORG_LOGO_MAX_BYTES) return fail('ORG_LOGO_TOO_LARGE', 'logo_size_lte_1mb', scope);
 let detected: OrgLogoContentType | null = null, svgText: string | null = null, stripped = false;
 if (raw.byteLength >= 8 && raw[0] === 0x89 && raw[1] === 0x50 && raw[2] === 0x4e && raw[3] === 0x47 && raw[4] === 0x0d && raw[5] === 0x0a && raw[6] === 0x1a && raw[7] === 0x0a) detected = 'image/png';
 else if (raw.byteLength >= 3 && raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) detected = 'image/jpeg';
 else if (raw.byteLength >= 12 && raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46 && raw[8] === 0x57 && raw[9] === 0x45 && raw[10] === 0x42 && raw[11] === 0x50) detected = 'image/webp';
 else if (!raw.includes(0)) {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
  if (/<svg[\s>]/i.test(text) && (/<\/svg>/i.test(text) || /<svg[^>]*\/>/i.test(text))) {
   const cl = sanitizeOrgLogoSvg(text);
   if (cl.sanitized && /<svg[\s>]/i.test(cl.sanitized)) { detected = 'image/svg+xml'; svgText = cl.sanitized; stripped = cl.stripped; }
  }
 }
 if (!detected) return fail('ORG_LOGO_INVALID_FORMAT', 'png_jpeg_webp_or_svg_magic_bytes', scope);
 if (declaredType && declaredType !== detected) return fail('ORG_LOGO_MAGIC_BYTE_MISMATCH', `matching_${detected}_magic_bytes`, scope);
 if (detected !== 'image/svg+xml' && !decodeRasterLogo(raw, detected)) return fail('ORG_LOGO_INVALID_FORMAT', 'valid_decodable_raster_image', scope);
 return { ok: true as const, content_type: detected, ext: extFor(detected), bytes: svgText !== null ? new TextEncoder().encode(svgText) : raw, svg_text: svgText, sanitized: stripped };
}
function authLogo(s: OrgAuthorityState, c: CallerContext, input: { org_id: string; require_approval?: boolean; now?: string } & Record<string, unknown>, kind: string, tx?: OrgSqlExecutor) {
 const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
 if (!org) return { ok: false as const, res: fail('ORG_NOT_FOUND', 'organization', { org: input.org_id }) };
 syncLockedOrgRows(s, org.id, tx);
 const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: kind, payload: { ...input }, require_approval: input.require_approval, now, db: tx });
 return auth.status === 'authorized' ? { ok: true as const, now, org, actorId: auth.actor_user_id } : { ok: false as const, res: auth.result };
}
export function orgLogoUploadPrepare(
 s: OrgAuthorityState, c: CallerContext,
 input: { org_id: string; content_type: string; size_bytes?: number; require_approval?: boolean; approval_id?: string; now?: string },
 db?: OrgSqlExecutor,
) {
 return withOrgTx(s, db, (tx) => {
  const a = authLogo(s, c, input, 'org_logo_upload_prepare', tx);
  if (!a.ok) return a.res;
  const { now, org, actorId } = a;
  if (!(ORG_LOGO_ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.content_type)) return fail('ORG_LOGO_INVALID_FORMAT', 'supported_logo_content_type', { org: org.slug });
  if (input.size_bytes !== undefined) {
   if (input.size_bytes <= 0) return fail('ORG_LOGO_EMPTY', 'non_empty_logo_bytes', { org: org.slug });
   if (input.size_bytes > ORG_LOGO_MAX_BYTES) return fail('ORG_LOGO_TOO_LARGE', 'logo_size_lte_1mb', { org: org.slug });
  }
  const ct = input.content_type as OrgLogoContentType, ext = extFor(ct), pfx = `orgs/${org.id}/logo`;
  const upload: OrgLogoPendingUpload = { upload_id: crypto.randomUUID(), org_id: org.id, content_type: ct, max_bytes: ORG_LOGO_MAX_BYTES, object_prefix: pfx, rendition_keys: { 64: `${pfx}/64.${ext}`, 128: `${pfx}/128.${ext}`, 256: `${pfx}/256.${ext}` }, requested_by: actorId, created_at: now, finalized_at: null };
  (s.logoUploads ??= {})[upload.upload_id] = upload;
  return { ok: true as const, status: 'executed' as const, upload };
 });
}
export function orgLogoFinalize(
 s: OrgAuthorityState, c: CallerContext,
 input: { org_id: string; upload_id?: string; content_type?: string | null; bytes: Uint8Array | string; require_approval?: boolean; approval_id?: string; now?: string },
 db?: OrgSqlExecutor,
) {
 return withOrgTx(s, db, (tx) => {
  const a = authLogo(s, c, input, 'org_logo_finalize', tx);
  if (!a.ok) return a.res;
  const { now, org } = a, pending = input.upload_id ? s.logoUploads?.[input.upload_id] : undefined;
  if (input.upload_id && (!pending || pending.org_id !== org.id)) return fail('ORG_LOGO_UPLOAD_NOT_FOUND', 'prepared_logo_upload', { org: org.slug });
  const ver = detectAndVerifyOrgLogo(input.bytes, input.content_type ?? pending?.content_type ?? null, org.slug);
  if (!ver.ok) return ver;
  s.logoObjects ??= {};
  const pfx = `orgs/${org.id}/logo`;
  for (const k of Object.keys(s.logoObjects)) if (k.startsWith(`${pfx}/`)) { delete s.logoObjects[k]; tx?.storage?.delete?.(k); }
  execOrgSql(tx, 'DELETE FROM swarm.org_logo_objects WHERE org_id = $1', [org.id]);
  const renditions = { 64: `${pfx}/64.${ver.ext}`, 128: `${pfx}/128.${ver.ext}`, 256: `${pfx}/256.${ver.ext}` };
  for (const size of ORG_LOGO_RENDITION_SIZES) {
   const key = renditions[size], data = ver.svg_text !== null ? resizeSvgRendition(ver.svg_text, size) : resizeRasterRendition(ver.bytes, ver.content_type as 'image/png' | 'image/jpeg' | 'image/webp', size);
   const enc = typeof data === 'string' ? new TextEncoder().encode(data) : data, sha = sha256Hex(enc);
   s.logoObjects[key] = { key, org_id: org.id, size, width: size, height: size, content_type: ver.content_type, byte_length: enc.byteLength, sha256: sha, data };
   tx?.storage?.put?.(key, data, ver.content_type);
   execOrgSql(tx, 'INSERT INTO swarm.org_logo_objects (object_key, org_id, size_px, content_type, byte_length, sha256, bytes, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (object_key) DO UPDATE SET content_type = EXCLUDED.content_type, byte_length = EXCLUDED.byte_length, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes, created_at = EXCLUDED.created_at', [key, org.id, size, ver.content_type, enc.byteLength, sha, enc, now]);
  }
  if (pending) pending.finalized_at = now;
  org.logo_object_key = renditions[256]; org.logo_updated_at = now; org.updated_at = now;
  execOrgSql(tx, 'UPDATE swarm.organizations SET logo_object_key = $2, logo_updated_at = $3, updated_at = $3 WHERE id = $1', [org.id, org.logo_object_key, now]);
  return { ok: true as const, status: 'executed' as const, organization: org, content_type: ver.content_type, sanitized: ver.sanitized, logo_object_key: org.logo_object_key, renditions };
 });
}
export function orgLogoRemove(
 s: OrgAuthorityState, c: CallerContext,
 input: { org_id: string; require_approval?: boolean; approval_id?: string; now?: string },
 db?: OrgSqlExecutor,
) {
 return withOrgTx(s, db, (tx) => {
  const a = authLogo(s, c, input, 'org_logo_remove', tx);
  if (!a.ok) return a.res;
  const { now, org } = a, pfx = `orgs/${org.id}/logo/`, removedKeys: string[] = [];
  if (s.logoObjects) for (const k of Object.keys(s.logoObjects)) if (k.startsWith(pfx)) { removedKeys.push(k); delete s.logoObjects[k]; tx?.storage?.delete?.(k); }
  execOrgSql(tx, 'DELETE FROM swarm.org_logo_objects WHERE org_id = $1', [org.id]);
  org.logo_object_key = null; org.logo_updated_at = now; org.updated_at = now;
  execOrgSql(tx, 'UPDATE swarm.organizations SET logo_object_key = NULL, logo_updated_at = $2, updated_at = $2 WHERE id = $1', [org.id, now]);
  return { ok: true as const, status: 'executed' as const, organization: org, removed_keys: removedKeys };
 });
}
registerOrgActionExecutor('org_logo_upload_prepare', (s, c, p, db) => orgLogoUploadPrepare(s, c, p as Parameters<typeof orgLogoUploadPrepare>[2], db));
registerOrgActionExecutor('org_logo_finalize', (s, c, p, db) => orgLogoFinalize(s, c, p as Parameters<typeof orgLogoFinalize>[2], db));
registerOrgActionExecutor('org_logo_remove', (s, c, p, db) => orgLogoRemove(s, c, p as Parameters<typeof orgLogoRemove>[2], db));
export const org_logo_upload_prepare = orgLogoUploadPrepare;
export const org_logo_finalize = orgLogoFinalize;
export const org_logo_remove = orgLogoRemove;
