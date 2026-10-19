/** Durable content facts shared by object, todo and queue paths. The caller
 * authenticates capabilities; this helper never accepts model identity claims.
 * Workspace -> boundary/member/role -> principal/connection -> grant/binding/seat
 * -> restriction. Inheritance never writes a consent or approval row. */
import type postgres from 'postgres';
import type { HouseholdIdentity } from './household-objects.ts';
import type { HouseholdAccessFacts, HouseholdContentOperation } from '../_shared/household-object-policy.d.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
const stamp = (v: unknown): number | null => v == null ? null : new Date(v as string).getTime();
const actor = (i: HouseholdIdentity) => ({ user_id: i.user_id, principal_id: i.principal_id, run_id: i.run_id });
export async function loadHouseholdContentAccess(tx: Sql, workspaceId: string, identity: HouseholdIdentity): Promise<{ facts: HouseholdAccessFacts; now: number; source: 'human' | 'inherited' | 'explicit'; restriction: { operations: string[]; origin: string; principal_id: string }[] } | null> {
  const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  if (!workspace) return null;
  const [boundary] = await tx`SELECT purpose, owner_user_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  const [member] = await tx`SELECT role, revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
  const [rights] = await tx`SELECT * FROM swarm.household_member_content_roles WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
  if (!boundary) return null;
  let source: 'human' | 'inherited' | 'explicit' = identity.principal_id === null ? 'human' : 'explicit';
  let restriction: { operations: string[]; origin: string; principal_id: string }[] = [];
  let credential: HouseholdAccessFacts['credential'] = { kind: 'human' };
  if (identity.principal_id !== null) {
    if (!identity.connection) return null;
    const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
    if (!principal || principal.revoked_at !== null) return null;
    const [connection] = await tx`SELECT * FROM swarm.household_content_connections WHERE workspace_id=${workspaceId}::uuid
      AND connection_id=${identity.connection.connection_id}::uuid AND grant_id=${identity.connection.grant_id}::uuid
      AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
    const [canonicalSeat] = await tx`SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats
      WHERE seat_id=${identity.connection.connection_id}::uuid AND grant_id=${identity.connection.grant_id}::uuid
        AND workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid`;
    const inherited = canonicalSeat && member?.role === 'owner';
    if (inherited && !connection) source = 'inherited';
    if (!connection && !inherited) return null;
    if (canonicalSeat && (inherited || connection)) {
      const legacy = await tx`SELECT c.* FROM swarm.household_content_connections c
        WHERE c.workspace_id=${workspaceId}::uuid AND c.hosted_grant_id=${canonicalSeat.grant_id}::uuid
        ORDER BY c.connection_id,c.principal_id FOR SHARE OF c`;
      const [grant] = await tx`SELECT state,revoked_at FROM swarm.hosted_mcp_grants WHERE grant_id=${canonicalSeat.grant_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      const [binding] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=${canonicalSeat.grant_id}::uuid AND workspace_id=${workspaceId}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      const [seat] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_seats WHERE seat_id=${canonicalSeat.seat_id}::uuid FOR SHARE`;
      if (!grant || grant.state !== 'active' || grant.revoked_at !== null || !binding || binding.revoked_at !== null || !seat || seat.revoked_at !== null) return null;
      const policies = await tx`SELECT * FROM swarm.household_hosted_content_restrictions
        WHERE grant_id=${canonicalSeat.grant_id}::uuid AND workspace_id=${workspaceId}::uuid
        ORDER BY principal_id FOR SHARE`;
      let operations: HouseholdContentOperation[] = rights?.content_role === 'editor' ? ['read','create','update'] : ['read'];
      // Every row records one truthful human/system target. Their intersection
      // is grant/workspace-wide, including after the owner's role is lowered.
      restriction = policies.map(policy => ({ operations: policy.operations as string[],
        origin: String(policy.origin), principal_id: String(policy.principal_id) }));
      for (const policy of policies) operations = operations.filter(op => (policy.operations as string[]).includes(op));
      // Human Allow updates only its actual legacy seat row. No blanket marker
      // may discard another seat's operation ceiling, expiry or withdrawal.
      const [clock] = await tx`SELECT clock_timestamp() AS now`;
      for (const row of inherited || policies.length > 0 ? legacy : connection ? [connection] : []) {
        const denied = row.revoked_at !== null || (row.expires_at !== null && stamp(row.expires_at)! <= stamp(clock!.now)!) || row.purpose !== boundary.purpose;
        const ceiling = denied ? [] : row.operations as string[];
        if (denied || operations.some(op => !ceiling.includes(op))) restriction.push({
          operations: ceiling, origin: 'legacy_approval', principal_id: String(row.principal_id) });
        operations = operations.filter(op => ceiling.includes(op));
      }
      if (!inherited && !connection) return null;
      // Non-owners still require their exact live manual approval.
      if (!inherited && connection) {
        if (connection.revoked_at !== null || (connection.expires_at !== null && stamp(connection.expires_at)! <= stamp(clock!.now)!)) return null;
        operations = operations.filter(op => (connection.operations as string[]).includes(op));
      }
      credential = { kind: 'agent', connection: { ...identity.connection, workspace_id: workspaceId,
        principal_id: identity.principal_id, owner_user_id: identity.user_id, operations,
        purpose: boundary.purpose as 'personal' | 'shared', revoked_at: null, expires_at: null } };
    } else {
      if (!connection || connection.hosted_grant_id !== null) return null;
      credential = { kind: 'agent', connection: {
        connection_id: String(connection.connection_id), grant_id: String(connection.grant_id), workspace_id: workspaceId,
        principal_id: identity.principal_id, owner_user_id: identity.user_id,
        operations: connection.operations as HouseholdContentOperation[], purpose: connection.purpose as 'personal' | 'shared',
        revoked_at: stamp(connection.revoked_at), expires_at: stamp(connection.expires_at),
      } };
    }
  } else if (identity.connection !== null || identity.run_id !== null) return null;
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  return { now: stamp(clock!.now)!, source, restriction, facts: {
    workspace_id: workspaceId, archived_at: stamp(workspace.archived_at), actor: actor(identity), credential,
    boundary: boundary.purpose === 'personal' ? { kind: 'personal', owner_user_id: String(boundary.owner_user_id) } : { kind: 'shared' },
    member: member ? { user_id: identity.user_id, workspace_id: workspaceId,
      revoked_at: stamp(member.revoked_at) ?? stamp(rights?.revoked_at),
      content_role: rights?.content_role as 'reader' | 'editor' | null ?? null,
      content_consent_id: rights?.content_consent_id as string | null ?? null } : null,
  } };
}

/** Call only after authenticated human checks and audit context, under workspace
 * lock. Explicit update avoids double BEFORE-trigger audits on an upsert. */
export async function writeHostedContentRestriction(tx: Sql, workspaceId: string, owner: string,
  grant: string, principal: string, operations: readonly string[], origin: 'human_allow' | 'human_withdraw' | 'system_invalidation') {
  const [member] = await tx`SELECT role FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid
    AND user_id=${owner}::uuid AND revoked_at IS NULL FOR SHARE`;
  const [existing] = await tx`SELECT grant_id FROM swarm.household_hosted_content_restrictions
    WHERE grant_id=${grant}::uuid AND workspace_id=${workspaceId}::uuid AND principal_id=${principal}::uuid FOR UPDATE`;
  if (!existing && member?.role !== 'owner') return;
  if (existing) await tx`UPDATE swarm.household_hosted_content_restrictions
    SET operations=${[...operations]}::text[],origin=${origin}
    WHERE grant_id=${grant}::uuid AND workspace_id=${workspaceId}::uuid AND principal_id=${principal}::uuid`;
  else await tx`INSERT INTO swarm.household_hosted_content_restrictions(grant_id,workspace_id,owner_user_id,principal_id,operations,origin)
    VALUES (${grant}::uuid,${workspaceId}::uuid,${owner}::uuid,${principal}::uuid,${[...operations]}::text[],${origin})`;
}
