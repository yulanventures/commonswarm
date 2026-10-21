import {
  type OrganizationSummary,
  type OrgRole,
  type PrincipalKind,
  agentOwner,
  canReadOrg,
  canReadWorkspace,
  cascadeOrgMemberRemoval,
  isLive,
  isPrin,
  norm,
  orgRole,
} from '../../../src/protocol/org-channels-contract.js';
import {
  effCallerOrgRole,
  registerDefaultOrgChannelCliExecutor,
} from '../../../src/cloud/org-channels-cli.js';
import {
  type McpCallerAuth,
  type OrgChannelSlice3State,
  OrgChannelToolInputError,
  type OrgChannelToolName,
  executeMultiOrgWhoami,
  resolveMcpOrgWorkspaceChannel,
  resolveSeatIdFromAuthOrArgs,
  validateOrgChannelToolArguments,
} from './org-channels-tools.js';
import {
  SLUG_RE,
  enqueueApproval,
  executeOrgLogoOrWorkspaceCreate,
  executeWorkspaceJoinTool,
  executeWorkspaceScopeTool,
  ref,
  resolveOrg,
  toCtx,
} from './org-channels-subtools.js';
import { executeChannelMcpSubtool } from './org-channels-channels.js';

export function executeOrgChannelMcpTool(
  s: OrgChannelSlice3State,
  caller: McpCallerAuth,
  name: OrgChannelToolName | string,
  rawArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  let args: Record<string, unknown>;
  try {
    args = validateOrgChannelToolArguments(name, rawArgs);
  } catch (err) {
    if (err instanceof OrgChannelToolInputError) {
      return { ...ref('INVALID_ARGUMENTS', err.message), error: err.code };
    }
    throw err;
  }
  const now = new Date().toISOString();
  const ctx = toCtx(caller);
  const inferKind = (id: string) =>
    ((args.principal_kind as PrincipalKind | undefined) ??
      (s.agentIdentities.some((a) => a.id === id) ? 'agent' : 'user')) as PrincipalKind;

  if (name === 'whoami' || name === 'discover') {
    const res = executeMultiOrgWhoami(s, caller, args);
    if (!res.ok || name === 'whoami') return res;
    return {
      ...res,
      total_organizations: res.organizations.length,
      total_workspaces: res.organizations.reduce((a, o) => a + o.workspaces.length, 0),
      total_channels: res.organizations.reduce(
        (a, o) => a + o.workspaces.reduce((w, x) => w + x.channels.length, 0),
        0,
      ),
    };
  }

  if (name === 'org_list') {
    const sr = resolveSeatIdFromAuthOrArgs(s, caller, args);
    if (!sr.ok) return { ok: false, status: 'refused', refusal: sr.refusal };
    if (typeof args.workspace === 'string' || typeof args.channel === 'string') {
      const chk = resolveMcpOrgWorkspaceChannel(s, caller, args as Record<string, string | null | undefined>);
      if (!chk.ok) return { ok: false, status: 'refused', refusal: chk.refusal };
    } else if (typeof args.org === 'string' && args.org.trim()) {
      const or = resolveOrg(s, caller, args);
      if (!or.ok) return or;
    }
    const organizations = s.organizations
      .filter((o) => isLive(o) && canReadOrg(s, ctx, o.id))
      .map((o) => ({
        ...o,
        role: effCallerOrgRole(s, ctx, o.id)!,
        workspace_count: s.workspaces.filter(
          (w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, ctx, w.workspace_id),
        ).length,
      }));
    return { ok: true, organizations };
  }

  if (name === 'org_create') {
    const slug = norm(String(args.slug));
    const displayName = String(args.display_name).trim();
    if (!SLUG_RE.test(slug) || slug.length > 48 || !displayName) {
      return ref('INVALID_ORG_SLUG', 'valid_org_slug', { org: slug });
    }
    if (s.organizations.some((o) => norm(o.slug) === slug && isLive(o))) {
      return ref('ORG_SLUG_TAKEN', 'unique_org_slug', { org: slug });
    }
    const uid =
      caller.principal_kind === 'user'
        ? caller.principal_id
        : (agentOwner(s, ctx) ?? caller.principal_id);
    const org: OrganizationSummary = {
      id: `org-${s.organizations.length + 1}`,
      slug,
      display_name: displayName,
      logo_object_key: null,
      logo_updated_at: null,
      created_by: uid,
      created_at: now,
      updated_at: now,
      archived_at: null,
    };
    s.organizations.push(org);
    s.orgMemberships.push({
      org_id: org.id,
      principal_kind: 'user',
      principal_id: uid,
      role: 'owner',
      created_at: now,
      revoked_at: null,
    });
    if (caller.principal_kind === 'agent') {
      s.orgMemberships.push({
        org_id: org.id,
        principal_kind: 'agent',
        principal_id: caller.principal_id,
        role: 'admin',
        created_at: now,
        revoked_at: null,
      });
    }
    return { ok: true, organization: org };
  }

  if (name === 'org_confirm_action') {
    const decision = String(args.decision);
    if (decision !== 'approve' && decision !== 'reject') {
      return { ...ref('INVALID_ARGUMENTS', 'decision_approve_or_reject'), error: 'INVALID_ARGUMENTS' };
    }
    const card = (s.approvalRequests ?? []).find((a) => a.approval_id === String(args.approval_id));
    if (!card) return ref('APPROVAL_NOT_FOUND', 'approval_id');
    if (card.state !== 'pending') return ref('APPROVAL_ALREADY_DECIDED', 'pending_approval', { org: card.org_id });
    if (caller.principal_kind !== 'user' || orgRole(s, card.org_id, 'user', caller.principal_id) !== 'owner') {
      return ref('ORG_OWNER_REQUIRED', 'human_org_owner', { org: card.org_id });
    }
    if (decision === 'reject') {
      card.decided_by = caller.principal_id;
      card.decided_at = now;
      card.state = 'rejected';
      return { ok: true, status: 'rejected', approval: card };
    }
    const executed = executeOrgChannelMcpTool(
      s,
      { principal_kind: 'user', principal_id: caller.principal_id },
      card.action_kind,
      card.payload,
    );
    if (executed.ok !== true) {
      const errCode = (executed.refusal as { code?: string } | undefined)?.code ?? String(executed.error ?? 'EXECUTION_FAILED');
      return {
        ...executed,
        ok: false,
        status: 'refused',
        error: errCode,
        approval: card,
        executed,
      };
    }
    card.decided_by = caller.principal_id;
    card.decided_at = now;
    card.state = 'approved';
    return { ok: true, status: 'approved', approval: card, executed };
  }

  if (name === 'workspace_list') {
    const sr = resolveSeatIdFromAuthOrArgs(s, caller, args);
    if (!sr.ok) return { ok: false, status: 'refused', refusal: sr.refusal };
    let filterOrgId: string | null = null;
    if (typeof args.workspace === 'string' || typeof args.channel === 'string') {
      const chk = resolveMcpOrgWorkspaceChannel(s, caller, args as Record<string, string | null | undefined>);
      if (!chk.ok) return { ok: false, status: 'refused', refusal: chk.refusal };
      filterOrgId = chk.org.id;
    } else if (typeof args.org === 'string' && args.org.trim()) {
      const or = resolveOrg(s, caller, args);
      if (!or.ok) return or;
      filterOrgId = or.org.id;
    }
    const workspaces = s.workspaces
      .filter((w) => isLive(w) && (!filterOrgId || w.org_id === filterOrgId) && canReadWorkspace(s, ctx, w.workspace_id))
      .map((w) => {
        const o = s.organizations.find((x) => x.id === w.org_id)!;
        return { ...w, org_slug: o.slug, selector: `${o.slug}/${w.slug}` };
      });
    return { ok: true, workspaces };
  }

  const ORG_OPS = new Set([
    'org_get', 'org_update', 'org_delete', 'org_switch_default',
    'org_list_members', 'org_invite_member', 'org_set_member_role', 'org_remove_member',
    'workspace_create', 'org_logo_upload', 'org_logo_remove',
  ]);
  if (ORG_OPS.has(name)) {
    const or = resolveOrg(s, caller, args);
    if (!or.ok) return or;
    const { org } = or;
    const role = effCallerOrgRole(s, ctx, org.id);

    if (name === 'org_get') {
      return {
        ok: true,
        organization: org,
        role,
        workspaces: s.workspaces.filter((w) => w.org_id === org.id && isLive(w) && canReadWorkspace(s, ctx, w.workspace_id)),
        logo: s.orgLogos?.[org.id] ?? null,
      };
    }
    if (name === 'org_switch_default') {
      let defWsId: string | null = null;
      if (typeof args.workspace === 'string' && args.workspace.trim()) {
        const wsTok = norm(args.workspace.includes('/') ? args.workspace.split('/', 2)[1]! : args.workspace);
        const ws = s.workspaces.find((w) => w.org_id === org.id && isLive(w) && (w.workspace_id === args.workspace || norm(w.slug) === wsTok));
        if (!ws || !canReadWorkspace(s, ctx, ws.workspace_id)) {
          return ref('WORKSPACE_ACCESS_DENIED', 'workspace_grant', { org: org.slug, workspace: String(args.workspace) });
        }
        defWsId = ws.workspace_id;
      }
      s.connectionPolicies = s.connectionPolicies ?? [];
      const cid = caller.connection_id ?? `conn_${caller.principal_id}`;
      const pol = s.connectionPolicies.find((p) => p.connection_id === cid);
      if (pol) { pol.default_org_id = org.id; pol.default_workspace_id = defWsId; }
      else s.connectionPolicies.push({ connection_id: cid, default_org_id: org.id, default_workspace_id: defWsId, revoked_at: null });
      return { ok: true, default_org_id: org.id, default_workspace_id: defWsId, org_slug: org.slug };
    }
    if (name === 'org_list_members') {
      const kind = typeof args.kind === 'string' ? args.kind : 'all';
      const members = s.orgMemberships
        .filter((m) => m.org_id === org.id && isLive(m) && (kind === 'all' || (kind === 'guest' ? m.role === 'guest' : m.principal_kind === kind)))
        .map((m) => ({
          ...m,
          workspaces: s.workspaceGrants.filter((g) => g.org_id === org.id && isPrin(g, m.principal_kind, m.principal_id) && isLive(g)).map((g) => g.workspace_id),
        }));
      return { ok: true, org_id: org.id, members, invites: (s.orgInvites ?? []).filter((i) => i.org_id === org.id && isLive(i)) };
    }
    if (name === 'org_delete') {
      if (String(args.confirm_slug) !== org.slug) return ref('ORG_DELETE_CONFIRMATION_MISMATCH', 'matching_confirm_slug', { org: org.slug });
      if (caller.principal_kind === 'agent' || args.request_approval === true) return enqueueApproval(s, caller, org, 'org_delete', { org: org.id, confirm_slug: org.slug });
      if (role !== 'owner') return ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
      org.archived_at = now;
      for (const m of s.orgMemberships.filter((x) => x.org_id === org.id && isLive(x))) cascadeOrgMemberRemoval(s, { org_id: org.id, principal_kind: m.principal_kind, principal_id: m.principal_id, now });
      return { ok: true, deleted_org_id: org.id };
    }
    if (args.request_approval === true && caller.principal_kind === 'agent') {
      return enqueueApproval(s, caller, org, name, { ...args, org: org.id, request_approval: false });
    }
    if (role !== 'owner' && role !== 'admin') return ref('ORG_ADMIN_REQUIRED', 'org_owner_or_admin_role', { org: org.slug });

    if (name === 'workspace_create' || name === 'org_logo_upload' || name === 'org_logo_remove') {
      return executeOrgLogoOrWorkspaceCreate(s, caller, ctx, org, name, args, now);
    }
    if (name === 'org_update') {
      const next = typeof (args.new_slug ?? args.slug) === 'string' ? norm(String(args.new_slug ?? args.slug)) : null;
      if (next && next !== norm(org.slug)) {
        if (!SLUG_RE.test(next) || next.length > 48) return ref('INVALID_ORG_SLUG', 'valid_org_slug', { org: next });
        if (s.organizations.some((o) => o.id !== org.id && norm(o.slug) === next && isLive(o))) return ref('ORG_SLUG_TAKEN', 'unique_org_slug', { org: next });
        org.slug = next;
      }
      if (typeof args.display_name === 'string' && args.display_name.trim()) org.display_name = args.display_name.trim();
      org.updated_at = now;
      return { ok: true, organization: org };
    }
    const humanOwners = () => s.orgMemberships.filter((m) => m.org_id === org.id && m.principal_kind === 'user' && m.role === 'owner' && isLive(m)).length;
    if (name === 'org_invite_member') {
      const tRole = ((args.role as OrgRole | undefined) ?? 'member') as OrgRole;
      const pId = typeof args.principal_id === 'string' && args.principal_id.trim() ? args.principal_id.trim() : null;
      const pKind = ((args.principal_kind as PrincipalKind | undefined) ?? (pId ? inferKind(pId) : 'user')) as PrincipalKind;
      const email = typeof args.email === 'string' && args.email.trim() ? args.email.trim().toLowerCase() : null;
      const ex = pId ? s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId)) : undefined;
      const exIsLiveOwner = Boolean(ex && isLive(ex) && ex.role === 'owner');
      if (exIsLiveOwner && tRole !== 'owner' && humanOwners() <= 1) {
        return role !== 'owner'
          ? ref('ORG_OWNER_ROLE_REQUIRED', 'org_owner_role', { org: org.slug })
          : ref('LAST_ORG_OWNER_REQUIRED', 'another_org_owner', { org: org.slug });
      }
      if ((tRole === 'owner' || exIsLiveOwner) && (caller.principal_kind === 'agent' || role !== 'owner')) {
        return caller.principal_kind === 'agent'
          ? enqueueApproval(s, caller, org, 'org_invite_member', { ...args, org: org.id })
          : ref('ORG_OWNER_ROLE_REQUIRED', 'org_owner_role', { org: org.slug });
      }
      if (!pId && !email) return ref('INVALID_INVITE_TARGET', 'principal_id_or_email', { org: org.slug });
      const wsIds = Array.isArray(args.workspace_ids) ? (args.workspace_ids as string[]) : [];
      if (pId) {
        if (pKind === 'agent' && !s.agentIdentities.some((a) => a.id === pId)) {
          s.agentIdentities.push({ id: pId, owner_user_id: caller.principal_kind === 'user' ? caller.principal_id : (agentOwner(s, ctx) ?? caller.principal_id), display_name: typeof args.display_name === 'string' ? args.display_name : pId, created_at: now });
        }
        if (ex) { ex.role = tRole; ex.revoked_at = null; } else s.orgMemberships.push({ org_id: org.id, principal_kind: pKind, principal_id: pId, role: tRole, created_at: now, revoked_at: null });
        for (const wid of wsIds) executeOrgChannelMcpTool(s, caller, 'org_assign_workspace_member', { org: org.id, workspace: wid, principal_id: pId, principal_kind: pKind, role: tRole });
      }
      if (email) {
        s.orgInvites = s.orgInvites ?? [];
        const inv = { invite_id: `inv_${s.orgInvites.length + 1}`, org_id: org.id, email, principal_kind: pKind, principal_id: pId, role: tRole, workspace_ids: wsIds, invited_by: caller.principal_id, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), created_at: now, revoked_at: null };
        s.orgInvites.push(inv);
        return { ok: true, invite: inv, principal_id: pId, role: tRole };
      }
      return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, role: tRole };
    }
    if (name === 'org_set_member_role') {
      const pId = String(args.principal_id);
      const pKind = inferKind(pId);
      const nextRole = String(args.role) as OrgRole;
      const mem = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId) && isLive(m));
      if (!mem) return ref('MEMBER_NOT_FOUND', 'org_membership', { org: org.slug });
      if ((nextRole === 'owner' || mem.role === 'owner') && (caller.principal_kind === 'agent' || role !== 'owner' || args.request_approval === true)) {
        return caller.principal_kind === 'agent' || args.request_approval === true
          ? enqueueApproval(s, caller, org, 'org_set_member_role', { org: org.id, principal_id: pId, principal_kind: pKind, role: nextRole })
          : ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
      }
      if (mem.role === 'owner' && nextRole !== 'owner' && pKind === 'user' && humanOwners() <= 1) return ref('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
      mem.role = nextRole;
      return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, role: nextRole };
    }
    if (name === 'org_remove_member') {
      const pId = String(args.principal_id);
      const pKind = inferKind(pId);
      const mem = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId) && isLive(m));
      if (!mem) return ref('MEMBER_NOT_FOUND', 'org_membership', { org: org.slug });
      if (mem.role === 'owner' && pKind === 'user') {
        if (humanOwners() <= 1) return ref('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
        if (role !== 'owner') return ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
      }
      return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, ...cascadeOrgMemberRemoval(s, { org_id: org.id, principal_kind: pKind, principal_id: pId, now }) };
    }
  }

  if (name === 'workspace_join') return executeWorkspaceJoinTool(s, caller, args, now);

  const scopeRes = resolveMcpOrgWorkspaceChannel(s, caller, args as Record<string, string | null | undefined>);
  if (!scopeRes.ok) return { ok: false, status: 'refused', refusal: scopeRes.refusal };
  const { org, workspace: ws } = scopeRes;
  const callerOrgRole = effCallerOrgRole(s, ctx, org.id);

  const wsHandled = executeWorkspaceScopeTool(s, caller, ctx, org, ws, callerOrgRole, name, args, now);
  if (wsHandled) return wsHandled;

  return executeChannelMcpSubtool(s, caller, ctx, org, ws, callerOrgRole, name, args, now);
}

registerDefaultOrgChannelCliExecutor((s, c, t, a) => executeOrgChannelMcpTool(s as OrgChannelSlice3State, c, t, a));
