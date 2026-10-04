/** Explicit human confirmation. Administration alone never grants content rights.
 * No default rights are provisioned when a workspace, member or seat is created. */
import type postgres from 'postgres';
import type { HouseholdIdentity, HouseholdCredentialRecheck } from './household-objects.ts';
import { HOUSEHOLD_CONTENT_OPERATIONS } from '../_shared/protocol.js';
import { householdCanonical, householdSha256 } from './household-transfers.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const refused = (reason: string) => ({ status: 'refused', reason });

export async function provisionHouseholdPermissions(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (actor.principal_id !== null || actor.connection !== null || !await recheck(tx, actor)) return refused('human_confirmation_required');
  if (Object.keys(input).some(key => !['kind', 'purpose', 'content_role', 'connection'].includes(key))
    || !['personal', 'shared'].includes(String(input.purpose)) || !['reader', 'editor'].includes(String(input.content_role))) return refused('invalid_request');
  const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  const [member] = await tx`SELECT role, revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!workspace || workspace.archived_at !== null || !member || member.revoked_at !== null) return refused('workspace_access_refused');
  const [boundary] = await tx`SELECT purpose, owner_user_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  if (!boundary && member.role !== 'owner') return refused('owner_confirmation_required');
  if (boundary && (boundary.purpose !== input.purpose || boundary.purpose === 'personal' && boundary.owner_user_id !== actor.user_id)) return refused('workspace_boundary_mismatch');
  const connection = input.connection as Record<string, unknown> | undefined;
  let expiry: Date | null = null;
  if (connection) {
    if (typeof connection !== 'object' || Array.isArray(connection) || Object.keys(connection).some(key => !['kind','connection_id','grant_id','principal_id','operations'].includes(key))
      || !uuid(connection.connection_id) || !uuid(connection.grant_id) || !uuid(connection.principal_id)
      || !Array.isArray(connection.operations) || connection.operations.length < 1
      || new Set(connection.operations).size !== connection.operations.length
      || !connection.operations.every(op => (HOUSEHOLD_CONTENT_OPERATIONS as readonly unknown[]).includes(op))
      || !connection.operations.includes('read') || input.content_role === 'reader' && connection.operations.some(op => op !== 'read')) return refused('invalid_connection_consent');
    const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid
      AND principal_id=${connection.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid FOR SHARE`;
    if (!principal || principal.revoked_at !== null) return refused('connection_access_refused');
    if (connection.kind === 'hosted') {
      const [seat] = await tx`SELECT s.seat_id FROM swarm.hosted_mcp_seats s
        JOIN swarm.hosted_mcp_grants g USING(grant_id)
        JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=s.grant_id AND b.workspace_id=s.workspace_id
        WHERE s.seat_id=${connection.connection_id}::uuid AND s.grant_id=${connection.grant_id}::uuid
        AND s.workspace_id=${workspaceId}::uuid AND s.principal_id=${connection.principal_id}::uuid
        AND s.owner_user_id=${actor.user_id}::uuid AND g.owner_user_id=${actor.user_id}::uuid
        AND g.state='active' AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND b.revoked_at IS NULL
        FOR SHARE OF s,g,b`;
      if (!seat) return refused('connection_access_refused');
      expiry = new Date(Date.now() + 24 * 60 * 60_000);
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
      if (!token) return refused('connection_access_refused');
      expiry = new Date(token.expires_at as string);
    } else return refused('invalid_connection_consent');
  }
  const digest = await householdSha256(new TextEncoder().encode(householdCanonical({ workspace_id: workspaceId, command: input })));
  const [stream] = await tx`SELECT stream_id FROM swarm.streams WHERE workspace_id=${workspaceId}::uuid AND kind='workspace'`;
  const [prior] = await tx`SELECT request_hash,response FROM swarm.idempotency_keys WHERE principal_kind='user'
    AND principal_id=${actor.user_id} AND command_id=${requestId} FOR UPDATE`;
  if (prior) return prior.request_hash === digest ? prior.response as Record<string, unknown> : refused('request_id_reused');
  // The permission triggers require authenticated provenance and append their
  // own immutable audit rows in this transaction, including connection changes.
  await tx`SELECT set_config('cswarm.household_actor',${actor.user_id},true),
    set_config('cswarm.household_request',${requestId},true), set_config('cswarm.household_digest',${digest},true)`;
  if (!boundary) await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id)
    VALUES (${workspaceId}::uuid,${String(input.purpose)},${input.purpose === 'personal' ? actor.user_id : null}::uuid)`;
  const consent = crypto.randomUUID();
  await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
    VALUES (${workspaceId}::uuid,${actor.user_id}::uuid,${String(input.content_role)},${consent}::uuid,clock_timestamp())
    ON CONFLICT(workspace_id,user_id) DO UPDATE SET content_role=excluded.content_role, content_consent_id=excluded.content_consent_id,
      confirmed_at=excluded.confirmed_at, revoked_at=NULL`;
  if (connection && expiry) await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id)
    VALUES (${String(connection.connection_id)}::uuid,${String(connection.grant_id)}::uuid,${workspaceId}::uuid,${String(connection.principal_id)}::uuid,
      ${actor.user_id}::uuid,${String(input.purpose)},${connection.operations as string[]}::text[],${consent}::uuid,${expiry},${connection.kind === 'hosted' ? String(connection.grant_id) : null}::uuid)
    ON CONFLICT(connection_id,grant_id,workspace_id,principal_id) DO UPDATE SET operations=excluded.operations,
      consent_receipt_id=excluded.consent_receipt_id,expires_at=excluded.expires_at,revoked_at=NULL`;
  if (!await recheck(tx, actor)) throw new Error('permission credential changed');
  const response = { status: 'committed', content_role: String(input.content_role), consent_receipt_id: consent,
    connection_confirmed: !!connection, expires_at: expiry?.toISOString() ?? null };
  await tx`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
    VALUES ('user',${actor.user_id},${requestId},${workspaceId}::uuid,${String(stream!.stream_id)}::uuid,${digest},${tx.json(response)})`;
  return response;
}
