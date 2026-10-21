/** Explicit human confirmation. Administration alone never grants content rights.
 * No default rights are provisioned when a workspace, member or seat is created. */
import type postgres from 'postgres';
import { assertHouseholdContentServiceReady, writeHostedContentRestriction } from './household-content-access.ts';
import type { HouseholdIdentity, HouseholdCredentialRecheck } from './household-objects.ts';
import { HOUSEHOLD_CONTENT_OPERATIONS } from '../_shared/protocol.js';
import { householdCanonical, householdSha256 } from './household-transfers.ts';
export { pendingLinkInvitationIds, revokeRemovedMemberHousehold } from './household-member-removal.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const refused = (reason: string) => ({ status: 'refused', reason });

interface ConnectionConsent {
  kind: 'hosted' | 'local'; connection_id: string; grant_id: string; principal_id: string; operations: string[];
}
function connectionConsent(value: unknown, role?: unknown): value is ConnectionConsent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  return !Object.keys(c).some(key => !['kind', 'connection_id', 'grant_id', 'principal_id', 'operations'].includes(key))
    && (c.kind === 'hosted' || c.kind === 'local') && uuid(c.connection_id) && uuid(c.grant_id) && uuid(c.principal_id)
    && Array.isArray(c.operations) && c.operations.length > 0 && new Set(c.operations).size === c.operations.length
    && c.operations.every(op => (HOUSEHOLD_CONTENT_OPERATIONS as readonly unknown[]).includes(op))
    && c.operations.includes('read') && (role !== 'reader' || c.operations.every(op => op === 'read'));
}
async function human(tx: Sql, actor: HouseholdIdentity, recheck: HouseholdCredentialRecheck) {
  return actor.principal_id === null && actor.connection === null && await recheck(tx, actor);
}
async function permissionContext(tx: Sql, workspaceId: string, actor: HouseholdIdentity) {
  await assertHouseholdContentServiceReady(tx);
  const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  const [member] = await tx`SELECT role, revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!workspace || workspace.archived_at !== null || !member || member.revoked_at !== null) return null;
  const [boundary] = await tx`SELECT purpose, owner_user_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  const [rights] = await tx`SELECT content_role, content_consent_id, revoked_at FROM swarm.household_member_content_roles
    WHERE workspace_id=${workspaceId}::uuid AND user_id=${actor.user_id}::uuid FOR SHARE`;
  return { member, boundary, rights };
}
export async function checkedConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity, connection: ConnectionConsent) {
  let expiry: Date | null = null;
  const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${connection.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!principal || principal.revoked_at !== null) return { allowed: false as const, expires_at: null };
  if (connection.kind === 'hosted') {
    const [seat] = await tx`SELECT s.seat_id FROM swarm.hosted_mcp_seats s
      JOIN swarm.hosted_mcp_grants g USING(grant_id)
      JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=s.grant_id AND b.workspace_id=s.workspace_id
      WHERE s.seat_id=${connection.connection_id}::uuid AND s.grant_id=${connection.grant_id}::uuid
      AND s.workspace_id=${workspaceId}::uuid AND s.principal_id=${connection.principal_id}::uuid
      AND s.owner_user_id=${actor.user_id}::uuid AND g.owner_user_id=${actor.user_id}::uuid
      AND g.state='active' AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND b.revoked_at IS NULL
      FOR SHARE OF s,g,b`;
    if (!seat) return { allowed: false as const, expires_at: null };
    // Reuse the existing canonical hosted authorization port without granting
    // the edge command role direct OAuth access. Always restore transaction role.
    const [role] = await tx`SELECT current_setting('role') AS value`;
    await tx`SELECT set_config('role','swarm_read',true)`;
    let live = false;
    try {
      const [resolved] = await tx`SELECT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seat_handles h
        CROSS JOIN LATERAL swarm.resolve_hosted_seat_read_authorization(${connection.grant_id}::uuid,h.handle,'whoami') a
        JOIN swarm.hosted_mcp_grants g ON g.grant_id=${connection.grant_id}::uuid
        WHERE h.seat_id=${connection.connection_id}::uuid AND h.revoked_at IS NULL
          AND a.workspace_id=${workspaceId}::uuid AND a.principal_id=${connection.principal_id}::uuid
          AND a.owner_user_id=${actor.user_id}::uuid
          AND commonswarm_oauth.provider_family_active(g.provider_grant_id)) AS live`;
      live = resolved?.live === true;
    } finally { await tx`SELECT set_config('role',${String(role!.value)},true)`; }
    if (!live) return { allowed: false as const, expires_at: null };
    expiry = null;
  } else if (connection.kind === 'local') {
    const [token] = await tx`SELECT t.expires_at FROM swarm.agent_tokens t JOIN swarm.agent_runs r USING(run_id)
      JOIN swarm.devices d USING(device_id)
      WHERE t.token_id=${connection.connection_id}::uuid AND t.run_id=${connection.grant_id}::uuid
      AND t.principal_id=${connection.principal_id}::uuid AND t.revoked_at IS NULL AND NOT t.surrender_only AND t.expires_at>clock_timestamp()
      AND r.principal_id=${connection.principal_id}::uuid
      AND r.ended_at IS NULL AND d.revoked_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones rt WHERE
        ((rt.kind='principal' AND rt.target_id=${connection.principal_id}::uuid)
          OR (rt.kind='run' AND rt.target_id=r.run_id) OR (rt.kind='device' AND rt.target_id=d.device_id)))
      FOR SHARE OF t,r,d`;
    if (!token) return { allowed: false as const, expires_at: null };
    expiry = new Date(token.expires_at as string);
  } else return { allowed: false as const, expires_at: null };
  return { allowed: true as const, expires_at: expiry };
}
async function requestContext(tx: Sql, workspaceId: string, actor: HouseholdIdentity, requestId: string, input: Record<string, unknown>) {
  const digest = await householdSha256(new TextEncoder().encode(householdCanonical({ workspace_id: workspaceId, command: input })));
  const [stream] = await tx`SELECT stream_id FROM swarm.streams WHERE workspace_id=${workspaceId}::uuid AND kind='workspace'`;
  const [prior] = await tx`SELECT request_hash,response FROM swarm.idempotency_keys WHERE principal_kind='user'
    AND principal_id=${actor.user_id} AND command_id=${requestId} FOR UPDATE`;
  return { digest, streamId: String(stream!.stream_id), response: prior
    ? prior.request_hash === digest ? prior.response as Record<string, unknown> : refused('request_id_reused') : null };
}
async function auditContext(tx: Sql, actor: HouseholdIdentity, requestId: string, digest: string, command: string) {
  await tx`SELECT set_config('cswarm.household_actor',${actor.user_id},true),
    set_config('cswarm.household_request',${requestId},true), set_config('cswarm.household_digest',${digest},true),
    set_config('cswarm.household_command',${command},true)`;
}
export async function writeConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity, connection: ConnectionConsent,
  purpose: string, consent: string, expiry: Date | null, ownerChat = false) {
  // The workspace lock serializes this primary-key upsert. Lock the existing
  // row explicitly so a reapproval fires one audit trigger, rather than both
  // BEFORE INSERT and BEFORE UPDATE through INSERT ... ON CONFLICT.
  const [existing] = await tx`SELECT connection_id FROM swarm.household_content_connections
    WHERE connection_id=${connection.connection_id}::uuid AND grant_id=${connection.grant_id}::uuid
      AND workspace_id=${workspaceId}::uuid AND principal_id=${connection.principal_id}::uuid FOR UPDATE`;
  if (existing) {
    await tx`UPDATE swarm.household_content_connections SET operations=${connection.operations}::text[],
      consent_receipt_id=${consent}::uuid,expires_at=${expiry},revoked_at=NULL
      WHERE connection_id=${connection.connection_id}::uuid AND grant_id=${connection.grant_id}::uuid
        AND workspace_id=${workspaceId}::uuid AND principal_id=${connection.principal_id}::uuid`;
  } else {
    await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
      VALUES (${connection.connection_id}::uuid,${connection.grant_id}::uuid,${workspaceId}::uuid,${connection.principal_id}::uuid,
        ${actor.user_id}::uuid,${purpose},${connection.operations}::text[],${consent}::uuid,${expiry},${connection.kind === 'hosted' ? connection.grant_id : null}::uuid)`;
  }
  if (connection.kind === 'hosted' && !ownerChat) await writeHostedContentRestriction(tx, workspaceId, actor.user_id,
    connection.grant_id, connection.principal_id, connection.operations, 'human_allow');
}
async function finish(tx: Sql, workspaceId: string, actor: HouseholdIdentity, requestId: string,
  request: Awaited<ReturnType<typeof requestContext>>, response: Record<string, postgres.JSONValue>, recheck: HouseholdCredentialRecheck) {
  if (!await recheck(tx, actor)) throw new Error('permission credential changed');
  await tx`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
    VALUES ('user',${actor.user_id},${requestId},${workspaceId}::uuid,${request.streamId}::uuid,${request.digest},${tx.json(response)})`;
  return response;
}

export async function provisionHouseholdPermissions(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (!await human(tx, actor, recheck)) return refused('human_confirmation_required');
  if (Object.keys(input).some(key => !['kind', 'purpose', 'content_role', 'connection'].includes(key))
    || !['personal', 'shared'].includes(String(input.purpose)) || !['reader', 'editor'].includes(String(input.content_role))) return refused('invalid_request');
  const connection = input.connection;
  if (connection != null && !connectionConsent(connection, input.content_role)) return refused('invalid_connection_consent');
  const context = await permissionContext(tx, workspaceId, actor);
  if (!context) return refused('workspace_access_refused');
  const request = await requestContext(tx, workspaceId, actor, requestId, input);
  if (request.response) return request.response;
  const { member, boundary } = context;
  if (!boundary && member.role !== 'owner') return refused('owner_confirmation_required');
  if (boundary && (boundary.purpose !== input.purpose || boundary.purpose === 'personal' && boundary.owner_user_id !== actor.user_id)) return refused('workspace_boundary_mismatch');
  const checked = connection != null ? await checkedConnection(tx, workspaceId, actor, connection as ConnectionConsent) : null;
  if (checked && !checked.allowed) return refused('connection_access_refused');
  const expiry = checked?.expires_at ?? null;
  await auditContext(tx, actor, requestId, request.digest, 'household_permissions');
  if (!boundary) await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id)
    VALUES (${workspaceId}::uuid,${String(input.purpose)},${input.purpose === 'personal' ? actor.user_id : null}::uuid)`;
  const consent = crypto.randomUUID();
  await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
    VALUES (${workspaceId}::uuid,${actor.user_id}::uuid,${String(input.content_role)},${consent}::uuid,clock_timestamp())
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET content_role=excluded.content_role, content_consent_id=excluded.content_consent_id,
      confirmed_at=excluded.confirmed_at, revoked_at=NULL`;
  if (connection != null) await writeConnection(tx, workspaceId, actor, connection as ConnectionConsent, String(input.purpose), consent, expiry);
  return finish(tx, workspaceId, actor, requestId, request, { status: 'committed', content_role: String(input.content_role),
    consent_receipt_id: consent, connection_confirmed: connection != null, expires_at: expiry?.toISOString() ?? null }, recheck);
}

/** Approve the agent using the person's existing content role and consent. */
export async function approveHouseholdConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (!await human(tx, actor, recheck)) return refused('human_confirmation_required');
  if (input.kind !== 'household_approve_connection' || Object.keys(input).some(key => !['kind', 'connection'].includes(key))) return refused('invalid_request');
  if (!connectionConsent(input.connection)) return refused('invalid_connection_consent');
  const context = await permissionContext(tx, workspaceId, actor);
  if (!context) return refused('workspace_access_refused');
  const request = await requestContext(tx, workspaceId, actor, requestId, input);
  if (request.response) return request.response;
  const { boundary, rights } = context;
  if (!boundary) return refused('owner_confirmation_required');
  if (boundary.purpose === 'personal' && boundary.owner_user_id !== actor.user_id) return refused('workspace_boundary_mismatch');
  if (!rights || rights.revoked_at !== null) return refused('content_consent_required');
  if (!connectionConsent(input.connection, rights.content_role)) return refused('invalid_connection_consent');
  const checked = await checkedConnection(tx, workspaceId, actor, input.connection);
  if (!checked.allowed) return refused('connection_access_refused');
  await auditContext(tx, actor, requestId, request.digest, 'household_approve_connection');
  await writeConnection(tx, workspaceId, actor, input.connection, String(boundary.purpose), String(rights.content_consent_id), checked.expires_at);
  return finish(tx, workspaceId, actor, requestId, request, { status: 'committed', operations: input.connection.operations,
    expires_at: checked.expires_at?.toISOString() ?? null }, recheck);
}

/** Withdrawal does not depend on current content consent or a live seat/grant. */
export async function withdrawHouseholdConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (!await human(tx, actor, recheck)) return refused('human_confirmation_required');
  if (input.kind !== 'household_withdraw_connection' || Object.keys(input).some(key => !['kind', 'principal_id'].includes(key))
    || !uuid(input.principal_id)) return refused('invalid_request');
  const context = await permissionContext(tx, workspaceId, actor);
  if (!context) return refused('workspace_access_refused');
  const request = await requestContext(tx, workspaceId, actor, requestId, input);
  if (request.response) return request.response;
  const [principal] = await tx`SELECT principal_id FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${input.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!principal) return refused('connection_access_refused');
  await tx`SELECT connection_id FROM swarm.household_content_connections WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${input.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid
    ORDER BY connection_id,grant_id FOR UPDATE`;
  const [seat] = await tx`SELECT seat_id,grant_id FROM swarm.hosted_mcp_seats WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${input.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid FOR SHARE`;
  await auditContext(tx, actor, requestId, request.digest, 'household_withdraw_connection');
  if (seat) await writeHostedContentRestriction(tx, workspaceId, actor.user_id,
    String(seat.grant_id), input.principal_id, [], 'human_withdraw');
  const withdrawn = await tx`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
    WHERE workspace_id=${workspaceId}::uuid AND principal_id=${input.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid
      AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp()) RETURNING connection_id`;
  return finish(tx, workspaceId, actor, requestId, request, { status: 'committed', withdrawn: withdrawn.length }, recheck);
}
