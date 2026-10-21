/** Owner-chat assertions come from the authenticated caller. They are not a
 * server-verified chat receipt. No identity field is accepted from model input. */
import type postgres from 'postgres';
import type { HouseholdIdentity, HouseholdCredentialRecheck } from './household-objects.ts';
import type { HouseholdTodoNoticePort } from './household-todos.ts';
import { checkedConnection, writeConnection } from './household-permissions.ts';
import { assertHouseholdContentServiceReady, loadHouseholdContentAccess } from './household-content-access.ts';
import { householdCanonical, householdSha256 } from './household-transfers.ts';
import { householdAccessRefusal, validateHouseholdToolArguments } from '../_shared/protocol.js';
import type { HouseholdOwnerPermissionCommand } from '../_shared/household-tool-registry.d.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
const refused = (reason: string) => ({ status: 'refused', reason });
export class HouseholdOwnerPermissionAborted extends Error {
  constructor() { super('Owner permission transaction aborted.'); this.name = 'HouseholdOwnerPermissionAborted'; }
}

export async function confirmOwnerHouseholdPermissions(tx: Sql, workspaceId: string, actor: HouseholdIdentity,
  requestId: string, input: Record<string, unknown>, recheck: HouseholdCredentialRecheck,
  notice?: HouseholdTodoNoticePort): Promise<Record<string, unknown>> {
  const args = validateHouseholdToolArguments('object_permissions_confirm', input);
  if (args.request_id !== requestId) return refused('request_id_mismatch');
  if (!await recheck(tx, actor)) return refused('credential_revoked');
  if (actor.principal_id === null && (actor.connection !== null || actor.run_id !== null)) return refused('workspace_access_refused');
  if (actor.principal_id !== null && !actor.connection) return refused('connection_access_refused');
  await assertHouseholdContentServiceReady(tx);
  const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  const [member] = await tx`SELECT role,revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid
    AND user_id=${actor.user_id}::uuid FOR SHARE`;
  if (!workspace || workspace.archived_at !== null || member?.role !== 'owner' || member.revoked_at !== null)
    return refused('owner_confirmation_required');
  if (actor.principal_id !== null) {
    const source = { kind: actor.run_id === null ? 'hosted' as const : 'local' as const,
      ...actor.connection!, principal_id: actor.principal_id, operations: ['read'] };
    if (!(await checkedConnection(tx, workspaceId, actor, source)).allowed) return refused('connection_access_refused');
  }
  const action = args.action as HouseholdOwnerPermissionCommand['action'];
  const digest = await householdSha256(new TextEncoder().encode(householdCanonical({ workspace_id: workspaceId,
    source: actor, input: args })));
  const [prior] = await tx`SELECT request_digest,response FROM swarm.household_owner_permission_receipts
    WHERE workspace_id=${workspaceId}::uuid AND actor_user=${actor.user_id}::uuid
      AND actor_key=${actor.principal_id ?? actor.user_id}::uuid AND request_id=${requestId} FOR UPDATE`;
  if (prior) return prior.request_digest === digest
    ? { ...prior.response as Record<string, unknown>, replayed: true } : refused('request_id_reused');
  const [boundary] = await tx`SELECT purpose,owner_user_id FROM swarm.household_workspace_boundaries
    WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  const [rights] = await tx`SELECT content_role,content_consent_id,revoked_at FROM swarm.household_member_content_roles
    WHERE workspace_id=${workspaceId}::uuid AND user_id=${actor.user_id}::uuid FOR SHARE`;
  if (boundary?.purpose === 'personal' && boundary.owner_user_id !== actor.user_id) return refused('workspace_boundary_mismatch');
  // Setup cannot erase a prior withdrawal or raise an existing reader ceiling.
  if (rights && (rights.revoked_at !== null || action.kind === 'setup' && rights.content_role === 'reader' && action.content_role === 'editor'))
    return refused('content_read_only');
  if (actor.connection) {
    const approvals = await tx`SELECT operations,revoked_at,expires_at FROM swarm.household_content_connections
      WHERE workspace_id=${workspaceId}::uuid AND owner_user_id=${actor.user_id}::uuid
        AND (connection_id=${actor.connection.connection_id}::uuid OR hosted_grant_id=${actor.run_id === null ? actor.connection.grant_id : null}::uuid)
      FOR SHARE`;
    const restrictions = actor.run_id === null ? await tx`SELECT operations FROM swarm.household_hosted_content_restrictions
      WHERE workspace_id=${workspaceId}::uuid AND grant_id=${actor.connection.grant_id}::uuid FOR SHARE` : [];
    const wanted = action.kind === 'setup' ? action.content_role === 'editor' ? ['read','create','update'] : ['read'] : action.connection.operations;
    const [clock] = await tx`SELECT clock_timestamp() AS now`;
    if (approvals.some(row => row.revoked_at !== null || row.expires_at !== null && new Date(row.expires_at as string) <= new Date(clock!.now as string)
      || wanted.some(op => !(row.operations as string[]).includes(op)))
      || restrictions.some(row => wanted.some(op => !(row.operations as string[]).includes(op)))) return refused('caller_content_restricted');
  }
  if (action.kind === 'setup') {
    if (boundary && boundary.purpose !== action.purpose) return refused('workspace_boundary_mismatch');
  } else {
    if (!boundary) return refused('owner_confirmation_required');
    if (!rights) return refused('content_consent_required');
    const target = action.connection;
    if (target.principal_id === actor.principal_id || target.connection_id === actor.connection?.connection_id
      || target.kind === 'hosted' && actor.run_id === null && target.grant_id === actor.connection?.grant_id)
      return refused('self_permission_change_refused');
    if (rights.content_role === 'reader' && target.operations.some(op => op !== 'read')) return refused('content_read_only');
    if (actor.principal_id !== null) {
      const access = await loadHouseholdContentAccess(tx, workspaceId, actor);
      if (!access || target.operations.some(op => householdAccessRefusal(access.facts, workspaceId, op, access.now)))
        return refused('caller_content_restricted');
    }
    if (!(await checkedConnection(tx, workspaceId, actor, target)).allowed) return refused('connection_access_refused');
    // A delegated Allow never rewrites grant-wide human/system restrictions.
    // Refuse a widening instead of reporting an ineffective approval as success.
    if (target.kind === 'hosted') {
      const policies = await tx`SELECT operations FROM swarm.household_hosted_content_restrictions
        WHERE workspace_id=${workspaceId}::uuid AND grant_id=${target.grant_id}::uuid FOR SHARE`;
      if (policies.some(row => target.operations.some(op => !(row.operations as string[]).includes(op))))
        return refused('target_content_restricted');
    }
  }
  if (!notice) throw new HouseholdOwnerPermissionAborted();
  await tx`SELECT set_config('cswarm.household_actor',${actor.user_id},true),
    set_config('cswarm.household_principal',${actor.principal_id ?? ''},true),
    set_config('cswarm.household_request',${requestId},true),set_config('cswarm.household_digest',${digest},true),
    set_config('cswarm.household_command','household_owner_permissions',true)`;
  if (action.kind === 'setup') {
    if (!boundary) await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose,owner_user_id)
      VALUES (${workspaceId}::uuid,${action.purpose},${action.purpose === 'personal' ? actor.user_id : null}::uuid)`;
    // Existing consent is preserved; setup is additive and cannot reset it.
    if (!rights) await tx`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES (${workspaceId}::uuid,${actor.user_id}::uuid,${action.content_role},${crypto.randomUUID()}::uuid,clock_timestamp())`;
  } else {
    const checked = await checkedConnection(tx, workspaceId, actor, action.connection);
    if (!checked.allowed) throw new HouseholdOwnerPermissionAborted();
    await writeConnection(tx, workspaceId, actor, action.connection, String(boundary!.purpose),
      String(rights!.content_consent_id), checked.expires_at, true);
  }
  const receipt = await notice(tx, workspaceId, actor, { kind: 'note', to: [{ kind: 'user', id: actor.user_id }],
    about: 'Lists permissions', body: `Owner chat confirmed Lists permissions: ${householdCanonical({ request_id: requestId,
      action, audit_context: args.audit_context ?? {}, principal_id: actor.principal_id })}` });
  if (receipt.status !== 'sent' || !receipt.signal_id) throw new HouseholdOwnerPermissionAborted();
  if (!await recheck(tx, actor)) throw new HouseholdOwnerPermissionAborted();
  if (action.kind === 'allow_connection' && !(await checkedConnection(tx, workspaceId, actor, action.connection)).allowed)
    throw new HouseholdOwnerPermissionAborted();
  const [live] = await tx`SELECT role FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid
    AND user_id=${actor.user_id}::uuid AND revoked_at IS NULL FOR SHARE`;
  if (live?.role !== 'owner') throw new HouseholdOwnerPermissionAborted();
  const response = { status: 'committed', request_id: requestId, action: action.kind,
    notice: { status: 'sent', signal_id: receipt.signal_id }, replayed: false };
  await tx`INSERT INTO swarm.household_owner_permission_receipts(workspace_id,actor_user,actor_key,actor_principal,request_id,request_digest,source,action,audit_context,response)
    VALUES (${workspaceId}::uuid,${actor.user_id}::uuid,${actor.principal_id ?? actor.user_id}::uuid,${actor.principal_id}::uuid,
      ${requestId},${digest},${tx.json(actor as unknown as postgres.JSONValue)},${tx.json(action)},
      ${tx.json((args.audit_context ?? {}) as postgres.JSONValue)},${tx.json(response)})`;
  return response;
}

/** Advice never invites a restricted source to approve itself. Actual authority
 * is rechecked by confirmOwnerHouseholdPermissions on the later command. */
export async function canOfferOwnerHouseholdSetup(tx: Sql, workspaceId: string, actor: HouseholdIdentity) {
  const [owner] = await tx`SELECT m.user_id FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
    WHERE m.workspace_id=${workspaceId}::uuid AND m.user_id=${actor.user_id}::uuid
      AND m.role='owner' AND m.revoked_at IS NULL AND w.archived_at IS NULL`;
  if (!owner) return false;
  if (actor.principal_id === null) return actor.connection === null && actor.run_id === null;
  if (!actor.connection) return false;
  const [principal] = await tx`SELECT principal_id FROM swarm.agent_principals
    WHERE workspace_id=${workspaceId}::uuid AND principal_id=${actor.principal_id}::uuid
      AND owner_user_id=${actor.user_id}::uuid AND revoked_at IS NULL`;
  if (!principal) return false;
  const [overrides] = await tx`SELECT EXISTS(SELECT 1 FROM swarm.household_content_connections
    WHERE workspace_id=${workspaceId}::uuid AND owner_user_id=${actor.user_id}::uuid
      AND (connection_id=${actor.connection.connection_id}::uuid OR hosted_grant_id=${actor.run_id === null ? actor.connection.grant_id : null}::uuid))
    OR EXISTS(SELECT 1 FROM swarm.household_hosted_content_restrictions
      WHERE workspace_id=${workspaceId}::uuid AND grant_id=${actor.run_id === null ? actor.connection.grant_id : null}::uuid) AS present`;
  return overrides?.present === false;
}
