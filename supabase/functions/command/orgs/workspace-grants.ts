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
  type OrgSqlExecutor,
  authorizeOrgAction,
  effectiveCallerOrgRole,
  execOrgSql,
  isValidOrgRole,
  registerOrgActionExecutor,
  resolveWorkspaceSelector,
  upsertAgentPrincipalInWorkspace,
  withOrgTx,
} from './invites.js';

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
    approval_id?: string;
    now?: string;
  },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;

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
      payload: { ...input, role: grantRole },
      require_approval: input.require_approval,
      now,
      db: tx,
    });
    if (auth.status === 'refused') return auth.result;
    if (auth.status === 'approval_required') return auth.result;

    execOrgSql(tx, 'SELECT id FROM swarm.organizations WHERE id = $1 FOR UPDATE', [org.id]);
    execOrgSql(
      tx,
      'SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = $1 FOR UPDATE',
      [ws.workspace_id],
    );

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

    execOrgSql(
      tx,
      'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, revoked_at = NULL',
      [
        grant.id ?? `wpg-${crypto.randomUUID()}`,
        ws.workspace_id,
        org.id,
        input.principal_kind,
        input.principal_id,
        grantRole,
        auth.actor_user_id,
        grant.created_at,
      ],
    );

    let agentPrincipal = null;
    if (input.principal_kind === 'agent') {
      agentPrincipal = upsertAgentPrincipalInWorkspace(
        state,
        ws.workspace_id,
        input.principal_id,
        tx,
      );
    }

    return {
      ok: true as const,
      status: 'executed' as const,
      grant,
      agent_principal: agentPrincipal,
    };
  });
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
    approval_id?: string;
    now?: string;
  },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;

    const existingGrant = state.workspaceGrants.find(
      (g) =>
        g.workspace_id === ws.workspace_id &&
        isPrin(g, input.principal_kind, input.principal_id),
    );
    const existingLiveRole = existingGrant && isLive(existingGrant) ? existingGrant.role : null;
    const wasWsOwner = existingLiveRole === 'owner';
    const minRole: 'owner' | 'admin' = wasWsOwner ? 'owner' : 'admin';

    const auth = authorizeOrgAction(state, caller, {
      org,
      workspace_slug: ws.slug,
      workspace_id: ws.workspace_id,
      min_role: minRole,
      action_kind: 'org_remove_workspace_member',
      payload: { ...input },
      existing_target_role: existingLiveRole,
      require_approval: input.require_approval,
      now,
      db: tx,
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

    execOrgSql(
      tx,
      'SELECT workspace_id FROM swarm.workspaces WHERE workspace_id = $1 FOR UPDATE',
      [ws.workspace_id],
    );
    execOrgSql(
      tx,
      'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at',
      [
        existingGrant?.id ?? `wpg-${crypto.randomUUID()}`,
        ws.workspace_id,
        org.id,
        input.principal_kind,
        input.principal_id,
        existingGrant?.role ?? 'member',
        auth.actor_user_id,
        existingGrant?.created_at ?? now,
        now,
      ],
    );
    execOrgSql(
      tx,
      'UPDATE swarm.channel_memberships SET revoked_at = $4 WHERE workspace_id = $1 AND principal_kind = $2 AND principal_id = $3 AND revoked_at IS NULL',
      [ws.workspace_id, input.principal_kind, input.principal_id, now],
    );
    execOrgSql(
      tx,
      'UPDATE swarm.agent_principals SET revoked_at = $3 WHERE workspace_id = $1 AND (agent_identity_id = $2 OR owner_user_id = $2) AND revoked_at IS NULL',
      [ws.workspace_id, input.principal_id, now],
    );
    if (cascaded.closed_seat_ids.length > 0) {
      execOrgSql(
        tx,
        'UPDATE swarm.hosted_mcp_seats SET revoked_at = $2 WHERE seat_id = ANY($1::uuid[]) AND revoked_at IS NULL',
        [cascaded.closed_seat_ids, now],
      );
    }

    return {
      ok: true as const,
      status: 'executed' as const,
      workspace_id: ws.workspace_id,
      principal_kind: input.principal_kind,
      principal_id: input.principal_id,
      closed_seat_ids: cascaded.closed_seat_ids,
      closed_handle_ids: cascaded.closed_handle_ids,
    };
  });
}

export function workspaceJoin(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    now?: string;
  },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;

    if (!canReadOrg(state, caller, org.id)) {
      return fail('ORG_ACCESS_DENIED', 'org_membership', {
        org: org.slug,
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

    execOrgSql(
      tx,
      'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, revoked_at = NULL',
      [
        grant.id ?? `wpg-${crypto.randomUUID()}`,
        ws.workspace_id,
        org.id,
        caller.principal_kind,
        caller.principal_id,
        grant.role,
        grant.granted_by ?? caller.principal_id,
        grant.created_at,
      ],
    );

    let agentPrincipal = null;
    if (caller.principal_kind === 'agent') {
      agentPrincipal = upsertAgentPrincipalInWorkspace(
        state,
        ws.workspace_id,
        caller.principal_id,
        tx,
      );
    }

    return {
      ok: true as const,
      grant,
      agent_principal: agentPrincipal,
    };
  });
}

export function workspaceLeave(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
    now?: string;
  },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.org_id);
    if (!wsRes.ok) return wsRes;
    const { workspace: ws, org } = wsRes;

    if (!canReadWorkspace(state, caller, ws.workspace_id)) {
      return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
        org: org.slug,
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
          g.principal_kind === 'user' &&
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

    execOrgSql(
      tx,
      'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET revoked_at = EXCLUDED.revoked_at',
      [
        existingGrant?.id ?? `wpg-${crypto.randomUUID()}`,
        ws.workspace_id,
        org.id,
        caller.principal_kind,
        caller.principal_id,
        existingGrant?.role ?? 'member',
        existingGrant?.created_at ?? now,
        now,
      ],
    );
    execOrgSql(
      tx,
      'UPDATE swarm.channel_memberships SET revoked_at = $4 WHERE workspace_id = $1 AND principal_kind = $2 AND principal_id = $3 AND revoked_at IS NULL',
      [ws.workspace_id, caller.principal_kind, caller.principal_id, now],
    );
    if (cascaded.closed_seat_ids.length > 0) {
      execOrgSql(
        tx,
        'UPDATE swarm.hosted_mcp_seats SET revoked_at = $2 WHERE seat_id = ANY($1::uuid[]) AND revoked_at IS NULL',
        [cascaded.closed_seat_ids, now],
      );
    }

    return {
      ok: true as const,
      workspace_id: ws.workspace_id,
      closed_seat_ids: cascaded.closed_seat_ids,
      closed_handle_ids: cascaded.closed_handle_ids,
    };
  });
}

export function workspaceListMembers(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id?: string;
    workspace_id: string;
  },
) {
  const wsRes = resolveWorkspaceSelector(state, caller, input.workspace_id, input.org_id);
  if (!wsRes.ok) {
    if (wsRes.refusal.code === 'AMBIGUOUS_WORKSPACE_SELECTOR') return wsRes;
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      org: input.org_id ?? null,
      workspace: input.workspace_id,
    });
  }
  const { workspace: ws, org } = wsRes;
  if (!canReadWorkspace(state, caller, ws.workspace_id)) {
    return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
      org: org.slug,
      workspace: ws.slug,
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

registerOrgActionExecutor('org_assign_workspace_member', (s, c, p, db) =>
  orgAssignWorkspaceMember(s, c, p as Parameters<typeof orgAssignWorkspaceMember>[2], db),
);
registerOrgActionExecutor('org_remove_workspace_member', (s, c, p, db) =>
  orgRemoveWorkspaceMember(s, c, p as Parameters<typeof orgRemoveWorkspaceMember>[2], db),
);

export const org_assign_workspace_member = orgAssignWorkspaceMember;
export const org_remove_workspace_member = orgRemoveWorkspaceMember;
export const workspace_join = workspaceJoin;
export const workspace_leave = workspaceLeave;
export const workspace_list_members = workspaceListMembers;
