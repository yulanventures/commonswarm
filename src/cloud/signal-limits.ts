/** Shared character limits for CLI input and MCP schemas. */
export const SIGNAL_BODY_MAX = 8_000;
export const SIGNAL_ABOUT_MAX = 500;
/** MCP selector cap only. swarm.users.display_name and swarm.agent_principals.name
 * are unbounded text in 20260723000001_p1_schema.sql; the CLI must accept them. */
export const SIGNAL_RECIPIENT_MAX = 80;
