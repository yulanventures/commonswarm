/**
 * Server witness for 20261125000001_ask_withdrawals.sql and the served command + read edges (CI / local Postgres):
 *   1. Forward catalog proof, functional proof, rollback, rollback-catalog proof, re-apply migration,
 *      re-run forward proofs, and direct table denial on swarm.ask_withdrawals for client roles.
 *   2. Core served command + read edge end-to-end:
 *      - Sender withdraws own ask -> leaves both addressees' decision_queue, decision_queue_page,
 *        and home_overview counts immediately, and appears once in each addressee's waiting_archived_page
 *        as outcome_kind='withdrawn', outcome_text='Withdrawn'.
 *      - Another agent of the same owner, the agent's owner, an admin, and a stranger all receive the
 *        exact same uniform 404 (or 403 workspace denial for non-members) and change nothing.
 *      - Withdrawing twice is idempotent (created=false, same withdrawn_at, one row in swarm.ask_withdrawals).
 *      - Answered ask cannot be withdrawn (uniform 404).
 *      - Withdrawn ask cannot be answered (plain reply 403 forbidden, choice answer_choice 409 ask_expired),
 *        dismissed (404), restored (404), or re-raised (409 ask_withdrawn).
 *      - Replace (post_signal / ask_choice with supersedes) creates the new ask and withdraws the old one
 *        atomically; old ask appears in Archived as outcome_kind='replaced', outcome_text='Replaced by a newer question'.
 *      - Replace naming someone else's or an already-withdrawn/answered ask returns uniform 404 and creates
 *        nothing in swarm.signals.
 *      - Private-channel ask withdrawal tags audit_log with the private channel (invisible to outside admin/owner
 *        in swarm_read.audit_log) and never leaks to non-members in Archived.
 *      - my_open_asks lists only the caller's own open asks (local agent token & human JWT), excludes
 *        withdrawn/replaced/answered asks, and reveals nothing about addressee dismissals (page before
 *        and after addressee dismissal is byte-identical modulo generated_at).
 *      - waiting_todos_page includes offer_id on request rows (matching dismiss_waiting_item('review', ...))
 *        and omits the offer_id key completely on non-request (e.g. assigned) to-do rows.
 *      - HezSec C1 dismissal instance binding: dismiss twice returns created=true then created=false with same
 *        dismissal UUID; restore with current dismissal succeeds; re-dismiss returns a new dismissal UUID;
 *        restore with stale first dismissal returns uniform 404 and leaves the dismissal active; restore without
 *        dismissal continues to work.
 *   3. Independent served security-condition tests (C1 group leave; C2 completion rule; C2 held-lock
 *      serialization races; C3 release recheck under blocked audit insert; C3 replay after access loss
 *      and deadline expiry; C4 audit privacy, cross-channel tag union, and agent presence).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { dbAssert, repoSql, runSql } from "../support/admin-schema-db.js";
import { sqlPhase } from "../support/admin-schema-process.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Row = Record<string, unknown>;
type Tx = postgres.TransactionSql<Record<string, unknown>>;

const TEST_TIMEOUT_MS = 240_000;
const WAIT_TIMEOUT_MS = 15_000;
const TEST_DB_LOCK_TIMEOUT_MS = 20_000;
const TEST_DB_STATEMENT_TIMEOUT_MS = 20_000;
const HOLDER_IDLE_IN_TX_TIMEOUT_MS = 25_000;
const RELEASE_LOCK_ROLLBACK = Symbol("release_lock_rollback");
const UNKNOWN_WITHDRAW_BODY = {
  error: "not_found",
  message: "No open ask of yours has that id.",
} as const;

const proofRoot = "deploy/release-proofs/ask-withdrawals/20261125000001";
const catalogAssert = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "ask withdrawals rollback catalog" : "ask withdrawals catalog",
  );

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
const EDGE_LOG_RING_LIMIT = 80;
const edgeLogRing: string[] = [];
let edgeLogPartial = "";
let envDir: string | undefined;
const activeConnections = new Set<postgres.Sql>();

function step(name: string): void {
  console.error(`[ask-withdrawals] ${name}`);
}

function openBoundedConnection(applicationName: string, forLockHolder = false): postgres.Sql {
  const conn = postgres(local.DB_URL, {
    prepare: false,
    max: forLockHolder ? 1 : 8,
    connection: {
      application_name: applicationName.slice(0, 63),
      lock_timeout: TEST_DB_LOCK_TIMEOUT_MS,
      statement_timeout: TEST_DB_STATEMENT_TIMEOUT_MS,
      ...(forLockHolder ? { idle_in_transaction_session_timeout: HOLDER_IDLE_IN_TX_TIMEOUT_MS } : {}),
    },
  });
  activeConnections.add(conn);
  return conn;
}

const UUID_TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER_TOKEN_RE = /^[a-z][a-z0-9_-]*$/;

function redactSensitiveText(text: string): string {
  return text
    .replace(/\b(Bearer|DPoP)\s+\S+/gi, "$1 ***")
    .replace(/\bswm_[A-Za-z0-9_-]+/g, "***")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "***")
    .replace(/\b[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, "***")
    .replace(
      /\b(authorization|apikey|api[_-]?key|service_role_key|anon_key|access_token|refresh_token|token|secret|password)(\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1$2***",
    )
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, (match) =>
      UUID_TOKEN_RE.test(match) || IDENTIFIER_TOKEN_RE.test(match) ? match : "***",
    );
}

function appendEdgeLogChunk(text: string): void {
  const combined = edgeLogPartial + text;
  const parts = combined.split(/\r?\n/);
  edgeLogPartial = parts.pop() ?? "";
  for (const line of parts) {
    if (line.length === 0) continue;
    edgeLogRing.push(line);
  }
  if (edgeLogRing.length > EDGE_LOG_RING_LIMIT) {
    edgeLogRing.splice(0, edgeLogRing.length - EDGE_LOG_RING_LIMIT);
  }
}

function recentRedactedEdgeLogs(): string[] {
  const lines = edgeLogPartial.length > 0 ? [...edgeLogRing, edgeLogPartial] : [...edgeLogRing];
  return lines.slice(-EDGE_LOG_RING_LIMIT).map(redactSensitiveText);
}

function redactQueryPrefix(query: string | null): string {
  if (!query) return "";
  return redactSensitiveText(query)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

async function captureLockDiagnostics(stepName: string): Promise<string> {
  const collect = async (): Promise<string> => {
    const [activity, ungrantedLocks] = await Promise.all([
      sql<{
        pid: number;
        application_name: string | null;
        state: string | null;
        wait_event_type: string | null;
        wait_event: string | null;
        blocking_pids: number[];
        query: string | null;
      }[]>`
        SELECT
          pid,
          application_name,
          state,
          wait_event_type,
          wait_event,
          pg_blocking_pids(pid) AS blocking_pids,
          left(query, 200) AS query
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND pid <> pg_backend_pid()
          AND (
            state <> 'idle'
            OR wait_event_type IS NOT NULL
            OR cardinality(pg_blocking_pids(pid)) > 0
          )
        ORDER BY pid
      `,
      sql<{
        pid: number;
        locktype: string;
        relation: string | null;
        mode: string;
        granted: boolean;
        classid: number | null;
        objid: number | null;
        transactionid: string | null;
      }[]>`
        SELECT
          pid,
          locktype,
          relation::regclass::text AS relation,
          mode,
          granted,
          classid,
          objid,
          transactionid::text AS transactionid
        FROM pg_locks
        WHERE NOT granted
          AND (
            database IS NULL
            OR database = (SELECT oid FROM pg_database WHERE datname = current_database())
          )
        ORDER BY pid, locktype
      `,
    ]);
    const sanitizedActivity = activity.map((row) => ({
      pid: row.pid,
      app: row.application_name,
      state: row.state,
      wait_event_type: row.wait_event_type,
      wait_event: row.wait_event,
      blocking_pids: row.blocking_pids,
      query_prefix: redactQueryPrefix(row.query),
    }));
    const waitingBlockers = sanitizedActivity
      .filter((row) => row.wait_event_type !== null || row.blocking_pids.length > 0)
      .map((row) => ({
        pid: row.pid,
        wait_event_type: row.wait_event_type,
        wait_event: row.wait_event,
        blocking_pids: row.blocking_pids,
      }));
    return JSON.stringify(
      {
        step: stepName,
        pg_stat_activity: sanitizedActivity,
        ungranted_pg_locks: ungrantedLocks,
        waiting_blocking_pids: waitingBlockers,
      },
      null,
      2,
    );
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      collect(),
      new Promise<string>((resolve) => {
        timer = setTimeout(
          () => resolve(JSON.stringify({ step: stepName, diag_error: "diagnostic query timed out after 5000ms" })),
          5_000,
        );
      }),
    ]);
  } catch (err) {
    return JSON.stringify({
      step: stepName,
      diag_error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceWithTimeout<T>(
  promise: Promise<T>,
  stepName: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<T> {
  const timedOut = Symbol("timed_out");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), timeoutMs);
  });
  try {
    const winner = await Promise.race([promise, timeoutPromise]);
    if (winner === timedOut) {
      promise.catch(() => {});
      const diag = await captureLockDiagnostics(stepName);
      throw new Error(`${stepName}: timed out after ${timeoutMs}ms\n${diag}`);
    }
    return winner;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function waitForBlockedOnPid(
  blockerPid: number,
  label: string,
  advisoryOnly = false,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{
      pid: number;
      wait_event_type: string | null;
      wait_event: string | null;
      blockers: number[];
    }[]>`
      SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    const match = rows.find((r) => !advisoryOnly || r.wait_event === "advisory");
    if (match !== undefined) return match.pid;
    await delay(25);
  }
  const diag = await captureLockDiagnostics(label);
  throw new Error(
    `${label}: timed out after ${timeoutMs}ms waiting for a backend blocked on pid ${blockerPid}` +
      `${advisoryOnly ? " (advisoryOnly=true)" : ""}\n${diag}`,
  );
}

/**
 * Hold a lock on a dedicated single-connection client with bounded timeouts,
 * always rolling back the holding transaction and closing the connection in `finally`,
 * and draining any tracked in-flight requests so no lock or promise can leak.
 */
async function withHeldLock<T>(
  label: string,
  acquireLock: (tx: Tx) => Promise<void>,
  body: (ctx: {
    holderPid: number;
    releaseLock: () => Promise<void>;
    trackPending: <P>(p: Promise<P>) => Promise<P>;
  }) => Promise<T>,
): Promise<T> {
  const holderSql = openBoundedConnection(`aw-lock-${label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`, true);
  let lockReadyResolve!: (pid: number) => void;
  let lockReadyReject!: (err: unknown) => void;
  let releaseResolve!: () => void;
  let released = false;
  let holderError: unknown = null;
  const pendingRequests: Array<Promise<unknown>> = [];

  const lockReady = new Promise<number>((resolve, reject) => {
    lockReadyResolve = resolve;
    lockReadyReject = reject;
  });
  const waitRelease = new Promise<void>((resolve) => {
    releaseResolve = resolve;
  });

  const holderPromise = holderSql
    .begin(async (tx) => {
      const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await acquireLock(tx);
      lockReadyResolve(me!.pid);
      await waitRelease;
      throw RELEASE_LOCK_ROLLBACK;
    })
    .catch((err: unknown) => {
      if (err === RELEASE_LOCK_ROLLBACK) return;
      holderError = err;
      lockReadyReject(err);
      throw err;
    });
  // Avoid unhandled rejection if holder fails while body is unwinding.
  holderPromise.catch(() => {});

  const triggerRelease = (): void => {
    if (!released) {
      released = true;
      releaseResolve();
    }
  };

  const releaseLock = async (): Promise<void> => {
    triggerRelease();
    await raceWithTimeout(
      holderPromise.catch(() => {}),
      `${label}: rollback lock holder`,
      WAIT_TIMEOUT_MS,
    );
    if (holderError !== null) {
      throw holderError;
    }
  };

  const trackPending = <P>(p: Promise<P>): Promise<P> => {
    p.catch(() => {});
    pendingRequests.push(p);
    return p;
  };

  try {
    const holderPid = await raceWithTimeout(lockReady, `${label}: acquire lock`, WAIT_TIMEOUT_MS);
    return await body({ holderPid, releaseLock, trackPending });
  } finally {
    triggerRelease();
    await Promise.race([holderPromise.catch(() => {}), delay(5_000)]);
    try {
      await holderSql.end({ timeout: 2 });
    } catch {
      /* connection already closed */
    } finally {
      activeConnections.delete(holderSql);
    }
    if (pendingRequests.length > 0) {
      await Promise.race([Promise.allSettled(pendingRequests), delay(5_000)]);
    }
  }
}

async function runHeldAtAuditInsert(
  label: string,
  wsId: string,
  bearer: string,
  command: Row,
  commandId: string,
  revokeAccess: () => Promise<void>,
): Promise<{ status: number; body: Row }> {
  return withHeldLock(
    label,
    async (tx) => {
      await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
    },
    async ({ holderPid, releaseLock, trackPending }) => {
      const pendingResp = trackPending(sendCommand(bearer, wsId, command, commandId));
      await waitForBlockedOnPid(holderPid, `${label}: audit_log wait for ${String(command.kind)}`);
      await raceWithTimeout(revokeAccess(), `${label}: revokeAccess while audit_log locked`, WAIT_TIMEOUT_MS);
      await releaseLock();
      return await raceWithTimeout(pendingResp, `${label}: await command response after audit_log release`, WAIT_TIMEOUT_MS);
    },
  );
}

// Service-role helper to move an ask's deadline into the past while preserving
// swarm.signals's CHECK (until > created_at) and without taking DDL locks or
// firing triggers that would contend with a blocked in-flight command transaction.
async function expireAskNow(wsId: string, signalId: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`
      UPDATE swarm.signals
      SET created_at = clock_timestamp() - interval '2 minutes',
          until = clock_timestamp() - interval '1 second'
      WHERE workspace_id = ${wsId}::uuid
        AND id = ${signalId}::uuid
    `;
  });
}

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as Local;
}

function respDiag(label: string, resp: { status: number; body: Row }): string {
  const base = `${label}: status=${resp.status} body=${JSON.stringify(resp.body)}`;
  if (resp.status >= 500) {
    const recent = recentRedactedEdgeLogs();
    return `${base}\n--- edge output (last ${recent.length} lines, redacted) ---\n${
      recent.length > 0 ? recent.join("\n") : "(no edge output captured)"
    }`;
  }
  return base;
}

function postedSignalId(label: string, resp: { status: number; body: Row }): string {
  const sig = resp.body.signal as { id?: unknown } | undefined;
  assert.equal(typeof sig?.id, "string", `${label}: missing signal.id in ${JSON.stringify(resp.body)}`);
  return sig!.id as string;
}

async function createUser(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  return { id: created.data.user!.id, jwt: signed.data.session!.access_token };
}

async function sendCommand(
  bearer: string,
  workspaceId: string,
  command: Row,
  commandId: string = randomUUID(),
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function sendRead(
  bearer: string,
  payload: Row,
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function readWaitingViewsAs(wsId: string, userId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    const [dq] = await tx<{ r: Row }[]>`SELECT swarm_read.decision_queue(${wsId}::uuid) AS r`;
    const [dqp] = await tx<{ r: Row }[]>`SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r`;
    const [wt] = await tx<{ r: Row }[]>`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [wa] = await tx<{ r: Row }[]>`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [ho] = await tx<{ r: { workspaces: Array<{ workspace_id: string } & Row> } }[]>`SELECT swarm_read.home_overview() AS r`;
    const wsOverview = ho!.r.workspaces.find((w) => w.workspace_id === wsId) ?? null;
    return { dq: dq!.r, dqp: dqp!.r, wt: wt!.r, wa: wa!.r, wsOverview };
  });
}

async function seedBasicWorkspace(opts: {
  name: string;
  members: Array<{ user: Person; displayName: string; role: "owner" | "admin" | "member" }>;
  extraUsers?: Array<{ user: Person; displayName: string }>;
  agents?: Array<{ ownerId: string; name: string }>;
  channels?: Array<{
    slug: string;
    visibility: "open" | "private";
    createdByUserId: string;
    userMemberIds?: string[];
    agentMemberIndexes?: number[];
  }>;
}) {
  const wsId = randomUUID();
  const agents = (opts.agents ?? []).map((spec) => ({
    id: randomUUID(),
    token: `swm_agt_${randomBytes(32).toString("base64url")}`,
    ownerId: spec.ownerId,
    name: spec.name,
  }));
  const channels = (opts.channels ?? []).map((spec) => ({
    id: randomUUID(),
    ...spec,
  }));
  const ownerMember = opts.members.find((m) => m.role === "owner") ?? opts.members[0]!;

  await sql.begin(async (tx) => {
    for (const m of opts.members) {
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES (${m.user.id}::uuid, ${m.displayName})
      `;
    }
    for (const u of opts.extraUsers ?? []) {
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES (${u.user.id}::uuid, ${u.displayName})
      `;
    }
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${wsId}::uuid, ${opts.name}, ${ownerMember.user.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${wsId}::uuid, 'workspace')
    `;
    for (const m of opts.members) {
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${wsId}::uuid, ${m.user.id}::uuid, ${m.role})
      `;
    }

    if (agents.length > 0) {
      const devicesByOwner = new Map<string, string>();
      for (const a of agents) {
        let deviceId = devicesByOwner.get(a.ownerId);
        if (!deviceId) {
          deviceId = randomUUID();
          devicesByOwner.set(a.ownerId, deviceId);
          await tx`
            INSERT INTO swarm.devices (device_id, user_id, label)
            VALUES (${deviceId}::uuid, ${a.ownerId}::uuid, ${`${opts.name}-device`})
          `;
        }
        const runId = randomUUID();
        await tx`
          INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
          VALUES (${a.id}::uuid, ${wsId}::uuid, ${a.ownerId}::uuid, ${a.name})
        `;
        await tx`
          INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
          VALUES (${wsId}::uuid, ${a.id}::uuid, ${a.ownerId}::uuid, ${a.ownerId}::uuid)
          ON CONFLICT (principal_id, workspace_id) DO NOTHING
        `;
        await tx`
          INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
          VALUES (${runId}::uuid, ${a.id}::uuid, ${deviceId}::uuid)
        `;
        await tx`
          INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
          VALUES (
            ${randomUUID()}::uuid,
            ${a.id}::uuid,
            ${runId}::uuid,
            ${tx.json(["post_signal", "read_signals"])}::jsonb,
            ${createHash("sha256").update(a.token).digest()},
            statement_timestamp() + interval '1 hour',
            ${randomUUID()}::uuid
          )
        `;
      }
    }

    for (const ch of channels) {
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES (${ch.id}::uuid, ${wsId}::uuid, ${ch.slug}, ${ch.visibility}, ${ch.createdByUserId}::uuid, 'user')
      `;
      for (const userId of ch.userMemberIds ?? []) {
        await tx`
          INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
          VALUES (${ch.id}::uuid, ${wsId}::uuid, 'user', ${userId}::uuid, ${ch.createdByUserId}::uuid, 'user')
        `;
      }
      for (const agentIdx of ch.agentMemberIndexes ?? []) {
        const agent = agents[agentIdx]!;
        await tx`
          INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, agent_principal_id, added_by_principal, added_by_kind)
          VALUES (${ch.id}::uuid, ${wsId}::uuid, 'agent', ${agent.id}::uuid, ${ch.createdByUserId}::uuid, 'user')
        `;
      }
    }
  });

  const allUserIds = [
    ...opts.members.map((m) => m.user.id),
    ...(opts.extraUsers ?? []).map((u) => u.user.id),
  ];
  return {
    wsId,
    agents,
    channelsBySlug: Object.fromEntries(channels.map((ch) => [ch.slug, ch.id])) as Record<string, string>,
    cleanup: () => cleanupWorkspaceFixture(wsId, allUserIds),
  };
}

async function cleanupWorkspaceFixture(
  wsId: string,
  userIds: string[],
): Promise<void> {
  await sql.begin(async (txClean) => {
    await txClean`SET LOCAL session_replication_role = replica`;
    await txClean`DELETE FROM swarm.ask_withdrawals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.waiting_dismissals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_todos WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_member_content_roles WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.ui_actions WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.ask_reraises WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.ask_choices WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.audit_log WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.idempotency_keys WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.signal_deliveries WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.signal_recipients WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.conversation_signals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.conversation_reads WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.conversation_members WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.signals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.conversations WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.channel_members WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.channels WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.agent_tokens WHERE principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ${wsId}::uuid)`;
    await txClean`DELETE FROM swarm.agent_runs WHERE principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ${wsId}::uuid)`;
    await txClean`DELETE FROM swarm.agent_presence WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.agent_workspace_memberships WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.agent_principals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.devices WHERE user_id = ANY(${userIds}::uuid[])`;
    await txClean`DELETE FROM swarm.memberships WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.streams WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.workspaces WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.users WHERE user_id = ANY(${userIds}::uuid[])`;
    await txClean`SET LOCAL session_replication_role = origin`;
  });
  for (const userId of userIds) {
    await admin.auth.admin.deleteUser(userId);
  }
}

before(async () => {
  step("before: start local environment and supabase functions serve");
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-ask-withdrawals-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(
    envFile,
    "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\nSWARM_INTERACTIVE_REPLIES=1\n",
    { mode: 0o600 },
  );
  sql = openBoundedConnection("ask-withdrawals-test", false);
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ENV: "test" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  edgeLogRing.length = 0;
  edgeLogPartial = "";
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    const text = chunk.toString("utf8");
    functionLogs = (functionLogs + text).slice(-30_000);
    appendEdgeLogChunk(text);
    startupSeen ||= functionLogs.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observe);
  functionProcess.stderr?.on("data", observe);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    const cliNow = cliState();
    if (cliNow === "exited" || cliNow === "error") {
      throw new Error(`supabase functions serve ${cliNow} early: ${functionLogs.slice(-2000)}`);
    }
    if (Date.now() > bootDeadline) {
      throw new Error(`supabase functions serve timed out: ${functionLogs.slice(-2000)}`);
    }
    await delay(200);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local command function was not ready: ${functionLogs.slice(-2000)}`,
    cliState,
  });
  step("before: command function ready");
});

after(async () => {
  step("after: tearing down functions serve and database connections");
  if (functionProcess?.pid) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* exited */ }
    functionProcess.stdout?.destroy();
    functionProcess.stderr?.destroy();
  }
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  const conns = [...activeConnections];
  activeConnections.clear();
  await Promise.allSettled(conns.map((conn) => conn.end({ timeout: 5 })));
  step("after: teardown complete");
});

test(
  "20261125000001 passes catalog + functional proofs, rolls back cleanly, re-applies, and denies direct table access",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    step("T1: catalog + functional + direct-deny + rollback + reapply proofs");
    const directDenyCheck = ["anon", "authenticated", "swarm_read", "swarm_command"]
      .map((role) => `
        DO $deny$
        BEGIN
          EXECUTE 'SET LOCAL ROLE ${role}';
          BEGIN
            PERFORM * FROM swarm.ask_withdrawals LIMIT 1;
            RAISE EXCEPTION 'role ${role} must not read swarm.ask_withdrawals directly';
          EXCEPTION WHEN insufficient_privilege THEN
            NULL;
          END;
          RESET ROLE;
        END $deny$;
      `)
      .join("\n");

    runSql(
      sqlPhase("ask-withdraw-initial-proofs", catalogAssert(false) + "\n" + repoSql(`${proofRoot}-functional.sql`)) +
        sqlPhase("ask-withdraw-direct-deny", directDenyCheck) +
        sqlPhase("ask-withdraw-rollback", repoSql(`${proofRoot}-rollback.sql`) + "\n" + catalogAssert(true)) +
        sqlPhase(
          "ask-withdraw-reapply",
          repoSql("supabase/migrations/20261125000001_ask_withdrawals.sql") +
            "\n" +
            catalogAssert(false) +
            "\n" +
            repoSql(`${proofRoot}-functional.sql`),
        ),
    );
    step("T1: done");
  },
);

test(
  "served command + read edge: ask withdrawal, replace, my_open_asks, privacy, and HezSec C1 dismissal instance binding",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("T2: setup core workspace fixture");
    const owner = await createUser("aw-owner");
    const adminUser = await createUser("aw-admin");
    const addressee1 = await createUser("aw-addr1");
    const addressee2 = await createUser("aw-addr2");
    const stranger = await createUser("aw-stranger");

    const fx = await seedBasicWorkspace({
      name: "AskWithdrawWS",
      members: [
        { user: owner, displayName: "AskOwner", role: "owner" },
        { user: adminUser, displayName: "AskAdmin", role: "admin" },
        { user: addressee1, displayName: "AddrOne", role: "member" },
        { user: addressee2, displayName: "AddrTwo", role: "member" },
      ],
      extraUsers: [{ user: stranger, displayName: "Stranger" }],
      agents: [
        { ownerId: owner.id, name: "AgentA" },
        { ownerId: owner.id, name: "AgentB" },
      ],
      channels: [
        // Private channel with ONLY AgentA and addressee1 (owner, adminUser, addressee2 are NOT members).
        {
          slug: "aw-secret",
          visibility: "private",
          createdByUserId: addressee1.id,
          userMemberIds: [addressee1.id],
          agentMemberIndexes: [0],
        },
      ],
    });
    const wsId = fx.wsId;
    const privChId = fx.channelsBySlug["aw-secret"]!;
    const agentAId = fx.agents[0]!.id;
    const agentAToken = fx.agents[0]!.token;
    const agentBToken = fx.agents[1]!.token;

    try {
      step("T2.1: post multi-addressee ask and verify both addressees' waiting views");
      const postMulti = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: null,
        to_agent_principal_id: null,
        to: [
          { kind: "user", id: addressee1.id },
          { kind: "user", id: addressee2.id },
        ],
        in_reply_to: null,
        about: null,
        body: "Can we deploy the schema tonight?",
      });
      assert.equal(postMulti.status, 200, respDiag("postMulti", postMulti));
      const multiAskId = postedSignalId("postMulti", postMulti);

      for (const [label, user] of [["addr1", addressee1], ["addr2", addressee2]] as const) {
        const views = await readWaitingViewsAs(wsId, user.id);
        assert.equal((views.dq as { total: number }).total, 1, `${label} dq=${JSON.stringify(views.dq)}`);
        assert.equal((views.dqp as { total: number }).total, 1, `${label} dqp=${JSON.stringify(views.dqp)}`);
        assert.equal((views.wsOverview?.needs_you as { asks: unknown[] } | undefined)?.asks.length, 1, `${label} ho=${JSON.stringify(views.wsOverview)}`);
      }

      step("T2.2: uniform 404 for unknown UUID, AgentB, owner, admin; 403 for stranger");
      const unknownWithdraw = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(
        unknownWithdraw.body,
        UNKNOWN_WITHDRAW_BODY,
        respDiag("unknownWithdraw", unknownWithdraw),
      );

      for (const [label, bearer] of [
        ["agentB (same owner)", agentBToken],
        ["owner", owner.jwt],
        ["admin", adminUser.jwt],
      ] as const) {
        const denied = await sendCommand(bearer, wsId, {
          kind: "withdraw_ask",
          signal_id: multiAskId,
        });
        assert.deepEqual(
          denied,
          unknownWithdraw,
          `${label} must receive uniform 404: ${respDiag(label, denied)} vs ${respDiag("unknownWithdraw", unknownWithdraw)}`,
        );
      }

      const strangerWithdraw = await sendCommand(stranger.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: multiAskId,
      });
      assert.equal(strangerWithdraw.status, 403, respDiag("strangerWithdraw", strangerWithdraw));

      step("T2.3: addressee dismissal does not alter sender's my_open_asks");
      // The edge writes a person's profile name on their first command, which changes the name the
      // sender's list shows. Let addressee1 act once before the baseline (dismiss, then restore, which
      // leaves the ask open) so the two reads below differ only by the dismissal.
      const warmDismiss = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: multiAskId,
      });
      assert.equal(warmDismiss.status, 200, respDiag("warmDismiss", warmDismiss));
      const warmRestore = await sendCommand(addressee1.jwt, wsId, {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: multiAskId,
      });
      assert.equal(warmRestore.status, 200, respDiag("warmRestore", warmRestore));

      const openForABefore = await sendRead(agentAToken, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openForABefore.status, 200, respDiag("openForABefore", openForABefore));

      const dismissMulti = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: multiAskId,
      });
      assert.equal(dismissMulti.status, 200, respDiag("dismissMulti", dismissMulti));
      assert.equal(dismissMulti.body.created, true, respDiag("dismissMulti", dismissMulti));
      assert.equal(typeof dismissMulti.body.dismissal, "string", respDiag("dismissMulti", dismissMulti));

      const openForA = await sendRead(agentAToken, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openForA.status, 200, respDiag("openForA", openForA));
      assert.equal(
        JSON.stringify({ ...openForA.body, generated_at: null }),
        JSON.stringify({ ...openForABefore.body, generated_at: null }),
        `my_open_asks must be byte-identical before vs after addressee dismissal: before=${JSON.stringify(openForABefore.body)} after=${JSON.stringify(openForA.body)}`,
      );
      assert.doesNotMatch(JSON.stringify(openForA.body), /dismiss/i, respDiag("openForA", openForA));
      const asksA = openForA.body.asks as Array<Row>;
      assert.equal(asksA.length, 1, respDiag("openForA", openForA));
      assert.equal(asksA[0]!.signal_id, multiAskId, respDiag("openForA", openForA));
      const addresseeNames = await sql<{ display_name: string }[]>`
        SELECT display_name FROM swarm.users
        WHERE user_id IN (${addressee1.id}::uuid, ${addressee2.id}::uuid)
      `;
      assert.deepEqual(
        [...(asksA[0]!.addressees as string[])].sort(),
        addresseeNames.map((row) => row.display_name).sort(),
        respDiag("openForA", openForA),
      );
      assert.deepEqual(
        Object.keys(asksA[0]!).sort(),
        ["addressees", "body_preview", "created_at", "signal_id", "until", "where"],
        respDiag("openForA", openForA),
      );

      const openForB = await sendRead(agentBToken, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openForB.status, 200, respDiag("openForB", openForB));
      assert.deepEqual(openForB.body.asks, [], respDiag("openForB", openForB));

      step("T2.4: sender withdraws multiAskId -> leaves both queues, appears once in Archived");
      const withdraw1 = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: multiAskId,
      });
      assert.equal(withdraw1.status, 200, respDiag("withdraw1", withdraw1));
      assert.equal(withdraw1.body.withdrawn, true, respDiag("withdraw1", withdraw1));
      assert.equal(withdraw1.body.created, true, respDiag("withdraw1", withdraw1));
      assert.equal(withdraw1.body.signal_id, multiAskId, respDiag("withdraw1", withdraw1));
      assert.equal(typeof withdraw1.body.withdrawn_at, "string", respDiag("withdraw1", withdraw1));

      for (const [label, user] of [["addr1", addressee1], ["addr2", addressee2]] as const) {
        const views = await readWaitingViewsAs(wsId, user.id);
        assert.equal((views.dq as { total: number }).total, 0, `${label} dq=${JSON.stringify(views.dq)}`);
        assert.equal((views.dqp as { total: number }).total, 0, `${label} dqp=${JSON.stringify(views.dqp)}`);
        assert.equal((views.wsOverview?.needs_you as { asks: unknown[] } | undefined)?.asks.length, 0, `${label} ho=${JSON.stringify(views.wsOverview)}`);
        const archived = (views.wa as { items: Array<Row> }).items.filter((i) => i.item_key === `ask:${multiAskId}`);
        assert.equal(archived.length, 1, `${label} archived=${JSON.stringify(views.wa)}`);
        assert.equal(archived[0]!.outcome_kind, "withdrawn", `${label} archived[0]=${JSON.stringify(archived[0])}`);
        assert.equal(archived[0]!.outcome_text, "Withdrawn", `${label} archived[0]=${JSON.stringify(archived[0])}`);
      }

      step("T2.5: idempotent repeated withdraw");
      const withdraw2 = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: multiAskId,
      });
      assert.equal(withdraw2.status, 200, respDiag("withdraw2", withdraw2));
      assert.equal(withdraw2.body.withdrawn, true, respDiag("withdraw2", withdraw2));
      assert.equal(withdraw2.body.created, false, respDiag("withdraw2", withdraw2));
      assert.equal(withdraw2.body.withdrawn_at, withdraw1.body.withdrawn_at, respDiag("withdraw2", withdraw2));

      const [wdCount] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals WHERE workspace_id = ${wsId}::uuid AND signal_id = ${multiAskId}::uuid
      `;
      assert.equal(Number(wdCount!.cnt), 1, `expected 1 ask_withdrawals row, got ${wdCount!.cnt}`);

      step("T2.6: withdrawn ask cannot be answered, dismissed, restored, or re-raised");
      const expiredAskId = randomUUID();
      await sql`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, created_at, until)
        VALUES (
          ${expiredAskId}::uuid,
          ${wsId}::uuid,
          ${agentAId}::uuid,
          'agent',
          ${addressee2.id}::uuid,
          'ask',
          'Expired control ask?',
          statement_timestamp() - interval '2 minutes',
          statement_timestamp() - interval '1 minute'
        )
      `;
      const [signalsBeforeWithdrawnReply] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const replyWithdrawn = await sendCommand(addressee2.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: multiAskId,
        about: null,
        body: "Late reply",
      });
      const [signalsAfterWithdrawnReply] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(
        signalsAfterWithdrawnReply!.cnt,
        signalsBeforeWithdrawnReply!.cnt,
        "plain reply to withdrawn ask must create no signal",
      );
      const replyExpired = await sendCommand(addressee2.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: expiredAskId,
        about: null,
        body: "Late reply",
      });
      assert.equal(replyWithdrawn.status, 403, respDiag("replyWithdrawn", replyWithdrawn));
      assert.equal(replyWithdrawn.body.error, "forbidden", respDiag("replyWithdrawn", replyWithdrawn));
      assert.deepEqual(
        replyWithdrawn,
        replyExpired,
        `plain reply to withdrawn ask must match expired ask refusal: withdrawn=${respDiag("replyWithdrawn", replyWithdrawn)} expired=${respDiag("replyExpired", replyExpired)}`,
      );

      const dismissWithdrawn = await sendCommand(addressee2.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: multiAskId,
      });
      assert.equal(dismissWithdrawn.status, 404, respDiag("dismissWithdrawn", dismissWithdrawn));

      const restoreWithdrawn = await sendCommand(addressee1.jwt, wsId, {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: multiAskId,
      });
      assert.equal(restoreWithdrawn.status, 404, respDiag("restoreWithdrawn", restoreWithdrawn));

      const reraiseWithdrawn = await sendCommand(agentAToken, wsId, {
        kind: "reraise_ask",
        signal_id: multiAskId,
      });
      assert.equal(reraiseWithdrawn.status, 409, respDiag("reraiseWithdrawn", reraiseWithdrawn));
      assert.equal(reraiseWithdrawn.body.error, "ask_withdrawn", respDiag("reraiseWithdrawn", reraiseWithdrawn));

      step("T2.7: choice ask withdrawn -> answer_choice returns 409 ask_expired");
      const postChoice = await sendCommand(agentAToken, wsId, {
        kind: "ask_choice",
        to_user_id: addressee1.id,
        about: null,
        body: "Pick A or B?",
        options: [
          { id: "a", label: "Option A" },
          { id: "b", label: "Option B" },
        ],
      });
      assert.equal(postChoice.status, 200, respDiag("postChoice", postChoice));
      const choiceAskId = postedSignalId("postChoice", postChoice);
      const withdrawChoice = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: choiceAskId,
      });
      assert.equal(withdrawChoice.status, 200, respDiag("withdrawChoice", withdrawChoice));

      const answerWithdrawnChoice = await sendCommand(addressee1.jwt, wsId, {
        kind: "answer_choice",
        signal_id: choiceAskId,
        option_id: "a",
      });
      assert.equal(answerWithdrawnChoice.status, 409, respDiag("answerWithdrawnChoice", answerWithdrawnChoice));
      assert.equal(answerWithdrawnChoice.body.error, "ask_expired", respDiag("answerWithdrawnChoice", answerWithdrawnChoice));

      step("T2.8: answered ask cannot be withdrawn -> uniform 404");
      const postToAnswer = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Are you free at 3pm?",
      });
      assert.equal(postToAnswer.status, 200, respDiag("postToAnswer", postToAnswer));
      const answeredAskId = postedSignalId("postToAnswer", postToAnswer);
      const answerIt = await sendCommand(addressee1.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: answeredAskId,
        about: null,
        body: "Yes!",
      });
      assert.equal(answerIt.status, 200, respDiag("answerIt", answerIt));

      const withdrawAnswered = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: answeredAskId,
      });
      assert.deepEqual(withdrawAnswered, unknownWithdraw, respDiag("withdrawAnswered", withdrawAnswered));

      step("T2.9: replace (supersedes) creates new ask and withdraws old ask atomically");
      const postOld = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Old wording: ship Friday?",
      });
      assert.equal(postOld.status, 200, respDiag("postOld", postOld));
      const oldAskId = postedSignalId("postOld", postOld);

      const postReplacement = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Updated wording: ship Monday?",
        supersedes: oldAskId,
      });
      assert.equal(postReplacement.status, 200, respDiag("postReplacement", postReplacement));
      const newAskId = postedSignalId("postReplacement", postReplacement);
      assert.equal(postReplacement.body.superseded_signal_id, oldAskId, respDiag("postReplacement", postReplacement));
      assert.notEqual(newAskId, oldAskId);

      const viewsAfterReplace = await readWaitingViewsAs(wsId, addressee1.id);
      assert.equal((viewsAfterReplace.dq as { total: number }).total, 1, `dq=${JSON.stringify(viewsAfterReplace.dq)}`);
      const replacedArchived = (viewsAfterReplace.wa as { items: Array<Row> }).items.find((i) => i.item_key === `ask:${oldAskId}`);
      assert.ok(replacedArchived, `wa=${JSON.stringify(viewsAfterReplace.wa)}`);
      assert.equal(replacedArchived.outcome_kind, "replaced", `replacedArchived=${JSON.stringify(replacedArchived)}`);
      assert.equal(replacedArchived.outcome_text, "Replaced by a newer question", `replacedArchived=${JSON.stringify(replacedArchived)}`);

      step("T2.10: refused replace returns uniform 404 and creates nothing");
      const [signalsBeforeRefused] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const refusedReplaceOther = await sendCommand(agentBToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Should roll back completely",
        supersedes: newAskId,
      });
      assert.deepEqual(refusedReplaceOther, unknownWithdraw, respDiag("refusedReplaceOther", refusedReplaceOther));

      const refusedReplaceAlreadyWithdrawn = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Cannot supersede already-withdrawn ask",
        supersedes: oldAskId,
      });
      assert.deepEqual(refusedReplaceAlreadyWithdrawn, unknownWithdraw, respDiag("refusedReplaceAlreadyWithdrawn", refusedReplaceAlreadyWithdrawn));

      const [signalsAfterRefused] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(
        signalsAfterRefused!.cnt,
        signalsBeforeRefused!.cnt,
        `refused supersedes must roll back signal creation: before=${signalsBeforeRefused!.cnt} after=${signalsAfterRefused!.cnt}`,
      );

      step("T2.11: private-channel ask withdrawal audit privacy and Archived non-leak");
      const postPriv = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "aw-secret",
        to_user_id: addressee1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Private channel question",
      });
      assert.equal(postPriv.status, 200, respDiag("postPriv", postPriv));
      const privAskId = postedSignalId("postPriv", postPriv);

      const withdrawPriv = await sendCommand(agentAToken, wsId, {
        kind: "withdraw_ask",
        signal_id: privAskId,
      });
      assert.equal(withdrawPriv.status, 200, respDiag("withdrawPriv", withdrawPriv));

      const privAuditRows = await sql<{ audit_id: string }[]>`
        SELECT audit_id::text AS audit_id
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind = 'withdraw_ask'
          AND ${privChId}::uuid = ANY(channel_ids)
      `;
      assert.ok(privAuditRows.length >= 1, `private-channel withdraw_ask audit row must carry its channel tag, got ${JSON.stringify(privAuditRows)}`);
      const privAuditIds = privAuditRows.map((row) => row.audit_id);
      for (const [label, auditor] of [["owner", owner], ["admin", adminUser]] as const) {
        const visible = await sql.begin(async (tx) => {
          await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
          await tx`SET LOCAL ROLE authenticated`;
          return tx<{ audit_id: string }[]>`
            SELECT audit_id::text AS audit_id
            FROM swarm_read.audit_log
            WHERE workspace_id = ${wsId}::uuid
              AND command_kind = 'withdraw_ask'
          `;
        });
        const leaked = visible.filter((row) => privAuditIds.includes(row.audit_id));
        assert.equal(leaked.length, 0, `${label} must not see private-channel withdraw_ask audit rows: ${JSON.stringify(leaked)}`);
      }

      const addr2Views = await readWaitingViewsAs(wsId, addressee2.id);
      const leakedPriv = (addr2Views.wa as { items: Array<Row> }).items.find((i) => i.item_key === `ask:${privAskId}`);
      assert.equal(leakedPriv, undefined, `addr2 must not see private ask in Archived: ${JSON.stringify(addr2Views.wa)}`);

      step("T2.12: human sender reads own open asks via my_open_asks");
      const humanPost = await sendCommand(owner.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee2.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Owner asks addressee2",
      });
      assert.equal(humanPost.status, 200, respDiag("humanPost", humanPost));
      const humanAskId = postedSignalId("humanPost", humanPost);

      const openForOwner = await sendRead(owner.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openForOwner.status, 200, respDiag("openForOwner", openForOwner));
      const ownerAsks = openForOwner.body.asks as Array<Row>;
      assert.equal(ownerAsks.length, 1, respDiag("openForOwner", openForOwner));
      assert.equal(ownerAsks[0]!.signal_id, humanAskId, respDiag("openForOwner", openForOwner));

      step("T2.13: HezSec C1 dismissal instance binding");
      const d1 = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
      });
      assert.equal(d1.status, 200, respDiag("d1", d1));
      assert.equal(d1.body.created, true, respDiag("d1", d1));
      const firstDismissalId = d1.body.dismissal as string;
      assert.match(firstDismissalId, /^[0-9a-f-]{36}$/, respDiag("d1", d1));

      const d2 = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
      });
      assert.equal(d2.status, 200, respDiag("d2", d2));
      assert.equal(d2.body.created, false, respDiag("d2", d2));
      assert.equal(d2.body.dismissal, firstDismissalId, respDiag("d2", d2));
      assert.equal(d2.body.dismissed_at, d1.body.dismissed_at, respDiag("d2", d2));

      const r1 = await sendCommand(addressee1.jwt, wsId, {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
        dismissal: firstDismissalId,
      });
      assert.equal(r1.status, 200, respDiag("r1", r1));
      assert.equal(r1.body.restored, true, respDiag("r1", r1));

      const d3 = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
      });
      assert.equal(d3.status, 200, respDiag("d3", d3));
      assert.equal(d3.body.created, true, respDiag("d3", d3));
      const secondDismissalId = d3.body.dismissal as string;
      assert.notEqual(secondDismissalId, firstDismissalId, `re-dismiss must issue new instance: d3=${JSON.stringify(d3.body)} d1=${JSON.stringify(d1.body)}`);

      const rStale = await sendCommand(addressee1.jwt, wsId, {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
        dismissal: firstDismissalId,
      });
      assert.equal(rStale.status, 404, respDiag("rStale", rStale));
      assert.deepEqual(rStale.body, { error: "not_found", message: "Waiting item not found." }, respDiag("rStale", rStale));

      const viewsStillDismissed = await readWaitingViewsAs(wsId, addressee1.id);
      assert.equal((viewsStillDismissed.dq as { total: number }).total, 0, `stale restore must not un-dismiss: ${JSON.stringify(viewsStillDismissed.dq)}`);

      const rUnbound = await sendCommand(addressee1.jwt, wsId, {
        kind: "restore_waiting_item",
        item_kind: "ask",
        item_id: newAskId,
      });
      assert.equal(rUnbound.status, 200, respDiag("rUnbound", rUnbound));
      assert.equal(rUnbound.body.restored, true, respDiag("rUnbound", rUnbound));

      const viewsRestored = await readWaitingViewsAs(wsId, addressee1.id);
      assert.equal((viewsRestored.dq as { total: number }).total, 1, `unbound restore must restore item: ${JSON.stringify(viewsRestored.dq)}`);

      step("T2.14: waiting_todos_page carries offer_id on request rows and omits it on assigned rows");
      const assignedTodoId = randomUUID();
      const reviewTodoId = randomUUID();
      const reviewOfferId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`
          INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
          VALUES (${wsId}::uuid, 'shared')
        `;
        await tx`
          INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
          VALUES
            (${wsId}::uuid, ${addressee1.id}::uuid, 'editor', ${randomUUID()}::uuid, statement_timestamp()),
            (${wsId}::uuid, ${owner.id}::uuid, 'editor', ${randomUUID()}::uuid, statement_timestamp())
        `;
        await tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
            gate_kind, state_by_user, state_at, comment_count, last_seq
          ) VALUES (
            ${wsId}::uuid, ${assignedTodoId}::uuid, 1, 'Assigned task', '', 'open',
            ${owner.id}::uuid, statement_timestamp(), ${addressee1.id}::uuid, ${owner.id}::uuid, statement_timestamp(),
            'none', ${owner.id}::uuid, statement_timestamp(), 0, 1
          )
        `;
        await tx`
          INSERT INTO swarm.household_todos (
            workspace_id, todo_id, version, title, notes, state,
            created_by_user, created_at, offer_id, offer_principal, offer_decider,
            offer_start, offer_gate, offer_by_user, offered_at,
            gate_kind, state_by_user, state_at, comment_count, last_seq
          ) VALUES (
            ${wsId}::uuid, ${reviewTodoId}::uuid, 1, 'Review task', '', 'open',
            ${owner.id}::uuid, statement_timestamp(), ${reviewOfferId}::uuid, ${agentAId}::uuid, ${addressee1.id}::uuid,
            'queue', '{"kind":"none"}'::jsonb, ${owner.id}::uuid, statement_timestamp(),
            'none', ${owner.id}::uuid, statement_timestamp(), 0, 2
          )
        `;
      });

      const todoViewsBefore = await readWaitingViewsAs(wsId, addressee1.id);
      const todoRows = (todoViewsBefore.wt as { todos: Array<Row> }).todos;
      const requestRow = todoRows.find((row) => row.todo_id === reviewTodoId);
      const assignedRow = todoRows.find((row) => row.todo_id === assignedTodoId);
      assert.ok(requestRow, `missing request row in waiting_todos_page: ${JSON.stringify(todoViewsBefore.wt)}`);
      assert.ok(assignedRow, `missing assigned row in waiting_todos_page: ${JSON.stringify(todoViewsBefore.wt)}`);
      assert.equal(requestRow.reason, "request");
      assert.equal(requestRow.offer_id, reviewOfferId);
      assert.equal(assignedRow.reason, "assigned");
      assert.equal(
        Object.hasOwn(assignedRow, "offer_id"),
        false,
        `assigned to-do row must not carry offer_id key: ${JSON.stringify(assignedRow)}`,
      );

      const dismissReview = await sendCommand(addressee1.jwt, wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "review",
        item_id: requestRow.offer_id as string,
      });
      assert.equal(dismissReview.status, 200, respDiag("dismissReview", dismissReview));
      assert.equal(dismissReview.body.dismissed, true, respDiag("dismissReview", dismissReview));

      const todoViewsAfter = await readWaitingViewsAs(wsId, addressee1.id);
      const remainingIds = (todoViewsAfter.wt as { todos: Array<Row> }).todos.map((row) => row.todo_id);
      assert.deepEqual(remainingIds, [assignedTodoId], `dismissed review must leave waiting_todos_page: ${JSON.stringify(todoViewsAfter.wt)}`);
      step("T2: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C1 (group leave): leaving a group conversation revokes my_open_asks, withdraw_ask, and replace while staying-member control succeeds",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C1: setup workspace fixture");
    const sender = await createUser("awc1-sender");
    const peer1 = await createUser("awc1-peer1");
    const peer2 = await createUser("awc1-peer2");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC1WS",
      members: [
        { user: sender, displayName: "C1Sender", role: "owner" },
        { user: peer1, displayName: "C1Peer1", role: "member" },
        { user: peer2, displayName: "C1Peer2", role: "member" },
      ],
    });
    const wsId = fx.wsId;

    try {
      const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(unknownWithdraw.body, UNKNOWN_WITHDRAW_BODY, respDiag("unknownWithdraw", unknownWithdraw));

      step("C1.1: open group conversation and post asks from sender and peer1");
      const openGroup = await sendCommand(sender.jwt, wsId, {
        kind: "conversation_open",
        members: [
          { kind: "user", id: peer1.id },
          { kind: "user", id: peer2.id },
        ],
        new_group: false,
      });
      assert.equal(openGroup.status, 200, respDiag("openGroup", openGroup));
      const groupConvId = (openGroup.body.conversation as { conversation_id?: string } | undefined)?.conversation_id;
      assert.equal(typeof groupConvId, "string", respDiag("openGroup", openGroup));

      const senderGroupPost = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        conversation_id: groupConvId,
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Group ask from sender before leaving",
      });
      assert.equal(senderGroupPost.status, 200, respDiag("senderGroupPost", senderGroupPost));
      const senderGroupAskId = postedSignalId("senderGroupPost", senderGroupPost);

      const peer1GroupPost = await sendCommand(peer1.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        conversation_id: groupConvId,
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Group ask from peer1 (unchanged-access control)",
      });
      assert.equal(peer1GroupPost.status, 200, respDiag("peer1GroupPost", peer1GroupPost));
      const peer1GroupAskId = postedSignalId("peer1GroupPost", peer1GroupPost);

      step("C1.2: sender sees ask before leaving, then leaves group");
      const senderOpenBeforeLeave = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(senderOpenBeforeLeave.status, 200, respDiag("senderOpenBeforeLeave", senderOpenBeforeLeave));
      assert.ok(
        (senderOpenBeforeLeave.body.asks as Array<Row>).some((a) => a.signal_id === senderGroupAskId),
        `sender must see group ask before leaving: ${respDiag("senderOpenBeforeLeave", senderOpenBeforeLeave)}`,
      );

      const leaveGroup = await sendCommand(sender.jwt, wsId, {
        kind: "conversation_leave",
        conversation_id: groupConvId,
      });
      assert.equal(leaveGroup.status, 200, respDiag("leaveGroup", leaveGroup));

      step("C1.3: former member loses my_open_asks, withdraw_ask, and replace");
      const senderOpenAfterLeave = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(senderOpenAfterLeave.status, 200, respDiag("senderOpenAfterLeave", senderOpenAfterLeave));
      assert.equal(
        (senderOpenAfterLeave.body.asks as Array<Row>).some((a) => a.signal_id === senderGroupAskId),
        false,
        `former group member must not see group ask in my_open_asks: ${respDiag("senderOpenAfterLeave", senderOpenAfterLeave)}`,
      );

      const [sigCountBeforeLeftReplace] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const withdrawAfterLeave = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: senderGroupAskId,
      });
      assert.deepEqual(
        withdrawAfterLeave,
        unknownWithdraw,
        `withdraw_ask after leaving group must return uniform 404: ${respDiag("withdrawAfterLeave", withdrawAfterLeave)}`,
      );

      const replaceAfterLeave = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Attempted replacement after leaving group",
        supersedes: senderGroupAskId,
      });
      assert.deepEqual(
        replaceAfterLeave,
        unknownWithdraw,
        `replacing post after leaving group must return uniform 404: ${respDiag("replaceAfterLeave", replaceAfterLeave)}`,
      );

      const [leftWdCount] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${senderGroupAskId}::uuid
      `;
      assert.equal(Number(leftWdCount!.cnt), 0, `no withdrawal row may exist after refused group-leave attempts: cnt=${leftWdCount!.cnt}`);
      const [sigCountAfterLeftReplace] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(
        sigCountAfterLeftReplace!.cnt,
        sigCountBeforeLeftReplace!.cnt,
        `refused group-leave replacement must create no signal: before=${sigCountBeforeLeftReplace!.cnt} after=${sigCountAfterLeftReplace!.cnt}`,
      );

      step("C1.4: unchanged-access control in the same group succeeds");
      const peer1OpenControl = await sendRead(peer1.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(peer1OpenControl.status, 200, respDiag("peer1OpenControl", peer1OpenControl));
      assert.ok(
        (peer1OpenControl.body.asks as Array<Row>).some((a) => a.signal_id === peer1GroupAskId),
        `peer1 control ask must appear in my_open_asks: ${respDiag("peer1OpenControl", peer1OpenControl)}`,
      );
      const peer1WithdrawControl = await sendCommand(peer1.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: peer1GroupAskId,
      });
      assert.equal(peer1WithdrawControl.status, 200, respDiag("peer1WithdrawControl", peer1WithdrawControl));
      assert.equal(peer1WithdrawControl.body.withdrawn, true, respDiag("peer1WithdrawControl", peer1WithdrawControl));
      step("C1: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C2a-C2b (completion rule): completed unaddressed choice ask and directly-addressed agent reply leave my_open_asks and refuse withdraw/replace",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C2ab: setup workspace fixture");
    const owner = await createUser("awc2ab-owner");
    const sender = await createUser("awc2ab-sender");
    const peer1 = await createUser("awc2ab-peer1");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC2CompWS",
      members: [
        { user: owner, displayName: "C2CompOwner", role: "owner" },
        { user: sender, displayName: "C2CompSender", role: "member" },
        { user: peer1, displayName: "C2CompPeer1", role: "member" },
      ],
      agents: [{ ownerId: owner.id, name: "CondAgentA" }],
    });
    const wsId = fx.wsId;
    const agentAId = fx.agents[0]!.id;
    const agentAToken = fx.agents[0]!.token;

    try {
      const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(unknownWithdraw.body, UNKNOWN_WITHDRAW_BODY, respDiag("unknownWithdraw", unknownWithdraw));

      step("C2a: unaddressed choice ask completed by a click -> not open, cannot withdraw/replace");
      const openChoicePost = await sendCommand(sender.jwt, wsId, {
        kind: "ask_choice",
        to_user_id: null,
        about: null,
        body: "Anyone: red or blue?",
        options: [
          { id: "red", label: "Red" },
          { id: "blue", label: "Blue" },
        ],
      });
      assert.equal(openChoicePost.status, 200, respDiag("openChoicePost", openChoicePost));
      const openChoiceAskId = postedSignalId("openChoicePost", openChoicePost);

      const openBeforeChoice = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openBeforeChoice.status, 200, respDiag("openBeforeChoice", openBeforeChoice));
      assert.ok(
        (openBeforeChoice.body.asks as Array<Row>).some((a) => a.signal_id === openChoiceAskId),
        `unaddressed choice ask should be listed before click: ${respDiag("openBeforeChoice", openBeforeChoice)}`,
      );

      const clickOpenChoice = await sendCommand(peer1.jwt, wsId, {
        kind: "answer_choice",
        signal_id: openChoiceAskId,
        option_id: "red",
      });
      assert.equal(clickOpenChoice.status, 200, respDiag("clickOpenChoice", clickOpenChoice));

      const openAfterChoice = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openAfterChoice.status, 200, respDiag("openAfterChoice", openAfterChoice));
      assert.equal(
        (openAfterChoice.body.asks as Array<Row>).some((a) => a.signal_id === openChoiceAskId),
        false,
        `completed unaddressed choice ask must leave my_open_asks: ${respDiag("openAfterChoice", openAfterChoice)}`,
      );
      const withdrawCompletedChoice = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: openChoiceAskId,
      });
      assert.deepEqual(
        withdrawCompletedChoice,
        unknownWithdraw,
        `withdraw of completed unaddressed choice ask must return uniform 404: ${respDiag("withdrawCompletedChoice", withdrawCompletedChoice)}`,
      );
      const replaceCompletedChoice = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Must refuse replacing completed choice",
        supersedes: openChoiceAskId,
      });
      assert.deepEqual(
        replaceCompletedChoice,
        unknownWithdraw,
        `replace of completed unaddressed choice ask must return uniform 404: ${respDiag("replaceCompletedChoice", replaceCompletedChoice)}`,
      );

      step("C2b: ask addressed directly to an agent, which replies -> not open, cannot withdraw/replace");
      const askToAgent = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: null,
        to_agent_principal_id: agentAId,
        in_reply_to: null,
        about: null,
        body: "CondAgentA, is the build green?",
      });
      assert.equal(askToAgent.status, 200, respDiag("askToAgent", askToAgent));
      const askToAgentId = postedSignalId("askToAgent", askToAgent);

      const openBeforeAgentReply = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openBeforeAgentReply.status, 200, respDiag("openBeforeAgentReply", openBeforeAgentReply));
      assert.ok(
        (openBeforeAgentReply.body.asks as Array<Row>).some((a) => a.signal_id === askToAgentId),
        `ask to agent should be listed before agent replies: ${respDiag("openBeforeAgentReply", openBeforeAgentReply)}`,
      );

      const agentReplies = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: askToAgentId,
        about: null,
        body: "Yes, build is green.",
      });
      assert.equal(agentReplies.status, 200, respDiag("agentReplies", agentReplies));

      const openAfterAgentReply = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
      assert.equal(openAfterAgentReply.status, 200, respDiag("openAfterAgentReply", openAfterAgentReply));
      assert.equal(
        (openAfterAgentReply.body.asks as Array<Row>).some((a) => a.signal_id === askToAgentId),
        false,
        `agent-answered ask must leave my_open_asks: ${respDiag("openAfterAgentReply", openAfterAgentReply)}`,
      );
      const withdrawAgentAnswered = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: askToAgentId,
      });
      assert.deepEqual(
        withdrawAgentAnswered,
        unknownWithdraw,
        `withdraw of agent-answered ask must return uniform 404: ${respDiag("withdrawAgentAnswered", withdrawAgentAnswered)}`,
      );
      const replaceAgentAnswered = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: null,
        to_agent_principal_id: agentAId,
        in_reply_to: null,
        about: null,
        body: "Must refuse replacing agent-answered ask",
        supersedes: askToAgentId,
      });
      assert.deepEqual(
        replaceAgentAnswered,
        unknownWithdraw,
        `replace of agent-answered ask must return uniform 404: ${respDiag("replaceAgentAnswered", replaceAgentAnswered)}`,
      );
      step("C2ab: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C2c-C2e (held-lock races): withdraw vs reraise (both orders) and answer_choice vs withdraw serialize cleanly",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C2races: setup workspace fixture");
    const sender = await createUser("awc2r-sender");
    const peer1 = await createUser("awc2r-peer1");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC2RaceWS",
      members: [
        { user: sender, displayName: "C2RaceSender", role: "owner" },
        { user: peer1, displayName: "C2RacePeer1", role: "member" },
      ],
    });
    const wsId = fx.wsId;

    try {
      const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(unknownWithdraw.body, UNKNOWN_WITHDRAW_BODY, respDiag("unknownWithdraw", unknownWithdraw));

      // C2c: Held-lock race Order 1 — withdraw acquires answer_choice lock first and commits;
      //      concurrent reraise blocks on withdraw's transaction (at lockLocalAuthPlan before
      //      reaching answer_choice), wakes up, gets 409 ask_withdrawn, no reminder.
      step("C2c: held-lock race Order 1 (withdraw first vs reraise)");
      const racePost1 = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Race 1: withdraw first vs reraise",
      });
      assert.equal(racePost1.status, 200, respDiag("racePost1", racePost1));
      const raceAsk1 = postedSignalId("racePost1", racePost1);

      const [wdResp1, rrResp1] = await withHeldLock(
        "C2c-withdraw-vs-reraise",
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`withdraw_ask:${wsId}:${raceAsk1}`}, 0))`;
        },
        async ({ holderPid, releaseLock, trackPending }) => {
          const withdrawPending = trackPending(sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceAsk1 }));
          const withdrawPid = await waitForBlockedOnPid(holderPid, "C2c withdraw_ask waiting on withdraw_ask lock", true);
          // Non-blocking check proves withdraw_ask acquired the shared answer_choice lock before blocking on withdraw_ask.
          const [tryAnswerChoice] = await sql<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`answer_choice:${wsId}:${raceAsk1}`}, 0)) AS acquired
          `;
          assert.equal(tryAnswerChoice?.acquired, false, "C2c withdraw_ask must hold answer_choice advisory lock while waiting on withdraw_ask lock");
          const reraisePending = trackPending(sendCommand(sender.jwt, wsId, { kind: "reraise_ask", signal_id: raceAsk1 }));
          // Served human commands serialize on lockLocalAuthPlan row locks (wait_event='transactionid') before handler locks.
          await waitForBlockedOnPid(withdrawPid, "C2c reraise_ask waiting on withdraw_ask transaction", false);
          await releaseLock();
          return await raceWithTimeout(
            Promise.all([withdrawPending, reraisePending]),
            "C2c await withdraw_ask and reraise_ask after lock release",
          );
        },
      );
      assert.equal(wdResp1.status, 200, respDiag("C2c wdResp", wdResp1));
      assert.equal(wdResp1.body.withdrawn, true, respDiag("C2c wdResp", wdResp1));
      assert.equal(rrResp1.status, 409, respDiag("C2c rrResp", rrResp1));
      assert.equal(rrResp1.body.error, "ask_withdrawn", respDiag("C2c rrResp", rrResp1));

      const [remCount] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals
        WHERE workspace_id = ${wsId}::uuid AND in_reply_to = ${raceAsk1}::uuid
      `;
      assert.equal(Number(remCount!.cnt), 0, `no reminder signal may be enqueued for withdrawn ask ${raceAsk1}: cnt=${remCount!.cnt}`);
      const [rrRowCount] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_reraises
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${raceAsk1}::uuid
      `;
      assert.equal(Number(rrRowCount!.cnt), 0, `no ask_reraises row may exist for withdrawn ask ${raceAsk1}: cnt=${rrRowCount!.cnt}`);

      // C2d: Held-lock race Order 2 — reraise acquires answer_choice lock first and commits;
      //      concurrent withdraw blocks until reraise commits (serialized strictly after).
      step("C2d: held-lock race Order 2 (reraise first vs withdraw)");
      const racePost2 = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Race 2: reraise first vs withdraw",
      });
      assert.equal(racePost2.status, 200, respDiag("racePost2", racePost2));
      const raceAsk2 = postedSignalId("racePost2", racePost2);

      const [rrResp2, wdResp2] = await withHeldLock(
        "C2d-reraise-vs-withdraw",
        async (tx) => {
          await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`reraise_ask:${wsId}:${raceAsk2}`}, 0))`;
        },
        async ({ holderPid, releaseLock, trackPending }) => {
          const reraisePending = trackPending(sendCommand(sender.jwt, wsId, { kind: "reraise_ask", signal_id: raceAsk2 }));
          const reraisePid = await waitForBlockedOnPid(holderPid, "C2d reraise_ask waiting on reraise_ask lock", true);
          // Non-blocking check proves reraise_ask acquired the shared answer_choice lock before blocking on reraise_ask.
          const [tryAnswerChoice] = await sql<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`answer_choice:${wsId}:${raceAsk2}`}, 0)) AS acquired
          `;
          assert.equal(tryAnswerChoice?.acquired, false, "C2d reraise_ask must hold answer_choice advisory lock while waiting on reraise_ask lock");
          const withdrawPending = trackPending(sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceAsk2 }));
          await waitForBlockedOnPid(reraisePid, "C2d withdraw_ask waiting on reraise_ask transaction", false);
          await releaseLock();
          return await raceWithTimeout(
            Promise.all([reraisePending, withdrawPending]),
            "C2d await reraise_ask and withdraw_ask after lock release",
          );
        },
      );
      assert.equal(rrResp2.status, 200, respDiag("C2d rrResp", rrResp2));
      assert.equal(wdResp2.status, 200, respDiag("C2d wdResp", wdResp2));
      assert.equal(wdResp2.body.withdrawn, true, respDiag("C2d wdResp", wdResp2));

      const [timing] = await sql<{ rem_at: Date; wd_at: Date }[]>`
        SELECT r.last_raised_at AS rem_at, aw.withdrawn_at AS wd_at
        FROM swarm.ask_reraises AS r
        JOIN swarm.ask_withdrawals AS aw
          ON aw.workspace_id = r.workspace_id AND aw.signal_id = r.signal_id
        WHERE r.workspace_id = ${wsId}::uuid AND r.signal_id = ${raceAsk2}::uuid
      `;
      assert.ok(timing, `both reraise and serialized withdrawal rows must exist for ${raceAsk2}`);
      assert.ok(
        timing.wd_at.getTime() >= timing.rem_at.getTime(),
        `withdrawal must commit at or after serialized reraise: rem=${timing.rem_at.toISOString()} wd=${timing.wd_at.toISOString()}`,
      );

      // C2e: Held-lock race — answer_choice commits first while withdraw blocks on answer_choice's transaction -> withdraw refused 404.
      step("C2e: held-lock race Order 3 (answer_choice first vs withdraw)");
      const raceChoicePost = await sendCommand(sender.jwt, wsId, {
        kind: "ask_choice",
        to_user_id: peer1.id,
        about: null,
        body: "Race 3: choice answer first vs withdraw",
        options: [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ],
      });
      assert.equal(raceChoicePost.status, 200, respDiag("raceChoicePost", raceChoicePost));
      const raceChoiceAskId = postedSignalId("raceChoicePost", raceChoicePost);

      const [ansResp3, wdResp3] = await withHeldLock(
        "C2e-answer-vs-withdraw",
        async (tx) => {
          await tx`LOCK TABLE swarm.ui_actions IN EXCLUSIVE MODE`;
        },
        async ({ holderPid, releaseLock, trackPending }) => {
          const ansPending = trackPending(sendCommand(peer1.jwt, wsId, {
            kind: "answer_choice",
            signal_id: raceChoiceAskId,
            option_id: "yes",
          }));
          const ansPid = await waitForBlockedOnPid(holderPid, "C2e answer_choice waiting on ui_actions", false);
          // Non-blocking check proves answer_choice holds the shared answer_choice advisory lock before writing ui_actions.
          const [tryAnswerChoice] = await sql<{ acquired: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${`answer_choice:${wsId}:${raceChoiceAskId}`}, 0)) AS acquired
          `;
          assert.equal(tryAnswerChoice?.acquired, false, "C2e answer_choice must hold answer_choice advisory lock while waiting on ui_actions");
          const withdrawPending = trackPending(sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceChoiceAskId }));
          await waitForBlockedOnPid(ansPid, "C2e withdraw_ask waiting on answer_choice transaction", false);
          await releaseLock();
          return await raceWithTimeout(
            Promise.all([ansPending, withdrawPending]),
            "C2e await answer_choice and withdraw_ask after lock release",
          );
        },
      );
      assert.equal(ansResp3.status, 200, respDiag("C2e ansResp", ansResp3));
      assert.deepEqual(wdResp3, unknownWithdraw, respDiag("C2e wdResp", wdResp3));
      const [wdRows] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${raceChoiceAskId}::uuid
      `;
      assert.equal(Number(wdRows!.cnt), 0, `withdraw lost to answer_choice must leave 0 rows: cnt=${wdRows!.cnt}`);
      step("C2races: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C3a-C3c & C3e (release recheck): access loss or deadline expiry during blocked audit_log INSERT rolls back completely",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C3release: setup workspace fixture");
    const sender = await createUser("awc3rel-sender");
    const peer1 = await createUser("awc3rel-peer1");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC3RelWS",
      members: [
        { user: sender, displayName: "C3RelSender", role: "owner" },
        { user: peer1, displayName: "C3RelPeer1", role: "member" },
      ],
      channels: [
        { slug: "c3-pub", visibility: "open", createdByUserId: sender.id },
        { slug: "c3-audit-1", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-audit-2", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-audit-3", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
      ],
    });
    const wsId = fx.wsId;
    const privChAudit1 = fx.channelsBySlug["c3-audit-1"]!;
    const privChAudit2 = fx.channelsBySlug["c3-audit-2"]!;
    const privChAudit3 = fx.channelsBySlug["c3-audit-3"]!;

    try {
      const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(unknownWithdraw.body, UNKNOWN_WITHDRAW_BODY, respDiag("unknownWithdraw", unknownWithdraw));

      step("C3a: standalone withdraw_ask blocked at audit_log INSERT + channel access loss");
      const c3Ask1Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-audit-1",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 standalone audit-wait ask",
      });
      assert.equal(c3Ask1Post.status, 200, respDiag("c3Ask1Post", c3Ask1Post));
      const c3Ask1Id = postedSignalId("c3Ask1Post", c3Ask1Post);

      const c3StandaloneCmdId = randomUUID();
      const c3StandaloneResp = await runHeldAtAuditInsert(
        "C3a-standalone-access-loss",
        wsId,
        sender.jwt,
        { kind: "withdraw_ask", signal_id: c3Ask1Id },
        c3StandaloneCmdId,
        async () => {
          await sql`
            DELETE FROM swarm.channel_members
            WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChAudit1}::uuid AND user_id = ${sender.id}::uuid
          `;
        },
      );
      assert.deepEqual(
        c3StandaloneResp,
        unknownWithdraw,
        `C3 standalone audit-wait revocation must return uniform 404: ${respDiag("c3StandaloneResp", c3StandaloneResp)}`,
      );
      const [c3Wd1] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${c3Ask1Id}::uuid
      `;
      assert.equal(Number(c3Wd1!.cnt), 0, `C3 standalone rollback must leave 0 withdrawal rows: cnt=${c3Wd1!.cnt}`);
      const [c3Rcpt1] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${c3StandaloneCmdId}
      `;
      assert.equal(Number(c3Rcpt1!.cnt), 0, `C3 standalone rollback must leave 0 receipts: cnt=${c3Rcpt1!.cnt}`);

      step("C3b: post_signal replacement blocked at audit_log INSERT + old-ask channel access loss");
      const c3Ask2Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-audit-2",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 post_signal replacement audit-wait old ask",
      });
      assert.equal(c3Ask2Post.status, 200, respDiag("c3Ask2Post", c3Ask2Post));
      const c3Ask2Id = postedSignalId("c3Ask2Post", c3Ask2Post);

      const [c3SigCountBefore2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const c3ReplacePostCmdId = randomUUID();
      const c3ReplacePostResp = await runHeldAtAuditInsert(
        "C3b-post-replace-access-loss",
        wsId,
        sender.jwt,
        {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: peer1.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "C3 post_signal replacement must roll back",
          supersedes: c3Ask2Id,
        },
        c3ReplacePostCmdId,
        async () => {
          await sql`
            DELETE FROM swarm.channel_members
            WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChAudit2}::uuid AND user_id = ${sender.id}::uuid
          `;
        },
      );
      assert.deepEqual(
        c3ReplacePostResp,
        unknownWithdraw,
        `C3 post_signal replacement audit-wait revocation must return uniform 404: ${respDiag("c3ReplacePostResp", c3ReplacePostResp)}`,
      );
      const [c3SigCountAfter2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(c3SigCountAfter2!.cnt, c3SigCountBefore2!.cnt, `C3 post_signal rollback must leave 0 new signals: before=${c3SigCountBefore2!.cnt} after=${c3SigCountAfter2!.cnt}`);
      const [c3Wd2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${c3Ask2Id}::uuid
      `;
      assert.equal(Number(c3Wd2!.cnt), 0, `C3 post_signal rollback must leave 0 withdrawal rows: cnt=${c3Wd2!.cnt}`);
      const [c3Rcpt2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${c3ReplacePostCmdId}
      `;
      assert.equal(Number(c3Rcpt2!.cnt), 0, `C3 post_signal rollback must leave 0 receipts: cnt=${c3Rcpt2!.cnt}`);

      step("C3c: ask_choice replacement blocked at audit_log INSERT + old-ask channel access loss");
      const c3Ask3Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-audit-3",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 ask_choice replacement audit-wait old ask",
      });
      assert.equal(c3Ask3Post.status, 200, respDiag("c3Ask3Post", c3Ask3Post));
      const c3Ask3Id = postedSignalId("c3Ask3Post", c3Ask3Post);

      const [c3SigCountBefore3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const c3ReplaceChoiceCmdId = randomUUID();
      const c3ReplaceChoiceResp = await runHeldAtAuditInsert(
        "C3c-choice-replace-access-loss",
        wsId,
        sender.jwt,
        {
          kind: "ask_choice",
          to_user_id: peer1.id,
          about: null,
          body: "C3 choice replacement must roll back",
          options: [
            { id: "x", label: "X" },
            { id: "y", label: "Y" },
          ],
          supersedes: c3Ask3Id,
        },
        c3ReplaceChoiceCmdId,
        async () => {
          await sql`
            DELETE FROM swarm.channel_members
            WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChAudit3}::uuid AND user_id = ${sender.id}::uuid
          `;
        },
      );
      assert.deepEqual(
        c3ReplaceChoiceResp,
        unknownWithdraw,
        `C3 ask_choice replacement audit-wait revocation must return uniform 404: ${respDiag("c3ReplaceChoiceResp", c3ReplaceChoiceResp)}`,
      );
      const [c3SigCountAfter3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(c3SigCountAfter3!.cnt, c3SigCountBefore3!.cnt, `C3 ask_choice rollback must leave 0 new signals: before=${c3SigCountBefore3!.cnt} after=${c3SigCountAfter3!.cnt}`);
      const [c3Wd3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${c3Ask3Id}::uuid
      `;
      assert.equal(Number(c3Wd3!.cnt), 0, `C3 ask_choice rollback must leave 0 withdrawal rows: cnt=${c3Wd3!.cnt}`);
      const [c3Rcpt3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${c3ReplaceChoiceCmdId}
      `;
      assert.equal(Number(c3Rcpt3!.cnt), 0, `C3 ask_choice rollback must leave 0 receipts: cnt=${c3Rcpt3!.cnt}`);

      step("C3e-1: standalone withdraw_ask blocked at audit_log INSERT + deadline expiry");
      const dlStandaloneAsk = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 fresh deadline rollback standalone ask",
      });
      assert.equal(dlStandaloneAsk.status, 200, respDiag("dlStandaloneAsk", dlStandaloneAsk));
      const dlStandaloneAskId = postedSignalId("dlStandaloneAsk", dlStandaloneAsk);

      const dlStandaloneCmdId = randomUUID();
      const dlStandaloneResp = await runHeldAtAuditInsert(
        "C3e1-standalone-deadline",
        wsId,
        sender.jwt,
        { kind: "withdraw_ask", signal_id: dlStandaloneAskId },
        dlStandaloneCmdId,
        () => expireAskNow(wsId, dlStandaloneAskId),
      );
      assert.deepEqual(
        dlStandaloneResp,
        unknownWithdraw,
        `Detail 1 standalone deadline expiry during audit wait must return uniform 404: ${respDiag("dlStandaloneResp", dlStandaloneResp)}`,
      );
      const [dlWd1] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${dlStandaloneAskId}::uuid
      `;
      assert.equal(Number(dlWd1!.cnt), 0, `Detail 1 standalone deadline rollback must leave 0 withdrawal rows: cnt=${dlWd1!.cnt}`);
      const [dlRcpt1] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${dlStandaloneCmdId}
      `;
      assert.equal(Number(dlRcpt1!.cnt), 0, `Detail 1 standalone deadline rollback must leave 0 receipts: cnt=${dlRcpt1!.cnt}`);

      step("C3e-2: post_signal replacement blocked at audit_log INSERT + deadline expiry");
      const dlPostOld = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 fresh deadline rollback post_signal old ask",
      });
      assert.equal(dlPostOld.status, 200, respDiag("dlPostOld", dlPostOld));
      const dlPostOldId = postedSignalId("dlPostOld", dlPostOld);

      const [dlSigBefore2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const dlPostCmdId = randomUUID();
      const dlPostResp = await runHeldAtAuditInsert(
        "C3e2-post-replace-deadline",
        wsId,
        sender.jwt,
        {
          kind: "post_signal",
          signal_kind: "ask",
          channel: "c3-pub",
          to_user_id: peer1.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Detail 1 post_signal replacement must roll back on deadline expiry",
          supersedes: dlPostOldId,
        },
        dlPostCmdId,
        () => expireAskNow(wsId, dlPostOldId),
      );
      assert.deepEqual(
        dlPostResp,
        unknownWithdraw,
        `Detail 1 post_signal replacement deadline expiry during audit wait must return uniform 404: ${respDiag("dlPostResp", dlPostResp)}`,
      );
      const [dlSigAfter2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(dlSigAfter2!.cnt, dlSigBefore2!.cnt, `Detail 1 post_signal deadline rollback must leave 0 new signals: before=${dlSigBefore2!.cnt} after=${dlSigAfter2!.cnt}`);
      const [dlWd2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${dlPostOldId}::uuid
      `;
      assert.equal(Number(dlWd2!.cnt), 0, `Detail 1 post_signal deadline rollback must leave 0 withdrawal rows: cnt=${dlWd2!.cnt}`);
      const [dlRcpt2] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${dlPostCmdId}
      `;
      assert.equal(Number(dlRcpt2!.cnt), 0, `Detail 1 post_signal deadline rollback must leave 0 receipts: cnt=${dlRcpt2!.cnt}`);

      step("C3e-3: ask_choice replacement blocked at audit_log INSERT + deadline expiry");
      const dlChoiceOld = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 fresh deadline rollback ask_choice old ask",
      });
      assert.equal(dlChoiceOld.status, 200, respDiag("dlChoiceOld", dlChoiceOld));
      const dlChoiceOldId = postedSignalId("dlChoiceOld", dlChoiceOld);

      const [dlSigBefore3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      const dlChoiceCmdId = randomUUID();
      const dlChoiceResp = await runHeldAtAuditInsert(
        "C3e3-choice-replace-deadline",
        wsId,
        sender.jwt,
        {
          kind: "ask_choice",
          channel: "c3-pub",
          to_user_id: peer1.id,
          about: null,
          body: "Detail 1 ask_choice replacement must roll back on deadline expiry",
          options: [
            { id: "d1", label: "D1" },
            { id: "d2", label: "D2" },
          ],
          supersedes: dlChoiceOldId,
        },
        dlChoiceCmdId,
        () => expireAskNow(wsId, dlChoiceOldId),
      );
      assert.deepEqual(
        dlChoiceResp,
        unknownWithdraw,
        `Detail 1 ask_choice replacement deadline expiry during audit wait must return uniform 404: ${respDiag("dlChoiceResp", dlChoiceResp)}`,
      );
      const [dlSigAfter3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.signals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(dlSigAfter3!.cnt, dlSigBefore3!.cnt, `Detail 1 ask_choice deadline rollback must leave 0 new signals: before=${dlSigBefore3!.cnt} after=${dlSigAfter3!.cnt}`);
      const [dlWd3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${dlChoiceOldId}::uuid
      `;
      assert.equal(Number(dlWd3!.cnt), 0, `Detail 1 ask_choice deadline rollback must leave 0 withdrawal rows: cnt=${dlWd3!.cnt}`);
      const [dlRcpt3] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid AND command_id = ${dlChoiceCmdId}
      `;
      assert.equal(Number(dlRcpt3!.cnt), 0, `Detail 1 ask_choice deadline rollback must leave 0 receipts: cnt=${dlRcpt3!.cnt}`);
      step("C3release: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C3d & C3f (replay): replay succeeds with intact access, fails closed after access loss, and skips deadline check",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C3replay: setup workspace fixture");
    const sender = await createUser("awc3rep-sender");
    const peer1 = await createUser("awc3rep-peer1");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC3RepWS",
      members: [
        { user: sender, displayName: "C3RepSender", role: "owner" },
        { user: peer1, displayName: "C3RepPeer1", role: "member" },
      ],
      channels: [
        { slug: "c3-rep-pub", visibility: "open", createdByUserId: sender.id },
        { slug: "c3-replay-1", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-replay-2", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-replay-dest", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-replay-3", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
        { slug: "c3-replay-strip-dest", visibility: "private", createdByUserId: peer1.id, userMemberIds: [sender.id, peer1.id] },
      ],
    });
    const wsId = fx.wsId;
    const privChReplay1 = fx.channelsBySlug["c3-replay-1"]!;
    const privChReplay2 = fx.channelsBySlug["c3-replay-2"]!;
    const privChReplayDest = fx.channelsBySlug["c3-replay-dest"]!;
    const privChReplay3 = fx.channelsBySlug["c3-replay-3"]!;
    const privChReplayStripDest = fx.channelsBySlug["c3-replay-strip-dest"]!;

    try {
      const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
        kind: "withdraw_ask",
        signal_id: randomUUID(),
      });
      assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
      assert.deepEqual(unknownWithdraw.body, UNKNOWN_WITHDRAW_BODY, respDiag("unknownWithdraw", unknownWithdraw));

      step("C3d-1: standalone withdraw_ask replay before and after channel access loss");
      const rAsk1Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-replay-1",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay standalone ask",
      });
      assert.equal(rAsk1Post.status, 200, respDiag("rAsk1Post", rAsk1Post));
      const rAsk1Id = postedSignalId("rAsk1Post", rAsk1Post);

      const replayCmd1 = randomUUID();
      const wdFresh1 = await sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: rAsk1Id }, replayCmd1);
      assert.equal(wdFresh1.status, 200, respDiag("wdFresh1", wdFresh1));
      const wdReplayOk1 = await sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: rAsk1Id }, replayCmd1);
      assert.equal(wdReplayOk1.status, 200, respDiag("wdReplayOk1", wdReplayOk1));
      assert.equal(wdReplayOk1.body.signal_id, rAsk1Id, respDiag("wdReplayOk1", wdReplayOk1));
      assert.equal(wdReplayOk1.body.withdrawn_at, wdFresh1.body.withdrawn_at, respDiag("wdReplayOk1", wdReplayOk1));

      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplay1}::uuid AND user_id = ${sender.id}::uuid
      `;
      const wdReplayDenied1 = await sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: rAsk1Id }, replayCmd1);
      assert.deepEqual(
        wdReplayDenied1,
        unknownWithdraw,
        `C3 standalone replay after access loss must return uniform 404 with no stored fields: ${respDiag("wdReplayDenied1", wdReplayDenied1)}`,
      );

      step("C3d-2a: post_signal replacement replay before and after old-ask access loss");
      const rAsk2Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-replay-2",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay post_signal old ask",
      });
      assert.equal(rAsk2Post.status, 200, respDiag("rAsk2Post", rAsk2Post));
      const rAsk2Id = postedSignalId("rAsk2Post", rAsk2Post);

      const replayCmd2 = randomUUID();
      const repPostCmd2 = {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay post_signal replacement",
        supersedes: rAsk2Id,
      };
      const repFresh2 = await sendCommand(sender.jwt, wsId, repPostCmd2, replayCmd2);
      assert.equal(repFresh2.status, 200, respDiag("repFresh2", repFresh2));
      const repReplayOk2 = await sendCommand(sender.jwt, wsId, repPostCmd2, replayCmd2);
      assert.equal(repReplayOk2.status, 200, respDiag("repReplayOk2", repReplayOk2));
      assert.equal(postedSignalId("repReplayOk2", repReplayOk2), postedSignalId("repFresh2", repFresh2), respDiag("repReplayOk2", repReplayOk2));
      assert.equal(repReplayOk2.body.superseded_signal_id, rAsk2Id, respDiag("repReplayOk2", repReplayOk2));

      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplay2}::uuid AND user_id = ${sender.id}::uuid
      `;
      const repReplayDenied2 = await sendCommand(sender.jwt, wsId, repPostCmd2, replayCmd2);
      assert.deepEqual(
        repReplayDenied2,
        unknownWithdraw,
        `C3 post_signal replacement replay after old-ask access loss must return uniform 404: ${respDiag("repReplayDenied2", repReplayDenied2)}`,
      );

      step("C3d-2b: post_signal replacement replay before and after destination-channel access loss");
      const rAsk2DestOld = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay post_signal destination-loss old ask",
      });
      assert.equal(rAsk2DestOld.status, 200, respDiag("rAsk2DestOld", rAsk2DestOld));
      const rAsk2DestOldId = postedSignalId("rAsk2DestOld", rAsk2DestOld);

      const replayCmd2Dest = randomUUID();
      const repPostDestCmd = {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-replay-dest",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay post_signal to private dest channel",
        supersedes: rAsk2DestOldId,
      };
      const repFresh2Dest = await sendCommand(sender.jwt, wsId, repPostDestCmd, replayCmd2Dest);
      assert.equal(repFresh2Dest.status, 200, respDiag("repFresh2Dest", repFresh2Dest));
      const repReplayOk2Dest = await sendCommand(sender.jwt, wsId, repPostDestCmd, replayCmd2Dest);
      assert.equal(repReplayOk2Dest.status, 200, respDiag("repReplayOk2Dest", repReplayOk2Dest));

      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplayDest}::uuid AND user_id = ${sender.id}::uuid
      `;
      const repReplayDenied2Dest = await sendCommand(sender.jwt, wsId, repPostDestCmd, replayCmd2Dest);
      assert.equal(repReplayDenied2Dest.status, 404, respDiag("repReplayDenied2Dest", repReplayDenied2Dest));
      assert.equal(repReplayDenied2Dest.body.error, "channel_not_found", respDiag("repReplayDenied2Dest", repReplayDenied2Dest));
      assert.equal(Object.hasOwn(repReplayDenied2Dest.body, "signal"), false, respDiag("repReplayDenied2Dest", repReplayDenied2Dest));
      assert.equal(Object.hasOwn(repReplayDenied2Dest.body, "superseded_signal_id"), false, respDiag("repReplayDenied2Dest", repReplayDenied2Dest));

      step("C3d-3: ask_choice replacement replay before and after old-ask access loss");
      const rAsk3Post = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-replay-3",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3 replay ask_choice old ask",
      });
      assert.equal(rAsk3Post.status, 200, respDiag("rAsk3Post", rAsk3Post));
      const rAsk3Id = postedSignalId("rAsk3Post", rAsk3Post);

      const replayCmd3 = randomUUID();
      const repChoiceCmd3 = {
        kind: "ask_choice",
        to_user_id: peer1.id,
        about: null,
        body: "C3 replay ask_choice replacement",
        options: [
          { id: "opt1", label: "Option 1" },
          { id: "opt2", label: "Option 2" },
        ],
        supersedes: rAsk3Id,
      };
      const repFresh3 = await sendCommand(sender.jwt, wsId, repChoiceCmd3, replayCmd3);
      assert.equal(repFresh3.status, 200, respDiag("repFresh3", repFresh3));
      const repReplayOk3 = await sendCommand(sender.jwt, wsId, repChoiceCmd3, replayCmd3);
      assert.equal(repReplayOk3.status, 200, respDiag("repReplayOk3", repReplayOk3));
      assert.equal(postedSignalId("repReplayOk3", repReplayOk3), postedSignalId("repFresh3", repFresh3), respDiag("repReplayOk3", repReplayOk3));
      assert.equal(repReplayOk3.body.superseded_signal_id, rAsk3Id, respDiag("repReplayOk3", repReplayOk3));

      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplay3}::uuid AND user_id = ${sender.id}::uuid
      `;
      const repReplayDenied3 = await sendCommand(sender.jwt, wsId, repChoiceCmd3, replayCmd3);
      assert.deepEqual(
        repReplayDenied3,
        unknownWithdraw,
        `C3 ask_choice replacement replay after access loss must return uniform 404 with no stored fields: ${respDiag("repReplayDenied3", repReplayDenied3)}`,
      );

      step("C3f-1: standalone withdraw_ask replay still returns stored receipt after until passes");
      const dlReplayAsk = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 committed-then-expired replay ask",
      });
      assert.equal(dlReplayAsk.status, 200, respDiag("dlReplayAsk", dlReplayAsk));
      const dlReplayAskId = postedSignalId("dlReplayAsk", dlReplayAsk);

      const dlReplayWdCmdId = randomUUID();
      const dlReplayWdFresh = await sendCommand(
        sender.jwt, wsId, { kind: "withdraw_ask", signal_id: dlReplayAskId }, dlReplayWdCmdId,
      );
      assert.equal(dlReplayWdFresh.status, 200, respDiag("dlReplayWdFresh", dlReplayWdFresh));
      await expireAskNow(wsId, dlReplayAskId);
      const dlReplayWdAfter = await sendCommand(
        sender.jwt, wsId, { kind: "withdraw_ask", signal_id: dlReplayAskId }, dlReplayWdCmdId,
      );
      assert.equal(dlReplayWdAfter.status, 200, respDiag("dlReplayWdAfter", dlReplayWdAfter));
      assert.equal(dlReplayWdAfter.body.signal_id, dlReplayAskId, respDiag("dlReplayWdAfter", dlReplayWdAfter));
      assert.equal(dlReplayWdAfter.body.withdrawn, true, respDiag("dlReplayWdAfter", dlReplayWdAfter));
      assert.equal(dlReplayWdAfter.body.withdrawn_at, dlReplayWdFresh.body.withdrawn_at, respDiag("dlReplayWdAfter", dlReplayWdAfter));

      step("C3f-2: post_signal replacement replay still returns stored receipt after until passes");
      const dlReplayPostOld = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 committed-then-expired post_signal replacement old ask",
      });
      assert.equal(dlReplayPostOld.status, 200, respDiag("dlReplayPostOld", dlReplayPostOld));
      const dlReplayPostOldId = postedSignalId("dlReplayPostOld", dlReplayPostOld);

      const dlReplayPostCmdId = randomUUID();
      const dlReplayPostCmd = {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 committed-then-expired post_signal replacement new ask",
        supersedes: dlReplayPostOldId,
      };
      const dlReplayPostFresh = await sendCommand(sender.jwt, wsId, dlReplayPostCmd, dlReplayPostCmdId);
      assert.equal(dlReplayPostFresh.status, 200, respDiag("dlReplayPostFresh", dlReplayPostFresh));
      await expireAskNow(wsId, dlReplayPostOldId);
      const dlReplayPostAfter = await sendCommand(sender.jwt, wsId, dlReplayPostCmd, dlReplayPostCmdId);
      assert.equal(dlReplayPostAfter.status, 200, respDiag("dlReplayPostAfter", dlReplayPostAfter));
      assert.equal(
        postedSignalId("dlReplayPostAfter", dlReplayPostAfter),
        postedSignalId("dlReplayPostFresh", dlReplayPostFresh),
        respDiag("dlReplayPostAfter", dlReplayPostAfter),
      );
      assert.equal(dlReplayPostAfter.body.superseded_signal_id, dlReplayPostOldId, respDiag("dlReplayPostAfter", dlReplayPostAfter));

      step("C3f-3: ask_choice replacement replay still returns stored receipt after until passes");
      const dlReplayChoiceOld = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 committed-then-expired ask_choice replacement old ask",
      });
      assert.equal(dlReplayChoiceOld.status, 200, respDiag("dlReplayChoiceOld", dlReplayChoiceOld));
      const dlReplayChoiceOldId = postedSignalId("dlReplayChoiceOld", dlReplayChoiceOld);

      const dlReplayChoiceCmdId = randomUUID();
      const dlReplayChoiceCmd = {
        kind: "ask_choice",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        about: null,
        body: "Detail 1 committed-then-expired ask_choice replacement new ask",
        options: [
          { id: "r1", label: "R1" },
          { id: "r2", label: "R2" },
        ],
        supersedes: dlReplayChoiceOldId,
      };
      const dlReplayChoiceFresh = await sendCommand(sender.jwt, wsId, dlReplayChoiceCmd, dlReplayChoiceCmdId);
      assert.equal(dlReplayChoiceFresh.status, 200, respDiag("dlReplayChoiceFresh", dlReplayChoiceFresh));
      await expireAskNow(wsId, dlReplayChoiceOldId);
      const dlReplayChoiceAfter = await sendCommand(sender.jwt, wsId, dlReplayChoiceCmd, dlReplayChoiceCmdId);
      assert.equal(dlReplayChoiceAfter.status, 200, respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter));
      assert.equal(
        postedSignalId("dlReplayChoiceAfter", dlReplayChoiceAfter),
        postedSignalId("dlReplayChoiceFresh", dlReplayChoiceFresh),
        respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter),
      );
      assert.equal(dlReplayChoiceAfter.body.superseded_signal_id, dlReplayChoiceOldId, respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter));

      step("C3g: standalone withdraw_ask on replaced ask never returns replacement id after destination access loss");
      const stripOldPost = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-rep-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3g old ask in public channel that sender keeps",
      });
      assert.equal(stripOldPost.status, 200, respDiag("stripOldPost", stripOldPost));
      const stripOldId = postedSignalId("stripOldPost", stripOldPost);

      const stripRepPost = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c3-replay-strip-dest",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C3g replacement in private channel sender will lose",
        supersedes: stripOldId,
      });
      assert.equal(stripRepPost.status, 200, respDiag("stripRepPost", stripRepPost));
      const stripRepId = postedSignalId("stripRepPost", stripRepPost);
      assert.equal(stripRepPost.body.superseded_signal_id, stripOldId, respDiag("stripRepPost", stripRepPost));

      // Sender loses access to the replacement's private destination channel while keeping access to the old ask.
      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplayStripDest}::uuid AND user_id = ${sender.id}::uuid
      `;

      const standaloneAfterRepCmdId = randomUUID();
      const standaloneFresh = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: stripOldId },
        standaloneAfterRepCmdId,
      );
      assert.equal(standaloneFresh.status, 200, respDiag("standaloneFresh", standaloneFresh));
      assert.equal(standaloneFresh.body.signal_id, stripOldId, respDiag("standaloneFresh", standaloneFresh));
      assert.equal(standaloneFresh.body.withdrawn, true, respDiag("standaloneFresh", standaloneFresh));
      assert.equal(standaloneFresh.body.created, false, respDiag("standaloneFresh", standaloneFresh));
      assert.equal(typeof standaloneFresh.body.withdrawn_at, "string", respDiag("standaloneFresh", standaloneFresh));
      assert.equal(
        Object.hasOwn(standaloneFresh.body, "replaced_by_signal_id"),
        false,
        `standalone withdraw_ask fresh response must never include replaced_by_signal_id: ${respDiag("standaloneFresh", standaloneFresh)}`,
      );
      assert.deepEqual(
        Object.keys(standaloneFresh.body).sort(),
        ["created", "event_ids", "events", "min_client_version", "ok", "signal_id", "status", "withdrawn", "withdrawn_at"],
        respDiag("standaloneFresh", standaloneFresh),
      );
      assert.equal(
        JSON.stringify(standaloneFresh.body).includes(stripRepId),
        false,
        `standalone withdraw_ask fresh response must not leak replacement id: ${respDiag("standaloneFresh", standaloneFresh)}`,
      );

      // Retrying the same standalone command id (replay) returns the same documented keys and no replacement id.
      const standaloneReplay = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: stripOldId },
        standaloneAfterRepCmdId,
      );
      assert.equal(standaloneReplay.status, 200, respDiag("standaloneReplay", standaloneReplay));
      assert.equal(standaloneReplay.body.signal_id, stripOldId, respDiag("standaloneReplay", standaloneReplay));
      assert.equal(standaloneReplay.body.withdrawn, true, respDiag("standaloneReplay", standaloneReplay));
      assert.equal(standaloneReplay.body.created, false, respDiag("standaloneReplay", standaloneReplay));
      assert.equal(standaloneReplay.body.withdrawn_at, standaloneFresh.body.withdrawn_at, respDiag("standaloneReplay", standaloneReplay));
      assert.equal(
        Object.hasOwn(standaloneReplay.body, "replaced_by_signal_id"),
        false,
        `standalone withdraw_ask replay must never include replaced_by_signal_id: ${respDiag("standaloneReplay", standaloneReplay)}`,
      );
      assert.deepEqual(
        Object.keys(standaloneReplay.body).sort(),
        ["created", "event_ids", "ok", "signal_id", "status", "withdrawn", "withdrawn_at"],
        respDiag("standaloneReplay", standaloneReplay),
      );
      assert.equal(
        JSON.stringify(standaloneReplay.body).includes(stripRepId),
        false,
        `standalone withdraw_ask replay must not leak replacement id: ${respDiag("standaloneReplay", standaloneReplay)}`,
      );

      // Service-role check: the stored receipt holds no replacement id.
      const [storedReceipt] = await sql<{ response: Record<string, unknown> }[]>`
        SELECT response
        FROM swarm.idempotency_keys
        WHERE workspace_id = ${wsId}::uuid
          AND command_id = ${standaloneAfterRepCmdId}
        LIMIT 1
      `;
      assert.ok(storedReceipt, "expected stored receipt row for standaloneAfterRepCmdId");
      assert.equal(
        Object.hasOwn(storedReceipt.response, "replaced_by_signal_id"),
        false,
        `stored standalone withdraw_ask receipt must hold no replaced_by_signal_id: ${JSON.stringify(storedReceipt.response)}`,
      );
      assert.deepEqual(
        Object.keys(storedReceipt.response).sort(),
        ["created", "event_ids", "ok", "signal_id", "withdrawn", "withdrawn_at"],
        JSON.stringify(storedReceipt.response),
      );
      assert.equal(
        JSON.stringify(storedReceipt.response).includes(stripRepId),
        false,
        `stored standalone withdraw_ask receipt must not contain replacement id: ${JSON.stringify(storedReceipt.response)}`,
      );

      // Simulate a pre-C3 receipt that had replaced_by_signal_id persisted and confirm standalone replay strips it.
      const legacyReceiptCmdId = randomUUID();
      const legacySeedFresh = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: stripOldId },
        legacyReceiptCmdId,
      );
      assert.equal(legacySeedFresh.status, 200, respDiag("legacySeedFresh", legacySeedFresh));
      await sql`
        UPDATE swarm.idempotency_keys
        SET response = response || jsonb_build_object('replaced_by_signal_id', ${stripRepId}::text)
        WHERE workspace_id = ${wsId}::uuid
          AND command_id = ${legacyReceiptCmdId}
      `;
      const legacyReplayStripped = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: stripOldId },
        legacyReceiptCmdId,
      );
      assert.equal(legacyReplayStripped.status, 200, respDiag("legacyReplayStripped", legacyReplayStripped));
      assert.equal(
        Object.hasOwn(legacyReplayStripped.body, "replaced_by_signal_id"),
        false,
        `standalone replay must strip replaced_by_signal_id from pre-existing stored receipts: ${respDiag("legacyReplayStripped", legacyReplayStripped)}`,
      );
      assert.deepEqual(
        Object.keys(legacyReplayStripped.body).sort(),
        ["created", "event_ids", "ok", "signal_id", "status", "withdrawn", "withdrawn_at"],
        respDiag("legacyReplayStripped", legacyReplayStripped),
      );
      step("C3replay: done");
    } finally {
      await fx.cleanup();
    }
  },
);

test(
  "C4 (audit privacy & agent presence): direct/group audit rows hidden, cross-channel replace keeps tag union, agent withdrawal does not advance presence",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("C4: setup workspace fixture");
    const outsideOwner = await createUser("awc4-owner");
    const outsideAdmin = await createUser("awc4-admin");
    const bothChAdmin = await createUser("awc4-both-admin");
    const sender = await createUser("awc4-sender");
    const peer1 = await createUser("awc4-peer1");
    const peer2 = await createUser("awc4-peer2");
    const fx = await seedBasicWorkspace({
      name: "AskWithdrawC4WS",
      members: [
        { user: outsideOwner, displayName: "C4Owner", role: "owner" },
        { user: outsideAdmin, displayName: "C4Admin", role: "admin" },
        { user: bothChAdmin, displayName: "C4BothAdmin", role: "admin" },
        { user: sender, displayName: "C4Sender", role: "member" },
        { user: peer1, displayName: "C4Peer1", role: "member" },
        { user: peer2, displayName: "C4Peer2", role: "member" },
      ],
      agents: [{ ownerId: outsideOwner.id, name: "C4AgentA" }],
      channels: [
        { slug: "c4-pub", visibility: "open", createdByUserId: outsideOwner.id },
        {
          slug: "c4-priv-pres",
          visibility: "private",
          createdByUserId: peer1.id,
          userMemberIds: [peer1.id],
          agentMemberIndexes: [0],
        },
        {
          slug: "c4-priv-rep",
          visibility: "private",
          createdByUserId: peer1.id,
          userMemberIds: [sender.id, peer1.id, bothChAdmin.id],
        },
      ],
    });
    const wsId = fx.wsId;
    const pubChId = fx.channelsBySlug["c4-pub"]!;
    const privChReplaceAudit = fx.channelsBySlug["c4-priv-rep"]!;
    const agentAId = fx.agents[0]!.id;
    const agentAToken = fx.agents[0]!.token;

    try {
      step("C4a: withdraw 1:1 DM ask and group-DM ask -> untagged audit rows hidden from outside owner/admin");
      const dmAskPost = await sendCommand(peer1.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer2.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 direct 1:1 DM ask",
      });
      assert.equal(dmAskPost.status, 200, respDiag("dmAskPost", dmAskPost));
      const dmAskId = postedSignalId("dmAskPost", dmAskPost);

      const wdDm = await sendCommand(peer1.jwt, wsId, { kind: "withdraw_ask", signal_id: dmAskId });
      assert.equal(wdDm.status, 200, respDiag("wdDm", wdDm));

      const openGroupC4 = await sendCommand(peer1.jwt, wsId, {
        kind: "conversation_open",
        members: [
          { kind: "user", id: peer2.id },
          { kind: "user", id: sender.id },
        ],
        new_group: false,
      });
      assert.equal(openGroupC4.status, 200, respDiag("openGroupC4", openGroupC4));
      const groupConvIdC4 = (openGroupC4.body.conversation as { conversation_id?: string } | undefined)?.conversation_id;
      assert.equal(typeof groupConvIdC4, "string", respDiag("openGroupC4", openGroupC4));

      const groupAskPost = await sendCommand(peer1.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        conversation_id: groupConvIdC4,
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 group DM ask",
      });
      assert.equal(groupAskPost.status, 200, respDiag("groupAskPost", groupAskPost));
      const groupAskId = postedSignalId("groupAskPost", groupAskPost);

      const wdGroup = await sendCommand(peer1.jwt, wsId, { kind: "withdraw_ask", signal_id: groupAskId });
      assert.equal(wdGroup.status, 200, respDiag("wdGroup", wdGroup));

      const untaggedWithdrawAudits = await sql<{ audit_id: string }[]>`
        SELECT audit_id::text AS audit_id
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind = 'withdraw_ask'
          AND outcome = 'accepted'
          AND coalesce(cardinality(channel_ids), 0) = 0
      `;
      assert.ok(
        untaggedWithdrawAudits.length >= 2,
        `expected >= 2 server-side accepted direct/group withdraw_ask audit rows, got ${JSON.stringify(untaggedWithdrawAudits)}`,
      );
      const untaggedIds = new Set(untaggedWithdrawAudits.map((r) => r.audit_id));

      for (const [label, auditor] of [["outsideOwner", outsideOwner], ["outsideAdmin", outsideAdmin]] as const) {
        const visible = await sql.begin(async (tx) => {
          await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
          await tx`SET LOCAL ROLE authenticated`;
          return tx<{ audit_id: string }[]>`
            SELECT audit_id::text AS audit_id
            FROM swarm_read.audit_log
            WHERE workspace_id = ${wsId}::uuid
              AND command_kind = 'withdraw_ask'
          `;
        });
        const leaked = visible.filter((r) => untaggedIds.has(r.audit_id));
        assert.equal(
          leaked.length,
          0,
          `${label} must see zero direct/group withdraw_ask rows in swarm_read.audit_log: leaked=${JSON.stringify(leaked)}`,
        );
      }

      step("C4a-replace: cross-channel replacement tags union of both channels on fresh + replay and never leaks old ask id");
      const crossPrivOld1 = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-priv-rep",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 2 private old ask for post_signal replacement",
      });
      assert.equal(crossPrivOld1.status, 200, respDiag("crossPrivOld1", crossPrivOld1));
      const crossPrivOld1Id = postedSignalId("crossPrivOld1", crossPrivOld1);

      const crossPostCmdId = randomUUID();
      const crossPostCmd = {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 2 public post_signal replacement of private ask",
        supersedes: crossPrivOld1Id,
      };
      const crossPostFresh = await sendCommand(sender.jwt, wsId, crossPostCmd, crossPostCmdId);
      assert.equal(crossPostFresh.status, 200, respDiag("crossPostFresh", crossPostFresh));
      const crossPostReplay = await sendCommand(sender.jwt, wsId, crossPostCmd, crossPostCmdId);
      assert.equal(crossPostReplay.status, 200, respDiag("crossPostReplay", crossPostReplay));

      const crossPrivOld2 = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-priv-rep",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 2 private old ask for ask_choice replacement",
      });
      assert.equal(crossPrivOld2.status, 200, respDiag("crossPrivOld2", crossPrivOld2));
      const crossPrivOld2Id = postedSignalId("crossPrivOld2", crossPrivOld2);

      const crossChoiceCmdId = randomUUID();
      const crossChoiceCmd = {
        kind: "ask_choice",
        channel: "c4-pub",
        to_user_id: peer1.id,
        about: null,
        body: "Detail 2 public ask_choice replacement of private ask",
        options: [
          { id: "c1", label: "C1" },
          { id: "c2", label: "C2" },
        ],
        supersedes: crossPrivOld2Id,
      };
      const crossChoiceFresh = await sendCommand(sender.jwt, wsId, crossChoiceCmd, crossChoiceCmdId);
      assert.equal(crossChoiceFresh.status, 200, respDiag("crossChoiceFresh", crossChoiceFresh));
      const crossChoiceReplay = await sendCommand(sender.jwt, wsId, crossChoiceCmd, crossChoiceCmdId);
      assert.equal(crossChoiceReplay.status, 200, respDiag("crossChoiceReplay", crossChoiceReplay));

      const replaceAuditRows = await sql<{ audit_id: string; detail: string | null }[]>`
        SELECT audit_id::text AS audit_id, detail
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind IN ('post_signal', 'ask_choice')
          AND outcome IN ('accepted', 'replayed')
          AND detail IS NOT NULL
      `;
      for (const row of replaceAuditRows) {
        assert.equal(
          row.detail?.includes(crossPrivOld1Id) || row.detail?.includes(crossPrivOld2Id),
          false,
          `replacing post audit detail must not record superseded signal id: ${JSON.stringify(row)}`,
        );
      }

      const crossTaggedRows = await sql<{
        audit_id: string;
        command_kind: string;
        outcome: string;
        detail: string | null;
      }[]>`
        SELECT audit_id::text AS audit_id, command_kind, outcome, detail
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind IN ('post_signal', 'ask_choice')
          AND outcome IN ('accepted', 'replayed')
          AND ${privChReplaceAudit}::uuid = ANY(channel_ids)
          AND ${pubChId}::uuid = ANY(channel_ids)
      `;
      const findCrossIds = (kind: string, outcome: string) =>
        crossTaggedRows.filter((r) => r.command_kind === kind && r.outcome === outcome).map((r) => r.audit_id);
      assert.ok(findCrossIds("post_signal", "accepted").length >= 1, `missing fresh union-tagged post_signal replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
      assert.ok(findCrossIds("post_signal", "replayed").length >= 1, `missing replayed union-tagged post_signal replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
      assert.ok(findCrossIds("ask_choice", "accepted").length >= 1, `missing fresh union-tagged ask_choice replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
      assert.ok(findCrossIds("ask_choice", "replayed").length >= 1, `missing replayed union-tagged ask_choice replacement audit row: ${JSON.stringify(crossTaggedRows)}`);

      const allCrossAuditIds = new Set(crossTaggedRows.map((r) => r.audit_id));
      for (const [label, auditor] of [["outsideOwner", outsideOwner], ["outsideAdmin", outsideAdmin]] as const) {
        const visible = await sql.begin(async (tx) => {
          await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
          await tx`SET LOCAL ROLE authenticated`;
          return tx<{ audit_id: string }[]>`
            SELECT audit_id::text AS audit_id
            FROM swarm_read.audit_log
            WHERE workspace_id = ${wsId}::uuid
              AND command_kind IN ('post_signal', 'ask_choice')
          `;
        });
        const leaked = visible.filter((r) => allCrossAuditIds.has(r.audit_id));
        assert.equal(
          leaked.length,
          0,
          `${label} outside private channel must see zero fresh/replayed cross-channel replacement audit rows: leaked=${JSON.stringify(leaked)}`,
        );
      }
      const visibleToBothChAdmin = await sql.begin(async (tx) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: bothChAdmin.id })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        return tx<{ audit_id: string }[]>`
          SELECT audit_id::text AS audit_id
          FROM swarm_read.audit_log
          WHERE workspace_id = ${wsId}::uuid
            AND command_kind IN ('post_signal', 'ask_choice')
        `;
      });
      const visibleBothSet = new Set(visibleToBothChAdmin.map((r) => r.audit_id));
      for (const expectedId of allCrossAuditIds) {
        assert.ok(
          visibleBothSet.has(expectedId),
          `bothChAdmin (member of both channels with admin role) must see audit_id=${expectedId}; saw=${JSON.stringify([...visibleBothSet])}`,
        );
      }

      step("C4a-legacy-replace: legacy thread-reply ask (NULL scalar channel_id, canonical private channel) preserves exact tags on fresh, replay, and conflict");
      const privRootPost = await sendCommand(sender.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        channel: "c4-priv-rep",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 legacy-placement private thread root",
      });
      assert.equal(privRootPost.status, 200, respDiag("privRootPost", privRootPost));
      const privRootId = postedSignalId("privRootPost", privRootPost);

      // No served command writes a channel thread reply with scalar channel_id = NULL (post_signal
      // always copies rootChannelId into signals.channel_id); seed the historical backfill / filer
      // shape directly as service role so signals_settle_conversation files it into privChReplaceAudit.
      const seedLegacyPrivateThreadAsk = async (body: string): Promise<string> => {
        const legacyId = randomUUID();
        await sql`
          INSERT INTO swarm.signals (
            id, workspace_id, from_principal, from_kind, to_user_id,
            kind, body, channel_id, thread_root_id, created_at, until
          ) VALUES (
            ${legacyId}::uuid,
            ${wsId}::uuid,
            ${sender.id}::uuid,
            'user',
            ${peer1.id}::uuid,
            'ask',
            ${body},
            NULL,
            ${privRootId}::uuid,
            statement_timestamp(),
            statement_timestamp() + interval '7 days'
          )
        `;
        const [shape] = await sql<{
          scalar_channel_id: string | null;
          conv_channel_id: string | null;
          conv_kind: string | null;
        }[]>`
          SELECT
            s.channel_id::text AS scalar_channel_id,
            c.channel_id::text AS conv_channel_id,
            c.kind AS conv_kind
          FROM swarm.signals AS s
          JOIN swarm.conversation_signals AS cs
            ON cs.workspace_id = s.workspace_id AND cs.signal_id = s.id
          JOIN swarm.conversations AS c
            ON c.workspace_id = s.workspace_id AND c.conversation_id = cs.conversation_id
          WHERE s.workspace_id = ${wsId}::uuid
            AND s.id = ${legacyId}::uuid
        `;
        assert.equal(shape?.scalar_channel_id, null, `legacy ask must have NULL scalar channel_id: ${JSON.stringify(shape)}`);
        assert.equal(shape?.conv_channel_id, privChReplaceAudit, `legacy ask canonical conversation must be private channel: ${JSON.stringify(shape)}`);
        assert.equal(shape?.conv_kind, "private_channel", `legacy ask canonical conversation kind must be private_channel: ${JSON.stringify(shape)}`);
        return legacyId;
      };

      const legacyOldPostAskId = await seedLegacyPrivateThreadAsk("C4 legacy thread-reply ask replaced by public post_signal");
      const legacyOldChoiceAskId = await seedLegacyPrivateThreadAsk("C4 legacy thread-reply ask replaced by public ask_choice");
      const legacyOldStandaloneAskId = await seedLegacyPrivateThreadAsk("C4 legacy thread-reply ask withdrawn standalone");

      const priorLegacyAuditRows = await sql<{ audit_id: string }[]>`
        SELECT audit_id::text AS audit_id
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
      `;
      const beforeLegacyAuditIds = new Set(priorLegacyAuditRows.map((r) => r.audit_id));

      // 1. Public post_signal replacement of legacy private-channel thread-reply ask: fresh, replay, conflict.
      const legacyPostCmdId = randomUUID();
      const legacyPostCmd = {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 public post_signal replacing legacy private thread-reply ask",
        supersedes: legacyOldPostAskId,
      };
      const legacyPostFresh = await sendCommand(sender.jwt, wsId, legacyPostCmd, legacyPostCmdId);
      assert.equal(legacyPostFresh.status, 200, respDiag("legacyPostFresh", legacyPostFresh));
      const legacyPostReplay = await sendCommand(sender.jwt, wsId, legacyPostCmd, legacyPostCmdId);
      assert.equal(legacyPostReplay.status, 200, respDiag("legacyPostReplay", legacyPostReplay));
      const legacyPostConflict = await sendCommand(
        sender.jwt,
        wsId,
        { ...legacyPostCmd, body: "C4 conflicting post_signal body under same command id" },
        legacyPostCmdId,
      );
      assert.equal(legacyPostConflict.status, 409, respDiag("legacyPostConflict", legacyPostConflict));
      assert.equal(legacyPostConflict.body.error, "command_id_conflict", respDiag("legacyPostConflict", legacyPostConflict));

      // 2. Public ask_choice replacement of legacy private-channel thread-reply ask: fresh, replay, conflict.
      const legacyChoiceCmdId = randomUUID();
      const legacyChoiceCmd = {
        kind: "ask_choice",
        channel: "c4-pub",
        to_user_id: peer1.id,
        about: null,
        body: "C4 public ask_choice replacing legacy private thread-reply ask",
        options: [
          { id: "lc1", label: "LC1" },
          { id: "lc2", label: "LC2" },
        ],
        supersedes: legacyOldChoiceAskId,
      };
      const legacyChoiceFresh = await sendCommand(sender.jwt, wsId, legacyChoiceCmd, legacyChoiceCmdId);
      assert.equal(legacyChoiceFresh.status, 200, respDiag("legacyChoiceFresh", legacyChoiceFresh));
      const legacyChoiceReplay = await sendCommand(sender.jwt, wsId, legacyChoiceCmd, legacyChoiceCmdId);
      assert.equal(legacyChoiceReplay.status, 200, respDiag("legacyChoiceReplay", legacyChoiceReplay));
      const legacyChoiceConflict = await sendCommand(
        sender.jwt,
        wsId,
        { ...legacyChoiceCmd, body: "C4 conflicting ask_choice body under same command id" },
        legacyChoiceCmdId,
      );
      assert.equal(legacyChoiceConflict.status, 409, respDiag("legacyChoiceConflict", legacyChoiceConflict));
      assert.equal(legacyChoiceConflict.body.error, "command_id_conflict", respDiag("legacyChoiceConflict", legacyChoiceConflict));

      // 3. Standalone withdraw_ask of legacy private-channel thread-reply ask: fresh, replay, conflict.
      const legacyWdCmdId = randomUUID();
      const legacyWdFresh = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: legacyOldStandaloneAskId },
        legacyWdCmdId,
      );
      assert.equal(legacyWdFresh.status, 200, respDiag("legacyWdFresh", legacyWdFresh));
      const legacyWdReplay = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: legacyOldStandaloneAskId },
        legacyWdCmdId,
      );
      assert.equal(legacyWdReplay.status, 200, respDiag("legacyWdReplay", legacyWdReplay));
      const legacyWdConflict = await sendCommand(
        sender.jwt,
        wsId,
        { kind: "withdraw_ask", signal_id: randomUUID() },
        legacyWdCmdId,
      );
      assert.equal(legacyWdConflict.status, 409, respDiag("legacyWdConflict", legacyWdConflict));
      assert.equal(legacyWdConflict.body.error, "command_id_conflict", respDiag("legacyWdConflict", legacyWdConflict));

      // 4. Even after sender loses access to the private channel, a conflict still preserves {private, public}.
      await sql`
        DELETE FROM swarm.channel_members
        WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChReplaceAudit}::uuid AND user_id = ${sender.id}::uuid
      `;
      const legacyPostConflictAfterLoss = await sendCommand(
        sender.jwt,
        wsId,
        { ...legacyPostCmd, body: "C4 conflicting post_signal body after private channel removal" },
        legacyPostCmdId,
      );
      assert.equal(legacyPostConflictAfterLoss.status, 409, respDiag("legacyPostConflictAfterLoss", legacyPostConflictAfterLoss));
      assert.equal(legacyPostConflictAfterLoss.body.error, "command_id_conflict", respDiag("legacyPostConflictAfterLoss", legacyPostConflictAfterLoss));

      const legacyNewAudits = (await sql<{
        audit_id: string;
        command_kind: string;
        outcome: string;
        reason: string | null;
        channel_ids: string[];
      }[]>`
        SELECT
          audit_id::text AS audit_id,
          command_kind,
          outcome,
          reason,
          coalesce(to_jsonb(channel_ids), '[]'::jsonb) AS channel_ids
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind IN ('post_signal', 'ask_choice', 'withdraw_ask')
        ORDER BY occurred_at ASC, audit_id ASC
      `).filter((row) => !beforeLegacyAuditIds.has(row.audit_id));

      const expectedPair = [privChReplaceAudit, pubChId].sort();
      const postFreshRows = legacyNewAudits.filter((r) => r.command_kind === "post_signal" && r.outcome === "accepted");
      const postReplayRows = legacyNewAudits.filter((r) => r.command_kind === "post_signal" && r.outcome === "replayed");
      const postConflictRows = legacyNewAudits.filter((r) => r.command_kind === "post_signal" && r.outcome === "conflict" && r.reason === "command_id_conflict");
      const choiceFreshRows = legacyNewAudits.filter((r) => r.command_kind === "ask_choice" && r.outcome === "accepted");
      const choiceReplayRows = legacyNewAudits.filter((r) => r.command_kind === "ask_choice" && r.outcome === "replayed");
      const choiceConflictRows = legacyNewAudits.filter((r) => r.command_kind === "ask_choice" && r.outcome === "conflict" && r.reason === "command_id_conflict");
      const wdFreshRows = legacyNewAudits.filter((r) => r.command_kind === "withdraw_ask" && r.outcome === "accepted");
      const wdReplayRows = legacyNewAudits.filter((r) => r.command_kind === "withdraw_ask" && r.outcome === "replayed");
      const wdConflictRows = legacyNewAudits.filter((r) => r.command_kind === "withdraw_ask" && r.outcome === "conflict" && r.reason === "command_id_conflict");

      assert.equal(postFreshRows.length, 1, `expected 1 legacy post_signal accepted row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(postReplayRows.length, 1, `expected 1 legacy post_signal replayed row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(postConflictRows.length, 2, `expected 2 legacy post_signal conflict rows (before + after access loss): ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(choiceFreshRows.length, 1, `expected 1 legacy ask_choice accepted row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(choiceReplayRows.length, 1, `expected 1 legacy ask_choice replayed row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(choiceConflictRows.length, 1, `expected 1 legacy ask_choice conflict row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(wdFreshRows.length, 1, `expected 1 legacy withdraw_ask accepted row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(wdReplayRows.length, 1, `expected 1 legacy withdraw_ask replayed row: ${JSON.stringify(legacyNewAudits)}`);
      assert.equal(wdConflictRows.length, 1, `expected 1 legacy withdraw_ask conflict row: ${JSON.stringify(legacyNewAudits)}`);

      for (const row of [...postFreshRows, ...postReplayRows, ...postConflictRows, ...choiceFreshRows, ...choiceReplayRows, ...choiceConflictRows]) {
        assert.deepEqual(
          [...row.channel_ids].sort(),
          expectedPair,
          `legacy replacement audit row (${row.command_kind}/${row.outcome}) must carry exact {private, public} tags: ${JSON.stringify(row)}`,
        );
      }
      for (const row of [...wdFreshRows, ...wdReplayRows, ...wdConflictRows]) {
        assert.deepEqual(
          [...row.channel_ids].sort(),
          [privChReplaceAudit],
          `legacy standalone withdraw_ask audit row (${row.outcome}) must carry exact {private} tag: ${JSON.stringify(row)}`,
        );
      }

      const legacyAuditIdSet = new Set(legacyNewAudits.map((r) => r.audit_id));
      for (const [label, auditor] of [["outsideOwner", outsideOwner], ["outsideAdmin", outsideAdmin]] as const) {
        const visible = await sql.begin(async (tx) => {
          await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
          await tx`SET LOCAL ROLE authenticated`;
          return tx<{ audit_id: string }[]>`
            SELECT audit_id::text AS audit_id
            FROM swarm_read.audit_log
            WHERE workspace_id = ${wsId}::uuid
              AND command_kind IN ('post_signal', 'ask_choice', 'withdraw_ask')
          `;
        });
        const leaked = visible.filter((r) => legacyAuditIdSet.has(r.audit_id));
        assert.equal(
          leaked.length,
          0,
          `${label} outside private channel must see zero legacy-placement withdrawal/replacement audit rows: leaked=${JSON.stringify(leaked)}`,
        );
      }
      const visibleLegacyToBothChAdmin = await sql.begin(async (tx) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: bothChAdmin.id })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        return tx<{ audit_id: string }[]>`
          SELECT audit_id::text AS audit_id
          FROM swarm_read.audit_log
          WHERE workspace_id = ${wsId}::uuid
            AND command_kind IN ('post_signal', 'ask_choice', 'withdraw_ask')
        `;
      });
      const visibleLegacyBothSet = new Set(visibleLegacyToBothChAdmin.map((r) => r.audit_id));
      for (const expectedId of legacyAuditIdSet) {
        assert.ok(
          visibleLegacyBothSet.has(expectedId),
          `bothChAdmin (member of both channels with admin role) must see legacy audit_id=${expectedId}; saw=${JSON.stringify([...visibleLegacyBothSet])}`,
        );
      }

      step("C4b: agent presence suppressed for private-channel and DM withdrawals; public control advances it");
      const agentPrivAskPost = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-priv-pres",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 agent private-channel ask",
      });
      assert.equal(agentPrivAskPost.status, 200, respDiag("agentPrivAskPost", agentPrivAskPost));
      const agentPrivAskId = postedSignalId("agentPrivAskPost", agentPrivAskPost);

      const agentDmAskPost = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 agent direct-conversation ask",
      });
      assert.equal(agentDmAskPost.status, 200, respDiag("agentDmAskPost", agentDmAskPost));
      const agentDmAskId = postedSignalId("agentDmAskPost", agentDmAskPost);

      const [seededPresence] = await sql<{ last_command_at: Date }[]>`
        INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at)
        VALUES (${wsId}::uuid, ${agentAId}::uuid, statement_timestamp() - interval '10 minutes')
        ON CONFLICT (workspace_id, principal_id) DO UPDATE
          SET last_command_at = statement_timestamp() - interval '10 minutes'
        RETURNING last_command_at
      `;
      const baselinePresenceMs = seededPresence!.last_command_at.getTime();
      const readPresenceMs = async (): Promise<number> => {
        const [row] = await sql<{ last_command_at: Date }[]>`
          SELECT last_command_at FROM swarm.agent_presence
          WHERE workspace_id = ${wsId}::uuid AND principal_id = ${agentAId}::uuid
        `;
        assert.ok(row, "agent_presence row must exist");
        return row.last_command_at.getTime();
      };

      const privWdCmdId = randomUUID();
      const agentWdPrivFresh = await sendCommand(agentAToken, wsId, { kind: "withdraw_ask", signal_id: agentPrivAskId }, privWdCmdId);
      assert.equal(agentWdPrivFresh.status, 200, respDiag("agentWdPrivFresh", agentWdPrivFresh));
      assert.equal(await readPresenceMs(), baselinePresenceMs, "fresh private-channel withdraw_ask must not advance agent_presence");

      const agentWdPrivReplay = await sendCommand(agentAToken, wsId, { kind: "withdraw_ask", signal_id: agentPrivAskId }, privWdCmdId);
      assert.equal(agentWdPrivReplay.status, 200, respDiag("agentWdPrivReplay", agentWdPrivReplay));
      assert.equal(await readPresenceMs(), baselinePresenceMs, "replayed private-channel withdraw_ask must not advance agent_presence");

      const dmWdCmdId = randomUUID();
      const agentWdDmFresh = await sendCommand(agentAToken, wsId, { kind: "withdraw_ask", signal_id: agentDmAskId }, dmWdCmdId);
      assert.equal(agentWdDmFresh.status, 200, respDiag("agentWdDmFresh", agentWdDmFresh));
      assert.equal(await readPresenceMs(), baselinePresenceMs, "fresh DM withdraw_ask must not advance agent_presence");

      const agentWdDmReplay = await sendCommand(agentAToken, wsId, { kind: "withdraw_ask", signal_id: agentDmAskId }, dmWdCmdId);
      assert.equal(agentWdDmReplay.status, 200, respDiag("agentWdDmReplay", agentWdDmReplay));
      assert.equal(await readPresenceMs(), baselinePresenceMs, "replayed DM withdraw_ask must not advance agent_presence");

      const pubControlPost = await sendCommand(agentAToken, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        channel: "c4-pub",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "C4 public-channel presence control",
      });
      assert.equal(pubControlPost.status, 200, respDiag("pubControlPost", pubControlPost));
      const afterControlMs = await readPresenceMs();
      assert.ok(
        afterControlMs > baselinePresenceMs,
        `public-channel post control must advance agent_presence: baseline=${baselinePresenceMs} after=${afterControlMs}`,
      );
      step("C4: done");
    } finally {
      await fx.cleanup();
    }
  },
);
