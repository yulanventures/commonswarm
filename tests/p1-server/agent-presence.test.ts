/** G3d per-seat presence against the served command/read edges. */
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
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  otherWorkspace: string;
  otherOwnerId: string;
  device: string;
  principal: string;
  token: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let fixture: Fixture;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;

function localEnvironment(): LocalEnvironment {
  const parsed = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  })) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY);
  return parsed as LocalEnvironment;
}

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
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
  commandBody: Record<string, unknown>,
  options: {
    commandId?: string;
    clientBuild?: unknown;
    workspace?: string;
  } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const envelope: Record<string, unknown> = {
    command_id: options.commandId ?? randomUUID(),
    client_version: "0.1.0",
    workspace_id: options.workspace ?? fixture.workspace,
    stream: { kind: "workspace" },
    command: commandBody,
  };
  if (Object.hasOwn(options, "clientBuild")) envelope.client_build = options.clientBuild;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

function note(body = `presence-${randomUUID()}`): Record<string, unknown> {
  return { kind: "post_signal", signal_kind: "note", body, to_user_id: null, about: null };
}

async function ask(): Promise<string> {
  const sent = await command(fixture.ownerJwt, {
    kind: "post_signal",
    signal_kind: "ask",
    body: `presence-ask-${randomUUID()}`,
    to_user_id: null,
    to_agent_principal_id: fixture.principal,
    in_reply_to: null,
    about: null,
  });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  const id = (sent.body.signal as { id?: unknown } | undefined)?.id;
  assert.equal(typeof id, "string");
  return id as string;
}

async function presence() {
  const [row] = await sql<{
    last_command_at: Date;
    client_build: string | null;
    watcher_at: Date | null;
    channel_at: Date | null;
    listener_at: Date | null;
    turn_at: Date | null;
  }[]>`
    SELECT last_command_at, client_build, watcher_at, channel_at, listener_at, turn_at
    FROM swarm.agent_presence
    WHERE workspace_id = ${fixture.workspace}::uuid
      AND principal_id = ${fixture.principal}::uuid
  `;
  assert.ok(row);
  return row;
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const owner = await createUser("presence-owner");
  const other = await createUser("presence-other");
  const workspace = randomUUID();
  const otherWorkspace = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    for (const user of [owner, other]) {
      await tx`INSERT INTO swarm.users (user_id, display_name)
        VALUES (${user.id}::uuid, ${`Presence ${user.id.slice(0, 8)}`})`;
    }
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'presence-device')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES
      (${workspace}::uuid, 'Presence A', ${owner.id}::uuid),
      (${otherWorkspace}::uuid, 'Presence B', ${other.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES
      (${workspace}::uuid, ${owner.id}::uuid, 'owner'),
      (${otherWorkspace}::uuid, ${other.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES
      (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace'),
      (${randomUUID()}::uuid, ${otherWorkspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals
      (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'Presence seat')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens
      (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  fixture = {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherWorkspace,
    otherOwnerId: other.id,
    device,
    principal,
    token,
  };

  envDir = mkdtempSync(join(tmpdir(), "cswarm-agent-presence-edge-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n", { mode: 0o600 });
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    { cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    await delay(250);
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => functionProcess.once("close", () => resolve(true)));
    functionProcess.kill();
    if (!await Promise.race([exited, delay(2_000).then(() => false)]) && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

test("watcher, turn, channel, and listener routes remain independent", async () => {
  const watcher = randomUUID();
  const host = randomUUID();
  const claimed = await command(fixture.token, {
    kind: "claim_wake_lease", watcher_id: watcher, host_label: "presence-host",
    host_id: host, take_over: false,
  }, { clientBuild: "0.1.77" });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const generation = Number(claimed.body.generation);
  const afterClaim = await presence();
  assert.ok(afterClaim.watcher_at);
  assert.equal(afterClaim.client_build, "0.1.77");

  await delay(20);
  const touched = await command(fixture.token, { kind: "touch_presence" });
  assert.deepEqual(touched, { status: 200, body: { ok: true } });
  const afterTouch = await presence();
  assert.ok(afterTouch.turn_at);
  assert.equal(afterTouch.watcher_at?.toISOString(), afterClaim.watcher_at?.toISOString());

  await delay(20);
  const renewed = await command(fixture.token, {
    kind: "renew_wake_lease", watcher_id: watcher, generation,
  });
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const afterRenew = await presence();
  assert.ok(afterRenew.watcher_at && afterRenew.watcher_at >= afterClaim.watcher_at!);
  assert.equal(afterRenew.turn_at?.toISOString(), afterTouch.turn_at?.toISOString());

  const channel = await command(fixture.token, {
    kind: "claim_agent_inbox", listener_instance_id: randomUUID(), limit: 1, route: "channel",
  });
  assert.equal(channel.status, 200, JSON.stringify(channel.body));
  assert.ok((await presence()).channel_at);
  const listener = await command(fixture.token, {
    kind: "claim_agent_inbox", listener_instance_id: randomUUID(), limit: 1, route: "listener",
  });
  assert.equal(listener.status, 200, JSON.stringify(listener.body));
  assert.ok((await presence()).listener_at);
});

test("route is refused everywhere except the two claim_agent_inbox values", async () => {
  for (const commandBody of [
    { kind: "claim_agent_inbox", listener_instance_id: randomUUID(), limit: 1, route: "worker" },
    { ...note(), route: "channel" },
  ]) {
    const result = await command(fixture.token, commandBody);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "route_not_allowed" });
  }
});

test("touch_presence reserves and replays its command id", async () => {
  const occupiedId = randomUUID();
  const ordinary = await command(fixture.token, note(), { commandId: occupiedId });
  assert.equal(ordinary.status, 200, JSON.stringify(ordinary.body));
  const beforeConflict = await presence();
  const conflict = await command(fixture.token, { kind: "touch_presence" }, {
    commandId: occupiedId,
  });
  assert.deepEqual(conflict, {
    status: 409,
    body: { error: "command_id_conflict" },
  });
  assert.equal(
    (await presence()).turn_at?.toISOString(),
    beforeConflict.turn_at?.toISOString(),
  );

  const touchId = randomUUID();
  const fresh = await command(fixture.token, { kind: "touch_presence" }, {
    commandId: touchId,
  });
  assert.deepEqual(fresh, { status: 200, body: { ok: true } });
  const [ledger] = await sql<{ response: unknown }[]>`
    SELECT response
    FROM swarm.idempotency_keys
    WHERE principal_kind = 'agent'
      AND principal_id = ${fixture.principal}
      AND command_id = ${touchId}
  `;
  assert.deepEqual(ledger?.response, { ok: true });
  assert.deepEqual(
    await command(fixture.token, { kind: "touch_presence" }, { commandId: touchId }),
    { status: 200, body: { ok: true } },
  );
  const reverseConflict = await command(fixture.token, note(), { commandId: touchId });
  assert.deepEqual(reverseConflict, {
    status: 409,
    body: { error: "command_id_conflict" },
  });
});

test("ordinary commands throttle last_command_at and replays still update build", async () => {
  const commandId = randomUUID();
  const first = await command(fixture.token, note(), { commandId, clientBuild: "0.1.70" });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstPresence = await presence();
  const replay = await command(fixture.token, note("different body is not the replay"), {
    commandId: randomUUID(), clientBuild: "0.1.71",
  });
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  const throttled = await presence();
  assert.equal(throttled.last_command_at.toISOString(), firstPresence.last_command_at.toISOString());
  assert.equal(throttled.client_build, "0.1.71");

  const replayId = randomUUID();
  const replayBody = note();
  assert.equal((await command(fixture.token, replayBody, { commandId: replayId, clientBuild: "0.1.72" })).status, 200);
  const beforeReplay = await presence();
  assert.equal((await command(fixture.token, replayBody, { commandId: replayId, clientBuild: "0.1.73" })).status, 200);
  const afterReplay = await presence();
  assert.equal(afterReplay.last_command_at.toISOString(), beforeReplay.last_command_at.toISOString());
  assert.equal(afterReplay.client_build, "0.1.73");

  await sql`UPDATE swarm.agent_presence SET last_command_at = statement_timestamp() - interval '61 seconds'
    WHERE workspace_id = ${fixture.workspace}::uuid AND principal_id = ${fixture.principal}::uuid`;
  const stale = await presence();
  assert.equal((await command(fixture.token, note())).status, 200);
  assert.ok((await presence()).last_command_at > stale.last_command_at);
});

test("malformed client builds become NULL without refusing the command", async () => {
  for (const clientBuild of ["not-semver", `1.0.0-${"a".repeat(59)}`]) {
    if (clientBuild !== "not-semver") assert.equal(clientBuild.length, 65);
    const result = await command(fixture.token, note(), { clientBuild });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await presence()).client_build, null);
  }
});

test("leased and unclaimed ACK routes are derived once", async () => {
  const leasedSignal = await ask();
  const listener = randomUUID();
  const claimed = await command(fixture.token, {
    kind: "claim_agent_inbox", listener_instance_id: listener, limit: 10, route: "channel",
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  const delivery = (claimed.body.deliveries as Array<{ signal: { id: string }; lease_id: string }>)
    .find((row) => row.signal.id === leasedSignal);
  assert.ok(delivery);
  const leasedAck = await command(fixture.token, {
    kind: "ack_agent_delivery", signal_id: leasedSignal, lease_id: delivery.lease_id,
    listener_instance_id: listener, outcome: "queued", last_error_code: null,
  });
  assert.equal(leasedAck.status, 200, JSON.stringify(leasedAck.body));
  let [leasedRow] = await sql<{ ack_via: string }[]>`
    SELECT ack_via FROM swarm.signal_deliveries
    WHERE signal_id = ${leasedSignal}::uuid AND recipient_agent_principal_id = ${fixture.principal}::uuid`;
  assert.equal(leasedRow?.ack_via, "leased");

  // Simulate a queued ACK written by the pre-G3d edge. Its persisted lease
  // provenance must win over the later body-free observed follow-up.
  await sql`UPDATE swarm.signal_deliveries SET ack_via = NULL
    WHERE signal_id = ${leasedSignal}::uuid
      AND recipient_agent_principal_id = ${fixture.principal}::uuid`;

  const later = await command(fixture.token, {
    kind: "ack_agent_delivery", signal_id: leasedSignal, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
  });
  assert.equal(later.status, 200, JSON.stringify(later.body));
  [leasedRow] = await sql<{ ack_via: string }[]>`
    SELECT ack_via FROM swarm.signal_deliveries
    WHERE signal_id = ${leasedSignal}::uuid AND recipient_agent_principal_id = ${fixture.principal}::uuid`;
  assert.equal(leasedRow?.ack_via, "leased");

  const unclaimedSignal = await ask();
  const unclaimed = await command(fixture.token, {
    kind: "ack_agent_delivery", signal_id: unclaimedSignal, lease_id: null,
    listener_instance_id: null, outcome: "observed", last_error_code: null,
    surfaced: true, unclaimed: true,
  });
  assert.equal(unclaimed.status, 200, JSON.stringify(unclaimed.body));
  const [unclaimedRow] = await sql<{ ack_via: string }[]>`
    SELECT ack_via FROM swarm.signal_deliveries
    WHERE signal_id = ${unclaimedSignal}::uuid AND recipient_agent_principal_id = ${fixture.principal}::uuid`;
  assert.equal(unclaimedRow?.ack_via, "unclaimed");
});

test("human commands create no presence and the member view is tenant scoped", async () => {
  const before = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.agent_presence`;
  assert.equal((await command(fixture.ownerJwt, note())).status, 200);
  const afterHuman = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm.agent_presence`;
  assert.equal(afterHuman[0]?.count, before[0]?.count);

  const ownVisible = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: fixture.ownerId, role: "authenticated" })}, true)`;
    return await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm_read.agent_presence
      WHERE workspace_id = ${fixture.workspace}::uuid AND principal_id = ${fixture.principal}::uuid`;
  });
  assert.equal(ownVisible[0]?.count, 1);
  const crossVisible = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: fixture.otherOwnerId, role: "authenticated" })}, true)`;
    return await tx<{ count: number }[]>`SELECT count(*)::int AS count FROM swarm_read.agent_presence
      WHERE workspace_id = ${fixture.workspace}::uuid`;
  });
  assert.equal(crossVisible[0]?.count, 0);
  await assert.rejects(sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT * FROM swarm.agent_presence LIMIT 1`;
  }), /permission denied/);
});

test("the functional proof uses production psql shape and has a negative control", async () => {
  const seeded = await command(fixture.token, { kind: "touch_presence" });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const proof = readFileSync(fileURLToPath(new URL(
    "../../deploy/release-proofs/item-g3d/20260927000002-functional.sql",
    import.meta.url,
  )), "utf8");
  const containers = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" })
    .trim().split("\n").filter((name) => /^supabase_db_/.test(name));
  assert.equal(containers.length, 1);
  const args = [
    "exec", "-i", containers[0]!, "psql", "-X", "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1",
    "-v", `item_g3d_principal_id=${fixture.principal}`,
    "-v", `item_g3d_workspace_id=${fixture.workspace}`,
    "--file", "-",
  ];
  const run = spawnSync("docker", args, { input: proof, encoding: "utf8", timeout: 10_000 });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim().split("\n").at(-1), "t");
  const negativeArgs = [...args];
  negativeArgs[negativeArgs.indexOf(`item_g3d_principal_id=${fixture.principal}`)] =
    `item_g3d_principal_id=${randomUUID()}`;
  const negative = spawnSync("docker", negativeArgs, { input: proof, encoding: "utf8", timeout: 10_000 });
  assert.ifError(negative.error);
  assert.notEqual(negative.status, 0);
  assert.notEqual(negative.stdout.trim().split("\n").at(-1), "t");
});

test("a revoked agent is refused without changing presence", async () => {
  const before = await presence();
  await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
    WHERE workspace_id = ${fixture.workspace}::uuid AND principal_id = ${fixture.principal}::uuid`;
  const refused = await command(fixture.token, { kind: "touch_presence" });
  assert.notEqual(refused.status, 200);
  const after = await presence();
  assert.equal(after.last_command_at.toISOString(), before.last_command_at.toISOString());
  assert.equal(after.turn_at?.toISOString(), before.turn_at?.toISOString());
});
