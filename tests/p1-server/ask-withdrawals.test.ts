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
