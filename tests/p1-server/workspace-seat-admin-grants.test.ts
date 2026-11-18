/**
 * An owner of a workspace reads every agent admin grant that covers it (20261118000006). Who may read, which grants
 * are listed, and whether each can be ended by this person, against the migrated schema.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

let sql: postgres.Sql;
let admin: SupabaseClient;
let founder: string, coOwner: string, workspaceAdmin: string, member: string, stranger: string;
let organization: string, workspace: string, sibling: string, elsewhere: string, archived: string;
const grants: Record<string, string> = {};
const agents: Record<string, string> = {};

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `${label}-${randomUUID()}@example.test`, password: `T-${randomBytes(24).toString("base64url")}!`, email_confirm: true,
  });
  assert.ifError(created.error);
  return created.data.user!.id;
}

/** An agent whose home is `home`. Creating it records its seat there (agent_workspace_memberships). */
async function agent(name: string, owner: string, home = workspace): Promise<string> {
  const principal = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
    VALUES (${principal}::uuid, ${home}::uuid, ${owner}::uuid, ${name})`;
  return (agents[name] = principal);
}
/** A seat in another workspace, as adding an existing agent to it records; `removed` leaves the row, revoked. */
async function seat(principal: string, owner: string, target: string, removed = false): Promise<void> {
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by, revoked_at)
    VALUES (${principal}::uuid, ${target}::uuid, ${owner}::uuid, ${owner}::uuid, ${removed ? sql`statement_timestamp()` : null})`;
}

type Level = "scoped" | "workspace" | "organization";
/** A grant row as the grant command would write it. `created` and `expires` are SQL expressions. */
async function grant(label: string, by: string, principal: string, level: Level, target: string,
  times: { created?: string; expires?: string } = {}): Promise<string> {
  const grantId = randomUUID();
  const scopeNames = level === "scoped" ? ["admin:read", "invites:create"] : [`role:${level}_admin`];
  const workspaceIds = level === "organization" ? [] : [target];
  const organizationId = level === "organization" ? target : null;
  const manifest = { registry_version: 3, level, scope_names: scopeNames, workspace_ids: workspaceIds,
    organization_id: organizationId, principal_id: principal, expires: times.expires ?? null };
  await sql`INSERT INTO swarm.seat_admin_grants (grant_id, owner_user_id, principal_id, level, organization_id,
      registry_version, scope_names, workspace_ids, manifest, manifest_digest, created_at, expires_at)
    VALUES (${grantId}::uuid, ${by}::uuid, ${principal}::uuid, ${level}, ${organizationId}::uuid, 3, ${scopeNames}::text[],
      ${workspaceIds}::uuid[], ${sql.json(manifest as postgres.JSONValue)}::jsonb, ${"a".repeat(64)},
      ${sql.unsafe(times.created ?? "statement_timestamp()")}, ${times.expires ? sql.unsafe(times.expires) : null})`;
  return (grants[label] = grantId);
}

type Listed = { grant_id: string; principal_id: string; agent_name: string; owner_user_id: string; owner_display: string | null;
  level: Level; expires_at: string | null; created_at: string; may_end: boolean };
const read = (claims: Record<string, unknown> | null, target = workspace, role = "authenticated") => sql.begin(async (tx) => {
  await tx.unsafe(`SET LOCAL ROLE ${role}`);
  if (claims) await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
  return (await tx<{ r: { grants: Listed[] } | null }[]>`SELECT swarm_read.workspace_seat_admin_grants(${target}::uuid) AS r`)[0]!.r;
});
const person = (userId: string) => ({ sub: userId, role: "authenticated" });

before(async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  sql = postgres(status.DB_URL, { prepare: false, max: 3 });
  admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  [founder, coOwner, workspaceAdmin, member, stranger] = await Promise.all(
    ["founder", "co-owner", "admin", "member", "stranger"].map((label) => createUser(`ws-admin-read-${label}`)));
  organization = randomUUID(); workspace = randomUUID(); sibling = randomUUID(); elsewhere = randomUUID(); archived = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${founder}::uuid, 'Founder Person'), (${coOwner}::uuid, 'Co Owner'),
      (${workspaceAdmin}::uuid, 'Admin Person'), (${member}::uuid, 'Member Person'), (${stranger}::uuid, 'Stranger Person')`;
    // One organization with its own id and two workspaces. Its founder owns it; owning a workspace in it does not.
    await tx`INSERT INTO swarm.organizations (id, slug, display_name, created_by)
      VALUES (${organization}::uuid, ${`admin-read-${organization.replaceAll("-", "")}`.slice(0, 48)}, 'AdminReadOrganization', ${founder}::uuid)`;
    await tx`INSERT INTO swarm.org_memberships (org_id, principal_kind, principal_id, role) VALUES (${organization}::uuid, 'user', ${founder}::uuid, 'owner')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by, org_id) VALUES
      (${workspace}::uuid, 'AdminReadHome', ${founder}::uuid, ${organization}::uuid),
      (${sibling}::uuid, 'AdminReadSibling', ${founder}::uuid, ${organization}::uuid)`;
    // These two start their own organizations.
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES
      (${elsewhere}::uuid, 'AdminReadElsewhere', ${founder}::uuid), (${archived}::uuid, 'AdminReadArchived', ${founder}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES
      (${workspace}::uuid, ${founder}::uuid, 'owner'), (${workspace}::uuid, ${coOwner}::uuid, 'owner'),
      (${workspace}::uuid, ${workspaceAdmin}::uuid, 'admin'), (${workspace}::uuid, ${member}::uuid, 'member'),
      (${sibling}::uuid, ${founder}::uuid, 'owner'),
      (${elsewhere}::uuid, ${founder}::uuid, 'owner'), (${archived}::uuid, ${founder}::uuid, 'owner')`;
  });
  await grant("coOwnerWorkspace", coOwner, await agent("Pixel", coOwner), "workspace", workspace);
  await grant("founderScoped", founder, await agent("Harbor", founder), "scoped", workspace, { expires: "statement_timestamp() + interval '30 days'" });
  // Three organization grants for agents whose home is the sibling workspace: one also seated here, one whose seat
  // here was removed, and one that has never been here.
  await seat(await agent("Atlas", founder, sibling), founder, workspace);
  await grant("organizationSeatedHere", founder, agents.Atlas, "organization", organization);
  await seat(await agent("Relay", founder, sibling), founder, workspace, true);
  await grant("organizationFormerSeat", founder, agents.Relay, "organization", organization);
  await grant("organizationNeverHere", founder, await agent("Quill", founder, sibling), "organization", organization);
  await grant("elsewhere", founder, await agent("Orbit", founder, elsewhere), "workspace", elsewhere);
  await grant("pastEndDate", founder, await agent("Ledger", founder), "workspace", workspace,
    { created: "statement_timestamp() - interval '10 days'", expires: "statement_timestamp() - interval '1 day'" });
  await grant("inArchived", founder, await agent("Muse", founder, archived), "workspace", archived);
  await sql`UPDATE swarm.workspaces SET archived_at = statement_timestamp() WHERE workspace_id = ${archived}::uuid`;
});

after(async () => { await sql?.end({ timeout: 5 }); });

const here = () => [grants.coOwnerWorkspace, grants.founderScoped, grants.organizationSeatedHere, grants.organizationFormerSeat].sort();

test("an owner sees every grant in force that concerns the workspace, including another person's", async () => {
  const seen = await read(person(founder));
  assert.ok(seen);
  const byId = new Map(seen.grants.map((row) => [row.grant_id, row]));
  assert.deepEqual([...byId.keys()].sort(), here(),
    "the workspace and scoped grants that name it, and the organization grants of agents seated here now or before");
  const pixel = byId.get(grants.coOwnerWorkspace)!;
  assert.deepEqual({ agent: pixel.agent_name, principal: pixel.principal_id, by: pixel.owner_user_id, name: pixel.owner_display, level: pixel.level, ends: pixel.expires_at },
    { agent: "Pixel", principal: agents.Pixel, by: coOwner, name: "Co Owner", level: "workspace", ends: null });
  assert.equal(byId.get(grants.founderScoped)!.level, "scoped");
  assert.ok(byId.get(grants.founderScoped)!.expires_at, "a set end date is returned");
  assert.deepEqual([byId.get(grants.organizationSeatedHere)!.level, byId.get(grants.organizationSeatedHere)!.agent_name], ["organization", "Atlas"]);
  assert.equal(byId.get(grants.organizationFormerSeat)!.agent_name, "Relay", "a removed seat keeps its grant on record here");
  assert.deepEqual(Object.keys(pixel).sort(), ["agent_name", "created_at", "expires_at", "grant_id", "level", "may_end", "owner_display", "owner_user_id", "principal_id"],
    "no manifest, digest, scope list, workspace list or organization id");
  // The co-owner is an owner of the workspace too, and sees the same four.
  assert.deepEqual((await read(person(coOwner)))!.grants.map((row) => row.grant_id).sort(), here());
});

test("an organization grant for an agent that was never in this workspace is not listed, and nothing about it leaks", async () => {
  for (const viewer of [founder, coOwner]) {
    const text = JSON.stringify(await read(person(viewer)));
    for (const hidden of [grants.organizationNeverHere, agents.Quill, "Quill"]) assert.ok(!text.includes(hidden), `${hidden} is not returned`);
  }
  // It is listed where that agent does have a seat: its home, the sibling workspace of the same organization.
  const atSibling = (await read(person(founder), sibling))!.grants;
  assert.deepEqual(atSibling.map((row) => row.agent_name).sort(), ["Atlas", "Quill", "Relay"]);
  // And the workspace-level grants that name this workspace are not listed at the sibling.
  assert.ok(!atSibling.some((row) => [grants.coOwnerWorkspace, grants.founderScoped].includes(row.grant_id)));
});

test("may_end follows the end command: any owner for a workspace or scoped grant, only an organization owner or the grantor for an organization grant", async () => {
  const mayEnd = async (userId: string) => Object.fromEntries((await read(person(userId)))!.grants.map((row) => [row.grant_id, row.may_end]));
  assert.deepEqual(await mayEnd(founder), { [grants.coOwnerWorkspace]: true, [grants.founderScoped]: true,
    [grants.organizationSeatedHere]: true, [grants.organizationFormerSeat]: true }, "the founder owns the workspace and its organization");
  assert.deepEqual(await mayEnd(coOwner), { [grants.coOwnerWorkspace]: true, [grants.founderScoped]: true,
    [grants.organizationSeatedHere]: false, [grants.organizationFormerSeat]: false },
    "a workspace owner who does not own the organization cannot end an organization grant");
});

test("only a live owner signed in as a person reads; everyone else learns nothing, not even that the workspace exists", async () => {
  for (const [label, userId] of [["an admin", workspaceAdmin], ["a member", member], ["a stranger", stranger]] as const) {
    assert.equal(await read(person(userId)), null, label);
  }
  assert.equal(await read(person(founder), randomUUID()), null, "an unknown workspace");
  assert.equal(await read(person(founder), archived), null, "an archived workspace");
  assert.equal(await read({ sub: founder, role: "authenticated", agent_principal_id: agents.Harbor }), null, "an agent credential, even its owner's");
  assert.equal(await read({ sub: founder, role: "anon" }), null, "claims that are not a signed-in person's");
  assert.equal(await read({ sub: "not-a-uuid", role: "authenticated" }), null, "a malformed subject");
  assert.equal(await read(null), null, "no claims at all");
  // An owner of another workspace sees that workspace's grant and none of this one's.
  assert.deepEqual((await read(person(founder), elsewhere))!.grants.map((row) => row.grant_id), [grants.elsewhere]);
  for (const role of ["anon", "swarm_read", "swarm_command"]) {
    await assert.rejects(() => read(person(founder), workspace, role), /permission denied/, `${role} cannot call the read`);
  }
});

test("a former owner stops seeing the list; their grant stays on record for the others; an ended grant leaves it", async () => {
  await sql`UPDATE swarm.memberships SET role = 'admin' WHERE workspace_id = ${workspace}::uuid AND user_id = ${coOwner}::uuid`;
  assert.equal(await read(person(coOwner)), null, "no longer an owner");
  await sql`UPDATE swarm.memberships SET role = 'owner', revoked_at = statement_timestamp() WHERE workspace_id = ${workspace}::uuid AND user_id = ${coOwner}::uuid`;
  assert.equal(await read(person(coOwner)), null, "a removed owner");
  // The grant past its end date is still 'active' on its row until something expires it; either way it is not listed.
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`SELECT swarm.expire_seat_admin_grant(${grants.pastEndDate}::uuid)`;
  });
  const after = (await read(person(founder)))!.grants.map((row) => row.grant_id);
  assert.ok(!after.includes(grants.pastEndDate));
  assert.deepEqual(after.sort(), here(), "the former owner's grant is still on record and still listed for the remaining owner");
});
