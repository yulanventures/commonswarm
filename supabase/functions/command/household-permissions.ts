import { localAgentWorkspaceLive } from '../_shared/agent-auth.ts';
/** Explicit human confirmation. Administration alone never grants content rights.
 * No default rights are provisioned when a workspace, member or seat is created. */
import type postgres from 'postgres';
import { lockLocalAuthPlan, planLocalConnection, type LocalAuthLockPlan } from '../_shared/agent-auth.ts';
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
async function checkedConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity, connection: ConnectionConsent, plan: LocalAuthLockPlan | null = null): Promise<{ allowed: boolean; expires_at: Date | null; renewal_grant_id?: string | null }> {
  let expiry: Date | null = null;
  if (connection.kind === 'local' && !plan?.locked) return { allowed: false, expires_at: null };
  const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid
    AND principal_id=${connection.principal_id}::uuid AND owner_user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!principal || principal.revoked_at !== null) return { allowed: false as const, expires_at: null };
  if (connection.kind === 'hosted') {
    const [seat] = await tx`SELECT s.seat_id,g.connection_expires_at,g.connection_expired_at FROM swarm.hosted_mcp_seats s
      JOIN swarm.hosted_mcp_grants g USING(grant_id)
      JOIN swarm.hosted_mcp_grant_workspaces b ON b.grant_id=s.grant_id AND b.workspace_id=s.workspace_id
      WHERE s.seat_id=${connection.connection_id}::uuid AND s.grant_id=${connection.grant_id}::uuid
      AND s.workspace_id=${workspaceId}::uuid AND s.principal_id=${connection.principal_id}::uuid
      AND s.owner_user_id=${actor.user_id}::uuid AND g.owner_user_id=${actor.user_id}::uuid
      AND g.state='active' AND g.revoked_at IS NULL AND s.revoked_at IS NULL AND b.revoked_at IS NULL
      FOR SHARE OF s,g,b`;
    if (!seat) return { allowed: false as const, expires_at: null };
    // Evaluate chosen policy with a fresh database clock after the existing
    // principal/seat/grant/binding waits. A terminal family stays terminal.
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    expiry = seat.connection_expires_at == null ? null : new Date(seat.connection_expires_at as string);
    if (seat.connection_expired_at !== null || expiry !== null && expiry.getTime() <= new Date(clock!.now as string).getTime())
      return { allowed: false as const, expires_at: null };
  } else if (connection.kind === 'local') {
    // No token/RLS read or family FK write is allowed before the complete plan.
    const target = plan?.snapshot.bindings.find(row => row.token_id === connection.connection_id);
    if (!plan?.locked || !target?.renewal_grant_id || target.run_id !== connection.grant_id
      || target.principal_id !== connection.principal_id || target.owner_user_id !== actor.user_id
      || !await localAgentWorkspaceLive(tx,target.principal_id,workspaceId)) return { allowed: false as const, expires_at: null, renewal_grant_id: null };
    const [token] = await tx`SELECT t.token_id,g.renewal_grant_id,g.connection_expires_at,g.connection_expired_at,
        t.expires_at,t.revoked_at,t.surrender_only,r.ended_at,d.revoked_at AS device_revoked_at,
        g.revoked_at AS family_revoked_at,g.suspension_active,
        g.bound_device_id,r.device_id
      FROM swarm.agent_tokens t JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
      JOIN swarm.devices d USING(device_id)
      JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
        AND g.run_id=t.run_id AND g.principal_id=t.principal_id
        AND g.created_by=${actor.user_id}::uuid
      WHERE t.token_id=${connection.connection_id}::uuid AND t.run_id=${connection.grant_id}::uuid
        AND t.principal_id=${connection.principal_id}::uuid AND g.renewal_grant_id=${target.renewal_grant_id}::uuid
        AND swarm.admin_child_live(t.parent_admin_grant_id,${workspaceId}::uuid)
        AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
        AND NOT EXISTS (SELECT 1 FROM swarm.revocation_tombstones rt WHERE
          (rt.kind,rt.target_id) IN (('token',t.token_id),('principal',t.principal_id),('run',r.run_id),
            ('device',d.device_id),('lineage',t.lineage_id),('family',t.lineage_id),
            ('renewal_grant',g.renewal_grant_id),('membership',${actor.user_id}::uuid)))`;
    // Every acquisition happened in the plan; use a new statement after waits.
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    const now = new Date(clock!.now as string).getTime();
    if (!token || token.revoked_at !== null || token.surrender_only || new Date(token.expires_at as string).getTime() <= now
      || token.ended_at !== null || token.device_revoked_at !== null || token.family_revoked_at !== null
      || token.connection_expired_at !== null
      || token.connection_expires_at !== null && new Date(token.connection_expires_at as string).getTime() <= now
      || token.bound_device_id !== null && token.bound_device_id !== token.device_id)
      return { allowed: false as const, expires_at: null, renewal_grant_id: null };
    // Only the canonical chosen policy is a user expiry. Token rotation is technical.
    return { allowed: true as const, expires_at: token.connection_expires_at == null ? null : new Date(token.connection_expires_at as string),
      renewal_grant_id: String(token.renewal_grant_id) };
  } else return { allowed: false as const, expires_at: null };
  return { allowed: true as const, expires_at: expiry, renewal_grant_id: null };
}
async function prepareLocalConsent(tx: Sql, workspaceId: string, actor: HouseholdIdentity, connection: ConnectionConsent | null) {
  if (connection?.kind !== 'local') return null;
  const plan = await planLocalConnection(tx, workspaceId, actor.user_id, connection.principal_id, connection.connection_id);
  if (plan) await lockLocalAuthPlan(tx, plan);
  return plan;
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
async function writeConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity, connection: ConnectionConsent,
  purpose: string, consent: string, family: string | null) {
  // Hosted chosen expiry belongs to the canonical grant. Persisting a copy
  // would turn an extended/cleared date into a stale manual restriction.
  // Local family policy is canonical too; never persist its technical bearer deadline.
  const approvalExpiry = null;
  if (connection.kind === 'local' && family === null) throw new Error('local approval family missing');
  // The workspace lock serializes this primary-key upsert. Lock the existing
  // row explicitly so a reapproval fires one audit trigger, rather than both
  // BEFORE INSERT and BEFORE UPDATE through INSERT ... ON CONFLICT.
  const [existing] = await tx`SELECT * FROM swarm.household_content_connections
    WHERE connection_id=${connection.connection_id}::uuid AND grant_id=${connection.grant_id}::uuid
      AND workspace_id=${workspaceId}::uuid AND principal_id=${connection.principal_id}::uuid FOR UPDATE`;
  if (existing) {
    await tx`UPDATE swarm.household_content_connections SET operations=${connection.operations}::text[],
      consent_receipt_id=${consent}::uuid,expires_at=${approvalExpiry},revoked_at=NULL,renewal_grant_id=${family}::uuid
      WHERE connection_id=${connection.connection_id}::uuid AND grant_id=${connection.grant_id}::uuid
        AND workspace_id=${workspaceId}::uuid AND principal_id=${connection.principal_id}::uuid`;
  } else {
    await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,purpose,operations,consent_receipt_id,expires_at,hosted_grant_id,renewal_grant_id)
      VALUES (${connection.connection_id}::uuid,${connection.grant_id}::uuid,${workspaceId}::uuid,${connection.principal_id}::uuid,
        ${actor.user_id}::uuid,${purpose},${connection.operations}::text[],${consent}::uuid,${approvalExpiry},${connection.kind === 'hosted' ? connection.grant_id : null}::uuid,${family}::uuid)`;
  }
  if (connection.kind === 'local') await tx`SELECT swarm.set_local_workspace_approval(${family}::uuid,${workspaceId}::uuid,${connection.connection_id}::uuid)`;
  // A second Allow on the same technical bearer updates the same primary key.
  // Preserve the previous decision's exact permission/receipt in append-only
  // audit before returning success; no old decision vanishes on re-Allow/widen.
  if (connection.kind === 'local') await tx`INSERT INTO swarm.audit_log(
      actor_user,credential_kind,credential_id,command_kind,workspace_id,outcome,reason,detail,request_hash)
    SELECT ${actor.user_id}::uuid,'user',${actor.user_id}::uuid,
      current_setting('cswarm.household_command',true),${workspaceId}::uuid,'accepted','local_allow_decision',
      jsonb_build_object('before',${tx.json((existing ?? null) as postgres.JSONValue)},'after',to_jsonb(c))::text,
      current_setting('cswarm.household_digest',true)
    FROM swarm.household_content_connections c WHERE c.connection_id=${connection.connection_id}::uuid
      AND c.grant_id=${connection.grant_id}::uuid AND c.workspace_id=${workspaceId}::uuid
      AND c.principal_id=${connection.principal_id}::uuid`;
  if (connection.kind === 'hosted') await writeHostedContentRestriction(tx, workspaceId, actor.user_id,
    connection.grant_id, connection.principal_id, connection.operations, 'human_allow');
}
async function finish(tx: Sql, workspaceId: string, actor: HouseholdIdentity, requestId: string,
  request: Awaited<ReturnType<typeof requestContext>>, response: Record<string, postgres.JSONValue>, recheck: HouseholdCredentialRecheck, finalConnectionCheck?: () => Promise<boolean>) {
  if (!await recheck(tx, actor)) throw new Error('permission credential changed');
  await tx`INSERT INTO swarm.idempotency_keys(principal_kind,principal_id,command_id,workspace_id,stream_id,request_hash,response)
    VALUES ('user',${actor.user_id},${requestId},${workspaceId}::uuid,${request.streamId}::uuid,${request.digest},${tx.json(response)})`;
  if (finalConnectionCheck && !await finalConnectionCheck()) throw new Error('local approval changed before commit');
  if (!await recheck(tx, actor)) throw new Error('permission credential changed');
  return response;
}

export async function provisionHouseholdPermissions(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (!await human(tx, actor, recheck)) return refused('human_confirmation_required');
  if (Object.keys(input).some(key => !['kind', 'purpose', 'content_role', 'connection'].includes(key))
    || !['personal', 'shared'].includes(String(input.purpose)) || !['reader', 'editor'].includes(String(input.content_role))) return refused('invalid_request');
  const connection = input.connection;
  if (connection != null && !connectionConsent(connection, input.content_role)) return refused('invalid_connection_consent');
  const localPlan = await prepareLocalConsent(tx, workspaceId, actor, connection as ConnectionConsent | null);
  const context = await permissionContext(tx, workspaceId, actor);
  if (!context) return refused('workspace_access_refused');
  const request = await requestContext(tx, workspaceId, actor, requestId, input);
  if (request.response) return request.response;
  const { member, boundary } = context;
  if (!boundary && member.role !== 'owner') return refused('owner_confirmation_required');
  if (boundary && (boundary.purpose !== input.purpose || boundary.purpose === 'personal' && boundary.owner_user_id !== actor.user_id)) return refused('workspace_boundary_mismatch');
  const checked = connection != null ? await checkedConnection(tx, workspaceId, actor, connection as ConnectionConsent, localPlan) : null;
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
  if (connection != null) await writeConnection(tx, workspaceId, actor, connection as ConnectionConsent, String(input.purpose), consent, checked?.renewal_grant_id ?? null);
  return finish(tx, workspaceId, actor, requestId, request, { status: 'committed', content_role: String(input.content_role),
    consent_receipt_id: consent, connection_confirmed: connection != null, expires_at: expiry?.toISOString() ?? null }, recheck, connection != null && (connection as ConnectionConsent).kind === 'local'
      ? async () => (await checkedConnection(tx, workspaceId, actor, connection as ConnectionConsent, localPlan)).allowed : undefined);
}

/** Approve the agent using the person's existing content role and consent. */
export async function approveHouseholdConnection(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck): Promise<Record<string, unknown>> {
  if (!await human(tx, actor, recheck)) return refused('human_confirmation_required');
  if (input.kind !== 'household_approve_connection' || Object.keys(input).some(key => !['kind', 'connection'].includes(key))) return refused('invalid_request');
  if (!connectionConsent(input.connection)) return refused('invalid_connection_consent');
  const localPlan = await prepareLocalConsent(tx, workspaceId, actor, input.connection);
  const context = await permissionContext(tx, workspaceId, actor);
  if (!context) return refused('workspace_access_refused');
  const request = await requestContext(tx, workspaceId, actor, requestId, input);
  if (request.response) return request.response;
  const { boundary, rights } = context;
  if (!boundary) return refused('owner_confirmation_required');
  if (boundary.purpose === 'personal' && boundary.owner_user_id !== actor.user_id) return refused('workspace_boundary_mismatch');
  if (!rights || rights.revoked_at !== null) return refused('content_consent_required');
  if (!connectionConsent(input.connection, rights.content_role)) return refused('invalid_connection_consent');
  const checked = await checkedConnection(tx, workspaceId, actor, input.connection, localPlan);
  if (!checked.allowed) return refused('connection_access_refused');
  await auditContext(tx, actor, requestId, request.digest, 'household_approve_connection');
  await writeConnection(tx, workspaceId, actor, input.connection, String(boundary.purpose), String(rights.content_consent_id), checked.renewal_grant_id ?? null);
  return finish(tx, workspaceId, actor, requestId, request, { status: 'committed', operations: input.connection.operations,
    expires_at: checked.expires_at?.toISOString() ?? null }, recheck, input.connection.kind === 'local'
      ? async () => (await checkedConnection(tx, workspaceId, actor, input.connection as ConnectionConsent, localPlan)).allowed : undefined);
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
  const [principal] = await tx`SELECT principal_id FROM swarm.agent_principals WHERE (workspace_id=${workspaceId}::uuid AND transport='hosted_mcp' OR swarm.local_agent_workspace_live(principal_id,${workspaceId}::uuid))
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
