import {
  type CallerContext,
  type ChannelSummary,
  type MultiOrgWhoamiResponse,
  type OrgChannelAuthorityState,
  type OrgRole,
  type OrganizationSummary,
  type PrincipalKind,
  type WorkspaceMoveTransferMode,
  type WorkspaceRecord,
  type WorkspaceSelectorChoice,
  fail,
  isLive,
  isPrin,
  norm,
  orgRole,
} from './org-channels-types.js';
import {
  canReadChannel,
  canReadOrg,
  canReadWorkspace,
  cascadeWorkspaceMemberRemoval,
} from './org-channels-access.js';

export * from './org-channels-types.js';
export * from './org-channels-access.js';

type State = OrgChannelAuthorityState;

export function resolveOrgWorkspaceChannelSelector(
  s: State,
  c: CallerContext,
  input: {
    org?: string | null;
    workspace?: string | null;
    channel?: string | null;
    seat_id?: string | null;
  },
) {
  let expOrg = input.org?.trim() || null,
    expWs = input.workspace?.trim() || null;
  if (expWs?.includes('/')) {
    const [oPart, wPart] = expWs.split('/', 2);
    const qualOrg = oPart?.trim() || null;
    if (expOrg && qualOrg && norm(expOrg) !== norm(qualOrg)) {
      const sameOrg = s.organizations.find(
        (o) =>
          (o.id === expOrg || norm(o.slug) === norm(expOrg)) &&
          (o.id === qualOrg || norm(o.slug) === norm(qualOrg)),
      );
      if (!sameOrg) {
        return fail('WORKSPACE_ACCESS_DENIED', 'conflicting_org_workspace_selector', {
          org: expOrg,
          workspace: input.workspace ?? null,
          seat_id: input.seat_id ?? null,
        });
      }
    }
    if (!expOrg && qualOrg) expOrg = qualOrg;
    expWs = wPart?.trim() || null;
  }
  const reachOrgs = s.organizations.filter((o) => isLive(o) && canReadOrg(s, c, o.id));
  const reachWs = s.workspaces.filter((w) => isLive(w) && canReadWorkspace(s, c, w.workspace_id));
  const toChoice = (w: WorkspaceRecord): WorkspaceSelectorChoice => {
    const o = s.organizations.find((org) => org.id === w.org_id)!;
    return {
      org_id: o.id,
      org_slug: o.slug,
      workspace_id: w.workspace_id,
      workspace_slug: w.slug,
      selector: `${o.slug}/${w.slug}`,
    };
  };
  const seat = input.seat_id
    ? (s.seats ?? []).find((x) => x.seat_id === input.seat_id && isLive(x))
    : undefined;
  const seatWs = seat
    ? s.workspaces.find((w) => w.workspace_id === seat.workspace_id && isLive(w))
    : undefined;
  const seatOrg = seatWs
    ? s.organizations.find((o) => o.id === seatWs.org_id && isLive(o))
    : undefined;
  if (input.seat_id) {
    if (!seat || !seatWs || !seatOrg) {
      return fail('WORKSPACE_SEAT_MISMATCH', 'active_seat', {
        seat_id: input.seat_id,
      });
    }
    const seatAid =
      seat.agent_identity_id ??
      (s.agentPrincipals ?? []).find((ap) => ap.principal_id === seat.principal_id)
        ?.agent_identity_id ??
      seat.principal_id;
    if (c.principal_kind !== 'agent' || seatAid !== c.principal_id) {
      return fail('WORKSPACE_SEAT_MISMATCH', 'seat_principal_ownership', {
        seat_id: input.seat_id,
      });
    }
    if (!canReadWorkspace(s, c, seatWs.workspace_id)) {
      return fail('WORKSPACE_ACCESS_DENIED', 'active_seat_workspace_access', {
        seat_id: input.seat_id,
      });
    }
  }
  const pol = c.connection_id
    ? (s.connectionPolicies ?? []).find((p) => p.connection_id === c.connection_id && isLive(p))
    : undefined;
  let resOrg: OrganizationSummary | undefined, resWs: WorkspaceRecord | undefined;
  let source: 'explicit' | 'seat' | 'connection_default' | 'inferred' = 'inferred';

  if (expOrg || expWs) {
    source = 'explicit';
    if (expOrg) {
      resOrg = reachOrgs.find((o) => o.id === expOrg || norm(o.slug) === norm(expOrg));
      if (!resOrg)
        return fail('ORG_ACCESS_DENIED', 'org_membership', {
          org: expOrg,
          workspace: expWs,
          seat_id: input.seat_id ?? null,
        });
    }
    if (expWs) {
      const cands = reachWs.filter(
        (w) =>
          (!resOrg || w.org_id === resOrg.id) &&
          (w.workspace_id === expWs || norm(w.slug) === norm(expWs)),
      );
      if (cands.length === 0)
        return fail('WORKSPACE_ACCESS_DENIED', 'workspace_grant', {
          org: resOrg?.slug ?? expOrg,
          workspace: expWs,
          seat_id: input.seat_id ?? null,
        });
      if (cands.length > 1)
        return fail(
          'AMBIGUOUS_WORKSPACE_SELECTOR',
          'org_qualifier',
          { workspace: expWs, seat_id: input.seat_id ?? null },
          cands.map(toChoice),
        );
      resWs = cands[0];
      resOrg = resOrg ?? reachOrgs.find((o) => o.id === resWs!.org_id);
    } else if (resOrg) {
      const defWs = pol?.default_workspace_id
        ? reachWs.find(
            (w) =>
              w.workspace_id === pol.default_workspace_id &&
              w.org_id === resOrg!.id,
          )
        : undefined;
      if (seatWs && seatWs.org_id === resOrg.id) resWs = seatWs;
      else if (defWs) resWs = defWs;
      else {
        const orgWs = reachWs.filter((w) => w.org_id === resOrg!.id);
        if (orgWs.length !== 1)
          return fail(
            'AMBIGUOUS_WORKSPACE_SELECTOR',
            'workspace_selector',
            { org: resOrg.slug, seat_id: input.seat_id ?? null },
            orgWs.map(toChoice),
          );
        resWs = orgWs[0];
      }
    }
    if (seatWs && seatOrg && resWs && resWs.workspace_id !== seatWs.workspace_id) {
      const oSlug = resOrg?.slug ?? resWs.org_id;
      return fail('WORKSPACE_SEAT_MISMATCH', `seat_in_${oSlug}/${resWs.slug}`, {
        org: oSlug,
        workspace: resWs.slug,
        seat_id: seat?.seat_id ?? null,
      });
    }
  } else if (seatWs && seatOrg) {
    resOrg = seatOrg;
    resWs = seatWs;
    source = 'seat';
  } else {
    if (pol?.default_workspace_id) {
      const defWs = reachWs.find((w) => w.workspace_id === pol.default_workspace_id);
      const defOrg = defWs ? reachOrgs.find((o) => o.id === defWs.org_id) : undefined;
      if (defWs && defOrg && (!pol.default_org_id || pol.default_org_id === defOrg.id)) {
        resWs = defWs;
        resOrg = defOrg;
        source = 'connection_default';
      }
    }
    if (!resWs && pol?.default_org_id) {
      const defOrg = reachOrgs.find((o) => o.id === pol.default_org_id);
      const orgWs = defOrg ? reachWs.filter((w) => w.org_id === defOrg.id) : [];
      if (defOrg && orgWs.length === 1) {
        resOrg = defOrg;
        resWs = orgWs[0];
        source = 'connection_default';
      }
    }
    if (!resWs || !resOrg) {
      if (reachWs.length !== 1)
        return fail(
          reachWs.length === 0 ? 'WORKSPACE_ACCESS_DENIED' : 'AMBIGUOUS_WORKSPACE_SELECTOR',
          reachWs.length === 0 ? 'workspace_grant' : 'workspace_selector',
          { seat_id: input.seat_id ?? null },
          reachWs.map(toChoice),
        );
      resWs = reachWs[0];
      resOrg = reachOrgs.find((o) => o.id === resWs!.org_id);
      source = 'inferred';
    }
  }
  let resCh: ChannelSummary | null = null;
  const wsCh = s.channels.filter((ch) => ch.workspace_id === resWs!.workspace_id && isLive(ch));
  if (input.channel?.trim()) {
    const tok = input.channel.trim();
    const target = wsCh.find((ch) => ch.channel_id === tok || norm(ch.slug) === norm(tok));
    if (!target || !canReadChannel(s, c, target.channel_id))
      return fail('CHANNEL_ACCESS_DENIED', 'channel_membership', {
        org: resOrg!.slug,
        workspace: resWs!.slug,
        channel: norm(tok),
        seat_id: input.seat_id ?? null,
      });
    resCh = target;
  } else {
    const gen = wsCh.find((ch) => norm(ch.slug) === 'general');
    if (gen && canReadChannel(s, c, gen.channel_id)) resCh = gen;
  }
  return { ok: true as const, org: resOrg!, workspace: resWs!, channel: resCh, source };
}

export function reconcileWorkspaceMove(
  s: State,
  {
    workspace_id,
    target_org_id,
    actor_user_id,
    transfer_members,
    now = new Date().toISOString(),
  }: {
    workspace_id: string;
    target_org_id: string;
    actor_user_id: string;
    transfer_members: WorkspaceMoveTransferMode;
    now?: string;
  },
) {
  const ws = s.workspaces.find((w) => w.workspace_id === workspace_id && isLive(w));
  if (!ws) return fail('WORKSPACE_NOT_FOUND', 'workspace', { workspace: workspace_id });
  if (
    orgRole(s, ws.org_id, 'user', actor_user_id) !== 'owner' ||
    orgRole(s, target_org_id, 'user', actor_user_id) !== 'owner'
  ) {
    return fail('ORG_MOVE_REQUIRES_DUAL_OWNER', 'dual_org_owner_role', {
      org: target_org_id,
      workspace: ws.slug,
    });
  }
  const sourceOrgId = ws.org_id;
  ws.org_id = target_org_id;
  for (const g of s.workspaceGrants) if (g.workspace_id === ws.workspace_id) g.org_id = target_org_id;
  const closedSeats: string[] = [];
  const candidates = new Map<string, { principal_kind: PrincipalKind; principal_id: string; role: OrgRole }>();
  for (const g of s.workspaceGrants.filter((x) => x.workspace_id === ws.workspace_id && isLive(x))) {
    candidates.set(`${g.principal_kind}:${g.principal_id}`, { principal_kind: g.principal_kind, principal_id: g.principal_id, role: g.role });
  }
  for (const ap of (s.agentPrincipals ?? []).filter((x) => x.workspace_id === ws.workspace_id && isLive(x))) {
    const k = `agent:${ap.agent_identity_id}`;
    if (!candidates.has(k)) candidates.set(k, { principal_kind: 'agent', principal_id: ap.agent_identity_id, role: 'member' });
  }
  for (const cm of s.channelMemberships.filter((x) => x.workspace_id === ws.workspace_id && isLive(x))) {
    const k = `${cm.principal_kind}:${cm.principal_id}`;
    if (!candidates.has(k)) candidates.set(k, { principal_kind: cm.principal_kind, principal_id: cm.principal_id, role: 'member' });
  }
  for (const seat of (s.seats ?? []).filter((x) => x.workspace_id === ws.workspace_id && isLive(x))) {
    const aid = seat.agent_identity_id ?? (s.agentPrincipals ?? []).find((a) => a.principal_id === seat.principal_id)?.agent_identity_id ?? seat.principal_id;
    const k = `agent:${aid}`;
    if (!candidates.has(k)) candidates.set(k, { principal_kind: 'agent', principal_id: aid, role: 'member' });
  }
  if (transfer_members === 'all') {
    for (const p of candidates.values()) {
      let wg = s.workspaceGrants.find(
        (x) => x.workspace_id === ws.workspace_id && isPrin(x, p.principal_kind, p.principal_id),
      );
      if (!wg) {
        wg = {
          workspace_id: ws.workspace_id,
          org_id: target_org_id,
          principal_kind: p.principal_kind,
          principal_id: p.principal_id,
          role: p.role === 'owner' ? 'admin' : p.role,
          granted_by: actor_user_id,
          created_at: now,
          revoked_at: null,
        };
        s.workspaceGrants.push(wg);
      }
      const existingOrgMem = s.orgMemberships.find(
        (m) =>
          m.org_id === target_org_id &&
          isPrin(m, p.principal_kind, p.principal_id),
      );
      if (existingOrgMem && existingOrgMem.revoked_at != null) {
        closedSeats.push(
          ...cascadeWorkspaceMemberRemoval(s, {
            workspace_id: ws.workspace_id,
            principal_kind: p.principal_kind,
            principal_id: p.principal_id,
            now,
          }).closed_seat_ids,
        );
      } else if (!existingOrgMem) {
        s.orgMemberships.push({
          org_id: target_org_id,
          principal_kind: p.principal_kind,
          principal_id: p.principal_id,
          role: p.role === 'owner' ? 'admin' : p.role,
          invited_by: actor_user_id,
          created_at: now,
          revoked_at: null,
        });
      }
    }
  } else {
    for (const om of s.orgMemberships.filter((m) => m.org_id === target_org_id && isLive(m) && m.role !== 'owner')) {
      const k = `${om.principal_kind}:${om.principal_id}`;
      if (!candidates.has(k)) candidates.set(k, { principal_kind: om.principal_kind, principal_id: om.principal_id, role: om.role });
    }
    for (const ai of (s.agentIdentities ?? []).filter(isLive)) {
      const k = `agent:${ai.id}`;
      if (!candidates.has(k)) candidates.set(k, { principal_kind: 'agent', principal_id: ai.id, role: 'member' });
    }
    for (const p of candidates.values()) {
      if (orgRole(s, target_org_id, p.principal_kind, p.principal_id) !== 'owner') {
        closedSeats.push(
          ...cascadeWorkspaceMemberRemoval(s, {
            workspace_id: ws.workspace_id,
            principal_kind: p.principal_kind,
            principal_id: p.principal_id,
            now,
          }).closed_seat_ids,
        );
      }
    }
  }
  return { ok: true as const, source_org_id: sourceOrgId, target_org_id, closed_seat_ids: closedSeats };
}

export function buildMultiOrgWhoamiResponse(
  s: State,
  {
    agent_identity_id,
    connection_id = null,
    seat_id = null,
  }: {
    agent_identity_id: string;
    connection_id?: string | null;
    seat_id?: string | null;
  },
): MultiOrgWhoamiResponse {
  const id = s.agentIdentities.find((a) => a.id === agent_identity_id && isLive(a));
  if (!id) throw new Error(`Unknown or revoked agent identity: ${agent_identity_id}`);
  const c: CallerContext = {
    principal_kind: 'agent',
    principal_id: id.id,
    owner_user_id: id.owner_user_id,
    connection_id,
  };
  const pol = connection_id
    ? (s.connectionPolicies ?? []).find((p) => p.connection_id === connection_id && isLive(p))
    : undefined;
  let activeSeat: MultiOrgWhoamiResponse['active_seat'] = null;
  if (seat_id) {
    const seat = (s.seats ?? []).find((x) => x.seat_id === seat_id && isLive(x));
    const seatAid =
      seat?.agent_identity_id ??
      (s.agentPrincipals ?? []).find((ap) => ap.principal_id === seat?.principal_id && isLive(ap))
        ?.agent_identity_id ??
      seat?.principal_id;
    const ws =
      seat && seatAid === id.id
        ? s.workspaces.find((w) => w.workspace_id === seat.workspace_id && isLive(w))
        : undefined;
    const org = ws
      ? s.organizations.find((o) => o.id === ws.org_id && isLive(o))
      : undefined;
    if (seat && ws && org && canReadWorkspace(s, c, ws.workspace_id)) {
      activeSeat = {
        seat_id: seat.seat_id,
        org_id: org.id,
        org_slug: org.slug,
        workspace_id: ws.workspace_id,
        workspace_slug: ws.slug,
        principal_id: seat.principal_id,
      };
    }
  }
  const organizations = s.organizations
    .filter((o) => isLive(o) && canReadOrg(s, c, o.id))
    .map((o) => {
      const uRole = orgRole(s, o.id, 'user', id.owner_user_id)!;
      const r: OrgRole =
        orgRole(s, o.id, 'agent', id.id) ?? (uRole === 'guest' ? 'guest' : 'member');
      const workspaces = s.workspaces
        .filter((w) => w.org_id === o.id && isLive(w) && canReadWorkspace(s, c, w.workspace_id))
        .map((w) => {
          const wg = s.workspaceGrants.find(
            (g) => g.workspace_id === w.workspace_id && isPrin(g, 'agent', id.id) && isLive(g),
          );
          const channels = s.channels
            .filter(
              (ch) =>
                ch.workspace_id === w.workspace_id &&
                isLive(ch) &&
                canReadChannel(s, c, ch.channel_id),
            )
            .map((ch) => ({
              channel_id: ch.channel_id,
              slug: ch.slug,
              visibility: ch.visibility,
            }));
          return { workspace_id: w.workspace_id, slug: w.slug, name: w.name, role: wg?.role ?? r, channels };
        });
      return { org_id: o.id, slug: o.slug, display_name: o.display_name, role: r, workspaces };
    });
  return {
    agent_identity_id: id.id,
    owner_user_id: id.owner_user_id,
    display_name: id.display_name,
    active_seat: activeSeat,
    default_org_id: pol?.default_org_id ?? null,
    default_workspace_id: pol?.default_workspace_id ?? null,
    organizations,
  };
}
