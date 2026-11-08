/** Brain M1: workspace memories. The schema keeps the original author fixed and one active memory
 * per subject; swarm_read.memory_search and memory_get admit only a live member, or an agent bound
 * to that workspace, and mark every row as untrusted content. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import postgres from "postgres";

let sql: postgres.Sql;

before(() => {
  const status = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(status.DB_URL).hostname));
  sql = postgres(status.DB_URL, { prepare: false, max: 2 });
});

after(async () => { await sql.end(); });

async function person(name: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO auth.users (id, aud, role, email) VALUES (${id}::uuid, 'authenticated', 'authenticated', ${`brain-${id}@example.test`})`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${id}::uuid, ${name})`;
  return id;
}

async function workspace(owner: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES (${id}::uuid, 'Brain test', ${owner}::uuid)`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES (${id}::uuid, ${owner}::uuid, 'owner')`;
  return id;
}

async function agent(ws: string, owner: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name, transport, turn_only)
    VALUES (${id}::uuid, ${ws}::uuid, ${owner}::uuid, 'Helper', 'local', false)`;
  await sql`INSERT INTO swarm.agent_workspace_memberships (principal_id, workspace_id, owner_user_id, added_by)
    VALUES (${id}::uuid, ${ws}::uuid, ${owner}::uuid, ${owner}::uuid) ON CONFLICT DO NOTHING`;
  return id;
}

async function memory(ws: string, author: { kind: "user" | "agent"; id: string }, sponsor: string, subject: string,
  statement: string, status: "active" | "deleted" = "active"): Promise<string> {
  const id = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.memories (memory_id, workspace_id, subject_key, kind, statement, status, revision,
        author_kind, author_id, sponsor_user_id, last_editor_kind, last_editor_id, review_at, deleted_at)
      VALUES (${id}::uuid, ${ws}::uuid, ${subject}, 'convention', ${statement}, ${status}, 1,
        ${author.kind}, ${author.id}::uuid, ${sponsor}::uuid, ${author.kind}, ${author.id}::uuid,
        statement_timestamp() + interval '90 days', ${status === "deleted" ? tx`statement_timestamp()` : null})`;
    await tx`INSERT INTO swarm.memory_versions (memory_id, workspace_id, revision, action, kind, statement,
        editor_kind, editor_id, sponsor_user_id)
      VALUES (${id}::uuid, ${ws}::uuid, 1, 'save', 'convention', ${statement}, ${author.kind}, ${author.id}::uuid, ${sponsor}::uuid)`;
  });
  return id;
}

type Search = { untrusted_content: boolean; memories: Array<Record<string, unknown>> } | null;

async function asCaller<T>(role: string, claims: Record<string, unknown>, query: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
  return await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ role: "authenticated", ...claims })}, true)`;
    return await query(tx);
  }) as T;
}

const search = (ws: string, claims: Record<string, unknown>, q: string | null = null, role = "authenticated") =>
  asCaller(role, claims, async (tx) => (await tx<{ r: Search }[]>`SELECT swarm_read.memory_search(${ws}::uuid, ${q}, 20) AS r`)[0]!.r);

test("a member and a bound agent search active memories with provenance and the untrusted marker", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner);
  const helper = await agent(ws, owner);
  await memory(ws, { kind: "agent", id: helper }, owner, "release day", "Releases go out on Tuesdays.");
  await memory(ws, { kind: "user", id: owner }, owner, "style guide", "Use role names, not personal names.");
  await memory(ws, { kind: "agent", id: helper }, owner, "old rule", "Forgotten.", "deleted");

  const asPerson = await search(ws, { sub: owner });
  assert.equal(asPerson?.untrusted_content, true);
  assert.deepEqual(asPerson?.memories.map((m) => m.subject).sort(), ["release day", "style guide"], "deleted memories never appear");
  const release = asPerson?.memories.find((m) => m.subject === "release day")!;
  assert.deepEqual(release.author, { kind: "agent", id: helper });
  assert.equal(release.sponsor_user_id, owner);

  const asAgent = await search(ws, { sub: owner, agent_principal_id: helper }, "tuesday", "swarm_read");
  assert.deepEqual(asAgent?.memories.map((m) => m.subject), ["release day"], "a plain substring filter");
});

test("reads refuse outsiders, other workspaces, unbound or revoked agents, and malformed claims alike", async () => {
  const owner = await person("Owner");
  const outsider = await person("Outsider");
  const ws = await workspace(owner);
  const other = await workspace(owner);
  const helper = await agent(ws, owner);
  const elsewhere = await agent(other, owner);
  const id = await memory(ws, { kind: "user", id: owner }, owner, "secret plan", "Only for this workspace.");

  assert.equal(await search(ws, { sub: outsider }), null);
  assert.equal(await search(ws, { sub: owner, agent_principal_id: elsewhere }, null, "swarm_read"), null, "an agent bound elsewhere");
  assert.equal(await search(ws, { sub: owner, agent_principal_id: "not-a-uuid" }), null);
  assert.equal(await search(ws, { sub: "nobody" }), null);
  assert.deepEqual((await search(other, { sub: owner }))?.memories, [], "another workspace's memories never cross");

  await sql`UPDATE swarm.agent_workspace_memberships SET revoked_at = statement_timestamp()
    WHERE principal_id = ${helper}::uuid AND workspace_id = ${ws}::uuid`;
  assert.equal(await search(ws, { sub: owner, agent_principal_id: helper }, null, "swarm_read"), null, "a removed agent loses access at once");

  const get = (workspaceId: string, claims: Record<string, unknown>) => asCaller("authenticated", claims, async (tx) =>
    (await tx<{ r: unknown }[]>`SELECT swarm_read.memory_get(${workspaceId}::uuid, ${id}::uuid) AS r`)[0]!.r);
  assert.ok(await get(ws, { sub: owner }));
  await sql`UPDATE swarm.memories SET status = 'deleted', deleted_at = statement_timestamp(), revision = revision + 1
    WHERE memory_id = ${id}::uuid`;
  assert.equal(await get(ws, { sub: owner }), null, "a forgotten memory has no detail read");
  await sql`UPDATE swarm.memories SET status = 'active', deleted_at = NULL, revision = revision + 1
    WHERE memory_id = ${id}::uuid`;
  assert.equal(await get(other, { sub: owner }), null, "an id from another workspace returns nothing");
  assert.equal(await get(ws, { sub: outsider }), null);

  for (const role of ["anon", "swarm_command"]) {
    await assert.rejects(() => search(ws, { sub: owner }, null, role), /permission denied/, role);
  }
  for (const role of ["authenticated", "anon", "swarm_read"]) {
    await assert.rejects(() => sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT 1 FROM swarm.memories LIMIT 1`;
    }), /permission denied/, `${role} has no direct table read`);
  }
});

test("memory_get returns versions newest first; the author and subject are fixed; one active memory per subject", async () => {
  const owner = await person("Owner");
  const ws = await workspace(owner);
  const helper = await agent(ws, owner);
  const id = await memory(ws, { kind: "agent", id: helper }, owner, "deploy window", "Deploy after 18:00.");
  await sql`UPDATE swarm.memories SET statement = 'Deploy after 19:00.', revision = 2,
      last_editor_kind = 'user', last_editor_id = ${owner}::uuid, updated_at = statement_timestamp()
    WHERE memory_id = ${id}::uuid`;
  await sql`INSERT INTO swarm.memory_versions (memory_id, workspace_id, revision, action, kind, statement, editor_kind, editor_id, sponsor_user_id)
    VALUES (${id}::uuid, ${ws}::uuid, 2, 'edit', 'convention', 'Deploy after 19:00.', 'user', ${owner}::uuid, ${owner}::uuid)`;
  const got = await asCaller("authenticated", { sub: owner }, async (tx) =>
    (await tx<{ r: { memory: Record<string, unknown>; versions: Array<{ revision: number }> } }[]>`SELECT swarm_read.memory_get(${ws}::uuid, ${id}::uuid) AS r`)[0]!.r);
  assert.deepEqual(got.versions.map((v) => v.revision), [2, 1]);
  assert.deepEqual(got.memory.author, { kind: "agent", id: helper }, "an edit by someone else keeps the original author");
  assert.deepEqual(got.memory.last_editor, { kind: "user", id: owner });

  for (const change of [sql`author_id = ${owner}::uuid`, sql`subject_key = 'other'`, sql`sponsor_user_id = ${helper}::uuid`]) {
    await assert.rejects(() => sql`UPDATE swarm.memories SET ${change}, revision = revision + 1 WHERE memory_id = ${id}::uuid`, /memory identity is fixed/);
  }
  await assert.rejects(() => sql`UPDATE swarm.memories SET statement = 'x' WHERE memory_id = ${id}::uuid`, /revision must increase/);
  await assert.rejects(() => memory(ws, { kind: "user", id: owner }, owner, "deploy window", "A second active one."), /memories_active_subject/);
  for (const bad of ["Deploy Window", " deploy", "deploy  window", ""]) {
    await assert.rejects(() => memory(ws, { kind: "user", id: owner }, owner, bad, "x"), /check/, `subject ${JSON.stringify(bad)}`);
  }
});
