/**
 * Reactions on a message, as the web app shows them: the picker's emojis and the words a pill
 * says. The rule for what an emoji is lives in src/protocol/signal-reactions.ts, shared with the
 * edge and the CLI.
 */
import { SIGNAL_REACTION_SHORTCODES } from "../../../src/protocol/signal-reactions";

/** The picker: each emoji the shortcodes name, once, in their order. */
export const REACTION_PICKER_EMOJIS: readonly string[] = Object.freeze([...new Set(Object.values(SIGNAL_REACTION_SHORTCODES))]);

export interface ReactionActor {
  kind: "person" | "agent";
  id: string;
}

/** One emoji on one message: who added it, oldest first, and whether the signed-in person is among them. */
export interface ReactionGroup {
  emoji: string;
  count: number;
  actors: ReactionActor[];
  mine: boolean;
}

/** "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** Who reacted, as a person reads it: "you" first when the signed-in person is among them. */
export function reactionNames(group: ReactionGroup, viewerId: string, nameOf: (actor: ReactionActor) => string): string {
  const own = group.actors.filter((actor) => actor.kind === "person" && actor.id === viewerId);
  const others = group.actors.filter((actor) => !(actor.kind === "person" && actor.id === viewerId)).map(nameOf);
  return joinNames([...(own.length ? ["you"] : []), ...others]);
}

/** A pill's accessible name: the emoji, how many, who, and what a click does. */
export function reactionPillLabel(group: ReactionGroup, names: string): string {
  return `${group.emoji} ${group.count}, ${names}; ${group.mine ? "remove yours" : "add yours"}`;
}

/** The picker's next item for a key, or null when the key does not move. Rows are `columns` wide. */
export function pickerMove(key: string, index: number, total: number, columns: number): number | null {
  if (total < 1) return null;
  switch (key) {
    case "ArrowRight": return (index + 1) % total;
    case "ArrowLeft": return (index - 1 + total) % total;
    case "ArrowDown": return Math.min(index + columns, total - 1);
    case "ArrowUp": return Math.max(index - columns, 0);
    case "Home": return 0;
    case "End": return total - 1;
    default: return null;
  }
}
