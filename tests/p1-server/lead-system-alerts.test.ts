/**
 * Lead system alerts (CS fcb99658) against real Postgres and served command/read functions:
 * reader role grants, audit-view non-oracle, canonical conversation scope partitioning,
 * real-socket wake & concurrent channel-conversion serialization, grant-scoped hosted refusals,
 * pg_cron schedule, and CLI/client end-to-end delivery.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";
import { readSystemAlerts, resolveSystemAlertCommand } from "../../src/cloud/system-alerts.js";
import { ThinCommandClient, type SignalRecord } from "../../src/cloud/command-client.js";
import { readAgentSignalPage } from "../../src/cloud/signals.js";
import { runArrivalWatch } from "../../src/cloud/arrival-watch.js";

type Local = { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
type Person = { id: string; jwt: string };
type Row = Record<string, unknown>;
type Agent = { principal: string; token: string; name: string; wakeId: string };
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
  const [wakeRow] = await sql<{ wake_id: string }[]>`
    SELECT wake_id FROM swarm.agent_principals WHERE principal_id = ${principal}::uuid
  `;
  return { principal, token, name, wakeId: wakeRow!.wake_id };
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
  threadRootId?: string | null;
  ageMinutes: number;
  directToAgent?: boolean;
  directToUserId?: string | null;
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
        channel_id, thread_root_id, kind, body, until, created_at
      ) VALUES (
        ${signalId}::uuid, ${ws}::uuid, ${opts.senderUserId}::uuid, 'user',
        ${opts.directToUserId ?? null}::uuid,
        ${opts.directToAgent ? opts.recipientAgent.principal : null}::uuid,
        ${opts.channelId ?? null}::uuid,
        ${opts.threadRootId ?? null}::uuid,
        'note',
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

async function ownerAlertInboxAs(
  userId: string,
  ws = workspace,
  agentPrincipalId?: string,
  role: "authenticated" | "swarm_read" = "authenticated",
): Promise<Row | null> {
  return await sql.begin(async (tx) => {
    const claims: Row = { sub: userId, role: "authenticated" };
    if (agentPrincipalId) claims.agent_principal_id = agentPrincipalId;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    const [row] = await tx<{ inbox: Row | null }[]>`SELECT swarm_read.owner_alert_inbox(${ws}::uuid) AS inbox`;
    return row?.inbox ?? null;
  }) as Row | null;
}

async function alertsViewAs(
  userId: string,
  ws = workspace,
  agentPrincipalId?: string,
  role: "authenticated" | "swarm_read" = "authenticated",
): Promise<Row[]> {
  return await sql.begin(async (tx) => {
    const claims: Row = { sub: userId, role: "authenticated" };
    if (agentPrincipalId) claims.agent_principal_id = agentPrincipalId;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
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

async function subscribeWakeSocket(wakeId: string): Promise<{
  frames: Row[];
  statuses: string[];
  allBroadcasts: unknown[];
  close: () => Promise<void>;
}> {
  const client = createClient(local.API_URL, local.ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await client.realtime.setAuth(local.ANON_KEY);
  const frames: Row[] = [];
  const statuses: string[] = [];
  const allBroadcasts: unknown[] = [];
  const channel = client.channel(`cswarm-wake:${wakeId}`, {
    config: { private: true, broadcast: { ack: false, self: false } },
  });
  channel.on("broadcast", { event: "wake" }, (msg) => {
    frames.push((msg.payload ?? {}) as Row);
  });
  channel.on("broadcast", { event: "*" }, (msg) => {
    allBroadcasts.push(msg);
  });
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("wake socket subscribe timed out")), 15_000);
    channel.subscribe((status, err) => {
      statuses.push(err ? `${status}:${String(err)}` : status);
      if (status === "SUBSCRIBED") {
        clearTimeout(t);
        resolve();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        clearTimeout(t);
        reject(new Error(`wake socket failed: ${status} ${err ? String(err) : ""}`));
      }
    });
  });
  await delay(250);
  return {
    frames,
    statuses,
    allBroadcasts,
    close: async () => {
      await client.removeChannel(channel);
      await client.realtime.disconnect();
    },
  };
}

before(async () => {
  local = localEnvironment();
  envDir = mkdtempSync(join(tmpdir(), "cs-system-alerts-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_CHAT_MENTIONS=1\n", { mode: 0o600 });
  sql = postgres(local.DB_URL, { prepare: false, max: 8 });
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

test("Conditions 1 & 3: reader grants (authenticated + swarm_read + ordinary inbox), canonical placement, addressed root exclusion, private inherited placement and mixed queue", { timeout: 90_000 }, async () => {
  const quietSeat = await agentOf(owner.id, "quiet-mixed");
  const ordinarySeat = await agentOf(owner.id, "ordinary-inbox");
  const leadA = await agentOf(owner.id, "lead-priv-a");
  const leadOpen = await agentOf(owner.id, "lead-open");
  const memberB = await person("MemberPrivB", "member");
  await setPresence(leadA, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(leadOpen, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(quietSeat, { watcherAgoSec: 600, lastCommandAgoSec: 900 });

  // Served ordinary agent inbox must remain 200 (never failing on view execute permissions).
  const ordinaryInbox = await readResource(ordinarySeat.token, {
    resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null, since: null,
    limit: 20, include_stale: false,
  });
  assert.equal(ordinaryInbox.status, 200, JSON.stringify(ordinaryInbox.body));

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

  // #priv-b: memberB + quietSeat ONLY (owner, wsAdmin, wsLead, leadA are NOT members!)
  const privB = await createChannel(memberB, "priv-b", {
    visibility: "private",
    members: [{ kind: "agent", id: quietSeat.principal }],
  });

  // Public controls: 2 in #general, 1 in #open-ch
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 25, body: "SECRET_GENERAL_BODY" });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 15 });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: openCh.id, ageMinutes: 20, body: "SECRET_OPEN_BODY" });

  // Private #priv-a: 1 top-level root + 1 thread reply with RAW channel_id = NULL whose canonical
  // conversation placement inherits #priv-a (must bucket under #priv-a, NEVER #general!).
  const privARoot = await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: privA.id, ageMinutes: 30, body: "SECRET_PRIVA_BODY" });
  await enqueueWaitingDelivery({ senderUserId: owner.id, recipientAgent: quietSeat, channelId: null, threadRootId: privARoot, ageMinutes: 18, body: "SECRET_PRIVA_INHERITED_REPLY" });

  // Addressed channel root + unaddressed thread reply under that addressed root: MUST be excluded!
  const addressedRoot = await enqueueWaitingDelivery({
    senderUserId: owner.id, recipientAgent: quietSeat, channelId: openCh.id, ageMinutes: 40, directToUserId: member.id,
  });
  await enqueueWaitingDelivery({
    senderUserId: member.id, recipientAgent: quietSeat, channelId: openCh.id, threadRootId: addressedRoot, ageMinutes: 28,
  });

  // Hidden #priv-b (2 deliveries) + DMs (2 deliveries, oldest at 50m -> MUST be excluded!)
  await enqueueWaitingDelivery({ senderUserId: memberB.id, recipientAgent: quietSeat, channelId: privB.id, ageMinutes: 35, body: "SECRET_PRIVB_BODY" });
  await enqueueWaitingDelivery({ senderUserId: memberB.id, recipientAgent: quietSeat, channelId: privB.id, ageMinutes: 14 });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: quietSeat, channelId: null, ageMinutes: 50, directToAgent: true, body: "SECRET_DM_BODY" });

  const [synced] = await sql<{ res: Row }[]>`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes') AS res`;
  assert.ok(Number(synced!.res.synced) >= 4, `expected at least 4 synced alerts, got ${synced!.res.synced}`);

  const rawRows = await sql<Row[]>`
    SELECT alert_id, channel_id, waiting_count, routed_lead_principal_id
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${quietSeat.principal}::uuid
  `;
  assert.equal(rawRows.length, 4, "exactly 4 scoped alerts for quietSeat; DM and addressed thread excluded");
  const byScope = new Map(rawRows.map((r) => [r.channel_id ?? "general", r]));
  assert.equal(byScope.get("general")!.waiting_count, 2, "inherited #priv-a reply must NOT inflate #general");
  assert.equal(byScope.get(openCh.id)!.waiting_count, 1, "addressed root & reply must NOT inflate #open-ch");
  assert.equal(byScope.get(privA.id)!.waiting_count, 2, "inherited #priv-a reply MUST bucket under #priv-a");
  assert.equal(byScope.get(privB.id)!.waiting_count, 2);

  // Condition 1: test swarm_read.system_alerts under BOTH real reader roles (authenticated AND swarm_read).
  for (const role of ["authenticated", "swarm_read"] as const) {
    const ownerAlerts = await alertsViewAs(owner.id, workspace, undefined, role);
    const scopes = ownerAlerts
      .filter((a) => a.affected_principal_id === quietSeat.principal)
      .map((a) => a.channel_id ?? "general")
      .sort();
    assert.deepEqual(scopes, ["general", openCh.id, privA.id].sort(), `owner view under ${role} hides #priv-b`);
    const leadAAlerts = await alertsViewAs(owner.id, workspace, leadA.principal, role);
    assert.deepEqual(leadAAlerts.map((a) => a.channel_id), [privA.id], `leadA view under ${role}`);
  }

  // Lead inbox (cswarm check) receives #priv-a with fix hint and seat name, ZERO message body.
  const leadAInbox = await readResource(leadA.token, {
    resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null, since: null,
    limit: 20, include_stale: false,
  });
  assert.equal(leadAInbox.status, 200);
  const alertSignal = (leadAInbox.body.signals as Row[]).find((s) => s.id === byScope.get(privA.id)!.alert_id);
  assert.ok(alertSignal);
  assert.equal(alertSignal.channel_id, privA.id);
  assert.deepEqual(alertSignal.system_alert, {
    alert_id: byScope.get(privA.id)!.alert_id,
    kind: "agent_quiet",
    affected_principal_id: quietSeat.principal,
  });
  assert.match(String(alertSignal.body), new RegExp(quietSeat.name));
  assert.match(String(alertSignal.body), /Fix:/);
  assert.doesNotMatch(String(alertSignal.body), /SECRET_/);

  // Reroute cursor proof (routed_at): open an alert routed to leadOpen on #open-ch, advance
  // wsLead's cursor past opened_at, make leadOpen stale so the alert reroutes to wsLead, and verify
  // routed_at advances ONLY on route change so wsLead's cursor-based inbox read still receives it!
  const [beforeReroute] = await sql<{ alert_id: string; routed_lead_principal_id: string; routed_at: Date; opened_at: Date }[]>`
    SELECT alert_id, routed_lead_principal_id, routed_at, opened_at
    FROM swarm.system_alerts
    WHERE alert_id = ${String(byScope.get(openCh.id)!.alert_id)}::uuid
  `;
  assert.equal(beforeReroute!.routed_lead_principal_id, leadOpen.principal);
  // Refreshing waiting count while leadOpen is still live MUST NOT bump routed_at.
  await delay(50);
  await sql`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes')`;
  const [afterNoReroute] = await sql<{ routed_at: Date }[]>`
    SELECT routed_at FROM swarm.system_alerts WHERE alert_id = ${beforeReroute!.alert_id}::uuid
  `;
  assert.equal(afterNoReroute!.routed_at.getTime(), beforeReroute!.routed_at.getTime(), "routed_at must not bump when routed lead is unchanged");

  // Held reroute witness (cursor advances WHILE reroute is waiting on lock):
  // Make leadOpen stale, hold openCh's conversation lock, eagerly start sync_quiet_agent_alerts(),
  // wait until it blocks in pg_stat_activity, advance wsLead's cursor DURING the lock wait, then
  // release the lock. Post-lock clock_timestamp() ensures routed_at > cursorDuringWait, AND
  // runArrivalWatch open-route reconciliation delivers the open alert even if cursor > routed_at!
  await setPresence(leadOpen, { watcherAgoSec: 600, lastCommandAgoSec: 900 });
  let rerouteHolderPid = 0;
  let rerouteHoldReady!: () => void;
  const rerouteHeld = new Promise<void>((r) => { rerouteHoldReady = r; });
  let releaseRerouteHold!: () => void;
  const rerouteReleaseGate = new Promise<void>((r) => { releaseRerouteHold = r; });
  const rerouteHoldTx = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    rerouteHolderPid = pid;
    await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${openCh.id}::uuid FOR UPDATE`;
    rerouteHoldReady();
    await rerouteReleaseGate;
  });
  await rerouteHeld;

  const heldReroute = sql`SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes')`.execute();
  await waitForBlockedBy(rerouteHolderPid, "sync_quiet_agent_alerts", "held reroute waiting on channel scope lock");
  await delay(80);
  // Simulate another message committing and advancing wsLead's cursor WHILE the reroute waits!
  const wsLeadCursorDuringWait = new Date().toISOString();
  await delay(80);
  releaseRerouteHold();
  await Promise.all([rerouteHoldTx, heldReroute]);

  const [afterReroute] = await sql<{ routed_lead_principal_id: string; routed_at: Date }[]>`
    SELECT routed_lead_principal_id, routed_at FROM swarm.system_alerts WHERE alert_id = ${beforeReroute!.alert_id}::uuid
  `;
  assert.equal(afterReroute!.routed_lead_principal_id, wsLead.principal);
  assert.ok(
    afterReroute!.routed_at.getTime() > new Date(wsLeadCursorDuringWait).getTime(),
    "routed_at must use post-lock clock_timestamp() so a cursor advancing during lock wait stays behind it",
  );
  const wsLeadAfterCursor = await readResource(wsLead.token, {
    resource: "signals", workspace_id: workspace, inbox: true, about: null, kind: null, since: null,
    after_created_at: wsLeadCursorDuringWait, after_id: "00000000-0000-4000-8000-000000000000",
    limit: 20, include_stale: false,
  });
  assert.equal(wsLeadAfterCursor.status, 200, JSON.stringify(wsLeadAfterCursor.body));
  assert.ok(
    (wsLeadAfterCursor.body.signals as Row[]).some((s) => s.id === beforeReroute!.alert_id),
    "rerouted alert must appear after backup lead's cursor advanced during lock wait",
  );

  // Full-page pagination + behind-cursor reconciliation witness:
  // Keep one full page (limit = 2) of older open routes routed to wsLead (general + openCh),
  // deliver a newer route ahead of cursor on the ordinary cursor path (proving SQL applies the
  // signal cursor BEFORE LIMIT), and deliver a late-committing behind-cursor route on page 2 via
  // independent alertAfter reconciliation, with zero duplicate notices across 3 full poll cycles!
  const existingOpenForWsLead = await sql<{ alert_id: string; routed_at: Date }[]>`
    SELECT alert_id, COALESCE(routed_at, opened_at) AS routed_at
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid
      AND resolved_at IS NULL
      AND routed_lead_principal_id = ${wsLead.principal}::uuid
    ORDER BY date_trunc('milliseconds', COALESCE(routed_at, opened_at)) ASC, alert_id ASC
  `;
  assert.equal(existingOpenForWsLead.length, 2, "expected exactly 2 older open alerts (general + openCh) routed to wsLead");
  const older1Id = existingOpenForWsLead[0]!.alert_id;
  const older2Id = existingOpenForWsLead[1]!.alert_id;
  const tBaseMs = existingOpenForWsLead[1]!.routed_at.getTime();

  const lateSeat = await agentOf(owner.id, "quiet-late-reconcile");
  const newerSeat = await agentOf(owner.id, "quiet-newer-cursor");
  const [{ id: lateBehindId }] = await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'agent_quiet', ${lateSeat.principal}::uuid, NULL::uuid,
      1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
    ) AS id
  `;
  const [{ id: newerAheadId }] = await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'agent_quiet', ${newerSeat.principal}::uuid, NULL::uuid,
      1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
    ) AS id
  `;
  const lateBehindTs = new Date(tBaseMs + 5_000).toISOString();
  const signalCursorTs = new Date(tBaseMs + 10_000).toISOString();
  const newerAheadTs = new Date(tBaseMs + 20_000).toISOString();
  await sql`
    UPDATE swarm.system_alerts
    SET opened_at = ${lateBehindTs}::timestamptz, routed_at = ${lateBehindTs}::timestamptz
    WHERE alert_id = ${lateBehindId}::uuid
  `;
  await sql`
    UPDATE swarm.system_alerts
    SET opened_at = ${newerAheadTs}::timestamptz, routed_at = ${newerAheadTs}::timestamptz
    WHERE alert_id = ${newerAheadId}::uuid
  `;

  // Direct served check at limit = 2: ordinary cursor path MUST return newerAhead even though
  // 2 older open alerts fill page 1, AND open_system_alerts MUST advertise hasMore = true!
  const watchTarget = { profileId: "reroute-watch-test", url: local.API_URL, anonKey: local.ANON_KEY };
  const initialCursor = { created_at: signalCursorTs, id: "00000000-0000-4000-8000-000000000000" };
  const probePage = await readAgentSignalPage(
    watchTarget,
    { kind: "agent", token: wsLead.token },
    { workspaceId: workspace, inbox: true, ascending: true, after: initialCursor, limit: 2, includeStale: false },
  );
  assert.ok(
    probePage.signals.some((s) => s.id === newerAheadId),
    "ordinary cursor path must apply cursor in SQL before LIMIT so newer route beyond full page of older open routes is delivered",
  );
  assert.ok(
    !probePage.signals.some((s) => s.id === older1Id || s.id === older2Id || s.id === lateBehindId),
    "ordinary cursor path must exclude older and behind-cursor routes",
  );
  assert.deepEqual(
    (probePage.openSystemAlerts ?? []).map((s) => s.id),
    [older1Id, older2Id],
    "page 1 of open_system_alerts holds the full page of 2 older open routes",
  );
  assert.equal(probePage.openSystemAlertsHasMore, true, "open_system_alerts must signal additional bounded pages");

  // Full runArrivalWatch proof with pageLimit = 2 across 3 idle poll cycles while all 4 stay open.
  const watchCtrl = new AbortController();
  const watchEmitted: SignalRecord[] = [];
  const observedReads: Array<{
    alertAfterId: string | null;
    signalIds: string[];
    openAlertIds: string[];
    hasMore: boolean;
  }> = [];
  let idleCycles = 0;
  let savedCursor: { created_at: string; id: string } | null = initialCursor;
  await runArrivalWatch({
    workspaceId: workspace,
    principalId: wsLead.principal,
    signal: watchCtrl.signal,
    pollMs: 1,
    pageLimit: 2,
    sleep: async (ms) => {
      if (ms > 0) {
        idleCycles += 1;
        if (idleCycles >= 3) watchCtrl.abort();
      }
    },
    store: {
      location: "memory://reroute-watch-test",
      read: async () => savedCursor,
      write: async (next) => { savedCursor = next; },
    },
    readPage: async ({ after, alertAfter, baseline, limit }) => {
      const page = await readAgentSignalPage(
        watchTarget,
        { kind: "agent", token: wsLead.token },
        {
          workspaceId: workspace,
          inbox: true,
          limit,
          includeStale: false,
          ...(baseline
            ? {}
            : {
              ascending: true as const,
              ...(after === null ? {} : { after }),
              ...(alertAfter === null ? {} : { alertAfter }),
            }),
        },
        { signal: watchCtrl.signal },
      );
      observedReads.push({
        alertAfterId: alertAfter?.id ?? null,
        signalIds: page.signals.map((s) => s.id),
        openAlertIds: (page.openSystemAlerts ?? []).map((s) => s.id),
        hasMore: page.openSystemAlertsHasMore === true,
      });
      return page;
    },
    emit: async (row) => { watchEmitted.push(row); },
  });

  assert.ok(
    observedReads.some((r) => r.signalIds.includes(newerAheadId)),
    "newer route must be delivered via ordinary cursor signals path",
  );
  assert.ok(
    !observedReads.some((r) => r.signalIds.includes(lateBehindId)),
    "behind-cursor route must never appear on ordinary cursor signals path",
  );
  assert.ok(
    observedReads.some((r) => r.alertAfterId === older2Id && r.openAlertIds.includes(lateBehindId)),
    "behind-cursor route beyond full page of older routes must be delivered via page 2 independent alertAfter reconciliation",
  );
  for (const expectedId of [older1Id, older2Id, lateBehindId, newerAheadId]) {
    const count = watchEmitted.filter((r) => r.id === expectedId).length;
    assert.equal(count, 1, `alert ${expectedId} must emit exactly once across 3 full poll cycles (got ${count})`);
  }
  assert.equal(savedCursor?.id, newerAheadId, "signal cursor must advance to newerAhead and never rewind on reconciliation");
});

test("Condition 2: hidden private alert and unknown UUID produce identical HTTP 404, identical audit_log visibility, and zero lock wait under contention for non-member admin", { timeout: 90_000 }, async () => {
  const quietSeat = await agentOf(owner.id, "quiet-audit");
  const leadPriv = await agentOf(owner.id, "lead-audit-priv");
  await setPresence(leadPriv, { watcherAgoSec: 5, lastCommandAgoSec: 5 });

  // Private channel with owner + leadPriv ONLY (wsAdmin is NOT a member!).
  const privCh = await createChannel(owner, "audit-oracle-priv", {
    visibility: "private",
    members: [{ kind: "agent", id: leadPriv.principal }],
  });
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: privCh.id, lead_mode: "agent", principal_id: leadPriv.principal,
  })).status, 200);
  const [alertRow] = await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'agent_quiet', ${quietSeat.principal}::uuid, ${privCh.id}::uuid,
      1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
    ) AS id
  `;
  const privAlertId = alertRow!.id;

  const auditRowsFor = async (viewerId: string, mark: string) =>
    await sql.begin(async (tx) => {
      await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: viewerId, role: "authenticated" })}, true)`;
      await tx.unsafe("SET LOCAL ROLE authenticated");
      const rows = await tx<{ outcome: string; reason: string | null }[]>`
        SELECT outcome, reason FROM swarm_read.audit_log
        WHERE workspace_id = ${workspace}::uuid
          AND command_kind = 'resolve_system_alert'
          AND audit_id > ${mark}::bigint
        ORDER BY audit_id
      `;
      return rows.map((r) => ({ ...r }));
    }) as Array<{ outcome: string; reason: string | null }>;

  const mark1 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const probeUnknown = await send(wsAdmin.jwt, { kind: "resolve_system_alert", alert_id: randomUUID(), note: "probe" });
  const adminAuditUnknown = await auditRowsFor(wsAdmin.id, mark1);

  const mark2 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const probeHidden = await send(wsAdmin.jwt, { kind: "resolve_system_alert", alert_id: privAlertId, note: "probe" });
  const adminAuditHidden = await auditRowsFor(wsAdmin.id, mark2);

  // HTTP response AND visible audit rows MUST be byte-for-byte indistinguishable!
  assert.equal(probeUnknown.status, 404);
  assert.equal(probeHidden.status, 404);
  assert.deepEqual(probeHidden.body, probeUnknown.body);
  assert.deepEqual(adminAuditHidden, adminAuditUnknown, "non-member admin must see identical audit rows for hidden vs unknown alert");
  assert.equal(adminAuditHidden.length, 1);

  // Lock-contention witness (C2): hold exclusive locks on privCh conversation, conversation-frames,
  // AND privAlertId row. While locks are held, non-member wsAdmin probing hidden vs unknown ID MUST
  // return uniform 404 immediately (read-only precheck BEFORE locks -> zero wait, never lock timeout).
  let scopeLocked!: () => void;
  const scopeLockedReady = new Promise<void>((r) => { scopeLocked = r; });
  let releaseScope!: () => void;
  const scopeReleaseGate = new Promise<void>((r) => { releaseScope = r; });
  const holderTx = sql.begin(async (tx) => {
    await tx`SELECT 1 FROM swarm.conversations WHERE conversation_id = ${privCh.id}::uuid FOR UPDATE`;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`conversation-frames:${workspace}:${privCh.id}`}, 0))`;
    await tx`SELECT 1 FROM swarm.system_alerts WHERE alert_id = ${privAlertId}::uuid FOR UPDATE`;
    scopeLocked();
    await scopeReleaseGate;
  });
  await scopeLockedReady;
  try {
    const markLocked1 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
    const lockedUnknown = await send(wsAdmin.jwt, { kind: "resolve_system_alert", alert_id: randomUUID(), note: "locked-probe" });
    const auditLockedUnknown = await auditRowsFor(wsAdmin.id, markLocked1);

    const markLocked2 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
    const lockedHidden = await send(wsAdmin.jwt, { kind: "resolve_system_alert", alert_id: privAlertId, note: "locked-probe" });
    const auditLockedHidden = await auditRowsFor(wsAdmin.id, markLocked2);

    assert.equal(lockedUnknown.status, 404);
    assert.equal(lockedHidden.status, 404, "hidden private alert must refuse before taking locks, never returning lock timeout");
    assert.deepEqual(lockedHidden.body, lockedUnknown.body);
    assert.deepEqual(auditLockedHidden, auditLockedUnknown);
  } finally {
    releaseScope();
    await holderTx;
  }

  // Authorized control: leadPriv resolves (and retries/conflicts, including after removal) ->
  // hidden from non-member wsAdmin in swarm_read.audit_log, visible to member owner!
  const mark3 = (await sql<{ mark: string }[]>`SELECT coalesce(max(audit_id), 0)::text AS mark FROM swarm.audit_log`)[0]!.mark;
  const resolveCmdId = randomUUID();
  const secretNote = `Restarted ${randomUUID()}`;
  assert.equal((await send(leadPriv.token, { kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote }, resolveCmdId)).status, 200);
  assert.equal((await send(leadPriv.token, { kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote }, resolveCmdId)).status, 200);
  assert.equal((await send(leadPriv.token, { kind: "resolve_system_alert", alert_id: privAlertId, note: "conflict" }, resolveCmdId)).status, 409);
  assert.equal((await send(owner.jwt, { kind: "channel_member_remove", channel_id: privCh.id, member: { kind: "agent", id: leadPriv.principal } })).status, 200);
  assert.equal((await send(leadPriv.token, { kind: "resolve_system_alert", alert_id: privAlertId, note: secretNote }, resolveCmdId)).status, 404);

  assert.equal((await auditRowsFor(wsAdmin.id, mark3)).length, 0, "non-member admin sees ZERO authorized private resolve/retry audit rows");
  assert.equal((await auditRowsFor(owner.id, mark3)).length, 4, "authorized member owner sees all 4 private resolve/retry audit rows");
  assert.equal(functionLogs.includes(secretNote), false, "resolution note stays out of general logs");
});

async function waitForBlockedBy(holderPid: number, queryPattern: string, label: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await sql<{ pid: number; wait_event_type: string | null; wait_event: string | null; query: string }[]>`
      SELECT pid, wait_event_type, wait_event, query
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND ${holderPid}::int = ANY(pg_blocking_pids(pid))
        AND query ILIKE ${`%${queryPattern}%`}
    `;
    if (rows.length > 0) return;
    await delay(25);
  }
  const diag = await sql`
    SELECT pid, state, wait_event_type, wait_event, pg_blocking_pids(pid) AS blockers, left(query, 120) AS q
    FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND state <> 'idle'
  `;
  throw new Error(`${label}: expected query matching "${queryPattern}" to block on pid ${holderPid}; active=${JSON.stringify(diag)}`);
}

test("Condition 4: real-socket bare wake control, served conversion lock-order race, multi-scope workspace-removal race, and resolve-vs-escalation race", { timeout: 120_000 }, async () => {
  const quietSeat = await agentOf(owner.id, "quiet-c4");
  const controlLead = await agentOf(owner.id, "ctrl-lead-c4");
  await setPresence(wsLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(controlLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });

  // 1. Authorized real-socket wake control: minimal {"v": 1} payload only!
  const ctrlCh = await createChannel(owner, "wake-ctrl");
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: ctrlCh.id, lead_mode: "agent", principal_id: controlLead.principal,
  })).status, 200);
  const ctrlSock = await subscribeWakeSocket(controlLead.wakeId);
  try {
    const [ctrlAlert] = await sql<{ id: string | null }[]>`
      SELECT swarm.record_system_alert(
        ${workspace}::uuid, 'agent_quiet', ${quietSeat.principal}::uuid, ${ctrlCh.id}::uuid,
        1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
      ) AS id
    `;
    assert.ok(ctrlAlert?.id, "control alert must be recorded");
    const [ctrlRow] = await sql<Row[]>`
      SELECT alert_id, routed_lead_principal_id, escalated_at FROM swarm.system_alerts WHERE alert_id = ${ctrlAlert.id}::uuid
    `;
    assert.equal(ctrlRow!.routed_lead_principal_id, controlLead.principal, "control alert must route to controlLead");
    const deadline = Date.now() + 15_000;
    while (ctrlSock.frames.length === 0 && Date.now() < deadline) await delay(50);
    const queuedFrames = await sql<Row[]>`
      SELECT topic, event, extension, private, payload FROM realtime.messages WHERE topic = ${`cswarm-wake:${controlLead.wakeId}`}
    `;
    if (ctrlSock.frames.length === 0) {
      await sql`SELECT realtime.send('{"v":1,"probe":"direct"}'::jsonb, 'wake', ${`cswarm-wake:${controlLead.wakeId}`}, true)`;
      await delay(2_000);
    }
    assert.ok(
      ctrlSock.frames.length >= 1,
      `authorized lead socket must receive wake frame (alert=${JSON.stringify(ctrlRow)}, queued=${JSON.stringify(queuedFrames)}, statuses=${JSON.stringify(ctrlSock.statuses)}, allBroadcasts=${JSON.stringify(ctrlSock.allBroadcasts)})`,
    );
    const frameKeys = Object.keys(ctrlSock.frames[0]!).filter((k) => k !== "id");
    assert.deepEqual(frameKeys, ["v"], `wake frame must carry minimal {v:1} only; got ${JSON.stringify(ctrlSock.frames[0])}`);
    assert.equal(ctrlSock.frames[0]!.v, 1);
  } finally {
    await ctrlSock.close();
  }

  // 2. Served channel_update conversion lock sequence:
  //    channel-access -> UPDATE swarm.channels (triggers channels_sync_conversation on conversations(ch)
  //    THEN channels_sync_conversation_frames on conversation-frames(ws, ch)).
  //    Start BOTH record_system_alert (.execute()) AND served resolve_system_alert eagerly, prove BOTH
  //    genuinely reach pg_stat_activity Lock wait behind conversion BEFORE releasing conversion!
  const convCh = await createChannel(owner, "conv-race");
  const preAlertId = (await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'agent_quiet', ${quietSeat.principal}::uuid, ${convCh.id}::uuid,
      1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
    ) AS id
  `)[0]!.id;
  const secondQuiet = await agentOf(owner.id, "quiet-c4-b");
  const wsLeadSock = await subscribeWakeSocket(wsLead.wakeId);
  try {
    let holderPid = 0;
    let lockHeld!: () => void;
    const locked = new Promise<void>((r) => { lockHeld = r; });
    let allowCommit!: () => void;
    const commitGate = new Promise<void>((r) => { allowCommit = r; });

    // Exact served channel_update lock order: channel-access -> UPDATE swarm.channels -> channel_members.
    const conversionTx = sql.begin(async (tx) => {
      const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      holderPid = pid;
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`channel-access:${workspace}:${convCh.id}`}, 0))`;
      await tx`UPDATE swarm.channels SET visibility = 'private' WHERE workspace_id = ${workspace}::uuid AND channel_id = ${convCh.id}::uuid`;
      await tx`INSERT INTO swarm.channel_members (workspace_id, channel_id, member_kind, user_id, added_by_kind, added_by_principal)
        VALUES (${workspace}::uuid, ${convCh.id}::uuid, 'user', ${owner.id}::uuid, 'user', ${owner.id}::uuid)
        ON CONFLICT DO NOTHING`;
      lockHeld();
      await commitGate;
    });
    await locked;

    // Eagerly dispatch BOTH concurrent writers while conversion holds served locks.
    const concurrentAlert = sql<{ id: string }[]>`
      SELECT swarm.record_system_alert(
        ${workspace}::uuid, 'agent_quiet', ${secondQuiet.principal}::uuid, ${convCh.id}::uuid,
        1, statement_timestamp() - interval '15 minutes', interval '30 minutes'
      ) AS id
    `.execute();
    const concurrentResolve = send(wsLead.token, {
      kind: "resolve_system_alert", alert_id: preAlertId, note: "late resolve during conversion",
    });

    await waitForBlockedBy(holderPid, "record_system_alert", "concurrent alert during served conversion");
    await waitForBlockedBy(holderPid, "resolve_system_alert", "concurrent resolve during served conversion");

    allowCommit();
    const [, [newAlertRow], resolveRes] = await Promise.all([conversionTx, concurrentAlert, concurrentResolve]);

    // Zero deadlock; after conversion commits: wsLead refused on resolve (404), new alert routed NULL, ZERO wake frame!
    assert.equal(resolveRes.status, 404, "concurrent resolve must be refused once conversion removes wsLead");
    const [newAlert] = await sql<Row[]>`
      SELECT routed_lead_principal_id FROM swarm.system_alerts WHERE alert_id = ${newAlertRow!.id}::uuid
    `;
    assert.equal(newAlert!.routed_lead_principal_id, null, "new alert after private conversion must not route to excluded wsLead");
    await delay(300);
    assert.equal(wsLeadSock.frames.length, 0, "excluded wsLead socket must receive ZERO late wake frames");
  } finally {
    await wsLeadSock.close();
  }

  // 3. Served workspace-removal race (exact agent-auth.ts:647 order: workspaces FOR UPDATE +
  //    agent_principals FOR UPDATE -> agent_workspace_memberships update triggering
  //    swarm.conversation_lock_workspace) racing BOTH sync_quiet_agent_alerts AND a brand-new
  //    record_system_alert insert in that workspace. Proves zero FK parent-lock inversion!
  const msCh1 = await createChannel(owner, "multi-scope-1");
  const msCh2 = await createChannel(owner, "multi-scope-2");
  const msLead = await agentOf(owner.id, "ms-lead");
  const msQuiet = await agentOf(owner.id, "ms-quiet");
  const fkInsertSeat = await agentOf(owner.id, "fk-insert-seat");
  await setPresence(msLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(msQuiet, { watcherAgoSec: 600, lastCommandAgoSec: 900 });
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: msCh1.id, lead_mode: "agent", principal_id: msLead.principal,
  })).status, 200);
  assert.equal((await send(owner.jwt, {
    kind: "set_channel_lead", channel_id: msCh2.id, lead_mode: "agent", principal_id: msLead.principal,
  })).status, 200);
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: msQuiet, channelId: msCh1.id, ageMinutes: 25 });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: msQuiet, channelId: msCh2.id, ageMinutes: 20 });
  await enqueueWaitingDelivery({ senderUserId: member.id, recipientAgent: msQuiet, channelId: null, ageMinutes: 15 });

  let msHolderPid = 0;
  let msLocked!: () => void;
  const msLockedReady = new Promise<void>((r) => { msLocked = r; });
  let msAllowCommit!: () => void;
  const msCommitGate = new Promise<void>((r) => { msAllowCommit = r; });
  const removalTx = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    msHolderPid = pid;
    // Exact served member/agent removal lock order (agent-auth.ts:647): workspaces FOR UPDATE +
    // agent_principals FOR UPDATE BEFORE conversation_lock_workspace!
    await tx`SELECT 1 FROM swarm.workspaces WHERE workspace_id = ${workspace}::uuid FOR UPDATE`;
    await tx`
      SELECT 1 FROM swarm.agent_principals
      WHERE principal_id IN (${msLead.principal}::uuid, ${fkInsertSeat.principal}::uuid, ${wsLead.principal}::uuid)
      ORDER BY principal_id FOR UPDATE
    `;
    await tx`
      UPDATE swarm.agent_workspace_memberships
      SET revoked_at = statement_timestamp()
      WHERE workspace_id = ${workspace}::uuid
        AND principal_id = ${msLead.principal}::uuid
    `;
    msLocked();
    await msCommitGate;
  });
  await msLockedReady;

  const multiScopeTimer = sql<{ res: Row }[]>`
    SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes') AS res
  `.execute();
  const concurrentFkInsert = sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'local_renewal_superseded', ${fkInsertSeat.principal}::uuid, ${msCh1.id}::uuid
    ) AS id
  `.execute();
  await waitForBlockedBy(msHolderPid, "sync_quiet_agent_alerts", "multi-scope timer racing served workspace removal");
  await waitForBlockedBy(msHolderPid, "record_system_alert", "new alert insert racing served workspace/principal locks");
  msAllowCommit();
  const [, [timerResult], [fkInserted]] = await Promise.all([removalTx, multiScopeTimer, concurrentFkInsert]);
  assert.ok(Number(timerResult!.res.synced) >= 3, "multi-scope timer must complete without deadlock after served workspace removal");
  assert.ok(fkInserted?.id, "new alert insert must complete without FK parent-lock deadlock");
  const msAlerts = await sql<Row[]>`
    SELECT channel_id, routed_lead_principal_id
    FROM swarm.system_alerts
    WHERE workspace_id = ${workspace}::uuid AND affected_principal_id = ${msQuiet.principal}::uuid
  `;
  assert.equal(msAlerts.length, 3);
  for (const row of msAlerts) {
    assert.notEqual(row.routed_lead_principal_id, msLead.principal, "removed workspace lead must NOT receive multi-scope route");
  }

  // 4. Multi-workspace principal retirement (20261118000005:1035, locking workspaces in workspace_id
  //    ASC then conversations in conversation_id ASC) racing multi-workspace sync_quiet_agent_alerts!
  const retiringLead = await agentOf(owner.id, "multi-ws-retire");
  const otherQuiet = await agentOf(owner.id, "other-ws-quiet", otherWorkspace);
  await sql`
    INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${retiringLead.principal}::uuid, ${otherWorkspace}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)
    ON CONFLICT DO NOTHING
  `;
  await setPresence(retiringLead, { watcherAgoSec: 5, lastCommandAgoSec: 5 });
  await setPresence(otherQuiet, { watcherAgoSec: 600, lastCommandAgoSec: 900, ws: otherWorkspace });
  const otherCh = await createChannel(owner, "other-ws-ch", {}, otherWorkspace);
  await enqueueWaitingDelivery({ ws: otherWorkspace, senderUserId: owner.id, recipientAgent: otherQuiet, channelId: otherCh.id, ageMinutes: 25 });
  await enqueueWaitingDelivery({ ws: otherWorkspace, senderUserId: owner.id, recipientAgent: otherQuiet, channelId: null, ageMinutes: 20 });

  let retirePid = 0;
  let retireLocked!: () => void;
  const retireLockedReady = new Promise<void>((r) => { retireLocked = r; });
  let releaseRetire!: () => void;
  const retireReleaseGate = new Promise<void>((r) => { releaseRetire = r; });
  const retireTx = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    retirePid = pid;
    // Triggers agent_principals_apply_conversations across BOTH workspace and otherWorkspace!
    await tx`
      UPDATE swarm.agent_principals
      SET revoked_at = statement_timestamp()
      WHERE principal_id = ${retiringLead.principal}::uuid
    `;
    retireLocked();
    await retireReleaseGate;
  });
  await retireLockedReady;
  const multiWsTimer = sql<{ res: Row }[]>`
    SELECT swarm.sync_quiet_agent_alerts(interval '30 minutes') AS res
  `.execute();
  await waitForBlockedBy(retirePid, "sync_quiet_agent_alerts", "multi-workspace timer racing principal retirement");
  releaseRetire();
  const [, [multiWsResult]] = await Promise.all([retireTx, multiWsTimer]);
  assert.ok(Number(multiWsResult!.res.synced) >= 2, "multi-workspace timer must serialize with principal retirement without deadlock");

  // 5. Opposite alert_id vs natural-key order witness: two due hosted_seat_refused alerts with
  //    alert_ids strictly reversed relative to (workspace_id, affected_principal_id) order, racing
  //    record_hosted_seat_refused_alerts against escalate_due_system_alerts!
  const rawHost1 = await agentOf(owner.id, "host-order-a");
  const rawHost2 = await agentOf(owner.id, "host-order-b");
  const [hostFirst, hostSecond] = rawHost1.principal < rawHost2.principal ? [rawHost1, rawHost2] : [rawHost2, rawHost1];
  const orderGrantId = randomUUID();
  const orderProviderId = `pg_ord_${randomBytes(12).toString("hex")}`;
  const orderDigest = createHash("sha256").update("order-manifest-v1").digest();
  const [alertIdLow, alertIdHigh] = [randomUUID(), randomUUID()].sort() as [string, string];
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm.agent_principals SET transport = 'hosted_mcp', turn_only = true
      WHERE principal_id IN (${hostFirst.principal}::uuid, ${hostSecond.principal}::uuid)`;
    await tx`INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${orderGrantId}::uuid, ${orderProviderId}, ${owner.id}::uuid, ${workspace}::uuid, 'client-ord',
        'https://mcp.commonswarm.com/mcp', ARRAY[${workspace}::uuid], ${orderDigest},
        'ref-ord', 'active', statement_timestamp(), statement_timestamp()
      )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (
        grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
      ) VALUES (${orderGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${orderDigest}, ${randomUUID()}::uuid, statement_timestamp())`;
    for (const s of [hostFirst, hostSecond]) {
      await tx`INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
        VALUES (${orderGrantId}::uuid, ${s.principal}::uuid, ${owner.id}::uuid)`;
      await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${randomUUID()}::uuid, ${orderGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${s.principal}::uuid, ${s.name}, statement_timestamp())`;
    }
    // Insert due open alerts with alert_id order REVERSED vs (workspace_id, affected_principal_id)!
    await tx`INSERT INTO swarm.system_alerts (
        alert_id, workspace_id, channel_id, kind, affected_principal_id, fix_hint,
        routed_lead_principal_id, routed_at, opened_at, escalate_after, escalated_at, updated_at
      ) VALUES
        (${alertIdHigh}::uuid, ${workspace}::uuid, NULL, 'hosted_seat_refused', ${hostFirst.principal}::uuid,
         'Reconnect hosted MCP.', ${wsLead.principal}::uuid, statement_timestamp() - interval '1 hour',
         statement_timestamp() - interval '1 hour', statement_timestamp() - interval '30 minutes', NULL, statement_timestamp()),
        (${alertIdLow}::uuid, ${workspace}::uuid, NULL, 'hosted_seat_refused', ${hostSecond.principal}::uuid,
         'Reconnect hosted MCP.', ${wsLead.principal}::uuid, statement_timestamp() - interval '1 hour',
         statement_timestamp() - interval '1 hour', statement_timestamp() - interval '30 minutes', NULL, statement_timestamp())`;
  });

  let orderPid = 0;
  let orderLocked!: () => void;
  const orderLockedReady = new Promise<void>((r) => { orderLocked = r; });
  let releaseOrder!: () => void;
  const orderReleaseGate = new Promise<void>((r) => { releaseOrder = r; });
  const firstKey = `system_alert:${workspace}:hosted_seat_refused:${hostFirst.principal}:00000000-0000-0000-0000-000000000000`;
  const orderHoldTx = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    orderPid = pid;
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${firstKey}, 0))`;
    orderLocked();
    await orderReleaseGate;
  });
  await orderLockedReady;

  const hostedBatchRace = sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${orderProviderId}, ${owner.id}::uuid) AS n
  `.execute();
  const escalateOrderRace = sql<{ n: number }[]>`
    SELECT swarm.escalate_due_system_alerts() AS n
  `.execute();
  await waitForBlockedBy(orderPid, "record_hosted_seat_refused_alerts", "hosted batch blocked on canonical first key");
  await waitForBlockedBy(orderPid, "escalate_due_system_alerts", "escalation timer blocked on same canonical first key");
  releaseOrder();
  const [, [hostedBatchRes], [escalateOrderRes]] = await Promise.all([orderHoldTx, hostedBatchRace, escalateOrderRace]);
  assert.equal(hostedBatchRes!.n, 2, "hosted batch must complete without deadlock against reversed alert_ids");
  assert.ok(escalateOrderRes!.n >= 2, "escalation timer must complete without deadlock against reversed alert_ids");

  // 6. Resolve racing escalation against the same row lock: verify real lock wait in pg_stat_activity!
  const raceSeat = await agentOf(owner.id, "race-seat-c4");
  const raceAlertId = (await sql<{ id: string }[]>`
    SELECT swarm.record_system_alert(
      ${workspace}::uuid, 'local_renewal_superseded', ${raceSeat.principal}::uuid, NULL,
      NULL, NULL, interval '0 seconds'
    ) AS id
  `)[0]!.id;
  await sql`UPDATE swarm.system_alerts SET escalate_after = opened_at, escalated_at = NULL WHERE alert_id = ${raceAlertId}::uuid`;

  let resolveHolderPid = 0;
  let resolveLocked!: () => void;
  const lockedRow = new Promise<void>((r) => { resolveLocked = r; });
  let allowResolveCommit!: () => void;
  const commitResolveGate = new Promise<void>((r) => { allowResolveCommit = r; });
  const resolveTx = sql.begin(async (tx) => {
    const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    resolveHolderPid = pid;
    const [r] = await tx<{ res: Row }[]>`
      SELECT swarm.resolve_system_alert(
        ${workspace}::uuid, ${raceAlertId}::uuid, 'agent', ${wsLead.principal}::uuid, ${owner.id}::uuid, 'Fixed during race'
      ) AS res
    `;
    resolveLocked();
    await commitResolveGate;
    return r!.res;
  });
  await lockedRow;
  const escPromise = sql<{ n: number }[]>`SELECT swarm.escalate_due_system_alerts() AS n`.execute();
  await waitForBlockedBy(resolveHolderPid, "escalate_due_system_alerts", "escalation racing resolve row lock");
  allowResolveCommit();
  const [resOutcome, [escCount]] = await Promise.all([resolveTx, escPromise]);
  assert.equal((resOutcome as Row).outcome, "resolved");
  assert.equal(escCount!.n, 0, "resolved row must not escalate when racing timer");
});

test("Condition 5 & Delivery: pinned roles, unclaimed vs serving hosted replacement, served MCP refusal producer, real pg_cron tick to owner inbox, and CLI/client end-to-end flow", { timeout: 120_000 }, async () => {
  // 1. Pinned roles: direct table writes and internal producer EXECUTE refused (isolated per tx).
  const expectDeniedAs = async (role: string, run: (tx: postgres.TransactionSql) => Promise<unknown>, label: string) => {
    await assert.rejects(
      () => sql.begin(async (tx) => {
        await tx.unsafe(`SET LOCAL ROLE ${role}`);
        await run(tx);
      }),
      (err: { code?: string }) => err.code === "42501",
      `${role}: ${label}`,
    );
  };
  for (const role of ["authenticated", "swarm_read", "swarm_command"]) {
    await expectDeniedAs(
      role,
      (tx) => tx`INSERT INTO swarm.system_alerts (workspace_id, kind, affected_principal_id, fix_hint, escalate_after)
        VALUES (${workspace}::uuid, 'local_credential_revoked', ${wsLead.principal}::uuid, 'x', statement_timestamp())`,
      "direct insert",
    );
    await expectDeniedAs(role, (tx) => tx`SELECT swarm.sync_quiet_agent_alerts()`, "sync_quiet_agent_alerts");
    await expectDeniedAs(role, (tx) => tx`SELECT swarm.escalate_due_system_alerts()`, "escalate_due_system_alerts");
    await expectDeniedAs(role, (tx) => tx`SELECT swarm.system_alert_lock_scope(${workspace}::uuid, NULL)`, "system_alert_lock_scope");
    await expectDeniedAs(role, (tx) => tx`SELECT swarm.system_alert_lock_scopes(ARRAY[${workspace}::uuid], ARRAY[NULL::uuid])`, "system_alert_lock_scopes");
  }
  for (const role of ["authenticated", "swarm_read"]) {
    await expectDeniedAs(
      role,
      (tx) => tx`SELECT swarm.record_system_alert(${workspace}::uuid, 'local_credential_revoked', ${wsLead.principal}::uuid)`,
      "record_system_alert",
    );
    await expectDeniedAs(
      role,
      (tx) => tx`SELECT swarm.record_hosted_seat_refused_alerts('pg_1234567890abcdef', ${owner.id}::uuid)`,
      "record_hosted_seat_refused_alerts",
    );
  }

  // 2. Grant-scoped hosted seat refusal:
  //    - strandedSeat has a live seat on retiredGrant in `workspace` AND an unrelated membership in `otherWorkspace`
  //    - reconnectedSeat was on retiredGrant in `workspace` AND first has ONLY an UNCLAIMED replacement
  //      grant (grant + workspace consent + grant_agents, NO seat/handle -> MUST STILL alert!),
  //      then gets a live replacement seat + handle (actively serving -> MUST suppress!).
  const strandedSeat = await agentOf(owner.id, "hosted-stranded");
  const reconnectedSeat = await agentOf(owner.id, "hosted-reconnected");
  const retiredGrantId = randomUUID();
  const replacementGrantId = randomUUID();
  const retiredProviderId = `pg_ret_${randomBytes(12).toString("hex")}`;
  const replacementProviderId = `pg_new_${randomBytes(12).toString("hex")}`;
  const digest = createHash("sha256").update("manifest-v1").digest();
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm.agent_principals SET transport = 'hosted_mcp', turn_only = true
      WHERE principal_id IN (${strandedSeat.principal}::uuid, ${reconnectedSeat.principal}::uuid)`;
    // Unrelated workspace membership for strandedSeat (NOT consented on retiredGrant!)
    await tx`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
      VALUES (${strandedSeat.principal}::uuid, ${otherWorkspace}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)`;
    // Retired grant covering workspace ONLY
    await tx`INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${retiredGrantId}::uuid, ${retiredProviderId}, ${owner.id}::uuid, ${workspace}::uuid, 'client-a',
        'https://mcp.commonswarm.com/mcp', ARRAY[${workspace}::uuid], ${digest},
        'ref-ret', 'active', statement_timestamp(), statement_timestamp()
      )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (
        grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
      ) VALUES (${retiredGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    for (const seat of [strandedSeat, reconnectedSeat]) {
      await tx`INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
        VALUES (${retiredGrantId}::uuid, ${seat.principal}::uuid, ${owner.id}::uuid)`;
      await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
        VALUES (${randomUUID()}::uuid, ${retiredGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${seat.principal}::uuid, ${seat.name}, statement_timestamp())`;
    }
    // Step 2a: Eligible UNCLAIMED replacement grant for reconnectedSeat (NO hosted_mcp_seats/handles yet!)
    await tx`INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${replacementGrantId}::uuid, ${replacementProviderId}, ${owner.id}::uuid, ${workspace}::uuid, 'client-a',
        'https://mcp.commonswarm.com/mcp', ARRAY[${workspace}::uuid], ${digest},
        'ref-new', 'active', statement_timestamp(), statement_timestamp()
      )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (
        grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
      ) VALUES (${replacementGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
      VALUES (${replacementGrantId}::uuid, ${reconnectedSeat.principal}::uuid, ${owner.id}::uuid)`;
  });

  // Truncated / wrong-owner -> 0; unclaimed replacement MUST NOT suppress (both seats alert!).
  assert.equal((await sql<{ n: number }[]>`SELECT swarm.record_hosted_seat_refused_alerts(${retiredProviderId.slice(0, 8)}, ${owner.id}::uuid) AS n`)[0]!.n, 0);
  assert.equal((await sql<{ n: number }[]>`SELECT swarm.record_hosted_seat_refused_alerts(${retiredProviderId}, ${wsAdmin.id}::uuid) AS n`)[0]!.n, 0);
  const [unclaimedRecorded] = await sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${retiredProviderId}, ${owner.id}::uuid) AS n
  `;
  assert.equal(unclaimedRecorded!.n, 2, "unclaimed replacement grant (no live seat/handle) must NOT suppress hosted_seat_refused");

  // Step 2b: Now give reconnectedSeat a live seat + handle on replacementGrant (actually serving!).
  // Clear prior open hosted_seat_refused rows and re-run -> MUST record 1 (strandedSeat ONLY!).
  await sql`DELETE FROM swarm.system_alerts WHERE kind = 'hosted_seat_refused' AND affected_principal_id IN (${strandedSeat.principal}::uuid, ${reconnectedSeat.principal}::uuid)`;
  const replSeatId = randomUUID();
  const replHandle = `seat_${randomBytes(18).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
      VALUES (${replSeatId}::uuid, ${replacementGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${reconnectedSeat.principal}::uuid, ${`${reconnectedSeat.name}-v2`}, statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
      VALUES (${replHandle}, ${replSeatId}::uuid, ${replacementGrantId}::uuid, ${workspace}::uuid, ${reconnectedSeat.principal}::uuid, statement_timestamp())`;
  });

  const [hostedRecorded] = await sql<{ n: number }[]>`
    SELECT swarm.record_hosted_seat_refused_alerts(${retiredProviderId}, ${owner.id}::uuid) AS n
  `;
  assert.equal(hostedRecorded!.n, 1, "only strandedSeat in grant-approved workspace; actively serving replacement seat and unrelated workspace excluded");
  const hostedAlerts = await sql<Row[]>`
    SELECT workspace_id, affected_principal_id FROM swarm.system_alerts
    WHERE kind = 'hosted_seat_refused'
      AND affected_principal_id IN (${strandedSeat.principal}::uuid, ${reconnectedSeat.principal}::uuid)
  `;
  assert.deepEqual(hostedAlerts.map((r) => ({ ws: r.workspace_id, p: r.affected_principal_id })), [
    { ws: workspace, p: strandedSeat.principal },
  ]);

  // 3. Served MCP refusal producer witness: invoke supabase/functions/mcp/index.ts executeTool on a
  //    retired refresh-family grant against real Postgres -> must refuse tool AND record alert!
  const servedSeat = await agentOf(owner.id, "hosted-served-refusal");
  const servedGrantId = randomUUID();
  const servedSeatId = randomUUID();
  const servedProviderId = `pg_srv_${randomBytes(12).toString("hex")}`;
  const servedHandle = `seat_${randomBytes(18).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`UPDATE swarm.agent_principals SET transport = 'hosted_mcp', turn_only = true WHERE principal_id = ${servedSeat.principal}::uuid`;
    await tx`INSERT INTO swarm.hosted_mcp_grants (
        grant_id, provider_grant_id, owner_user_id, home_workspace_id, client_id, resource,
        selected_workspace_ids, manifest_digest, interaction_ref, state, created_at, activated_at
      ) VALUES (
        ${servedGrantId}::uuid, ${servedProviderId}, ${owner.id}::uuid, ${workspace}::uuid, 'client-a',
        'https://mcp.commonswarm.com/mcp', ARRAY[${workspace}::uuid], ${digest},
        'ref-srv', 'active', statement_timestamp(), statement_timestamp()
      )`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_workspaces (
        grant_id, workspace_id, owner_user_id, manifest_digest, consent_receipt_id, consented_at
      ) VALUES (${servedGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${digest}, ${randomUUID()}::uuid, statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_grant_agents (grant_id, principal_id, owner_user_id)
      VALUES (${servedGrantId}::uuid, ${servedSeat.principal}::uuid, ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.hosted_mcp_seats (seat_id, grant_id, workspace_id, owner_user_id, principal_id, name, created_at)
      VALUES (${servedSeatId}::uuid, ${servedGrantId}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${servedSeat.principal}::uuid, ${servedSeat.name}, statement_timestamp())`;
    await tx`INSERT INTO swarm.hosted_mcp_seat_handles (handle, seat_id, grant_id, workspace_id, principal_id, created_at)
      VALUES (${servedHandle}, ${servedSeatId}::uuid, ${servedGrantId}::uuid, ${workspace}::uuid, ${servedSeat.principal}::uuid, statement_timestamp())`;
    // Retire the OAuth refresh family so the signed access token triggers hosted_seat_forbidden -> hosted_seat_refused!
    await tx`INSERT INTO commonswarm_oauth.refresh_family_tombstones (grant_id, revoked_at)
      VALUES (${servedProviderId}, statement_timestamp())`;
  });
  const mcpUrl = new URL("../../supabase/functions/mcp/index.ts", import.meta.url).href;
  const mcpHarness = join(envDir!, "mcp-refusal-harness.ts");
  writeFileSync(mcpHarness, `
    import { executeHostedTool } from ${JSON.stringify(mcpUrl)};
    const input = JSON.parse(await new Response(Deno.stdin.readable).text());
    try {
      await executeHostedTool({
        name: "whoami",
        arguments: { seat: input.handle },
        token: {
          subject: input.ownerId,
          providerGrantId: input.providerGrantId,
          expiresAt: Math.floor(Date.now() / 1000) + 300,
        },
        signal: AbortSignal.timeout(10_000),
      });
      console.log(JSON.stringify({ refused: false }));
    } catch (err) {
      console.log(JSON.stringify({ refused: true, code: (err as { code?: string })?.code ?? String(err) }));
    }
    Deno.exit(0);
  `);
  const mcpRun = spawnSync(
    "deno",
    ["run", "--no-lock", "--config", "supabase/functions/mcp/deno.json", "--allow-env", "--allow-net", "--allow-read", mcpHarness],
    {
      cwd: process.cwd(),
      input: JSON.stringify({ handle: servedHandle, ownerId: owner.id, providerGrantId: servedProviderId }),
      encoding: "utf8",
      timeout: 60_000,
      env: {
        ...process.env,
        SWARM_ENV: "test",
        SWARM_MCP_PUBLIC_ENABLED: "1",
        SWARM_DATABASE_URL: local.DB_URL,
        SUPABASE_DB_URL: local.DB_URL,
        SUPABASE_URL: local.API_URL,
        SUPABASE_ANON_KEY: local.ANON_KEY,
        SUPABASE_SERVICE_ROLE_KEY: local.SERVICE_ROLE_KEY,
      },
    },
  );
  assert.equal(mcpRun.status, 0, `mcp refusal harness failed: stdout=${mcpRun.stdout} stderr=${mcpRun.stderr}`);
  const mcpLines = mcpRun.stdout.trim().split("\n").filter(Boolean);
  const mcpOutcome = JSON.parse(mcpLines[mcpLines.length - 1]!) as { refused: boolean; code?: string };
  assert.equal(mcpOutcome.refused, true, `served MCP call on retired family must be refused: ${JSON.stringify(mcpOutcome)}`);
  const servedAlertRows = await sql<Row[]>`
    SELECT alert_id, kind, workspace_id, affected_principal_id
    FROM swarm.system_alerts
    WHERE kind = 'hosted_seat_refused' AND affected_principal_id = ${servedSeat.principal}::uuid
  `;
  assert.equal(servedAlertRows.length, 1, "served MCP refusal must record hosted_seat_refused alert in swarm.system_alerts");

  // 4. Real scheduled pg_cron tick -> authorized owner_alert_inbox + CLI/client end-to-end flow!
  const [cronJob] = await sql<{ jobid: number; jobname: string; schedule: string; active: boolean; command: string }[]>`
    SELECT jobid, jobname, schedule, active, command FROM cron.job WHERE jobname = 'swarm-sync-system-alerts'
  `;
  assert.ok(cronJob, "swarm-sync-system-alerts pg_cron job must be scheduled");
  assert.equal(cronJob.schedule, "*/2 * * * *");
  assert.equal(cronJob.active, true);
  assert.match(cronJob.command, /swarm\.sync_quiet_agent_alerts/);

  const cliTarget = { profileId: "lead-alerts-test", url: local.API_URL, anonKey: local.ANON_KEY };
  const leadVisible = await readSystemAlerts(cliTarget, wsLead.token, workspace);
  const targetAlert = leadVisible.alerts.find((a) => a.affected_principal_id === strandedSeat.principal);
  assert.ok(targetAlert, "lead must see hosted_seat_refused alert via readSystemAlerts");

  // Backdate escalate_after and let the REAL pg_cron background worker run cronJob.command on a 1s tick!
  await sql`UPDATE swarm.system_alerts SET escalate_after = opened_at WHERE alert_id = ${targetAlert.alert_id}::uuid`;
  const testJobName = `swarm-alerts-tick-${randomBytes(4).toString("hex")}`;
  const [{ testJobId }] = await sql<{ testJobId: number }[]>`
    SELECT cron.schedule(${testJobName}, '1 second', ${cronJob.command}) AS "testJobId"
  `;
  try {
    const tickDeadline = Date.now() + 12_000;
    let ticked = false;
    while (Date.now() < tickDeadline) {
      const [run] = await sql<{ status: string }[]>`
        SELECT status FROM cron.job_run_details
        WHERE jobid = ${testJobId} AND status = 'succeeded'
        ORDER BY start_time DESC LIMIT 1
      `;
      if (run) {
        ticked = true;
        break;
      }
      await delay(200);
    }
    assert.equal(ticked, true, "real pg_cron worker must execute the scheduled alert sync command");
  } finally {
    await sql`SELECT cron.unschedule(${testJobName}) WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = ${testJobName})`;
  }

  // Real pg_cron tick escalated targetAlert -> visible in owner_alert_inbox (admin excluded)!
  const ownerEscalated = await readSystemAlerts(cliTarget, owner.jwt, workspace, { escalatedOnly: true });
  assert.ok(ownerEscalated.alerts.some((a) => a.alert_id === targetAlert.alert_id), "real pg_cron tick must escalate due alert to owner inbox");
  const adminEscalated = await readSystemAlerts(cliTarget, wsAdmin.jwt, workspace, { escalatedOnly: true });
  assert.equal(adminEscalated.alerts.length, 0, "admin must NOT receive escalated_only owner inbox alerts");

  // Repeated escalation is idempotent (0 additional escalations).
  assert.equal((await sql<{ n: number }[]>`SELECT swarm.escalate_due_system_alerts() AS n`)[0]!.n, 0);

  const cmdClient = new ThinCommandClient(cliTarget);
  const resolved = await cmdClient.sendResolveSystemAlert({
    workspaceId: workspace,
    credential: wsLead.token,
    command: resolveSystemAlertCommand(targetAlert.alert_id, "Reconnected hosted MCP grant."),
  });
  assert.equal(resolved.httpStatus, 200);
  assert.equal(resolved.response.alert.was_escalated, true);

  const ownerEscalatedAfter = await readSystemAlerts(cliTarget, owner.jwt, workspace, { escalatedOnly: true });
  assert.equal(ownerEscalatedAfter.alerts.some((a) => a.alert_id === targetAlert.alert_id), false);
});

test("best-effort access_lost alerts bail within 250ms under #general FOR UPDATE without blocking renew_wake_lease, signals_seen, or activity", { timeout: 60_000 }, async () => {
  // Set up:
  // 1. A second workspace for owner + multi-workspace revoked agents (command & activity).
  // 2. A standing-grant local agent whose predecessor token has a used successor so renew_agent_token
  //    hits the real predecessor_superseded refusal path (the prime suspect for holding swarm.users
  //    FOR NO KEY UPDATE when record_system_alert ran inline inside the renewal transaction).
  // 3. A sibling agent owned by the SAME owner with an active wake lease + a live signal so we can
  //    fire real renew_wake_lease (x2) and signals_seen (x1) concurrently under #general FOR UPDATE.
  const ws2 = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${ws2}::uuid, 'LockHardeningWS2', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${ws2}::uuid, ${owner.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${ws2}::uuid, 'workspace')`;
  });

  const leaseBot = await agentOf(owner.id, "lock-lease-sibling");
  const openCh = await createChannel(owner, "lock-open-ctrl");
  const watcherId = randomUUID();
  const hostId = randomUUID();
  const claimedLease = await send(leaseBot.token, {
    kind: "claim_wake_lease", watcher_id: watcherId, host_label: "lock-test-host", host_id: hostId, take_over: false,
  });
  assert.equal(claimedLease.status, 200, JSON.stringify(claimedLease.body));
  const leaseGeneration = Number(claimedLease.body.generation);

  const seedSig = await send(leaseBot.token, {
    kind: "post_signal", signal_kind: "note", channel: openCh.slug, body: "signal for signals_seen",
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null,
  });
  assert.equal(seedSig.status, 200, JSON.stringify(seedSig.body));
  const seenSignalId = String((seedSig.body.signal as Row).id);

  // Standing-grant agent whose predecessor token is superseded by a used successor.
  const renewPrincipal = randomUUID();
  const renewDevice = randomUUID();
  const renewRun = randomUUID();
  const renewGrant = randomUUID();
  const renewTask = randomUUID();
  const renewLineage = randomUUID();
  const predToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${renewDevice}::uuid, ${owner.id}::uuid, 'renew-lock-test')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${renewPrincipal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, ${`renew-lock-${renewPrincipal.slice(0, 6)}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${renewRun}::uuid, ${renewPrincipal}::uuid, ${renewDevice}::uuid)`;
    await tx`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id, principal_id, run_id, kind, max_successors, successors_used, horizon_expires_at, bound_device_id, created_by)
      VALUES (${renewGrant}::uuid, ${workspace}::uuid, ${renewPrincipal}::uuid, ${renewRun}::uuid, 'standing', NULL, 0, NULL, ${renewDevice}::uuid, ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, task_id, epoch, scopes, token_hash, expires_at, lineage_id, renewal_grant_id)
      VALUES (${randomUUID()}::uuid, ${renewPrincipal}::uuid, ${renewRun}::uuid, ${renewTask}::uuid, 1,
        ${tx.json(["post_signal"])}::jsonb, ${createHash("sha256").update(predToken).digest()},
        statement_timestamp() + interval '1 hour', ${renewLineage}::uuid, ${renewGrant}::uuid)`;
  });
  const firstRenew = await send(predToken, { kind: "renew_agent_token" });
  assert.equal(firstRenew.status, 200, JSON.stringify(firstRenew.body));
  const succToken = String(firstRenew.body.agent_token);
  const useSucc = await send(succToken, {
    kind: "post_signal", signal_kind: "note", channel: openCh.slug, body: "mark successor first_used_at",
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null,
  });
  assert.equal(useSucc.status, 200, JSON.stringify(useSucc.body));

  const revokedCmd = await agentOf(owner.id, "lock-revoked-cmd");
  const revokedAct = await agentOf(owner.id, "lock-revoked-act");
  const revokedAfter = await agentOf(owner.id, "lock-revoked-after");
  for (const ag of [revokedCmd, revokedAct, revokedAfter]) {
    await sql`
      INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
      VALUES (${ag.principal}::uuid, ${ws2}::uuid, ${owner.id}::uuid, ${owner.id}::uuid)
      ON CONFLICT (principal_id, workspace_id) DO NOTHING
    `;
    await sql`UPDATE swarm.agent_tokens SET revoked_at = statement_timestamp() WHERE principal_id = ${ag.principal}::uuid`;
  }

  // Hold an exclusive FOR UPDATE lock on workspace's #general conversation row while firing:
  // - renew_agent_token (predecessor_superseded), which previously held swarm.users FOR NO KEY UPDATE
  //   while waiting up to 5s on #general inside insertAudit,
  // - two concurrent renew_wake_lease commands and one signals_seen command for the SAME owner,
  // - revoked multi-workspace /functions/v1/command and /functions/v1/activity calls.
  let holdReady!: () => void;
  let releaseHold!: () => void;
  const holdStarted = new Promise<void>((r) => { holdReady = r; });
  const allowRelease = new Promise<void>((r) => { releaseHold = r; });

  const generalHold = sql.begin(async (tx) => {
    await tx`
      SELECT conversation_id FROM swarm.conversations
      WHERE workspace_id = ${workspace}::uuid AND kind = 'general'
      FOR UPDATE
    `;
    holdReady();
    await allowRelease;
  });
  await holdStarted;

  const t0 = Date.now();
  const [supersededRes, wakeLease1, wakeLease2, signalsSeenRes, cmdRevokedRes, actRevokedRes] = await Promise.all([
    send(predToken, { kind: "renew_agent_token" }),
    send(leaseBot.token, { kind: "renew_wake_lease", watcher_id: watcherId, generation: leaseGeneration }),
    send(leaseBot.token, { kind: "renew_wake_lease", watcher_id: watcherId, generation: leaseGeneration }),
    send(owner.jwt, { kind: "signals_seen", signal_ids: [seenSignalId] }),
    send(revokedCmd.token, {
      kind: "post_signal", signal_kind: "note", body: "revoked under contention",
      to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null,
    }),
    fetch(`${local.API_URL}/functions/v1/activity`, {
      method: "POST",
      signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${revokedAct.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        workspace_id: workspace,
        stream_id: randomUUID(),
        sequence: 1,
        phase: "prompting",
        signal_id: null,
        tool_title: null,
        elapsed_ms: 0,
      }),
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) as Row })),
  ]);
  const elapsedMs = Date.now() - t0;

  releaseHold();
  await generalHold;

  assert.notEqual(supersededRes.status, 503, `predecessor_superseded must not 503: ${JSON.stringify(supersededRes.body)}`);
  assert.equal(wakeLease1.status, 200, `renew_wake_lease #1 must succeed 200 without 55P03: ${JSON.stringify(wakeLease1.body)}`);
  assert.equal(wakeLease2.status, 200, `renew_wake_lease #2 must succeed 200 without 55P03: ${JSON.stringify(wakeLease2.body)}`);
  assert.equal(signalsSeenRes.status, 200, `signals_seen must succeed 200 without 55P03: ${JSON.stringify(signalsSeenRes.body)}`);
  assert.ok(cmdRevokedRes.status === 401 || cmdRevokedRes.status === 403, `revoked command must refuse cleanly, got ${cmdRevokedRes.status}`);
  assert.equal(actRevokedRes.status, 403, `revoked activity must return 403, got ${actRevokedRes.status}`);
  assert.ok(elapsedMs < 3_000, `post-tx 250ms best-effort alert lock_timeout must prevent 5s stall or hang (took ${elapsedMs}ms)`);

  // Once #general is unlocked, both post-tx local_renewal_superseded and multi-workspace
  // local_credential_revoked alerts record cleanly in swarm.system_alerts.
  const supersededAfter = await send(predToken, { kind: "renew_agent_token" });
  assert.notEqual(supersededAfter.status, 503);
  const renewAlerts = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id::text AS workspace_id
    FROM swarm.system_alerts
    WHERE kind = 'local_renewal_superseded' AND affected_principal_id = ${renewPrincipal}::uuid
  `;
  assert.equal(renewAlerts.length, 1, "post-tx local_renewal_superseded alert must record cleanly once #general is unlocked");

  const afterRes = await send(revokedAfter.token, {
    kind: "post_signal", signal_kind: "note", body: "revoked after unlock",
    to_user_id: null, about: null, to_agent_principal_id: null, in_reply_to: null,
  });
  assert.ok(afterRes.status === 401 || afterRes.status === 403);
  const recorded = await sql<{ workspace_id: string }[]>`
    SELECT workspace_id::text AS workspace_id
    FROM swarm.system_alerts
    WHERE kind = 'local_credential_revoked' AND affected_principal_id = ${revokedAfter.principal}::uuid
    ORDER BY workspace_id ASC
  `;
  assert.deepEqual(
    recorded.map((r) => r.workspace_id),
    [workspace, ws2].sort(),
    "revoked multi-workspace credential must record alerts across both workspaces in deterministic workspace_id ASC order once unlocked",
  );
});
