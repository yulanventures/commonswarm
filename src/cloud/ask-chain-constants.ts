/** Maximum number of parent-to-child edges in one declared ask chain. */
export const CHAIN_MAX_HOPS = 4;

/** Maximum number of direct follow-up asks that may name the same parent. */
export const CHAIN_MAX_CHILDREN = 3;

/** Fixed-minute ask budget shared by every credential for one agent principal. */
export const ASK_SENDER_PER_MINUTE = 20;

/** Fixed-ten-minute ask budget for one agent-sender/agent-recipient pair. */
export const ASK_PAIR_PER_10_MINUTES = 6;

/** Refusals whose service-authored sentence is the complete user remedy. */
export const ASK_CHAIN_REFUSAL_CODES = [
  "chain_parent_invalid",
  "chain_loop",
  "chain_too_long",
  "chain_too_wide",
] as const;

export function isAskChainRefusalCode(value: unknown): value is typeof ASK_CHAIN_REFUSAL_CODES[number] {
  return typeof value === "string" && (ASK_CHAIN_REFUSAL_CODES as readonly string[]).includes(value);
}
