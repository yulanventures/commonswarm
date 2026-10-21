import { inflateSync } from 'node:zlib';
import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER,
  type CallerContext, type ChannelSummary, type OrganizationSummary,
  type OrgMembershipRecord, type OrgRole, type WorkspacePrincipalGrant, type WorkspaceRecord,
  agentOwner, canReadChannel, canReadOrg, canReadWorkspace, cascadeWorkspaceMemberRemoval,
  fail, isLive, isPrin, norm, orgRole,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState, type OrgSqlExecutor,
  authorizeOrgAction, effectiveCallerOrgRole, execOrgSql, findLiveOrg,
  isValidOrgSlug, registerOrgActionExecutor, syncLockedOrgRows,
  upsertAgentPrincipalInWorkspace, withOrgTx,
} from './invites.js';

export function orgCreate(
  s: OrgAuthorityState, c: CallerContext,
  input: { id?: string; slug: string; display_name: string; default_workspace?: { workspace_id?: string; slug?: string; name?: string } | boolean; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), slug = norm(input.slug ?? ''), dn = (input.display_name ?? '').trim();
    if (!isValidOrgSlug(slug)) return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: input.slug ?? null });
    if (!dn) return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: slug });
    if (s.organizations.some((o) => norm(o.slug) === slug)) return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: slug });
    const ownerId = c.principal_kind === 'user' ? c.principal_id : agentOwner(s, c);
    if (!ownerId) return fail('ORG_ACCESS_DENIED', 'authenticated_owner', { org: slug });

    const orgId = input.id?.trim() || crypto.randomUUID();
    const organization: OrganizationSummary = { id: orgId, slug, display_name: dn, logo_object_key: null, logo_updated_at: null, created_by: ownerId, created_at: now, updated_at: now, archived_at: null };
    s.organizations.push(organization);
    execOrgSql(tx, 'INSERT INTO swarm.organizations (id, slug, display_name, logo_object_key, logo_updated_at, created_by, created_at, updated_at, archived_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, NULL)', [orgId, slug, dn, ownerId, now, now]);

    const upMem = 'INSERT INTO swarm.org_memberships (id, org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) ON CONFLICT (org_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, revoked_at = NULL';
    const ownerMem: OrgMembershipRecord = { id: crypto.randomUUID(), org_id: orgId, principal_kind: 'user', principal_id: ownerId, role: 'owner', invited_by: ownerId, created_at: now, revoked_at: null };
    s.orgMemberships.push(ownerMem);
    execOrgSql(tx, upMem, [ownerMem.id, orgId, 'user', ownerId, 'owner', ownerId, now]);

    let agentMem: OrgMembershipRecord | null = null;
    if (c.principal_kind === 'agent') {
      agentMem = { id: crypto.randomUUID(), org_id: orgId, principal_kind: 'agent', principal_id: c.principal_id, role: 'admin', invited_by: ownerId, created_at: now, revoked_at: null };
      s.orgMemberships.push(agentMem);
      execOrgSql(tx, upMem, [agentMem.id, orgId, 'agent', c.principal_id, 'admin', ownerId, now]);
    }

    let ws: WorkspaceRecord | null = null, ch: ChannelSummary | null = null;
    if (input.default_workspace) {
      const cfg = typeof input.default_workspace === 'object' ? input.default_workspace : {};
      const wsSlug = norm(cfg.slug || 'main'), wsName = (cfg.name || dn).trim(), wsId = cfg.workspace_id || crypto.randomUUID();
      ws = { workspace_id: wsId, org_id: orgId, slug: wsSlug, name: wsName, archived_at: null };
      s.workspaces.push(ws);
      execOrgSql(tx, 'INSERT INTO swarm.workspaces (workspace_id, org_id, slug, name, created_by, archived_at) VALUES ($1, $2, $3, $4, $5, NULL)', [wsId, orgId, wsSlug, wsName, ownerId]);

      const upGr = 'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, revoked_at = NULL';
      const oGr: WorkspacePrincipalGrant = { id: crypto.randomUUID(), workspace_id: wsId, org_id: orgId, principal_kind: 'user', principal_id: ownerId, role: 'owner', granted_by: ownerId, created_at: now, revoked_at: null };
      s.workspaceGrants.push(oGr);
      execOrgSql(tx, upGr, [oGr.id, wsId, orgId, 'user', ownerId, 'owner', ownerId, now]);

      if (c.principal_kind === 'agent') {
        const aGr: WorkspacePrincipalGrant = { id: crypto.randomUUID(), workspace_id: wsId, org_id: orgId, principal_kind: 'agent', principal_id: c.principal_id, role: 'admin', granted_by: ownerId, created_at: now, revoked_at: null };
        s.workspaceGrants.push(aGr);
        execOrgSql(tx, upGr, [aGr.id, wsId, orgId, 'agent', c.principal_id, 'admin', ownerId, now]);
        upsertAgentPrincipalInWorkspace(s, wsId, c.principal_id, tx);
      }

      ch = { channel_id: crypto.randomUUID(), workspace_id: wsId, org_id: orgId, slug: 'general', purpose: 'General coordination', visibility: 'workspace', join_policy: 'open', created_by_principal: ownerId, created_by_kind: 'user', created_at: now, archived_at: null };
      s.channels.push(ch);
      execOrgSql(tx, 'INSERT INTO swarm.channels (channel_id, workspace_id, slug, purpose, visibility, join_policy, created_by_principal, created_by_kind, created_at, archived_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)', [ch.channel_id, wsId, 'general', 'General coordination', 'workspace', 'open', ownerId, 'user', now]);
    }
    return { ok: true as const, status: 'executed' as const, organization, membership: ownerMem, agent_membership: agentMem, workspace: ws, general_channel: ch };
  });
}

export function orgUpdate(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id: string; slug?: string; display_name?: string; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    syncLockedOrgRows(s, org.id, tx);
    if (!isLive(org)) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_update', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    if (input.slug !== undefined) {
      const next = norm(input.slug);
      if (!isValidOrgSlug(next)) return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: org.slug });
      if (s.organizations.some((o) => o.id !== org.id && norm(o.slug) === next)) return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: next });
      org.slug = next;
    }
    if (input.display_name !== undefined) {
      const nm = input.display_name.trim();
      if (!nm) return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: org.slug });
      org.display_name = nm;
    }
    org.updated_at = now;
    execOrgSql(tx, 'UPDATE swarm.organizations SET slug = $2, display_name = $3, updated_at = $4 WHERE id = $1', [org.id, org.slug, org.display_name, now]);
    return { ok: true as const, status: 'executed' as const, organization: org };
  });
}

export function orgDelete(
  s: OrgAuthorityState, c: CallerContext,
  input: { org_id: string; confirm_slug?: string; confirm?: boolean; allow_last_org?: boolean; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(s, db, (tx) => {
    const now = input.now ?? new Date().toISOString(), org = findLiveOrg(s, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const wsIds = s.workspaces.filter((w) => w.org_id === org.id && isLive(w)).map((w) => w.workspace_id);
    (s.lockLog ??= []).push(...CANONICAL_ORG_CHANNEL_LOCK_ORDER);
    syncLockedOrgRows(s, org.id, tx);
    for (const [t, k, p] of [['workspaces', 'workspace_id', 'org_id = $1'], ['channels', 'channel_id', 'workspace_id = ANY($1::uuid[])'], ['workspace_principal_grants', 'id', 'org_id = $1'], ['channel_memberships', 'id', 'workspace_id = ANY($1::uuid[])'], ['agent_principals', 'principal_id', 'workspace_id = ANY($1::uuid[])'], ['hosted_mcp_seats', 'seat_id', 'workspace_id = ANY($1::uuid[])']] as const) {
      execOrgSql(tx, `SELECT ${k} FROM swarm.${t} WHERE ${p} ORDER BY ${k} FOR UPDATE`, [p.includes('ANY') ? wsIds : org.id]);
    }
    if (!isLive(org)) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
    const auth = authorizeOrgAction(s, c, { org, min_role: 'owner', action_kind: 'org_delete', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;
    if (input.confirm_slug !== undefined && norm(input.confirm_slug) !== norm(org.slug)) return fail('ORG_DELETE_CONFIRMATION_MISMATCH', 'matching_confirm_slug', { org: org.slug });
    const ownerLiveOrgs = s.organizations.filter((o) => isLive(o) && orgRole(s, o.id, 'user', auth.actor_user_id) !== null);
    if (ownerLiveOrgs.length <= 1 && !(input.allow_last_org === true && typeof input.confirm_slug === 'string' && norm(input.confirm_slug) === norm(org.slug))) {
      return fail('CANNOT_DELETE_LAST_ORG', 'allow_last_org_and_confirm_slug', { org: org.slug });
    }
    const closedSeatIds: string[] = [], closedHandleIds: string[] = [], archivedWorkspaceIds: string[] = [];
    for (const ws of s.workspaces) {
      if (ws.org_id !== org.id || !isLive(ws)) continue;
      archivedWorkspaceIds.push(ws.workspace_id);
      for (const m of s.orgMemberships) {
        if (m.org_id === org.id && isLive(m)) {
          const r = cascadeWorkspaceMemberRemoval(s, { workspace_id: ws.workspace_id, principal_kind: m.principal_kind, principal_id: m.principal_id, now });
          for (const id of r.closed_seat_ids) if (!closedSeatIds.includes(id)) closedSeatIds.push(id);
          for (const id of r.closed_handle_ids) if (!closedHandleIds.includes(id)) closedHandleIds.push(id);
        }
      }
      for (const g of s.workspaceGrants) if ((g.workspace_id === ws.workspace_id || g.org_id === org.id) && g.revoked_at == null) g.revoked_at = now;
      for (const lm of s.legacyMemberships ?? []) if (lm.workspace_id === ws.workspace_id && lm.revoked_at == null) lm.revoked_at = now;
      for (const cm of s.channelMemberships) if (cm.workspace_id === ws.workspace_id && cm.revoked_at == null) cm.revoked_at = now;
      for (const ap of s.agentPrincipals ?? []) if (ap.workspace_id === ws.workspace_id && ap.revoked_at == null) ap.revoked_at = now;
      for (const st of s.seats ?? []) if (st.workspace_id === ws.workspace_id && st.revoked_at == null) { st.revoked_at = now; if (!closedSeatIds.includes(st.seat_id)) closedSeatIds.push(st.seat_id); }
      for (const h of s.seatHandles ?? []) if ((h.workspace_id === ws.workspace_id || closedSeatIds.includes(h.seat_id)) && h.revoked_at == null) { h.revoked_at = now; if (!closedHandleIds.includes(h.handle_id)) closedHandleIds.push(h.handle_id); }
      for (const ch of s.channels) if (ch.workspace_id === ws.workspace_id && ch.archived_at == null) ch.archived_at = now;
      ws.archived_at = now;
    }
    for (const m of s.orgMemberships) if (m.org_id === org.id && m.revoked_at == null) m.revoked_at = now;
    for (const inv of s.orgInvites ?? []) if (inv.org_id === org.id && inv.revoked_at == null) inv.revoked_at = now;
    org.archived_at = now; org.updated_at = now;
    for (const tbl of ['hosted_mcp_seat_handles', 'hosted_mcp_seats', 'agent_principals', 'channel_memberships', 'memberships']) execOrgSql(tx, `UPDATE swarm.${tbl} SET revoked_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND revoked_at IS NULL`, [wsIds, now]);
    for (const tbl of ['workspace_principal_grants', 'org_invites', 'org_memberships']) execOrgSql(tx, `UPDATE swarm.${tbl} SET revoked_at = $2 WHERE org_id = $1 AND revoked_at IS NULL`, [org.id, now]);
    execOrgSql(tx, 'UPDATE swarm.channels SET archived_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL', [wsIds, now]);
    execOrgSql(tx, 'UPDATE swarm.workspaces SET archived_at = $2 WHERE org_id = $1 AND archived_at IS NULL', [org.id, now]);
    execOrgSql(tx, 'UPDATE swarm.organizations SET archived_at = $2, updated_at = $2 WHERE id = $1', [org.id, now]);
    return { ok: true as const, status: 'executed' as const, organization: org, archived_workspace_ids: archivedWorkspaceIds, closed_seat_ids: closedSeatIds, closed_handle_ids: closedHandleIds };
  });
}

export function orgList(s: OrgAuthorityState, c: CallerContext) {
  const organizations = s.organizations.filter((o) => isLive(o) && canReadOrg(s, c, o.id)).map((o) => {
    const role: OrgRole = effectiveCallerOrgRole(s, c, o.id) ?? 'guest';
    const workspaces = s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id)).map((w) => {
      const g = s.workspaceGrants.find((x) => x.workspace_id === w.workspace_id && isPrin(x, c.principal_kind, c.principal_id) && isLive(x));
      const channels = s.channels.filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(s, c, ch.channel_id)).map((ch) => ({ channel_id: ch.channel_id, slug: ch.slug, visibility: ch.visibility, join_policy: ch.join_policy }));
      return { workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: g?.role ?? role, channels };
    });
    return { org_id: o.id, slug: o.slug, display_name: o.display_name, logo_object_key: o.logo_object_key ?? null, logo_updated_at: o.logo_updated_at ?? null, role, workspaces };
  });
  return { ok: true as const, organizations };
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

export function decodePng(raw: Uint8Array): { width: number; height: number; rgba: Uint8Array } | null {
  if (raw.byteLength < 33) return null;
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  if (dv.getUint32(0) !== 0x89504e47 || dv.getUint32(4) !== 0x0d0a1a0a || dv.getUint32(8) !== 13 || dv.getUint32(12) !== 0x49484452) return null;
  const w = dv.getUint32(16), h = dv.getUint32(20), bd = raw[24]!, ct = raw[25]!, bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : ct === 0 || ct === 3 ? 1 : 0;
  if (w < 1 || w > 2048 || h < 1 || h > 2048 || bd !== 8 || raw[26] || raw[27] || raw[28] || !bpp) return null;
  const idats: Uint8Array[] = [];
  let plte: Uint8Array | null = null, trns: Uint8Array | null = null, iend = false, off = 8;
  while (off + 12 <= raw.byteLength) {
    const l = dv.getUint32(off); if (off + 12 + l > raw.byteLength) return null;
    const tp = String.fromCharCode(raw[off + 4]!, raw[off + 5]!, raw[off + 6]!, raw[off + 7]!), ch = raw.subarray(off + 8, off + 8 + l);
    if (tp === 'PLTE') plte = ch; else if (tp === 'tRNS') trns = ch; else if (tp === 'IDAT') idats.push(ch);
    else if (tp === 'IEND') { iend = off + 12 + l === raw.byteLength; break; }
    off += 12 + l;
  }
  if (!iend || !idats.length || (ct === 3 && (!plte || plte.byteLength < 3))) return null;
  try {
    const inf = new Uint8Array(inflateSync(Buffer.concat(idats))), rb = w * bpp, st = 1 + rb;
    if (inf.byteLength < h * st) return null;
    const rec = new Uint8Array(h * rb), rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const f = inf[y * st]!, sb = y * st + 1, db = y * rb; if (f > 4) return null;
      for (let i = 0; i < rb; i++) {
        const x = inf[sb + i]!, a = i >= bpp ? rec[db + i - bpp]! : 0, b = y > 0 ? rec[db - rb + i]! : 0, c = y > 0 && i >= bpp ? rec[db - rb + i - bpp]! : 0;
        rec[db + i] = (x + (f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, c) : 0)) & 255;
      }
      for (let x = 0; x < w; x++) {
        const si = db + x * bpp, di = (y * w + x) * 4;
        if (ct === 6) rgba.set(rec.subarray(si, si + 4), di);
        else if (ct === 2) { rgba[di] = rec[si]!; rgba[di + 1] = rec[si + 1]!; rgba[di + 2] = rec[si + 2]!; rgba[di + 3] = trns && trns.byteLength >= 6 && rec[si] === trns[1] && rec[si + 1] === trns[3] && rec[si + 2] === trns[5] ? 0 : 255; }
        else if (ct === 4) { rgba[di] = rgba[di + 1] = rgba[di + 2] = rec[si]!; rgba[di + 3] = rec[si + 1]!; }
        else if (ct === 0) { const v = rec[si]!; rgba[di] = rgba[di + 1] = rgba[di + 2] = v; rgba[di + 3] = trns && trns.byteLength >= 2 && v === trns[1] ? 0 : 255; }
        else { const ix = rec[si]!; if (ix * 3 + 2 >= plte!.byteLength) return null; rgba[di] = plte![ix * 3]!; rgba[di + 1] = plte![ix * 3 + 1]!; rgba[di + 2] = plte![ix * 3 + 2]!; rgba[di + 3] = trns && ix < trns.byteLength ? trns[ix]! : 255; }
      }
    }
    return { width: w, height: h, rgba };
  } catch { return null; }
}

registerOrgActionExecutor('org_create', (s, c, p, db) => orgCreate(s, c, p as Parameters<typeof orgCreate>[2], db));
registerOrgActionExecutor('org_update', (s, c, p, db) => orgUpdate(s, c, p as Parameters<typeof orgUpdate>[2], db));
registerOrgActionExecutor('org_delete', (s, c, p, db) => orgDelete(s, c, p as Parameters<typeof orgDelete>[2], db));

export const org_create = orgCreate;
export const org_update = orgUpdate;
export const org_delete = orgDelete;
export const org_list = orgList;
