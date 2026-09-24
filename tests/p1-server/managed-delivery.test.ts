/**
 * Managed delivery pending-surface against the served command function.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**).
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import {
  AGENT_SESSION_GENERATION_HEADER,
  AGENT_SESSION_ID_HEADER,
  AGENT_SESSION_KEY_HEADER,
  DELIVERY_NOT_SURFACED_CODE,
} from "../../src/cloud/session-wire.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import { WAKE_STALE_MS } from "../../src/cloud/idle-poll.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;

interface SharedFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  device: string;
}

let shared: SharedFixture;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL &&
      parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

async function createUser(
  label: string,
): Promise<{ id: string; jwt: string }> {
  const email = `synth-${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session?.access_token);
  return { id: created.data.user.id, jwt: signedIn.data.session.access_token };
}

function synthKey(): string {
  return randomBytes(32).toString("base64url");
}

function synthToken(): string {
  return `swm_agt_${randomBytes(32).toString("base64url")}`;
}

function proofHeaders(
  sessionId: string,
  generation: number,
  key: string,
): Record<string, string> {
  return {
    [AGENT_SESSION_ID_HEADER]: sessionId,
    [AGENT_SESSION_GENERATION_HEADER]: String(generation),
    [AGENT_SESSION_KEY_HEADER]: key,
  };
}

function acquireHeaders(sessionId: string, key: string): Record<string, string> {
  return {
    [AGENT_SESSION_ID_HEADER]: sessionId,
    [AGENT_SESSION_KEY_HEADER]: key,
  };
}

async function runCmd(
  token: string,
  command: Record<string, unknown>,
  options: {
    commandId?: string;
    headers?: Record<string, string>;
    workspace?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const workspace = options.workspace ?? shared.workspace;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...options.headers,
    },
    body: JSON.stringify({
      command_id: options.commandId ?? randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

interface SeededAgent {
  principalId: string;
  token: string;
}

async function seedAgent(label: string): Promise<SeededAgent> {
  const principalId = randomUUID();
  const token = synthToken();
  const run = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid,
        ${shared.workspace}::uuid,
        ${shared.ownerId}::uuid,
        ${`synth-${label}-${principalId.slice(0, 8)}`}
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principalId}::uuid, ${shared.device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { principalId, token };
}

async function enable(principalId: string) {
  const result = await runCmd(shared.ownerJwt, {
    kind: "enable_agent_management",
    principal_id: principalId,
  });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result;
}

async function acquire(token: string, sessionId: string, key: string) {
  return await runCmd(
    token,
    { kind: "acquire_agent_session", session_id: sessionId },
    { headers: acquireHeaders(sessionId, key) },
  );
}

async function postAsk(principalId: string, senderToken = shared.ownerJwt): Promise<string> {
  const posted = await runCmd(senderToken, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `synth-ask-${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: principalId,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signalId = (posted.body.signal as { id?: string } | undefined)?.id;
  assert.equal(typeof signalId, "string");
  return signalId as string;
}

async function holdSession(agent: SeededAgent) {
  await enable(agent.principalId);
  const sessionId = randomUUID();
  const key = synthKey();
  const held = await acquire(agent.token, sessionId, key);
  assert.equal(held.status, 200, JSON.stringify(held.body));
  return { sessionId, key, generation: Number(held.body.generation) };
}

async function deliveryRow(signalId: string, principalId: string) {
  const [row] = await sql<{
    session_id: string | null;
    session_generation: number | null;
    attempt_count: number;
    ack_outcome: string | null;
    acked_at: Date | null;
    surfaced_at: Date | null;
    lease_id: string | null;
  }[]>`
    SELECT
      session_id::text,
      session_generation,
      attempt_count,
      ack_outcome,
      acked_at,
      surfaced_at,
      lease_id::text
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${principalId}::uuid
  `;
  assert.ok(row, "delivery row");
  return row;
}

async function wakePathRows(principalId: string, userId = shared.ownerId): Promise<Date[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    const rows = await tx<{ oldest_unobserved_at: Date }[]>`
      SELECT oldest_unobserved_at FROM swarm_read.agent_wake_path
      WHERE workspace_id = ${shared.workspace}::uuid AND principal_id = ${principalId}::uuid
    `;
    return rows.map(row => row.oldest_unobserved_at);
  });
}

async function receiptWakePath(signalId: string, principalId: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: shared.ownerId, role: "authenticated" })}, true)`;
    const [row] = await tx<{ value: { receipts: Array<{ recipient_agent_principal_id?: string; wake_path_observing?: boolean }> } }[]>`
      SELECT swarm_read.signal_delivery_receipts(${shared.workspace}::uuid, ${signalId}::uuid, NULL) AS value`;
    const receipt = row?.value.receipts.find(value => value.recipient_agent_principal_id === principalId);
    assert.ok(receipt, "directed agent receipt");
    return receipt.wake_path_observing === true;
  });
}

async function agentReceiptWakePath(signalId: string, principalId: string, senderToken: string): Promise<boolean> {
  return sql.begin(async (tx) => {
    // The read edge intentionally does not install request.jwt.claims for agent tokens.
    const [row] = await tx<{ value: { receipts: Array<{ recipient_agent_principal_id?: string; wake_path_observing?: boolean }> } | null }[]>`
      SELECT swarm_read.signal_delivery_receipts(
        ${shared.workspace}::uuid, ${signalId}::uuid,
        ${createHash("sha256").update(senderToken).digest()}) AS value`;
    const receipt = row?.value?.receipts.find(value => value.recipient_agent_principal_id === principalId);
    assert.ok(receipt, "agent sender's directed receipt");
    return receipt.wake_path_observing === true;
  });
}

async function eligibleWakePathSignalIds(principalId: string): Promise<string[]> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: shared.ownerId, role: "authenticated" })}, true)`;
    const rows = await tx<{ signal_id: string }[]>`
      SELECT signal_id::text FROM swarm_read.agent_wake_path_deliveries
      WHERE workspace_id = ${shared.workspace}::uuid AND principal_id = ${principalId}::uuid`;
    return rows.map(row => row.signal_id);
  });
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-managed-delivery-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n");
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          `functions serve never booted:\n${functionLogs.slice(-3000)}`,
        );
      }
      await delay(250);
    }
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });

  const owner = await createUser("managed-delivery-owner");
  const workspace = randomUUID();
  const device = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'SynthManagedDeliveryOwner')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'synth-managed-delivery-device')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'SynthManagedDeliveryWS', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
  });
  shared = {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    device,
  };
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([
      exited,
      delay(2_000).then(() => false),
    ]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("claim binds session_id and session_generation from the verified proof", async () => {
  const agent = await seedAgent("claim-bind");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers: proofHeaders(held.sessionId, held.generation, held.key) },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.session_id, held.sessionId);
  assert.equal(Number(row.session_generation), held.generation);
  assert.ok(row.lease_id);
});

test("stale-generation claim is refused with session_conflict", async () => {
  const agent = await seedAgent("stale-gen");
  const held = await holdSession(agent);
  await postAsk(agent.principalId);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: randomUUID() },
    { headers: proofHeaders(held.sessionId, held.generation + 1, held.key) },
  );
  assert.equal(claim.status, 409, JSON.stringify(claim.body));
  assert.equal(claim.body.error, "session_conflict");
});

test("bare queued-to-observed is delivery_not_surfaced when managed", async () => {
  const agent = await seedAgent("bare-promote");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const bare = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
    },
    { headers },
  );
  assert.equal(bare.status, 409, JSON.stringify(bare.body));
  assert.equal(bare.body.error, DELIVERY_NOT_SURFACED_CODE);
  const flagged = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(flagged.status, 409, JSON.stringify(flagged.body));
  assert.equal(flagged.body.error, "delivery_not_surfaced");
});

test("surfaced ACK with current proof succeeds and sets surfaced_at", async () => {
  const agent = await seedAgent("surface-ack");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const observed = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: null,
      listener_instance_id: null,
      outcome: "observed",
      last_error_code: null,
      surfaced: true,
    },
    { headers },
  );
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.ack_outcome, "observed");
  assert.ok(row.surfaced_at);
  const staleReplay = await runCmd(agent.token, {
    kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null,
    outcome: "observed", last_error_code: null, surfaced: true,
  }, { headers: proofHeaders(held.sessionId, held.generation + 1, held.key) });
  assert.equal(staleReplay.status, 409, JSON.stringify(staleReplay.body));
  assert.equal(staleReplay.body.error, "session_conflict");
  assert.deepEqual(await deliveryRow(signalId, agent.principalId), row);
});

test("unmanaged ACK keeps today's queued-to-observed promotion", async () => {
  const agent = await seedAgent("unmanaged-ack");
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const claim = await runCmd(agent.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: listener,
  });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(agent.token, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: leaseId,
    listener_instance_id: listener,
    outcome: "queued",
    last_error_code: null,
  });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const observed = await runCmd(agent.token, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: null,
    listener_instance_id: null,
    outcome: "observed",
    last_error_code: null,
  });
  assert.equal(observed.status, 200, JSON.stringify(observed.body));
  const row = await deliveryRow(signalId, agent.principalId);
  assert.equal(row.ack_outcome, "observed");
  assert.equal(row.surfaced_at, null);
  assert.equal(row.session_id, null);
});

test("unclaimed check observation accepts only untouched directed rows and is idempotent", async () => {
  const agent = await seedAgent("unclaimed-check");
  const signalId = await postAsk(agent.principalId);
  assert.equal((await wakePathRows(agent.principalId)).length, 0,
    "a seat that has never observed mail is unknown");
  assert.equal((await wakePathRows(agent.principalId, randomUUID())).length, 0,
    "mutation control: another identity cannot see this wake path");
  const command = {
    kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null,
    outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true,
  };
  const first = await runCmd(agent.token, command);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const observed = await deliveryRow(signalId, agent.principalId);
  assert.equal(observed.ack_outcome, "observed");
  assert.ok(observed.acked_at);
  assert.equal((await wakePathRows(agent.principalId)).length, 0,
    "the roster mark clears once check observes the delivery");
  const second = await runCmd(agent.token, command);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const replay = await deliveryRow(signalId, agent.principalId);
  assert.deepEqual(replay.acked_at, observed.acked_at);
  // Mutation control: a different principal must reach the edge and be refused.
  const other = await seedAgent("unclaimed-other");
  const foreign = await runCmd(other.token, command);
  assert.equal(foreign.status, 403, JSON.stringify(foreign.body));
  assert.equal(foreign.body.error, "delivery_unavailable");
});

test("wake mark ignores expired mail, then ages and clears live mail", { timeout: 30_000 }, async () => {
  const [cutoff] = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM swarm.wake_path_release WHERE singleton`;
  assert.ok(cutoff);
  await sql`UPDATE swarm.wake_path_release SET applied_at = statement_timestamp() - interval '1 hour' WHERE singleton`;
  try {
  const agent = await seedAgent("wake-states");
  const first = await postAsk(agent.principalId);
  assert.equal((await wakePathRows(agent.principalId)).length, 0, "no observed ACK means unknown");
  const command = { kind: "ack_agent_delivery", signal_id: first, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true };
  assert.equal((await runCmd(agent.token, command)).status, 200);
  // The observed signal was created before the live signal, so it cannot heal
  // the live row in check order. Keep its delivery after the release cutoff.
  await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '10 minutes'
    WHERE signal_id = ${first}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
  assert.equal((await wakePathRows(agent.principalId)).length, 0);
  const expired = await postAsk(agent.principalId);
  // signals is append-only; expire the row the way tests/p1-server/command.test.ts does.
  await sql`ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only`;
  try {
    await sql`UPDATE swarm.signals
      SET created_at = statement_timestamp() - interval '10 seconds',
          until = statement_timestamp() - interval '1 second'
      WHERE id = ${expired}::uuid AND workspace_id = ${shared.workspace}::uuid`;
  } finally {
    await sql`ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only`;
  }
  assert.equal((await wakePathRows(agent.principalId)).length, 0, "expired mail cannot make a seat stale");
  assert.equal(await receiptWakePath(expired, agent.principalId), false);
  const live = await postAsk(agent.principalId);
  await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '4 minutes'
    WHERE signal_id = ${live}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
  const stale = await wakePathRows(agent.principalId);
  assert.equal(stale.length, 1);
  assert.ok(Date.now() - stale[0]!.getTime() >= WAKE_STALE_MS);
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), [live]);
  assert.equal(await receiptWakePath(live, agent.principalId), true);
  assert.equal((await runCmd(agent.token, { ...command, signal_id: live })).status, 200);
  assert.equal((await wakePathRows(agent.principalId)).length, 0, "observed ACK clears stale");
  assert.equal(await receiptWakePath(live, agent.principalId), false);
  } finally {
    await sql`UPDATE swarm.wake_path_release SET applied_at = ${cutoff.applied_at} WHERE singleton`;
  }
});

test("agent and owner senders see stale receipts while a nonmember sees none", { timeout: 30_000 }, async () => {
  const [cutoff] = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM swarm.wake_path_release WHERE singleton`;
  assert.ok(cutoff);
  await sql`UPDATE swarm.wake_path_release SET applied_at = statement_timestamp() - interval '1 hour' WHERE singleton`;
  try {
  const recipient = await seedAgent("wake-receipt-recipient");
  const sender = await seedAgent("wake-receipt-sender");
  const observed = await postAsk(recipient.principalId);
  const ack = await runCmd(recipient.token, { kind: "ack_agent_delivery", signal_id: observed,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true });
  assert.equal(ack.status, 200, JSON.stringify(ack.body));
  await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '10 minutes'
    WHERE signal_id = ${observed}::uuid AND recipient_agent_principal_id = ${recipient.principalId}::uuid`;
  const agentSignal = await postAsk(recipient.principalId, sender.token);
  const ownerSignal = await postAsk(recipient.principalId);
  for (const signalId of [agentSignal, ownerSignal]) {
    await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '4 minutes'
      WHERE signal_id = ${signalId}::uuid AND recipient_agent_principal_id = ${recipient.principalId}::uuid`;
  }
  assert.equal(await agentReceiptWakePath(agentSignal, recipient.principalId, sender.token), true);
  assert.equal(await receiptWakePath(ownerSignal, recipient.principalId), true);
  const stranger = randomUUID();
  const denied = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: stranger, role: "authenticated" })}, true)`;
    const [row] = await tx<{ value: unknown }[]>`
      SELECT swarm_read.signal_delivery_receipts(${shared.workspace}::uuid, ${ownerSignal}::uuid, NULL) AS value`;
    return row?.value;
  });
  assert.equal(denied, null);
  assert.deepEqual(await wakePathRows(recipient.principalId, stranger), []);
  } finally {
    await sql`UPDATE swarm.wake_path_release SET applied_at = ${cutoff.applied_at} WHERE singleton`;
  }
});

test("later observed mail heals older unobserved mail in view and receipt", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-later-observed");
  const first = await postAsk(agent.principalId);
  const second = await postAsk(agent.principalId);
  const command = { kind: "ack_agent_delivery", signal_id: second, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true };
  assert.equal((await runCmd(agent.token, command)).status, 200);
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), []);
  assert.equal((await wakePathRows(agent.principalId)).length, 0);
  assert.equal(await receiptWakePath(first, agent.principalId), false);
  const third = await postAsk(agent.principalId);
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), [third]);
  assert.equal(await receiptWakePath(third, agent.principalId), true);
  assert.equal(await receiptWakePath(first, agent.principalId), false);
});

test("check order wins when an older signal gains its recipient after newer mail", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-inverted-order");
  const other = await seedAgent("wake-inverted-other");
  const known = await postAsk(agent.principalId);
  const older = await postAsk(other.principalId);
  const pending = await postAsk(agent.principalId);
  assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: known,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm.wake_path_release SET applied_at = statement_timestamp() - interval '2 hours' WHERE singleton`;
    // Production inverts signal order and enqueue order only inside one posting transaction
    // (milliseconds). This rolled-back fixture widens that gap to minutes by adding a recipient
    // late, which signal_recipients_same_transaction refuses outside this fixture.
    await tx`ALTER TABLE swarm.signal_recipients DISABLE TRIGGER signal_recipients_same_transaction`;
    await tx`INSERT INTO swarm.signal_recipients
      (signal_id, workspace_id, recipient_agent_principal_id, position)
      VALUES (${older}::uuid, ${shared.workspace}::uuid, ${agent.principalId}::uuid, 1)`;
    await tx`ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only`;
    try {
      await tx`UPDATE swarm.signals SET created_at = statement_timestamp() - interval '90 minutes'
        WHERE id = ${known}::uuid AND workspace_id = ${shared.workspace}::uuid`;
      await tx`UPDATE swarm.signals SET created_at = statement_timestamp() - interval '80 minutes'
        WHERE id = ${older}::uuid AND workspace_id = ${shared.workspace}::uuid`;
      await tx`UPDATE swarm.signals SET created_at = statement_timestamp() - interval '70 minutes'
        WHERE id = ${pending}::uuid AND workspace_id = ${shared.workspace}::uuid`;
    } finally { await tx`ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only`; }
    await tx`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '90 minutes'
      WHERE signal_id = ${known}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
    await tx`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '15 minutes',
      acked_at = statement_timestamp(), ack_outcome = 'observed', last_error_code = NULL,
      delivered_at = statement_timestamp(), surfaced_at = statement_timestamp(), updated_at = statement_timestamp()
      WHERE signal_id = ${older}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
    await tx`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '40 minutes'
      WHERE signal_id = ${pending}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: shared.ownerId, role: "authenticated" })}, true)`;
    const rows = await tx<{ signal_id: string }[]>`SELECT signal_id::text FROM swarm_read.agent_wake_path_deliveries
      WHERE workspace_id = ${shared.workspace}::uuid AND principal_id = ${agent.principalId}::uuid`;
    assert.deepEqual(rows.map(row => row.signal_id), [pending],
      "a later enqueue for an earlier signal cannot heal later check mail");
    const [receipt] = await tx<{ value: { receipts: Array<{ recipient_agent_principal_id?: string; wake_path_observing?: boolean }> } }[]>`
      SELECT swarm_read.signal_delivery_receipts(${shared.workspace}::uuid, ${pending}::uuid, NULL) AS value`;
    assert.equal(receipt?.value.receipts.find(value => value.recipient_agent_principal_id === agent.principalId)?.wake_path_observing, true);
    throw new Error("ROLLBACK_INVERTED_WAKE_ORDER");
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_INVERTED_WAKE_ORDER") throw error;
  });
});

test("an observed non-ask/note delivery cannot heal directed mail", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-nondirected-kind");
  const known = await postAsk(agent.principalId);
  assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: known,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
  const pending = await postAsk(agent.principalId);
  const posted = await runCmd(shared.ownerJwt, { kind: "post_signal", signal_kind: "working-on",
    body: `synth-working-${randomUUID()}`, to_user_id: null, to_agent_principal_id: null,
    about: "https://example.test/work", in_reply_to: null });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const later = (posted.body.signal as { id: string }).id;
  await sql.begin(async (tx) => {
    // Production cannot hold this row: the trigger refuses a late recipient and the command edge
    // refuses this ACK. The rolled-back fixture isolates the view's kind filter.
    await tx`ALTER TABLE swarm.signal_recipients DISABLE TRIGGER signal_recipients_same_transaction`;
    await tx`INSERT INTO swarm.signal_recipients
      (signal_id, workspace_id, recipient_agent_principal_id, position)
      VALUES (${later}::uuid, ${shared.workspace}::uuid, ${agent.principalId}::uuid, 0)`;
    // The recipient trigger may already have enqueued this delivery; make it observed either way.
    await tx`INSERT INTO swarm.signal_deliveries
      (signal_id, workspace_id, recipient_agent_principal_id, enqueued_at)
      VALUES (${later}::uuid, ${shared.workspace}::uuid, ${agent.principalId}::uuid, statement_timestamp())
      ON CONFLICT DO NOTHING`;
    const marked = await tx`UPDATE swarm.signal_deliveries SET delivered_at = statement_timestamp(),
      surfaced_at = statement_timestamp(), acked_at = statement_timestamp(), ack_outcome = 'observed',
      last_error_code = NULL, updated_at = statement_timestamp()
      WHERE signal_id = ${later}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`;
    assert.equal(marked.count, 1);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: shared.ownerId, role: "authenticated" })}, true)`;
    const rows = await tx<{ signal_id: string }[]>`SELECT signal_id::text FROM swarm_read.agent_wake_path_deliveries
      WHERE workspace_id = ${shared.workspace}::uuid AND principal_id = ${agent.principalId}::uuid`;
    assert.deepEqual(rows.map(row => row.signal_id), [pending]);
    const [receipt] = await tx<{ value: { receipts: Array<{ recipient_agent_principal_id?: string; wake_path_observing?: boolean }> } }[]>`
      SELECT swarm_read.signal_delivery_receipts(${shared.workspace}::uuid, ${pending}::uuid, NULL) AS value`;
    assert.equal(receipt?.value.receipts.find(value => value.recipient_agent_principal_id === agent.principalId)?.wake_path_observing, true);
    throw new Error("ROLLBACK_NON_ASK_NOTE_WAKE");
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_NON_ASK_NOTE_WAKE") throw error;
  });
});

async function inboxPage(token: string, after: { created_at: string; id: string }): Promise<Array<{ id: string; created_at: string }>> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: shared.workspace, inbox: true, about: null,
      kind: null, since: null, after_created_at: after.created_at, after_id: after.id, limit: 1,
      include_stale: true }),
  });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return (JSON.parse(text) as { signals: Array<{ id: string; created_at: string }> }).signals;
}

test("check pages one millisecond by id, and the heal uses that order", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-same-millisecond");
  const first = await postAsk(agent.principalId);
  const second = await postAsk(agent.principalId);
  const [low, high] = [first, second].sort();
  // Inside one millisecond, the higher id gets the earlier microsecond.
  await sql`ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only`;
  let base: string;
  try {
    const [row] = await sql<{ base: string }[]>`SELECT to_char(date_trunc('milliseconds', statement_timestamp())
      - interval '5 minutes' - interval '1 millisecond', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS base`;
    base = row!.base;
    await sql`UPDATE swarm.signals SET created_at = ${base}::timestamptz + interval '1 millisecond'
        + interval '100 microseconds' WHERE id = ${high}::uuid AND workspace_id = ${shared.workspace}::uuid`;
    await sql`UPDATE swarm.signals SET created_at = ${base}::timestamptz + interval '1 millisecond'
        + interval '900 microseconds' WHERE id = ${low}::uuid AND workspace_id = ${shared.workspace}::uuid`;
  } finally {
    await sql`ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only`;
  }
  const seen: string[] = [];
  let cursor = { created_at: base, id: "00000000-0000-4000-8000-000000000000" };
  for (let page = 0; page < 2; page += 1) {
    const rows = await inboxPage(agent.token, cursor);
    assert.equal(rows.length, 1);
    seen.push(rows[0]!.id);
    cursor = { created_at: rows[0]!.created_at, id: rows[0]!.id };
  }
  assert.deepEqual(seen, [low, high], "one-row pages return both signals once, in (millisecond, id) order");
  // The seat observed only the first signal check shows; the second stays eligible.
  assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: low,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), [high]);
  assert.equal(await receiptWakePath(high, agent.principalId), true);
});

test("revoked principal has no wake row or observing receipt", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-revoked");
  const observed = await postAsk(agent.principalId);
  const command = { kind: "ack_agent_delivery", signal_id: observed, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true };
  assert.equal((await runCmd(agent.token, command)).status, 200);
  const pending = await postAsk(agent.principalId);
  assert.equal(await receiptWakePath(pending, agent.principalId), true);
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
    WHERE principal_id = ${agent.principalId}::uuid`;
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), []);
  assert.equal((await wakePathRows(agent.principalId)).length, 0);
  assert.equal(await receiptWakePath(pending, agent.principalId), false);
});

test("a claimed delivery leaves both wake eligibility surfaces", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-leased");
  const known = await postAsk(agent.principalId);
  assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: known,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
  const pending = await postAsk(agent.principalId);
  assert.equal(await receiptWakePath(pending, agent.principalId), true);
  const claimed = await runCmd(agent.token, { kind: "claim_agent_inbox", listener_instance_id: randomUUID() });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), []);
  assert.equal((await wakePathRows(agent.principalId)).length, 0);
  assert.equal(await receiptWakePath(pending, agent.principalId), false);
});

test("a departed owner cannot view a seat that a remaining member can inspect", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("wake-owner-left");
  const known = await postAsk(agent.principalId);
  assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: known,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
  await postAsk(agent.principalId);
  const other = await createUser("wake-remaining-member");
  await sql`INSERT INTO swarm.users (user_id, display_name)
    VALUES (${other.id}::uuid, 'RemainingWakeMember')`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES (${shared.workspace}::uuid, ${other.id}::uuid, 'member')`;
  assert.equal((await wakePathRows(agent.principalId, other.id)).length, 1);
  await sql.begin(async (tx) => {
    await tx`DELETE FROM swarm.memberships
      WHERE workspace_id = ${shared.workspace}::uuid AND user_id = ${shared.ownerId}::uuid`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: shared.ownerId, role: "authenticated" })}, true)`;
    const departed = await tx`SELECT * FROM swarm_read.agent_wake_path
      WHERE principal_id = ${agent.principalId}::uuid`;
    assert.equal(departed.length, 0);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: other.id, role: "authenticated" })}, true)`;
    const remaining = await tx`SELECT * FROM swarm_read.agent_wake_path
      WHERE principal_id = ${agent.principalId}::uuid`;
    assert.equal(remaining.length, 1);
    throw new Error("ROLLBACK_OWNER_LEFT_PROBE");
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_OWNER_LEFT_PROBE") throw error;
  });
});

test("wake catalog validates the lease-free observed shape and hides private receipt sources", { timeout: 10_000 }, async () => {
  const [row] = await sql<{ definition: string; validated: boolean; inner_exposed: boolean; read_exposed: boolean; anon_exposed: boolean; public_exposed: boolean; eligible_authenticated: boolean; eligible_read: boolean; eligible_anon: boolean; eligible_command: boolean }[]>`
    SELECT pg_get_constraintdef(c.oid) AS definition, c.convalidated AS validated,
      has_function_privilege('authenticated',
        'swarm_read.signal_delivery_receipts_without_wake_path(uuid,uuid,bytea)', 'EXECUTE') AS inner_exposed,
      has_function_privilege('swarm_read',
        'swarm_read.signal_delivery_receipts_without_wake_path(uuid,uuid,bytea)', 'EXECUTE') AS read_exposed,
      has_function_privilege('anon',
        'swarm_read.signal_delivery_receipts_without_wake_path(uuid,uuid,bytea)', 'EXECUTE') AS anon_exposed,
      EXISTS (SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS acl
        WHERE p.oid = 'swarm_read.signal_delivery_receipts_without_wake_path(uuid,uuid,bytea)'::regprocedure
          AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_exposed,
      has_table_privilege('authenticated', 'swarm.wake_path_eligible_deliveries', 'SELECT') AS eligible_authenticated,
      has_table_privilege('swarm_read', 'swarm.wake_path_eligible_deliveries', 'SELECT') AS eligible_read,
      has_table_privilege('anon', 'swarm.wake_path_eligible_deliveries', 'SELECT') AS eligible_anon,
      has_table_privilege('swarm_command', 'swarm.wake_path_eligible_deliveries', 'SELECT') AS eligible_command
    FROM pg_constraint AS c WHERE c.conrelid = 'swarm.signal_deliveries'::regclass
      AND c.conname = 'signal_deliveries_check9'`;
  assert.ok(row);
  assert.equal(row.validated, true);
  assert.match(row.definition, /ack_outcome = 'observed'.*last_error_code IS NULL/);
  assert.equal(row.inner_exposed, false);
  assert.equal(row.read_exposed, false);
  assert.equal(row.anon_exposed, false);
  assert.equal(row.public_exposed, false);
  assert.equal(row.eligible_authenticated, false);
  assert.equal(row.eligible_read, false);
  assert.equal(row.eligible_anon, false);
  assert.equal(row.eligible_command, false);
  const agent = await seedAgent("wake-constraint");
  const signalId = await postAsk(agent.principalId);
  const accepted = await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  await assert.rejects(sql`UPDATE swarm.signal_deliveries SET last_error_code = 'provider_refused'
    WHERE signal_id = ${signalId}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`,
  { code: "23514" });
  await assert.rejects(sql`UPDATE swarm.signal_deliveries SET ack_outcome = 'replied'
    WHERE signal_id = ${signalId}::uuid AND recipient_agent_principal_id = ${agent.principalId}::uuid`,
  { code: "23514" });
});

const WAKE_MIGRATION = fileURLToPath(new URL("../../supabase/migrations/20260925000001_unclaimed_observed_ack.sql", import.meta.url));
function eligibleViewBody(): string {
  const migration = readFileSync(WAKE_MIGRATION, "utf8");
  return migration.split("CREATE VIEW swarm.wake_path_eligible_deliveries", 2)[1]!
    .split("ALTER VIEW swarm.wake_path_eligible_deliveries", 1)[0]!;
}
const CHECK_ORDER_HEAL = "AND (date_trunc('milliseconds', later_signal.created_at), later_signal.id)\n" +
  "        > (date_trunc('milliseconds', s.created_at), s.id)";
function replaceOnce(text: string, find: string, replacement: string): string {
  assert.equal(text.split(find).length, 2, `the mutation must find ${JSON.stringify(find)} once`);
  return text.replace(find, replacement);
}

test("section 5 catalog proof accepts the installed view and refuses an old heal rule", { timeout: 30_000 }, async () => {
  const proof = readFileSync(fileURLToPath(new URL("../../deploy/release-proofs/item-g/20260925000001-catalog.sql", import.meta.url)), "utf8")
    .replace(/\\gset\s*$/, "");
  const view = eligibleViewBody();
  const cases: Array<[string, string, boolean]> = [
    ["installed", view, true],
    ["enqueue-order heal", replaceOnce(view, CHECK_ORDER_HEAL, "AND later.enqueued_at > d.enqueued_at"), false],
    ["microsecond-order heal", replaceOnce(view, CHECK_ORDER_HEAL,
      "AND (later_signal.created_at, later_signal.id) > (s.created_at, s.id)"), false],
    ["no later kind filter", replaceOnce(view, "      AND later_signal.kind IN ('ask', 'note')\n", ""), false],
    ["no release cutoff", replaceOnce(view,
      "  AND d.enqueued_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton)\n", ""), false],
  ];
  cases.push(["no unclaimed observed index", view, false]);
  cases.push(["index that can hold no row", view, false]);
  cases.push(["unique index", view, false]);
  for (const [name, body, expected] of cases) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries${body}`);
      if (name !== "installed" && name.includes("index")) await tx`DROP INDEX swarm.signal_deliveries_unclaimed_observed`;
      if (name === "index that can hold no row") {
        await tx`CREATE INDEX signal_deliveries_unclaimed_observed ON swarm.signal_deliveries
          (workspace_id, recipient_agent_principal_id) WHERE ack_outcome = 'observed'
          AND last_lease_id IS NULL AND last_leased_by IS NULL AND acked_at IS NULL`;
      }
      if (name === "unique index") {
        await tx`CREATE UNIQUE INDEX signal_deliveries_unclaimed_observed ON swarm.signal_deliveries
          (workspace_id, recipient_agent_principal_id, signal_id) WHERE ack_outcome = 'observed'
          AND last_lease_id IS NULL AND last_leased_by IS NULL`;
      }
      const [row] = await tx.unsafe<{ catalog_ok: boolean }[]>(proof);
      assert.equal(row?.catalog_ok, expected, `catalog proof on ${name}`);
      throw new Error("ROLLBACK_CATALOG_CASE");
    }).catch(error => {
      if (!(error instanceof Error) || error.message !== "ROLLBACK_CATALOG_CASE") throw error;
    });
  }
});

test("the release cutoff alone keeps pre-release backlog out after an old ACK", { timeout: 30_000 }, async () => {
  const [cutoff] = await sql<{ applied_at: Date }[]>`SELECT applied_at FROM swarm.wake_path_release WHERE singleton`;
  assert.ok(cutoff);
  const agent = await seedAgent("wake-cutoff-backlog");
  // A seat behind at release: two pre-release asks, read oldest first.
  const read = await postAsk(agent.principalId);
  const backlog = await postAsk(agent.principalId);
  await sql`UPDATE swarm.wake_path_release SET applied_at = statement_timestamp() WHERE singleton`;
  try {
    assert.equal((await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: read,
      lease_id: null, listener_instance_id: null, outcome: "observed",
      last_error_code: null, surfaced: true, unclaimed: true })).status, 200);
    assert.deepEqual(await eligibleWakePathSignalIds(agent.principalId), [], "pre-release backlog is not stale");
    assert.equal(await receiptWakePath(backlog, agent.principalId), false);
    const noCutoff = replaceOnce(eligibleViewBody(),
      "  AND d.enqueued_at >= (SELECT applied_at FROM swarm.wake_path_release WHERE singleton)\n", "");
    await sql.begin(async (tx) => {
      await tx.unsafe(`CREATE OR REPLACE VIEW swarm.wake_path_eligible_deliveries${noCutoff}`);
      const rows = await tx<{ signal_id: string }[]>`SELECT signal_id::text FROM swarm.wake_path_eligible_deliveries
        WHERE workspace_id = ${shared.workspace}::uuid AND principal_id = ${agent.principalId}::uuid`;
      assert.deepEqual(rows.map(row => row.signal_id), [backlog], "only the cutoff excludes the backlog");
      throw new Error("ROLLBACK_NO_CUTOFF");
    }).catch(error => {
      if (!(error instanceof Error) || error.message !== "ROLLBACK_NO_CUTOFF") throw error;
    });
  } finally {
    await sql`UPDATE swarm.wake_path_release SET applied_at = ${cutoff.applied_at} WHERE singleton`;
  }
});

test("same-transaction validation retains the exclusive lock described by the migration", { timeout: 10_000 }, async () => {
  const migration = readFileSync(fileURLToPath(new URL("../../supabase/migrations/20260925000001_unclaimed_observed_ack.sql", import.meta.url)), "utf8");
  assert.match(migration, /holds ACCESS EXCLUSIVE through\s*-- VALIDATE and commit/);
  const agent = await seedAgent("wake-lock-probe");
  await postAsk(agent.principalId);
  await sql.begin(async (tx) => {
    await tx`CREATE TEMP TABLE itemg_lock_probe AS SELECT * FROM swarm.signal_deliveries WHERE false`;
    await tx`INSERT INTO itemg_lock_probe
      SELECT d.* FROM (SELECT * FROM swarm.signal_deliveries WHERE acked_at IS NULL LIMIT 1) AS d
      CROSS JOIN generate_series(1, 100000)`;
    const [size] = await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM itemg_lock_probe`;
    assert.equal(size?.count, 100000);
    await tx`ALTER TABLE itemg_lock_probe ADD CONSTRAINT itemg_probe
      CHECK (acked_at IS NULL OR (ack_outcome = 'observed' AND last_error_code IS NULL)) NOT VALID`;
    await tx`ALTER TABLE itemg_lock_probe VALIDATE CONSTRAINT itemg_probe`;
    const locks = await tx<{ mode: string }[]>`
      SELECT mode FROM pg_locks WHERE pid = pg_backend_pid()
        AND relation = 'itemg_lock_probe'::regclass`;
    assert.ok(locks.some(lock => lock.mode === "AccessExclusiveLock"));
    throw new Error("ROLLBACK_LOCK_PROBE");
  }).catch(error => {
    if (!(error instanceof Error) || error.message !== "ROLLBACK_LOCK_PROBE") throw error;
  });
});

test("box functional proof exits nonzero for missing and ineligible seeds", { timeout: 30_000 }, async () => {
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim().split("\n").filter(name => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1, "one local Supabase database container");
  const proof = fileURLToPath(new URL("../../deploy/release-proofs/item-g/20260925000001-functional.sql", import.meta.url));
  const proofSql = readFileSync(proof, "utf8");
  const runProof = (seed?: string, setup = "") => {
    const args = ["exec", "-i", containers[0]!, "psql", "-X", "-U", "postgres", "-d", "postgres",
      "-v", "ON_ERROR_STOP=1", ...(seed ? ["-v", `item_g_seed_signal_id=${seed}`] : [])];
    const script = `BEGIN;\n${setup}\n${proofSql}\nROLLBACK;\n`;
    const result = spawnSync("docker", args, { input: script, encoding: "utf8", timeout: 5_000 });
    assert.ifError(result.error);
    return { code: result.status, output: result.stdout + result.stderr };
  };
  const missing = runProof();
  assert.notEqual(missing.code, 0);
  assert.match(missing.output, /item_g_seed_signal_id is required/);
  const agent = await seedAgent("proof-seed");
  const known = await postAsk(agent.principalId);
  const command = { kind: "ack_agent_delivery", signal_id: known, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true };
  assert.equal((await runCmd(agent.token, command)).status, 200);
  const seed = await postAsk(agent.principalId);
  assert.equal(runProof(seed).code, 0, "the exact eligible seed is a positive control");
  const eligibility = /seed signal is not an eligible live unobserved delivery for a known, active seat/;
  for (const setup of [
    `UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = '${agent.principalId}'::uuid;`,
    `DELETE FROM swarm.memberships WHERE workspace_id = '${shared.workspace}'::uuid AND user_id = '${shared.ownerId}'::uuid;`,
    // The same columns the edge writes for an unclaimed observed ack (an acked row needs delivered_at).
    `UPDATE swarm.signal_deliveries SET acked_at = statement_timestamp(), ack_outcome = 'observed', last_error_code = NULL, delivered_at = COALESCE(delivered_at, statement_timestamp()), surfaced_at = COALESCE(surfaced_at, statement_timestamp()), updated_at = statement_timestamp() WHERE signal_id = '${seed}'::uuid;`,
    `ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only; UPDATE swarm.signals SET created_at = statement_timestamp() - interval '10 seconds', until = statement_timestamp() - interval '1 second' WHERE id = '${seed}'::uuid;`,
  ]) {
    const result = runProof(seed, setup);
    assert.notEqual(result.code, 0, setup);
    assert.match(result.output, eligibility, setup);
  }
  const unknown = runProof(randomUUID());
  assert.notEqual(unknown.code, 0);
  assert.match(unknown.output, eligibility);
  const competitor = await postAsk(agent.principalId);
  const competing = runProof(seed);
  assert.notEqual(competing.code, 0);
  assert.match(competing.output, /seed seat has other eligible mail/);
  assert.ok(competitor);
  const laterObserved = runProof(seed,
    `UPDATE swarm.signal_deliveries SET acked_at = statement_timestamp(), ack_outcome = 'observed', last_error_code = NULL, delivered_at = COALESCE(delivered_at, statement_timestamp()), surfaced_at = COALESCE(surfaced_at, statement_timestamp()), updated_at = statement_timestamp() WHERE signal_id = '${competitor}'::uuid;`);
  assert.notEqual(laterObserved.code, 0);
  assert.match(laterObserved.output, eligibility,
    "the shared source must reject a seed hidden by a later observed ACK");
  const removeCompetitor = `UPDATE swarm.signal_deliveries SET
    enqueued_at = (SELECT enqueued_at - interval '1 minute' FROM swarm.signal_deliveries WHERE signal_id = '${seed}'::uuid),
    acked_at = statement_timestamp(), ack_outcome = 'observed', last_error_code = NULL,
    delivered_at = COALESCE(delivered_at, statement_timestamp()),
    surfaced_at = COALESCE(surfaced_at, statement_timestamp()), updated_at = statement_timestamp()
    WHERE signal_id = '${competitor}'::uuid;
    ALTER TABLE swarm.signals DISABLE TRIGGER signals_append_only;
    UPDATE swarm.signals SET created_at =
      (SELECT created_at - interval '1 minute' FROM swarm.signals WHERE id = '${seed}'::uuid)
      WHERE id = '${competitor}'::uuid;
    ALTER TABLE swarm.signals ENABLE TRIGGER signals_append_only;`;
  const viewOmitted = runProof(seed, `${removeCompetitor} CREATE OR REPLACE VIEW swarm_read.agent_wake_path WITH (security_barrier = true) AS
    SELECT workspace_id, principal_id, min(enqueued_at) AS oldest_unobserved_at
    FROM swarm_read.agent_wake_path_deliveries WHERE false GROUP BY workspace_id, principal_id;`);
  assert.notEqual(viewOmitted.code, 0);
  assert.match(viewOmitted.output, /wake-path view omitted exact seeded unobserved delivery/);
  const migration = readFileSync(fileURLToPath(new URL("../../supabase/migrations/20260925000001_unclaimed_observed_ack.sql", import.meta.url)), "utf8");
  const detailView = migration.split("CREATE VIEW swarm_read.agent_wake_path_deliveries", 2)[1]!
    .split("ALTER VIEW swarm_read.agent_wake_path_deliveries", 1)[0]!;
  const memberGate = "WHERE swarm.is_member(d.workspace_id, auth.uid())";
  assert.equal(detailView.split(memberGate).length, 2, "the mutation must find the member gate once");
  const noMemberGate = runProof(seed,
    `${removeCompetitor} CREATE OR REPLACE VIEW swarm_read.agent_wake_path_deliveries${detailView.replace(
      memberGate, "WHERE true")}`);
  assert.notEqual(noMemberGate.code, 0);
  assert.match(noMemberGate.output, /wake-path view exposed a row to a nonmember/);
  const noAnonymousGate = runProof(seed,
    `${removeCompetitor} CREATE OR REPLACE VIEW swarm_read.agent_wake_path_deliveries${detailView.replace(
      memberGate,
      "WHERE (swarm.is_member(d.workspace_id, auth.uid()) OR auth.uid() IS NULL)")}`);
  assert.notEqual(noAnonymousGate.code, 0);
  assert.match(noAnonymousGate.output, /wake-path view exposed a row without member identity/);
});

test("unclaimed check observation cannot change a claimed queued row", async () => {
  const agent = await seedAgent("unclaimed-claimed");
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const claim = await runCmd(agent.token, { kind: "claim_agent_inbox", listener_instance_id: listener });
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const leaseId = String((claim.body.deliveries as Array<Record<string, unknown>>)[0]?.lease_id);
  const queued = await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: leaseId, listener_instance_id: listener, outcome: "queued", last_error_code: null });
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const refusal = await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true });
  assert.equal(refusal.status, 409, JSON.stringify(refusal.body));
  assert.equal(refusal.body.error, "delivery_ack_conflict");
  assert.equal((await deliveryRow(signalId, agent.principalId)).ack_outcome, "queued");
  const terminal = await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null, outcome: "observed", last_error_code: null });
  assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
  const terminalBefore = await deliveryRow(signalId, agent.principalId);
  const terminalRefusal = await runCmd(agent.token, { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true });
  assert.equal(terminalRefusal.status, 409, JSON.stringify(terminalRefusal.body));
  assert.equal(terminalRefusal.body.error, "delivery_ack_conflict");
  assert.deepEqual(await deliveryRow(signalId, agent.principalId), terminalBefore);
});

test("managed unclaimed observation accepts a current proof for an enqueued row", { timeout: 30_000 }, async () => {
  const agent = await seedAgent("unclaimed-managed");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  assert.equal((await deliveryRow(signalId, agent.principalId)).session_id, null);
  const command = { kind: "ack_agent_delivery", signal_id: signalId,
    lease_id: null, listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true };
  const stale = await runCmd(agent.token, command,
    { headers: proofHeaders(held.sessionId, held.generation + 1, held.key) });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.error, "session_conflict", "generic session fence refuses stale proof");
  assert.equal((await deliveryRow(signalId, agent.principalId)).acked_at, null);
  const current = await runCmd(agent.token, command,
    { headers: proofHeaders(held.sessionId, held.generation, held.key) });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal((await deliveryRow(signalId, agent.principalId)).ack_outcome, "observed");
});

test("recovery reclaims a queued unsurfaced row; new holder claims it; attempt unchanged", async () => {
  const agent = await seedAgent("reclaim-queued");
  const held = await holdSession(agent);
  const signalId = await postAsk(agent.principalId);
  const listener = randomUUID();
  const headers = proofHeaders(held.sessionId, held.generation, held.key);
  const claim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: listener },
    { headers },
  );
  assert.equal(claim.status, 200, JSON.stringify(claim.body));
  const deliveries = claim.body.deliveries as Array<Record<string, unknown>>;
  const leaseId = String(deliveries[0]?.lease_id);
  const queued = await runCmd(
    agent.token,
    {
      kind: "ack_agent_delivery",
      signal_id: signalId,
      lease_id: leaseId,
      listener_instance_id: listener,
      outcome: "queued",
      last_error_code: null,
      surfaced: false,
    },
    { headers },
  );
  assert.equal(queued.status, 200, JSON.stringify(queued.body));
  const before = await deliveryRow(signalId, agent.principalId);
  assert.equal(before.ack_outcome, "queued");
  assert.equal(before.surfaced_at, null);
  const attempts = before.attempt_count;
  const recovered = await runCmd(shared.ownerJwt, {
    kind: "recover_agent_session",
    principal_id: agent.principalId,
  });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  const mid = await deliveryRow(signalId, agent.principalId);
  assert.equal(mid.session_id, null);
  assert.equal(mid.session_generation, null);
  assert.equal(mid.lease_id, null);
  assert.equal(mid.acked_at, null);
  assert.equal(mid.attempt_count, attempts);
  const nextSession = randomUUID();
  const nextKey = synthKey();
  const nextHold = await acquire(agent.token, nextSession, nextKey);
  assert.equal(nextHold.status, 200, JSON.stringify(nextHold.body));
  const nextGeneration = Number(nextHold.body.generation);
  const reclaim = await runCmd(
    agent.token,
    { kind: "claim_agent_inbox", listener_instance_id: randomUUID() },
    { headers: proofHeaders(nextSession, nextGeneration, nextKey) },
  );
  assert.equal(reclaim.status, 200, JSON.stringify(reclaim.body));
  const reclaimed = reclaim.body.deliveries as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(reclaimed) && reclaimed.length >= 1);
  const reclaimedId = String(
    (reclaimed[0]?.signal as { id?: string } | undefined)?.id,
  );
  assert.equal(reclaimedId, signalId);
  const after = await deliveryRow(signalId, agent.principalId);
  assert.equal(after.attempt_count, attempts);
  assert.equal(after.session_id, nextSession);
  assert.equal(Number(after.session_generation), nextGeneration);
});
