/** Served H0 forwarding through the local command edge and local PostgreSQL only. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface Local { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Result { status: number; body: Record<string, unknown>; headers: Headers }
interface Seat { token: string; principalId: string }
let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let ownerJwt: string;
let workspace: string;
let processHandle: ReturnType<typeof spawn> | undefined;
let envDir: string | undefined;
let functionReady = false;

function localEnvironment(): Local {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  });
  const value = JSON.parse(output) as Partial<Local>;
  assert.ok(value.API_URL && value.ANON_KEY && value.DB_URL && value.SERVICE_ROLE_KEY);
  for (const raw of [value.API_URL, value.DB_URL]) {
    const host = new URL(raw).hostname;
    assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(host), `non-loopback test host: ${host}`);
  }
  return value as Local;
}

async function post(path: string, body: Record<string, unknown>, token: string | null): Promise<Result> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${local.API_URL}/functions/v1/${path}`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, headers: response.headers, body: await response.json() as Record<string, unknown> };
}

function h0(path: string, body: Record<string, unknown>, token: string | null): Promise<Result> {
  return post(`h0/${path}`, body, token);
}

function command(token: string | null, commandBody: Record<string, unknown>, id = randomUUID()): Promise<Result> {
  return post("command", {
    command_id: id, client_version: "0.1.0", workspace_id: workspace,
    stream: { kind: "workspace" }, command: commandBody,
  }, token);
}

async function mint(cap = 10): Promise<{ secret: string; id: string }> {
  const response = await command(ownerJwt, { kind: "mint_agent_join_credential", seat_cap: cap, ttl_hours: 4 });
  assert.equal(response.status, 200, "join credential mint failed");
  assert.equal(typeof response.body.join_credential, "string");
  return { secret: response.body.join_credential as string, id: response.body.join_credential_id as string };
}

async function register(secret: string, attemptId = randomUUID(), name = "H0 seat", icon?: string): Promise<Seat> {
  const result = await h0("register", {
    joinCredential: secret, attemptId, name,
    ...(icon === undefined ? {} : { icon }),
  }, null);
  assert.equal(result.status, 200, `register status ${result.status}`);
  assert.equal(typeof result.body.agent_token, "string");
  assert.equal(typeof result.body.principal_id, "string");
  assertHeaders(result);
  return { token: result.body.agent_token as string, principalId: result.body.principal_id as string };
}

function assertHeaders(result: Result): void {
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
}

function signalId(result: Result): string {
  assert.equal(result.status, 200, `signal status ${result.status}`);
  const signal = result.body.signal as { id?: unknown } | undefined;
  assert.equal(typeof signal?.id, "string");
  return signal!.id as string;
}

async function signalRow(id: string): Promise<Record<string, unknown>> {
  const rows = await sql<Record<string, unknown>[]>`
    SELECT kind, body, from_principal::text, to_user_id::text,
      to_agent_principal_id::text, in_reply_to::text, about
    FROM swarm.signals WHERE id = ${id}::uuid
  `;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-h0-forward-"));
  const envFile = join(envDir, "edge.env");
  writeFileSync(envFile, "SWARM_ENV=test\n");
  processHandle = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let ready = "";
  processHandle.stdout?.on("data", (chunk: Buffer) => { ready = (ready + chunk.toString()).slice(-4_000); });
  processHandle.stderr?.on("data", (chunk: Buffer) => { ready = (ready + chunk.toString()).slice(-4_000); });
  const deadline = Date.now() + 60_000;
  while (!ready.includes("Serving functions on")) {
    if (Date.now() > deadline) throw new Error("local functions did not start");
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`, fetcher: fetch,
    timeoutMs: 30_000, sleep: (ms) => delay(ms), now: () => Date.now(),
    diagnostics: () => "command readiness failed",
  });
  let documentReady = false;
  const documentDeadline = Date.now() + 30_000;
  while (Date.now() < documentDeadline) {
    try {
      const response = await fetch(`${local.API_URL}/functions/v1/h0/agent-doc/test`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.status === 200) { documentReady = true; break; }
    } catch { /* the local worker may still be starting */ }
    await delay(200);
  }
  assert.ok(documentReady, "h0 agent document never became ready");
  functionReady = true;
  const email = `h0-forward-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const user = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(user.error);
  assert.ok(user.data.user);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const session = await client.auth.signInWithPassword({ email, password });
  assert.ifError(session.error);
  assert.ok(session.data.session);
  ownerJwt = session.data.session.access_token;
  workspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user.data.user.id}::uuid, 'H0 Forward Owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'H0 Forward', ${user.data.user.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${user.data.user.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
});

after(async () => {
  if (processHandle && processHandle.exitCode === null) {
    const exited = new Promise<void>((resolve) => { processHandle?.once("close", () => resolve()); });
    processHandle.kill();
    await Promise.race([exited, delay(2_000)]);
    if (processHandle.exitCode === null) processHandle.kill("SIGKILL");
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("register retries one attempt on one seat, a new attempt takes another, and revocation refuses", { timeout: 80_000 }, async () => {
  assert.ok(functionReady);
  const join = await mint(4);
  const attempt = randomUUID();
  const first = await register(join.secret, attempt, "First", "star");
  const retry = await register(join.secret, attempt, "First");
  assert.equal(retry.principalId, first.principalId);
  assert.notEqual(retry.token, first.token, "unused token recovery must replace its secret");
  const replaced = await h0("note", { body: "replaced token must be refused" }, first.token);
  assert.equal(replaced.status, 403);
  assert.equal(replaced.body.error, "forbidden");
  signalId(await h0("note", { body: "live recovered token" }, retry.token));
  const usedRetry = await h0("register", {
    joinCredential: join.secret, attemptId: attempt, name: "First",
  }, null);
  assert.equal(usedRetry.status, 409);
  assert.equal(usedRetry.body.error, "registration_token_already_used");
  const second = await register(join.secret, randomUUID(), "Second");
  assert.notEqual(second.principalId, first.principalId);
  const attempts = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.agent_join_attempts
    WHERE principal_id IN (${first.principalId}::uuid, ${second.principalId}::uuid)
  `;
  assert.equal(attempts[0]?.n, 2);
  const bad = await h0("register", { joinCredential: "bad-credential", attemptId: randomUUID(), name: "Bad" }, null);
  assert.equal(bad.status, 403);
  assert.equal(bad.body.error, "forbidden");
  assertHeaders(bad);
  assert.equal(JSON.stringify(bad.body).includes("bad-credential"), false);
  const revoked = await command(ownerJwt, { kind: "revoke_agent_join_credential", join_credential_id: join.id });
  assert.equal(revoked.status, 200);
  const refused = await h0("register", { joinCredential: join.secret, attemptId: randomUUID(), name: "Revoked" }, null);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, "forbidden");
  assertHeaders(refused);
  assert.equal(JSON.stringify(refused.body).includes(join.secret), false);
});

test("ask, note, reply and working-on store the same signal fields as a CLI command", { timeout: 80_000 }, async () => {
  const join = await mint(3);
  const sender = await register(join.secret, randomUUID(), "Sender");
  const recipient = await register(join.secret, randomUUID(), "Recipient");
  const addressed = [{ kind: "agent", id: recipient.principalId }];
  const sourceAsk = signalId(await command(recipient.token, {
    kind: "post_signal", signal_kind: "ask", body: "Source question",
    to_user_id: null, to_agent_principal_id: sender.principalId,
    in_reply_to: null, about: null,
  }));
  const cases = [
    { verb: "ask", h0: { body: "Compare ask", to: addressed }, direct: {
      signal_kind: "ask", body: "Compare ask", to_agent_principal_id: recipient.principalId,
    } },
    { verb: "note", h0: { body: "Compare note", to: addressed }, direct: {
      signal_kind: "note", body: "Compare note", to_agent_principal_id: recipient.principalId,
    } },
    { verb: "reply", h0: { signal_id: sourceAsk, body: "Compare reply" }, direct: {
      signal_kind: "note", body: "Compare reply", in_reply_to: sourceAsk,
    } },
    { verb: "working-on", h0: { body: "Compare work" }, direct: {
      signal_kind: "working-on", body: "Compare work",
    } },
  ] as const;
  for (const item of cases) {
    const h0Id = signalId(await h0(item.verb, { ...item.h0, requestId: randomUUID() }, sender.token));
    const directId = signalId(await command(sender.token, {
      kind: "post_signal", signal_kind: item.direct.signal_kind, body: item.direct.body,
      to_user_id: null, to_agent_principal_id: "to_agent_principal_id" in item.direct ? item.direct.to_agent_principal_id : null,
      in_reply_to: "in_reply_to" in item.direct ? item.direct.in_reply_to : null,
      about: null,
    }));
    assert.deepEqual(await signalRow(h0Id), await signalRow(directId), item.verb);
  }
  const idempotency = randomUUID();
  const first = await h0("note", { body: "Replay note", requestId: idempotency }, sender.token);
  const replay = await h0("note", { body: "Replay note", requestId: idempotency }, sender.token);
  assert.equal(signalId(first), signalId(replay));
  const count = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM swarm.signals
    WHERE workspace_id = ${workspace}::uuid AND body = 'Replay note'
  `;
  assert.equal(count[0]?.n, 1);
});

test("unknown fields, query bearers and missing bearer are refused", { timeout: 45_000 }, async () => {
  const join = await mint(1);
  const seat = await register(join.secret);
  const valid = await h0("note", { body: "positive control" }, seat.token);
  signalId(valid);
  const unknown = await h0("note", { body: "reject", surprise: true }, seat.token);
  assert.equal(unknown.status, 400);
  assertHeaders(unknown);
  const tooLarge = await h0("note", { body: "x".repeat(16 * 1024) }, seat.token);
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.error, "payload_too_large");
  assertHeaders(tooLarge);
  const missing = await h0("note", { body: "reject" }, null);
  assert.equal(missing.status, 401);
  assert.equal(missing.body.error, "unauthenticated");
  assertHeaders(missing);
  const response = await fetch(`${local.API_URL}/functions/v1/h0/note?token=redacted`, {
    method: "POST", headers: { authorization: `Bearer ${seat.token}`, "content-type": "application/json" },
    body: JSON.stringify({ body: "reject" }), signal: AbortSignal.timeout(20_000),
  });
  const query = { status: response.status, body: await response.json() as Record<string, unknown>, headers: response.headers };
  assert.equal(query.status, 400);
  assert.equal(query.body.error, "h0_bearer_query_refused");
  assertHeaders(query);
});

test("three seats: ask, poll, ack and reply complete through H0", { timeout: 80_000 }, async () => {
  const join = await mint(3);
  const asker = await register(join.secret, randomUUID(), "Asker");
  const receiver = await register(join.secret, randomUUID(), "Receiver");
  const third = await register(join.secret, randomUUID(), "Third");
  assert.equal(new Set([asker.principalId, receiver.principalId, third.principalId]).size, 3);
  const asked = signalId(await h0("ask", {
    body: "Three-seat question", to: [{ kind: "agent", id: receiver.principalId }],
    requestId: randomUUID(),
  }, asker.token));
  const polled = await h0("poll", { wait: 0 }, receiver.token);
  assert.equal(polled.status, 200);
  assertHeaders(polled);
  const deliveries = polled.body.deliveries as Array<{ signal: { id: string }; lease_id: string }>;
  const message = deliveries.find((row) => row.signal.id === asked);
  assert.ok(message);
  const thirdPoll = await h0("poll", { wait: 0 }, third.token);
  assert.equal(thirdPoll.status, 200);
  assertHeaders(thirdPoll);
  assert.equal((thirdPoll.body.deliveries as Array<{ signal: { id: string } }>).some((row) => row.signal.id === asked), false);
  const acked = await h0("ack", {
    signal_id: asked, lease_id: message.lease_id,
    listener_instance_id: polled.body.listener_instance_id,
    outcome: "replied", last_error_code: null,
  }, receiver.token);
  assert.equal(acked.status, 200);
  assertHeaders(acked);
  const reply = signalId(await h0("reply", {
    signal_id: asked, body: "Three-seat answer", requestId: randomUUID(),
  }, receiver.token));
  const row = await signalRow(reply);
  assert.equal(row.in_reply_to, asked);
  const askerPoll = await h0("poll", { wait: 0 }, asker.token);
  assert.equal(askerPoll.status, 200);
  assert.ok((askerPoll.body.deliveries as Array<{ signal: { id: string } }>).some((item) => item.signal.id === reply));
});
