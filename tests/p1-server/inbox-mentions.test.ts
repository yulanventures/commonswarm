/**
 * An agent's inbox read (POST /functions/v1/read, inbox: true) holds the messages that mention it:
 * an @tag, the lead on a person's untagged post, and a person's reply in a thread the agent is in.
 * Before this, the read admitted only rows addressed to the agent, so every public mention woke the
 * agent and then read back as an empty inbox.
 *
 * Driven against the served read and command functions and real Postgres, with SWARM_CHAT_MENTIONS
 * on. An installed client (0.1.82 to 0.1.97) reads without include_mentions and admits a row only
 * when to_agent or recipients names it, or its check throws and keeps its cursor; this client asks
 * for mentions and its check admits a row that mentions it.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { AGENT_CREDENTIAL_MESSAGE_D088 } from "../../src/cloud/agent-credential-input.js";
import { checkAgentMessages, type AgentCheckResult } from "../../src/cloud/agent-check.js";
import { cloudTarget } from "../../src/cloud/config.js";
import { parseSignalRecord, readSignals, signalAddressesAgent, signalReachesAgent } from "../../src/cloud/signals.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { principal: string; token: string; profilePath: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let root: string;
let previousHome: string | undefined;
let previousState: string | undefined;
let workspace: string;
let owner: Person;
let other: Person;
let device: string;
/** Mentioned in the tests below. */
let mentioned: Agent;
/** Same owner as `mentioned`: the signals view admits by owner, so only the read edge keeps them apart. */
let bystander: Agent;

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
  return { id: created.data.user.id, jwt: signed.data.session.access_token };
}

/** A live agent of the owner with its own token and its own CLI profile (so its own check cursor). */
async function createAgent(name: string): Promise<Agent> {
  const principal = randomUUID();
  const run = randomUUID();
  const tokenId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`${name}-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${tokenId}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  const dir = join(root, `profile-${principal}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const credentialFile = join(dir, "credential.json");
  const profilePath = join(dir, "profile.json");
  writeFileSync(credentialFile, JSON.stringify({ message: AGENT_CREDENTIAL_MESSAGE_D088,
    status: "accepted", principal_id: principal, token_id: tokenId, run_id: run,
    agent_token: token, expires_at: "2099-01-01T00:00:00.000Z" }), { mode: 0o600 });
  writeFileSync(profilePath, JSON.stringify({ version: 1, url: local.API_URL,
    anon_key: local.ANON_KEY, workspace_id: workspace, principal_id: principal,
    credential_file: credentialFile }), { mode: 0o600 });
  return { principal, token, profilePath };
}

async function send(bearer: string, command: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

/** The exact post body every installed client sends. */
function post(extra: Row = {}): Row {
  return { kind: "post_signal", signal_kind: "note", body: `inbox mentions ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra };
}

async function posted(bearer: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, post(extra));
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  const signal = result.body.signal as Row | undefined;
  assert.ok(signal && typeof signal.id === "string", JSON.stringify(result.body));
  return signal.id as string;
}

/** The read an installed client sends (no include_mentions), or the new one. */
async function read(agent: Agent, inbox: boolean, includeMentions?: boolean): Promise<Row[]> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox, about: null, kind: null,
      since: null, in_reply_to: null, after_created_at: null, after_id: null, limit: 100, include_stale: false,
      ...(includeMentions === undefined ? {} : { include_mentions: includeMentions }) }),
  });
  const body = await response.json() as Row;
  assert.equal(response.status, 200, JSON.stringify(body) + functionLogs.slice(-3000));
  return body.signals as Row[];
}

function byId(rows: Row[], id: string): Row | undefined {
  return rows.find((row) => row.id === id);
}

async function check(agent: Agent): Promise<string[]> {
  let result: AgentCheckResult | undefined;
  await checkAgentMessages({ profilePath: agent.profilePath, present: async (value) => { result = value; } });
  assert.ok(result, "check presented a result");
  return result.messages.map((message) => message.id);
}

/**
 * What an installed client (0.1.82 to 0.1.97) does with the inbox: it reads without include_mentions,
 * and every row must be addressed to it, or its check stops.
 */
async function installedInbox(agent: Agent): Promise<string[]> {
  const rows = (await read(agent, true)).map((row) => parseSignalRecord(row));
  for (const row of rows) {
    assert.ok(signalAddressesAgent(row, agent.principal), `inbox row ${row.id} must name the agent for 0.1.82 to 0.1.97`);
  }
  return rows.map((row) => row.id);
}

/** This client's inbox: it asks for mentions, and every row reaches it, addressed or mentioned, as stored. */
async function cliInbox(agent: Agent): Promise<Map<string, ReturnType<typeof parseSignalRecord>>> {
  const rows = await readSignals(cloudTarget(local.API_URL, local.ANON_KEY),
    { kind: "agent", token: agent.token }, { workspaceId: workspace, inbox: true, limit: 100 });
  for (const row of rows) {
    assert.ok(signalReachesAgent(row, agent.principal), `inbox row ${row.id} reaches the agent`);
    assert.ok(Array.isArray(row.mentions), "this client asked for mentions");
  }
  return new Map(rows.map((row) => [row.id, row]));
}

before(async () => {
  local = localEnvironment();
  root = createLaneTempHome("inbox-mentions-");
  previousHome = process.env.HOME;
  previousState = process.env.SWARM_AGENT_STATE_DIR;
  process.env.HOME = root;
  process.env.SWARM_AGENT_STATE_DIR = join(root, "state");
  const envFile = join(root, "edge.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
    startupSeen ||= functionLogs.includes("Serving functions on");
  };
  functionProcess.stdout?.on("data", observe);
  functionProcess.stderr?.on("data", observe);
  const bootDeadline = Date.now() + 60_000;
  while (!startupSeen) {
    if (Date.now() >= bootDeadline || functionProcess.exitCode !== null) {
      throw new Error("local functions serve did not start");
    }
    await delay(250);
  }
  await awaitFunctionRunning({ url: `${local.API_URL}/functions/v1/command`, fetcher: fetch,
    timeoutMs: 30_000, sleep: (ms) => delay(ms), now: () => Date.now(),
    diagnostics: () => "local command function was not ready", cliState });
  owner = await createUser("inbox-mentions-owner");
  other = await createUser("inbox-mentions-other");
  workspace = randomUUID();
  device = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'MentionsOwner'), (${other.id}::uuid, 'MentionsOther')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'inbox-mentions')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'MentionsWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'), (${workspace}::uuid, ${other.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  mentioned = await createAgent("mentioned");
  bystander = await createAgent("bystander");
}, { timeout: 120_000 });

after(async () => {
  if (functionProcess?.pid && functionProcess.exitCode === null) {
    try { process.kill(-functionProcess.pid, "SIGTERM"); } catch { /* already stopped */ }
    await Promise.race([new Promise((resolve) => functionProcess!.once("close", resolve)), delay(2_000)]);
    if (functionProcess.exitCode === null) {
      try { process.kill(-functionProcess.pid, "SIGKILL"); } catch { /* already stopped */ }
    }
  }
  await sql?.end({ timeout: 5 });
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousState === undefined) delete process.env.SWARM_AGENT_STATE_DIR;
  else process.env.SWARM_AGENT_STATE_DIR = previousState;
  if (root) removeLaneTempHome(root);
}, { timeout: 10_000 });

test("an @tag in #general and in a channel reaches the agent's inbox, its check, and only that agent", { timeout: 120_000 }, async () => {
  const slug = `mentions-${randomBytes(4).toString("hex")}`;
  assert.equal((await send(owner.jwt, { kind: "channel_create", slug })).status, 200);
  const inGeneral = await posted(owner.jwt, { mentions: [{ kind: "agent", id: mentioned.principal }] });
  const inChannel = await posted(other.jwt, { channel: slug, mentions: [{ kind: "agent", id: mentioned.principal }] });
  const plain = await posted(owner.jwt);
  const directed = await posted(owner.jwt, { to_agent_principal_id: mentioned.principal });

  // An installed client's inbox: every row names the agent, so its check accepts the page.
  const inbox = await read(mentioned, true);
  for (const id of [inGeneral, inChannel, directed]) assert.ok(byId(inbox, id), `inbox holds ${id}`);
  assert.equal(byId(inbox, plain), undefined, "a public message that does not mention the agent stays out of its inbox");
  for (const id of [inGeneral, inChannel]) {
    const row = byId(inbox, id)!;
    assert.equal(row.to_agent, mentioned.principal, "named in to_agent for a client that has not asked for mentions");
    assert.deepEqual(row.recipients, []);
    assert.equal(row.audience, "workspace", "and still says the whole channel reads it");
    assert.equal("mentions" in row, false, "no new key for a client that did not ask");
  }
  assert.equal(byId(inbox, directed)!.audience, "private");
  assert.equal(byId(inbox, directed)!.to_agent, mentioned.principal);

  // A client that asks gets the row as stored, and its mentions in order.
  const truthful = await read(mentioned, true, true);
  const row = byId(truthful, inChannel)!;
  assert.equal(row.to_agent, null);
  assert.deepEqual(row.recipients, []);
  assert.equal(row.audience, "workspace");
  assert.deepEqual(row.mentions, [{ position: 0, kind: "agent", id: mentioned.principal, source: "author" }]);
  assert.deepEqual(byId(truthful, directed)!.mentions, []);
  assert.equal(byId(truthful, directed)!.to_agent, mentioned.principal);

  // The CLI's own reads: an installed client's, and this one's, which keeps the row as stored.
  const installed = await installedInbox(mentioned);
  for (const id of [inGeneral, inChannel, directed]) assert.ok(installed.includes(id));
  const current = await cliInbox(mentioned);
  for (const id of [inGeneral, inChannel]) {
    assert.equal(current.get(id)?.to_agent, null);
    assert.equal(current.get(id)?.audience, "workspace");
    assert.equal(signalAddressesAgent(current.get(id)!, mentioned.principal), false, "reached by its mention alone");
  }
  assert.equal(current.get(directed)?.to_agent, mentioned.principal);
  const checked = await check(mentioned);
  for (const id of [inGeneral, inChannel, directed]) assert.ok(checked.includes(id), `check returned ${id}`);
  assert.deepEqual(await check(mentioned), [], "a second check is empty: the cursor moved past every row");

  // Another agent of the same owner: not in its inbox, still in its feed as the public message it is.
  const bystanderInbox = await read(bystander, true);
  for (const id of [inGeneral, inChannel]) assert.equal(byId(bystanderInbox, id), undefined);
  const feed = await read(bystander, false);
  for (const id of [inGeneral, inChannel]) {
    assert.equal(byId(feed, id)?.to_agent, null, "the feed never re-addresses a public message");
    assert.equal(byId(feed, id)?.audience, "workspace");
  }
  assert.deepEqual(await check(bystander), []);

  // An installed client answers a mention privately, to its author; that is accepted.
  assert.equal((await send(mentioned.token, post({ in_reply_to: inChannel, body: "on it" }))).status, 200);
});

test("a person's reply in a thread reaches the agent in it; an agent's own mention never reaches itself", { timeout: 120_000 }, async () => {
  const rootId = await posted(owner.jwt, { mentions: [{ kind: "agent", id: mentioned.principal }] });
  const followUp = await posted(other.jwt, { thread_root_id: rootId, body: "any news?" });
  const inbox = await read(mentioned, true, true);
  assert.deepEqual(byId(inbox, followUp)?.mentions, [{ position: 0, kind: "agent", id: mentioned.principal, source: "thread" }]);
  const checked = await check(mentioned);
  assert.ok(checked.includes(rootId) && checked.includes(followUp), "check returns the thread reply");
  assert.equal((await send(mentioned.token, post({ in_reply_to: followUp, body: "nothing yet" }))).status, 200);

  // The agent mentions itself and the bystander: the bystander is woken and reads it; the author is not.
  const selfMention = await posted(mentioned.token, {
    thread_root_id: rootId, mentions: [{ kind: "agent", id: mentioned.principal }, { kind: "agent", id: bystander.principal }],
  });
  assert.equal(byId(await read(mentioned, true), selfMention), undefined, "not in the author's own inbox");
  assert.equal(byId(await read(mentioned, true, true), selfMention), undefined);
  assert.equal(byId(await read(bystander, true), selfMention)?.to_agent, bystander.principal);
  assert.deepEqual(await check(mentioned), [], "nothing new for the author");
  assert.ok((await check(bystander)).includes(selfMention));
});

test("with a lead set, a person's untagged post reaches the lead's inbox and check", { timeout: 120_000 }, async () => {
  const lead = await createAgent("lead");
  await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = ${lead.principal}::uuid WHERE workspace_id = ${workspace}::uuid`;
  try {
    const untagged = await posted(other.jwt, { body: "who can look at the build?" });
    const row = byId(await read(lead, true, true), untagged);
    assert.deepEqual(row?.mentions, [{ position: 0, kind: "agent", id: lead.principal, source: "lead" }]);
    assert.equal(row?.to_agent, null);
    assert.ok((await installedInbox(lead)).includes(untagged));
    assert.deepEqual(await cliInbox(lead).then((rows) => rows.get(untagged)?.mentions?.map((m) => m.source)), ["lead"]);
    assert.deepEqual(await check(lead), [untagged]);
    assert.equal(byId(await read(mentioned, true), untagged), undefined, "only the lead");
    assert.equal((await send(lead.token, post({ in_reply_to: untagged, body: "I can" }))).status, 200);
  } finally {
    await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = NULL WHERE workspace_id = ${workspace}::uuid`;
  }
});

test("a mention in a private channel leaves the agent's inbox when the agent leaves the channel, though its owner stays", { timeout: 120_000 }, async () => {
  const lockSlug = `lock-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, { kind: "channel_create", slug: lockSlug, visibility: "private",
    members: [{ kind: "agent", id: mentioned.principal }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const lockId = String((created.body.channel as Row).channel_id);
  const inLock = await posted(owner.jwt, { channel: lockSlug, mentions: [{ kind: "agent", id: mentioned.principal }] });
  assert.ok(byId(await read(mentioned, true), inLock), "a member agent reads the mention");
  assert.equal(byId(await read(bystander, true), inLock), undefined);
  assert.equal(byId(await read(bystander, false), inLock), undefined, "nor does the feed show it to an agent outside the channel");

  const removed = await send(owner.jwt, { kind: "channel_member_remove", channel_id: lockId,
    member: { kind: "agent", id: mentioned.principal } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  for (const [inbox, includeMentions] of [[true, undefined], [true, true], [false, undefined]] as const) {
    assert.equal(byId(await read(mentioned, inbox, includeMentions), inLock), undefined,
      `removed: not read with inbox ${inbox}, include_mentions ${includeMentions}`);
  }
  assert.equal((await installedInbox(mentioned)).includes(inLock), false);
});

test("a read that names include_mentions takes only a boolean", async () => {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${mentioned.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null,
      since: null, limit: 10, include_stale: false, include_mentions: "yes" }),
  });
  assert.equal(response.status, 400);
  await response.body?.cancel();
});

/** The CLI itself, as an agent token, against the served functions. */
async function cswarm(agent: Agent, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const tokenFile = join(root, `token-${agent.principal}`);
  writeFileSync(tokenFile, agent.token, { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--url", local.API_URL,
    "--anon-key", local.ANON_KEY, "--workspace-id", workspace, "--agent-token-file", tokenFile, "--json"], {
    cwd: process.cwd(), env: { ...process.env, HOME: root, SWARM_AGENT_STATE_DIR: join(root, "cli-state") },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => stdout += chunk);
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => stderr += chunk);
  const code = await new Promise<number>((resolve) => child.on("close", (value) => resolve(value ?? -1)));
  return { code, stdout, stderr };
}

async function agentName(agent: Agent): Promise<string> {
  const [row] = await sql<{ name: string }[]>`SELECT name FROM swarm.agent_principals WHERE principal_id = ${agent.principal}::uuid`;
  return row!.name;
}

test("cswarm note from an agent token turns @Name into a mention that wakes the named agent", { timeout: 120_000 }, async () => {
  const name = await agentName(mentioned);
  const result = await cswarm(bystander, ["note", `@${name} can you take the build?`]);
  assert.equal(result.code, 0, result.stderr + functionLogs.slice(-3000));
  const id = String((JSON.parse(result.stdout).signal as Row).id);
  const stored = await sql<{ mentioned_agent_principal_id: string }[]>`
    SELECT mentioned_agent_principal_id FROM swarm.signal_mentions WHERE signal_id = ${id}::uuid ORDER BY position`;
  assert.deepEqual(Array.from(stored, (row) => String(row.mentioned_agent_principal_id)), [mentioned.principal]);
  const woken = await sql`SELECT 1 FROM swarm.signal_deliveries
    WHERE signal_id = ${id}::uuid AND recipient_agent_principal_id = ${mentioned.principal}::uuid`;
  assert.equal(woken.length, 1, "the mention enqueued a delivery for the named agent");
  assert.ok((await check(mentioned)).includes(id));
});

test("cswarm reply answers a channel message in its thread, and an addressed one privately", { timeout: 120_000 }, async () => {
  const rootId = await posted(owner.jwt, { body: "open question" });
  const child = await posted(other.jwt, { thread_root_id: rootId, body: "me too" });
  const direct = await posted(owner.jwt, { to_agent_principal_id: mentioned.principal, body: "just you" });
  const placed = async (args: string[]) => {
    const result = await cswarm(mentioned, ["reply", ...args]);
    assert.equal(result.code, 0, result.stderr + functionLogs.slice(-3000));
    const id = String((JSON.parse(result.stdout).signal as Row).id);
    const [row] = await sql<{ thread_root_id: string | null; in_reply_to: string | null }[]>`
      SELECT thread_root_id, in_reply_to FROM swarm.signals WHERE id = ${id}::uuid`;
    return { thread_root_id: row!.thread_root_id, in_reply_to: row!.in_reply_to };
  };
  assert.deepEqual(await placed([rootId, "answer in the open"]), { thread_root_id: rootId, in_reply_to: null });
  assert.deepEqual(await placed([child, "same thread"]), { thread_root_id: rootId, in_reply_to: null });
  assert.deepEqual(await placed([direct, "privately", "--thread"]), { thread_root_id: null, in_reply_to: direct });

  // The read the CLI places a reply with: one row by id, only from what this agent can read.
  const byIdRead = async (agent: Agent, signalId: string) => {
    const response = await fetch(`${local.API_URL}/functions/v1/read`, {
      method: "POST", signal: AbortSignal.timeout(15_000),
      headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
      body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox: false, about: null, kind: null,
        since: null, in_reply_to: null, limit: 1, include_stale: true, signal_id: signalId }),
    });
    const body = await response.json() as Row;
    assert.equal(response.status, 200, JSON.stringify(body));
    return Array.from(body.signals as Row[], (row) => String(row.id));
  };
  assert.deepEqual(await byIdRead(bystander, child), [child]);
  assert.deepEqual(await byIdRead(bystander, direct), [], "a message addressed to another agent is not returned");
  assert.deepEqual(await byIdRead(mentioned, direct), [direct]);
});

