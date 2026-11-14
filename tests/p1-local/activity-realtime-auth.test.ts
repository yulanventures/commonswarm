/**
 * Private Realtime authorization control for listener activity.
 *
 * This file is named by `npm run test:p1-local`. It needs the local Supabase
 * stack and an announced exclusive database slot because it creates auth users
 * and committed workspace memberships.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  createClient,
  type RealtimeChannel,
  type SupabaseClient,
} from "@supabase/supabase-js";
import postgres from "postgres";
import { activityTopic } from "../../supabase/functions/activity/core.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

function environment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

let local: LocalEnvironment;
let admin: SupabaseClient;
let sql: ReturnType<typeof postgres>;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDirectory: string | undefined;
const realtimeClients: SupabaseClient[] = [];

before(async () => {
  local = environment();
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  sql = postgres(local.DB_URL, { max: 1 });
  envDirectory = mkdtempSync(join(tmpdir(), "cswarm-l35-env-"));
  const envFile = join(envDirectory, "test.env");
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
  const cliState = observeFunctionCli(functionProcess);
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/activity`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (milliseconds) => delay(milliseconds),
    now: Date.now,
    diagnostics: () => `activity function logs:\n${functionLogs.slice(-4_000)}`,
    cliState,
  });
});

after(async () => {
  for (const client of realtimeClients) client.realtime.disconnect();
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
    if (!stopped && functionProcess.exitCode === null) functionProcess.kill("SIGKILL");
  }
  await sql.end({ timeout: 2 });
  if (envDirectory) rmSync(envDirectory, { recursive: true, force: true });
});

async function newMember(label: string): Promise<{
  client: SupabaseClient;
  userId: string;
  workspaceId: string;
}> {
  const email = `l35-${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  assert.ok(created.data.user);
  const userId = created.data.user.id;
  const workspaceId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${userId}::uuid, ${`L35 ${label}`})
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceId}::uuid, ${`L35 ${label}`}, ${userId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceId}::uuid, ${userId}::uuid, 'owner')
    `;
  });
  const client = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  realtimeClients.push(client);
  const signedIn = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signedIn.error);
  assert.ok(signedIn.data.session);
  await client.realtime.setAuth(signedIn.data.session.access_token);
  return { client, userId, workspaceId };
}

async function newAgent(
  userId: string,
  workspaceId: string,
): Promise<{ principalId: string; token: string }> {
  const deviceId = randomUUID();
  const principalId = randomUUID();
  const runId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const tokenHash = createHash("sha256").update(token).digest();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${deviceId}::uuid, ${userId}::uuid, 'l35-activity')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principalId}::uuid, ${workspaceId}::uuid, ${userId}::uuid, 'l35-listener'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${runId}::uuid, ${principalId}::uuid, ${deviceId}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid, ${principalId}::uuid, ${runId}::uuid,
        ${tx.json(["post_signal"])}::jsonb, ${tokenHash},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return { principalId, token };
}

async function subscribe(
  client: SupabaseClient,
  topic: string,
  onFrame: (frame: unknown) => void,
): Promise<{ channel: RealtimeChannel; status: string }> {
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  channel.on("broadcast", { event: "activity" }, onFrame);
  const status = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscribe timed out")), 10_000);
    channel.subscribe((next) => {
      if (next !== "SUBSCRIBED" && next !== "CHANNEL_ERROR" && next !== "TIMED_OUT") {
        return;
      }
      clearTimeout(timer);
      resolve(next);
    });
  });
  return { channel, status };
}

test("another workspace member cannot join or receive the private activity channel", async () => {
  const owner = await newMember("owner");
  const outsider = await newMember("outsider");
  const topic = activityTopic(owner.workspaceId);
  let ownerReceipts = 0;
  let outsiderReceipts = 0;
  const ownerFrames: unknown[] = [];

  const allowed = await subscribe(owner.client, topic, (frame) => {
    ownerReceipts += 1;
    ownerFrames.push(frame);
  });
  assert.equal(allowed.status, "SUBSCRIBED", "member join is the positive control");

  const refused = await subscribe(outsider.client, topic, () => {
    outsiderReceipts += 1;
  });
  assert.equal(refused.status, "CHANNEL_ERROR");

  await sql`
    SELECT realtime.send(
      ${sql.json({ probe: randomUUID() })}::jsonb,
      'activity',
      ${topic},
      true
    )
  `;
  for (let attempt = 0; attempt < 20 && ownerReceipts === 0; attempt += 1) {
    await delay(50);
  }
  assert.equal(ownerReceipts, 1, "authorized member must receive the control frame");
  assert.equal(outsiderReceipts, 0);

  const agent = await newAgent(owner.userId, owner.workspaceId);
  const requestBody = {
    version: 1,
    workspace_id: owner.workspaceId,
    stream_id: randomUUID(),
    sequence: 1,
    phase: "tool-running",
    signal_id: randomUUID(),
    tool_title: `Inspect /private/finance.txt credential=CANARY_PRIVATE swm_\u200bagt_${"z".repeat(43)}`,
    elapsed_ms: 12,
  };
  const published = await fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agent.token}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(requestBody),
  });
  assert.equal(
    published.status,
    202,
    `${await published.text()}\n${functionLogs.slice(-4_000)}`,
  );
  for (let attempt = 0; attempt < 20 && ownerReceipts < 2; attempt += 1) {
    await delay(50);
  }
  assert.equal(ownerReceipts, 2, "the authenticated agent publish must reach its member");
  assert.equal(outsiderReceipts, 0);
  assert.equal(
    (ownerFrames[1] as { payload?: { principalId?: unknown } } | undefined)
      ?.payload?.principalId,
    agent.principalId,
    "the edge must derive the publishing principal from the agent token",
  );
  const legacy = (ownerFrames[1] as { payload?: Record<string, unknown> } | undefined)?.payload ?? {};
  assert.equal(legacy.toolTitle, null, "no tool title reaches the workspace topic");
  assert.equal(legacy.signalId, null, "no message id reaches the workspace topic");
  assert.equal(legacy.phase, "tool-running", "the coarse phase remains");
  assert.doesNotMatch(JSON.stringify(ownerFrames[1]), new RegExp(`finance|CANARY_PRIVATE|swm_|${requestBody.signal_id}`),
    "whatever an old or direct client sends, the broadcast carries no private detail");

  const crossWorkspace = await fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agent.token}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({ ...requestBody, workspace_id: outsider.workspaceId }),
  });
  assert.equal(crossWorkspace.status, 403);
  await delay(100);
  assert.equal(outsiderReceipts, 0);

  await owner.client.removeChannel(allowed.channel);
  await outsider.client.removeChannel(refused.channel);
});

test("a status frame is bound to an addressed message, expires by server time and broadcasts no id or label", async () => {
  const owner = await newMember("status");
  const topic = activityTopic(owner.workspaceId);
  const frames: Array<{ payload?: Record<string, unknown> }> = [];
  const joined = await subscribe(owner.client, topic, (frame) => {
    frames.push(frame as { payload?: Record<string, unknown> });
  });
  assert.equal(joined.status, "SUBSCRIBED");
  const agent = await newAgent(owner.userId, owner.workspaceId);
  await sql`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
    VALUES (${randomUUID()}::uuid, ${owner.workspaceId}::uuid, 'workspace')`;
  const message = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_agent_principal_id, kind, body, until)
    VALUES (${message}::uuid, ${owner.workspaceId}::uuid, ${owner.userId}::uuid, 'user', ${agent.principalId}::uuid,
      'ask', 'private question', statement_timestamp() + interval '1 day')`;
  const notAddressed = randomUUID();
  await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until)
    VALUES (${notAddressed}::uuid, ${owner.workspaceId}::uuid, ${owner.userId}::uuid, 'user',
      'note', 'for everyone', statement_timestamp() + interval '1 day')`;

  const stream = randomUUID();
  const post = (body: Record<string, unknown>) => fetch(`${local.API_URL}/functions/v1/activity`, {
    method: "POST",
    headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ version: 1, kind: "status", workspace_id: owner.workspaceId, stream_id: stream, ...body }),
  });
  const snapshot = async () => (await sql<{
    working_signal_id: string | null; working_label: string | null; seconds_left: number | null;
  }[]>`SELECT signal_id AS working_signal_id, label AS working_label,
      extract(epoch FROM working_until - statement_timestamp())::float8 AS seconds_left
    FROM swarm.agent_message_working WHERE principal_id = ${agent.principalId}::uuid`)[0]
    ?? { working_signal_id: null, working_label: null, seconds_left: null };

  for (const signal of [notAddressed, randomUUID()]) {
    const refused = await post({ sequence: 1, state: "working", signal_id: signal, label: "editing" });
    assert.equal(refused.status, 403, "Working names only a message addressed to this agent");
  }
  for (const bad of [{ label: "Bash" }, { tool_title: "cat secrets" }, { until: "2099-01-01T00:00:00Z" }]) {
    const rejected = await post({ sequence: 1, state: "working", signal_id: message, label: "editing", ...bad });
    assert.equal(rejected.status, 400);
  }
  assert.equal((await snapshot()).working_signal_id, null);

  const accepted = await post({ sequence: 2, state: "working", signal_id: message, label: "editing" });
  assert.equal(accepted.status, 202, `${await accepted.text()}\n${functionLogs.slice(-4_000)}`);
  const busy = await snapshot();
  assert.equal(busy.working_signal_id, message);
  assert.equal(busy.working_label, "editing");
  assert.ok(busy.seconds_left! > 100 && busy.seconds_left! <= 120, `expiry from server time: ${busy.seconds_left}`);

  for (let attempt = 0; attempt < 40 && frames.length === 0; attempt += 1) await delay(50);
  assert.equal(frames.length, 1, "the member receives one status event");
  // Realtime adds its own broadcast id; every other key is the edge's generic status event.
  const payload = { ...frames[0]!.payload };
  assert.notEqual(payload.id, message);
  delete payload.id;
  assert.deepEqual(Object.keys(payload).sort(), ["emittedAt", "kind", "principalId", "state", "version", "workspaceId"]);
  assert.equal(payload.state, "working");
  assert.doesNotMatch(JSON.stringify(frames[0]), new RegExp(`${message}|editing`), "no message id or label on the workspace topic");

  const stale = await post({ sequence: 1, state: "working", signal_id: message, label: "reading" });
  assert.equal(stale.status, 202);
  assert.equal((await snapshot()).working_label, "editing", "an older frame cannot replace newer work");
  const otherStream = await post({ stream_id: randomUUID(), sequence: 9, state: "idle", signal_id: null, label: null });
  assert.equal(otherStream.status, 202);
  assert.equal((await snapshot()).working_label, "editing", "another stream cannot take over live work");
  await delay(300);
  assert.equal(frames.length, 1, "a frame that changed nothing announces nothing");

  const idle = await post({ sequence: 3, state: "idle", signal_id: null, label: null });
  assert.equal(idle.status, 202);
  assert.deepEqual(await snapshot(), { working_signal_id: null, working_label: null, seconds_left: null });
  const revived = await post({ sequence: 2, state: "working", signal_id: message, label: "editing" });
  assert.equal(revived.status, 202);
  assert.equal((await snapshot()).working_signal_id, null, "an older frame cannot revive cleared work");
  const handover = await post({ stream_id: randomUUID(), sequence: 1, state: "working", signal_id: message, label: "reading" });
  assert.equal(handover.status, 202);
  assert.equal((await snapshot()).working_label, "reading", "a new stream takes over once the old one is idle");

  await owner.client.removeChannel(joined.channel);
});

/** Join a topic for the "signal" event and report the outcome, with the refusal text when there is one. */
async function joinSignals(
  client: SupabaseClient,
  topic: string,
  onFrame: (frame: unknown) => void = () => {},
): Promise<{ channel: RealtimeChannel; status: string; refusal: string }> {
  const channel = client.channel(topic, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  channel.on("broadcast", { event: "signal" }, onFrame);
  const outcome = await new Promise<{ status: string; refusal: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Realtime subscribe timed out")), 10_000);
    channel.subscribe((next, err: unknown) => {
      if (next !== "SUBSCRIBED" && next !== "CHANNEL_ERROR" && next !== "TIMED_OUT") return;
      clearTimeout(timer);
      const message = err && typeof err === "object" && "message" in err ? (err as { message: unknown }).message : err;
      resolve({ status: next, refusal: (typeof message === "string" ? message : "").split(topic).join("<topic>") });
    });
  });
  return { channel, ...outcome };
}

const memberTopic = (workspaceId: string, userId: string) => `cswarm-member:${workspaceId}:${userId}`;

test("a person joins their own member topic and no other, and every refusal reads the same", async () => {
  const anna = await newMember("member-topic-anna");
  const ben = await newMember("member-topic-ben");
  const ended = await newMember("member-topic-ended");

  const own = await joinSignals(anna.client, memberTopic(anna.workspaceId, anna.userId));
  assert.equal(own.status, "SUBSCRIBED", `a member's own topic is the positive control: ${own.refusal}`);

  // The session ends in the database; the token is still unexpired, and it no longer opens the topic.
  const endedTopic = memberTopic(ended.workspaceId, ended.userId);
  const whileLive = await joinSignals(ended.client, endedTopic);
  assert.equal(whileLive.status, "SUBSCRIBED");
  await ended.client.removeChannel(whileLive.channel);
  await sql`DELETE FROM auth.sessions WHERE user_id = ${ended.userId}::uuid`;

  const refusals: string[] = [];
  for (const [name, client, topic] of [
    ["another person's topic", ben.client, memberTopic(anna.workspaceId, anna.userId)],
    ["their own id in a workspace they are not in", ben.client, memberTopic(anna.workspaceId, ben.userId)],
    ["another person's id in their own workspace", ben.client, memberTopic(ben.workspaceId, anna.userId)],
    ["a workspace that does not exist", ben.client, memberTopic(randomUUID(), ben.userId)],
    ["a topic with no person", ben.client, `cswarm-member:${ben.workspaceId}`],
    ["a topic with a third part", ben.client, `${memberTopic(ben.workspaceId, ben.userId)}:${randomUUID()}`],
    ["a topic that is not ids", ben.client, "cswarm-member:not-a-workspace:not-a-person"],
    ["an ended session", ended.client, endedTopic],
  ] as const) {
    const refused = await joinSignals(client, topic);
    assert.equal(refused.status, "CHANNEL_ERROR", `${name} must be refused`);
    assert.ok(refused.refusal.length > 0, `${name}: a refusal carries text`);
    refusals.push(refused.refusal);
    await client.removeChannel(refused.channel);
  }
  assert.deepEqual([...new Set(refusals)], [refusals[0]], "one refusal for every case: none says which part was wrong");

  // Ben's own topic still opens after all those refusals, so they were about the topics.
  const bens = await joinSignals(ben.client, memberTopic(ben.workspaceId, ben.userId));
  assert.equal(bens.status, "SUBSCRIBED", bens.refusal);
  await ben.client.removeChannel(bens.channel);
  await anna.client.removeChannel(own.channel);
});

test("a private channel's message arrives on its members' open sockets and stops for one who is removed", async () => {
  const anna = await newMember("member-live-anna");
  const ben = await newMember("member-live-ben");
  const cara = await newMember("member-live-cara");
  const ws = anna.workspaceId;
  const channelId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${ws}::uuid, ${ben.userId}::uuid, 'member'), (${ws}::uuid, ${cara.userId}::uuid, 'admin')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${ws}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.channels (channel_id, workspace_id, slug, purpose, created_by_principal, created_by_kind, visibility)
      VALUES (${channelId}::uuid, ${ws}::uuid, 'confidential', NULL, ${anna.userId}::uuid, 'user', 'private')`;
    await tx`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, user_id, is_manager, added_by_kind, added_by_principal)
      VALUES (${ws}::uuid, ${channelId}::uuid, 'user', ${anna.userId}::uuid, true, 'user', ${anna.userId}::uuid),
        (${ws}::uuid, ${channelId}::uuid, 'user', ${ben.userId}::uuid, false, 'user', ${anna.userId}::uuid)`;
  });

  const received = { anna: [] as unknown[], ben: [] as unknown[], cara: [] as unknown[] };
  /** A message's frame is {"v": 1} and nothing else; this test's own marker frames carry an id to tell them apart. */
  const idOf = (frame: unknown) => {
    const payload = (frame as { payload?: Record<string, unknown> }).payload ?? {};
    if (typeof payload.marker === "string") return payload.marker;
    assert.deepEqual(Object.keys(payload).filter((key) => key !== "id"), ["v"], JSON.stringify(frame));
    return "message";
  };
  const joins = [
    await joinSignals(anna.client, memberTopic(ws, anna.userId), (frame) => received.anna.push(idOf(frame))),
    await joinSignals(ben.client, memberTopic(ws, ben.userId), (frame) => received.ben.push(idOf(frame))),
    // Cara is a workspace admin outside the channel: her topic opens, and nothing arrives on it.
    await joinSignals(cara.client, memberTopic(ws, cara.userId), (frame) => received.cara.push(idOf(frame))),
  ];
  for (const joined of joins) assert.equal(joined.status, "SUBSCRIBED", joined.refusal);

  const post = async (): Promise<void> => {
    await sql`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, kind, body, until, channel_id)
      VALUES (${randomUUID()}::uuid, ${ws}::uuid, ${anna.userId}::uuid, 'user', 'note', 'private',
        statement_timestamp() + interval '1 day', ${channelId}::uuid)`;
  };
  /** A frame sent straight to each topic after the message, so "nothing arrived" is read off a socket that works. */
  const marker = async (): Promise<string> => {
    const id = randomUUID();
    for (const userId of [anna.userId, ben.userId, cara.userId]) {
      await sql`SELECT realtime.send(${sql.json({ v: 1, marker: id })}::jsonb, 'signal', ${memberTopic(ws, userId)}, true)`;
    }
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ([received.anna, received.ben, received.cara].every((list) => list.includes(id))) return id;
      await delay(50);
    }
    assert.fail(`the marker frame did not reach every socket: ${JSON.stringify(received)}`);
  };

  await post();
  const firstMarker = await marker();
  assert.deepEqual(received, { anna: ["message", firstMarker], ben: ["message", firstMarker], cara: [firstMarker] });

  // Ben's socket stays joined. The next message never reaches it, because membership is read when the message is written.
  await sql`DELETE FROM swarm.channel_members WHERE workspace_id = ${ws}::uuid AND channel_id = ${channelId}::uuid
    AND user_id = ${ben.userId}::uuid`;
  await post();
  const secondMarker = await marker();
  assert.deepEqual(received, {
    anna: ["message", firstMarker, "message", secondMarker],
    ben: ["message", firstMarker, secondMarker],
    cara: [firstMarker, secondMarker],
  });
  for (const [index, joined] of joins.entries()) {
    await [anna, ben, cara][index]!.client.removeChannel(joined.channel);
  }
});
