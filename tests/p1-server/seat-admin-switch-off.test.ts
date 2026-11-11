/**
 * Seat admin with the switch OFF (SWARM_SEAT_ADMIN unset): nothing new can be granted and no agent acts under a grant,
 * but a person can still end a grant they hold, so turning the switch off never traps a live grant. Both status reads
 * report off.
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
import { parseSeatAdminCommand, seatAdminManifest, type GrantSeatAdminCommand } from "../../src/protocol/seat-admin.js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

const ORIGIN = "http://127.0.0.1:4321";
let local: { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let owner: { id: string; jwt: string }, other: { id: string; jwt: string };
let workspace: string, agent: string, agentToken: string;

async function person(label: string): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`, password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  assert.ifError(created.error);
  const client = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const signed = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signed.error);
  return { id: created.data.user!.id, jwt: signed.data.session!.access_token };
}

async function account(bearer: string, command: Record<string, unknown>, opts: { origin?: string | null; commandId?: string } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, "content-type": "application/json" };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers.origin = origin;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, { method: "POST", headers,
    body: JSON.stringify({ command_id: opts.commandId ?? randomUUID(), client_version: "0.1.93", stream: { kind: "account" },
      resource: "https://api.commonswarm.com/admin", command }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

const grantCmd = (patch: Record<string, unknown> = {}) => ({ kind: "grant_seat_admin", principal_id: agent, level: "workspace",
  scope_names: ["role:workspace_admin"], workspace_ids: [workspace], organization_id: null, expires_at: null, ...patch });

async function history(ownerId: string): Promise<Array<{ action: string; outcome: string; reason_code: string | null }>> {
  const rows = await sql<{ e: { payload: { action: string; outcome: string; reason_code: string | null; target_kind: string } } }[]>`
    SELECT event AS e FROM swarm.admin_events WHERE owner_user_id = ${ownerId}::uuid ORDER BY seq`;
  return rows.filter((r) => r.e.payload.target_kind === "seat_admin_grant")
    .map((r) => ({ action: r.e.payload.action, outcome: r.e.payload.outcome, reason_code: r.e.payload.reason_code }));
}

before(async () => {
  local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  sql = postgres(local.DB_URL, { prepare: false, max: 3 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-seat-admin-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, `SWARM_ENV=test\nSWARM_SELF_SERVE=1\nSWARM_COMMAND_ALLOWED_ORIGINS=${ORIGIN}\n`);
  functionProcess = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    { cwd: process.cwd(), env: { ...process.env, SWARM_ENV: "test" }, stdio: ["ignore", "pipe", "pipe"] });
  const cliState = observeFunctionCli(functionProcess);
  const capture = (chunk: Buffer) => { functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000); };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  const deadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > deadline) throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    await delay(250);
  }
  await awaitFunctionRunning({ url: `${local.API_URL}/functions/v1/command`, fetcher: fetch, timeoutMs: 30_000,
    sleep: (ms) => delay(ms), now: () => Date.now(), diagnostics: () => functionLogs.slice(-4000), cliState });

  owner = await person("seat-off-owner");
  other = await person("seat-off-other");
  workspace = randomUUID();
  agent = randomUUID();
  agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const device = randomUUID(), run = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner.id}::uuid, 'SeatOwner'), (${other.id}::uuid, 'SeatOther')`;
    await tx`INSERT INTO swarm.devices (device_id, user_id, label) VALUES (${device}::uuid, ${owner.id}::uuid, 'seat-admin')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${workspace}::uuid, 'SeatAdmin', ${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner'), (${workspace}::uuid, ${other.id}::uuid, 'member')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${agent}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'seat-admin-agent')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id) VALUES (${run}::uuid, ${agent}::uuid, ${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${agent}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    functionProcess.kill("SIGTERM");
    await Promise.race([new Promise((r) => functionProcess.once("close", r)), delay(2_000)]);
    if (functionProcess.exitCode === null) functionProcess.kill("SIGKILL");
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});


test("switch off: a person ends their own grant; granting, agent actions and both status reads are off", async () => {
  // A grant made while the switch was on, written directly (the grant command is off here).
  const command = parseSeatAdminCommand(grantCmd()) as GrantSeatAdminCommand;
  const manifest = seatAdminManifest(command);
  const grantId = randomUUID();
  await sql`INSERT INTO swarm.seat_admin_grants (grant_id, owner_user_id, principal_id, level, organization_id, registry_version,
      scope_names, workspace_ids, manifest, manifest_digest, expires_at)
    VALUES (${grantId}::uuid, ${owner.id}::uuid, ${agent}::uuid, 'workspace', NULL, 3, ${command.scope_names}::text[],
      ${command.workspace_ids}::uuid[], ${sql.json(manifest as unknown as postgres.JSONValue)}, ${"0".repeat(64)}, NULL)`;

  const granted = await account(owner.jwt, grantCmd());
  assert.equal(granted.status, 404, JSON.stringify(granted.body) + functionLogs.slice(-1500));
  assert.equal(granted.body.error, "seat_admin_unavailable");

  const read = async (bearer: string, body: Record<string, unknown>) => {
    const response = await fetch(`${local.API_URL}/functions/v1/read`, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const self = await read(agentToken, { resource: "seat_admin_self", workspace_id: workspace });
  assert.equal(self.status, 200, JSON.stringify(self.body));
  assert.deepEqual(self.body, { enabled: false });
  const status = await read(owner.jwt, { resource: "seat_admin_status" });
  assert.deepEqual([status.status, status.body], [200, { enabled: false }]);
  assert.equal((await read(owner.jwt, { resource: "seat_admin_self", workspace_id: workspace })).status, 401, "a person cannot use the agent read");

  const agentRename = await fetch(`${local.API_URL}/functions/v1/command`, { method: "POST",
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), client_version: "0.1.93", workspace_id: workspace, stream: { kind: "workspace" },
      command: { kind: "rename_workspace", name: "Off" } }) });
  assert.equal(agentRename.status, 403, "the active grant gives the agent nothing while the switch is off");
  assert.equal((await agentRename.json() as { error: string }).error, "forbidden");

  const outsider = await account(other.jwt, { kind: "end_seat_admin", grant_id: grantId });
  assert.equal(outsider.status, 404, "only the grant's owner can end it");
  const noOrigin = await account(owner.jwt, { kind: "end_seat_admin", grant_id: grantId }, { origin: null });
  assert.equal(noOrigin.status, 401, "ending still needs the same-site confirmation");
  const ended = await account(owner.jwt, { kind: "end_seat_admin", grant_id: grantId });
  assert.equal(ended.status, 200, JSON.stringify(ended.body) + functionLogs.slice(-1500));
  assert.equal((ended.body.seat_admin_grant as { state: string }).state, "downgraded");
  const [{ state }] = await sql<{ state: string }[]>`SELECT state FROM swarm.seat_admin_grants WHERE grant_id = ${grantId}::uuid`;
  assert.equal(state, "downgraded");
});
