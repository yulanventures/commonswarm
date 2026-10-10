import { modelFamily, modelGlyphSvg } from './model-glyph.js';
import { hostedContextLabel, hostedContextPeopleLabel, type HostedContextLabelInput } from './hosted-context-label.js';
import { agentStatus } from './agent-status.js';
import type { AgentPresenceRow } from '../../../src/cloud/agent-presence.js';

export interface RailMember {
  userId: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface RailAgent extends Omit<HostedContextLabelInput, "name"> {
  principalId: string;
  name: string;
  ownerUserId: string;
  model?: string | null;
  transport?: "local" | "hosted_mcp";
  turnOnly?: boolean;
  /** undefined: the server gave no view; null: no row yet (see agent-status.ts). */
  presence?: AgentPresenceRow | null;
}

export interface RosterAgent extends RailAgent {
  model: string | null;
  transport: "local" | "hosted_mcp";
  turnOnly: boolean;
}

export interface RosterAgentRow {
  principal_id?: unknown;
  name?: unknown;
  model?: unknown;
  owner_user_id?: unknown;
  transport?: unknown;
  turn_only?: unknown;
  display_name?: unknown;
  disambiguator?: unknown;
  identity_lifetime?: unknown;
  app?: unknown;
  context_activity?: unknown;
}

export type ParticipantGroup<TMember extends RailMember, TAgent extends RailAgent> =
  | { kind: "member"; member: TMember; agents: TAgent[] }
  | { kind: "unresolved"; label: "Owner unavailable"; agents: TAgent[] };

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const compareMembers = <TMember extends RailMember>(left: TMember, right: TMember): number =>
  compareText(left.name.toLowerCase(), right.name.toLowerCase()) ||
  compareText(left.userId, right.userId);

const compareAgents = <TAgent extends RailAgent>(left: TAgent, right: TAgent): number =>
  compareText(left.name, right.name) || compareText(left.principalId, right.principalId);

export interface ParticipantOrderOptions {
  /** The signed-in person. Their group comes first; everyone else stays alphabetical. */
  viewerId?: string | null;
}

/** Keeps every workspace member and agent visible while making ownership structural. */
export const groupParticipantsByOwner = <
  TMember extends RailMember,
  TAgent extends RailAgent,
>(members: TMember[], agents: TAgent[], options: ParticipantOrderOptions = {}): ParticipantGroup<TMember, TAgent>[] => {
  const memberIds = new Set(members.map((member) => member.userId));
  const viewerId = options.viewerId ?? null;
  const viewerFirst = (left: TMember, right: TMember): number =>
    viewerId === null ? 0 : Number(right.userId === viewerId) - Number(left.userId === viewerId);
  const groups: ParticipantGroup<TMember, TAgent>[] = [...members]
    .sort((left, right) => viewerFirst(left, right) || compareMembers(left, right))
    .map((member) => ({
      kind: "member",
      member,
      agents: agents
        .filter((agent) => agent.ownerUserId === member.userId)
        .sort(compareAgents),
    }));
  const unresolved = agents
    .filter((agent) => !memberIds.has(agent.ownerUserId))
    .sort(compareAgents);
  if (unresolved.length > 0) {
    groups.push({ kind: "unresolved", label: "Owner unavailable", agents: unresolved });
  }
  return groups;
};

function rosterApp(value: unknown): HostedContextLabelInput["app"] {
  if (value === null || typeof value !== 'object') return null;
  const app = value as Record<string, unknown>;
  return typeof app.client_id === 'string' && typeof app.display_name === 'string'
    ? { client_id: app.client_id, display_name: app.display_name } : null;
}

/** Normalizes roster rows without discarding agents whose owner cannot be resolved. */
export const rosterAgentsFromRows = (rows: RosterAgentRow[]): RosterAgent[] =>
  rows
    .map<RosterAgent>((row) => ({
      principalId: String(row.principal_id ?? ''),
      name: String(row.name ?? 'Unnamed agent'),
      model: row.model == null ? null : String(row.model),
      transport: row.transport === 'hosted_mcp' ? 'hosted_mcp' : 'local',
      turnOnly: row.turn_only === true,
      ownerUserId: String(row.owner_user_id ?? ''),
      ...(row.transport !== 'hosted_mcp' ? {} : {
        displayName: typeof row.display_name === 'string' ? row.display_name : null,
        disambiguator: typeof row.disambiguator === 'string' ? row.disambiguator : null,
        ...(row.identity_lifetime === 'durable' || row.identity_lifetime === 'ephemeral'
          ? { identityLifetime: row.identity_lifetime } : {}),
        app: rosterApp(row.app),
        lastBusinessAt: row.context_activity !== null && typeof row.context_activity === 'object'
          && typeof (row.context_activity as Record<string, unknown>).last_business_at === 'string'
          ? (row.context_activity as { last_business_at: string }).last_business_at : null,
      }),
    }))
    .filter((agent) => agent.principalId.length > 0);

/** Renders the participant rail used by the live dashboard and its DOM observers. */
export const renderSidebarParticipants = <
  TMember extends RailMember,
  TAgent extends RailAgent,
>(
  participantList: HTMLUListElement,
  members: TMember[],
  agents: TAgent[],
  initials: (name: string) => string,
  options: ParticipantOrderOptions = {},
): void => {
  const document = participantList.ownerDocument;
  participantList.replaceChildren();

  const identityRoster = agents.map((agent) => ({
    id: agent.principalId,
    name: agent.name,
  }));
  const buildAgentRow = (agent: TAgent, ownerName?: string): HTMLLIElement => {
    const row = document.createElement('li');
    row.className = 'dashboard__sidebar-agent';
    const modelMark = document.createElement('span');
    modelMark.className = 'dashboard__sidebar-model-mark';
    modelMark.innerHTML = modelGlyphSvg(
      modelFamily(agent.model),
      'dashboard__sidebar-model-glyph',
    );
    const copy = document.createElement('span');
    copy.className = 'dashboard__sidebar-participant-copy';
    const name = document.createElement('strong');
    const label = hostedContextPeopleLabel(agent, identityRoster);
    const context = hostedContextLabel(agent);
    name.textContent = label.name;
    name.title = label.exactName ?? label.name;
    copy.append(name);
    if (context.badge) {
      const badge = document.createElement('small');
      badge.dataset.contextBadge = context.badge;
      badge.textContent = `Badge ${context.badge}`;
      copy.append(badge);
    }
    if (context.distinction) {
      const distinction = document.createElement('span');
      distinction.textContent = context.distinction;
      copy.append(distinction);
    }
    /* One plain status instead of the wire transport (Tom's plain-words rule). The transport
       stays in the profile panel for support. */
    const status = agentStatus({ transport: agent.transport, turnOnly: agent.turnOnly, presence: agent.presence });
    const statusLine = document.createElement('span');
    statusLine.className = 'dashboard__sidebar-agent-status';
    statusLine.dataset.agentStatus = status.kind;
    statusLine.textContent = status.chip;
    copy.append(statusLine);
    if (agent.model) {
      const model = document.createElement('span');
      model.textContent = agent.model;
      copy.append(model);
    }
    if (ownerName) {
      const owner = document.createElement('span');
      owner.className = 'dashboard__sidebar-orphan-owner';
      owner.textContent = `operated by ${ownerName}`;
      copy.append(owner);
    }
    row.append(modelMark, copy);
    return row;
  };

  for (const group of groupParticipantsByOwner(members, agents, options)) {
    const groupItem = document.createElement('li');
    groupItem.className = 'dashboard__sidebar-owner-group';
    const personRow = document.createElement('div');
    personRow.className = group.kind === 'member'
      ? 'dashboard__sidebar-person'
      : 'dashboard__sidebar-person dashboard__sidebar-person--unresolved';

    if (group.kind === 'member') {
      const avatarWrap = document.createElement('span');
      avatarWrap.className = 'dashboard__sidebar-avatar-wrap';
      const avatar = document.createElement('span');
      avatar.className = 'dashboard__sidebar-person-avatar';
      avatar.textContent = initials(group.member.name);
      avatar.setAttribute('aria-hidden', 'true');
      avatarWrap.append(avatar);
      const copy = document.createElement('span');
      copy.className = 'dashboard__sidebar-participant-copy';
      const name = document.createElement('strong');
      name.textContent = group.member.name;
      name.title = group.member.name;
      const meta = document.createElement('span');
      meta.textContent = group.member.role;
      copy.append(name, meta);
      personRow.append(avatarWrap, copy);
    } else {
      const marker = document.createElement('span');
      marker.className = 'dashboard__sidebar-unresolved-mark';
      marker.textContent = '?';
      marker.setAttribute('aria-hidden', 'true');
      const label = document.createElement('strong');
      label.textContent = group.label;
      personRow.append(marker, label);
    }
    groupItem.append(personRow);
    if (group.agents.length > 0) {
      const nestedAgents = document.createElement('ul');
      nestedAgents.className = 'dashboard__sidebar-owner-agents';
      for (const agent of group.agents) {
        nestedAgents.append(buildAgentRow(
          agent,
          group.kind === 'unresolved' ? group.label : undefined,
        ));
      }
      groupItem.append(nestedAgents);
    }
    participantList.append(groupItem);
  }
};
