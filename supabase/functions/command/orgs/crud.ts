import {
  type CallerContext,
  type ChannelSummary,
  type OrganizationSummary,
  type OrgMembershipRecord,
  type OrgRole,
  type WorkspacePrincipalGrant,
  type WorkspaceRecord,
  agentOwner,
  canReadChannel,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
  fail,
  isLive,
  isPrin,
  norm,
  orgRole,
} from '../../../../src/protocol/org-channels-contract.js';
import {
  type OrgAuthorityState,
  authorizeOrgAction,
  effectiveCallerOrgRole,
  findLiveOrg,
  isValidOrgSlug,
  registerOrgActionExecutor,
} from './invites.js';

export function orgCreate(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    id?: string;
    slug: string;
    display_name: string;
    default_workspace?: {
      workspace_id?: string;
      slug?: string;
      name?: string;
    } | boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const slug = norm(input.slug ?? '');
  const displayName = (input.display_name ?? '').trim();

  if (!isValidOrgSlug(slug)) {
    return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: input.slug ?? null });
  }
  if (!displayName) {
    return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: slug });
  }
  if (state.organizations.some((o) => norm(o.slug) === slug)) {
    return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: slug });
  }

  const ownerUserId =
    caller.principal_kind === 'user' ? caller.principal_id : agentOwner(state, caller);
  if (!ownerUserId) {
    return fail('ORG_ACCESS_DENIED', 'authenticated_owner', { org: slug });
  }

  const orgId = input.id?.trim() || `org-${crypto.randomUUID()}`;
  const organization: OrganizationSummary = {
    id: orgId,
    slug,
    display_name: displayName,
    logo_object_key: null,
    logo_updated_at: null,
    created_by: ownerUserId,
    created_at: now,
    updated_at: now,
    archived_at: null,
  };
  state.organizations.push(organization);

  const ownerMembership: OrgMembershipRecord = {
    id: `om-${crypto.randomUUID()}`,
    org_id: orgId,
    principal_kind: 'user',
    principal_id: ownerUserId,
    role: 'owner',
    invited_by: ownerUserId,
    created_at: now,
    revoked_at: null,
  };
  state.orgMemberships.push(ownerMembership);

  let agentMembership: OrgMembershipRecord | null = null;
  if (caller.principal_kind === 'agent') {
    agentMembership = {
      id: `om-${crypto.randomUUID()}`,
      org_id: orgId,
      principal_kind: 'agent',
      principal_id: caller.principal_id,
      role: 'admin',
      invited_by: ownerUserId,
      created_at: now,
      revoked_at: null,
    };
    state.orgMemberships.push(agentMembership);
  }

  let createdWorkspace: WorkspaceRecord | null = null;
  let generalChannel: ChannelSummary | null = null;
  if (input.default_workspace) {
    const wsCfg = typeof input.default_workspace === 'object' ? input.default_workspace : {};
    const wsSlug = norm(wsCfg.slug || 'main');
    const wsName = (wsCfg.name || displayName).trim();
    const wsId = wsCfg.workspace_id || `ws-${crypto.randomUUID()}`;
    createdWorkspace = {
      workspace_id: wsId,
      org_id: orgId,
      slug: wsSlug,
      name: wsName,
      archived_at: null,
    };
    state.workspaces.push(createdWorkspace);

    const ownerGrant: WorkspacePrincipalGrant = {
      id: `wpg-${crypto.randomUUID()}`,
      workspace_id: wsId,
      org_id: orgId,
      principal_kind: 'user',
      principal_id: ownerUserId,
      role: 'owner',
      granted_by: ownerUserId,
      created_at: now,
      revoked_at: null,
    };
    state.workspaceGrants.push(ownerGrant);

    if (caller.principal_kind === 'agent') {
      state.workspaceGrants.push({
        id: `wpg-${crypto.randomUUID()}`,
        workspace_id: wsId,
        org_id: orgId,
        principal_kind: 'agent',
        principal_id: caller.principal_id,
        role: 'admin',
        granted_by: ownerUserId,
        created_at: now,
        revoked_at: null,
      });
    }

    generalChannel = {
      channel_id: `ch-${crypto.randomUUID()}`,
      workspace_id: wsId,
      org_id: orgId,
      slug: 'general',
      purpose: 'General coordination',
      visibility: 'workspace',
      join_policy: 'open',
      created_by_principal: ownerUserId,
      created_by_kind: 'user',
      created_at: now,
      archived_at: null,
    };
    state.channels.push(generalChannel);
  }

  return {
    ok: true as const,
    status: 'executed' as const,
    organization,
    membership: ownerMembership,
    agent_membership: agentMembership,
    workspace: createdWorkspace,
    general_channel: generalChannel,
  };
}

export function orgUpdate(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    slug?: string;
    display_name?: string;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: 'admin',
    action_kind: 'org_update',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  if (input.slug !== undefined) {
    const nextSlug = norm(input.slug);
    if (!isValidOrgSlug(nextSlug)) {
      return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: org.slug });
    }
    if (state.organizations.some((o) => o.id !== org.id && norm(o.slug) === nextSlug)) {
      return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: nextSlug });
    }
    org.slug = nextSlug;
  }

  if (input.display_name !== undefined) {
    const nextName = input.display_name.trim();
    if (!nextName) {
      return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: org.slug });
    }
    org.display_name = nextName;
  }

  org.updated_at = now;
  return { ok: true as const, status: 'executed' as const, organization: org };
}

export function orgDelete(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    org_id: string;
    confirm_slug?: string;
    confirm?: boolean;
    allow_last_org?: boolean;
    require_approval?: boolean;
    now?: string;
  },
) {
  const now = input.now ?? new Date().toISOString();
  const org = findLiveOrg(state, input.org_id);
  if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

  const auth = authorizeOrgAction(state, caller, {
    org,
    min_role: 'owner',
    action_kind: 'org_delete',
    payload: { ...input },
    require_approval: input.require_approval,
    now,
  });
  if (auth.status === 'refused') return auth.result;
  if (auth.status === 'approval_required') return auth.result;

  if (input.confirm_slug !== undefined && norm(input.confirm_slug) !== norm(org.slug)) {
    return fail('ORG_DELETE_CONFIRMATION_MISMATCH', 'matching_confirm_slug', { org: org.slug });
  }

  const ownerLiveOrgs = state.organizations.filter(
    (o) => isLive(o) && orgRole(state, o.id, 'user', auth.actor_user_id) !== null,
  );
  const explicitConfirmed =
    input.allow_last_org === true ||
    input.confirm === true ||
    (input.confirm_slug !== undefined && norm(input.confirm_slug) === norm(org.slug));

  if (ownerLiveOrgs.length <= 1 && !explicitConfirmed) {
    return fail('CANNOT_DELETE_LAST_ORG', 'non_last_org_or_explicit_confirmation', {
      org: org.slug,
    });
  }

  const closedSeatIds: string[] = [];
  const archivedWorkspaceIds: string[] = [];

  for (const ws of state.workspaces) {
    if (ws.org_id === org.id && isLive(ws)) {
      archivedWorkspaceIds.push(ws.workspace_id);
      for (const m of state.orgMemberships) {
        if (m.org_id === org.id && isLive(m)) {
          const res = cascadeWorkspaceMemberRemoval(state, {
            workspace_id: ws.workspace_id,
            principal_kind: m.principal_kind,
            principal_id: m.principal_id,
            now,
          });
          for (const sid of res.closed_seat_ids) {
            if (!closedSeatIds.includes(sid)) closedSeatIds.push(sid);
          }
        }
      }
      for (const seat of state.seats ?? []) {
        if (seat.workspace_id === ws.workspace_id && seat.revoked_at == null) {
          seat.revoked_at = now;
          if (!closedSeatIds.includes(seat.seat_id)) closedSeatIds.push(seat.seat_id);
        }
      }
      for (const ch of state.channels) {
        if (ch.workspace_id === ws.workspace_id && ch.archived_at == null) {
          ch.archived_at = now;
        }
      }
      ws.archived_at = now;
    }
  }

  for (const m of state.orgMemberships) {
    if (m.org_id === org.id && m.revoked_at == null) m.revoked_at = now;
  }

  org.archived_at = now;
  org.updated_at = now;

  return {
    ok: true as const,
    status: 'executed' as const,
    organization: org,
    archived_workspace_ids: archivedWorkspaceIds,
    closed_seat_ids: closedSeatIds,
  };
}

export function orgList(
  state: OrgAuthorityState,
  caller: CallerContext,
) {
  const organizations = state.organizations
    .filter((o) => isLive(o) && canReadOrg(state, caller, o.id))
    .map((o) => {
      const role: OrgRole = effectiveCallerOrgRole(state, caller, o.id) ?? 'guest';
      const workspaces = state.workspaces
        .filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(state, caller, w.workspace_id))
        .map((w) => {
          const grant = state.workspaceGrants.find(
            (g) =>
              g.workspace_id === w.workspace_id &&
              isPrin(g, caller.principal_kind, caller.principal_id) &&
              isLive(g),
          );
          const channels = state.channels
            .filter(
              (ch) =>
                ch.workspace_id === w.workspace_id &&
                isLive(ch) &&
                canReadChannel(state, caller, ch.channel_id),
            )
            .map((ch) => ({
              channel_id: ch.channel_id,
              slug: ch.slug,
              visibility: ch.visibility,
              join_policy: ch.join_policy,
            }));
          return {
            workspace_id: w.workspace_id,
            slug: w.slug,
            name: w.name,
            role: grant?.role ?? role,
            channels,
          };
        });
      return {
        org_id: o.id,
        slug: o.slug,
        display_name: o.display_name,
        logo_object_key: o.logo_object_key ?? null,
        logo_updated_at: o.logo_updated_at ?? null,
        role,
        workspaces,
      };
    });

  return { ok: true as const, organizations };
}

registerOrgActionExecutor('org_create', (s, c, p) =>
  orgCreate(s, c, p as Parameters<typeof orgCreate>[2]),
);
registerOrgActionExecutor('org_update', (s, c, p) =>
  orgUpdate(s, c, p as Parameters<typeof orgUpdate>[2]),
);
registerOrgActionExecutor('org_delete', (s, c, p) =>
  orgDelete(s, c, p as Parameters<typeof orgDelete>[2]),
);

export const org_create = orgCreate;
export const org_update = orgUpdate;
export const org_delete = orgDelete;
export const org_list = orgList;
