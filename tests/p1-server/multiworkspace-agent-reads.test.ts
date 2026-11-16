/**
 * An agent added to a second workspace (swarm.agent_workspace_memberships) reads the messages
 * addressed to it there, as it does in its first workspace (20261116000005).
 *
 * Before, swarm_read.signals admitted an addressed agent's messages only in the workspace its
 * agent_principals row was created in. In every other workspace the agent's inbox and check came back
 * empty, its delivery rows were never acked, and the roster showed it as not_picking_up; its owner
 * could not read those messages either, the receipts named none of its replies, and home_overview
 * kept answered asks open and missed its held to-dos.
 *
 * Driven against the served read and command functions and real Postgres. The agent's home is
 * `home`; it is a member of `shared` by membership row only.
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
import { deliveryReceiptState, readAgentDeliveryReceipts, type DeliveryReceipt } from "../../src/cloud/delivery-receipts.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { principal: string; token: string; name: string; profilePath: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let root: string;
let previousHome: string | undefined;
let previousState: string | undefined;
/** The agent's first workspace. */
let home: string;
/** The workspace the agent was added to. */
let shared: string;
/** Owns `lead`; a member of both workspaces. */
let owner: Person;
/** A member of `shared` who is addressed alongside `lead` in the multi-recipient message. */
let member: Person;
/** A member of `shared` who is never addressed. */
let bystander: Person;
/** The agent under test: created in `home`, added to `shared`. */
let lead: Agent;
/** The owner's other agent, created in `shared`: the view admits its owner's rows, the read edge narrows them. */
let sibling: Agent;
/** The bystander's agent, created in `shared`. */
let foreign: Agent;

// Shared across the tests below, which run in order.
let broadcast: string;
let note: string;
let ask: string;
let multi: string;
let homeNote: string;
/** A held to-do in `shared` assigned to `lead` (home_overview test). */
let heldShared: string;
/** The to-do `lead` is doing in `shared` (home_overview test). */
let doingShared: string;

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

/** A live local agent with its own token, device and CLI profile, created in `workspace`. */
async function createAgent(label: string, workspace: string, ownedBy: Person): Promise<Agent> {
  const principal = randomUUID();
  const run = randomUUID();
  const device = randomUUID();
  const tokenId = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const name = `${label}-${principal.slice(0, 6)}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownedBy.id}::uuid, ${`mw-${label}`})`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${ownedBy.id}::uuid, ${name})`;
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
  return { principal, token, name, profilePath };
}

async function send(bearer: string, workspace: string, command: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

function post(extra: Row = {}): Row {
  return { kind: "post_signal", signal_kind: "note", body: `multiworkspace ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra };
}

async function posted(bearer: string, workspace: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, workspace, post(extra));
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  const signal = result.body.signal as Row | undefined;
  assert.ok(signal && typeof signal.id === "string", JSON.stringify(result.body));
  return signal.id as string;
}

/** The read every installed client sends. */
async function readAs(agent: Agent, workspace: string, inbox: boolean): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${agent.token}`, apikey: local.ANON_KEY, "content-type": "application/json" },
    body: JSON.stringify({ resource: "signals", workspace_id: workspace, inbox, about: null, kind: null,
      since: null, in_reply_to: null, after_created_at: null, after_id: null, limit: 100, include_stale: false }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function readIds(agent: Agent, workspace: string, inbox: boolean): Promise<string[]> {
  const result = await readAs(agent, workspace, inbox);
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  return (result.body.signals as Row[]).map((row) => String(row.id));
}

/** `cswarm check --workspace-id <workspace>`: the agent's home profile, pointed at another workspace. */
async function check(agent: Agent, workspace: string): Promise<string[]> {
  let result: AgentCheckResult | undefined;
  await checkAgentMessages({ profilePath: agent.profilePath, workspaceId: workspace,
    present: async (value) => { result = value; } });
  assert.ok(result, "check presented a result");
  return result.messages.map((message) => message.id);
}

/** What a person's browser reads from swarm_read.signals (PostgREST: role authenticated, their claims). */
async function viewIds(person: Person, workspace: string): Promise<string[]> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: person.id, role: "authenticated" })}, true)`;
    const rows = await tx<{ id: string }[]>`SELECT id FROM swarm_read.signals WHERE workspace_id = ${workspace}::uuid`;
    return rows.map((row) => row.id);
  });
}

async function asPerson<T>(person: Person, query: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: person.id, role: "authenticated" })}, true)`;
    return await query(tx);
  }) as T;
}

async function receiptsAs(person: Person, workspace: string, signal: string): Promise<Row | null> {
  return await asPerson(person, async (tx) => {
    const [row] = await tx<{ receipt: Row | null }[]>`
      SELECT swarm_read.signal_delivery_receipts(${workspace}::uuid, ${signal}::uuid, NULL) AS receipt`;
    return row!.receipt;
  });
}

/** As the read function calls it: role swarm_read with the owner's claims. */
async function rosterStatus(workspace: string, viewer: Person, principal: string): Promise<string | undefined> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_read`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer.id, role: "authenticated" })}, true)`;
    const [row] = await tx<{ roster: { agents: Array<{ principal_id: string; status: string }> } | null }[]>`
      SELECT swarm_read.workspace_roster(${workspace}::uuid) AS roster`;
    return row!.roster?.agents.find((agent) => agent.principal_id === principal)?.status;
  });
}

/** The agents a person's broadcast receipt lists (its broadcast_roster). */
async function broadcastRoster(person: Person, workspace: string, signal: string): Promise<string[]> {
  const receipt = await receiptsAs(person, workspace, signal);
  assert.equal(receipt?.addressed, false, "a broadcast");
  const agents = (receipt!.broadcast_roster as { agents: { principals: Row[] } }).agents;
  return agents.principals.map((agent) => String(agent.principal_id));
}

/** home_overview's waiting to-dos for one workspace, as [todo_id, reason, agent_id]. */
async function waitingIn(person: Person, workspace: string): Promise<unknown[][]> {
  const overview = await asPerson(person, async (tx) => {
    const [row] = await tx<{ overview: { workspaces: Row[] } }[]>`SELECT swarm_read.home_overview() AS overview`;
    return row!.overview;
  });
  const entry = overview.workspaces.find((candidate) => candidate.workspace_id === workspace);
  assert.ok(entry, `the overview lists ${workspace}`);
  return (entry.needs_you as { waiting: Row[] }).waiting.map((row) => [row.todo_id, row.reason, row.agent_id]);
}

before(async () => {
  local = localEnvironment();
  root = createLaneTempHome("multiworkspace-reads-");
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
  owner = await createUser("mw-owner");
  member = await createUser("mw-member");
  bystander = await createUser("mw-bystander");
  home = randomUUID();
  shared = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'MwOwner'), (${member.id}::uuid, 'MwMember'), (${bystander.id}::uuid, 'MwBystander')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${home}::uuid, 'MwHome', ${owner.id}::uuid), (${shared}::uuid, 'MwShared', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${home}::uuid, ${owner.id}::uuid, 'owner'), (${shared}::uuid, ${owner.id}::uuid, 'owner'),
        (${shared}::uuid, ${member.id}::uuid, 'member'), (${shared}::uuid, ${bystander.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${home}::uuid, 'workspace'), (${randomUUID()}::uuid, ${shared}::uuid, 'workspace')`;
  });
  lead = await createAgent("lead", home, owner);
  // Added to the shared workspace the way add-to-workspace leaves it: a membership row, nothing else.
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${lead.principal}::uuid, ${shared}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)`;
  sibling = await createAgent("sibling", shared, owner);
  foreign = await createAgent("foreign", shared, bystander);
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

test("a note, an ask and a multi-recipient message to the agent in its second workspace reach it, its check and its owner, and no one else", { timeout: 120_000 }, async () => {
  broadcast = await posted(owner.jwt, shared);
  note = await posted(owner.jwt, shared, { to_agent_principal_id: lead.principal });
  ask = await posted(owner.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  // The agent is recipient 1, so only the recipient arm (not the scalar column) names it.
  multi = await posted(owner.jwt, shared, { to: [{ kind: "user", id: member.id }, { kind: "agent", id: lead.principal }] });
  homeNote = await posted(owner.jwt, home, { to_agent_principal_id: lead.principal });
  const addressed = [note, ask, multi];

  // The agent, through the read edge on its own token.
  const inbox = await readIds(lead, shared, true);
  for (const id of addressed) assert.ok(inbox.includes(id), `the agent's inbox in its second workspace holds ${id}`);
  assert.equal(inbox.includes(broadcast), false, "a broadcast is not inbox");
  const feed = await readIds(lead, shared, false);
  for (const id of [...addressed, broadcast]) assert.ok(feed.includes(id), `the agent's feed holds ${id}`);
  assert.equal(feed.includes(homeNote), false, "a read names its workspace");
  assert.ok((await readIds(lead, home, true)).includes(homeNote), "its first workspace reads as before");

  // Its owner, through swarm_read.signals. The view has no sender arm, so each of these is read through
  // the agent the owner owns: the scalar arm for the note and the ask, the recipient arm for multi.
  const ownerView = await viewIds(owner, shared);
  for (const id of [...addressed, broadcast]) assert.ok(ownerView.includes(id), `the owner reads ${id}`);

  // People who can read the workspace (the broadcast proves is_member admits them) and are not addressed.
  const memberView = await viewIds(member, shared);
  assert.ok(memberView.includes(broadcast) && memberView.includes(multi), "the member reads the broadcast and the message addressed to them");
  assert.equal(memberView.includes(note) || memberView.includes(ask), false, "but not the messages to someone else's agent");
  const bystanderView = await viewIds(bystander, shared);
  assert.ok(bystanderView.includes(broadcast), "the bystander reads the workspace");
  for (const id of addressed) assert.equal(bystanderView.includes(id), false, `the bystander does not read ${id}`);

  // Agents that read the workspace: the owner's sibling (admitted by the view through its owner, narrowed by
  // the read edge) and another person's agent.
  for (const other of [sibling, foreign]) {
    const otherFeed = await readIds(other, shared, false);
    assert.ok(otherFeed.includes(broadcast), `${other.name} reads the workspace`);
    const otherInbox = await readIds(other, shared, true);
    for (const id of addressed) {
      assert.equal(otherFeed.includes(id) || otherInbox.includes(id), false, `${other.name} does not read ${id}`);
    }
  }

  // check: surfaces all three, acks each delivery, and the roster leaves not_picking_up.
  await sql`INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at, watcher_at)
    VALUES (${shared}::uuid, ${lead.principal}::uuid, statement_timestamp() - interval '1 minute', statement_timestamp())
    ON CONFLICT (workspace_id, principal_id) DO UPDATE
      SET last_command_at = EXCLUDED.last_command_at, watcher_at = EXCLUDED.watcher_at`;
  const backdated = await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '10 minutes'
    WHERE workspace_id = ${shared}::uuid AND recipient_agent_principal_id = ${lead.principal}::uuid AND acked_at IS NULL
      AND signal_id = ANY(${addressed}::uuid[])`;
  assert.equal(backdated.count, 3, "each addressed message enqueued a delivery for the agent");
  assert.equal(await rosterStatus(shared, owner, lead.principal), "not_picking_up", "waiting deliveries, a wake path and a live key");

  const checked = await check(lead, shared);
  for (const id of addressed) assert.ok(checked.includes(id), `check returned ${id}`);
  assert.equal(checked.includes(homeNote), false, "check reads the workspace it names");
  const waiting = await sql<{ n: string }[]>`SELECT count(*)::text AS n FROM swarm.signal_deliveries
    WHERE workspace_id = ${shared}::uuid AND recipient_agent_principal_id = ${lead.principal}::uuid AND acked_at IS NULL`;
  assert.equal(waiting[0]?.n, "0", "check acked every delivery it surfaced");
  assert.equal(await rosterStatus(shared, owner, lead.principal), "active");
  assert.deepEqual(await check(lead, shared), [], "a second check is empty");
});

test("receipts name the agent's reply in its second workspace, to the asker and to the agent's owner", { timeout: 120_000 }, async () => {
  const reply = await posted(lead.token, shared, { in_reply_to: ask, body: "on it" });
  // The owner asked, so the receipt admits the owner as author; only the responder's name is in question.
  const own = await receiptsAs(owner, shared, ask);
  assert.ok(own);
  assert.equal(own.addressed, true);
  const ownReceipt = (own.receipts as Row[]).find((row) => row.recipient_agent_principal_id === lead.principal);
  assert.equal(ownReceipt?.ack_outcome, "observed", "check's ack shows on the asker's receipt");
  assert.deepEqual((own.replies as Row[]).map((row) => [row.responder_principal_id, row.responder_display_name, row.reply_signal_id]),
    [[lead.principal, lead.name, reply]], "the reply carries the agent's name");

  // Another member asks the agent; the agent answers them. Its owner reads both through the agent.
  const memberAsk = await posted(member.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  const answer = await posted(lead.token, shared, { in_reply_to: memberAsk, body: "done" });
  const oversight = await receiptsAs(owner, shared, memberAsk);
  assert.ok(oversight, "the owner reads the receipt of an ask to its agent");
  assert.deepEqual((oversight.replies as Row[]).map((row) => [row.reply_signal_id, row.responder_display_name]), [[answer, lead.name]]);
  const asker = await receiptsAs(member, shared, memberAsk);
  assert.deepEqual((asker?.replies as Row[]).map((row) => [row.reply_signal_id, row.responder_display_name]), [[answer, lead.name]]);
  // The bystander reads the workspace (first test) but neither the ask nor its receipt.
  assert.equal(await receiptsAs(bystander, shared, memberAsk), null);

  // The attended-seat canary's observed hop: the agent's note to itself, checked, then read back on its token.
  const canary = await posted(lead.token, shared, { to_agent_principal_id: lead.principal, body: "canary" });
  assert.ok((await check(lead, shared)).includes(canary));
  const report = await readAgentDeliveryReceipts(cloudTarget(local.API_URL, local.ANON_KEY), lead.token, shared, canary);
  const mine = report.receipts.find((receipt): receipt is DeliveryReceipt =>
    "recipient_agent_principal_id" in receipt && receipt.recipient_agent_principal_id === lead.principal);
  assert.ok(mine, JSON.stringify(report));
  assert.equal(deliveryReceiptState(mine), "observed");
});

test("a private channel in the second workspace still closes to the agent when it leaves, though its owner reads on", { timeout: 120_000 }, async () => {
  const slug = `mw-lock-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, shared, { kind: "channel_create", slug, visibility: "private",
    members: [{ kind: "agent", id: lead.principal }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String((created.body.channel as Row).channel_id);
  const inLock = await posted(owner.jwt, shared, { channel: slug, to_agent_principal_id: lead.principal });
  assert.ok((await readIds(lead, shared, true)).includes(inLock), "a member agent reads its message in the channel");

  const removed = await send(owner.jwt, shared, { kind: "channel_member_remove", channel_id: channelId,
    member: { kind: "agent", id: lead.principal } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  for (const inbox of [true, false]) {
    assert.equal((await readIds(lead, shared, inbox)).includes(inLock), false, `removed from the channel: not read (inbox ${inbox})`);
  }
  assert.ok((await readIds(lead, shared, true)).includes(note), "the rest of its inbox here is unchanged");
  assert.ok((await viewIds(owner, shared)).includes(inLock), "its owner, still in the channel, reads it");
});

test("home_overview in the second workspace: an ask the owner's agent answered is closed, and its held to-do waits on the owner", { timeout: 60_000 }, async () => {
  const answeredAsk = randomUUID(), openAsk = randomUUID(), held = heldShared = randomUUID(), doing = doingShared = randomUUID(), foreignHeld = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${shared}::uuid, 'shared')`;
    await tx`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
      VALUES (${shared}::uuid, ${owner.id}::uuid, 'reader', ${randomUUID()}::uuid, statement_timestamp())`;
    for (const id of [answeredAsk, openAsk]) {
      await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, created_at)
        VALUES (${id}::uuid, ${shared}::uuid, ${member.id}::uuid, 'user', ${owner.id}::uuid, 'ask', 'question',
          statement_timestamp() + interval '1 day', statement_timestamp() - interval '1 minute')`;
    }
    await tx`INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, in_reply_to, kind, body, until, created_at)
      VALUES (${randomUUID()}::uuid, ${shared}::uuid, ${lead.principal}::uuid, 'agent', ${answeredAsk}::uuid, 'note', 'answered',
        statement_timestamp() + interval '1 day', statement_timestamp())`;
    const todo = async (id: string, assignee: string, gate: string, state: string) => {
      await tx`INSERT INTO swarm.household_todos (workspace_id, todo_id, version, title, state, created_by_user, created_at,
          state_by_user, state_at, last_seq, gate_kind, assignee_principal, assigned_by_user, assigned_at)
        VALUES (${shared}::uuid, ${id}::uuid, 1, 'Synthetic title', ${state}, ${owner.id}::uuid, statement_timestamp(),
          ${owner.id}::uuid, statement_timestamp(), 0, ${gate}, ${assignee}::uuid, ${owner.id}::uuid, statement_timestamp())`;
    };
    await todo(held, lead.principal, "hold", "open");
    await todo(doing, lead.principal, "none", "doing");
    await todo(foreignHeld, foreign.principal, "hold", "open");
  });

  const overview = await asPerson(owner, async (tx) => {
    const [row] = await tx<{ overview: { workspaces: Row[] } }[]>`SELECT swarm_read.home_overview() AS overview`;
    return row!.overview;
  });
  const workspace = overview.workspaces.find((entry) => entry.workspace_id === shared)!;
  assert.ok(workspace);
  const needs = workspace.needs_you as { asks: Row[]; waiting: Row[] };
  const asks = needs.asks.map((entry) => entry.signal_id);
  assert.ok(asks.includes(openAsk), "an unanswered ask to the owner is listed");
  assert.equal(asks.includes(answeredAsk), false, "an ask the owner's agent answered here is not");
  assert.deepEqual(needs.waiting.map((entry) => [entry.todo_id, entry.reason, entry.agent_id]),
    [[held, "hold", lead.principal]], "the held to-do of the owner's agent, and not another person's agent's");
  const agents = (workspace.people as Array<{ user_id: string; agents: Row[] }>)
    .find((person) => person.user_id === owner.id)!.agents;
  const listed = agents.find((agent) => agent.principal_id === lead.principal);
  assert.equal(listed?.name, lead.name, "the agent is listed by name under its owner");
  assert.equal(((listed?.status as Row).facts as { doing: Row | null }).doing?.todo_id, doing, "with the to-do it is doing here");
});

test("removing the agent from the second workspace ends its reads there; its first workspace is unaffected", { timeout: 120_000 }, async () => {
  // A broadcast in each workspace, and a held to-do for the agent in its first workspace beside the one in shared.
  const sharedBroadcast = await posted(owner.jwt, shared);
  const homeBroadcast = await posted(owner.jwt, home);
  const heldHome = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.household_workspace_boundaries (workspace_id, purpose) VALUES (${home}::uuid, 'shared')`;
    await tx`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
      VALUES (${home}::uuid, ${owner.id}::uuid, 'reader', ${randomUUID()}::uuid, statement_timestamp())`;
    await tx`INSERT INTO swarm.household_todos (workspace_id, todo_id, version, title, state, created_by_user, created_at,
        state_by_user, state_at, last_seq, gate_kind, assignee_principal, assigned_by_user, assigned_at)
      VALUES (${home}::uuid, ${heldHome}::uuid, 1, 'Synthetic title', 'open', ${owner.id}::uuid, statement_timestamp(),
        ${owner.id}::uuid, statement_timestamp(), 0, 'hold', ${lead.principal}::uuid, ${owner.id}::uuid, statement_timestamp())`;
  });
  assert.ok((await broadcastRoster(owner, shared, sharedBroadcast)).includes(lead.principal), "listed in shared while a member");
  assert.ok((await broadcastRoster(owner, home, homeBroadcast)).includes(lead.principal), "and in its first workspace");
  assert.deepEqual(await waitingIn(owner, shared), [[heldShared, "hold", lead.principal]]);
  assert.deepEqual(await waitingIn(owner, home), [[heldHome, "hold", lead.principal]]);

  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = clock_timestamp()
    WHERE principal_id = ${lead.principal}::uuid AND workspace_id = ${shared}::uuid`;
  for (const inbox of [true, false]) {
    const refused = await readAs(lead, shared, inbox);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: "forbidden" }, "the membership refusal, not an unknown credential");
  }
  assert.ok((await readIds(lead, home, true)).includes(homeNote), "its first workspace reads as before");

  // The principal is still live: only its shared membership ended.
  const sharedRoster = await broadcastRoster(owner, shared, sharedBroadcast);
  assert.equal(sharedRoster.includes(lead.principal), false, "a removed agent leaves shared's broadcast roster");
  assert.ok(sharedRoster.includes(sibling.principal), "while the agents still there stay");
  assert.ok((await broadcastRoster(owner, home, homeBroadcast)).includes(lead.principal), "its first workspace still lists it");
  // Both of its shared to-dos (the held one and the one it was doing) now wait on the owner as agent_removed.
  const sortById = (rows: unknown[][]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(sortById(await waitingIn(owner, shared)),
    sortById([[heldShared, "agent_removed", lead.principal], [doingShared, "agent_removed", lead.principal]]),
    "an agent removed from shared, though its principal is live, reads as removed there");
  assert.deepEqual(await waitingIn(owner, home), [[heldHome, "hold", lead.principal]], "its first workspace is unchanged");

  const ownerView = await viewIds(owner, shared);
  for (const id of [note, ask, multi]) {
    assert.ok(ownerView.includes(id), `its owner still reads ${id}, as for an agent removed from its first workspace`);
  }
});
