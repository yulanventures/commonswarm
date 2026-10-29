import type postgres from "npm:postgres@3.4.9";

type Sql = postgres.TransactionSql<Record<string, unknown>>;

export interface AgentAuthRow {
  token_id: string;
  principal_id: string;
  run_id: string;
  device_id: string;
  owner_user_id: string;
  principal_workspace_id: string;
  lineage_id: string;
  scopes: unknown;
  surrender_only: boolean;
  token_revoked_at: Date | null;
  principal_revoked_at: Date | null;
  run_ended_at: Date | null;
  device_revoked_at: Date | null;
  unexpired: boolean;
  managed_at: Date | null;
  transport: "local" | "hosted_mcp";
}

/**
 * Resolves the presented agent credential AND records that it has been used, in
 * every edge function that authenticates one — §2.3 first-use supersession.
 *
 * ★ THE STAMP LIVES HERE, NOT IN THE COMMAND FUNCTION, AND THAT PLACEMENT IS THE
 * WHOLE CORRECTNESS ARGUMENT. `first_used_at IS NULL` ("PENDING") is what makes a
 * successor DISPOSABLE: a renewal that finds a pending successor revokes it and
 * issues a fresh one, on the reasoning that a token nobody has ever used is a
 * token nobody received. That reasoning is only sound if EVERY authentication
 * path stamps. An earlier version stamped only in the command function, so an
 * agent doing what agents actually do between commands — polling `read` for
 * signals — authenticated successfully over and over while its credential stayed
 * PENDING for ever. Any later renewal from the still-live predecessor would then
 * revoke a credential that was in active use, permanently and with a tombstone,
 * and the agent's next command would 401 with no reason naming the discard.
 * "Pending" has to mean "unused", and `read` is a use.
 *
 * TWO STATEMENTS, NOT ONE, AND NOT AN ACCIDENT. The stamping UPDATE takes a row
 * lock, so a concurrent discard of the same token makes this block. Under READ
 * COMMITTED a statement's snapshot is taken before it waits: the UPDATE
 * re-evaluates the row after the lock clears (so it correctly declines to stamp a
 * token revoked while we waited), but any SELECT in the SAME statement would
 * still report that row as it looked BEFORE the wait — i.e. not revoked. Folded
 * into one statement, this function would hand back a credential whose revocation
 * had already committed. The liveness read is therefore its own statement, taken
 * on a fresh snapshot after the lock is released. It costs one round trip on the
 * agent auth path and it is the difference between reading state and reading the
 * past.
 */
export class LocalCredentialDenied extends Error {
  constructor(readonly credentialInvalid: boolean = false) { super('Local credential is no longer authorized'); }
}
/** Named route-policy denial; callers may preserve an operation's external class. */
export class LocalCredentialWorkspaceMismatch extends LocalCredentialDenied {}
export async function loadAgentCredential(
  tx: Sql, tokenHash: Uint8Array, expected: LocalAuthLockPlan,
  allowExpiredRenewal = false,
): Promise<(AgentAuthRow & { first_use: boolean }) | null> {
  if (!expected.locked) throw new LocalAuthDiscoveryChanged();
  if (snapshotKey(await expected.rediscover()) !== snapshotKey(expected.snapshot)) throw new LocalAuthDiscoveryChanged();
  const exact = await discoverLocalCredential(tx, tokenHash);
  if (!exact || !expected.snapshot.bindings.some(r=>r.token_id===exact.token_id)) throw new LocalAuthDiscoveryChanged();
  const agent = await lockedCredentialFacts(tx,tokenHash,exact,allowExpiredRenewal,true,expected.connectionOnly===true);
  if (agent && !expected.connectionOnly && expected.targetWorkspace) {
    if (!await localCredentialTargetLive(tx,agent,expected.targetWorkspace)) throw new LocalCredentialDenied();
    agent.principal_workspace_id=expected.targetWorkspace;
  }
  return agent;
}

/** Final proof after owned content writes. Missing stream rows are protected by
 * the already-held workspace UPDATE lock. Supported content stores may create
 * them in this transaction; no existing stream may disappear or rebind, and
 * no new external binding/parent/session/family/token is adopted here.
 */
export async function recheckLocalCredential(tx:Sql,hash:Uint8Array,plan:LocalAuthLockPlan,allowExpiredRenewal=false):Promise<AgentAuthRow|null> {
  if(!plan.locked) throw new LocalAuthDiscoveryChanged();
  const current=await plan.rediscover();
  const initial=plan.snapshot;
  for(const key of ['objectStreams','todoStreams'] as const) {
    const oldRows=initial[key] ?? [],newRows=current[key] ?? [];
    if(oldRows.some(row=>!newRows.some(r=>r.workspace===row.workspace && r.stream===row.stream))
      || newRows.some(row=>!oldRows.some(r=>r.workspace===row.workspace && r.stream===row.stream)
        && !plan.workspaces.some(w=>w.id===row.workspace && w.mode==='update'))) throw new LocalAuthDiscoveryChanged();
  }
  if((current.todoBindings ?? []).some(t=>[t.assignee_principal,t.offer_principal].some(id=>
      id!==null && !initial.bindings.some(b=>b.principal_id===id)))) throw new LocalAuthDiscoveryChanged();
  if(snapshotKey({...current,objectStreams:initial.objectStreams,todoStreams:initial.todoStreams,todoBindings:initial.todoBindings})!==snapshotKey(initial)) throw new LocalAuthDiscoveryChanged();
  const exact=await discoverLocalCredential(tx,hash);
  if(!exact || !initial.bindings.some(r=>r.token_id===exact.token_id)) throw new LocalAuthDiscoveryChanged();
  const agent = await lockedCredentialFacts(tx,hash,exact,allowExpiredRenewal,false,plan.connectionOnly===true);
  if (agent && !plan.connectionOnly && plan.targetWorkspace) {
    if (!await localCredentialTargetLive(tx,agent,plan.targetWorkspace)) throw new LocalCredentialDenied();
    agent.principal_workspace_id=plan.targetWorkspace;
  }
  return agent;
}
async function lockedCredentialFacts(tx:Sql,tokenHash:Uint8Array,exact:LocalCredentialIds,
  allowExpiredRenewal:boolean,stampUse:boolean,connectionOnly=false):Promise<(AgentAuthRow & {first_use:boolean})|null> {
  // All waits precede this statement. Family policy, unlike a bearer deadline,
  // is terminal. Expired proof is admitted only for silent renewal; an unused
  // predecessorless root additionally needs the exact permanent family below.
  const rows = await tx<(AgentAuthRow & { first_use:boolean; eligible_renewal:boolean })[]>`
    SELECT t.token_id,t.principal_id,t.run_id,r.device_id,p.owner_user_id,
      p.workspace_id AS principal_workspace_id,t.lineage_id,t.scopes,t.surrender_only,
      t.revoked_at AS token_revoked_at,p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,d.revoked_at AS device_revoked_at,
      t.expires_at>clock_timestamp() AS unexpired,p.managed_at,p.transport,
      t.first_used_at IS NULL AS first_use,
      (g.kind='standing' AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
        AND g.connection_expired_at IS NULL AND g.revoked_at IS NULL AND NOT g.suspension_active
        AND (t.first_used_at IS NOT NULL
          OR (t.first_used_at IS NULL AND t.predecessor_token_id IS NULL
            AND g.horizon_expires_at IS NULL AND g.max_successors IS NULL)
          OR EXISTS(SELECT 1 FROM swarm.agent_tokens predecessor
          WHERE predecessor.token_id=t.predecessor_token_id AND predecessor.first_used_at IS NOT NULL
            AND predecessor.revoked_at IS NULL AND NOT predecessor.surrender_only
            AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z
              WHERE z.kind='token' AND z.target_id=predecessor.token_id)
            AND ROW(predecessor.principal_id,predecessor.run_id,predecessor.renewal_grant_id,predecessor.lineage_id,predecessor.parent_admin_grant_id)
              IS NOT DISTINCT FROM ROW(t.principal_id,t.run_id,t.renewal_grant_id,t.lineage_id,t.parent_admin_grant_id)))
        AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=t.token_id
          AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)) AS eligible_renewal
    FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
    JOIN swarm.devices d ON d.device_id=r.device_id
    LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
    WHERE t.token_hash=${tokenHash} AND p.transport='local' AND NOT p.turn_only
      AND t.revoked_at IS NULL AND p.revoked_at IS NULL AND r.ended_at IS NULL AND d.revoked_at IS NULL
      AND d.user_id=p.owner_user_id AND NOT t.surrender_only
      AND swarm.local_parent_connection_live(t.parent_admin_grant_id)
      AND swarm.local_parent_connection_live(p.parent_admin_grant_id)
      AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
      AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,t.scopes)
      AND (t.first_used_at IS NOT NULL OR t.predecessor_token_id IS NOT NULL
        OR EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships am
          WHERE am.principal_id=p.principal_id
            AND swarm.local_agent_workspace_live(p.principal_id,am.workspace_id)
            AND swarm.admin_child_live(t.parent_admin_grant_id,am.workspace_id)
            AND swarm.admin_child_live(p.parent_admin_grant_id,am.workspace_id)))
      AND (g.renewal_grant_id IS NULL OR (g.revoked_at IS NULL AND NOT g.suspension_active AND g.connection_expired_at IS NULL
        AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
        AND ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)=ROW(t.principal_id,t.run_id,p.workspace_id,p.owner_user_id)
        AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id)))
      AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
        (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
         ('membership',p.owner_user_id),('lineage',t.lineage_id),('family',t.lineage_id),('renewal_grant',t.renewal_grant_id)))`;
  const agent=rows[0];
  if(!agent) {
    const known=await tx<{credential_invalid:boolean}[]>`SELECT
      (t.revoked_at IS NOT NULL OR t.surrender_only OR g.revoked_at IS NOT NULL OR g.suspension_active
        OR g.connection_expired_at IS NOT NULL OR g.connection_expires_at<=clock_timestamp()) IS TRUE AS credential_invalid
      FROM swarm.agent_tokens t LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
      WHERE t.token_hash=${tokenHash}`;
    if(known.length) throw new LocalCredentialDenied(known[0]!.credential_invalid);
    return null;
  }
  if (!agent.unexpired && !(allowExpiredRenewal && agent.eligible_renewal)) return null;
  const recoverPending = allowExpiredRenewal && !agent.unexpired && agent.eligible_renewal && agent.first_use;
  if (stampUse && (agent.unexpired || recoverPending) && agent.first_use) {
    const [clock]=await tx<{now:Date}[]>`SELECT clock_timestamp() AS now`;
    const stamped=await tx`UPDATE swarm.agent_tokens SET first_used_at=${clock!.now}
      WHERE token_id=${agent.token_id}::uuid AND first_used_at IS NULL
        AND revoked_at IS NULL AND (expires_at>${clock!.now} OR ${recoverPending}) RETURNING token_id`;
    if (!stamped.length) return null;
    await tx`UPDATE swarm.agent_tokens SET expires_at=${clock!.now}
      WHERE token_id=${exact.predecessor_token_id}::uuid AND revoked_at IS NULL AND expires_at>${clock!.now}`;
  }
  // A saved pending successor or eligible unused permanent root proves actual
  // possession here. Command commits this use only after validation and final
  // authorization, then retries issuance in a fresh transaction.
  return agent;
}

export async function agentCredentialRevoked(
  tx: Sql,
  agent: AgentAuthRow,
  membershipRevokedAt: Date | null,
): Promise<boolean> {
  if (
    membershipRevokedAt !== null ||
    agent.token_revoked_at !== null ||
    agent.principal_revoked_at !== null ||
    agent.run_ended_at !== null ||
    agent.device_revoked_at !== null ||
    agent.surrender_only
  ) {
    return true;
  }

  const targets: Array<[string, string]> = [
    ["token", agent.token_id],
    ["principal", agent.principal_id],
    ["run", agent.run_id],
    ["device", agent.device_id],
    ["membership", agent.owner_user_id],
    ["lineage", agent.lineage_id],
    ["family", agent.lineage_id],
  ];
  const ids = [...new Set(targets.map(([, id]) => id))];
  const rows = await tx<{ kind: string; target_id: string }[]>`
    SELECT kind, target_id
    FROM swarm.revocation_tombstones
    WHERE target_id = ANY(${ids}::uuid[])
  `;
  const expected = new Set(targets.map(([kind, id]) => `${kind}:${id}`));
  return rows.some((row) => expected.has(`${row.kind}:${row.target_id}`));
}

import {
  agentSessionErrorStatus,
  type AgentSessionErrorCode,
  type AgentSessionProof,
  type AgentSessionProofParse,
} from "../../../src/cloud/session-wire.ts";

export type { AgentSessionProof };

export async function hashSessionKey(key: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
  );
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i]! ^ right[i]!;
  }
  return diff === 0;
}

function asBytes(value: Uint8Array | ArrayBuffer | string): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return null;
}

export type AgentSessionFenceResult =
  | { ok: true }
  | { ok: false; error: AgentSessionErrorCode; status: number };

function refuse(error: AgentSessionErrorCode): AgentSessionFenceResult {
  return { ok: false, error, status: agentSessionErrorStatus(error) };
}

/**
 * Session-proof fence for an agent-authenticated mutation.
 *
 * Callers skip this for kinds in AGENT_SESSION_PROOF_EXEMPT_KINDS.
 * managed_at and the session row are read FOR SHARE in this transaction so
 * recover/enable/disable/acquire (FOR UPDATE on those rows) cannot commit
 * between the check and the write. Callers may still pass managedAt; it is
 * not used to skip the lock. PostgreSQL refuses FOR SHARE on the nullable
 * side of a LEFT JOIN, so the two reads are separate statements.
 */
export async function enforceAgentSessionProof(
  tx: Sql,
  args: {
    principalId: string;
    workspaceId: string;
    proofParse: AgentSessionProofParse;
    managedAt?: Date | string | null;
    connectionOnly?: boolean;
    recheckOnly?: boolean;
  },
): Promise<AgentSessionFenceResult> {
  const principals = await tx<{
    managed_at: Date | string | null;
    transport: "local" | "hosted_mcp";
    turn_only: boolean;
  }[]>`
    SELECT managed_at, transport, turn_only
    FROM swarm.agent_principals
    WHERE principal_id = ${args.principalId}::uuid
    FOR SHARE
  `;
  const principal = principals[0];
  if (principal === undefined) {
    return refuse("session_proof_invalid");
  }
  if (principal.transport !== "local" || principal.turn_only) {
    return refuse("session_proof_invalid");
  }
  if (principal.managed_at === null) {
    return { ok: true };
  }

  const parsedProof = args.proofParse.ok ? args.proofParse.proof : null;
  const existing = await tx<{ key_hash: Uint8Array | ArrayBuffer | string | null; generation: string | number | bigint; live: boolean; retired: boolean }[]>`SELECT key_hash, generation,
    (expired_at IS NOT NULL AND expired_at > clock_timestamp()) AS live,
    EXISTS(SELECT 1 FROM swarm.retired_agent_sessions r WHERE r.principal_id=agent_execution_sessions.principal_id AND r.session_id=${parsedProof ? parsedProof.session_id : null}::uuid) AS retired
    FROM swarm.agent_execution_sessions WHERE principal_id=${args.principalId}::uuid AND (workspace_id=${args.workspaceId}::uuid OR ${args.connectionOnly===true}) ORDER BY workspace_id FOR SHARE`;
  if (!args.connectionOnly && !args.recheckOnly && parsedProof && existing.some((r) => (r.key_hash === null || !r.live) && !r.retired && Number(r.generation) <= parsedProof.generation)) {
    await tx`SELECT swarm.activate_local_workspace_session(${args.principalId}::uuid,${args.workspaceId}::uuid,
      ${parsedProof.session_id}::uuid,${parsedProof.generation},${await hashSessionKey(parsedProof.key)})`;
  }
  const rows = await tx<{
    session_id: string;
    generation: string | number | bigint;
    key_hash: Uint8Array | ArrayBuffer | string | null;
    live: boolean;
  }[]>`
    SELECT
      session_id,
      generation,
      key_hash,
      ((expired_at IS NOT NULL AND expired_at > clock_timestamp()) OR (connection_proof AND key_hash IS NOT NULL)) AS live
    FROM (SELECT session_id,generation,key_hash,expired_at,workspace_id,principal_id,false AS connection_proof FROM swarm.agent_execution_sessions
      UNION ALL SELECT session_id,generation,key_hash,expired_at,${args.workspaceId}::uuid,principal_id,true FROM swarm.agent_connection_sessions
        WHERE ${args.connectionOnly===true} AND NOT EXISTS(SELECT 1 FROM swarm.retired_agent_sessions r WHERE r.principal_id=agent_connection_sessions.principal_id AND r.session_id=agent_connection_sessions.session_id)) proof
    WHERE principal_id = ${args.principalId}::uuid
      AND (workspace_id = ${args.workspaceId}::uuid OR ${args.connectionOnly===true})
      AND (${args.connectionOnly!==true} OR session_id=${args.proofParse.ok ? args.proofParse.proof.session_id : null}::uuid)
    ORDER BY expired_at DESC NULLS LAST LIMIT 1
  `;
  const session = rows[0];
  if (!args.proofParse.ok) {
    return refuse(args.proofParse.error);
  }
  if (session === undefined) {
    return refuse("session_proof_invalid");
  }
  if (!session.live) {
    return refuse("session_expired");
  }
  const proof = args.proofParse.proof;
  if (proof.session_id !== session.session_id) {
    return refuse("session_conflict");
  }
  if (Number(session.generation) !== proof.generation) {
    return refuse("session_conflict");
  }
  const stored = asBytes(session.key_hash ?? new Uint8Array());
  if (stored === null || stored.length === 0) {
    return refuse("session_proof_invalid");
  }
  const presented = await hashSessionKey(proof.key);
  if (!bytesEqual(stored, presented)) {
    return refuse("session_proof_invalid");
  }
  return { ok: true };
}

/** @deprecated use enforceAgentSessionProof; kept for the item-4 seam. */
export async function authenticateAgentSession(
  tx: Sql,
  principalId: string,
  workspaceId: string,
  proof: AgentSessionProof | null,
  _isAcquire: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const proofParse: AgentSessionProofParse = proof === null
    ? { ok: false, error: "session_proof_missing" }
    : { ok: true, proof };
  const result = await enforceAgentSessionProof(tx, {
    principalId,
    workspaceId,
    proofParse,
  });
  if (result.ok) return { ok: true };
  return { ok: false, error: result.error };
}

/** IDs only. Discovery is not authorization and must never reach public output. */
export interface LocalCredentialIds {
  token_id: string | null;
  predecessor_token_id: string | null;
  renewal_grant_id: string | null;
  principal_id: string;
  run_id: string | null;
  device_id: string | null;
  owner_user_id: string;
  workspace_id: string;
  lineage_id: string | null;
  token_parent_admin_grant_id: string | null;
  principal_parent_admin_grant_id: string | null;
}
export class LocalAuthDiscoveryChanged extends Error {
  readonly code = "40001";
  readonly detail = "LOCAL_AUTH_DISCOVERY_CHANGED";
  constructor() { super("Local authentication binding changed"); }
}
export async function retryLocalAuthTransaction<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0;; attempt++) {
    try { return await operation(); }
    catch (error) {
      const owned = error instanceof LocalAuthDiscoveryChanged ||
        (error !== null && typeof error === "object" &&
          "code" in error && error.code === "40001" &&
          "detail" in error && error.detail === "LOCAL_AUTH_DISCOVERY_CHANGED");
      if (!owned || attempt >= 2) throw error;
    }
  }
}
export async function discoverLocalCredential(tx: Sql, hash: Uint8Array): Promise<LocalCredentialIds | null> {
  try {
    const rows = await tx<LocalCredentialIds[]>`SELECT * FROM swarm.discover_local_credential_ids(${hash})`;
    return rows[0] ?? null;
  } catch(error) {
    if(error!==null && typeof error==='object' && 'code' in error && error.code==='42501'
      && 'detail' in error && (error.detail==='LOCAL_CREDENTIAL_DENIED' || error.detail==='LOCAL_CREDENTIAL_INVALID'))
      throw new LocalCredentialDenied(error.detail==='LOCAL_CREDENTIAL_INVALID');
    throw error;
  }
}
export async function discoverLocalTargets(tx: Sql, workspace: string, selector:
  { user: string } | { principals: string[]; tokens: string[] } | { allWorkspace: true },
): Promise<LocalCredentialIds[]> {
  return await tx<LocalCredentialIds[]>`
    SELECT * FROM swarm.discover_local_target_ids(${workspace}::uuid,
      ${"user" in selector ? selector.user : null}::uuid,
      ${"principals" in selector ? selector.principals : []}::uuid[],
      ${"tokens" in selector ? selector.tokens : []}::uuid[],
      ${"allWorkspace" in selector})`;
}
type LocalLockMode = "share" | "update" | "noKeyUpdate";
interface LocalRowLock { id: string; mode: LocalLockMode }
interface LocalMemberLock { workspace: string; user: string; mode: LocalLockMode }
type LocalApprovalLock = {
  connection: string; grant: string; workspace: string; principal: string; mode: LocalLockMode;
};
interface LocalPlanSnapshot {
  hostedPrefix?: string;
  bindings: LocalCredentialIds[];
  users: string[];
  parents: string[];
  memberships: LocalMemberLock[];
  sessions: { principal: string; workspace: string }[];
  approvals: LocalApprovalLock[];
  members?: { workspace: string; user: string }[];
  contentRoles?: {workspace:string;user:string}[];
  boundaryIds?: string[];
  todoBindings?: {assignee_principal:string|null;offer_principal:string|null}[];
  hosted?: { grant: string; workspace: string; seat: string | null; principal: string }[];
  objectStreams?: { workspace: string; stream: string }[];
  todoStreams?: { workspace: string; stream: string }[];
  joins?: { credential: string; attempt: string | null }[];
  parentUpdates?: string[];
  adminAccounts?: string[];
  adminWorkspaces?: string[];
  workspaceRows?: string[];
  hostedGrants?: string[];
  hostedBindings?: {grant:string;workspace:string}[];
  routeStreams?: {id:string;workspace:string;kind:string;repo:string|null}[];
  restrictions?: {grant:string;workspace:string;principal:string}[];
}
/** No arbitrary table or SQL string. More caller phases must be added explicitly. */
export interface LocalAuthLockPlan {
  readonly snapshot: LocalPlanSnapshot;
  readonly rediscover: () => Promise<LocalPlanSnapshot>;
  readonly workspaces: LocalRowLock[];
  readonly principalMode: LocalLockMode;
  readonly sessionMode: LocalLockMode;
  readonly streamIds: string[];
  readonly connectionOnly?: boolean;
  readonly targetWorkspace?: string;
  locked: boolean;
  parentsLocked?: boolean;
  readonly actor?: string;
  readonly userKeyShareIds?: readonly string[];
  readonly hostedMode?: LocalLockMode;
}
const sortedIds = (ids: Array<string | null>) => [...new Set(ids.filter((id): id is string => id !== null))].sort();
function canonicalBindings(rows: LocalCredentialIds[]): string {
  return JSON.stringify(rows.map(r => [
    r.token_id,r.predecessor_token_id,r.renewal_grant_id,r.principal_id,r.run_id,r.device_id,
    r.owner_user_id,r.workspace_id,r.lineage_id,r.token_parent_admin_grant_id,r.principal_parent_admin_grant_id,
  ]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function snapshotKey(s: LocalPlanSnapshot): string {
  return JSON.stringify([s.hostedPrefix,canonicalBindings(s.bindings),s.users,s.parents,s.memberships,s.sessions,s.approvals,s.members,s.hosted,s.objectStreams,s.todoStreams,s.joins,s.parentUpdates,s.routeStreams,s.restrictions,s.hostedGrants,s.hostedBindings,s.contentRoles,s.boundaryIds,s.adminAccounts,s.adminWorkspaces,s.workspaceRows,s.todoBindings]);
}
/** This plan owns one exact local Allow target, including the exact current family proof.
 * Call before workspace/approval/principal/token reads in the permission writer.
 * The authenticated human's earlier user upsert is the same owner's U lock.
 */
export async function planLocalConnection(
  tx: Sql, workspace: string, owner: string, principal: string, token: string,
): Promise<LocalAuthLockPlan | null> {
  let initial: LocalCredentialIds[];
  try {
    // Read-only selector validation, before any plan row lock. This savepoint
    // maps a foreign/malformed target to ordinary refusal; it never restarts a
    // changed closure while retaining locks.
    initial = await tx.savepoint(sp => discoverLocalTargets(sp, workspace, { principals: [], tokens: [token] }));
  } catch (error) {
    if (error !== null && typeof error === "object" && "code" in error && error.code === "22023") return null;
    throw error;
  }
  const discover = async (known?: LocalCredentialIds[]): Promise<LocalPlanSnapshot> => {
    const bindings = known ?? await discoverLocalTargets(tx, workspace, { principals: [], tokens: [token] });
    const parents = sortedIds(bindings.flatMap(r => [r.token_parent_admin_grant_id,r.principal_parent_admin_grant_id]));
    const parentOwners = parents.length ? await tx<{ owner_user_id: string }[]>`
      SELECT owner_user_id FROM swarm.admin_grants WHERE grant_id=ANY(${parents}::uuid[]) ORDER BY grant_id` : [];
    const principals = sortedIds(bindings.map(r => r.principal_id));
    const users = sortedIds([owner,...bindings.map(r => r.owner_user_id),...parentOwners.map(r => r.owner_user_id)]);
    const sessions = principals.length ? await tx<{ principal: string; workspace: string }[]>`
      SELECT principal_id AS principal, workspace_id AS workspace FROM swarm.agent_execution_sessions
      WHERE principal_id=ANY(${principals}::uuid[]) ORDER BY principal_id,workspace_id` : [];
    const approvals = principals.length ? await tx<LocalApprovalLock[]>`
      SELECT connection_id AS connection,grant_id AS grant,workspace_id AS workspace,principal_id AS principal,'update'::text AS mode
      FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid
        AND principal_id=ANY(${principals}::uuid[])
        AND (renewal_grant_id=ANY(${sortedIds(bindings.map(r=>r.renewal_grant_id))}::uuid[])
          OR connection_id=${token}::uuid)
      ORDER BY connection_id,grant_id,workspace_id,principal_id` : [];
    return { bindings,parents,users,sessions,approvals,
      memberships: users.map(user => ({workspace,user,mode:"share" as const})) };
  };
  const snapshot = await discover(initial);
  const target = snapshot.bindings.find(r => r.token_id === token);
  // A human Allow cannot enlist foreign-owner U locks after its own user upsert.
  // Parent ancestry enforces the same owner; fail closed on malformed bindings.
  if (!target || target.principal_id !== principal || target.owner_user_id !== owner ||
      snapshot.users.some(user => user !== owner) ||
      snapshot.bindings.some(r => r.owner_user_id !== owner)) return null;
  if (snapshot.sessions.length > 256 || snapshot.approvals.length > 4096) {
    throw Object.assign(new Error("Local authentication closure exceeds work bound"), {code:"54000"});
  }
  return { snapshot,rediscover:() => discover(),workspaces:[{id:workspace,mode:"update"}],
    principalMode:"share",sessionMode:"share",streamIds:[],locked:false };
}
/** Locking only: callers supply a current server-resolved binding, never an
 * AuthContext. Rediscovery fences retain the existing whole-transaction retry.
 * Empty suffix sets deliberately leave grant/stream ordering to the caller.
 */
export async function planHostedClaimPrefix(tx: Sql, discover: () => Promise<{
  owner: string; workspaces: string[]; binding: string;
} | null>): Promise<LocalAuthLockPlan | null> {
  const initial = await discover();
  if (!initial) return null;
  if (sortedIds(initial.workspaces).length > 100) {
    throw Object.assign(new Error('Hosted workspace closure exceeds work bound'), {code:'54000'});
  }
  const snapshotOf = (row: NonNullable<typeof initial>): LocalPlanSnapshot => ({
    hostedPrefix: row.binding, bindings: [], users: [row.owner], parents: [],
    memberships: sortedIds(row.workspaces).map(workspace => ({workspace,user:row.owner,mode:'share'})),
    sessions: [], approvals: [], workspaceRows: sortedIds(row.workspaces),
  });
  return {
    snapshot: snapshotOf(initial),
    rediscover: async () => {
      const current = await discover();
      if (!current) throw new LocalAuthDiscoveryChanged();
      return snapshotOf(current);
    },
    workspaces: sortedIds(initial.workspaces).map(id => ({id,mode:'update'})),
    userKeyShareIds: [initial.owner], principalMode:'share',sessionMode:'share',
    streamIds:[],locked:false,
  };
}
/** Acquire complete predeclared phases. Every post-wait discovery is a new SQL
 * statement. Changed membership in any set rolls back the ENTIRE transaction.
 * This is backend protocol, not a trigger claim about absent caller prelocks.
 */
export async function lockLocalAuthPlan(tx: Sql, plan: LocalAuthLockPlan, through?: "parents"): Promise<void> {
  const same = async () => {
    if (snapshotKey(await plan.rediscover()) !== snapshotKey(plan.snapshot)) throw new LocalAuthDiscoveryChanged();
    await tx`SELECT clock_timestamp()`;
  };
  const s = plan.snapshot;
  if (new Set(plan.streamIds).size > 64) {
    throw Object.assign(new Error("Local authentication stream closure exceeds work bound"), {code:"54000"});
  }
  if (!plan.parentsLocked) {
  for (const id of s.users) {
    if (plan.userKeyShareIds?.includes(id) || (plan.actor && id !== plan.actor)) await tx`SELECT user_id FROM swarm.users WHERE user_id=${id}::uuid FOR KEY SHARE`;
    else await tx`SELECT user_id FROM swarm.users WHERE user_id=${id}::uuid FOR NO KEY UPDATE`;
  }
  for (const id of s.adminAccounts ?? []) await tx`SELECT owner_user_id FROM swarm.admin_accounts WHERE owner_user_id=${id}::uuid FOR UPDATE`;
  await same();
  for (const id of s.parents) {
    if (s.parentUpdates?.includes(id)) await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${id}::uuid FOR UPDATE`;
    else await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${id}::uuid FOR SHARE`;
  }
  await same();
  plan.parentsLocked=true;
  } else await same();
  if (through === "parents") return;
  for (const w of [...plan.workspaces].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (w.mode === "update") await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${w.id}::uuid FOR UPDATE`;
    else if (w.mode === "noKeyUpdate") await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${w.id}::uuid FOR NO KEY UPDATE`;
    else await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${w.id}::uuid FOR SHARE`;
  }
  for (const w of plan.workspaces) await tx`SELECT workspace_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${w.id}::uuid FOR SHARE`;
  for (const m of s.memberships) await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${m.workspace}::uuid AND user_id=${m.user}::uuid FOR SHARE`;
  for (const w of plan.workspaces) for (const user of sortedIds(s.bindings.map(r=>r.owner_user_id)))
    await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${w.id}::uuid AND user_id=${user}::uuid FOR SHARE`;
  for (const m of s.memberships) await tx`SELECT user_id FROM swarm.household_member_content_roles WHERE workspace_id=${m.workspace}::uuid AND user_id=${m.user}::uuid FOR SHARE`;
  for (const w of plan.workspaces) for (const id of sortedIds(s.bindings.map(r=>r.principal_id)))
    await tx`SELECT principal_id FROM swarm.agent_workspace_memberships WHERE workspace_id=${w.id}::uuid AND principal_id=${id}::uuid FOR SHARE`;
  await same();
  for (const a of s.approvals) await tx`
    SELECT connection_id FROM swarm.household_content_connections
    WHERE connection_id=${a.connection}::uuid AND grant_id=${a.grant}::uuid
      AND workspace_id=${a.workspace}::uuid AND principal_id=${a.principal}::uuid FOR UPDATE`;
  for (const h of s.restrictions ?? s.hosted ?? []) await tx`SELECT principal_id FROM swarm.household_hosted_content_restrictions
    WHERE grant_id=${h.grant}::uuid AND workspace_id=${h.workspace}::uuid AND principal_id=${h.principal}::uuid FOR UPDATE`;
  await same();
  for (const id of [...plan.streamIds].sort()) await tx`SELECT stream_id FROM swarm.streams WHERE stream_id=${id}::uuid FOR UPDATE`;
  for (const e of s.objectStreams ?? []) await tx`SELECT stream_id FROM swarm.household_object_streams WHERE workspace_id=${e.workspace}::uuid AND stream_id=${e.stream}::uuid FOR UPDATE`;
  for (const e of s.todoStreams ?? []) await tx`SELECT stream_id FROM swarm.household_todo_streams WHERE workspace_id=${e.workspace}::uuid AND stream_id=${e.stream}::uuid FOR UPDATE`;
  await same();
  for (const id of s.hostedGrants ?? sortedIds((s.hosted ?? []).map(r=>r.grant))) {
    if(plan.hostedMode==='update') await tx`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${id}::uuid FOR UPDATE`;
    else await tx`SELECT grant_id FROM swarm.hosted_mcp_grants WHERE grant_id=${id}::uuid FOR SHARE`;
  }
  for (const h of s.hostedBindings ?? s.hosted ?? []) {
    if(plan.hostedMode==='update') await tx`SELECT grant_id FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=${h.grant}::uuid AND workspace_id=${h.workspace}::uuid FOR UPDATE`;
    else await tx`SELECT grant_id FROM swarm.hosted_mcp_grant_workspaces WHERE grant_id=${h.grant}::uuid AND workspace_id=${h.workspace}::uuid FOR SHARE`;
  }
  for (const id of sortedIds((s.hosted ?? []).map(r=>r.seat))) await tx`SELECT seat_id FROM swarm.hosted_mcp_seats WHERE seat_id=${id}::uuid FOR UPDATE`;
  await same();
  for (const j of s.joins ?? []) {
    await tx`SELECT id FROM swarm.agent_join_credentials WHERE id=${j.credential}::uuid FOR UPDATE`;
    if (j.attempt) await tx`SELECT attempt_id FROM swarm.agent_join_attempts WHERE join_credential_id=${j.credential}::uuid AND attempt_id=${j.attempt}::uuid FOR UPDATE`;
  }
  await same();
  const principalIds=sortedIds(s.bindings.map(r=>r.principal_id));
  if (plan.principalMode==='update') {
    for await (const _rows of tx`SELECT principal_id FROM swarm.agent_principals
      WHERE principal_id=ANY(${principalIds}::uuid[]) ORDER BY principal_id FOR UPDATE`.cursor(64)) { /* retain locks */ }
  } else if (plan.principalMode==='noKeyUpdate') {
    for await (const _rows of tx`SELECT principal_id FROM swarm.agent_principals
      WHERE principal_id=ANY(${principalIds}::uuid[]) ORDER BY principal_id FOR NO KEY UPDATE`.cursor(64)) { /* retain locks */ }
  } else {
    for await (const _rows of tx`SELECT principal_id FROM swarm.agent_principals
      WHERE principal_id=ANY(${principalIds}::uuid[]) ORDER BY principal_id FOR SHARE`.cursor(64)) { /* retain locks */ }
  }
  await same();
  for (const session of s.sessions) {
    if (plan.sessionMode === "update") await tx`SELECT principal_id FROM swarm.agent_execution_sessions WHERE principal_id=${session.principal}::uuid AND workspace_id=${session.workspace}::uuid FOR UPDATE`;
    else await tx`SELECT principal_id FROM swarm.agent_execution_sessions WHERE principal_id=${session.principal}::uuid AND workspace_id=${session.workspace}::uuid FOR SHARE`;
  }
  await same();
  for (const id of sortedIds(s.bindings.map(r=>r.run_id))) await tx`SELECT run_id FROM swarm.agent_runs WHERE run_id=${id}::uuid FOR SHARE`;
  for (const id of sortedIds(s.bindings.map(r=>r.device_id))) await tx`SELECT device_id FROM swarm.devices WHERE device_id=${id}::uuid FOR SHARE`;
  await same();
  for await (const _rows of tx`SELECT renewal_grant_id FROM swarm.renewal_grants
    WHERE renewal_grant_id=ANY(${sortedIds(s.bindings.map(r=>r.renewal_grant_id))}::uuid[])
    ORDER BY renewal_grant_id FOR UPDATE`.cursor(64)) { /* complete parent fence */ }
  await same();
  const remaining = new Map(s.bindings.filter(r=>r.token_id!==null).map(r=>[r.token_id!,r]));
  const done = new Set<string>();
  while (remaining.size) {
    const roots = [...remaining.values()].filter(r => r.predecessor_token_id === null ||
      !remaining.has(r.predecessor_token_id) || done.has(r.predecessor_token_id)).sort((a,b)=>a.token_id!.localeCompare(b.token_id!));
    if (!roots.length) throw Object.assign(new Error("Malformed local credential closure"), {code:"22023"});
    for (const r of roots) {
      await tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id=${r.token_id}::uuid FOR UPDATE`;
      remaining.delete(r.token_id!); done.add(r.token_id!);
    }
  }
  await same();
  plan.locked=true;
}

/** Plan an existing operation before any actor upsert, parent RLS read or suffix.
 * Projection/household/admin callers explicitly request workspace discovery
 * because those branches enumerate members and candidate principals. Ordinary
 * activity/H0 select only the exact credential family and create no streams.
 */
export async function planLocalOperation(tx: Sql, options: {
  hash?: Uint8Array; workspace?: string; actor?: string; allWorkspace?: boolean; connectionOnly?: boolean; memberMutation?: boolean;
  streamIds?: string[]; principalMode?: LocalLockMode; sessionMode?: LocalLockMode;
  workspaceMode?: LocalLockMode; parentUpdates?: string[]; join?: { hash: Uint8Array; attempt: string }; hostedMode?:LocalLockMode;
  target?: {user:string}|{principals:string[];tokens:string[]};
  resumeFamily?: string;
  admin?: {owner:string;grant:string;recipients:string[]};
  household?: boolean; memberTargets?: string[]; allowMissingWorkspace?: boolean; todo?: string; householdQueue?: boolean;
  revocation?: {user:string}|{principal:string}|{token:string};
}): Promise<LocalAuthLockPlan | null> {
  const credential = options.hash ? await discoverLocalCredential(tx, options.hash) : null;
  if (options.hash && !credential) return null;
  let joinRows: (LocalCredentialIds & { join_credential_id: string; attempt_id: string | null; stream_id: string })[] = [];
  if (options.join) joinRows = await tx`SELECT * FROM swarm.discover_local_join_ids(${options.join.hash},${options.join.attempt}::uuid)`;
  if (options.join && !joinRows.length) return null;
  const workspace = options.connectionOnly ? credential?.workspace_id ?? options.workspace ?? null : options.workspace ?? credential?.workspace_id ?? joinRows[0]?.workspace_id ?? null;
  if (!workspace && !options.admin) return null;
  // Nonlocking admission; authority is repeated after the final wait.
  if (credential && workspace && !options.connectionOnly && !await localAgentWorkspaceLive(tx,credential.principal_id,workspace)) throw new LocalCredentialWorkspaceMismatch();
  const owner=options.actor ?? credential?.owner_user_id ?? joinRows[0]?.owner_user_id;
  if (workspace && owner && !options.join && !options.connectionOnly) {
    const [admitted]=await tx<{ok:boolean}[]>`SELECT EXISTS(
      SELECT 1 FROM swarm.memberships m JOIN swarm.workspaces w USING(workspace_id)
      WHERE m.workspace_id=${workspace}::uuid AND m.user_id=${owner}::uuid
        AND m.revoked_at IS NULL AND w.archived_at IS NULL) AS ok`;
    if (!admitted?.ok && !(options.allowMissingWorkspace && !(await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${workspace}::uuid`).length)) {
      if(options.hash) throw new LocalCredentialDenied();
      return null;
    }
  }
  const discover = async (): Promise<LocalPlanSnapshot> => {
    const exact = options.hash ? await discoverLocalCredential(tx, options.hash) : null;
    const joins: typeof joinRows = options.join
      ? await tx`SELECT * FROM swarm.discover_local_join_ids(${options.join.hash},${options.join.attempt}::uuid)` : [];
    // Parent-only selectors return P/G and current parent bindings, no T.
    let bindings = workspace && options.revocation && !('token' in options.revocation)
      ? await discoverLocalTargets(tx,workspace,'user' in options.revocation
        ? {user:options.revocation.user}:{principals:[options.revocation.principal],tokens:[]})
      : workspace && options.allWorkspace
      ? await discoverLocalTargets(tx, workspace, {allWorkspace:true})
      : joins.length ? joins.map(({join_credential_id: _j,attempt_id: _a,stream_id: _s,...row})=>row)
      : exact?.token_id ? await discoverLocalTargets(tx, workspace!, {principals:[],tokens:[exact.token_id]}) : [];
    if(workspace && options.target && !options.allWorkspace) {
      const extra=await discoverLocalTargets(tx,workspace,options.target);
      const union=new Map([...bindings,...extra].map(r=>[JSON.stringify([r.token_id,r.principal_id,r.renewal_grant_id]),r]));
      bindings=[...union.values()];
    }
    if (workspace && options.revocation && 'token' in options.revocation) {
      const revoked=await tx<LocalCredentialIds[]>`SELECT * FROM swarm.discover_local_target_ids(
        ${workspace}::uuid,NULL::uuid,ARRAY[]::uuid[],ARRAY[${options.revocation.token}::uuid],false,NULL::uuid,true)`;
      bindings=[...new Map([...bindings,...revoked].map(r=>[JSON.stringify(r),r])).values()];
    }
    if (workspace && options.resumeFamily) {
      const family=await tx<LocalCredentialIds[]>`SELECT * FROM swarm.discover_local_target_ids(
        ${workspace}::uuid,NULL::uuid,ARRAY[]::uuid[],ARRAY[]::uuid[],false,${options.resumeFamily}::uuid)`;
      if (!family.length) throw new LocalAuthDiscoveryChanged();
      bindings=[...new Map([...bindings,...family].map(r=>[JSON.stringify(r),r])).values()];
    }
    const todoBindings=workspace && options.todo ? await tx<{assignee_principal:string|null;offer_principal:string|null}[]>`
      SELECT assignee_principal,offer_principal FROM swarm.household_todos
      WHERE workspace_id=${workspace}::uuid AND todo_id=${options.todo}::uuid` : [];
    const todoPrincipals=sortedIds(todoBindings.flatMap(t=>[t.assignee_principal,t.offer_principal]));
    if (workspace && todoPrincipals.length) {
      const extra=await discoverLocalTargets(tx,workspace,{principals:todoPrincipals,tokens:[]});
      bindings=[...new Map([...bindings,...extra].map(r=>[JSON.stringify([r.token_id,r.principal_id,r.renewal_grant_id,r.token_parent_admin_grant_id]),r])).values()];
    }
    if(workspace && options.householdQueue && exact) {
      const extra=await discoverLocalTargets(tx,workspace,{principals:[exact.principal_id],tokens:[]});
      bindings=[...new Map([...bindings,...extra].map(r=>[JSON.stringify([r.token_id,r.principal_id,r.renewal_grant_id,r.token_parent_admin_grant_id]),r])).values()];
    }
    if(options.revocation && !('token' in options.revocation)) {
      // The independent parent plan carries no child T work and cannot fail
      // because of the number of current or historical children.
      bindings=[...new Map(bindings.map(r=>{
        const parent={...r,token_id:null,predecessor_token_id:null,lineage_id:null};
        return [JSON.stringify(parent),parent] as const;
      })).values()];
    }
    if (options.hash && (!exact || !bindings.some(r=>r.token_id===exact.token_id))) throw new LocalAuthDiscoveryChanged();
    // All existing account grants are written by delegated projection persistence.
    // Read IDs without locks; they authorize nothing. The complete union is locked
    // before the verifier's status resolver can take the caller's own parent.
    const ownParents=options.admin ? await tx<{grant_id:string;workspace_ids:string[];withdrawn_workspace_ids:string[]}[]>`
      SELECT grant_id,workspace_ids,withdrawn_workspace_ids FROM swarm.admin_grants
      WHERE owner_user_id=${options.admin.owner}::uuid ORDER BY grant_id` : [];
    const bound=ownParents.find(g=>g.grant_id===options.admin?.grant);
    const adminWorkspaces=options.admin && bound ? (await tx<{workspace_id:string}[]>`
      SELECT w.workspace_id FROM swarm.workspaces w JOIN swarm.memberships m USING(workspace_id)
      WHERE m.user_id=${options.admin.owner}::uuid
        AND w.workspace_id=ANY(${bound.workspace_ids.filter(w=>!bound.withdrawn_workspace_ids.includes(w))}::uuid[])
      ORDER BY w.workspace_id`).map(r=>r.workspace_id) : [];
    const adminAccounts=options.admin ? (await tx<{owner_user_id:string}[]>`
      SELECT owner_user_id FROM swarm.admin_accounts WHERE owner_user_id=${options.admin.owner}::uuid`).map(r=>r.owner_user_id) : [];
    const recipients=options.admin ? (await tx<{user_id:string}[]>`SELECT user_id FROM swarm.users
      WHERE user_id=ANY(${options.admin.recipients}::uuid[]) ORDER BY user_id`).map(r=>r.user_id) : [];
    const relatedWorkspaces=options.memberMutation ? (await tx<{workspace_id:string}[]>`SELECT workspace_id FROM swarm.agent_workspace_memberships WHERE principal_id=ANY(${sortedIds(bindings.map(r=>r.principal_id))}::uuid[]) ORDER BY workspace_id`).map(r=>r.workspace_id) : [];
    const workspaceRows=(await tx<{workspace_id:string}[]>`SELECT workspace_id FROM swarm.workspaces
      WHERE workspace_id=ANY(${sortedIds([workspace,...adminWorkspaces,...relatedWorkspaces])}::uuid[]) ORDER BY workspace_id`).map(r=>r.workspace_id);
    const parentUpdates=sortedIds([...(options.parentUpdates ?? []),...ownParents.map(g=>g.grant_id)]);
    const parents = sortedIds([...bindings.flatMap(r=>[r.token_parent_admin_grant_id,r.principal_parent_admin_grant_id]),...parentUpdates]);
    const parentOwners = parents.length ? await tx<{owner_user_id:string}[]>`SELECT owner_user_id FROM swarm.admin_grants WHERE grant_id=ANY(${parents}::uuid[]) ORDER BY grant_id` : [];
    const workspaceMembers = options.allWorkspace
      ? await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.memberships WHERE workspace_id=${workspace}::uuid ORDER BY workspace_id,user_id` : [];
    const users = sortedIds([options.actor ?? null,options.admin?.owner ?? null,...recipients,...bindings.map(r=>r.owner_user_id),...parentOwners.map(r=>r.owner_user_id),...workspaceMembers.map(r=>r.user),...(options.memberTargets ?? [])]);
    const members=await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.memberships
      WHERE workspace_id=ANY(${sortedIds([workspace ?? null,...adminWorkspaces])}::uuid[]) AND user_id=ANY(${users}::uuid[]) ORDER BY workspace_id,user_id`;
    const contentRoles=await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.household_member_content_roles
      WHERE workspace_id=ANY(${sortedIds([workspace ?? null,...adminWorkspaces])}::uuid[]) AND user_id=ANY(${users}::uuid[]) ORDER BY workspace_id,user_id`;
    const boundaryIds=(await tx<{workspace_id:string}[]>`SELECT workspace_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspace}::uuid`).map(r=>r.workspace_id);
    const principals = sortedIds(bindings.map(r=>r.principal_id));
    const sessions = principals.length ? await tx<{principal:string;workspace:string}[]>`SELECT principal_id AS principal,workspace_id AS workspace FROM swarm.agent_execution_sessions WHERE principal_id=ANY(${principals}::uuid[]) ORDER BY principal_id,workspace_id` : [];
    let approvals: LocalApprovalLock[] = await tx<LocalApprovalLock[]>`SELECT connection_id AS connection,grant_id AS grant,workspace_id AS workspace,principal_id AS principal,'update'::text AS mode FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid AND (
      ${options.household===true || options.revocation!==undefined || options.allWorkspace===true}
        AND principal_id=ANY(${principals}::uuid[])) ORDER BY connection_id,grant_id,workspace_id,principal_id`;
    let hosted = options.household || options.revocation || options.allWorkspace || options.memberMutation ? await tx<{grant:string;workspace:string;seat:string|null;principal:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace,seat_id AS seat,principal_id AS principal FROM swarm.hosted_mcp_seats WHERE workspace_id=${workspace}::uuid
      AND (principal_id=ANY(${principals}::uuid[]) OR owner_user_id=ANY(${options.memberTargets ?? []}::uuid[])) ORDER BY grant_id,workspace_id,seat_id,principal_id` : [];
    const hostedGrants=options.household || options.revocation || options.allWorkspace || options.memberMutation ? (await tx<{grant_id:string}[]>`SELECT g.grant_id FROM swarm.hosted_mcp_grants g
      WHERE (g.owner_user_id=ANY(${options.memberTargets ?? []}::uuid[])
          AND (${workspace}::uuid=ANY(g.selected_workspace_ids) OR EXISTS(
            SELECT 1 FROM swarm.hosted_mcp_agent_workspace_adds a WHERE a.grant_id=g.grant_id AND a.workspace_id=${workspace}::uuid)))
        OR (${options.memberMutation===true} AND EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_agents ga
          WHERE ga.grant_id=g.grant_id AND ga.principal_id=ANY(${principals}::uuid[])))
        OR g.grant_id=ANY(${sortedIds(hosted.map(h=>h.grant))}::uuid[])
      ORDER BY g.grant_id`).map(r=>r.grant_id) : [];
    if(hostedGrants.length) {
      hosted=await tx<{grant:string;workspace:string;seat:string|null;principal:string}[]>`
        SELECT grant_id AS grant,workspace_id AS workspace,seat_id AS seat,principal_id AS principal
        FROM swarm.hosted_mcp_seats WHERE workspace_id=${workspace}::uuid
          AND grant_id=ANY(${hostedGrants}::uuid[]) ORDER BY grant_id,workspace_id,seat_id,principal_id`;
      const legacy=await tx<LocalApprovalLock[]>`SELECT connection_id AS connection,grant_id AS grant,workspace_id AS workspace,
        principal_id AS principal,'update'::text AS mode FROM swarm.household_content_connections
        WHERE workspace_id=${workspace}::uuid AND hosted_grant_id=ANY(${hostedGrants}::uuid[])
        ORDER BY connection_id,grant_id,workspace_id,principal_id`;
      approvals=[...new Map([...approvals,...legacy].map(a=>[JSON.stringify([a.connection,a.grant,a.workspace,a.principal]),a])).values()]
        .sort((a,b)=>a.connection.localeCompare(b.connection)||a.grant.localeCompare(b.grant)||a.workspace.localeCompare(b.workspace)||a.principal.localeCompare(b.principal));
    }
    const hostedBindings=hostedGrants.length ? await tx<{grant:string;workspace:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace
      FROM swarm.hosted_mcp_grant_workspaces WHERE workspace_id=${workspace}::uuid
      AND grant_id=ANY(${hostedGrants}::uuid[]) ORDER BY grant_id,workspace_id` : [];
    const routeStreams = await tx<{id:string;workspace:string;kind:string;repo:string|null}[]>`SELECT stream_id AS id,workspace_id AS workspace,kind,repo_mapping_id AS repo FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND (stream_id=ANY(${options.streamIds ?? []}::uuid[]) OR ${options.admin!==undefined || options.memberMutation===true} AND kind='workspace') ORDER BY stream_id`;
    const restrictions = hostedGrants.length ? await tx<{grant:string;workspace:string;principal:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace,principal_id AS principal FROM swarm.household_hosted_content_restrictions WHERE workspace_id=${workspace}::uuid
      AND grant_id=ANY(${hostedGrants}::uuid[]) ORDER BY grant_id,workspace_id,principal_id` : [];
    const objectStreams = options.household ? await tx<{workspace:string;stream:string}[]>`SELECT workspace_id AS workspace,stream_id AS stream FROM swarm.household_object_streams WHERE workspace_id=${workspace}::uuid ORDER BY stream_id` : [];
    const todoStreams = options.household ? await tx<{workspace:string;stream:string}[]>`SELECT workspace_id AS workspace,stream_id AS stream FROM swarm.household_todo_streams WHERE workspace_id=${workspace}::uuid ORDER BY stream_id` : [];
    if (!options.revocation && (sortedIds(bindings.map(r=>r.token_id)).length>2048
      || sortedIds(bindings.map(r=>r.principal_id)).length>256
      || sortedIds(bindings.map(r=>r.renewal_grant_id)).length>256
      || sortedIds(bindings.map(r=>r.run_id)).length>256 || sortedIds(bindings.map(r=>r.device_id)).length>256
      || members.length>4096 || contentRoles.length>4096 || adminWorkspaces.length+(workspace?1:0)>256 || users.length>256 || parents.length>256 || sessions.length>256 || hostedGrants.length>256 || bindings.length+approvals.length+hosted.length+hostedBindings.length+restrictions.length>4096 || objectStreams.length+todoStreams.length+(options.streamIds?.length ?? 0)>64)) throw Object.assign(new Error('Local authentication closure exceeds work bound'),{code:'54000'});
    return {bindings,parents,users,sessions,approvals,todoBindings,members,contentRoles,boundaryIds,hosted,hostedGrants,hostedBindings,objectStreams,todoStreams,routeStreams,restrictions,adminAccounts,adminWorkspaces,workspaceRows,
      memberships:[...new Map([...members,...contentRoles].map(m=>[JSON.stringify([m.workspace,m.user]),m])).values()]
        .sort((a,b)=>a.workspace.localeCompare(b.workspace)||a.user.localeCompare(b.user)).map(m=>({...m,mode:"share" as const})),
      joins: joins.length ? [{credential:joins[0]!.join_credential_id,attempt:joins[0]!.attempt_id}] : [],
      parentUpdates};
  };
  const snapshot = await discover();
  return {snapshot,rediscover:discover,connectionOnly:options.connectionOnly,targetWorkspace:workspace ?? undefined,actor:options.actor ?? credential?.owner_user_id ?? joinRows[0]?.owner_user_id,
    workspaces:sortedIds([workspace ?? null,...(snapshot.adminWorkspaces ?? []),...(options.memberMutation ? snapshot.workspaceRows ?? [] : [])]).map(id=>({id,mode: options.workspaceMode ?? (options.allWorkspace || options.household || options.revocation || options.join || options.admin ? 'update' as const:'share' as const)})),
    principalMode:options.principalMode ?? 'share',sessionMode:options.sessionMode ?? 'share',hostedMode:options.hostedMode,
    streamIds:sortedIds([...(snapshot.routeStreams ?? []).map(r=>r.id),...joinRows.map(r=>r.stream_id)]),locked:false};
}

export async function localAgentWorkspaceLive(tx:Sql,principal:string,workspace:string):Promise<boolean> {
  const [row]=await tx<{ok:boolean}[]>`SELECT swarm.local_agent_workspace_live(${principal}::uuid,${workspace}::uuid) AS ok`;
  return row?.ok===true;
}

async function localCredentialTargetLive(tx:Sql,agent:AgentAuthRow,workspace:string):Promise<boolean> {
 const [row]=await tx<{ok:boolean}[]>`SELECT swarm.local_agent_workspace_live(p.principal_id,${workspace}::uuid)
  AND swarm.admin_child_live(p.parent_admin_grant_id,${workspace}::uuid)
  AND swarm.admin_child_live(t.parent_admin_grant_id,${workspace}::uuid) AS ok
  FROM swarm.agent_principals p JOIN swarm.agent_tokens t USING(principal_id)
  WHERE p.principal_id=${agent.principal_id}::uuid AND t.token_id=${agent.token_id}::uuid`;
 return row?.ok===true;
}
