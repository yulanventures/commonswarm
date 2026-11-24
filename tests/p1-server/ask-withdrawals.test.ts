/**
 * Server witness for 20261125000001_ask_withdrawals.sql and the served command + read edges (CI / local Postgres):
 *   1. Forward catalog proof, functional proof, rollback, rollback-catalog proof, re-apply migration,
 *      re-run forward proofs, and direct table denial on swarm.ask_withdrawals for client roles.
 *   2. Served command + read edge end-to-end:
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

function respDiag(label: string, resp: { status: number; body: Row }): string {
  return `${label}: status=${resp.status} body=${JSON.stringify(resp.body)}`;
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

async function sendRead(
  bearer: string,
  payload: Row,
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
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
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-ask-withdrawals-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(
    envFile,
    "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\nSWARM_INTERACTIVE_REPLIES=1\n",
    { mode: 0o600 },
  );
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

test("20261125000001 passes catalog + functional proofs, rolls back cleanly, re-applies, and denies direct table access", () => {
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
});

test("served command + read edge: ask withdrawal, replace, my_open_asks, privacy, and HezSec C1 dismissal instance binding", async () => {
  const owner = await createUser("aw-owner");
  const adminUser = await createUser("aw-admin");
  const addressee1 = await createUser("aw-addr1");
  const addressee2 = await createUser("aw-addr2");
  const stranger = await createUser("aw-stranger");

  const wsId = randomUUID();
  const privChId = randomUUID();
  const agentAId = randomUUID();
  const agentBId = randomUUID();
  const agentAToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const agentBToken = `swm_agt_${randomBytes(32).toString("base64url")}`;

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'AskOwner'),
        (${adminUser.id}::uuid, 'AskAdmin'),
        (${addressee1.id}::uuid, 'AddrOne'),
        (${addressee2.id}::uuid, 'AddrTwo'),
        (${stranger.id}::uuid, 'Stranger')
    `;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'AskWithdrawWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${wsId}::uuid, 'workspace')`;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${wsId}::uuid, ${owner.id}::uuid, 'owner'),
        (${wsId}::uuid, ${adminUser.id}::uuid, 'admin'),
        (${wsId}::uuid, ${addressee1.id}::uuid, 'member'),
        (${wsId}::uuid, ${addressee2.id}::uuid, 'member')
    `;

    const deviceId = randomUUID();
    const runA = randomUUID();
    const runB = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${deviceId}::uuid, ${owner.id}::uuid, 'aw-test-device')`;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES
        (${agentAId}::uuid, ${wsId}::uuid, ${owner.id}::uuid, 'AgentA'),
        (${agentBId}::uuid, ${wsId}::uuid, ${owner.id}::uuid, 'AgentB')
    `;
    await tx`
      INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
      VALUES
        (${wsId}::uuid, ${agentAId}::uuid, ${owner.id}::uuid, ${owner.id}::uuid),
        (${wsId}::uuid, ${agentBId}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)
      ON CONFLICT (principal_id, workspace_id) DO NOTHING
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES
        (${runA}::uuid, ${agentAId}::uuid, ${deviceId}::uuid),
        (${runB}::uuid, ${agentBId}::uuid, ${deviceId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES
        (${randomUUID()}::uuid, ${agentAId}::uuid, ${runA}::uuid, ${tx.json(["post_signal", "read_signals"])}::jsonb, ${createHash("sha256").update(agentAToken).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid),
        (${randomUUID()}::uuid, ${agentBId}::uuid, ${runB}::uuid, ${tx.json(["post_signal", "read_signals"])}::jsonb, ${createHash("sha256").update(agentBToken).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)
    `;

    // Private channel with ONLY AgentA and addressee1 (owner, adminUser, addressee2 are NOT members).
    await tx`
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES (${privChId}::uuid, ${wsId}::uuid, 'aw-secret', 'private', ${addressee1.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
      VALUES (${privChId}::uuid, ${wsId}::uuid, 'user', ${addressee1.id}::uuid, ${addressee1.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, agent_principal_id, added_by_principal, added_by_kind)
      VALUES (${privChId}::uuid, ${wsId}::uuid, 'agent', ${agentAId}::uuid, ${addressee1.id}::uuid, 'user')
    `;
  });

  try {
    // 1. AgentA posts a multi-addressee ask addressed to addressee1 and addressee2.
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

    // Both addressees see the open ask in decision_queue, decision_queue_page, and home_overview.
    for (const [label, user] of [["addr1", addressee1], ["addr2", addressee2]] as const) {
      const views = await readWaitingViewsAs(wsId, user.id);
      assert.equal((views.dq as { total: number }).total, 1, `${label} dq=${JSON.stringify(views.dq)}`);
      assert.equal((views.dqp as { total: number }).total, 1, `${label} dqp=${JSON.stringify(views.dqp)}`);
      assert.equal((views.wsOverview?.needs_you as { asks: unknown[] } | undefined)?.asks.length, 1, `${label} ho=${JSON.stringify(views.wsOverview)}`);
    }

    // 2. Uniform 404 for unknown UUID, another agent of the same owner (AgentB), owner, and admin; stranger gets 403 at workspace gate.
    const unknownWithdraw = await sendCommand(agentAToken, wsId, {
      kind: "withdraw_ask",
      signal_id: randomUUID(),
    });
    assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
    assert.deepEqual(
      unknownWithdraw.body,
      { error: "not_found", message: "No open ask of yours has that id." },
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

    // 3. Addressee1 dismisses multiAskId -> my_open_asks for AgentA is byte-identical (modulo generated_at)
    //    before and after dismissal, and never mentions dismissals.
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

    // AgentB sees ZERO open asks of its own.
    const openForB = await sendRead(agentBToken, { resource: "my_open_asks", workspace_id: wsId });
    assert.equal(openForB.status, 200, respDiag("openForB", openForB));
    assert.deepEqual(openForB.body.asks, [], respDiag("openForB", openForB));

    // 4. Sender (AgentA) withdraws multiAskId -> leaves BOTH addressees' queues/counts; appears ONCE in each Archived as withdrawn.
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

    // 5. Idempotent repeated withdraw (new command_id): returns created=false, same withdrawn_at, one DB row.
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

    // 6. Withdrawn ask cannot be answered (plain reply refused identically to an expired ask and creates no signal),
    //    dismissed (404), restored (404), or re-raised (409 ask_withdrawn).
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

    // 7. Choice ask withdrawn -> answer_choice returns 409 ask_expired (same as expired).
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

    // 8. Answered ask cannot be withdrawn -> uniform 404.
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

    // 9. Replace (supersedes): atomic new ask + withdraw old ask; Archived shows 'replaced'/'Replaced by a newer question'.
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

    // 10. Refused replace (targeting someone else's ask or already-withdrawn ask) returns 404 and creates NOTHING.
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

    // 11. Private-channel ask withdrawal: audit_log carries private channel tag (hidden from outside owner/admin),
    //     and non-member addressee2 never sees it in Archived.
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

    // The private-channel withdrawal's audit row is tagged with its channel in the table, and the
    // audit view (which exposes no channel column) hides exactly those rows from an owner and an admin
    // who are not in the channel.
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

    // Addressee2 (not in privChId) sees nothing of privAskId in Archived.
    const addr2Views = await readWaitingViewsAs(wsId, addressee2.id);
    const leakedPriv = (addr2Views.wa as { items: Array<Row> }).items.find((i) => i.item_key === `ask:${privAskId}`);
    assert.equal(leakedPriv, undefined, `addr2 must not see private ask in Archived: ${JSON.stringify(addr2Views.wa)}`);

    // 12. Human sender can read own open asks via my_open_asks and withdraw own ask.
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

    // 13. HezSec C1 dismissal instance binding on newAskId (for addressee1):
    const d1 = await sendCommand(addressee1.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: newAskId,
    });
    assert.equal(d1.status, 200, respDiag("d1", d1));
    assert.equal(d1.body.created, true, respDiag("d1", d1));
    const firstDismissalId = d1.body.dismissal as string;
    assert.match(firstDismissalId, /^[0-9a-f-]{36}$/, respDiag("d1", d1));

    // Dismiss twice -> created=false, same dismissal UUID and dismissed_at.
    const d2 = await sendCommand(addressee1.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: newAskId,
    });
    assert.equal(d2.status, 200, respDiag("d2", d2));
    assert.equal(d2.body.created, false, respDiag("d2", d2));
    assert.equal(d2.body.dismissal, firstDismissalId, respDiag("d2", d2));
    assert.equal(d2.body.dismissed_at, d1.body.dismissed_at, respDiag("d2", d2));

    // Restore with matching dismissal instance works.
    const r1 = await sendCommand(addressee1.jwt, wsId, {
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: newAskId,
      dismissal: firstDismissalId,
    });
    assert.equal(r1.status, 200, respDiag("r1", r1));
    assert.equal(r1.body.restored, true, respDiag("r1", r1));

    // Re-dismiss creates a NEW dismissal instance UUID.
    const d3 = await sendCommand(addressee1.jwt, wsId, {
      kind: "dismiss_waiting_item",
      item_kind: "ask",
      item_id: newAskId,
    });
    assert.equal(d3.status, 200, respDiag("d3", d3));
    assert.equal(d3.body.created, true, respDiag("d3", d3));
    const secondDismissalId = d3.body.dismissal as string;
    assert.notEqual(secondDismissalId, firstDismissalId, `re-dismiss must issue new instance: d3=${JSON.stringify(d3.body)} d1=${JSON.stringify(d1.body)}`);

    // Restore with STALE first dismissal instance returns uniform 404 and leaves the active dismissal intact.
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

    // Restore WITHOUT dismissal continues to work as before.
    const rUnbound = await sendCommand(addressee1.jwt, wsId, {
      kind: "restore_waiting_item",
      item_kind: "ask",
      item_id: newAskId,
    });
    assert.equal(rUnbound.status, 200, respDiag("rUnbound", rUnbound));
    assert.equal(rUnbound.body.restored, true, respDiag("rUnbound", rUnbound));

    const viewsRestored = await readWaitingViewsAs(wsId, addressee1.id);
    assert.equal((viewsRestored.dq as { total: number }).total, 1, `unbound restore must restore item: ${JSON.stringify(viewsRestored.dq)}`);

    // 14. waiting_todos_page carries offer_id on request rows (matching dismiss_waiting_item('review', ...))
    //     and omits the offer_id key entirely on non-request (assigned) to-do rows.
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
  } finally {
    await cleanupWorkspaceFixture(wsId, [owner.id, adminUser.id, addressee1.id, addressee2.id, stranger.id]);
  }
});

test("served command + read edge: security conditions C1 (group leave), C2 (completion & lock races), C3 (release fence & replay), C4 (direct audit privacy & agent presence)", async () => {
  const outsideOwner = await createUser("awc-owner");
  const outsideAdmin = await createUser("awc-admin");
  const bothChAdmin = await createUser("awc-both-admin");
  const sender = await createUser("awc-sender");
  const peer1 = await createUser("awc-peer1");
  const peer2 = await createUser("awc-peer2");

  const wsId = randomUUID();
  const agentAId = randomUUID();
  const agentAToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const pubChId = randomUUID();
  const privChAudit1 = randomUUID();
  const privChAudit2 = randomUUID();
  const privChAudit3 = randomUUID();
  const privChReplay1 = randomUUID();
  const privChReplay2 = randomUUID();
  const privChReplayDest = randomUUID();
  const privChReplay3 = randomUUID();
  const privChPresence = randomUUID();
  const privChReplaceAudit = randomUUID();

  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${outsideOwner.id}::uuid, 'CondOwner'),
        (${outsideAdmin.id}::uuid, 'CondAdmin'),
        (${bothChAdmin.id}::uuid, 'CondBothAdmin'),
        (${sender.id}::uuid, 'CondSender'),
        (${peer1.id}::uuid, 'CondPeer1'),
        (${peer2.id}::uuid, 'CondPeer2')
    `;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${wsId}::uuid, 'AskWithdrawCondWS', ${outsideOwner.id}::uuid)`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${wsId}::uuid, 'workspace')`;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${wsId}::uuid, ${outsideOwner.id}::uuid, 'owner'),
        (${wsId}::uuid, ${outsideAdmin.id}::uuid, 'admin'),
        (${wsId}::uuid, ${bothChAdmin.id}::uuid, 'admin'),
        (${wsId}::uuid, ${sender.id}::uuid, 'member'),
        (${wsId}::uuid, ${peer1.id}::uuid, 'member'),
        (${wsId}::uuid, ${peer2.id}::uuid, 'member')
    `;

    const deviceId = randomUUID();
    const runA = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${deviceId}::uuid, ${outsideOwner.id}::uuid, 'awc-device')`;
    await tx`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${agentAId}::uuid, ${wsId}::uuid, ${outsideOwner.id}::uuid, 'CondAgentA')
    `;
    await tx`
      INSERT INTO swarm.agent_workspace_memberships (workspace_id, principal_id, owner_user_id, added_by)
      VALUES (${wsId}::uuid, ${agentAId}::uuid, ${outsideOwner.id}::uuid, ${outsideOwner.id}::uuid)
      ON CONFLICT (principal_id, workspace_id) DO NOTHING
    `;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${runA}::uuid, ${agentAId}::uuid, ${deviceId}::uuid)`;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (
        ${randomUUID()}::uuid,
        ${agentAId}::uuid,
        ${runA}::uuid,
        ${tx.json(["post_signal", "read_signals"])}::jsonb,
        ${createHash("sha256").update(agentAToken).digest()},
        statement_timestamp() + interval '1 hour',
        ${randomUUID()}::uuid
      )
    `;

    await tx`
      INSERT INTO swarm.channels (channel_id, workspace_id, slug, visibility, created_by_principal, created_by_kind)
      VALUES
        (${pubChId}::uuid, ${wsId}::uuid, 'c4-pub', 'open', ${outsideOwner.id}::uuid, 'user'),
        (${privChAudit1}::uuid, ${wsId}::uuid, 'c3-audit-1', 'private', ${peer1.id}::uuid, 'user'),
        (${privChAudit2}::uuid, ${wsId}::uuid, 'c3-audit-2', 'private', ${peer1.id}::uuid, 'user'),
        (${privChAudit3}::uuid, ${wsId}::uuid, 'c3-audit-3', 'private', ${peer1.id}::uuid, 'user'),
        (${privChReplay1}::uuid, ${wsId}::uuid, 'c3-replay-1', 'private', ${peer1.id}::uuid, 'user'),
        (${privChReplay2}::uuid, ${wsId}::uuid, 'c3-replay-2', 'private', ${peer1.id}::uuid, 'user'),
        (${privChReplayDest}::uuid, ${wsId}::uuid, 'c3-replay-dest', 'private', ${peer1.id}::uuid, 'user'),
        (${privChReplay3}::uuid, ${wsId}::uuid, 'c3-replay-3', 'private', ${peer1.id}::uuid, 'user'),
        (${privChPresence}::uuid, ${wsId}::uuid, 'c4-priv-pres', 'private', ${peer1.id}::uuid, 'user'),
        (${privChReplaceAudit}::uuid, ${wsId}::uuid, 'c4-priv-rep', 'private', ${peer1.id}::uuid, 'user')
    `;

    for (const chId of [
      privChAudit1, privChAudit2, privChAudit3,
      privChReplay1, privChReplay2, privChReplayDest, privChReplay3,
      privChReplaceAudit,
    ]) {
      await tx`
        INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
        VALUES
          (${chId}::uuid, ${wsId}::uuid, 'user', ${sender.id}::uuid, ${peer1.id}::uuid, 'user'),
          (${chId}::uuid, ${wsId}::uuid, 'user', ${peer1.id}::uuid, ${peer1.id}::uuid, 'user')
      `;
    }
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
      VALUES (${privChReplaceAudit}::uuid, ${wsId}::uuid, 'user', ${bothChAdmin.id}::uuid, ${peer1.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, user_id, added_by_principal, added_by_kind)
      VALUES (${privChPresence}::uuid, ${wsId}::uuid, 'user', ${peer1.id}::uuid, ${peer1.id}::uuid, 'user')
    `;
    await tx`
      INSERT INTO swarm.channel_members (channel_id, workspace_id, member_kind, agent_principal_id, added_by_principal, added_by_kind)
      VALUES (${privChPresence}::uuid, ${wsId}::uuid, 'agent', ${agentAId}::uuid, ${peer1.id}::uuid, 'user')
    `;
  });

  const waitForBlockedOnPid = async (
    blockerPid: number,
    label: string,
    advisoryOnly = false,
  ): Promise<number> => {
    let lastSnapshot: Row[] = [];
    for (let attempt = 0; attempt < 160; attempt += 1) {
      const rows = await sql<{ pid: number; wait_event_type: string | null; wait_event: string | null; blockers: number[] }[]>`
        SELECT pid, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND ${blockerPid}::int = ANY(pg_blocking_pids(pid))
      `;
      lastSnapshot = rows as unknown as Row[];
      const match = rows.find((r) => !advisoryOnly || r.wait_event === "advisory");
      if (match !== undefined) return match.pid;
      await delay(25);
    }
    throw new Error(`${label}: no backend blocked on pid ${blockerPid}; last=${JSON.stringify(lastSnapshot)}`);
  };

  const runHeldAtAuditInsert = async (
    bearer: string,
    command: Row,
    commandId: string,
    revokeAccess: () => Promise<void>,
  ): Promise<{ status: number; body: Row }> => {
    let lockAcquired!: (pid: number) => void;
    let releaseLock!: () => void;
    const lockReady = new Promise<number>((resolve) => { lockAcquired = resolve; });
    const waitToRelease = new Promise<void>((resolve) => { releaseLock = resolve; });

    const lockHolder = sql.begin(async (tx) => {
      const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await tx`LOCK TABLE swarm.audit_log IN EXCLUSIVE MODE`;
      lockAcquired(me!.pid);
      await waitToRelease;
    });

    const blockerPid = await lockReady;
    const pendingResp = sendCommand(bearer, wsId, command, commandId);
    await waitForBlockedOnPid(blockerPid, `audit_log wait for ${String(command.kind)}`);
    await revokeAccess();
    releaseLock();
    await lockHolder;
    return await pendingResp;
  };

  // Service-role helper to move an ask's deadline into the past while preserving
  // swarm.signals's CHECK (until > created_at) and without taking DDL locks that
  // would contend with a blocked in-flight command transaction.
  const expireAskNow = async (signalId: string): Promise<void> => {
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
  };

  try {
    const unknownWithdraw = await sendCommand(sender.jwt, wsId, {
      kind: "withdraw_ask",
      signal_id: randomUUID(),
    });
    assert.equal(unknownWithdraw.status, 404, respDiag("unknownWithdraw", unknownWithdraw));
    assert.deepEqual(
      unknownWithdraw.body,
      { error: "not_found", message: "No open ask of yours has that id." },
      respDiag("unknownWithdraw", unknownWithdraw),
    );

    // =========================================================================
    // C1: Group conversation leave -> sender loses my_open_asks, withdraw_ask,
    //     and replace; unchanged-access control in the same group succeeds.
    // =========================================================================
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

    // Before leaving: sender sees senderGroupAskId in my_open_asks.
    const senderOpenBeforeLeave = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
    assert.equal(senderOpenBeforeLeave.status, 200, respDiag("senderOpenBeforeLeave", senderOpenBeforeLeave));
    assert.ok(
      (senderOpenBeforeLeave.body.asks as Array<Row>).some((a) => a.signal_id === senderGroupAskId),
      `sender must see group ask before leaving: ${respDiag("senderOpenBeforeLeave", senderOpenBeforeLeave)}`,
    );

    // Sender leaves the group conversation.
    const leaveGroup = await sendCommand(sender.jwt, wsId, {
      kind: "conversation_leave",
      conversation_id: groupConvId,
    });
    assert.equal(leaveGroup.status, 200, respDiag("leaveGroup", leaveGroup));

    // After leaving: my_open_asks no longer lists senderGroupAskId.
    const senderOpenAfterLeave = await sendRead(sender.jwt, { resource: "my_open_asks", workspace_id: wsId });
    assert.equal(senderOpenAfterLeave.status, 200, respDiag("senderOpenAfterLeave", senderOpenAfterLeave));
    assert.equal(
      (senderOpenAfterLeave.body.asks as Array<Row>).some((a) => a.signal_id === senderGroupAskId),
      false,
      `former group member must not see group ask in my_open_asks: ${respDiag("senderOpenAfterLeave", senderOpenAfterLeave)}`,
    );

    // After leaving: withdraw_ask and replacing post_signal both get uniform 404 and change nothing.
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

    // Unchanged-access control in the SAME group: peer1 still lists and withdraws peer1GroupAskId.
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

    // =========================================================================
    // C2: Unaddressed completed choice ask, directly-addressed agent reply,
    //     and held-lock serialization races (withdraw vs reraise in both orders,
    //     plus answer_choice-first vs withdraw).
    // =========================================================================
    // C2a: Choice ask addressed to nobody, completed by a click -> not open, cannot withdraw/replace.
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

    // C2b: Ask addressed directly to an agent, which replies -> not open, cannot withdraw/replace.
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

    // C2c: Held-lock race Order 1 — withdraw acquires answer_choice lock first and commits;
    //      concurrent reraise blocks on answer_choice lock, wakes up, gets 409 ask_withdrawn, no reminder.
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

    {
      let lockReadyResolve!: (pid: number) => void;
      let releaseResolve!: () => void;
      const lockReady = new Promise<number>((r) => { lockReadyResolve = r; });
      const waitRelease = new Promise<void>((r) => { releaseResolve = r; });
      const holder = sql.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`withdraw_ask:${wsId}:${raceAsk1}`}, 0))`;
        lockReadyResolve(me!.pid);
        await waitRelease;
      });
      const holderPid = await lockReady;
      const withdrawPending = sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceAsk1 });
      const withdrawPid = await waitForBlockedOnPid(holderPid, "C2 race1 withdraw_ask waiting on withdraw_ask lock", true);
      const reraisePending = sendCommand(sender.jwt, wsId, { kind: "reraise_ask", signal_id: raceAsk1 });
      await waitForBlockedOnPid(withdrawPid, "C2 race1 reraise_ask waiting on answer_choice lock held by withdraw_ask", true);
      releaseResolve();
      await holder;
      const [wdResp, rrResp] = await Promise.all([withdrawPending, reraisePending]);
      assert.equal(wdResp.status, 200, respDiag("C2 race1 wdResp", wdResp));
      assert.equal(wdResp.body.withdrawn, true, respDiag("C2 race1 wdResp", wdResp));
      assert.equal(rrResp.status, 409, respDiag("C2 race1 rrResp", rrResp));
      assert.equal(rrResp.body.error, "ask_withdrawn", respDiag("C2 race1 rrResp", rrResp));

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
    }

    // C2d: Held-lock race Order 2 — reraise acquires answer_choice lock first and commits;
    //      concurrent withdraw blocks on answer_choice lock until reraise commits (serialized strictly after).
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

    {
      let lockReadyResolve!: (pid: number) => void;
      let releaseResolve!: () => void;
      const lockReady = new Promise<number>((r) => { lockReadyResolve = r; });
      const waitRelease = new Promise<void>((r) => { releaseResolve = r; });
      const holder = sql.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`reraise_ask:${wsId}:${raceAsk2}`}, 0))`;
        lockReadyResolve(me!.pid);
        await waitRelease;
      });
      const holderPid = await lockReady;
      const reraisePending = sendCommand(sender.jwt, wsId, { kind: "reraise_ask", signal_id: raceAsk2 });
      const reraisePid = await waitForBlockedOnPid(holderPid, "C2 race2 reraise_ask waiting on reraise_ask lock", true);
      const withdrawPending = sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceAsk2 });
      await waitForBlockedOnPid(reraisePid, "C2 race2 withdraw_ask waiting on answer_choice lock held by reraise_ask", true);
      releaseResolve();
      await holder;
      const [rrResp, wdResp] = await Promise.all([reraisePending, withdrawPending]);
      assert.equal(rrResp.status, 200, respDiag("C2 race2 rrResp", rrResp));
      assert.equal(wdResp.status, 200, respDiag("C2 race2 wdResp", wdResp));
      assert.equal(wdResp.body.withdrawn, true, respDiag("C2 race2 wdResp", wdResp));

      // Verify strict serialization: reminder existed before withdrawal committed, and subsequent reraise is refused.
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
    }

    // C2e: Held-lock race — answer_choice commits first while withdraw blocks on answer_choice lock -> withdraw refused 404.
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

    {
      let lockReadyResolve!: (pid: number) => void;
      let releaseResolve!: () => void;
      const lockReady = new Promise<number>((r) => { lockReadyResolve = r; });
      const waitRelease = new Promise<void>((r) => { releaseResolve = r; });
      const holder = sql.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`LOCK TABLE swarm.ui_actions IN EXCLUSIVE MODE`;
        lockReadyResolve(me!.pid);
        await waitRelease;
      });
      const holderPid = await lockReady;
      const ansPending = sendCommand(peer1.jwt, wsId, {
        kind: "answer_choice",
        signal_id: raceChoiceAskId,
        option_id: "yes",
      });
      const ansPid = await waitForBlockedOnPid(holderPid, "C2 race3 answer_choice waiting on ui_actions");
      const withdrawPending = sendCommand(sender.jwt, wsId, { kind: "withdraw_ask", signal_id: raceChoiceAskId });
      await waitForBlockedOnPid(ansPid, "C2 race3 withdraw_ask waiting on answer_choice lock", true);
      releaseResolve();
      await holder;
      const [ansResp, wdResp] = await Promise.all([ansPending, withdrawPending]);
      assert.equal(ansResp.status, 200, respDiag("C2 race3 ansResp", ansResp));
      assert.deepEqual(wdResp, unknownWithdraw, respDiag("C2 race3 wdResp", wdResp));
      const [wdRows] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM swarm.ask_withdrawals
        WHERE workspace_id = ${wsId}::uuid AND signal_id = ${raceChoiceAskId}::uuid
      `;
      assert.equal(Number(wdRows!.cnt), 0, `withdraw lost to answer_choice must leave 0 rows: cnt=${wdRows!.cnt}`);
    }

    // =========================================================================
    // C3: Access lost during blocked audit_log INSERT (standalone withdraw_ask,
    //     post_signal replacement, ask_choice replacement) rolls back completely;
    //     replay succeeds while access is intact and fails closed after access loss.
    // =========================================================================
    // C3a: Standalone withdraw_ask blocked at audit_log INSERT.
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

    // C3b: post_signal replacement (supersedes) blocked at audit_log INSERT.
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

    // C3c: ask_choice replacement (supersedes) blocked at audit_log INSERT.
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

    // C3d: Replay with access intact -> stored receipt; replay after access loss -> refusal, no stored fields.
    // Form 1: standalone withdraw_ask
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

    // Form 2a: post_signal replacement — old ask loses access (destination still reachable)
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

    // Form 2b: post_signal replacement — new destination channel loses access (without conversation_id supplied)
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

    // Form 3: ask_choice replacement replay (intact -> 200; after access loss -> uniform 404, no stored fields)
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

    // C3e (reviewer detail 1): Fresh final release checks old ask's deadline on clock_timestamp().
    // With the accepted audit_log INSERT blocked, moving the old ask's `until` into the past rolls
    // back the entire transaction (0 withdrawal rows, 0 receipts, 0 new asks) and returns uniform 404
    // across standalone withdraw_ask and both replacement forms.
    const dlStandaloneAsk = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
      sender.jwt,
      { kind: "withdraw_ask", signal_id: dlStandaloneAskId },
      dlStandaloneCmdId,
      () => expireAskNow(dlStandaloneAskId),
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

    const dlPostOld = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
      sender.jwt,
      {
        kind: "post_signal",
        signal_kind: "ask",
        channel: "c4-pub",
        to_user_id: peer1.id,
        to_agent_principal_id: null,
        in_reply_to: null,
        about: null,
        body: "Detail 1 post_signal replacement must roll back on deadline expiry",
        supersedes: dlPostOldId,
      },
      dlPostCmdId,
      () => expireAskNow(dlPostOldId),
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

    const dlChoiceOld = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
      sender.jwt,
      {
        kind: "ask_choice",
        channel: "c4-pub",
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
      () => expireAskNow(dlChoiceOldId),
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

    // C3f (reviewer detail 1): Replay deliberately skips the deadline check — a withdrawal (and
    // both replacement forms) committed in time still returns its stored result after until passes.
    const dlReplayAsk = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
    await expireAskNow(dlReplayAskId);
    const dlReplayWdAfter = await sendCommand(
      sender.jwt, wsId, { kind: "withdraw_ask", signal_id: dlReplayAskId }, dlReplayWdCmdId,
    );
    assert.equal(dlReplayWdAfter.status, 200, respDiag("dlReplayWdAfter", dlReplayWdAfter));
    assert.equal(dlReplayWdAfter.body.signal_id, dlReplayAskId, respDiag("dlReplayWdAfter", dlReplayWdAfter));
    assert.equal(dlReplayWdAfter.body.withdrawn, true, respDiag("dlReplayWdAfter", dlReplayWdAfter));
    assert.equal(dlReplayWdAfter.body.withdrawn_at, dlReplayWdFresh.body.withdrawn_at, respDiag("dlReplayWdAfter", dlReplayWdAfter));

    const dlReplayPostOld = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
      channel: "c4-pub",
      to_user_id: peer1.id,
      to_agent_principal_id: null,
      in_reply_to: null,
      about: null,
      body: "Detail 1 committed-then-expired post_signal replacement new ask",
      supersedes: dlReplayPostOldId,
    };
    const dlReplayPostFresh = await sendCommand(sender.jwt, wsId, dlReplayPostCmd, dlReplayPostCmdId);
    assert.equal(dlReplayPostFresh.status, 200, respDiag("dlReplayPostFresh", dlReplayPostFresh));
    await expireAskNow(dlReplayPostOldId);
    const dlReplayPostAfter = await sendCommand(sender.jwt, wsId, dlReplayPostCmd, dlReplayPostCmdId);
    assert.equal(dlReplayPostAfter.status, 200, respDiag("dlReplayPostAfter", dlReplayPostAfter));
    assert.equal(
      postedSignalId("dlReplayPostAfter", dlReplayPostAfter),
      postedSignalId("dlReplayPostFresh", dlReplayPostFresh),
      respDiag("dlReplayPostAfter", dlReplayPostAfter),
    );
    assert.equal(dlReplayPostAfter.body.superseded_signal_id, dlReplayPostOldId, respDiag("dlReplayPostAfter", dlReplayPostAfter));

    const dlReplayChoiceOld = await sendCommand(sender.jwt, wsId, {
      kind: "post_signal",
      signal_kind: "ask",
      channel: "c4-pub",
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
      channel: "c4-pub",
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
    await expireAskNow(dlReplayChoiceOldId);
    const dlReplayChoiceAfter = await sendCommand(sender.jwt, wsId, dlReplayChoiceCmd, dlReplayChoiceCmdId);
    assert.equal(dlReplayChoiceAfter.status, 200, respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter));
    assert.equal(
      postedSignalId("dlReplayChoiceAfter", dlReplayChoiceAfter),
      postedSignalId("dlReplayChoiceFresh", dlReplayChoiceFresh),
      respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter),
    );
    assert.equal(dlReplayChoiceAfter.body.superseded_signal_id, dlReplayChoiceOldId, respDiag("dlReplayChoiceAfter", dlReplayChoiceAfter));

    // =========================================================================
    // C4: Direct/group-conversation withdrawal audit rows are hidden from
    //     outside owner/admin; replacing post audit detail does not leak old id;
    //     agent withdrawals in private channel & DM leave presence unchanged
    //     (fresh + replay), while a public-channel post control advances it.
    // =========================================================================
    // C4a: Withdraw a 1:1 DM ask (peer1 -> peer2) and a group-DM ask (peer1 -> peer2 + sender, new group).
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

    // Also note peer1 already withdrew peer1GroupAskId in the group DM above (untagged withdraw_ask).
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

    // Verify replacing post audit rows do not put superseded_signal_id in detail.
    const replaceAuditRows = await sql<{ audit_id: string; detail: string | null }[]>`
      SELECT audit_id::text AS audit_id, detail
      FROM swarm.audit_log
      WHERE workspace_id = ${wsId}::uuid
        AND command_kind IN ('post_signal', 'ask_choice')
        AND outcome = 'accepted'
        AND detail IS NOT NULL
    `;
    for (const row of replaceAuditRows) {
      assert.equal(
        row.detail?.includes(rAsk2Id) || row.detail?.includes(rAsk3Id),
        false,
        `replacing post audit detail must not record superseded signal id: ${JSON.stringify(row)}`,
      );
    }

    // C4a-replace (reviewer detail 2): A replacement moving an ask from a private channel
    // (`c4-priv-rep`) to a public channel (`c4-pub`) tags its audit rows with the union of BOTH
    // channels on fresh write and on replay, for both `post_signal` and `ask_choice` replacements:
    // outside owner/admin see neither row through `swarm_read.audit_log`, while `bothChAdmin`
    // (admin and member of both channels) sees both fresh and replay rows.
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
    const crossPostAcceptedIds = findCrossIds("post_signal", "accepted");
    const crossPostReplayedIds = findCrossIds("post_signal", "replayed");
    const crossChoiceAcceptedIds = findCrossIds("ask_choice", "accepted");
    const crossChoiceReplayedIds = findCrossIds("ask_choice", "replayed");
    assert.ok(crossPostAcceptedIds.length >= 1, `missing fresh union-tagged post_signal replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
    assert.ok(crossPostReplayedIds.length >= 1, `missing replayed union-tagged post_signal replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
    assert.ok(crossChoiceAcceptedIds.length >= 1, `missing fresh union-tagged ask_choice replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
    assert.ok(crossChoiceReplayedIds.length >= 1, `missing replayed union-tagged ask_choice replacement audit row: ${JSON.stringify(crossTaggedRows)}`);
    for (const row of crossTaggedRows) {
      assert.equal(
        row.detail?.includes(crossPrivOld1Id) || row.detail?.includes(crossPrivOld2Id),
        false,
        `cross-channel replacement audit detail must not record superseded signal id: ${JSON.stringify(row)}`,
      );
    }

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

    // C4b: Agent presence suppressed for private-channel and DM withdrawals (fresh & replay);
    //      public-channel post control advances presence.
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

    // Seed agent_presence 10 minutes in the past (well past the 60s throttle) so any presence write is observable.
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

    // Control: public-channel post advances agent_presence.
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
  } finally {
    await cleanupWorkspaceFixture(wsId, [outsideOwner.id, outsideAdmin.id, bothChAdmin.id, sender.id, peer1.id, peer2.id]);
  }
});
