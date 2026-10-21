import {
  type CallerContext,
  type OrgRole,
  type PrincipalKind,
  type WorkspacePrincipalGrant,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
  fail,
  isLive,
  isPrin,
  orgRole,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  authorizeOrgAction,
  effectiveCallerOrgRole,
  findLiveOrg,
  findLiveWorkspace,
  isValidOrgRole,
  registerOrgActionExecutor,
} from './invites.js';

function upsertAgentPrincipalInWorkspace(
  state: OrgAuthorityState,
  workspaceId: string,
  agentIdentityId: string,
) {
  const ai = state.agentIdentities.find((a) => a.id === agentIdentityId && isLive(a));
  if (!ai) return null;
  state.agentPrincipals ??= [];
  let ap = state.agentPrincipals.find(
    (p) => p.workspace_id === workspaceId && p.agent_identity_id === agentIdentityId,
  );
  if (ap) {
    ap.revoked_at = null;
    ap.name = ai.display_name;
    ap.owner_user_id = ai.owner_user_id;
  } else {
    ap = {
      principal_id: `ap-${workspaceId}-${agentIdentityId}`,
      workspace_id: workspaceId,
      agent_identity_id: agentIdentityId,
      owner_user_id: ai.owner_user_id,
      name: ai.display_name,
      revoked_at: null,
    };
    state.agentPrincipals.push(ap);
  }
  return ap;
}

export function orgAssignWorkspaceMember(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    role?: OrgRole;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const ws = findLiveWorkspace(state, input.workspace_id, input.org_id);
  if (!ws) {
    return fail('WORKSPACE_NOT_FOUND', 'workspace', {
      org: input.org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const org = findLiveOrg(state, ws.org_id);
  if (!org) {
    return fail('ORG_NOT_FOUND', 'organization', { org: ws.org_id, workspace: ws.slug });
  }

  const targetOrgRole = orgRole(state, org.id, input.principal_kind, input.principal_id);
  if (input.principal_kind === 'user') {
    if (!targetOrgRole) {
      return fail('TARGET_NOT_IN_ORG', 'org_membership', { org: org.slug, workspace: ws.slug });
    }
  } else {
    const ai = state.agentIdentities.find((a) => a.id === input.principal_id && isLive(a));
    if (!ai) {
      return fail('AGENT_IDENTITY_NOT_FOUND', 'live_agent_identity', {
        org: org.slug,
        workspace: ws.slug,
      });
    }
    const explicitlyRevokedInOrg = state.orgMemberships.some(
      (m) =>
        m.org_id === org.id &&
        isPrin(m, 'agent', input.principal_id) &&
        m.revoked_at != null,
    );
    const ownerRole = orgRole(state, org.id, 'user', ai.owner_user_id);
    if (explicitlyRevokedInOrg || (!targetOrgRole && (!ownerRole || ownerRole === 'guest'))) {
      return fail('TARGET_NOT_IN_ORG', 'agent_org_membership', {
        org: org.slug,
        workspace: ws.slug,
      });
    }
  }

  const grantRole: OrgRole = input.role ?? targetOrgRole ?? 'member';
  if (!isValidOrgRole(grantRole)) {
    return fail('INVALID_ORG_ROLE', 'valid_org_role', { org: org.slug, workspace: ws.slug });
  }

  const minRole: 'owner' | 'admin' = grantRole === 'owner' ? 'owner' : 'admin';
  const auth = authorizeOrgAction(state, caller, {
    org,
    workspace_slug: ws.slug,
    workspace_id: ws.workspace_id,
    min_role: minRole,
    action_kind: 'org_assign_workspace_member',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  let grant = state.workspaceGrants.find(
    (g) =>
      g.workspace_id === ws.workspace_id &&
      isPrin(g, input.principal_kind, input.principal_id),
  );
  if (grant) {
    grant.org_id = org.id;
    grant.role = grantRole;
    grant.granted_by = auth.actor_user_id;
    grant.revoked_at = null;
  } else {
    grant = {
      id: `wpg-${crypto.randomUUID()}`,
      workspace_id: ws.workspace_id,
      org_id: org.id,
      principal_kind: input.principal_kind,
      principal_id: input.principal_id,
      role: grantRole,
      granted_by: auth.actor_user_id,
      created_at: now,
      revoked_at: null,
    };
    state.workspaceGrants.push(grant);
  }

  let agentPrincipal = null;
  if (input.principal_kind === 'agent') {
    agentPrincipal = upsertAgentPrincipalInWorkspace(state, ws.workspace_id, input.principal_id);
  }

  return {
    ok: true as const,
    status: 'executed' as const,
    grant,
    agent_principal: agentPrincipal,
  };
}

export function orgRemoveWorkspaceMember(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    principal_kind: PrincipalKind;
    principal_id: string;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const ws = findLiveWorkspace(state, input.workspace_id, input.org_id);
  if (!ws) {
    return fail('WORKSPACE_NOT_FOUND', 'workspace', {
      org: input.org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const org = findLiveOrg(state, ws.org_id);
  if (!org) {
    return fail('ORG_NOT_FOUND', 'organization', { org: ws.org_id, workspace: ws.slug });
  }

  const existingGrant = state.workspaceGrants.find(
    (g) =>
      g.workspace_id === ws.workspace_id &&
      isPrin(g, input.principal_kind, input.principal_id),
  );
  const wasWsOwner = Boolean(existingGrant && isLive(existingGrant) && existingGrant.role === 'owner');
  const minRole: 'owner' | 'admin' = wasWsOwner ? 'owner' : 'admin';

  const auth = authorizeOrgAction(state, caller, {
    org,
    workspace_slug: ws.slug,
    workspace_id: ws.workspace_id,
    min_role: minRole,
    action_kind: 'org_remove_workspace_member',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  // Record explicit revocation tombstone if the principal previously relied on owner inheritance.
  if (!existingGrant) {
    state.workspaceGrants.push({
      id: `wpg-${crypto.randomUUID()}`,
      workspace_id: ws.workspace_id,
      org_id: org.id,
      principal_kind: input.principal_kind,
      principal_id: input.principal_id,
      role: 'member',
      granted_by: auth.actor_user_id,
      created_at: now,
      revoked_at: now,
    });
  }

  const cascaded = cascadeWorkspaceMemberRemoval(state, {
    workspace_id: ws.workspace_id,
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
    now,
  });

  return {
    ok: true as const,
    status: 'executed' as const,
    workspace_id: ws.workspace_id,
    principal_kind: input.principal_kind,
    principal_id: input.principal_id,
    closed_seat_ids: cascaded.closed_seat_ids,
    closed_handle_ids: cascaded.closed_handle_ids,
  };
}

export function workspaceJoin(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const ws = findLiveWorkspace(state, input.workspace_id, input.org_id);
  if (!ws) {
    return fail('WORKSPACE_NOT_FOUND', 'workspace', {
      org: input.org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const org = findLiveOrg(state, ws.org_id);
  if (!org || !canReadOrg(state, caller, org.id)) {
    return fail('ORG_ACCESS_DENIED', 'org_membership', {
      org: org?.slug ?? input.org_id ?? null,
      workspace: ws.slug,
    });
  }

  const effRole = effectiveCallerOrgRole(state, caller, org.id);
  if (!effRole || effRole === 'guest') {
    return fail('GUEST_CANNOT_SELF_JOIN_WORKSPACE', 'explicit_workspace_grant', {
      org: org.slug,
      workspace: ws.slug,
    });
  }

  const existingGrant = state.workspaceGrants.find(
    (g) =>
      g.workspace_id === ws.workspace_id &&
      isPrin(g, caller.principal_kind, caller.principal_id),
  );
  if (existingGrant && existingGrant.revoked_at != null) {
    return fail('WORKSPACE_ACCESS_REVOKED', 'explicit_workspace_regrant', {
      org: org.slug,
      workspace: ws.slug,
    });
  }

  let grant: WorkspacePrincipalGrant;
  if (existingGrant) {
    grant = existingGrant;
  } else {
    grant = {
      id: `wpg-${crypto.randomUUID()}`,
      workspace_id: ws.workspace_id,
      org_id: org.id,
      principal_kind: caller.principal_kind,
      principal_id: caller.principal_id,
      role: effRole,
      granted_by: caller.principal_id,
      created_at: now,
      revoked_at: null,
    };
    state.workspaceGrants.push(grant);
  }

  let agentPrincipal = null;
  if (caller.principal_kind === 'agent') {
    agentPrincipal = upsertAgentPrincipalInWorkspace(state, ws.workspace_id, caller.principal_id);
  }

  return {
    ok: true as const,
    grant,
    agent_principal: agentPrincipal,
  };
}

export function workspaceLeave(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const ws = findLiveWorkspace(state, input.workspace_id, input.org_id);
  if (!ws) {
    return fail('WORKSPACE_NOT_FOUND', 'workspace', {
      org: input.org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const org = findLiveOrg(state, ws.org_id);
  if (!org || !canReadWorkspace(state, caller, ws.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      org: org?.slug ?? null,
      workspace: ws.slug,
    });
  }

  const existingGrant = state.workspaceGrants.find(
    (g) =>
      g.workspace_id === ws.workspace_id &&
      isPrin(g, caller.principal_kind, caller.principal_id),
  );
  if (existingGrant && isLive(existingGrant) && existingGrant.role === 'owner') {
    const otherWsOwners = state.workspaceGrants.filter(
      (g) =>
        g.workspace_id === ws.workspace_id &&
        isLive(g) &&
        g.role === 'owner' &&
        !isPrin(g, caller.principal_kind, caller.principal_id),
    );
    if (otherWsOwners.length === 0) {
      return fail('CANNOT_REMOVE_LAST_WORKSPACE_OWNER', 'another_workspace_owner', {
        org: org.slug,
        workspace: ws.slug,
      });
    }
  }

  if (!existingGrant) {
    state.workspaceGrants.push({
      id: `wpg-${crypto.randomUUID()}`,
      workspace_id: ws.workspace_id,
      org_id: org.id,
      principal_kind: caller.principal_kind,
      principal_id: caller.principal_id,
      role: 'member',
      created_at: now,
      revoked_at: now,
    });
  }

  const cascaded = cascadeWorkspaceMemberRemoval(state, {
    workspace_id: ws.workspace_id,
    principal_kind: caller.principal_kind,
    principal_id: caller.principal_id,
    now,
  });

  return {
    ok: true as const,
    workspace_id: ws.workspace_id,
    closed_seat_ids: cascaded.closed_seat_ids,
    closed_handle_ids: cascaded.closed_handle_ids,
  };
}

export function workspaceListMembers(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
  },
) {
  const ws = findLiveWorkspace(state, input.workspace_id, input.org_id);
  const org = ws ? findLiveOrg(state, ws.org_id) : undefined;
  if (!ws || !org || !canReadWorkspace(state, caller, ws.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      org: org?.slug ?? input.org_id ?? null,
      workspace: ws?.slug ?? input.workspace_id,
    });
  }

  const members = state.workspaceGrants
    .filter((g) => g.workspace_id === ws.workspace_id && isLive(g))
    .map((g) => {
      const ai =
        g.principal_kind === 'agent'
          ? state.agentIdentities.find((a) => a.id === g.principal_id)
          : undefined;
      const ap =
        g.principal_kind === 'agent'
          ? (state.agentPrincipals ?? []).find(
              (p) =>
                p.workspace_id === ws.workspace_id &&
                p.agent_identity_id === g.principal_id &&
                isLive(p),
            )
          : undefined;
      const seatIds = (state.seats ?? [])
        .filter(
          (s) =>
            s.workspace_id === ws.workspace_id &&
            isLive(s) &&
            ((ap && s.principal_id === ap.principal_id) ||
              (g.principal_kind === 'agent' && s.agent_identity_id === g.principal_id)),
        )
        .map((s) => s.seat_id);

      return {
        workspace_id: ws.workspace_id,
        org_id: org.id,
        principal_kind: g.principal_kind,
        principal_id: g.principal_id,
        display_name: ai?.display_name ?? g.principal_id,
        role: g.role,
        org_role: orgRole(state, org.id, g.principal_kind, g.principal_id),
        agent_principal_id: ap?.principal_id ?? null,
        active_seat_ids: seatIds,
      };
    });

  return {
    ok: true as const,
    org_id: org.id,
    workspace_id: ws.workspace_id,
    members,
  };
}

registerOrgActionExecutor('org_assign_workspace_member', (s, c, p) =>
  orgAssignWorkspaceMember(s, c, p as Parameters<typeof orgAssignWorkspaceMember>[2]),
);
registerOrgActionExecutor('org_remove_workspace_member', (s, c, p) =>
  orgRemoveWorkspaceMember(s, c, p as Parameters<typeof orgRemoveWorkspaceMember>[2]),
);

export const org_assign_workspace_member = orgAssignWorkspaceMember;
export const org_remove_workspace_member = orgRemoveWorkspaceMember;
export const workspace_join = workspaceJoin;
export const workspace_leave = workspaceLeave;
export const workspace_list_members = workspaceListMembers;
