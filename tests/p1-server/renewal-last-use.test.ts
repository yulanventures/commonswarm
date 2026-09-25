/**
 * Concurrent grant use against real Postgres, including the row-lock order that
 * made the served read edge return 500. Reached by test:p1-server's glob.
 * The lead owns the local stack and applies the migration before running this.
 */
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

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
}

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10_000,
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(parsed.API_URL?.startsWith("http://127.0.0.1:"), "local API only");
  assert.ok(parsed.DB_URL && parsed.ANON_KEY);
  const db = new URL(parsed.DB_URL);
  assert.ok(["127.0.0.1", "localhost"].includes(db.hostname), "local DB only");
  return parsed as LocalEnvironment;
}

function token(): string {
  return `swm_agt_${randomBytes(32).toString("base64url")}`;
}

function stopProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

test("blocked grant use stays monotonic through SQL and the served read edge", { timeout: 45_000 }, async () => {
  const local = localEnvironment();
  const options = { prepare: false, max: 1, connect_timeout: 5 };
  const sql = postgres(local.DB_URL, options);
  const aSql = postgres(local.DB_URL, options);
  const bSql = postgres(local.DB_URL, options);
  const monitor = postgres(local.DB_URL, options);
  const user = randomUUID();
  const device = randomUUID();
  const workspace = randomUUID();
  const principal = randomUUID();
  const run = randomUUID();
  const grant = randomUUID();
  const tokenId = randomUUID();
  const secret = token();
  let aResult: Promise<{ error?: unknown }> | undefined;
  try {
    const functions = await sql<{ present: boolean }[]>`
      SELECT to_regprocedure('swarm.record_renewal_grant_use(uuid,uuid,text)') IS NOT NULL AS present
    `;
    assert.equal(functions[0]?.present, true, "standing-grant schema required");
    await sql`INSERT INTO auth.users (id, aud, role, email, encrypted_password,
      email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
      VALUES (${user}::uuid, 'authenticated', 'authenticated',
      ${`renewal-${user}@example.test`}, '', statement_timestamp(), '{}'::jsonb,
      '{}'::jsonb, statement_timestamp(), statement_timestamp())`;
    await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, 'Renewal race')`;
    await sql`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${user}::uuid, 'renewal-race')`;
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
      ${randomUUID()}::uuid, 1, '["post_signal"]'::jsonb,
      ${createHash("sha256").update(secret).digest()},
      statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid, ${grant}::uuid)`;

    await aSql`SET statement_timeout = '10s'`;
    const [{ pid }] = await aSql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
    let bStamp: Date | null = null;
    await bSql.begin(async (b) => {
      await b`SET LOCAL statement_timeout = '10s'`;
      await b`SELECT renewal_grant_id FROM swarm.renewal_grants
        WHERE renewal_grant_id = ${grant}::uuid FOR UPDATE`;
      // A's statement starts here and waits on B's row lock. Observe the wait
      // on its actual backend, rather than assuming a timer made it block.
      aResult = aSql`SELECT swarm.record_renewal_grant_use(
        ${tokenId}::uuid, ${device}::uuid, NULL)`.then(
          () => ({}), (error: unknown) => ({ error }),
        );
      const deadline = Date.now() + 5_000;
      let blocked = false;
      while (Date.now() < deadline) {
        const rows = await monitor<{ blocked: boolean; started_at: Date }[]>`
          SELECT wait_event_type = 'Lock' AS blocked, query_start AS started_at
          FROM pg_stat_activity WHERE pid = ${pid}`;
        if (rows[0]?.blocked) {
          blocked = true;
          break;
        }
        await delay(25);
      }
      assert.ok(blocked, "A must reach the grant row and block before B uses it");
      // Positive control: B records a real, later use while holding the lock.
      await b`SELECT swarm.record_renewal_grant_use(${tokenId}::uuid, ${device}::uuid, NULL)`;
      const rows = await b<{ last_used_at: Date }[]>`
        SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${grant}::uuid`;
      assert.ok(rows[0]?.last_used_at, "B must record use");
      bStamp = rows[0]!.last_used_at;
    });
    const result = await aResult;
    assert.equal(result?.error, undefined, "A must succeed after B commits");
    const rows = await sql<{ last_used_at: Date }[]>`
      SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${grant}::uuid`;
    assert.equal(rows[0]?.last_used_at?.getTime(), bStamp!.getTime(),
      "A's older statement must preserve B's later timestamp");

    // Served reproduction: the read edge reaches its membership-phase use
    // recorder while B holds the same row, then B records a later use.
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
    try {
      const deadline = Date.now() + 10_000;
      while (!logs.includes("Serving functions on")) {
        assert.ok(Date.now() < deadline, `read edge did not boot: ${logs.slice(-2000)}`);
        await delay(50);
      }
      await awaitFunctionRunning({
        url: `${local.API_URL}/functions/v1/read`, fetcher: fetch, timeoutMs: 10_000,
        sleep: (ms) => delay(ms), now: () => Date.now(),
        diagnostics: () => `read edge: ${logs.slice(-2000)}`,
      });
      let responsePromise: Promise<{ response?: Response; error?: unknown }> | undefined;
      await bSql.begin(async (b) => {
        await b`SET LOCAL statement_timeout = '5s'`;
        await b`SELECT renewal_grant_id FROM swarm.renewal_grants
          WHERE renewal_grant_id = ${grant}::uuid FOR UPDATE`;
        responsePromise = fetch(`${local.API_URL}/functions/v1/read`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, apikey: local.ANON_KEY,
            "content-type": "application/json" },
          body: JSON.stringify({ resource: "members", workspace_id: workspace }),
          signal: AbortSignal.timeout(7_000),
        }).then((response) => ({ response }), (error: unknown) => ({ error }));
        const waitDeadline = Date.now() + 3_000;
        let blocked = false;
        while (Date.now() < waitDeadline) {
          const rows = await monitor<{ blocked: boolean }[]>`
            SELECT wait_event_type = 'Lock' AS blocked FROM pg_stat_activity
            WHERE query LIKE '%SELECT swarm.record_renewal_grant_use(%'
              AND pid <> pg_backend_pid()`;
          if (rows.some((row) => row.blocked)) {
            blocked = true;
            break;
          }
          await delay(25);
        }
        assert.ok(blocked, "served read must block inside membership grant use");
        await b`SELECT swarm.record_renewal_grant_use(${tokenId}::uuid, ${device}::uuid, NULL)`;
        const rows = await b<{ last_used_at: Date }[]>`
          SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${grant}::uuid`;
        bStamp = rows[0]!.last_used_at;
      });
      const { response, error } = await responsePromise!;
      assert.equal(error, undefined, "served read must complete");
      assert.ok(response);
      assert.equal(response.status, 200, await response.text());
      const afterRead = await sql<{ last_used_at: Date }[]>`
        SELECT last_used_at FROM swarm.renewal_grants WHERE renewal_grant_id = ${grant}::uuid`;
      assert.equal(afterRead[0]?.last_used_at?.getTime(), bStamp!.getTime());
    } finally {
      const exited = child.exitCode === null
        ? new Promise<void>((resolve) => child.once("close", () => resolve()))
        : Promise.resolve();
      stopProcessGroup(child.pid, "SIGTERM");
      await Promise.race([exited, delay(2_000)]);
      // The CLI may have exited after spawning an edge worker. End the whole
      // dedicated group even if the CLI itself has already closed.
      stopProcessGroup(child.pid, "SIGKILL");
      rmSync(temp, { recursive: true, force: true });
    }
  } finally {
    if (aResult) await aResult;
    await Promise.all([sql, aSql, bSql, monitor].map((db) => db.end({ timeout: 5 })));
  }
});
