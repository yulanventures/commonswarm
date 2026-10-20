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
export async function loadAgentCredential(
  tx: Sql,
  tokenHash: Uint8Array,
): Promise<(AgentAuthRow & { first_use: boolean }) | null> {
  const stamped = await tx<{ token_id: string; first_use: boolean }[]>`
    WITH presented AS (
      -- The joins are repeated here rather than left to the liveness read so
      -- that a hash resolving to a token whose principal, run or device row is
      -- missing is never stamped: that credential does not authenticate, and a
      -- use that did not happen must not end anything.
      SELECT t.token_id, t.predecessor_token_id, t.first_used_at
      FROM swarm.agent_tokens AS t
      JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
      JOIN swarm.agent_runs AS r
        ON r.run_id = t.run_id AND r.principal_id = t.principal_id
      JOIN swarm.devices AS d ON d.device_id = r.device_id
      WHERE t.token_hash = ${tokenHash}
        AND p.transport = 'local'
        AND p.turn_only = false
      LIMIT 1
    ),
    stamp AS (
      UPDATE swarm.agent_tokens AS s
      SET first_used_at = statement_timestamp()
      FROM presented AS p
      WHERE s.token_id = p.token_id
        AND s.first_used_at IS NULL
        AND s.revoked_at IS NULL
        AND s.expires_at > statement_timestamp()
      RETURNING s.token_id
    ),
    handover AS (
      -- The successor is now known to have reached its holder, so the
      -- predecessor's job is over. Ending it HERE rather than at issue is the
      -- fix: superseding at issue kills the predecessor for a successor that may
      -- never arrive, which strands the worker when the response is lost.
      --
      -- It reads stamp, not presented, so the predecessor is ended only when
      -- this call really was the first use. Two concurrent first uses cannot
      -- both stamp: the second UPDATE re-checks first_used_at IS NULL against
      -- the row the first one wrote and matches nothing.
      UPDATE swarm.agent_tokens AS pred
      SET expires_at = statement_timestamp()
      FROM presented AS p
      JOIN stamp AS s ON s.token_id = p.token_id
      WHERE pred.token_id = p.predecessor_token_id
        AND pred.revoked_at IS NULL
        AND pred.expires_at > statement_timestamp()
      RETURNING pred.token_id
    )
    SELECT
      pre.token_id,
      pre.first_used_at IS NULL AS first_use
    FROM presented AS pre
  `;
  const presented = stamped[0];
  if (!presented) return null;

  const rows = await tx<AgentAuthRow[]>`
    SELECT
      t.token_id, t.principal_id, t.run_id, r.device_id,
      p.owner_user_id, p.workspace_id AS principal_workspace_id,
      t.lineage_id, t.scopes, t.surrender_only,
      t.revoked_at AS token_revoked_at,
      p.revoked_at AS principal_revoked_at,
      r.ended_at AS run_ended_at,
      d.revoked_at AS device_revoked_at,
      t.expires_at > statement_timestamp() AS unexpired,
      p.managed_at AS managed_at,
      p.transport
    FROM swarm.agent_tokens AS t
    JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
    JOIN swarm.agent_runs AS r
      ON r.run_id = t.run_id AND r.principal_id = t.principal_id
    JOIN swarm.devices AS d ON d.device_id = r.device_id
    WHERE t.token_id = ${presented.token_id}::uuid
      AND p.transport = 'local'
      AND p.turn_only = false
  `;
  const agent = rows[0];
  if (!agent?.unexpired) return null;
  return { ...agent, first_use: presented.first_use === true };
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
      (expired_at IS NOT NULL AND expired_at > statement_timestamp()) AS live
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
type LocalLockMode = "share" | "update";
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
}
const sortedIds = (ids: Array<string | null>) => [...new Set(ids.filter((id): id is string => id !== null))].sort();
function canonicalBindings(rows: LocalCredentialIds[]): string {
  return JSON.stringify(rows.map(r => [
    r.token_id,r.predecessor_token_id,r.renewal_grant_id,r.principal_id,r.run_id,r.device_id,
    r.owner_user_id,r.workspace_id,r.lineage_id,r.token_parent_admin_grant_id,r.principal_parent_admin_grant_id,
  ]).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}
function snapshotKey(s: LocalPlanSnapshot): string {
  return JSON.stringify([canonicalBindings(s.bindings),s.users,s.parents,s.memberships,s.sessions,s.approvals]);
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
export async function lockLocalAuthPlan(tx: Sql, plan: LocalAuthLockPlan): Promise<void> {
  const same = async () => {
    if (snapshotKey(await plan.rediscover()) !== snapshotKey(plan.snapshot)) throw new LocalAuthDiscoveryChanged();
    await tx`SELECT clock_timestamp()`;
  };
  const s = plan.snapshot;
  if (new Set(plan.streamIds).size > 64) {
    throw Object.assign(new Error("Local authentication stream closure exceeds work bound"), {code:"54000"});
  }
  for (const id of s.users) await tx`SELECT user_id FROM swarm.users WHERE user_id=${id}::uuid FOR NO KEY UPDATE`;
  await same();
  for (const id of s.parents) await tx`SELECT grant_id FROM swarm.admin_grants WHERE grant_id=${id}::uuid FOR SHARE`;
  await same();
  for (const w of [...plan.workspaces].sort((a,b)=>a.id.localeCompare(b.id))) {
    if (w.mode === "update") await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${w.id}::uuid FOR UPDATE`;
    else await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${w.id}::uuid FOR SHARE`;
  }
  for (const w of plan.workspaces) await tx`SELECT workspace_id FROM swarm.household_workspace_boundaries WHERE workspace_id=${w.id}::uuid FOR SHARE`;
  for (const m of s.memberships) await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${m.workspace}::uuid AND user_id=${m.user}::uuid FOR SHARE`;
  for (const m of s.memberships) await tx`SELECT user_id FROM swarm.household_member_content_roles WHERE workspace_id=${m.workspace}::uuid AND user_id=${m.user}::uuid FOR SHARE`;
  await same();
  for (const a of s.approvals) await tx`
    SELECT connection_id FROM swarm.household_content_connections
    WHERE connection_id=${a.connection}::uuid AND grant_id=${a.grant}::uuid
      AND workspace_id=${a.workspace}::uuid AND principal_id=${a.principal}::uuid FOR UPDATE`;
  await same();
  for (const id of [...plan.streamIds].sort()) await tx`SELECT stream_id FROM swarm.streams WHERE stream_id=${id}::uuid FOR UPDATE`;
  await same();
  for (const id of sortedIds(s.bindings.map(r=>r.principal_id))) {
    if (plan.principalMode === "update") await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${id}::uuid FOR UPDATE`;
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
