import {
  type CallerContext,
  type ChannelSummary,
  type OrgApprovalRequest,
  type OrgChannelRefusal,
  type OrganizationSummary,
  type OrgRole,
  type PrincipalKind,
  type WorkspaceMoveTransferMode,
  type WorkspaceRecord,
  agentOwner,
  buildOrgChannelRefusal,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
  isLive,
  isPrin,
  norm,
  orgRole,
  reconcileWorkspaceMove,
} from '../../../src/protocol/org-channels-contract.js';
import { effCallerOrgRole } from '../../../src/cloud/org-channels-cli.js';
import {
  type McpCallerAuth,
  type OrgChannelSlice3State,
  resolveSeatIdFromAuthOrArgs,
} from './org-channels-tools.js';

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const MAX_LOGO = 1_048_576;

export const toCtx = (c: McpCallerAuth): CallerContext => ({
  principal_kind: c.principal_kind,
  principal_id: c.principal_id,
  owner_user_id: c.owner_user_id ?? null,
  connection_id: c.connection_id ?? null,
});

export const ref = (code: string, missing: string, scope?: OrgChannelRefusal['scope']) => ({
  ok: false as const,
  status: 'refused' as const,
  refusal: buildOrgChannelRefusal({ code, missing, scope }),
});

export function upsertWsGrant(
  s: OrgChannelSlice3State,
  wsId: string,
  orgId: string,
  k: PrincipalKind,
  id: string,
  role: OrgRole,
  now: string,
  ownerFallback: string,
) {
  const ex = s.workspaceGrants.find((g) => g.workspace_id === wsId && isPrin(g, k, id));
  if (ex) {
    ex.role = role;
    ex.revoked_at = null;
  } else {
    s.workspaceGrants.push({ workspace_id: wsId, org_id: orgId, principal_kind: k, principal_id: id, role, created_at: now, revoked_at: null });
  }
  if (k !== 'agent') return null;
  s.agentPrincipals = s.agentPrincipals ?? [];
  const ai = s.agentIdentities.find((a) => a.id === id);
  let ap = s.agentPrincipals.find((a) => a.workspace_id === wsId && a.agent_identity_id === id);
  if (ap) ap.revoked_at = null;
  else {
    ap = { principal_id: `ap-${wsId}-${id}`, workspace_id: wsId, agent_identity_id: id, owner_user_id: ai?.owner_user_id ?? ownerFallback, name: ai?.display_name ?? id, revoked_at: null };
    s.agentPrincipals.push(ap);
  }
  return ap.principal_id;
}

export function resolveOrg(s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>) {
  const seatRes = resolveSeatIdFromAuthOrArgs(s, caller, args);
  if (!seatRes.ok) return { ok: false as const, status: 'refused' as const, refusal: seatRes.refusal };
  const seatId = seatRes.seat_id;
  const ctx = toCtx(caller);
  const reach = s.organizations.filter((o) => isLive(o) && canReadOrg(s, ctx, o.id));
  const seat = seatId ? (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x)) : undefined;
  const seatWs = seat ? s.workspaces.find((w) => w.workspace_id === seat.workspace_id && isLive(w)) : undefined;
  const seatOrg = seatWs ? s.organizations.find((o) => o.id === seatWs.org_id && isLive(o)) : undefined;
  if (seat && (!seatWs || !seatOrg || !canReadWorkspace(s, ctx, seatWs.workspace_id))) {
    return ref('WORKSPACE_ACCESS_DENIED', 'active_seat_workspace_access', { seat_id: seatId });
  }
  let exp = typeof args.org === 'string' && args.org.trim() ? args.org.trim() : null;
  const expWs = typeof args.workspace === 'string' && args.workspace.trim() ? args.workspace.trim() : null;
  if (!exp && expWs?.includes('/')) exp = expWs.split('/', 2)[0]!.trim();
  if (exp) {
    const found = reach.find((o) => o.id === exp || norm(o.slug) === norm(exp));
    if (!found) return ref('ORG_ACCESS_DENIED', 'org_membership', { org: exp, seat_id: seatId });
    if (seatOrg && found.id !== seatOrg.id) {
      return ref('WORKSPACE_SEAT_MISMATCH', `seat_in_${found.slug}`, { org: found.slug, workspace: seatWs?.slug ?? null, seat_id: seatId });
    }
    return { ok: true as const, org: found, seat_id: seatId };
  }
  if (seatOrg) return { ok: true as const, org: seatOrg, seat_id: seatId };
  const pol = caller.connection_id ? (s.connectionPolicies ?? []).find((p) => p.connection_id === caller.connection_id && isLive(p)) : undefined;
  const def = pol?.default_org_id ? reach.find((o) => o.id === pol.default_org_id) : undefined;
  if (def) return { ok: true as const, org: def, seat_id: seatId };
  if (reach.length === 1) return { ok: true as const, org: reach[0]!, seat_id: seatId };
  return ref(reach.length === 0 ? 'ORG_ACCESS_DENIED' : 'AMBIGUOUS_WORKSPACE_SELECTOR', reach.length === 0 ? 'org_membership' : 'org_selector', { seat_id: seatId });
}

export function enqueueApproval(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  org: { id: string; slug: string },
  action_kind: string,
  payload: Record<string, unknown>,
  workspace_id: string | null = null,
) {
  const ownerId = caller.principal_kind === 'agent' ? agentOwner(s, toCtx(caller)) : null;
  if (!ownerId || orgRole(s, org.id, 'user', ownerId) !== 'owner') {
    return ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
  }
  s.approvalRequests = s.approvalRequests ?? [];
  const card: OrgApprovalRequest = {
    approval_id: `apr_${s.approvalRequests.length + 1}`,
    org_id: org.id,
    workspace_id,
    channel_id: null,
    requested_by_agent_identity_id: caller.principal_id,
    owner_user_id: ownerId,
    action_kind,
    target_scope: { org: org.slug, workspace_id },
    payload,
    state: 'pending',
    created_at: new Date().toISOString(),
  };
  s.approvalRequests.push(card);
  return { ok: true as const, status: 'approval_required' as const, approval: card, mcp_tool: 'org_confirm_action', cli_command: `cswarm org confirm ${card.approval_id} --approve --org ${org.slug}` };
}

export function checkLogo(ct: string, b64?: string, svg?: string): { ok: true; bytes: number; sanitizedSvg?: string } | { ok: false; reason: 'size' | 'format' } {
  if (ct === 'image/svg+xml') {
    const raw = (svg ?? (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '')).trim();
    const len = Buffer.byteLength(raw, 'utf8');
    if (len === 0 || len > MAX_LOGO) return { ok: false, reason: len > MAX_LOGO ? 'size' : 'format' };
    if (!raw.toLowerCase().includes('<svg')) return { ok: false, reason: 'format' };
    const sanitizedSvg = raw
      .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/javascript\s*:/gi, '')
      .replace(/\s(xlink:)?href\s*=\s*("https?:\/\/[^"]*"|'https?:\/\/[^']*')/gi, '');
    return { ok: true, bytes: len, sanitizedSvg };
  }
  if (!b64) return { ok: false, reason: 'format' };
  const buf = Buffer.from(b64, 'base64');
  if (buf.byteLength === 0 || buf.byteLength > MAX_LOGO) return { ok: false, reason: buf.byteLength > MAX_LOGO ? 'size' : 'format' };
  const png = ct === 'image/png' && buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const jpg = ct === 'image/jpeg' && buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const webp = ct === 'image/webp' && buf.length >= 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
  return png || jpg || webp ? { ok: true, bytes: buf.byteLength } : { ok: false, reason: 'format' };
}

export function executeOrgLogoOrWorkspaceCreate(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  ctx: CallerContext,
  org: OrganizationSummary,
  name: string,
  args: Record<string, unknown>,
  now: string,
): Record<string, unknown> {
  if (name === 'workspace_create') {
    const slug = norm(String(args.slug));
    const wsName = String(args.name).trim();
    if (!SLUG_RE.test(slug) || !wsName) return ref('INVALID_WORKSPACE_SLUG', 'valid_workspace_slug', { org: org.slug, workspace: slug });
    if (s.workspaces.some((w) => w.org_id === org.id && norm(w.slug) === slug && isLive(w))) return ref('WORKSPACE_SLUG_TAKEN', 'unique_workspace_slug_in_org', { org: org.slug, workspace: slug });
    const ws = { workspace_id: `ws-${s.workspaces.length + 1}`, org_id: org.id, slug, name: wsName, archived_at: null };
    s.workspaces.push(ws);
    upsertWsGrant(s, ws.workspace_id, org.id, caller.principal_kind, caller.principal_id, 'owner', now, caller.principal_id);
    if (caller.principal_kind === 'agent') {
      const ownerId = agentOwner(s, ctx);
      if (ownerId) upsertWsGrant(s, ws.workspace_id, org.id, 'user', ownerId, 'owner', now, ownerId);
    }
    const genCh: ChannelSummary = { channel_id: `ch-${s.channels.length + 1}`, workspace_id: ws.workspace_id, org_id: org.id, slug: 'general', visibility: 'workspace', join_policy: 'open', created_at: now };
    s.channels.push(genCh);
    return { ok: true, workspace: ws, default_channel: genCh };
  }
  if (name === 'org_logo_upload') {
    const ct = String(args.content_type);
    const chk = checkLogo(ct, args.data_base64 as string | undefined, args.svg as string | undefined);
    if (!chk.ok) return ref(chk.reason === 'size' ? 'LOGO_TOO_LARGE' : 'INVALID_LOGO_FORMAT', chk.reason === 'size' ? 'logo_under_1mb' : 'valid_png_jpeg_webp_svg', { org: org.slug });
    s.orgLogos = s.orgLogos ?? {};
    const renditions = { '64': `orgs/${org.id}/logo/64.webp`, '128': `orgs/${org.id}/logo/128.webp`, '256': `orgs/${org.id}/logo/256.webp` };
    const logo = { org_id: org.id, object_key: renditions['256'], content_type: ct as 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml', byte_length: chk.bytes, renditions, ...(chk.sanitizedSvg ? { sanitized_svg: chk.sanitizedSvg } : {}), updated_at: now };
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

export function executeWorkspaceScopeTool(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  ctx: CallerContext,
  org: OrganizationSummary,
  ws: WorkspaceRecord,
  callerOrgRole: OrgRole | null,
  name: string,
  args: Record<string, unknown>,
  now: string,
): Record<string, unknown> | null {
  const inferKind = (id: string) => ((args.principal_kind as PrincipalKind | undefined) ?? (s.agentIdentities.some((a) => a.id === id) ? 'agent' : 'user')) as PrincipalKind;
  if (name === 'org_assign_workspace_member' || name === 'org_remove_workspace_member') {
    if (callerOrgRole !== 'owner' && callerOrgRole !== 'admin') return ref('ORG_ADMIN_REQUIRED', 'org_owner_or_admin_role', { org: org.slug, workspace: ws.slug });
    const pId = String(args.principal_id);
    const pKind = inferKind(pId);
    if (name === 'org_assign_workspace_member') {
      if (!canReadOrg(s, { principal_kind: pKind, principal_id: pId }, org.id)) return ref('ORG_ACCESS_DENIED', 'target_org_membership', { org: org.slug, workspace: ws.slug });
      const gRole = ((args.role as OrgRole | undefined) ?? orgRole(s, org.id, pKind, pId) ?? 'member') as OrgRole;
      const agentPrincipalId = upsertWsGrant(s, ws.workspace_id, org.id, pKind, pId, gRole, now, caller.principal_id);
      return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, principal_id: pId, principal_kind: pKind, role: gRole, agent_principal_id: agentPrincipalId };
    }
    return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, principal_id: pId, principal_kind: pKind, ...cascadeWorkspaceMemberRemoval(s, { workspace_id: ws.workspace_id, principal_kind: pKind, principal_id: pId, now }) };
  }
  if (name === 'workspace_leave') return { ok: true, workspace_id: ws.workspace_id, ...cascadeWorkspaceMemberRemoval(s, { workspace_id: ws.workspace_id, principal_kind: caller.principal_kind, principal_id: caller.principal_id, now }) };
  if (name === 'workspace_list_members') return { ok: true, workspace_id: ws.workspace_id, org_id: org.id, members: s.workspaceGrants.filter((g) => g.workspace_id === ws.workspace_id && isLive(g)) };
  if (name === 'org_move_workspace') {
    const tok = String(args.target_org).trim();
    const dst = s.organizations.find((o) => isLive(o) && (o.id === tok || norm(o.slug) === norm(tok)));
    if (!dst) return ref('ORG_NOT_FOUND', 'target_org', { org: tok, workspace: ws.slug });
    const mode = ((args.transfer_members as WorkspaceMoveTransferMode | undefined) ?? 'owners_only') as WorkspaceMoveTransferMode;
    if (caller.principal_kind === 'agent' || args.request_approval === true) return enqueueApproval(s, caller, org, 'org_move_workspace', { org: org.id, workspace: ws.workspace_id, target_org: dst.id, transfer_members: mode }, ws.workspace_id);
    const moved = reconcileWorkspaceMove(s, { workspace_id: ws.workspace_id, target_org_id: dst.id, actor_user_id: caller.principal_id, transfer_members: mode, now });
    return moved.ok ? { ...moved, workspace_id: ws.workspace_id, transfer_members: mode } : { ok: false, status: 'refused', refusal: moved.refusal };
  }
  return null;
}

export function executeWorkspaceJoinTool(s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>, now: string) {
  const ctx = toCtx(caller);
  const expWs = typeof args.workspace === 'string' ? args.workspace.trim() : '';
  const expOrg = typeof args.org === 'string' ? args.org.trim() : (expWs.includes('/') ? expWs.split('/', 2)[0]!.trim() : '');
  const wsTok = norm(expWs.includes('/') ? expWs.split('/', 2)[1]! : expWs);
  const cand = s.workspaces.find((w) => isLive(w) && (w.workspace_id === expWs || norm(w.slug) === wsTok) && (!expOrg || s.organizations.some((o) => o.id === w.org_id && (o.id === expOrg || norm(o.slug) === norm(expOrg)))));
  if (!cand) return ref('WORKSPACE_NOT_FOUND', 'workspace', { workspace: expWs || null });
  const org = s.organizations.find((o) => o.id === cand.org_id)!;
  const r = effCallerOrgRole(s, ctx, org.id);
  if (!r) return ref('ORG_ACCESS_DENIED', 'org_membership', { org: org.slug, workspace: cand.slug });
  if (r === 'guest') return ref('GUEST_WORKSPACE_GRANT_REQUIRED', 'explicit_workspace_grant', { org: org.slug, workspace: cand.slug });
  if (s.workspaceGrants.some((g) => g.workspace_id === cand.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && g.revoked_at != null)) {
    return ref('WORKSPACE_GRANT_REVOKED', 'admin_workspace_regrant', { org: org.slug, workspace: cand.slug });
  }
  upsertWsGrant(s, cand.workspace_id, org.id, caller.principal_kind, caller.principal_id, r, now, agentOwner(s, ctx) ?? caller.principal_id);
  return { ok: true, workspace_id: cand.workspace_id, org_id: org.id, role: r };
}
