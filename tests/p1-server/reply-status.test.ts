/** Reply-status storage, edge validation, receipt visibility, and release proofs. */
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
import { REPLY_STATUSES, type ReplyStatus } from "../../src/cloud/reply-status.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspace: string;
  otherWorkspace: string;
  ownerId: string;
  ownerJwt: string;
  agents: Array<{ principalId: string; token: string }>;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let edge: ReturnType<typeof spawn>;
let edgeLogs = "";
let envDir: string | undefined;
let fixture: Fixture;

function localEnvironment(): LocalEnvironment {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

async function createUser(): Promise<{ id: string; jwt: string }> {
  const email = `reply-status-${randomUUID()}@example.test`;
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

async function seedFixture(): Promise<Fixture> {
  const owner = await createUser();
  const workspace = randomUUID();
  const otherWorkspace = randomUUID();
  const device = randomUUID();
  const agents = [0, 1].map(() => ({
    principalId: randomUUID(),
    token: `swm_agt_${randomBytes(32).toString("base64url")}`,
  }));
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'Reply Owner')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'reply-status-tests')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'Reply Status', ${owner.id}::uuid),
             (${otherWorkspace}::uuid, 'Other Reply Status', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
             (${otherWorkspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace'),
             (${randomUUID()}::uuid, ${otherWorkspace}::uuid, 'workspace')`;
    for (const [index, agent] of agents.entries()) {
      const runId = randomUUID();
      await tx`INSERT INTO swarm.agent_principals
        (principal_id, workspace_id, owner_user_id, name)
        VALUES (${agent.principalId}::uuid, ${workspace}::uuid,
          ${owner.id}::uuid, ${`Responder ${index + 1}`})`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${runId}::uuid, ${agent.principalId}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens
        (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
        VALUES (${randomUUID()}::uuid, ${agent.principalId}::uuid, ${runId}::uuid,
          ${tx.json(["post_signal"])}::jsonb,
          ${createHash("sha256").update(agent.token).digest()},
          statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
    }
  });
  return { workspace, otherWorkspace, ownerId: owner.id, ownerJwt: owner.jwt, agents };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-reply-status-edge-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
  edge = spawn("supabase", [
    "functions", "serve", "--no-verify-jwt", "--env-file", envFile,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ENV: "test" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => {
    edgeLogs = (edgeLogs + chunk.toString("utf8")).slice(-20_000);
  };
  edge.stdout?.on("data", capture);
  edge.stderr?.on("data", capture);
  const deadline = Date.now() + 60_000;
  while (!edgeLogs.includes("Serving functions on")) {
    if (Date.now() > deadline) throw new Error(`functions serve never booted:\n${edgeLogs}`);
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: Date.now,
    diagnostics: () => edgeLogs,
  });
  fixture = await seedFixture();
});

after(async () => {
  if (edge && edge.exitCode === null) {
    const stopped = new Promise<boolean>((resolve) => edge.once("close", () => resolve(true)));
    edge.kill();
    if (!await Promise.race([stopped, delay(2_000).then(() => false)])) edge.kill("SIGKILL");
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

async function send(
  bearer: string,
  command: Record<string, unknown>,
  workspace = fixture.workspace,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: randomUUID(),
      client_version: "0.1.0",
      workspace_id: workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function post(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: `reply status ${randomUUID()}`,
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    about: null,
    ...extra,
  };
}

function signalId(result: { body: Record<string, unknown> }): string {
  const signal = result.body.signal as Record<string, unknown> | undefined;
  assert.ok(signal?.id, JSON.stringify(result.body));
  return String(signal.id);
}

async function askTo(principalIds: string[]): Promise<string> {
  const result = await send(fixture.ownerJwt, post({
    signal_kind: "ask",
    ...(principalIds.length === 1
      ? { to_agent_principal_id: principalIds[0] }
      : {
        to_agent_principal_id: principalIds[0],
        to: principalIds.map((id) => ({ kind: "agent", id })),
      }),
  }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return signalId(result);
}

async function agentAskTo(
  sender: Fixture["agents"][number],
  recipientPrincipalId: string,
): Promise<string> {
  const result = await send(sender.token, post({
    signal_kind: "ask",
    to_agent_principal_id: recipientPrincipalId,
  }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return signalId(result);
}

async function receiptThroughReadEdge(
  agent: Fixture["agents"][number],
  signal: string,
  workspace = fixture.workspace,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      resource: "delivery_receipts",
      workspace_id: workspace,
      signal_id: signal,
    }),
  });
  assert.equal(response.status, 200);
  return await response.json() as Record<string, unknown>;
}

async function reply(
  agent: Fixture["agents"][number],
  original: string,
  status: ReplyStatus | undefined,
): Promise<string> {
  const result = await send(agent.token, post({
    in_reply_to: original,
    ...(status === undefined ? {} : { reply_status: status }),
  }));
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return signalId(result);
}

async function receipt(signal: string, workspace = fixture.workspace): Promise<Record<string, unknown> | null> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims',
      ${JSON.stringify({ sub: fixture.ownerId, role: "authenticated" })}, true)`;
    const rows = await tx<{ value: Record<string, unknown> | null }[]>`
      SELECT swarm_read.signal_delivery_receipts(
        ${workspace}::uuid, ${signal}::uuid, NULL
      ) AS value`;
    return rows[0]?.value ?? null;
  });
}

test("each status is stored and returned in receipt replies", async () => {
  for (const status of REPLY_STATUSES) {
    const original = await agentAskTo(
      fixture.agents[0]!,
      fixture.agents[1]!.principalId,
    );
    const replyId = await reply(fixture.agents[1]!, original, status);
    const rows = await sql<{ reply_status: string | null }[]>`
      SELECT reply_status FROM swarm.signals WHERE id = ${replyId}::uuid`;
    assert.equal(rows[0]?.reply_status, status);
    const result = await receiptThroughReadEdge(fixture.agents[0]!, original);
    const replies = result.replies as Array<Record<string, unknown>>;
    assert.equal(replies.length, 1);
    assert.equal(replies[0]?.reply_signal_id, replyId);
    assert.equal(replies[0]?.reply_status, status);
  }
});

test("SQL CHECK refuses status on a non-reply", async () => {
  const nonReply = await send(fixture.ownerJwt, post());
  assert.equal(nonReply.status, 200, JSON.stringify(nonReply.body));
  await assert.rejects(
    sql`UPDATE swarm.signals SET reply_status = 'answered'
      WHERE id = ${signalId(nonReply)}::uuid`,
    /signals_reply_status_valid/,
  );
});

test("edge returns stable status/thread and status/non-reply codes", async () => {
  const thread = await send(fixture.ownerJwt, post({
    thread_root_id: randomUUID(),
    reply_status: "answered",
  }));
  assert.equal(thread.status, 400);
  assert.equal(thread.body.error, "reply_status_thread");

  const nonReply = await send(fixture.ownerJwt, post({ reply_status: "failed" }));
  assert.equal(nonReply.status, 400);
  assert.equal(nonReply.body.error, "reply_status_not_reply");
});

test("an old-client reply without reply_status remains accepted and stores NULL", async () => {
  const original = await askTo([fixture.agents[0]!.principalId]);
  const replyId = await reply(fixture.agents[0]!, original, undefined);
  const rows = await sql<{ reply_status: string | null }[]>`
    SELECT reply_status FROM swarm.signals WHERE id = ${replyId}::uuid`;
  assert.equal(rows[0]?.reply_status, null);
});

test("two responders and a correction are ordered, and latest-per-responder is deterministic", async () => {
  const original = await askTo(fixture.agents.map((agent) => agent.principalId));
  const first = await reply(fixture.agents[0]!, original, "answered");
  const second = await reply(fixture.agents[1]!, original, "failed");
  const correction = await reply(fixture.agents[0]!, original, "declined");
  const result = await receipt(original);
  const replies = result?.replies as Array<Record<string, unknown>>;
  assert.deepEqual(replies.map((row) => row.reply_signal_id), [first, second, correction]);
  const latest = new Map(replies.map((row) => [row.responder_principal_id, row]));
  assert.equal(latest.get(fixture.agents[0]!.principalId)?.reply_status, "declined");
  assert.equal(latest.get(fixture.agents[1]!.principalId)?.reply_status, "failed");

  const foreign = await receipt(original, fixture.otherWorkspace);
  assert.equal(foreign, null);
  const foreignEdge = await receiptThroughReadEdge(
    fixture.agents[0]!,
    original,
    fixture.otherWorkspace,
  );
  assert.deepEqual(foreignEdge.replies, []);
});

test("G3c catalog and seeded functional release proofs pass", async () => {
  const catalog = readFileSync(fileURLToPath(new URL(
    "../../deploy/release-proofs/item-g3c/20260927000001-catalog.sql",
    import.meta.url,
  )), "utf8").replace(/\\gset\s*$/, "");
  const catalogRows = await sql.unsafe<{ catalog_ok: boolean }[]>(catalog);
  assert.equal(catalogRows[0]?.catalog_ok, true);

  const original = await askTo([fixture.agents[0]!.principalId]);
  const replyId = await reply(fixture.agents[0]!, original, "declined");
  const functional = readFileSync(fileURLToPath(new URL(
    "../../deploy/release-proofs/item-g3c/20260927000001-functional.sql",
    import.meta.url,
  )), "utf8");
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
    encoding: "utf8",
  }).trim().split("\n").filter((name) => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1);
  const run = spawnSync("docker", [
    "exec", "-i", containers[0]!, "psql", "-X", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-v", `item_g3c_workspace_id=${fixture.workspace}`,
    "-v", `item_g3c_signal_id=${original}`,
    "-v", `item_g3c_reply_id=${replyId}`,
    "-v", `item_g3c_author_user_id=${fixture.ownerId}`,
  ], { input: `BEGIN;\n${functional}\nROLLBACK;\n`, encoding: "utf8", timeout: 10_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
});
