/**
 * Attended seats acknowledge what they act on, in every workspace they belong to.
 *
 * An agent added to a second workspace (swarm.agent_workspace_memberships) that answers or reacts to
 * a message there has seen it, so the reply or the reaction observes the agent's own unclaimed
 * delivery of that message; leased rows and other agents' rows are untouched. check acknowledges a
 * whole page in one batched ack_agent_delivery. Wake-path eligibility (the admin view and the
 * caller-scoped function, 20261117000003) counts the agent's deliveries in its second workspace and
 * its mentions, and keeps private channels closed. Its owner can answer a message addressed to the
 * agent there.
 *
 * Driven against the served command function and real Postgres. Each test makes its own agent,
 * created in `home` and added to `shared` by a membership row only.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { createLaneTempHome, removeLaneTempHome } from "../support/lane-temp-home.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Agent = { principal: string; token: string };
type Row = Record<string, unknown>;

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let root: string;
let home: string;
let shared: string;
/** Owns every agent under test; a member of both workspaces. */
let owner: Person;
/** A member of `shared` who writes to the owner's agents. */
let member: Person;
/** A member of `shared` with an agent of its own. */
let bystander: Person;

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

/** A live local agent with its own token, created in `workspace`. */
async function createAgent(label: string, workspace: string, ownedBy: Person): Promise<Agent> {
  const principal = randomUUID();
  const run = randomUUID();
  const device = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownedBy.id}::uuid, ${`mwack-${label}`})`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${ownedBy.id}::uuid, ${`${label}-${principal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token };
}

/** The owner's agent: created in `home`, added to `shared` the way add-to-workspace leaves it. */
async function secondWorkspaceAgent(label: string): Promise<Agent> {
  const agent = await createAgent(label, home, owner);
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${agent.principal}::uuid, ${shared}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)`;
  return agent;
}

async function send(bearer: string, workspace: string, command: Row, commandId = randomUUID()): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: commandId, client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

function post(extra: Row = {}): Row {
  return { kind: "post_signal", signal_kind: "note", body: `delivery ack ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra };
}

async function posted(bearer: string, workspace: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, workspace, post(extra));
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  const signal = result.body.signal as Row | undefined;
  assert.ok(signal && typeof signal.id === "string", JSON.stringify(result.body));
  return signal.id as string;
}

function observeShape(extra: Row): Row {
  return { kind: "ack_agent_delivery", lease_id: null, listener_instance_id: null, outcome: "observed",
    last_error_code: null, surfaced: true, unclaimed: true, ...extra };
}

/** The agent's delivery row for a signal, as plain values. */
async function delivery(signal: string, principal: string): Promise<Row | undefined> {
  const [row] = await sql<{
    acked_at: Date | null; ack_outcome: string | null; ack_via: string | null; delivered_at: Date | null;
    lease_id: string | null; leased_by: string | null; last_lease_id: string | null; last_leased_by: string | null;
  }[]>`
    SELECT acked_at, ack_outcome, ack_via, delivered_at, lease_id, leased_by, last_lease_id, last_leased_by
    FROM swarm.signal_deliveries
    WHERE workspace_id = ${shared}::uuid AND signal_id = ${signal}::uuid
      AND recipient_agent_principal_id = ${principal}::uuid`;
  return row === undefined ? undefined : {
    acked_at: row.acked_at?.toISOString() ?? null,
    ack_outcome: row.ack_outcome,
    ack_via: row.ack_via,
    delivered: row.delivered_at !== null,
    lease_id: row.lease_id,
    leased_by: row.leased_by,
    last_lease_id: row.last_lease_id,
    last_leased_by: row.last_leased_by,
  };
}

function assertObservedUnclaimed(row: Row | undefined, label: string): void {
  assert.ok(row, `${label}: the agent has a delivery row`);
  assert.equal(row.ack_outcome, "observed", label);
  assert.equal(row.ack_via, "unclaimed", label);
  assert.ok(row.acked_at !== null && row.delivered === true, label);
  assert.deepEqual([row.lease_id, row.leased_by, row.last_lease_id, row.last_leased_by], [null, null, null, null], label);
}

/** As the read function calls it: role swarm_read with the viewer's claims. */
async function rosterStatus(viewer: Person, principal: string): Promise<string | undefined> {
  return await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_read`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewer.id, role: "authenticated" })}, true)`;
    const [row] = await tx<{ roster: { agents: Array<{ principal_id: string; status: string }> } | null }[]>`
      SELECT swarm_read.workspace_roster(${shared}::uuid) AS roster`;
    return row!.roster?.agents.find((agent) => agent.principal_id === principal)?.status;
  });
}

/** A seat with a live watcher whose deliveries have waited ten minutes: what the roster calls not_picking_up. */
async function waitingSeat(principal: string, signals: string[]): Promise<void> {
  await sql`INSERT INTO swarm.agent_presence (workspace_id, principal_id, last_command_at, watcher_at)
    VALUES (${shared}::uuid, ${principal}::uuid, statement_timestamp() - interval '1 minute', statement_timestamp())
    ON CONFLICT (workspace_id, principal_id) DO UPDATE
      SET last_command_at = EXCLUDED.last_command_at, watcher_at = EXCLUDED.watcher_at`;
  const backdated = await sql`UPDATE swarm.signal_deliveries SET enqueued_at = statement_timestamp() - interval '10 minutes'
    WHERE workspace_id = ${shared}::uuid AND recipient_agent_principal_id = ${principal}::uuid AND acked_at IS NULL
      AND signal_id = ANY(${signals}::uuid[])`;
  assert.equal(backdated.count, signals.length);
}

async function auditCount(principal: string, outcome: string): Promise<number> {
  const [row] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.audit_log
    WHERE actor_agent_principal = ${principal}::uuid AND command_kind = 'ack_agent_delivery' AND outcome = ${outcome}`;
  return row!.n;
}

/** The admin view, for one agent in `shared`. */
async function viewEligible(principal: string): Promise<string[]> {
  const rows = await sql<{ signal_id: string }[]>`SELECT signal_id::text FROM swarm.wake_path_eligible_deliveries
    WHERE workspace_id = ${shared}::uuid AND principal_id = ${principal}::uuid ORDER BY signal_id`;
  return rows.map((row) => row.signal_id);
}

/** The caller-scoped function (agent_wake_path and receipts read it), for one agent in `shared`. */
async function actorEligible(viewerKind: "user" | "agent", viewer: string, principal: string): Promise<string[]> {
  const rows = await sql<{ signal_id: string }[]>`SELECT signal_id::text
    FROM swarm.actor_wake_path_eligible_deliveries(${viewerKind}, ${viewer}::uuid)
    WHERE workspace_id = ${shared}::uuid AND principal_id = ${principal}::uuid ORDER BY signal_id`;
  return rows.map((row) => row.signal_id);
}

before(async () => {
  local = localEnvironment();
  root = createLaneTempHome("multiworkspace-ack-");
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
  owner = await createUser("mwack-owner");
  member = await createUser("mwack-member");
  bystander = await createUser("mwack-bystander");
  home = randomUUID();
  shared = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'AckOwner'), (${member.id}::uuid, 'AckMember'), (${bystander.id}::uuid, 'AckBystander')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${home}::uuid, 'AckHome', ${owner.id}::uuid), (${shared}::uuid, 'AckShared', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${home}::uuid, ${owner.id}::uuid, 'owner'), (${shared}::uuid, ${owner.id}::uuid, 'owner'),
        (${shared}::uuid, ${member.id}::uuid, 'member'), (${shared}::uuid, ${bystander.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${randomUUID()}::uuid, ${home}::uuid, 'workspace'), (${randomUUID()}::uuid, ${shared}::uuid, 'workspace')`;
  });
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
  if (root) removeLaneTempHome(root);
}, { timeout: 10_000 });

test("a reply observes the replying agent's own unleased delivery in its second workspace; the roster leaves not_picking_up", { timeout: 60_000 }, async () => {
  const lead = await secondWorkspaceAgent("replier");
  const ask = await posted(owner.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  await waitingSeat(lead.principal, [ask]);
  assert.equal(await rosterStatus(owner, lead.principal), "not_picking_up");
  assert.equal((await delivery(ask, lead.principal))?.acked_at, null);

  const commandId = randomUUID();
  const replyCommand = post({ in_reply_to: ask, body: "on it" });
  const reply = await send(lead.token, shared, replyCommand, commandId);
  assert.equal(reply.status, 200, JSON.stringify(reply.body) + functionLogs.slice(-3000));
  assert.deepEqual(Object.keys(reply.body).sort(), ["event_ids", "events", "min_client_version", "ok", "signal", "status"],
    "the reply's result is unchanged");
  const observed = await delivery(ask, lead.principal);
  assertObservedUnclaimed(observed, "the replied-to ask");
  assert.equal(await rosterStatus(owner, lead.principal), "active");

  // A replay returns the stored reply and observes nothing twice.
  const replay = await send(lead.token, shared, replyCommand, commandId);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body.signal, reply.body.signal);
  assert.deepEqual(await delivery(ask, lead.principal), observed);
  const [replies] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.signals
    WHERE workspace_id = ${shared}::uuid AND in_reply_to = ${ask}::uuid`;
  assert.equal(replies!.n, 1, "one reply");
});

test("a 👀 on an @mention in the second workspace observes the reacting agent's delivery; another agent's reaction does not", { timeout: 60_000 }, async () => {
  const lead = await secondWorkspaceAgent("reactor");
  const other = await createAgent("other-reactor", shared, bystander);
  const mention = await posted(owner.jwt, shared, { mentions: [{ kind: "agent", id: lead.principal }] });
  const before = await delivery(mention, lead.principal);
  assert.ok(before, "a mention enqueues a delivery for the agent in its second workspace");
  assert.equal(before.acked_at, null);

  const foreign = await send(other.token, shared, { kind: "add_reaction", signal_id: mention, emoji: "\u{1F440}" });
  assert.equal(foreign.status, 200, JSON.stringify(foreign.body));
  assert.deepEqual(await delivery(mention, lead.principal), before, "another agent's reaction leaves this agent's row alone");

  const reacted = await send(lead.token, shared, { kind: "add_reaction", signal_id: mention, emoji: "\u{1F440}" });
  assert.equal(reacted.status, 200, JSON.stringify(reacted.body) + functionLogs.slice(-3000));
  assert.deepEqual(reacted.body, { status: "accepted", ok: true, event_ids: [], signal_id: mention, emoji: "\u{1F440}", added: true },
    "the reaction's result is unchanged");
  assertObservedUnclaimed(await delivery(mention, lead.principal), "the mention");

  // Removing a reaction observes nothing, and neither does a client's automatic 👀 (source "ack"):
  // check and the watcher decide their own acknowledgement.
  const directed = await posted(owner.jwt, shared, { to_agent_principal_id: lead.principal });
  assert.equal((await send(lead.token, shared, { kind: "remove_reaction", signal_id: directed, emoji: "\u{1F440}" })).status, 200);
  assert.equal((await delivery(directed, lead.principal))?.acked_at, null, "remove_reaction observes nothing");
  const automatic = await send(lead.token, shared, { kind: "add_reaction", signal_id: directed, emoji: "\u{1F440}", source: "ack" });
  assert.equal(automatic.status, 200, JSON.stringify(automatic.body));
  assert.equal((await delivery(directed, lead.principal))?.acked_at, null, "an automatic seen mark observes nothing");
});

test("a reply leaves a leased delivery and another agent's delivery of the same message exactly as they were", { timeout: 60_000 }, async () => {
  const lead = await secondWorkspaceAgent("leased");
  const peer = await createAgent("peer", shared, owner);
  const leasedAsk = await posted(owner.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  const claim = await send(lead.token, shared, { kind: "claim_agent_inbox", listener_instance_id: randomUUID() });
  assert.equal(claim.status, 200, JSON.stringify(claim.body) + functionLogs.slice(-3000));
  const leased = await delivery(leasedAsk, lead.principal);
  assert.ok(leased?.lease_id, "the listener holds a lease");
  assert.equal((await send(lead.token, shared, post({ in_reply_to: leasedAsk, body: "from the session" }))).status, 200);
  assert.deepEqual(await delivery(leasedAsk, lead.principal), leased, "a leased row is the listener's to acknowledge");

  const both = await posted(owner.jwt, shared, { to: [{ kind: "agent", id: lead.principal }, { kind: "agent", id: peer.principal }] });
  const peerBefore = await delivery(both, peer.principal);
  assert.ok(peerBefore && peerBefore.acked_at === null);
  assert.equal((await send(lead.token, shared, post({ in_reply_to: both, body: "mine" }))).status, 200);
  assertObservedUnclaimed(await delivery(both, lead.principal), "the replying agent's own row");
  assert.deepEqual(await delivery(both, peer.principal), peerBefore, "the other recipient's row is untouched");
});

test("a batched observation acks several ids in one request, answers each on its own, and leaves the single shape as it was", { timeout: 60_000 }, async () => {
  const lead = await secondWorkspaceAgent("batch");
  const peer = await createAgent("batch-peer", shared, owner);
  const note = await posted(owner.jwt, shared, { to_agent_principal_id: lead.principal });
  const ask = await posted(member.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  const mention = await posted(owner.jwt, shared, { mentions: [{ kind: "agent", id: lead.principal }] });
  const notMine = await posted(owner.jwt, shared, { to_agent_principal_id: peer.principal });
  const unknown = randomUUID();
  const ids = (count: number) => Array.from({ length: count }, () => randomUUID());

  for (const [label, command] of [
    ["no ids", observeShape({ signal_ids: [] })],
    ["51 ids", observeShape({ signal_ids: ids(51) })],
    ["a malformed id", observeShape({ signal_ids: [note, "not-a-uuid"] })],
    ["signal_id beside signal_ids", observeShape({ signal_ids: [note], signal_id: note })],
    ["a lease", observeShape({ signal_ids: [note], lease_id: randomUUID(), listener_instance_id: randomUUID() })],
    ["another outcome", observeShape({ signal_ids: [note], outcome: "replied" })],
    ["no unclaimed", (({ unclaimed: _u, ...rest }) => rest)(observeShape({ signal_ids: [note] }))],
    ["no surfaced", (({ surfaced: _s, ...rest }) => rest)(observeShape({ signal_ids: [note] }))],
    ["surfaced false", observeShape({ signal_ids: [note], surfaced: false })],
    ["an extra key", observeShape({ signal_ids: [note], extra: 1 })],
  ] as const) {
    const refused = await send(lead.token, shared, command as Row);
    assert.equal(refused.status, 400, `${label}: ${JSON.stringify(refused.body)}`);
    assert.equal(refused.body.error, "invalid_request", label);
  }
  assert.equal((await delivery(note, lead.principal))?.acked_at, null, "nothing refused wrote anything");

  const acceptedBefore = await auditCount(lead.principal, "accepted");
  const commandId = randomUUID();
  const batch = observeShape({ signal_ids: [note, ask, note.toUpperCase(), unknown, notMine] });
  const accepted = await send(lead.token, shared, batch, commandId);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body) + functionLogs.slice(-3000));
  assert.deepEqual(accepted.body, {
    status: "accepted", ok: true, event_ids: [], outcome: "observed",
    signal_ids: [note, ask, unknown, notMine],
    observed_signal_ids: [note, ask],
    refused: [{ signal_id: unknown, error: "delivery_unavailable" }, { signal_id: notMine, error: "delivery_unavailable" }],
  });
  assertObservedUnclaimed(await delivery(note, lead.principal), "the note");
  assertObservedUnclaimed(await delivery(ask, lead.principal), "the ask");
  assert.equal((await delivery(notMine, peer.principal))?.acked_at, null, "another agent's delivery is not this agent's to ack");
  assert.equal(await auditCount(lead.principal, "accepted"), acceptedBefore + 1, "one audit row for the request");

  const replayedBefore = await auditCount(lead.principal, "replayed");
  const replay = await send(lead.token, shared, batch, commandId);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.deepEqual(replay.body, accepted.body, "a replay returns the stored answer");
  assert.equal(await auditCount(lead.principal, "replayed"), replayedBefore + 1);

  // Already observed answers observed again; the single shape is exactly what older clients send.
  const again = await send(lead.token, shared, observeShape({ signal_ids: [note] }));
  assert.deepEqual(again.body.observed_signal_ids, [note]);
  const single = await send(lead.token, shared, observeShape({ signal_id: mention }));
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.deepEqual(single.body, { status: "accepted", ok: true, event_ids: [], signal_id: mention, outcome: "observed" });
  assertObservedUnclaimed(await delivery(mention, lead.principal), "the mention, through the single shape");
});

test("wake-path eligibility counts the agent's deliveries in its second workspace and its mentions, and keeps private channels closed", { timeout: 90_000 }, async () => {
  const lead = await secondWorkspaceAgent("wake");
  // The observed seed: one delivery the seat observed unclaimed.
  const seed = await posted(owner.jwt, shared, { to_agent_principal_id: lead.principal });
  assert.equal((await send(lead.token, shared, observeShape({ signal_id: seed }))).status, 200);
  const directed = await posted(member.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  const mention = await posted(owner.jwt, shared, { mentions: [{ kind: "agent", id: lead.principal }] });

  assert.deepEqual(await viewEligible(lead.principal), [directed, mention].sort(), "the admin view");
  assert.deepEqual(await actorEligible("user", owner.id, lead.principal), [directed, mention].sort(), "the owner's view");
  assert.deepEqual(await actorEligible("agent", lead.principal, lead.principal), [directed, mention].sort(), "the agent's own view");
  const directedReceipt = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: member.id, role: "authenticated" })}, true)`;
    const [row] = await tx<{ value: { receipts: Row[] } | null }[]>`
      SELECT swarm_read.signal_delivery_receipts(${shared}::uuid, ${directed}::uuid, NULL) AS value`;
    return row!.value;
  });
  assert.equal(directedReceipt?.receipts.find((row) => row.recipient_agent_principal_id === lead.principal)?.wake_path_observing, true,
    "the asker's receipt says the agent's wake path is observing");

  // A private channel the agent is in: eligible for the owner (a member), never shown to a person outside it.
  const slug = `mwack-lock-${randomBytes(4).toString("hex")}`;
  const created = await send(owner.jwt, shared, { kind: "channel_create", slug, visibility: "private",
    members: [{ kind: "agent", id: lead.principal }] });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const channelId = String((created.body.channel as Row).channel_id);
  const locked = await posted(owner.jwt, shared, { channel: slug, to_agent_principal_id: lead.principal });
  assert.ok((await viewEligible(lead.principal)).includes(locked));
  assert.ok((await actorEligible("user", owner.id, lead.principal)).includes(locked));
  assert.equal((await actorEligible("user", bystander.id, lead.principal)).includes(locked), false,
    "a person outside the private channel never sees it");
  const removed = await send(owner.jwt, shared, { kind: "channel_member_remove", channel_id: channelId,
    member: { kind: "agent", id: lead.principal } });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal((await viewEligible(lead.principal)).includes(locked), false, "the agent left the channel");
  assert.equal((await actorEligible("user", owner.id, lead.principal)).includes(locked), false);

  // Only a live membership counts: removed from the second workspace, nothing there is eligible.
  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = clock_timestamp()
    WHERE principal_id = ${lead.principal}::uuid AND workspace_id = ${shared}::uuid`;
  assert.deepEqual(await viewEligible(lead.principal), []);
  assert.deepEqual(await actorEligible("user", owner.id, lead.principal), []);
});

test("the owner answers a message addressed to its agent in the agent's second workspace", { timeout: 60_000 }, async () => {
  const lead = await secondWorkspaceAgent("owned");
  const ask = await posted(member.jwt, shared, { signal_kind: "ask", to_agent_principal_id: lead.principal });
  const answer = await send(owner.jwt, shared, post({ in_reply_to: ask, body: "answering for my agent" }));
  assert.equal(answer.status, 200, JSON.stringify(answer.body) + functionLogs.slice(-3000));
  assert.equal((answer.body.signal as Row).to, member.id, "the answer goes to the asker");

  // Recipient 1 of a multi-recipient message: the recipient set, not the scalar column, names the agent.
  const multi = await posted(member.jwt, shared, { to: [{ kind: "user", id: bystander.id }, { kind: "agent", id: lead.principal }] });
  const multiAnswer = await send(owner.jwt, shared, post({ in_reply_to: multi, body: "on behalf of my agent" }));
  assert.equal(multiAnswer.status, 200, JSON.stringify(multiAnswer.body));

  // Someone who neither received the ask nor owns its agent still cannot answer it.
  const stranger = await send(bystander.jwt, shared, post({ in_reply_to: ask, body: "me too" }));
  assert.notEqual(stranger.status, 200, JSON.stringify(stranger.body));
});
