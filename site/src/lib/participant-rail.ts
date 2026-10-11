import type { AgentPresenceRow } from '../../../src/cloud/agent-presence.js';

export interface RailMember {
  userId: string;
  name: string;
  role: "owner" | "admin" | "member";
}

export interface RailAgent {
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
    }))
    .filter((agent) => agent.principalId.length > 0);
