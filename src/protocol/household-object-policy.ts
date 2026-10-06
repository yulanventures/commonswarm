// Proposed household v1 policy. No credential lookup or storage I/O here.
export const HOUSEHOLD_OBJECT_LIMIT = 500;
export const HOUSEHOLD_STORAGE_BYTE_LIMIT = 1024 * 1024 * 1024;
export const HOUSEHOLD_VERSION_BYTE_LIMIT = 25 * 1024 * 1024;
export const HOUSEHOLD_LIVE_REVISION_LIMIT = 20;
export const HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT = 600;
export const HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT = 2000;

/** Also used by consent and tool generation during lane 4 integration. */
export const HOUSEHOLD_CONTENT_OPERATIONS = ['read', 'create', 'update'] as const;
export type HouseholdContentOperation = typeof HOUSEHOLD_CONTENT_OPERATIONS[number];
export const HOUSEHOLD_CONTENT_ROLES = ['reader', 'editor'] as const;
export type HouseholdContentRole = typeof HOUSEHOLD_CONTENT_ROLES[number];

export interface HouseholdMemberFacts {
  user_id: string;
  workspace_id: string;
  revoked_at: number | null;
  content_role: HouseholdContentRole | null;
  /** A human-confirmed receipt, never inferred from an administrative role. */
  content_consent_id: string | null;
}

export interface HouseholdConnectionFacts {
  principal_id: string;
  owner_user_id: string;
  workspace_id: string;
  connection_id: string;
  grant_id: string;
  revoked_at: number | null;
  /** NULL approvals last until withdrawn; local approvals retain token expiry. */
  expires_at: number | null;
  operations: readonly HouseholdContentOperation[];
  /** Private/shared purposes use different connections and principals. */
  purpose: 'personal' | 'shared';
}

/** Authenticated, transaction-locked facts. Never construct these from a request. */
export interface HouseholdAccessFacts {
  workspace_id: string;
  archived_at: number | null;
  boundary: { kind: 'shared' } | { kind: 'personal'; owner_user_id: string };
  actor: { user_id: string; principal_id: string | null; run_id: string | null };
  credential: { kind: 'human' } | { kind: 'agent'; connection: HouseholdConnectionFacts };
  member: HouseholdMemberFacts | null;
}

export type HouseholdAccessRefusal =
  | 'workspace_access_refused'
  | 'content_consent_required'
  | 'content_read_only'
  | 'connection_access_refused';

/** Administration, relationships, seat names and content cannot expand this check. */
export function householdAccessRefusal(
  facts: HouseholdAccessFacts,
  workspaceId: string,
  operation: HouseholdContentOperation,
  now: number,
): HouseholdAccessRefusal | null {
  const member = facts.member;
  if (!Number.isFinite(now) || !facts.actor.user_id || workspaceId !== facts.workspace_id || facts.archived_at !== null
    || !member || member.workspace_id !== workspaceId || member.user_id !== facts.actor.user_id
    || member.revoked_at !== null
    || (facts.boundary.kind === 'personal' && facts.boundary.owner_user_id !== facts.actor.user_id)) {
    return 'workspace_access_refused';
  }
  if (!member.content_consent_id || !(HOUSEHOLD_CONTENT_ROLES as readonly unknown[]).includes(member.content_role)) {
    return 'content_consent_required';
  }
  if (facts.credential.kind === 'human') {
    if (facts.actor.principal_id !== null) return 'connection_access_refused';
  } else {
    const connection = facts.credential.connection;
    if (!facts.actor.principal_id || facts.actor.principal_id !== connection.principal_id
      || connection.owner_user_id !== member.user_id || connection.workspace_id !== workspaceId
      || !connection.connection_id || !connection.grant_id || connection.revoked_at !== null
      || (connection.expires_at !== null && (!Number.isFinite(connection.expires_at) || connection.expires_at <= now))
      || connection.purpose !== facts.boundary.kind || !connection.operations.includes(operation)) {
      return 'connection_access_refused';
    }
  }
  return operation !== 'read' && member.content_role !== 'editor' ? 'content_read_only' : null;
}

/** Attempts include validated refusals; the adapter charges the durable bucket once. */
export function householdWriteLimitReached(identityAttempts: number, workspaceAttempts: number): boolean {
  return !Number.isSafeInteger(identityAttempts) || identityAttempts < 0
    || !Number.isSafeInteger(workspaceAttempts) || workspaceAttempts < 0
    || identityAttempts >= HOUSEHOLD_IDENTITY_WRITE_HOURLY_LIMIT
    || workspaceAttempts >= HOUSEHOLD_WORKSPACE_WRITE_HOURLY_LIMIT;
}
