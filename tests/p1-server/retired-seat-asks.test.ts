/**
 * Server witness for retired/disconnected seat ask clearing (20261125000002_retired_seat_asks_prep.sql,
 * 20261125000003_retired_seat_asks_enable.sql, and the served command + read edges; CI / local Postgres):
 *
 * Mapped directly to R4 Section 5 (HezSec PASS):
 *   - Suite 6 (Test 1): Phase 1 & Phase 2 catalog/functional proofs, direct role denial on new tables,
 *     helper, triggers, and command-only definers, clean Phase 2 + Phase 1 rollback, rollback-catalog
 *     proof, and re-apply.
 *   - Suite 1a (Test 2): Disconnected local states (key_off, key_ended, paused, removed, departed-owner),
 *     disconnected hosted states (connection_off revoked/expired), live local refusal (409 seat_still_live),
 *     R3 Point 2 claimed hosted seat provider-family witness (tombstoned refresh family accepted & cleared;
 *     live claimed hosted seat control refused 409; tombstoned claimed seat with live replacement grant
 *     refused 409), explicit sender_lifecycle_epoch binding on runtime agent asks (post_signal, ask_choice,
 *     local & hosted), and projection updates across decision_queue, decision_queue_page, home_overview,
 *     my_open_asks, and authorized waiting_archived_page ('seat_cleared' / 'Cleared (seat inactive)').
 *   - Suite 1b (Test 3): Re-add resurrection guard, outcome precedence & archived_at cursor stability
 *     across repeated clears, undirected channel thread replyability, own-withdrawal idempotency
 *     preservation, and multi-workspace isolation + cross-workspace reconnect epoch advancement.
 *   - Suite 2 (Test 4): Condition 1 & Path 1 zero hidden-answer oracle AND zero completion-predicate
 *     evaluation (pg_stat_get_function_calls with track_functions = 'all' + positive control) across
 *     never-answered, unreadable-answer, and readable-answer fixtures for post_signal(in_reply_to),
 *     answer_choice, reraise_ask, withdraw_ask, supersedes, and caller-settled answer_choice replay.
 *   - Suite 3 (Test 5): Condition 2 & R3 Point 1 mandatory captured-epoch trigger controls (omitted NULL
 *     before/after clear -> 42501, delayed explicit-E covered by cutoff, forged current+1 and 0 -> 42501,
 *     unexpected non-ask/human epoch -> 42501, Phase 1 rollout gate -> 503/no-op/NULL preservation),
 *     concurrent reconnect both lock orders (local same-WS, sibling-W2 mint, add_agent_to_workspace,
 *     hosted claim), and held human authority changes (change_role demotion, remove_member,
 *     archive_workspace) in both lock orders.
 *   - Suite 4 (Test 6): Condition 3 & Path 2 concurrent-answer orders (clear-then-answer, answer-then-clear),
 *     held different-human private-reply overlap (private channel & private DM; plain reply & answer_choice)
 *     with field-for-field receipt and audit parity vs 0-ask empty control, held target-seat P private post
 *     across clock expiry (local key_ended & hosted expired connection_off; both pre-fence rollback and
 *     post-fence epoch-bound commit), post-reconnect replay while reconnected target seat holds a private
 *     post open (local & hosted), and sibling hosted seat Q under same hosted_mcp_grants row holding a
 *     private reply open.
 *   - Suite 5 (Test 7): Privilege, ingress (local agent, hosted MCP seat, seat-admin agent with active
 *     role:workspace_admin grant -> 403), CORS/Origin check, non-member -> 403, uniform 404 not_found
 *     with zero foreign locks and zero probed-UUID audit echo (non-owner member, unknown UUID,
 *     cross-workspace agent, human user UUID, join-registrar UUID), and blind idempotency replay
 *     negative cases (409 command_id_conflict, 404 after demotion, 403 after removal or archive).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { dbAssert, localClusterAdminUrl, repoSql, runSql } from "../support/admin-schema-db.js";
import { sqlPhase } from "../support/admin-schema-process.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { releaseCatalogQuery } from "../support/release-catalog-query.js";
import {
  RETIRED_SEAT_NOT_FOUND_BODY,
  RETIRED_SEAT_STILL_LIVE_BODY,
} from "../../supabase/functions/command/retired-seat-asks.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; email: string; jwt: string };
type Row = Record<string, unknown>;
type Tx = postgres.TransactionSql<Record<string, unknown>>;

const TEST_TIMEOUT_MS = 240_000;
const WAIT_TIMEOUT_MS = 15_000;
const TEST_DB_LOCK_TIMEOUT_MS = 20_000;
const TEST_DB_STATEMENT_TIMEOUT_MS = 20_000;
const HOLDER_IDLE_IN_TX_TIMEOUT_MS = 25_000;
const ALLOWED_ORIGIN = "http://127.0.0.1:4321";
const DISALLOWED_ORIGIN = "https://evil.example";
const RELEASE_LOCK_ROLLBACK = Symbol("release_lock_rollback");

const CHOICE_OPTIONS = [
  { id: "opt_yes", label: "Yes, proceed" },
  { id: "opt_no", label: "No, hold off" },
] as const;

const proofRoot = "deploy/release-proofs/retired-seat-asks";
const commandUrl = new URL("../../supabase/functions/command/index.ts", import.meta.url);
const hostedAuthUrl = new URL("../../supabase/functions/_shared/hosted-seat-auth.ts", import.meta.url);

const catalogAssertPrep = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}/20261125000002-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "retired-seat-asks prep rollback catalog" : "retired-seat-asks prep catalog",
  );

const catalogAssertEnable = () =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}/20261125000003-catalog.sql`),
      "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    "retired-seat-asks enable catalog",
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
let hostedHarnessPath: string | undefined;
const activeConnections = new Set<postgres.Sql>();

const HOSTED_HARNESS_SOURCE = `
const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const command = await import(${JSON.stringify(commandUrl.href)});
const auth = await import(${JSON.stringify(hostedAuthUrl.href)});

const results = [];
for (const step of input.steps) {
  let cap = null;
  if (step.mode === "grant") {
    cap = await command.db.begin(async (tx) => await auth.authenticateHostedGrantCapability(tx, {
      grantId: step.grantId,
      ownerUserId: step.ownerUserId,
      providerGrantId: step.providerGrantId,
      workspaceId: step.workspaceId,
      tool: step.tool,
      providerStatus: async () => ({ active: true }),
    }));
  } else {
    cap = await command.db.begin(async (tx) => await auth.authenticateHostedSeatCapability(tx, {
      grantId: step.grantId,
      providerGrantId: step.providerGrantId,
      handle: step.handle,
      tool: step.tool,
      providerStatus: async () => ({ active: true }),
    }, "command"));
  }
  if (cap === null) {
    results.push({ status: 403, body: { error: "no_capability" } });
    continue;
  }
  results.push(await command.handleHostedCommand({
    command_id: step.commandId ?? ("mcprsa_" + crypto.randomUUID()),
    client_version: "0.1.93",
    workspace_id: step.workspaceId,
    stream: { kind: "workspace" },
    command: step.command,
  }, cap));
}
console.log("HOSTED_RSA_RESULT:" + JSON.stringify(results));
await command.db.end({ timeout: 2 });
`;

function step(name: string): void {
  console.error(`[retired-seat-asks] ${name}`);
}

function openBoundedConnection(
  applicationName: string,
  forLockHolder = false,
  dbUrl: string = local.DB_URL,
): postgres.Sql {
  const conn = postgres(dbUrl, {
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
  return redactSensitiveText(query).replace(/\s+/g, " ").trim().slice(0, 200);
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
      }[]>`
        SELECT pid, locktype, relation::regclass::text AS relation, mode, granted
        FROM pg_locks
        WHERE NOT granted
          AND (
            database IS NULL
            OR database = (SELECT oid FROM pg_database WHERE datname = current_database())
          )
        ORDER BY pid, locktype
      `,
    ]);
    return JSON.stringify(
      {
        step: stepName,
        pg_stat_activity: activity.map((row) => ({
          pid: row.pid,
          app: row.application_name,
          state: row.state,
          wait_event_type: row.wait_event_type,
          wait_event: row.wait_event,
          blocking_pids: row.blocking_pids,
          query_prefix: redactQueryPrefix(row.query),
        })),
        ungranted_pg_locks: ungrantedLocks,
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
          () => resolve(JSON.stringify({ step: stepName, diag_error: "diagnostic query timed out" })),
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
  timeoutMs = WAIT_TIMEOUT_MS,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{
      pid: number;
      wait_event_type: string | null;
      wait_event: string | null;
    }[]>`
      SELECT pid, wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
    `;
    if (rows[0] !== undefined) return rows[0].pid;
    await delay(25);
  }
  const diag = await captureLockDiagnostics(label);
  throw new Error(`${label}: timed out after ${timeoutMs}ms waiting for backend blocked on pid ${blockerPid}\n${diag}`);
}

/**
 * Hold a bounded database transaction open on a dedicated single-connection client.
 * Callers can either rollback (default) or commit on release, and can run extra statements
 * inside the held transaction before finishing. Always rolls back and closes in `finally`.
 */
async function withHeldTransaction<T>(
  label: string,
  setup: (tx: Tx) => Promise<void>,
  body: (ctx: {
    holderPid: number;
    runInHolder: <R>(fn: (tx: Tx) => Promise<R>) => Promise<R>;
    commitHolder: () => Promise<void>;
    rollbackHolder: () => Promise<void>;
    trackPending: <P>(p: Promise<P>) => Promise<P>;
  }) => Promise<T>,
): Promise<T> {
  const holderSql = openBoundedConnection(`rsa-hold-${label.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 46)}`, true);
  let readyResolve!: (pid: number) => void;
  let readyReject!: (err: unknown) => void;
  const ready = new Promise<number>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  type Action =
    | { kind: "run"; fn: (tx: Tx) => Promise<unknown>; resolve: (v: unknown) => void; reject: (e: unknown) => void }
    | { kind: "commit" }
    | { kind: "rollback" };

  const queue: Action[] = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let holderError: unknown = null;
  const pendingRequests: Array<Promise<unknown>> = [];

  const enqueue = (action: Action): void => {
    queue.push(action);
    if (wake) {
      const fn = wake;
      wake = null;
      fn();
    }
  };

  const nextAction = async (): Promise<Action> => {
    while (queue.length === 0) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift()!;
  };

  const holderPromise = holderSql
    .begin(async (tx) => {
      const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await setup(tx);
      readyResolve(me!.pid);
      while (true) {
        const action = await nextAction();
        if (action.kind === "commit") return;
        if (action.kind === "rollback") throw RELEASE_LOCK_ROLLBACK;
        try {
          const val = await action.fn(tx);
          action.resolve(val);
        } catch (err) {
          action.reject(err);
        }
      }
    })
    .catch((err: unknown) => {
      if (err === RELEASE_LOCK_ROLLBACK) return;
      holderError = err;
      readyReject(err);
      throw err;
    });
  holderPromise.catch(() => {});

  const finish = async (kind: "commit" | "rollback"): Promise<void> => {
    if (!finished) {
      finished = true;
      enqueue({ kind });
    }
    await raceWithTimeout(holderPromise.catch(() => {}), `${label}: ${kind} holder`, WAIT_TIMEOUT_MS);
    if (holderError !== null) throw holderError;
  };

  const runInHolder = <R>(fn: (tx: Tx) => Promise<R>): Promise<R> =>
    raceWithTimeout(
      new Promise<R>((resolve, reject) => {
        enqueue({
          kind: "run",
          fn: fn as (tx: Tx) => Promise<unknown>,
          resolve: resolve as (v: unknown) => void,
          reject,
        });
      }),
      `${label}: runInHolder`,
      WAIT_TIMEOUT_MS,
    );

  const trackPending = <P>(p: Promise<P>): Promise<P> => {
    p.catch(() => {});
    pendingRequests.push(p);
    return p;
  };

  try {
    const holderPid = await raceWithTimeout(ready, `${label}: setup held tx`, WAIT_TIMEOUT_MS);
    return await body({
      holderPid,
      runInHolder,
      commitHolder: () => finish("commit"),
      rollbackHolder: () => finish("rollback"),
      trackPending,
    });
  } finally {
    if (!finished) {
      finished = true;
      enqueue({ kind: "rollback" });
    }
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

function localEnvironment(): Local {
  const parsed = JSON.parse(
    execFileSync("supabase", ["status", "-o", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }),
  ) as Partial<Local>;
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
  return { id: created.data.user!.id, email, jwt: signed.data.session!.access_token };
}

async function sendCommandRaw(
  bearer: string,
  workspaceId: string | null,
  command: Row,
  opts: {
    commandId?: string;
    stream?: Row;
    resource?: string;
    origin?: string | null;
  } = {},
): Promise<{ status: number; body: Row; headers: Headers }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${bearer}`,
    "content-type": "application/json",
  };
  if (opts.origin !== undefined && opts.origin !== null) {
    headers.origin = opts.origin;
  }
  const payload: Row = {
    command_id: opts.commandId ?? randomUUID(),
    client_version: "0.1.93",
    command,
  };
  if (workspaceId !== null) {
    payload.workspace_id = workspaceId;
    payload.stream = opts.stream ?? { kind: "workspace" };
  } else if (opts.stream !== undefined) {
    payload.stream = opts.stream;
  }
  if (opts.resource !== undefined) payload.resource = opts.resource;

  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    headers,
    body: JSON.stringify(payload),
  });
  return {
    status: response.status,
    body: (await response.json()) as Row,
    headers: response.headers,
  };
}

async function sendCommand(
  bearer: string,
  workspaceId: string,
  command: Row,
  commandId: string = randomUUID(),
): Promise<{ status: number; body: Row }> {
  const res = await sendCommandRaw(bearer, workspaceId, command, { commandId });
  return { status: res.status, body: res.body };
}

async function sendRead(bearer: string, payload: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Row };
}

type HostedStep = {
  mode?: "seat" | "grant";
  grantId: string;
  providerGrantId: string;
  ownerUserId?: string;
  handle?: string;
  workspaceId: string;
  tool: string;
  command: Row;
  commandId?: string;
};

function runHostedSteps(steps: HostedStep[]): Array<{ status: number; body: Row }> {
  assert.ok(hostedHarnessPath, "hosted harness not initialized");
  const result = spawnSync(
    "deno",
    [
      "run",
      "--no-lock",
      "--config",
      "supabase/functions/command/deno.json",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      hostedHarnessPath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      input: JSON.stringify({ steps }),
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
        SWARM_ENV: "test",
        SWARM_MCP_PUBLIC_ENABLED: "1",
        SWARM_DATABASE_URL: local.DB_URL,
        SUPABASE_DB_URL: local.DB_URL,
        SUPABASE_URL: local.API_URL,
        SUPABASE_ANON_KEY: local.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
        SWARM_INTERACTIVE_REPLIES: "1",
        SWARM_CHAT_MENTIONS: "1",
      },
      timeout: 120_000,
    },
  );
  assert.equal(result.status, 0, `hosted harness failed:\n${result.stderr}\n${result.stdout}`);
  const line = result.stdout
    .trim()
    .split("\n")
    .reverse()
    .find((entry) => entry.startsWith("HOSTED_RSA_RESULT:"));
  assert.equal(typeof line, "string", `missing HOSTED_RSA_RESULT line: ${result.stdout}`);
  return JSON.parse((line ?? "").slice("HOSTED_RSA_RESULT:".length)) as Array<{ status: number; body: Row }>;
}

async function readWaitingViewsAs(wsId: string, userId: string) {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
    await tx`SET LOCAL ROLE authenticated`;
    const [dq] = await tx<{ r: Row }[]>`SELECT swarm_read.decision_queue(${wsId}::uuid) AS r`;
    const [dqp] = await tx<{ r: Row }[]>`SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r`;
    const [wa] = await tx<{ r: Row }[]>`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [ho] = await tx<{ r: { workspaces: Array<{ workspace_id: string } & Row> } }[]>`SELECT swarm_read.home_overview() AS r`;
    const wsOverview = ho!.r.workspaces.find((w) => w.workspace_id === wsId) ?? null;
    return { dq: dq!.r, dqp: dqp!.r, wa: wa!.r, wsOverview };
  });
}

async function readMyOpenAsksAsAgentSql(wsId: string, ownerUserId: string, principalId: string): Promise<Row> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({
      role: "authenticated",
      sub: ownerUserId,
      agent_principal_id: principalId,
    })}, true)`;
    await tx`SET LOCAL ROLE swarm_read`;
    const [row] = await tx<{ r: Row }[]>`SELECT swarm_read.my_open_asks(${wsId}::uuid) AS r`;
    return row!.r;
  });
}

async function readConnectionKind(wsId: string, principalId: string): Promise<string | null> {
  const [row] = await sql<{ k: string | null }[]>`
    SELECT swarm_read.agent_connection_kind(${wsId}::uuid, ${principalId}::uuid) AS k
  `;
  return row?.k ?? null;
}

async function readOverviewAgentConnection(wsId: string, viewerUserId: string, principalId: string): Promise<string | null> {
  const { wsOverview } = await readWaitingViewsAs(wsId, viewerUserId);
  if (!wsOverview) return null;
  const people = (wsOverview.people as Array<{
    agents?: Array<{
      principal_id: string;
      connection?: string;
      status?: { connection?: string; facts?: { connection?: string } };
    }>;
  }>) ?? [];
  for (const person of people) {
    for (const agent of person.agents ?? []) {
      if (agent.principal_id === principalId) {
        return agent.status?.facts?.connection ?? agent.connection ?? agent.status?.connection ?? null;
      }
    }
  }
  return null;
}

async function createServedWorkspace(opts: {
  name: string;
  owner: Person;
  members?: Array<{ user: Person; role: "admin" | "member" }>;
}) {
  const wsId = randomUUID();
  const created = await sendCommandRaw(opts.owner.jwt, null, {
    kind: "create_workspace",
    workspace_id: wsId,
    name: opts.name,
  });
  assert.equal(created.status, 200, respDiag(`create_workspace(${opts.name})`, created));

  for (const member of opts.members ?? []) {
    const invited = await sendCommand(opts.owner.jwt, wsId, {
      kind: "invite_member",
      email: member.user.email,
    });
    assert.equal(invited.status, 200, respDiag(`invite_member(${member.user.email})`, invited));
    const accepted = await sendCommandRaw(member.user.jwt, null, {
      kind: "accept_invitation",
      token: String(invited.body.invitation_token),
    });
    assert.equal(accepted.status, 200, respDiag(`accept_invitation(${member.user.email})`, accepted));
    if (member.role === "admin") {
      const promoted = await sendCommand(opts.owner.jwt, wsId, {
        kind: "change_role",
        user_id: member.user.id,
        role: "admin",
      });
      assert.equal(promoted.status, 200, respDiag(`promote_admin(${member.user.email})`, promoted));
    }
  }
  return wsId;
}

async function createLocalAgent(opts: {
  wsId: string;
  owner: Person;
  name: string;
  deviceId?: string;
  ttlMs?: number;
}) {
  const deviceId = opts.deviceId ?? randomUUID();
  await sql`
    INSERT INTO swarm.devices (device_id, user_id, label)
    VALUES (${deviceId}::uuid, ${opts.owner.id}::uuid, ${`dev-${opts.name}`})
    ON CONFLICT (device_id) DO NOTHING
  `;
  const created = await sendCommand(opts.owner.jwt, opts.wsId, {
    kind: "create_agent_principal",
    name: opts.name,
  });
  assert.equal(created.status, 200, respDiag(`create_agent_principal(${opts.name})`, created));
  const principalId = String(created.body.principal_id);
  const runId = randomUUID();
  const minted = await sendCommand(opts.owner.jwt, opts.wsId, {
    kind: "mint_agent_token",
    principal_id: principalId,
    run_id: runId,
    task_id: randomUUID(),
    epoch: 1,
    device_id: deviceId,
    scopes: ["post_signal"],
    ...(opts.ttlMs !== undefined ? { ttl_ms: opts.ttlMs } : {}),
  });
  assert.equal(minted.status, 200, respDiag(`mint_agent_token(${opts.name})`, minted));
  const token = String(minted.body.agent_token);
  const tokenId = String(minted.body.token_id);
  const [tokRow] = await sql<{ renewal_grant_id: string | null }[]>`
    SELECT renewal_grant_id FROM swarm.agent_tokens WHERE token_id = ${tokenId}::uuid
  `;
  return {
    principalId,
    runId,
    deviceId,
    token,
    tokenId,
    renewalGrantId: tokRow?.renewal_grant_id ?? null,
  };
}

async function seedHostedSeat(opts: {
  wsId: string;
  ownerId: string;
  name: string;
  existingPrincipalId?: string;
  existingGrantId?: string;
  existingProviderGrantId?: string;
  connectionExpiresInterval?: string;
  claimed?: boolean;
}) {
  const principalId = opts.existingPrincipalId ?? randomUUID();
  const grantId = opts.existingGrantId ?? randomUUID();
  const providerGrantId = opts.existingProviderGrantId ?? `provider-${grantId}`;
  const seatId = randomUUID();
  const handle = `seat_${randomUUID().replaceAll("-", "").slice(0, 22)}`;
  const digest = new Uint8Array(32).fill(9);
  const expiresInterval = opts.connectionExpiresInterval ?? "7 days";

  await sql.begin(async (tx) => {
    if (!opts.existingPrincipalId) {
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
        VALUES (${principalId}::uuid, ${opts.wsId}::uuid, ${opts.ownerId}::uuid, ${opts.name}, 'hosted_mcp', true)
      `;
      await tx`
        INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
        VALUES (${opts.wsId}::uuid, ${principalId}::uuid, ${opts.ownerId}::uuid, ${opts.ownerId}::uuid)
        ON CONFLICT (principal_id, workspace_id) DO NOTHING
      `;
    }
    if (!opts.existingGrantId) {
      await tx`
        INSERT INTO swarm.hosted_mcp_grants (
          grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
          selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at,
          connection_expires_at
        ) VALUES (
          ${grantId}::uuid, ${providerGrantId}, ${opts.ownerId}::uuid, ${opts.wsId}::uuid,
          'rsa-hosted-client', 'https://mcp.commonswarm.com/mcp', ${[opts.wsId]}::uuid[],
          ${digest}, ${`ref-${grantId}`}, 'active', statement_timestamp(), statement_timestamp(),
          clock_timestamp() + ${expiresInterval}::interval
        )
      `;
      await tx`
        INSERT INTO swarm.hosted_mcp_grant_workspaces (
          grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
        ) VALUES (
          ${grantId}::uuid, ${opts.wsId}::uuid, ${opts.ownerId}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp()
        )
      `;
    }
    await tx`
      INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
      VALUES (${grantId}::uuid, ${principalId}::uuid, ${opts.ownerId}::uuid)
      ON CONFLICT (grant_id, principal_id) DO NOTHING
    `;
    if (opts.claimed !== false) {
      await tx`
        INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${seatId}::uuid, ${grantId}::uuid, ${opts.wsId}::uuid, ${opts.ownerId}::uuid, ${principalId}::uuid, ${opts.name}, statement_timestamp())
      `;
      await tx`
        INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
        VALUES (${handle}, ${seatId}::uuid, ${grantId}::uuid, ${opts.wsId}::uuid, ${principalId}::uuid, statement_timestamp())
      `;
    }
  });

  return { principalId, grantId, providerGrantId, seatId, handle };
}

async function cleanupFixture(workspaceIds: string[], userIds: string[]): Promise<void> {
  if (workspaceIds.length === 0 && userIds.length === 0) return;
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    if (workspaceIds.length > 0) {
      await tx`
        DELETE FROM commonswarm_oauth.refresh_family_tombstones
        WHERE grant_id IN (
          SELECT provider_grant_id FROM swarm.hosted_mcp_grants
          WHERE home_workspace_id = ANY(${workspaceIds}::uuid[])
        )
      `;
      await tx`
        DELETE FROM swarm.revocation_tombstones
        WHERE target_id IN (
          SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ANY(${workspaceIds}::uuid[])
          UNION ALL
          SELECT grant_id FROM swarm.hosted_mcp_grants WHERE home_workspace_id = ANY(${workspaceIds}::uuid[])
          UNION ALL
          SELECT seat_id FROM swarm.hosted_mcp_seats WHERE workspace_id = ANY(${workspaceIds}::uuid[])
        )
      `;
      await tx`DELETE FROM swarm.agent_ask_clear_events WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_ask_lifecycle WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.ask_withdrawals WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.waiting_dismissals WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.ui_actions WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.ask_reraises WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.ask_choices WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.audit_log WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.idempotency_keys WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.events WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.signal_deliveries WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.signal_recipients WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.signal_mentions WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.conversation_signals WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.conversation_reads WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.conversation_members WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.signals WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.conversations WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.channel_members WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.channels WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.invitations WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_join_credentials WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.hosted_mcp_seat_handles WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.hosted_mcp_seats WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.hosted_mcp_agent_workspace_adds WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.hosted_mcp_grant_agents WHERE grant_id IN (SELECT grant_id FROM swarm.hosted_mcp_grants WHERE home_workspace_id = ANY(${workspaceIds}::uuid[]))`;
      await tx`DELETE FROM swarm.hosted_mcp_grant_workspaces WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.hosted_mcp_grants WHERE home_workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_execution_sessions WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_tokens WHERE principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ANY(${workspaceIds}::uuid[]))`;
      await tx`DELETE FROM swarm.renewal_grants WHERE principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ANY(${workspaceIds}::uuid[]))`;
      await tx`DELETE FROM swarm.agent_runs WHERE principal_id IN (SELECT principal_id FROM swarm.agent_principals WHERE workspace_id = ANY(${workspaceIds}::uuid[]))`;
      await tx`DELETE FROM swarm.agent_presence WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_workspace_memberships WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.agent_principals WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.memberships WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.streams WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
      await tx`DELETE FROM swarm.workspaces WHERE workspace_id = ANY(${workspaceIds}::uuid[])`;
    }
    if (userIds.length > 0) {
      await tx`DELETE FROM swarm.seat_admin_grants WHERE owner_user_id = ANY(${userIds}::uuid[])`;
      await tx`DELETE FROM swarm.admin_events WHERE owner_user_id = ANY(${userIds}::uuid[])`;
      await tx`DELETE FROM swarm.admin_accounts WHERE owner_user_id = ANY(${userIds}::uuid[])`;
      await tx`DELETE FROM swarm.idempotency_keys WHERE principal_kind = 'user' AND principal_id = ANY(${userIds}::text[])`;
      await tx`DELETE FROM swarm.devices WHERE user_id = ANY(${userIds}::uuid[])`;
      await tx`DELETE FROM swarm.users WHERE user_id = ANY(${userIds}::uuid[])`;
    }
    await tx`SET LOCAL session_replication_role = origin`;
  });
  for (const userId of userIds) {
    try {
      await admin.auth.admin.deleteUser(userId);
    } catch {
      /* user already removed */
    }
  }
}

async function cleanupFixtureInFinally(
  label: string,
  workspaceIds: string[],
  userIds: string[],
  hasPrimaryError: boolean,
): Promise<void> {
  try {
    await cleanupFixture(workspaceIds, userIds);
  } catch (cleanupErr) {
    console.error(`[retired-seat-asks] ${label} cleanupFixture failed:`, cleanupErr);
    if (!hasPrimaryError) {
      throw cleanupErr;
    }
  }
}

before(async () => {
  step("before: start local environment and supabase functions serve");
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-retired-seat-asks-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(
    envFile,
    [
      "SWARM_ENV=test",
      "SWARM_SELF_SERVE=1",
      "SWARM_CHAT_MENTIONS=1",
      "SWARM_INTERACTIVE_REPLIES=1",
      "SWARM_SEAT_ADMIN=1",
      `SWARM_COMMAND_ALLOWED_ORIGINS=${ALLOWED_ORIGIN}`,
    ].join("\n") + "\n",
    { mode: 0o600 },
  );
  hostedHarnessPath = join(envDir, "hosted-rsa-harness.ts");
  writeFileSync(hostedHarnessPath, HOSTED_HARNESS_SOURCE, { mode: 0o600 });

  sql = openBoundedConnection("retired-seat-asks-test", false);
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
    try {
      process.kill(-functionProcess.pid, "SIGTERM");
    } catch {
      /* exited */
    }
    functionProcess.stdout?.destroy();
    functionProcess.stderr?.destroy();
  }
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  const conns = [...activeConnections];
  activeConnections.clear();
  await Promise.allSettled(conns.map((conn) => conn.end({ timeout: 5 })));
  step("after: teardown complete");
});

// ============================================================================
// Suite 6 (R4 Section 5.1 & 5.6): Catalog, functional, direct-role denial,
// rollback (Phase 2 -> Phase 1), rollback-catalog, and re-apply proofs.
// ============================================================================
test(
  "Suite 6: 20261125000002 & 20261125000003 pass catalog/functional proofs, deny direct role access, roll back cleanly, and re-apply",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 6: verify live migrated database passes Phase 1 & Phase 2 proofs");
    await sql.begin(async (tx) => {
      await tx.unsafe(
        catalogAssertPrep(false) +
          "\n" +
          catalogAssertEnable() +
          "\n" +
          repoSql(`${proofRoot}/20261125000002-functional.sql`),
      );
    });

    step("Suite 6: isolated catalog + functional + direct-deny + rollback + reapply drill");
    const directRoleDenyChecks = ["anon", "authenticated", "swarm_read", "swarm_command"]
      .map(
        (role) => `
      DO $deny$
      BEGIN
        EXECUTE 'SET LOCAL ROLE ${role}';
        -- Direct table operations denied on swarm.agent_ask_clear_events and swarm.agent_ask_lifecycle
        FOR i IN 1..2 LOOP
          BEGIN
            IF i = 1 THEN
              PERFORM * FROM swarm.agent_ask_clear_events LIMIT 1;
            ELSE
              PERFORM * FROM swarm.agent_ask_lifecycle LIMIT 1;
            END IF;
            RAISE EXCEPTION 'role ${role} must not SELECT new table %', i;
          EXCEPTION WHEN insufficient_privilege THEN
            NULL;
          END;
        END LOOP;
        BEGIN
          INSERT INTO swarm.agent_ask_clear_events(workspace_id, principal_id, cutoff_epoch, cleared_at, cleared_by_user_id)
          VALUES (gen_random_uuid(), gen_random_uuid(), 1, now(), gen_random_uuid());
          RAISE EXCEPTION 'role ${role} must not INSERT swarm.agent_ask_clear_events';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        BEGIN
          UPDATE swarm.agent_ask_lifecycle SET ask_lifecycle_epoch = 2 WHERE false;
          RAISE EXCEPTION 'role ${role} must not UPDATE swarm.agent_ask_lifecycle';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        BEGIN
          DELETE FROM swarm.agent_ask_clear_events WHERE false;
          RAISE EXCEPTION 'role ${role} must not DELETE swarm.agent_ask_clear_events';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        -- Owner-only helper denied to all runtime/client roles
        BEGIN
          PERFORM swarm.seat_is_disconnected_for_ask_clear(gen_random_uuid(), gen_random_uuid());
          RAISE EXCEPTION 'role ${role} must not EXECUTE swarm.seat_is_disconnected_for_ask_clear';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        -- All four trigger functions denied to all runtime/client roles
        IF has_function_privilege('${role}', 'swarm.agent_ask_lifecycle_validate_refs()', 'EXECUTE')
           OR has_function_privilege('${role}', 'swarm.agent_workspace_memberships_seed_ask_lifecycle()', 'EXECUTE')
           OR has_function_privilege('${role}', 'swarm.agent_ask_clear_events_validate_refs()', 'EXECUTE')
           OR has_function_privilege('${role}', 'swarm.signals_bind_seat_lifecycle_epoch()', 'EXECUTE') THEN
          RAISE EXCEPTION 'role ${role} must not hold EXECUTE on retired-seat-asks trigger functions';
        END IF;
        RESET ROLE;
      END $deny$;
    `,
      )
      .join("\n");

    const nonCommandDefinerDenyChecks = ["anon", "authenticated", "swarm_read"]
      .map(
        (role) => `
      DO $deny_def$
      BEGIN
        EXECUTE 'SET LOCAL ROLE ${role}';
        BEGIN
          PERFORM swarm.clear_retired_seat_asks(gen_random_uuid(), gen_random_uuid(), gen_random_uuid());
          RAISE EXCEPTION 'role ${role} must not execute clear_retired_seat_asks';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        BEGIN
          PERFORM swarm.advance_seat_lifecycle_epoch(gen_random_uuid(), gen_random_uuid());
          RAISE EXCEPTION 'role ${role} must not execute advance_seat_lifecycle_epoch';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        BEGIN
          PERFORM swarm.seat_ask_lifecycle_epoch(gen_random_uuid(), gen_random_uuid());
          RAISE EXCEPTION 'role ${role} must not execute seat_ask_lifecycle_epoch';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        BEGIN
          PERFORM swarm.seat_ask_clear_release_allowed(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, now());
          RAISE EXCEPTION 'role ${role} must not execute seat_ask_clear_release_allowed';
        EXCEPTION WHEN insufficient_privilege THEN NULL;
        END;
        RESET ROLE;
      END $deny_def$;
    `,
      )
      .join("\n");

    // runSql() uses emptyApplicationSchema() (pg_dump --schema-only, zero data rows),
    // so seed the Phase 2 rollout flag in swarm.config at the start of the isolated drill.
    const seedRolloutConfig = `
      INSERT INTO swarm.config (key, value)
      VALUES ('retired_seat_ask_clear_enabled', 'true'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
    `;

    runSql(
      sqlPhase("rsa-seed-config", seedRolloutConfig) +
        sqlPhase(
          "rsa-initial-proofs",
          catalogAssertPrep(false) +
            "\n" +
            catalogAssertEnable() +
            "\n" +
            repoSql(`${proofRoot}/20261125000002-functional.sql`),
        ) +
        sqlPhase("rsa-direct-role-denial", directRoleDenyChecks + "\n" + nonCommandDefinerDenyChecks) +
        sqlPhase(
          "rsa-rollback-phase2",
          repoSql(`${proofRoot}/20261125000003-rollback.sql`) +
            "\n" +
            catalogAssertPrep(false) +
            "\n" +
            repoSql(`${proofRoot}/20261125000002-functional.sql`),
        ) +
        sqlPhase(
          "rsa-rollback-phase1",
          repoSql(`${proofRoot}/20261125000002-rollback.sql`) + "\n" + catalogAssertPrep(true),
        ) +
        sqlPhase(
          "rsa-reapply-phase1",
          repoSql("supabase/migrations/20261125000002_retired_seat_asks_prep.sql") +
            "\n" +
            catalogAssertPrep(false) +
            "\n" +
            repoSql(`${proofRoot}/20261125000002-functional.sql`),
        ) +
        sqlPhase(
          "rsa-reapply-phase2",
          repoSql("supabase/migrations/20261125000003_retired_seat_asks_enable.sql") +
            "\n" +
            catalogAssertEnable() +
            "\n" +
            repoSql(`${proofRoot}/20261125000002-functional.sql`),
        ),
    );
  },
);

// ============================================================================
// Suite 1a (R4 Section 5.2): Disconnected local & hosted states, live refusals,
// R3 Point 2 claimed hosted seat provider-family witness & controls, and
// runtime sender_lifecycle_epoch verification.
// ============================================================================
test(
  "Suite 1a: disconnected local & hosted states clear cleanly, live seats refuse 409, and R3 Point 2 claimed hosted seat provider-family witness holds",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 1a: provision workspace & users");
    const owner = await createUser("rsa1a-owner");
    const adminUser = await createUser("rsa1a-admin");
    const agentOwner = await createUser("rsa1a-agowner");
    const departingOwner = await createUser("rsa1a-depart");
    const addressee = await createUser("rsa1a-addr");
    const outsider = await createUser("rsa1a-out");
    const wsId = await createServedWorkspace({
      name: "RSA-1a",
      owner,
      members: [
        { user: adminUser, role: "admin" },
        { user: agentOwner, role: "member" },
        { user: departingOwner, role: "member" },
        { user: addressee, role: "member" },
      ],
    });
    const privSlug = `priv-${randomBytes(3).toString("hex")}`;
    const privChResp = await sendCommand(owner.jwt, wsId, {
      kind: "channel_create",
      slug: privSlug,
      visibility: "private",
    });
    assert.equal(privChResp.status, 200, respDiag("create priv channel", privChResp));
    const privChId = String((privChResp.body.channel as Row).channel_id);

    let primaryFailed = false;
    try {
      // 1. Live local seat: post plain ask + choice ask + note; check sender_lifecycle_epoch + live 409 refusal.
      step("Suite 1a.1: live local seat refuses 409 seat_still_live + runtime epoch check");
      const liveLocal = await createLocalAgent({ wsId, owner: agentOwner, name: "LiveLocal" });
      const livePlainResp = await sendCommand(liveLocal.token, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Live local plain ask?",
      });
      assert.equal(livePlainResp.status, 200, respDiag("livePlainResp", livePlainResp));
      const livePlainAskId = postedSignalId("livePlainResp", livePlainResp);

      const liveChoiceResp = await sendCommand(liveLocal.token, wsId, {
        kind: "ask_choice",
        to_user_id: addressee.id,
        about: null,
        body: "Live local choice ask?",
        options: [...CHOICE_OPTIONS],
      });
      assert.equal(liveChoiceResp.status, 200, respDiag("liveChoiceResp", liveChoiceResp));
      const liveChoiceAskId = postedSignalId("liveChoiceResp", liveChoiceResp);

      const liveNoteResp = await sendCommand(liveLocal.token, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Live local note",
      });
      assert.equal(liveNoteResp.status, 200, respDiag("liveNoteResp", liveNoteResp));
      const liveNoteId = postedSignalId("liveNoteResp", liveNoteResp);

      const humanAskResp = await sendCommand(owner.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Human ask control?",
      });
      assert.equal(humanAskResp.status, 200, respDiag("humanAskResp", humanAskResp));
      const humanAskId = postedSignalId("humanAskResp", humanAskResp);

      const epochRows = await sql<{ id: string; sender_lifecycle_epoch: string | null }[]>`
        SELECT id, sender_lifecycle_epoch::text
        FROM swarm.signals
        WHERE id = ANY(${[livePlainAskId, liveChoiceAskId, liveNoteId, humanAskId]}::uuid[])
      `;
      const epochById = new Map(epochRows.map((r) => [r.id, r.sender_lifecycle_epoch]));
      assert.equal(epochById.get(livePlainAskId), "2", "runtime local post_signal ask stamps explicit epoch");
      assert.equal(epochById.get(liveChoiceAskId), "2", "runtime local ask_choice stamps explicit epoch");
      assert.equal(epochById.get(liveNoteId), null, "runtime local note keeps sender_lifecycle_epoch NULL");
      assert.equal(epochById.get(humanAskId), null, "runtime human ask keeps sender_lifecycle_epoch NULL");

      const liveRefused = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: liveLocal.principalId,
      });
      assert.equal(liveRefused.status, 409, respDiag("liveRefused", liveRefused));
      assert.deepEqual(liveRefused.body, RETIRED_SEAT_STILL_LIVE_BODY, respDiag("liveRefused", liveRefused));
      const [liveCutoffs] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.agent_ask_clear_events
        WHERE workspace_id = ${wsId}::uuid AND principal_id = ${liveLocal.principalId}::uuid
      `;
      assert.equal(Number(liveCutoffs!.cnt), 0, "409 seat_still_live must write zero cutoff rows");

      // 2. Disconnected local states: key_off, key_ended, paused, removed, departed-owner.
      step("Suite 1a.2: local key_off (revoked token) cleared by agent owner & checked on all projections");
      // Put liveLocal in private channel so we also verify unauthorized Archived isolation.
      const addPriv = await sendCommand(owner.jwt, wsId, {
        kind: "channel_member_add",
        channel_id: privChId,
        members: [{ kind: "agent", id: liveLocal.principalId }],
      });
      assert.equal(addPriv.status, 200, respDiag("addPriv", addPriv));
      const privAskResp = await sendCommand(liveLocal.token, wsId, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: owner.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        channel: privSlug,
        body: "Private channel ask from KeyOff?",
      });
      assert.equal(privAskResp.status, 200, respDiag("privAskResp", privAskResp));
      const privAskId = postedSignalId("privAskResp", privAskResp);

      const revTok = await sendCommand(agentOwner.jwt, wsId, {
        kind: "revoke_agent_token",
        token_id: liveLocal.tokenId,
      });
      assert.equal(revTok.status, 200, respDiag("revTok", revTok));
      assert.equal(await readConnectionKind(wsId, liveLocal.principalId), "key_off");

      // Agent's human owner (a live 'member', not owner/admin) clears their own disconnected agent!
      const clearKeyOff = await sendCommand(agentOwner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: liveLocal.principalId,
      });
      assert.equal(clearKeyOff.status, 200, respDiag("clearKeyOff", clearKeyOff));
      assert.equal(clearKeyOff.body.status, "accepted");
      assert.equal(clearKeyOff.body.principal_id, liveLocal.principalId);
      assert.equal(typeof clearKeyOff.body.cleared_at, "string");
      for (const forbiddenKey of ["cutoff_epoch", "cleared_count", "signal_ids", "channel_ids", "had_open_asks"]) {
        assert.equal(Object.hasOwn(clearKeyOff.body, forbiddenKey), false, `wire response must omit ${forbiddenKey}`);
      }

      // Check all projections for addressee (authorized for public asks, NOT for privAskId) and owner (authorized for privAskId).
      const addrViews = await readWaitingViewsAs(wsId, addressee.id);
      const dqIds = ((addrViews.dq.asks as Array<Row>) ?? []).map((a) => a.signal_id);
      assert.equal(dqIds.includes(livePlainAskId), false, "decision_queue excludes cleared plain ask");
      assert.equal(dqIds.includes(liveChoiceAskId), false, "decision_queue excludes cleared choice ask");
      assert.equal(dqIds.includes(humanAskId), true, "human ask stays open");
      const dqpIds = ((addrViews.dqp.asks as Array<Row>) ?? []).map((a) => a.signal_id);
      assert.equal(dqpIds.includes(livePlainAskId), false, "decision_queue_page excludes cleared ask");
      const hoAsks = ((addrViews.wsOverview?.needs_you as { asks?: Array<Row> })?.asks ?? []).map((a) => a.signal_id);
      assert.equal(hoAsks.includes(livePlainAskId), false, "home_overview excludes cleared ask");

      const addrArch = (addrViews.wa.items as Array<Row>) ?? [];
      for (const id of [livePlainAskId, liveChoiceAskId]) {
        const entry = addrArch.find((item) => item.item_key === `ask:${id}`);
        assert.ok(entry, `addressee waiting_archived_page must contain ask:${id}`);
        assert.equal(entry.outcome_kind, "seat_cleared");
        assert.equal(entry.outcome_text, "Cleared (seat inactive)");
        assert.equal(entry.answered_by, null);
      }
      assert.equal(
        addrArch.some((item) => item.item_key === `ask:${privAskId}`),
        false,
        "unauthorized viewer must NOT see private cleared ask in waiting_archived_page",
      );

      const ownerViews = await readWaitingViewsAs(wsId, owner.id);
      const ownerPrivArch = ((ownerViews.wa.items as Array<Row>) ?? []).find((item) => item.item_key === `ask:${privAskId}`);
      assert.ok(ownerPrivArch, "authorized owner sees private cleared ask in waiting_archived_page");
      assert.equal(ownerPrivArch.outcome_kind, "seat_cleared");
      assert.equal(ownerPrivArch.outcome_text, "Cleared (seat inactive)");

      const myOpenCleared = await readMyOpenAsksAsAgentSql(wsId, agentOwner.id, liveLocal.principalId);
      assert.deepEqual(myOpenCleared.asks, [], "my_open_asks excludes cleared asks");

      // Local key_ended (expired token + expired/removed standing renewal)
      step("Suite 1a.3: local key_ended, paused, removed, and departed-owner states");
      const endedLocal = await createLocalAgent({ wsId, owner, name: "KeyEndedLocal" });
      const endedAsk = postedSignalId(
        "endedAsk",
        await sendCommand(endedLocal.token, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Key ended ask?",
        }),
      );
      await sql`
        UPDATE swarm.agent_tokens
        SET expires_at = clock_timestamp() - interval '1 minute'
        WHERE principal_id = ${endedLocal.principalId}::uuid
      `;
      await sql`
        UPDATE swarm.renewal_grants
        SET connection_expires_at = clock_timestamp() - interval '1 minute'
        WHERE principal_id = ${endedLocal.principalId}::uuid
      `;
      assert.equal(await readConnectionKind(wsId, endedLocal.principalId), "key_ended");
      const clearEnded = await sendCommand(adminUser.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: endedLocal.principalId,
      });
      assert.equal(clearEnded.status, 200, respDiag("clearEnded", clearEnded));
      assert.equal(
        ((await readWaitingViewsAs(wsId, addressee.id)).wa.items as Array<Row>).find(
          (i) => i.item_key === `ask:${endedAsk}`,
        )?.outcome_kind,
        "seat_cleared",
      );

      // Local paused (idle-suspended renewal grant)
      const pausedLocal = await createLocalAgent({ wsId, owner, name: "PausedLocal" });
      const pausedAsk = postedSignalId(
        "pausedAsk",
        await sendCommand(pausedLocal.token, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Paused seat ask?",
        }),
      );
      await sql`
        UPDATE swarm.agent_tokens
        SET expires_at = clock_timestamp() - interval '1 minute'
        WHERE principal_id = ${pausedLocal.principalId}::uuid
      `;
      await sql`
        UPDATE swarm.renewal_grants
        SET suspended_at = clock_timestamp() - interval '1 minute'
        WHERE principal_id = ${pausedLocal.principalId}::uuid
      `;
      assert.equal(await readConnectionKind(wsId, pausedLocal.principalId), "paused");
      const clearPaused = await sendCommand(adminUser.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: pausedLocal.principalId,
      });
      assert.equal(clearPaused.status, 200, respDiag("clearPaused", clearPaused));
      assert.equal(
        ((await readWaitingViewsAs(wsId, addressee.id)).wa.items as Array<Row>).find(
          (i) => i.item_key === `ask:${pausedAsk}`,
        )?.outcome_kind,
        "seat_cleared",
      );

      // Local removed seat
      const removedLocal = await createLocalAgent({ wsId, owner, name: "RemovedLocal" });
      const removedAsk = postedSignalId(
        "removedAsk",
        await sendCommand(removedLocal.token, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Removed seat ask?",
        }),
      );
      const rmSeatResp = await sendCommand(owner.jwt, wsId, {
        kind: "remove_agent_from_workspace",
        principal_id: removedLocal.principalId,
      });
      assert.equal(rmSeatResp.status, 200, respDiag("rmSeatResp", rmSeatResp));
      const clearRemoved = await sendCommand(adminUser.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: removedLocal.principalId,
      });
      assert.equal(clearRemoved.status, 200, respDiag("clearRemoved", clearRemoved));
      assert.equal(
        (await sql<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsId}::uuid, ${removedAsk}::uuid) AS w`)[0]!.w,
        true,
      );

      // Departed-owner seat (agent owner removed from workspace while agent_workspace_memberships still unrevoked)
      const departedLocal = await createLocalAgent({ wsId, owner: departingOwner, name: "DepartedOwnerBot" });
      const departedAsk = postedSignalId(
        "departedAsk",
        await sendCommand(departedLocal.token, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Departed owner ask?",
        }),
      );
      // Simulate departed human owner directly on memberships (even if agent membership row stayed open).
      await sql`
        UPDATE swarm.memberships
        SET revoked_at = clock_timestamp()
        WHERE workspace_id = ${wsId}::uuid AND user_id = ${departingOwner.id}::uuid
      `;
      const clearDeparted = await sendCommand(adminUser.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: departedLocal.principalId,
      });
      assert.equal(clearDeparted.status, 200, respDiag("clearDeparted", clearDeparted));
      assert.equal(
        (await sql<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsId}::uuid, ${departedAsk}::uuid) AS w`)[0]!.w,
        true,
      );

      // 3. R3 HOLD Point 2: Claimed hosted seat provider-family witness + live controls + expired/revoked hosted states.
      step("Suite 1a.4: R3 Point 2 claimed hosted seat provider-family witness & controls");
      // 3a. Witness: claimed hosted seat with active local rows + real OAuth refresh_family_tombstones row.
      const tombHosted = await seedHostedSeat({ wsId, ownerId: owner.id, name: "HostedTombstoned" });
      const [hostedPosted, hostedChoicePosted] = runHostedSteps([
        {
          grantId: tombHosted.grantId,
          providerGrantId: tombHosted.providerGrantId,
          handle: tombHosted.handle,
          workspaceId: wsId,
          tool: "ask",
          command: {
            kind: "post_signal",
            signal_kind: "ask",
            to_user_id: addressee.id,
            to_agent_principal_id: null,
            in_reply_to: null,
            about: null,
            body: "Hosted tombstoned plain ask?",
          },
        },
        {
          grantId: tombHosted.grantId,
          providerGrantId: tombHosted.providerGrantId,
          handle: tombHosted.handle,
          workspaceId: wsId,
          tool: "ask",
          command: {
            kind: "ask_choice",
            to_user_id: addressee.id,
            about: null,
            body: "Hosted tombstoned choice ask?",
            options: [...CHOICE_OPTIONS],
          },
        },
      ]);
      assert.equal(hostedPosted!.status, 200, respDiag("hostedPosted", hostedPosted!));
      assert.equal(hostedChoicePosted!.status, 200, respDiag("hostedChoicePosted", hostedChoicePosted!));
      const hostedPlainAskId = postedSignalId("hostedPosted", hostedPosted!);
      const hostedChoiceAskId = postedSignalId("hostedChoicePosted", hostedChoicePosted!);

      const hostedEpochRows = await sql<{ id: string; sender_lifecycle_epoch: string | null }[]>`
        SELECT id, sender_lifecycle_epoch::text FROM swarm.signals
        WHERE id IN (${hostedPlainAskId}::uuid, ${hostedChoiceAskId}::uuid)
      `;
      for (const r of hostedEpochRows) {
        assert.equal(r.sender_lifecycle_epoch, "1", `hosted runtime ask ${r.id} must stamp explicit epoch`);
      }

      // Insert real OAuth refresh family tombstone WITHOUT revoking local hosted_mcp_grants or hosted_mcp_seats!
      await sql`
        INSERT INTO commonswarm_oauth.refresh_family_tombstones (grant_id, revoked_at)
        VALUES (${tombHosted.providerGrantId}, clock_timestamp())
      `;
      assert.equal(
        await readConnectionKind(wsId, tombHosted.principalId),
        "connection_off",
        "agent_connection_kind must report connection_off for claimed hosted seat with tombstoned refresh family",
      );
      assert.equal(
        await readOverviewAgentConnection(wsId, owner.id, tombHosted.principalId),
        "connection_off",
        "home_overview must report connection_off for claimed hosted seat with tombstoned refresh family",
      );
      const clearTombHosted = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: tombHosted.principalId,
      });
      assert.equal(
        clearTombHosted.status,
        200,
        `claimed hosted seat with tombstoned OAuth family must accept (NOT 409): ${respDiag("clearTombHosted", clearTombHosted)}`,
      );
      const afterTombViews = await readWaitingViewsAs(wsId, addressee.id);
      const afterTombDqIds = ((afterTombViews.dq.asks as Array<Row>) ?? []).map((a) => a.signal_id);
      assert.equal(afterTombDqIds.includes(hostedPlainAskId), false);
      assert.equal(afterTombDqIds.includes(hostedChoiceAskId), false);
      const afterTombArch = (afterTombViews.wa.items as Array<Row>) ?? [];
      assert.equal(afterTombArch.find((i) => i.item_key === `ask:${hostedPlainAskId}`)?.outcome_kind, "seat_cleared");
      assert.deepEqual((await readMyOpenAsksAsAgentSql(wsId, owner.id, tombHosted.principalId)).asks, []);

      // 3b. Control: genuinely live claimed hosted seat (no tombstone) -> reports 'live' and refuses 409 seat_still_live.
      const liveHosted = await seedHostedSeat({ wsId, ownerId: owner.id, name: "HostedLiveControl" });
      assert.equal(await readConnectionKind(wsId, liveHosted.principalId), "live");
      assert.equal(await readOverviewAgentConnection(wsId, owner.id, liveHosted.principalId), "live");
      const liveHostedRefused = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: liveHosted.principalId,
      });
      assert.equal(liveHostedRefused.status, 409, respDiag("liveHostedRefused", liveHostedRefused));
      assert.deepEqual(liveHostedRefused.body, RETIRED_SEAT_STILL_LIVE_BODY);
      const [liveHostedCutoffs] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.agent_ask_clear_events
        WHERE workspace_id = ${wsId}::uuid AND principal_id = ${liveHosted.principalId}::uuid
      `;
      assert.equal(Number(liveHostedCutoffs!.cnt), 0);

      // 3c. Control: tombstoned claimed seat on G1 WITH a live replacement grant G2 -> rank 1 wins -> 'live' -> refuses 409!
      const replacedHosted = await seedHostedSeat({ wsId, ownerId: owner.id, name: "HostedReplacedControl" });
      await sql`
        INSERT INTO commonswarm_oauth.refresh_family_tombstones (grant_id, revoked_at)
        VALUES (${replacedHosted.providerGrantId}, clock_timestamp())
      `;
      // Add live, un-tombstoned, binding-eligible replacement grant G2 for the same principal in wsId (pre-claim rank 1).
      const replacement = await seedHostedSeat({
        wsId,
        ownerId: owner.id,
        name: "HostedReplacedControl",
        existingPrincipalId: replacedHosted.principalId,
        claimed: false,
      });
      const [policyRow] = await sql<{ grant_id: string }[]>`
        SELECT grant_id FROM swarm.hosted_connection_policy(${wsId}::uuid, ${replacedHosted.principalId}::uuid, ${owner.id}::uuid)
      `;
      assert.equal(policyRow?.grant_id, replacement.grantId, "hosted_connection_policy must rank live replacement grant G2 above tombstoned claimed G1");
      assert.equal(await readConnectionKind(wsId, replacedHosted.principalId), "live");
      const replacedRefused = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: replacedHosted.principalId,
      });
      assert.equal(replacedRefused.status, 409, respDiag("replacedRefused", replacedRefused));
      assert.deepEqual(replacedRefused.body, RETIRED_SEAT_STILL_LIVE_BODY);

      // 3d. Disconnected hosted states: expired connection_expires_at & revoked seat.
      const expiredHosted = await seedHostedSeat({
        wsId,
        ownerId: owner.id,
        name: "HostedExpired",
        connectionExpiresInterval: "-5 minutes",
      });
      assert.equal(await readConnectionKind(wsId, expiredHosted.principalId), "connection_off");
      const clearExpiredHosted = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: expiredHosted.principalId,
      });
      assert.equal(clearExpiredHosted.status, 200, respDiag("clearExpiredHosted", clearExpiredHosted));

      const revokedHosted = await seedHostedSeat({ wsId, ownerId: owner.id, name: "HostedRevokedSeat" });
      await sql`
        UPDATE swarm.hosted_mcp_seats SET revoked_at = clock_timestamp()
        WHERE seat_id = ${revokedHosted.seatId}::uuid
      `;
      assert.equal(await readConnectionKind(wsId, revokedHosted.principalId), "connection_off");
      const clearRevokedHosted = await sendCommand(owner.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: revokedHosted.principalId,
      });
      assert.equal(clearRevokedHosted.status, 200, respDiag("clearRevokedHosted", clearRevokedHosted));
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      await cleanupFixtureInFinally(
        "Suite 1a",
        [wsId],
        [owner.id, adminUser.id, agentOwner.id, departingOwner.id, addressee.id, outsider.id],
        primaryFailed,
      );
    }
  },
);

// ============================================================================
// Suite 1b (R4 Section 5.2): Re-add resurrection guard, precedence & cursor
// stability, undirected channel threads, own-withdrawal idempotency, and
// multi-workspace isolation & reconnect epoch advancement.
// ============================================================================
test(
  "Suite 1b: re-add resurrection guard, precedence/cursor stability, undirected threads, own-withdrawal idempotency, and multi-workspace isolation",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 1b: setup two workspaces");
    const owner = await createUser("rsa1b-owner");
    const addressee = await createUser("rsa1b-addr");
    const wsA = await createServedWorkspace({
      name: "RSA-1b-A",
      owner,
      members: [{ user: addressee, role: "member" }],
    });
    const wsB = await createServedWorkspace({
      name: "RSA-1b-B",
      owner,
      members: [{ user: addressee, role: "member" }],
    });

    let primaryFailed = false;
    try {
      // 1. Re-add resurrection guard (remove -> clear -> add -> new ask stays open while old stays cleared)
      step("Suite 1b.1: re-add resurrection guard");
      const readdBot = await createLocalAgent({ wsId: wsA, owner, name: "ReaddBot" });
      const preClearAsk = postedSignalId(
        "preClearAsk",
        await sendCommand(readdBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Ask before remove & clear?",
        }),
      );
      assert.equal(
        (await sendCommand(owner.jwt, wsA, { kind: "remove_agent_from_workspace", principal_id: readdBot.principalId })).status,
        200,
      );
      assert.equal(
        (await sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: readdBot.principalId })).status,
        200,
      );
      assert.equal(
        (await sendCommand(owner.jwt, wsA, { kind: "add_agent_to_workspace", principal_id: readdBot.principalId })).status,
        200,
      );
      const postReaddAsk = postedSignalId(
        "postReaddAsk",
        await sendCommand(readdBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Ask after re-add?",
        }),
      );
      const afterReaddViews = await readWaitingViewsAs(wsA, addressee.id);
      const afterReaddDq = ((afterReaddViews.dq.asks as Array<Row>) ?? []).map((a) => a.signal_id);
      assert.equal(afterReaddDq.includes(preClearAsk), false, "pre-clear ask must NEVER resurrect on re-add");
      assert.equal(afterReaddDq.includes(postReaddAsk), true, "post-readd ask must stay open");
      const openReadd = await sendRead(readdBot.token, { resource: "my_open_asks", workspace_id: wsA });
      assert.equal(openReadd.status, 200, respDiag("openReadd", openReadd));
      assert.deepEqual(
        ((openReadd.body.asks as Array<Row>) ?? []).map((a) => a.signal_id),
        [postReaddAsk],
      );
      // Verify post-readd ask is answerable.
      const answerPostReadd = await sendCommand(addressee.jwt, wsA, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: postReaddAsk,
        about: null,
        body: "Answering post-readd ask",
      });
      assert.equal(answerPostReadd.status, 200, respDiag("answerPostReadd", answerPostReadd));

      // 2. Precedence, cursor stability across repeated clears, undirected threads, own-withdrawal idempotency.
      step("Suite 1b.2: precedence, cursor stability, undirected thread replyability, own-withdrawal idempotency");
      const precBot = await createLocalAgent({ wsId: wsA, owner, name: "PrecBot" });

      // (a) Prior withdrawn ask
      const withdrawnAsk = postedSignalId(
        "withdrawnAsk",
        await sendCommand(precBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Withdrawn before clear?",
        }),
      );
      const wd1 = await sendCommand(precBot.token, wsA, { kind: "withdraw_ask", signal_id: withdrawnAsk });
      assert.equal(wd1.status, 200, respDiag("wd1", wd1));
      const originalWithdrawnAt = String(wd1.body.withdrawn_at);

      // (b) Prior replaced ask
      const replacedOldAsk = postedSignalId(
        "replacedOldAsk",
        await sendCommand(precBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Old ask to replace?",
        }),
      );
      const repResp = await sendCommand(precBot.token, wsA, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        supersedes: replacedOldAsk,
        body: "Replacement ask left open until clear?",
      });
      assert.equal(repResp.status, 200, respDiag("repResp", repResp));
      const openClearedAsk = postedSignalId("repResp", repResp);

      // (c) Earlier expired ask
      const expiredAskId = randomUUID();
      await sql`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, created_at, until, sender_lifecycle_epoch)
        VALUES (
          ${expiredAskId}::uuid, ${wsA}::uuid, ${precBot.principalId}::uuid, 'agent', ${addressee.id}::uuid,
          'ask', 'Already expired before clear?', statement_timestamp() - interval '10 minutes',
          statement_timestamp() - interval '5 minutes', 1
        )
      `;

      // (d) Earlier channel_archived ask
      const archSlug = `arch-${randomBytes(3).toString("hex")}`;
      const archChResp = await sendCommand(owner.jwt, wsA, { kind: "channel_create", slug: archSlug, visibility: "open" });
      assert.equal(archChResp.status, 200);
      const archChId = String((archChResp.body.channel as Row).channel_id);
      const archChAsk = postedSignalId(
        "archChAsk",
        await sendCommand(precBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          channel: archSlug,
          body: "In channel archived before clear?",
        }),
      );
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "channel_archive", channel_id: archChId })).status, 200);

      // (e) Undirected channel thread rooted by precBot
      const threadRootNote = postedSignalId(
        "threadRootNote",
        await sendCommand(precBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "note",
          to_user_id: null,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Undirected thread root from precBot",
        }),
      );

      // Disconnect precBot and clear twice!
      await delay(50);
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: precBot.tokenId })).status, 200);
      const clear1 = await sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: precBot.principalId });
      assert.equal(clear1.status, 200, respDiag("clear1", clear1));

      const archAfter1 = ((await readWaitingViewsAs(wsA, addressee.id)).wa.items as Array<Row>) ?? [];
      const item1 = (id: string) => archAfter1.find((i) => i.item_key === `ask:${id}`);
      assert.equal(item1(withdrawnAsk)?.outcome_kind, "withdrawn", "prior withdrawn keeps outcome");
      assert.equal(item1(replacedOldAsk)?.outcome_kind, "replaced", "prior replaced keeps outcome");
      assert.equal(item1(expiredAskId)?.outcome_kind, "expired", "earlier expired keeps outcome");
      assert.equal(item1(archChAsk)?.outcome_kind, "channel_archived", "earlier channel_archived keeps outcome");
      assert.equal(item1(openClearedAsk)?.outcome_kind, "seat_cleared");
      const firstClearedArchivedAt = item1(openClearedAsk)?.archived_at;
      assert.ok(typeof firstClearedArchivedAt === "string");

      // Second clear after brief delay must advance epoch and write a second cutoff row WITHOUT shifting archived_at!
      await delay(50);
      const clear2 = await sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: precBot.principalId });
      assert.equal(clear2.status, 200, respDiag("clear2", clear2));
      assert.notEqual(clear2.body.cleared_at, clear1.body.cleared_at);
      const archAfter2 = ((await readWaitingViewsAs(wsA, addressee.id)).wa.items as Array<Row>) ?? [];
      assert.equal(
        archAfter2.find((i) => i.item_key === `ask:${openClearedAsk}`)?.archived_at,
        firstClearedArchivedAt,
        "second clear must never shift archived_at on earlier asks",
      );

      // Undirected channel thread remains replyable after seat clear.
      const threadReply = await sendCommand(addressee.jwt, wsA, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: null,
        thread_root_id: threadRootNote,
        about: null,
        body: "Still replyable thread after seat clear",
      });
      assert.equal(threadReply.status, 200, respDiag("threadReply", threadReply));

      // Reconnect precBot and verify own-withdrawal idempotency is preserved after a later clear!
      const remintedPrec = await sendCommand(owner.jwt, wsA, {
        kind: "mint_agent_token",
        principal_id: precBot.principalId,
        run_id: randomUUID(),
        task_id: randomUUID(),
        epoch: 2,
        device_id: precBot.deviceId,
        scopes: ["post_signal"],
      });
      assert.equal(remintedPrec.status, 200, respDiag("remintedPrec", remintedPrec));
      const precToken2 = String(remintedPrec.body.agent_token);

      const wdAfterClear = await sendCommand(precToken2, wsA, { kind: "withdraw_ask", signal_id: withdrawnAsk });
      assert.equal(wdAfterClear.status, 200, respDiag("wdAfterClear", wdAfterClear));
      assert.equal(wdAfterClear.body.created, false);
      assert.equal(wdAfterClear.body.withdrawn_at, originalWithdrawnAt, "own-withdrawal idempotency preserved after clear");

      const supersedesAlreadyWithdrawn = await sendCommand(precToken2, wsA, {
        kind: "post_signal",
        signal_kind: "ask",
        to_user_id: addressee.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        supersedes: withdrawnAsk,
        body: "Should fail 404",
      });
      assert.equal(supersedesAlreadyWithdrawn.status, 404, respDiag("supersedesAlreadyWithdrawn", supersedesAlreadyWithdrawn));

      // 3. Multi-workspace isolation & cross-workspace reconnect epoch advancement.
      step("Suite 1b.3: multi-workspace isolation & reconnect epoch bump across all live workspaces");
      const multiBot = await createLocalAgent({ wsId: wsA, owner, name: "MultiWsBot" });
      assert.equal(
        (await sendCommand(owner.jwt, wsB, { kind: "add_agent_to_workspace", principal_id: multiBot.principalId })).status,
        200,
      );
      const askInA = postedSignalId(
        "askInA",
        await sendCommand(multiBot.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Ask in Workspace A?",
        }),
      );
      const askInB = postedSignalId(
        "askInB",
        await sendCommand(multiBot.token, wsB, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Ask in Workspace B?",
        }),
      );
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: multiBot.tokenId })).status, 200);

      // Clear ONLY in Workspace A -> B remains open!
      const clearAOnly = await sendCommand(owner.jwt, wsA, {
        kind: "clear_retired_seat_asks",
        principal_id: multiBot.principalId,
      });
      assert.equal(clearAOnly.status, 200, respDiag("clearAOnly", clearAOnly));
      assert.equal(
        (((await readWaitingViewsAs(wsA, addressee.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === askInA),
        false,
        "Workspace A ask cleared",
      );
      assert.equal(
        (((await readWaitingViewsAs(wsB, addressee.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === askInB),
        true,
        "Workspace B ask must stay open when only Workspace A was cleared",
      );

      // Record epochs before reconnect from A
      const epochsBefore = await sql<{ workspace_id: string; ask_lifecycle_epoch: string }[]>`
        SELECT workspace_id, ask_lifecycle_epoch::text
        FROM swarm.agent_ask_lifecycle
        WHERE principal_id = ${multiBot.principalId}::uuid
      `;
      const epBeforeMap = new Map(epochsBefore.map((r) => [r.workspace_id, Number(r.ask_lifecycle_epoch)]));
      assert.equal(epBeforeMap.get(wsA), 3); // 1 -> 2 on initial mint_agent_token -> 3 on clear
      assert.equal(epBeforeMap.get(wsB), 2); // add_agent_to_workspace bumped B to 2

      // Reconnect multiBot via mint_agent_token in Workspace A -> advances epochs in BOTH A and B!
      const remintMulti = await sendCommand(owner.jwt, wsA, {
        kind: "mint_agent_token",
        principal_id: multiBot.principalId,
        run_id: randomUUID(),
        task_id: randomUUID(),
        epoch: 2,
        device_id: multiBot.deviceId,
        scopes: ["post_signal"],
      });
      assert.equal(remintMulti.status, 200, respDiag("remintMulti", remintMulti));
      const multiToken2 = String(remintMulti.body.agent_token);

      const epochsAfter = await sql<{ workspace_id: string; ask_lifecycle_epoch: string }[]>`
        SELECT workspace_id, ask_lifecycle_epoch::text
        FROM swarm.agent_ask_lifecycle
        WHERE principal_id = ${multiBot.principalId}::uuid
      `;
      const epAfterMap = new Map(epochsAfter.map((r) => [r.workspace_id, Number(r.ask_lifecycle_epoch)]));
      assert.equal(epAfterMap.get(wsA), epBeforeMap.get(wsA)! + 1, "reconnect from A advances A epoch");
      assert.equal(epAfterMap.get(wsB), epBeforeMap.get(wsB)! + 1, "reconnect from A advances B epoch too");

      // Post new asks in BOTH A and B -> both stay open!
      const newAskA = postedSignalId(
        "newAskA",
        await sendCommand(multiToken2, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Post-reconnect ask in A?",
        }),
      );
      const newAskB = postedSignalId(
        "newAskB",
        await sendCommand(multiToken2, wsB, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Post-reconnect ask in B?",
        }),
      );
      assert.equal(
        (((await readWaitingViewsAs(wsA, addressee.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === newAskA),
        true,
      );
      assert.equal(
        (((await readWaitingViewsAs(wsB, addressee.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === newAskB),
        true,
      );
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      await cleanupFixtureInFinally("Suite 1b", [wsA, wsB], [owner.id, addressee.id], primaryFailed);
    }
  },
);

// ============================================================================
// Suite 2 (R4 Section 5.3): Condition 1 & Path 1 zero hidden-answer oracle AND
// zero completion-predicate evaluation on post-cutoff refusals.
// ============================================================================
test(
  "Suite 2: Condition 1 & Path 1 zero hidden-answer oracle and zero ask_answered / ask_complete_for_withdrawal calls on post-cutoff refusals",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 2: enable track_functions='all' and provision workspace");
    const owner = await createUser("rsa2-owner");
    const addrA = await createUser("rsa2-addra");
    const addrB = await createUser("rsa2-addrb");
    const wsId = await createServedWorkspace({
      name: "RSA-2",
      owner,
      members: [
        { user: addrA, role: "member" },
        { user: addrB, role: "member" },
      ],
    });

    const readFnCalls = async (sig: string): Promise<number> => {
      await sql`SELECT pg_stat_clear_snapshot()`;
      const [row] = await sql<{ calls: string }[]>`
        SELECT COALESCE(pg_stat_get_function_calls(${sig}::regprocedure), 0)::text AS calls
      `;
      return Number(row!.calls);
    };

    const waitForFnCallsIncrement = async (sig: string, baseline: number, timeoutMs = 3_000): Promise<number> => {
      const deadline = Date.now() + timeoutMs;
      let latest = baseline;
      while (Date.now() < deadline) {
        latest = await readFnCalls(sig);
        if (latest > baseline) return latest;
        await delay(50);
      }
      return latest;
    };

    const readLatestAudit = async (commandKind: string, sinceId: number): Promise<Row | null> => {
      const [row] = await sql<{
        audit_id: string;
        outcome: string;
        reason: string | null;
        detail: string | null;
        channel_ids: string[] | null;
      }[]>`
        SELECT audit_id::text, outcome, reason, detail, channel_ids
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind = ${commandKind}
          AND audit_id > ${sinceId}::bigint
        ORDER BY audit_id DESC
        LIMIT 1
      `;
      if (!row) return null;
      return {
        outcome: row.outcome,
        reason: row.reason,
        detail: row.detail,
        channel_ids: row.channel_ids,
      };
    };

    const maxAuditId = async (): Promise<number> => {
      const [row] = await sql<{ m: string }[]>`
        SELECT COALESCE(max(audit_id), 0)::text AS m FROM swarm.audit_log WHERE workspace_id = ${wsId}::uuid
      `;
      return Number(row!.m);
    };

    const adminSql = openBoundedConnection(
      "retired-seat-asks-track-fn",
      true,
      localClusterAdminUrl(local.DB_URL),
    );
    let primaryFailed = false;
    try {
      await adminSql`ALTER SYSTEM SET track_functions = 'all'`;
      await adminSql`SELECT pg_reload_conf()`;
      // Brief pause so pooled backends observe SIGHUP before probing.
      await delay(150);

      const sharedSlug = `shared-${randomBytes(3).toString("hex")}`;
      const sharedChResp = await sendCommand(owner.jwt, wsId, {
        kind: "channel_create",
        slug: sharedSlug,
        visibility: "open",
      });
      assert.equal(sharedChResp.status, 200);
      const sharedChId = String((sharedChResp.body.channel as Row).channel_id);

      const privASlug = `priva-${randomBytes(3).toString("hex")}`;
      const privAChResp = await sendCommand(addrA.jwt, wsId, {
        kind: "channel_create",
        slug: privASlug,
        visibility: "private",
      });
      assert.equal(privAChResp.status, 200);
      const privAChId = String((privAChResp.body.channel as Row).channel_id);

      const bot = await createLocalAgent({ wsId, owner, name: "Cond1Bot" });
      assert.equal(
        (await sendCommand(addrA.jwt, wsId, {
          kind: "channel_member_add",
          channel_id: privAChId,
          members: [{ kind: "agent", id: bot.principalId }],
        })).status,
        200,
      );

      // Post 3 side-by-side fixture pairs (plain ask + choice ask in #shared addressed to A & B):
      // 1 = never answered, 2 = unreadable answer/completed choice by A, 3 = readable answer by A.
      const postPlain = async (body: string) =>
        postedSignalId(
          body,
          await sendCommand(bot.token, wsId, {
            kind: "post_signal",
            signal_kind: "ask",
            to_user_id: null,
            to_agent_principal_id: null,
            to: [
              { kind: "user", id: addrA.id },
              { kind: "user", id: addrB.id },
            ],
            in_reply_to: null,
            about: null,
            channel: sharedSlug,
            body,
          }),
        );
      const postChoice = async (body: string) => {
        const id = postedSignalId(
          body,
          await sendCommand(bot.token, wsId, {
            kind: "ask_choice",
            to_user_id: null,
            about: null,
            channel: sharedSlug,
            body,
            options: [...CHOICE_OPTIONS],
          }),
        );
        return id;
      };

      const f1Plain = await postPlain("F1 never answered plain?");
      const f1Choice = await postChoice("F1 never answered choice?");

      const f2Plain = await postPlain("F2 unreadable answer plain?");
      const f2Choice = await postChoice("F2 unreadable answer choice?");

      const f3Plain = await postPlain("F3 readable answer plain?");
      const f3Choice = await postChoice("F3 readable answer choice?");

      // Seed F2 unreadable answer by Addressee A inside #privA (unreadable to B)
      const f2PlainReplyId = randomUUID();
      const f2ChoiceReplyId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`SET CONSTRAINTS ALL DEFERRED`;
        await tx`
          INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, channel_id, until)
          VALUES
            (${f2PlainReplyId}::uuid, ${wsId}::uuid, ${addrA.id}::uuid, 'user', ${f2Plain}::uuid, 'note', 'Secret answer from A', ${privAChId}::uuid, '9999-12-31T23:59:59Z'),
            (${f2ChoiceReplyId}::uuid, ${wsId}::uuid, ${addrA.id}::uuid, 'user', ${f2Choice}::uuid, 'note', 'Selected: Yes, proceed', ${privAChId}::uuid, '9999-12-31T23:59:59Z')
        `;
        await tx`
          INSERT INTO swarm.ui_actions (
            action_id, workspace_id, signal_id, actor_user_id, option_id, option_ids, state, reply_signal_id, completed_at
          ) VALUES (
            ${randomUUID()}::uuid, ${wsId}::uuid, ${f2Choice}::uuid, ${addrA.id}::uuid,
            'opt_yes', ARRAY['opt_yes']::text[], 'completed', ${f2ChoiceReplyId}::uuid, clock_timestamp()
          )
        `;
        await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      });

      // Seed F3 readable answer by Addressee A in #shared (undirected conversation reply visible to both A & B)
      const f3PlainReplyId = randomUUID();
      await sql`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, channel_id, until)
        VALUES (
          ${f3PlainReplyId}::uuid, ${wsId}::uuid, ${addrA.id}::uuid, 'user', ${f3Plain}::uuid,
          'note', 'Public readable answer from A', ${sharedChId}::uuid, '9999-12-31T23:59:59Z'
        )
      `;
      const aaBeforeF3Choice = await readFnCalls("swarm.ask_answered(uuid,uuid)");
      const f3ChoiceAnsCmdId = randomUUID();
      const f3ChoiceAns = await sendCommand(
        addrA.jwt,
        wsId,
        { kind: "answer_choice", signal_id: f3Choice, option_id: "opt_yes" },
        f3ChoiceAnsCmdId,
      );
      assert.equal(f3ChoiceAns.status, 200, respDiag("f3ChoiceAns", f3ChoiceAns));
      // Wait for f3ChoiceAns's backend stats to flush before negative probes start (also proves track_functions='all' is live).
      const aaAfterF3Choice = await waitForFnCallsIncrement("swarm.ask_answered(uuid,uuid)", aaBeforeF3Choice);
      assert.ok(
        aaAfterF3Choice > aaBeforeF3Choice,
        `track_functions='all' warmup must flush ask_answered (${aaBeforeF3Choice} -> ${aaAfterF3Choice})`,
      );

      // Disconnect bot, clear its asks, then reconnect bot so it can attempt post-cutoff reraise/withdraw/supersedes!
      assert.equal((await sendCommand(owner.jwt, wsId, { kind: "revoke_agent_token", token_id: bot.tokenId })).status, 200);
      assert.equal((await sendCommand(owner.jwt, wsId, { kind: "clear_retired_seat_asks", principal_id: bot.principalId })).status, 200);
      const reconnected = await sendCommand(owner.jwt, wsId, {
        kind: "mint_agent_token",
        principal_id: bot.principalId,
        run_id: randomUUID(),
        task_id: randomUUID(),
        epoch: 2,
        device_id: bot.deviceId,
        scopes: ["post_signal"],
      });
      assert.equal(reconnected.status, 200, respDiag("reconnected", reconnected));
      const botToken2 = String(reconnected.body.agent_token);

      // Probe all 5 post-cutoff write paths across F1, F2, F3 and capture parity + call deltas!
      const probeFixture = async (label: string, plainId: string, choiceId: string) => {
        step(`Suite 2: probing ${label}`);
        const results: Record<string, { status: number; body: Row; audit: Row | null; uiActionsCount: number }> = {};

        // 1. Addressee B calls post_signal(in_reply_to)
        let since = await maxAuditId();
        const aaBefore1 = await readFnCalls("swarm.ask_answered(uuid,uuid)");
        const rReply = await sendCommand(addrB.jwt, wsId, {
          kind: "post_signal",
          signal_kind: "note",
          to_user_id: null,
          to_agent_principal_id: null,
          in_reply_to: plainId,
          about: null,
          channel: sharedSlug,
          body: "Post-cutoff reply by B",
        });
        assert.equal(await readFnCalls("swarm.ask_answered(uuid,uuid)"), aaBefore1, `${label}: post_signal must not call ask_answered`);
        assert.equal(rReply.status, 403, respDiag(`${label}.reply`, rReply));
        results.reply = {
          status: rReply.status,
          body: rReply.body,
          audit: await readLatestAudit("post_signal", since),
          uiActionsCount: 0,
        };

        // 2. Addressee B calls answer_choice
        since = await maxAuditId();
        const aaBefore2 = await readFnCalls("swarm.ask_answered(uuid,uuid)");
        const rAns = await sendCommand(addrB.jwt, wsId, {
          kind: "answer_choice",
          signal_id: choiceId,
          option_id: "opt_no",
        });
        assert.equal(await readFnCalls("swarm.ask_answered(uuid,uuid)"), aaBefore2, `${label}: answer_choice post-cutoff must have 0 ask_answered calls`);
        assert.equal(rAns.status, 409, respDiag(`${label}.answer_choice`, rAns));
        assert.equal(rAns.body.error, "ask_expired");
        const [bUiRows] = await sql<{ cnt: string }[]>`
          SELECT count(*)::text AS cnt FROM swarm.ui_actions
          WHERE workspace_id = ${wsId}::uuid AND signal_id = ${choiceId}::uuid AND actor_user_id = ${addrB.id}::uuid
        `;
        assert.equal(Number(bUiRows!.cnt), 0, `${label}: 0 ui_actions rows for B`);
        results.answer_choice = {
          status: rAns.status,
          body: rAns.body,
          audit: await readLatestAudit("answer_choice", since),
          uiActionsCount: Number(bUiRows!.cnt),
        };

        // 3. Reconnected seat calls reraise_ask
        since = await maxAuditId();
        const aaBefore3 = await readFnCalls("swarm.ask_answered(uuid,uuid)");
        const rReraise = await sendCommand(botToken2, wsId, {
          kind: "reraise_ask",
          signal_id: plainId,
        });
        assert.equal(await readFnCalls("swarm.ask_answered(uuid,uuid)"), aaBefore3, `${label}: reraise_ask post-cutoff must have 0 ask_answered calls`);
        assert.equal(rReraise.status, 409, respDiag(`${label}.reraise`, rReraise));
        assert.equal(rReraise.body.error, "ask_withdrawn");
        results.reraise = {
          status: rReraise.status,
          body: rReraise.body,
          audit: await readLatestAudit("reraise_ask", since),
          uiActionsCount: 0,
        };

        // 4. Reconnected seat calls withdraw_ask
        since = await maxAuditId();
        const aaBefore4 = await readFnCalls("swarm.ask_answered(uuid,uuid)");
        const wcBefore4 = await readFnCalls("swarm.ask_complete_for_withdrawal(uuid,uuid)");
        const rWithdraw = await sendCommand(botToken2, wsId, {
          kind: "withdraw_ask",
          signal_id: plainId,
        });
        assert.equal(await readFnCalls("swarm.ask_answered(uuid,uuid)"), aaBefore4, `${label}: withdraw_ask post-cutoff must have 0 ask_answered calls`);
        assert.equal(await readFnCalls("swarm.ask_complete_for_withdrawal(uuid,uuid)"), wcBefore4, `${label}: withdraw_ask post-cutoff must have 0 ask_complete_for_withdrawal calls`);
        assert.equal(rWithdraw.status, 404, respDiag(`${label}.withdraw`, rWithdraw));
        results.withdraw = {
          status: rWithdraw.status,
          body: rWithdraw.body,
          audit: await readLatestAudit("withdraw_ask", since),
          uiActionsCount: 0,
        };

        // 5. Reconnected seat calls post_signal(supersedes)
        since = await maxAuditId();
        const aaBefore5 = await readFnCalls("swarm.ask_answered(uuid,uuid)");
        const wcBefore5 = await readFnCalls("swarm.ask_complete_for_withdrawal(uuid,uuid)");
        const rSupersedes = await sendCommand(botToken2, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addrB.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          channel: sharedSlug,
          supersedes: plainId,
          body: "Supersedes cleared ask?",
        });
        assert.equal(await readFnCalls("swarm.ask_answered(uuid,uuid)"), aaBefore5, `${label}: supersedes post-cutoff must have 0 ask_answered calls`);
        assert.equal(await readFnCalls("swarm.ask_complete_for_withdrawal(uuid,uuid)"), wcBefore5, `${label}: supersedes post-cutoff must have 0 ask_complete_for_withdrawal calls`);
        assert.equal(rSupersedes.status, 404, respDiag(`${label}.supersedes`, rSupersedes));
        results.supersedes = {
          status: rSupersedes.status,
          body: rSupersedes.body,
          audit: await readLatestAudit("post_signal", since),
          uiActionsCount: 0,
        };

        return results;
      };

      const resF1 = await probeFixture("F1-never-answered", f1Plain, f1Choice);
      const resF2 = await probeFixture("F2-unreadable-answer", f2Plain, f2Choice);
      const resF3 = await probeFixture("F3-readable-answer", f3Plain, f3Choice);

      assert.deepEqual(resF2, resF1, "F2 (unreadable answer) must be byte-identical to F1 (never answered) across status, body, ui_actions, and audit_log");
      assert.deepEqual(resF3, resF1, "F3 (readable answer) must be byte-identical to F1 (never answered) on post-cutoff refusals");

      // Check Archived visibility for F1, F2, F3
      const archA = ((await readWaitingViewsAs(wsId, addrA.id)).wa.items as Array<Row>) ?? [];
      const archB = ((await readWaitingViewsAs(wsId, addrB.id)).wa.items as Array<Row>) ?? [];
      const findArch = (items: Array<Row>, id: string) => items.find((i) => i.item_key === `ask:${id}`);

      assert.equal(findArch(archB, f1Plain)?.outcome_kind, "seat_cleared");
      assert.equal(findArch(archB, f1Plain)?.answered_by, null);
      assert.equal(findArch(archB, f2Plain)?.outcome_kind, "seat_cleared", "B cannot see A's private answer -> seat_cleared");
      assert.equal(findArch(archB, f2Plain)?.answered_by, null);
      assert.equal(findArch(archA, f2Plain)?.outcome_kind, "answered", "A still sees their own answer in Archived");
      assert.equal(findArch(archA, f3Plain)?.outcome_kind, "answered");
      assert.equal(findArch(archB, f3Plain)?.outcome_kind, "answered", "readable F3 stays answered for B");
      assert.equal((findArch(archB, f3Plain)?.answered_by as { id?: string } | null)?.id, addrA.id);

      // Addressee A retrying their own completed answer_choice on F3 -> 200 (same) and 409 choice_conflict (different), BOTH with 0 ask_answered calls!
      const aaBeforeMine = await readFnCalls("swarm.ask_answered(uuid,uuid)");
      const replaySameCmd = await sendCommand(
        addrA.jwt,
        wsId,
        { kind: "answer_choice", signal_id: f3Choice, option_id: "opt_yes" },
        f3ChoiceAnsCmdId,
      );
      assert.equal(replaySameCmd.status, 200, respDiag("replaySameCmd", replaySameCmd));
      const retrySameOpt = await sendCommand(addrA.jwt, wsId, {
        kind: "answer_choice",
        signal_id: f3Choice,
        option_id: "opt_yes",
      });
      assert.equal(retrySameOpt.status, 200, respDiag("retrySameOpt", retrySameOpt));
      const retryDiffOpt = await sendCommand(addrA.jwt, wsId, {
        kind: "answer_choice",
        signal_id: f3Choice,
        option_id: "opt_no",
      });
      assert.equal(retryDiffOpt.status, 409, respDiag("retryDiffOpt", retryDiffOpt));
      assert.equal(retryDiffOpt.body.error, "choice_conflict");
      assert.equal(
        await readFnCalls("swarm.ask_answered(uuid,uuid)"),
        aaBeforeMine,
        "caller-settled choiceLedgerReplay/mine retry must have 0 ask_answered calls",
      );

      // Positive control: live non-cutoff answered ask MUST increment ask_answered & ask_complete_for_withdrawal!
      step("Suite 2: positive probe control on live non-cutoff answered ask");
      const liveChoiceCtrl = postedSignalId(
        "liveChoiceCtrl",
        await sendCommand(botToken2, wsId, {
          kind: "ask_choice",
          to_user_id: null,
          about: null,
          channel: sharedSlug,
          body: "Positive control choice ask?",
          options: [...CHOICE_OPTIONS],
        }),
      );
      assert.equal(
        (await sendCommand(addrA.jwt, wsId, { kind: "answer_choice", signal_id: liveChoiceCtrl, option_id: "opt_yes" })).status,
        200,
      );
      const aaBeforePos = await readFnCalls("swarm.ask_answered(uuid,uuid)");
      const bLateLive = await sendCommand(addrB.jwt, wsId, {
        kind: "answer_choice",
        signal_id: liveChoiceCtrl,
        option_id: "opt_no",
      });
      assert.equal(bLateLive.status, 409, respDiag("bLateLive", bLateLive));
      assert.equal(bLateLive.body.error, "ask_answered");
      const aaAfterPos = await waitForFnCallsIncrement("swarm.ask_answered(uuid,uuid)", aaBeforePos);
      assert.ok(aaAfterPos > aaBeforePos, `positive control must increment ask_answered (${aaBeforePos} -> ${aaAfterPos})`);

      const wcBeforePos = await readFnCalls("swarm.ask_complete_for_withdrawal(uuid,uuid)");
      const wdLiveAnswered = await sendCommand(botToken2, wsId, {
        kind: "withdraw_ask",
        signal_id: liveChoiceCtrl,
      });
      assert.equal(wdLiveAnswered.status, 404, respDiag("wdLiveAnswered", wdLiveAnswered));
      const wcAfterPos = await waitForFnCallsIncrement("swarm.ask_complete_for_withdrawal(uuid,uuid)", wcBeforePos);
      assert.ok(
        wcAfterPos > wcBeforePos,
        `positive control must increment ask_complete_for_withdrawal (${wcBeforePos} -> ${wcAfterPos})`,
      );
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      let resetError: unknown = null;
      try {
        await adminSql`ALTER SYSTEM RESET track_functions`;
        await adminSql`SELECT pg_reload_conf()`;
      } catch (resetErr) {
        console.error("[retired-seat-asks] Suite 2 track_functions reset failed:", resetErr);
        resetError = resetErr;
      } finally {
        try {
          await adminSql.end({ timeout: 2 });
        } catch {
          /* admin connection already closed */
        } finally {
          activeConnections.delete(adminSql);
        }
      }
      await cleanupFixtureInFinally(
        "Suite 2",
        [wsId],
        [owner.id, addrA.id, addrB.id],
        primaryFailed || resetError !== null,
      );
      if (!primaryFailed && resetError !== null) {
        throw resetError;
      }
    }
  },
);

// ============================================================================
// Suite 3 (R4 Section 5.4): Condition 2 & R3 Point 1 mandatory epoch trigger,
// Phase 1 rollout gate, concurrent reconnect (both lock orders), and held human
// authority changes (change_role, remove_member, archive_workspace) both orders.
// ============================================================================
test(
  "Suite 3: Condition 2 & R3 Point 1 epoch trigger controls, Phase 1 rollout gate, concurrent reconnect races, and held authority changes",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 3: provision workspaces & users");
    const owner = await createUser("rsa3-owner");
    const adminDemote = await createUser("rsa3-admdem");
    const adminRemove = await createUser("rsa3-admrem");
    const addressee = await createUser("rsa3-addr");
    const wsA = await createServedWorkspace({
      name: "RSA-3-A",
      owner,
      members: [
        { user: adminDemote, role: "admin" },
        { user: adminRemove, role: "admin" },
        { user: addressee, role: "member" },
      ],
    });
    const wsB = await createServedWorkspace({
      name: "RSA-3-B",
      owner,
      members: [{ user: addressee, role: "member" }],
    });
    const wsArchive = await createServedWorkspace({
      name: "RSA-3-Arch",
      owner,
      members: [{ user: adminDemote, role: "admin" }],
    });

    let primaryFailed = false;
    try {
      // 1. Mandatory captured-epoch trigger controls (R3 Point 1) under BOTH swarm_command and owner roles.
      step("Suite 3.1: mandatory epoch trigger controls (NULL, delayed-E, current+1, 0, unexpected, Phase 1 gate)");
      const trigBot = await createLocalAgent({ wsId: wsA, owner, name: "TrigBot" });
      const [trigEpochRow] = await sql<{ e: string }[]>`
        SELECT swarm.seat_ask_lifecycle_epoch(${wsA}::uuid, ${trigBot.principalId}::uuid)::text AS e
      `;
      const trigEpoch = Number(trigEpochRow!.e);
      assert.equal(trigEpoch, 2, "createLocalAgent starts at epoch 2 after initial mint_agent_token");

      for (const role of ["swarm_command", "swarm_admin"] as const) {
        await sql.begin(async (tx) => {
          await tx.unsafe(`SET LOCAL ROLE ${role}`);
          // Before a clear (current_epoch = trigEpoch, enabled = true): NULL rejected 42501 SEAT_LIFECYCLE_EPOCH_REQUIRED
          await tx`SAVEPOINT sp_null_before`;
          await assert.rejects(
            () => tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
              VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Omitted epoch?', '9999-12-31T23:59:59Z', NULL)
            `,
            (err: { code?: string; message?: string }) =>
              err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_REQUIRED/.test(err?.message ?? ""),
            `${role}: omitted NULL before clear must fail 42501 SEAT_LIFECYCLE_EPOCH_REQUIRED`,
          );
          await tx`ROLLBACK TO SAVEPOINT sp_null_before`;

          // Forged future epoch (current + 1) -> 42501 SEAT_LIFECYCLE_EPOCH_INVALID
          await tx`SAVEPOINT sp_future`;
          await assert.rejects(
            () => tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
              VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Forged future?', '9999-12-31T23:59:59Z', ${trigEpoch + 1}::bigint)
            `,
            (err: { code?: string; message?: string }) =>
              err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_INVALID/.test(err?.message ?? ""),
            `${role}: forged future epoch must fail 42501 SEAT_LIFECYCLE_EPOCH_INVALID`,
          );
          await tx`ROLLBACK TO SAVEPOINT sp_future`;

          // Non-positive epoch (0) -> 42501 SEAT_LIFECYCLE_EPOCH_INVALID
          await tx`SAVEPOINT sp_zero`;
          await assert.rejects(
            () => tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
              VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Zero epoch?', '9999-12-31T23:59:59Z', 0)
            `,
            (err: { code?: string; message?: string }) =>
              err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_INVALID/.test(err?.message ?? ""),
            `${role}: epoch 0 must fail 42501 SEAT_LIFECYCLE_EPOCH_INVALID`,
          );
          await tx`ROLLBACK TO SAVEPOINT sp_zero`;

          // Unexpected epoch on non-ask agent note & human ask -> 42501 SEAT_LIFECYCLE_EPOCH_UNEXPECTED
          await tx`SAVEPOINT sp_unexp_note`;
          await assert.rejects(
            () => tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, sender_lifecycle_epoch)
              VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', 'note', 'Note with epoch', '9999-12-31T23:59:59Z', 1)
            `,
            (err: { code?: string; message?: string }) =>
              err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_UNEXPECTED/.test(err?.message ?? ""),
            `${role}: agent note with epoch must fail 42501 SEAT_LIFECYCLE_EPOCH_UNEXPECTED`,
          );
          await tx`ROLLBACK TO SAVEPOINT sp_unexp_note`;

          await tx`SAVEPOINT sp_unexp_human`;
          await assert.rejects(
            () => tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
              VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${owner.id}::uuid, 'user', ${addressee.id}::uuid, 'ask', 'Human ask with epoch?', '9999-12-31T23:59:59Z', 1)
            `,
            (err: { code?: string; message?: string }) =>
              err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_UNEXPECTED/.test(err?.message ?? ""),
            `${role}: human ask with epoch must fail 42501 SEAT_LIFECYCLE_EPOCH_UNEXPECTED`,
          );
          await tx`ROLLBACK TO SAVEPOINT sp_unexp_human`;
        });
      }

      // Disconnect & clear trigBot -> cutoff_epoch = trigEpoch (2), v_current_epoch = 3.
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: trigBot.tokenId })).status, 200);
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: trigBot.principalId })).status, 200);

      // Omitted NULL after clear -> 42501 SEAT_LIFECYCLE_EPOCH_REQUIRED; delayed explicit-E (trigEpoch) succeeds and is covered!
      const delayedAskId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE swarm_command`;
        await tx`SAVEPOINT sp_null_after`;
        await assert.rejects(
          () => tx`
            INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
            VALUES (${randomUUID()}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Omitted after clear?', '9999-12-31T23:59:59Z', NULL)
          `,
          (err: { code?: string; message?: string }) =>
            err?.code === "42501" && /SEAT_LIFECYCLE_EPOCH_REQUIRED/.test(err?.message ?? ""),
        );
        await tx`ROLLBACK TO SAVEPOINT sp_null_after`;

        await tx`
          INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
          VALUES (${delayedAskId}::uuid, ${wsA}::uuid, ${trigBot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Delayed explicit E ask?', '9999-12-31T23:59:59Z', ${trigEpoch}::bigint)
        `;
        const [withdrawn] = await tx<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsA}::uuid, ${delayedAskId}::uuid) AS w`;
        assert.equal(withdrawn!.w, true, "delayed explicit-E ask must fall under cutoff_epoch = E");
      });
      assert.equal(
        (((await readWaitingViewsAs(wsA, addressee.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === delayedAskId),
        false,
        "delayed explicit-E ask must stay absent from decision_queue",
      );

      // Phase 1 rollout gate behavior tested in a rolled-back transaction (zero leak to live config!)
      const phase1Bot = await createLocalAgent({ wsId: wsA, owner, name: "Phase1Bot" });
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: phase1Bot.tokenId })).status, 200);
      await sql
        .begin(async (tx) => {
          await tx`UPDATE swarm.config SET value = 'false'::jsonb WHERE key = 'retired_seat_ask_clear_enabled'`;
          // Simulate a seat created during Phase 1 (still at epoch 1 before Phase 2 enablement).
          await tx`
            UPDATE swarm.agent_ask_lifecycle
            SET ask_lifecycle_epoch = 1
            WHERE workspace_id = ${wsA}::uuid AND principal_id = ${phase1Bot.principalId}::uuid
          `;
          await tx`SET LOCAL ROLE swarm_command`;
          const [clearDisabled] = await tx<{ r: Row }[]>`
            SELECT swarm.clear_retired_seat_asks(${wsA}::uuid, ${owner.id}::uuid, ${phase1Bot.principalId}::uuid) AS r
          `;
          assert.deepEqual(clearDisabled!.r, { status: "clearing_not_enabled" });
          const [advDisabled] = await tx<{ e: string }[]>`
            SELECT swarm.advance_seat_lifecycle_epoch(${phase1Bot.principalId}::uuid, ${wsA}::uuid)::text AS e
          `;
          assert.equal(advDisabled!.e, "1", "advance_seat_lifecycle_epoch must no-op to 1 in Phase 1");

          const legacyNullId = randomUUID();
          await tx`
            INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
            VALUES (${legacyNullId}::uuid, ${wsA}::uuid, ${phase1Bot.principalId}::uuid, 'agent', ${addressee.id}::uuid, 'ask', 'Phase 1 omitted NULL ask?', '9999-12-31T23:59:59Z')
          `;
          const [storedNull] = await tx<{ ep: string | null }[]>`
            SELECT sender_lifecycle_epoch::text AS ep FROM swarm.signals WHERE id = ${legacyNullId}::uuid
          `;
          assert.equal(storedNull!.ep, null, "Phase 1 must store NULL verbatim and never backfill v_current_epoch");

          // Flip to Phase 2 inside this rolled-back tx -> clear at cutoff_epoch=1 covers the NULL ask!
          await tx`RESET ROLE`;
          await tx`UPDATE swarm.config SET value = 'true'::jsonb WHERE key = 'retired_seat_ask_clear_enabled'`;
          await tx`SET LOCAL ROLE swarm_command`;
          const [clearEnabled] = await tx<{ r: Row }[]>`
            SELECT swarm.clear_retired_seat_asks(${wsA}::uuid, ${owner.id}::uuid, ${phase1Bot.principalId}::uuid) AS r
          `;
          assert.equal(clearEnabled!.r.status, "ok");
          const [covered] = await tx<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsA}::uuid, ${legacyNullId}::uuid) AS w`;
          assert.equal(covered!.w, true, "Phase 1 NULL ask evaluates as epoch 1 and is covered by cutoff_epoch = 1");

          throw RELEASE_LOCK_ROLLBACK;
        })
        .catch((err) => {
          if (err !== RELEASE_LOCK_ROLLBACK) throw err;
        });

      // 2. Concurrent reconnect (both outcomes) for local same-WS, sibling-W2 mint, add_agent_to_workspace, and hosted claim.
      step("Suite 3.2: concurrent reconnect Outcome A (reconnect holds lock first -> clear refuses 409)");
      const raceA = await createLocalAgent({ wsId: wsA, owner, name: "RaceReconA" });
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: raceA.tokenId })).status, 200);
      await withHeldTransaction(
        "recon-A-local",
        async (tx) => {
          // Reconnect acquires Step 17 agent_ask_lifecycle FOR NO KEY UPDATE, inserts fresh token, advances epoch, holds before COMMIT.
          const newRun = randomUUID();
          const newTok = `swm_agt_${randomBytes(32).toString("base64url")}`;
          await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${newRun}::uuid, ${raceA.principalId}::uuid, ${raceA.deviceId}::uuid)`;
          await tx`
            INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
            VALUES (${randomUUID()}::uuid, ${raceA.principalId}::uuid, ${newRun}::uuid, ${tx.json(["post_signal"])}::jsonb,
              ${createHash("sha256").update(newTok).digest()}, clock_timestamp() + interval '1 hour', ${randomUUID()}::uuid)
          `;
          await tx`SELECT swarm.advance_seat_lifecycle_epoch(${raceA.principalId}::uuid, NULL::uuid)`;
        },
        async ({ holderPid, commitHolder, trackPending }) => {
          const pendingClear = trackPending(
            sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: raceA.principalId }),
          );
          await waitForBlockedOnPid(holderPid, "clear waits on Step 17 held by reconnect");
          await commitHolder();
          const clearResp = await raceWithTimeout(pendingClear, "clear wakes after reconnect commit");
          assert.equal(clearResp.status, 409, respDiag("clearResp after reconnect", clearResp));
          assert.deepEqual(clearResp.body, RETIRED_SEAT_STILL_LIVE_BODY);
          const [cnt] = await sql<{ c: string }[]>`
            SELECT count(*)::text AS c FROM swarm.agent_ask_clear_events
            WHERE workspace_id = ${wsA}::uuid AND principal_id = ${raceA.principalId}::uuid
          `;
          assert.equal(Number(cnt!.c), 0);
        },
      );

      step("Suite 3.3: concurrent reconnect Outcome B (clear holds Step 17 at audit_log -> sibling-W2 mint waits, then succeeds)");
      const raceB = await createLocalAgent({ wsId: wsA, owner, name: "RaceReconB" });
      assert.equal((await sendCommand(owner.jwt, wsB, { kind: "add_agent_to_workspace", principal_id: raceB.principalId })).status, 200);
      const raceBPreAsk = postedSignalId(
        "raceBPreAsk",
        await sendCommand(raceB.token, wsA, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: addressee.id,
          to_agent_principal_id: null,
          in_reply_to: null,
          about: null,
          body: "Race B pre-clear ask?",
        }),
      );
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: raceB.tokenId })).status, 200);

      await withHeldTransaction(
        "recon-B-clear-first",
        async (tx) => {
          await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
        },
        async ({ holderPid, rollbackHolder, trackPending }) => {
          // Real HTTP clear (by adminDemote so owner's users row only takes FOR KEY SHARE, letting owner's
          // sibling-wsB mint reach Step 17!) acquires Step 3/5/17 locks, writes cutoff & bumps epoch, then blocks on audit_log!
          const pendingClear = trackPending(
            sendCommand(adminDemote.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: raceB.principalId }),
          );
          const clearPid = await waitForBlockedOnPid(holderPid, "clear parked at audit_log");

          // Fire REAL HTTP mint_agent_token from sibling workspace wsB -> blocks on clearPid's Step 17 agent_ask_lifecycle(wsA, raceB)!
          const pendingMint = trackPending(
            sendCommand(owner.jwt, wsB, {
              kind: "mint_agent_token",
              principal_id: raceB.principalId,
              run_id: randomUUID(),
              task_id: randomUUID(),
              epoch: 2,
              device_id: raceB.deviceId,
              scopes: ["post_signal"],
            }),
          );
          await waitForBlockedOnPid(clearPid, "sibling-wsB mint waits on clearPid Step 17 lock");

          // Release audit_log -> clear commits -> mint wakes up, advances epoch > cutoff, and commits!
          await rollbackHolder();
          const [clearRes, mintRes] = await raceWithTimeout(
            Promise.all([pendingClear, pendingMint]),
            "clear + sibling-W2 mint complete",
          );
          assert.equal(clearRes.status, 200, respDiag("raceB clearRes", clearRes));
          assert.equal(mintRes.status, 200, respDiag("raceB mintRes", mintRes));
          const freshToken = String(mintRes.body.agent_token);

          const raceBPostAsk = postedSignalId(
            "raceBPostAsk",
            await sendCommand(freshToken, wsA, {
              kind: "post_signal",
              signal_kind: "ask",
              to_user_id: addressee.id,
              to_agent_principal_id: null,
              in_reply_to: null,
              about: null,
              body: "Race B post-reconnect ask?",
            }),
          );
          const dqAsks = (((await readWaitingViewsAs(wsA, addressee.id)).dq.asks as Array<Row>) ?? []).map((a) => a.signal_id);
          assert.equal(dqAsks.includes(raceBPreAsk), false, "pre-clear ask stays cleared");
          assert.equal(dqAsks.includes(raceBPostAsk), true, "post-reconnect ask stays open");
        },
      );

      // Hosted claim concurrent reconnect (Outcome A & Outcome B)
      step("Suite 3.4: concurrent hosted claim_hosted_seat reconnect (Outcome A & B)");
      const hostedRace = await seedHostedSeat({ wsId: wsA, ownerId: owner.id, name: "HostedRaceSeat" });
      await sql`
        UPDATE swarm.hosted_mcp_seats SET revoked_at = clock_timestamp()
        WHERE seat_id = ${hostedRace.seatId}::uuid
      `;
      await withHeldTransaction(
        "hosted-claim-first",
        async (tx) => {
          // Simulate active replacement grant + claim_hosted_seat holding Step 17 before commit.
          const g2 = randomUUID();
          const digest = new Uint8Array(32).fill(5);
          await tx`
            INSERT INTO swarm.hosted_mcp_grants (
              grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
              selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at, connection_expires_at
            ) VALUES (
              ${g2}::uuid, ${`provider-${g2}`}, ${owner.id}::uuid, ${wsA}::uuid, 'rsa-hosted-client',
              'https://mcp.commonswarm.com/mcp', ${[wsA]}::uuid[], ${digest}, ${`ref-${g2}`}, 'active',
              statement_timestamp(), statement_timestamp(), clock_timestamp() + interval '7 days'
            )
          `;
          await tx`
            INSERT INTO swarm.hosted_mcp_grant_workspaces (grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at)
            VALUES (${g2}::uuid, ${wsA}::uuid, ${owner.id}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())
          `;
          await tx`
            INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
            VALUES (${g2}::uuid, ${hostedRace.principalId}::uuid, ${owner.id}::uuid)
          `;
          const s2 = randomUUID();
          await tx`
            INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
            VALUES (${s2}::uuid, ${g2}::uuid, ${wsA}::uuid, ${owner.id}::uuid, ${hostedRace.principalId}::uuid, 'HostedRaceSeat', statement_timestamp())
          `;
          await tx`SELECT swarm.advance_seat_lifecycle_epoch(${hostedRace.principalId}::uuid, ${wsA}::uuid)`;
        },
        async ({ holderPid, commitHolder, trackPending }) => {
          const pendingClear = trackPending(
            sendCommand(owner.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: hostedRace.principalId }),
          );
          await waitForBlockedOnPid(holderPid, "clear waits on hosted claim Step 17");
          await commitHolder();
          const res = await raceWithTimeout(pendingClear, "clear wakes after hosted claim commit");
          assert.equal(res.status, 409, respDiag("clear after hosted claim", res));
          assert.deepEqual(res.body, RETIRED_SEAT_STILL_LIVE_BODY);
        },
      );

      // 3. Held human authority changes (change_role demotion, remove_member, archive_workspace) in BOTH lock orders.
      step("Suite 3.5: held human authority change races (demotion, removal, archive) in both lock orders");
      const authTargetA = await createLocalAgent({ wsId: wsA, owner, name: "AuthTargetA" });
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: authTargetA.tokenId })).status, 200);

      // 3.5a: Demotion (change_role to member) holds Step 3/5 first -> clear blocks then refuses 404 not_found!
      await withHeldTransaction(
        "demote-first",
        async (tx) => {
          await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
        },
        async ({ holderPid, rollbackHolder, trackPending }) => {
          const pendingDemote = trackPending(
            sendCommand(owner.jwt, wsA, { kind: "change_role", user_id: adminDemote.id, role: "member" }),
          );
          const demotePid = await waitForBlockedOnPid(holderPid, "demote parked at audit_log");
          const pendingClear = trackPending(
            sendCommand(adminDemote.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: authTargetA.principalId }),
          );
          await waitForBlockedOnPid(demotePid, "clear waits on demotePid Step 3/5 locks");
          await rollbackHolder();
          const [demoteRes, clearRes] = await raceWithTimeout(Promise.all([pendingDemote, pendingClear]), "demote + clear");
          assert.equal(demoteRes.status, 200, respDiag("demoteRes", demoteRes));
          assert.equal(clearRes.status, 404, respDiag("clear after demote", clearRes));
          assert.deepEqual(clearRes.body, RETIRED_SEAT_NOT_FOUND_BODY);
        },
      );

      // 3.5b: Removal (remove_member) holds Step 3/5 first -> clear blocks then refuses 403 forbidden!
      await withHeldTransaction(
        "remove-first",
        async (tx) => {
          await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
        },
        async ({ holderPid, rollbackHolder, trackPending }) => {
          const pendingRemove = trackPending(
            sendCommand(owner.jwt, wsA, { kind: "remove_member", user_id: adminRemove.id }),
          );
          const removePid = await waitForBlockedOnPid(holderPid, "remove_member parked at audit_log");
          const pendingClear = trackPending(
            sendCommand(adminRemove.jwt, wsA, { kind: "clear_retired_seat_asks", principal_id: authTargetA.principalId }),
          );
          await waitForBlockedOnPid(removePid, "clear waits on removePid Step 3/5 locks");
          await rollbackHolder();
          const [remRes, clearRes] = await raceWithTimeout(Promise.all([pendingRemove, pendingClear]), "remove + clear");
          assert.equal(remRes.status, 200, respDiag("remRes", remRes));
          assert.equal(clearRes.status, 403, respDiag("clear after remove", clearRes));
        },
      );

      // 3.5c: Reverse order (clear holds Step 3/5 first -> archive_workspace waits until clear commits),
      //       then archive holds Step 3 first -> subsequent clear refuses 403!
      const archBot = await createLocalAgent({ wsId: wsArchive, owner, name: "ArchBot" });
      assert.equal((await sendCommand(owner.jwt, wsArchive, { kind: "revoke_agent_token", token_id: archBot.tokenId })).status, 200);
      await withHeldTransaction(
        "clear-before-archive",
        async (tx) => {
          await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
        },
        async ({ holderPid, rollbackHolder, trackPending }) => {
          const pendingClear = trackPending(
            sendCommand(adminDemote.jwt, wsArchive, { kind: "clear_retired_seat_asks", principal_id: archBot.principalId }),
          );
          const clearPid = await waitForBlockedOnPid(holderPid, "clear parked at audit_log before archive");
          const pendingArchive = trackPending(sendCommand(owner.jwt, wsArchive, { kind: "archive_workspace" }));
          await waitForBlockedOnPid(clearPid, "archive_workspace waits on clearPid Step 3 FOR SHARE");
          await rollbackHolder();
          const [clearRes, archRes] = await raceWithTimeout(Promise.all([pendingClear, pendingArchive]), "clear + archive");
          assert.equal(clearRes.status, 200, respDiag("clear before archive", clearRes));
          assert.equal(archRes.status, 200, respDiag("archive after clear", archRes));
        },
      );
      const clearAfterArchive = await sendCommand(adminDemote.jwt, wsArchive, {
        kind: "clear_retired_seat_asks",
        principal_id: archBot.principalId,
      });
      assert.equal(clearAfterArchive.status, 403, respDiag("clearAfterArchive", clearAfterArchive));
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      await cleanupFixtureInFinally(
        "Suite 3",
        [wsA, wsB, wsArchive],
        [owner.id, adminDemote.id, adminRemove.id, addressee.id],
        primaryFailed,
      );
    }
  },
);

// ============================================================================
// Suite 4 (R4 Section 5.5): Condition 3 & Path 2 concurrent-answer orders and
// full private-post independence (held private channel & DM replies, held
// target-seat P private post across clock expiry local & hosted, post-reconnect
// replay while target seat holds private post open, and sibling hosted seat Q).
// ============================================================================
test(
  "Suite 4: Condition 3 & Path 2 concurrent-answer orders and full private-post independence (zero wait & exact empty-control parity)",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 4: provision workspace & private channels");
    const owner = await createUser("rsa4-owner");
    const nonMemberAdmin = await createUser("rsa4-admin");
    const privUser = await createUser("rsa4-priv");
    const otherAddr = await createUser("rsa4-other");
    const wsId = await createServedWorkspace({
      name: "RSA-4",
      owner,
      members: [
        { user: nonMemberAdmin, role: "admin" },
        { user: privUser, role: "member" },
        { user: otherAddr, role: "member" },
      ],
    });

    const privSlug = `secret-${randomBytes(3).toString("hex")}`;
    const privChResp = await sendCommand(privUser.jwt, wsId, {
      kind: "channel_create",
      slug: privSlug,
      visibility: "private",
    });
    assert.equal(privChResp.status, 200, respDiag("privChResp", privChResp));
    const privChId = String((privChResp.body.channel as Row).channel_id);

    const readClearAudit = async (principalId: string, sinceId: number) => {
      const [row] = await sql<{
        command_kind: string;
        outcome: string;
        reason: string | null;
        detail: string | null;
        channel_ids: string[] | null;
      }[]>`
        SELECT command_kind, outcome, reason, detail, channel_ids
        FROM swarm.audit_log
        WHERE workspace_id = ${wsId}::uuid
          AND command_kind = 'clear_retired_seat_asks'
          AND audit_id > ${sinceId}::bigint
        ORDER BY audit_id DESC
        LIMIT 1
      `;
      assert.ok(row, `missing audit_log row for ${principalId}`);
      return {
        command_kind: row.command_kind,
        outcome: row.outcome,
        reason: row.reason,
        detail: row.detail?.replace(principalId, "<PID>") ?? null,
        channel_ids: row.channel_ids,
      };
    };

    const normalizeReceipt = (body: Row, principalId: string): Row => ({
      ...body,
      principal_id: body.principal_id === principalId ? "<PID>" : body.principal_id,
      cleared_at: typeof body.cleared_at === "string" ? "<TS>" : body.cleared_at,
    });

    const maxAuditId = async () => {
      const [r] = await sql<{ m: string }[]>`
        SELECT COALESCE(max(audit_id), 0)::text AS m FROM swarm.audit_log WHERE workspace_id = ${wsId}::uuid
      `;
      return Number(r!.m);
    };

    let primaryFailed = false;
    try {
      // 0. Baseline 0-ask empty control clear by nonMemberAdmin.
      step("Suite 4.0: capture 0-ask empty control baseline");
      const emptyBot = await createLocalAgent({ wsId, owner, name: "EmptyCtrlBot" });
      assert.equal((await sendCommand(owner.jwt, wsId, { kind: "revoke_agent_token", token_id: emptyBot.tokenId })).status, 200);
      const sinceEmpty = await maxAuditId();
      const emptyCtrlResp = await sendCommand(nonMemberAdmin.jwt, wsId, {
        kind: "clear_retired_seat_asks",
        principal_id: emptyBot.principalId,
      });
      assert.equal(emptyCtrlResp.status, 200, respDiag("emptyCtrlResp", emptyCtrlResp));
      const baselineReceipt = normalizeReceipt(emptyCtrlResp.body, emptyBot.principalId);
      const baselineAudit = await readClearAudit(emptyBot.principalId, sinceEmpty);
      assert.deepEqual(baselineAudit, {
        command_kind: "clear_retired_seat_asks",
        outcome: "accepted",
        reason: null,
        detail: "principal_id=<PID>",
        channel_ids: null,
      });

      // (a) Clear-then-answer order & (b) Answer-then-clear order
      step("Suite 4(a)-(b): clear-then-answer and answer-then-clear orders");
      const ordBot = await createLocalAgent({ wsId, owner, name: "OrderBot" });
      const ansFirstPlain = postedSignalId(
        "ansFirstPlain",
        await sendCommand(ordBot.token, wsId, {
          kind: "post_signal",
          signal_kind: "ask",
          to_user_id: null,
          to_agent_principal_id: null,
          to: [
            { kind: "user", id: privUser.id },
            { kind: "user", id: otherAddr.id },
          ],
          in_reply_to: null,
          about: null,
          body: "Answered before clear?",
        }),
      );
      const clearFirstChoice = postedSignalId(
        "clearFirstChoice",
        await sendCommand(ordBot.token, wsId, {
          kind: "ask_choice",
          to_user_id: otherAddr.id,
          about: null,
          body: "Cleared before answer?",
          options: [...CHOICE_OPTIONS],
        }),
      );
      // Answer ansFirstPlain BEFORE clear
      assert.equal(
        (await sendCommand(privUser.jwt, wsId, {
          kind: "post_signal",
          signal_kind: "note",
          to_user_id: null,
          to_agent_principal_id: null,
          in_reply_to: ansFirstPlain,
          about: null,
          body: "Early answer before clear",
        })).status,
        200,
      );
      assert.equal((await sendCommand(owner.jwt, wsId, { kind: "revoke_agent_token", token_id: ordBot.tokenId })).status, 200);
      assert.equal((await sendCommand(owner.jwt, wsId, { kind: "clear_retired_seat_asks", principal_id: ordBot.principalId })).status, 200);

      // Verify (a): post-clear fresh attempts refused
      const lateChoice = await sendCommand(otherAddr.jwt, wsId, {
        kind: "answer_choice",
        signal_id: clearFirstChoice,
        option_id: "opt_yes",
      });
      assert.equal(lateChoice.status, 409);
      assert.equal(lateChoice.body.error, "ask_expired");
      const latePlain = await sendCommand(otherAddr.jwt, wsId, {
        kind: "post_signal",
        signal_kind: "note",
        to_user_id: null,
        to_agent_principal_id: null,
        in_reply_to: ansFirstPlain,
        about: null,
        body: "Post-clear reply on already-answered ask",
      });
      assert.equal(latePlain.status, 403);

      // Verify (b): prior answer stays 'answered' in waiting_archived_page for authorized viewer,
      // while cleared choice ask shows 'seat_cleared' for addressee.
      const privOrdArch = ((await readWaitingViewsAs(wsId, privUser.id)).wa.items as Array<Row>) ?? [];
      assert.equal(privOrdArch.find((i) => i.item_key === `ask:${ansFirstPlain}`)?.outcome_kind, "answered");
      const otherOrdArch = ((await readWaitingViewsAs(wsId, otherAddr.id)).wa.items as Array<Row>) ?? [];
      assert.equal(otherOrdArch.find((i) => i.item_key === `ask:${clearFirstChoice}`)?.outcome_kind, "seat_cleared");

      // (c) Different-human held private-reply overlap (private channel AND private DM; plain reply AND answer_choice)
      step("Suite 4(c): held different-human private-reply overlap (private channel + private DM; plain + choice)");
      for (const mode of ["private-channel-choice", "private-dm-plain"] as const) {
        const privBot = await createLocalAgent({ wsId, owner, name: `PrivBot-${mode}` });
        if (mode === "private-channel-choice") {
          assert.equal(
            (await sendCommand(privUser.jwt, wsId, {
              kind: "channel_member_add",
              channel_id: privChId,
              members: [{ kind: "agent", id: privBot.principalId }],
            })).status,
            200,
          );
        }
        const askId =
          mode === "private-channel-choice"
            ? postedSignalId(
                mode,
                await sendCommand(privBot.token, wsId, {
                  kind: "ask_choice",
                  to_user_id: privUser.id,
                  about: null,
                  channel: privSlug,
                  body: "Secret private-channel choice ask?",
                  options: [...CHOICE_OPTIONS],
                }),
              )
            : postedSignalId(
                mode,
                await sendCommand(privBot.token, wsId, {
                  kind: "post_signal",
                  signal_kind: "ask",
                  to_user_id: privUser.id,
                  to_agent_principal_id: null,
                  in_reply_to: null,
                  about: null,
                  body: "Secret private-DM plain ask?",
                }),
              );
        assert.equal((await sendCommand(owner.jwt, wsId, { kind: "revoke_agent_token", token_id: privBot.tokenId })).status, 200);

        const replyId = randomUUID();
        const deliveriesBefore = Number(
          (await sql<{ c: string }[]>`SELECT count(*)::text AS c FROM swarm.signal_deliveries WHERE workspace_id = ${wsId}::uuid`)[0]!.c,
        );

        await withHeldTransaction(
          `held-reply-${mode}`,
          async (tx) => {
            // Mirror exact locks & writes of an admitted human private reply before COMMIT:
            await tx`SELECT 1 FROM swarm.users WHERE user_id = ${privUser.id}::uuid FOR NO KEY UPDATE`;
            await tx`SELECT 1 FROM swarm.workspaces WHERE workspace_id = ${wsId}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.memberships WHERE workspace_id = ${wsId}::uuid AND user_id = ${privUser.id}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.streams WHERE workspace_id = ${wsId}::uuid AND kind = 'workspace' FOR UPDATE`;
            await tx`SELECT pg_advisory_xact_lock(hashtextextended('answer_choice:' || ${wsId} || ':' || ${askId}, 0))`;
            const [w] = await tx<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsId}::uuid, ${askId}::uuid) AS w`;
            assert.equal(w!.w, false, "admitted before cutoff");
            await tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, channel_id, until)
              VALUES (
                ${replyId}::uuid, ${wsId}::uuid, ${privUser.id}::uuid, 'user', ${askId}::uuid, 'note',
                ${mode === "private-channel-choice" ? "Selected: Yes, proceed" : "Held private DM answer"},
                ${mode === "private-channel-choice" ? privChId : null}::uuid, '9999-12-31T23:59:59Z'
              )
            `;
            if (mode === "private-channel-choice") {
              await tx`
                INSERT INTO swarm.ui_actions (
                  action_id, workspace_id, signal_id, actor_user_id, option_id, option_ids, state, reply_signal_id, completed_at
                ) VALUES (
                  ${randomUUID()}::uuid, ${wsId}::uuid, ${askId}::uuid, ${privUser.id}::uuid,
                  'opt_yes', ARRAY['opt_yes']::text[], 'completed', ${replyId}::uuid, clock_timestamp()
                )
              `;
            }
          },
          async ({ commitHolder }) => {
            // Invoke REAL HTTP clear_retired_seat_asks WHILE T_reply is STILL HELD OPEN!
            const since = await maxAuditId();
            const clearWhileHeld = await raceWithTimeout(
              sendCommand(nonMemberAdmin.jwt, wsId, {
                kind: "clear_retired_seat_asks",
                principal_id: privBot.principalId,
              }),
              `clear finishes immediately while ${mode} held open`,
              5_000,
            );
            assert.equal(clearWhileHeld.status, 200, respDiag(`clearWhileHeld(${mode})`, clearWhileHeld));
            assert.deepEqual(normalizeReceipt(clearWhileHeld.body, privBot.principalId), baselineReceipt);
            assert.deepEqual(await readClearAudit(privBot.principalId, since), baselineAudit);
            assert.doesNotMatch(JSON.stringify(clearWhileHeld.body), new RegExp(`${privChId}|${askId}`));
            const deliveriesAfterClear = Number(
              (await sql<{ c: string }[]>`SELECT count(*)::text AS c FROM swarm.signal_deliveries WHERE workspace_id = ${wsId}::uuid`)[0]!.c,
            );
            assert.equal(deliveriesAfterClear, deliveriesBefore, "clear emits zero per-ask notifications/deliveries");

            // Now commit T_reply cleanly afterward!
            await commitHolder();
          },
        );
        const privArch = ((await readWaitingViewsAs(wsId, privUser.id)).wa.items as Array<Row>) ?? [];
        assert.equal(
          privArch.find((i) => i.item_key === `ask:${askId}`)?.outcome_kind,
          "answered",
          `${mode}: committed held reply stays 'answered' for authorized private reader`,
        );
      }

      // (d) Held target-seat P private post across clock expiry (local key_ended AND hosted expired connection_off)
      step("Suite 4(d): held target-seat P private post across clock expiry (local key_ended & hosted expired)");
      // 4d-local: test BOTH resume positions (Position 1 pre-fence rollback; Position 2 post-fence epoch-bound commit)
      for (const pos of ["pre-fence-rollback", "post-fence-commit"] as const) {
        const expBot = await createLocalAgent({ wsId, owner: privUser, name: `ExpLocal-${pos}` });
        await sql`
          UPDATE swarm.agent_tokens SET expires_at = clock_timestamp() + interval '1 second'
          WHERE principal_id = ${expBot.principalId}::uuid
        `;
        await sql`
          UPDATE swarm.renewal_grants
          SET connection_expires_at = clock_timestamp() + interval '1 second'
          WHERE principal_id = ${expBot.principalId}::uuid
        `;
        const delayedLocalAskId = randomUUID();
        let capturedEpoch = 0;

        await withHeldTransaction(
          `local-expiry-${pos}`,
          async (tx) => {
            // Exact local send locks (Steps 1, 3, 5, 7, 9, 12, 13, 15, 16) + atomic epoch capture while live!
            await tx`SELECT 1 FROM swarm.users WHERE user_id = ${privUser.id}::uuid FOR KEY SHARE`;
            await tx`SELECT 1 FROM swarm.workspaces WHERE workspace_id = ${wsId}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.memberships WHERE workspace_id = ${wsId}::uuid AND user_id = ${privUser.id}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.agent_workspace_memberships WHERE workspace_id = ${wsId}::uuid AND principal_id = ${expBot.principalId}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.streams WHERE workspace_id = ${wsId}::uuid AND kind = 'workspace' FOR UPDATE`;
            await tx`SELECT 1 FROM swarm.agent_principals WHERE principal_id = ${expBot.principalId}::uuid FOR SHARE`;
            await tx`SELECT 1 FROM swarm.renewal_grants WHERE principal_id = ${expBot.principalId}::uuid FOR UPDATE`;
            await tx`SELECT 1 FROM swarm.agent_tokens WHERE principal_id = ${expBot.principalId}::uuid FOR UPDATE`;
            const [ep] = await tx<{ e: string }[]>`SELECT swarm.seat_ask_lifecycle_epoch(${wsId}::uuid, ${expBot.principalId}::uuid)::text AS e`;
            capturedEpoch = Number(ep!.e);
            assert.equal(capturedEpoch, 2);
          },
          async ({ runInHolder, commitHolder, rollbackHolder }) => {
            // Wait for natural clock expiry into key_ended while T_post holds all local credential locks!
            await delay(1_250);
            const since = await maxAuditId();
            const clearExp = await raceWithTimeout(
              sendCommand(nonMemberAdmin.jwt, wsId, {
                kind: "clear_retired_seat_asks",
                principal_id: expBot.principalId,
              }),
              `clear finishes while local T_post(${pos}) held open`,
              5_000,
            );
            assert.equal(clearExp.status, 200, respDiag(`clearExp(${pos})`, clearExp));
            assert.deepEqual(normalizeReceipt(clearExp.body, expBot.principalId), baselineReceipt);
            assert.deepEqual(await readClearAudit(expBot.principalId, since), baselineAudit);

            if (pos === "pre-fence-rollback") {
              // Resume before final credential fence -> sees expired token -> rolls back!
              const stillLive = await runInHolder(async (tx) => {
                const [row] = await tx<{ ok: boolean }[]>`
                  SELECT EXISTS (
                    SELECT 1 FROM swarm.agent_tokens
                    WHERE principal_id = ${expBot.principalId}::uuid AND revoked_at IS NULL AND expires_at > clock_timestamp()
                  ) AS ok
                `;
                return row!.ok;
              });
              assert.equal(stillLive, false, "final credential fence detects clock expiry");
              await rollbackHolder();
            } else {
              // Held after fence before COMMIT: inserts with captured epoch=1 and commits -> deterministically covered!
              await runInHolder(async (tx) => {
                await tx`SET LOCAL ROLE swarm_command`;
                await tx`
                  INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
                  VALUES (${delayedLocalAskId}::uuid, ${wsId}::uuid, ${expBot.principalId}::uuid, 'agent', ${privUser.id}::uuid, 'ask', 'Delayed local ask?', '9999-12-31T23:59:59Z', ${capturedEpoch}::bigint)
                `;
                await tx`RESET ROLE`;
              });
              await commitHolder();
            }
          },
        );
        if (pos === "post-fence-commit") {
          const [w] = await sql<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsId}::uuid, ${delayedLocalAskId}::uuid) AS w`;
          assert.equal(w!.w, true, "delayed local ask with explicit captured epoch is covered by cutoff_epoch");
          assert.equal(
            (((await readWaitingViewsAs(wsId, privUser.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === delayedLocalAskId),
            false,
          );
        }
      }

      // 4d-hosted: held hosted target-seat P across connection_expires_at expiry (both positions)
      for (const pos of ["pre-fence-rollback", "post-fence-commit"] as const) {
        const expHosted = await seedHostedSeat({
          wsId,
          ownerId: privUser.id,
          name: `ExpHosted-${pos}`,
          connectionExpiresInterval: "1 second",
        });
        const delayedHostedAskId = randomUUID();
        let capturedEpoch = 0;

        await withHeldTransaction(
          `hosted-expiry-${pos}`,
          async (tx) => {
            // Exact hosted seat send locks: Step 9 streams FOR UPDATE + Step 10 hosted_mcp_grants FOR UPDATE + atomic epoch capture.
            await tx`SELECT 1 FROM swarm.streams WHERE workspace_id = ${wsId}::uuid AND kind = 'workspace' FOR UPDATE`;
            await tx`SELECT 1 FROM swarm.hosted_mcp_grants WHERE grant_id = ${expHosted.grantId}::uuid FOR UPDATE`;
            const [ep] = await tx<{ e: string }[]>`SELECT swarm.seat_ask_lifecycle_epoch(${wsId}::uuid, ${expHosted.principalId}::uuid)::text AS e`;
            capturedEpoch = Number(ep!.e);
            assert.equal(capturedEpoch, 1);
          },
          async ({ runInHolder, commitHolder, rollbackHolder }) => {
            await delay(1_250);
            const since = await maxAuditId();
            const clearExpH = await raceWithTimeout(
              sendCommand(nonMemberAdmin.jwt, wsId, {
                kind: "clear_retired_seat_asks",
                principal_id: expHosted.principalId,
              }),
              `clear finishes while hosted T_post(${pos}) held open`,
              5_000,
            );
            assert.equal(clearExpH.status, 200, respDiag(`clearExpH(${pos})`, clearExpH));
            assert.deepEqual(normalizeReceipt(clearExpH.body, expHosted.principalId), baselineReceipt);
            assert.deepEqual(await readClearAudit(expHosted.principalId, since), baselineAudit);

            if (pos === "pre-fence-rollback") {
              const authRows = await runInHolder(async (tx) =>
                tx`SELECT * FROM swarm.resolve_hosted_seat_command_authorization(${expHosted.grantId}::uuid, ${expHosted.handle}, 'ask')`,
              );
              assert.equal(authRows.length, 0, "final hosted credential fence detects clock expiry");
              await rollbackHolder();
            } else {
              await runInHolder(async (tx) => {
                await tx`SET LOCAL ROLE swarm_command`;
                await tx`
                  INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
                  VALUES (${delayedHostedAskId}::uuid, ${wsId}::uuid, ${expHosted.principalId}::uuid, 'agent', ${privUser.id}::uuid, 'ask', 'Delayed hosted ask?', '9999-12-31T23:59:59Z', ${capturedEpoch}::bigint)
                `;
                await tx`RESET ROLE`;
              });
              await commitHolder();
            }
          },
        );
        if (pos === "post-fence-commit") {
          const [w] = await sql<{ w: boolean }[]>`SELECT swarm.ask_is_withdrawn(${wsId}::uuid, ${delayedHostedAskId}::uuid) AS w`;
          assert.equal(w!.w, true, "delayed hosted ask with explicit E=1 is covered by cutoff_epoch=1");
        }
      }

      // (e) Post-reconnect replay while reconnected target seat holds a private post open (local AND hosted)
      step("Suite 4(e): post-reconnect replay while reconnected target seat holds private post open (local & hosted)");
      for (const transport of ["local", "hosted"] as const) {
        let principalId: string;
        let grantIdForLock: string | null = null;
        let deviceIdForLocal: string | null = null;
        if (transport === "local") {
          const bot = await createLocalAgent({ wsId, owner: privUser, name: "ReplayHeldLocal" });
          principalId = bot.principalId;
          deviceIdForLocal = bot.deviceId;
          assert.equal((await sendCommand(privUser.jwt, wsId, { kind: "revoke_agent_token", token_id: bot.tokenId })).status, 200);
        } else {
          const hs = await seedHostedSeat({ wsId, ownerId: privUser.id, name: "ReplayHeldHosted" });
          principalId = hs.principalId;
          await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = clock_timestamp() WHERE seat_id = ${hs.seatId}::uuid`;
        }

        const c1 = randomUUID();
        const initialClear = await sendCommand(
          nonMemberAdmin.jwt,
          wsId,
          { kind: "clear_retired_seat_asks", principal_id: principalId },
          c1,
        );
        assert.equal(initialClear.status, 200, respDiag(`initialClear(${transport})`, initialClear));

        // Reconnect seat P
        if (transport === "local") {
          const remint = await sendCommand(privUser.jwt, wsId, {
            kind: "mint_agent_token",
            principal_id: principalId,
            run_id: randomUUID(),
            task_id: randomUUID(),
            epoch: 2,
            device_id: deviceIdForLocal!,
            scopes: ["post_signal"],
          });
          assert.equal(remint.status, 200, respDiag("remint local replay", remint));
        } else {
          const hs2 = await seedHostedSeat({
            wsId,
            ownerId: privUser.id,
            name: "ReplayHeldHosted",
            existingPrincipalId: principalId,
          });
          grantIdForLock = hs2.grantId;
          await sql`SELECT swarm.advance_seat_lifecycle_epoch(${principalId}::uuid, ${wsId}::uuid)`;
        }

        const newGenAskId = randomUUID();
        await withHeldTransaction(
          `reconnected-post-${transport}`,
          async (tx) => {
            await tx`SELECT 1 FROM swarm.streams WHERE workspace_id = ${wsId}::uuid AND kind = 'workspace' FOR UPDATE`;
            if (transport === "local") {
              await tx`SELECT 1 FROM swarm.agent_workspace_memberships WHERE workspace_id = ${wsId}::uuid AND principal_id = ${principalId}::uuid FOR SHARE`;
              await tx`SELECT 1 FROM swarm.agent_tokens WHERE principal_id = ${principalId}::uuid FOR UPDATE`;
            } else {
              await tx`SELECT 1 FROM swarm.hosted_mcp_grants WHERE grant_id = ${grantIdForLock!}::uuid FOR UPDATE`;
            }
            // Also hold agent_ask_lifecycle FOR NO KEY UPDATE to prove replay takes ZERO lock on agent_ask_lifecycle!
            const [ep] = await tx<{ e: string }[]>`
              SELECT ask_lifecycle_epoch::text AS e FROM swarm.agent_ask_lifecycle
              WHERE workspace_id = ${wsId}::uuid AND principal_id = ${principalId}::uuid
              FOR NO KEY UPDATE
            `;
            await tx`SET LOCAL ROLE swarm_command`;
            await tx`
              INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, sender_lifecycle_epoch)
              VALUES (${newGenAskId}::uuid, ${wsId}::uuid, ${principalId}::uuid, 'agent', ${privUser.id}::uuid, 'ask', 'New gen ask held during replay?', '9999-12-31T23:59:59Z', ${Number(ep!.e)}::bigint)
            `;
            await tx`RESET ROLE`;
          },
          async ({ commitHolder }) => {
            const replayResp = await raceWithTimeout(
              sendCommand(
                nonMemberAdmin.jwt,
                wsId,
                { kind: "clear_retired_seat_asks", principal_id: principalId },
                c1,
              ),
              `replay(${transport}) returns immediately while reconnected post held open`,
              5_000,
            );
            assert.equal(replayResp.status, 200, respDiag(`replayResp(${transport})`, replayResp));
            assert.equal(replayResp.body.principal_id, principalId);
            assert.equal(replayResp.body.cleared_at, initialClear.body.cleared_at);
            assert.equal(Object.hasOwn(replayResp.body, "cutoff_epoch"), false, "replay strips internal cutoff_epoch");
            await commitHolder();
          },
        );
        assert.equal(
          (((await readWaitingViewsAs(wsId, privUser.id)).dq.asks as Array<Row>) ?? []).some((a) => a.signal_id === newGenAskId),
          true,
          `${transport}: new-generation ask remains open after replay`,
        );
      }

      // (f) Sibling hosted seat Q under the same hosted_mcp_grants row holding a private reply open
      step("Suite 4(f): sibling hosted seat Q holding private reply open on same hosted_mcp_grants row");
      const seatP = await seedHostedSeat({ wsId, ownerId: privUser.id, name: "SiblingP" });
      const seatQ = await seedHostedSeat({
        wsId,
        ownerId: privUser.id,
        name: "SiblingQ",
        existingGrantId: seatP.grantId,
        existingProviderGrantId: seatP.providerGrantId,
      });
      // Disconnect P (revoke seat P) while Q stays live on the exact same grant row G!
      await sql`UPDATE swarm.hosted_mcp_seats SET revoked_at = clock_timestamp() WHERE seat_id = ${seatP.seatId}::uuid`;
      assert.equal(await readConnectionKind(wsId, seatP.principalId), "connection_off");
      assert.equal(await readConnectionKind(wsId, seatQ.principalId), "live");

      const siblingNoteId = randomUUID();
      await withHeldTransaction(
        "sibling-Q-private-reply",
        async (tx) => {
          // Exact locks held by sibling hosted seat Q posting a private reply: streams FOR UPDATE + hosted_mcp_grants FOR UPDATE.
          await tx`SELECT 1 FROM swarm.streams WHERE workspace_id = ${wsId}::uuid AND kind = 'workspace' FOR UPDATE`;
          await tx`SELECT 1 FROM swarm.hosted_mcp_grants WHERE grant_id = ${seatP.grantId}::uuid FOR UPDATE`;
          await tx`
            INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, channel_id, until)
            VALUES (${siblingNoteId}::uuid, ${wsId}::uuid, ${seatQ.principalId}::uuid, 'agent', 'note', 'Sibling Q private reply', ${privChId}::uuid, '9999-12-31T23:59:59Z')
          `;
        },
        async ({ commitHolder }) => {
          const since = await maxAuditId();
          const clearP = await raceWithTimeout(
            sendCommand(nonMemberAdmin.jwt, wsId, {
              kind: "clear_retired_seat_asks",
              principal_id: seatP.principalId,
            }),
            "fresh clear(W, P) finishes immediately while sibling Q holds grant G FOR UPDATE",
            5_000,
          );
          assert.equal(clearP.status, 200, respDiag("clearP while sibling Q held", clearP));
          assert.deepEqual(normalizeReceipt(clearP.body, seatP.principalId), baselineReceipt);
          assert.deepEqual(await readClearAudit(seatP.principalId, since), baselineAudit);
          await commitHolder();
        },
      );
      const [sibCommitted] = await sql<{ id: string }[]>`SELECT id FROM swarm.signals WHERE id = ${siblingNoteId}::uuid`;
      assert.equal(sibCommitted?.id, siblingNoteId, "sibling Q private reply committed cleanly");
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      await cleanupFixtureInFinally("Suite 4", [wsId], [owner.id, nonMemberAdmin.id, privUser.id, otherAddr.id], primaryFailed);
    }
  },
);

// ============================================================================
// Suite 5 (R4 Section 5.6): Privilege, ingress, CORS/Origin, uniform 404 probes
// (zero foreign locks & zero probed-UUID echo), and blind replay negative cases.
// ============================================================================
test(
  "Suite 5: privilege, ingress (local, hosted, seat-admin), CORS origin, uniform 404 probes, and blind replay negative cases",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    step("Suite 5: provision workspaces & users");
    const owner = await createUser("rsa5-owner");
    const adminUser = await createUser("rsa5-admin");
    const nonOwnerMember = await createUser("rsa5-member");
    const stranger = await createUser("rsa5-stranger");

    const wsA = await createServedWorkspace({
      name: "RSA-5-A",
      owner,
      members: [
        { user: adminUser, role: "admin" },
        { user: nonOwnerMember, role: "member" },
      ],
    });
    const wsB = await createServedWorkspace({ name: "RSA-5-B", owner });
    const wsArch = await createServedWorkspace({
      name: "RSA-5-Arch",
      owner,
      members: [{ user: adminUser, role: "admin" }],
    });

    let primaryFailed = false;
    try {
      const targetA = await createLocalAgent({ wsId: wsA, owner, name: "TargetA" });
      assert.equal((await sendCommand(owner.jwt, wsA, { kind: "revoke_agent_token", token_id: targetA.tokenId })).status, 200);

      const targetB = await createLocalAgent({ wsId: wsB, owner, name: "TargetB" });
      assert.equal((await sendCommand(owner.jwt, wsB, { kind: "revoke_agent_token", token_id: targetB.tokenId })).status, 200);

      const callerAgent = await createLocalAgent({ wsId: wsA, owner, name: "CallerAgent" });
      const hostedCaller = await seedHostedSeat({ wsId: wsA, ownerId: owner.id, name: "HostedCaller" });

      // 1. Local agent token -> 403 forbidden
      step("Suite 5.1: local agent, hosted MCP seat, and seat-admin agent rejected 403");
      const localAgentRefused = await sendCommand(callerAgent.token, wsA, {
        kind: "clear_retired_seat_asks",
        principal_id: targetA.principalId,
      });
      assert.equal(localAgentRefused.status, 403, respDiag("localAgentRefused", localAgentRefused));

      // 2. Hosted MCP seat -> 403 forbidden across tools
      const hostedRefusals = runHostedSteps(
        ["ask", "note", "reply", "withdraw"].map((tool) => ({
          grantId: hostedCaller.grantId,
          providerGrantId: hostedCaller.providerGrantId,
          handle: hostedCaller.handle,
          workspaceId: wsA,
          tool,
          command: { kind: "clear_retired_seat_asks", principal_id: targetA.principalId },
        })),
      );
      for (const r of hostedRefusals) {
        assert.equal(r.status, 403, respDiag("hosted clear refusal", r));
      }

      // 3. Seat-admin agent with active role:workspace_admin grant -> 403 forbidden
      const grantResp = await sendCommandRaw(
        owner.jwt,
        null,
        {
          kind: "grant_seat_admin",
          principal_id: callerAgent.principalId,
          level: "workspace",
          scope_names: ["role:workspace_admin"],
          workspace_ids: [wsA],
          organization_id: null,
          expires_at: null,
        },
        {
          stream: { kind: "account" },
          resource: "https://api.commonswarm.com/admin",
          origin: ALLOWED_ORIGIN,
        },
      );
      assert.equal(grantResp.status, 200, respDiag("grant_seat_admin", grantResp));
      const seatAdminRefused = await sendCommand(callerAgent.token, wsA, {
        kind: "clear_retired_seat_asks",
        principal_id: targetA.principalId,
      });
      assert.equal(seatAdminRefused.status, 403, respDiag("seatAdminRefused", seatAdminRefused));

      // 4. Browser CORS / Origin guard
      step("Suite 5.2: CORS origin header check (disallowed vs allowed origin)");
      const preflightBad = await fetch(`${local.API_URL}/functions/v1/command`, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
        headers: { origin: DISALLOWED_ORIGIN },
      });
      assert.equal(preflightBad.headers.get("access-control-allow-origin"), null, "disallowed origin must not get ACAO");
      const preflightGood = await fetch(`${local.API_URL}/functions/v1/command`, {
        method: "OPTIONS",
        signal: AbortSignal.timeout(WAIT_TIMEOUT_MS),
        headers: { origin: ALLOWED_ORIGIN },
      });
      assert.equal(preflightGood.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);

      // 5. Non-member -> 403 forbidden
      step("Suite 5.3: non-member 403 and uniform 404 probes");
      const strangerRefused = await sendCommand(stranger.jwt, wsA, {
        kind: "clear_retired_seat_asks",
        principal_id: targetA.principalId,
      });
      assert.equal(strangerRefused.status, 403, respDiag("strangerRefused", strangerRefused));

      // Seed a join-registrar principal in wsA to test join-registrar probe.
      const registrarPrincipalId = randomUUID();
      const registrarRunId = randomUUID();
      const registrarDevId = randomUUID();
      await sql.begin(async (tx) => {
        await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${registrarDevId}::uuid, ${owner.id}::uuid, 'reg-dev')`;
        await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES (${registrarPrincipalId}::uuid, ${wsA}::uuid, ${owner.id}::uuid, 'JoinRegistrar')`;
        await tx`INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by) VALUES (${wsA}::uuid, ${registrarPrincipalId}::uuid, ${owner.id}::uuid, ${owner.id}::uuid) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${registrarRunId}::uuid, ${registrarPrincipalId}::uuid, ${registrarDevId}::uuid)`;
        await tx`
          INSERT INTO swarm.agent_join_credentials (
            id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
            credential_hash, locator, seat_cap, expires_at, mint_command_id
          ) VALUES (
            ${randomUUID()}::uuid, ${wsA}::uuid, ${owner.id}::uuid, ${registrarPrincipalId}::uuid, ${registrarRunId}::uuid,
            ${createHash("sha256").update(randomBytes(32)).digest()},
            ${randomBytes(16).toString("base64url").slice(0, 22)},
            1, clock_timestamp() + interval '1 hour', ${randomUUID()}
          )
        `;
      });

      const probes: Array<[string, string, string]> = [
        ["non-owner member probing owner's agent", nonOwnerMember.jwt, targetA.principalId],
        ["unknown UUID", owner.jwt, randomUUID()],
        ["cross-workspace agent UUID", owner.jwt, targetB.principalId],
        ["human user UUID", owner.jwt, nonOwnerMember.id],
        ["join-registrar UUID", owner.jwt, registrarPrincipalId],
      ];
      for (const [label, bearer, probedId] of probes) {
        const [beforeRow] = await sql<{ m: string }[]>`
          SELECT COALESCE(max(audit_id), 0)::text AS m FROM swarm.audit_log WHERE workspace_id = ${wsA}::uuid
        `;
        const resp = await sendCommand(bearer, wsA, {
          kind: "clear_retired_seat_asks",
          principal_id: probedId,
        });
        assert.equal(resp.status, 404, respDiag(label, resp));
        assert.deepEqual(resp.body, RETIRED_SEAT_NOT_FOUND_BODY, label);
        // Probed UUID must not be echoed in audit_log detail
        const [auditRow] = await sql<{ detail: string | null }[]>`
          SELECT detail FROM swarm.audit_log
          WHERE workspace_id = ${wsA}::uuid AND command_kind = 'clear_retired_seat_asks' AND audit_id > ${Number(beforeRow!.m)}::bigint
          ORDER BY audit_id DESC LIMIT 1
        `;
        assert.equal(
          (auditRow?.detail ?? "").includes(probedId),
          false,
          `${label}: refused audit_log detail must not echo probed UUID`,
        );
      }

      // Prove non-owner member probe acquires ZERO lock on foreign target owner's users row or agent_ask_lifecycle!
      await withHeldTransaction(
        "foreign-target-lock-probe",
        async (tx) => {
          await tx`SELECT 1 FROM swarm.users WHERE user_id = ${owner.id}::uuid FOR UPDATE`;
          await tx`SELECT 1 FROM swarm.agent_ask_lifecycle WHERE workspace_id = ${wsA}::uuid AND principal_id = ${targetA.principalId}::uuid FOR UPDATE`;
        },
        async () => {
          const probeWhileLocked = await raceWithTimeout(
            sendCommand(nonOwnerMember.jwt, wsA, {
              kind: "clear_retired_seat_asks",
              principal_id: targetA.principalId,
            }),
            "non-owner probe returns 404 without waiting on foreign target locks",
            5_000,
          );
          assert.equal(probeWhileLocked.status, 404);
          assert.deepEqual(probeWhileLocked.body, RETIRED_SEAT_NOT_FOUND_BODY);
        },
      );

      // 6. Blind idempotency replay negative cases (409 conflict, 404 demotion, 403 membership loss, 403 archived)
      step("Suite 5.4: blind idempotency replay negative cases");
      const replayCmdId = randomUUID();
      const firstClear = await sendCommand(
        adminUser.jwt,
        wsA,
        { kind: "clear_retired_seat_asks", principal_id: targetA.principalId },
        replayCmdId,
      );
      assert.equal(firstClear.status, 200, respDiag("firstClear", firstClear));

      // Payload conflict (same command_id, different principal_id) -> 409 command_id_conflict
      const conflictReplay = await sendCommand(
        adminUser.jwt,
        wsA,
        { kind: "clear_retired_seat_asks", principal_id: randomUUID() },
        replayCmdId,
      );
      assert.equal(conflictReplay.status, 409, respDiag("conflictReplay", conflictReplay));
      assert.equal(conflictReplay.body.error, "command_id_conflict");

      // Demote adminUser to non-owner member -> exact replay returns 404 not_found!
      assert.equal(
        (await sendCommand(owner.jwt, wsA, { kind: "change_role", user_id: adminUser.id, role: "member" })).status,
        200,
      );
      const demotedReplay = await sendCommand(
        adminUser.jwt,
        wsA,
        { kind: "clear_retired_seat_asks", principal_id: targetA.principalId },
        replayCmdId,
      );
      assert.equal(demotedReplay.status, 404, respDiag("demotedReplay", demotedReplay));
      assert.deepEqual(demotedReplay.body, RETIRED_SEAT_NOT_FOUND_BODY);

      // Remove adminUser from wsA -> exact replay returns 403 forbidden!
      assert.equal(
        (await sendCommand(owner.jwt, wsA, { kind: "remove_member", user_id: adminUser.id })).status,
        200,
      );
      const removedReplay = await sendCommand(
        adminUser.jwt,
        wsA,
        { kind: "clear_retired_seat_asks", principal_id: targetA.principalId },
        replayCmdId,
      );
      assert.equal(removedReplay.status, 403, respDiag("removedReplay", removedReplay));

      // Archive workspace -> exact replay returns 403 forbidden!
      const archTarget = await createLocalAgent({ wsId: wsArch, owner, name: "ArchReplayTarget" });
      assert.equal((await sendCommand(owner.jwt, wsArch, { kind: "revoke_agent_token", token_id: archTarget.tokenId })).status, 200);
      const archCmdId = randomUUID();
      const clearBeforeArch = await sendCommand(
        adminUser.jwt,
        wsArch,
        { kind: "clear_retired_seat_asks", principal_id: archTarget.principalId },
        archCmdId,
      );
      assert.equal(clearBeforeArch.status, 200, respDiag("clearBeforeArch", clearBeforeArch));
      assert.equal((await sendCommand(owner.jwt, wsArch, { kind: "archive_workspace" })).status, 200);
      const archivedReplay = await sendCommand(
        adminUser.jwt,
        wsArch,
        { kind: "clear_retired_seat_asks", principal_id: archTarget.principalId },
        archCmdId,
      );
      assert.equal(archivedReplay.status, 403, respDiag("archivedReplay", archivedReplay));
    } catch (err) {
      primaryFailed = true;
      throw err;
    } finally {
      await cleanupFixtureInFinally("Suite 5", [wsA, wsB, wsArch], [owner.id, adminUser.id, nonOwnerMember.id, stranger.id], primaryFailed);
    }
  },
);
