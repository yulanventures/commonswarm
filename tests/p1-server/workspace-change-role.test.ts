/**
 * change_role against the served command function and real Postgres.
 *
 * The reducer already decided this command. This file proves the edge accepts
 * the wire shape, persists MemberRoleChanged, and returns the reducer's stable
 * refusal reasons. An agent credential is refused before that reducer runs.
 * A stale interactive session is refused with 401 fresh_auth_required before
 * the reducer. tests/fresh-auth.test.ts covers that refusal. A just-signed-in
 * owner below is the fresh-session control.
 *
 * Reached by `npm run test:p1-server` (globs tests/p1-server/**; serial via
 * --test-concurrency=1 because each file owns the one local runtime).
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
import { awaitFunctionRunning } from "../support/edge-readiness.js";

interface LocalEnvironment {
  API_URL: string;
  ANON_KEY: string;
  DB_URL: string;
  SERVICE_ROLE_KEY: string;
}

interface Person {
  id: string;
  jwt: string;
}

interface RoleFixture {
  workspaceA: string;
  workspaceB: string;
  owner: Person;
  admin: Person;
  promoted: Person;
  plain: Person;
  former: Person;
  /** Plaintext agent credential whose scopes include change_role. */
  agentCredential: string;
  agentOutOfScopeCredential: string;
  agentPrincipal: string;
  hostedAgentCredential: string;
  hostedAgentPrincipal: string;
}

interface CommandResult {
  status: number;
  body: Record<string, unknown>;
}

let local: LocalEnvironment;
let sql: postgres.Sql;
let adminClient: SupabaseClient;
let functionProcess: ReturnType<typeof spawn>;
let functionLogs = "";
let envDir: string | undefined;
let f: RoleFixture;

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

function randomBigint(): string {
  return (
    BigInt(Date.now()) * 10_000n + BigInt(randomBytes(2).readUInt16BE())
  ).toString();
}

async function createUser(label: string): Promise<Person> {
  const email = `${label}-${randomUUID()}@example.test`;
  const password = `T-${randomBytes(24).toString("base64url")}!`;
  const created = await adminClient.auth.admin.createUser({
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

async function roleFixture(): Promise<RoleFixture> {
  const owner = await createUser("role-owner");
  const admin = await createUser("role-admin");
  const promoted = await createUser("role-promoted");
  const plain = await createUser("role-plain");
  const former = await createUser("role-former");
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  const device = randomUUID();
  const agentPrincipal = randomUUID();
  const hostedAgentPrincipal = randomUUID();
  const agentCredential = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const agentOutOfScopeCredential = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const hostedAgentCredential = `swm_agt_${randomBytes(32).toString("base64url")}`;
  const installation = randomUUID();
  const repository = randomUUID();
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES
        (${owner.id}::uuid, 'RoleOwner'),
        (${admin.id}::uuid, 'RoleAdmin'),
        (${promoted.id}::uuid, 'RolePromoted'),
        (${plain.id}::uuid, 'RolePlain'),
        (${former.id}::uuid, 'RoleFormer')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${owner.id}::uuid, 'role-tests')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES
        (${workspaceA}::uuid, 'RoleA', ${owner.id}::uuid),
        (${workspaceB}::uuid, 'RoleB', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role, revoked_at)
      VALUES
        (${workspaceA}::uuid, ${owner.id}::uuid, 'owner', NULL),
        (${workspaceA}::uuid, ${admin.id}::uuid, 'admin', NULL),
        (${workspaceA}::uuid, ${promoted.id}::uuid, 'member', NULL),
        (${workspaceA}::uuid, ${plain.id}::uuid, 'member', NULL),
        (${workspaceA}::uuid, ${former.id}::uuid, 'member', statement_timestamp()),
        (${workspaceB}::uuid, ${owner.id}::uuid, 'owner', NULL),
        (${workspaceB}::uuid, ${promoted.id}::uuid, 'member', NULL),
        (${workspaceB}::uuid, ${former.id}::uuid, 'member', NULL)
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES
        (${randomUUID()}::uuid, ${workspaceA}::uuid, 'workspace'),
        (${randomUUID()}::uuid, ${workspaceB}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.github_installations (
        installation_row_id, workspace_id, github_installation_id
      ) VALUES (
        ${installation}::uuid,
        ${workspaceA}::uuid,
        ${randomBigint()}
      )
    `;
    await tx`
      INSERT INTO swarm.repositories (
        repo_mapping_id, workspace_id, github_repository_id,
        installation_row_id, full_name, default_branch,
        landing_authority_user_id
      ) VALUES (
        ${repository}::uuid,
        ${workspaceA}::uuid,
        ${randomBigint()},
        ${installation}::uuid,
        'example/role-repo',
        'main',
        ${plain.id}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${agentPrincipal}::uuid, ${workspaceA}::uuid, ${owner.id}::uuid, 'role-worker'
      )
    `;
    const run = randomUUID();
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${agentPrincipal}::uuid, ${device}::uuid)
    `;
    const renewalGrant = randomUUID();
    const predecessor = randomUUID();
    const lineage = randomUUID();
    await tx`INSERT INTO swarm.renewal_grants (
      renewal_grant_id,workspace_id,principal_id,run_id,kind,max_successors,
      horizon_expires_at,bound_device_id,created_by
    ) VALUES (${renewalGrant}::uuid,${workspaceA}::uuid,${agentPrincipal}::uuid,
      ${run}::uuid,'standing',NULL,NULL,${device}::uuid,${owner.id}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (
      token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id,renewal_grant_id
    ) VALUES (${predecessor}::uuid,${agentPrincipal}::uuid,${run}::uuid,'["change_role"]'::jsonb,
      ${randomBytes(32)},statement_timestamp()+interval '1 hour',${lineage}::uuid,${renewalGrant}::uuid)`;
    await tx`UPDATE swarm.agent_tokens SET first_used_at=clock_timestamp()
      WHERE token_id=${predecessor}::uuid`;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id, renewal_grant_id, predecessor_token_id
      ) VALUES (
        ${randomUUID()}::uuid, ${agentPrincipal}::uuid, ${run}::uuid,
        ${tx.json(["change_role"])}::jsonb,
        ${createHash("sha256").update(agentCredential).digest()},
        statement_timestamp() + interval '1 hour', ${lineage}::uuid,
        ${renewalGrant}::uuid, ${predecessor}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
      VALUES (${randomUUID()}::uuid, ${agentPrincipal}::uuid, ${run}::uuid, '[]'::jsonb,
        ${createHash("sha256").update(agentOutOfScopeCredential).digest()},
        statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)
    `;
    await tx`INSERT INTO swarm.agent_principals (
      principal_id,workspace_id,owner_user_id,name,transport,turn_only
    ) VALUES (${hostedAgentPrincipal}::uuid,${workspaceA}::uuid,${owner.id}::uuid,
      'role-hosted-worker','hosted_mcp',true)`;
    const hostedRun = randomUUID();
    await tx`INSERT INTO swarm.agent_runs (run_id,principal_id,device_id)
      VALUES (${hostedRun}::uuid,${hostedAgentPrincipal}::uuid,${device}::uuid)`;
    await tx`INSERT INTO swarm.agent_tokens (
      token_id,principal_id,run_id,scopes,token_hash,expires_at,lineage_id
    ) VALUES (${randomUUID()}::uuid,${hostedAgentPrincipal}::uuid,${hostedRun}::uuid,
      '["change_role"]'::jsonb,${createHash("sha256").update(hostedAgentCredential).digest()},
      statement_timestamp()+interval '1 hour',${randomUUID()}::uuid)`;
  });
  return {
    workspaceA,
    workspaceB,
    owner,
    admin,
    promoted,
    plain,
    former,
    agentCredential,
    agentOutOfScopeCredential,
    agentPrincipal,
    hostedAgentCredential,
    hostedAgentPrincipal,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  adminClient = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-change-role-env-"));
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
  f = await roleFixture();
}, { timeout: 180_000 });

after(async () => {
  if (functionProcess && functionProcess.exitCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      functionProcess.once("close", () => resolve(true));
    });
    functionProcess.kill();
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

async function postChange(
  credential: string,
  workspace: string,
  command: Record<string, unknown>,
  commandId = randomUUID(),
): Promise<CommandResult> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${credential}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: workspace,
      stream: { kind: "workspace" },
      command,
    }),
  });
  const body = await response.json() as Record<string, unknown>;
  return { status: response.status, body };
}

async function roster(jwt: string, workspace: string): Promise<Record<string, string>> {
  const url = new URL(`${local.API_URL}/rest/v1/member_profiles`);
  url.searchParams.set("select", "user_id,role");
  url.searchParams.set("workspace_id", `eq.${workspace}`);
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${jwt}`,
      apikey: local.ANON_KEY,
      "accept-profile": "swarm_read",
    },
  });
  assert.equal(response.status, 200);
  const rows = await response.json() as { user_id: string; role: string }[];
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

async function liveRoles(workspace: string): Promise<Record<string, string>> {
  const rows = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id::text AS user_id, role
    FROM swarm.memberships
    WHERE workspace_id = ${workspace}::uuid
      AND revoked_at IS NULL
  `;
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

async function roleChangeCount(workspace: string): Promise<number> {
  const [row] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM swarm.events
    WHERE workspace_id = ${workspace}::uuid
      AND type = 'MemberRoleChanged'
  `;
  return Number(row?.count ?? 0);
}

function assertRejected(
  result: CommandResult,
  reason: string,
  detail: string,
): void {
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "rejected");
  assert.equal(result.body.reason, reason);
  assert.equal(result.body.detail, detail);
}

test("change_role promotes a member and refuses the stable reasons", { timeout: 180_000 }, async () => {
  const beforeRoster = await roster(f.owner.jwt, f.workspaceA);
  assert.equal(beforeRoster[f.promoted.id], "member");
  assert.equal(beforeRoster[f.owner.id], "owner");
  assert.equal(beforeRoster[f.former.id], undefined);
  assert.equal(await roleChangeCount(f.workspaceA), 0);

  const malformed = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.promoted.id,
    role: "guest",
  });
  assert.equal(malformed.status, 400, JSON.stringify(malformed.body));
  assert.equal(malformed.body.error, "invalid_request");
  assert.equal(malformed.body.message, "change_role fields are malformed");
  const extra = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.promoted.id,
    role: "admin",
    note: "ignore",
  });
  assert.equal(extra.status, 400, JSON.stringify(extra.body));
  assert.equal(extra.body.message, "change_role fields are malformed");
  assert.equal((await liveRoles(f.workspaceA))[f.promoted.id], "member");
  assert.equal(await roleChangeCount(f.workspaceA), 0);

  const commandId = randomUUID();
  const promoted = await postChange(
    f.owner.jwt,
    f.workspaceA,
    { kind: "change_role", user_id: f.promoted.id, role: "admin" },
    commandId,
  );
  assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
  assert.equal(promoted.body.status, "accepted");
  assert.equal(promoted.body.workspace_id, f.workspaceA);
  const eventIds = promoted.body.event_ids;
  assert.ok(Array.isArray(eventIds) && eventIds.length === 1);

  const events = await sql<{
    workspace_id: string;
    user_id: string;
    from_role: string;
    to_role: string;
  }[]>`
    SELECT
      workspace_id::text AS workspace_id,
      payload->>'user_id' AS user_id,
      payload->>'from_role' AS from_role,
      payload->>'to_role' AS to_role
    FROM swarm.events
    WHERE type = 'MemberRoleChanged'
      AND payload->>'user_id' = ${f.promoted.id}
  `;
  assert.deepEqual(Array.from(events, (r) => ({ ...r })), [{
    workspace_id: f.workspaceA,
    user_id: f.promoted.id,
    from_role: "member",
    to_role: "admin",
  }]);
  assert.equal((await roster(f.owner.jwt, f.workspaceA))[f.promoted.id], "admin");
  assert.equal((await liveRoles(f.workspaceA))[f.promoted.id], "admin");
  assert.equal((await liveRoles(f.workspaceB))[f.promoted.id], "member");

  const replay = await postChange(
    f.owner.jwt,
    f.workspaceA,
    { kind: "change_role", user_id: f.promoted.id, role: "admin" },
    commandId,
  );
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.status, "accepted");
  assert.deepEqual(replay.body.event_ids, eventIds);
  assert.equal(await roleChangeCount(f.workspaceA), 1);
  const replayAudit = await sql<{ outcome: string; reason: string | null }[]>`
    SELECT outcome, reason
    FROM swarm.audit_log
    WHERE workspace_id = ${f.workspaceA}::uuid
      AND command_kind = 'change_role'
      AND actor_user = ${f.owner.id}::uuid
      AND outcome IN ('accepted', 'replayed')
    ORDER BY outcome
  `;
  assert.deepEqual(Array.from(replayAudit, (r) => ({ ...r })), [
    { outcome: "accepted", reason: null },
    { outcome: "replayed", reason: null },
  ]);

  const conflict = await postChange(
    f.owner.jwt,
    f.workspaceA,
    { kind: "change_role", user_id: f.promoted.id, role: "member" },
    commandId,
  );
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.equal(conflict.body.error, "command_id_conflict");
  assert.equal((await liveRoles(f.workspaceA))[f.promoted.id], "admin");
  assert.equal(await roleChangeCount(f.workspaceA), 1);

  const already = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.promoted.id,
    role: "admin",
  });
  assertRejected(already, "bad_state", "member already has that role");

  const adminOnOwner = await postChange(f.admin.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.owner.id,
    role: "member",
  });
  assertRejected(
    adminOnOwner,
    "role_forbidden",
    "Admin cannot add, remove, or change an Owner",
  );
  assert.equal((await liveRoles(f.workspaceA))[f.owner.id], "owner");

  const demoteSelf = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.owner.id,
    role: "member",
  });
  assertRejected(demoteSelf, "last_owner", "last Owner cannot be demoted");
  assert.equal((await liveRoles(f.workspaceA))[f.owner.id], "owner");

  let memberRequest: Promise<CommandResult> | undefined;
  let plainCaller: CommandResult;
  try {
    plainCaller = await sql.begin(async blocker => {
      // Admission must reach the actor's domain refusal without locking the
      // submitted target. Changing only admission would park on this U row.
      await blocker`SELECT user_id FROM swarm.users WHERE user_id=${f.promoted.id}::uuid FOR UPDATE`;
      memberRequest=postChange(f.plain.jwt, f.workspaceA, {
        kind: "change_role", user_id: f.promoted.id, role: "member",
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([memberRequest,new Promise<never>((_,reject)=>{
          timer=setTimeout(()=>reject(new Error('member role refusal waited on unauthorized target')),5_000);
        })]);
      } finally { if(timer)clearTimeout(timer); }
    });
  } finally { if(memberRequest)await memberRequest.catch(()=>{}); }
  assertRejected(
    plainCaller,
    "role_forbidden",
    "changing roles requires Owner/Admin",
  );
  const memberAudit = await sql`SELECT outcome,reason FROM swarm.audit_log
    WHERE workspace_id=${f.workspaceA}::uuid AND command_kind='change_role'
      AND actor_user=${f.plain.id}::uuid`;
  assert.deepEqual(Array.from(memberAudit,r=>({...r})),[{outcome:"domain",reason:"role_forbidden"}]);
  assert.equal((await liveRoles(f.workspaceA))[f.promoted.id], "admin");

  const missing = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.former.id,
    role: "admin",
  });
  assertRejected(missing, "member_not_found", "target is not a current member");
  const [formerRow] = await sql<{ revoked: boolean }[]>`
    SELECT revoked_at IS NOT NULL AS revoked
    FROM swarm.memberships
    WHERE workspace_id = ${f.workspaceA}::uuid
      AND user_id = ${f.former.id}::uuid
  `;
  assert.equal(formerRow?.revoked, true);

  // The denied command must retain only its security record. In particular,
  // an unused token must stay unused: authentication stamps inside a savepoint.
  const agentEffects = async () => {
    const [state] = await sql`SELECT
      (SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY token_id)::text)
        FROM swarm.agent_tokens t WHERE principal_id IN
          (${f.agentPrincipal}::uuid,${f.hostedAgentPrincipal}::uuid)) AS tokens,
      (SELECT md5(jsonb_agg(to_jsonb(g) ORDER BY renewal_grant_id)::text)
        FROM swarm.renewal_grants g WHERE principal_id=${f.agentPrincipal}::uuid) AS renewal,
      (SELECT md5(jsonb_agg(to_jsonb(p) ORDER BY principal_id)::text)
        FROM swarm.agent_presence p WHERE principal_id IN
          (${f.agentPrincipal}::uuid,${f.hostedAgentPrincipal}::uuid)) AS presence,
      (SELECT count(*)::int FROM swarm.idempotency_keys
        WHERE principal_kind='agent' AND principal_id IN
          (${f.agentPrincipal},${f.hostedAgentPrincipal})) AS ledger,
      (SELECT md5(jsonb_agg(to_jsonb(b) ORDER BY bucket_key,window_start)::text)
        FROM swarm.rate_buckets b) AS metering,
      (SELECT count(*)::int FROM swarm.events WHERE workspace_id=${f.workspaceA}::uuid) AS events,
      (SELECT count(*)::int FROM swarm.audit_log WHERE workspace_id=${f.workspaceA}::uuid) AS audits`;
    return state!;
  };
  const deniedAgentWithoutTargetWait = async (credential: string, audited = true) => {
    const before = await agentEffects();
    let pending: Promise<CommandResult> | undefined;
    try {
      return await sql.begin(async blocker => {
        // Agent change_role target-lock ruling (2026-10-27): hold only the
        // submitted U row; response AND committed audit must precede release.
        await blocker`SELECT user_id FROM swarm.users WHERE user_id=${f.promoted.id}::uuid FOR UPDATE`;
        pending=postChange(credential,f.workspaceA,{
          kind:"change_role",user_id:f.promoted.id,role:"member",
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        let result: CommandResult;
        try {
          result=await Promise.race([pending,new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('agent role refusal waited on unauthorized target')),5_000);
          })]);
        } finally { if(timer)clearTimeout(timer); }
        assert.deepEqual(result,{status:403,body:{error:"forbidden"}});
        const audits=await blocker`SELECT outcome,reason FROM swarm.audit_log
          WHERE workspace_id=${f.workspaceA}::uuid AND command_kind='change_role'
            AND credential_id=(SELECT token_id FROM swarm.agent_tokens WHERE token_hash=
              ${createHash("sha256").update(credential).digest()})`;
        assert.deepEqual(Array.from(audits,r=>({...r})),audited ? [{outcome:"authz",reason:"forbidden"}] : [],
          'only a verified local agent has one security audit while the target is still locked');
        assert.deepEqual(await agentEffects(),{...before,audits:before.audits+Number(audited)},
          'before target unlock, only the verified refusal audit may change');
        return result;
      });
    } finally { if(pending)await pending.catch(()=>{}); }
  };
  const beforeAgent = await agentEffects();
  const agent = await deniedAgentWithoutTargetWait(f.agentCredential);
  assert.equal(agent.status, 403, JSON.stringify(agent.body));
  assert.deepEqual(agent.body, { error: "forbidden" });
  const agentAudit = await sql<{ outcome: string; reason: string | null }[]>`
    SELECT outcome, reason
    FROM swarm.audit_log
    WHERE workspace_id = ${f.workspaceA}::uuid
      AND command_kind = 'change_role'
      AND actor_agent_principal = ${f.agentPrincipal}::uuid
  `;
  assert.deepEqual(Array.from(agentAudit, (r) => ({ ...r })), [{ outcome: "authz", reason: "forbidden" }]);
  assert.deepEqual(await agentEffects(), {...beforeAgent, audits:beforeAgent.audits+1},
    'in-scope agent commits exactly one audit, no use stamp, presence, ledger or event');
  const beforeOutOfScope = await agentEffects();
  const outOfScope = await deniedAgentWithoutTargetWait(f.agentOutOfScopeCredential);
  assert.deepEqual(outOfScope,{status:403,body:{error:"forbidden"}});
  const outOfScopeAudit = await sql`SELECT outcome,reason FROM swarm.audit_log
    WHERE workspace_id=${f.workspaceA}::uuid AND command_kind='change_role'
      AND credential_id=(SELECT token_id FROM swarm.agent_tokens WHERE token_hash=
        ${createHash("sha256").update(f.agentOutOfScopeCredential).digest()})`;
  assert.deepEqual(Array.from(outOfScopeAudit,r=>({...r})),[{outcome:"authz",reason:"forbidden"}]);
  assert.deepEqual(await agentEffects(), {...beforeOutOfScope,audits:beforeOutOfScope.audits+1},
    'out-of-scope agent commits exactly one audit and no other effect');
  for (const credential of [
    `swm_agt_${randomBytes(32).toString("base64url")}`,
    f.hostedAgentCredential,
  ]) {
    const before = await agentEffects();
    assert.deepEqual(await deniedAgentWithoutTargetWait(credential,false),
      {status:403,body:{error:"forbidden"}});
    assert.deepEqual(await agentEffects(),before,
      'unknown bearer and hosted agent retain the early refusal with no audit or other effect');
  }
  // Neither a missing target nor a user with current tenancy only in B may
  // change the denial, reveal membership, or lose its one security audit.
  for(const credential of [f.agentCredential,f.agentOutOfScopeCredential]) {
    for(const target of [randomUUID(),f.former.id]) {
      const before=await agentEffects();
      assert.deepEqual(await postChange(credential,f.workspaceA,{
        kind:"change_role",user_id:target,role:"member",
      }),{status:403,body:{error:"forbidden"}});
      assert.deepEqual(await agentEffects(),{...before,audits:before.audits+1},
        'missing/foreign targets retain one audit and no other effect');
    }
  }
  const beforeForeign = await agentEffects();
  const foreign = await postChange(f.former.jwt,f.workspaceA,{
    kind:"change_role",user_id:f.promoted.id,role:"member",
  });
  assert.deepEqual(foreign,{status:403,body:{error:"forbidden"}});
  const unauthenticated = await postChange('invalid-session',f.workspaceA,{
    kind:"change_role",user_id:f.promoted.id,role:"member",
  });
  assert.deepEqual(unauthenticated,{status:401,body:{error:"unauthenticated"}});
  assert.deepEqual(await agentEffects(),beforeForeign,'foreign and unauthenticated callers create no audit or write');
  assert.equal((await liveRoles(f.workspaceA))[f.promoted.id], "admin");
  assert.equal(await roleChangeCount(f.workspaceA), 1);

  const landing = await postChange(f.owner.jwt, f.workspaceA, {
    kind: "change_role",
    user_id: f.plain.id,
    role: "admin",
  });
  assertRejected(
    landing,
    "landing_authority_unresolved",
    "landing authority must be transferred to a live successor first",
  );
  assert.equal((await liveRoles(f.workspaceA))[f.plain.id], "member");
  assert.equal((await roster(f.owner.jwt, f.workspaceA))[f.plain.id], "member");
  assert.equal((await liveRoles(f.workspaceB))[f.promoted.id], "member");
  assert.equal(await roleChangeCount(f.workspaceA), 1);
  assert.equal(await roleChangeCount(f.workspaceB), 0);
});
