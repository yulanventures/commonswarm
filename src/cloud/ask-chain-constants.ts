/** Maximum number of parent-to-child edges in one declared ask chain. */
export const CHAIN_MAX_HOPS = 4;

/** Maximum number of direct follow-up asks that may name the same parent. */
export const CHAIN_MAX_CHILDREN = 3;

/** Fixed-minute ask budget shared by every credential for one agent principal. */
export const ASK_SENDER_PER_MINUTE = 20;

/** Fixed-ten-minute ask budget for one agent-sender/agent-recipient pair. */
export const ASK_PAIR_PER_10_MINUTES = 6;
