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
  constructor() { super('Local credential is no longer authorized'); }
}
export async function loadAgentCredential(
  tx: Sql, tokenHash: Uint8Array, expected: LocalAuthLockPlan,
  allowExpiredRenewal = false,
): Promise<(AgentAuthRow & { first_use: boolean }) | null> {
  if (!expected.locked) throw new LocalAuthDiscoveryChanged();
  if (snapshotKey(await expected.rediscover()) !== snapshotKey(expected.snapshot)) throw new LocalAuthDiscoveryChanged();
  const exact = await discoverLocalCredential(tx, tokenHash);
  if (!exact || !expected.snapshot.bindings.some(r=>r.token_id===exact.token_id)) throw new LocalAuthDiscoveryChanged();
  return await lockedCredentialFacts(tx,tokenHash,exact,allowExpiredRenewal,true);
}

/** Final proof after owned content writes. Missing stream rows are protected by
 * the already-held workspace UPDATE lock. Supported content stores may create
 * them in this transaction; no existing stream may disappear or rebind, and
 * no new external binding/parent/session/family/token is adopted here.
 */
export async function recheckLocalCredential(tx:Sql,hash:Uint8Array,plan:LocalAuthLockPlan):Promise<AgentAuthRow|null> {
  if(!plan.locked) throw new LocalAuthDiscoveryChanged();
  const current=await plan.rediscover();
  const initial=plan.snapshot;
  for(const key of ['objectStreams','todoStreams'] as const) {
    const oldRows=initial[key] ?? [],newRows=current[key] ?? [];
    if(oldRows.some(row=>!newRows.some(r=>r.workspace===row.workspace && r.stream===row.stream))
      || newRows.some(row=>!oldRows.some(r=>r.workspace===row.workspace && r.stream===row.stream)
        && !plan.workspaces.some(w=>w.id===row.workspace && w.mode==='update'))) throw new LocalAuthDiscoveryChanged();
  }
  if(snapshotKey({...current,objectStreams:initial.objectStreams,todoStreams:initial.todoStreams})!==snapshotKey(initial)) throw new LocalAuthDiscoveryChanged();
  const exact=await discoverLocalCredential(tx,hash);
  if(!exact || !initial.bindings.some(r=>r.token_id===exact.token_id)) throw new LocalAuthDiscoveryChanged();
  return await lockedCredentialFacts(tx,hash,exact,false,false);
}
async function lockedCredentialFacts(tx:Sql,tokenHash:Uint8Array,exact:LocalCredentialIds,
  allowExpiredRenewal:boolean,stampUse:boolean):Promise<(AgentAuthRow & {first_use:boolean})|null> {
  // All waits precede this statement. Family policy, unlike a bearer deadline,
  // is terminal. An expired used bearer is proof only for silent renewal.
  const rows = await tx<(AgentAuthRow & { first_use:boolean; eligible_renewal:boolean })[]>`
    SELECT t.token_id,t.principal_id,t.run_id,r.device_id,p.owner_user_id,
      p.workspace_id AS principal_workspace_id,t.lineage_id,t.scopes,t.surrender_only,
      t.revoked_at AS token_revoked_at,p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,d.revoked_at AS device_revoked_at,
      t.expires_at>clock_timestamp() AS unexpired,p.managed_at,p.transport,
      t.first_used_at IS NULL AS first_use,
      (g.kind='standing' AND g.connection_expires_at IS NULL AND g.connection_expired_at IS NULL
        AND g.revoked_at IS NULL AND t.first_used_at IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM swarm.agent_tokens child WHERE child.predecessor_token_id=t.token_id
          AND child.revoked_at IS NULL AND child.first_used_at IS NOT NULL)) AS eligible_renewal
    FROM swarm.agent_tokens t JOIN swarm.agent_principals p USING(principal_id)
    JOIN swarm.agent_runs r ON r.run_id=t.run_id AND r.principal_id=t.principal_id
    JOIN swarm.devices d ON d.device_id=r.device_id
    LEFT JOIN swarm.renewal_grants g ON g.renewal_grant_id=t.renewal_grant_id
    JOIN swarm.workspaces w ON w.workspace_id=p.workspace_id
    JOIN swarm.memberships m ON m.workspace_id=p.workspace_id AND m.user_id=p.owner_user_id
    WHERE t.token_hash=${tokenHash} AND p.transport='local' AND NOT p.turn_only
      AND t.revoked_at IS NULL AND p.revoked_at IS NULL AND r.ended_at IS NULL AND d.revoked_at IS NULL
      AND d.user_id=p.owner_user_id AND NOT t.surrender_only AND m.revoked_at IS NULL AND w.archived_at IS NULL
      AND swarm.admin_child_live(t.parent_admin_grant_id,p.workspace_id)
      AND swarm.admin_child_live(p.parent_admin_grant_id,p.workspace_id)
      AND swarm.admin_child_scopes_live(t.parent_admin_grant_id,t.scopes)
      AND swarm.admin_child_scopes_live(p.parent_admin_grant_id,t.scopes)
      AND (g.renewal_grant_id IS NULL OR (g.revoked_at IS NULL AND g.connection_expired_at IS NULL
        AND (g.connection_expires_at IS NULL OR g.connection_expires_at>clock_timestamp())
        AND ROW(g.principal_id,g.run_id,g.workspace_id,g.created_by)=ROW(t.principal_id,t.run_id,p.workspace_id,p.owner_user_id)
        AND (g.bound_device_id IS NULL OR g.bound_device_id=d.device_id)))
      AND NOT EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE (z.kind,z.target_id) IN
        (('token',t.token_id),('principal',p.principal_id),('run',r.run_id),('device',d.device_id),
         ('membership',p.owner_user_id),('lineage',t.lineage_id),('family',t.lineage_id),('renewal_grant',t.renewal_grant_id)))`;
  const agent=rows[0];
  if(!agent) {
    const known=await tx`SELECT t.token_id FROM swarm.agent_tokens t WHERE t.token_hash=${tokenHash}`;
    if(known.length) throw new LocalCredentialDenied();
    return null;
  }
  if (!agent.unexpired && !(allowExpiredRenewal && agent.eligible_renewal)) return null;
  if (stampUse && agent.unexpired && agent.first_use) {
    const [clock]=await tx<{now:Date}[]>`SELECT clock_timestamp() AS now`;
    const stamped=await tx`UPDATE swarm.agent_tokens SET first_used_at=${clock!.now}
      WHERE token_id=${agent.token_id}::uuid AND first_used_at IS NULL
        AND revoked_at IS NULL AND expires_at>${clock!.now} RETURNING token_id`;
    if (!stamped.length) return null;
    await tx`UPDATE swarm.agent_tokens SET expires_at=${clock!.now}
      WHERE token_id=${exact.predecessor_token_id}::uuid AND revoked_at IS NULL AND expires_at>${clock!.now}`;
  }
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
      (expired_at IS NOT NULL AND expired_at > clock_timestamp()) AS live
    FROM swarm.agent_execution_sessions
    WHERE principal_id = ${args.principalId}::uuid
      AND workspace_id = ${args.workspaceId}::uuid
    FOR SHARE
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
  const rows = await tx<LocalCredentialIds[]>`
    SELECT * FROM swarm.discover_local_credential_ids(${hash})`;
  return rows[0] ?? null;
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
  bindings: LocalCredentialIds[];
  users: string[];
  parents: string[];
  memberships: LocalMemberLock[];
  sessions: { principal: string; workspace: string }[];
  approvals: LocalApprovalLock[];
  members?: { workspace: string; user: string }[];
  contentRoles?: {workspace:string;user:string}[];
  boundaryIds?: string[];
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
  locked: boolean;
  parentsLocked?: boolean;
  readonly actor?: string;
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
  return JSON.stringify([canonicalBindings(s.bindings),s.users,s.parents,s.memberships,s.sessions,s.approvals,s.members,s.hosted,s.objectStreams,s.todoStreams,s.joins,s.parentUpdates,s.routeStreams,s.restrictions,s.hostedGrants,s.hostedBindings,s.contentRoles,s.boundaryIds,s.adminAccounts,s.adminWorkspaces,s.workspaceRows]);
}
/** This plan owns one exact local Allow target, including every family sibling.
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
      snapshot.bindings.some(r => r.workspace_id !== workspace || r.owner_user_id !== owner)) return null;
  if (snapshot.sessions.length > 256 || snapshot.approvals.length > 4096) {
    throw Object.assign(new Error("Local authentication closure exceeds work bound"), {code:"54000"});
  }
  return { snapshot,rediscover:() => discover(),workspaces:[{id:workspace,mode:"update"}],
    principalMode:"share",sessionMode:"share",streamIds:[],locked:false };
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
    if (plan.actor && id !== plan.actor) await tx`SELECT user_id FROM swarm.users WHERE user_id=${id}::uuid FOR KEY SHARE`;
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
  for (const m of s.memberships) await tx`SELECT user_id FROM swarm.household_member_content_roles WHERE workspace_id=${m.workspace}::uuid AND user_id=${m.user}::uuid FOR SHARE`;
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
  for (const j of s.joins ?? []) {
    await tx`SELECT id FROM swarm.agent_join_credentials WHERE id=${j.credential}::uuid FOR UPDATE`;
    if (j.attempt) await tx`SELECT attempt_id FROM swarm.agent_join_attempts WHERE join_credential_id=${j.credential}::uuid AND attempt_id=${j.attempt}::uuid FOR UPDATE`;
  }
  await same();
  for (const id of sortedIds(s.bindings.map(r=>r.principal_id))) {
    if (plan.principalMode === "update") await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${id}::uuid FOR UPDATE`;
    else if (plan.principalMode === "noKeyUpdate") await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${id}::uuid FOR NO KEY UPDATE`;
    else await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${id}::uuid FOR SHARE`;
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
  for (const id of sortedIds(s.bindings.map(r=>r.renewal_grant_id))) await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${id}::uuid FOR UPDATE`;
  await same();
  const remaining = new Map(s.bindings.filter(r=>r.token_id!==null).map(r=>[r.token_id!,r]));
  const done = new Set<string>();
  while (remaining.size) {
    const roots = [...remaining.values()].filter(r => r.predecessor_token_id === null ||
      done.has(r.predecessor_token_id)).sort((a,b)=>a.token_id!.localeCompare(b.token_id!));
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
  hash?: Uint8Array; workspace?: string; actor?: string; allWorkspace?: boolean;
  streamIds?: string[]; principalMode?: LocalLockMode; sessionMode?: LocalLockMode;
  workspaceMode?: LocalLockMode; parentUpdates?: string[]; join?: { hash: Uint8Array; attempt: string }; hostedMode?:LocalLockMode;
  target?: {user:string}|{principals:string[];tokens:string[]};
  admin?: {owner:string;grant:string;recipients:string[]};
}): Promise<LocalAuthLockPlan | null> {
  const credential = options.hash ? await discoverLocalCredential(tx, options.hash) : null;
  if (options.hash && !credential) return null;
  let joinRows: (LocalCredentialIds & { join_credential_id: string; attempt_id: string | null; stream_id: string })[] = [];
  if (options.join) joinRows = await tx`SELECT * FROM swarm.discover_local_join_ids(${options.join.hash},${options.join.attempt}::uuid)`;
  if (options.join && !joinRows.length) return null;
  const workspace = credential?.workspace_id ?? joinRows[0]?.workspace_id ?? options.workspace ?? null;
  if (!workspace && !options.admin) return null;
  const discover = async (): Promise<LocalPlanSnapshot> => {
    const exact = options.hash ? await discoverLocalCredential(tx, options.hash) : null;
    const joins: typeof joinRows = options.join
      ? await tx`SELECT * FROM swarm.discover_local_join_ids(${options.join.hash},${options.join.attempt}::uuid)` : [];
    let bindings = workspace && options.allWorkspace
      ? await discoverLocalTargets(tx, workspace, {allWorkspace:true})
      : joins.length ? joins.map(({join_credential_id: _j,attempt_id: _a,stream_id: _s,...row})=>row)
      : exact?.token_id ? await discoverLocalTargets(tx, workspace!, {principals:[],tokens:[exact.token_id]}) : [];
    if(workspace && options.target && !options.allWorkspace) {
      const extra=await discoverLocalTargets(tx,workspace,options.target);
      const union=new Map([...bindings,...extra].map(r=>[JSON.stringify([r.token_id,r.principal_id,r.renewal_grant_id]),r]));
      bindings=[...union.values()];
    }
    if (options.hash && (!exact || exact.workspace_id!==workspace || !bindings.some(r=>r.token_id===exact.token_id))) throw new LocalAuthDiscoveryChanged();
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
    const workspaceRows=(await tx<{workspace_id:string}[]>`SELECT workspace_id FROM swarm.workspaces
      WHERE workspace_id=ANY(${sortedIds([workspace,...adminWorkspaces])}::uuid[]) ORDER BY workspace_id`).map(r=>r.workspace_id);
    const parentUpdates=sortedIds([...(options.parentUpdates ?? []),...ownParents.map(g=>g.grant_id)]);
    const parents = sortedIds([...bindings.flatMap(r=>[r.token_parent_admin_grant_id,r.principal_parent_admin_grant_id]),...parentUpdates]);
    const parentOwners = parents.length ? await tx<{owner_user_id:string}[]>`SELECT owner_user_id FROM swarm.admin_grants WHERE grant_id=ANY(${parents}::uuid[]) ORDER BY grant_id` : [];
    const workspaceMembers = options.allWorkspace
      ? await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.memberships WHERE workspace_id=${workspace}::uuid ORDER BY workspace_id,user_id` : [];
    const users = sortedIds([options.actor ?? null,options.admin?.owner ?? null,...recipients,...bindings.map(r=>r.owner_user_id),...parentOwners.map(r=>r.owner_user_id),...workspaceMembers.map(r=>r.user)]);
    const members=await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.memberships
      WHERE workspace_id=ANY(${sortedIds([workspace ?? null,...adminWorkspaces])}::uuid[]) AND user_id=ANY(${users}::uuid[]) ORDER BY workspace_id,user_id`;
    const contentRoles=await tx<{workspace:string;user:string}[]>`SELECT workspace_id AS workspace,user_id AS user FROM swarm.household_member_content_roles
      WHERE workspace_id=ANY(${sortedIds([workspace ?? null,...adminWorkspaces])}::uuid[]) AND user_id=ANY(${users}::uuid[]) ORDER BY workspace_id,user_id`;
    const boundaryIds=(await tx<{workspace_id:string}[]>`SELECT workspace_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspace}::uuid`).map(r=>r.workspace_id);
    const principals = sortedIds(bindings.map(r=>r.principal_id));
    const sessions = principals.length ? await tx<{principal:string;workspace:string}[]>`SELECT principal_id AS principal,workspace_id AS workspace FROM swarm.agent_execution_sessions WHERE principal_id=ANY(${principals}::uuid[]) ORDER BY principal_id,workspace_id` : [];
    const approvals = await tx<LocalApprovalLock[]>`SELECT connection_id AS connection,grant_id AS grant,workspace_id AS workspace,principal_id AS principal,'update'::text AS mode FROM swarm.household_content_connections WHERE workspace_id=${workspace}::uuid AND (principal_id=ANY(${principals}::uuid[]) OR ${options.allWorkspace===true}) ORDER BY connection_id,grant_id,workspace_id,principal_id`;
    const hosted = options.allWorkspace ? await tx<{grant:string;workspace:string;seat:string|null;principal:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace,seat_id AS seat,principal_id AS principal FROM swarm.hosted_mcp_seats WHERE workspace_id=${workspace}::uuid ORDER BY grant_id,workspace_id,seat_id,principal_id` : [];
    const hostedGrants=options.allWorkspace ? (await tx<{grant_id:string}[]>`SELECT g.grant_id FROM swarm.hosted_mcp_grants g
      WHERE ${workspace}::uuid=ANY(g.selected_workspace_ids)
        OR EXISTS(SELECT 1 FROM swarm.hosted_mcp_grant_workspaces b WHERE b.grant_id=g.grant_id AND b.workspace_id=${workspace}::uuid)
        OR EXISTS(SELECT 1 FROM swarm.hosted_mcp_seats hs WHERE hs.grant_id=g.grant_id AND hs.workspace_id=${workspace}::uuid)
      ORDER BY g.grant_id`).map(r=>r.grant_id) : [];
    const hostedBindings=options.allWorkspace ? await tx<{grant:string;workspace:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace
      FROM swarm.hosted_mcp_grant_workspaces WHERE workspace_id=${workspace}::uuid ORDER BY grant_id,workspace_id` : [];
    const routeStreams = await tx<{id:string;workspace:string;kind:string;repo:string|null}[]>`SELECT stream_id AS id,workspace_id AS workspace,kind,repo_mapping_id AS repo FROM swarm.streams WHERE workspace_id=${workspace}::uuid AND (stream_id=ANY(${options.streamIds ?? []}::uuid[]) OR ${options.admin!==undefined && options.allWorkspace===true} AND kind='workspace') ORDER BY stream_id`;
    const restrictions = options.allWorkspace ? await tx<{grant:string;workspace:string;principal:string}[]>`SELECT grant_id AS grant,workspace_id AS workspace,principal_id AS principal FROM swarm.household_hosted_content_restrictions WHERE workspace_id=${workspace}::uuid ORDER BY grant_id,workspace_id,principal_id` : [];
    const objectStreams = options.allWorkspace ? await tx<{workspace:string;stream:string}[]>`SELECT workspace_id AS workspace,stream_id AS stream FROM swarm.household_object_streams WHERE workspace_id=${workspace}::uuid ORDER BY stream_id` : [];
    const todoStreams = options.allWorkspace ? await tx<{workspace:string;stream:string}[]>`SELECT workspace_id AS workspace,stream_id AS stream FROM swarm.household_todo_streams WHERE workspace_id=${workspace}::uuid ORDER BY stream_id` : [];
    if (members.length>4096 || contentRoles.length>4096 || adminWorkspaces.length+(workspace?1:0)>256 || users.length>256 || parents.length>256 || sessions.length>256 || hostedGrants.length>256 || bindings.length+approvals.length+hosted.length+hostedBindings.length+restrictions.length>4096 || objectStreams.length+todoStreams.length+(options.streamIds?.length ?? 0)>64) throw Object.assign(new Error('Local authentication closure exceeds work bound'),{code:'54000'});
    return {bindings,parents,users,sessions,approvals,members,contentRoles,boundaryIds,hosted,hostedGrants,hostedBindings,objectStreams,todoStreams,routeStreams,restrictions,adminAccounts,adminWorkspaces,workspaceRows,
      memberships:[...new Map([...members,...contentRoles].map(m=>[JSON.stringify([m.workspace,m.user]),m])).values()]
        .sort((a,b)=>a.workspace.localeCompare(b.workspace)||a.user.localeCompare(b.user)).map(m=>({...m,mode:"share" as const})),
      joins: joins.length ? [{credential:joins[0]!.join_credential_id,attempt:joins[0]!.attempt_id}] : [],
      parentUpdates};
  };
  const snapshot = await discover();
  return {snapshot,rediscover:discover,actor:options.actor ?? credential?.owner_user_id ?? joinRows[0]?.owner_user_id,
    workspaces:sortedIds([workspace ?? null,...(snapshot.adminWorkspaces ?? [])]).map(id=>({id,mode: options.workspaceMode ?? (options.allWorkspace || options.join || options.admin ? 'update' as const:'share' as const)})),
    principalMode:options.principalMode ?? 'share',sessionMode:options.sessionMode ?? 'share',hostedMode:options.hostedMode,
    streamIds:sortedIds([...(snapshot.routeStreams ?? []).map(r=>r.id),...joinRows.map(r=>r.stream_id)]),locked:false};
}
