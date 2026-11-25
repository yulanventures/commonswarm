/**
 * Server integration witness suite for #742 Approve Action on To-Dos
 * (migration 20261125000004_todo_approvals.sql and R4 7-step savepoint notice boundary):
 *
 *   Suite 1: Forward catalog/functional proofs, isolated rollback + rollback-catalog + re-apply,
 *            zero new SECURITY DEFINER functions or broadened grants, and all 5 table-level
 *            CHECK constraints on swarm.household_todos.
 *   Suite 2: Approval workflow (workspace/general origins allowed; channel/dm/group_dm refused),
 *            household_todo_decide authorization & freeze, human-only reopen clearing decision_*,
 *            dependent after-gates in home_overview and todo_queue, and start_now gate survival
 *            with immediate reopen re-block.
 *   Suite 3: Condition 2 live-recipient controls (own agent, cross-owner agent, human requester),
 *            rate-bucket wait across connection_expires_at deadline witness + live control,
 *            R4 late-write contention witnesses (Step F swarm.conversations FOR UPDATE and
 *            Step E spend:signal_post:0..7 FOR UPDATE) + live controls for both household_todo_decide
 *            and household_todo_answer, read-right loss during settlement, and replay fencing.
 *   Suite 4: Condition 3 server proof (missing/stale/matching base_version on household_todo_answer,
 *            offer_pending_frozen, full offer.gate and has_notes on summary()/todo_list),
 *            waiting_todos_page, waiting_archived_page (dedup + untrusted_content), and audit_log privacy.
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
import { HOUSEHOLD_LOCAL_SEAT } from "../../src/protocol/household-tool-registry.js";
import { dbAssert, refuses, repoSql, runSql } from "../support/admin-schema-db.js";
import { sqlPhase } from "../support/admin-schema-process.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Row = Record<string, unknown>;
type Tx = postgres.TransactionSql<Record<string, unknown>>;

interface SeededAgent {
  id: string;
  token: string;
  tokenId: string;
  runId: string;
  deviceId: string;
  renewalGrantId: string;
  ownerId: string;
  name: string;
  wakeId: string;
}

const TEST_TIMEOUT_MS = 240_000;
const WAIT_TIMEOUT_MS = 20_000;
const TEST_DB_LOCK_TIMEOUT_MS = 20_000;
const TEST_DB_STATEMENT_TIMEOUT_MS = 20_000;
const HOLDER_IDLE_IN_TX_TIMEOUT_MS = 25_000;
const RELEASE_LOCK_ROLLBACK = Symbol("release_lock_rollback");
const SPEND_SIGNAL_KEYS = Array.from({ length: 8 }, (_, i) => `spend:signal_post:${i}`);

const proofRoot = "deploy/release-proofs/todo-approvals/20261125000004";
const catalogAssert = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "todo approvals rollback catalog" : "todo approvals catalog",
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
  console.error(`[todo-approvals] ${name}`);
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

async function captureLockDiagnostics(stepName: string): Promise<string> {
  try {
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
      }[]>`
        SELECT
          pid,
          locktype,
          relation::regclass::text AS relation,
          mode,
          granted
        FROM pg_locks
        WHERE NOT granted
        ORDER BY pid
      `,
    ]);
    return JSON.stringify({
      step: stepName,
      pg_stat_activity: activity.map((row) => ({
        pid: row.pid,
        application_name: row.application_name,
        state: row.state,
        wait_event_type: row.wait_event_type,
        wait_event: row.wait_event,
        blocking_pids: row.blocking_pids,
        query: redactSensitiveText(row.query ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
      })),
      ungranted_pg_locks: ungrantedLocks,
      edge_logs: recentRedactedEdgeLogs().slice(-20),
    });
  } catch (err) {
    return `${stepName}: failed to capture lock diagnostics (${String(err)})`;
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
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<{ pid: number; blockedAt: Date }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{
      pid: number;
      now: Date;
    }[]>`
      SELECT pid, clock_timestamp() AS now
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (rows[0] !== undefined) {
      return { pid: rows[0].pid, blockedAt: rows[0].now };
    }
    await delay(25);
  }
  const diag = await captureLockDiagnostics(label);
  throw new Error(
    `${label}: timed out after ${timeoutMs}ms waiting for a backend blocked on pid ${blockerPid}\n${diag}`,
  );
}

async function waitForPgClockPast(
  targetIso: string,
  label: string,
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await sql<{ passed: boolean }[]>`
      SELECT clock_timestamp() > ${targetIso}::timestamptz + interval '50 milliseconds' AS passed
    `;
    if (row?.passed === true) return;
    await delay(40);
  }
  throw new Error(`${label}: timed out waiting for PostgreSQL clock_timestamp() > ${targetIso}`);
}

async function withHeldLock<T>(
  label: string,
  acquireLock: (tx: Tx) => Promise<void>,
  body: (ctx: {
    holderPid: number;
    releaseLock: () => Promise<void>;
    trackPending: <P>(p: Promise<P>) => Promise<P>;
  }) => Promise<T>,
): Promise<T> {
  const holderSql = openBoundedConnection(`ta-lock-${label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48)}`, true);
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
    if (holderError !== null) throw holderError;
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
      /* already closed */
    } finally {
      activeConnections.delete(holderSql);
    }
    if (pendingRequests.length > 0) {
      await Promise.race([Promise.allSettled(pendingRequests), delay(5_000)]);
    }
  }
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
      client_version: "0.1.109",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function sendTodoTool(
  bearer: string,
  workspaceId: string,
  tool: string,
  args: Row,
  commandId: string = randomUUID(),
  isRead = false,
): Promise<{ status: number; body: Row }> {
  return sendCommand(
    bearer,
    workspaceId,
    {
      kind: "household_tool",
      tool,
      arguments: {
        seat: HOUSEHOLD_LOCAL_SEAT,
        ...(isRead ? {} : { request_id: commandId }),
        ...args,
      },
    },
    commandId,
  );
}

async function readWaitingViewsAs(wsId: string, userId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    const [wt] = await tx<{ r: Row | null }[]>`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [wa] = await tx<{ r: Row | null }[]>`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [ho] = await tx<{ r: { workspaces: Array<{ workspace_id: string } & Row> } | null }[]>`
      SELECT swarm_read.home_overview() AS r
    `;
    const wsOverview = ho?.r?.workspaces.find((w) => w.workspace_id === wsId) ?? null;
    return { wt: wt?.r ?? null, wa: wa?.r ?? null, wsOverview };
  });
}

async function seedHouseholdWorkspace(opts: {
  name: string;
  members: Array<{
    user: Person;
    displayName: string;
    role: "owner" | "admin" | "member";
    contentRole?: "editor" | "reader" | null;
  }>;
  agents?: Array<{
    ownerId: string;
    name: string;
    contentAccess?: boolean;
  }>;
  channels?: Array<{
    slug: string;
    visibility: "open" | "private";
    createdByUserId: string;
    userMemberIds?: string[];
    agentMemberIndexes?: number[];
  }>;
}) {
  const wsId = randomUUID();
  const ownerMember = opts.members.find((m) => m.role === "owner") ?? opts.members[0]!;
  const consentsByUser = new Map<string, string>();
  const agents: SeededAgent[] = [];
  const channels = (opts.channels ?? []).map((spec) => ({ id: randomUUID(), ...spec }));

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.config (key, value)
      VALUES ('min_client_version', '"0.1.0"')
      ON CONFLICT (key) DO NOTHING
    `;
    for (const m of opts.members) {
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES (${m.user.id}::uuid, ${m.displayName})
        ON CONFLICT (user_id) DO NOTHING
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
    await tx`
      INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
      VALUES (${wsId}::uuid, 'shared')
    `;
    for (const m of opts.members) {
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${wsId}::uuid, ${m.user.id}::uuid, ${m.role})
      `;
      const contentRole = m.contentRole === undefined ? "editor" : m.contentRole;
      if (contentRole !== null) {
        const consentId = randomUUID();
        consentsByUser.set(m.user.id, consentId);
        await tx`
          INSERT INTO swarm.household_member_content_roles (
            workspace_id, user_id, content_role, content_consent_id, confirmed_at
          ) VALUES (
            ${wsId}::uuid, ${m.user.id}::uuid, ${contentRole}, ${consentId}::uuid, clock_timestamp()
          )
        `;
      }
    }

    const devicesByOwner = new Map<string, string>();
    for (const spec of opts.agents ?? []) {
      const id = randomUUID();
      const tokenId = randomUUID();
      const runId = randomUUID();
      const renewalGrantId = randomUUID();
      const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
      let deviceId = devicesByOwner.get(spec.ownerId);
      if (!deviceId) {
        deviceId = randomUUID();
        devicesByOwner.set(spec.ownerId, deviceId);
        await tx`
          INSERT INTO swarm.devices (device_id, user_id, label)
          VALUES (${deviceId}::uuid, ${spec.ownerId}::uuid, ${`${opts.name}-device`})
        `;
      }
      const [insertedPrincipal] = await tx<{ wake_id: string }[]>`
        INSERT INTO swarm.agent_principals (
          principal_id, workspace_id, owner_user_id, name, transport, turn_only
        ) VALUES (
          ${id}::uuid, ${wsId}::uuid, ${spec.ownerId}::uuid, ${spec.name}, 'local', false
        )
        RETURNING wake_id
      `;
      await tx`
        INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
        VALUES (${wsId}::uuid, ${id}::uuid, ${spec.ownerId}::uuid, ${spec.ownerId}::uuid)
        ON CONFLICT (principal_id, workspace_id) DO NOTHING
      `;
      await tx`
        INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${runId}::uuid, ${id}::uuid, ${deviceId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.renewal_grants (
          renewal_grant_id, workspace_id, principal_id, run_id, kind,
          max_successors, successors_used, horizon_expires_at, bound_device_id, created_by
        ) VALUES (
          ${renewalGrantId}::uuid, ${wsId}::uuid, ${id}::uuid, ${runId}::uuid, 'standing',
          NULL, 0, NULL, ${deviceId}::uuid, ${spec.ownerId}::uuid
        )
      `;
      await tx`
        INSERT INTO swarm.agent_tokens (
          token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id, renewal_grant_id
        ) VALUES (
          ${tokenId}::uuid,
          ${id}::uuid,
          ${runId}::uuid,
          ${tx.json(["post_signal", "read_signals"])}::jsonb,
          ${createHash("sha256").update(token).digest()},
          clock_timestamp() + interval '1 hour',
          ${randomUUID()}::uuid,
          ${renewalGrantId}::uuid
        )
      `;
      if (spec.contentAccess !== false) {
        const consentId = consentsByUser.get(spec.ownerId);
        assert.ok(consentId, `owner ${spec.ownerId} must have household consent for agent ${spec.name}`);
        await tx`
          INSERT INTO swarm.household_content_connections (
            connection_id, grant_id, workspace_id, principal_id, owner_user_id,
            purpose, operations, consent_receipt_id, expires_at, hosted_grant_id, renewal_grant_id
          ) VALUES (
            ${tokenId}::uuid, ${runId}::uuid, ${wsId}::uuid, ${id}::uuid, ${spec.ownerId}::uuid,
            'shared', ARRAY['read', 'create', 'update'], ${consentId}::uuid, NULL, NULL, ${renewalGrantId}::uuid
          )
        `;
      }
      agents.push({
        id,
        token,
        tokenId,
        runId,
        deviceId,
        renewalGrantId,
        ownerId: spec.ownerId,
        name: spec.name,
        wakeId: insertedPrincipal!.wake_id,
      });
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

  const allUserIds = opts.members.map((m) => m.user.id);
  const allPrincipalIds = [...allUserIds, ...agents.map((a) => a.id)];
  return {
    wsId,
    agents,
    channelsBySlug: Object.fromEntries(channels.map((ch) => [ch.slug, ch.id])) as Record<string, string>,
    cleanup: () => cleanupWorkspaceFixture(wsId, allUserIds, allPrincipalIds),
  };
}

async function cleanupWorkspaceFixture(
  wsId: string,
  userIds: string[],
  principalIds: string[],
): Promise<void> {
  try {
    await sql.begin(async (txClean) => {
      await txClean`SET LOCAL session_replication_role = replica`;
      await txClean`DELETE FROM swarm.waiting_dismissals WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_comments WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_todo_receipts WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_todo_events WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_todo_streams WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_agent_work_policies WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_todos WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_object_audit WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_object_streams WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_hosted_content_restrictions WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_content_connections WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.local_content_approval_workspaces WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_member_content_roles WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id = ${wsId}::uuid`;
      await txClean`DELETE FROM swarm.audit_log WHERE workspace_id = ${wsId}::uuid`;
      // swarm.idempotency_keys.principal_id is text, not uuid.
      await txClean`DELETE FROM swarm.idempotency_keys WHERE workspace_id = ${wsId}::uuid OR principal_id = ANY(${principalIds}::text[])`;
      await txClean`DELETE FROM swarm.rate_buckets WHERE bucket_key = ${`signal:workspace:${wsId}`} OR bucket_key = ${`todo:ws:${wsId.toLowerCase()}`}`;
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
      await txClean`DELETE FROM swarm.renewal_grants WHERE workspace_id = ${wsId}::uuid`;
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
      try {
        await admin.auth.admin.deleteUser(userId);
      } catch {
        /* ignore cleanup errors so primary assertions stand */
      }
    }
  } catch (err) {
    console.error(`[todo-approvals] cleanup warning: ${redactSensitiveText(String(err))}`);
  }
}

interface NoticeSideEffectSnapshot {
  signals: number;
  recipients: number;
  deliveries: number;
  conversationSignals: number;
  realtimeFrames: number;
}

async function countNoticeEffects(wsId: string, about: string, realtimeTopics: string[]): Promise<NoticeSideEffectSnapshot> {
  const [counts] = await sql<{
    signals: number;
    recipients: number;
    deliveries: number;
    conversation_signals: number;
    realtime_frames: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM swarm.signals s WHERE s.workspace_id = ${wsId}::uuid AND s.about = ${about}) AS signals,
      (SELECT count(*)::int FROM swarm.signal_recipients sr
        JOIN swarm.signals s ON s.workspace_id = sr.workspace_id AND s.id = sr.signal_id
        WHERE s.workspace_id = ${wsId}::uuid AND s.about = ${about}) AS recipients,
      (SELECT count(*)::int FROM swarm.signal_deliveries d
        JOIN swarm.signals s ON s.workspace_id = d.workspace_id AND s.id = d.signal_id
        WHERE s.workspace_id = ${wsId}::uuid AND s.about = ${about}) AS deliveries,
      (SELECT count(*)::int FROM swarm.conversation_signals cs
        JOIN swarm.signals s ON s.workspace_id = cs.workspace_id AND s.id = cs.signal_id
        WHERE s.workspace_id = ${wsId}::uuid AND s.about = ${about}) AS conversation_signals,
      (SELECT count(*)::int FROM realtime.messages m WHERE m.topic = ANY(${realtimeTopics}::text[])) AS realtime_frames
  `;
  return {
    signals: counts!.signals,
    recipients: counts!.recipients,
    deliveries: counts!.deliveries,
    conversationSignals: counts!.conversation_signals,
    realtimeFrames: counts!.realtime_frames,
  };
}

async function ensureRateBucketRows(bucketKeys: string[]): Promise<void> {
  await sql`
    INSERT INTO swarm.rate_buckets (bucket_key, window_start, count)
    SELECT k, w, 0
    FROM unnest(${bucketKeys}::text[]) AS k
    CROSS JOIN (
      VALUES
        (date_trunc('hour', clock_timestamp())),
        (date_trunc('hour', clock_timestamp() + interval '1 hour'))
    ) AS windows(w)
    ON CONFLICT (bucket_key, window_start) DO NOTHING
  `;
}

before(async () => {
  step("before: start local environment and supabase functions serve");
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-todo-approvals-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(
    envFile,
    "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\nSWARM_INTERACTIVE_REPLIES=1\n",
    { mode: 0o600 },
  );
  sql = openBoundedConnection("todo-approvals-test", false);
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
  if (envDir) {
    try { rmSync(envDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const conns = [...activeConnections];
  activeConnections.clear();
  await Promise.allSettled(conns.map((conn) => conn.end({ timeout: 5 })));
  step("after: teardown complete");
});

// ---------------------------------------------------------------------------
// Suite 1: Catalog, functional, rollback, re-apply, and Condition 1 DB CHECKs
// ---------------------------------------------------------------------------
test(
  "Suite 1: 20261125000004 catalog, functional, rollback, re-apply, privilege inventory, and all 5 Condition 1 DB CHECK constraints",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    step("Suite 1: running isolated runSql proofs and DB CHECK witness");
    const ownerId = randomUUID();
    const wsId = randomUUID();
    const agentId = randomUUID();
    const chId = randomUUID();
    const dmConvId = randomUUID();

    runSql(`
      ${sqlPhase("forward-catalog", catalogAssert(false))}
      ${sqlPhase("forward-functional", repoSql(`${proofRoot}-functional.sql`))}

      -- Snapshot SECURITY DEFINER functions and grants on the 3 replaced functions before rollback.
      CREATE TEMP TABLE secdef_before AS
      SELECT p.oid::regprocedure::text AS sig, p.proowner::regrole::text AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname IN ('swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops')
        AND p.prosecdef;

      ${sqlPhase("rollback", repoSql(`${proofRoot}-rollback.sql`))}
      ${sqlPhase("rollback-catalog", catalogAssert(true))}

      -- Assert zero SECURITY DEFINER functions were added or removed by the migration.
      ${dbAssert(`
        SELECT NOT EXISTS (
          (SELECT sig, owner FROM secdef_before
           EXCEPT
           SELECT p.oid::regprocedure::text, p.proowner::regrole::text
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops') AND p.prosecdef)
          UNION ALL
          (SELECT p.oid::regprocedure::text, p.proowner::regrole::text
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname IN ('swarm', 'swarm_read', 'commonswarm_oauth', 'commonswarm_ops') AND p.prosecdef
           EXCEPT
           SELECT sig, owner FROM secdef_before)
        )
      `, "rollback preserves exact SECURITY DEFINER inventory")}

      ${sqlPhase("reapply", repoSql("supabase/migrations/20261125000004_todo_approvals.sql"))}
      ${sqlPhase("reapply-catalog", catalogAssert(false))}
      ${sqlPhase("reapply-functional", repoSql(`${proofRoot}-functional.sql`))}

      -- Confirm waiting_todos_page, waiting_archived_page, and home_overview remain authenticated-only.
      ${dbAssert(`
        SELECT
          has_function_privilege('authenticated', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('PUBLIC', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('swarm_read', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
          AND NOT has_function_privilege('swarm_command', 'swarm_read.waiting_todos_page(uuid,integer,timestamp with time zone,uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
          AND NOT has_function_privilege('PUBLIC', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
          AND NOT has_function_privilege('swarm_read', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
          AND NOT has_function_privilege('swarm_command', 'swarm_read.waiting_archived_page(uuid,integer,timestamp with time zone,text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'swarm_read.home_overview()', 'EXECUTE')
          AND NOT has_function_privilege('PUBLIC', 'swarm_read.home_overview()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'swarm_read.home_overview()', 'EXECUTE')
          AND NOT has_function_privilege('swarm_read', 'swarm_read.home_overview()', 'EXECUTE')
          AND NOT has_function_privilege('swarm_command', 'swarm_read.home_overview()', 'EXECUTE')
      `, "read functions remain authenticated-only")}

      -- Seed minimal fixture for direct Condition 1 CHECK constraint verification.
      INSERT INTO auth.users (id, aud, role, email)
      VALUES ('${ownerId}', 'authenticated', 'authenticated', '${ownerId}@example.test');
      INSERT INTO swarm.users (user_id, display_name) VALUES ('${ownerId}', 'CheckOwner');
      INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES ('${wsId}', 'CheckWS', '${ownerId}');
      INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES ('${wsId}', '${ownerId}', 'owner');
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES ('${agentId}', '${wsId}', '${ownerId}', 'CheckAgent');
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES ('${chId}', '${wsId}', 'check-ch', 'open', '${ownerId}', 'user');
      INSERT INTO swarm.conversations (conversation_id, workspace_id, kind, member_key, generation, created_by_kind, created_by_principal)
      VALUES ('${dmConvId}', '${wsId}', 'dm', 'check-dm-key', 0, 'user', '${ownerId}');

      -- Positive controls: valid approved approval (workspace) and valid declined approval (general).
      INSERT INTO swarm.household_todos (
        workspace_id, todo_id, version, kind, title, notes, state,
        created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
        gate_kind, state_by_user, state_at, comment_count, last_seq,
        decision_status, decision_by_user, decision_at, decision_note, origin_placement
      ) VALUES
        ('${wsId}', '${randomUUID()}', 2, 'approval', 'Valid approved', '', 'done',
         '${ownerId}', clock_timestamp(), '${ownerId}', '${ownerId}', clock_timestamp(),
         'none', '${ownerId}', clock_timestamp(), 0, 1,
         'approved', '${ownerId}', clock_timestamp(), 'Approved with note', 'workspace'),
        ('${wsId}', '${randomUUID()}', 2, 'approval', 'Valid declined', '', 'dropped',
         '${ownerId}', clock_timestamp(), '${ownerId}', '${ownerId}', clock_timestamp(),
         'none', '${ownerId}', clock_timestamp(), 0, 2,
         'declined', '${ownerId}', clock_timestamp(), NULL, 'general');

      -- 1) Tightened R3/R4 CHECK: rejects decision_status='approved', decision_by_user=NULL, decision_at=NULL, decision_note='ok'
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Missing by and at', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 10,
          'approved', NULL, NULL, 'ok'
        )
      `, "23514")}

      -- 2a) Rejects decision_by_user IS NULL when decision_status IS NOT NULL
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Missing by', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 11,
          'approved', NULL, clock_timestamp(), NULL
        )
      `, "23514")}

      -- 2b) Rejects decision_at IS NULL when decision_status IS NOT NULL
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Missing at', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 12,
          'approved', '${ownerId}', NULL, NULL
        )
      `, "23514")}

      -- 3) Rejects non-NULL decision_note when decision_status IS NULL
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Stray note', '', 'open',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 13,
          NULL, NULL, NULL, 'stray note'
        )
      `, "23514")}

      -- 4) Rejects kind='task' with non-NULL decision_status
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'task', 'Task with decision', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 14,
          'approved', '${ownerId}', clock_timestamp()
        )
      `, "23514")}

      -- 5) Rejects kind='approval' with assignee_principal IS NOT NULL
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_principal, gate_kind, state_by_user, state_at, last_seq
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Agent assigned approval', '', 'open',
          '${ownerId}', clock_timestamp(), '${agentId}', 'none', '${ownerId}', clock_timestamp(), 15
        )
      `, "23514")}

      -- 6a) Rejects kind='approval' with origin_placement='channel' + origin_channel_id
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          origin_placement, origin_channel_id
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Channel approval', '', 'open',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 16,
          'channel', '${chId}'
        )
      `, "23514")}

      -- 6b) Rejects kind='approval' with origin_placement='dm' + origin_conversation_id
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          origin_placement, origin_conversation_id
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'DM approval', '', 'open',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 17,
          'dm', '${dmConvId}'
        )
      `, "23514")}

      -- 6c) Rejects kind='approval' with origin_placement='group_dm'
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          origin_placement, origin_conversation_id
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Group DM approval', '', 'open',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 18,
          'group_dm', '${dmConvId}'
        )
      `, "23514")}

      -- 7a) Rejects (decision_status='approved', state<>'done')
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Approved but open', '', 'open',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 19,
          'approved', '${ownerId}', clock_timestamp()
        )
      `, "23514")}

      -- 7b) Rejects (decision_status='declined', state<>'dropped')
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Declined but done', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 20,
          'declined', '${ownerId}', clock_timestamp()
        )
      `, "23514")}

      -- 8) Rejects decision_note with forbidden control char or length > 500
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Control char note', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 21,
          'approved', '${ownerId}', clock_timestamp(), chr(1)
        )
      `, "23514")}
      ${refuses(`
        INSERT INTO swarm.household_todos (
          workspace_id, todo_id, version, kind, title, notes, state,
          created_by_user, created_at, assignee_user, gate_kind, state_by_user, state_at, last_seq,
          decision_status, decision_by_user, decision_at, decision_note
        ) VALUES (
          '${wsId}', '${randomUUID()}', 1, 'approval', 'Oversized note', '', 'done',
          '${ownerId}', clock_timestamp(), '${ownerId}', 'none', '${ownerId}', clock_timestamp(), 22,
          'approved', '${ownerId}', clock_timestamp(), repeat('a', 501)
        )
      `, "23514")}
    `);
    step("Suite 1: done");
  },
);

// ---------------------------------------------------------------------------
// Suite 2: Approval workflow, dependent gates, start_now survival + reopen re-block
// ---------------------------------------------------------------------------
test(
  "Suite 2: approval workflow, origin rules, dependent gates in home_overview & todo_queue, start_now gate survival, and reopen re-block",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 2: setup workspace");
    const owner = await createUser("s2-owner");
    const decider = await createUser("s2-decider");
    const bystander = await createUser("s2-bystander");
    const fx = await seedHouseholdWorkspace({
      name: "Suite2ApprovalWS",
      members: [
        { user: owner, displayName: "Owner", role: "owner" },
        { user: decider, displayName: "Decider", role: "member" },
        { user: bystander, displayName: "Bystander", role: "member" },
      ],
      agents: [
        { ownerId: decider.id, name: "DeciderAgent" },
        { ownerId: owner.id, name: "WorkerAgent" },
      ],
      channels: [
        {
          slug: "open-room",
          visibility: "open",
          createdByUserId: owner.id,
          userMemberIds: [owner.id, decider.id],
        },
      ],
    });

    try {
      const deciderAgent = fx.agents[0]!;
      const workerAgent = fx.agents[1]!;
      const openChannelId = fx.channelsBySlug["open-room"]!;

      // Open 1:1 DM and Group DM so origin_conversation_id is accessible for the refusal witness.
      const [dmRow] = await sql<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${fx.wsId}::uuid, 'user', ${owner.id}::uuid, ARRAY[${decider.id}]::uuid[], '{}'::uuid[], false
        ) AS r
      `;
      const [groupRow] = await sql<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${fx.wsId}::uuid, 'user', ${owner.id}::uuid, ARRAY[${decider.id}, ${bystander.id}]::uuid[], '{}'::uuid[], false
        ) AS r
      `;
      const dmConvId = dmRow!.r.conversation.conversation_id;
      const groupConvId = groupRow!.r.conversation.conversation_id;

      // 1. Origin rules: workspace & general succeed; channel/dm/group_dm refused with approval_origin_not_allowed.
      const wsApprovalResp = await sendTodoTool(deciderAgent.token, fx.wsId, "todo_create", {
        kind: "approval",
        title: "Approve furnace replacement",
        notes: "Quote is $4,200 from Acme Heating.",
        assign: { to: { kind: "user", id: decider.id } },
      });
      assert.equal(wsApprovalResp.status, 200, respDiag("wsApprovalResp", wsApprovalResp));
      assert.equal(wsApprovalResp.body.status, "committed", respDiag("wsApprovalResp", wsApprovalResp));
      const wsApproval = wsApprovalResp.body.value as Row;
      assert.equal(wsApproval.kind, "approval");
      assert.equal(wsApproval.offer, null, "approval assigns directly without an offer");
      assert.deepEqual(wsApproval.assignee, { kind: "user", id: decider.id });

      const generalApprovalResp = await sendTodoTool(owner.jwt, fx.wsId, "todo_create", {
        kind: "approval",
        title: "Approve general announcement",
        origin_placement: "general",
        assign: { to: { kind: "user", id: decider.id } },
      });
      assert.equal(generalApprovalResp.status, 200, respDiag("generalApprovalResp", generalApprovalResp));
      assert.equal(generalApprovalResp.body.status, "committed", respDiag("generalApprovalResp", generalApprovalResp));

      for (const badOrigin of [
        { label: "channel", origin_placement: "channel", origin_channel_id: openChannelId },
        { label: "dm", origin_placement: "dm", origin_conversation_id: dmConvId },
        { label: "group_dm", origin_placement: "group_dm", origin_conversation_id: groupConvId },
      ]) {
        const refused = await sendTodoTool(owner.jwt, fx.wsId, "todo_create", {
          kind: "approval",
          title: `Bad ${badOrigin.label} approval`,
          assign: { to: { kind: "user", id: decider.id } },
          origin_placement: badOrigin.origin_placement,
          ...(badOrigin.origin_channel_id ? { origin_channel_id: badOrigin.origin_channel_id } : {}),
          ...(badOrigin.origin_conversation_id ? { origin_conversation_id: badOrigin.origin_conversation_id } : {}),
        });
        assert.equal(refused.status, 200, respDiag(badOrigin.label, refused));
        assert.equal(refused.body.status, "refused", respDiag(badOrigin.label, refused));
        assert.equal(refused.body.reason, "approval_origin_not_allowed", respDiag(badOrigin.label, refused));
      }

      // 2. Authorization refusals on household_todo_decide:
      //    - Assignee's own agent refused human_confirmation_required
      //    - Non-assignee human (workspace owner) refused not_decider
      const agentDecide = await sendCommand(deciderAgent.token, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: wsApproval.todo_id,
        base_version: wsApproval.version,
        decision: "approve",
      });
      assert.equal(agentDecide.body.status, "refused", respDiag("agentDecide", agentDecide));
      assert.equal(agentDecide.body.reason, "human_confirmation_required");

      const ownerNotDecider = await sendCommand(owner.jwt, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: wsApproval.todo_id,
        base_version: wsApproval.version,
        decision: "approve",
      });
      assert.equal(ownerNotDecider.body.status, "refused", respDiag("ownerNotDecider", ownerNotDecider));
      assert.equal(ownerNotDecider.body.reason, "not_decider");

      // 3. Create dependent task assigned to workerAgent gated `after` wsApproval.
      const depResp = await sendTodoTool(owner.jwt, fx.wsId, "todo_create", {
        title: "Book furnace installer",
        assign: {
          to: { kind: "agent", id: workerAgent.id },
          gate: { kind: "after", todo_id: wsApproval.todo_id },
        },
      });
      assert.equal(depResp.body.status, "committed", respDiag("depResp", depResp));
      const depTodo = depResp.body.value as Row;

      const checkGateViews = async (label: string, expectClear: boolean) => {
        const views = await readWaitingViewsAs(fx.wsId, owner.id);
        const people = (views.wsOverview!.people as Array<{ agents: Array<{ principal_id: string; queue: { up_next: number; not_yet: number } }> }>);
        const workerEntry = people.flatMap((p) => p.agents).find((a) => a.principal_id === workerAgent.id);
        assert.ok(workerEntry, `${label}: workerAgent missing from home_overview`);
        assert.equal(workerEntry.queue.up_next, expectClear ? 1 : 0, `${label}: home_overview up_next`);
        assert.equal(workerEntry.queue.not_yet, expectClear ? 0 : 1, `${label}: home_overview not_yet`);

        const qResp = await sendTodoTool(owner.jwt, fx.wsId, "todo_queue", { principal_id: workerAgent.id }, randomUUID(), true);
        assert.equal(qResp.body.status, "ok", respDiag(`${label} todo_queue`, qResp));
        const q = qResp.body.queue as { up_next: Array<Row>; not_yet: Array<Row> };
        if (expectClear) {
          assert.equal(q.up_next.length, 1, `${label}: todo_queue up_next`);
          assert.equal(q.not_yet.length, 0, `${label}: todo_queue not_yet`);
          assert.equal((q.up_next[0]!.gate as Row).clear, true);
          assert.equal(q.up_next[0]!.queue_position, 1);
        } else {
          assert.equal(q.up_next.length, 0, `${label}: todo_queue up_next`);
          assert.equal(q.not_yet.length, 1, `${label}: todo_queue not_yet`);
          assert.equal((q.not_yet[0]!.gate as Row).clear, false);
          assert.equal(q.not_yet[0]!.queue_position, null);
        }
      };

      // (a) Unapproved (open) approval -> gate_clear = false.
      await checkGateViews("unapproved", false);

      // (b) Declined approval (without note) -> gate_clear = false; todo_update frozen.
      const declinedResp = await sendCommand(decider.jwt, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: wsApproval.todo_id,
        base_version: wsApproval.version,
        decision: "decline",
      });
      assert.equal(declinedResp.body.status, "committed", respDiag("declinedResp", declinedResp));
      const declined = declinedResp.body.value as Row;
      assert.equal(declined.state, "dropped");
      assert.equal(declined.decision_status, "declined");
      assert.equal(declined.decision_note, null);

      const frozenDeclinedUpdate = await sendTodoTool(decider.jwt, fx.wsId, "todo_update", {
        todo_id: declined.todo_id,
        base_version: declined.version,
        title: "Mutated after decline",
      });
      assert.equal(frozenDeclinedUpdate.body.status, "refused", respDiag("frozenDeclinedUpdate", frozenDeclinedUpdate));
      assert.equal(frozenDeclinedUpdate.body.reason, "approval_decided_frozen");
      await checkGateViews("declined", false);

      // (c) Reopen decided approval: agent refused, non-decider non-admin refused, decider succeeds and clears decision_*.
      const agentReopen = await sendTodoTool(deciderAgent.token, fx.wsId, "todo_set_state", {
        todo_id: declined.todo_id,
        base_version: declined.version,
        state: "open",
      });
      assert.equal(agentReopen.body.status, "refused");
      assert.equal(agentReopen.body.reason, "human_confirmation_required");

      const bystanderReopen = await sendTodoTool(bystander.jwt, fx.wsId, "todo_set_state", {
        todo_id: declined.todo_id,
        base_version: declined.version,
        state: "open",
      });
      assert.equal(bystanderReopen.body.status, "refused");
      assert.equal(bystanderReopen.body.reason, "not_permitted");

      const reopenedResp = await sendTodoTool(decider.jwt, fx.wsId, "todo_set_state", {
        todo_id: declined.todo_id,
        base_version: declined.version,
        state: "open",
      });
      assert.equal(reopenedResp.body.status, "committed", respDiag("reopenedResp", reopenedResp));
      const reopened = reopenedResp.body.value as Row;
      assert.equal(reopened.state, "open");
      assert.equal(reopened.decision_status, null);
      assert.equal(reopened.decision_by_user, null);
      assert.equal(reopened.decision_at, null);
      assert.equal(reopened.decision_note, null);

      // (d) Dropped-without-decision via todo_set_state(dropped) -> gate_clear = false.
      const droppedNoDecisionResp = await sendTodoTool(decider.jwt, fx.wsId, "todo_set_state", {
        todo_id: reopened.todo_id,
        base_version: reopened.version,
        state: "dropped",
      });
      assert.equal(droppedNoDecisionResp.body.status, "committed");
      const droppedNoDecision = droppedNoDecisionResp.body.value as Row;
      assert.equal(droppedNoDecision.decision_status, null);
      await checkGateViews("dropped-without-decision", false);

      // Reopen again and APPROVE with note -> gate_clear = true, todo_update frozen.
      const reopened2 = (await sendTodoTool(owner.jwt, fx.wsId, "todo_set_state", {
        todo_id: droppedNoDecision.todo_id,
        base_version: droppedNoDecision.version,
        state: "open",
      })).body.value as Row;

      const approvedResp = await sendCommand(decider.jwt, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: reopened2.todo_id,
        base_version: reopened2.version,
        decision: "approve",
        note: "Proceed with Acme quote.",
      });
      assert.equal(approvedResp.body.status, "committed", respDiag("approvedResp", approvedResp));
      const approved = approvedResp.body.value as Row;
      assert.equal(approved.state, "done");
      assert.equal(approved.decision_status, "approved");
      assert.equal(approved.decision_by_user, decider.id);
      assert.equal(approved.decision_note, "Proceed with Acme quote.");

      const frozenApprovedUpdate = await sendTodoTool(decider.jwt, fx.wsId, "todo_update", {
        todo_id: approved.todo_id,
        base_version: approved.version,
        notes: "Tampered post-approval",
      });
      assert.equal(frozenApprovedUpdate.body.status, "refused");
      assert.equal(frozenApprovedUpdate.body.reason, "approval_decided_frozen");
      await checkGateViews("approved", true);

      // 4. Successful household_todo_steer(start_now) while approved preserves gate_kind='after', gate_todo_id, gate_set_by!
      const [beforeSteerRow] = await sql<{ gate_kind: string; gate_todo_id: string | null; gate_set_by: string | null }[]>`
        SELECT gate_kind, gate_todo_id, gate_set_by FROM swarm.household_todos
        WHERE workspace_id = ${fx.wsId}::uuid AND todo_id = ${depTodo.todo_id as string}::uuid
      `;
      assert.equal(beforeSteerRow!.gate_kind, "after");
      assert.equal(beforeSteerRow!.gate_todo_id, wsApproval.todo_id);
      assert.equal(beforeSteerRow!.gate_set_by, owner.id);

      const steerResp = await sendCommand(owner.jwt, fx.wsId, {
        kind: "household_todo_steer",
        todo_id: depTodo.todo_id,
        base_version: depTodo.version,
        action: { kind: "start_now" },
      });
      assert.equal(steerResp.body.status, "committed", respDiag("steerResp", steerResp));
      const steeredDep = steerResp.body.value as Row;

      const [afterSteerRow] = await sql<{ gate_kind: string; gate_todo_id: string | null; gate_set_by: string | null }[]>`
        SELECT gate_kind, gate_todo_id, gate_set_by FROM swarm.household_todos
        WHERE workspace_id = ${fx.wsId}::uuid AND todo_id = ${depTodo.todo_id as string}::uuid
      `;
      assert.equal(afterSteerRow!.gate_kind, "after", "start_now must preserve approval gate_kind");
      assert.equal(afterSteerRow!.gate_todo_id, wsApproval.todo_id, "start_now must preserve approval gate_todo_id");
      assert.equal(afterSteerRow!.gate_set_by, owner.id, "start_now must preserve gate_set_by");

      // Reopen the approval -> immediately re-blocks home_overview, todo_queue, todo_start, todo_set_state(doing), and start_now!
      const reopened3 = (await sendTodoTool(decider.jwt, fx.wsId, "todo_set_state", {
        todo_id: approved.todo_id,
        base_version: approved.version,
        state: "open",
      })).body.value as Row;
      assert.equal(reopened3.decision_status, null);
      await checkGateViews("reopened-after-start-now", false);

      const blockedStart = await sendTodoTool(workerAgent.token, fx.wsId, "todo_start", {
        todo_id: steeredDep.todo_id,
      });
      assert.equal(blockedStart.body.status, "refused", respDiag("blockedStart", blockedStart));
      assert.equal(blockedStart.body.reason, "gate_invalid");

      const blockedDoing = await sendTodoTool(workerAgent.token, fx.wsId, "todo_set_state", {
        todo_id: steeredDep.todo_id,
        base_version: steeredDep.version,
        state: "doing",
      });
      assert.equal(blockedDoing.body.status, "refused", respDiag("blockedDoing", blockedDoing));
      assert.equal(blockedDoing.body.reason, "gate_invalid");

      const blockedSteer = await sendCommand(owner.jwt, fx.wsId, {
        kind: "household_todo_steer",
        todo_id: steeredDep.todo_id,
        base_version: steeredDep.version,
        action: { kind: "start_now" },
      });
      assert.equal(blockedSteer.body.status, "refused", respDiag("blockedSteer", blockedSteer));
      assert.equal(blockedSteer.body.reason, "gate_invalid");

      step("Suite 2: done");
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 3: Condition 2 live controls, rate-bucket wait witness, R4 late-write
//          contention witnesses + live controls, read-right loss, replay proof
// ---------------------------------------------------------------------------
test(
  "Suite 3: Condition 2 live controls, rate-bucket wait across deadline, R4 late-write contention witnesses + live controls, read-right loss, and replay proof",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 3: setup workspace");
    const decider = await createUser("s3-decider");
    const requesterHuman = await createUser("s3-req-human");
    const extraMember = await createUser("s3-extra");
    const fx = await seedHouseholdWorkspace({
      name: "Suite3NoticeBoundaryWS",
      members: [
        { user: decider, displayName: "Decider", role: "owner" },
        { user: requesterHuman, displayName: "ReqHuman", role: "member" },
        { user: extraMember, displayName: "Extra", role: "member" },
      ],
      agents: [
        { ownerId: decider.id, name: "OwnAgent" },
        { ownerId: requesterHuman.id, name: "CrossOwnerAgent" },
        { ownerId: extraMember.id, name: "ExtraAgent" },
      ],
    });

    try {
      const ownAgent = fx.agents[0]!;
      const crossAgent = fx.agents[1]!;
      const extraAgent = fx.agents[2]!;

      const setAgentDeadline = async (agent: SeededAgent, intervalSql: string | null): Promise<string | null> => {
        if (intervalSql === null) {
          await sql`
            UPDATE swarm.renewal_grants
            SET connection_expires_at = NULL, connection_expired_at = NULL
            WHERE renewal_grant_id = ${agent.renewalGrantId}::uuid
          `;
          return null;
        }
        const [row] = await sql<{ exp: Date }[]>`
          UPDATE swarm.renewal_grants
          SET connection_expires_at = clock_timestamp() + ${intervalSql}::interval,
              connection_expired_at = NULL
          WHERE renewal_grant_id = ${agent.renewalGrantId}::uuid
          RETURNING connection_expires_at AS exp
        `;
        return row!.exp.toISOString();
      };

      const createApprovalBy = async (bearer: string, title: string): Promise<Row> => {
        const resp = await sendTodoTool(bearer, fx.wsId, "todo_create", {
          kind: "approval",
          title,
          assign: { to: { kind: "user", id: decider.id } },
        });
        assert.equal(resp.status, 200, respDiag("createApprovalBy", resp));
        assert.equal(resp.body.status, "committed", respDiag("createApprovalBy", resp));
        return resp.body.value as Row;
      };

      const createOfferToDeciderAgentBy = async (bearer: string, targetAgent: SeededAgent, title: string): Promise<Row> => {
        const resp = await sendTodoTool(bearer, fx.wsId, "todo_create", {
          title,
          assign: { to: { kind: "agent", id: targetAgent.id }, start: "queue" },
        });
        assert.equal(resp.status, 200, respDiag("createOfferToDeciderAgentBy", resp));
        assert.equal(resp.body.status, "committed", respDiag("createOfferToDeciderAgentBy", resp));
        const val = resp.body.value as Row;
        assert.ok(val.offer, `expected pending offer on ${title}: ${JSON.stringify(val)}`);
        return val;
      };

      // --- 3.1 Live-recipient controls: (a) own agent, (b) cross-owner agent, (c) human requester ---
      step("Suite 3.1: live-recipient controls");
      for (const scenario of [
        {
          label: "own-agent",
          bearer: ownAgent.token,
          expectedParty: { kind: "agent", id: ownAgent.id },
          decision: "approve" as const,
          expectedBody: "Approved your to-do.",
          isAgent: true,
        },
        {
          label: "cross-owner-agent",
          bearer: crossAgent.token,
          expectedParty: { kind: "agent", id: crossAgent.id },
          decision: "decline" as const,
          expectedBody: "Declined your to-do.",
          isAgent: true,
        },
        {
          label: "human-requester",
          bearer: requesterHuman.jwt,
          expectedParty: { kind: "user", id: requesterHuman.id },
          decision: "approve" as const,
          expectedBody: "Approved your to-do.",
          isAgent: false,
        },
      ]) {
        const secretTitle = `SECRET_TITLE_${scenario.label}_${randomUUID()}`;
        const secretNote = `SECRET_NOTE_${scenario.label}_${randomUUID()}`;
        const approval = await createApprovalBy(scenario.bearer, secretTitle);
        const cmdId = randomUUID();
        const decideResp = await sendCommand(
          decider.jwt,
          fx.wsId,
          {
            kind: "household_todo_decide",
            todo_id: approval.todo_id,
            base_version: approval.version,
            decision: scenario.decision,
            note: secretNote,
          },
          cmdId,
        );
        assert.equal(decideResp.status, 200, respDiag(`live control ${scenario.label}`, decideResp));
        assert.equal(decideResp.body.status, "committed", respDiag(`live control ${scenario.label}`, decideResp));
        const notices = decideResp.body.notices as Array<Row>;
        assert.equal(notices.length, 1);
        assert.equal(notices[0]!.status, "sent", `live control ${scenario.label} notice`);
        assert.deepEqual(notices[0]!.to, [scenario.expectedParty]);
        const signalId = notices[0]!.signal_id as string;

        const [ev] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM swarm.household_todo_events
          WHERE workspace_id = ${fx.wsId}::uuid
            AND event->>'type' = 'TodoDecided'
            AND event->'payload'->'todo'->>'todo_id' = ${approval.todo_id as string}
        `;
        assert.equal(ev!.count, 1, `${scenario.label}: TodoDecided committed`);

        const [receipt] = await sql<{ count: number }[]>`
          SELECT count(*)::int AS count FROM swarm.household_todo_receipts
          WHERE workspace_id = ${fx.wsId}::uuid AND command_id = ${cmdId}
        `;
        assert.equal(receipt!.count, 1, `${scenario.label}: receipt recorded`);

        const [sig] = await sql<{ body: string; about: string; channel_id: string | null }[]>`
          SELECT body, about, channel_id FROM swarm.signals
          WHERE workspace_id = ${fx.wsId}::uuid AND id = ${signalId}::uuid
        `;
        assert.equal(sig!.body, scenario.expectedBody);
        assert.equal(sig!.about, `todo:${approval.todo_id as string}`);
        assert.equal(sig!.channel_id, null);
        assert.equal(sig!.body.includes(secretNote), false, "zero note leakage");
        assert.equal(sig!.body.includes(secretTitle), false, "zero title leakage");

        const [filing] = await sql<{ audience: string; kind: string }[]>`
          SELECT cs.audience, c.kind
          FROM swarm.conversation_signals cs
          JOIN swarm.conversations c ON c.conversation_id = cs.conversation_id
          WHERE cs.workspace_id = ${fx.wsId}::uuid AND cs.signal_id = ${signalId}::uuid
        `;
        assert.equal(filing!.audience, "private", `${scenario.label}: private DM filing`);
        assert.equal(filing!.kind, "dm", `${scenario.label}: canonical 1:1 DM`);

        if (scenario.isAgent) {
          const [deliv] = await sql<{ count: number }[]>`
            SELECT count(*)::int AS count FROM swarm.signal_deliveries
            WHERE workspace_id = ${fx.wsId}::uuid
              AND signal_id = ${signalId}::uuid
              AND recipient_agent_principal_id = ${scenario.expectedParty.id}::uuid
          `;
          assert.equal(deliv!.count, 1, `${scenario.label}: exactly 1 delivery wake row`);
        }
      }

      // --- 3.2 Rate-bucket wait across connection_expires_at deadline witness + live control ---
      step("Suite 3.2: rate-bucket wait across connection_expires_at witness + live control");
      const wsRateKey = `signal:workspace:${fx.wsId}`;
      await ensureRateBucketRows([wsRateKey]);
      const memberDeciderTopic = `cswarm-member:${fx.wsId}:${decider.id}`;
      const ownWakeTopic = `cswarm-wake:${ownAgent.wakeId}`;
      const ownRealtimeTopics = [ownWakeTopic, memberDeciderTopic];

      // (a) household_todo_decide rate-bucket witness (expires during hold)
      {
        const approval = await createApprovalBy(ownAgent.token, "Rate-bucket decide expiry witness");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "rate-bucket-decide-expire",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.rate_buckets WHERE bucket_key = ${wsRateKey} FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const expiresAt = (await setAgentDeadline(ownAgent, "2000 milliseconds"))!;
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
              note: "Approved during rate-bucket wait",
            }));
            await waitForBlockedOnPid(holderPid, "rate-bucket-decide-expire wait");
            await waitForPgClockPast(expiresAt, "rate-bucket-decide-expire clock");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "rate-bucket-decide-expire resp");
            assert.equal(resp.status, 200, respDiag("rate-bucket-decide-expire", resp));
            assert.equal(resp.body.status, "committed", respDiag("rate-bucket-decide-expire", resp));
            assert.equal((resp.body.value as Row).decision_status, "approved");
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: ownAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.deepEqual(afterFx, beforeFx, "rate-bucket decide expiry must leave zero committed notice effects");
        await setAgentDeadline(ownAgent, null);
      }

      // (b) household_todo_answer rate-bucket witness (expires during hold)
      {
        const offerTodo = await createOfferToDeciderAgentBy(crossAgent.token, ownAgent, "Rate-bucket answer expiry witness");
        const about = `todo:${offerTodo.todo_id as string}`;
        const crossTopics = [`cswarm-wake:${crossAgent.wakeId}`, memberDeciderTopic];
        const beforeFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        await withHeldLock(
          "rate-bucket-answer-expire",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.rate_buckets WHERE bucket_key = ${wsRateKey} FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const expiresAt = (await setAgentDeadline(crossAgent, "2000 milliseconds"))!;
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_answer",
              todo_id: offerTodo.todo_id,
              offer_id: (offerTodo.offer as Row).offer_id,
              base_version: offerTodo.version,
              answer: "decline",
            }));
            await waitForBlockedOnPid(holderPid, "rate-bucket-answer-expire wait");
            await waitForPgClockPast(expiresAt, "rate-bucket-answer-expire clock");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "rate-bucket-answer-expire resp");
            assert.equal(resp.status, 200, respDiag("rate-bucket-answer-expire", resp));
            assert.equal(resp.body.status, "committed", respDiag("rate-bucket-answer-expire", resp));
            assert.equal((resp.body.value as Row).offer, null);
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: crossAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        assert.deepEqual(afterFx, beforeFx, "rate-bucket answer expiry must leave zero committed notice effects");
        await setAgentDeadline(crossAgent, null);
      }

      // (c) Rate-bucket LIVE CONTROL (released before deadline -> commits all notice effects)
      {
        const approval = await createApprovalBy(ownAgent.token, "Rate-bucket live control");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "rate-bucket-live-control",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.rate_buckets WHERE bucket_key = ${wsRateKey} FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            await setAgentDeadline(ownAgent, "60 seconds");
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
            }));
            await waitForBlockedOnPid(holderPid, "rate-bucket-live-control wait");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "rate-bucket-live-control resp");
            assert.equal(resp.status, 200, respDiag("rate-bucket-live-control", resp));
            assert.equal(resp.body.status, "committed", respDiag("rate-bucket-live-control", resp));
            const notices = resp.body.notices as Array<Row>;
            assert.equal(notices[0]!.status, "sent");
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.equal(afterFx.signals, beforeFx.signals + 1, "rate-bucket live control commits signal");
        assert.equal(afterFx.recipients, beforeFx.recipients + 1, "rate-bucket live control commits recipient");
        assert.equal(afterFx.deliveries, beforeFx.deliveries + 1, "rate-bucket live control commits delivery");
        assert.equal(afterFx.conversationSignals, beforeFx.conversationSignals + 1, "rate-bucket live control files DM");
        assert.ok(afterFx.realtimeFrames >= beforeFx.realtimeFrames + 2, "rate-bucket live control emits wake + member frames");
        await setAgentDeadline(ownAgent, null);
      }

      // --- 3.3 R4 late-write contention witnesses + live controls ---
      // Proves Step C passes live (clock_timestamp() < connection_expires_at), Step D writes signal/delivery,
      // Step E (spend shards) or Step F (deferred filing FOR SHARE on pre-seeded 1:1 DM) blocks across deadline,
      // and Step G executes ROLLBACK TO SAVEPOINT leaving zero committed notice effects.
      step("Suite 3.3a: R4 late-write Step F swarm.conversations contention witness + live control");
      const [ownDmRow] = await sql<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${fx.wsId}::uuid, 'user', ${decider.id}::uuid, '{}'::uuid[], ARRAY[${ownAgent.id}]::uuid[], false
        ) AS r
      `;
      const ownDmConvId = ownDmRow!.r.conversation.conversation_id;

      const [crossDmRow] = await sql<{ r: { conversation: { conversation_id: string } } }[]>`
        SELECT swarm.conversation_open(
          ${fx.wsId}::uuid, 'user', ${decider.id}::uuid, '{}'::uuid[], ARRAY[${crossAgent.id}]::uuid[], false
        ) AS r
      `;
      const crossDmConvId = crossDmRow!.r.conversation.conversation_id;

      // R4 Step F witness: household_todo_decide blocked on swarm.conversations FOR UPDATE
      {
        const approval = await createApprovalBy(ownAgent.token, "R4 conversations decide witness");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "r4-conv-decide-expire",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${ownDmConvId}::uuid FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const expiresAt = (await setAgentDeadline(ownAgent, "2500 milliseconds"))!;
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
              note: "R4 Step F late-write witness",
            }));
            const blocked = await waitForBlockedOnPid(holderPid, "r4-conv-decide-expire Step F wait");
            assert.ok(
              blocked.blockedAt.getTime() < Date.parse(expiresAt),
              `Step C must have passed live before deadline: blockedAt=${blocked.blockedAt.toISOString()} expiresAt=${expiresAt}`,
            );
            await waitForPgClockPast(expiresAt, "r4-conv-decide-expire clock");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "r4-conv-decide-expire resp");
            assert.equal(resp.status, 200, respDiag("r4-conv-decide-expire", resp));
            assert.equal(resp.body.status, "committed", respDiag("r4-conv-decide-expire", resp));
            assert.equal((resp.body.value as Row).decision_status, "approved");
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: ownAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.deepEqual(afterFx, beforeFx, "R4 Step F decide expiry must roll back all notice/filing/realtime rows");
        await setAgentDeadline(ownAgent, null);
      }

      // R4 Step F witness: household_todo_answer blocked on swarm.conversations FOR UPDATE
      {
        const offerTodo = await createOfferToDeciderAgentBy(crossAgent.token, ownAgent, "R4 conversations answer witness");
        const about = `todo:${offerTodo.todo_id as string}`;
        const crossTopics = [`cswarm-wake:${crossAgent.wakeId}`, memberDeciderTopic];
        const beforeFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        await withHeldLock(
          "r4-conv-answer-expire",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${crossDmConvId}::uuid FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const expiresAt = (await setAgentDeadline(crossAgent, "2500 milliseconds"))!;
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_answer",
              todo_id: offerTodo.todo_id,
              offer_id: (offerTodo.offer as Row).offer_id,
              base_version: offerTodo.version,
              answer: "decline",
            }));
            const blocked = await waitForBlockedOnPid(holderPid, "r4-conv-answer-expire Step F wait");
            assert.ok(
              blocked.blockedAt.getTime() < Date.parse(expiresAt),
              `Step C must pass live before deadline on answer: blockedAt=${blocked.blockedAt.toISOString()} expiresAt=${expiresAt}`,
            );
            await waitForPgClockPast(expiresAt, "r4-conv-answer-expire clock");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "r4-conv-answer-expire resp");
            assert.equal(resp.status, 200, respDiag("r4-conv-answer-expire", resp));
            assert.equal(resp.body.status, "committed", respDiag("r4-conv-answer-expire", resp));
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: crossAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        assert.deepEqual(afterFx, beforeFx, "R4 Step F answer expiry must roll back all notice/filing/realtime rows");
        await setAgentDeadline(crossAgent, null);
      }

      // R4 Step F LIVE CONTROL (released while clock_timestamp() < connection_expires_at)
      {
        const approval = await createApprovalBy(ownAgent.token, "R4 conversations live control");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "r4-conv-live-control",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${ownDmConvId}::uuid FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            await setAgentDeadline(ownAgent, "60 seconds");
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
            }));
            await waitForBlockedOnPid(holderPid, "r4-conv-live-control Step F wait");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "r4-conv-live-control resp");
            assert.equal(resp.status, 200, respDiag("r4-conv-live-control", resp));
            assert.equal(resp.body.status, "committed", respDiag("r4-conv-live-control", resp));
            assert.equal((resp.body.notices as Array<Row>)[0]!.status, "sent");
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.equal(afterFx.signals, beforeFx.signals + 1);
        assert.equal(afterFx.recipients, beforeFx.recipients + 1);
        assert.equal(afterFx.deliveries, beforeFx.deliveries + 1);
        assert.equal(afterFx.conversationSignals, beforeFx.conversationSignals + 1);
        assert.ok(afterFx.realtimeFrames >= beforeFx.realtimeFrames + 2);
        await setAgentDeadline(ownAgent, null);
      }

      // R4 Step E companion witness: hold all 8 spend:signal_post:0..7 rows FOR UPDATE
      step("Suite 3.3b: R4 late-write Step E spend-shard contention witness + live control");
      await ensureRateBucketRows(SPEND_SIGNAL_KEYS);
      {
        const approval = await createApprovalBy(ownAgent.token, "R4 spend-shard decide witness");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "r4-spend-decide-expire",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.rate_buckets WHERE bucket_key = ANY(${SPEND_SIGNAL_KEYS}::text[]) FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const expiresAt = (await setAgentDeadline(ownAgent, "2500 milliseconds"))!;
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
            }));
            const blocked = await waitForBlockedOnPid(holderPid, "r4-spend-decide-expire Step E wait");
            assert.ok(
              blocked.blockedAt.getTime() < Date.parse(expiresAt),
              `Step C must pass live before Step E spend wait: blockedAt=${blocked.blockedAt.toISOString()} expiresAt=${expiresAt}`,
            );
            await waitForPgClockPast(expiresAt, "r4-spend-decide-expire clock");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "r4-spend-decide-expire resp");
            assert.equal(resp.status, 200, respDiag("r4-spend-decide-expire", resp));
            assert.equal(resp.body.status, "committed", respDiag("r4-spend-decide-expire", resp));
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: ownAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.deepEqual(afterFx, beforeFx, "R4 Step E spend expiry must roll back all notice/filing/realtime rows");
        await setAgentDeadline(ownAgent, null);
      }

      // R4 Step E LIVE CONTROL
      {
        const approval = await createApprovalBy(ownAgent.token, "R4 spend-shard live control");
        const about = `todo:${approval.todo_id as string}`;
        const beforeFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        await withHeldLock(
          "r4-spend-live-control",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.rate_buckets WHERE bucket_key = ANY(${SPEND_SIGNAL_KEYS}::text[]) FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            await setAgentDeadline(ownAgent, "60 seconds");
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approval.todo_id,
              base_version: approval.version,
              decision: "approve",
            }));
            await waitForBlockedOnPid(holderPid, "r4-spend-live-control Step E wait");
            await releaseLock();
            const resp = await raceWithTimeout(pending, "r4-spend-live-control resp");
            assert.equal(resp.status, 200, respDiag("r4-spend-live-control", resp));
            assert.equal(resp.body.status, "committed", respDiag("r4-spend-live-control", resp));
            assert.equal((resp.body.notices as Array<Row>)[0]!.status, "sent");
          },
        );
        const afterFx = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.equal(afterFx.signals, beforeFx.signals + 1);
        assert.equal(afterFx.deliveries, beforeFx.deliveries + 1);
        assert.equal(afterFx.conversationSignals, beforeFx.conversationSignals + 1);
        assert.ok(afterFx.realtimeFrames >= beforeFx.realtimeFrames + 2);
        await setAgentDeadline(ownAgent, null);
      }

      // --- 3.4 Read-right loss during settlement ---
      step("Suite 3.4: read-right loss cases");
      // (a) Asking agent's household connection withdrawn while remaining a live workspace chat member
      {
        const approval = await createApprovalBy(crossAgent.token, "Withdrawn agent connection approval");
        const about = `todo:${approval.todo_id as string}`;
        const crossTopics = [`cswarm-wake:${crossAgent.wakeId}`, memberDeciderTopic];
        const withdrawResp = await sendCommand(requesterHuman.jwt, fx.wsId, {
          kind: "household_withdraw_connection",
          principal_id: crossAgent.id,
        });
        assert.equal(withdrawResp.body.status, "committed", respDiag("withdrawResp", withdrawResp));

        const beforeFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        const decideResp = await sendCommand(decider.jwt, fx.wsId, {
          kind: "household_todo_decide",
          todo_id: approval.todo_id,
          base_version: approval.version,
          decision: "approve",
        });
        assert.equal(decideResp.body.status, "committed", respDiag("decideWithdrawnAgent", decideResp));
        assert.deepEqual(decideResp.body.notices, [
          { to: [{ kind: "agent", id: crossAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
        ]);
        const afterFx = await countNoticeEffects(fx.wsId, about, crossTopics);
        assert.deepEqual(afterFx, beforeFx, "withdrawn connection emits zero notice rows");
      }

      // (b) Asking agent revoked: both pre-revoked (Step A recipient_not_live) and revoked during held Step F (Step G recipient_access_refused)
      {
        const approvalPreRevoke = await createApprovalBy(extraAgent.token, "Pre-revoked agent approval");
        const approvalMidRevoke = await createApprovalBy(extraAgent.token, "Mid-flight revoked agent approval");
        const [extraDmRow] = await sql<{ r: { conversation: { conversation_id: string } } }[]>`
          SELECT swarm.conversation_open(
            ${fx.wsId}::uuid, 'user', ${decider.id}::uuid, '{}'::uuid[], ARRAY[${extraAgent.id}]::uuid[], false
          ) AS r
        `;
        const extraDmConvId = extraDmRow!.r.conversation.conversation_id;
        const extraTopics = [`cswarm-wake:${extraAgent.wakeId}`, memberDeciderTopic];

        // Mid-flight revocation during held Step F -> Step G rolls back savepoint with recipient_access_refused!
        const aboutMid = `todo:${approvalMidRevoke.todo_id as string}`;
        const beforeMid = await countNoticeEffects(fx.wsId, aboutMid, extraTopics);
        await withHeldLock(
          "mid-flight-agent-revoke",
          async (tx) => {
            await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${extraDmConvId}::uuid FOR UPDATE`;
          },
          async ({ holderPid, releaseLock, trackPending }) => {
            const pending = trackPending(sendCommand(decider.jwt, fx.wsId, {
              kind: "household_todo_decide",
              todo_id: approvalMidRevoke.todo_id,
              base_version: approvalMidRevoke.version,
              decision: "approve",
            }));
            await waitForBlockedOnPid(holderPid, "mid-flight-agent-revoke wait");
            await sql`UPDATE swarm.agent_principals SET revoked_at = clock_timestamp() WHERE principal_id = ${extraAgent.id}::uuid`;
            await releaseLock();
            const resp = await raceWithTimeout(pending, "mid-flight-agent-revoke resp");
            assert.equal(resp.body.status, "committed", respDiag("mid-flight-agent-revoke", resp));
            assert.deepEqual(resp.body.notices, [
              { to: [{ kind: "agent", id: extraAgent.id }], status: "not_sent", reason: "recipient_access_refused" },
            ]);
          },
        );
        const afterMid = await countNoticeEffects(fx.wsId, aboutMid, extraTopics);
        assert.deepEqual(afterMid, beforeMid, "mid-flight revoked agent emits zero notice rows");

        // Pre-revoked agent -> Step A refuses with recipient_not_live and outer decision commits with zero notice rows.
        const aboutPre = `todo:${approvalPreRevoke.todo_id as string}`;
        const beforePre = await countNoticeEffects(fx.wsId, aboutPre, extraTopics);
        const preResp = await sendCommand(decider.jwt, fx.wsId, {
          kind: "household_todo_decide",
          todo_id: approvalPreRevoke.todo_id,
          base_version: approvalPreRevoke.version,
          decision: "decline",
        });
        assert.equal(preResp.body.status, "committed", respDiag("pre-revoked agent", preResp));
        assert.deepEqual(preResp.body.notices, [
          { to: [{ kind: "agent", id: extraAgent.id }], status: "not_sent", reason: "recipient_not_live" },
        ]);
        const afterPre = await countNoticeEffects(fx.wsId, aboutPre, extraTopics);
        assert.deepEqual(afterPre, beforePre, "pre-revoked agent emits zero notice rows");
      }

      // (c) Asking human's household content role/consent revoked while still a live workspace member
      {
        const approval = await createApprovalBy(requesterHuman.jwt, "Revoked human consent approval");
        const about = `todo:${approval.todo_id as string}`;
        const humanTopics = [memberDeciderTopic, `cswarm-member:${fx.wsId}:${requesterHuman.id}`];
        await sql`
          UPDATE swarm.household_member_content_roles
          SET revoked_at = clock_timestamp()
          WHERE workspace_id = ${fx.wsId}::uuid AND user_id = ${requesterHuman.id}::uuid
        `;
        const beforeFx = await countNoticeEffects(fx.wsId, about, humanTopics);
        const decideResp = await sendCommand(decider.jwt, fx.wsId, {
          kind: "household_todo_decide",
          todo_id: approval.todo_id,
          base_version: approval.version,
          decision: "approve",
        });
        assert.equal(decideResp.body.status, "committed", respDiag("revoked human consent", decideResp));
        assert.deepEqual(decideResp.body.notices, [
          { to: [{ kind: "user", id: requesterHuman.id }], status: "not_sent", reason: "recipient_access_refused" },
        ]);
        const afterFx = await countNoticeEffects(fx.wsId, about, humanTopics);
        assert.deepEqual(afterFx, beforeFx, "revoked human content role emits zero notice rows");
      }

      // --- 3.5 Replay proof ---
      step("Suite 3.5: replay proof");
      {
        const approval = await createApprovalBy(ownAgent.token, "Replay proof approval");
        const about = `todo:${approval.todo_id as string}`;
        const replayCmdId = randomUUID();
        const decideCmd = {
          kind: "household_todo_decide",
          todo_id: approval.todo_id,
          base_version: approval.version,
          decision: "approve",
          note: "First commit",
        };
        const first = await sendCommand(decider.jwt, fx.wsId, decideCmd, replayCmdId);
        assert.equal(first.body.status, "committed", respDiag("replay first", first));
        assert.equal((first.body.notices as Array<Row>)[0]!.status, "sent");

        // (a) Replay after recipient loses household read rights returns stored receipt and emits zero new signals/wakes.
        await setAgentDeadline(ownAgent, "-1 minute");
        const beforeReplay = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        const replaySame = await sendCommand(decider.jwt, fx.wsId, decideCmd, replayCmdId);
        assert.equal(replaySame.body.status, "committed", respDiag("replaySame", replaySame));
        assert.equal(replaySame.body.replayed, true);
        assert.deepEqual(replaySame.body.notices, first.body.notices);
        const afterReplay = await countNoticeEffects(fx.wsId, about, ownRealtimeTopics);
        assert.deepEqual(afterReplay, beforeReplay, "replay emits zero new signals or wakes");

        // (c) Same command_id with different digest returns request_id_reused.
        const reused = await sendCommand(
          decider.jwt,
          fx.wsId,
          { ...decideCmd, note: "Different digest" },
          replayCmdId,
        );
        assert.equal(reused.body.status, "refused", respDiag("reused", reused));
        assert.equal(reused.body.reason, "request_id_reused");

        // (b) Replay after actor is downgraded to reader or loses workspace membership is refused without releasing receipt.
        await sql`
          UPDATE swarm.household_member_content_roles
          SET content_role = 'reader'
          WHERE workspace_id = ${fx.wsId}::uuid AND user_id = ${decider.id}::uuid
        `;
        const replayReader = await sendCommand(decider.jwt, fx.wsId, decideCmd, replayCmdId);
        assert.equal(replayReader.body.status, "refused", respDiag("replayReader", replayReader));
        assert.equal(replayReader.body.reason, "content_read_only");
        assert.equal(replayReader.body.value, undefined, "downgraded reader must not receive stored receipt");

        await sql`
          UPDATE swarm.household_member_content_roles
          SET content_role = 'editor'
          WHERE workspace_id = ${fx.wsId}::uuid AND user_id = ${decider.id}::uuid
        `;
        await sql`
          UPDATE swarm.memberships
          SET revoked_at = clock_timestamp()
          WHERE workspace_id = ${fx.wsId}::uuid AND user_id = ${decider.id}::uuid
        `;
        const replayRemoved = await sendCommand(decider.jwt, fx.wsId, decideCmd, replayCmdId);
        assert.ok(
          replayRemoved.status === 403 || replayRemoved.body.status === "refused",
          respDiag("replayRemoved", replayRemoved),
        );
        assert.equal(replayRemoved.body.value, undefined, "removed member must not receive stored receipt");
      }

      step("Suite 3: done");
    } finally {
      await fx.cleanup();
    }
  },
);

// ---------------------------------------------------------------------------
// Suite 4: Condition 3 server proof + read models & audit
// ---------------------------------------------------------------------------
test(
  "Suite 4: Condition 3 base_version/freeze/summary(), waiting_todos_page, waiting_archived_page dedup, and audit_log privacy",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 4: setup workspace");
    const alice = await createUser("s4-alice");
    const bob = await createUser("s4-bob");
    const fx = await seedHouseholdWorkspace({
      name: "Suite4ReadModelsWS",
      members: [
        { user: alice, displayName: "Alice", role: "owner" },
        { user: bob, displayName: "Bob", role: "member" },
      ],
      agents: [
        { ownerId: alice.id, name: "AliceAgent" },
      ],
      channels: [
        {
          slug: "secret-room",
          visibility: "private",
          createdByUserId: alice.id,
          userMemberIds: [alice.id], // Bob is NOT a member of #secret-room!
        },
      ],
    });

    try {
      const aliceAgent = fx.agents[0]!;
      const privateChannelId = fx.channelsBySlug["secret-room"]!;

      // 1. Condition 3: create offers with `at` gate and `hold` gate + note.
      const scheduledAtIso = "2026-12-01T15:30:00.000Z";
      const holdGateNote = "Hold until contractor confirms permit";
      const atOfferResp = await sendTodoTool(bob.jwt, fx.wsId, "todo_create", {
        title: "Scheduled offer task",
        notes: "Offer has notes",
        assign: {
          to: { kind: "agent", id: aliceAgent.id },
          start: "queue",
          gate: { kind: "at", at: scheduledAtIso },
        },
      });
      assert.equal(atOfferResp.body.status, "committed", respDiag("atOfferResp", atOfferResp));
      const atOfferTodo = atOfferResp.body.value as Row;

      const holdOfferResp = await sendTodoTool(bob.jwt, fx.wsId, "todo_create", {
        title: "Hold offer task",
        assign: {
          to: { kind: "agent", id: aliceAgent.id },
          start: "queue",
          gate: { kind: "hold", note: holdGateNote },
        },
      });
      assert.equal(holdOfferResp.body.status, "committed", respDiag("holdOfferResp", holdOfferResp));
      const holdOfferTodo = holdOfferResp.body.value as Row;

      // todo_list (summary()) returns full offer.gate (`at` timestamp and `hold` note) and `has_notes`.
      const listResp = await sendTodoTool(alice.jwt, fx.wsId, "todo_list", { scope: "open" }, randomUUID(), true);
      assert.equal(listResp.body.status, "ok", respDiag("listResp", listResp));
      const listedTodos = listResp.body.todos as Array<Row>;
      const listedAt = listedTodos.find((t) => t.todo_id === atOfferTodo.todo_id);
      const listedHold = listedTodos.find((t) => t.todo_id === holdOfferTodo.todo_id);
      assert.ok(listedAt && listedHold);
      assert.equal(listedAt.has_notes, true);
      assert.deepEqual((listedAt.offer as Row).gate, { kind: "at", at: scheduledAtIso });
      assert.equal(listedHold.has_notes, false);
      assert.deepEqual((listedHold.offer as Row).gate, { kind: "hold", note: holdGateNote });

      // todo_update on pending offer returns offer_pending_frozen.
      const frozenOfferUpdate = await sendTodoTool(bob.jwt, fx.wsId, "todo_update", {
        todo_id: atOfferTodo.todo_id,
        base_version: atOfferTodo.version,
        title: "Sneaky edit under pending offer",
      });
      assert.equal(frozenOfferUpdate.body.status, "refused", respDiag("frozenOfferUpdate", frozenOfferUpdate));
      assert.equal(frozenOfferUpdate.body.reason, "offer_pending_frozen");

      // HTTP household_todo_answer omitting base_version returns HTTP 400 invalid_arguments.
      const missingVersionResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "household_todo_answer",
        todo_id: atOfferTodo.todo_id,
        offer_id: (atOfferTodo.offer as Row).offer_id,
        answer: "accept",
      });
      assert.equal(missingVersionResp.status, 400, respDiag("missingVersionResp", missingVersionResp));
      assert.deepEqual(missingVersionResp.body, { status: "refused", reason: "invalid_arguments" });

      // Bump version via todo_comment -> stale base_version returns conflict; matching base_version commits!
      const commentResp = await sendTodoTool(bob.jwt, fx.wsId, "todo_comment", {
        target: { kind: "todo", id: atOfferTodo.todo_id },
        body: "Added important context before accept",
      });
      assert.equal(commentResp.body.status, "committed", respDiag("commentResp", commentResp));

      const staleAnswerResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "household_todo_answer",
        todo_id: atOfferTodo.todo_id,
        offer_id: (atOfferTodo.offer as Row).offer_id,
        base_version: atOfferTodo.version, // stale!
        answer: "accept",
      });
      assert.equal(staleAnswerResp.status, 200, respDiag("staleAnswerResp", staleAnswerResp));
      assert.equal(staleAnswerResp.body.status, "conflict", respDiag("staleAnswerResp", staleAnswerResp));
      const currentVersion = (staleAnswerResp.body.current as Row).version as number;
      assert.ok(currentVersion > (atOfferTodo.version as number));

      // Verify waiting_todos_page BEFORE answering holdOfferTodo & atOfferTodo!
      const longNotes = "N".repeat(250);
      const shortNotes = "Short approval context.";
      const longApprovalResp = await sendTodoTool(aliceAgent.token, fx.wsId, "todo_create", {
        kind: "approval",
        title: "Long-notes approval",
        notes: longNotes,
        assign: { to: { kind: "user", id: alice.id } },
      });
      assert.equal(longApprovalResp.body.status, "committed");
      const longApproval = longApprovalResp.body.value as Row;

      const secretApprovalTitle = `AUDIT_SECRET_TITLE_${randomUUID()}`;
      const secretApprovalNote = `AUDIT_SECRET_NOTE_${randomUUID()}_${"Z".repeat(490)}`;
      const shortApprovalResp = await sendTodoTool(aliceAgent.token, fx.wsId, "todo_create", {
        kind: "approval",
        title: secretApprovalTitle,
        notes: shortNotes,
        assign: { to: { kind: "user", id: alice.id } },
      });
      assert.equal(shortApprovalResp.body.status, "committed");
      const shortApproval = shortApprovalResp.body.value as Row;

      // Private-channel task assigned to Bob (via offer -> Bob accepts) to prove private-origin redaction survives!
      const privTaskOfferResp = await sendTodoTool(alice.jwt, fx.wsId, "todo_create", {
        title: "Private room errand for Bob",
        origin_placement: "channel",
        origin_channel_id: privateChannelId,
        assign: { to: { kind: "user", id: bob.id } },
      });
      assert.equal(privTaskOfferResp.body.status, "committed", respDiag("privTaskOfferResp", privTaskOfferResp));
      const privTaskOffer = privTaskOfferResp.body.value as Row;
      const privTaskAccepted = await sendCommand(bob.jwt, fx.wsId, {
        kind: "household_todo_answer",
        todo_id: privTaskOffer.todo_id,
        offer_id: (privTaskOffer.offer as Row).offer_id,
        base_version: privTaskOffer.version,
        answer: "accept",
      });
      assert.equal(privTaskAccepted.body.status, "committed");

      // Check waiting_todos_page for Alice:
      const aliceViewsBefore = await readWaitingViewsAs(fx.wsId, alice.id);
      const aliceTodos = (aliceViewsBefore.wt as { todos: Array<Row> }).todos;
      const wtAt = aliceTodos.find((t) => t.todo_id === atOfferTodo.todo_id)!;
      const wtHold = aliceTodos.find((t) => t.todo_id === holdOfferTodo.todo_id)!;
      const wtLong = aliceTodos.find((t) => t.todo_id === longApproval.todo_id)!;
      const wtShort = aliceTodos.find((t) => t.todo_id === shortApproval.todo_id)!;
      assert.ok(wtAt && wtHold && wtLong && wtShort);

      // Offer rows carry version, kind, notes_preview, notes_truncated, requested_by, offer_id, offer_to, offer_start, and verbatim offer_gate!
      assert.equal(wtAt.version, currentVersion);
      assert.equal(wtAt.kind, "task");
      assert.equal(wtAt.reason, "request");
      assert.equal(wtAt.offer_id, (atOfferTodo.offer as Row).offer_id);
      assert.deepEqual(wtAt.offer_to, { kind: "agent", id: aliceAgent.id, name: "AliceAgent" });
      assert.equal(wtAt.offer_start, "queue");
      assert.deepEqual(wtAt.offer_gate, { kind: "at", at: scheduledAtIso });
      assert.deepEqual(wtAt.requested_by, { kind: "user", id: bob.id, name: "Bob" });

      assert.equal(wtHold.version, holdOfferTodo.version);
      assert.deepEqual(wtHold.offer_gate, { kind: "hold", note: holdGateNote });

      // Approval rows carry version, kind='approval', notes_preview, notes_truncated, and requested_by!
      assert.equal(wtLong.kind, "approval");
      assert.equal(wtLong.version, longApproval.version);
      assert.equal((wtLong.notes_preview as string).length, 200);
      assert.equal(wtLong.notes_truncated, true);
      assert.deepEqual(wtLong.requested_by, { kind: "agent", id: aliceAgent.id, name: "AliceAgent" });

      assert.equal(wtShort.kind, "approval");
      assert.equal(wtShort.notes_preview, shortNotes);
      assert.equal(wtShort.notes_truncated, false);

      // Private-origin redaction preserved for Bob (non-member of #secret-room)!
      const bobViews = await readWaitingViewsAs(fx.wsId, bob.id);
      const bobPrivRow = (bobViews.wt as { todos: Array<Row> }).todos.find((t) => t.todo_id === privTaskOffer.todo_id);
      assert.ok(bobPrivRow);
      assert.equal(bobPrivRow.placement, "workspace", "private channel origin must redact to workspace for non-member");
      assert.equal(bobPrivRow.channel_id, null, "private channel_id must stay null for non-member");

      // Matching base_version commits on household_todo_answer!
      const matchAnswerResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "household_todo_answer",
        todo_id: atOfferTodo.todo_id,
        offer_id: (atOfferTodo.offer as Row).offer_id,
        base_version: currentVersion,
        answer: "accept",
      });
      assert.equal(matchAnswerResp.body.status, "committed", respDiag("matchAnswerResp", matchAnswerResp));

      // Dismiss shortApproval first, verify it appears as dismissed in Archived, then Approve it -> deduplicates!
      const dismissResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "dismiss_waiting_item",
        item_kind: "todo",
        item_id: shortApproval.todo_id,
      });
      assert.equal(dismissResp.body.dismissed, true, respDiag("dismissResp", dismissResp));

      const aliceViewsAfterDismiss = await readWaitingViewsAs(fx.wsId, alice.id);
      const dismissedItems = (aliceViewsAfterDismiss.wa as { items: Array<Row> }).items.filter(
        (i) => i.todo_id === shortApproval.todo_id,
      );
      assert.equal(dismissedItems.length, 1);
      assert.equal(dismissedItems[0]!.outcome_kind, "dismissed");

      // Approve shortApproval (with >480 char note to verify truncation) and Decline longApproval (with note).
      const approveShortResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: shortApproval.todo_id,
        base_version: shortApproval.version,
        decision: "approve",
        note: secretApprovalNote.slice(0, 500),
      });
      assert.equal(approveShortResp.body.status, "committed", respDiag("approveShortResp", approveShortResp));

      const declineLongResp = await sendCommand(alice.jwt, fx.wsId, {
        kind: "household_todo_decide",
        todo_id: longApproval.todo_id,
        base_version: longApproval.version,
        decision: "decline",
        note: "Too expensive",
      });
      assert.equal(declineLongResp.body.status, "committed", respDiag("declineLongResp", declineLongResp));

      // Both approvals left waiting_todos_page immediately!
      const aliceViewsAfter = await readWaitingViewsAs(fx.wsId, alice.id);
      const remainingIds = new Set((aliceViewsAfter.wt as { todos: Array<Row> }).todos.map((t) => t.todo_id));
      assert.equal(remainingIds.has(shortApproval.todo_id), false, "approved item must leave waiting_todos_page");
      assert.equal(remainingIds.has(longApproval.todo_id), false, "declined item must leave waiting_todos_page");

      // waiting_archived_page projects 'approved' and 'declined' with truncated note, deduplicates dismissal, and keeps untrusted_content: true!
      const archived = aliceViewsAfter.wa as { untrusted_content: boolean; items: Array<Row> };
      assert.equal(archived.untrusted_content, true);
      const shortArchivedRows = archived.items.filter((i) => i.todo_id === shortApproval.todo_id);
      assert.equal(shortArchivedRows.length, 1, "decided approval must deduplicate against prior waiting_dismissals");
      assert.equal(shortArchivedRows[0]!.outcome_kind, "approved");
      assert.equal(
        shortArchivedRows[0]!.outcome_text,
        `Approved · ${secretApprovalNote.slice(0, 480)}`,
      );

      const longArchivedRows = archived.items.filter((i) => i.todo_id === longApproval.todo_id);
      assert.equal(longArchivedRows.length, 1);
      assert.equal(longArchivedRows[0]!.outcome_kind, "declined");
      assert.equal(longArchivedRows[0]!.outcome_text, "Declined · Too expensive");

      // swarm_read.audit_log contains household_todo_decide row with zero decision_note, title, or private channel ID leakage!
      const auditRows = await sql.begin(async (tx) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: alice.id })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        return tx<Array<Row>>`
          SELECT * FROM swarm_read.audit_log
          WHERE workspace_id = ${fx.wsId}::uuid
            AND command_kind = 'household_todo_decide'
        `;
      });
      assert.ok(auditRows.length >= 2, `expected household_todo_decide audit rows, got ${auditRows.length}`);
      const auditSerialized = JSON.stringify(auditRows);
      assert.equal(auditSerialized.includes(secretApprovalTitle), false, "audit_log must not leak approval title");
      assert.equal(auditSerialized.includes("AUDIT_SECRET_NOTE_"), false, "audit_log must not leak decision_note");
      assert.equal(auditSerialized.includes("Too expensive"), false, "audit_log must not leak decline note");
      assert.equal(auditSerialized.includes(privateChannelId), false, "audit_log must not leak private channel ID");

      step("Suite 4: done");
    } finally {
      await fx.cleanup();
    }
  },
);
