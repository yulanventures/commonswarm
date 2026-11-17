/*
 * A CHANNEL'S LEAD: who an untagged top-level post from a person in a named channel wakes. The
 * server holds it (swarm.channels lead_mode and lead_agent_principal_id; set_channel_lead) and judges
 * every change. This module is the browser's reading of it: the two columns, the Channel lead select's
 * options, the lead the header names, and set_channel_lead's exact shape.
 *
 * "workspace" (the default) is the workspace lead, "agent" is one named agent, "none" wakes nobody.
 * #general always uses the workspace lead and has no setting of its own.
 */
import type { WorkspaceChannel } from "./channels.js";

export type ChannelLeadMode = "workspace" | "agent" | "none";
export type ChannelLead = { mode: "workspace" | "none" } | { mode: "agent"; principalId: string };

export const CHANNEL_LEAD_LABEL = "Channel lead";
export const NO_LEAD_LABEL = "No lead";
export const SET_LEAD_LABEL = "Set lead";
export const workspaceLeadOptionLabel = (name: string | null): string => `Workspace lead (${name ?? "none"})`;
/** A stored lead this page cannot name (no longer on the roster). Kept as an option so the select never jumps. */
export const UNNAMED_LEAD_LABEL = "Agent no longer here";

type LeadColumns = Pick<WorkspaceChannel, "leadMode" | "leadAgentPrincipalId">;

/**
 * The two columns of one swarm_read.channels row. An older server sends neither: both stay absent
 * and the channel reads as "workspace". A value this build does not know, or "agent" without an
 * agent, also reads as "workspace", the server's own default.
 */
export function parseChannelLeadColumns(row: Record<string, unknown>): LeadColumns {
  if (!Object.hasOwn(row, "lead_mode") && !Object.hasOwn(row, "lead_agent_principal_id")) return {};
  const id = row.lead_agent_principal_id;
  if (row.lead_mode === "agent" && typeof id === "string" && id.trim() !== "") return { leadMode: "agent", leadAgentPrincipalId: id };
  if (row.lead_mode === "none") return { leadMode: "none", leadAgentPrincipalId: null };
  return { leadMode: "workspace", leadAgentPrincipalId: null };
}

/** The stored setting, with absent columns read as the default. */
export const channelLead = (channel: LeadColumns): ChannelLead =>
  channel.leadMode === "agent" && channel.leadAgentPrincipalId ? { mode: "agent", principalId: channel.leadAgentPrincipalId }
  : channel.leadMode === "none" ? { mode: "none" } : { mode: "workspace" };

/** The select's value for a setting: "workspace", "none" or "agent:<principal id>". */
export const channelLeadValue = (lead: ChannelLead): string => lead.mode === "agent" ? `agent:${lead.principalId}` : lead.mode;

export const channelLeadFromValue = (value: string): ChannelLead | null =>
  value === "workspace" || value === "none" ? { mode: value }
  : value.startsWith("agent:") && value.length > "agent:".length ? { mode: "agent", principalId: value.slice("agent:".length) }
  : null;

/** set_channel_lead, exactly: principal_id only with "agent". */
export const setChannelLeadCommand = (channelId: string, lead: ChannelLead): Record<string, unknown> => ({
  kind: "set_channel_lead",
  channel_id: channelId,
  lead_mode: lead.mode,
  ...(lead.mode === "agent" ? { principal_id: lead.principalId } : {}),
});

export interface LeadAgent { principalId: string; name: string; transport?: string; turnOnly?: boolean }

/** The browser's half of the server's rule (live local, not turn-only), as the workspace lead uses it. The server checks the rest. */
export const mayLeadChannel = (agent: Pick<LeadAgent, "transport" | "turnOnly">): boolean =>
  agent.transport !== "hosted_mcp" && agent.turnOnly !== true;

export interface ChannelLeadOptionsInput {
  agents: readonly LeadAgent[];
  /** The workspace's live lead, or null. */
  workspaceLead: LeadAgent | null;
  /** The channel's stored setting. */
  stored: ChannelLead;
  /** A value the select already shows, kept across a rebuild. */
  selected?: string | null;
  /** A private channel's member agents; null while they are not known. Ignored for an open channel. */
  memberAgentIds?: ReadonlySet<string> | null;
  visibility?: "open" | "private" | null;
}

export interface ChannelLeadOption { value: string; label: string }

/**
 * Workspace lead, No lead, then every agent that may lead here, by name. In a private channel only its
 * member agents may, and while they are not known none are offered. The stored lead and the shown value
 * are always options, so opening the dialog or loading members never moves the selection.
 */
export function channelLeadOptions(input: ChannelLeadOptionsInput): ChannelLeadOption[] {
  const privateChannel = input.visibility === "private";
  const members = privateChannel ? input.memberAgentIds ?? null : null;
  const inChannel = (id: string): boolean => !privateChannel || (members !== null && members.has(id));
  const workspaceLead = input.workspaceLead && (!privateChannel || members === null || members.has(input.workspaceLead.principalId))
    ? input.workspaceLead.name : null;
  const eligible = input.agents.filter((agent) => mayLeadChannel(agent) && inChannel(agent.principalId));
  const kept = [channelLeadValue(input.stored), input.selected ?? ""]
    .map((value) => channelLeadFromValue(value))
    .flatMap((lead) => lead?.mode === "agent" ? [lead.principalId] : []);
  const ids = new Set(eligible.map((agent) => agent.principalId));
  const extra = kept.filter((id, index) => !ids.has(id) && kept.indexOf(id) === index)
    .map((id) => input.agents.find((agent) => agent.principalId === id) ?? { principalId: id, name: UNNAMED_LEAD_LABEL });
  const byName = (left: LeadAgent, right: LeadAgent): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : left.principalId < right.principalId ? -1 : left.principalId > right.principalId ? 1 : 0;
  return [
    { value: "workspace", label: workspaceLeadOptionLabel(workspaceLead) },
    { value: "none", label: NO_LEAD_LABEL },
    ...[...eligible, ...extra].sort(byName).map((agent) => ({ value: `agent:${agent.principalId}`, label: agent.name })),
  ];
}

/**
 * What the header shows for a named channel's own setting ("agent" or "none"): the named agent while it
 * is on the roster and may lead, otherwise nobody. "workspace" is drawn exactly as #general draws it.
 */
export function namedChannelLead<Agent extends LeadAgent>(lead: ChannelLead, agents: readonly Agent[]): Agent | null {
  if (lead.mode !== "agent") return null;
  const agent = agents.find((candidate) => candidate.principalId === lead.principalId);
  return agent && mayLeadChannel(agent) ? agent : null;
}

/**
 * ONE COMMAND ID PER ATTEMPT. A new selection is a new attempt with a fresh id. Only when an attempt's
 * outcome is unknown (the connection dropped) does Save with the same selection send the same id
 * again, so the server replays its first answer; a different selection under a reused id would be
 * 409 command_id_conflict. A decided answer, accepted or refused, ends the attempt.
 */
export class CommandAttempts {
  #open = new Map<string, { value: string; commandId: string }>();

  commandId(key: string, value: string, fresh: () => string): string {
    const open = this.#open.get(key);
    if (open && open.value === value) return open.commandId;
    const commandId = fresh();
    this.#open.set(key, { value, commandId });
    return commandId;
  }

  settle(key: string): void {
    this.#open.delete(key);
  }
}
