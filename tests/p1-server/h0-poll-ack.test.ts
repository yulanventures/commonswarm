/**
 * H0 poll, ack, and the command-edge claim fence, against local Postgres.
 *
 * Gate: `npm run test:p1-server` globs tests/p1-server. Run that script alone.
 * This file refuses any non-loopback URL from `supabase status`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import { H0_CACHE_CONTROL, H0_ROBOTS_TAG } from "../../supabase/functions/h0/core.js";
import {
  H0_BEARER_QUERY_REFUSED,
  H0_POLL_IN_PROGRESS,
  H0_POLL_IN_PROGRESS_MESSAGE,
  H0_POLL_IN_PROGRESS_STATUS,
  H0_POLL_WAIT_REFUSED,
} from "../../supabase/functions/h0/parse.js";
import {
  H0_SEAT_CLAIM_REFUSED,
  H0_SEAT_CLAIM_REFUSED_MESSAGE,
} from "../../supabase/functions/command/h0-seat.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Owner {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
}

interface Seat {
  token: string;
  principalId: string;
}

interface HttpResult {
  status: number;
  headers: Headers;
  body: Record<string, unknown>;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let owner: Owner;
let joinSecret: string;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  for (const raw of [parsed.API_URL, parsed.DB_URL]) {
    const url = new URL(raw!);
    assert.ok(
      url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]",
      `h0 server test refuses non-loopback target ${url.hostname}`,
    );
  }
  return parsed as LocalEnvironment;
}

async function createUser(): Promise<{ id: string; jwt: string }> {
  const email = `h0-poll-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
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

async function command(
  bearer: string,
  body: Record<string, unknown>,
  workspaceId = owner.workspace,
): Promise<HttpResult> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command: body,
    }),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json() as Record<string, unknown>,
  };
}

async function makeSeat(): Promise<Seat> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${joinSecret}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: randomUUID(),
      stream: { kind: "repo", repo_mapping_id: randomUUID() },
      command: {
        kind: "register_agent_seat",
        attempt_id: randomUUID(),
        name: "H0 poll seat",
      },
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  assert.equal(response.status, 200, String(body.error ?? "register failed"));
  assert.equal(typeof body.agent_token, "string");
  assert.equal(typeof body.principal_id, "string");
  return { token: String(body.agent_token), principalId: String(body.principal_id) };
}

async function plainAgent(): Promise<Seat> {
  const principalId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const deviceId = randomUUID();
  const runId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${deviceId}::uuid, ${owner.ownerId}::uuid, 'plain-agent')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid, ${owner.workspace}::uuid, ${owner.ownerId}::uuid, 'plain-agent'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid,
        ${principalId}::uuid,
        ${runId}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()},
        statement_timestamp() + interval '1 hour',
        ${randomUUID()}::uuid
      )
    `;
  });
  return { token, principalId };
}

async function postAsk(principalId: string): Promise<string> {
  const posted = await command(owner.ownerJwt, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `h0 poll ${randomUUID()}`,
    to_user_id: null,
    about: null,
    to_agent_principal_id: principalId,
    in_reply_to: null,
  });
  assert.equal(posted.status, 200, JSON.stringify(posted.body));
  const signal = posted.body.signal as { id?: string } | undefined;
  assert.equal(typeof signal?.id, "string");
  return signal.id!;
}

async function h0(
  path: "poll" | "ack",
  token: string | null,
  body: Record<string, unknown>,
  query = "",
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${local.API_URL}/functions/v1/h0/${path}${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: response.headers,
    body: await response.json() as Record<string, unknown>,
  };
}

function assertVerbHeaders(headers: Headers): void {
  assert.equal(headers.get("cache-control"), H0_CACHE_CONTROL);
  assert.equal(headers.get("x-robots-tag"), H0_ROBOTS_TAG);
}

interface DeliveryRow {
  lease_id: string | null;
  acked_at: Date | null;
  attempt_count: number;
  ack_outcome: string | null;
  lease_expiry_count: number;
}

async function delivery(signalId: string, principalId: string): Promise<DeliveryRow> {
  const rows = await sql<DeliveryRow[]>`
    SELECT lease_id::text, acked_at, attempt_count, ack_outcome, lease_expiry_count
    FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${principalId}::uuid
  `;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

function deliveriesOf(body: Record<string, unknown>): Array<{
  signal: { id: string };
  lease_id: string;
}> {
  const rows = body.deliveries;
  assert.ok(Array.isArray(rows));
  return rows as Array<{ signal: { id: string }; lease_id: string }>;
}

describe("h0 poll and ack", { concurrency: false }, () => {
before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 4 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-h0-poll-env-"));
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
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) {
      throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    }
    await delay(250);
  }
  for (const edge of ["command", "h0/poll"]) {
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/${edge}`,
      fetcher: fetch,
      timeoutMs: 30_000,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      diagnostics: () => `${edge} function logs:\n${functionLogs.slice(-4000)}`,
    });
  }
  const user = await createUser();
  const workspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user.id}::uuid, 'H0 Poll Owner')`;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'H0 Poll', ${user.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${user.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')
    `;
  });
  owner = { workspace, ownerId: user.id, ownerJwt: user.jwt };
  const minted = await command(owner.ownerJwt, {
    kind: "mint_agent_join_credential",
    seat_cap: 10,
    ttl_hours: 4,
  });
  assert.equal(minted.status, 200, String(minted.body.error ?? "mint failed"));
  assert.equal(typeof minted.body.join_credential, "string");
  joinSecret = String(minted.body.join_credential);
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess?.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
    if (!stopped && functionProcess.exitCode === null) functionProcess.kill("SIGKILL");
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("an H0 seat claim is refused, its ack is accepted, and a plain seat still claims", async () => {
  const seat = await makeSeat();
  const signalId = await postAsk(seat.principalId);
  const claim = await command(seat.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: randomUUID(),
    limit: 10,
  });
  assert.equal(claim.status, 403, String(claim.body.error ?? "claim was not refused"));
  assert.equal(claim.body.error, H0_SEAT_CLAIM_REFUSED);
  assert.equal(claim.body.message, H0_SEAT_CLAIM_REFUSED_MESSAGE);
  const before = await delivery(signalId, seat.principalId);
  assert.equal(before.lease_id, null);
  assert.equal(before.attempt_count, 0);

  const polled = await h0("poll", seat.token, { wait: 0 });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assertVerbHeaders(polled.headers);
  const rows = deliveriesOf(polled.body);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.signal.id, signalId);
  const listener = polled.body.listener_instance_id;
  assert.equal(typeof listener, "string");

  const acked = await command(seat.token, {
    kind: "ack_agent_delivery",
    signal_id: signalId,
    lease_id: rows[0]!.lease_id,
    listener_instance_id: listener,
    outcome: "replied",
    last_error_code: null,
  });
  assert.equal(acked.status, 200, JSON.stringify(acked.body));
  const afterAck = await delivery(signalId, seat.principalId);
  assert.equal(afterAck.ack_outcome, "replied");
  assert.ok(afterAck.acked_at);

  const plain = await plainAgent();
  const plainSignal = await postAsk(plain.principalId);
  const plainClaim = await command(plain.token, {
    kind: "claim_agent_inbox",
    listener_instance_id: randomUUID(),
    limit: 10,
  });
  assert.equal(plainClaim.status, 200, JSON.stringify(plainClaim.body));
  const plainRows = plainClaim.body.deliveries as Array<{ signal: { id: string } }>;
  assert.ok(plainRows.some((row) => row.signal.id === plainSignal));
  const marker = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM swarm.agent_join_attempts
    WHERE principal_id = ${plain.principalId}::uuid
  `;
  assert.equal(marker[0]?.n, 0);
});

test("poll returns own unacknowledged leases first, then new rows", async () => {
  const seat = await makeSeat();
  const older = await postAsk(seat.principalId);
  const first = await h0("poll", seat.token, { wait: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstRows = deliveriesOf(first.body);
  assert.equal(firstRows.length, 1);
  assert.equal(firstRows[0]!.signal.id, older);
  const firstLease = firstRows[0]!.lease_id;
  const listener = String(first.body.listener_instance_id);
  const batchId = String(first.body.batchId);

  const newer = await postAsk(seat.principalId);
  const second = await h0("poll", seat.token, { wait: 0, ackBatch: batchId });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondRows = deliveriesOf(second.body);
  assert.deepEqual(secondRows.map((row) => row.signal.id), [older, newer]);
  assert.equal(secondRows[0]!.lease_id, firstLease);
  assert.notEqual(secondRows[1]!.lease_id, firstLease);
  assert.equal(second.body.listener_instance_id, listener);
  const olderRow = await delivery(older, seat.principalId);
  assert.equal(olderRow.attempt_count, 1);
  assert.equal(olderRow.lease_id, firstLease);
});

test("one active batch per seat is enforced by the schema", async () => {
  const seat = await makeSeat();
  await postAsk(seat.principalId);
  const polled = await h0("poll", seat.token, { wait: 0 });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assert.equal(typeof polled.body.batchId, "string");
  const active = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM swarm.h0_poll_batches
    WHERE principal_id = ${seat.principalId}::uuid
      AND status = 'active'
  `;
  assert.equal(active[0]?.n, 1);
  await assert.rejects(
    sql`
      INSERT INTO swarm.h0_poll_batches (
        workspace_id, principal_id, batch_id, lease_ids, status, expires_at
      )
      SELECT workspace_id, principal_id, ${randomUUID()}::uuid, lease_ids, 'active', expires_at
      FROM swarm.h0_poll_batches
      WHERE principal_id = ${seat.principalId}::uuid
        AND status = 'active'
    `,
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === "23505",
  );
  const replay = await h0("poll", seat.token, { wait: 0 });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.batchId, polled.body.batchId);
  const stillOne = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM swarm.h0_poll_batches
    WHERE principal_id = ${seat.principalId}::uuid
      AND status = 'active'
  `;
  assert.equal(stillOne[0]?.n, 1);
});

test("ackBatch closes the batch and leaves delivery rows untouched", async () => {
  const seat = await makeSeat();
  const signalId = await postAsk(seat.principalId);
  const polled = await h0("poll", seat.token, { wait: 0 });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  const before = await delivery(signalId, seat.principalId);
  const closed = await h0("poll", seat.token, {
    wait: 0,
    ackBatch: String(polled.body.batchId),
  });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  const after = await delivery(signalId, seat.principalId);
  assert.equal(after.lease_id, before.lease_id);
  assert.equal(after.acked_at, before.acked_at);
  assert.equal(after.attempt_count, before.attempt_count);
  assert.equal(after.ack_outcome, before.ack_outcome);
  const batch = await sql<{ status: string }[]>`
    SELECT status
    FROM swarm.h0_poll_batches
    WHERE batch_id = ${String(polled.body.batchId)}::uuid
  `;
  assert.equal(batch[0]?.status, "closed");
});

test("an expired batch closes and its rows re-claim through the normal path", async () => {
  const seat = await makeSeat();
  const signalId = await postAsk(seat.principalId);
  const polled = await h0("poll", seat.token, { wait: 0 });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  const firstLease = deliveriesOf(polled.body)[0]!.lease_id;
  await sql`
    UPDATE swarm.h0_poll_batches
    SET expires_at = statement_timestamp() - interval '1 minute'
    WHERE batch_id = ${String(polled.body.batchId)}::uuid
  `;
  await sql`
    UPDATE swarm.signal_deliveries
    SET
      leased_until = statement_timestamp() - interval '1 minute',
      updated_at = statement_timestamp() - interval '2 minutes'
    WHERE signal_id = ${signalId}::uuid
      AND recipient_agent_principal_id = ${seat.principalId}::uuid
  `;
  const again = await h0("poll", seat.token, { wait: 0 });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  const next = deliveriesOf(again.body);
  assert.equal(next.length, 1);
  assert.equal(next[0]!.signal.id, signalId);
  assert.notEqual(next[0]!.lease_id, firstLease);
  assert.notEqual(again.body.batchId, polled.body.batchId);
  const row = await delivery(signalId, seat.principalId);
  assert.equal(row.attempt_count, 2);
  assert.equal(row.lease_expiry_count, 1);
  assert.equal(row.lease_id, next[0]!.lease_id);
  const old = await sql<{ status: string }[]>`
    SELECT status FROM swarm.h0_poll_batches
    WHERE batch_id = ${String(polled.body.batchId)}::uuid
  `;
  assert.equal(old[0]?.status, "closed");
});

test("a second concurrent poll gets the documented response", async () => {
  const seat = await makeSeat();
  const started = Date.now();
  const firstPromise = h0("poll", seat.token, { wait: 2 });
  const seen = Date.now() + 3_000;
  let locked = false;
  while (Date.now() < seen) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
        AND expires_at > statement_timestamp()
    `;
    if ((rows[0]?.n ?? 0) > 0) {
      locked = true;
      break;
    }
    await delay(50);
  }
  assert.equal(locked, true, "the first poll did not publish its lock");
  const secondStarted = Date.now();
  const second = await h0("poll", seat.token, { wait: 0 });
  const secondMs = Date.now() - secondStarted;
  assert.ok(secondMs < 1_000, `second poll blocked for ${secondMs}ms`);
  assert.equal(second.status, H0_POLL_IN_PROGRESS_STATUS);
  assert.equal(second.body.error, H0_POLL_IN_PROGRESS);
  assert.equal(second.body.message, H0_POLL_IN_PROGRESS_MESSAGE);
  assertVerbHeaders(second.headers);
  const first = await firstPromise;
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.batchId, null);
  assert.equal(typeof first.body.listener_instance_id, "string");
  assert.ok(Date.now() - started >= 1_500, "the first poll did not wait");
});

test("wait above 50 is refused and a bearer in the query string is refused", async () => {
  const seat = await makeSeat();
  const tooLong = await h0("poll", seat.token, { wait: 51 });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error, H0_POLL_WAIT_REFUSED);
  assertVerbHeaders(tooLong.headers);
  const locks = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.h0_poll_locks
    WHERE principal_id = ${seat.principalId}::uuid
  `;
  assert.equal(locks[0]?.n, 0);

  const queried = await h0("poll", seat.token, { wait: 0 }, `?access_token=${seat.token}`);
  assert.equal(queried.status, 400);
  assert.equal(queried.body.error, H0_BEARER_QUERY_REFUSED);
  assertVerbHeaders(queried.headers);
  const queryOnly = await h0("poll", null, { wait: 0 }, `?token=${seat.token}`);
  assert.equal(queryOnly.status, 400);
  assert.equal(queryOnly.body.error, H0_BEARER_QUERY_REFUSED);
});

test("h0 ack advances one delivery and keeps the listener id", async () => {
  const seat = await makeSeat();
  const empty = await h0("poll", seat.token, { wait: 0 });
  assert.equal(empty.status, 200, JSON.stringify(empty.body));
  const listener = String(empty.body.listener_instance_id);
  const signalId = await postAsk(seat.principalId);
  const polled = await h0("poll", seat.token, { wait: 0 });
  assert.equal(polled.status, 200, JSON.stringify(polled.body));
  assert.equal(polled.body.listener_instance_id, listener);
  const row = deliveriesOf(polled.body)[0]!;
  const acked = await h0("ack", seat.token, {
    signal_id: signalId,
    lease_id: row.lease_id,
    listener_instance_id: listener,
    outcome: "replied",
    last_error_code: null,
  });
  assert.equal(acked.status, 200, JSON.stringify(acked.body));
  assert.equal(acked.body.signal_id, signalId);
  assert.equal(acked.body.outcome, "replied");
  assertVerbHeaders(acked.headers);
  const stored = await delivery(signalId, seat.principalId);
  assert.equal(stored.ack_outcome, "replied");
});
});
