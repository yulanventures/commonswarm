/**
 * H0 poll, ack, and the command-edge claim fence, against local Postgres.
 *
 * Gate: `npm run test:p1-server` globs tests/p1-server. Run that script alone.
 * This file refuses any non-loopback URL from `supabase status`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
  H0_ACK_BATCH_MISMATCH,
  H0_ACK_BATCH_MISMATCH_MESSAGE,
  H0_BEARER_QUERY_REFUSED,
  H0_POLL_IN_PROGRESS,
  H0_POLL_IN_PROGRESS_MESSAGE,
  H0_POLL_IN_PROGRESS_STATUS,
  H0_POLL_LOCK_ENDED,
  H0_POLL_LOCK_ENDED_STATUS,
  H0_POLL_WAIT_REFUSED,
} from "../../supabase/functions/h0/parse.js";
import {
  H0_MAX_CONCURRENT_WAITS,
  H0_POLL_RETRY_AFTER_SECONDS,
} from "../../src/h0/verbs.js";
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

async function makeSeat(secret?: string): Promise<Seat> {
  // Each seat gets its own credential. A shared ten-seat cap makes unrelated
  // cases depend on how many earlier tests registered.
  let mintedId: string | undefined;
  if (secret === undefined) {
    const minted = await command(owner.ownerJwt, {
      kind: "mint_agent_join_credential",
      seat_cap: 1,
      ttl_hours: 4,
    });
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    secret = String(minted.body.join_credential);
    mintedId = String(minted.body.join_credential_id);
  }
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${secret}`,
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
  if (mintedId !== undefined) {
    const revoked = await command(owner.ownerJwt, {
      kind: "revoke_agent_join_credential",
      join_credential_id: mintedId,
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  }
  return { token: String(body.agent_token), principalId: String(body.principal_id) };
}

async function seatInNewWorkspace(): Promise<Seat> {
  const user = await createUser();
  const workspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user.id}::uuid, 'H0 Poll Other')`;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'H0 Poll Other', ${user.id}::uuid)
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
  const minted = await command(user.jwt, {
    kind: "mint_agent_join_credential",
    seat_cap: 10,
    ttl_hours: 4,
  }, workspace);
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  assert.equal(typeof minted.body.join_credential, "string");
  return await makeSeat(String(minted.body.join_credential));
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
  if (signal === undefined || typeof signal.id !== "string") {
    assert.fail(JSON.stringify(posted.body));
  }
  return signal.id;
}

async function h0(
  path: "poll" | "ack",
  token: string | null,
  body: Record<string, unknown>,
  query = "",
  signal?: AbortSignal,
): Promise<HttpResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${local.API_URL}/functions/v1/h0/${path}${query}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
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
});

test("H0 poll refuses a seat with a fresh watcher lease and succeeds after it goes stale", { timeout: 20_000 }, async () => {
  const seat = await makeSeat();
  await sql`INSERT INTO swarm.agent_wake_leases
    (workspace_id, principal_id, watcher_id, host_label, host_id, host_session_ref,
     generation, claimed_at, renewed_at)
    VALUES (${owner.workspace}::uuid, ${seat.principalId}::uuid,
      ${randomUUID()}::uuid, 'other-host', ${randomUUID()}::uuid, NULL, 1,
      clock_timestamp(), clock_timestamp())`;
  try {
    const refused = await h0("poll", seat.token, { wait: 0 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, "notify_held_elsewhere");
    assert.equal(refused.body.surface, "watcher");
    assert.equal(refused.body.host_label, "other-host");
    await sql`UPDATE swarm.agent_wake_leases SET renewed_at = clock_timestamp() - interval '4 minutes'
      WHERE workspace_id = ${owner.workspace}::uuid AND principal_id = ${seat.principalId}::uuid`;
    const allowed = await h0("poll", seat.token, { wait: 0 });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  } finally {
    await sql`DELETE FROM swarm.agent_wake_leases
      WHERE workspace_id = ${owner.workspace}::uuid AND principal_id = ${seat.principalId}::uuid`;
  }
});

test("a watcher claim for a real H0 seat names its fresh poll lock", { timeout: 20_000 }, async () => {
  const seat = await makeSeat();
  await sql`INSERT INTO swarm.h0_poll_locks
    (workspace_id, principal_id, holder, listener_instance_id, acquired_at, expires_at)
    VALUES (${owner.workspace}::uuid, ${seat.principalId}::uuid,
      ${randomUUID()}::uuid, ${randomUUID()}::uuid, clock_timestamp(),
      clock_timestamp() + interval '1 minute')`;
  const claim = await command(seat.token, { kind: "claim_wake_lease",
    watcher_id: randomUUID(), host_label: "h0-seat-host", host_id: randomUUID(),
    take_over: true });
  assert.equal(claim.status, 409);
  assert.equal(claim.body.error, "notify_held_elsewhere");
  assert.equal(claim.body.surface, "h0_poll");
  await sql`UPDATE swarm.h0_poll_locks SET expires_at = clock_timestamp()
    WHERE workspace_id = ${owner.workspace}::uuid AND principal_id = ${seat.principalId}::uuid`;
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

test("a waiting slice and a second poll use one principal-seat lock order", { timeout: 20_000 }, async () => {
  const seat = await makeSeat();
  let firstSettled = false;
  const first = h0("poll", seat.token, { wait: 5 });
  void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const rows = await sql<{ waiting: boolean }[]>`
      SELECT waiting FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
    `;
    if (rows[0]?.waiting) break;
    await delay(40);
  }
  const waiting = await sql<{ waiting: boolean }[]>`
    SELECT waiting FROM swarm.h0_poll_locks
    WHERE principal_id = ${seat.principalId}::uuid
  `;
  assert.equal(waiting[0]?.waiting, true, "first poll did not enter its wait");
  let second: Promise<HttpResult> | undefined;
  await sql.begin(async (tx) => {
    await tx`
      SELECT principal_id FROM swarm.agent_principals
      WHERE principal_id = ${seat.principalId}::uuid FOR SHARE
    `;
    // The first slice now waits for principal FOR NO KEY UPDATE. In the old order
    // it held the seat row while waiting to upgrade its principal lock.
    await delay(1_200);
    const unlockedSeat = await sql<{ holder: string }[]>`
      SELECT holder::text FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid FOR UPDATE NOWAIT
    `;
    assert.equal(unlockedSeat.length, 1, "the waiting slice locked the seat before the principal");
    second = h0("poll", seat.token, { wait: 0 });
    await delay(1_200);
    assert.equal(firstSettled, false, "first poll ended before the overlap");
  });
  const overlap = await second!;
  assert.equal(overlap.status, H0_POLL_IN_PROGRESS_STATUS, JSON.stringify(overlap.body));
  assert.equal(overlap.body.error, H0_POLL_IN_PROGRESS);
  assert.equal(firstSettled, false, "first poll stopped waiting after the overlap");
  const finished = await first;
  assert.equal(finished.status, 200, JSON.stringify(finished.body));
});

test("a slice blocked on its seat row cannot collect after the lock ends", { timeout: 25_000 }, async () => {
  const seat = await makeSeat();
  let firstSettled = false;
  const firstPromise = h0("poll", seat.token, { wait: 4 });
  void firstPromise.then(() => { firstSettled = true; }, () => { firstSettled = true; });
  const deadline = Date.now() + 4_000;
  let waiting = false;
  while (Date.now() < deadline) {
    const rows = await sql<{ waiting: boolean }[]>`
      SELECT waiting FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
    `;
    if (rows[0]?.waiting) { waiting = true; break; }
    await delay(40);
  }
  assert.equal(waiting, true, "first poll did not enter its wait");
  let secondPromise: Promise<HttpResult> | undefined;
  let signalId = "";
  await sql.begin(async (tx) => {
    await tx`
      SELECT holder FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid FOR UPDATE
    `;
    signalId = await postAsk(seat.principalId);
    await delay(1_500);
    assert.equal(firstSettled, false, "slice collected while another transaction held its lock row");
    await tx`
      UPDATE swarm.h0_poll_locks
      SET expires_at = statement_timestamp() - interval '1 second'
      WHERE principal_id = ${seat.principalId}::uuid
    `;
    secondPromise = h0("poll", seat.token, { wait: 0 });
    await delay(100);
  });
  const [first, second] = await Promise.all([firstPromise, secondPromise!]);
  assert.equal(first.status, H0_POLL_LOCK_ENDED_STATUS,
    `${JSON.stringify(first.body)}; edge codes: ${functionLogs.match(/h0 poll failed[^\n]*/g)?.join("; ") ?? "none"}`);
  assert.equal(first.body.error, H0_POLL_LOCK_ENDED);
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(deliveriesOf(second.body)[0]?.signal.id, signalId);
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

test("one waiting poll is admitted for the whole deployment", { timeout: 30_000 }, async () => {
  const home = await makeSeat();
  const other = await seatInNewWorkspace();
  const parked = await makeSeat();
  const workspaces = await sql<{ principal_id: string; workspace_id: string }[]>`
    SELECT principal_id::text, workspace_id::text
    FROM swarm.agent_principals
    WHERE principal_id IN (${home.principalId}::uuid, ${other.principalId}::uuid)
  `;
  assert.equal(workspaces.length, 2);
  assert.notEqual(workspaces[0]?.workspace_id, workspaces[1]?.workspace_id);
  await sql`
    INSERT INTO swarm.h0_poll_locks (
      workspace_id, principal_id, holder, listener_instance_id,
      acquired_at, expires_at, waiting
    )
    SELECT
      workspace_id,
      principal_id,
      ${randomUUID()}::uuid,
      ${randomUUID()}::uuid,
      statement_timestamp() - interval '2 minutes',
      statement_timestamp() - interval '1 minute',
      true
    FROM swarm.agent_principals
    WHERE principal_id = ${parked.principalId}::uuid
  `;

  const waitSeconds = 4;
  const started = Date.now();
  const homePoll = h0("poll", home.token, { wait: waitSeconds });
  const otherPoll = h0("poll", other.token, { wait: waitSeconds });
  const early = await Promise.race([
    homePoll.then((body) => ({ seat: home, body })),
    otherPoll.then((body) => ({ seat: other, body })),
  ]);
  const earlyMs = Date.now() - started;
  assert.ok(
    earlyMs < 2_500,
    `the poll that could not wait took ${earlyMs}ms (cap ${H0_MAX_CONCURRENT_WAITS})`,
  );
  assert.equal(early.body.status, 200, JSON.stringify(early.body.body));
  assert.equal(early.body.body.batchId, null);
  assert.equal(typeof early.body.body.listener_instance_id, "string");
  assert.deepEqual(early.body.body.deliveries, []);
  assert.equal(early.body.body.retryAfterSeconds, H0_POLL_RETRY_AFTER_SECONDS);
  assert.equal(early.body.body.error, undefined);
  assertVerbHeaders(early.body.headers);
  assert.deepEqual(Object.keys(early.body.body).sort(), [
    "batchId",
    "deliveries",
    "listener_instance_id",
    "retryAfterSeconds",
  ]);

  const waiting = await sql<{ principal_id: string }[]>`
    SELECT principal_id::text
    FROM swarm.h0_poll_locks
    WHERE waiting
      AND expires_at > statement_timestamp()
  `;
  const waiter = early.seat === home ? other : home;
  assert.deepEqual(waiting.map((row) => row.principal_id), [waiter.principalId]);

  const late = await (early.seat === home ? otherPoll : homePoll);
  assert.ok(Date.now() - started >= 3_000, "the admitted poll did not wait");
  assert.equal(late.status, 200, JSON.stringify(late.body));
  assert.equal(late.body.batchId, null);
  assert.deepEqual(late.body.deliveries, []);
  assert.equal(late.body.retryAfterSeconds, undefined);
  assert.deepEqual(Object.keys(late.body).sort(), [
    "batchId",
    "deliveries",
    "listener_instance_id",
  ]);

  const free = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n
    FROM swarm.h0_poll_locks
    WHERE waiting
      AND expires_at > statement_timestamp()
  `;
  assert.equal(free[0]?.n, 0);

  const againStarted = Date.now();
  const againPromise = h0("poll", waiter.token, { wait: 3 });
  let held = false;
  const observeUntil = Date.now() + 3_000;
  while (Date.now() < observeUntil) {
    const rows = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM swarm.h0_poll_locks
      WHERE principal_id = ${waiter.principalId}::uuid
        AND waiting
        AND expires_at > statement_timestamp()
    `;
    if ((rows[0]?.n ?? 0) === 1) {
      held = true;
      break;
    }
    await delay(50);
  }
  assert.equal(held, true, "a poll could not wait after the slot was free");
  const again = await againPromise;
  assert.ok(Date.now() - againStarted >= 2_500, "the later poll did not wait");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.retryAfterSeconds, undefined);
  assert.equal(again.body.batchId, null);
});

/** A client abort must free the deployment slot inside this bound, not after the poll's wait. */
const ABORT_SLOT_FREE_MS = 2_000;

test("an aborted waiting poll frees the slot for another seat", { timeout: 30_000 }, async () => {
  const first = await makeSeat();
  const second = await makeSeat();
  const dir = mkdtempSync(join(tmpdir(), "h0-abort-"));
  const script = join(dir, "abort.ts");
  const handler = join(process.cwd(), "supabase/functions/h0/poll-ack.ts");
  writeFileSync(script, `
import postgres from "npm:postgres@3.4.9";
import { handleH0PollRequest } from ${JSON.stringify(handler)};

const dbUrl = Deno.env.get("SUPABASE_DB_URL");
if (!dbUrl) throw new Error("missing database url");
const sql = postgres(dbUrl, { prepare: false, max: 1 });
const firstToken = Deno.env.get("H0_FIRST_TOKEN") ?? "";
const firstId = Deno.env.get("H0_FIRST_ID") ?? "";
const secondToken = Deno.env.get("H0_SECOND_TOKEN") ?? "";
const secondId = Deno.env.get("H0_SECOND_ID") ?? "";

function pollRequest(token: string, wait: number, signal: AbortSignal): Request {
  return new Request("http://127.0.0.1/functions/v1/h0/poll", {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "content-type": "application/json",
    },
    body: JSON.stringify({ wait }),
    signal,
  });
}

const controller = new AbortController();
const pending = handleH0PollRequest(pollRequest(firstToken, 8, controller.signal));
const seenBy = Date.now() + 5_000;
let firstWaiting = false;
while (Date.now() < seenBy) {
  const rows = await sql<{ n: number }[]>\`
    SELECT count(*)::int AS n
    FROM swarm.h0_poll_locks
    WHERE principal_id = \${firstId}::uuid
      AND waiting
      AND expires_at > statement_timestamp()
  \`;
  if ((rows[0]?.n ?? 0) === 1) {
    firstWaiting = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const abortedAt = Date.now();
controller.abort();
const settled = await Promise.race([
  pending.then(() => "done", () => "done"),
  new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), ${ABORT_SLOT_FREE_MS})),
]);
const freedMs = settled === "done" ? Date.now() - abortedAt : -1;
const free = await sql<{ n: number }[]>\`
  SELECT count(*)::int AS n
  FROM swarm.h0_poll_locks
  WHERE waiting
    AND expires_at > statement_timestamp()
\`;
const slotFree = (free[0]?.n ?? 1) === 0;
const secondPending = handleH0PollRequest(pollRequest(secondToken, 3, new AbortController().signal));
let secondWaiting = false;
const admitBy = Date.now() + ${ABORT_SLOT_FREE_MS};
while (Date.now() < admitBy) {
  const rows = await sql<{ principal_id: string }[]>\`
    SELECT principal_id::text
    FROM swarm.h0_poll_locks
    WHERE waiting
      AND expires_at > statement_timestamp()
  \`;
  if (rows.length === 1 && rows[0]?.principal_id === secondId) {
    secondWaiting = true;
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}
const secondResponse = await secondPending;
const secondBody = await secondResponse.json() as { retryAfterSeconds?: number; batchId: string | null };
console.log(JSON.stringify({
  firstWaiting,
  settled,
  freedMs,
  slotFree,
  secondWaiting,
  secondStatus: secondResponse.status,
  retryAfterSeconds: secondBody.retryAfterSeconds ?? null,
  batchId: secondBody.batchId,
}));
await sql.end({ timeout: 2 });
`);
  try {
    const result = spawnSync("deno", [
      "run",
      "--no-lock",
      "--config",
      "supabase/functions/h0/deno.json",
      "--allow-env",
      "--allow-net",
      "--allow-read",
      script,
    ], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}),
        SWARM_DATABASE_URL: local.DB_URL,
        SUPABASE_DB_URL: local.DB_URL,
        H0_FIRST_TOKEN: first.token,
        H0_FIRST_ID: first.principalId,
        H0_SECOND_TOKEN: second.token,
        H0_SECOND_ID: second.principalId,
      },
      timeout: 25_000,
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const line = result.stdout.trim().split("\n").find((row) => row.startsWith("{"));
    assert.equal(typeof line, "string", result.stdout);
    const body = JSON.parse(line ?? "{}") as {
      firstWaiting: boolean;
      settled: string;
      freedMs: number;
      slotFree: boolean;
      secondWaiting: boolean;
      secondStatus: number;
      retryAfterSeconds: number | null;
      batchId: string | null;
    };
    assert.equal(body.firstWaiting, true, "the first poll did not take the waiting slot");
    assert.equal(body.settled, "done", "the aborted poll did not stop");
    assert.equal(body.slotFree, true, "the aborted poll did not release the slot");
    assert.ok(
      body.freedMs >= 0 && body.freedMs <= ABORT_SLOT_FREE_MS,
      `the slot was not free within ${ABORT_SLOT_FREE_MS}ms (freedMs ${body.freedMs})`,
    );
    assert.equal(
      body.secondWaiting,
      true,
      `the second seat was not waiting within ${ABORT_SLOT_FREE_MS}ms of the release`,
    );
    assert.equal(body.secondStatus, 200);
    assert.equal(body.retryAfterSeconds, null);
    assert.equal(body.batchId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wait ends from the lock row, not from a clock started after the claim", { timeout: 15_000 }, async () => {
  const seat = await makeSeat();
  const pending = h0("poll", seat.token, { wait: 20 });
  const seenBy = Date.now() + 3_000;
  let holder: string | null = null;
  while (Date.now() < seenBy) {
    const rows = await sql<{ holder: string }[]>`
      SELECT holder::text
      FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
        AND expires_at > statement_timestamp()
    `;
    if (rows[0] !== undefined) {
      holder = rows[0].holder;
      break;
    }
    await delay(50);
  }
  assert.equal(typeof holder, "string");
  const moved = await sql<{ holder: string }[]>`
    UPDATE swarm.h0_poll_locks
    SET
      acquired_at = statement_timestamp() - interval '1 hour',
      expires_at = statement_timestamp() + interval '1 hour'
    WHERE principal_id = ${seat.principalId}::uuid
      AND holder = ${holder}::uuid
    RETURNING holder::text
  `;
  assert.equal(moved.length, 1);
  const marked = Date.now();
  const result = await pending;
  const elapsed = Date.now() - marked;
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.retryAfterSeconds, undefined);
  assert.equal(result.body.batchId, null);
  assert.deepEqual(result.body.deliveries, []);
  assert.ok(elapsed < 5_000, `the wait outlived the lock acquisition clock: ${elapsed}ms`);
});

test("a poll whose own lock ends returns h0_poll_lock_ended", { timeout: 20_000 }, async () => {
  const seat = await makeSeat();
  const pending = h0("poll", seat.token, { wait: 8 });
  const seenBy = Date.now() + 3_000;
  let holder: string | null = null;
  while (Date.now() < seenBy) {
    const rows = await sql<{ holder: string }[]>`
      SELECT holder::text
      FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
        AND expires_at > statement_timestamp()
    `;
    if (rows[0] !== undefined) {
      holder = rows[0].holder;
      break;
    }
    await delay(50);
  }
  assert.equal(typeof holder, "string");
  await sql`
    UPDATE swarm.h0_poll_locks
    SET
      acquired_at = statement_timestamp() - interval '1 minute',
      expires_at = statement_timestamp() - interval '1 second'
    WHERE principal_id = ${seat.principalId}::uuid
      AND holder = ${holder}::uuid
  `;
  const result = await pending;
  assert.equal(result.status, H0_POLL_LOCK_ENDED_STATUS);
  assert.equal(result.body.error, H0_POLL_LOCK_ENDED);
  assert.notEqual(result.body.error, H0_POLL_IN_PROGRESS);
});

test("a retried stale ackBatch says to poll again without ackBatch", async () => {
  const seat = await makeSeat();
  const signalId = await postAsk(seat.principalId);
  const first = await h0("poll", seat.token, { wait: 0 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const ackBatch = String(first.body.batchId);
  const lost = await h0("poll", seat.token, { wait: 0, ackBatch });
  assert.equal(lost.status, 200, JSON.stringify(lost.body));
  const activeBatch = String(lost.body.batchId);
  assert.notEqual(activeBatch, ackBatch);
  const retry = await h0("poll", seat.token, { wait: 0, ackBatch });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.error, H0_ACK_BATCH_MISMATCH);
  assert.equal(retry.body.message, H0_ACK_BATCH_MISMATCH_MESSAGE);
  assert.match(String(retry.body.message), /Poll again without ackBatch/);
  const replay = await h0("poll", seat.token, { wait: 0 });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.batchId, activeBatch);
  assert.equal(deliveriesOf(replay.body)[0]?.signal.id, signalId);
});

function batchImmutable(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === "55000";
}

test("closed poll batches older than the retention age can be deleted", async () => {
  const seat = await makeSeat();
  const workspace = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id::text
    FROM swarm.agent_principals
    WHERE principal_id = ${seat.principalId}::uuid
  `;
  const workspaceId = workspace[0]?.workspace_id;
  assert.equal(typeof workspaceId, "string");
  const activeId = randomUUID();
  const recentId = randomUUID();
  const oldDirectId = randomUUID();
  const oldPurgeId = randomUUID();
  const keptByFloorId = randomUUID();
  const lease = () => [randomUUID()];
  await sql`
    INSERT INTO swarm.h0_poll_batches (
      workspace_id, principal_id, batch_id, lease_ids, status, expires_at
    ) VALUES (
      ${workspaceId}::uuid,
      ${seat.principalId}::uuid,
      ${activeId}::uuid,
      ${lease()}::uuid[],
      'active',
      statement_timestamp() + interval '1 hour'
    )
  `;
  await sql`
    INSERT INTO swarm.h0_poll_batches (
      workspace_id, principal_id, batch_id, lease_ids, status, expires_at, closed_at
    ) VALUES
      (
        ${workspaceId}::uuid, ${seat.principalId}::uuid, ${recentId}::uuid,
        ${lease()}::uuid[], 'closed', statement_timestamp(),
        statement_timestamp() - interval '1 day'
      ),
      (
        ${workspaceId}::uuid, ${seat.principalId}::uuid, ${oldDirectId}::uuid,
        ${lease()}::uuid[], 'closed', statement_timestamp(),
        statement_timestamp() - interval '3 days'
      ),
      (
        ${workspaceId}::uuid, ${seat.principalId}::uuid, ${oldPurgeId}::uuid,
        ${lease()}::uuid[], 'closed', statement_timestamp(),
        statement_timestamp() - interval '3 days'
      )
  `;
  const days = await sql<{ days: number }[]>`
    SELECT swarm.h0_poll_batch_retention_days() AS days
  `;
  assert.ok((days[0]?.days ?? 0) >= 2);
  await assert.rejects(
    sql`
      DELETE FROM swarm.h0_poll_batches
      WHERE batch_id = ${activeId}::uuid
    `,
    batchImmutable,
  );
  await assert.rejects(
    sql`
      DELETE FROM swarm.h0_poll_batches
      WHERE batch_id = ${recentId}::uuid
    `,
    batchImmutable,
  );
  await sql`
    DELETE FROM swarm.h0_poll_batches
    WHERE batch_id = ${oldDirectId}::uuid
  `;
  await sql`SELECT swarm.purge_expired_h0_poll_batches()`;
  const afterPurge = await sql<{ batch_id: string }[]>`
    SELECT batch_id::text
    FROM swarm.h0_poll_batches
    WHERE principal_id = ${seat.principalId}::uuid
    ORDER BY batch_id
  `;
  assert.deepEqual(
    afterPurge.map((row) => row.batch_id).sort(),
    [activeId, recentId].sort(),
  );
  const previous = await sql<{ value: string }[]>`
    SELECT value::text AS value
    FROM swarm.config
    WHERE key = 'h0_poll_batch_retention_days'
  `;
  try {
    await sql`
      INSERT INTO swarm.config (key, value)
      VALUES ('h0_poll_batch_retention_days', '1'::jsonb)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    const floored = await sql<{ days: number }[]>`
      SELECT swarm.h0_poll_batch_retention_days() AS days
    `;
    assert.ok((floored[0]?.days ?? 0) >= 2);
    await sql`SELECT swarm.purge_expired_h0_poll_batches()`;
    const stillRecent = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM swarm.h0_poll_batches
      WHERE batch_id = ${recentId}::uuid
    `;
    assert.equal(stillRecent[0]?.n, 1);
    await sql`
      UPDATE swarm.config
      SET value = '10'::jsonb
      WHERE key = 'h0_poll_batch_retention_days'
    `;
    await sql`
      INSERT INTO swarm.h0_poll_batches (
        workspace_id, principal_id, batch_id, lease_ids, status, expires_at, closed_at
      ) VALUES (
        ${workspaceId}::uuid, ${seat.principalId}::uuid, ${keptByFloorId}::uuid,
        ${lease()}::uuid[], 'closed', statement_timestamp(),
        statement_timestamp() - interval '3 days'
      )
    `;
    await sql`SELECT swarm.purge_expired_h0_poll_batches()`;
    const kept = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM swarm.h0_poll_batches
      WHERE batch_id = ${keptByFloorId}::uuid
    `;
    assert.equal(kept[0]?.n, 1);
  } finally {
    if (previous[0] !== undefined) {
      await sql`
        UPDATE swarm.config
        SET value = ${previous[0].value}::jsonb
        WHERE key = 'h0_poll_batch_retention_days'
      `;
    }
    await sql`
      UPDATE swarm.h0_poll_batches
      SET status = 'closed', closed_at = statement_timestamp() - interval '3 days'
      WHERE batch_id = ${activeId}::uuid
        AND status = 'active'
    `;
    await sql`
      UPDATE swarm.config
      SET value = '2'::jsonb
      WHERE key = 'h0_poll_batch_retention_days'
    `;
    await sql`SELECT swarm.purge_expired_h0_poll_batches()`;
    if (previous[0] === undefined) {
      await sql`DELETE FROM swarm.config WHERE key = 'h0_poll_batch_retention_days'`;
    }
  }
});

test("a poll cannot take the waiting slot while the admission lock is held", { timeout: 20_000 }, async () => {
  const seat = await makeSeat();
  const gate = postgres(local.DB_URL, { prepare: false, max: 1 });
  let releaseGate = (): void => {};
  const untilRelease = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let notifyHeld = (): void => {};
  const held = new Promise<void>((resolve) => {
    notifyHeld = resolve;
  });
  const transaction = gate.begin(async (tx) => {
    await tx`
      SELECT pg_advisory_xact_lock(
        hashtext('h0-wait-admission'),
        hashtext('deployment')
      )
    `;
    notifyHeld();
    await untilRelease;
  });
  try {
    const ready = await Promise.race([
      held.then(() => "held" as const),
      transaction.then(() => "ended" as const, () => "failed" as const),
    ]);
    assert.equal(ready, "held");
    let settled = false;
    const pending = h0("poll", seat.token, { wait: 2 }).then((body) => {
      settled = true;
      return body;
    });
    const seenBy = Date.now() + 3_000;
    let locked = false;
    while (Date.now() < seenBy) {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM swarm.h0_poll_locks
        WHERE principal_id = ${seat.principalId}::uuid
          AND expires_at > statement_timestamp()
      `;
      if ((rows[0]?.n ?? 0) === 1) {
        locked = true;
        break;
      }
      await delay(50);
    }
    assert.equal(locked, true, "the poll did not publish its seat lock");
    // Inside the claim transaction's 5 second lock_timeout. Long enough that
    // a missing advisory lock would already have set waiting.
    await delay(800);
    const whileHeld = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n
      FROM swarm.h0_poll_locks
      WHERE principal_id = ${seat.principalId}::uuid
        AND waiting
        AND expires_at > statement_timestamp()
    `;
    assert.equal(whileHeld[0]?.n, 0, "the poll took the slot while the admission lock was held");
    assert.equal(settled, false, "the poll returned while the admission lock was held");
    releaseGate();
    await transaction;
    const admitBy = Date.now() + 2_000;
    let admitted = false;
    while (Date.now() < admitBy) {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n
        FROM swarm.h0_poll_locks
        WHERE principal_id = ${seat.principalId}::uuid
          AND waiting
          AND expires_at > statement_timestamp()
      `;
      if ((rows[0]?.n ?? 0) === 1) {
        admitted = true;
        break;
      }
      await delay(50);
    }
    assert.equal(admitted, true, "the poll did not take the slot after the admission lock was released");
    const body = await pending;
    assert.equal(body.status, 200, JSON.stringify(body.body));
    assert.equal(body.body.retryAfterSeconds, undefined);
    assert.equal(body.body.batchId, null);
  } finally {
    releaseGate();
    await transaction.then(() => undefined, () => undefined);
    await gate.end({ timeout: 5 });
  }
});
});
