/** Approval guidance shared by local and hosted household tool callers.
 * Workspace access refusals also cover unrelated failures, so that hint is conditional. */
export function householdRefusalNextStep(reason: string): string | undefined {
  const place = 'CommonSwarm: People & agents → this agent → Lists & docs → Allow…';
  if (reason === 'content_consent_required' || reason === 'connection_access_refused') return `Ask a workspace member to allow this agent in ${place}`;
  if (reason === 'workspace_access_refused') return `If this agent has not been allowed yet, ask a workspace member to allow it in ${place}`;
  return undefined;
}
