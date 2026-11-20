/**
 * Production-concurrency witness for lockLocalAuthPlan swarm.users contention:
 * - Same-owner sibling local agents (renew_wake_lease, signals_seen, claim_agent_inbox,
 *   touch_presence, /functions/v1/activity) and unchanged-profile human signals_seen
 *   complete concurrently with 0 503/55P03 while both a sibling agent command is held
 *   mid-transaction and another backend holds swarm.users FOR NO KEY UPDATE.
 * - Human invite_member (swarm.users FOR UPDATE upfront) runs concurrently with sibling
 *   agent renewals and receipts with 0 deadlocks (40P01) and 0 503s (55P03).
 * - Human signals_seen still updates swarm.users when display_name changes, then returns
 *   to FOR KEY SHARE on subsequent unchanged calls.
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
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string; email: string };
type Row = Record<string, unknown>;
type Agent = { principal: string; token: string; name: string; watcherId: string; generation: number };

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let agents: Agent[] = [];
let broadcastSignalId: string;

function localEnvironment(): Local {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as Partial<Local>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"));
  assert.ok(parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  assert.equal(new URL(parsed.DB_URL).hostname, "127.0.0.1");
  return parsed as Local;
}

async function createUser(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  assert.ok(signed.data.session?.access_token);
  return { id: created.data.user.id, jwt: signed.data.session.access_token, email };
}

async function send(
  bearer: string,
  command: Row,
  commandId: string = randomUUID(),
  ws = workspace,
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: ws,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const text = await response.text();
  let body: Row;
  try {
    body = JSON.parse(text) as Row;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function sendActivity(token: string, sequence: number): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      version: 1,
      workspace_id: workspace,
      stream_id: randomUUID(),
      sequence,
      phase: "idle",
      signal_id: null,
      tool_title: null,
      elapsed_ms: 0,
    }),
  });
  const text = await response.text();
  let body: Row;
  try {
    body = JSON.parse(text) as Row;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function seedAgent(ownerId: string, idx: number): Promise<Agent> {
  const principal = randomUUID();
  const name = `sibling-${idx}-${principal.slice(0, 6)}`;
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const scopes = ["post_signal", "claim_agent_inbox", "ack_agent_delivery"];
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${ownerId}::uuid, 'users-lock-witness')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${ownerId}::uuid, ${name})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(scopes)}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  const watcherId = randomUUID();
  const claimed = await send(token, {
    kind: "claim_wake_lease",
    watcher_id: watcherId,
    host_label: `host-${idx}`,
    host_id: randomUUID(),
    take_over: false,
  });
  assert.equal(claimed.status, 200, `claim_wake_lease[${idx}]: ${JSON.stringify(claimed.body)}`);
  const generation = Number(claimed.body.generation);
  assert.ok(Number.isSafeInteger(generation) && generation >= 1);
  return { principal, token, name, watcherId, generation };
}

interface HeldLock {
  pid: number;
  release: () => void;
  done: Promise<void>;
}

async function holdRowLock(
  lockFn: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<HeldLock> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  let acquiredResolve!: (pid: number) => void;
  let acquiredReject!: (err: unknown) => void;
  const acquired = new Promise<number>((resolve, reject) => {
    acquiredResolve = resolve;
    acquiredReject = reject;
  });
  const done = (async () => {
    try {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL lock_timeout = '5s'`;
        const [row] = await tx<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`;
        await lockFn(tx);
        acquiredResolve(row!.pid);
        await released;
      });
    } catch (error) {
      acquiredReject(error);
      throw error;
    }
  })();
  const pid = await acquired;
  return { pid, release, done };
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-users-lock-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
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
    if (functionProcess.exitCode !== null) {
      throw new Error(`supabase functions serve exited early: ${functionProcess.exitCode}\n${functionLogs}`);
    }
    if (Date.now() > bootDeadline) {
      throw new Error(`supabase functions serve timed out\n${functionLogs}`);
    }
    await delay(100);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local command function was not ready\n${functionLogs.slice(-2000)}`,
    cliState,
  });
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/activity`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `local activity function was not ready\n${functionLogs.slice(-2000)}`,
    cliState,
  });

  owner = await createUser("lock-owner");
  workspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name, email)
      VALUES (${owner.id}::uuid, 'initial-owner', ${owner.email})`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'users-lock-ws', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind, head_seq)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace', 0)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
  });

  // Warmup human post_signal: creates a real broadcast signal AND aligns
  // swarm.users (display_name, email) with the owner's verified JWT claims.
  const posted = await send(owner.jwt, {
    kind: "post_signal",
    signal_kind: "note",
    body: "broadcast signal for sibling receipts",
    to_user_id: null,
    about: null,
    to_agent_principal_id: null,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, `warmup post_signal: ${JSON.stringify(posted.body)}`);
  const [sigRow] = await sql<{ id: string }[]>`
    SELECT id FROM swarm.signals
    WHERE workspace_id = ${workspace}::uuid AND to_user_id IS NULL AND to_agent_principal_id IS NULL
    ORDER BY created_at DESC LIMIT 1
  `;
  assert.ok(sigRow?.id, "warmup broadcast signal exists");
  broadcastSignalId = sigRow.id;

  agents = [];
  for (let i = 0; i < 6; i++) {
    agents.push(await seedAgent(owner.id, i));
  }
});

after(async () => {
  if (functionProcess?.pid) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* exited */ }
  }
  if (envDir) rmSync(envDir, { recursive: true, force: true });
  if (sql) await sql.end({ timeout: 5 });
});

test(
  "same-owner sibling agents and unchanged human signals_seen complete without 503 while sibling command and owner FOR NO KEY UPDATE are held",
  { timeout: 45_000 },
  async () => {
    const parkedAgent = agents[0]!;
    const siblings = agents.slice(1);

    // Enqueue and lease one direct delivery for parkedAgent so we can park its
    // ack_agent_delivery inside the command transaction AFTER lockLocalAuthPlan.
    const directPosted = await send(owner.jwt, {
      kind: "post_signal",
      signal_kind: "note",
      to_user_id: null,
      about: null,
      to_agent_principal_id: parkedAgent.principal,
      in_reply_to: null,
      body: "direct delivery to hold mid-transaction",
    });
    assert.equal(directPosted.status, 200, JSON.stringify(directPosted.body));

    const parkedListener = randomUUID();
    const claim = await send(parkedAgent.token, {
      kind: "claim_agent_inbox",
      listener_instance_id: parkedListener,
      limit: 5,
    });
    assert.equal(claim.status, 200, JSON.stringify(claim.body));
    const deliveries = (claim.body.deliveries ?? []) as Row[];
    assert.ok(deliveries.length >= 1, `expected leased delivery: ${JSON.stringify(claim.body)}`);
    const leasedSignalId = String((deliveries[0]!.signal as Row).id);
    const leaseId = String(deliveries[0]!.lease_id);

    let deliveryLock: HeldLock | null = null;
    let ownerLock: HeldLock | null = null;
    let parkedAckPromise: Promise<{ status: number; body: Row }> | null = null;
    let parkedAckSettled = false;
    let parkedAckResult: { status: number; body: Row } | null = null;

    try {
      deliveryLock = await holdRowLock(async (tx) => {
        await tx`
          SELECT signal_id FROM swarm.signal_deliveries
          WHERE signal_id = ${leasedSignalId}::uuid
            AND recipient_agent_principal_id = ${parkedAgent.principal}::uuid
          FOR UPDATE
        `;
      });

      parkedAckPromise = send(parkedAgent.token, {
        kind: "ack_agent_delivery",
        signal_id: leasedSignalId,
        lease_id: leaseId,
        listener_instance_id: parkedListener,
        outcome: "observed",
        last_error_code: null,
      }).then((res) => {
        parkedAckSettled = true;
        parkedAckResult = res;
        return res;
      });

      // Wait until parkedAgent's ack has completed lockLocalAuthPlan (holding
      // swarm.users FOR KEY SHARE + swarm.workspaces FOR SHARE) and is waiting
      // on deliveryLock's swarm.signal_deliveries row.
      const waitDeadline = Date.now() + 8_000;
      let ackWaiting = false;
      while (Date.now() < waitDeadline) {
        const waiting = await sql<{ pid: number; query: string }[]>`
          SELECT pid::int AS pid, query
          FROM pg_stat_activity
          WHERE ${deliveryLock.pid}::int = ANY(pg_blocking_pids(pid))
            AND query ~ 'signal_deliveries'
        `;
        if (waiting.length > 0) {
          ackWaiting = true;
          break;
        }
        assert.equal(parkedAckSettled, false, `parked ack settled prematurely: ${JSON.stringify(parkedAckResult)}`);
        await delay(25);
      }
      assert.ok(ackWaiting, "parked agent ack reached signal_deliveries while holding lockLocalAuthPlan locks");

      // Concurrently hold swarm.users FOR NO KEY UPDATE on the shared owner row.
      // Because parkedAgent holds FOR KEY SHARE (not FOR NO KEY UPDATE), this
      // acquires immediately without blocking on parkedAgent.
      ownerLock = await holdRowLock(async (tx) => {
        await tx`SELECT user_id FROM swarm.users WHERE user_id = ${owner.id}::uuid FOR NO KEY UPDATE`;
      });

      const logStart = functionLogs.length;
      // Phase A: fire all 6 production paths concurrently while BOTH parkedAgent
      // (mid-command, holding 1 of command/index.ts's 2 pool connections with a 5s
      // lock_timeout) AND ownerLock (swarm.users FOR NO KEY UPDATE) are held.
      const phaseAStart = Date.now();
      const phaseAResults = await Promise.all([
        send(siblings[0]!.token, {
          kind: "renew_wake_lease",
          watcher_id: siblings[0]!.watcherId,
          generation: siblings[0]!.generation,
        }).then((r) => ({ label: `renew_wake_lease:${siblings[0]!.name}`, expected: 200, ...r })),
        send(siblings[1]!.token, {
          kind: "renew_wake_lease",
          watcher_id: siblings[1]!.watcherId,
          generation: siblings[1]!.generation,
        }).then((r) => ({ label: `renew_wake_lease:${siblings[1]!.name}`, expected: 200, ...r })),
        send(siblings[2]!.token, {
          kind: "signals_seen",
          signal_ids: [broadcastSignalId],
        }).then((r) => ({ label: `agent_signals_seen:${siblings[2]!.name}`, expected: 200, ...r })),
        send(siblings[3]!.token, {
          kind: "claim_agent_inbox",
          listener_instance_id: randomUUID(),
          limit: 5,
        }).then((r) => ({ label: `claim_agent_inbox:${siblings[3]!.name}`, expected: 200, ...r })),
        send(siblings[4]!.token, { kind: "touch_presence" })
          .then((r) => ({ label: `touch_presence:${siblings[4]!.name}`, expected: 200, ...r })),
        sendActivity(siblings[0]!.token, 1)
          .then((r) => ({ label: `activity:${siblings[0]!.name}`, expected: 202, ...r })),
        send(owner.jwt, { kind: "signals_seen", signal_ids: [broadcastSignalId] })
          .then((r) => ({ label: "human_signals_seen:1", expected: 200, ...r })),
      ]);
      const phaseAElapsedMs = Date.now() - phaseAStart;

      for (const r of phaseAResults) {
        assert.equal(r.status, r.expected, `${r.label} failed (${r.status}): ${JSON.stringify(r.body)}`);
      }
      assert.equal(
        parkedAckSettled,
        false,
        `all 7 concurrent sibling/owner commands finished in ${phaseAElapsedMs}ms while parkedAgent was still held (parkedAckResult=${JSON.stringify(parkedAckResult)})`,
      );
      assert.ok(phaseAElapsedMs < 4_500, `Phase A completed in ${phaseAElapsedMs}ms (must beat 5s lock_timeout)`);

      // Release parkedAgent's delivery lock while keeping ownerLock (swarm.users FOR NO KEY UPDATE) held.
      deliveryLock.release();
      await deliveryLock.done;
      deliveryLock = null;
      const parkedAck = await parkedAckPromise!;
      assert.equal(parkedAck.status, 200, `parked ack after release: ${JSON.stringify(parkedAck.body)}`);

      // Phase B: with ownerLock STILL holding swarm.users FOR NO KEY UPDATE, fire a full
      // 18-request burst across all 5 sibling agents + owner human signals_seen.
      const phaseBResults = await Promise.all([
        ...siblings.map((a) =>
          send(a.token, {
            kind: "renew_wake_lease",
            watcher_id: a.watcherId,
            generation: a.generation,
          }).then((r) => ({ label: `phaseB:renew_wake_lease:${a.name}`, expected: 200, ...r })),
        ),
        ...siblings.map((a) =>
          send(a.token, {
            kind: "signals_seen",
            signal_ids: [broadcastSignalId],
          }).then((r) => ({ label: `phaseB:agent_signals_seen:${a.name}`, expected: 200, ...r })),
        ),
        ...siblings.slice(0, 3).map((a) =>
          send(a.token, {
            kind: "claim_agent_inbox",
            listener_instance_id: randomUUID(),
            limit: 5,
          }).then((r) => ({ label: `phaseB:claim_agent_inbox:${a.name}`, expected: 200, ...r })),
        ),
        ...siblings.slice(3, 5).map((a) =>
          send(a.token, { kind: "touch_presence" })
            .then((r) => ({ label: `phaseB:touch_presence:${a.name}`, expected: 200, ...r })),
        ),
        sendActivity(siblings[1]!.token, 2)
          .then((r) => ({ label: `phaseB:activity:${siblings[1]!.name}`, expected: 202, ...r })),
        send(owner.jwt, { kind: "signals_seen", signal_ids: [broadcastSignalId] })
          .then((r) => ({ label: "phaseB:human_signals_seen:1", expected: 200, ...r })),
        send(owner.jwt, { kind: "signals_seen", signal_ids: [broadcastSignalId] })
          .then((r) => ({ label: "phaseB:human_signals_seen:2", expected: 200, ...r })),
      ]);
      for (const r of phaseBResults) {
        assert.equal(r.status, r.expected, `${r.label} failed (${r.status}): ${JSON.stringify(r.body)}`);
      }
      assert.doesNotMatch(functionLogs.slice(logStart), /55P03|40P01/u, `unexpected lock timeout or deadlock in logs:\n${functionLogs.slice(logStart)}`);
    } finally {
      ownerLock?.release();
      deliveryLock?.release();
      if (ownerLock) await ownerLock.done;
      if (deliveryLock) await deliveryLock.done;
    }
  },
);

test(
  "human invite_member concurrent with sibling agent burst completes with zero deadlocks and zero 503s",
  { timeout: 30_000 },
  async () => {
    const logStart = functionLogs.length;
    const siblings = agents.slice(1);
    for (let wave = 0; wave < 3; wave++) {
      const results = await Promise.all([
        send(owner.jwt, {
          kind: "invite_member",
          email: `invitee-wave-${wave}-${randomUUID()}@example.test`,
        }).then((r) => ({ label: `invite_member:${wave}`, ...r })),
        ...siblings.map((a) =>
          send(a.token, {
            kind: "renew_wake_lease",
            watcher_id: a.watcherId,
            generation: a.generation,
          }).then((r) => ({ label: `renew_wake_lease:${wave}:${a.name}`, ...r })),
        ),
        ...siblings.map((a) =>
          send(a.token, {
            kind: "signals_seen",
            signal_ids: [broadcastSignalId],
          }).then((r) => ({ label: `signals_seen:${wave}:${a.name}`, ...r })),
        ),
      ]);
      for (const r of results) {
        assert.equal(r.status, 200, `${r.label} failed (${r.status}): ${JSON.stringify(r.body)}`);
      }
    }
    assert.doesNotMatch(functionLogs.slice(logStart), /55P03|40P01/u, `unexpected lock timeout or deadlock in logs:\n${functionLogs.slice(logStart)}`);
  },
);

test(
  "human signals_seen updates swarm.users when display_name changed, then uses FOR KEY SHARE once unchanged",
  { timeout: 20_000 },
  async () => {
    const stale = `stale-before-seen-${randomUUID().slice(0, 8)}`;
    await sql`UPDATE swarm.users SET display_name = ${stale} WHERE user_id = ${owner.id}::uuid`;

    const updated = await send(owner.jwt, {
      kind: "signals_seen",
      signal_ids: [broadcastSignalId],
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));

    const [afterRow] = await sql<{ display_name: string }[]>`
      SELECT display_name FROM swarm.users WHERE user_id = ${owner.id}::uuid
    `;
    assert.ok(afterRow && afterRow.display_name !== stale, "changed human profile still updates swarm.users");

    // Once unchanged, human signals_seen acquires FOR KEY SHARE and completes
    // cleanly even while another backend holds swarm.users FOR NO KEY UPDATE.
    const ownerLock = await holdRowLock(async (tx) => {
      await tx`SELECT user_id FROM swarm.users WHERE user_id = ${owner.id}::uuid FOR NO KEY UPDATE`;
    });
    try {
      const concurrent = await send(owner.jwt, {
        kind: "signals_seen",
        signal_ids: [broadcastSignalId],
      });
      assert.equal(concurrent.status, 200, JSON.stringify(concurrent.body));
    } finally {
      ownerLock.release();
      await ownerLock.done;
    }
  },
);
