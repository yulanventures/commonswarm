/**
 * H0 agent-join credential controls against local Postgres and served edges.
 * Reached by test:p1-server's glob; this file never accepts a remote target.
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

interface Fixture {
  workspace: string;
  ownerId: string;
  ownerJwt: string;
  agentPrincipal: string;
  agentToken: string;
}

interface CommandResult {
  status: number;
  body: Record<string, unknown>;
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
  for (const raw of [parsed.API_URL, parsed.DB_URL]) {
    const url = new URL(raw!);
    assert.ok(
      url.hostname === "127.0.0.1" || url.hostname === "localhost" ||
        url.hostname === "[::1]",
      `agent-join server test refuses non-loopback target ${url.hostname}`,
    );
  }
  return parsed as LocalEnvironment;
}

async function createUser(): Promise<{ id: string; jwt: string }> {
  const email = `join-owner-${randomUUID()}@example.test`;
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
  return {
    id: created.data.user.id,
    jwt: signedIn.data.session.access_token,
  };
}

async function createFixture(): Promise<Fixture> {
  const owner = await createUser();
  const workspace = randomUUID();
  const stream = randomUUID();
  const agentDevice = randomUUID();
  const agentPrincipal = randomUUID();
  const agentRun = randomUUID();
  const agentToken = `swm_agt_${randomBytes(32).toString("base64url")}`;
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO swarm.users (user_id, display_name)
      VALUES (${owner.id}::uuid, 'Join Owner')
    `;
    await tx`
      INSERT INTO swarm.workspaces (workspace_id, name, created_by)
      VALUES (${workspace}::uuid, 'Join Test', ${owner.id}::uuid)
    `;
    await tx`
      INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${workspace}::uuid, ${owner.id}::uuid, 'owner')
    `;
    await tx`
      INSERT INTO swarm.streams (stream_id, workspace_id, kind)
      VALUES (${stream}::uuid, ${workspace}::uuid, 'workspace')
    `;
    await tx`
      INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${agentDevice}::uuid, ${owner.id}::uuid, 'join-test-agent')
    `;
    await tx`
      INSERT INTO swarm.agent_principals (
        principal_id, workspace_id, owner_user_id, name
      ) VALUES (
        ${agentPrincipal}::uuid,
        ${workspace}::uuid,
        ${owner.id}::uuid,
        'visible-test-agent'
      )
    `;
    await tx`
      INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (
        ${agentRun}::uuid,
        ${agentPrincipal}::uuid,
        ${agentDevice}::uuid
      )
    `;
    await tx`
      INSERT INTO swarm.agent_tokens (
        token_id, principal_id, run_id, scopes, token_hash,
        expires_at, lineage_id
      ) VALUES (
        ${randomUUID()}::uuid,
        ${agentPrincipal}::uuid,
        ${agentRun}::uuid,
        ${tx.json(["post_signal"])}::jsonb,
        ${createHash("sha256").update(agentToken).digest()},
        statement_timestamp() + interval '1 hour',
        ${randomUUID()}::uuid
      )
    `;
  });
  return {
    workspace,
    ownerId: owner.id,
    ownerJwt: owner.jwt,
    agentPrincipal,
    agentToken,
  };
}

before(async () => {
  local = localEnvironment();
  sql = postgres(local.DB_URL, { prepare: false, max: 5 });
  admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  envDir = mkdtempSync(join(tmpdir(), "cswarm-agent-join-env-"));
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
  const bootDeadline = Date.now() + 60_000;
  while (!functionLogs.includes("Serving functions on")) {
    if (Date.now() > bootDeadline) {
      throw new Error(`functions serve never booted:\n${functionLogs.slice(-3000)}`);
    }
    await delay(250);
  }
  for (const edge of ["command", "read"]) {
    await awaitFunctionRunning({
      url: `${local.API_URL}/functions/v1/${edge}`,
      fetcher: fetch,
      timeoutMs: 30_000,
      sleep: (ms) => delay(ms),
      now: () => Date.now(),
      diagnostics: () => `${edge} function logs:\n${functionLogs.slice(-4000)}`,
    });
  }
  f = await createFixture();
});

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

async function command(
  bearer: string,
  body: Record<string, unknown>,
  commandId = randomUUID(),
): Promise<CommandResult> {
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearer}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      workspace_id: f.workspace,
      stream: { kind: "workspace" },
      command: body,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function roster(): Promise<CommandResult> {
  const response = await fetch(`${local.API_URL}/functions/v1/read`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${f.agentToken}`,
      apikey: local.ANON_KEY,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      resource: "members",
      workspace_id: f.workspace,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

test("agent-join credential lifecycle", async (t) => {
  const mintCommandId = randomUUID();
  const fresh = await command(f.ownerJwt, {
    kind: "mint_agent_join_credential",
    seat_cap: 3,
    ttl_hours: 4,
  }, mintCommandId);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.status, "accepted");
  assert.match(String(fresh.body.join_credential), /^swm_join_[A-Za-z0-9_-]{43}$/);
  assert.match(String(fresh.body.locator), /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(fresh.body.join_credential, fresh.body.locator);
  const secret = String(fresh.body.join_credential);
  const credentialId = String(fresh.body.join_credential_id);

  await t.test("mint replay returns no secret", async () => {
    const replay = await command(f.ownerJwt, {
      kind: "mint_agent_join_credential",
      seat_cap: 3,
      ttl_hours: 4,
    }, mintCommandId);
    assert.equal(replay.status, 200, JSON.stringify(replay.body));
    assert.equal(replay.body.join_credential_id, credentialId);
    assert.equal(Object.hasOwn(replay.body, "join_credential"), false);
    assert.equal(JSON.stringify(replay.body).includes(secret), false);
  });

  await t.test("only the SHA-256 digest is stored", async () => {
    const rows = await sql<{
      digest: string;
      row_text: string;
      ledger_text: string;
      audit_text: string;
    }[]>`
      SELECT
        encode(c.credential_hash, 'hex') AS digest,
        c::text AS row_text,
        i.response::text AS ledger_text,
        coalesce(a.detail, '') AS audit_text
      FROM swarm.agent_join_credentials AS c
      JOIN swarm.idempotency_keys AS i
        ON i.principal_kind = 'user'
       AND i.principal_id = ${f.ownerId}
       AND i.command_id = ${mintCommandId}
      LEFT JOIN LATERAL (
        SELECT detail
        FROM swarm.audit_log
        WHERE workspace_id = c.workspace_id
          AND command_kind = 'mint_agent_join_credential'
          AND outcome = 'accepted'
        ORDER BY occurred_at DESC
        LIMIT 1
      ) AS a ON true
      WHERE c.id = ${credentialId}::uuid
    `;
    assert.equal(rows.length, 1);
    assert.equal(
      rows[0].digest,
      createHash("sha256").update(secret).digest("hex"),
    );
    assert.equal(rows[0].row_text.includes(secret), false);
    assert.equal(rows[0].ledger_text.includes(secret), false);
    assert.equal(rows[0].audit_text.includes(secret), false);
  });

  await t.test("seats_used cannot exceed seat_cap in PostgreSQL", async () => {
    await assert.rejects(
      async () => {
        await sql`
          UPDATE swarm.agent_join_credentials
          SET seats_used = seat_cap + 1
          WHERE id = ${credentialId}::uuid
        `;
      },
      (error: unknown) =>
        typeof error === "object" && error !== null &&
        "code" in error && error.code === "23514",
    );
    const rows = await sql<{ seats_used: number; seat_cap: number }[]>`
      SELECT seats_used, seat_cap
      FROM swarm.agent_join_credentials
      WHERE id = ${credentialId}::uuid
    `;
    assert.deepEqual(rows[0], { seats_used: 0, seat_cap: 3 });
  });

  await t.test("TTL above 24 hours is refused before insert", async () => {
    const beforeRows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM swarm.agent_join_credentials
      WHERE workspace_id = ${f.workspace}::uuid
    `;
    const refused = await command(f.ownerJwt, {
      kind: "mint_agent_join_credential",
      seat_cap: 3,
      ttl_hours: 25,
    });
    assert.equal(refused.status, 400, JSON.stringify(refused.body));
    const afterRows = await sql<{ n: string }[]>`
      SELECT count(*)::text AS n
      FROM swarm.agent_join_credentials
      WHERE workspace_id = ${f.workspace}::uuid
    `;
    assert.equal(afterRows[0].n, beforeRows[0].n);
  });

  await t.test("an agent credential can neither mint nor revoke", async () => {
    const agentMint = await command(f.agentToken, {
      kind: "mint_agent_join_credential",
      seat_cap: 1,
      ttl_hours: 1,
    });
    assert.equal(agentMint.status, 403, JSON.stringify(agentMint.body));
    const agentRevoke = await command(f.agentToken, {
      kind: "revoke_agent_join_credential",
      join_credential_id: credentialId,
    });
    assert.equal(agentRevoke.status, 403, JSON.stringify(agentRevoke.body));
    const rows = await sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM swarm.agent_join_credentials
      WHERE id = ${credentialId}::uuid
    `;
    assert.equal(rows[0].revoked_at, null);
  });

  await t.test("a non-member and a revoked member cannot mint; a live plain member can", async () => {
    /* THE GATE IS INHERITED, SO IT IS PINNED HERE. mintAgentJoinCredential never checks membership
     * itself: a non-member is refused by resolveRoute and a revoked member by revoked() at step 6,
     * both before dispatch. The lead traced that path during review and found no test for it —
     * and an inherited gate with no test is the one a later refactor of the dispatch order drops
     * silently, letting any signed-in human mint a seat-creating credential into any workspace.
     *
     * The live plain MEMBER minting successfully is the positive control: without it, a 403 below
     * could come from a bad JWT or a role rule rather than the membership gate being tested. */
    const mintBy = (jwt: string) =>
      command(jwt, { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 });
    const rowsOwnedBy = async (userId: string) =>
      (await sql<{ n: string }[]>`
        SELECT count(*)::text AS n FROM swarm.agent_join_credentials
        WHERE owner_user_id = ${userId}::uuid
      `)[0].n;

    const outsider = await createUser();
    await sql`INSERT INTO swarm.users (user_id, display_name) VALUES (${outsider.id}::uuid, 'Join Outsider')`;
    const outsiderMint = await mintBy(outsider.jwt);
    assert.equal(outsiderMint.status, 403, JSON.stringify(outsiderMint.body));
    assert.equal(await rowsOwnedBy(outsider.id), "0");

    const revokedMember = await createUser();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${revokedMember.id}::uuid, 'Join Revoked')`;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role, revoked_at)
        VALUES (${f.workspace}::uuid, ${revokedMember.id}::uuid, 'member', statement_timestamp())
      `;
    });
    const revokedMint = await mintBy(revokedMember.jwt);
    assert.equal(revokedMint.status, 403, JSON.stringify(revokedMint.body));
    assert.equal(await rowsOwnedBy(revokedMember.id), "0");

    const liveMember = await createUser();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${liveMember.id}::uuid, 'Join Member')`;
      await tx`
        INSERT INTO swarm.memberships (workspace_id, user_id, role)
        VALUES (${f.workspace}::uuid, ${liveMember.id}::uuid, 'member')
      `;
    });
    const memberMint = await mintBy(liveMember.jwt);
    assert.equal(memberMint.status, 200, JSON.stringify(memberMint.body));
    assert.equal(await rowsOwnedBy(liveMember.id), "1");
  });

  let registrarPrincipal = "";
  let registrarRun = "";
  let registrarDevice = "";
  await t.test("mint creates and links one registrar principal, device and run", async () => {
    const rows = await sql<{
      owner_user_id: string;
      registrar_principal_id: string;
      registrar_run_id: string;
      principal_workspace_id: string;
      principal_owner_user_id: string;
      name: string;
      run_principal_id: string;
      device_id: string;
      device_user_id: string;
      label: string;
    }[]>`
      SELECT
        c.owner_user_id,
        c.registrar_principal_id,
        c.registrar_run_id,
        p.workspace_id AS principal_workspace_id,
        p.owner_user_id AS principal_owner_user_id,
        p.name,
        r.principal_id AS run_principal_id,
        r.device_id,
        d.user_id AS device_user_id,
        d.label
      FROM swarm.agent_join_credentials AS c
      JOIN swarm.agent_principals AS p
        ON p.principal_id = c.registrar_principal_id
       AND p.workspace_id = c.workspace_id
       AND p.owner_user_id = c.owner_user_id
      JOIN swarm.agent_runs AS r
        ON r.run_id = c.registrar_run_id
       AND r.principal_id = c.registrar_principal_id
      JOIN swarm.devices AS d ON d.device_id = r.device_id
      WHERE c.id = ${credentialId}::uuid
    `;
    assert.equal(rows.length, 1, "the four mint rows must commit together");
    const row = rows[0];
    registrarPrincipal = row.registrar_principal_id;
    registrarRun = row.registrar_run_id;
    registrarDevice = row.device_id;
    assert.equal(row.owner_user_id, f.ownerId);
    assert.equal(row.principal_workspace_id, f.workspace);
    assert.equal(row.principal_owner_user_id, f.ownerId);
    assert.equal(row.run_principal_id, registrarPrincipal);
    assert.equal(row.device_user_id, f.ownerId);
    assert.equal(row.name, `join-registrar-${credentialId}`);
    assert.equal(row.label, `Join registrar ${credentialId}`);
  });

  await t.test("the registrar is absent from the roster", async () => {
    const result = await roster();
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const agents = result.body.agents as Array<Record<string, unknown>>;
    assert.ok(Array.isArray(agents));
    assert.ok(
      agents.some((agent) => agent.principal_id === f.agentPrincipal),
      "positive control: the ordinary agent must be visible",
    );
    assert.equal(
      agents.some((agent) => agent.principal_id === registrarPrincipal),
      false,
    );
  });

  await t.test("revoke ends only the registrar lifecycle", async () => {
    const revoked = await command(f.ownerJwt, {
      kind: "revoke_agent_join_credential",
      join_credential_id: credentialId,
    });
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const rows = await sql<{
      credential_revoked_at: Date | null;
      principal_revoked_at: Date | null;
      run_ended_at: Date | null;
      device_revoked_at: Date | null;
      visible_agent_revoked_at: Date | null;
    }[]>`
      SELECT
        c.revoked_at AS credential_revoked_at,
        p.revoked_at AS principal_revoked_at,
        r.ended_at AS run_ended_at,
        d.revoked_at AS device_revoked_at,
        visible.revoked_at AS visible_agent_revoked_at
      FROM swarm.agent_join_credentials AS c
      JOIN swarm.agent_principals AS p
        ON p.principal_id = ${registrarPrincipal}::uuid
      JOIN swarm.agent_runs AS r
        ON r.run_id = ${registrarRun}::uuid
      JOIN swarm.devices AS d
        ON d.device_id = ${registrarDevice}::uuid
      JOIN swarm.agent_principals AS visible
        ON visible.principal_id = ${f.agentPrincipal}::uuid
      WHERE c.id = ${credentialId}::uuid
    `;
    assert.ok(rows[0].credential_revoked_at instanceof Date);
    assert.ok(rows[0].principal_revoked_at instanceof Date);
    assert.ok(rows[0].run_ended_at instanceof Date);
    assert.ok(rows[0].device_revoked_at instanceof Date);
    assert.equal(rows[0].visible_agent_revoked_at, null);
  });
});
