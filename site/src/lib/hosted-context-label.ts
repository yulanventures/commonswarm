import { identityDisplayLabel, type IdentityRecord } from "./identity-label";
import type { AgentVM, PersonVM } from "./home-types";

/** Display metadata comes from the membership-gated roster, never a parsed name. */
export interface HostedContextLabelInput {
  name: string;
  transport?: "local" | "hosted_mcp";
  displayName?: string | null;
  disambiguator?: string | null;
  identityLifetime?: "durable" | "ephemeral";
  app?: { client_id: string; display_name: string } | null;
  lastBusinessAt?: string | null;
}

export function hostedContextLabel(agent: HostedContextLabelInput) {
  const hosted = agent.transport === "hosted_mcp";
  const badge = hosted ? agent.disambiguator ?? null : null;
  return {
    label: hosted ? agent.displayName ?? agent.name : agent.name,
    exactName: agent.name,
    badge,
    distinction: !hosted ? null : agent.identityLifetime === "durable"
      ? badge ? "Separate agent · Shared across chats" : "Shared across chats"
      : agent.identityLifetime === "ephemeral" ? "Separate chat" : null,
    assurance: hosted ? "App connection identity; chat not verified" : null,
  };
}

/** People rows keep UUID distinction until hosted display metadata is supplied. */
export function hostedContextPeopleLabel(
  agent: HostedContextLabelInput & { principalId: string },
  roster: readonly IdentityRecord[],
) {
  const context = hostedContextLabel(agent);
  const hasDisplay = agent.transport === "hosted_mcp" && agent.displayName != null;
  return {
    name: hasDisplay ? context.label : identityDisplayLabel({ id: agent.principalId, name: agent.name }, roster),
    exactName: hasDisplay ? context.exactName : undefined,
    disambiguator: context.badge,
  };
}

/** Chat uses the base label; the Home model's exact name stays available for addressing. */
export function hostedContextChatAuthor(
  author: AgentVM | PersonVM | null,
  agent: HostedContextLabelInput | null | undefined,
): AgentVM | PersonVM | null {
  return author && "label" in author && agent?.transport === "hosted_mcp" && agent.displayName != null
    ? { ...author, label: hostedContextLabel(agent).label }
    : author;
}
