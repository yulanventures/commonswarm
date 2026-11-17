/**
 * Channel leads against the served command and read functions and real Postgres: each lead mode in an
 * open and a private channel, general unchanged, the cases that never wake a lead, the cleanup
 * triggers, who may set a lead, the audit view, replay, and the read surface.
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
type Person = { id: string; jwt: string };
type Row = Record<string, unknown>;
type Agent = { principal: string; token: string };
type Channel = { id: string; slug: string };

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let owner: Person;
let member: Person;
let outsider: Person;
let wsLead: Agent;

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

/** A person in this workspace with the given role. */
async function person(label: string, role: "owner" | "admin" | "member"): Promise<Person> {
  const created = await createUser(label);
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${created.id}::uuid, ${label})`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${created.id}::uuid, ${role})`;
  return created;
}

/** A live local agent with a token; its workspace membership is written by the principal sync trigger. */
async function agentOf(ownerId: string, name: string, extra: { turnOnly?: boolean } = {}): Promise<Agent> {
  const principal = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownerId}::uuid, 'lead-tests')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, turn_only)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${ownerId}::uuid, ${`${name}-${principal.slice(0, 6)}`}, ${extra.turnOnly === true})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token };
}

async function send(bearer: string, command: Row, commandId: string = randomUUID()): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: commandId, client_version: "0.1.0",
      workspace_id: workspace, stream: { kind: "workspace" }, command }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function channel(by: Person, prefix: string, extra: Row = {}): Promise<Channel> {
  const slug = `${prefix}-${randomBytes(4).toString("hex")}`;
  const created = await send(by.jwt, { kind: "channel_create", slug, ...extra });
  assert.equal(created.status, 200, JSON.stringify(created.body) + functionLogs.slice(-3000));
  return { id: String((created.body.channel as Row).channel_id), slug };
}

const setLead = (bearer: string, channelId: string, lead: Row, commandId?: string) =>
  send(bearer, { kind: "set_channel_lead", channel_id: channelId, ...lead }, commandId);

async function leadSet(bearer: string, channelId: string, lead: Row): Promise<Row> {
  const result = await setLead(bearer, channelId, lead);
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  return result.body;
}

/** A note from a person (or agent), unaddressed unless extra says otherwise; returns the signal id. */
async function post(bearer: string, extra: Row = {}): Promise<string> {
  const result = await send(bearer, { kind: "post_signal", signal_kind: "note", body: `lead ${randomUUID()}`,
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null, ...extra });
  assert.equal(result.status, 200, JSON.stringify(result.body) + functionLogs.slice(-3000));
  const signal = result.body.signal as Row;
  return String(signal.id);
}

/** Who a message mentions as its lead, and which agents it was delivered to. */
async function woken(signalId: string): Promise<{ lead: string[]; delivered: string[] }> {
  const lead = await sql<{ p: string }[]>`
    SELECT mentioned_agent_principal_id::text AS p FROM swarm.signal_mentions
    WHERE signal_id = ${signalId}::uuid AND source = 'lead' ORDER BY position`;
  const delivered = await sql<{ p: string }[]>`
    SELECT recipient_agent_principal_id::text AS p FROM swarm.signal_deliveries
    WHERE signal_id = ${signalId}::uuid ORDER BY 1`;
  return { lead: lead.map((row) => row.p), delivered: delivered.map((row) => row.p) };
}

const only = (agent: Agent) => ({ lead: [agent.principal], delivered: [agent.principal] });
const nobody = { lead: [], delivered: [] };

async function stored(channelId: string): Promise<{ lead_mode: string; lead_agent_principal_id: string | null }> {
  const [row] = await sql<{ lead_mode: string; lead_agent_principal_id: string | null }[]>`
    SELECT lead_mode, lead_agent_principal_id::text AS lead_agent_principal_id FROM swarm.channels
    WHERE channel_id = ${channelId}::uuid`;
  return { ...row! };
}

async function effective(channelId: string | null): Promise<string | null> {
  const [row] = await sql<{ p: string | null }[]>`
    SELECT swarm.channel_effective_live_lead(${workspace}::uuid, ${channelId}::uuid)::text AS p`;
  return row!.p;
}

async function addMember(channelId: string, agent: Agent): Promise<void> {
  const added = await send(owner.jwt, { kind: "channel_member_add", channel_id: channelId,
    members: [{ kind: "agent", id: agent.principal }] });
  assert.equal(added.status, 200, JSON.stringify(added.body));
}

async function auditMark(): Promise<string> {
  const [row] = await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`;
  return row!.mark;
}

async function rawAudit(mark: string): Promise<Array<{ outcome: string; reason: string | null; channel_ids: string[] | null }>> {
  const rows = await sql<{ outcome: string; reason: string | null; channel_ids: string[] | null }[]>`
    SELECT outcome, reason, channel_ids::text[] AS channel_ids FROM swarm.audit_log
    WHERE workspace_id = ${workspace}::uuid AND command_kind = 'set_channel_lead' AND audit_id > ${mark}::bigint
    ORDER BY audit_id`;
  return rows.map((row) => ({ ...row }));
}

async function auditSeenBy(userId: string, mark: string): Promise<string[]> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const rows = await tx<{ outcome: string }[]>`
      SELECT outcome FROM swarm_read.audit_log
      WHERE workspace_id = ${workspace}::uuid AND command_kind = 'set_channel_lead' AND audit_id > ${mark}::bigint
      ORDER BY audit_id`;
    return rows.map((row) => row.outcome);
  }) as string[];
}

/** swarm_read.channels as this person reads it over REST. */
async function channelsSeenBy(userId: string): Promise<Map<string, Row>> {
  return await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const rows = await tx<Row[]>`
      SELECT channel_id::text AS channel_id, visibility, lead_mode, lead_agent_principal_id::text AS lead_agent_principal_id
      FROM swarm_read.channels WHERE workspace_id = ${workspace}::uuid`;
    return new Map(rows.map((row) => [String(row.channel_id), { ...row }]));
  }) as Map<string, Row>;
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cswarm-channel-leads-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, detached: true, stdio: ["ignore", "pipe", "pipe"],
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
    if (Date.now() >= bootDeadline || functionProcess.exitCode !== null) throw new Error("local functions serve did not start");
    await delay(250);
  }
  await awaitFunctionRunning({ url: `${local.API_URL}/functions/v1/command`, fetcher: fetch,
    timeoutMs: 30_000, sleep: (ms) => delay(ms), now: () => Date.now(),
    diagnostics: () => "local command function was not ready", cliState });
  workspace = randomUUID();
  const ownerUser = await createUser("leads-owner");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${ownerUser.id}::uuid, 'LeadsOwner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'LeadsWS', ${ownerUser.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${ownerUser.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
  });
  owner = ownerUser;
  member = await person("LeadsMember", "member");
  outsider = await person("LeadsOutsideAdmin", "admin");
  wsLead = await agentOf(owner.id, "ws-lead");
  await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = ${wsLead.principal}::uuid WHERE workspace_id = ${workspace}::uuid`;
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
  if (envDir) rmSync(envDir, { recursive: true, force: true });
}, { timeout: 10_000 });

test("an open channel wakes the workspace lead, its own agent, or nobody; general keeps the workspace lead", { timeout: 90_000 }, async () => {
  const design = await channel(owner, "design");
  const chLead = await agentOf(owner.id, "design-lead");
  assert.deepEqual(await stored(design.id), { lead_mode: "workspace", lead_agent_principal_id: null }, "the default changes nothing");
  assert.deepEqual(await woken(await post(member.jwt, { channel: design.slug })), only(wsLead));

  const set = await leadSet(owner.jwt, design.id, { lead_mode: "agent", principal_id: chLead.principal });
  assert.equal(set.status, "accepted");
  const shown = set.channel as Row;
  assert.deepEqual([shown.channel_id, shown.lead_mode, shown.lead_agent_principal_id], [design.id, "agent", chLead.principal]);
  assert.deepEqual(await stored(design.id), { lead_mode: "agent", lead_agent_principal_id: chLead.principal });
  const inDesign = await post(member.jwt, { channel: design.slug });
  assert.deepEqual(await woken(inDesign), only(chLead), "the channel's lead, not the workspace lead");
  const asked = await post(member.jwt, { channel: design.slug, signal_kind: "ask" });
  assert.deepEqual(await woken(asked), only(chLead), "an ask too");
  assert.deepEqual(await woken(await post(member.jwt)), only(wsLead), "general keeps the workspace lead");
  assert.equal(await effective(null), wsLead.principal);

  await leadSet(owner.jwt, design.id, { lead_mode: "none" });
  assert.deepEqual(await stored(design.id), { lead_mode: "none", lead_agent_principal_id: null });
  assert.deepEqual(await woken(await post(member.jwt, { channel: design.slug })), nobody);
  assert.deepEqual(await woken(await post(member.jwt)), only(wsLead), "general is still the workspace lead");

  await leadSet(owner.jwt, design.id, { lead_mode: "workspace" });
  assert.deepEqual(await woken(await post(member.jwt, { channel: design.slug })), only(wsLead));
});

test("a private channel wakes only a lead it has admitted", { timeout: 90_000 }, async () => {
  const chLead = await agentOf(owner.id, "lock-lead");
  const lock = await channel(owner, "lock", { visibility: "private", members: [{ kind: "user", id: member.id }] });
  // Workspace mode: the workspace lead is not in the channel, so nobody is woken (the existing guard).
  assert.deepEqual(await woken(await post(member.jwt, { channel: lock.slug })), nobody);
  assert.equal(await effective(lock.id), null);
  await addMember(lock.id, wsLead);
  assert.deepEqual(await woken(await post(member.jwt, { channel: lock.slug })), only(wsLead));

  // An agent outside the channel cannot be its lead.
  const refused = await setLead(owner.jwt, lock.id, { lead_mode: "agent", principal_id: chLead.principal });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, "channel_lead_not_eligible");
  assert.deepEqual(await stored(lock.id), { lead_mode: "workspace", lead_agent_principal_id: null });

  await addMember(lock.id, chLead);
  await leadSet(owner.jwt, lock.id, { lead_mode: "agent", principal_id: chLead.principal });
  assert.deepEqual(await woken(await post(member.jwt, { channel: lock.slug })), only(chLead));
  await leadSet(owner.jwt, lock.id, { lead_mode: "none" });
  assert.deepEqual(await woken(await post(member.jwt, { channel: lock.slug })), nobody);
});

test("only an untagged top-level post from a person wakes the channel lead", { timeout: 90_000 }, async () => {
  const ops = await channel(owner, "ops");
  const chLead = await agentOf(owner.id, "ops-lead");
  const author = await agentOf(owner.id, "ops-author");
  await leadSet(owner.jwt, ops.id, { lead_mode: "agent", principal_id: chLead.principal });
  const root = await post(member.jwt, { channel: ops.slug });
  assert.deepEqual(await woken(root), only(chLead));

  const reply = await post(owner.jwt, { thread_root_id: root });
  assert.deepEqual((await woken(reply)).lead, [], "a thread reply");
  const addressed = await post(member.jwt, { channel: ops.slug, to_user_id: owner.id });
  assert.deepEqual(await woken(addressed), nobody, "an addressed post");
  const toAgent = await post(member.jwt, { channel: ops.slug, to_agent_principal_id: author.principal });
  assert.deepEqual(await woken(toAgent), { lead: [], delivered: [author.principal] }, "a post addressed to another agent");
  const tagged = await post(member.jwt, { channel: ops.slug, mentions: [{ kind: "user", id: owner.id }] });
  assert.deepEqual(await woken(tagged), nobody, "a post that names someone");
  const byAgent = await post(author.token, { channel: ops.slug });
  assert.deepEqual(await woken(byAgent), nobody, "an agent's post");

  // An archived channel has no lead and takes no posts.
  assert.equal((await send(owner.jwt, { kind: "channel_archive", channel_id: ops.id })).status, 200);
  assert.equal(await effective(ops.id), null);
  const archived = await send(member.jwt, { kind: "post_signal", signal_kind: "note", body: "late", to_user_id: null,
    about: null, to_agent_principal_id: null, in_reply_to: null, channel: ops.slug });
  assert.equal(archived.status, 409);
  assert.equal(archived.body.error, "channel_archived");
  // A channel that does not resolve wakes nobody; the post is refused as before.
  const unknown = await send(member.jwt, { kind: "post_signal", signal_kind: "note", body: "x", to_user_id: null,
    about: null, to_agent_principal_id: null, in_reply_to: null, channel: `nope-${randomBytes(3).toString("hex")}` });
  assert.equal(unknown.status, 404);
});

test("a named lead that leaves puts the channel back on the workspace lead", { timeout: 90_000 }, async () => {
  const back = { lead_mode: "workspace", lead_agent_principal_id: null };
  async function led(lead: Agent, visibility: "open" | "private" = "open"): Promise<Channel> {
    const created = await channel(owner, "leave", visibility === "private"
      ? { visibility, members: [{ kind: "agent", id: lead.principal }] } : {});
    await leadSet(owner.jwt, created.id, { lead_mode: "agent", principal_id: lead.principal });
    return created;
  }

  const revoked = await agentOf(owner.id, "revoked");
  const revokedIn = await led(revoked);
  const revokedPrivate = await led(revoked, "private");
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${revoked.principal}::uuid`;
  assert.deepEqual(await stored(revokedIn.id), back, "principal revoked");
  assert.deepEqual(await stored(revokedPrivate.id), back, "principal revoked, private channel");

  const exited = await agentOf(owner.id, "exited");
  const exitedIn = await led(exited);
  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = statement_timestamp()
    WHERE principal_id = ${exited.principal}::uuid AND workspace_id = ${workspace}::uuid`;
  assert.deepEqual(await stored(exitedIn.id), back, "removed from the workspace");

  const leaver = await person("LeadsLeaver", "member");
  const leaverAgent = await agentOf(leaver.id, "leaver-agent");
  const leaverIn = await led(leaverAgent);
  await sql`UPDATE swarm.memberships SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${leaver.id}::uuid`;
  assert.deepEqual(await stored(leaverIn.id), back, "its owner left the workspace");

  const removed = await agentOf(owner.id, "removed");
  const removedIn = await led(removed, "private");
  const removal = await send(owner.jwt, { kind: "channel_member_remove", channel_id: removedIn.id,
    member: { kind: "agent", id: removed.principal } });
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  assert.deepEqual(await stored(removedIn.id), back, "removed from the private channel");

  // A lead named while the channel was open stays only if the conversion admits it.
  const kept = await agentOf(owner.id, "kept");
  const dropped = await agentOf(owner.id, "dropped");
  const keptIn = await led(kept);
  const droppedIn = await led(dropped);
  assert.equal((await send(owner.jwt, { kind: "channel_update", channel_id: keptIn.id, visibility: "private",
    members: [{ kind: "agent", id: kept.principal }] })).status, 200);
  assert.equal((await send(owner.jwt, { kind: "channel_update", channel_id: droppedIn.id, visibility: "private" })).status, 200);
  assert.deepEqual(await stored(keptIn.id), { lead_mode: "agent", lead_agent_principal_id: kept.principal });
  assert.deepEqual(await stored(droppedIn.id), back, "made private without its lead");

  // The table refuses a mode and an agent that disagree.
  await assert.rejects(sql`UPDATE swarm.channels SET lead_mode = 'agent' WHERE channel_id = ${droppedIn.id}::uuid`,
    /channels_lead_agent_named_check/);
  await assert.rejects(sql`UPDATE swarm.channels SET lead_agent_principal_id = ${kept.principal}::uuid, lead_mode = 'none'
    WHERE channel_id = ${keptIn.id}::uuid`, /channels_lead_agent_named_check/);
});

test("who may set a channel's lead, and which agents may lead", { timeout: 90_000 }, async () => {
  const open = await channel(owner, "auth");
  const lock = await channel(owner, "auth-lock", { visibility: "private" });
  const lead = await agentOf(owner.id, "auth-lead");

  const notManager = await setLead(member.jwt, open.id, { lead_mode: "none" });
  assert.equal(notManager.status, 403, JSON.stringify(notManager.body));
  assert.equal(notManager.body.error, "channel_forbidden");
  const own = await channel(member, "auth-own");
  assert.equal((await setLead(member.jwt, own.id, { lead_mode: "none" })).status, 200, "a channel's creator manages it");

  const unknown = await setLead(outsider.jwt, randomUUID(), { lead_mode: "none" });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "channel_not_found");
  const hidden = await setLead(outsider.jwt, lock.id, { lead_mode: "none" });
  assert.equal(hidden.status, 404);
  assert.deepEqual(hidden.body, unknown.body, "a private channel the caller is not in answers as an unknown one");
  assert.equal((await setLead(outsider.jwt, open.id, { lead_mode: "none" })).status, 200, "a workspace admin manages open channels");

  const agentCaller = await setLead(lead.token, open.id, { lead_mode: "none" });
  assert.equal(agentCaller.status, 403, "an agent never sets a lead");
  assert.deepEqual(await stored(open.id), { lead_mode: "none", lead_agent_principal_id: null });

  const turnOnly = await agentOf(owner.id, "turn-only", { turnOnly: true });
  const gone = await agentOf(owner.id, "gone");
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${gone.principal}::uuid`;
  const elsewhere = randomUUID();
  const strangerWorkspace = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${strangerWorkspace}::uuid, 'Elsewhere', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${strangerWorkspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${elsewhere}::uuid, ${strangerWorkspace}::uuid, ${owner.id}::uuid, ${`elsewhere-${elsewhere.slice(0, 6)}`})`;
  });
  const refusals: Row[] = [];
  for (const principal of [turnOnly.principal, gone.principal, elsewhere, randomUUID()]) {
    const refused = await setLead(owner.jwt, open.id, { lead_mode: "agent", principal_id: principal });
    assert.equal(refused.status, 403, `${principal}: ${JSON.stringify(refused.body)}`);
    refusals.push(refused.body);
  }
  assert.ok(refusals.every((body) => JSON.stringify(body) === JSON.stringify(refusals[0])), "one answer for every ineligible agent");
  assert.equal(refusals[0]!.error, "channel_lead_not_eligible");

  for (const bad of [{ lead_mode: "agent" }, { lead_mode: "none", principal_id: lead.principal }, { lead_mode: "boss" },
    { lead_mode: "none", extra: 1 }]) {
    assert.equal((await setLead(owner.jwt, open.id, bad)).status, 400, JSON.stringify(bad));
  }
});

test("a private channel's lead changes are tagged, hidden from admins outside it, and replay from the ledger", { timeout: 90_000 }, async () => {
  const lead = await agentOf(owner.id, "audit-lead");
  const lock = await channel(owner, "audit-lock", { visibility: "private", members: [{ kind: "agent", id: lead.principal }] });
  const open = await channel(owner, "audit-open");
  const mark = await auditMark();
  const commandId = randomUUID();
  const first = await setLead(owner.jwt, lock.id, { lead_mode: "agent", principal_id: lead.principal }, commandId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replayed = await setLead(owner.jwt, lock.id, { lead_mode: "agent", principal_id: lead.principal }, commandId);
  assert.equal(replayed.status, 200);
  // The ledger keeps the answer without the live-only events and min_client_version.
  const { events: _events, min_client_version: _minimum, ...kept } = first.body;
  assert.deepEqual(replayed.body, kept, "the stored answer");
  assert.equal((replayed.body.channel as Row).lead_agent_principal_id, lead.principal);
  const conflict = await setLead(owner.jwt, lock.id, { lead_mode: "none" }, commandId);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, "command_id_conflict");
  assert.deepEqual(await stored(lock.id), { lead_mode: "agent", lead_agent_principal_id: lead.principal }, "nothing changed");
  const refused = await setLead(owner.jwt, lock.id, { lead_mode: "agent", principal_id: randomUUID() });
  assert.equal(refused.status, 403);
  const openSet = await setLead(owner.jwt, open.id, { lead_mode: "none" });
  assert.equal(openSet.status, 200);

  const raw = await rawAudit(mark);
  assert.deepEqual(raw.map((row) => [row.outcome, row.reason]), [
    ["accepted", null], ["replayed", null], ["conflict", "command_id_conflict"],
    ["domain", "channel_lead_not_eligible"], ["accepted", null],
  ]);
  for (const row of raw.slice(0, 4)) assert.deepEqual(row.channel_ids, [lock.id], `${row.outcome} is tagged`);
  assert.deepEqual(raw[4]!.channel_ids, [open.id]);
  assert.deepEqual(await auditSeenBy(outsider.id, mark), ["accepted"], "an admin outside the channel sees only the open row");
  assert.deepEqual(await auditSeenBy(owner.id, mark), ["accepted", "replayed", "conflict", "domain", "accepted"]);
});

test("the lead setting reads back through swarm_read.channels and the agent read edge", { timeout: 90_000 }, async () => {
  const lead = await agentOf(owner.id, "read-lead");
  const open = await channel(owner, "read-open");
  const lock = await channel(owner, "read-lock", { visibility: "private", members: [{ kind: "agent", id: lead.principal }] });
  await leadSet(owner.jwt, open.id, { lead_mode: "agent", principal_id: lead.principal });
  await leadSet(owner.jwt, lock.id, { lead_mode: "none" });

  const seen = await channelsSeenBy(member.id);
  assert.deepEqual(seen.get(open.id), { channel_id: open.id, visibility: "open", lead_mode: "agent", lead_agent_principal_id: lead.principal });
  assert.equal(seen.has(lock.id), false, "the private-channel gate is unchanged");
  assert.deepEqual((await channelsSeenBy(owner.id)).get(lock.id),
    { channel_id: lock.id, visibility: "private", lead_mode: "none", lead_agent_principal_id: null });

  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST", signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${lead.token}`, "content-type": "application/json" },
    body: JSON.stringify({ resource: "channels", workspace_id: workspace }),
  });
  assert.equal(response.status, 200);
  const rows = (await response.json() as { channels: Row[] }).channels;
  const byId = new Map(rows.map((row) => [String(row.channel_id), row]));
  assert.deepEqual([byId.get(open.id)?.lead_mode, byId.get(open.id)?.lead_agent_principal_id], ["agent", lead.principal]);
  assert.deepEqual([byId.get(lock.id)?.lead_mode, byId.get(lock.id)?.lead_agent_principal_id], ["none", null]);

  // Only the command edge asks who the lead is.
  await assert.rejects(sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE swarm_read");
    await tx`SELECT swarm.channel_effective_live_lead(${workspace}::uuid, ${open.id}::uuid)`;
  }), /permission denied/);
});
