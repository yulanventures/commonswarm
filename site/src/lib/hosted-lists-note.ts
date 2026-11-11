/*
 * Lists & docs copy shared by modules that must not load agent-hosts.ts (its module init builds the
 * Cursor install link, which needs btoa or Buffer). No imports and no side effects, on purpose.
 */
export const HOSTED_LISTS_NOTE =
  "Shared lists and to-dos work when enabled and approved. Documents and file objects in Lists & docs need a local agent. Workspace Files and Channels work through the connector.";
export const LOCAL_LISTS_LEAD = "Let it use Lists & docs here, or skip for now.";
