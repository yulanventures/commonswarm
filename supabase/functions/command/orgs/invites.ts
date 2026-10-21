import {
  type CallerContext,
  type OrgApprovalRequest,
  type OrgChannelAuthorityState,
  type OrgChannelRefusal,
  type OrganizationSummary,
  type OrgRole,
  type PrincipalKind,
  type WorkspacePrincipalGrant,
  type WorkspaceRecord,
  agentOwner,
  canReadOrg,
  fail,
  isLive,
  isPrin,
  norm,
  orgRole,
} from '../../../../src/protocol/org-channels-contract.js';

export const VALID_ORG_ROLES: readonly OrgRole[] = ['owner', 'admin', 'member', 'guest'];
export const ORG_SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface OrgInviteRecord {
  invite_id: string;
  org_id: string;
  email: string | null;
  role: OrgRole;
  workspace_ids: string[];
  token_hash: string;
  token?: string;
  invited_by: string;
  expires_at: string;
  created_at: string;
  consumed_at?: string | null;
  consumed_by?: string | null;
  revoked_at?: string | null;
}

export interface OrgLogoPendingUpload {
  upload_id: string;
  org_id: string;
  content_type: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml';
  max_bytes: number;
  object_prefix: string;
  rendition_keys: { 64: string; 128: string; 256: string };
  requested_by: string;
  created_at: string;
  finalized_at?: string | null;
}

export interface OrgLogoObjectRecord {
  key: string;
  org_id: string;
  size: 64 | 128 | 256;
  content_type: string;
  byte_length: number;
  sha256: string;
  data: Uint8Array | string;
}

export interface OrgChatSignal {
  signal_id: string;
  workspace_id: string;
  channel_id: string | null;
  from_principal_kind: PrincipalKind;
  from_principal_id: string;
  kind: 'note' | 'ask' | 'working-on';
  body: string;
  approval_id?: string | null;
  created_at: string;
}

export interface OrgAuthorityState extends OrgChannelAuthorityState {
  orgInvites?: OrgInviteRecord[];
  approvalRequests?: OrgApprovalRequest[];
  logoUploads?: Record<string, OrgLogoPendingUpload>;
  logoObjects?: Record<string, OrgLogoObjectRecord>;
  signals?: OrgChatSignal[];
  files?: Array<{ file_id: string; workspace_id: string; name?: string; created_at?: string }>;
  lockLog?: string[];
}

export type RefusalResult = { ok: false; refusal: OrgChannelRefusal };
export type ApprovalPendingResult = {
  ok: true;
  status: 'approval_required';
  approval_required: true;
  approval: OrgApprovalRequest;
  card_signal: OrgChatSignal | null;
};

export type OrgActionExecutor = (
  state: OrgAuthorityState,
  caller: CallerContext,
  payload: Record<string, unknown>,
) => unknown;

export const ORG_ACTION_EXECUTORS: Record<string, OrgActionExecutor> = {};

export const registerOrgActionExecutor = (actionKind: string, executor: OrgActionExecutor) => {
  ORG_ACTION_EXECUTORS[actionKind] = executor;
};

export const roleRank = (r: OrgRole | null | undefined): number =>
  r === 'owner' ? 4 : r === 'admin' ? 3 : r === 'member' ? 2 : r === 'guest' ? 1 : 0;

export const isValidOrgRole = (v: unknown): v is OrgRole =>
  typeof v === 'string' && (VALID_ORG_ROLES as readonly string[]).includes(v);

export const isValidOrgSlug = (s: string): boolean =>
  s.length >= 1 && s.length <= 48 && ORG_SLUG_RE.test(s);

export const findLiveOrg = (s: OrgAuthorityState, idOrSlug: string): OrganizationSummary | undefined => {
  const tok = idOrSlug.trim();
  return s.organizations.find((o) => isLive(o) && (o.id === tok || norm(o.slug) === norm(tok)));
};

export const findLiveWorkspace = (
  s: OrgAuthorityState,
  wsIdOrSlug: string,
  orgIdOrSlug?: string | null,
): WorkspaceRecord | undefined => {
  const org = orgIdOrSlug ? findLiveOrg(s, orgIdOrSlug) : undefined;
  if (orgIdOrSlug && !org) return undefined;
  const tok = wsIdOrSlug.trim();
  return s.workspaces.find(
    (w) =>
      isLive(w) &&
      (!org || w.org_id === org.id) &&
      (w.workspace_id === tok || norm(w.slug) === norm(tok)),
  );
};

export function effectiveCallerOrgRole(s: OrgAuthorityState, c: CallerContext, orgId: string): OrgRole | null {
  if (!canReadOrg(s, c, orgId)) return null;
  if (c.principal_kind === 'user') return orgRole(s, orgId, 'user', c.principal_id);
  const ownerId = agentOwner(s, c);
  const uRole = ownerId ? orgRole(s, orgId, 'user', ownerId) : null;
  if (!uRole) return null;
  const aRole = orgRole(s, orgId, 'agent', c.principal_id);
  return uRole === 'guest' || aRole === 'guest' ? (aRole ? 'guest' : null) : (aRole ?? uRole);
}

export function createOrgApprovalCard(
  s: OrgAuthorityState,
  c: CallerContext,
  input: {
    org: OrganizationSummary;
    workspace_id?: string | null;
    channel_id?: string | null;
    action_kind: string;
    target_scope: Record<string, unknown>;
    payload: Record<string, unknown>;
    now?: string;
  },
): ApprovalPendingResult | RefusalResult {
  const now = input.now ?? new Date().toISOString();
  const ownerId = agentOwner(s, c);
  if (c.principal_kind !== 'agent' || !ownerId) {
    return fail('ORG_ACCESS_DENIED', 'agent_owner_binding', { org: input.org.slug });
  }
  s.approvalRequests ??= [];
  s.signals ??= [];

  const ws =
    (input.workspace_id ? s.workspaces.find((w) => w.workspace_id === input.workspace_id && isLive(w)) : undefined) ??
    s.workspaces.find((w) => w.org_id === input.org.id && isLive(w));
  const ch =
    (input.channel_id ? s.channels.find((x) => x.channel_id === input.channel_id && isLive(x)) : undefined) ??
    (ws ? s.channels.find((x) => x.workspace_id === ws.workspace_id && norm(x.slug) === 'general' && isLive(x)) : undefined);

  const approval: OrgApprovalRequest = {
    approval_id: `appr-${crypto.randomUUID()}`,
    org_id: input.org.id,
    workspace_id: ws?.workspace_id ?? input.workspace_id ?? null,
    channel_id: ch?.channel_id ?? input.channel_id ?? null,
    requested_by_agent_identity_id: c.principal_id,
    owner_user_id: ownerId,
    action_kind: input.action_kind,
    target_scope: input.target_scope,
    payload: input.payload,
    state: 'pending',
    decided_by: null,
    decided_at: null,
    expires_at: null,
    created_at: now,
  };
  s.approvalRequests.push(approval);

  let cardSignal: OrgChatSignal | null = null;
  if (ws) {
    cardSignal = {
      signal_id: `sig-${crypto.randomUUID()}`,
      workspace_id: ws.workspace_id,
      channel_id: ch?.channel_id ?? null,
      from_principal_kind: 'agent',
      from_principal_id: c.principal_id,
      kind: 'ask',
      body: `[Approval Card] Agent ${c.principal_id} requested ${input.action_kind} in ${input.org.slug}. Confirm via MCP org_confirm_action or CLI: cswarm org confirm ${approval.approval_id} --approve`,
      approval_id: approval.approval_id,
      created_at: now,
    };
    s.signals.push(cardSignal);
  }
  return { ok: true, status: 'approval_required', approval_required: true, approval, card_signal: cardSignal };
}

export function authorizeOrgAction(
  s: OrgAuthorityState,
  c: CallerContext,
  opts: {
    org: OrganizationSummary;
    workspace_slug?: string | null;
    workspace_id?: string | null;
    channel_id?: string | null;
    min_role: 'owner' | 'admin';
    action_kind: string;
    payload: Record<string, unknown>;
    require_approval?: boolean;
    now?: string;
  },
):
  | { status: 'authorized'; actor_user_id: string; role: OrgRole }
  | { status: 'approval_required'; result: ApprovalPendingResult }
  | { status: 'refused'; result: RefusalResult } {
  const scope = { org: opts.org.slug, workspace: opts.workspace_slug ?? null };
  if (!canReadOrg(s, c, opts.org.id)) return { status: 'refused', result: fail('ORG_ACCESS_DENIED', 'org_membership', scope) };
  const errCode = opts.min_role === 'owner' ? 'ORG_OWNER_REQUIRED' : 'ORG_ADMIN_REQUIRED';
  const errMissing = opts.min_role === 'owner' ? 'org_owner_role' : 'org_admin_role';

  if (c.principal_kind === 'user') {
    const uRole = orgRole(s, opts.org.id, 'user', c.principal_id);
    return roleRank(uRole) < roleRank(opts.min_role)
      ? { status: 'refused', result: fail(errCode, errMissing, scope) }
      : { status: 'authorized', actor_user_id: c.principal_id, role: uRole! };
  }

  const ownerId = agentOwner(s, c);
  const ownerRole = ownerId ? orgRole(s, opts.org.id, 'user', ownerId) : null;
  const aRole = orgRole(s, opts.org.id, 'agent', c.principal_id);

  if (!opts.require_approval && ownerId && roleRank(aRole) >= roleRank(opts.min_role) && roleRank(ownerRole) >= roleRank(opts.min_role)) {
    return { status: 'authorized', actor_user_id: ownerId, role: aRole! };
  }
  if (ownerId && roleRank(ownerRole) >= roleRank(opts.min_role)) {
    const cleanPayload = { ...opts.payload };
    delete cleanPayload.require_approval;
    delete cleanPayload.on_behalf_of_owner;
    const card = createOrgApprovalCard(s, c, {
      org: opts.org,
      workspace_id: opts.workspace_id ?? null,
      channel_id: opts.channel_id ?? null,
      action_kind: opts.action_kind,
      target_scope: scope,
      payload: cleanPayload,
      now: opts.now,
    });
    return card.ok ? { status: 'approval_required', result: card } : { status: 'refused', result: card };
  }
  return { status: 'refused', result: fail(errCode, errMissing, scope) };
}

function tokenDigestHex(token: string): string {
  let h1 = 0xdeadbeef ^ token.length, h2 = 0x41c6ce57 ^ token.length;
  for (let i = 0; i < token.length; i++) {
    const ch = token.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).repeat(4);
}

export function orgInviteCreate(
  s: OrgAuthorityState,
  c: CallerContext,
  input: {
    org_id: string;
    email?: string | null;
    role?: OrgRole;
    workspace_ids?: string[];
    ttl_ms?: number;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(s, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const role: OrgRole = input.role ?? 'member';
  if (!isValidOrgRole(role)) return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug });

  const auth = authorizeOrgAction(s, c, {
    org,
    min_role: role === 'owner' ? 'owner' : 'admin',
    action_kind: 'org_invite_create',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status !== 'authorized') return auth.result;

  const wsIds: string[] = [];
  for (const raw of input.workspace_ids ?? []) {
    const ws = findLiveWorkspace(s, raw, org.id);
    if (!ws) return fail('WORKSPACE_NOT_FOUND', 'workspace_in_org', { org: org.slug, workspace: raw });
    if (!wsIds.includes(ws.workspace_id)) wsIds.push(ws.workspace_id);
  }
  s.orgInvites ??= [];
  const rawToken = `swm_orginv_${crypto.randomUUID().replace(/-/g, '')}`;
  const ttl = input.ttl_ms && input.ttl_ms > 0 ? input.ttl_ms : DEFAULT_INVITE_TTL_MS;
  const invite: OrgInviteRecord = {
    invite_id: `inv-${crypto.randomUUID()}`,
    org_id: org.id,
    email: input.email ? input.email.trim().toLowerCase() : null,
    role,
    workspace_ids: wsIds,
    token_hash: tokenDigestHex(rawToken),
    token: rawToken,
    invited_by: auth.actor_user_id,
    expires_at: new Date(new Date(now).getTime() + ttl).toISOString(),
    created_at: now,
    consumed_at: null,
    consumed_by: null,
    revoked_at: null,
  };
  s.orgInvites.push(invite);
  return { ok: true as const, status: 'executed' as const, invite, token: rawToken };
}

export function orgInviteAccept(
  s: OrgAuthorityState,
  c: CallerContext,
  input: { token?: string; invite_id?: string; email?: string | null; now?: string },
) {
  const now = input.now ?? new Date().toISOString();
  const hashed = input.token ? tokenDigestHex(input.token) : null;
  const inv = (s.orgInvites ?? []).find(
    (x) => (input.token && (x.token === input.token || x.token_hash === hashed)) || (input.invite_id && x.invite_id === input.invite_id),
  );
  if (!inv || inv.revoked_at != null || inv.consumed_at != null) return fail('ORG_INVITE_UNAVAILABLE', 'active_org_invite', { org: inv?.org_id ?? null });
  if (new Date(inv.expires_at).getTime() <= new Date(now).getTime()) return fail('ORG_INVITE_EXPIRED', 'unexpired_org_invite', { org: inv.org_id });
  if (inv.email && input.email && inv.email.toLowerCase() !== input.email.trim().toLowerCase()) return fail('ORG_INVITE_EMAIL_MISMATCH', 'matching_invite_email', { org: inv.org_id });
  const org = findLiveOrg(s, inv.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: inv.org_id });

  inv.consumed_at = now;
  inv.consumed_by = c.principal_id;

  let m = s.orgMemberships.find((x) => x.org_id === org.id && isPrin(x, c.principal_kind, c.principal_id));
  if (m) {
    m.role = inv.role;
    m.invited_by = inv.invited_by;
    m.revoked_at = null;
  } else {
    m = { id: `om-${crypto.randomUUID()}`, org_id: org.id, principal_kind: c.principal_kind, principal_id: c.principal_id, role: inv.role, invited_by: inv.invited_by, created_at: now, revoked_at: null };
    s.orgMemberships.push(m);
  }

  const grants: WorkspacePrincipalGrant[] = [];
  for (const wsId of inv.workspace_ids) {
    const ws = s.workspaces.find((w) => w.workspace_id === wsId && w.org_id === org.id && isLive(w));
    if (!ws) continue;
    let g = s.workspaceGrants.find((x) => x.workspace_id === ws.workspace_id && isPrin(x, c.principal_kind, c.principal_id));
    if (g) {
      g.role = inv.role;
      g.granted_by = inv.invited_by;
      g.revoked_at = null;
    } else {
      g = { id: `wpg-${crypto.randomUUID()}`, workspace_id: ws.workspace_id, org_id: org.id, principal_kind: c.principal_kind, principal_id: c.principal_id, role: inv.role, granted_by: inv.invited_by, created_at: now, revoked_at: null };
      s.workspaceGrants.push(g);
    }
    grants.push(g);
  }
  return { ok: true as const, invite: inv, membership: m, workspace_grants: grants };
}

export function orgInviteRevoke(
  s: OrgAuthorityState,
  c: CallerContext,
  input: { org_id: string; invite_id: string; require_approval?: boolean; now?: string },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(s, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });
  const auth = authorizeOrgAction(s, c, { org, min_role: 'admin', action_kind: 'org_invite_revoke', payload: { ...input }, require_approval: input.require_approval, now });
  if (auth.status !== 'authorized') return auth.result;
  const inv = (s.orgInvites ?? []).find((x) => x.invite_id === input.invite_id && x.org_id === org.id && x.revoked_at == null);
  if (!inv) return fail('ORG_INVITE_NOT_FOUND', 'active_org_invite', { org: org.slug });
  inv.revoked_at = now;
  return { ok: true as const, status: 'executed' as const, invite: inv };
}

export function orgConfirmAction(
  s: OrgAuthorityState,
  c: CallerContext,
  input: { approval_id: string; decision?: 'approve' | 'reject'; approve?: boolean; now?: string },
) {
  const now = input.now ?? new Date().toISOString();
  if (c.principal_kind !== 'user') return fail('HUMAN_OWNER_CONFIRMATION_REQUIRED', 'human_owner_session', {});
  const appr = (s.approvalRequests ?? []).find((a) => a.approval_id === input.approval_id);
  if (!appr) return fail('APPROVAL_NOT_FOUND', 'approval_request', {});
  if (appr.state !== 'pending') return fail('APPROVAL_ALREADY_DECIDED', 'pending_approval_request', { org: appr.org_id });
  const org = findLiveOrg(s, appr.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: appr.org_id });
  const cRole = orgRole(s, org.id, 'user', c.principal_id);
  if (!cRole || (c.principal_id !== appr.owner_user_id && roleRank(cRole) < roleRank('admin'))) {
    return fail('ORG_APPROVAL_ACCESS_DENIED', 'approval_owner_or_admin', { org: org.slug });
  }
  const dec = input.decision ?? (input.approve === false ? 'reject' : 'approve');
  if (dec === 'reject') {
    appr.state = 'rejected';
    appr.decided_by = c.principal_id;
    appr.decided_at = now;
    return { ok: true as const, approval: appr, executed: false as const, result: null };
  }
  const exec = ORG_ACTION_EXECUTORS[appr.action_kind];
  if (!exec) return fail('UNSUPPORTED_APPROVAL_ACTION', appr.action_kind, { org: org.slug });
  const res = exec(s, { principal_kind: 'user', principal_id: c.principal_id }, { ...appr.payload, now, require_approval: false }) as { ok?: boolean; refusal?: OrgChannelRefusal };
  if (!res?.ok) return (res as RefusalResult) ?? fail('APPROVAL_EXECUTION_FAILED', appr.action_kind, { org: org.slug });
  appr.state = 'approved';
  appr.decided_by = c.principal_id;
  appr.decided_at = now;
  return { ok: true as const, approval: appr, executed: true as const, result: res };
}

registerOrgActionExecutor('org_invite_create', (s, c, p) => orgInviteCreate(s, c, p as Parameters<typeof orgInviteCreate>[2]));
registerOrgActionExecutor('org_invite_revoke', (s, c, p) => orgInviteRevoke(s, c, p as Parameters<typeof orgInviteRevoke>[2]));

export const org_invite_create = orgInviteCreate;
export const org_invite_accept = orgInviteAccept;
export const org_invite_revoke = orgInviteRevoke;
export const org_confirm_action = orgConfirmAction;
