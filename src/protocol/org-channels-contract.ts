import { type CallerContext, type OrgChannelAuthorityState, type WorkspaceRecord,
  type WorkspaceSelectorChoice, fail } from './org-channels-types.js';
import { canReadChannel, canReadChannelBoundFile, canReadOrg, canReadSignal, canReadWorkspace } from './org-channels-access.js';

export * from './org-channels-types.js';
export * from './org-channels-access.js';

export interface OrgWorkspaceChannelSelector {
  org?: string | null;
  workspace?: string | null;
  channel?: string | null;
  seat_id?: string | null;
  entity?: { kind: 'signal' | 'file'; id: string };
}

const matches = (id: string, slug: string, token: string) => id === token || slug.toLowerCase() === token.toLowerCase();

export function resolveOrgWorkspaceChannelSelector(
  s: OrgChannelAuthorityState, c: CallerContext, input: OrgWorkspaceChannelSelector,
) {
  let orgToken = input.org?.trim() || null;
  let wsToken = input.workspace?.trim() || null;
  const channelToken = input.channel?.trim().replace(/^#/, '') || null;
  const orgs = s.organizations.filter((o) => canReadOrg(s, c, o.id));
  const workspaces = s.workspaces.filter((w) => canReadWorkspace(s, c, w.workspace_id));
  const toChoice = (w: WorkspaceRecord): WorkspaceSelectorChoice => {
    const parent = orgs.find((o) => o.id === w.org_id)!;
    return { org_id: parent.id, org_slug: parent.slug, workspace_id: w.workspace_id,
      workspace_slug: w.slug, selector: `${parent.slug}/${w.slug}` };
  };
  const orgMatches = orgToken ? orgs.filter((o) => matches(o.id, o.slug, orgToken!)) : [];
  if (orgMatches.length > 1) return fail('AMBIGUOUS_ORG_SELECTOR',
    workspaces.filter((w) => orgMatches.some((o) => o.id === w.org_id)).map(toChoice));
  let org = orgMatches[0];
  if (orgToken && !org) return fail('ORG_ACCESS_DENIED');
  if (wsToken?.includes('/')) {
    const parts = wsToken.split('/').map((p) => p.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) return fail('INVALID_SELECTOR');
    const qualifiedOrgs = orgs.filter((o) => matches(o.id, o.slug, parts[0]!));
    if (qualifiedOrgs.length > 1) return fail('AMBIGUOUS_ORG_SELECTOR',
      workspaces.filter((w) => qualifiedOrgs.some((o) => o.id === w.org_id)).map(toChoice));
    const qualifiedOrg = qualifiedOrgs[0];
    if (!qualifiedOrg || (org && org.id !== qualifiedOrg.id)) {
      return fail('WORKSPACE_ACCESS_DENIED');
    }
    orgToken = qualifiedOrg.id;
    org = qualifiedOrg;
    wsToken = parts[1]!;
  }
  const seat = input.seat_id ? s.seats.find((x) => x.seat_id === input.seat_id
    && c.principal_kind === 'agent' && x.principal_id === c.principal_id
    && x.workspace_id === c.workspace_id && x.revoked_at === null
    && canReadWorkspace(s, c, x.workspace_id)) : undefined;
  if (input.seat_id && !seat) return fail('WORKSPACE_SEAT_MISMATCH');

  let candidates = workspaces.filter((w) => (!org || w.org_id === org.id)
    && (!wsToken || matches(w.workspace_id, w.slug, wsToken)));
  let source: 'explicit' | 'seat' | 'current_workspace' | 'inferred' = orgToken || wsToken ? 'explicit' : 'inferred';
  if (seat) {
    if (!candidates.some((w) => w.workspace_id === seat.workspace_id)) return fail('WORKSPACE_SEAT_MISMATCH');
    candidates = candidates.filter((w) => w.workspace_id === seat.workspace_id);
    if (source !== 'explicit') source = 'seat';
  } else if (!wsToken) {
    const currentId = c.principal_kind === 'agent' ? c.workspace_id : c.current_workspace_id;
    const current = currentId ? candidates.find((w) => w.workspace_id === currentId) : undefined;
    if (current) {
      candidates = [current];
      if (source !== 'explicit') source = 'current_workspace';
    } else if (currentId && !orgToken) {
      // A removed/default workspace or revoked agent never falls through to a sibling.
      return fail('WORKSPACE_ACCESS_DENIED');
    }
  }
  if (candidates.length === 0) return fail('WORKSPACE_ACCESS_DENIED');
  if (candidates.length > 1) return fail('AMBIGUOUS_WORKSPACE_SELECTOR', candidates.map(toChoice));
  const workspace = candidates[0]!;
  const parent = orgs.find((o) => o.id === workspace.org_id)!;
  const channels = s.channels.filter((ch) => ch.workspace_id === workspace.workspace_id
    && ch.archived_at === null && canReadChannel(s, c, ch.channel_id));
  const channelMatches = input.entity && !channelToken ? [] : channels.filter((ch) => channelToken
    ? matches(ch.channel_id, ch.slug, channelToken) : ch.slug.toLowerCase() === 'general');
  if (channelMatches.length > 1) return fail('AMBIGUOUS_CHANNEL_SELECTOR', channelMatches.map((ch) => ({
    ...toChoice(workspace), channel_id: ch.channel_id, channel_slug: ch.slug,
  })));
  let channel: OrgChannelAuthorityState['channels'][number] | undefined = channelMatches[0];
  if (channelToken && !channel) return fail('CHANNEL_ACCESS_DENIED');
  if (input.entity) {
    const entity = input.entity;
    const readable = entity.kind === 'signal'
      ? canReadSignal(s, c, entity.id, workspace.workspace_id)
      : canReadChannelBoundFile(s, c, entity.id, workspace.workspace_id);
    if (!readable) return fail('ENTITY_ACCESS_DENIED');
    if (entity.kind === 'signal') {
      const signal = s.signals.find((x) => x.signal_id === entity.id && x.workspace_id === workspace.workspace_id)!;
      if (channelToken && signal.channel_id !== channel?.channel_id) return fail('ENTITY_ACCESS_DENIED');
      // An entity's existing filing wins over the general-channel default.
      if (!channelToken) channel = s.channels.find((ch) => ch.channel_id === signal.channel_id
        && ch.workspace_id === workspace.workspace_id);
    } else if (channelToken) {
      if (!s.fileChannelBindings.some((b) => b.file_id === entity.id
        && b.workspace_id === workspace.workspace_id && b.channel_id === channel?.channel_id)) {
        return fail('ENTITY_ACCESS_DENIED');
      }
    } else channel = undefined;
  }
  return { ok: true as const, org: parent, workspace, channel: channel ?? null, source };
}
