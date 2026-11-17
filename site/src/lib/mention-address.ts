/**
 * AN @TAG READS A NAME OUT OF A SENTENCE. What the composer then does with that name lives in
 * `composer-address.ts`: the tag ADDS the person or agent to the To: set (ruling D2), it does
 * not open a DM and it does not replace whoever is already there.
 *
 * RETIRED 2026-09-05: "THE ADDRESS IS THE MESSAGE ... the send posts one signal per tag because
 * the wire carries a single recipient per signal." The wire learned a recipient list on
 * 2026-09-05 (`SIGNAL_RECIPIENT_MAX` in `_shared/channels.ts`), so one message now carries the
 * whole set. A reader who meets the old wording somewhere else should read this instead.
 *
 * The parser itself lives in src/protocol/mention-address.ts, so the CLI and both MCP servers
 * read a tag exactly as the composer does. This file adds only what the browser needs on top:
 * roster targets with display labels that tell duplicate names apart.
 */
import { identityDisplayLabels, type IdentityRecord } from "./identity-label.js";
import { isTaggable, type MentionTarget } from "../../../src/protocol/mention-address.js";

export {
  MENTION_MAX_RECIPIENTS,
  addressFromBody,
  isTaggable,
  mentionSpans,
  type MentionAddress,
  type MentionEntity,
  type MentionSpan,
  type MentionTarget,
} from "../../../src/protocol/mention-address.js";

/**
 * Longest name first, so "@Dana Rivera" is never read as "@Dana" plus stray text.
 * Entries without a name cannot be tagged and are dropped.
 */
export function mentionTargets(
  agents: ReadonlyArray<{ name?: string | null; principalId: string }>,
  members: ReadonlyArray<{ name?: string | null; userId: string }>,
): MentionTarget[] {
  const records: IdentityRecord[] = [
    ...agents.map((agent) => ({ id: agent.principalId, name: agent.name ?? "" })),
    ...members.map((member) => ({ id: member.userId, name: member.name ?? "" })),
  ];
  const labels = identityDisplayLabels(records);
  return [
    ...agents.map((agent, index) => {
      const name = agent.name ?? "";
      return {
        entity: { kind: "agent" as const, id: agent.principalId },
        name,
        label: labels[index]!,
      };
    }),
    ...members.map((member, index) => {
      const name = member.name ?? "";
      return {
        entity: { kind: "person" as const, id: member.userId },
        name,
        label: labels[agents.length + index]!,
      };
    }),
  ]
    .filter((target) => isTaggable(target.name))
    .sort((left, right) =>
      right.label.length - left.label.length || right.name.length - left.name.length
    );
}
