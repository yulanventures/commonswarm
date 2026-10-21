import {
  type OrganizationSummary, type OrgRole, type PrincipalKind,
  agentOwner, canReadOrg, canReadWorkspace, cascadeOrgMemberRemoval, isLive, isPrin, norm, orgRole,
} from '../../../src/protocol/org-channels-contract.js';
import { effCallerOrgRole } from '../../../src/cloud/org-channels-cli.js';
import {
  type McpCallerAuth, type OrgChannelSlice3State, OrgChannelToolInputError, type OrgChannelToolName,
  executeMultiOrgWhoami, resolveMcpOrgWorkspaceChannel, resolveSeatIdFromAuthOrArgs, validateOrgChannelToolArguments,
} from './org-channels-tools.js';
import {
  SLUG_RE, enqueueApproval, executeOrgLogoOrWorkspaceCreate, executeWorkspaceJoinTool, executeWorkspaceScopeTool, ref, resolveOrg, toCtx,
} from './org-channels-subtools.js';
import { executeChannelMcpSubtool } from './org-channels-channels.js';

const ADMIN_WS_TOOLS = new Set(['org_assign_workspace_member', 'org_remove_workspace_member', 'workspace_list_members', 'org_move_workspace']);
const ORG_OPS = new Set(['org_get', 'org_update', 'org_delete', 'org_switch_default', 'org_list_members', 'org_invite_member', 'org_set_member_role', 'org_remove_member', 'workspace_create', 'org_logo_upload', 'org_logo_remove']);
const str = (v: unknown) => (typeof v === 'string' && v.trim()) || null;

function resolveAdminWs(s: OrgChannelSlice3State, caller: McpCallerAuth, args: Record<string, unknown>, seatId: string | null) {
  const ctx = toCtx(caller), rawWs = str(args.workspace) ?? '';
  const [wPre, wSuf] = rawWs.includes('/') ? rawWs.split('/', 2) : ['', rawWs], rawOrg = str(args.org) || wPre.trim(), wsTok = norm(wSuf!);
  const cands = s.workspaces.filter((w) => {
    if (!isLive(w)) return false;
    const o = s.organizations.find((x) => x.id === w.org_id && isLive(x)), r = o ? effCallerOrgRole(s, ctx, o.id) : null;
    if (!o || (r !== 'owner' && r !== 'admin') || (rawOrg && o.id !== rawOrg && norm(o.slug) !== norm(rawOrg))) return false;
    return !rawWs || w.workspace_id === rawWs || norm(w.slug) === wsTok;
  });
  if (cands.length !== 1) return null;
  const ws = cands[0]!, org = s.organizations.find((x) => x.id === ws.org_id)!;
  return seatId && (s.seats ?? []).find((x) => x.seat_id === seatId && isLive(x))?.workspace_id !== ws.workspace_id ? null : { org, workspace: ws };
}

export function executeOrgChannelMcpTool(
  s: OrgChannelSlice3State, caller: McpCallerAuth, name: OrgChannelToolName | string, rawArgs: Record<string, unknown> = {},
): Record<string, unknown> {
  const snap = structuredClone(s), res = ((): Record<string, unknown> => {
    let args: Record<string, unknown>;
    try { args = validateOrgChannelToolArguments(name, rawArgs); } catch (err) {
      if (err instanceof OrgChannelToolInputError) return { ...ref('INVALID_ARGUMENTS', err.message), error: err.code };
      throw err;
    }
    const sr = resolveSeatIdFromAuthOrArgs(s, caller, args);
    if (!sr.ok) return { ok: false, status: 'refused', refusal: sr.refusal };
    const now = new Date().toISOString(), ctx = toCtx(caller), hasSel = Boolean(str(args.org) || str(args.workspace) || str(args.channel));
    const inferKind = (id: string) => ((args.principal_kind as PrincipalKind | undefined) ?? (s.agentIdentities.some((a) => a.id === id) ? 'agent' : 'user')) as PrincipalKind;

    if (name === 'whoami' || name === 'discover') {
      const r = executeMultiOrgWhoami(s, caller, args);
      if (!r.ok || name === 'whoami') return { ...r };
      return {
        ...r, total_organizations: r.organizations.length,
        total_workspaces: r.organizations.reduce((a, o) => a + o.workspaces.length, 0),
        total_channels: r.organizations.reduce((a, o) => a + o.workspaces.reduce((w, x) => w + x.channels.length, 0), 0),
      };
    }

    if (name === 'org_list' || name === 'org_create') {
      if (hasSel) { const or = resolveOrg(s, caller, args); if (!or.ok) return or; }
      if (name === 'org_list') {
        return { ok: true, organizations: s.organizations.filter((o) => isLive(o) && canReadOrg(s, ctx, o.id)).map((o) => ({
          ...o, role: effCallerOrgRole(s, ctx, o.id)!, workspace_count: s.workspaces.filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, ctx, w.workspace_id)).length,
        })) };
      }
      const slug = norm(String(args.slug)), dn = String(args.display_name).trim();
      if (!SLUG_RE.test(slug) || slug.length > 48 || !dn) return ref('INVALID_ORG_SLUG', 'valid_org_slug', { org: slug });
      if (s.organizations.some((o) => norm(o.slug) === slug && isLive(o))) return ref('ORG_SLUG_TAKEN', 'unique_org_slug', { org: slug });
      const uid = caller.principal_kind === 'user' ? caller.principal_id : (agentOwner(s, ctx) ?? caller.principal_id);
      const org: OrganizationSummary = { id: `org-${s.organizations.length + 1}`, slug, display_name: dn, logo_object_key: null, logo_updated_at: null, created_by: uid, created_at: now, updated_at: now, archived_at: null };
      s.organizations.push(org);
      s.orgMemberships.push({ org_id: org.id, principal_kind: 'user', principal_id: uid, role: 'owner', created_at: now, revoked_at: null });
      if (caller.principal_kind === 'agent') s.orgMemberships.push({ org_id: org.id, principal_kind: 'agent', principal_id: caller.principal_id, role: 'admin', created_at: now, revoked_at: null });
      return { ok: true, organization: org };
    }

    if (name === 'org_confirm_action') {
      const selOrg = sr.seat_id || hasSel ? resolveOrg(s, caller, args) : null;
      if (selOrg && !selOrg.ok) return selOrg;
      const dec = String(args.decision);
      if (dec !== 'approve' && dec !== 'reject') return { ...ref('INVALID_ARGUMENTS', 'decision_approve_or_reject'), error: 'INVALID_ARGUMENTS' };
      const card = (s.approvalRequests ?? []).find((a) => a.approval_id === String(args.approval_id));
      if (!card) return ref('APPROVAL_NOT_FOUND', 'approval_id');
      if (selOrg && selOrg.ok && selOrg.org.id !== card.org_id) return ref('WORKSPACE_SEAT_MISMATCH', 'approval_org_scope', { org: selOrg.org.slug, seat_id: sr.seat_id });
      if (card.state !== 'pending') return ref('APPROVAL_ALREADY_DECIDED', 'pending_approval', { org: card.org_id });
      if (caller.principal_kind !== 'user' || orgRole(s, card.org_id, 'user', caller.principal_id) !== 'owner') return ref('ORG_OWNER_REQUIRED', 'human_org_owner', { org: card.org_id });
      if (dec === 'reject') {
        Object.assign(card, { decided_by: caller.principal_id, decided_at: now, state: 'rejected' });
        return { ok: true, status: 'rejected', approval: card };
      }
      const executed = executeOrgChannelMcpTool(s, { principal_kind: 'user', principal_id: caller.principal_id }, card.action_kind, card.payload);
      if (executed.ok !== true) {
        const errCode = (executed.refusal as { code?: string } | undefined)?.code ?? String(executed.error ?? 'EXECUTION_FAILED');
        return { ...executed, ok: false, status: 'refused', error: errCode, approval: card, executed };
      }
      Object.assign(card, { decided_by: caller.principal_id, decided_at: now, state: 'approved' });
      return { ok: true, status: 'approved', approval: card, executed };
    }

    if (name === 'workspace_list') {
      const or = hasSel ? resolveOrg(s, caller, args) : null;
      if (or && !or.ok) return or;
      return { ok: true, workspaces: s.workspaces.filter((w) => isLive(w) && (!or || w.org_id === or.org.id) && canReadWorkspace(s, ctx, w.workspace_id)).map((w) => {
        const o = s.organizations.find((x) => x.id === w.org_id)!;
        return { ...w, org_slug: o.slug, selector: `${o.slug}/${w.slug}` };
      }) };
    }

    if (ORG_OPS.has(name)) {
      const or = resolveOrg(s, caller, args);
      if (!or.ok) return or;
      const { org } = or, role = effCallerOrgRole(s, ctx, org.id);

      if (name === 'org_get') {
        return { ok: true, organization: org, role, workspaces: s.workspaces.filter((w) => w.org_id === org.id && isLive(w) && canReadWorkspace(s, ctx, w.workspace_id)), logo: s.orgLogos?.[org.id] ?? null };
      }
      if (name === 'org_switch_default') {
        let defWsId: string | null = null;
        const rawW = str(args.workspace);
        if (rawW) {
          const wsTok = norm(rawW.includes('/') ? rawW.split('/', 2)[1]! : rawW);
          const ws = s.workspaces.find((w) => w.org_id === org.id && isLive(w) && (w.workspace_id === rawW || norm(w.slug) === wsTok));
          if (!ws || !canReadWorkspace(s, ctx, ws.workspace_id)) return ref('WORKSPACE_ACCESS_DENIED', 'workspace_grant', { org: org.slug, workspace: rawW });
          defWsId = ws.workspace_id;
        }
        s.connectionPolicies = s.connectionPolicies ?? [];
        const cid = caller.connection_id ?? `conn_${caller.principal_id}`, pol = s.connectionPolicies.find((p) => p.connection_id === cid);
        if (pol) { pol.default_org_id = org.id; pol.default_workspace_id = defWsId; }
        else s.connectionPolicies.push({ connection_id: cid, default_org_id: org.id, default_workspace_id: defWsId, revoked_at: null });
        return { ok: true, default_org_id: org.id, default_workspace_id: defWsId, org_slug: org.slug };
      }
      if (name === 'org_list_members') {
        const kind = str(args.kind) ?? 'all';
        const members = s.orgMemberships.filter((m) => m.org_id === org.id && isLive(m) && (kind === 'all' || (kind === 'guest' ? m.role === 'guest' : m.principal_kind === kind))).map((m) => ({ ...m, workspaces: s.workspaceGrants.filter((g) => g.org_id === org.id && isPrin(g, m.principal_kind, m.principal_id) && isLive(g)).map((g) => g.workspace_id) }));
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
        const rawS = str(args.new_slug ?? args.slug), next = rawS ? norm(rawS) : null;
        if (next && next !== norm(org.slug)) {
          if (!SLUG_RE.test(next) || next.length > 48) return ref('INVALID_ORG_SLUG', 'valid_org_slug', { org: next });
          if (s.organizations.some((o) => o.id !== org.id && norm(o.slug) === next && isLive(o))) return ref('ORG_SLUG_TAKEN', 'unique_org_slug', { org: next });
          org.slug = next;
        }
        const dn = str(args.display_name);
        if (dn) org.display_name = dn;
        org.updated_at = now;
        return { ok: true, organization: org };
      }
      const hOwn = () => s.orgMemberships.filter((m) => m.org_id === org.id && m.principal_kind === 'user' && m.role === 'owner' && isLive(m)).length;
      if (name === 'org_invite_member') {
        const tRole = ((args.role as OrgRole | undefined) ?? 'member') as OrgRole, pId = str(args.principal_id);
        const pKind = ((args.principal_kind as PrincipalKind | undefined) ?? (pId ? inferKind(pId) : 'user')) as PrincipalKind;
        const email = str(args.email)?.toLowerCase() ?? null;
        const ex = pId ? s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId)) : undefined, isOwn = Boolean(ex && isLive(ex) && ex.role === 'owner');
        if (isOwn && tRole !== 'owner' && hOwn() <= 1) {
          return role !== 'owner' ? ref('ORG_OWNER_ROLE_REQUIRED', 'org_owner_role', { org: org.slug }) : ref('LAST_ORG_OWNER_REQUIRED', 'another_org_owner', { org: org.slug });
        }
        if ((tRole === 'owner' || isOwn) && (caller.principal_kind === 'agent' || role !== 'owner')) {
          return caller.principal_kind === 'agent' ? enqueueApproval(s, caller, org, 'org_invite_member', { ...args, org: org.id }) : ref('ORG_OWNER_ROLE_REQUIRED', 'org_owner_role', { org: org.slug });
        }
        if (!pId && !email) return ref('INVALID_INVITE_TARGET', 'principal_id_or_email', { org: org.slug });
        const wIds: string[] = [];
        for (const wid of Array.isArray(args.workspace_ids) ? (args.workspace_ids as string[]) : []) {
          const chk = resolveMcpOrgWorkspaceChannel(s, caller, { org: org.id, workspace: wid });
          if (chk.ok) { wIds.push(chk.workspace.workspace_id); continue; }
          const fb = chk.refusal.code === 'WORKSPACE_ACCESS_DENIED' ? resolveAdminWs(s, caller, { org: org.id, workspace: wid }, sr.seat_id) : null;
          if (!fb) return { ok: false, status: 'refused', refusal: chk.refusal };
          wIds.push(fb.workspace.workspace_id);
        }
        if (pId) {
          if (pKind === 'agent' && !s.agentIdentities.some((a) => a.id === pId)) {
            s.agentIdentities.push({ id: pId, owner_user_id: caller.principal_kind === 'user' ? caller.principal_id : (agentOwner(s, ctx) ?? caller.principal_id), display_name: str(args.display_name) ?? pId, created_at: now });
          }
          if (ex) { ex.role = tRole; ex.revoked_at = null; } else s.orgMemberships.push({ org_id: org.id, principal_kind: pKind, principal_id: pId, role: tRole, created_at: now, revoked_at: null });
          for (const wid of wIds) {
            const gr = executeOrgChannelMcpTool(s, caller, 'org_assign_workspace_member', { org: org.id, workspace: wid, principal_id: pId, principal_kind: pKind, role: tRole });
            if (gr.ok !== true) return gr;
          }
        }
        if (email) {
          s.orgInvites = s.orgInvites ?? [];
          const inv = { invite_id: `inv_${s.orgInvites.length + 1}`, org_id: org.id, email, principal_kind: pKind, principal_id: pId, role: tRole, workspace_ids: wIds, invited_by: caller.principal_id, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString(), created_at: now, revoked_at: null };
          s.orgInvites.push(inv);
          return { ok: true, invite: inv, principal_id: pId, role: tRole };
        }
        return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, role: tRole };
      }
      if (name === 'org_set_member_role') {
        const pId = String(args.principal_id), pKind = inferKind(pId), nextRole = String(args.role) as OrgRole;
        const mem = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId) && isLive(m));
        if (!mem) return ref('MEMBER_NOT_FOUND', 'org_membership', { org: org.slug });
        if ((nextRole === 'owner' || mem.role === 'owner') && (caller.principal_kind === 'agent' || role !== 'owner' || args.request_approval === true)) {
          return caller.principal_kind === 'agent' || args.request_approval === true
            ? enqueueApproval(s, caller, org, 'org_set_member_role', { org: org.id, principal_id: pId, principal_kind: pKind, role: nextRole })
            : ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
        }
        if (mem.role === 'owner' && nextRole !== 'owner' && pKind === 'user' && hOwn() <= 1) return ref('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
        mem.role = nextRole;
        return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, role: nextRole };
      }
      if (name === 'org_remove_member') {
        const pId = String(args.principal_id), pKind = inferKind(pId);
        const mem = s.orgMemberships.find((m) => m.org_id === org.id && isPrin(m, pKind, pId) && isLive(m));
        if (!mem) return ref('MEMBER_NOT_FOUND', 'org_membership', { org: org.slug });
        if (mem.role === 'owner' && pKind === 'user') {
          if (hOwn() <= 1) return ref('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
          if (role !== 'owner') return ref('ORG_OWNER_REQUIRED', 'org_owner_role', { org: org.slug });
        }
        return { ok: true, org_id: org.id, principal_id: pId, principal_kind: pKind, ...cascadeOrgMemberRemoval(s, { org_id: org.id, principal_kind: pKind, principal_id: pId, now }) };
      }
    }

    if (name === 'workspace_join') return executeWorkspaceJoinTool(s, caller, args, now);

    const scopeRes = resolveMcpOrgWorkspaceChannel(s, caller, args as Record<string, string | null | undefined>);
    const fb = !scopeRes.ok && scopeRes.refusal.code === 'WORKSPACE_ACCESS_DENIED' && ADMIN_WS_TOOLS.has(name) ? resolveAdminWs(s, caller, args, sr.seat_id) : null;
    if (!scopeRes.ok && !fb) return { ok: false, status: 'refused', refusal: scopeRes.refusal };
    const { org, workspace: ws } = scopeRes.ok ? scopeRes : fb!;
    const cRole = effCallerOrgRole(s, ctx, org.id);

    return executeWorkspaceScopeTool(s, caller, ctx, org, ws, cRole, name, args, now)
      ?? executeChannelMcpSubtool(s, caller, ctx, org, ws, cRole, name, args, now);
  })();
  if (res.ok !== true) {
    Object.keys(s).forEach((k) => delete (s as unknown as Record<string, unknown>)[k]); Object.assign(s, snap);
  }
  return res;
}
