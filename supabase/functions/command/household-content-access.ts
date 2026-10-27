/** Durable content facts shared by object, todo and queue paths. The caller
 * authenticates capabilities; this helper never accepts model identity claims.
 * Workspace -> boundary/member/role -> principal/connection -> grant/binding/seat
 * -> restriction. Inheritance never writes a consent or approval row. */
import type postgres from 'postgres';
import type { HouseholdIdentity } from './household-objects.ts';
import type { HouseholdAccessFacts, HouseholdContentOperation } from '../_shared/household-object-policy.d.ts';
type Sql = postgres.TransactionSql<Record<string, unknown>>;
/** Owned transient failure: callers retry without changing authentication. */
export class HouseholdContentServiceUpdating extends Error {
  static readonly body = Object.freeze({
    error: 'household_content_service_updating',
    message: 'Household content service is updating. Retry after one second with the same request_id.',
    retryable: true,
    retry_after_seconds: 1,
  });
  constructor() {
    super('Household content service is updating');
    this.name = 'HouseholdContentServiceUpdating';
  }
}

export async function assertHouseholdContentServiceReady(tx: Sql): Promise<void> {
  // Policy DDL requires AccessExclusiveLock. Hold this SELECT-authorized lock
  // through rollback/commit so catalog inspection cannot race gate installation.
  // Read the actual catalog on every call, including post-wait access rechecks.
  await tx`LOCK TABLE swarm.household_content_connections IN ACCESS SHARE MODE`;
  const [gate] = await tx`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='swarm' AND c.relname='household_content_connections'
      AND p.polname='hosted_owner_content_rollback_gate'
  ) AS present`;
  if (gate?.present) throw new HouseholdContentServiceUpdating();
}

const stamp = (v: unknown): number | null => v == null ? null : new Date(v as string).getTime();
const actor = (i: HouseholdIdentity) => ({ user_id: i.user_id, principal_id: i.principal_id, run_id: i.run_id });
export async function loadHouseholdContentAccess(tx: Sql, workspaceId: string, identity: HouseholdIdentity): Promise<{ facts: HouseholdAccessFacts; now: number; source: 'human' | 'inherited' | 'explicit'; restriction: { operations: string[]; origin: string; principal_id: string }[] } | null> {
  await assertHouseholdContentServiceReady(tx);
  const [workspace] = await tx`SELECT archived_at FROM swarm.workspaces WHERE workspace_id=${workspaceId}::uuid FOR UPDATE`;
  if (!workspace) return null;
  const [boundary] = await tx`SELECT purpose, owner_user_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspaceId}::uuid FOR SHARE`;
  const [member] = await tx`SELECT role, revoked_at FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
  const [rights] = await tx`SELECT * FROM swarm.household_member_content_roles WHERE workspace_id=${workspaceId}::uuid AND user_id=${identity.user_id}::uuid FOR SHARE`;
  if (!boundary) return null;
  let source: 'human' | 'inherited' | 'explicit' = identity.principal_id === null ? 'human' : 'explicit';
  let restriction: { operations: string[]; origin: string; principal_id: string }[] = [];
  let connectionPolicy: { connection_expires_at: unknown; connection_expired_at: unknown } | null = null;
  let credential: HouseholdAccessFacts['credential'] = { kind: 'human' };
  if (identity.principal_id !== null) {
    if (!identity.connection) return null;
    const [principal] = await tx`SELECT revoked_at FROM swarm.agent_principals WHERE (workspace_id=${workspaceId}::uuid AND transport='hosted_mcp' OR swarm.local_agent_workspace_live(principal_id,${workspaceId}::uuid)) AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
    if (!principal || principal.revoked_at !== null) return null;
    const [presented] = await tx`SELECT t.renewal_grant_id,t.lineage_id,t.run_id
      FROM swarm.agent_tokens t JOIN swarm.agent_runs run ON run.run_id=t.run_id AND run.principal_id=t.principal_id
      JOIN swarm.devices device USING(device_id)
      WHERE t.revoked_at IS NULL AND NOT t.surrender_only AND t.expires_at>clock_timestamp()
        AND run.ended_at IS NULL AND device.revoked_at IS NULL AND device.user_id=${identity.user_id}::uuid
        AND swarm.admin_child_live(t.parent_admin_grant_id,${workspaceId}::uuid)
        AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
        AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
          (('token',t.token_id),('principal',t.principal_id),('run',t.run_id),('device',device.device_id),
           ('renewal_grant',t.renewal_grant_id),('lineage',t.lineage_id),('family',t.lineage_id),('membership',${identity.user_id}::uuid)))
        AND t.token_id=${identity.connection.connection_id}::uuid
        AND t.principal_id=${identity.principal_id}::uuid AND t.run_id=${identity.connection.grant_id}::uuid`;
    const [localFamily] = presented?.renewal_grant_id ? await tx`SELECT g.* FROM swarm.renewal_grants g
      WHERE g.renewal_grant_id=${presented.renewal_grant_id}::uuid
        AND g.principal_id=${identity.principal_id}::uuid AND g.run_id=${identity.connection.grant_id}::uuid
        AND g.created_by=${identity.user_id}::uuid` : [];
    const [approval]=localFamily ? await tx`SELECT token_id FROM swarm.local_content_approval_workspaces
      WHERE renewal_grant_id=${localFamily.renewal_grant_id}::uuid AND workspace_id=${workspaceId}::uuid` : [];
    const latestAllow=approval?.token_id ?? (localFamily?.workspace_id===workspaceId ? localFamily.local_content_approval_token_id : null) ?? null;
    const connections = await tx`SELECT c.* FROM swarm.household_content_connections c
      WHERE c.workspace_id=${workspaceId}::uuid AND c.grant_id=${identity.connection.grant_id}::uuid
        AND c.principal_id=${identity.principal_id}::uuid AND c.owner_user_id=${identity.user_id}::uuid
        AND (c.connection_id=${identity.connection.connection_id}::uuid OR
          (c.hosted_grant_id IS NULL AND (to_jsonb(c)->>'renewal_grant_id')::uuid=${presented?.renewal_grant_id ?? null}::uuid
            AND EXISTS(SELECT 1 FROM swarm.agent_tokens original WHERE original.token_id=c.connection_id
              AND original.principal_id=c.principal_id AND original.run_id=c.grant_id
              AND original.renewal_grant_id=(to_jsonb(c)->>'renewal_grant_id')::uuid AND original.lineage_id=${presented?.lineage_id ?? null}::uuid)))
      ORDER BY c.connection_id,c.grant_id,c.workspace_id,c.principal_id FOR SHARE OF c`;
    const connection = latestAllow===null
      ? connections.find(c=>c.connection_id===identity.connection!.connection_id) ?? connections[0]
      : connections.find(c=>c.connection_id===latestAllow);
    const [canonicalSeat] = await tx`SELECT seat_id,grant_id,owner_user_id FROM swarm.hosted_mcp_seats
      WHERE seat_id=${identity.connection.connection_id}::uuid AND grant_id=${identity.connection.grant_id}::uuid
        AND workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid AND owner_user_id=${identity.user_id}::uuid`;
    const inherited = canonicalSeat && member?.role === 'owner';
    if (inherited && !connection) source = 'inherited';
    if (!connection && !inherited) return null;
    if (canonicalSeat && (inherited || connection)) {
      const legacy = await tx`SELECT c.*, (EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=c.grant_id
          AND cs.workspace_id=c.workspace_id AND cs.principal_id=c.principal_id AND cs.owner_user_id=c.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=c.grant_id AND ls.workspace_id=c.workspace_id
            AND ls.principal_id=c.principal_id AND ls.owner_user_id=c.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)) AND EXISTS(SELECT 1 FROM swarm.household_hosted_content_restrictions marker
          CROSS JOIN LATERAL jsonb_array_elements(marker.closed_target_replacements) entry
          WHERE marker.grant_id=c.grant_id AND marker.workspace_id=c.workspace_id
            AND marker.origin='human_allow' AND (
              entry=jsonb_build_object('kind','legacy','row',to_jsonb(c))
              OR (jsonb_typeof(entry->'row')='object' AND NOT (entry->'row' ? 'renewal_grant_id')
                AND to_jsonb(c)->'renewal_grant_id'='null'::jsonb
                AND entry=jsonb_build_object('kind','legacy','row',to_jsonb(c)-'renewal_grant_id'))
            )) AS closed_replaced FROM swarm.household_content_connections c
        WHERE c.workspace_id=${workspaceId}::uuid AND c.hosted_grant_id=${canonicalSeat.grant_id}::uuid
        ORDER BY c.connection_id,c.principal_id FOR SHARE OF c`;
      const [grant] = await tx`SELECT state,revoked_at,connection_expires_at,connection_expired_at FROM swarm.hosted_mcp_grants WHERE grant_id=${canonicalSeat.grant_id}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      const [binding] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=${canonicalSeat.grant_id}::uuid AND workspace_id=${workspaceId}::uuid AND owner_user_id=${identity.user_id}::uuid FOR SHARE`;
      const [seat] = await tx`SELECT revoked_at FROM swarm.hosted_mcp_seats WHERE seat_id=${canonicalSeat.seat_id}::uuid FOR SHARE`;
      if (!grant || grant.state !== 'active' || grant.revoked_at !== null || !binding || binding.revoked_at !== null || !seat || seat.revoked_at !== null) return null;
      connectionPolicy = { connection_expires_at: grant.connection_expires_at, connection_expired_at: grant.connection_expired_at };
      const policies = await tx`SELECT r.*, (EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=r.grant_id
          AND cs.workspace_id=r.workspace_id AND cs.principal_id=r.principal_id AND cs.owner_user_id=r.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=r.grant_id AND ls.workspace_id=r.workspace_id
            AND ls.principal_id=r.principal_id AND ls.owner_user_id=r.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)) AND EXISTS(SELECT 1 FROM swarm.household_hosted_content_restrictions marker
          CROSS JOIN LATERAL jsonb_array_elements(marker.closed_target_replacements) entry
          WHERE marker.grant_id=r.grant_id AND marker.workspace_id=r.workspace_id
            AND marker.origin='human_allow' AND entry=jsonb_build_object('kind','restriction','principal_id',r.principal_id,'operations',r.operations,'origin',r.origin,'changed_at',r.changed_at,'changed_by',r.changed_by)) AS closed_replaced
        FROM swarm.household_hosted_content_restrictions r
        WHERE r.grant_id=${canonicalSeat.grant_id}::uuid AND r.workspace_id=${workspaceId}::uuid
        ORDER BY r.principal_id FOR SHARE OF r`;
      let operations: HouseholdContentOperation[] = rights?.content_role === 'editor' ? ['read','create','update'] : ['read'];
      // Every row records one truthful human/system target. Their intersection
      // is grant/workspace-wide, including after the owner's role is lowered.
      const activePolicies = policies.filter(policy => !policy.closed_replaced);
      restriction = activePolicies.map(policy => ({ operations: policy.operations as string[],
        origin: String(policy.origin), principal_id: String(policy.principal_id) }));
      for (const policy of activePolicies) operations = operations.filter(op => (policy.operations as string[]).includes(op));
      // A marker replaces only an exact CLOSED row version. Live sibling
      // operation ceilings, expiries and withdrawals always remain in force.
      const [clock] = await tx`SELECT clock_timestamp() AS now`;
      for (const row of inherited || policies.length > 0 ? legacy : connection ? [connection] : []) {
        if (row.closed_replaced) continue;
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
      if (!presented || !connection || connection.hosted_grant_id !== null) return null;
      if (latestAllow!==null && (!localFamily || connection.renewal_grant_id!==presented.renewal_grant_id
        || connection.consent_receipt_id!==rights?.content_consent_id)) return null;
      // Only the canonical nullable linkage opts a local approval into family
      // policy. Legacy technical horizons never become owner-selected expiry.
      // Read existing role-visible fields without adding a late family lock.
      if (connection.renewal_grant_id != null) {
        const [family] = await tx`SELECT revoked_at,connection_expires_at,connection_expired_at
          FROM swarm.renewal_grants WHERE renewal_grant_id=${connection.renewal_grant_id}::uuid
            AND workspace_id=${workspaceId}::uuid AND principal_id=${identity.principal_id}::uuid
            AND run_id=${connection.grant_id}::uuid AND created_by=${identity.user_id}::uuid`;
        if (!family || family.revoked_at !== null) return null;
        connectionPolicy = { connection_expires_at: family.connection_expires_at, connection_expired_at: family.connection_expired_at };
      }
      // NULL legacy keeps every earlier ceiling. Only a deliberate validated
      // Allow selects a new decision; bearer rotation never advances the pointer.
      const [localClock] = await tx`SELECT clock_timestamp() AS now`;
      const localNow=stamp(localClock!.now)!;
      let operations=connection.operations as HouseholdContentOperation[];
      for (const row of latestAllow===null ? connections : [connection]) {
        if (row.hosted_grant_id !== null || row.purpose!==boundary.purpose || row.revoked_at!==null
          || row.expires_at!==null && stamp(row.expires_at)!<=localNow) return null;
        operations=operations.filter(op=>(row.operations as string[]).includes(op));
      }
      credential = { kind: 'agent', connection: {
        connection_id: identity.connection.connection_id, grant_id: String(connection.grant_id), workspace_id: workspaceId,
        principal_id: identity.principal_id, owner_user_id: identity.user_id,
        operations, purpose: connection.purpose as 'personal' | 'shared',
        revoked_at: stamp(connection.revoked_at), expires_at: stamp(connection.expires_at),
      } };
    }
  } else if (identity.connection !== null || identity.run_id !== null) return null;
  const [clock] = await tx`SELECT clock_timestamp() AS now`;
  const now = stamp(clock!.now)!;
  // Every caller, including queue and management summaries, receives policy
  // evaluated after the existing row waits. NULL is permanent; terminal stays
  // terminal even when no date is selected.
  if (connectionPolicy && (connectionPolicy.connection_expired_at !== null
    || (connectionPolicy.connection_expires_at !== null && stamp(connectionPolicy.connection_expires_at)! <= now))) return null;
  return { now, source, restriction, facts: {
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
  await assertHouseholdContentServiceReady(tx);
  const [member] = await tx`SELECT role FROM swarm.memberships WHERE workspace_id=${workspaceId}::uuid
    AND user_id=${owner}::uuid AND revoked_at IS NULL FOR SHARE`;
  const [existing] = await tx`SELECT grant_id FROM swarm.household_hosted_content_restrictions
    WHERE grant_id=${grant}::uuid AND workspace_id=${workspaceId}::uuid AND principal_id=${principal}::uuid FOR UPDATE`;
  if (!existing && member?.role !== 'owner') return;
  // Only explicit current-owner Allow captures exact retired target versions.
  // The trigger recomputes and validates this complete, bounded snapshot set.
  const [replacement] = origin === 'human_allow' && member?.role === 'owner'
    ? await tx`SELECT coalesce(jsonb_agg(snapshot ORDER BY snapshot::text),'[]'::jsonb) AS snapshots FROM (
      SELECT jsonb_build_object('kind','restriction','principal_id',r.principal_id,'operations',r.operations,'origin',r.origin,'changed_at',r.changed_at,'changed_by',r.changed_by) AS snapshot FROM swarm.household_hosted_content_restrictions r
        WHERE r.grant_id=${grant}::uuid AND r.workspace_id=${workspaceId}::uuid AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=r.grant_id
          AND cs.workspace_id=r.workspace_id AND cs.principal_id=r.principal_id AND cs.owner_user_id=r.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=r.grant_id AND ls.workspace_id=r.workspace_id
            AND ls.principal_id=r.principal_id AND ls.owner_user_id=r.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      UNION ALL
      SELECT jsonb_build_object('kind','legacy','row',to_jsonb(c)) AS snapshot FROM swarm.household_content_connections c
        WHERE c.hosted_grant_id=${grant}::uuid AND c.workspace_id=${workspaceId}::uuid AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats cs WHERE cs.grant_id=c.grant_id
          AND cs.workspace_id=c.workspace_id AND cs.principal_id=c.principal_id AND cs.owner_user_id=c.owner_user_id)
        AND NOT EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats ls JOIN swarm.agent_principals lp USING(principal_id)
          WHERE ls.grant_id=c.grant_id AND ls.workspace_id=c.workspace_id
            AND ls.principal_id=c.principal_id AND ls.owner_user_id=c.owner_user_id
            AND ls.revoked_at IS NULL AND lp.revoked_at IS NULL)
      LIMIT 257
    ) targets` : [];
  const replacements = (replacement?.snapshots ?? []) as postgres.JSONValue;
  if (existing) await tx`UPDATE swarm.household_hosted_content_restrictions
    SET operations=${[...operations]}::text[],origin=${origin},closed_target_replacements=${tx.json(replacements)}
    WHERE grant_id=${grant}::uuid AND workspace_id=${workspaceId}::uuid AND principal_id=${principal}::uuid`;
  else await tx`INSERT INTO swarm.household_hosted_content_restrictions(grant_id,workspace_id,owner_user_id,principal_id,operations,origin,closed_target_replacements)
    VALUES (${grant}::uuid,${workspaceId}::uuid,${owner}::uuid,${principal}::uuid,${[...operations]}::text[],${origin},${tx.json(replacements)})`;
}
