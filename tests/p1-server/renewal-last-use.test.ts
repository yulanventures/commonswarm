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
import { createClient } from "@supabase/supabase-js";
import { awaitFunctionRunning, observeFunctionCli } from "../support/edge-readiness.js";

interface LocalEnvironment { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string }
interface Fixture {
  user: string;
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

async function seed(sql: postgres.Sql, existingUser?: string): Promise<Fixture> {
  const user = existingUser ?? randomUUID();
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
  if (!existingUser) {
  await sql`INSERT INTO auth.users (id, aud, role, email, encrypted_password,
    email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
    VALUES (${user}::uuid, 'authenticated', 'authenticated',
    ${`renewal-${user}@example.test`}, '', statement_timestamp(), '{}'::jsonb,
    '{}'::jsonb, statement_timestamp(), statement_timestamp())`;
  await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${user}::uuid, 'Renewal race')`;
  }
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
  return { user, workspace, grant, tokenId, principal, run, task, lineage, device, otherDevice, secret };
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

test("a wrong run device cannot overwrite an authorized use after its grant wait", { timeout: 25_000 }, async () => {
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
      await waitForGrantLock(monitor, bPid, 5_000, aPid, "RowShareLock");
      await b`SELECT swarm.record_renewal_grant_use(${f.tokenId}::uuid, ${f.device}::uuid, 'newer')`;
      // A future authorized observation is an independent monotonic floor:
      // the fresh post-wait request must not overwrite any of its fields.
      await b`UPDATE swarm.renewal_grants SET last_used_at=clock_timestamp()+interval '10 minutes'
        WHERE renewal_grant_id=${f.grant}::uuid`;
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

test("successor use takes a fresh post-wait clock while still spending capacity", { timeout: 25_000 }, async () => {
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
        ${f.tokenId}::uuid, ${f.device}::uuid, 'newer')`;
      // A future authorized observation is an independent monotonic floor:
      // the fresh post-wait request must not overwrite any of its fields.
      await b`UPDATE swarm.renewal_grants SET last_used_at=clock_timestamp()+interval '10 minutes'
        WHERE renewal_grant_id=${f.grant}::uuid`;
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
    assert.equal(rows[0]!.last_used_at.getTime(),bStamp!.getTime(),"successor preserves the independent future observation");
    assert.equal(rows[0]?.last_used_device_id, f.device);
    assert.equal(rows[0]?.last_used_from, "newer");
    assert.equal(rows[0]?.new_host_at, null);
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
    cwd: process.cwd(), env: { ...process.env,
      XDG_STATE_HOME: join(temp, "state"), SWARM_ENV: "test" },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const cliState = observeFunctionCli(child);
  const capture = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-20_000); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  let responsePromise: Promise<{ response?: Response; error?: unknown }> | undefined;
  try {
    const f = await seed(sql);
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/read`, fetcher: fetch, timeoutMs: 60_000,
      sleep: delay, now: () => Date.now(),
      diagnostics: () => `read edge: ${logs.slice(-2000)}`, cliState,
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
      await waitForGrantLock(monitor, bPid, 5_000, null, "RowShareLock", "%agent_delivery_read_context%");
      await b`SELECT swarm.record_renewal_grant_use(${f.tokenId}::uuid, ${f.device}::uuid, NULL)`;
      // A future authorized observation is an independent monotonic floor:
      // the fresh post-wait request must not overwrite any of its fields.
      await b`UPDATE swarm.renewal_grants SET last_used_at=clock_timestamp()+interval '10 minutes'
        WHERE renewal_grant_id=${f.grant}::uuid`;
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
    assert.equal(rows[0]!.last_used_at.getTime(),bStamp!.getTime(),"read preserves the independent future observation");
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

// Write-boundary contract: the trusted command DB role cannot attach an approval
// to an arbitrary FK, even when all human confirmation settings are well formed.
// These do not assert that SQL role/UUID settings authenticate a human over HTTP.
test("local approval binding is exact, immutable and column scoped", { timeout: 30_000 }, async () => {
  const sql = postgres(localEnvironment().DB_URL, options);
  try {
    const f = await seed(sql);
    const other = await seed(sql);
    const consent = randomUUID();
    const sameScopeForeignFamily = randomUUID();
    await sql`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,
      max_successors,successors_used,horizon_expires_at,bound_device_id,created_by)
      VALUES(${sameScopeForeignFamily}::uuid,${f.workspace}::uuid,${f.principal}::uuid,${f.run}::uuid,
        'standing',NULL,0,NULL,${f.device}::uuid,${f.user}::uuid)`;
    await sql`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose)
      VALUES(${f.workspace}::uuid,'shared')`;
    await sql`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES(${f.workspace}::uuid,${f.user}::uuid,'editor',${consent}::uuid,clock_timestamp())`;
    const command = (run: (tx: postgres.TransactionSql<Record<string, unknown>>) => Promise<unknown>) => sql.begin(async tx => {
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT set_config('cswarm.household_actor',${f.user},true),
        set_config('cswarm.household_request',${randomUUID()},true),
        set_config('cswarm.household_digest',${"a".repeat(64)},true),
        set_config('cswarm.household_command','household_approve_connection',true)`;
      return run(tx);
    });
    const insert = (family: string) => command(tx => tx`
      INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,
        purpose,operations,consent_receipt_id,expires_at,renewal_grant_id)
      VALUES(${f.tokenId}::uuid,${f.run}::uuid,${f.workspace}::uuid,${f.principal}::uuid,${f.user}::uuid,
        'shared',ARRAY['read'],${consent}::uuid,NULL,${family}::uuid)`);
    for (const family of [sameScopeForeignFamily,other.grant]) {
      await assert.rejects(insert(family), {code:"23514"}, "exact token family, including same-scope foreign family, required");
    }
    const before = await sql`SELECT count(*)::int AS n FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid`;
    await insert(f.grant); // Same-invocation positive under the identical DB role/audit path.
    const [approval] = await sql`SELECT renewal_grant_id,expires_at FROM swarm.household_content_connections WHERE connection_id=${f.tokenId}::uuid`;
    assert.equal(approval!.renewal_grant_id,f.grant);
    assert.equal(approval!.expires_at,null,"technical expiry is not persisted as chosen policy");
    const after = await sql`SELECT count(*)::int AS n FROM swarm.household_object_audit WHERE workspace_id=${f.workspace}::uuid`;
    assert.equal(after[0]!.n,before[0]!.n+1,"one approval audit commits with one approval");
    for (const family of [null,sameScopeForeignFamily,other.grant]) {
      await assert.rejects(command(tx => tx`UPDATE swarm.household_content_connections SET renewal_grant_id=${family}::uuid
        WHERE connection_id=${f.tokenId}::uuid`),{code:"23514"},"cannot clear or rebind an assigned family");
    }
    await assert.rejects(command(tx => tx`UPDATE swarm.household_content_connections SET workspace_id=${other.workspace}::uuid
      WHERE connection_id=${f.tokenId}::uuid`),{code:"42501"},"column grant does not authorize other scope writes");
    const [acl] = await sql`SELECT
      has_column_privilege('swarm_command','swarm.household_content_connections','renewal_grant_id','UPDATE') AS family,
      has_table_privilege('swarm_command','swarm.household_content_connections','UPDATE') AS whole,
      has_column_privilege('swarm_command','swarm.household_content_connections','owner_user_id','UPDATE') AS owner`;
    assert.deepEqual(acl,{family:true,whole:false,owner:false});
    const [unchanged] = await sql`SELECT renewal_grant_id FROM swarm.household_content_connections WHERE connection_id=${f.tokenId}::uuid`;
    assert.equal(unchanged!.renewal_grant_id,f.grant,"failed writes preserve exact binding");
    const terminal = await seed(sql);
    const terminalConsent = randomUUID();
    await sql`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES(${terminal.workspace}::uuid,'shared')`;
    await sql`INSERT INTO swarm.household_member_content_roles(workspace_id,user_id,content_role,content_consent_id,confirmed_at)
      VALUES(${terminal.workspace}::uuid,${terminal.user}::uuid,'editor',${terminalConsent}::uuid,clock_timestamp())`;
    // Chosen elapsed policy refuses even a still-live technical credential.
    await sql`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second'
      WHERE renewal_grant_id=${terminal.grant}::uuid`;
    await assert.rejects(sql.begin(async tx => {
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT set_config('cswarm.household_actor',${terminal.user},true),
        set_config('cswarm.household_request',${randomUUID()},true),set_config('cswarm.household_digest',${"b".repeat(64)},true),
        set_config('cswarm.household_command','household_approve_connection',true)`;
      await tx`INSERT INTO swarm.household_content_connections(connection_id,grant_id,workspace_id,principal_id,owner_user_id,
        purpose,operations,consent_receipt_id,renewal_grant_id)
        VALUES(${terminal.tokenId}::uuid,${terminal.run}::uuid,${terminal.workspace}::uuid,${terminal.principal}::uuid,${terminal.user}::uuid,
          'shared',ARRAY['read'],${terminalConsent}::uuid,${terminal.grant}::uuid)`;
    }),{code:"23514"});
    const [absent] = await sql`SELECT count(*)::int AS n FROM swarm.household_content_connections WHERE connection_id=${terminal.tokenId}::uuid`;
    assert.equal(absent!.n,0,"chosen expiry denial commits no approval");
  } finally { await sql.end({timeout:5}); }
});

test("local discovery refuses invalid selectors and preserves exact complete IDs under command role", {timeout:30_000}, async () => {
  const sql=postgres(localEnvironment().DB_URL,options);
  try {
    const f=await seed(sql), foreign=await seed(sql);
    const discover=(principals:string[],tokens:string[],all=false,user:string|null=null) =>
      sql.begin(async tx => {
        await tx`SET LOCAL ROLE swarm_command`;
        return tx`SELECT * FROM swarm.discover_local_target_ids(${f.workspace}::uuid,${user}::uuid,
          ${principals}::uuid[],${tokens}::uuid[],${all})`;
      });
    await assert.rejects(discover([],[]),{code:"22023"},"NULL/empty is never workspace-wide");
    await assert.rejects(discover([],Array(65).fill(f.tokenId)),{code:"22023"},"selector cap precedes deduplication");
    await assert.rejects(discover([f.principal],[f.tokenId],true),{code:"22023"},"mixed all-workspace selector refuses wholly");
    const exact=await discover([],[f.tokenId]);
    assert.equal(exact.length,1);
    assert.equal(exact[0]!.token_id,f.tokenId);
    assert.equal(exact[0]!.renewal_grant_id,f.grant);
    assert.equal(exact[0]!.owner_user_id,f.user);
    const noTokenGrant=randomUUID();
    await sql`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,
      successors_used,horizon_expires_at,bound_device_id,created_by)
      VALUES(${noTokenGrant}::uuid,${f.workspace}::uuid,${f.principal}::uuid,${f.run}::uuid,
        'standing',NULL,0,NULL,${f.device}::uuid,${f.user}::uuid)`;
    const all=await discover([],[],true);
    assert.ok(all.some(row=>row.token_id===null && row.renewal_grant_id===noTokenGrant),"grants without tokens remain in the closure");
    const names=["swarm.discover_local_credential_ids(bytea)","swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)",
      "swarm.discover_local_join_ids(bytea,uuid)","swarm.revoke_local_residual_tokens(uuid,uuid,text,uuid)"];
    for (const role of ["anon","authenticated","swarm_read"]) for (const name of names) {
      const [row]=await sql`SELECT has_function_privilege(${role},${name},'EXECUTE') AS allowed`;
      assert.equal(row!.allowed,false,`${role} cannot execute ${name}`);
    }
    const [positive]=await sql`SELECT has_function_privilege('swarm_command',
      'swarm.discover_local_target_ids(uuid,uuid,uuid[],uuid[],boolean)','EXECUTE') AS allowed`;
    assert.equal(positive!.allowed,true);
    for (const name of names) {
      const [catalog]=await sql`SELECT p.proowner='swarm_admin'::regrole AS owner,
        p.prosecdef AS definer,p.provolatile='v' AS fresh,
        p.proconfig @> ARRAY['search_path=pg_catalog']::text[] AS fixed_path,
        (SELECT count(*)=1 AND bool_and(a.grantee='swarm_command'::regrole
          AND a.privilege_type='EXECUTE' AND NOT a.is_grantable)
          FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) AS exact_acl
        FROM pg_proc p WHERE p.oid=${name}::regprocedure`;
      assert.deepEqual(catalog,{owner:true,definer:true,fresh:true,fixed_path:true,exact_acl:true});
    }
    for (const name of ["swarm.household_local_family_binding_guard()","swarm.renewal_grants_revoke_cascade()","swarm.local_content_approval_pointer_guard()"]) {
      const [privateRoutine]=await sql`SELECT p.proowner='swarm_admin'::regrole AS owner,p.prosecdef AS definer,
        (SELECT count(*)=0 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
          WHERE a.grantee<>p.proowner) AS private
        FROM pg_proc p WHERE p.oid=${name}::regprocedure`;
      assert.deepEqual(privateRoutine,{owner:true,definer:true,private:true});
    }
  } finally {await sql.end({timeout:5});}
});


test("residual revocation refuses live families and revokes only the authorized familyless lineage", {timeout:30_000}, async () => {
  const sql=postgres(localEnvironment().DB_URL,options);
  try {
    const f=await seed(sql),foreign=await seed(sql);
    const token=randomUUID(),lineage=randomUUID();
    await sql`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id)
      VALUES(${token}::uuid,${f.principal}::uuid,${f.run}::uuid,${f.task}::uuid,1,'["post_signal"]'::jsonb,
        ${createHash("sha256").update(randomBytes(32)).digest()},clock_timestamp()+interval '1 hour',${lineage}::uuid)`;
    const state=() => sql`SELECT token_id,revoked_at,first_used_at,expires_at FROM swarm.agent_tokens
      WHERE token_id IN (${token}::uuid,${f.tokenId}::uuid,${foreign.tokenId}::uuid) ORDER BY token_id`;
    const before=await state();
    const revoke=(target:string) => sql.begin(async tx => {
      await tx`SET LOCAL ROLE swarm_command`;
      // Complete closure for this deliberately parentless fixture. No hosted,
      // content, stream or session dependencies exist. All G precede every T.
      await tx`SELECT user_id FROM swarm.users WHERE user_id=${f.user}::uuid FOR NO KEY UPDATE`;
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${f.workspace}::uuid FOR SHARE`;
      await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${f.workspace}::uuid AND user_id=${f.user}::uuid FOR SHARE`;
      await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${f.principal}::uuid FOR UPDATE`;
      await tx`SELECT run_id FROM swarm.agent_runs WHERE run_id=${f.run}::uuid FOR SHARE`;
      await tx`SELECT device_id FROM swarm.devices WHERE device_id=${f.device}::uuid FOR SHARE`;
      await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${f.grant}::uuid FOR UPDATE`;
      await tx`SELECT token_id FROM swarm.agent_tokens WHERE principal_id=${f.principal}::uuid ORDER BY token_id FOR UPDATE`;
      await tx`SELECT swarm.revoke_local_residual_tokens(${f.workspace}::uuid,${f.user}::uuid,'revoke_agent_token',${target}::uuid)`;
    });
    await assert.rejects(revoke(f.tokenId),{code:"42501"},"live bound grants cannot use residual shortcut");
    await assert.rejects(revoke(foreign.tokenId),{code:"42501"},"scope mismatch denies whole operation");
    assert.deepEqual(await state(),before,"denials change neither target nor unrelated credentials");
    await revoke(token);
    const after=await state();
    const target=after.find(row=>row.token_id===token)!;
    assert.ok(target.revoked_at instanceof Date);
    assert.equal(target.first_used_at,null);
    assert.equal(target.expires_at.getTime(),before.find(row=>row.token_id===token)!.expires_at.getTime());
    for (const id of [f.tokenId,foreign.tokenId]) assert.deepEqual(after.find(row=>row.token_id===id),before.find(row=>row.token_id===id));
    const tombstones=await sql`SELECT kind,target_id,created_by FROM swarm.revocation_tombstones
      WHERE target_id IN (${token}::uuid,${lineage}::uuid) ORDER BY kind`;
    assert.deepEqual(tombstones.map(row=>[row.kind,row.target_id,row.created_by]),
      [["lineage",lineage,f.user],["token",token,f.user]]);
    await revoke(token);
    assert.deepEqual(await state(),after,"idempotent residual revoke preserves timestamps");
  } finally {await sql.end({timeout:5});}
});

// prepare is the owning SQL boundary for lazy idle suspension. A stale last
// use must not force human action; an owner-selected expiry still refuses.
test("perpetual standing renewal has no idle gate and chosen expiry stays terminal", {timeout:30_000},async()=>{
  const sql=postgres(localEnvironment().DB_URL,options);
  try {
    const f=await seed(sql);
    await sql`UPDATE swarm.renewal_grants SET last_used_at=clock_timestamp()-interval '90 days'
      WHERE renewal_grant_id=${f.grant}::uuid`;
    const prepare=(seat=f)=>sql.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      await tx`SELECT user_id FROM swarm.users WHERE user_id=${seat.user}::uuid FOR NO KEY UPDATE`;
      await tx`SELECT workspace_id FROM swarm.workspaces WHERE workspace_id=${seat.workspace}::uuid FOR SHARE`;
      await tx`SELECT user_id FROM swarm.memberships WHERE workspace_id=${seat.workspace}::uuid AND user_id=${seat.user}::uuid FOR SHARE`;
      await tx`SELECT principal_id FROM swarm.agent_principals WHERE principal_id=${seat.principal}::uuid FOR SHARE`;
      await tx`SELECT run_id FROM swarm.agent_runs WHERE run_id=${seat.run}::uuid FOR SHARE`;
      await tx`SELECT device_id FROM swarm.devices WHERE device_id=${seat.device}::uuid FOR SHARE`;
      await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${seat.grant}::uuid FOR UPDATE`;
      await tx`SELECT token_id FROM swarm.agent_tokens WHERE token_id=${seat.tokenId}::uuid FOR UPDATE`;
      const [result]=await tx`SELECT swarm.prepare_renewal_grant(${seat.grant}::uuid,${seat.device}::uuid) AS code`;
      return result!.code;
    });
    assert.equal(await prepare(),null,"ninety idle days require no resume");
    const [live]=await sql`SELECT suspension_active,suspended_at,connection_expired_at FROM swarm.renewal_grants WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.deepEqual(live,{suspension_active:false,suspended_at:null,connection_expired_at:null});
    await sql`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()+interval '1 day' WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.equal(await prepare(),null,"a future chosen date has no idle gate");
    await sql`UPDATE swarm.renewal_grants SET connection_expires_at=NULL WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.equal(await prepare(),null,"clearing a live future policy requires no resume");
    const paused=await seed(sql);
    await sql`UPDATE swarm.renewal_grants SET suspended_at=clock_timestamp() WHERE renewal_grant_id=${paused.grant}::uuid`;
    assert.equal(await prepare(paused),'renewal_grant_suspended','legacy pauses require explicit human recovery');
    const [history]=await sql`SELECT suspension_active,suspended_at,resumed_at,resumed_by,resume_count
      FROM swarm.renewal_grants WHERE renewal_grant_id=${paused.grant}::uuid`;
    assert.equal(history!.suspension_active,true);assert.ok(history!.suspended_at instanceof Date);
    assert.equal(history!.resumed_at,null);assert.equal(history!.resumed_by,null);assert.equal(history!.resume_count,0);
    await sql`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.equal(await prepare(),'renewal_grant_revoked');
    await sql`UPDATE swarm.renewal_grants SET connection_expires_at=NULL WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.equal(await prepare(),'renewal_grant_revoked',"clearing the date cannot revive terminal authority");
  } finally {await sql.end({timeout:5});}
});

test("read owner routine checks chosen deadline after a blocked family wait and rolls back adoption", {timeout:30_000},async()=>{
  const sql=postgres(localEnvironment().DB_URL,options),blocker=postgres(localEnvironment().DB_URL,options),
    reader=postgres(localEnvironment().DB_URL,options),monitor=postgres(localEnvironment().DB_URL,options);
  let pending:Promise<postgres.RowList<postgres.Row[]>>|undefined;
  try {
    const f=await seed(sql);
    const [before]=await sql`SELECT first_used_at,expires_at FROM swarm.agent_tokens WHERE token_id=${f.tokenId}::uuid`;
    await blocker.begin(async tx=>{
      const [{pid}]=await tx<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT renewal_grant_id FROM swarm.renewal_grants WHERE renewal_grant_id=${f.grant}::uuid FOR UPDATE`;
      pending=reader.begin(async r=>{
        await r`SET LOCAL ROLE swarm_read`;
        return r`SELECT * FROM swarm.agent_delivery_read_context(${createHash('sha256').update(f.secret).digest()},${f.workspace}::uuid)`;
      });
      await waitForGrantLock(monitor,pid,5000,null,'RowShareLock','%agent_delivery_read_context%');
      await tx`UPDATE swarm.renewal_grants SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE renewal_grant_id=${f.grant}::uuid`;
    });
    assert.equal((await pending!).length,0,"deadline committed during the wait refuses this invocation");
    const [after]=await sql`SELECT first_used_at,expires_at FROM swarm.agent_tokens WHERE token_id=${f.tokenId}::uuid`;
    assert.deepEqual(after,before,"a denied read adopts nothing");
    const control=await seed(sql);
    const result=await reader.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_read`;
      return tx`SELECT * FROM swarm.agent_delivery_read_context(${createHash('sha256').update(control.secret).digest()},${control.workspace}::uuid)`;
    });
    assert.equal(result.length,1,"same-role positive reaches the same owner routine");
    assert.equal(result[0]!.is_revoked,false);
    const [used]=await sql`SELECT first_used_at FROM swarm.agent_tokens WHERE token_id=${control.tokenId}::uuid`;
    assert.ok(used!.first_used_at instanceof Date);
  } finally {if(pending) await pending;await Promise.all([sql,blocker,reader,monitor].map(db=>db.end({timeout:5})));}
});

test("required active workspace closure accepts 2048 tokens and refuses 2049 without truncation",{timeout:45_000},async()=>{
  const sql=postgres(localEnvironment().DB_URL,options);
  try {
    const f=await seed(sql);
    await sql`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
      SELECT gen_random_uuid(),${f.principal}::uuid,${f.run}::uuid,${f.task}::uuid,1,'["post_signal"]'::jsonb,
        decode(lpad(to_hex(i),64,'0'),'hex'),clock_timestamp()+interval '1 hour',gen_random_uuid(),${f.grant}::uuid
      FROM generate_series(1,2047) i`;
    const discover=()=>sql.begin(async tx=>{
      await tx`SET LOCAL ROLE swarm_command`;
      return tx`SELECT token_id FROM swarm.discover_local_target_ids(${f.workspace}::uuid,NULL,ARRAY[]::uuid[],ARRAY[]::uuid[],true)`;
    });
    assert.equal((await discover()).length,2048,"exact token cap returns the complete set");
    await sql`INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,expires_at,lineage_id,renewal_grant_id)
      VALUES(gen_random_uuid(),${f.principal}::uuid,${f.run}::uuid,${f.task}::uuid,1,'["post_signal"]'::jsonb,
        ${createHash('sha256').update(randomBytes(32)).digest()},clock_timestamp()+interval '1 hour',gen_random_uuid(),${f.grant}::uuid)`;
    await assert.rejects(discover(),{code:'54000'},"cap+1 refuses rather than returning a partial closure");
    const [intact]=await sql`SELECT count(*)::int AS n,count(first_used_at)::int AS used,count(revoked_at)::int AS revoked
      FROM swarm.agent_tokens WHERE principal_id=${f.principal}::uuid`;
    assert.deepEqual(intact,{n:2049,used:0,revoked:0},"discovery has no adoption or revocation effects");
  } finally {await sql.end({timeout:5});}
});


// F1's primary regression: genuine predecessor succession, not duplicate roots.
// The old 946603f4 fails at HTTP renewal with 54000 after 2048 rotations.
test("long rotation history renews and reads; unrelated workspace history cannot block human removal",
  {timeout:180_000},async()=>{
  const local=localEnvironment(),sql=postgres(local.DB_URL,{...options,max:3});
  const temp=mkdtempSync(join(tmpdir(),"renewal-history-")),envFile=join(temp,"functions.env");
  writeFileSync(envFile,"SWARM_ENV=test\n");
  const child=spawn("supabase",["functions","serve","--no-verify-jwt","--env-file",envFile],{
    cwd:process.cwd(),env:{...process.env,SWARM_ENV:"test",XDG_STATE_HOME:join(temp,"state")},
    detached:true,stdio:["ignore","pipe","pipe"]});
  const cliState=observeFunctionCli(child);
  let logs="";child.stdout?.on("data",chunk=>{logs=(logs+chunk).slice(-20_000);});child.stderr?.on("data",chunk=>{logs=(logs+chunk).slice(-20_000);});
  const admin=createClient(local.API_URL,local.SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
  try {
    for(const name of ['command','read']) await awaitFunctionRunning({
      url:`${local.API_URL}/functions/v1/${name}`,fetcher:fetch,timeoutMs:60_000,
      sleep:delay,now:()=>Date.now(),diagnostics:()=>logs,cliState,
    });
    const makeHuman=async()=>{
      const email=`history-${randomUUID()}@example.test`,password=`H-${randomBytes(24).toString("base64url")}!`;
      const made=await admin.auth.admin.createUser({email,password,email_confirm:true});
      assert.equal(made.error,null);assert.ok(made.data.user);
      const client=createClient(local.API_URL,local.ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}});
      const signed=await client.auth.signInWithPassword({email,password});
      assert.equal(signed.error,null);assert.ok(signed.data.session);
      const user=made.data.user!.id;
      await sql`INSERT INTO swarm.users(user_id,display_name) VALUES(${user}::uuid,'History owner')`;
      return {user,jwt:signed.data.session!.access_token};
    };
    const owner=await makeHuman(),keeper=await makeHuman();
    const f=await seed(sql,owner.user),unrelated=await seed(sql);
    await sql`INSERT INTO swarm.streams(stream_id,workspace_id,kind)
      VALUES(${randomUUID()}::uuid,${f.workspace}::uuid,'workspace')`;
    await sql`INSERT INTO swarm.memberships(workspace_id,user_id,role)
      VALUES(${f.workspace}::uuid,${keeper.user}::uuid,'owner')`;
    await sql`UPDATE swarm.memberships SET role='member' WHERE workspace_id=${f.workspace}::uuid AND user_id=${owner.user}::uuid`;
    const call=async(token:string,command:Record<string,unknown>,commandId=randomUUID())=>{
      const response=await fetch(`${local.API_URL}/functions/v1/command`,{method:"POST",
        headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},
        body:JSON.stringify({command_id:commandId,client_version:"0.1.0",workspace_id:f.workspace,stream:{kind:"workspace"},command})});
      return {status:response.status,body:await response.json() as Record<string,unknown>};
    };
    await sql`UPDATE swarm.renewal_grants SET suspended_at=clock_timestamp() WHERE renewal_grant_id=${f.grant}::uuid`;
    const resumed=await call(owner.jwt,{kind:'resume_renewal_grant',renewal_grant_id:f.grant});
    assert.equal(resumed.status,200);assert.equal(resumed.body.status,'accepted');
    const [recovery]=await sql`SELECT suspension_active,resumed_by,resume_count,resumed_at>suspended_at AS later
      FROM swarm.renewal_grants WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.deepEqual(recovery,{suspension_active:false,resumed_by:owner.user,resume_count:1,later:true});
    const [resumeAudit]=await sql`SELECT count(*)::int AS n FROM swarm.audit_log
      WHERE workspace_id=${f.workspace}::uuid AND actor_user=${owner.user}::uuid
        AND command_kind='resume_renewal_grant' AND outcome='accepted'`;
    assert.equal(resumeAudit!.n,1,'one explicit human recovery is audited');
    const keeperConsent=await call(keeper.jwt,{kind:'household_permissions',purpose:'shared',content_role:'editor'});
    assert.equal(keeperConsent.body.status,'committed');
    const originalAllow=await call(owner.jwt,{kind:'household_permissions',purpose:'shared',content_role:'editor',
      connection:{kind:'local',connection_id:f.tokenId,grant_id:f.run,principal_id:f.principal,operations:['read']}});
    assert.equal(originalAllow.body.status,'committed','served original human consent');
    const originalApproval=await sql`SELECT consent_receipt_id,operations FROM swarm.household_content_connections
      WHERE connection_id=${f.tokenId}::uuid AND renewal_grant_id=${f.grant}::uuid`;
    const currentRaw=`swm_agt_${randomBytes(32).toString("base64url")}`;
    const currentHash=createHash("sha256").update(currentRaw).digest();
    const last=await sql.begin(async tx=>{
      await tx.unsafe(`CREATE FUNCTION pg_temp.rotation_history(root_id uuid,final_hash bytea) RETURNS uuid
        LANGUAGE plpgsql AS $fixture$
        DECLARE root swarm.agent_tokens%ROWTYPE; prior uuid; next_id uuid; i integer;
        BEGIN
          SELECT * INTO STRICT root FROM swarm.agent_tokens WHERE token_id=root_id;
          prior:=root_id;
          UPDATE swarm.agent_tokens SET first_used_at=clock_timestamp() WHERE token_id=prior;
          FOR i IN 1..2048 LOOP
            next_id:=gen_random_uuid();
            INSERT INTO swarm.agent_tokens(token_id,principal_id,run_id,task_id,epoch,scopes,token_hash,
              expires_at,lineage_id,renewal_grant_id,predecessor_token_id)
            VALUES(next_id,root.principal_id,root.run_id,root.task_id,root.epoch,root.scopes,
              CASE WHEN i=2048 THEN final_hash ELSE sha256(convert_to(next_id::text,'UTF8')) END,
              clock_timestamp()+interval '1 hour',root.lineage_id,root.renewal_grant_id,prior);
            UPDATE swarm.agent_tokens SET first_used_at=clock_timestamp() WHERE token_id=next_id;
            UPDATE swarm.agent_tokens SET expires_at=clock_timestamp() WHERE token_id=prior;
            prior:=next_id;
          END LOOP;
          RETURN prior;
        END $fixture$`);
      const [row]=await tx<{id:string}[]>`SELECT pg_temp.rotation_history(${f.tokenId}::uuid,${currentHash}) AS id`;
      await tx`SELECT pg_temp.rotation_history(${unrelated.tokenId}::uuid,${createHash('sha256').update(randomBytes(32)).digest()})`;
      return row!.id;
    });
    const [count]=await sql`SELECT count(*)::int AS n FROM swarm.agent_tokens WHERE renewal_grant_id=${f.grant}::uuid`;
    assert.equal(count!.n,2049,"actual historical predecessors remain");
    const renewed=await call(currentRaw,{kind:"renew_agent_token"});
    assert.equal(renewed.status,200);assert.equal(renewed.body.status,"accepted");
    assert.equal(typeof renewed.body.agent_token,"string");
    const read=await fetch(`${local.API_URL}/functions/v1/read`,{method:"POST",
      headers:{authorization:`Bearer ${renewed.body.agent_token}`,"content-type":"application/json"},
      body:JSON.stringify({resource:"members",workspace_id:f.workspace})});
    assert.equal(read.status,200,"current descendant reaches actual read authority");
    const [proof]=await sql`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id=${String(renewed.body.token_id)}::uuid`;
    assert.equal(proof!.used,true,"HTTP read committed actual adoption");
    const {HOUSEHOLD_LOCAL_SEAT}=await import('../../supabase/functions/_shared/protocol.js');
    const content=(token:string)=>call(token,{kind:'household_tool',tool:'object_list',
      arguments:{seat:HOUSEHOLD_LOCAL_SEAT,offset:0,limit:10}});
    const createTodo=(token:string,title:string)=>{
      const requestId=randomUUID();
      return call(token,{kind:'household_tool',tool:'todo_create',
        arguments:{seat:HOUSEHOLD_LOCAL_SEAT,request_id:requestId,title}},requestId);
    };
    assert.equal((await content(String(renewed.body.agent_token))).body.status,'ok','rotation retains original consent');
    const withdrawn=await call(owner.jwt,{kind:'household_withdraw_connection',principal_id:f.principal});
    assert.equal(withdrawn.body.status,'committed');
    assert.equal((await content(String(renewed.body.agent_token))).body.status,'refused','served withdrawal is immediate');
    const rotatedAgain=await call(String(renewed.body.agent_token),{kind:'renew_agent_token'});
    assert.equal(rotatedAgain.body.status,'accepted');
    const liveRaw=String(rotatedAgain.body.agent_token),liveId=String(rotatedAgain.body.token_id);
    assert.equal((await content(liveRaw)).body.status,'refused','rotation cannot erase a withdrawal');
    const allow=(operations:string[])=>call(owner.jwt,{kind:'household_approve_connection',
      connection:{kind:'local',connection_id:liveId,grant_id:f.run,principal_id:f.principal,operations}});
    assert.equal((await allow(['read'])).body.status,'committed','deliberate current-proof re-Allow');
    assert.equal((await content(liveRaw)).body.status,'ok','later decision supersedes only the old same-family withdrawal');
    assert.equal((await createTodo(liveRaw,'read-only refusal')).body.status,'refused');
    assert.equal((await allow(['read','create','update'])).body.status,'committed','deliberate widening');
    const [decisionHistory]=await sql`SELECT EXISTS(SELECT 1 FROM swarm.audit_log a
      WHERE a.workspace_id=${f.workspace}::uuid AND a.actor_user=${owner.user}::uuid
        AND a.reason='local_allow_decision' AND a.detail::jsonb->'before'->'operations'='["read"]'::jsonb
        AND a.detail::jsonb->'after'->'operations'='["read","create","update"]'::jsonb) AS retained`;
    assert.equal(decisionHistory!.retained,true,'same-bearer widening retains its prior permission and receipt snapshot');
    const created=await createTodo(liveRaw,'explicit widening control');
    const safeReason=(value:unknown)=>typeof value==='string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : null;
    process.stdout.write(`R14_WIDENING_DIAGNOSTIC ${JSON.stringify({status:created.status,
      result:safeReason(created.body.status),reason:safeReason(created.body.reason),error:safeReason(created.body.error)})}\n`);
    assert.equal(created.body.status,'committed');
    const [{n}]=await sql`SELECT count(*)::int AS n FROM swarm.household_todos
      WHERE workspace_id=${f.workspace}::uuid AND title='explicit widening control'`;
    assert.equal(n,1,'write permission committed an actual to-do');
    const [old]=await sql`SELECT consent_receipt_id,operations,revoked_at FROM swarm.household_content_connections
      WHERE connection_id=${f.tokenId}::uuid`;
    assert.equal(old!.consent_receipt_id,originalApproval[0]!.consent_receipt_id);
    assert.deepEqual(old!.operations,originalApproval[0]!.operations);
    assert.ok(old!.revoked_at instanceof Date,'old withdrawn decision and receipt remain intact');
    const otherFamily=await call(owner.jwt,{kind:'mint_agent_token',principal_id:f.principal,
      run_id:randomUUID(),task_id:randomUUID(),epoch:1,device_id:f.device,scopes:['post_signal']});
    assert.equal(otherFamily.body.status,'accepted');
    assert.equal((await content(String(otherFamily.body.agent_token))).body.status,'refused','same principal cannot inherit across families');
    const proofState=()=>sql`SELECT t.first_used_at,t.expires_at,g.last_used_at,g.successors_used,g.successors_stranded
      FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id) WHERE t.token_id=${liveId}::uuid`;
    let withdrawalWait:Promise<{status:number;body:Record<string,unknown>}>|undefined,beforeWithdrawal:unknown;
    await sql.begin(async tx=>{
      const [{pid}]=await tx<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
      // Fixture-only policy writer parks the actual served request at its R
      // phase. Served owner withdrawal/re-Allow above proves the human boundary.
      await tx`SELECT connection_id FROM swarm.household_content_connections
        WHERE connection_id=${liveId}::uuid AND grant_id=${f.run}::uuid FOR UPDATE`;
      beforeWithdrawal=await proofState();withdrawalWait=content(liveRaw);
      let blocked=false;
      for(let i=0;i<100;i++) {
        blocked=(await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
          WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock') AS yes`)[0]?.yes===true;
        if(blocked) break;await delay(25);
      }
      assert.equal(blocked,true,'actual content request waited on its canonical approval');
      await tx`UPDATE swarm.household_content_connections SET revoked_at=clock_timestamp()
        WHERE connection_id=${liveId}::uuid AND grant_id=${f.run}::uuid`;
    });
    assert.equal((await withdrawalWait!).body.status,'refused','withdrawal wins after the approval wait');
    assert.deepEqual(await proofState(),beforeWithdrawal,'withdrawal refusal adopts or spends nothing');
    assert.equal((await allow(['read','create','update'])).body.status,'committed','served re-Allow after waited withdrawal');
    assert.equal((await content(liveRaw)).body.status,'ok','same-invocation current approval control');
    let waiting:Promise<{status:number;body:Record<string,unknown>}>|undefined,beforeLoss:unknown;
    await sql.begin(async tx=>{
      const [{pid}]=await tx<{pid:number}[]>`SELECT pg_backend_pid() AS pid`;
      await tx`SELECT user_id FROM swarm.household_member_content_roles
        WHERE workspace_id=${f.workspace}::uuid AND user_id=${owner.user}::uuid FOR UPDATE`;
      beforeLoss=await proofState();waiting=content(liveRaw);
      let blocked=false;
      for(let i=0;i<100;i++) {
        blocked=(await sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity a
          WHERE ${pid}=ANY(pg_blocking_pids(a.pid)) AND a.wait_event_type='Lock') AS yes`)[0]?.yes===true;
        if(blocked) break;await delay(25);
      }
      assert.equal(blocked,true,'actual content request waited before its final owner-role proof');
      await tx`UPDATE swarm.household_member_content_roles SET revoked_at=clock_timestamp()
        WHERE workspace_id=${f.workspace}::uuid AND user_id=${owner.user}::uuid`;
    });
    assert.equal((await waiting!).body.status,'refused','role loss wins after the wait');
    assert.deepEqual(await proofState(),beforeLoss,'no adoption/use/budget changes on role-loss refusal');
    renewed.body.agent_token=liveRaw;renewed.body.token_id=liveId;
    const obsolete=await call(f.secret,{kind:"renew_agent_token"});
    assert.ok(obsolete.status===401 || obsolete.status===403 || obsolete.body.status==="rejected","obsolete proof cannot renew");
    const removed=await call(keeper.jwt,{kind:"remove_member",user_id:owner.user});
    assert.equal(removed.status,200);assert.equal(removed.body.status,"accepted");
    const [fence]=await sql`SELECT coalesce(g.revoked_at,am.revoked_at) IS NOT NULL AS revoked,m.revoked_at IS NOT NULL AS removed,
      (EXISTS(SELECT 1 FROM swarm.revocation_tombstones z WHERE z.kind='renewal_grant' AND z.target_id=g.renewal_grant_id) OR am.revoked_at IS NOT NULL) AS tombstone
      FROM swarm.renewal_grants g JOIN swarm.memberships m ON m.workspace_id=g.workspace_id AND m.user_id=g.created_by
      JOIN swarm.agent_workspace_memberships am ON am.principal_id=g.principal_id AND am.workspace_id=g.workspace_id
      WHERE g.renewal_grant_id=${f.grant}::uuid`;
    assert.deepEqual(fence,{revoked:true,removed:true,tombstone:true});
    const ended=await content(String(renewed.body.agent_token));
    assert.ok(ended.status===401 || ended.status===403,"removed workspace membership cannot operate in that workspace");
    const dormant=await call(String(renewed.body.agent_token),{kind:"renew_agent_token"});
    assert.equal(dormant.status,200,"dormant connection with zero live workspaces still renews");
    const [intact]=await sql`SELECT revoked_at FROM swarm.renewal_grants WHERE renewal_grant_id=${unrelated.grant}::uuid`;
    assert.equal(intact!.revoked_at,null,"unrelated over-cap history remains untouched");
    assert.ok(last);
  } finally {
    const stopped=child.exitCode===null ? new Promise<void>(resolve=>child.once('exit',()=>resolve())) : Promise.resolve();
    stopProcessGroup(child.pid,"SIGTERM");
    await Promise.race([stopped,delay(5000)]);
    if(child.exitCode===null) {stopProcessGroup(child.pid,"SIGKILL");await stopped;}
    await sql.end({timeout:5});rmSync(temp,{recursive:true,force:true});
  }
});
