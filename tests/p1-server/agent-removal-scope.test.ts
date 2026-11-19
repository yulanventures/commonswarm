/**
 * Agent removal scope read (20261119000001): identifies whether removing an agent from a workspace
 * is workspace-only ('workspace') or permanent retirement ('permanent'), matching revoke_agent_principal.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

let sql: postgres.Sql;
let admin: SupabaseClient;
let owner: string, workspaceAdmin: string, agentOwnerMember: string, otherMember: string, stranger: string;
let workspaceA: string, workspaceB: string, archivedWs: string;
let localAgent: string, hostedAgent: string, revokedAgent: string;

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `${label}-${randomUUID()}@example.test`,
    password: `T-${randomBytes(24).toString("base64url")}!`,
    email_confirm: true,
  });
  assert.ifError(created.error);
  return created.data.user!.id;
}

const readScope = (
  claims: Record<string, unknown> | null,
  ws: string | null,
  principal: string | null,
  role = "authenticated",
) =>
  sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    if (claims) await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return (await tx<{ r: string | null }[]>`SELECT swarm_read.agent_removal_scope(${ws}::uuid, ${principal}::uuid) AS r`)[0]!.r;
  });

const person = (userId: string) => ({ sub: userId, role: "authenticated" });

before(async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  sql = postgres(status.DB_URL, { prepare: false, max: 3 });
  admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  [owner, workspaceAdmin, agentOwnerMember, otherMember, stranger] = await Promise.all(
    ["owner", "admin", "agent-owner", "other-member", "stranger"].map((label) => createUser(`removal-scope-${label}`)),
  );
  workspaceA = randomUUID(); workspaceB = randomUUID(); archivedWs = randomUUID();
  localAgent = randomUUID(); hostedAgent = randomUUID(); revokedAgent = randomUUID();
  const orgId = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES
      (${owner}::uuid, 'Owner'), (${workspaceAdmin}::uuid, 'Admin'),
      (${agentOwnerMember}::uuid, 'Agent Owner'), (${otherMember}::uuid, 'Other Member'),
      (${stranger}::uuid, 'Stranger')`;
    await tx`INSERT INTO swarm.organizations (id, slug, display_name, created_by)
      VALUES (${orgId}::uuid, ${`rm-scope-${orgId.replaceAll("-", "")}`.slice(0, 48)}, 'RemovalScopeOrg', ${owner}::uuid)`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by, org_id, archived_at) VALUES
      (${workspaceA}::uuid, 'Origin WS', ${owner}::uuid, ${orgId}::uuid, null),
      (${workspaceB}::uuid, 'Added WS', ${owner}::uuid, ${orgId}::uuid, null),
      (${archivedWs}::uuid, 'Archived WS', ${owner}::uuid, ${orgId}::uuid, statement_timestamp())`;
    for (const ws of [workspaceA, workspaceB, archivedWs]) {
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES
        (${ws}::uuid, ${owner}::uuid, 'owner'),
        (${ws}::uuid, ${workspaceAdmin}::uuid, 'admin'),
        (${ws}::uuid, ${agentOwnerMember}::uuid, 'member'),
        (${ws}::uuid, ${otherMember}::uuid, 'member')`;
    }
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only) VALUES
      (${localAgent}::uuid, ${workspaceA}::uuid, ${agentOwnerMember}::uuid, 'Sprout', 'local', false),
      (${hostedAgent}::uuid, ${workspaceA}::uuid, ${agentOwnerMember}::uuid, 'Muse', 'hosted_mcp', true),
      (${revokedAgent}::uuid, ${workspaceA}::uuid, ${agentOwnerMember}::uuid, 'Gone', 'local', false)`;
    await tx`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp() WHERE principal_id = ${revokedAgent}::uuid`;
    await tx`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by) VALUES
      (${localAgent}::uuid, ${workspaceB}::uuid, ${agentOwnerMember}::uuid, ${owner}::uuid),
      (${hostedAgent}::uuid, ${workspaceB}::uuid, ${agentOwnerMember}::uuid, ${owner}::uuid)`;
  });
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test("identifies permanent for local agent in origin workspace and workspace for added workspace and hosted agents", async () => {
  for (const viewer of [owner, workspaceAdmin, agentOwnerMember]) {
    assert.equal(await readScope(person(viewer), workspaceA, localAgent), "permanent", "local in origin workspace");
    assert.equal(await readScope(person(viewer), workspaceB, localAgent), "workspace", "local in added workspace");
    assert.equal(await readScope(person(viewer), workspaceA, hostedAgent), "workspace", "hosted in origin workspace");
    assert.equal(await readScope(person(viewer), workspaceB, hostedAgent), "workspace", "hosted in added workspace");
  }
});

test("returns NULL for unauthorized callers, agent credentials, unknown/archived/revoked targets, and denies non-authenticated DB roles", async () => {
  assert.equal(await readScope(person(otherMember), workspaceA, localAgent), null, "other member cannot manage");
  assert.equal(await readScope(person(otherMember), workspaceB, hostedAgent), null, "other member cannot manage hosted");
  assert.equal(await readScope(person(stranger), workspaceA, localAgent), null, "stranger gets null");
  assert.equal(await readScope({ sub: owner, role: "authenticated", agent_principal_id: localAgent }, workspaceA, localAgent), null, "agent credential gets null");
  assert.equal(await readScope(null, workspaceA, localAgent), null, "missing claims get null");
  assert.equal(await readScope({ sub: "not-a-uuid", role: "authenticated" }, workspaceA, localAgent), null, "malformed sub gets null");
  assert.equal(await readScope(person(owner), archivedWs, localAgent), null, "archived workspace gets null");
  assert.equal(await readScope(person(owner), workspaceA, revokedAgent), null, "revoked principal gets null");
  assert.equal(await readScope(person(owner), randomUUID(), localAgent), null, "unknown workspace gets null");
  assert.equal(await readScope(person(owner), workspaceA, randomUUID()), null, "unknown principal gets null");
  assert.equal(await readScope(person(owner), null, localAgent), null, "null workspace gets null");

  for (const dbRole of ["anon", "swarm_read", "swarm_command"]) {
    await assert.rejects(readScope(person(owner), workspaceA, localAgent, dbRole), /42501|permission denied/i, `${dbRole} denied`);
  }
});
