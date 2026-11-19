/**
 * Lead system alerts (CS fcb99658) against real Postgres and served command/read functions:
 * audience preservation, scope partitioning, channel/workspace lead fallback, no self-routing,
 * stale lead refusal, private-channel audit gate, resolve-vs-escalation concurrency ordering,
 * pinned producer roles, verified access_lost producers, and owner-inbox-only escalation.
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
type Agent = { principal: string; token: string; name: string };
type Channel = { id: string; slug: string };

let local: Local;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn> | undefined;
let functionLogs = "";
let envDir: string | undefined;
let workspace: string;
let otherWorkspace: string;
let owner: Person;
let wsAdmin: Person;
let member: Person;
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

async function person(label: string, role: "owner" | "admin" | "member", ws = workspace): Promise<Person> {
  const created = await createUser(label);
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${created.id}::uuid, ${label})`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws}::uuid, ${created.id}::uuid, ${role})`;
  return created;
}

async function agentOf(ownerId: string, prefix: string, ws = workspace): Promise<Agent> {
  const principal = randomUUID();
  const name = `${prefix}-${principal.slice(0, 6)}`;
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    const device = randomUUID();
    const run = randomUUID();
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${ownerId}::uuid, 'alert-tests')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${ws}::uuid, ${ownerId}::uuid, ${name})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token, name };
}

async function setPresence(agent: Agent, opts: {
  watcherAgoSec?: number | null;
  lastCommandAgoSec?: number | null;
  ws?: string;
}): Promise<void> {
  const ws = opts.ws ?? workspace;
  const watcher = opts.watcherAgoSec == null ? null : new Date(Date.now() - opts.watcherAgoSec * 1000).toISOString();
  const lastCmd = opts.lastCommandAgoSec == null ? null : new Date(Date.now() - opts.lastCommandAgoSec * 1000).toISOString();
  await sql`DELETE FROM swarm.agent_wake_leases WHERE principal_id = ${agent.principal}::uuid`;
  await sql`
    INSERT INTO swarm.agent_presence (workspace_id, principal_id, watcher_at, last_command_at)
    VALUES (${ws}::uuid, ${agent.principal}::uuid, ${watcher}::timestamptz, ${lastCmd}::timestamptz)
    ON CONFLICT (workspace_id, principal_id)
    DO UPDATE SET watcher_at = EXCLUDED.watcher_at, channel_at = NULL, listener_at = NULL,
                  last_command_at = EXCLUDED.last_command_at
  `;
}

async function send(
  bearer: string,
  command: Row,
  commandId: string = randomUUID(),
  ws = workspace,
): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: ws,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function readResource(bearer: string, body: Row): Promise<{ status: number; body: Row }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as Row };
}

async function createChannel(by: Person, prefix: string, extra: Row = {}, ws = workspace): Promise<Channel> {
  const slug = `${prefix}-${randomBytes(4).toString("hex")}`;
  const created = await send(by.jwt, { kind: "channel_create", slug, ...extra }, randomUUID(), ws);
  assert.equal(created.status, 200, JSON.stringify(created.body) + functionLogs.slice(-2000));
  return { id: String((created.body.channel as Row).channel_id), slug };
}

async function enqueueWaitingDelivery(opts: {
  ws?: string;
  senderUserId: string;
  recipientAgent: Agent;
  channelId?: string | null;
  ageMinutes: number;
  directToAgent?: boolean;
  body?: string;
}): Promise<string> {
  const ws = opts.ws ?? workspace;
  const signalId = randomUUID();
  const createdAt = new Date(Date.now() - opts.ageMinutes * 60_000).toISOString();
  const until = new Date(Date.now() + 24 * 3600_000).toISOString();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.signals (
        id, workspace_id, from_principal, from_kind, to_user_id, to_agent_principal_id,
        channel_id, kind, body, until, created_at
      ) VALUES (
        ${signalId}::uuid, ${ws}::uuid, ${opts.senderUserId}::uuid, 'user', NULL,
        ${opts.directToAgent ? opts.recipientAgent.principal : null}::uuid,
        ${opts.channelId ?? null}::uuid, 'note',
        ${opts.body ?? `secret-body-${signalId}`},
        ${until}::timestamptz, ${createdAt}::timestamptz
      )
    `;
    await tx`
      INSERT INTO swarm.signal_deliveries (
        signal_id, workspace_id, recipient_agent_principal_id, enqueued_at
      ) VALUES (
        ${signalId}::uuid, ${ws}::uuid, ${opts.recipientAgent.principal}::uuid, ${createdAt}::timestamptz
      )
      ON CONFLICT (signal_id, recipient_agent_principal_id)
      DO UPDATE SET enqueued_at = EXCLUDED.enqueued_at
    `;
  });
  return signalId;
}

async function ownerAlertInboxAs(userId: string, ws = workspace, agentPrincipalId?: string): Promise<Row | null> {
  return await sql.begin(async (tx) => {
    const claims: Row = { sub: userId, role: "authenticated" };
    if (agentPrincipalId) claims.agent_principal_id = agentPrincipalId;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const [row] = await tx<{ inbox: Row | null }[]>`SELECT swarm_read.owner_alert_inbox(${ws}::uuid) AS inbox`;
    return row?.inbox ?? null;
  }) as Row | null;
}

async function alertsViewAs(userId: string, ws = workspace, agentPrincipalId?: string): Promise<Row[]> {
  return await sql.begin(async (tx) => {
    const claims: Row = { sub: userId, role: "authenticated" };
    if (agentPrincipalId) claims.agent_principal_id = agentPrincipalId;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    const rows = await tx<Row[]>`
      SELECT alert_id, workspace_id, channel_id, kind, affected_principal_id, affected_seat_name,
             fix_hint, waiting_count, oldest_waiting_at, routed_lead_principal_id,
             opened_at, escalate_after, escalated_at, resolved_at, resolution_note
      FROM swarm_read.system_alerts
      WHERE workspace_id = ${ws}::uuid
      ORDER BY opened_at, alert_id
    `;
    return rows.map((r) => ({ ...r }));
  }) as Row[];
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-system-alerts-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 6 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(),
    env: { ...process.env, SWARM_ENV: "test" },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(functionProcess);
  let startupSeen = false;
  const observe = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-30_000);
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
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => "local command function was not ready",
    cliState,
  });

  workspace = randomUUID();
  otherWorkspace = randomUUID();
  owner = await createUser("alerts-owner");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'AlertsOwner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'AlertsWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${otherWorkspace}::uuid, 'AlertsOtherWS', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${otherWorkspace}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${otherWorkspace}::uuid, 'workspace')`;
  });
  wsAdmin = await person("AlertsAdmin", "admin");
  member = await person("AlertsMember", "member");
  wsLead = await agentOf(owner.id, "ws-lead");
  await sql`UPDATE swarm.workspaces SET lead_agent_principal_id = ${wsLead.principal}::uuid WHERE workspace_id = ${workspace}::uuid`;
  await setPresence(wsLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
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

test("Condition 1: mixed queue partitions by scope, excludes DMs, preserves private channels, and hides non-member private alerts", { timeout: 90_000 }, async () => {
  const quietSeat = await agentOf(owner.id, "quiet-mixed");
  const leadA = await agentOf(owner.id, "lead-priv-a");
  const leadOpen = await agentOf(owner.id, "lead-open");
  const memberB = await person("MemberPrivB", "member");
  await setPresence(leadA, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(leadOpen, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(quietSeat, { watcherAgoSec: 600, lastCommandAgoSec: 900 });

  const openCh = await createChannel(owner, "open-alerts");
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: openCh.id, lead_mode: "agent", principal_id: leadOpen.principal,
  })).status, 200);

  // #priv-a: owner + leadA + quietSeat (wsLead is NOT a member)
  const privA = await createChannel(owner, "priv-a", {
    visibility: "private",
    members: [{ kind: "agent", id: leadA.principal }, { kind: "agent", id: quietSeat.principal }],
  });
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: privA.id, lead_mode: "agent", principal_id: leadA.principal,
  })).status, 200);

  // #priv-b: created by memberB with quietSeat ONLY (owner, wsAdmin, wsLead, leadA are NOT members!)
  const privB = await createChannel(memberB, "priv-b", {
    visibility: "private",
    members: [{ kind: "agent", id: quietSeat.principal }],
  });

  // Waiting deliveries across all 5 categories:
  // 2 in #general, 1 in #open-ch, 3 in #priv-a, 2 in #priv-b, 2 in DM (addressed)
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 25, body: "SECRET_GENERAL_BODY" });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 15 });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: openCh.id, ageMinutes: 20, body: "SECRET_OPEN_BODY" });
  await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: privA.id, ageMinutes: 30, body: "SECRET_PRIVA_BODY" });
  await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: privA.id, ageMinutes: 18 });
  await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: privA.id, ageMinutes: 12 });
  await enqueueWaitingDelivery({ senderUserId: memberB.id, recipientAgent: quietSeat, channelId: privB.id, ageMinutes: 40, body: "SECRET_PRIVB_BODY" });
  await enqueueWaitingDelivery({ senderUserId: memberB.id, recipientAgent: quietSeat, channelId: privB.id, ageMinutes: 14 });
  // DMs / addressed deliveries (oldest! 50 min ago) MUST be excluded and never inflate counts/timestamps
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 50, directToAgent: true, body: "SECRET_DM_BODY" });
  await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 45, directToAgent: true });

  const [synced] = await sql<{ res: Row }[]>`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes') AS res`;
  assert.equal(Number(synced!.res.synced), 4, "exactly 4 scoped alerts (#general, #open-ch, #priv-a, #priv-b); DM excluded");

  const rawRows = await sql<Row[]>`
    SELECT alert_id, channel_id, waiting_count, routed_lead_principal_id, escalated_at
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${quietSeat.principal}::uuid
    ORDER BY waiting_count
  `;
  assert.equal(rawRows.length, 4);
  const byScope = new Map(rawRows.map((r) => [r.channel_id ?? "general", r]));
  assert.equal(byScope.get("general")!.waiting_count, 2);
  assert.equal(byScope.get("general")!.routed_lead_principal_id, wsLead.principal);
  assert.equal(byScope.get(openCh.id)!.waiting_count, 1);
  assert.equal(byScope.get(openCh.id)!.routed_lead_principal_id, leadOpen.principal);
  assert.equal(byScope.get(privA.id)!.waiting_count, 3);
  assert.equal(byScope.get(privA.id)!.routed_lead_principal_id, leadA.principal);
  assert.equal(byScope.get(privB.id)!.waiting_count, 2);
  assert.equal(byScope.get(privB.id)!.routed_lead_principal_id, null, "no eligible lead in #priv-b");

  // Non-member owner of #priv-b sees #general, #open-ch, #priv-a, NEVER #priv-b (even though #priv-b escalated immediately!).
  const ownerAlerts = await alertsViewAs(owner.id);
  const ownerScopes = ownerAlerts
    .filter((a) => a.affected_principal_id === quietSeat.principal)
    .map((a) => a.channel_id ?? "general")
    .sort();
  assert.deepEqual(ownerScopes, ["general", openCh.id, privA.id].sort());
  const ownerInbox = await ownerAlertInboxAs(owner.id);
  assert.ok(ownerInbox);
  assert.equal(
    (ownerInbox.alerts as Row[]).some((a) => a.channel_id === privB.id),
    false,
    "non-member owner must never see #priv-b in owner_alert_inbox",
  );

  // wsLead sees #general ONLY for this quietSeat (not #priv-a, not #priv-b).
  const wsLeadRead = await readResource(wsLead.token, { resource: "system_alerts", workspace_id: workspace });
  assert.equal(wsLeadRead.status, 200);
  const wsLeadForQuiet = (wsLeadRead.body.alerts as Row[]).filter((a) => a.affected_principal_id === quietSeat.principal);
  assert.deepEqual(wsLeadForQuiet.map((a) => a.channel_id ?? "general").sort(), ["general", openCh.id].sort());

  // leadA sees #priv-a ONLY in both system_alerts and inbox (cswarm check), with fix hint & seat name, ZERO message body!
  const leadARead = await readResource(leadA.token, { resource: "system_alerts", workspace_id: workspace });
  assert.equal(leadARead.status, 200);
  assert.deepEqual((leadARead.body.alerts as Row[]).map((a) => a.channel_id), [privA.id]);
  const leadAInbox = await readResource(leadA.token, {
    resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null, since: null,
    limit: 20, include_stale: false,
  });
  assert.equal(leadAInbox.status, 200);
  const alertSignal = (leadAInbox.body.signals as Row[]).find((s) => s.id === byScope.get(privA.id)!.alert_id);
  assert.ok(alertSignal, "leadA inbox must contain routed #priv-a system alert");
  assert.equal(alertSignal.channel_id, privA.id);
  assert.match(String(alertSignal.body), new RegExp(quietSeat.name));
  assert.match(String(alertSignal.body), /Fix:/);
  assert.doesNotMatch(String(alertSignal.body), /SECRET_/);

  // Non-member owner trying to resolve #priv-b gets the exact same 404 as an unknown UUID.
  const privBRes = await send(owner.jwt, {
    kind: "resolve_system_alert", alert_id: String(byScope.get(privB.id)!.alert_id), note: "probe",
  });
  const unknownRes = await send(owner.jwt, {
    kind: "resolve_system_alert", alert_id: randomUUID(), note: "probe",
  });
  assert.equal(privBRes.status, 404);
  assert.deepEqual(privBRes.body, unknownRes.body);
});

test("Condition 2: stale listener fallback, no self-route, demoted lead, channel turning private, agent-vs-owner claims, private audit gate, and resolve-vs-escalation race", { timeout: 90_000 }, async () => {
  const chLead = await agentOf(owner.id, "ch-lead-c2");
  const quietInCh = await agentOf(owner.id, "quiet-c2");
  const nonLeadOwnedByOwner = await agentOf(owner.id, "non-lead-c2");
  await setPresence(wsLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(chLead, { watcherAgoSec: 600, lastCommandAgoSec: 900 }); // stale listener!
  await setPresence(quietInCh, { watcherAgoSec: 600, lastCommandAgoSec: 900 });

  const room = await createChannel(owner, "fallback-room");
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: room.id, lead_mode: "agent", principal_id: chLead.principal,
  })).status, 200);

  // 1. Stale listener on chLead -> alert falls back to live wsLead, keeping channel_id!
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietInCh, channelId: room.id, ageMinutes: 15 });
  await sql`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes')`;
  const [fallbackAlert] = await sql<Row[]>`
    SELECT alert_id, channel_id, routed_lead_principal_id, escalated_at
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${quietInCh.principal}::uuid
      AND channel_id = ${room.id}::uuid AND resolved_at IS NULL
  `;
  assert.ok(fallbackAlert);
  assert.equal(fallbackAlert.channel_id, room.id);
  assert.equal(fallbackAlert.routed_lead_principal_id, wsLead.principal);
  assert.equal(fallbackAlert.escalated_at, null);

  // 2. No self-routing: chLead itself goes quiet -> routes to wsLead, never chLead!
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: chLead, channelId: room.id, ageMinutes: 15 });
  await sql`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes')`;
  const [chLeadQuiet] = await sql<Row[]>`
    SELECT alert_id, routed_lead_principal_id
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${chLead.principal}::uuid
      AND channel_id = ${room.id}::uuid AND resolved_at IS NULL
  `;
  assert.equal(chLeadQuiet!.routed_lead_principal_id, wsLead.principal);

  // 3. Agent claim owned by owner MUST NOT inherit human owner authority!
  assert.equal(await ownerAlertInboxAs(owner.id, workspace, nonLeadOwnedByOwner.principal), null);
  assert.deepEqual(await alertsViewAs(owner.id, workspace, nonLeadOwnedByOwner.principal), []);
  const nonLeadRead = await readResource(nonLeadOwnedByOwner.token, {
    resource: "system_alerts", workspace_id: workspace, escalated_only: true,
  });
  assert.equal(nonLeadRead.status, 200);
  assert.deepEqual(nonLeadRead.body.alerts, []);
  const nonLeadResolve = await send(nonLeadOwnedByOwner.token, {
    kind: "resolve_system_alert", alert_id: String(fallbackAlert.alert_id), note: "not a lead",
  });
  assert.equal(nonLeadResolve.status, 404);

  // 4. Cross-workspace read & resolve refuse cleanly (uniform 404 when member of otherWorkspace).
  const crossRead = await readResource(wsLead.token, { resource: "system_alerts", workspace_id: otherWorkspace });
  assert.equal(crossRead.status, 200);
  assert.deepEqual(crossRead.body.alerts, []);
  const crossResolveMember = await send(owner.jwt, {
    kind: "resolve_system_alert", alert_id: String(fallbackAlert.alert_id), note: "wrong ws",
  }, randomUUID(), otherWorkspace);
  assert.equal(crossResolveMember.status, 404);
  const crossResolveNonMember = await send(wsLead.token, {
    kind: "resolve_system_alert", alert_id: String(fallbackAlert.alert_id), note: "wrong ws",
  }, randomUUID(), otherWorkspace);
  assert.equal(crossResolveNonMember.status, 403);

  // 5. Channel becomes private without wsLead -> wsLead immediately loses read and resolve!
  assert.equal((await send(owner.jwt, {
    kind: "channel_update", channel_id: room.id, visibility: "private",
    members: [{ kind: "agent", id: chLead.principal }],
  })).status, 200);
  const wsLeadAfterPriv = await readResource(wsLead.token, { resource: "system_alerts", workspace_id: workspace });
  assert.equal((wsLeadAfterPriv.body.alerts as Row[]).some((a) => a.alert_id === fallbackAlert.alert_id), false);
  const wsLeadResolveAfterPriv = await send(wsLead.token, {
    kind: "resolve_system_alert", alert_id: String(fallbackAlert.alert_id), note: "after private",
  });
  assert.equal(wsLeadResolveAfterPriv.status, 404);

  // 6. Stale lead refusal + private-channel audit gate on resolve, replay, conflict, and post-removal retry!
  const leadP1 = await agentOf(owner.id, "lead-p1");
  const leadP2 = await agentOf(owner.id, "lead-p2");
  await setPresence(leadP1, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(leadP2, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  const privAuditCh = await createChannel(owner, "priv-audit", {
    visibility: "private",
    members: [{ kind: "agent", id: leadP1.principal }, { kind: "agent", id: leadP2.principal }],
  });
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: privAuditCh.id, lead_mode: "agent", principal_id: leadP1.principal,
  })).status, 200);
  const [privAlertRow] = await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'agent_quiet', ${quietInCh.principal}::uuid, ${privAuditCh.id}::uuid,
      2, statement_timestamp() - interval '15 minutes', interval '30 minutes'
    ) AS id
  `;
  const privAlertId = privAlertRow!.id;

  // Demote leadP1 -> leadP2; stale leadP1 is immediately refused.
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: privAuditCh.id, lead_mode: "agent", principal_id: leadP2.principal,
  })).status, 200);
  assert.equal((await send(leadP1.token, {
    kind: "resolve_system_alert", alert_id: privAlertId, note: "stale lead attempt",
  })).status, 404);

  // Current leadP2 resolves with secret note; audit stays behind private channel gate and omits note!
  const [markRow] = await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`;
  const mark = markRow!.mark;
  const resolveCmdId = randomUUID();
  const secretNote = `Restarted listener ${randomUUID()}`;
  const resolved = await send(leadP2.token, {
    kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote,
  }, resolveCmdId);
  assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
  assert.equal((resolved.body.alert as Row).resolution_note, secretNote);
  assert.equal(functionLogs.includes(secretNote), false, "resolution note must stay out of general logs");

  // Exact replay while still authorized succeeds; conflict returns 409.
  const replayed = await send(leadP2.token, {
    kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote,
  }, resolveCmdId);
  assert.equal(replayed.status, 200);
  const conflicted = await send(leadP2.token, {
    kind: "resolve_system_alert", alert_id: privAlertId, note: "different note",
  }, resolveCmdId);
  assert.equal(conflicted.status, 409);

  // Remove leadP2 from privAuditCh -> retrying the same command_id returns uniform 404 and stays audit-gated!
  assert.equal((await send(owner.jwt, {
    kind: "channel_member_remove", channel_id: privAuditCh.id, member: { kind: "agent", id: leadP2.principal },
  })).status, 200);
  const retryAfterRemoval = await send(leadP2.token, {
    kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote,
  }, resolveCmdId);
  assert.equal(retryAfterRemoval.status, 404);

  const rawAudits = await sql<{ channel_ids: string[] | null; detail: string | null }[]>`
    SELECT channel_ids::text[] AS channel_ids, detail
    FROM swarm.audit_log
    WHERE workspace_id = ${workspace}::uuid AND command_kind = 'resolve_system_alert' AND audit_id > ${mark}::bigint
  `;
  assert.ok(rawAudits.length >= 4);
  for (const row of rawAudits) {
    assert.deepEqual(row.channel_ids, [privAuditCh.id], "every private alert resolve/retry audit row must carry channel_ids");
    assert.equal(row.detail?.includes(secretNote) ?? false, false, "audit detail must not contain resolution note");
  }
  // Non-member wsAdmin sees ZERO audit rows for the private alert.
  const adminVisibleAudits = await sql.begin(async (tx) => {
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: wsAdmin.id, role: "authenticated" })}, true)`;
    await tx.unsafe("SET LOCAL ROLE authenticated");
    return await tx<Row[]>`
      SELECT audit_id FROM swarm_read.audit_log
      WHERE workspace_id = ${workspace}::uuid AND command_kind = 'resolve_system_alert' AND audit_id > ${mark}::bigint
    `;
  }) as Row[];
  assert.equal(adminVisibleAudits.length, 0);

  // 7. Resolve racing escalation against the same row lock: resolve commits first -> escalation skips it!
  const raceSeat = await agentOf(owner.id, "race-seat");
  const [raceAlertRow] = await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'local_renewal_superseded', ${raceSeat.principal}::uuid, NULL,
      NULL, NULL, interval '0 seconds'
    ) AS id
  `;
  const raceAlertId = raceAlertRow!.id;
  // Backdate escalate_after to ensure it is due right now while unresolved.
  await sql`
    UPDATE swarm.system_alerts
    SET escalate_after = opened_at, escalated_at = NULL
    WHERE alert_id = ${raceAlertId}::uuid
  `;
  let releaseResolve!: () => void;
  const resolveLocked = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let resolveProceed!: () => void;
  const allowCommit = new Promise<void>((resolve) => { resolveProceed = resolve; });

  const resolveTx = sql.begin(async (tx) => {
    const [r] = await tx<{ res: Row }[]>`
      SELECT swarm.resolve_system_alert(
        ${workspace}::uuid, ${raceAlertId}::uuid, 'agent', ${wsLead.principal}::uuid, ${owner.id}::uuid, 'Fixed during race'
      ) AS res
    `;
    releaseResolve();
    await allowCommit;
    return r!.res;
  });
  await resolveLocked;
  // Escalation pass starts while resolve holds FOR UPDATE on the same row.
  const escalatePromise = sql<{ n: number }[]>`SELECT swarm.escalate_due_system_alerts() AS n`;
  await delay(150);
  resolveProceed();
  const [resolveOutcome, [escalatedCount]] = await Promise.all([resolveTx, escalatePromise]);
  assert.equal((resolveOutcome as Row).outcome, "resolved");
  assert.equal(escalatedCount!.n, 0, "resolved row must not escalate when racing timer");
  const [afterRace] = await sql<{ resolved_at: Date | null; escalated_at: Date | null }[]>`
    SELECT resolved_at, escalated_at FROM swarm.system_alerts WHERE alert_id = ${raceAlertId}::uuid
  `;
  assert.ok(afterRace!.resolved_at);
  assert.equal(afterRace!.escalated_at, null);
});

test("Condition 3: pinned producers, verified access_lost, refusal of guessed/ambiguous events, and owner-inbox-only escalation (admins excluded)", { timeout: 90_000 }, async () => {
  // 1. Direct table mutations and internal producer EXECUTE refused for non-owner roles.
  for (const role of ["authenticated", "swarm_read", "swarm_command"]) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await assert.rejects(
        () => tx`INSERT INTO swarm.system_alerts (workspace_id, kind, affected_principal_id, fix_hint, escalate_after)
          VALUES (${workspace}::uuid, 'local_credential_revoked', ${wsLead.principal}::uuid, 'x', statement_timestamp())`,
        (err: { code?: string }) => err.code === "42501",
        `${role} must not insert swarm.system_alerts directly`,
      );
      await assert.rejects(
        () => tx`SELECT swarm.sync_quiet_agent_alerts()`,
        (err: { code?: string }) => err.code === "42501",
        `${role} must not execute sync_quiet_agent_alerts`,
      );
      await assert.rejects(
        () => tx`SELECT swarm.escalate_due_system_alerts()`,
        (err: { code?: string }) => err.code === "42501",
        `${role} must not execute escalate_due_system_alerts`,
      );
    });
  }
  for (const role of ["authenticated", "swarm_read"]) {
    await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await assert.rejects(
        () => tx`SELECT swarm.record_system_alert(${workspace}::uuid, 'local_credential_revoked', ${wsLead.principal}::uuid)`,
        (err: { code?: string }) => err.code === "42501",
        `${role} must not execute record_system_alert`,
      );
      await assert.rejects(
        () => tx`SELECT swarm.record_hosted_seat_refused_alerts('grant-x-1234567890', ${owner.id}::uuid)`,
        (err: { code?: string }) => err.code === "42501",
        `${role} must not execute record_hosted_seat_refused_alerts`,
      );
    });
  }

  // 2. Guessed / unverified seat or foreign workspace produces ZERO alerts.
  const otherSeat = await agentOf(owner.id, "other-ws-seat", otherWorkspace);
  const [foreignRes] = await sql<{ id: string | null }[]>`
    SELECT swarm.record_system_alert(${workspace}::uuid, 'local_credential_revoked', ${otherSeat.principal}::uuid) AS id
  `;
  assert.equal(foreignRes!.id, null, "foreign workspace/seat pair must not create alert");

  const guessedToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const beforeCount = Number((await sql<{ c: string }[]>`SELECT count(*) AS c FROM swarm.system_alerts`)[0]!.c);
  const guessedCall = await send(guessedToken, { kind: "touch_presence" });
  assert.equal(guessedCall.status, 401);
  const afterGuessedCount = Number((await sql<{ c: string }[]>`SELECT count(*) AS c FROM swarm.system_alerts`)[0]!.c);
  assert.equal(afterGuessedCount, beforeCount, "guessed token must create zero alerts");

  // 3. Verified revoked local token creates local_credential_revoked alert routed to live wsLead.
  const revokedSeat = await agentOf(owner.id, "revoked-local");
  await sql`UPDATE swarm.agent_tokens SET revoked_at = statement_timestamp() WHERE principal_id = ${revokedSeat.principal}::uuid`;
  const revokedCall = await send(revokedSeat.token, { kind: "touch_presence" });
  assert.equal(revokedCall.status, 403);
  const [revokedAlert] = await sql<Row[]>`
    SELECT alert_id, kind, routed_lead_principal_id, fix_hint, escalated_at
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${revokedSeat.principal}::uuid
      AND kind = 'local_credential_revoked' AND resolved_at IS NULL
  `;
  assert.ok(revokedAlert, "verified revoked local token must record local_credential_revoked alert");
  assert.equal(revokedAlert.routed_lead_principal_id, wsLead.principal);
  assert.equal(revokedAlert.escalated_at, null);

  // 4. Hosted seat refused: truncated prefix or wrong owner -> 0; exact grant -> records hosted_seat_refused.
  const hostedSeat = await agentOf(owner.id, "hosted-seat");
  const grantId = randomUUID();
  const providerGrantId = `pg_${randomBytes(16).toString("hex")}`;
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm.agent_principals SET transport = 'hosted_mcp', turn_only = true WHERE principal_id = ${hostedSeat.principal}::uuid`;
    await tx`
      INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${grantId}::uuid, ${providerGrantId}, ${owner.id}::uuid, ${workspace}::uuid, 'test-client',
        'https://mcp.commonswarm.com/mcp', ARRAY[${workspace}::uuid], ${createHash("sha256").update("m").digest()},
        'ref-1', 'active', statement_timestamp(), statement_timestamp()
      )
    `;
    await tx`
      INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
      VALUES (${grantId}::uuid, ${hostedSeat.principal}::uuid, ${owner.id}::uuid)
    `;
  });
  const [truncRes] = await sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${providerGrantId.slice(0, 8)}, ${owner.id}::uuid) AS n
  `;
  assert.equal(truncRes!.n, 0, "truncated ref must never record alert");
  const [wrongOwnerRes] = await sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${providerGrantId}, ${wsAdmin.id}::uuid) AS n
  `;
  assert.equal(wrongOwnerRes!.n, 0, "mismatched owner must never record alert");
  const [exactRes] = await sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${providerGrantId}, ${owner.id}::uuid) AS n
  `;
  assert.equal(exactRes!.n, 1, "exact verified grant records hosted_seat_refused alert");

  // 5. Escalation threshold -> idempotent escalation -> owner inbox ONLY (admins and members excluded!).
  await sql`
    UPDATE swarm.system_alerts
    SET escalate_after = opened_at
    WHERE alert_id = ${String(revokedAlert.alert_id)}::uuid
  `;
  const [esc1] = await sql<{ n: number }[]>`SELECT swarm.escalate_due_system_alerts() AS n`;
  assert.equal(esc1!.n, 1);
  const [esc2] = await sql<{ n: number }[]>`SELECT swarm.escalate_due_system_alerts() AS n`;
  assert.equal(esc2!.n, 0, "repeated escalation pass must never escalate twice");

  // Owner sees it in owner_alert_inbox AND read edge escalated_only (with NO resolution_note field).
  const ownerInbox = await ownerAlertInboxAs(owner.id);
  assert.ok(ownerInbox);
  const escalatedEntry = (ownerInbox.alerts as Row[]).find((a) => a.alert_id === revokedAlert.alert_id);
  assert.ok(escalatedEntry);
  assert.equal(Object.hasOwn(escalatedEntry, "resolution_note"), false);
  const ownerEdgeEsc = await readResource(owner.jwt, {
    resource: "system_alerts", workspace_id: workspace, escalated_only: true,
  });
  assert.equal(ownerEdgeEsc.status, 200);
  assert.ok((ownerEdgeEsc.body.alerts as Row[]).some((a) => a.alert_id === revokedAlert.alert_id));

  // Admin can view system_alerts, BUT is NOT enrolled in owner escalation!
  const adminView = await alertsViewAs(wsAdmin.id);
  assert.ok(adminView.some((a) => a.alert_id === revokedAlert.alert_id), "admin retains workspace alert visibility");
  assert.equal(await ownerAlertInboxAs(wsAdmin.id), null, "admin must NOT receive owner_alert_inbox");
  const adminEdgeEsc = await readResource(wsAdmin.jwt, {
    resource: "system_alerts", workspace_id: workspace, escalated_only: true,
  });
  assert.equal(adminEdgeEsc.status, 200);
  assert.deepEqual(adminEdgeEsc.body.alerts, [], "admin must NOT receive escalated_only alerts");

  // Ordinary member sees nothing anywhere.
  assert.deepEqual(await alertsViewAs(member.id), []);
  assert.equal(await ownerAlertInboxAs(member.id), null);
  const memberEdge = await readResource(member.jwt, { resource: "system_alerts", workspace_id: workspace });
  assert.equal(memberEdge.status, 200);
  assert.deepEqual(memberEdge.body.alerts, []);

  // Resolving an already-escalated alert records was_escalated=true and clears it from owner inbox.
  const resolveAfterEsc = await send(wsLead.token, {
    kind: "resolve_system_alert", alert_id: String(revokedAlert.alert_id), note: "Reconnected credential.",
  });
  assert.equal(resolveAfterEsc.status, 200);
  assert.equal((resolveAfterEsc.body.alert as Row).was_escalated, true);
  const ownerInboxAfter = await ownerAlertInboxAs(owner.id);
  assert.equal((ownerInboxAfter!.alerts as Row[]).some((a) => a.alert_id === revokedAlert.alert_id), false);
});
