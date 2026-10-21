import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import {
  type CallerContext, type ChannelSummary, type OrgApprovalRequest, type OrganizationSummary, type OrgRole, type PrincipalKind,
  agentOwner, canReadOrg, isLive, isPrin, norm, orgRole,
} from '../../../src/protocol/org-channels-contract.js';
import { effCallerOrgRole } from '../../../src/cloud/org-channels-cli.js';
import { type McpCallerAuth, type OrgChannelSlice3State, type OrgLogoRenditionBlob, resolveMcpOrgWorkspaceChannel, resolveSeatIdFromAuthOrArgs } from './org-channels-tools.js';
import { executeWorkspaceScopeTool, ref } from './org-channels-channels.js';

export { executeWorkspaceScopeTool, ref };
export const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LOGO = 1_048_576;
export const toCtx = (c: McpCallerAuth): CallerContext => ({ principal_kind: c.principal_kind, principal_id: c.principal_id, owner_user_id: c.owner_user_id ?? null, connection_id: c.connection_id ?? null });

export function upsertWsGrant(s: OrgChannelSlice3State, wsId: string, orgId: string, k: PrincipalKind, id: string, role: OrgRole, now: string, ownerFallback: string) {
  const ex = s.workspaceGrants.find((g) => g.workspace_id === wsId && isPrin(g, k, id));
  if (ex) { ex.role = role; ex.revoked_at = null; } else s.workspaceGrants.push({ workspace_id: wsId, org_id: orgId, principal_kind: k, principal_id: id, role, created_at: now, revoked_at: null });
  if (k !== 'agent') return null;
  s.agentPrincipals = s.agentPrincipals ?? [];
  const ai = s.agentIdentities.find((a) => a.id === id);
  let ap = s.agentPrincipals.find((a) => a.workspace_id === wsId && a.agent_identity_id === id);
  if (ap) ap.revoked_at = null;
  else s.agentPrincipals.push(ap = { principal_id: `ap-${wsId}-${id}`, workspace_id: wsId, agent_identity_id: id, owner_user_id: ai?.owner_user_id ?? ownerFallback, name: ai?.display_name ?? id, revoked_at: null });
  return ap.principal_id;
}

export function resolveOrg(s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>) {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!seatRes.ok) return { ok: false as const, status: 'refused' as const, refusal: seatRes.refusal };
  const str = (v: unknown) => (typeof v === 'string' && v.trim()) || null;
  if (str(args.workspace) || str(args.channel)) {
    const r = resolveMcpOrgWorkspaceChannel(s, caller, args as Record<string, string | null | undefined>);
    return r.ok ? { ok: true as const, org: r.org, seat_id: r.seat_id } : { ok: false as const, status: 'refused' as const, refusal: r.refusal };
  }
  const seatId = seatRes.seat_id, ctx = toCtx(caller), reach = s.organizations.filter((o) => isLive(o) && canReadOrg(s, ctx, o.id));
  const seat = seatId ? (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x)) : undefined;
  const seatWs = seat ? s.workspaces.find((w) => w.workspace_id === seat.workspace_id && isLive(w)) : undefined;
  const seatOrg = seatWs ? s.organizations.find((o) => o.id === seatWs.org_id && isLive(o)) : undefined;
  const exp = str(args.org);
  const pol = caller.connection_id ? (s.connectionPolicies ?? []).find((p) => p.connection_id === caller.connection_id && isLive(p)) : undefined;
  const found = exp ? reach.find((o) => o.id === exp || norm(o.slug) === norm(exp))
    : seatOrg ?? (pol?.default_org_id ? reach.find((o) => o.id === pol.default_org_id) : undefined) ?? (reach.length === 1 ? reach[0] : undefined);
  if (exp && !found) return ref('ORG_ACCESS_DENIED', 'org_membership', { org: exp, seat_id: seatId });
  if (exp && seatOrg && found!.id !== seatOrg.id) return ref('WORKSPACE_SEAT_MISMATCH', `seat_in_${found!.slug}`, { org: found!.slug, workspace: seatWs?.slug ?? null, seat_id: seatId });
  if (!found) return ref(reach.length === 0 ? 'ORG_ACCESS_DENIED' : 'AMBIGUOUS_WORKSPACE_SELECTOR', reach.length === 0 ? 'org_membership' : 'org_selector', { seat_id: seatId });
  return { ok: true as const, org: found, seat_id: seatId };
}

export function enqueueApproval(s: OrgChannelSlice3State, caller: McpCallerAuth, org: { id: string; slug: string }, action_kind: string, payload: Record<string, unknown>, workspace_id: string | null = null) {
  const ownerId = caller.principal_kind === 'agent' ? agentOwner(s, toCtx(caller)) : null;
  if (!ownerId || orgRole(s, org.id, 'user', ownerId) !== 'owner') return ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
  s.approvalRequests = s.approvalRequests ?? [];
  const card: OrgApprovalRequest = {
    approval_id: `apr_${s.approvalRequests.length + 1}`, org_id: org.id, workspace_id, channel_id: null,
    requested_by_agent_identity_id: caller.principal_id, owner_user_id: ownerId, action_kind,
    target_scope: { org: org.slug, workspace_id }, payload, state: 'pending', created_at: new Date().toISOString(),
  };
  s.approvalRequests.push(card);
  return { ok: true as const, status: 'approval_required' as const, approval: card, approval_request: card, mcp_tool: 'org_confirm_action', cli_command: `cswarm org confirm ${card.approval_id} --approve --org ${org.slug}` };
}

const ENT: Record<string, string> = { colon: ':', tab: '\t', newline: '\n', quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
const decodeEnt = (v: string): string => v.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0)).replace(/&#([0-9]+);?/g, (_, d) => String.fromCodePoint(parseInt(d, 10) || 0)).replace(/&(colon|tab|newline|quot|apos|amp|lt|gt);/gi, (_, n: string) => ENT[n.toLowerCase()] ?? '').replace(/\\([0-9a-f]{1,6})\s?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 0));

export function checkLogo(ct: string, b64?: string, svg?: string): { ok: true; bytes: number; sourceBytes: Buffer; sanitizedSvg?: string } | { ok: false; reason: 'size' | 'format' } {
  if (ct === 'image/svg+xml') {
    const raw = (svg ?? (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '')).trim(), len = Buffer.byteLength(raw, 'utf8');
    if (len === 0 || len > MAX_LOGO) return { ok: false, reason: len > MAX_LOGO ? 'size' : 'format' };
    if (!raw.toLowerCase().includes('<svg')) return { ok: false, reason: 'format' };
    const sanitizedSvg = raw.replace(/<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').replace(/<(script|foreignObject|iframe|object|embed|image|use)[\s\S]*?>[\s\S]*?<\/\1>/gi, '').replace(/<\/?(script|foreignObject|iframe|object|embed|image|use)[^>]*>/gi, '').replace(/\son[a-z0-9_-]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s([a-z0-9_:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (full, attr, _q, dq, sq, uq) => {
      const name = String(attr).toLowerCase();
      if (name.startsWith('on')) return '';
      const val = decodeEnt(String(dq ?? sq ?? uq ?? '')).replace(/[\u0000-\u0020]+/g, '');
      if (name === 'xmlns' && val === 'http://www.w3.org/2000/svg') return full;
      if (/(javascript|data|vbscript):|https?:|\/\/|@import/i.test(val)) return name === 'style' ? ' style="url()"' : '';
      return full;
    });
    return { ok: true, bytes: len, sourceBytes: Buffer.from(sanitizedSvg, 'utf8'), sanitizedSvg };
  }
  if (!b64) return { ok: false, reason: 'format' };
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO) return { ok: false, reason: buf.byteLength > MAX_LOGO ? 'size' : 'format' };
  const png = ct === 'image/png' && buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 && buf.subarray(12, 16).toString('ascii') === 'IHDR';
  const jpg = ct === 'image/jpeg' && buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = ct === 'image/webp' && buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpg || webp ? { ok: true, bytes: buf.byteLength, sourceBytes: buf } : { ok: false, reason: 'format' };
}

function decodeLogoRgba(ct: string, src: Buffer, svg?: string): { w: number; h: number; rgba: Uint8Array } {
  if (ct === 'image/png' && src.length >= 29) {
    try {
      const w = Math.max(1, Math.min(1024, src.readUInt32BE(16))), h = Math.max(1, Math.min(1024, src.readUInt32BE(20))), cT = src[25]!;
      const bpp = cT === 6 ? 4 : cT === 2 ? 3 : cT === 4 ? 2 : 1, st = w * bpp, idats: Buffer[] = [];
      for (let p = 8; p + 8 <= src.length; ) {
        const l = src.readUInt32BE(p);
        if (src.subarray(p + 4, p + 8).toString('ascii') === 'IDAT' && p + 8 + l <= src.length) idats.push(src.subarray(p + 8, p + 8 + l));
        p += 12 + l;
      }
      const raw = inflateSync(Buffer.concat(idats)), rec = new Uint8Array(h * st), rgba = new Uint8Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        const f = raw[y * (st + 1)] ?? 0, rO = y * (st + 1) + 1, oO = y * st;
        for (let i = 0; i < st; i++) {
          const x = raw[rO + i] ?? 0, a = i >= bpp ? rec[oO + i - bpp]! : 0, b = y > 0 ? rec[oO - st + i]! : 0, c = y > 0 && i >= bpp ? rec[oO - st + i - bpp]! : 0;
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          rec[oO + i] = (x + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : 0)) & 0xff;
        }
      }
      for (let i = 0; i < w * h; i++) {
        const o = i * bpp, d = i * 4;
        rgba[d] = rec[o]!; rgba[d + 1] = bpp >= 3 ? rec[o + 1]! : rec[o]!; rgba[d + 2] = bpp >= 3 ? rec[o + 2]! : rec[o]!; rgba[d + 3] = bpp === 4 ? rec[o + 3]! : bpp === 2 ? rec[o + 1]! : 255;
      }
      return { w, h, rgba };
    } catch { /* fallback */ }
  }
  const w = 64, h = 64, rgba = new Uint8Array(w * h * 4), m = svg?.match(/#([0-9a-f]{6})/i);
  const cR = m ? parseInt(m[1]!.slice(0, 2), 16) : src[0] ?? 80, cG = m ? parseInt(m[1]!.slice(2, 4), 16) : src[1 % src.length] ?? 120, cB = m ? parseInt(m[1]!.slice(4, 6), 16) : src[2 % src.length] ?? 160;
  for (let i = 0; i < w * h; i++) {
    const b = src[i % src.length] ?? 0, d = i * 4;
    rgba[d] = (cR + b) & 0xff; rgba[d + 1] = (cG + (b >> 1)) & 0xff; rgba[d + 2] = (cB ^ b) & 0xff; rgba[d + 3] = 255;
  }
  return { w, h, rgba };
}

function makeRenditionBlob(orgId: string, dim: 64 | 128 | 256, src: Buffer, ct = 'image/png', svg?: string): OrgLogoRenditionBlob {
  const dec = decodeLogoRgba(ct, src, svg), dst = new Uint8Array(dim * dim * 4);
  for (let y = 0; y < dim; y++) {
    const sy = Math.min(dec.h - 1, Math.floor((y * dec.h) / dim));
    for (let x = 0; x < dim; x++) {
      const sO = (sy * dec.w + Math.min(dec.w - 1, Math.floor((x * dec.w) / dim))) * 4, dO = (y * dim + x) * 4;
      dst.set(dec.rgba.subarray(sO, sO + 4), dO);
    }
  }
  let bitBuf = 0n, bitCnt = 0;
  const hdr = ((dim - 1) & 0x3fff) | (((dim - 1) & 0x3fff) << 14) | (1 << 28);
  const bytes = [0x2f, hdr & 0xff, (hdr >> 8) & 0xff, (hdr >> 16) & 0xff, (hdr >> 24) & 0xff];
  const put = (v: number, n: number) => { bitBuf |= BigInt(v) << BigInt(bitCnt); bitCnt += n; while (bitCnt >= 8) { bytes.push(Number(bitBuf & 0xffn)); bitBuf >>= 8n; bitCnt -= 8; } };
  const rev8 = (x: number) => { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((x >> i) & 1); return r; };
  put(0, 3);
  for (let t = 0; t < 4; t++) {
    put(6, 6);
    for (let i = 0; i < 18; i++) put(i === 8 ? 1 : 0, 3);
    if (t === 0) { put(13, 4); put(256, 8); } else put(0, 1);
    for (let i = 0; i < 256; i++) put(0, 1);
  }
  put(5, 3); put(0, 8);
  for (let i = 0; i < dim * dim; i++) {
    const o = i * 4;
    put(rev8(dst[o + 1]!), 8); put(rev8(dst[o]!), 8); put(rev8(dst[o + 2]!), 8); put(rev8(dst[o + 3]!), 8);
  }
  if (bitCnt > 0) bytes.push(Number(bitBuf & 0xffn));
  const vp8l = Buffer.from(bytes), pad = vp8l.length & 1, p = Buffer.alloc(20 + vp8l.length + pad);
  p.write('RIFF', 0, 'ascii'); p.writeUInt32LE(12 + vp8l.length + pad, 4); p.write('WEBPVP8L', 8, 'ascii'); p.writeUInt32LE(vp8l.length, 16); vp8l.copy(p, 20);
  return { object_key: `orgs/${orgId}/logo/${dim}.webp`, width: dim, height: dim, content_type: 'image/webp', byte_length: p.byteLength, sha256: createHash('sha256').update(p).digest('hex'), data_base64: p.toString('base64') };
}

export function executeOrgLogoOrWorkspaceCreate(s: OrgChannelSlice3State, caller: McpCallerAuth, ctx: CallerContext, org: OrganizationSummary, name: string, args: Record<string, unknown>, now: string): Record<string, unknown> {
  if (name === 'workspace_create') {
    const slug = norm(String(args.slug)), wsName = String(args.name).trim();
    if (!SLUG_RE.test(slug) || !wsName) return ref('INVALID_WORKSPACE_SLUG', 'valid_workspace_slug', { org: org.slug, workspace: slug });
    if (s.workspaces.some((w) => w.org_id === org.id && norm(w.slug) === slug && isLive(w))) return ref('WORKSPACE_SLUG_TAKEN', 'unique_workspace_slug_in_org', { org: org.slug, workspace: slug });
    const ws = { workspace_id: `ws-${s.workspaces.length + 1}`, org_id: org.id, slug, name: wsName, archived_at: null };
    s.workspaces.push(ws);
    upsertWsGrant(s, ws.workspace_id, org.id, caller.principal_kind, caller.principal_id, 'owner', now, caller.principal_id);
    if (caller.principal_kind === 'agent') {
      const ownerId = agentOwner(s, ctx);
      if (ownerId) upsertWsGrant(s, ws.workspace_id, org.id, 'user', ownerId, 'owner', now, ownerId);
    }
    const genCh: ChannelSummary & { is_default: boolean } = { channel_id: `ch-${s.channels.length + 1}`, workspace_id: ws.workspace_id, org_id: org.id, slug: 'general', visibility: 'workspace', join_policy: 'open', is_default: true, created_at: now };
    s.channels.push(genCh);
    return { ok: true, workspace: ws, default_channel: genCh };
  }
  if (name === 'org_logo_upload') {
    const ct = String(args.content_type);
    const chk = checkLogo(ct, args.data_base64 as string | undefined, args.svg as string | undefined);
    if (!chk.ok) return ref(chk.reason === 'size' ? 'LOGO_TOO_LARGE' : 'INVALID_LOGO_FORMAT', chk.reason === 'size' ? 'logo_under_1mb' : 'valid_png_jpeg_webp_svg', { org: org.slug });
    s.orgLogos = s.orgLogos ?? {};
    const rendition_blobs = { '64': makeRenditionBlob(org.id, 64, chk.sourceBytes, ct, chk.sanitizedSvg), '128': makeRenditionBlob(org.id, 128, chk.sourceBytes, ct, chk.sanitizedSvg), '256': makeRenditionBlob(org.id, 256, chk.sourceBytes, ct, chk.sanitizedSvg) };
    const renditions = { '64': rendition_blobs['64'].object_key, '128': rendition_blobs['128'].object_key, '256': rendition_blobs['256'].object_key };
    const logo = { org_id: org.id, object_key: renditions['256'], content_type: ct as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml', byte_length: chk.bytes, renditions, rendition_blobs, ...(chk.sanitizedSvg ? { sanitized_svg: chk.sanitizedSvg } : {}), updated_at: now };
    s.orgLogos[org.id] = logo;
    org.logo_object_key = logo.object_key;
    org.logo_updated_at = now;
    return { ok: true, org_id: org.id, logo };
  }
  if (s.orgLogos) delete s.orgLogos[org.id];
  org.logo_object_key = null;
  org.logo_updated_at = now;
  return { ok: true, org_id: org.id, logo: null };
}

export function executeWorkspaceJoinTool(s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>, now: string) {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!seatRes.ok) return { ok: false as const, status: 'refused' as const, refusal: seatRes.refusal };
  const seatId = seatRes.seat_id, seat = seatId ? (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x)) : undefined;
  const ctx = toCtx(caller), expWs = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  const argOrg = typeof args.org === 'string' && args.org.trim() ? args.org.trim() : '';
  const wsOrgPre = expWs.includes('/') ? expWs.split('/', 2)[0]!.trim() : '';
  if (argOrg && wsOrgPre) {
    const o1 = s.organizations.find((o) => isLive(o) && (o.id === argOrg || norm(o.slug) === norm(argOrg)));
    const o2 = s.organizations.find((o) => isLive(o) && (o.id === wsOrgPre || norm(o.slug) === norm(wsOrgPre)));
    if (!o1 || !o2 || o1.id !== o2.id) return ref('WORKSPACE_SEAT_MISMATCH', 'org_workspace_selector_conflict', { org: argOrg, workspace: expWs, seat_id: seatId });
  }
  const expOrg = argOrg || wsOrgPre, wsTok = norm(expWs.includes('/') ? expWs.split('/', 2)[1]! : expWs);
  const cands = s.workspaces.filter((w) => isLive(w) && (w.workspace_id === expWs || norm(w.slug) === wsTok) && (!expOrg || s.organizations.some((o) => o.id === w.org_id && (o.id === expOrg || norm(o.slug) === norm(expOrg)))));
  if (cands.length === 0) return ref('WORKSPACE_NOT_FOUND', 'workspace', { workspace: expWs || null, seat_id: seatId });
  if (cands.length > 1) return ref('AMBIGUOUS_WORKSPACE_SELECTOR', 'org_qualifier', { workspace: expWs, seat_id: seatId });
  const cand = cands[0]!, org = s.organizations.find((o) => o.id === cand.org_id)!;
  if (seat && seat.workspace_id !== cand.workspace_id) return ref('WORKSPACE_SEAT_MISMATCH', `seat_in_${org.slug}/${cand.slug}`, { org: org.slug, workspace: cand.slug, seat_id: seatId });
  const r = effCallerOrgRole(s, ctx, org.id);
  if (!r) return ref('ORG_ACCESS_DENIED', 'org_membership', { org: org.slug, workspace: cand.slug, seat_id: seatId });
  if (r === 'guest') return ref('GUEST_WORKSPACE_GRANT_REQUIRED', 'explicit_workspace_grant', { org: org.slug, workspace: cand.slug, seat_id: seatId });
  if (s.workspaceGrants.some((g) => g.workspace_id === cand.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && g.revoked_at != null)) {
    return ref('WORKSPACE_GRANT_REVOKED', 'admin_workspace_regrant', { org: org.slug, workspace: cand.slug, seat_id: seatId });
  }
  upsertWsGrant(s, cand.workspace_id, org.id, caller.principal_kind, caller.principal_id, r, now, agentOwner(s, ctx) ?? caller.principal_id);
  return { ok: true, workspace_id: cand.workspace_id, org_id: org.id, role: r };
}
