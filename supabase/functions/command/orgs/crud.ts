import {
  CANONICAL_ORG_CHANNEL_LOCK_ORDER,
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
  type OrgSqlExecutor,
  authorizeOrgAction,
  effectiveCallerOrgRole,
  execOrgSql,
  findLiveOrg,
  isValidOrgSlug,
  registerOrgActionExecutor,
  upsertAgentPrincipalInWorkspace,
  withOrgTx,
} from './invites.js';

export function orgCreate(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: {
    id?: string;
    slug: string;
    display_name: string;
    default_workspace?: { workspace_id?: string; slug?: string; name?: string } | boolean;
    now?: string;
  },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const slug = norm(input.slug ?? '');
    const displayName = (input.display_name ?? '').trim();
    if (!isValidOrgSlug(slug)) return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: input.slug ?? null });
    if (!displayName) return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: slug });
    if (state.organizations.some((o) => norm(o.slug) === slug)) return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: slug });

    const ownerUserId = caller.principal_kind === 'user' ? caller.principal_id : agentOwner(state, caller);
    if (!ownerUserId) return fail('ORG_ACCESS_DENIED', 'authenticated_owner', { org: slug });

    const orgId = input.id?.trim() || `org-${crypto.randomUUID()}`;
    const organization: OrganizationSummary = {
      id: orgId, slug, display_name: displayName, logo_object_key: null, logo_updated_at: null,
      created_by: ownerUserId, created_at: now, updated_at: now, archived_at: null,
    };
    state.organizations.push(organization);
    execOrgSql(tx, 'INSERT INTO swarm.organizations (id, slug, display_name, logo_object_key, logo_updated_at, created_by, created_at, updated_at, archived_at) VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6, NULL)', [orgId, slug, displayName, ownerUserId, now, now]);

    const upsertMemSql = 'INSERT INTO swarm.org_memberships (id, org_id, principal_kind, principal_id, role, invited_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NULL) ON CONFLICT (org_id, principal_kind, principal_id) DO UPDATE SET role = EXCLUDED.role, invited_by = EXCLUDED.invited_by, revoked_at = NULL';
    const ownerMembership: OrgMembershipRecord = {
      id: `om-${crypto.randomUUID()}`, org_id: orgId, principal_kind: 'user', principal_id: ownerUserId,
      role: 'owner', invited_by: ownerUserId, created_at: now, revoked_at: null,
    };
    state.orgMemberships.push(ownerMembership);
    execOrgSql(tx, upsertMemSql, [ownerMembership.id, orgId, 'user', ownerUserId, 'owner', ownerUserId, now]);

    let agentMembership: OrgMembershipRecord | null = null;
    if (caller.principal_kind === 'agent') {
      agentMembership = {
        id: `om-${crypto.randomUUID()}`, org_id: orgId, principal_kind: 'agent', principal_id: caller.principal_id,
        role: 'admin', invited_by: ownerUserId, created_at: now, revoked_at: null,
      };
      state.orgMemberships.push(agentMembership);
      execOrgSql(tx, upsertMemSql, [agentMembership.id, orgId, 'agent', caller.principal_id, 'admin', ownerUserId, now]);
    }

    let createdWorkspace: WorkspaceRecord | null = null;
    let generalChannel: ChannelSummary | null = null;
    if (input.default_workspace) {
      const wsCfg = typeof input.default_workspace === 'object' ? input.default_workspace : {};
      const wsSlug = norm(wsCfg.slug || 'main'), wsName = (wsCfg.name || displayName).trim();
      const wsId = wsCfg.workspace_id || `ws-${crypto.randomUUID()}`;
      createdWorkspace = { workspace_id: wsId, org_id: orgId, slug: wsSlug, name: wsName, archived_at: null };
      state.workspaces.push(createdWorkspace);
      execOrgSql(tx, 'INSERT INTO swarm.workspaces (workspace_id, org_id, slug, name, archived_at) VALUES ($1, $2, $3, $4, NULL)', [wsId, orgId, wsSlug, wsName]);

      const upsertGrantSql = 'INSERT INTO swarm.workspace_principal_grants (id, workspace_id, org_id, principal_kind, principal_id, role, granted_by, created_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL) ON CONFLICT (workspace_id, principal_kind, principal_id) DO UPDATE SET org_id = EXCLUDED.org_id, role = EXCLUDED.role, granted_by = EXCLUDED.granted_by, revoked_at = NULL';
      const ownerGrant: WorkspacePrincipalGrant = {
        id: `wpg-${crypto.randomUUID()}`, workspace_id: wsId, org_id: orgId, principal_kind: 'user', principal_id: ownerUserId,
        role: 'owner', granted_by: ownerUserId, created_at: now, revoked_at: null,
      };
      state.workspaceGrants.push(ownerGrant);
      execOrgSql(tx, upsertGrantSql, [ownerGrant.id, wsId, orgId, 'user', ownerUserId, 'owner', ownerUserId, now]);

      if (caller.principal_kind === 'agent') {
        const agentGrant: WorkspacePrincipalGrant = {
          id: `wpg-${crypto.randomUUID()}`, workspace_id: wsId, org_id: orgId, principal_kind: 'agent', principal_id: caller.principal_id,
          role: 'admin', granted_by: ownerUserId, created_at: now, revoked_at: null,
        };
        state.workspaceGrants.push(agentGrant);
        execOrgSql(tx, upsertGrantSql, [agentGrant.id, wsId, orgId, 'agent', caller.principal_id, 'admin', ownerUserId, now]);
        upsertAgentPrincipalInWorkspace(state, wsId, caller.principal_id, tx);
      }

      generalChannel = {
        channel_id: `ch-${crypto.randomUUID()}`, workspace_id: wsId, org_id: orgId, slug: 'general',
        purpose: 'General coordination', visibility: 'workspace', join_policy: 'open',
        created_by_principal: ownerUserId, created_by_kind: 'user', created_at: now, archived_at: null,
      };
      state.channels.push(generalChannel);
      execOrgSql(tx, 'INSERT INTO swarm.channels (channel_id, workspace_id, slug, purpose, visibility, join_policy, created_by_principal, created_by_kind, created_at, archived_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL)', [generalChannel.channel_id, wsId, 'general', 'General coordination', 'workspace', 'open', ownerUserId, 'user', now]);
    }

    return {
      ok: true as const, status: 'executed' as const, organization, membership: ownerMembership,
      agent_membership: agentMembership, workspace: createdWorkspace, general_channel: generalChannel,
    };
  });
}

export function orgUpdate(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: { org_id: string; slug?: string; display_name?: string; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const org = findLiveOrg(state, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

    const auth = authorizeOrgAction(state, caller, { org, min_role: 'admin', action_kind: 'org_update', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;

    if (input.slug !== undefined) {
      const nextSlug = norm(input.slug);
      if (!isValidOrgSlug(nextSlug)) return fail('INVALID_ORG_SLUG', 'valid_org_slug', { org: org.slug });
      if (state.organizations.some((o) => o.id !== org.id && norm(o.slug) === nextSlug)) return fail('ORG_SLUG_TAKEN', 'unique_org_slug', { org: nextSlug });
      org.slug = nextSlug;
    }
    if (input.display_name !== undefined) {
      const nextName = input.display_name.trim();
      if (!nextName) return fail('INVALID_ORG_DISPLAY_NAME', 'display_name', { org: org.slug });
      org.display_name = nextName;
    }

    org.updated_at = now;
    execOrgSql(tx, 'SELECT id FROM swarm.organizations WHERE id = $1 FOR UPDATE', [org.id]);
    execOrgSql(tx, 'UPDATE swarm.organizations SET slug = $2, display_name = $3, updated_at = $4 WHERE id = $1', [org.id, org.slug, org.display_name, now]);
    return { ok: true as const, status: 'executed' as const, organization: org };
  });
}

export function orgDelete(
  state: OrgAuthorityState,
  caller: CallerContext,
  input: { org_id: string; confirm_slug?: string; confirm?: boolean; allow_last_org?: boolean; require_approval?: boolean; approval_id?: string; now?: string },
  db?: OrgSqlExecutor,
) {
  return withOrgTx(state, db, (tx) => {
    const now = input.now ?? new Date().toISOString();
    const org = findLiveOrg(state, input.org_id);
    if (!org) return fail('ORG_NOT_FOUND', 'organization', { org: input.org_id });

    const auth = authorizeOrgAction(state, caller, { org, min_role: 'owner', action_kind: 'org_delete', payload: { ...input }, require_approval: input.require_approval, now, db: tx });
    if (auth.status !== 'authorized') return auth.result;

    if (input.confirm_slug !== undefined && norm(input.confirm_slug) !== norm(org.slug)) {
      return fail('ORG_DELETE_CONFIRMATION_MISMATCH', 'matching_confirm_slug', { org: org.slug });
    }
    const ownerLiveOrgs = state.organizations.filter((o) => isLive(o) && orgRole(state, o.id, 'user', auth.actor_user_id) !== null);
    const explicitConfirmed = input.allow_last_org === true && typeof input.confirm_slug === 'string' && norm(input.confirm_slug) === norm(org.slug);
    if (ownerLiveOrgs.length <= 1 && !explicitConfirmed) {
      return fail('CANNOT_DELETE_LAST_ORG', 'allow_last_org_and_confirm_slug', { org: org.slug });
    }

    const closedSeatIds: string[] = [], closedHandleIds: string[] = [], archivedWorkspaceIds: string[] = [];
    const orgWsIds = state.workspaces.filter((w) => w.org_id === org.id && isLive(w)).map((w) => w.workspace_id);

    state.lockLog ??= [];
    state.lockLog.push(...CANONICAL_ORG_CHANNEL_LOCK_ORDER);
    execOrgSql(tx, 'SELECT id FROM swarm.organizations WHERE id = $1 FOR UPDATE', [org.id]);
    execOrgSql(tx, 'SELECT workspace_id FROM swarm.workspaces WHERE org_id = $1 ORDER BY workspace_id FOR UPDATE', [org.id]);
    execOrgSql(tx, 'SELECT channel_id FROM swarm.channels WHERE workspace_id = ANY($1::uuid[]) ORDER BY channel_id FOR UPDATE', [orgWsIds]);
    execOrgSql(tx, 'SELECT id FROM swarm.org_memberships WHERE org_id = $1 ORDER BY id FOR UPDATE', [org.id]);
    execOrgSql(tx, 'SELECT id FROM swarm.workspace_principal_grants WHERE org_id = $1 ORDER BY id FOR UPDATE', [org.id]);
    execOrgSql(tx, 'SELECT id FROM swarm.channel_memberships WHERE workspace_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [orgWsIds]);
    execOrgSql(tx, 'SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ANY($1::uuid[]) ORDER BY principal_id FOR UPDATE', [orgWsIds]);
    execOrgSql(tx, 'SELECT seat_id FROM swarm.hosted_mcp_seats WHERE workspace_id = ANY($1::uuid[]) ORDER BY seat_id FOR UPDATE', [orgWsIds]);

    for (const ws of state.workspaces) {
      if (ws.org_id === org.id && isLive(ws)) {
        archivedWorkspaceIds.push(ws.workspace_id);
        for (const m of state.orgMemberships) {
          if (m.org_id === org.id && isLive(m)) {
            const res = cascadeWorkspaceMemberRemoval(state, { workspace_id: ws.workspace_id, principal_kind: m.principal_kind, principal_id: m.principal_id, now });
            for (const sid of res.closed_seat_ids) if (!closedSeatIds.includes(sid)) closedSeatIds.push(sid);
            for (const hid of res.closed_handle_ids) if (!closedHandleIds.includes(hid)) closedHandleIds.push(hid);
          }
        }
        for (const g of state.workspaceGrants) if ((g.workspace_id === ws.workspace_id || g.org_id === org.id) && g.revoked_at == null) g.revoked_at = now;
        for (const lm of state.legacyMemberships ?? []) if (lm.workspace_id === ws.workspace_id && lm.revoked_at == null) lm.revoked_at = now;
        for (const cm of state.channelMemberships) if (cm.workspace_id === ws.workspace_id && cm.revoked_at == null) cm.revoked_at = now;
        for (const ap of state.agentPrincipals ?? []) if (ap.workspace_id === ws.workspace_id && ap.revoked_at == null) ap.revoked_at = now;
        for (const seat of state.seats ?? []) {
          if (seat.workspace_id === ws.workspace_id && seat.revoked_at == null) {
            seat.revoked_at = now;
            if (!closedSeatIds.includes(seat.seat_id)) closedSeatIds.push(seat.seat_id);
          }
        }
        for (const h of state.seatHandles ?? []) {
          if ((h.workspace_id === ws.workspace_id || closedSeatIds.includes(h.seat_id)) && h.revoked_at == null) {
            h.revoked_at = now;
            if (!closedHandleIds.includes(h.handle_id)) closedHandleIds.push(h.handle_id);
          }
        }
        for (const ch of state.channels) if (ch.workspace_id === ws.workspace_id && ch.archived_at == null) ch.archived_at = now;
        ws.archived_at = now;
      }
    }

    for (const m of state.orgMemberships) if (m.org_id === org.id && m.revoked_at == null) m.revoked_at = now;
    for (const inv of state.orgInvites ?? []) if (inv.org_id === org.id && inv.revoked_at == null) inv.revoked_at = now;
    org.archived_at = now; org.updated_at = now;

    execOrgSql(tx, 'UPDATE swarm.hosted_mcp_seats SET revoked_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND revoked_at IS NULL', [orgWsIds, now]);
    execOrgSql(tx, 'UPDATE swarm.agent_principals SET revoked_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND revoked_at IS NULL', [orgWsIds, now]);
    execOrgSql(tx, 'UPDATE swarm.channel_memberships SET revoked_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND revoked_at IS NULL', [orgWsIds, now]);
    execOrgSql(tx, 'UPDATE swarm.workspace_principal_grants SET revoked_at = $2 WHERE org_id = $1 AND revoked_at IS NULL', [org.id, now]);
    execOrgSql(tx, 'UPDATE swarm.org_memberships SET revoked_at = $2 WHERE org_id = $1 AND revoked_at IS NULL', [org.id, now]);
    execOrgSql(tx, 'UPDATE swarm.channels SET archived_at = $2 WHERE workspace_id = ANY($1::uuid[]) AND archived_at IS NULL', [orgWsIds, now]);
    execOrgSql(tx, 'UPDATE swarm.workspaces SET archived_at = $2 WHERE org_id = $1 AND archived_at IS NULL', [org.id, now]);
    execOrgSql(tx, 'UPDATE swarm.organizations SET archived_at = $2, updated_at = $2 WHERE id = $1', [org.id, now]);

    return {
      ok: true as const, status: 'executed' as const, organization: org,
      archived_workspace_ids: archivedWorkspaceIds, closed_seat_ids: closedSeatIds, closed_handle_ids: closedHandleIds,
    };
  });
}

export function orgList(state: OrgAuthorityState, caller: CallerContext) {
  const organizations = state.organizations
    .filter((o) => isLive(o) && canReadOrg(state, caller, o.id))
    .map((o) => {
      const role: OrgRole = effectiveCallerOrgRole(state, caller, o.id) ?? 'guest';
      const workspaces = state.workspaces
        .filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(state, caller, w.workspace_id))
        .map((w) => {
          const grant = state.workspaceGrants.find((g) => g.workspace_id === w.workspace_id && isPrin(g, caller.principal_kind, caller.principal_id) && isLive(g));
          const channels = state.channels
            .filter((ch) => ch.workspace_id === w.workspace_id && isLive(ch) && canReadChannel(state, caller, ch.channel_id))
            .map((ch) => ({ channel_id: ch.channel_id, slug: ch.slug, visibility: ch.visibility, join_policy: ch.join_policy }));
          return { workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: grant?.role ?? role, channels };
        });
      return {
        org_id: o.id, slug: o.slug, display_name: o.display_name,
        logo_object_key: o.logo_object_key ?? null, logo_updated_at: o.logo_updated_at ?? null, role, workspaces,
      };
    });
  return { ok: true as const, organizations };
}

registerOrgActionExecutor('org_create', (s, c, p, db) => orgCreate(s, c, p as Parameters<typeof orgCreate>[2], db));
registerOrgActionExecutor('org_update', (s, c, p, db) => orgUpdate(s, c, p as Parameters<typeof orgUpdate>[2], db));
registerOrgActionExecutor('org_delete', (s, c, p, db) => orgDelete(s, c, p as Parameters<typeof orgDelete>[2], db));

export const org_create = orgCreate;
export const org_update = orgUpdate;
export const org_delete = orgDelete;
export const org_list = orgList;
