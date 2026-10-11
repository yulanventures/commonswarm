/** Approval guidance shared by local and hosted household tool callers. Only the agent's owner
 * can allow it (household-permissions.ts checkedConnection; the UI's Allow… needs agent.own).
 * Workspace access refusals also cover unrelated failures, so that hint is conditional. */
export function householdRefusalNextStep(reason: string): string | undefined {
  const place = 'CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  if (reason === 'content_consent_required' || reason === 'connection_access_refused') return `Ask this agent's owner to allow it in ${place}`;
  if (reason === 'workspace_access_refused') return `If this agent has not been allowed yet, ask its owner to allow it in ${place}`;
  return undefined;
}
