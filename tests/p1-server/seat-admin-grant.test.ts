/**
 * Seat admin, PR 2a: a person grants or ends admin powers on their own agent's seat through the
 * command edge (account stream), with SWARM_SEAT_ADMIN on. Agents can't use a grant yet.
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
  writeFileSync(envFile, `SWARM_ENV=test\nSWARM_SELF_SERVE=1\nSWARM_SEAT_ADMIN=1\nSWARM_COMMAND_ALLOWED_ORIGINS=${ORIGIN}\n`);
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

  owner = await person("seat-admin-owner");
  other = await person("seat-admin-other");
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

test("refusals: only the owner's fresh, same-site confirmation grants; each refusal is recorded", async () => {
  for (const [name, bearer, command, origin, status, error] of [
    ["no Origin (CSRF)", () => owner.jwt, grantCmd(), null, 401, "human_confirmation_required"],
    ["another person, for someone else's agent", () => other.jwt, grantCmd(), ORIGIN, 403, "agent_not_yours"],
    ["the agent itself", () => agentToken, grantCmd(), ORIGIN, 403, "credential_kind_forbidden"],
    ["workspace level in two workspaces", () => owner.jwt, grantCmd({ workspace_ids: [workspace, randomUUID()].sort() }), ORIGIN, 400, "invalid_request"],
    ["scoped with delegation", () => owner.jwt, grantCmd({ level: "scoped", scope_names: ["admin:delegate", "admin:read"] }), ORIGIN, 400, "scope_forbidden"],
    ["a malformed command", () => owner.jwt, { ...grantCmd(), extra: true }, ORIGIN, 400, "invalid_request"],
  ] as const) {
    const result = await account(bearer(), command, { origin });
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}\n${functionLogs.slice(-1500)}`);
    assert.equal(result.body.error, error, name);
  }
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.seat_admin_grants WHERE principal_id = ${agent}::uuid`;
  assert.equal(n, 0, "no refusal wrote a grant");
  assert.deepEqual((await history(owner.id)).map((h) => [h.outcome, h.reason_code]), [
    ["refused", "human_confirmation_required"], ["refused", "invalid_request"], ["refused", "scope_forbidden"],
  ], "each of the owner's refused attempts is in their history; the malformed one never parsed");
});

test("grant, replay, a second grant, end by an outsider, end, end again: every step is the grant's current state", async () => {
  const grantId = randomUUID();
  const granted = await account(owner.jwt, grantCmd(), { commandId: grantId });
  assert.equal(granted.status, 200, JSON.stringify(granted.body) + functionLogs.slice(-1500));
  const grant = granted.body.seat_admin_grant as { grant_id: string; state: string; expires_at: string | null; capability_names: string[] };
  assert.equal(grant.state, "active");
  assert.equal(grant.expires_at, null, "No end date");
  assert.ok(grant.capability_names.includes("rename_workspace") && !grant.capability_names.includes("create_workspace"));
  const [row] = await sql<{ level: string; manifest: { registry_version: number } }[]>`SELECT level, manifest FROM swarm.seat_admin_grants
    WHERE grant_id = ${grant.grant_id}::uuid`;
  assert.deepEqual([row!.level, row!.manifest.registry_version], ["workspace", 3]);

  const twice = await account(owner.jwt, grantCmd());
  assert.equal(twice.status, 409);
  assert.equal(twice.body.error, "seat_admin_exists");

  const outsider = await account(other.jwt, { kind: "end_seat_admin", grant_id: grant.grant_id });
  assert.equal(outsider.status, 404, "a member who doesn't own the workspace learns nothing");
  const noOrigin = await account(owner.jwt, { kind: "end_seat_admin", grant_id: grant.grant_id }, { origin: null });
  assert.equal(noOrigin.status, 401);

  const ended = await account(owner.jwt, { kind: "end_seat_admin", grant_id: grant.grant_id });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  assert.equal((ended.body.seat_admin_grant as { state: string }).state, "downgraded");
  const again = await account(owner.jwt, { kind: "end_seat_admin", grant_id: grant.grant_id });
  assert.equal((again.body.seat_admin_grant as { state: string }).state, "downgraded", "ending twice is idempotent");

  const replay = await account(owner.jwt, grantCmd(), { commandId: grantId });
  assert.equal(replay.status, 200);
  assert.equal((replay.body.seat_admin_grant as { state: string }).state, "downgraded", "a replay shows the grant now, not the stored success");
  const changed = await account(owner.jwt, grantCmd({ expires_at: Date.now() + 86_400_000 }), { commandId: grantId });
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "command_id_conflict");

  const regrant = await account(owner.jwt, grantCmd({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [],
    organization_id: workspace }));
  assert.equal(regrant.status, 200, `the organization role: ${JSON.stringify(regrant.body)}`);
  assert.deepEqual((await history(owner.id)).filter((h) => h.outcome === "accepted").map((h) => h.action),
    ["grant_seat_admin", "end_seat_admin", "grant_seat_admin"]);
});
