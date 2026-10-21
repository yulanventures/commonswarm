import {
  type CallerContext,
  type OrgMembershipRecord,
  type OrgRole,
  type PrincipalKind,
  canReadOrg,
  cascadeOrgMemberRemoval,
  fail,
  isLive,
  isPrin,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  authorizeOrgAction,
  findLiveOrg,
  isValidOrgRole,
  registerOrgActionExecutor,
} from './invites.js';

export interface OrgRosterEntry {
  org_id: string;
  principal_kind: PrincipalKind;
  principal_id: string;
  display_name: string;
  role: OrgRole;
  owner_user_id: string | null;
  workspaces: Array<{
    workspace_id: string;
    workspace_slug: string;
    workspace_name: string;
    role: OrgRole;
  }>;
  active_seat_ids: string[];
  created_at: string;
}

export function orgListMembers(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    filter?: 'all' | 'user' | 'agent' | 'guest';
  },
) {
  const org = findLiveOrg(state, input.org_id);
  if (!org || !canReadOrg(state, caller, org.id)) {
    return fail('ORG_ACCESS_DENIED', 'org_membership', { org: input.org_id });
  }

  const orgWorkspaces = state.workspaces.filter((w) => w.org_id === org.id && isLive(w));
  const orgWsIds = new Set(orgWorkspaces.map((w) => w.workspace_id));
  const filter = input.filter ?? 'all';

  const members: OrgRosterEntry[] = state.orgMemberships
    .filter((m) => m.org_id === org.id && isLive(m))
    .filter((m) => {
      if (filter === 'user') return m.principal_kind === 'user';
      if (filter === 'agent') return m.principal_kind === 'agent';
      if (filter === 'guest') return m.role === 'guest';
      return true;
    })
    .map((m) => {
      const agentIdentity =
        m.principal_kind === 'agent'
          ? state.agentIdentities.find((a) => a.id === m.principal_id)
          : undefined;
      const workspaces = state.workspaceGrants
        .filter(
          (g) =>
            orgWsIds.has(g.workspace_id) &&
            isPrin(g, m.principal_kind, m.principal_id) &&
            isLive(g),
        )
        .map((g) => {
          const ws = orgWorkspaces.find((w) => w.workspace_id === g.workspace_id)!;
          return {
            workspace_id: ws.workspace_id,
            workspace_slug: ws.slug,
            workspace_name: ws.name,
            role: g.role,
          };
        });

      const principalApIds = new Set(
        (state.agentPrincipals ?? [])
          .filter(
            (ap) =>
              orgWsIds.has(ap.workspace_id) &&
              isLive(ap) &&
              ((m.principal_kind === 'agent' && ap.agent_identity_id === m.principal_id) ||
                (m.principal_kind === 'user' && ap.owner_user_id === m.principal_id)),
          )
          .map((ap) => ap.principal_id),
      );

      const activeSeatIds = (state.seats ?? [])
        .filter(
          (s) =>
            orgWsIds.has(s.workspace_id) &&
            isLive(s) &&
            (principalApIds.has(s.principal_id) ||
              (m.principal_kind === 'agent' && s.agent_identity_id === m.principal_id)),
        )
        .map((s) => s.seat_id);

      return {
        org_id: org.id,
        principal_kind: m.principal_kind,
        principal_id: m.principal_id,
        display_name: agentIdentity?.display_name ?? m.principal_id,
        role: m.role,
        owner_user_id: agentIdentity?.owner_user_id ?? null,
        workspaces,
        active_seat_ids: activeSeatIds,
        created_at: m.created_at,
      };
    });

  return {
    ok: true as const,
    org_id: org.id,
    org_slug: org.slug,
    members,
  };
}

export function orgSetMemberRole(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    role: OrgRole;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  if (!isValidOrgRole(input.role)) {
    return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug });
  }
  if (input.principal_kind !== 'user' && input.principal_kind !== 'agent') {
    return fail('INVALID_PRINCIPAL_KIND', 'user_or_agent_principal', { org: org.slug });
  }
  if (input.principal_kind === 'agent') {
    const ai = state.agentIdentities.find((a) => a.id === input.principal_id && isLive(a));
    if (!ai) {
      return fail('AGENT_IDENTITY_NOT_FOUND', 'live_agent_identity', { org: org.slug });
    }
  }

  const existing = state.orgMemberships.find(
    (m) => m.org_id === org.id && isPrin(m, input.principal_kind, input.principal_id),
  );
  const wasLiveOwner = Boolean(existing && isLive(existing) && existing.role === 'owner');
  const minRole: 'owner' | 'admin' =
    input.role === 'owner' || wasLiveOwner ? 'owner' : 'admin';

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: minRole,
    action_kind: 'org_set_member_role',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  if (wasLiveOwner && input.role !== 'owner') {
    const otherOwners = state.orgMemberships.filter(
      (m) =>
        m.org_id === org.id &&
        isLive(m) &&
        m.role === 'owner' &&
        !isPrin(m, input.principal_kind, input.principal_id),
    );
    if (otherOwners.length === 0) {
      return fail('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
    }
  }

  let membership: OrgMembershipRecord;
  if (existing) {
    existing.role = input.role;
    existing.invited_by = auth.actor_user_id;
    existing.revoked_at = null;
    membership = existing;
  } else {
    membership = {
      id: `om-${crypto.randomUUID()}`,
      org_id: org.id,
      principal_kind: input.principal_kind,
      principal_id: input.principal_id,
      role: input.role,
      invited_by: auth.actor_user_id,
      created_at: now,
      revoked_at: null,
    };
    state.orgMemberships.push(membership);
  }

  return {
    ok: true as const,
    status: 'executed' as const,
    membership,
  };
}

export function orgRemoveMember(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const existing = state.orgMemberships.find(
    (m) => m.org_id === org.id && isPrin(m, input.principal_kind, input.principal_id),
  );
  const wasLiveOwner = Boolean(existing && isLive(existing) && existing.role === 'owner');

  const isSelfLeave =
    !input.require_approval &&
    isPrin(caller, input.principal_kind, input.principal_id) &&
    canReadOrg(state, caller, org.id);

  if (!isSelfLeave) {
    const minRole: 'owner' | 'admin' = wasLiveOwner ? 'owner' : 'admin';
    const auth = authorizeOrgAction(state, caller, {
      org,
      min_role: minRole,
      action_kind: 'org_remove_member',
      payload: { ...input },
      require_approval: input.require_approval,
      now,
    });
    if (auth.status === 'refused') return auth.result;
    if (auth.status === 'approval_required') return auth.result;
  }

  if (wasLiveOwner) {
    const otherOwners = state.orgMemberships.filter(
      (m) =>
        m.org_id === org.id &&
        isLive(m) &&
        m.role === 'owner' &&
        !isPrin(m, input.principal_kind, input.principal_id),
    );
    if (otherOwners.length === 0) {
      return fail('CANNOT_REMOVE_LAST_ORG_OWNER', 'another_org_owner', { org: org.slug });
    }
  }

  // Ensure an explicit revoked_at row exists so owner-connected inheritance is overridden.
  if (!existing) {
    state.orgMemberships.push({
      id: `om-${crypto.randomUUID()}`,
      org_id: org.id,
      principal_kind: input.principal_kind,
      principal_id: input.principal_id,
      role: 'member',
      created_at: now,
      revoked_at: now,
    });
  }

  const cascaded = cascadeOrgMemberRemoval(state, {
    org_id: org.id,
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
    now,
  });

  return {
    ok: true as const,
    status: 'executed' as const,
    org_id: org.id,
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
    closed_seat_ids: cascaded.closed_seat_ids,
    closed_handle_ids: cascaded.closed_handle_ids,
  };
}

registerOrgActionExecutor('org_set_member_role', (s, c, p) =>
  orgSetMemberRole(s, c, p as Parameters<typeof orgSetMemberRole>[2]),
);
registerOrgActionExecutor('org_remove_member', (s, c, p) =>
  orgRemoveMember(s, c, p as Parameters<typeof orgRemoveMember>[2]),
);

export const org_list_members = orgListMembers;
export const org_set_member_role = orgSetMemberRole;
export const org_remove_member = orgRemoveMember;
