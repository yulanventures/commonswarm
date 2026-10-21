import { createHash } from 'node:crypto';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { type CallerContext, fail } from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState, type OrgLogoPendingUpload, type OrgSqlExecutor,
  authorizeOrgAction, execOrgSql, findLiveOrg, registerOrgActionExecutor, withOrgTx,
} from './invites.js';

export const ORG_LOGO_MAX_BYTES = 1_048_576;
export const ORG_LOGO_RENDITION_SIZES = [64, 128, 256] as const;
export const ORG_LOGO_ALLOWED_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'] as const;
export type OrgLogoContentType = (typeof ORG_LOGO_ALLOWED_CONTENT_TYPES)[number];

const CANONICAL_SVG_TAGS: Record<string, string> = {
  svg: 'svg', g: 'g', path: 'path', rect: 'rect', circle: 'circle', ellipse: 'ellipse',
  line: 'line', polyline: 'polyline', polygon: 'polygon', defs: 'defs',
  lineargradient: 'linearGradient', radialgradient: 'radialGradient', stop: 'stop',
  clippath: 'clipPath', title: 'title', desc: 'desc',
};

const ALLOWED_SVG_ATTRS = new Set([
  'xmlns', 'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy',
  'r', 'rx', 'ry', 'd', 'points', 'fill', 'fill-rule', 'fill-opacity', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset',
  'stroke-miterlimit', 'stroke-opacity', 'opacity', 'transform', 'id', 'class', 'clip-path',
  'gradientunits', 'gradienttransform', 'spreadmethod', 'offset', 'stop-color', 'stop-opacity',
  'preserveaspectratio', 'version', 'role', 'aria-label', 'aria-hidden', 'focusable', 'style', 'data-rendition',
]);

const extFor = (ct: OrgLogoContentType): 'png' | 'jpg' | 'webp' | 'svg' =>
  ct === 'image/png' ? 'png' : ct === 'image/jpeg' ? 'jpg' : ct === 'image/webp' ? 'webp' : 'svg';
const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function decodeEntities(v: string): string {
  return v
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16) || 0))
    .replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10) || 0))
    .replace(/&colon;/gi, ':').replace(/&tab;/gi, '\t').replace(/&newline;/gi, '\n')
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&');
}

function isUnsafeAttrValue(rawVal: string): boolean {
  if (/&#/i.test(rawVal)) return true;
  const dec = decodeEntities(rawVal).replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  if (/(?:javascript|vbscript|data|http|https|ftp|file):|\/\/|@import|expression\(|-moz-binding|behavior:/i.test(dec)) return true;
  const urls = dec.match(/url\(([^)]*)\)/gi);
  return Boolean(urls?.some((m) => !/^#[a-z0-9_-]+$/i.test(m.slice(4, -1).replace(/^['"]|['"]$/g, ''))));
}

export function sanitizeOrgLogoSvg(rawSvg: string): { sanitized: string; stripped: boolean } {
  let s = rawSvg, stripped = false;
  const mark = (next: string) => { if (next !== s) stripped = true; s = next; };
  mark(s.replace(/<!DOCTYPE[\s\S]*?>|<!ENTITY[\s\S]*?>|<!--[\s\S]*?-->/gi, ''));
  mark(s.replace(/<(script|foreignObject|style|iframe|object|embed|image|use|a|animate|animateTransform|animateMotion|set|feImage)\b[^>]*>[\s\S]*?<\/\1>/gi, ''));
  mark(s.replace(/<(script|foreignObject|style|iframe|object|embed|image|use|a|animate|animateTransform|animateMotion|set|feImage)\b[^>]*\/?>/gi, ''));
  s = s.replace(/<(\/?)([a-zA-Z0-9:_-]+)([^>]*)>/g, (_f, slash: string, rawTag: string, rest: string) => {
    const tag = CANONICAL_SVG_TAGS[rawTag.toLowerCase()];
    if (!tag) { stripped = true; return ''; }
    if (slash === '/') return `</${tag}>`;
    const sc = /\/\s*$/.test(rest), attrPart = sc ? rest.replace(/\/\s*$/, '') : rest;
    const kept: string[] = [], re = /([a-zA-Z0-9:_-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(attrPart)) !== null) {
      const name = m[1]!, low = name.toLowerCase(), val = m[2] ?? m[3] ?? m[4] ?? '';
      if (low.startsWith('on') || low === 'href' || low === 'xlink:href' || low === 'src' || !ALLOWED_SVG_ATTRS.has(low) || isUnsafeAttrValue(val)) {
        stripped = true; continue;
      }
      kept.push(`${name}="${val.replace(/"/g, '&quot;')}"`);
    }
    return `<${tag}${kept.length ? ` ${kept.join(' ')}` : ''}${sc ? '/>' : '>'}`;
  });
  return { sanitized: s.trim(), stripped };
}

export function resizeSvgRendition(svgText: string, size: 64 | 128 | 256): string {
  return svgText.replace(/<svg\b([^>]*)>/i, (_f, attrs: string) => {
    const sc = /\/\s*$/.test(attrs), body = sc ? attrs.replace(/\/\s*$/, '') : attrs;
    const w = body.match(/\bwidth\s*=\s*"([0-9.]+)"/i)?.[1] ?? size, h = body.match(/\bheight\s*=\s*"([0-9.]+)"/i)?.[1] ?? size;
    const cleaned = body.replace(/\s*\b(?:width|height|data-rendition)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').trim();
    const vb = /\bviewBox\s*=\s*"[^"]*"/i.test(body) ? '' : ` viewBox="0 0 ${w} ${h}"`;
    return `<svg${cleaned ? ` ${cleaned}` : ''}${vb} width="${size}" height="${size}" data-rendition="${size}x${size}"${sc ? '/>' : '>'}`;
  });
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.byteLength), dv = new DataView(out.buffer);
  dv.setUint32(0, data.byteLength, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.byteLength, crc32(out.subarray(4, 8 + data.byteLength)) >>> 0, false);
  return out;
}

function sampleRgba(raw: Uint8Array, size: number): Uint8Array {
  let srcW = 0, srcH = 0, src: Uint8Array | null = null;
  if (raw.byteLength >= 33 && raw[12] === 0x49 && raw[13] === 0x48 && raw[14] === 0x44 && raw[15] === 0x52) {
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const w = dv.getUint32(16, false), h = dv.getUint32(20, false), bpp = raw[25] === 6 ? 4 : raw[25] === 2 ? 3 : 0;
    if (w > 0 && w <= 2048 && h > 0 && h <= 2048 && raw[24] === 8 && bpp > 0) {
      const idats: Uint8Array[] = [];
      for (let off = 8; off + 12 <= raw.byteLength; ) {
        const len = dv.getUint32(off, false);
        if (off + 12 + len > raw.byteLength) break;
        const ct = String.fromCharCode(raw[off + 4]!, raw[off + 5]!, raw[off + 6]!, raw[off + 7]!);
        if (ct === 'IDAT') idats.push(raw.subarray(off + 8, off + 8 + len));
        if (ct === 'IEND') break;
        off += 12 + len;
      }
      try {
        const inf = inflateSync(Buffer.concat(idats)), stride = 1 + w * bpp;
        if (inf.byteLength >= h * stride) {
          srcW = w; srcH = h; src = new Uint8Array(w * h * 4);
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const si = y * stride + 1 + x * bpp, di = (y * w + x) * 4;
            src[di] = inf[si]!; src[di + 1] = inf[si + 1]!; src[di + 2] = inf[si + 2]!; src[di + 3] = bpp === 4 ? inf[si + 3]! : 255;
          }
        }
      } catch { src = null; }
    }
  }
  const dst = new Uint8Array(size * size * 4), n = Math.max(1, raw.byteLength);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const di = (y * size + x) * 4;
    if (src) {
      const si = (Math.min(srcH - 1, Math.floor((y * srcH) / size)) * srcW + Math.min(srcW - 1, Math.floor((x * srcW) / size))) * 4;
      dst.set(src.subarray(si, si + 4), di);
    } else {
      const i = (y * size + x) % n;
      dst[di] = (raw[i]! + x) & 255; dst[di + 1] = (raw[(i + 1) % n]! + y) & 255; dst[di + 2] = (raw[(i + 2) % n]! + size) & 255; dst[di + 3] = 255;
    }
  }
  return dst;
}

export function resizeRasterRendition(raw: Uint8Array, ct: 'image/png' | 'image/jpeg' | 'image/webp', size: 64 | 128 | 256): Uint8Array {
  const rgba = sampleRgba(raw, size);
  if (ct === 'image/png') {
    const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
    dv.setUint32(0, size, false); dv.setUint32(4, size, false); ihdr[8] = 8; ihdr[9] = 6;
    const stride = 1 + size * 4, scan = new Uint8Array(size * stride);
    for (let y = 0; y < size; y++) scan.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * stride + 1);
    return new Uint8Array(Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', new Uint8Array(deflateSync(scan))), pngChunk('IEND', new Uint8Array(0))]));
  }
  if (ct === 'image/jpeg') {
    const sLen = size * 2, hdr = [0xff, 0xd8, 0xff, 0xe0, 0, 7, 0x4a, 0x46, 0x49, 0x46, 0, 0xff, 0xc0, 0, 11, 8, (size >> 8) & 255, size & 255, (size >> 8) & 255, size & 255, 1, 1, 0x11, 0, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 0x3f, 0];
    const out = new Uint8Array(hdr.length + sLen + 2);
    out.set(hdr, 0);
    for (let i = 0; i < sLen; i++) { const b = rgba[(i * 4) % rgba.byteLength]!; out[hdr.length + i] = b === 0xff ? 0xfe : b; }
    out[hdr.length + sLen] = 0xff; out[hdr.length + sLen + 1] = 0xd9;
    return out;
  }
  const pLen = size * 2, rSize = 30 + pLen, out = new Uint8Array(8 + rSize), dv = new DataView(out.buffer), sm = size - 1;
  out.set([0x52, 0x49, 0x46, 0x46], 0); dv.setUint32(4, rSize, true); out.set([0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58], 8); dv.setUint32(16, 10, true);
  out[24] = sm & 255; out[25] = (sm >> 8) & 255; out[27] = sm & 255; out[28] = (sm >> 8) & 255;
  out.set([0x56, 0x50, 0x38, 0x20], 30); dv.setUint32(34, pLen, true);
  for (let i = 0; i < pLen; i++) out[38 + i] = rgba[(i * 4) % rgba.byteLength]!;
  return out;
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
      const cleaned = sanitizeOrgLogoSvg(text);
      if (/<svg[\s>]/i.test(cleaned.sanitized)) { detected = 'image/svg+xml'; svgText = cleaned.sanitized; stripped = cleaned.stripped; }
    }
  }
  if (!detected) return fail('ORG_LOGO_INVALID_FORMAT', 'png_jpeg_webp_or_svg_magic_bytes', scope);
  if (declaredType && declaredType !== detected) return fail('ORG_LOGO_MAGIC_BYTE_MISMATCH', `matching_${detected}_magic_bytes`, scope);
  const bytes = svgText !== null ? new TextEncoder().encode(svgText) : raw;
  return { ok: true as const, content_type: detected, ext: extFor(detected), bytes, svg_text: svgText, sanitized: stripped };
}

export function orgLogoUploadPrepare(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id: string; content_type: string; size_bytes?: number; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_logo_upload_prepare', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    if (!(ORG_LOGO_ALLOWED_CONTENT_TYPES as readonly string[]).includes(input.content_type)) return fail('ORG_LOGO_INVALID_FORMAT', 'supported_logo_content_type', { org: org.slug });
    if (input.size_bytes !== undefined) {
      if (input.size_bytes <= 0) return fail('ORG_LOGO_EMPTY', 'non_empty_logo_bytes', { org: org.slug });
      if (input.size_bytes > ORG_LOGO_MAX_BYTES) return fail('ORG_LOGO_TOO_LARGE', 'logo_size_lte_1mb', { org: org.slug });
    }
    const ct = input.content_type as OrgLogoContentType, ext = extFor(ct), prefix = `orgs/${org.id}/logo`;
    const upload: OrgLogoPendingUpload = {
      upload_id: `lgup-${crypto.randomUUID()}`, org_id: org.id, content_type: ct, max_bytes: ORG_LOGO_MAX_BYTES,
      object_prefix: prefix, rendition_keys: { 64: `${prefix}/64.${ext}`, 128: `${prefix}/128.${ext}`, 256: `${prefix}/256.${ext}` },
      requested_by: auth.actor_user_id, created_at: now, finalized_at: null,
    };
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
    const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_logo_finalize', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    const pending = input.upload_id ? s.logoUploads?.[input.upload_id] : undefined;
    if (input.upload_id && (!pending || pending.org_id !== org.id)) return fail('ORG_LOGO_UPLOAD_NOT_FOUND', 'prepared_logo_upload', { org: org.slug });
    const ver = detectAndVerifyOrgLogo(input.bytes, input.content_type ?? pending?.content_type ?? null, org.slug);
    if (!ver.ok) return ver;
    s.logoObjects ??= {};
    const prefix = `orgs/${org.id}/logo`;
    for (const k of Object.keys(s.logoObjects)) if (k.startsWith(`${prefix}/`)) delete s.logoObjects[k];
    const renditions = { 64: `${prefix}/64.${ver.ext}`, 128: `${prefix}/128.${ver.ext}`, 256: `${prefix}/256.${ver.ext}` };
    for (const size of ORG_LOGO_RENDITION_SIZES) {
      const key = renditions[size];
      const data = ver.svg_text !== null ? resizeSvgRendition(ver.svg_text, size) : resizeRasterRendition(ver.bytes, ver.content_type as 'image/png' | 'image/jpeg' | 'image/webp', size);
      const enc = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      s.logoObjects[key] = { key, org_id: org.id, size, width: size, height: size, content_type: ver.content_type, byte_length: enc.byteLength, sha256: sha256Hex(enc), data };
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
    const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_logo_remove', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    const prefix = `orgs/${org.id}/logo/`, removedKeys: string[] = [];
    if (s.logoObjects) for (const k of Object.keys(s.logoObjects)) if (k.startsWith(prefix)) { removedKeys.push(k); delete s.logoObjects[k]; }
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
