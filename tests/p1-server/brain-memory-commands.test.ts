/**
 * Brain M1: memory_save and memory_forget on the command edge, with SWARM_BRAIN_MEMORY on.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**). Needs the
 * local stack and an exclusive database slot.
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

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Fixture {
  workspaceA: string;
  workspaceB: string;
  ownerId: string;
  ownerJwt: string;
  otherJwt: string;
  principal: string;
  run: string;
  device: string;
  tokenId: string;
  agentToken: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let f: Fixture;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL &&
      parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

async function createUser(
  label: string,
): Promise<{ id: string; jwt: string }> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
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

async function fixture(): Promise<Fixture> {
  const owner = await createUser("memory-owner");
  const other = await createUser("memory-other");
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const device = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const tokenId = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'MemoryOwner'),
        (${other.id}::uuid, 'MemoryOther')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'memory-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'MemoryA', ${owner.id}::uuid),
        (${workspaceB}::uuid, 'MemoryB', ${other.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES
        (${workspaceA}::uuid, ${owner.id}::uuid, 'owner'),
        (${workspaceB}::uuid, ${other.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${randomUUID()}::uuid, ${workspaceA}::uuid, 'workspace'),
        (${randomUUID()}::uuid, ${workspaceB}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${principal}::uuid, ${workspaceA}::uuid, ${owner.id}::uuid, 'memory-agent'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${tokenId}::uuid, ${principal}::uuid, ${run}::uuid,
        ${tx.json(["create", "acquire", "submit", "post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspaceA,
    workspaceB,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    otherJwt: other.jwt,
    principal,
    run,
    device,
    tokenId,
    agentToken,
  };
}

async function postRead(
  bearer: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function postCommand(
  bearer: string,
  workspaceId: string,
  command: Record<string, unknown>,
  commandId = randomUUID(),
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-brain-memory-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\nSWARM_SELF_SERVE=1\nSWARM_BRAIN_MEMORY=1\n");
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const cliState = observeFunctionCli(functionProcess);
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(
          `functions serve never booted:\n${functionLogs.slice(-3000)}`,
        );
      }
      await delay(250);
    }
  }
  for (const fn of ["command", "read"]) {
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/${fn}`,
      fetcher: fetch,
      timeoutMs: 30_000,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      diagnostics: () => `${fn} function logs:\n${functionLogs.slice(-4000)}`,
      cliState,
    });
  }
  f = await fixture();
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill("SIGTERM");
    const stopped = await Promise.race([
      exited,
      delay(2_000).then(() => false),
    ]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});


/** A second agent in workspace A, owned by the same person, with its own token. */
async function secondAgent(): Promise<{ principal: string; token: string }> {
  const principal = randomUUID();
  const run = randomUUID();
  const token = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${f.workspaceA}::uuid, ${f.ownerId}::uuid, 'memory-agent-2')`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${f.device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${principal}::uuid, ${run}::uuid, ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(token).digest()}, statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
  });
  return { principal, token };
}

const save = (bearer: string, subject: string, statement: string, extra: Record<string, unknown> = {}, commandId?: ReturnType<typeof randomUUID>) =>
  postCommand(bearer, f.workspaceA, { kind: "memory_save", memory_kind: "convention", subject, statement, ...extra }, commandId);

async function versions(memoryId: string): Promise<Array<{ revision: number; action: string; editor_id: string }>> {
  return await sql`SELECT revision, action, editor_id::text FROM swarm.memory_versions
    WHERE memory_id = ${memoryId}::uuid ORDER BY revision`;
}

test("an agent's save is live; a duplicate adds nothing; an update needs the current revision", async () => {
  const subject = `release day ${randomUUID().slice(0, 8)}`;
  const created = await save(f.agentToken, subject, "Releases go out on Tuesdays.");
  assert.equal(created.status, 200, JSON.stringify(created.body) + functionLogs.slice(-2000));
  assert.equal(created.body.memory_outcome, "created");
  const memory = created.body.memory as { memory_id: string; revision: number; subject: string };
  assert.equal(memory.revision, 1);
  const [row] = await sql<{ author_kind: string; author_id: string; sponsor_user_id: string }[]>`
    SELECT author_kind, author_id::text, sponsor_user_id::text FROM swarm.memories WHERE memory_id = ${memory.memory_id}::uuid`;
  assert.deepEqual(row, { author_kind: "agent", author_id: f.principal, sponsor_user_id: f.ownerId }, "provenance from the credential");

  const duplicate = await save(f.agentToken, `  ${subject.toUpperCase()}  `, "Releases go out on Tuesdays.");
  assert.equal(duplicate.body.memory_outcome, "duplicate", "subjects are canonical; an exact match changes nothing");
  assert.equal((await versions(memory.memory_id)).length, 1);

  const unseen = await save(f.agentToken, subject, "Releases go out on Wednesdays.");
  assert.equal(unseen.status, 409);
  assert.equal(unseen.body.error, "memory_exists");
  assert.equal((unseen.body.memory as { revision: number }).revision, 1, "the current memory is shown, not overwritten");
  const stale = await save(f.agentToken, subject, "Releases go out on Wednesdays.", { expected_revision: 7 });
  assert.equal(stale.body.error, "memory_revision_conflict");

  const other = await secondAgent();
  const updated = await save(other.token, subject, "Releases go out on Wednesdays.", { expected_revision: 1 });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  assert.equal(updated.body.memory_outcome, "updated");
  assert.equal(updated.body.previous_statement, "Releases go out on Tuesdays.");
  const [after] = await sql<{ author_id: string; last_editor_id: string; revision: number }[]>`
    SELECT author_id::text, last_editor_id::text, revision FROM swarm.memories WHERE memory_id = ${memory.memory_id}::uuid`;
  assert.deepEqual(after, { author_id: f.principal, last_editor_id: other.principal, revision: 2 }, "an edit never changes the author");
  assert.deepEqual((await versions(memory.memory_id)).map((v) => v.action), ["save", "edit"]);

  const notMine = await postCommand(other.token, f.workspaceA, { kind: "memory_forget", memory_id: memory.memory_id });
  assert.equal(notMine.status, 404, "editing a memory never makes it the editor's to forget");
  const forgotten = await postCommand(f.agentToken, f.workspaceA, { kind: "memory_forget", memory_id: memory.memory_id });
  assert.equal(forgotten.status, 200, JSON.stringify(forgotten.body));
  assert.equal(forgotten.body.memory_outcome, "forgotten");
  const again = await postCommand(f.agentToken, f.workspaceA, { kind: "memory_forget", memory_id: memory.memory_id });
  assert.equal(again.status, 404);
  const [gone] = await sql<{ status: string }[]>`SELECT status FROM swarm.memories WHERE memory_id = ${memory.memory_id}::uuid`;
  assert.equal(gone!.status, "deleted");
});

test("an exact retry replays without a second version; a changed retry conflicts", async () => {
  const subject = `retry ${randomUUID().slice(0, 8)}`;
  const commandId = randomUUID();
  const first = await save(f.agentToken, subject, "Use the staging box for drills.", {}, commandId);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await save(f.agentToken, subject, "Use the staging box for drills.", {}, commandId);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body.memory, first.body.memory);
  const memoryId = (first.body.memory as { memory_id: string }).memory_id;
  assert.equal((await versions(memoryId)).length, 1);
  const changed = await save(f.agentToken, subject, "Something else.", {}, commandId);
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error, "command_id_conflict");
});

test("a person can save; a non-member cannot; bad input and the daily cap are refused", async () => {
  const mine = await save(f.ownerJwt, `owner note ${randomUUID().slice(0, 8)}`, "Prefer short PRs.");
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  const outsider = await save(f.otherJwt, `outsider ${randomUUID().slice(0, 8)}`, "Not my workspace.");
  assert.ok(outsider.status === 403 || outsider.status === 404, `outsider got ${outsider.status}`);

  for (const extra of [
    { evidence: ["http://example.test/a"] },
    { evidence: ["https://user:pass@example.test/a"] },
    { evidence: Array.from({ length: 6 }, (_, i) => `https://example.test/${i}`) },
    { author_id: f.ownerId },
    { memory_kind: "permission" },
  ]) {
    const refused = await save(f.agentToken, `bad ${randomUUID().slice(0, 8)}`, "x", extra);
    assert.equal(refused.status, 400, JSON.stringify(extra));
  }
  for (const subject of ["", "!!!", "x".repeat(121)]) {
    assert.equal((await save(f.agentToken, subject, "x")).status, 400, `subject ${subject.slice(0, 10)}`);
  }

  const capped = await secondAgent();
  const anchor = await save(capped.token, `cap anchor ${randomUUID().slice(0, 8)}`, "First.");
  const anchorId = (anchor.body.memory as { memory_id: string }).memory_id;
  await sql`INSERT INTO swarm.memory_versions (memory_id, workspace_id, revision, action, kind, statement, editor_kind, editor_id, sponsor_user_id)
    SELECT ${anchorId}::uuid, ${f.workspaceA}::uuid, n, 'edit', 'convention', 'filler', 'agent', ${capped.principal}::uuid, ${f.ownerId}::uuid
    FROM generate_series(2, 50) AS n`;
  const limited = await save(capped.token, `cap ${randomUUID().slice(0, 8)}`, "One too many.");
  assert.equal(limited.status, 429);
  assert.equal(limited.body.error, "memory_rate_limited");
});

test("a forget hides the memory from detail reads and from every replay, including another agent's edit receipt", async () => {
  const subject = `forget replay ${randomUUID().slice(0, 8)}`;
  const saveId = randomUUID();
  const saved = await save(f.agentToken, subject, "Secret plan A.", {}, saveId);
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const memoryId = (saved.body.memory as { memory_id: string }).memory_id;
  const other = await secondAgent();
  const editId = randomUUID();
  const edited = await save(other.token, subject, "Secret plan B.", { expected_revision: 1 }, editId);
  assert.equal(edited.body.memory_outcome, "updated");
  const forgotten = await postCommand(f.agentToken, f.workspaceA, { kind: "memory_forget", memory_id: memoryId });
  assert.equal(forgotten.status, 200, JSON.stringify(forgotten.body));
  const versionCount = (await versions(memoryId)).length;

  for (const [bearer, statement, id] of [
    [other.token, "Secret plan B.", editId], [f.agentToken, "Secret plan A.", saveId],
  ] as const) {
    const replay = await save(bearer, subject, statement, statement === "Secret plan B." ? { expected_revision: 1 } : {}, id);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.deepEqual(replay.body.memory, { memory_id: memoryId, status: "deleted" }, "a replay carries the id only");
    assert.equal(Object.hasOwn(replay.body, "previous_statement"), false);
    assert.doesNotMatch(JSON.stringify(replay.body), /Secret plan/);
  }
  assert.equal((await versions(memoryId)).length, versionCount, "a replay adds no version");

  const detail = await sql.begin(async (tx) => {
    await tx.unsafe("SET LOCAL ROLE authenticated");
    await tx`SELECT set_config('request.jwt.claims', ${JSON.stringify({ sub: f.ownerId, role: "authenticated" })}, true)`;
    return (await tx<{ r: unknown }[]>`SELECT swarm_read.memory_get(${f.workspaceA}::uuid, ${memoryId}::uuid) AS r`)[0]!.r;
  });
  assert.equal(detail, null, "a forgotten memory has no detail read");
});

test("a forget that commits between an update's read and its write wins: the update gets a 409, not a 500", async () => {
  const noActive = "There's no active memory with that subject to update. Save it without expected_revision.";
  for (const { name, forgetInBetween, status, outcome, actions } of [
    { name: "no forget", forgetInBetween: false, status: 200, outcome: "updated", actions: ["save", "edit"] },
    { name: "forget in between", forgetInBetween: true, status: 409, outcome: "memory_revision_conflict", actions: ["save", "forget"] },
  ]) {
    const subject = `race ${randomUUID().slice(0, 8)}`;
    const saved = await save(f.agentToken, subject, "Deploy from main.");
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const memoryId = (saved.body.memory as { memory_id: string }).memory_id;
    const update = () => save(f.agentToken, subject, "Deploy from release.", { expected_revision: 1 });
    let result: Awaited<ReturnType<typeof update>>;
    if (!forgetInBetween) {
      result = await update();
    } else {
      // The forget's own statements, held open until the update has read revision 1 and is waiting on the row.
      let pending!: Promise<Awaited<ReturnType<typeof update>>>;
      await sql.begin(async (tx) => {
        const [{ pid }] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`UPDATE swarm.memories SET status = 'deleted', deleted_at = statement_timestamp(), revision = revision + 1,
          updated_at = statement_timestamp() WHERE memory_id = ${memoryId}::uuid`;
        await tx`INSERT INTO swarm.memory_versions (memory_id, workspace_id, revision, action, kind, statement, editor_kind, editor_id, sponsor_user_id)
          VALUES (${memoryId}::uuid, ${f.workspaceA}::uuid, 2, 'forget', 'convention', 'Deploy from main.', 'agent', ${f.principal}::uuid, ${f.ownerId}::uuid)`;
        pending = update();
        const deadline = Date.now() + 20_000;
        while ((await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE ${pid}::int = ANY(pg_blocking_pids(pid))`)[0]!.n === 0) {
          assert.ok(Date.now() < deadline, `the update never waited on the forget:\n${functionLogs.slice(-2000)}`);
          await delay(50);
        }
      });
      result = await pending;
    }
    assert.equal(result.status, status, `${name}: ${JSON.stringify(result.body)}\n${functionLogs.slice(-2000)}`);
    if (status === 200) assert.equal(result.body.memory_outcome, outcome, name);
    else assert.deepEqual(result.body, { error: outcome, message: noActive }, name);
    assert.deepEqual((await versions(memoryId)).map((v) => v.action), actions, `${name}: one writer, one version`);
  }
});

test("cap refusals name only remedies that exist", async () => {
  const tag = randomUUID().slice(0, 8);
  const fillers: string[] = [];
  try {
    for (const { code, fill, message } of [
      {
        code: "memory_limit",
        message: "A workspace can hold 500 memories. Whoever saved a memory can forget it to make room.",
        fill: async () => {
          const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.memories
            WHERE workspace_id = ${f.workspaceA}::uuid AND status = 'active'`;
          const rows = await sql<{ memory_id: string }[]>`INSERT INTO swarm.memories (memory_id, workspace_id, subject_key, kind, statement,
              revision, author_kind, author_id, sponsor_user_id, last_editor_kind, last_editor_id, review_at)
            SELECT gen_random_uuid(), ${f.workspaceA}::uuid, ${`filler ${tag} `} || g, 'fact', 'Filler.', 1, 'user', ${f.ownerId}::uuid,
              ${f.ownerId}::uuid, 'user', ${f.ownerId}::uuid, statement_timestamp() + interval '90 days'
            FROM generate_series(1, ${500 - n}::int) AS g RETURNING memory_id::text`;
          fillers.push(...rows.map((row) => row.memory_id));
        },
      },
      {
        code: "memory_history_full",
        message: "This workspace's memory history is full, so no more memories can be saved or changed.",
        fill: async () => {
          const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM swarm.memory_versions
            WHERE workspace_id = ${f.workspaceA}::uuid`;
          await sql`INSERT INTO swarm.memory_versions (memory_id, workspace_id, revision, action, kind, statement, editor_kind, editor_id, sponsor_user_id)
            SELECT ${fillers[0]!}::uuid, ${f.workspaceA}::uuid, g, 'edit', 'fact', 'Filler.', 'user', ${f.ownerId}::uuid, ${f.ownerId}::uuid
            FROM generate_series(2, ${5001 - n}::int) AS g`;
        },
      },
    ]) {
      await fill();
      const refused = await save(f.ownerJwt, `over cap ${tag} ${code.length}`, "One too many.");
      assert.equal(refused.status, 409, `${code}: ${JSON.stringify(refused.body)}`);
      assert.deepEqual(refused.body, { error: code, message }, code);
    }
  } finally {
    if (fillers.length) await sql`DELETE FROM swarm.memories WHERE memory_id IN ${sql(fillers)}`;
  }
});

test("Brain M3: an agent reads memory through the read edge; people, bad input and other workspaces get nothing", async () => {
  const tag = randomUUID().slice(0, 8);
  const subject = `read edge ${tag}`;
  const saved = await save(f.agentToken, subject, `Deploys need a backup first ${tag}.`, { evidence: ["https://example.com/runbook"] });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const memoryId = (saved.body.memory as { memory_id: string }).memory_id;

  const search = await postRead(f.agentToken, { resource: "memory_search", workspace_id: f.workspaceA, query: `BACKUP FIRST ${tag}` });
  assert.equal(search.status, 200, JSON.stringify(search.body) + functionLogs.slice(-2000));
  assert.equal(search.body.untrusted_content, true);
  const rows = search.body.memories as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => row.memory_id), [memoryId]);
  assert.deepEqual(rows[0]!.author, { kind: "agent", id: f.principal });
  assert.deepEqual(rows[0]!.evidence, ["https://example.com/runbook"]);

  const listed = await postRead(f.agentToken, { resource: "memory_search", workspace_id: f.workspaceA, limit: 1 });
  assert.equal(listed.status, 200);
  assert.equal((listed.body.memories as unknown[]).length, 1);

  const detail = await postRead(f.agentToken, { resource: "memory_get", workspace_id: f.workspaceA, memory_id: memoryId.toUpperCase() });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.untrusted_content, true);
  assert.equal((detail.body.memory as { subject: string }).subject, subject);
  assert.deepEqual((detail.body.versions as Array<{ action: string }>).map((row) => row.action), ["save"]);

  const unknown = await postRead(f.agentToken, { resource: "memory_get", workspace_id: f.workspaceA, memory_id: randomUUID() });
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, "not_found");

  for (const body of [
    { resource: "memory_search", workspace_id: f.workspaceA, query: "x".repeat(201) },
    { resource: "memory_search", workspace_id: f.workspaceA, limit: 51 },
    { resource: "memory_search", workspace_id: f.workspaceA, query: 7 },
    { resource: "memory_search", workspace_id: f.workspaceA, include_deleted: true },
    { resource: "memory_get", workspace_id: f.workspaceA },
    { resource: "memory_get", workspace_id: f.workspaceA, memory_id: "not-a-uuid" },
  ]) {
    const refused = await postRead(f.agentToken, body);
    assert.equal(refused.status, 400, JSON.stringify(body));
  }

  // Another workspace: no rows and no detail, whatever the agent asks for.
  const elsewhere = await postRead(f.agentToken, { resource: "memory_search", workspace_id: f.workspaceB });
  assert.ok(elsewhere.status !== 200 || (elsewhere.body.memories as unknown[]).length === 0, JSON.stringify(elsewhere.body));
  const elsewhereGet = await postRead(f.agentToken, { resource: "memory_get", workspace_id: f.workspaceB, memory_id: memoryId });
  assert.notEqual(elsewhereGet.status, 200);
  assert.doesNotMatch(JSON.stringify(elsewhereGet.body), /backup/);

  // People read memory in the app, not through this edge.
  const person = await postRead(f.ownerJwt, { resource: "memory_search", workspace_id: f.workspaceA });
  assert.equal(person.status, 401);

  // A forgotten memory leaves every agent read at once.
  const forgotten = await postCommand(f.agentToken, f.workspaceA, { kind: "memory_forget", memory_id: memoryId });
  assert.equal(forgotten.status, 200, JSON.stringify(forgotten.body));
  const after = await postRead(f.agentToken, { resource: "memory_search", workspace_id: f.workspaceA, query: tag });
  assert.deepEqual(after.body.memories, []);
  const gone = await postRead(f.agentToken, { resource: "memory_get", workspace_id: f.workspaceA, memory_id: memoryId });
  assert.equal(gone.status, 404);
});
