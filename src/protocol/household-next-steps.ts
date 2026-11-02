/** Approval guidance shared by local and hosted household tool callers. Only the agent's owner
 * can allow it (household-permissions.ts checkedConnection; the UI's Allow… needs agent.own).
 * Workspace access refusals also cover unrelated failures, so that hint is conditional. */
export function householdRefusalNextStep(reason: string): string | undefined {
  const place = 'CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  if (reason === 'content_consent_required' || reason === 'connection_access_refused') return `Ask this agent's owner to allow it in ${place}`;
  if (reason === 'workspace_access_refused') return `If this agent has not been allowed yet, ask its owner to allow it in ${place}`;
  return undefined;
}

export interface HouseholdRefusalDetails {
  code: string;
  missing: readonly string[];
  scope: { workspace_id: string };
  remedy_url: string;
  /** No agent tool or CLI command can grant content access today; only the owner's Allow… can. */
  mcp_tool: null;
  cli_command: null;
}

const REFUSAL_MISSING: Readonly<Record<string, string>> = {
  workspace_access_refused: 'workspace_access',
  content_consent_required: 'content_consent',
  connection_access_refused: 'connection_content_access',
  content_read_only: 'editor_content_role',
  owner_confirmation_required: 'workspace_content_boundary',
};

/** Structured remedy for access refusals. Scope comes only from the verified seat binding,
 * never from tool arguments. Other refusals (not found, conflicts) have no remedy fields. */
export function householdRefusalDetails(reason: string, workspaceId: string): HouseholdRefusalDetails | undefined {
  const missing = REFUSAL_MISSING[reason];
  if (missing === undefined) return undefined;
  const view = reason === 'owner_confirmation_required' ? 'lists' : 'people';
  return { code: reason, missing: [missing], scope: { workspace_id: workspaceId },
    remedy_url: `https://commonswarm.com/app?w=${encodeURIComponent(workspaceId)}&v=${view}`,
    mcp_tool: null, cli_command: null };
}
