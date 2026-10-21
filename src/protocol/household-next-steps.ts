import { householdRefusalDetails, type HouseholdRefusalDetails } from './household-tool-registry.js';
export { householdRefusalDetails, type HouseholdRefusalDetails } from './household-tool-registry.js';
/** Approval guidance shared by local and hosted household tool callers. Only the agent's owner
 * can allow it (household-permissions.ts checkedConnection; the UI's Allow… needs agent.own).
 * Workspace access refusals also cover unrelated failures, so that hint is conditional. */
export function householdRefusalNextStep(reason: string): string | undefined {
  if (reason === 'draft_access_refused') return 'Recover this private draft using its original user and agent connection. Permission changes cannot transfer a private draft.';
  const place = 'CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  if (reason === 'content_consent_required' || reason === 'connection_access_refused') return `Ask this agent's owner to allow it in ${place}`;
  if (reason === 'workspace_access_refused') return `If this agent has not been allowed yet, ask its owner to allow it in ${place}`;
  return undefined;
}

/** Closed projection. Never forward a server-supplied command, foreign scope or URL. */
export function projectHouseholdRefusalDetails(value: Record<string, unknown>, workspace: string): Partial<HouseholdRefusalDetails> {
  if (typeof value.code !== 'string' || value.code !== value.reason || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)) return {};
  const rawScope = value.scope as Record<string, unknown> | null;
  const scope = rawScope && typeof rawScope === 'object' && rawScope.workspace_id === workspace ? { workspace_id: workspace } : {};
  return householdRefusalDetails(value.code, scope, value.mcp_tool === 'object_permissions_confirm' || value.mcp_tool === 'list_permissions_confirm' ? value.mcp_tool : undefined);
}
