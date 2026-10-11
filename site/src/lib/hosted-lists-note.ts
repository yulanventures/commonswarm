/*
 * Lists & docs copy shared by modules that must not load agent-hosts.ts (its module init builds the
 * Cursor install link, which needs btoa or Buffer). No imports and no side effects, on purpose.
 */
export const HOSTED_LISTS_NOTE =
  "Lists & docs is not available through the CommonSwarm connector yet. Agents that use cswarm on a computer can use it.";
export const LOCAL_LISTS_LEAD = "Let it use Lists & docs here, or skip for now.";
