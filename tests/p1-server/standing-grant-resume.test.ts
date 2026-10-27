/**
 * `resume_renewal_grant` against the SERVED command function and real Postgres.
 *
 * WHY THIS FILE HAD TO EXIST. The resume path shipped with two suites around it and neither
 * could see it fail. tests/p1-local/standing-grants-postgres.test.ts drives
 * swarm.resume_renewal_grant directly, so it never runs the edge handler that reads the
 * function's return value. tests/p1-cli/standing-grants.test.ts drives `cswarm grant resume`
 * against a fake HTTP server that answers 200 with a stuffed `resumed_at` no matter what was
 * asked — so it asserted the CLI's own printing, and a handler that refused every resume would
 * have kept it green.
 *
 * What the gap hid: the handler read the outcome as
 * `outcomeRows[0]?.resume_outcome ?? "renewal_resume_forbidden"`. NULL is the SUCCESS value
 * (migration 20260904000001:614), `??` cannot tell it from a missing row, so every resume was
 * refused with 403 — while the UPDATE it had already made COMMITTED, because `refuse` returns
 * inside `db.begin` rather than throwing. The second call then answered
 * `renewal_grant_not_suspended`, describing a resume the caller had been told did not happen.
 * R1 below is red on that code; R2 is what made the split-brain visible.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime). Needs local Supabase
 * with migration 20260904000001 applied: `npm run db:start && npm run db:migrate`.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import postgres from "postgres";
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let admin: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;

function localEnvironment(): LocalEnvironment {
  const output = execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const parsed = JSON.parse(output) as Partial<LocalEnvironment>;
  assert.ok(
    parsed.API_URL && parsed.ANON_KEY && parsed.DB_URL && parsed.SERVICE_ROLE_KEY,
  );
  return parsed as LocalEnvironment;
}

interface ResumeFixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  device: string;
  stream: string;
  strangerJwt: string;
  principal: string;
  run: string;
  /** Standing, suspended, resumable. */
  suspendedGrant: string;
  /** Standing, never suspended — the not-suspended control. */
  liveGrant: string;
}

let f: ResumeFixture;
let clientVersion: string;

async function createUser(label: string): Promise<{ id: string; jwt: string }> {
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

async function commandRequest(
  bearer: string, workspace: string, command: Record<string, unknown>,
  commandId = randomUUID(), extra: Record<string, unknown> = {},
): Promise<{status:number;body:Record<string, unknown>}> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: 'POST', headers: {authorization:`Bearer ${bearer}`, 'content-type':'application/json'},
    body: JSON.stringify({command_id:commandId,client_version:clientVersion,workspace_id:workspace,
      stream:{kind:'workspace'},command,...extra}),
  });
  return {status:response.status,body:await response.json() as Record<string, unknown>};
}

async function mintFamily(
  context: Pick<ResumeFixture,'ownerJwt'|'workspace'|'principal'|'device'>,
  used = true, paused = true,
) {
  const run = randomUUID();
  const minted = await commandRequest(context.ownerJwt,context.workspace,{
    kind:'mint_agent_token',principal_id:context.principal,device_id:context.device,
    run_id:run,task_id:randomUUID(),epoch:1,ttl_ms:120000,scopes:['post_signal'],
  });
  assert.equal(minted.status,200,'legal mint control');
  assert.equal(typeof minted.body.agent_token,'string');
  assert.equal(typeof minted.body.token_id,'string');
  const token = minted.body.token_id as string, raw = minted.body.agent_token as string;
  if (used) {
    const response = await fetch(`${local.API_URL}/functions/v1/read`,{
      method:'POST',headers:{authorization:`Bearer ${raw}`,'content-type':'application/json'},
      body:JSON.stringify({resource:'renewal_grants',workspace_id:context.workspace}),
    });
    assert.equal(response.status,200,'real first use control');
    await response.arrayBuffer();
  }
  const [binding] = await sql<{renewal_grant_id:string;used:boolean;kind:string}[]>`
    SELECT t.renewal_grant_id,t.first_used_at IS NOT NULL AS used,g.kind
    FROM swarm.agent_tokens t JOIN swarm.renewal_grants g USING(renewal_grant_id)
    WHERE t.token_id=${token}::uuid`;
  assert.ok(binding);
  assert.equal(binding.used,used,'first use must come from authenticated possession');
  assert.equal(binding.kind,'standing');
  if (paused) await sql`UPDATE swarm.renewal_grants SET suspended_at=clock_timestamp()
    WHERE renewal_grant_id=${binding.renewal_grant_id}::uuid`;
  return {grant:binding.renewal_grant_id,token,raw,run};
}

async function resumeFixture(): Promise<ResumeFixture> {
  const owner = await createUser('resume-owner'), stranger = await createUser('resume-stranger');
  const workspace=randomUUID(),device=randomUUID(),principal=randomUUID(),stream=randomUUID();
  await sql.begin(async tx=>{
    await tx`INSERT INTO swarm.users(user_id,display_name) VALUES
      (${owner.id}::uuid,'ResumeOwner'),(${stranger.id}::uuid,'ResumeStranger')`;
    await tx`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${owner.id}::uuid,'resume-tests')`;
    await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES(${workspace}::uuid,'ResumeWS',${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${workspace}::uuid,${owner.id}::uuid,'owner')`;
    await tx`INSERT INTO swarm.streams(stream_id,workspace_id,kind) VALUES(${stream}::uuid,${workspace}::uuid,'workspace')`;
    await tx`INSERT INTO swarm.agent_principals(principal_id,workspace_id,name,owner_user_id)
      VALUES(${principal}::uuid,${workspace}::uuid,'resume-agent',${owner.id}::uuid)`;
  });
  const context={workspace,device,principal,ownerJwt:owner.jwt};
  const suspended=await mintFamily(context),live=await mintFamily(context,true,false);
  return {...context,stream,ownerId:owner.id,strangerJwt:stranger.jwt,run:suspended.run,
    suspendedGrant:suspended.grant,liveGrant:live.grant};
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  /* The migration under test must actually be in the database. Without this the fixture's
     INSERT fails on a missing column and every assertion below would be about the wrong
     thing — a negative result that never reached the path it claims to test. */
  const columns = await sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema = 'swarm' AND table_name = 'renewal_grants'
      AND column_name = 'suspension_active'
  `;
  assert.equal(
    columns.length,
    1,
    "migration 20260904000001 is not applied locally; run `npm run db:migrate`",
  );
  envDir = mkdtempSync(join(tmpdir(), "cswarm-resume-env-"));
  const envFile = join(envDir, "test.env");
  writeFileSync(envFile, "SWARM_ENV=test\n");
  functionProcess = spawn(
    "supabase",
    ["functions", "serve", "--no-verify-jwt", "--env-file", envFile],
    {
      cwd: process.cwd(),
      env: { ...process.env, SWARM_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const capture = (chunk: Buffer) => {
    functionLogs = (functionLogs + chunk.toString("utf8")).slice(-20_000);
  };
  functionProcess.stdout?.on("data", capture);
  functionProcess.stderr?.on("data", capture);
  /* Wait for OUR boot banner before the HTTP probe: at a file seam the previous file's
     still-answering runtime satisfies the probe and kong then swaps mid-suite. */
  {
    const bootDeadline = Date.now() + 60_000;
    while (!functionLogs.includes("Serving functions on")) {
      if (Date.now() > bootDeadline) {
        throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
      }
      await delay(250);
    }
  }
  await awaitFunctionRunning({
    url: `${local.API_URL}/functions/v1/command`,
    fetcher: fetch,
    timeoutMs: 30_000,
    sleep: (ms) => delay(ms),
    now: () => Date.now(),
    diagnostics: () => `command function logs:\n${functionLogs.slice(-4000)}`,
  });
  const [config]=await sql`SELECT value FROM swarm.config WHERE key='min_client_version'`;
  assert.equal(typeof config?.value,'string');
  clientVersion=config!.value as string;
  f = await resumeFixture();
});

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
    const stopped = await Promise.race([exited, delay(2_000).then(() => false)]);
    if (!stopped && functionProcess.exitCode === null) {
      functionProcess.kill("SIGKILL");
    }
  }
  await sql?.end({ timeout: 5 });
  if (envDir) rmSync(envDir, { recursive: true, force: true });
});

async function resume(jwt: string, renewalGrantId: string, commandId = randomUUID(), extra: Record<string, unknown> = {}) {
  return commandRequest(jwt,f.workspace,{kind:'resume_renewal_grant',renewal_grant_id:renewalGrantId},commandId,extra);
}

async function grantRow(id: string) {
  const rows = await sql<{
    suspended_at: Date | null;
    resumed_at: Date | null;
    resumed_by: string | null;
    resume_count: number;
    suspension_active: boolean;
  }[]>`
    SELECT suspended_at, resumed_at, resumed_by, resume_count, suspension_active
    FROM swarm.renewal_grants WHERE renewal_grant_id = ${id}::uuid
  `;
  assert.ok(rows[0], "grant row must exist");
  return rows[0]!;
}

async function lastAudit(): Promise<{ outcome: string; reason: string | null }> {
  const rows = await sql<{ outcome: string; reason: string | null }[]>`
    SELECT outcome, reason
    FROM swarm.audit_log
    WHERE workspace_id = ${f.workspace}::uuid
      AND command_kind = 'resume_renewal_grant'
    ORDER BY occurred_at DESC
    LIMIT 1
  `;
  assert.ok(rows[0], "the resume must leave an audit row");
  return rows[0]!;
}

test("R1 an owner resumes a suspended standing grant and is TOLD it happened", async () => {
  const before = await grantRow(f.suspendedGrant);
  assert.equal(before.suspension_active, true, "the fixture must start paused");

  const result = await resume(f.ownerJwt, f.suspendedGrant);

  /* The assertion the shipped handler failed. NULL is success from
     swarm.resume_renewal_grant; a `??` that turns it into a refusal string answers 403 here
     while still committing the UPDATE checked below. */
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "accepted", JSON.stringify(result.body));
  assert.equal(result.body.renewal_grant_id, f.suspendedGrant);
  assert.equal(typeof result.body.resumed_at, "string");

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.suspension_active, false, "the grant is no longer paused");
  assert.equal(after.resume_count, 1);
  assert.equal(after.resumed_by, f.ownerId);
  assert.ok(after.resumed_at instanceof Date);
  /* The lapse stays readable: suspended_at is never cleared, which is why
     suspension_active — not this column — is the definition of "paused right now". */
  assert.ok(after.suspended_at instanceof Date, "the suspension that happened stays on the row");

  const audit = await lastAudit();
  assert.equal(audit.outcome, "accepted");
  assert.equal(audit.reason, null);
});

test("R2 a second resume is refused as not-suspended, and changes nothing", async () => {
  /* THE CONTROL THAT MADE THE SPLIT-BRAIN VISIBLE. On the shipped handler R1 answered 403
     and this call answered `renewal_grant_not_suspended` — the state after a resume the
     caller had been told did not happen. Here it is the ordinary second call. */
  const before = await grantRow(f.suspendedGrant);
  const result = await resume(f.ownerJwt, f.suspendedGrant);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, "forbidden");

  const audit = await lastAudit();
  assert.equal(audit.outcome, "authz");
  assert.equal(
    audit.reason,
    "renewal_resume_renewal_grant_not_suspended",
    "the operator gets the distinction the caller is deliberately denied",
  );

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.resume_count, before.resume_count, "a refusal must not resume");
  assert.deepEqual(after.resumed_at, before.resumed_at);
});

test("R3 a grant that was never suspended is refused the same way", async () => {
  const result = await resume(f.ownerJwt, f.liveGrant);
  assert.equal(result.status, 403, JSON.stringify(result.body));
  const audit = await lastAudit();
  assert.equal(audit.reason, "renewal_resume_renewal_grant_not_suspended");
  const after = await grantRow(f.liveGrant);
  assert.equal(after.resume_count, 0);
  assert.equal(after.resumed_at, null);
});

test("R4 a non-member cannot resume, and the refusal is indistinguishable", async () => {
  // A non-member is outside workspace admission and must not reach target audit.
  const auditBefore=await resumeAudits();
  const before = await grantRow(f.suspendedGrant);
  const stranger = await resume(f.strangerJwt, f.suspendedGrant);
  assert.equal(stranger.status, 403, JSON.stringify(stranger.body));
  assert.equal(stranger.body.error, "forbidden");
  assert.deepEqual(await resumeAudits(),auditBefore,'non-member never reaches the target handler');

  const absent = await resume(f.strangerJwt, randomUUID());
  assert.equal(absent.status, 403);
  assert.deepEqual(absent.body, stranger.body, "the wire cannot tell the two apart");

  const after = await grantRow(f.suspendedGrant);
  assert.equal(after.resume_count, before.resume_count, "a stranger changes nothing");
});


async function resumeAudits() {
  return sql`SELECT audit_id,actor_user,actor_agent_principal,actor_run,credential_kind,
    credential_id,device_id,workspace_id,stream_id,outcome,reason,detail,request_hash
    FROM swarm.audit_log WHERE workspace_id=${f.workspace}::uuid
      AND command_kind='resume_renewal_grant' ORDER BY audit_id`;
}

async function noRefusalLedger(commandId: string) {
  const [{n}]=await sql`SELECT count(*)::int AS n FROM swarm.idempotency_keys WHERE command_id=${commandId}`;
  assert.equal(n,0,'a refusal never consumes a command id');
}

async function waitForAuditBlocker(pid: number) {
  const deadline=Date.now()+2500;
  while (Date.now()<deadline) {
    const rows=await sql`SELECT pid,query ILIKE '%INSERT INTO swarm.audit_log%' AS audit_wait
      FROM pg_stat_activity WHERE ${pid}::int=ANY(pg_blocking_pids(pid))`;
    if (rows.some(row=>row.audit_wait)) return;
    await delay(20);
  }
  assert.fail('request did not reach its actual audit INSERT wait');
}

// C3/C4 owner: served HTTP plus committed audit rows. Existing SQL-only tests
// cannot see early edge admission, raw discovery errors, or refusal rollbacks.
test('R5 eligible callers get exact private refusal audits without target locks', {timeout:60000}, async()=>{
  const positive=await mintFamily(f);
  assert.equal((await resume(f.ownerJwt,positive.grant)).status,200,'same-invocation owner positive');
  const target=await mintFamily(f);
  const member=await createUser('resume-member');
  await sql`INSERT INTO swarm.users(user_id,display_name) VALUES(${member.id}::uuid,'ResumeMember')`;
  await sql`INSERT INTO swarm.memberships(workspace_id,user_id,role) VALUES(${f.workspace}::uuid,${member.id}::uuid,'member')`;
  // A real grant in a different workspace is indistinguishable from absence.
  const foreign=await resumeFixture();
  const unknown=randomUUID();
  for (const row of [
    {jwt:member.jwt,actor:member.id,grant:target.grant,reason:'renewal_resume_forbidden'},
    {jwt:f.ownerJwt,actor:f.ownerId,grant:unknown,reason:'renewal_grant_not_found'},
    {jwt:f.ownerJwt,actor:f.ownerId,grant:foreign.suspendedGrant,reason:'renewal_grant_not_found'},
  ]) {
    const commandId=randomUUID(),before=await grantRow(target.grant),audits=await resumeAudits();
    let pending: ReturnType<typeof resume> | undefined, completed: Awaited<ReturnType<typeof resume>> | null = null;
    await sql.begin(async blocker=>{
      const [{pid}]=await blocker`SELECT pg_backend_pid() AS pid`;
      await blocker`SELECT renewal_grant_id FROM swarm.renewal_grants
        WHERE renewal_grant_id=ANY(${[target.grant,foreign.suspendedGrant]}::uuid[]) FOR UPDATE`;
      pending=resume(row.jwt,row.grant,commandId,{actor_user:randomUUID()});
      completed=await Promise.race([pending,delay(1500).then(()=>null)]);
      const [{n}]=await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${Number(pid)}::int=ANY(pg_blocking_pids(pid))`;
      assert.equal(n,0,'known refusal must not wait on an unauthorized target');
    });
    const first=await pending!;
    assert.ok(completed,'refusal completed before target unlock');
    assert.deepEqual(first,{status:403,body:{error:'forbidden'}});
    assert.deepEqual(await resume(row.jwt,row.grant,commandId,{actor_user:randomUUID()}),first);
    const added=(await resumeAudits()).slice(audits.length);
    assert.equal(added.length,2,'same command id records each refusal, without a replay ledger');
    for (const audit of added) {
      assert.equal(audit.outcome,'authz');
      assert.equal(audit.reason,`renewal_resume_${row.reason}`);
      assert.equal(audit.actor_user,row.actor,'authenticated identity, never supplied actor');
      assert.equal(audit.actor_agent_principal,null);
      assert.equal(audit.actor_run,null);
      assert.equal(audit.credential_kind,'user');
      assert.equal(audit.credential_id,null);
      assert.equal(audit.device_id,null);
      assert.equal(audit.workspace_id,f.workspace);
      assert.equal(audit.stream_id,f.stream);
      assert.equal(audit.detail,`ignored client-supplied identity fields: actor_user; renewal_grant_id=${row.grant}`);
      assert.equal(audit.request_hash,null);
    }
    await noRefusalLedger(commandId);
    assert.deepEqual(await grantRow(target.grant),before,'refusal has no resume effect');
  }
});

test('R6 owned bound-device discovery refusal is normalized and audited', async()=>{
  const positive=await mintFamily(f);
  assert.equal((await resume(f.ownerJwt,positive.grant)).status,200);
  // Canonical historical grant shape: its run and bound device disagree. No
  // trigger is disabled, immutable binding rewritten, or first use fabricated.
  const device=randomUUID(),grant=randomUUID();
  await sql`INSERT INTO swarm.devices(device_id,user_id,label) VALUES(${device}::uuid,${f.ownerId}::uuid,'other binding')`;
  await sql`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,
    kind,max_successors,horizon_expires_at,bound_device_id,created_by,suspended_at)
    VALUES(${grant}::uuid,${f.workspace}::uuid,${f.principal}::uuid,${positive.run}::uuid,
      'standing',NULL,NULL,${device}::uuid,${f.ownerId}::uuid,clock_timestamp())`;
  const before=await grantRow(grant),audits=await resumeAudits(),commandId=randomUUID();
  assert.deepEqual(await resume(f.ownerJwt,grant,commandId),{status:403,body:{error:'forbidden'}});
  const added=(await resumeAudits()).slice(audits.length);
  assert.equal(added.length,1);
  assert.equal(added[0].reason,'renewal_resume_renewal_resume_forbidden');
  assert.equal(added[0].outcome,'authz');
  assert.equal(added[0].actor_user,f.ownerId);
  assert.equal(added[0].actor_agent_principal,null);
  assert.equal(added[0].detail,`renewal_grant_id=${grant}`);
  assert.equal(added[0].request_hash,null);
  assert.deepEqual(await grantRow(grant),before);
  await noRefusalLedger(commandId);
});

test('R7 agent refusal preserves real actor and first use, without a refusal ledger', async()=>{
  const positive=await mintFamily(f);
  assert.equal((await resume(f.ownerJwt,positive.grant)).status,200);
  const target=await mintFamily(f),agent=await mintFamily(f,false,false),commandId=randomUUID();
  const before=await grantRow(target.grant),audits=await resumeAudits();
  for(let i=0;i<2;i++) assert.deepEqual(await resume(agent.raw,target.grant,commandId),{status:403,body:{error:'forbidden'}});
  const added=(await resumeAudits()).slice(audits.length);
  assert.equal(added.length,2);
  for(const audit of added) {
    assert.equal(audit.reason,'renewal_resume_credential_kind_forbidden');
    assert.equal(audit.outcome,'authz');
    assert.equal(audit.actor_user,f.ownerId);
    assert.equal(audit.actor_agent_principal,f.principal);
    assert.equal(audit.actor_run,agent.run);
    assert.equal(audit.credential_kind,'agent');
    assert.equal(audit.credential_id,agent.token);
    assert.equal(audit.device_id,f.device);
    assert.equal(audit.stream_id,f.stream);
    assert.equal(audit.detail,null,'credential-kind refusal retains its existing detail semantics');
    assert.equal(audit.request_hash,null);
  }
  assert.equal((await sql`SELECT first_used_at IS NOT NULL AS used FROM swarm.agent_tokens WHERE token_id=${agent.token}::uuid`)[0].used,true);
  assert.deepEqual(await grantRow(target.grant),before);
  await noRefusalLedger(commandId);
});

test('R8 final authentication failure rolls back refusal audit and first use', {timeout:30000}, async()=>{
  const positive=await mintFamily(f);
  assert.equal((await resume(f.ownerJwt,positive.grant)).status,200);
  const target=await mintFamily(f),agent=await mintFamily(f,false,false),commandId=randomUUID();
  const before=await grantRow(target.grant),audits=await resumeAudits();
  const [grantBefore]=await sql`SELECT last_used_at,last_used_device_id FROM swarm.renewal_grants WHERE renewal_grant_id=${agent.grant}::uuid`;
  await sql`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()+interval '4 seconds' WHERE token_id=${agent.token}::uuid`;
  let pending: ReturnType<typeof resume> | undefined;
  await sql.begin(async blocker=>{
    const [{pid}]=await blocker`SELECT pg_backend_pid() AS pid`;
    await blocker`LOCK TABLE swarm.audit_log IN SHARE MODE`;
    pending=resume(agent.raw,target.grant,commandId);
    await waitForAuditBlocker(Number(pid));
    assert.equal((await sql`SELECT expires_at>clock_timestamp() AS live FROM swarm.agent_tokens WHERE token_id=${agent.token}::uuid`)[0].live,true);
    await blocker`SELECT pg_sleep(greatest(0,extract(epoch FROM (expires_at-clock_timestamp())))+0.05)
      FROM swarm.agent_tokens WHERE token_id=${agent.token}::uuid`;
  });
  assert.deepEqual(await pending!,{status:401,body:{error:'unauthenticated'}});
  assert.deepEqual(await resumeAudits(),audits,'late authentication failure rolls back the audit');
  assert.equal((await sql`SELECT first_used_at IS NULL AS unused FROM swarm.agent_tokens WHERE token_id=${agent.token}::uuid`)[0].unused,true);
  assert.deepEqual((await sql`SELECT last_used_at,last_used_device_id FROM swarm.renewal_grants WHERE renewal_grant_id=${agent.grant}::uuid`)[0],grantBefore);
  assert.deepEqual(await grantRow(target.grant),before);
  await noRefusalLedger(commandId);
});

test('R9 absent proof and expired unused bootstrap cannot resume', async()=>{
  const positive=await mintFamily(f);
  assert.equal((await resume(f.ownerJwt,positive.grant)).status,200);
  const unused=await mintFamily(f,false,true),empty=randomUUID();
  await sql`UPDATE swarm.agent_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_id=${unused.token}::uuid`;
  await sql`INSERT INTO swarm.renewal_grants(renewal_grant_id,workspace_id,principal_id,run_id,
    kind,max_successors,horizon_expires_at,bound_device_id,created_by,suspended_at)
    VALUES(${empty}::uuid,${f.workspace}::uuid,${f.principal}::uuid,${positive.run}::uuid,
      'standing',NULL,NULL,${f.device}::uuid,${f.ownerId}::uuid,clock_timestamp())`;
  for(const grant of [unused.grant,empty]) {
    const before=await grantRow(grant);
    assert.deepEqual(await resume(f.ownerJwt,grant),{status:403,body:{error:'forbidden'}});
    assert.equal((await lastAudit()).reason,'renewal_resume_renewal_resume_forbidden');
    assert.deepEqual(await grantRow(grant),before);
  }
});
