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
    await assert.rejects(discover([],[foreign.tokenId]),{code:"22023"},"outside-workspace selector refuses wholly");
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
    for (const name of ["swarm.household_local_family_binding_guard()","swarm.renewal_grants_revoke_cascade()"]) {
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
