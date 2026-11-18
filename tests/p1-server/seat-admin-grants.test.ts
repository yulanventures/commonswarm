/**
 * Seat admin, PR 1: the swarm.seat_admin_grants schema on its own (no edge yet). A grant pins its
 * confirmed manifest, binds one agent principal at one level (scoped, workspace role or organization
 * role), only moves active -> one terminal state, and only the command role writes it. People read their own grants through one definer function.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";

let sql: postgres.Sql;
let admin: SupabaseClient;
let owner: string, other: string, workspaceA: string, workspaceB: string;

async function createUser(label: string): Promise<string> {
  const created = await admin.auth.admin.createUser({
    email: `${label}-${randomUUID()}@example.test`, password: `T-${randomBytes(24).toString("base64url")}!`, email_confirm: true,
  });
  assert.ifError(created.error);
  return created.data.user!.id;
}

async function agent(name: string): Promise<string> {
  const principal = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
    VALUES (${principal}::uuid, ${workspaceA}::uuid, ${owner}::uuid, ${name})`;
  return principal;
}

type Row = { principal_id: string; level: string; organization_id: string | null; scope_names: string[];
  workspace_ids: string[]; expires: string | null; registry_version: number; manifest_patch?: Record<string, unknown>;
  manifest_drop?: string; digest?: string };

function grantRow(principal: string, patch: Partial<Row> = {}): Row {
  return { principal_id: principal, level: "scoped", organization_id: null, scope_names: ["admin:read", "invites:create"],
    workspace_ids: [workspaceA], expires: null, registry_version: 3, ...patch };
}

async function insert(row: Row, as: "owner" | "swarm_command" = "owner"): Promise<string> {
  const grantId = randomUUID();
  const manifest: Record<string, unknown> = { registry_version: row.registry_version, level: row.level,
    scope_names: row.scope_names, workspace_ids: row.workspace_ids, organization_id: row.organization_id,
    principal_id: row.principal_id, expires: row.expires, ...row.manifest_patch };
  if (row.manifest_drop) delete manifest[row.manifest_drop];
  await sql.begin(async (tx) => {
    if (as === "swarm_command") await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`INSERT INTO swarm.seat_admin_grants (grant_id, owner_user_id, principal_id, level, organization_id,
        registry_version, scope_names, workspace_ids, manifest, manifest_digest, expires_at)
      VALUES (${grantId}::uuid, ${owner}::uuid, ${row.principal_id}::uuid, ${row.level}, ${row.organization_id}::uuid,
        ${row.registry_version}, ${row.scope_names}::text[],
        ${row.workspace_ids}::uuid[], ${tx.json(manifest as postgres.JSONValue)}::jsonb, ${row.digest ?? "a".repeat(64)},
        ${row.expires === null ? null : sql.unsafe(row.expires)})`;
  });
  return grantId;
}

before(async () => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  sql = postgres(status.DB_URL, { prepare: false, max: 3 });
  admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  owner = await createUser("seat-admin-owner");
  other = await createUser("seat-admin-other");
  workspaceA = randomUUID();
  workspaceB = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${owner}::uuid, 'SeatAdminOwner'), (${other}::uuid, 'SeatAdminOther')`;
    await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspaceA}::uuid, 'SeatAdminA', ${owner}::uuid), (${workspaceB}::uuid, 'SeatAdminB', ${owner}::uuid)`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspaceA}::uuid, ${owner}::uuid, 'owner'), (${workspaceB}::uuid, ${owner}::uuid, 'owner')`;
  });
});

after(async () => { await sql?.end({ timeout: 5 }); });

test("the schema admits only a pinned, bounded manifest", async () => {
  const two = [workspaceA, workspaceB].sort();
  const cases: Array<[string, Partial<Row> | ((p: string) => Partial<Row>), boolean]> = [
    ["read-only, no end date", { scope_names: ["admin:read"] }, true],
    ["every day-one scope, two workspaces, 90 days", { scope_names: ["admin:read", "invites:create", "invites:revoke",
      "onboarding:connect", "seats:create", "seats:renew", "seats:revoke", "workspaces:rename"], workspace_ids: two,
      expires: "statement_timestamp() + interval '90 days'" }, true],
    ["no admin:read", { scope_names: ["invites:create"] }, false],
    ["delegation", { scope_names: ["admin:delegate", "admin:read"] }, false],
    ["workspace creation", { scope_names: ["admin:read", "workspaces:create"] }, false],
    ["member management", { scope_names: ["admin:read", "members:manage"] }, false],
    ["unsorted scopes", { scope_names: ["invites:create", "admin:read"] }, false],
    ["repeated scope", { scope_names: ["admin:read", "admin:read"] }, false],
    ["no workspace", { workspace_ids: [] }, false],
    ["eleven workspaces", { workspace_ids: Array.from({ length: 11 }, () => randomUUID()).sort() }, false],
    ["registry v2", { registry_version: 2 }, false],
    ["an end in the past", { expires: "statement_timestamp() - interval '1 minute'" }, false],
    ["an end past 90 days", { expires: "statement_timestamp() + interval '91 days'" }, false],
    ["manifest scopes differ", { manifest_patch: { scope_names: ["admin:read", "seats:revoke"] } }, false],
    ["manifest names another agent", { manifest_patch: { principal_id: randomUUID() } }, false],
    ["manifest workspaces differ", { manifest_patch: { workspace_ids: two } }, false],
    ["bad digest", { digest: "not-a-digest" }, false],
    ["a manifest missing its scopes", { manifest_drop: "scope_names" }, false],
    ["a manifest missing its level", { manifest_drop: "level" }, false],
    ["a manifest missing its organization", { manifest_drop: "organization_id" }, false],
    ["workspace admin in one workspace", { level: "workspace", scope_names: ["role:workspace_admin"] }, true],
    ["workspace admin in two workspaces", { level: "workspace", scope_names: ["role:workspace_admin"], workspace_ids: two }, false],
    ["workspace admin with extra scopes", { level: "workspace", scope_names: ["admin:read", "role:workspace_admin"] }, false],
    ["workspace admin naming an organization", { level: "workspace", scope_names: ["role:workspace_admin"], organization_id: workspaceA }, false],
    ["organization admin", { level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: workspaceA }, true],
    ["organization admin without an organization", { level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [] }, false],
    ["organization admin also naming workspaces", { level: "organization", scope_names: ["role:organization_admin"], organization_id: workspaceA }, false],
    ["a role bundle on a scoped grant", { scope_names: ["admin:read", "role:workspace_admin"] }, false],
    ["the organization bundle at workspace level", { level: "workspace", scope_names: ["role:organization_admin"] }, false],
    ["an unknown level", { level: "account", scope_names: ["role:workspace_admin"] }, false],
  ];
  for (const [name, patch, ok] of cases) {
    const principal = await agent(`schema-${randomUUID().slice(0, 8)}`);
    const row = grantRow(principal, typeof patch === "function" ? patch(principal) : patch);
    if (ok) await insert(row);
    else await assert.rejects(() => insert(row), /violates|check/i, name);
  }
});

test("one active grant per agent; a grant only ends, once, and never reactivates", async () => {
  const principal = await agent("forward-only");
  const first = await insert(grantRow(principal));
  await assert.rejects(() => insert(grantRow(principal)), /seat_admin_grants_one_active/, "a second active scoped grant");
  const wsAdmin = { level: "workspace", scope_names: ["role:workspace_admin"] };
  await insert(grantRow(principal, wsAdmin)); // a workspace role beside the scoped grant
  await insert(grantRow(principal, { ...wsAdmin, workspace_ids: [workspaceB] })); // and in another workspace
  await assert.rejects(() => insert(grantRow(principal, wsAdmin)), /seat_admin_grants_one_active_workspace/, "twice in one workspace");
  const orgAdmin = { level: "organization", scope_names: ["role:organization_admin"], workspace_ids: [], organization_id: workspaceA };
  await insert(grantRow(principal, orgAdmin));
  await assert.rejects(() => insert(grantRow(principal, orgAdmin)), /seat_admin_grants_one_active_organization/, "twice in one organization");
  const refused: Array<[string, () => Promise<unknown>]> = [
    ["change scopes", () => sql`UPDATE swarm.seat_admin_grants SET scope_names = ARRAY['admin:read'] WHERE grant_id = ${first}::uuid`],
    ["extend the end", () => sql`UPDATE swarm.seat_admin_grants SET expires_at = statement_timestamp() + interval '1 day' WHERE grant_id = ${first}::uuid`],
    ["end without a reason", () => sql`UPDATE swarm.seat_admin_grants SET state = 'ended', ended_at = statement_timestamp() WHERE grant_id = ${first}::uuid`],
    ["expire for another reason", () => sql`UPDATE swarm.seat_admin_grants SET state = 'expired', ended_at = statement_timestamp(), end_reason = 'owner_downgrade' WHERE grant_id = ${first}::uuid`],
    ["delete", () => sql`DELETE FROM swarm.seat_admin_grants WHERE grant_id = ${first}::uuid`],
  ];
  for (const [name, update] of refused) {
    await assert.rejects(async () => { await update(); }, /only ends|never deleted|violates/, name);
  }
  await sql`UPDATE swarm.seat_admin_grants SET state = 'downgraded', ended_at = statement_timestamp(), end_reason = 'owner_downgrade',
    ended_by_user_id = ${owner}::uuid WHERE grant_id = ${first}::uuid`;
  for (const [name, state, reason] of [["reactivate", "active", null], ["end again", "ended", "seat_revoked"]] as const) {
    await assert.rejects(async () => {
      await sql`UPDATE swarm.seat_admin_grants SET state = ${state}, ended_at = ${reason === null ? null : sql`statement_timestamp()`},
        end_reason = ${reason} WHERE grant_id = ${first}::uuid`;
    }, /only ends|violates/, name);
  }
  await insert(grantRow(principal)); // the agent can be upgraded again with a new grant
});

test("only the command role writes, and ends only through the audited end; people read only their own grants", async () => {
  const principal = await agent("privileges");
  const grantId = await insert(grantRow(principal), "swarm_command");
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await tx`UPDATE swarm.seat_admin_grants SET scope_names = ARRAY['admin:read'] WHERE grant_id = ${grantId}::uuid`;
  }), /permission denied/, "the command role can't rewrite the manifest columns");
  for (const role of ["authenticated", "anon", "swarm_read"]) {
    await assert.rejects(() => sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT count(*) FROM swarm.seat_admin_grants`;
    }), /permission denied/, role);
  }
  // The command role ends a grant only through the audited end, never by writing the row.
  await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await recordEnd(tx, grantId, owner, "end-for-read");
    await tx`SELECT grant_id FROM swarm.end_seat_admin_grant(${grantId}::uuid, ${owner}::uuid, 'end-for-read', clock_timestamp())`;
  });

  const read = (claims: Record<string, unknown>) => sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    return (await tx<{ r: { grants: Array<{ grant_id: string; state: string }> } | null }[]>`SELECT swarm_read.my_seat_admin_grants() AS r`)[0]!.r;
  });
  const mine = await read({ sub: owner, role: "authenticated" });
  assert.equal(mine?.grants.find((g) => g.grant_id === grantId)?.state, "downgraded", "the owner sees their grant and its end");
  assert.deepEqual(await read({ sub: other, role: "authenticated" }), { grants: [] }, "another person sees none");
  assert.equal(await read({ sub: owner, role: "authenticated", agent_principal_id: principal }), null, "agent claims get nothing");
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE anon");
    await tx`SELECT swarm_read.my_seat_admin_grants()`;
  }), /permission denied/, "anon can't call the read");
});

/** The accepted end_seat_admin record the command edge appends before ending a grant, in the caller's transaction. */
async function recordEnd(tx: postgres.TransactionSql, grantId: string, actor: string, commandId: string,
  patch: { target?: string; outcome?: string } = {}) {
  await tx`INSERT INTO swarm.admin_accounts (owner_user_id, stream_id) VALUES (${owner}::uuid, ${randomUUID()}::uuid)
    ON CONFLICT (owner_user_id) DO NOTHING`;
  const [{ seq }] = await tx<{ seq: number }[]>`SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM swarm.admin_events
    WHERE owner_user_id = ${owner}::uuid`;
  const event = { stream_kind: "account", owner_user_id: owner, seq, event_id: randomUUID(), command_id: commandId,
    type: "AdminActionRecorded", actor_user: actor,
    payload: { action: "end_seat_admin", target_kind: "seat_admin_grant", target_id: patch.target ?? grantId, outcome: patch.outcome ?? "accepted" } };
  // A caller-supplied stamp is replaced by the server's.
  await tx`INSERT INTO swarm.admin_events (owner_user_id, seq, event_id, command_id, event, creation_xact_id)
    VALUES (${owner}::uuid, ${seq}, ${event.event_id}::uuid, ${commandId}, ${tx.json(event as postgres.JSONValue)}, '1'::xid8)`;
}
const stateOf = async (grantId: string) =>
  (await sql<{ state: string }[]>`SELECT state FROM swarm.seat_admin_grants WHERE grant_id = ${grantId}::uuid`)[0]!.state;
const asCommand = <T>(run: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
  await tx.unsafe("SET LOCAL ROLE swarm_command");
  return await run(tx);
});
const unaudited = (name: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, "42501", `${name}: ${String(error)}`);
  assert.equal((error as { detail?: string }).detail, "seat_admin_end_unaudited", name);
  return true;
};

test("the command role cannot write a grant's end; an owner's end needs this transaction's accepted record", async () => {
  const principal = await agent("audited-end");
  const grantId = await insert(grantRow(principal));
  for (const [name, end] of [
    ["an owner downgrade naming the grantor", (tx: postgres.TransactionSql) => tx`UPDATE swarm.seat_admin_grants SET state = 'downgraded',
      ended_at = statement_timestamp(), end_reason = 'owner_downgrade', ended_by_user_id = ${owner}::uuid WHERE grant_id = ${grantId}::uuid`],
    ["an expiry", (tx: postgres.TransactionSql) => tx`UPDATE swarm.seat_admin_grants SET state = 'expired', ended_at = statement_timestamp(),
      end_reason = 'expired' WHERE grant_id = ${grantId}::uuid`],
  ] as const) {
    await assert.rejects(() => asCommand(async (tx) => { await end(tx); }), /permission denied/, name);
  }
  assert.equal(await stateOf(grantId), "active", "a direct write ends nothing");

  const end = (tx: postgres.TransactionSql, commandId: string, actor = owner) =>
    tx`SELECT * FROM swarm.end_seat_admin_grant(${grantId}::uuid, ${actor}::uuid, ${commandId}, clock_timestamp())`;
  await assert.rejects(() => asCommand((tx) => end(tx, "no-record")), unaudited("no record"));
  // A record committed earlier, for this very grant, actor and command id, is not this transaction's.
  await asCommand((tx) => recordEnd(tx, grantId, owner, "earlier"));
  await assert.rejects(() => asCommand((tx) => end(tx, "earlier")), unaudited("a record from an earlier transaction"));
  // Another grant's earlier end, replayed under its command id.
  const otherGrant = await insert(grantRow(await agent("audited-other")));
  await asCommand(async (tx) => {
    await recordEnd(tx, otherGrant, owner, "other-end");
    await tx`SELECT grant_id FROM swarm.end_seat_admin_grant(${otherGrant}::uuid, ${owner}::uuid, 'other-end', clock_timestamp())`;
  });
  await assert.rejects(() => asCommand((tx) => end(tx, "other-end")), unaudited("another grant's earlier end"));
  for (const [name, record, call] of [
    ["a record for another grant", { target: otherGrant }, {}],
    ["a refused record", { outcome: "refused" }, {}],
    ["a record by another actor", {}, { actor: other }],
    ["a record under another command id", {}, { commandId: "elsewhere" }],
  ] as const) {
    await assert.rejects(() => asCommand(async (tx) => {
      await recordEnd(tx, grantId, owner, "same-tx", record);
      await end(tx, (call as { commandId?: string }).commandId ?? "same-tx", (call as { actor?: string }).actor ?? owner);
    }), unaudited(name));
  }
  assert.equal(await stateOf(grantId), "active", "no unaudited end took effect");

  // A record from another cluster: a logical restore can load the stamp columns with the data, before the trigger
  // exists, and this cluster can later issue the same xid8. Here the record carries this very transaction's xid8 but
  // another cluster's identifier, as an imported row would; it does not count.
  await assert.rejects(() => sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.admin_accounts (owner_user_id, stream_id) VALUES (${owner}::uuid, ${randomUUID()}::uuid)
      ON CONFLICT (owner_user_id) DO NOTHING`;
    const [{ seq }] = await tx<{ seq: number }[]>`SELECT coalesce(max(seq), 0)::int + 1 AS seq FROM swarm.admin_events
      WHERE owner_user_id = ${owner}::uuid`;
    const event = { stream_kind: "account", owner_user_id: owner, seq, event_id: randomUUID(), command_id: "imported",
      type: "AdminActionRecorded", actor_user: owner,
      payload: { action: "end_seat_admin", target_kind: "seat_admin_grant", target_id: grantId, outcome: "accepted" } };
    await tx.unsafe("SET LOCAL session_replication_role = replica"); // as a restore loads rows: no stamping trigger
    await tx`INSERT INTO swarm.admin_events (owner_user_id, seq, event_id, command_id, event, creation_xact_id,
        creation_system_identifier)
      VALUES (${owner}::uuid, ${seq}, ${event.event_id}::uuid, 'imported', ${tx.json(event as postgres.JSONValue)},
        pg_current_xact_id(), (SELECT system_identifier + 1 FROM pg_catalog.pg_control_system()))`;
    await tx.unsafe("SET LOCAL session_replication_role = origin");
    await tx.unsafe("SET LOCAL ROLE swarm_command");
    await end(tx, "imported");
  }), unaudited("a record stamped by another cluster"));
  assert.equal(await stateOf(grantId), "active", "an imported record ends nothing");

  // Positive control: this transaction's record, appended after a savepoint, ends it and keeps who ended it.
  const [row] = await asCommand(async (tx) => {
    await tx.savepoint(async (sp) => { await recordEnd(sp, grantId, owner, "audited"); });
    const [stamp] = await tx<{ ok: boolean }[]>`SELECT bool_and(creation_xact_id = pg_current_xact_id()
        AND creation_system_identifier = (SELECT system_identifier FROM pg_catalog.pg_control_system())) AS ok
      FROM swarm.admin_events WHERE owner_user_id = ${owner}::uuid AND command_id = 'audited'`;
    assert.equal(stamp!.ok, true, "the server stamps the top-level transaction and this cluster, replacing the caller's values");
    return await end(tx, "audited");
  });
  assert.deepEqual([row!.state, row!.end_reason, row!.ended_by_user_id], ["downgraded", "owner_downgrade", owner]);
  assert.equal(await stateOf(grantId), "downgraded");
});

test("an expiry ends only a grant whose end date has passed", async () => {
  const principal = await agent("audited-expiry");
  const grantId = await insert(grantRow(principal, { expires: "statement_timestamp() + interval '1 day'" }));
  const expire = () => asCommand(async (tx) =>
    (await tx<{ ended: boolean }[]>`SELECT swarm.expire_seat_admin_grant(${grantId}::uuid) AS ended`)[0]!.ended);
  assert.equal(await expire(), false, "an early expiry changes nothing");
  assert.equal(await stateOf(grantId), "active");
  const indefinite = await insert(grantRow(await agent("audited-indefinite")));
  assert.equal((await asCommand(async (tx) =>
    (await tx<{ ended: boolean }[]>`SELECT swarm.expire_seat_admin_grant(${indefinite}::uuid) AS ended`)[0]!.ended)), false,
    "a grant with no end date never expires");
  await sql.begin(async (tx) => {
    await tx`SET LOCAL session_replication_role = replica`;
    await tx`UPDATE swarm.seat_admin_grants SET created_at = clock_timestamp() - interval '1 hour',
      expires_at = clock_timestamp() - interval '1 second' WHERE grant_id = ${grantId}::uuid`;
  });
  assert.equal(await expire(), true, "a due expiry ends it");
  const [row] = await sql<{ state: string; end_reason: string; same: boolean; ended_by_user_id: string | null }[]>`
    SELECT state, end_reason, ended_at = expires_at AS same, ended_by_user_id FROM swarm.seat_admin_grants WHERE grant_id = ${grantId}::uuid`;
  assert.deepEqual({ ...row }, { state: "expired", end_reason: "expired", same: true, ended_by_user_id: null });
  assert.equal(await expire(), false, "and only once");
});

test("the command role learns only whether a person is a live owner of a live organization", async () => {
  const ask = (role: string, org: string, user: string) => sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    return (await tx<{ r: unknown }[]>`SELECT swarm.seat_admin_org_owner(${org}::uuid, ${user}::uuid) AS r`)[0]!.r;
  });
  assert.deepEqual(await ask("swarm_command", workspaceA, owner), { archived: false, owner: true }, "the founder owns the organization");
  assert.deepEqual(await ask("swarm_command", workspaceA, other), { archived: false, owner: false });
  assert.equal(await ask("swarm_command", randomUUID(), owner), null, "an unknown organization");
  for (const role of ["authenticated", "anon", "swarm_read"]) {
    await assert.rejects(() => ask(role, workspaceA, owner), /permission denied/, role);
  }
});
