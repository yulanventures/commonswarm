/**
 * Server witness for 20261124000001_waiting_dismissals.sql and the served command edge (CI / local Postgres):
 *   1. Catalog check, rollback, rollback-catalog check, re-apply, and functional proof, plus
 *      exact read-function parity (all 5 read functions return identical results before and after
 *      for a fixture with no dismissals).
 *   2. Per-person dismissal & restore isolation for ask, todo, and review, real-outcome precedence,
 *      and direct table denial.
 *   3. C1 authorization:
 *      - Household reader targeting another person's to-do gets 404 and creates no row.
 *      - Former offer decider gets 404 and creates no row (no TodoOffered history fallback).
 *      - Shared-household to-do with private origin can be dismissed/restored and stays redacted.
 *      - Unknown UUID and out-of-scope UUID return indistinguishable 404 status and body.
 *      - Access removed while the dismissal row is locked by another transaction (FOR UPDATE)
 *        rolls back the write, returns 404, and leaves no active dismissal row.
 *   4. C2 receipts, replay, audit privacy, and early agent gate (served command edge):
 *      - Directed ask after private-channel removal and after leaving a DM gets 404 on dismiss,
 *        restore, and exact replay.
 *      - Live same-person exact retry returns its original receipt (both dismiss and restore).
 *      - Authenticated owner and admin outside a private channel see nothing of another person's
 *        dismissal (fresh, replayed, conflicting, or refused) in swarm_read.audit_log.
 *      - Local agent token is refused 403 by the early HUMAN_ONLY_COMMANDS gate before the
 *        dismissal branch or its audit.
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
import * as todos from "../../src/protocol/household-todos.js";
import * as todoPolicy from "../../src/protocol/household-todo-policy.js";
import * as objectPolicy from "../../src/protocol/household-object-policy.js";
import * as objects from "../../src/protocol/household-objects.js";
import * as transfers from "../../supabase/functions/command/household-transfers.js";
import { createHouseholdObjectStore, type HouseholdIdentity } from "../../supabase/functions/command/household-objects.js";
import { createHouseholdTodoStore, type HouseholdTodoNoticePort } from "../../supabase/functions/command/household-todos.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Row = Record<string, unknown>;

const proofRoot = "deploy/release-proofs/waiting-dismissals/20261124000001";
const catalogAssert = (rollback = false) =>
  dbAssert(
    releaseCatalogQuery(
      repoSql(`${proofRoot}-${rollback ? "rollback-catalog" : "catalog"}.sql`),
      rollback ? "rollback_ok" : "catalog_ok",
    )
      .trim()
      .replace(/;$/, ""),
    rollback ? "waiting dismissals rollback catalog" : "waiting dismissals catalog",
  );

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;

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

const todoCore = { ...todos, ...todoPolicy, ...objectPolicy };
const noStorage = {
  putImmutable: async () => { throw new Error("Unexpected Storage I/O"); },
  read: async () => { throw new Error("Unexpected Storage I/O"); },
};
// Do not inject unrelated ask signals into swarm.signals when seeding household to-do offers:
// tests explicitly seed the asks whose decision_queue / home_overview counts they assert.
const noNotice: HouseholdTodoNoticePort = async (_tx, _workspace, _identity, intent) => ({
  to: intent.to,
  status: "not_sent",
  reason: "signal_rate_limited",
});

function makeTodoStore() {
  const access = createHouseholdObjectStore({
    core: { ...objects, ...objectPolicy },
    transfers,
    storage: noStorage,
    fileContentAllowed: () => false,
    recheckCredential: async () => true,
  }).access;
  return createHouseholdTodoStore({ core: todoCore, access, notice: noNotice });
}

function committedTodo(result: { outcome: todos.TodoOutcome }): todos.Todo {
  assert.equal(result.outcome.status, "committed", `expected committed todo outcome, got ${JSON.stringify(result.outcome)}`);
  if (result.outcome.status !== "committed" || !("todo_id" in result.outcome.value)) {
    throw new Error(`Expected committed todo outcome, got ${JSON.stringify(result.outcome)}`);
  }
  return result.outcome.value;
}

function respDiag(label: string, resp: { status: number; body: Row }): string {
  return `${label}: status=${resp.status} body=${JSON.stringify(resp.body)}`;
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
    signal: AbortSignal.timeout(15_000),
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

async function readAllFiveAs(conn: postgres.Sql | postgres.TransactionSql, wsId: string, userId: string) {
  const exec = async (q: postgres.TransactionSql) => {
    await q`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: userId })}, true)`;
    await q`SET LOCAL ROLE authenticated`;
    const [dq] = await q<{ r: Row }[]>`SELECT swarm_read.decision_queue(${wsId}::uuid) AS r`;
    const [dqp] = await q<{ r: Row }[]>`SELECT swarm_read.decision_queue_page(${wsId}::uuid, NULL, NULL) AS r`;
    const [wt] = await q<{ r: Row }[]>`SELECT swarm_read.waiting_todos_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [wa] = await q<{ r: Row }[]>`SELECT swarm_read.waiting_archived_page(${wsId}::uuid, 50, NULL, NULL) AS r`;
    const [ho] = await q<{ r: { workspaces: Array<{ workspace_id: string } & Row> } }[]>`SELECT swarm_read.home_overview() AS r`;
    const wsOverview = ho!.r.workspaces.find((w) => w.workspace_id === wsId) ?? null;
    return {
      dq: dq!.r,
      dqp: dqp!.r,
      wt: wt!.r,
      wa: wa!.r,
      wsOverview,
    };
  };
  if ("begin" in conn && typeof conn.begin === "function") {
    return conn.begin(async (tx) => exec(tx));
  }
  const tx = conn as postgres.TransactionSql;
  await tx`SAVEPOINT sp_read_five`;
  const res = await exec(tx);
  await tx`ROLLBACK TO SAVEPOINT sp_read_five`;
  return res;
}

async function cleanupWorkspaceFixture(
  wsId: string,
  userIds: string[],
  deleteAuthViaAdmin: boolean,
): Promise<void> {
  await sql.begin(async (txClean) => {
    await txClean`SET LOCAL session_replication_role = replica`;
    await txClean`DELETE FROM swarm.waiting_dismissals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.audit_log WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.idempotency_keys WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_todo_receipts WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_todo_events WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_comments WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_todos WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_todo_streams WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_member_content_roles WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id = ${wsId}::uuid`;
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
    await txClean`DELETE FROM swarm.agent_workspace_memberships WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.agent_principals WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.devices WHERE user_id = ANY(${userIds}::uuid[])`;
    await txClean`DELETE FROM swarm.memberships WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.streams WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.workspaces WHERE workspace_id = ${wsId}::uuid`;
    await txClean`DELETE FROM swarm.users WHERE user_id = ANY(${userIds}::uuid[])`;
    if (!deleteAuthViaAdmin) {
      await txClean`DELETE FROM auth.users WHERE id = ANY(${userIds}::uuid[])`;
    }
    await txClean`SET LOCAL session_replication_role = origin`;
  });
  if (deleteAuthViaAdmin) {
    for (const userId of userIds) {
      await admin.auth.admin.deleteUser(userId);
    }
  }
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-waiting-dismissals-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 8 });
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
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-30_000);
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
});

after(async () => {
  if (functionProcess?.pid) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* exited */ }
  }
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  if (sql) await sql.end();
});

test("20261124000001 rolls back cleanly, re-applies with proofs, and read functions return identical results before and after with no dismissals", () => {
  // Run the entire rollback, rollback-catalog, re-apply, catalog/functional proof, and
  // zero-dismissal 5-read-function parity check inside ONE runSql transaction so state
  // carries across rollback -> re-apply and the "before" snapshot actually runs against
  // the pre-migration function definitions.
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const wsId = randomUUID();
  const scoutId = randomUUID();
  const privChId = randomUUID();
  const generalAskId = randomUUID();
  const privAskId = randomUUID();
  const dmAskId = randomUUID();
  const answeredAskId = randomUUID();
  const assignedTodoId = randomUUID();
  const doneTodoId = randomUUID();
  const reviewTodoId = randomUUID();
  const reviewOfferId = randomUUID();
  const privateOriginBobTodoId = randomUUID();

  const snapshotFive = (label: string, userId: string) => `
    DO $snap$
    DECLARE
      v_dq jsonb;
      v_dqp jsonb;
      v_wt jsonb;
      v_wa jsonb;
      v_ho jsonb;
    BEGIN
      PERFORM pg_catalog.set_config('request.jwt.claims', '${JSON.stringify({ role: "authenticated", sub: userId })}', true);
      SET LOCAL ROLE authenticated;
      v_dq := swarm_read.decision_queue('${wsId}'::uuid) - 'generated_at';
      v_dqp := swarm_read.decision_queue_page('${wsId}'::uuid, NULL, NULL) - 'generated_at';
      v_wt := pg_catalog.jsonb_set(
        swarm_read.waiting_todos_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at',
        '{todos}',
        coalesce((
          SELECT pg_catalog.jsonb_agg(elem - 'offer_id' ORDER BY ord)
          FROM pg_catalog.jsonb_array_elements(
            (swarm_read.waiting_todos_page('${wsId}'::uuid, 50, NULL, NULL))->'todos'
          ) WITH ORDINALITY AS t(elem, ord)
        ), '[]'::jsonb)
      );
      v_wa := swarm_read.waiting_archived_page('${wsId}'::uuid, 50, NULL, NULL) - 'generated_at';
      SELECT elem INTO v_ho
      FROM pg_catalog.jsonb_array_elements((swarm_read.home_overview())->'workspaces') AS elem
      WHERE elem->>'workspace_id' = '${wsId}';
      RESET ROLE;
      PERFORM pg_catalog.set_config('request.jwt.claims', '', true);
      INSERT INTO pg_temp.read_snapshots(label, dq, dqp, wt, wa, ho)
      VALUES ('${label}', v_dq, v_dqp, v_wt, v_wa, v_ho);
    END $snap$;
  `;

  const fixtureSql = `
    INSERT INTO auth.users (id, email)
    VALUES
      ('${aliceId}'::uuid, 'wd-par-a-${aliceId}@example.test'),
      ('${bobId}'::uuid, 'wd-par-b-${bobId}@example.test');
    INSERT INTO swarm.users (user_id, display_name)
    VALUES ('${aliceId}'::uuid, 'ParityAlice'), ('${bobId}'::uuid, 'ParityBob');
    INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES ('${wsId}'::uuid, 'ParityWS', '${aliceId}'::uuid);
    INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES
      ('${wsId}'::uuid, '${aliceId}'::uuid, 'owner'),
      ('${wsId}'::uuid, '${bobId}'::uuid, 'member');
    INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
    VALUES ('${scoutId}'::uuid, '${wsId}'::uuid, '${aliceId}'::uuid, 'ParityScout');
    INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
    VALUES ('${wsId}'::uuid, '${scoutId}'::uuid, '${aliceId}'::uuid, '${aliceId}'::uuid)
    ON CONFLICT (principal_id, workspace_id) DO NOTHING;
    INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
    VALUES ('${wsId}'::uuid, 'shared');
    INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
    VALUES
      ('${wsId}'::uuid, '${aliceId}'::uuid, 'editor', '${randomUUID()}'::uuid, pg_catalog.statement_timestamp()),
      ('${wsId}'::uuid, '${bobId}'::uuid, 'editor', '${randomUUID()}'::uuid, pg_catalog.statement_timestamp());
    INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'parity-secret', 'private', '${aliceId}'::uuid, 'user');
    INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
    VALUES ('${privChId}'::uuid, '${wsId}'::uuid, 'user', '${aliceId}'::uuid, '${aliceId}'::uuid, 'user');
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
    VALUES
      ('${generalAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity general ask?', NULL, '9999-12-31T23:59:59Z'),
      ('${privAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity private ask?', '${privChId}'::uuid, '9999-12-31T23:59:59Z'),
      ('${dmAskId}'::uuid, '${wsId}'::uuid, '${bobId}'::uuid, 'user', '${aliceId}'::uuid, 'ask', 'Parity DM ask?', NULL, '9999-12-31T23:59:59Z'),
      ('${answeredAskId}'::uuid, '${wsId}'::uuid, '${scoutId}'::uuid, 'agent', '${aliceId}'::uuid, 'ask', 'Parity answered ask?', NULL, '9999-12-31T23:59:59Z');
    INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until)
    VALUES ('${randomUUID()}'::uuid, '${wsId}'::uuid, '${aliceId}'::uuid, 'user', '${answeredAskId}'::uuid, 'note', 'Answered!', '9999-12-31T23:59:59Z');
    SET CONSTRAINTS ALL IMMEDIATE;
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES
      ('${wsId}'::uuid, '${assignedTodoId}'::uuid, 1, 'Parity assigned todo', '', 'open',
       '${aliceId}'::uuid, pg_catalog.statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, pg_catalog.statement_timestamp(),
       'none', '${aliceId}'::uuid, pg_catalog.statement_timestamp(), 0, 1),
      ('${wsId}'::uuid, '${doneTodoId}'::uuid, 1, 'Parity done todo', '', 'done',
       '${aliceId}'::uuid, pg_catalog.statement_timestamp(), '${aliceId}'::uuid, '${aliceId}'::uuid, pg_catalog.statement_timestamp(),
       'none', '${aliceId}'::uuid, pg_catalog.statement_timestamp(), 0, 2);
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, offer_id, offer_principal, offer_decider,
      offer_start, offer_gate, offer_by_user, offered_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq
    ) VALUES (
      '${wsId}'::uuid, '${reviewTodoId}'::uuid, 1, 'Parity review todo', '', 'open',
      '${bobId}'::uuid, pg_catalog.statement_timestamp(), '${reviewOfferId}'::uuid, '${scoutId}'::uuid, '${aliceId}'::uuid,
      'queue', '{"kind":"none"}'::jsonb, '${bobId}'::uuid, pg_catalog.statement_timestamp(),
      'none', '${bobId}'::uuid, pg_catalog.statement_timestamp(), 0, 3
    );
    INSERT INTO swarm.household_todos (
      workspace_id, todo_id, version, title, notes, state,
      created_by_user, created_at, assignee_user, assigned_by_user, assigned_at,
      gate_kind, state_by_user, state_at, comment_count, last_seq,
      origin_placement, origin_channel_id
    ) VALUES (
      '${wsId}'::uuid, '${privateOriginBobTodoId}'::uuid, 1, 'Parity private-origin bob todo', '', 'open',
      '${aliceId}'::uuid, pg_catalog.statement_timestamp(), '${bobId}'::uuid, '${bobId}'::uuid, pg_catalog.statement_timestamp(),
      'none', '${bobId}'::uuid, pg_catalog.statement_timestamp(), 0, 4,
      'channel', '${privChId}'::uuid
    );
    CREATE TEMP TABLE pg_temp.read_snapshots (
      label text PRIMARY KEY,
      dq jsonb NOT NULL,
      dqp jsonb NOT NULL,
      wt jsonb NOT NULL,
      wa jsonb NOT NULL,
      ho jsonb NOT NULL
    );
  `;

  runSql(
    sqlPhase(
      "dismissals-rollback-later-migrations",
      repoSql("deploy/release-proofs/todo-approvals/20261125000004-rollback.sql") +
        "\n" +
        repoSql("deploy/release-proofs/ask-withdrawals/20261125000001-rollback.sql") +
        "\n" +
        repoSql("deploy/release-proofs/waiting-autoclear/20261124000002-rollback.sql"),
    ) +
      sqlPhase("dismissals-initial-proofs", catalogAssert(false) + "\n" + repoSql(`${proofRoot}-functional.sql`)) +
      sqlPhase("dismissals-parity-fixture", fixtureSql) +
      sqlPhase(
        "dismissals-snapshot-after",
        snapshotFive("after_alice", aliceId) +
          snapshotFive("after_bob", bobId) +
          dbAssert(
            `SELECT (dq->>'total')::int = 3 AND (dqp->>'total')::int = 3 AND (wt->>'total')::int = 2 AND (wa->>'total')::int = 2
             FROM pg_temp.read_snapshots WHERE label = 'after_alice'`,
            "parity fixture baseline counts for Alice",
          ) +
          dbAssert(
            `SELECT (dq->>'total')::int = 0 AND (dqp->>'total')::int = 0 AND (wt->>'total')::int = 1 AND (wa->>'total')::int = 0
             FROM pg_temp.read_snapshots WHERE label = 'after_bob'`,
            "parity fixture baseline counts for Bob",
          ),
      ) +
      sqlPhase("dismissals-rollback", repoSql(`${proofRoot}-rollback.sql`) + "\n" + catalogAssert(true)) +
      sqlPhase(
        "dismissals-snapshot-before-and-compare",
        snapshotFive("before_alice", aliceId) +
          snapshotFive("before_bob", bobId) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'after_alice' AND b.label = 'before_alice'`,
            "all 5 read functions must match pre-migration results for Alice with no dismissals",
          ) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'after_bob' AND b.label = 'before_bob'`,
            "all 5 read functions must match pre-migration results for Bob with no dismissals",
          ),
      ) +
      sqlPhase(
        "dismissals-reapply",
        repoSql("supabase/migrations/20261124000001_waiting_dismissals.sql") +
          "\n" +
          catalogAssert(false) +
          "\n" +
          repoSql(`${proofRoot}-functional.sql`),
      ) +
      sqlPhase(
        "dismissals-snapshot-reapplied-and-compare",
        snapshotFive("reapplied_alice", aliceId) +
          snapshotFive("reapplied_bob", bobId) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'reapplied_alice' AND b.label = 'before_alice'`,
            "re-applied migration must match pre-migration results for Alice with no dismissals",
          ) +
          dbAssert(
            `SELECT a.dq = b.dq AND a.dqp = b.dqp AND a.wt = b.wt AND a.wa = b.wa AND a.ho = b.ho
             FROM pg_temp.read_snapshots a, pg_temp.read_snapshots b
             WHERE a.label = 'reapplied_bob' AND b.label = 'before_bob'`,
            "re-applied migration must match pre-migration results for Bob with no dismissals",
          ),
      ),
  );
});

const ROLLBACK_WITNESS = Symbol("rollback-waiting-dismissals-witness");

test("per-person isolation, direct table denial, C1 eligibility, private-origin redaction, and real-outcome precedence", async () => {
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const noConsentId = randomUUID();
  const outsiderId = randomUUID();
  const wsId = randomUUID();
  const scoutId = randomUUID();
  const privChannelId = randomUUID();
  const sharedAskId = randomUUID();
  const privAskId = randomUUID();
  const store = makeTodoStore();
  const aliceIdentity: HouseholdIdentity = { user_id: aliceId, principal_id: null, run_id: null, connection: null };
  const bobIdentity: HouseholdIdentity = { user_id: bobId, principal_id: null, run_id: null, connection: null };

  try {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO auth.users (id, email)
        VALUES
          (${aliceId}::uuid, ${`wd-a-${aliceId}@example.test`}),
          (${bobId}::uuid, ${`wd-b-${bobId}@example.test`}),
          (${noConsentId}::uuid, ${`wd-nc-${noConsentId}@example.test`}),
          (${outsiderId}::uuid, ${`wd-out-${outsiderId}@example.test`})
      `;
      await tx`
        INSERT INTO swarm.users (user_id, display_name)
        VALUES
          (${aliceId}::uuid, 'Alice'),
          (${bobId}::uuid, 'Bob'),
          (${noConsentId}::uuid, 'NoConsent'),
          (${outsiderId}::uuid, 'Outsider')
      `;
      await tx`
        INSERT INTO swarm.workspaces (workspace_id, name, created_by)
        VALUES (${wsId}::uuid, 'DismissWS', ${aliceId}::uuid)
      `;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'owner'),
          (${wsId}::uuid, ${bobId}::uuid, 'member'),
          (${wsId}::uuid, ${noConsentId}::uuid, 'member')
      `;
      await tx`
        INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${scoutId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 'Scout')
      `;
      await tx`
        INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
        VALUES (${wsId}::uuid, ${scoutId}::uuid, ${aliceId}::uuid, ${aliceId}::uuid)
        ON CONFLICT (principal_id, workspace_id) DO NOTHING
      `;
      await tx`
        INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose)
        VALUES (${wsId}::uuid, 'shared')
      `;
      await tx`
        INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
        VALUES
          (${wsId}::uuid, ${aliceId}::uuid, 'editor', ${randomUUID()}::uuid, now()),
          (${wsId}::uuid, ${bobId}::uuid, 'editor', ${randomUUID()}::uuid, now())
      `;
      await tx`
        INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
        VALUES (${privChannelId}::uuid, ${wsId}::uuid, 'secret-room', 'private', ${aliceId}::uuid, 'user')
      `;
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES (${privChannelId}::uuid, ${wsId}::uuid, 'user', ${aliceId}::uuid, ${aliceId}::uuid, 'user')
      `;

      // Shared ask addressed to BOTH Alice and Bob in #general
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
        VALUES (${sharedAskId}::uuid, ${wsId}::uuid, ${scoutId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Should we ship Slice 1?', '9999-12-31T23:59:59Z')
      `;
      await tx`
        INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
        VALUES
          (${sharedAskId}::uuid, ${wsId}::uuid, ${aliceId}::uuid, 0),
          (${sharedAskId}::uuid, ${wsId}::uuid, ${bobId}::uuid, 1)
      `;
      // Private-channel ask addressed to Alice (Bob is NOT in #secret-room)
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
        VALUES (${privAskId}::uuid, ${wsId}::uuid, ${scoutId}::uuid, 'agent', ${aliceId}::uuid, 'ask', 'Private question', ${privChannelId}::uuid, '9999-12-31T23:59:59Z')
      `;
      // Settle deferred conversation filing triggers so read models see canonical conversation_signals rows.
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`SET CONSTRAINTS ALL DEFERRED`;

      await tx`SET LOCAL ROLE swarm_command`;
      const aliceTodo = committedTodo(await store.write(tx, wsId, aliceIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Book plumber",
        assign: { to: { kind: "user", id: aliceId } },
      }));
      // Shared-household to-do assigned to Bob with origin in Alice's private channel (Bob cannot access #secret-room).
      // Cross-user todo_create creates a pending offer for Bob; Bob accepts it so it becomes an assigned to-do (reason='assigned').
      const bobPrivateOriginOffer = committedTodo(await store.write(tx, wsId, aliceIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Buy paint",
        assign: { to: { kind: "user", id: bobId } },
        origin_placement: "channel",
        origin_channel_id: privChannelId,
      }));
      assert.ok(
        bobPrivateOriginOffer.offer?.offer_id,
        `cross-user assignment must create a pending offer for Bob, got ${JSON.stringify(bobPrivateOriginOffer)}`,
      );
      const bobPrivateOriginTodo = committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: bobPrivateOriginOffer.todo_id,
        offer_id: bobPrivateOriginOffer.offer.offer_id,
        base_version: bobPrivateOriginOffer.version,
        answer: "accept",
      }));
      assert.equal(
        bobPrivateOriginTodo.assignee?.id,
        bobId,
        `accepted private-origin todo must be assigned to Bob, got ${JSON.stringify(bobPrivateOriginTodo)}`,
      );
      assert.equal(
        bobPrivateOriginTodo.offer,
        null,
        `accepted private-origin todo must have no pending offer, got ${JSON.stringify(bobPrivateOriginTodo)}`,
      );
      // Work-request review for Alice (Bob offers to Scout, owned by Alice).
      const reviewTodo = committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Scout roof inspection",
        assign: { to: { kind: "agent", id: scoutId } },
      }));
      assert.ok(reviewTodo.offer?.offer_id, "review todo should carry an offer_id");
      const reviewOfferId = reviewTodo.offer.offer_id;
      // Second offer that Alice declines -> Alice becomes a FORMER offer decider (TodoOffered remains in history).
      const declinedOfferTodo = committedTodo(await store.write(tx, wsId, bobIdentity, `req-${randomUUID()}`, {
        kind: "todo_create",
        title: "Old declined offer",
        assign: { to: { kind: "agent", id: scoutId } },
      }));
      assert.ok(declinedOfferTodo.offer?.offer_id);
      const formerOfferId = declinedOfferTodo.offer.offer_id;
      committedTodo(await store.write(tx, wsId, aliceIdentity, `req-${randomUUID()}`, {
        kind: "household_todo_answer",
        todo_id: declinedOfferTodo.todo_id,
        offer_id: formerOfferId,
        base_version: declinedOfferTodo.version,
        answer: "decline",
      }));
      await tx`RESET ROLE`;

      // Direct table reads/writes refused for client roles
      for (const role of ["anon", "authenticated", "swarm_read", "swarm_command"]) {
        await tx`SAVEPOINT sp_table_deny`;
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await assert.rejects(() => tx`SELECT * FROM swarm.waiting_dismissals`, /permission denied/);
        await tx`ROLLBACK TO SAVEPOINT sp_table_deny`;
      }

      await tx`SET LOCAL ROLE swarm_command`;

      // C1: Bob (consented household reader/editor) targeting Alice's to-do -> not_found and NO row created.
      const [bobOtherTodo] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.deepEqual(bobOtherTodo!.r, { status: "not_found" }, `bobOtherTodo=${JSON.stringify(bobOtherTodo!.r)}`);

      // C1: Former offer decider (Alice on declined offer) -> not_found and NO row created.
      const [formerDecider] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'review', ${formerOfferId}::uuid) AS r
      `;
      assert.deepEqual(formerDecider!.r, { status: "not_found" }, `formerDecider=${JSON.stringify(formerDecider!.r)}`);

      // C1: Unknown UUID returns the exact same not_found as out-of-scope targets.
      const [unknownTarget] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'todo', ${randomUUID()}::uuid) AS r
      `;
      assert.deepEqual(unknownTarget!.r, bobOtherTodo!.r, `unknownTarget=${JSON.stringify(unknownTarget!.r)} bobOtherTodo=${JSON.stringify(bobOtherTodo!.r)}`);

      // C1: Bob cannot dismiss Alice's private-channel ask -> not_found.
      const [bobPriv] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'ask', ${privAskId}::uuid) AS r
      `;
      assert.deepEqual(bobPriv!.r, { status: "not_found" }, `bobPriv=${JSON.stringify(bobPriv!.r)}`);

      // C1: NoConsent member cannot dismiss a to-do or review -> not_found.
      const [ncTodo] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${noConsentId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.deepEqual(ncTodo!.r, { status: "not_found" }, `ncTodo=${JSON.stringify(ncTodo!.r)}`);
      const [ncReview] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${noConsentId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.deepEqual(ncReview!.r, { status: "not_found" }, `ncReview=${JSON.stringify(ncReview!.r)}`);

      // C1: Outsider (non-member) -> forbidden.
      const [outRes] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${outsiderId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.deepEqual(outRes!.r, { status: "forbidden" }, `outRes=${JSON.stringify(outRes!.r)}`);

      // C1: Restore without an active dismissal row -> not_found.
      const [restoreWithoutRow] = await tx<{ r: Row }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.deepEqual(restoreWithoutRow!.r, { status: "not_found" }, `restoreWithoutRow=${JSON.stringify(restoreWithoutRow!.r)}`);

      await tx`RESET ROLE`;
      const [refusedRows] = await tx<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.waiting_dismissals WHERE workspace_id = ${wsId}::uuid
      `;
      assert.equal(Number(refusedRows!.cnt), 0, `refused dismissals must create zero rows, got cnt=${refusedRows!.cnt}`);

      // C1: Shared-household to-do assigned to Bob with a private origin can be dismissed and stays redacted.
      const bobBeforePrivOrigin = await readAllFiveAs(tx, wsId, bobId);
      const bobTodosBefore = (bobBeforePrivOrigin.wt as { todos: Array<Row> }).todos;
      const privOriginRowBefore = bobTodosBefore.find((t) => t.todo_id === bobPrivateOriginTodo.todo_id);
      assert.ok(privOriginRowBefore, `Bob should see his assigned shared-household todo, got wt=${JSON.stringify(bobBeforePrivOrigin.wt)}`);
      assert.equal(privOriginRowBefore.reason, "assigned", `expected reason=assigned, got row=${JSON.stringify(privOriginRowBefore)}`);
      assert.equal(privOriginRowBefore.placement, "workspace", `row=${JSON.stringify(privOriginRowBefore)}`);
      assert.equal(privOriginRowBefore.channel_id, null, `row=${JSON.stringify(privOriginRowBefore)}`);
      assert.equal(privOriginRowBefore.conversation_id, null, `row=${JSON.stringify(privOriginRowBefore)}`);

      await tx`SET LOCAL ROLE swarm_command`;
      const [bobDismissPrivOrigin] = await tx<{ r: Row }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'todo', ${bobPrivateOriginTodo.todo_id}::uuid) AS r
      `;
      assert.equal(
        bobDismissPrivOrigin!.r.status,
        "ok",
        `bobDismissPrivOrigin=${JSON.stringify(bobDismissPrivOrigin!.r)} rowBefore=${JSON.stringify(privOriginRowBefore)}`,
      );
      assert.equal(Object.hasOwn(bobDismissPrivOrigin!.r, "audit_channel_id"), false, "audit_channel_id must not be returned");
      await tx`RESET ROLE`;

      const bobAfterPrivOrigin = await readAllFiveAs(tx, wsId, bobId);
      assert.equal((bobAfterPrivOrigin.wt as { total: number }).total, 0, `bobAfterPrivOrigin.wt=${JSON.stringify(bobAfterPrivOrigin.wt)}`);
      const bobArchItems = (bobAfterPrivOrigin.wa as { items: Array<Row> }).items;
      const archPrivOrigin = bobArchItems.find((i) => i.item_key === `todo:${bobPrivateOriginTodo.todo_id}`);
      assert.ok(archPrivOrigin, `dismissed private-origin todo appears in Bob's Archived, got wa=${JSON.stringify(bobAfterPrivOrigin.wa)}`);
      assert.equal(archPrivOrigin.outcome_kind, "dismissed", `archPrivOrigin=${JSON.stringify(archPrivOrigin)}`);
      assert.equal(archPrivOrigin.placement, "workspace", `archPrivOrigin=${JSON.stringify(archPrivOrigin)}`);
      assert.equal(archPrivOrigin.channel_id, null, `archPrivOrigin=${JSON.stringify(archPrivOrigin)}`);
      assert.equal(archPrivOrigin.conversation_id, null, `archPrivOrigin=${JSON.stringify(archPrivOrigin)}`);

      await tx`SET LOCAL ROLE swarm_command`;
      const [bobRestorePrivOrigin] = await tx<{ r: Row }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${bobId}::uuid, 'todo', ${bobPrivateOriginTodo.todo_id}::uuid) AS r
      `;
      assert.equal(bobRestorePrivOrigin!.r.status, "ok", `bobRestorePrivOrigin=${JSON.stringify(bobRestorePrivOrigin!.r)}`);
      assert.equal(bobRestorePrivOrigin!.r.restored, true, `bobRestorePrivOrigin=${JSON.stringify(bobRestorePrivOrigin!.r)}`);
      assert.equal(Object.hasOwn(bobRestorePrivOrigin!.r, "audit_channel_id"), false);

      // Alice dismisses sharedAskId, aliceTodo, and reviewOfferId
      const [dAsk1] = await tx<{ r: { status: string; dismissed: boolean; dismissed_at: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.equal(dAsk1!.r.status, "ok", `dAsk1=${JSON.stringify(dAsk1!.r)}`);
      assert.equal(dAsk1!.r.dismissed, true, `dAsk1=${JSON.stringify(dAsk1!.r)}`);

      // Idempotent dismiss keeps original dismissed_at
      const [dAsk2] = await tx<{ r: { status: string; dismissed: boolean; dismissed_at: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'ask', ${sharedAskId}::uuid) AS r
      `;
      assert.equal(dAsk2!.r.status, "ok", `dAsk2=${JSON.stringify(dAsk2!.r)}`);
      assert.equal(dAsk2!.r.dismissed_at, dAsk1!.r.dismissed_at, `dAsk2=${JSON.stringify(dAsk2!.r)} dAsk1=${JSON.stringify(dAsk1!.r)}`);

      const [dTodo] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(dTodo!.r.status, "ok", `dTodo=${JSON.stringify(dTodo!.r)}`);

      const [dReview] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.dismiss_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.equal(dReview!.r.status, "ok", `dReview=${JSON.stringify(dReview!.r)}`);
      await tx`RESET ROLE`;

      const aliceAfterDismiss = await readAllFiveAs(tx, wsId, aliceId);
      assert.equal((aliceAfterDismiss.dq as { total: number }).total, 1, `aliceAfterDismiss.dq=${JSON.stringify(aliceAfterDismiss.dq)}`);
      assert.equal((aliceAfterDismiss.dqp as { total: number }).total, 1, `aliceAfterDismiss.dqp=${JSON.stringify(aliceAfterDismiss.dqp)}`);
      assert.equal((aliceAfterDismiss.wt as { total: number }).total, 0, `aliceAfterDismiss.wt=${JSON.stringify(aliceAfterDismiss.wt)}`);
      assert.equal((aliceAfterDismiss.wa as { total: number }).total, 4, `aliceAfterDismiss.wa=${JSON.stringify(aliceAfterDismiss.wa)}`); // 3 dismissed + 1 declined review

      // Bob still sees sharedAskId untouched!
      const bobAfterAliceDismiss = await readAllFiveAs(tx, wsId, bobId);
      assert.equal((bobAfterAliceDismiss.dq as { total: number }).total, 1, `bobAfterAliceDismiss.dq=${JSON.stringify(bobAfterAliceDismiss.dq)}`);

      // Restore aliceTodo and reviewOfferId; a second fresh SQL restore without an active dismissal row returns not_found.
      await tx`SET LOCAL ROLE swarm_command`;
      const [rTodo1] = await tx<{ r: { status: string; restored: boolean } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(rTodo1!.r.status, "ok", `rTodo1=${JSON.stringify(rTodo1!.r)}`);
      assert.equal(rTodo1!.r.restored, true, `rTodo1=${JSON.stringify(rTodo1!.r)}`);

      const [rTodo2] = await tx<{ r: { status: string } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'todo', ${aliceTodo.todo_id}::uuid) AS r
      `;
      assert.equal(rTodo2!.r.status, "not_found", `rTodo2=${JSON.stringify(rTodo2!.r)}`);

      const [rReview] = await tx<{ r: { status: string; restored: boolean } }[]>`
        SELECT swarm.restore_waiting_item(${wsId}::uuid, ${aliceId}::uuid, 'review', ${reviewOfferId}::uuid) AS r
      `;
      assert.equal(rReview!.r.status, "ok", `rReview=${JSON.stringify(rReview!.r)}`);
      assert.equal(rReview!.r.restored, true, `rReview=${JSON.stringify(rReview!.r)}`);
      await tx`RESET ROLE`;

      // Dismissed-then-answered ask shows ONLY its real outcome in Archived (not 'dismissed')
      await tx`
        INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until)
        VALUES (${randomUUID()}::uuid, ${wsId}::uuid, ${bobId}::uuid, 'user', ${sharedAskId}::uuid, 'note', 'Yes, ship it!', '9999-12-31T23:59:59Z')
      `;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`SET CONSTRAINTS ALL DEFERRED`;
      const aliceAfterRealAnswer = await readAllFiveAs(tx, wsId, aliceId);
      const sharedMatches = (aliceAfterRealAnswer.wa as { items: Array<Row> }).items.filter(
        (i) => i.item_key === `ask:${sharedAskId}`,
      );
      assert.equal(sharedMatches.length, 1, `sharedMatches=${JSON.stringify(sharedMatches)}`);
      assert.equal(sharedMatches[0]!.outcome_kind, "answered", `sharedMatch=${JSON.stringify(sharedMatches[0])}`);
      assert.equal(sharedMatches[0]!.outcome_text, "Yes, ship it!", `sharedMatch=${JSON.stringify(sharedMatches[0])}`);

      throw ROLLBACK_WITNESS;
    });
  } catch (err) {
    if (err !== ROLLBACK_WITNESS) throw err;
  }
});

test("served command edge: C1/C2 replay reauthorization, uniform 404, audit privacy for outside owner/admin, lock-wait revocation, and early agent gate", async () => {
  const outsideOwner = await createUser("wd-owner");
  const outsideAdmin = await createUser("wd-admin");
  const member = await createUser("wd-member");
  const peer = await createUser("wd-peer");
  const wsId = randomUUID();
  const privChId = randomUUID();
  const privAskId = randomUUID();
  const dmAskId = randomUUID();
  const lockRaceAskId = randomUUID();
  const agentPrincipalId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${outsideOwner.id}::uuid, 'OutsideOwner'),
        (${outsideAdmin.id}::uuid, 'OutsideAdmin'),
        (${member.id}::uuid, 'Member'),
        (${peer.id}::uuid, 'Peer')
    `;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'ServedDismissWS', ${outsideOwner.id}::uuid)`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${wsId}::uuid, 'workspace')`;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${wsId}::uuid, ${outsideOwner.id}::uuid, 'owner'),
        (${wsId}::uuid, ${outsideAdmin.id}::uuid, 'admin'),
        (${wsId}::uuid, ${member.id}::uuid, 'member'),
        (${wsId}::uuid, ${peer.id}::uuid, 'member')
    `;
    const deviceId = randomUUID();
    const runId = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${deviceId}::uuid, ${member.id}::uuid, 'wd-agent-test')`;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${agentPrincipalId}::uuid, ${wsId}::uuid, ${member.id}::uuid, 'MemberBot')
    `;
    await tx`
      INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
      VALUES (${wsId}::uuid, ${agentPrincipalId}::uuid, ${member.id}::uuid, ${member.id}::uuid)
      ON CONFLICT (principal_id, workspace_id) DO NOTHING
    `;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${runId}::uuid, ${agentPrincipalId}::uuid, ${deviceId}::uuid)`;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (
        ${randomUUID()}::uuid, ${agentPrincipalId}::uuid, ${runId}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
    // Private channel containing ONLY member and peer (outsideOwner and outsideAdmin are NOT members).
    await tx`
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES (${privChId}::uuid, ${wsId}::uuid, 'member-private', 'private', ${member.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
      VALUES
        (${privChId}::uuid, ${wsId}::uuid, 'user', ${member.id}::uuid, ${member.id}::uuid, 'user'),
        (${privChId}::uuid, ${wsId}::uuid, 'user', ${peer.id}::uuid, ${member.id}::uuid, 'user')
    `;
    // Triggers create the private_channel conversation (id = privChId) and file each signal
    // into its canonical conversation (including creating the DM and its members for dmAskId).
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
      VALUES
        (${privAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'Secret channel question?', ${privChId}::uuid, '9999-12-31T23:59:59Z'),
        (${lockRaceAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'Lock race question?', ${privChId}::uuid, '9999-12-31T23:59:59Z'),
        (${dmAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'DM question?', NULL, '9999-12-31T23:59:59Z')
    `;
  });
  const [dmFiled] = await sql<{ conversation_id: string }[]>`
    SELECT conversation_id FROM swarm.conversation_signals WHERE signal_id = ${dmAskId}::uuid
  `;
  assert.ok(dmFiled?.conversation_id, "dmAskId must be filed into its canonical DM conversation");
  const dmConvId = dmFiled.conversation_id;

  try {
    // 1. Local agent token is refused 403 by the early HUMAN_ONLY_COMMANDS gate before the dismissal branch or its audit.
    const agentBeforeAudit = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
    `;
    const agentDismiss = await sendCommand(agentToken, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: privAskId,
    });
    assert.equal(agentDismiss.status, 403, respDiag("agentDismiss", agentDismiss));
    assert.deepEqual(agentDismiss.body, { error: "forbidden" }, respDiag("agentDismiss", agentDismiss));
    const agentAfterAudit = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
    `;
    assert.equal(
      agentAfterAudit[0]!.cnt,
      agentBeforeAudit[0]!.cnt,
      `early HUMAN_ONLY_COMMANDS gate refuses before dismissal branch audit: before=${agentBeforeAudit[0]!.cnt} after=${agentAfterAudit[0]!.cnt}`,
    );

    // 2. Uniform 404: unknown UUID and out-of-scope private ask return identical status and body.
    const unknownResp = await sendCommand(outsideOwner.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: randomUUID(),
    });
    const outOfScopeResp = await sendCommand(outsideOwner.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: privAskId,
    });
    assert.equal(unknownResp.status, 404, respDiag("unknownResp", unknownResp));
    assert.deepEqual(
      outOfScopeResp,
      unknownResp,
      `unknown and out-of-scope targets must be indistinguishable: ${respDiag("outOfScopeResp", outOfScopeResp)} vs ${respDiag("unknownResp", unknownResp)}`,
    );

    // 3. Private-channel ask: fresh dismiss + live exact replay return original receipt; conflict returns 409.
    const privDismissCmdId = randomUUID();
    const freshPriv = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: privAskId },
      privDismissCmdId,
    );
    assert.equal(freshPriv.status, 200, respDiag("freshPriv", freshPriv));
    assert.equal(freshPriv.body.status, "accepted", respDiag("freshPriv", freshPriv));
    assert.equal(freshPriv.body.dismissed, true, respDiag("freshPriv", freshPriv));
    assert.equal(Object.hasOwn(freshPriv.body, "audit_channel_id"), false, respDiag("freshPriv", freshPriv));

    const liveRetryPriv = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: privAskId },
      privDismissCmdId,
    );
    assert.equal(liveRetryPriv.status, 200, respDiag("liveRetryPriv", liveRetryPriv));
    assert.deepEqual(
      liveRetryPriv.body,
      freshPriv.body,
      `live same-person retry must return original receipt: ${respDiag("liveRetryPriv", liveRetryPriv)} vs ${respDiag("freshPriv", freshPriv)}`,
    );

    // Conflicting command_id reuse on dismiss_waiting_item -> 409 (and still invisible in audit view!).
    const conflictResp = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: dmAskId },
      privDismissCmdId,
    );
    assert.equal(conflictResp.status, 409, respDiag("conflictResp", conflictResp));

    // 4. DM ask: dismiss, restore, live exact retry of restore, then re-dismiss before leaving DM.
    const dmDismiss1 = await sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: dmAskId,
    });
    assert.equal(dmDismiss1.status, 200, respDiag("dmDismiss1", dmDismiss1));

    const dmRestoreCmdId = randomUUID();
    const dmRestore1 = await sendCommand(
      member.jwt,
      wsId,
      { kind: "restore_waiting_item", item_kind: "ask", item_id: dmAskId },
      dmRestoreCmdId,
    );
    assert.equal(dmRestore1.status, 200, respDiag("dmRestore1", dmRestore1));
    assert.equal(dmRestore1.body.restored, true, respDiag("dmRestore1", dmRestore1));

    const dmRestoreLiveRetry = await sendCommand(
      member.jwt,
      wsId,
      { kind: "restore_waiting_item", item_kind: "ask", item_id: dmAskId },
      dmRestoreCmdId,
    );
    assert.equal(dmRestoreLiveRetry.status, 200, respDiag("dmRestoreLiveRetry", dmRestoreLiveRetry));
    assert.deepEqual(
      dmRestoreLiveRetry.body,
      dmRestore1.body,
      `live same-person restore retry returns original receipt: ${respDiag("dmRestoreLiveRetry", dmRestoreLiveRetry)} vs ${respDiag("dmRestore1", dmRestore1)}`,
    );

    const dmDismiss2CmdId = randomUUID();
    const dmDismiss2 = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: dmAskId },
      dmDismiss2CmdId,
    );
    assert.equal(dmDismiss2.status, 200, respDiag("dmDismiss2", dmDismiss2));

    // 5. Lock-wait race: seed a restored dismissal row for lockRaceAskId, lock it FOR UPDATE in tx1,
    //    fire dismiss_waiting_item while locked, remove member from privChId, release lock -> 404 and NO active row!
    const seedLockDismiss = await sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: lockRaceAskId,
    });
    assert.equal(seedLockDismiss.status, 200, respDiag("seedLockDismiss", seedLockDismiss));
    const seedLockRestore = await sendCommand(member.jwt, wsId, {
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: lockRaceAskId,
    });
    assert.equal(seedLockRestore.status, 200, respDiag("seedLockRestore", seedLockRestore));

    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockReady = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const waitToRelease = new Promise<void>((resolve) => { releaseLock = resolve; });

    const lockHolder = sql.begin(async (tx) => {
      const rows = await tx`
        SELECT 1 FROM swarm.waiting_dismissals
        WHERE workspace_id = ${wsId}::uuid
          AND user_id = ${member.id}::uuid
          AND item_kind = 'ask'
          AND item_id = ${lockRaceAskId}::uuid
        FOR UPDATE
      `;
      assert.equal(rows.length, 1, `expected 1 waiting_dismissals row for lockRaceAskId, got ${rows.length}`);
      lockAcquired();
      await waitToRelease;
    });

    await lockReady;
    const waitingDismissPromise = sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: lockRaceAskId,
    });

    // Wait until the dismiss transaction is actually waiting on the dismissal row lock.
    let sawLockWaiter = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const waiters = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt
        FROM pg_stat_activity
        WHERE datname = current_database()
          AND wait_event_type = 'Lock'
          AND state = 'active'
      `;
      if (Number(waiters[0]!.cnt) > 0) {
        sawLockWaiter = true;
        break;
      }
      await delay(50);
    }
    assert.equal(sawLockWaiter, true, "dismiss_waiting_item transaction must reach and wait on the waiting_dismissals row lock");

    // Revoke member's access to the private channel while dismiss is blocked on the row lock!
    await sql`
      DELETE FROM swarm.channel_members
      WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChId}::uuid AND user_id = ${member.id}::uuid
    `;
    releaseLock();
    await lockHolder;

    const lockRaceResp = await waitingDismissPromise;
    assert.deepEqual(
      lockRaceResp,
      unknownResp,
      `access lost during row-lock wait must return uniform 404: ${respDiag("lockRaceResp", lockRaceResp)} vs ${respDiag("unknownResp", unknownResp)}`,
    );

    const [activeLockRow] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.waiting_dismissals
      WHERE workspace_id = ${wsId}::uuid
        AND user_id = ${member.id}::uuid
        AND item_kind = 'ask'
        AND item_id = ${lockRaceAskId}::uuid
        AND restored_at IS NULL
    `;
    assert.equal(Number(activeLockRow!.cnt), 0, `rolled-back dismiss must leave no active dismissal row, got cnt=${activeLockRow!.cnt}`);

    // 6. After private-channel removal: dismiss, restore, and exact replay all return uniform 404.
    const postRemoveReplay = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: privAskId },
      privDismissCmdId,
    );
    const postRemoveDismiss = await sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: privAskId,
    });
    const postRemoveRestore = await sendCommand(member.jwt, wsId, {
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: privAskId,
    });
    assert.deepEqual(postRemoveReplay, unknownResp, `${respDiag("postRemoveReplay", postRemoveReplay)} vs ${respDiag("unknownResp", unknownResp)}`);
    assert.deepEqual(postRemoveDismiss, unknownResp, `${respDiag("postRemoveDismiss", postRemoveDismiss)} vs ${respDiag("unknownResp", unknownResp)}`);
    assert.deepEqual(postRemoveRestore, unknownResp, `${respDiag("postRemoveRestore", postRemoveRestore)} vs ${respDiag("unknownResp", unknownResp)}`);

    // 7. After leaving DM: dismiss, restore, and exact replay all return uniform 404.
    await sql`
      UPDATE swarm.conversation_members
      SET left_at = greatest(clock_timestamp(), joined_at)
      WHERE workspace_id = ${wsId}::uuid AND conversation_id = ${dmConvId}::uuid AND member_user_id = ${member.id}::uuid
    `;
    const postLeaveDmReplay = await sendCommand(
      member.jwt,
      wsId,
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: dmAskId },
      dmDismiss2CmdId,
    );
    const postLeaveDmRestoreReplay = await sendCommand(
      member.jwt,
      wsId,
      { kind: "restore_waiting_item", item_kind: "ask", item_id: dmAskId },
      dmRestoreCmdId,
    );
    const postLeaveDmDismiss = await sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: dmAskId,
    });
    const postLeaveDmRestore = await sendCommand(member.jwt, wsId, {
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: dmAskId,
    });
    assert.deepEqual(postLeaveDmReplay, unknownResp, `${respDiag("postLeaveDmReplay", postLeaveDmReplay)} vs ${respDiag("unknownResp", unknownResp)}`);
    assert.deepEqual(postLeaveDmRestoreReplay, unknownResp, `${respDiag("postLeaveDmRestoreReplay", postLeaveDmRestoreReplay)} vs ${respDiag("unknownResp", unknownResp)}`);
    assert.deepEqual(postLeaveDmDismiss, unknownResp, `${respDiag("postLeaveDmDismiss", postLeaveDmDismiss)} vs ${respDiag("unknownResp", unknownResp)}`);
    assert.deepEqual(postLeaveDmRestore, unknownResp, `${respDiag("postLeaveDmRestore", postLeaveDmRestore)} vs ${respDiag("unknownResp", unknownResp)}`);

    // 8. C2 Audit privacy: server-side swarm.audit_log retained rows, but authenticated outside owner
    //    AND outside admin see ZERO dismissal/restore rows (fresh, replayed, conflicting, or refused)
    //    in swarm_read.audit_log.
    const [rawAuditCount] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid
        AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
    `;
    assert.ok(Number(rawAuditCount!.cnt) >= 4, `server-side audit_log still records internal dismissal audit rows, got cnt=${rawAuditCount!.cnt}`);

    for (const auditor of [outsideOwner, outsideAdmin]) {
      const visible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        return tx<{ command_kind: string; actor_user: string; outcome: string; request_hash: string }[]>`
          SELECT command_kind, actor_user, outcome, request_hash
          FROM swarm_read.audit_log
          WHERE workspace_id = ${wsId}::uuid
            AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
        `;
      });
      assert.equal(visible.length, 0, `auditor ${auditor.id} must see zero waiting dismissal/restore rows in swarm_read.audit_log, got ${JSON.stringify(visible)}`);
    }
  } finally {
    await cleanupWorkspaceFixture(wsId, [outsideOwner.id, outsideAdmin.id, member.id, peer.id], true);
  }
});

test("served command edge: C1 audit-insert wait revocation rolls back dismissal/restore and receipt for private-channel and DM access loss", async () => {
  const outsideOwner = await createUser("wd-audit-owner");
  const outsideAdmin = await createUser("wd-audit-admin");
  const member = await createUser("wd-audit-member");
  const peer = await createUser("wd-audit-peer");
  const wsId = randomUUID();
  const privChDismissId = randomUUID();
  const privChRestoreId = randomUUID();
  const privDismissAskId = randomUUID();
  const dmDismissAskId = randomUUID();
  const privRestoreAskId = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${outsideOwner.id}::uuid, 'AuditOwner'),
        (${outsideAdmin.id}::uuid, 'AuditAdmin'),
        (${member.id}::uuid, 'AuditMember'),
        (${peer.id}::uuid, 'AuditPeer')
    `;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'AuditWaitDismissWS', ${outsideOwner.id}::uuid)`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${wsId}::uuid, 'workspace')`;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${wsId}::uuid, ${outsideOwner.id}::uuid, 'owner'),
        (${wsId}::uuid, ${outsideAdmin.id}::uuid, 'admin'),
        (${wsId}::uuid, ${member.id}::uuid, 'member'),
        (${wsId}::uuid, ${peer.id}::uuid, 'member')
    `;
    await tx`
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES
        (${privChDismissId}::uuid, ${wsId}::uuid, 'audit-priv-dismiss', 'private', ${member.id}::uuid, 'user'),
        (${privChRestoreId}::uuid, ${wsId}::uuid, 'audit-priv-restore', 'private', ${member.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
      VALUES
        (${privChDismissId}::uuid, ${wsId}::uuid, 'user', ${member.id}::uuid, ${member.id}::uuid, 'user'),
        (${privChDismissId}::uuid, ${wsId}::uuid, 'user', ${peer.id}::uuid, ${member.id}::uuid, 'user'),
        (${privChRestoreId}::uuid, ${wsId}::uuid, 'user', ${member.id}::uuid, ${member.id}::uuid, 'user'),
        (${privChRestoreId}::uuid, ${wsId}::uuid, 'user', ${peer.id}::uuid, ${member.id}::uuid, 'user')
    `;
    // Triggers create the private_channel conversations (id = channel_id) and file each signal
    // into its canonical conversation (including creating the DM and its members for dmDismissAskId).
    await tx`
      INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, channel_id, until)
      VALUES
        (${privDismissAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'Audit-wait private dismiss ask?', ${privChDismissId}::uuid, '9999-12-31T23:59:59Z'),
        (${privRestoreAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'Audit-wait private restore ask?', ${privChRestoreId}::uuid, '9999-12-31T23:59:59Z'),
        (${dmDismissAskId}::uuid, ${wsId}::uuid, ${peer.id}::uuid, 'user', ${member.id}::uuid, 'ask', 'Audit-wait DM dismiss ask?', NULL, '9999-12-31T23:59:59Z')
    `;
  });
  const [dmFiled] = await sql<{ conversation_id: string }[]>`
    SELECT conversation_id FROM swarm.conversation_signals WHERE signal_id = ${dmDismissAskId}::uuid
  `;
  assert.ok(dmFiled?.conversation_id, "dmDismissAskId must be filed into its canonical DM conversation");
  const dmConvId = dmFiled.conversation_id;

  const runHeldAtAuditInsert = async (
    command: Row,
    commandId: string,
    revokeAccess: () => Promise<void>,
  ): Promise<{ status: number; body: Row }> => {
    let lockAcquired!: () => void;
    let releaseLock!: () => void;
    const lockReady = new Promise<void>((resolve) => { lockAcquired = resolve; });
    const waitToRelease = new Promise<void>((resolve) => { releaseLock = resolve; });

    // EXCLUSIVE MODE on swarm.audit_log blocks the fresh command's final INSERT INTO swarm.audit_log
    // (which requires ROW EXCLUSIVE) AFTER both the SQL dismissal write AND the idempotency_keys
    // receipt INSERT have already executed in that transaction, without blocking membership revokes.
    const lockHolder = sql.begin(async (tx) => {
      await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
      lockAcquired();
      await waitToRelease;
    });

    await lockReady;
    const pendingResp = sendCommand(member.jwt, wsId, command, commandId);

    let sawAuditWaiter = false;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const waiters = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt
        FROM pg_locks
        WHERE relation = 'swarm.audit_log'::regclass
          AND NOT granted
      `;
      if (Number(waiters[0]!.cnt) > 0) {
        sawAuditWaiter = true;
        break;
      }
      await delay(25);
    }
    assert.equal(sawAuditWaiter, true, "command transaction must reach and wait on the audit_log INSERT");

    await revokeAccess();
    releaseLock();
    await lockHolder;
    return await pendingResp;
  };

  try {
    const unknownResp = await sendCommand(outsideOwner.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: randomUUID(),
    });
    assert.equal(unknownResp.status, 404, respDiag("unknownResp", unknownResp));

    // 1. Private-channel access retired while fresh dismiss waits on audit_log INSERT.
    const privDismissCmdId = randomUUID();
    const privDismissResp = await runHeldAtAuditInsert(
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: privDismissAskId },
      privDismissCmdId,
      async () => {
        await sql`
          DELETE FROM swarm.channel_members
          WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChDismissId}::uuid AND user_id = ${member.id}::uuid
        `;
      },
    );
    assert.deepEqual(
      privDismissResp,
      unknownResp,
      `private-channel loss during audit wait must return uniform 404: ${respDiag("privDismissResp", privDismissResp)} vs ${respDiag("unknownResp", unknownResp)}`,
    );

    const [privActiveRow] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.waiting_dismissals
      WHERE workspace_id = ${wsId}::uuid
        AND user_id = ${member.id}::uuid
        AND item_kind = 'ask'
        AND item_id = ${privDismissAskId}::uuid
        AND restored_at IS NULL
    `;
    assert.equal(Number(privActiveRow!.cnt), 0, `rolled-back private-channel dismiss must leave zero active dismissal rows, got cnt=${privActiveRow!.cnt}`);

    const [privReceipt] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.idempotency_keys
      WHERE workspace_id = ${wsId}::uuid AND command_id = ${privDismissCmdId}
    `;
    assert.equal(Number(privReceipt!.cnt), 0, `rolled-back private-channel dismiss must leave zero accepted receipts, got cnt=${privReceipt!.cnt}`);

    // 2. DM membership retired while fresh dismiss waits on audit_log INSERT.
    const dmDismissCmdId = randomUUID();
    const dmDismissResp = await runHeldAtAuditInsert(
      { kind: "dismiss_waiting_item", item_kind: "ask", item_id: dmDismissAskId },
      dmDismissCmdId,
      async () => {
        await sql`
          UPDATE swarm.conversation_members
          SET left_at = greatest(clock_timestamp(), joined_at)
          WHERE workspace_id = ${wsId}::uuid AND conversation_id = ${dmConvId}::uuid AND member_user_id = ${member.id}::uuid
        `;
      },
    );
    assert.deepEqual(
      dmDismissResp,
      unknownResp,
      `DM loss during audit wait must return uniform 404: ${respDiag("dmDismissResp", dmDismissResp)} vs ${respDiag("unknownResp", unknownResp)}`,
    );

    const [dmActiveRow] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.waiting_dismissals
      WHERE workspace_id = ${wsId}::uuid
        AND user_id = ${member.id}::uuid
        AND item_kind = 'ask'
        AND item_id = ${dmDismissAskId}::uuid
        AND restored_at IS NULL
    `;
    assert.equal(Number(dmActiveRow!.cnt), 0, `rolled-back DM dismiss must leave zero active dismissal rows, got cnt=${dmActiveRow!.cnt}`);

    const [dmReceipt] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.idempotency_keys
      WHERE workspace_id = ${wsId}::uuid AND command_id = ${dmDismissCmdId}
    `;
    assert.equal(Number(dmReceipt!.cnt), 0, `rolled-back DM dismiss must leave zero accepted receipts, got cnt=${dmReceipt!.cnt}`);

    // 3. Private-channel access retired while fresh restore waits on audit_log INSERT.
    const seedDismiss = await sendCommand(member.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: privRestoreAskId,
    });
    assert.equal(seedDismiss.status, 200, respDiag("seedDismiss", seedDismiss));

    const privRestoreCmdId = randomUUID();
    const privRestoreResp = await runHeldAtAuditInsert(
      { kind: "restore_waiting_item", item_kind: "ask", item_id: privRestoreAskId },
      privRestoreCmdId,
      async () => {
        await sql`
          DELETE FROM swarm.channel_members
          WHERE workspace_id = ${wsId}::uuid AND channel_id = ${privChRestoreId}::uuid AND user_id = ${member.id}::uuid
        `;
      },
    );
    assert.deepEqual(
      privRestoreResp,
      unknownResp,
      `private-channel loss during restore audit wait must return uniform 404: ${respDiag("privRestoreResp", privRestoreResp)} vs ${respDiag("unknownResp", unknownResp)}`,
    );

    const [stillDismissedRow] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.waiting_dismissals
      WHERE workspace_id = ${wsId}::uuid
        AND user_id = ${member.id}::uuid
        AND item_kind = 'ask'
        AND item_id = ${privRestoreAskId}::uuid
        AND restored_at IS NULL
    `;
    assert.equal(Number(stillDismissedRow!.cnt), 1, `rolled-back restore must leave the dismissal row unchanged, got cnt=${stillDismissedRow!.cnt}`);

    const [restoreReceipt] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.idempotency_keys
      WHERE workspace_id = ${wsId}::uuid AND command_id = ${privRestoreCmdId}
    `;
    assert.equal(Number(restoreReceipt!.cnt), 0, `rolled-back restore must leave zero accepted receipts, got cnt=${restoreReceipt!.cnt}`);

    // 4. Internal audit has refusal rows (and only the 1 pre-seeded accepted dismiss), while
    //    swarm_read.audit_log exposes ZERO dismissal/restore rows to outside owner or admin.
    const [acceptedAuditCount] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid
        AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
        AND outcome = 'accepted'
    `;
    assert.equal(Number(acceptedAuditCount!.cnt), 1, `rolled-back attempts must not commit accepted audit rows, got cnt=${acceptedAuditCount!.cnt}`);

    const [refusalAuditCount] = await sql<{ cnt: string }[]>`
      SELECT count(*)::text AS cnt
      FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid
        AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
        AND outcome = 'authz'
        AND reason = 'waiting_item_not_found'
    `;
    assert.ok(Number(refusalAuditCount!.cnt) >= 4, `internal audit must record rolled-back refusal rows, got cnt=${refusalAuditCount!.cnt}`);

    for (const auditor of [outsideOwner, outsideAdmin]) {
      const visible = await sql.begin(async (tx) => {
        await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", sub: auditor.id })}, true)`;
        await tx`SET LOCAL ROLE authenticated`;
        return tx<{ command_kind: string }[]>`
          SELECT command_kind
          FROM swarm_read.audit_log
          WHERE workspace_id = ${wsId}::uuid
            AND command_kind IN ('dismiss_waiting_item', 'restore_waiting_item')
        `;
      });
      assert.equal(visible.length, 0, `rolled-back dismissal refusals must remain out of swarm_read.audit_log, got ${JSON.stringify(visible)}`);
    }
  } finally {
    await cleanupWorkspaceFixture(wsId, [outsideOwner.id, outsideAdmin.id, member.id, peer.id], true);
  }
});
