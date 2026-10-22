/*
 * Lists & docs copy shared by modules that must not load agent-hosts.ts (its module init builds the
 * Cursor install link, which needs btoa or Buffer). No imports and no side effects, on purpose.
 */
export const HOSTED_LISTS_NOTE =
  "Connected agents can use shared lists when access is enabled. Docs and files are not available through the connector yet.";
export const LOCAL_LISTS_LEAD = "Let it use Lists & docs here, or skip for now.";
