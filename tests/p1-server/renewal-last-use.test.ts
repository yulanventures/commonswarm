/** Concurrent grant uses against the local PostgreSQL stack and served read edge. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import postgres from "postgres";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string }
interface Fixture {
  workspace: string;
  grant: string;
  tokenId: string;
  principal: string;
  run: string;
  task: string;
  lineage: string;
  device: string;
  otherDevice: string;
  secret: string;
}

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"), "local API only");
  assert.ok(parsed.DB_URL && parsed.ANON_KEY);
  assert.ok(["127.0.0.1", "localhost"].includes(new URL(parsed.DB_URL).hostname), "local DB only");
  return parsed as LocalEnvironment;
}

async function seed(sql: postgres.Sql): Promise<Fixture> {
  const user = randomUUID();
  const device = randomUUID();
  const otherDevice = randomUUID();
  const workspace = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const grant = randomUUID();
  const tokenId = randomUUID();
  const task = randomUUID();
  const lineage = randomUUID();
  const secret = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const functions = await sql<{ present: boolean }[]>`
    SELECT to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)') IS NOT NULL AS present`;
  assert.equal(functions[0]?.present, true, "standing-grant schema required");
  await sql`INSERT INTO auth.users (id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (${user}::uuid, 'authenticated', 'authenticated',
    ${`renewal-${user}@example.test`}, '', statement_timestamp(), '{}'::jsonb,
    '{}'::jsonb, statement_timestamp(), statement_timestamp())`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, 'Renewal race')`;
  await sql`INSERT INTO swarm.devices (device_id, user_id, label)
    VALUES (${device}::uuid, ${user}::uuid, 'renewal-race'),
           (${otherDevice}::uuid, ${user}::uuid, 'renewal-race-other')`;
  await sql`INSERT INTO swarm.workspaces (workspace_id, name, created_by)
    VALUES (${workspace}::uuid, 'Renewal race', ${user}::uuid)`;
  await sql`INSERT INTO swarm.memberships (workspace_id, user_id, role)
    VALUES (${workspace}::uuid, ${user}::uuid, 'owner')`;
  await sql`INSERT INTO swarm.agent_principals (principal_id, workspace_id, name, owner_user_id)
    VALUES (${principal}::uuid, ${workspace}::uuid, 'renewal-race', ${user}::uuid)`;
  await sql`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
    VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
  await sql`INSERT INTO swarm.renewal_grants (renewal_grant_id, workspace_id,
    principal_id, run_id, kind, max_successors, successors_used,
    horizon_expires_at, bound_device_id, created_by)
    VALUES (${grant}::uuid, ${workspace}::uuid, ${principal}::uuid,
    ${run}::uuid, 'standing', NULL, 0, NULL, ${device}::uuid, ${user}::uuid)`;
  await sql`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id,
    task_id, epoch, scopes, token_hash, expires_at, lineage_id, renewal_grant_id)
    VALUES (${tokenId}::uuid, ${principal}::uuid, ${run}::uuid,
    ${task}::uuid, 1, '["post_signal"]'::jsonb,
    ${createHash("sha256").update(secret).digest()},
    statement_timestamp() + interval '1 hour', ${lineage}::uuid, ${grant}::uuid)`;
  return { workspace, grant, tokenId, principal, run, task, lineage, device, otherDevice, secret };
}

async function waitForGrantLock(
  monitor: postgres.Sql, blockerPid: number, deadlineMs: number,
  waitingPid: number | null = null, mode = "RowExclusiveLock", query = "%record_renewal_grant_use%",
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const rows = await monitor<{ blocked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity AS a
        WHERE a.wait_event_type = 'Lock'
          AND ${blockerPid} = ANY (pg_blocking_pids(a.pid))
          AND (${waitingPid}::integer IS NULL OR a.pid = ${waitingPid}::integer)
          AND a.query LIKE ${query}
          AND EXISTS (
            SELECT 1 FROM pg_locks AS l
            WHERE l.pid = a.pid
              AND l.relation = 'swarm.renewal_grants'::regclass
              AND l.mode = ${mode} AND l.granted
          )
      ) AS blocked`;
    if (rows[0]?.blocked) return;
    await delay(25);
  }
  assert.fail("use must wait on this grant's blocker with a renewal_grants row-update lock");
}

function stopProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try { process.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

const options = { prepare: false, max: 1, connect_timeout: 5 };

test("older SQL use with another device and source leaves the newer use intact", { timeout: 25_000 }, async () => {
  const local = localEnvironment();
  const sql = postgres(local.DB_URL, options);
  const aSql = postgres(local.DB_URL, options);
  const bSql = postgres(local.DB_URL, options);
  const monitor = postgres(local.DB_URL, options);
  let aResult: Promise<{ error?: unknown }> | undefined;
  try {
    const f = await seed(sql);
    await aSql`SET statement_timeout = '10s'`;
    const [{ pid: aPid }] = await aSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    let bStamp: Date | null = null;
    await bSql.begin(async (b) => {
      await b`SET LOCAL statement_timeout = '10s'`;
      const [{ pid: bPid }] = await b<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await b`SELECT renewal_grant_id FROM swarm.renewal_grants
        WHERE renewal_grant_id = ${f.grant}::uuid FOR UPDATE`;
      // A starts first, then waits while B records a later use.
      aResult = aSql`SELECT swarm.record_renewal_grant_use(
        ${f.tokenId}::uuid, ${f.otherDevice}::uuid, 'older')`.then(
          () => ({}), (error: unknown) => ({ error }),
        );
      await waitForGrantLock(monitor, bPid, 5_000, aPid);
      await b`SELECT swarm.record_renewal_grant_use(${f.tokenId}::uuid, ${f.device}::uuid, 'newer')`;
      const rows = await b<{ last_used_at: Date }[]>`
        SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${f.grant}::uuid`;
      assert.ok(rows[0]?.last_used_at, "positive control: B records a later use");
      bStamp = rows[0]!.last_used_at;
    });
    const result = await aResult;
    assert.equal(result?.error, undefined, "older use must succeed as a no-op");
    const rows = await sql<{
      last_used_at: Date; last_used_device_id: string; last_used_from: string; new_host_at: Date | null;
    }[]>`SELECT last_used_at, last_used_device_id, last_used_from, new_host_at
      FROM swarm.renewal_grants WHERE renewal_grant_id = ${f.grant}::uuid`;
    assert.equal(rows[0]?.last_used_at?.getTime(), bStamp!.getTime());
    assert.equal(rows[0]?.last_used_device_id, f.device);
    assert.equal(rows[0]?.last_used_from, "newer");
    assert.equal(rows[0]?.new_host_at, null);
  } finally {
    if (aResult) await aResult;
    await Promise.all([sql, aSql, bSql, monitor].map((db) => db.end({ timeout: 5 })));
  }
});

test("older successor use preserves newer fields while still spending capacity", { timeout: 25_000 }, async () => {
  const local = localEnvironment();
  const sql = postgres(local.DB_URL, options);
  const aSql = postgres(local.DB_URL, options);
  const bSql = postgres(local.DB_URL, options);
  const monitor = postgres(local.DB_URL, options);
  let aResult: Promise<{ error?: unknown }> | undefined;
  try {
    const f = await seed(sql);
    await aSql`SET statement_timeout = '10s'`;
    const [{ pid: aPid }] = await aSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    let bStamp: Date | null = null;
    await bSql.begin(async (b) => {
      await b`SET LOCAL statement_timeout = '10s'`;
      const [{ pid: bPid }] = await b<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await b`SELECT renewal_grant_id FROM swarm.renewal_grants
        WHERE renewal_grant_id = ${f.grant}::uuid FOR UPDATE`;
      aResult = aSql`INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id,
        task_id, epoch, scopes, token_hash, expires_at, lineage_id,
        renewal_grant_id, predecessor_token_id)
        VALUES (${randomUUID()}::uuid, ${f.principal}::uuid, ${f.run}::uuid,
        ${f.task}::uuid, 1, '["post_signal"]'::jsonb,
        ${createHash("sha256").update(randomBytes(32)).digest()},
        statement_timestamp() + interval '1 hour', ${f.lineage}::uuid,
        ${f.grant}::uuid, ${f.tokenId}::uuid)`.then(
          () => ({}), (error: unknown) => ({ error }),
        );
      await waitForGrantLock(monitor, bPid, 5_000, aPid, "RowShareLock", "%INSERT INTO swarm.agent_tokens%");
      await b`SELECT swarm.record_renewal_grant_use(
        ${f.tokenId}::uuid, ${f.otherDevice}::uuid, 'newer')`;
      const rows = await b<{ last_used_at: Date }[]>`
        SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${f.grant}::uuid`;
      assert.ok(rows[0]?.last_used_at, "positive control: B records a later use");
      bStamp = rows[0]!.last_used_at;
    });
    const result = await aResult;
    assert.equal(result?.error, undefined, "successor must still issue");
    const rows = await sql<{
      successors_used: number; last_used_at: Date; last_used_device_id: string;
      last_used_from: string; new_host_at: Date | null;
    }[]>`SELECT successors_used, last_used_at, last_used_device_id,
      last_used_from, new_host_at FROM swarm.renewal_grants
      WHERE renewal_grant_id = ${f.grant}::uuid`;
    assert.equal(rows[0]?.successors_used, 1);
    assert.equal(rows[0]?.last_used_at?.getTime(), bStamp!.getTime());
    assert.equal(rows[0]?.last_used_device_id, f.otherDevice);
    assert.equal(rows[0]?.last_used_from, "newer");
    assert.equal(rows[0]?.new_host_at?.getTime(), bStamp!.getTime());
  } finally {
    if (aResult) await aResult;
    await Promise.all([sql, aSql, bSql, monitor].map((db) => db.end({ timeout: 5 })));
  }
});

test("served member read survives an older blocked use", { timeout: 90_000 }, async () => {
  const local = localEnvironment();
  const sql = postgres(local.DB_URL, options);
  const bSql = postgres(local.DB_URL, options);
  const monitor = postgres(local.DB_URL, options);
  const temp = mkdtempSync(join(tmpdir(), "cswarm-renewal-last-use-"));
  const envFile = join(temp, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n");
  let logs = "";
  const child = spawn("supabase", ["functions", "serve", "--no-verify-jwt", "--env-file", envFile], {
    cwd: process.cwd(), env: { ...process.env, HOME: temp,
      XDG_STATE_HOME: join(temp, "state"), SWARM_ENV: "test" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-20_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let responsePromise: Promise<{ response?: Response; error?: unknown }> | undefined;
  try {
    const f = await seed(sql);
    const deadline = Date.now() + 60_000;
    while (!logs.includes("Serving functions on")) {
      assert.ok(Date.now() < deadline, `read edge did not boot: ${logs.slice(-2000)}`);
      await delay(50);
    }
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/read`, fetcher: fetch, timeoutMs: 10_000,
      sleep: (ms) => delay(ms), now: () => Date.now(),
      diagnostics: () => `read edge: ${logs.slice(-2000)}`,
    });
    let bStamp: Date | null = null;
    await bSql.begin(async (b) => {
      await b`SET LOCAL statement_timeout = '8s'`;
      const [{ pid: bPid }] = await b<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
      await b`SELECT renewal_grant_id FROM swarm.renewal_grants
        WHERE renewal_grant_id = ${f.grant}::uuid FOR UPDATE`;
      responsePromise = fetch(`${local.API_URL}/functions/v1/read`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.secret}`, apikey: local.ANON_KEY,
          "content-type": "application/json" },
        body: JSON.stringify({ resource: "members", workspace_id: f.workspace }),
        signal: AbortSignal.timeout(10_000),
      }).then((response) => ({ response }), (error: unknown) => ({ error }));
      await waitForGrantLock(monitor, bPid, 5_000);
      await b`SELECT swarm.record_renewal_grant_use(${f.tokenId}::uuid, ${f.device}::uuid, NULL)`;
      const rows = await b<{ last_used_at: Date }[]>`
        SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${f.grant}::uuid`;
      assert.ok(rows[0]?.last_used_at, "positive control: B records use");
      bStamp = rows[0]!.last_used_at;
    });
    const { response, error } = await responsePromise!;
    assert.equal(error, undefined, "served read must complete");
    assert.ok(response);
    assert.equal(response.status, 200, await response.text());
    const rows = await sql<{ last_used_at: Date }[]>`
      SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${f.grant}::uuid`;
    assert.equal(rows[0]?.last_used_at?.getTime(), bStamp!.getTime());
  } finally {
    if (responsePromise) await responsePromise;
    const exited = child.exitCode === null
      ? new Promise<void>((resolve) => child.once("close", () => resolve()))
      : Promise.resolve();
    stopProcessGroup(child.pid, "SIGTERM");
    await Promise.race([exited, delay(2_000)]);
    stopProcessGroup(child.pid, "SIGKILL");
    rmSync(temp, { recursive: true, force: true });
    await Promise.all([sql, bSql, monitor].map((db) => db.end({ timeout: 5 })));
  }
});
