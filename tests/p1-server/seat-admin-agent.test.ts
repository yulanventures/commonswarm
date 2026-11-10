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
import { after, afterEach, before, test } from "node:test";
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
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')`;
    // The workspace stream with its history: the reducer rebuilds the workspace from events, never from rows.
    const streamId = randomUUID();
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${streamId}::uuid, ${workspace}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.events (workspace_id, stream_id, seq, event_id, command_id, type, schema_version, actor_user, payload)
      VALUES (${workspace}::uuid, ${streamId}::uuid, 1, ${randomUUID()}::uuid, ${randomUUID()}, 'WorkspaceCreated', 1, ${owner.id}::uuid,
        ${tx.json({ workspace_id: workspace, name: "SeatAdmin", created_by: owner.id, created_at: Date.now() })})`;
    await tx`UPDATE swarm.streams SET head_seq = 1 WHERE stream_id = ${streamId}::uuid`;
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
  await joinWorkspace(other.id, "member");
});

/** A person joins the workspace: the membership row and its MemberJoined event, as the command path writes both. */
async function joinWorkspace(userId: string, role: "member" | "admin") {
  await sql.begin(async (tx) => {
    const [stream] = await tx<{ stream_id: string; head_seq: string }[]>`SELECT stream_id, head_seq FROM swarm.streams
      WHERE workspace_id = ${workspace}::uuid AND kind = 'workspace' FOR UPDATE`;
    const seq = Number(stream!.head_seq) + 1;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${workspace}::uuid, ${userId}::uuid, ${role})`;
    await tx`INSERT INTO swarm.events (workspace_id, stream_id, seq, event_id, command_id, type, schema_version, actor_user, payload)
      VALUES (${workspace}::uuid, ${stream!.stream_id}::uuid, ${seq}, ${randomUUID()}::uuid, ${randomUUID()}, 'MemberJoined', 1, ${owner.id}::uuid,
        ${tx.json({ user_id: userId, role, invited_by: owner.id, joined_at: Date.now() })})`;
    await tx`UPDATE swarm.streams SET head_seq = ${seq} WHERE stream_id = ${stream!.stream_id}::uuid`;
  });
}

// One test's failure never leaves a grant active for the next.
afterEach(async () => {
  await sql`UPDATE swarm.seat_admin_grants SET state = 'downgraded', ended_at = clock_timestamp(), end_reason = 'owner_downgrade'
    WHERE owner_user_id = ${owner.id}::uuid AND state = 'active'`;
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
  refused(await agentCommand({ kind: "rename_organization", display_name: "Nope" }), "seat_admin_inactive", "organization rename without a grant");
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
    WHERE command_kind = 'rename_workspace' AND workspace_id = ${workspace}::uuid AND outcome = 'accepted' ORDER BY audit_id DESC LIMIT 1`;
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
  // Never an owner (the grantor included); change_role never runs under a grant.
  refused(await agentCommand({ kind: "remove_member", user_id: owner.id }), "seat_admin_target_protected", "remove_member: the owner");
  refused(await agentCommand({ kind: "change_role", user_id: other.id, role: "admin" }), "seat_admin_target_protected", "change_role");
  const [{ live }] = await sql<{ live: boolean }[]>`SELECT revoked_at IS NULL AS live FROM swarm.memberships
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${other.id}::uuid`;
  assert.equal(live, true, "the member is untouched");
  // Refusals survive the business rollback: each is in the audit log and the grantor's history, under this grant.
  const refusedHistory = (await agentHistory()).filter((h) => h.outcome === "refused" && h.seat_admin_grant_id === grantId);
  assert.deepEqual(refusedHistory.map((h) => [h.action, h.reason_code]), [
    ["set_workspace_lead", "seat_admin_target_protected"], ["remove_agent_from_workspace", "seat_admin_target_protected"],
    ["remove_agent_from_workspace", "seat_admin_target_protected"], ["set_workspace_lead", "seat_admin_target_protected"],
    ["remove_agent_from_workspace", "seat_admin_target_protected"],
    ["remove_member", "seat_admin_target_protected"], ["change_role", "seat_admin_target_protected"],
  ]);
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.audit_log WHERE workspace_id = ${workspace}::uuid
    AND outcome = 'authz' AND actor_agent_principal = ${agent}::uuid AND detail LIKE ${`%seat_admin grant=${grantId}%`}`;
  assert.equal(n, 7, "each refusal has its audit row naming the grant");
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

test("a grant that expires while the organization lookup waits refuses and changes nothing", async () => {
  const grantId = await grant({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: workspace,
    expires_at: Date.now() + 86_400_000 });
  // Shorten the end date below the lock wait. The grant trigger forbids this edit; bypass it in the fixture only.
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE swarm.seat_admin_grants SET expires_at = clock_timestamp() + interval '2 seconds' WHERE grant_id = ${grantId}::uuid`;
  });
  const [{ before }] = await sql<{ before: string }[]>`SELECT name AS before FROM swarm.workspaces WHERE workspace_id = ${workspace}::uuid`;
  let pending: ReturnType<typeof agentCommand> | undefined;
  await sql.begin(async (tx) => {
    // seat_admin_org_owner takes the organization row FOR SHARE: hold it past the grant's end.
    await tx`SELECT id FROM swarm.organizations WHERE id = ${workspace}::uuid FOR UPDATE`;
    pending = agentCommand({ kind: "rename_workspace", name: "Renamed after expiry" });
    await delay(4_000);
  });
  refused(await pending!, "seat_admin_inactive", "expired during the organization lock wait");
  const [{ after }] = await sql<{ after: string }[]>`SELECT name AS after FROM swarm.workspaces WHERE workspace_id = ${workspace}::uuid`;
  assert.equal(after, before, "no change");
  const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.events
    WHERE workspace_id = ${workspace}::uuid AND type = 'WorkspaceRenamed' AND payload->>'name' = 'Renamed after expiry'`;
  assert.equal(n, 0);
});

test("remove a member: membership, their agents and household access end, attributed to the agent and the grantor", async () => {
  const member = await person("seat-agent-member"), adminPerson = await person("seat-agent-admin");
  const memberAgent = randomUUID();
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${member.id}::uuid, 'SeatMember'), (${adminPerson.id}::uuid, 'SeatAdminPerson')`;
  await joinWorkspace(member.id, "member");
  await joinWorkspace(adminPerson.id, "admin");
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${memberAgent}::uuid, ${workspace}::uuid, ${member.id}::uuid, 'member-agent')`;
    await tx`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
      VALUES (${workspace}::uuid, ${member.id}::uuid, 'reader', ${randomUUID()}::uuid, now())`;
  });
  const grantId = await grant();
  refused(await agentCommand({ kind: "remove_member", user_id: adminPerson.id }), "seat_admin_target_protected", "an admin");

  // The member's own agent is an admin agent in another workspace the member owns: removing the member would remove
  // it from this one, so the removal refuses and nothing changes.
  const elsewhere = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${elsewhere}::uuid, 'MemberOwned', ${member.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${elsewhere}::uuid, ${member.id}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.streams (stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${elsewhere}::uuid, 'workspace')`;
    await tx`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
      VALUES (${memberAgent}::uuid, ${elsewhere}::uuid, ${member.id}::uuid, ${member.id}::uuid)`;
  });
  const memberGrant = await account(member.jwt, grantCmd({ principal_id: memberAgent, workspace_ids: [elsewhere] }));
  assert.equal(memberGrant.status, 200, `the member's own grant: ${JSON.stringify(memberGrant.body)}`);
  refused(await agentCommand({ kind: "remove_member", user_id: member.id }), "seat_admin_target_protected", "owns an admin agent");
  const [still] = await sql<{ member: boolean; agent: boolean; role: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM swarm.memberships WHERE workspace_id = ${workspace}::uuid AND user_id = ${member.id}::uuid AND revoked_at IS NULL) AS member,
    EXISTS(SELECT 1 FROM swarm.agent_workspace_memberships WHERE workspace_id = ${workspace}::uuid AND principal_id = ${memberAgent}::uuid
      AND revoked_at IS NULL) AS agent,
    EXISTS(SELECT 1 FROM swarm.household_member_content_roles WHERE workspace_id = ${workspace}::uuid AND user_id = ${member.id}::uuid
      AND revoked_at IS NULL) AS role`;
  assert.deepEqual(still, { member: true, agent: true, role: true }, "membership, the agent and household access unchanged");
  const ended = await account(member.jwt, { kind: "end_seat_admin", grant_id: (memberGrant.body.seat_admin_grant as { grant_id: string }).grant_id });
  assert.equal(ended.status, 200, JSON.stringify(ended.body));
  const removed = await agentCommand({ kind: "remove_member", user_id: member.id });
  assert.equal(removed.status, 200, JSON.stringify(removed.body) + functionLogs.slice(-3000));
  const [m] = await sql<{ gone: boolean }[]>`SELECT revoked_at IS NOT NULL AS gone FROM swarm.memberships
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${member.id}::uuid`;
  assert.equal(m!.gone, true, "membership ended");
  const [a] = await sql<{ gone: boolean }[]>`SELECT revoked_at IS NOT NULL AS gone FROM swarm.agent_workspace_memberships
    WHERE workspace_id = ${workspace}::uuid AND principal_id = ${memberAgent}::uuid`;
  assert.equal(a!.gone, true, "their agent left the workspace");
  const [r] = await sql<{ gone: boolean }[]>`SELECT revoked_at IS NOT NULL AS gone FROM swarm.household_member_content_roles
    WHERE workspace_id = ${workspace}::uuid AND user_id = ${member.id}::uuid`;
  assert.equal(r!.gone, true, "their Lists & docs role ended");
  const audits = await sql<{ actor_user: string; actor_principal: string | null }[]>`SELECT actor_user, actor_principal FROM swarm.household_object_audit
    WHERE workspace_id = ${workspace}::uuid AND command_kind = 'remove_member'`;
  assert.deepEqual([...audits], [{ actor_user: owner.id, actor_principal: agent }], "household audit: the grantor authorizes, the agent acts");
  const [event] = await sql<{ actor_agent_principal: string }[]>`SELECT actor_agent_principal FROM swarm.events
    WHERE workspace_id = ${workspace}::uuid AND type = 'MemberRemoved' ORDER BY seq DESC LIMIT 1`;
  assert.equal(event!.actor_agent_principal, agent);
  const accepted = (await agentHistory()).filter((h) => h.seat_admin_grant_id === grantId && h.outcome === "accepted");
  assert.deepEqual(accepted.map((h) => [h.action, h.target_kind, h.target_id]), [["remove_member", "member", member.id]]);
  await endGrant(grantId);
});

test("the database floor: a delegated removal without a live grant is refused", async () => {
  // sibling holds no grant: the hosted-seat definer and the household trigger both refuse it as the delegated agent.
  await assert.rejects(sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_command`;
    await tx`SELECT swarm.remove_hosted_agents_for_member(${workspace}::uuid, ${other.id}::uuid, ${owner.id}::uuid, ${sibling}::uuid)`;
  }), /delegated member removal refused/);
  await sql`INSERT INTO swarm.household_member_content_roles (workspace_id, user_id, content_role, content_consent_id, confirmed_at)
    VALUES (${workspace}::uuid, ${other.id}::uuid, 'reader', ${randomUUID()}::uuid, now()) ON CONFLICT DO NOTHING`;
  await assert.rejects(sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE swarm_command`;
    await tx`SELECT set_config('cswarm.household_actor', ${owner.id}, true), set_config('cswarm.household_request', 'r', true),
      set_config('cswarm.household_digest', ${"a".repeat(64)}, true), set_config('cswarm.household_command', 'remove_member', true),
      set_config('cswarm.household_agent_principal', ${sibling}, true)`;
    await tx`UPDATE swarm.household_member_content_roles SET revoked_at = now() WHERE workspace_id = ${workspace}::uuid AND revoked_at IS NULL`;
  }), /household delegated actor refused/);
});

test("rename the organization: an organization grant only, name only, attributed to the agent and the grantor", async () => {
  const [{ slug: slugBefore }] = await sql<{ slug: string }[]>`SELECT slug FROM swarm.organizations WHERE id = ${workspace}::uuid`;
  const wsGrant = await grant();
  refused(await agentCommand({ kind: "rename_organization", display_name: "Nope" }), "seat_admin_scope_missing", "a workspace grant");
  await endGrant(wsGrant);
  const orgGrant = await grant({ level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: workspace });
  const bad = await agentCommand({ kind: "rename_organization", display_name: " padded " });
  assert.equal(bad.status, 400, JSON.stringify(bad.body));
  const renameId = randomUUID();
  const renamed = await agentCommand({ kind: "rename_organization", display_name: "Renamed org" }, { commandId: renameId });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body) + functionLogs.slice(-2000));
  const replayed = await agentCommand({ kind: "rename_organization", display_name: "Renamed org" }, { commandId: renameId });
  assert.equal(replayed.status, 200, `a replay under the live grant: ${JSON.stringify(replayed.body)}`);
  const [org] = await sql<{ display_name: string; slug: string }[]>`SELECT display_name, slug FROM swarm.organizations WHERE id = ${workspace}::uuid`;
  assert.deepEqual([org!.display_name, org!.slug], ["Renamed org", slugBefore], "name only; the slug stays");
  const [audit] = await sql<{ actor_agent_principal: string; detail: string }[]>`SELECT actor_agent_principal, detail FROM swarm.audit_log
    WHERE command_kind = 'rename_organization' AND outcome = 'accepted' ORDER BY audit_id DESC LIMIT 1`;
  assert.equal(audit!.actor_agent_principal, agent);
  assert.match(audit!.detail, new RegExp(`seat_admin grant=${orgGrant} level=organization authorizing_user=${owner.id}`));
  const accepted = (await agentHistory()).filter((h) => h.seat_admin_grant_id === orgGrant && h.outcome === "accepted");
  assert.deepEqual(accepted.map((h) => [h.action, h.target_kind, h.target_id]), [["rename_organization", "organization", workspace]]);
  await endGrant(orgGrant);
  refused(await agentCommand({ kind: "rename_organization", display_name: "After end" }), "seat_admin_inactive", "after end");
  refused(await agentCommand({ kind: "rename_organization", display_name: "Renamed org" }, { commandId: renameId }), "seat_admin_inactive",
    "replay after end");
});

test("rename the organization as its owner; a member and an ordinary agent cannot", async () => {
  const human = async (bearer: string, name: string, commandId: string = randomUUID()) => {
    const response = await fetch(`${local.API_URL}/functions/v1/command`, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json", origin: ORIGIN },
      body: JSON.stringify({ command_id: commandId, client_version: "0.1.93", workspace_id: workspace, stream: { kind: "workspace" },
        command: { kind: "rename_organization", display_name: name } }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const byMember = await human(other.jwt, "By member");
  assert.equal(byMember.status, 403, JSON.stringify(byMember.body));
  const ownerId = randomUUID();
  const byOwner = await human(owner.jwt, "By owner", ownerId);
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body) + functionLogs.slice(-2000));
  assert.equal((await human(owner.jwt, "By owner", ownerId)).status, 200, "the owner's replay");
  // Ownership lost: the replay re-checks it now and refuses.
  await sql`UPDATE swarm.org_memberships SET role = 'admin' WHERE org_id = ${workspace}::uuid AND principal_kind = 'user'
    AND principal_id = ${owner.id}::uuid`;
  try {
    assert.equal((await human(owner.jwt, "By owner", ownerId)).status, 403, "replay after losing ownership");
  } finally {
    await sql`UPDATE swarm.org_memberships SET role = 'owner' WHERE org_id = ${workspace}::uuid AND principal_kind = 'user'
      AND principal_id = ${owner.id}::uuid`;
  }
  const [org] = await sql<{ display_name: string }[]>`SELECT display_name FROM swarm.organizations WHERE id = ${workspace}::uuid`;
  assert.equal(org!.display_name, "By owner");
});

test("seat_admin_status: the person's own agents, what each level accepts, and active grants that always resolve", async () => {
  const status = async (bearer: string) => {
    const response = await fetch(`${local.API_URL}/functions/v1/read`, { method: "POST",
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" }, body: JSON.stringify({ resource: "seat_admin_status" }) });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };
  const asAgent = await status(agentToken);
  assert.equal(asAgent.status, 403, "a person's session only");
  const grantId = await grant();
  const mine = await status(owner.jwt);
  assert.equal(mine.status, 200, JSON.stringify(mine.body) + functionLogs.slice(-2000));
  assert.equal(mine.body.enabled, true);
  assert.equal(mine.body.registry_version, 3);
  type Row = { principal_id: string; eligible: { workspace: string[]; organization: string[]; scoped: string[] }; active_grant_ids: string[] };
  const rows = mine.body.agents as Row[];
  assert.ok(!rows.some((r) => r.principal_id === foreign), "only the caller's own agents");
  const row = rows.find((r) => r.principal_id === agent)!;
  assert.deepEqual(row.eligible, { workspace: [workspace], organization: [workspace], scoped: [workspace] });
  assert.deepEqual(row.active_grant_ids, [grantId]);
  const theirs = await status(other.jwt);
  assert.ok(!(theirs.body.agents as Row[]).some((r) => r.principal_id === agent), "never another person's agents");

  // 101 newer ended grants: the active one is still in the grant list the site resolves against.
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`INSERT INTO swarm.seat_admin_grants (grant_id, owner_user_id, principal_id, level, organization_id, registry_version,
        scope_names, workspace_ids, manifest, manifest_digest, expires_at, state, created_at, ended_at, end_reason)
      SELECT (md5(${grantId} || n::text))::uuid, owner_user_id, principal_id, level, organization_id, registry_version, scope_names,
        workspace_ids, manifest, manifest_digest, expires_at, 'downgraded', created_at + n * interval '1 second',
        created_at + n * interval '1 second' + interval '1 millisecond', 'owner_downgrade'
      FROM swarm.seat_admin_grants, generate_series(1, 101) AS n WHERE grant_id = ${grantId}::uuid`;
  });
  const listed = await sql.begin(async (tx) => {
    await tx`SET LOCAL ROLE authenticated`;
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: owner.id, role: "authenticated" })}, true)`;
    const [r] = await tx<{ g: { grants: Array<{ grant_id: string; state: string }> } }[]>`SELECT swarm_read.my_seat_admin_grants() AS g`;
    return r!.g.grants;
  });
  assert.ok(listed.length > 100 && listed.filter((g) => g.state === "downgraded").length >= 100, "the latest 100, and more");
  assert.equal(listed.find((g) => g.grant_id === grantId)?.state, "active");
  await endGrant(grantId);
  const after = await status(owner.jwt);
  assert.deepEqual((after.body.agents as Row[]).find((r) => r.principal_id === agent)!.active_grant_ids, []);
});
