/**
 * Seat admin, PR 2b: an agent uses its grant for workspace commands (SWARM_SEAT_ADMIN on). One covering grant,
 * re-decided under lock on every call and replay; targets protected; the agent is the actor and the grant and its
 * grantor are named in the audit and the grantor's history, in the same transaction as the action.
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
let workspace: string, agent: string, agentToken: string, sibling: string, foreign: string;

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

  owner = await person("seat-agent-owner");
  other = await person("seat-agent-other");
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
    sibling = randomUUID(); foreign = randomUUID();
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${sibling}::uuid, ${workspace}::uuid, ${owner.id}::uuid, 'sibling-agent'), (${foreign}::uuid, ${workspace}::uuid, ${other.id}::uuid, 'foreign-agent')`;
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


async function agentCommand(command: Record<string, unknown>, opts: { commandId?: string } = {}) {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, { method: "POST",
    headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
    body: JSON.stringify({ command_id: opts.commandId ?? randomUUID(), client_version: "0.1.93", workspace_id: workspace,
      stream: { kind: "workspace" }, command }) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
async function grant(patch: Record<string, unknown> = {}): Promise<string> {
  const granted = await account(owner.jwt, grantCmd(patch));
  assert.equal(granted.status, 200, JSON.stringify(granted.body) + functionLogs.slice(-1500));
  return (granted.body.seat_admin_grant as { grant_id: string }).grant_id;
}
async function endGrant(id: string) {
  const ended = await account(owner.jwt, { kind: "end_seat_admin", grant_id: id });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
}
async function agentHistory() {
  const rows = await sql<{ e: { actor_agent_principal: string | null; payload: Record<string, unknown> } }[]>`
    SELECT event AS e FROM swarm.admin_events WHERE owner_user_id = ${owner.id}::uuid ORDER BY seq`;
  return rows.filter((r) => r.e.payload.seat_admin_grant_id !== undefined)
    .map((r) => ({ actor: r.e.actor_agent_principal, ...r.e.payload } as { actor: string | null; [key: string]: unknown }));
}
const refused = (r: { status: number; body: Record<string, unknown> }, error: string, name: string) => {
  assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}\n${functionLogs.slice(-1500)}`);
  assert.equal(r.body.error, error, name);
};

test("no grant: every one of the six refuses as inactive; other human-only commands stay forbidden", async () => {
  refused(await agentCommand({ kind: "rename_workspace", name: "Nope" }), "seat_admin_inactive", "rename without a grant");
  refused(await agentCommand({ kind: "set_workspace_lead", principal_id: sibling }), "seat_admin_inactive", "lead without a grant");
  const archive = await agentCommand({ kind: "archive_workspace" });
  assert.equal(archive.status, 403);
  assert.equal(archive.body.error, "forbidden", "a human-only command outside the six is refused exactly as before");
});

test("a workspace grant: rename, lead and agent membership run as the agent, attributed to the grant and its grantor", async () => {
  const grantId = await grant();
  const renamed = await agentCommand({ kind: "rename_workspace", name: "Renamed by agent" });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body) + functionLogs.slice(-2000));
  const [{ name }] = await sql<{ name: string }[]>`SELECT name FROM swarm.workspaces WHERE workspace_id = ${workspace}::uuid`;
  assert.equal(name, "Renamed by agent");
  const [event] = await sql<{ actor_agent_principal: string }[]>`SELECT actor_agent_principal FROM swarm.events
    WHERE workspace_id = ${workspace}::uuid AND type = 'WorkspaceRenamed' ORDER BY seq DESC LIMIT 1`;
  assert.equal(event!.actor_agent_principal, agent, "the event's actor is the agent");
  const [audit] = await sql<{ actor_agent_principal: string; detail: string }[]>`SELECT actor_agent_principal, detail FROM swarm.audit_log
    WHERE command_kind = 'rename_workspace' AND workspace_id = ${workspace}::uuid AND outcome = 'accepted' ORDER BY created_at DESC LIMIT 1`;
  assert.equal(audit!.actor_agent_principal, agent);
  assert.match(audit!.detail, new RegExp(`seat_admin grant=${grantId} level=workspace authorizing_user=${owner.id}`));

  const lead = await agentCommand({ kind: "set_workspace_lead", principal_id: sibling });
  assert.equal(lead.status, 200, JSON.stringify(lead.body) + functionLogs.slice(-2000));
  const removed = await agentCommand({ kind: "remove_agent_from_workspace", principal_id: sibling });
  assert.equal(removed.status, 200, JSON.stringify(removed.body) + functionLogs.slice(-2000));
  const added = await agentCommand({ kind: "add_agent_to_workspace", principal_id: sibling });
  assert.equal(added.status, 200, JSON.stringify(added.body) + functionLogs.slice(-2000));

  const actions = await agentHistory();
  assert.deepEqual(actions.filter((a) => a.outcome === "accepted").map((a) => a.action),
    ["rename_workspace", "set_workspace_lead", "remove_agent_from_workspace", "add_agent_to_workspace"]);
  for (const a of actions) {
    assert.equal(a.actor, agent);
    assert.equal(a.seat_admin_grant_id, grantId);
    assert.equal(a.authorizing_user_id, owner.id);
    assert.equal(a.acting_agent_principal_id, agent);
  }
  await endGrant(grantId);
});

test("targets: never itself, never another person's agent, never an agent with admin access", async () => {
  const grantId = await grant();
  refused(await agentCommand({ kind: "set_workspace_lead", principal_id: agent }), "seat_admin_target_protected", "lead: itself");
  refused(await agentCommand({ kind: "remove_agent_from_workspace", principal_id: agent }), "seat_admin_target_protected", "remove: itself");
  refused(await agentCommand({ kind: "remove_agent_from_workspace", principal_id: foreign }), "seat_admin_target_protected", "remove: someone else's agent");
  refused(await agentCommand({ kind: "set_workspace_lead", principal_id: foreign }), "seat_admin_target_protected", "lead: someone else's agent");
  // The sibling gets admin access of its own: it is now protected too.
  const siblingGrant = await account(owner.jwt, grantCmd({ principal_id: sibling }));
  assert.equal(siblingGrant.status, 200, JSON.stringify(siblingGrant.body));
  refused(await agentCommand({ kind: "remove_agent_from_workspace", principal_id: sibling }), "seat_admin_target_protected", "remove: an admin agent");
  await endGrant((siblingGrant.body.seat_admin_grant as { grant_id: string }).grant_id);
  // remove_member and change_role do not run under a grant in this slice.
  refused(await agentCommand({ kind: "remove_member", user_id: other.id }), "seat_admin_scope_missing", "remove_member");
  refused(await agentCommand({ kind: "change_role", user_id: other.id, role: "admin" }), "seat_admin_target_protected", "change_role");
  const [{ live }] = await sql<{ live: boolean }[]>`SELECT revoked_at IS NULL AS live FROM swarm.memberships
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${other.id}::uuid`;
  assert.equal(live, true, "the member is untouched");
  await endGrant(grantId);
});

test("live authority: an ended grant refuses the next call and a replay; a scoped grant without the command refuses", async () => {
  const grantId = await grant();
  const commandId = randomUUID();
  const first = await agentCommand({ kind: "rename_workspace", name: "Before end" }, { commandId });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  await endGrant(grantId);
  refused(await agentCommand({ kind: "rename_workspace", name: "After end" }), "seat_admin_inactive", "after end");
  refused(await agentCommand({ kind: "rename_workspace", name: "Before end" }, { commandId }), "seat_admin_inactive", "replay after end");

  const scoped = await grant({ level: "scoped", scope_names: ["admin:read"] });
  refused(await agentCommand({ kind: "set_workspace_lead", principal_id: sibling }), "seat_admin_scope_missing", "scoped without the command");
  await endGrant(scoped);
});

test("the grantor stops owning the workspace: the grant no longer covers it", async () => {
  const grantId = await grant();
  await sql`UPDATE swarm.memberships SET role = 'admin' WHERE workspace_id = ${workspace}::uuid AND user_id = ${owner.id}::uuid`;
  try {
    refused(await agentCommand({ kind: "rename_workspace", name: "Not owner" }), "seat_admin_workspace_not_covered", "grantor demoted");
  } finally {
    await sql`UPDATE swarm.memberships SET role = 'owner' WHERE workspace_id = ${workspace}::uuid AND user_id = ${owner.id}::uuid`;
  }
  await endGrant(grantId);
});
