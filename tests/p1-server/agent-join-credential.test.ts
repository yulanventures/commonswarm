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
import {
  AGENT_TOKEN_DEFAULT_TTL_MS,
  H0_SEAT_TOKEN_TTL_MS,
} from "../../src/protocol/index.js";
import { awaitFunctionRunning } from "../support/edge-readiness.js";
import { REGISTRATION_SEAT_REVOKED } from "../../supabase/functions/command/registration-conflicts.js";

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
  workspaceId: string = f.workspace,
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
      workspace_id: workspaceId,
      stream: { kind: "workspace" },
      command: body,
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function registrationCommand(
  bearer: string | null,
  attemptId: string,
  name = "Joined agent",
  commandId = randomUUID(),
): Promise<CommandResult> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${local.API_URL}/functions/v1/command`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      command_id: commandId,
      client_version: "0.1.0",
      /* Deliberately false routing input: registration must derive both from
       * the locked credential row rather than trusting this envelope. */
      workspace_id: randomUUID(),
      stream: { kind: "repo", repo_mapping_id: randomUUID() },
      command: {
        kind: "register_agent_seat",
        attempt_id: attemptId,
        name,
      },
    }),
  });
  return {
    status: response.status,
    body: await response.json() as Record<string, unknown>,
  };
}

async function mintJoinCredential(
  g: Fixture,
  seatCap: number,
): Promise<{ id: string; secret: string }> {
  const minted = await command(
    g.ownerJwt,
    { kind: "mint_agent_join_credential", seat_cap: seatCap, ttl_hours: 4 },
    randomUUID(),
    g.workspace,
  );
  assert.equal(minted.status, 200, JSON.stringify(minted.body));
  return {
    id: String(minted.body.join_credential_id),
    secret: String(minted.body.join_credential),
  };
}

async function useSeatToken(
  g: Fixture,
  token: string,
  suffix: string = randomUUID(),
): Promise<CommandResult> {
  return await command(
    token,
    {
      kind: "post_signal",
      signal_kind: "note",
      body: `registered-token-${suffix}`,
      to_user_id: null,
      about: null,
    },
    randomUUID(),
    g.workspace,
  );
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

/* ---------------------------------------------------------------------------------------------
 * Quotas, added after a review arm FAILED the first version of this lane. Each uses its own fresh
 * workspace so principal and credential counts are exactly what the test sets up.
 * ------------------------------------------------------------------------------------------- */

async function addPlainPrincipals(g: Fixture, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await sql`
      INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${randomUUID()}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${`filler-${randomUUID()}`})
    `;
  }
}

/** A registrar principal, device and run, plus the credential row that owns them. */
async function addRegistrar(g: Fixture, state: "live" | "expired"): Promise<string> {
  const principal = randomUUID();
  const device = randomUUID();
  const run = randomUUID();
  const credential = randomUUID();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${g.ownerId}::uuid, ${`Join registrar ${credential}`})`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${`join-registrar-${credential}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    const hash = createHash("sha256").update(`swm_join_${randomBytes(32).toString("base64url")}`).digest();
    const locator = randomBytes(16).toString("base64url");
    if (state === "live") {
      await tx`INSERT INTO swarm.agent_join_credentials (
          id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
          credential_hash, locator, seat_cap, seats_used, expires_at, mint_command_id)
        VALUES (${credential}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${principal}::uuid,
          ${run}::uuid, ${hash}, ${locator}, 3, 0, statement_timestamp() + interval '1 hour',
          ${randomUUID()})`;
    } else {
      /* Created 25 hours ago and expired 1 hour ago: exactly the 24-hour maximum, so the table's
       * own CHECKs accept it. The trigger guards UPDATE and DELETE, not INSERT. */
      await tx`INSERT INTO swarm.agent_join_credentials (
          id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
          credential_hash, locator, seat_cap, seats_used, created_at, expires_at, mint_command_id)
        VALUES (${credential}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${principal}::uuid,
          ${run}::uuid, ${hash}, ${locator}, 3, 0,
          statement_timestamp() - interval '25 hours', statement_timestamp() - interval '1 hour',
          ${randomUUID()})`;
    }
  });
  return credential;
}

async function addRegistrationCredential(
  g: Fixture,
  options: { expired?: boolean; seatCap?: number; seatsUsed?: number } = {},
): Promise<{ id: string; secret: string }> {
  const principal = randomUUID();
  const device = randomUUID();
  const run = randomUUID();
  const id = randomUUID();
  const secret = `swm_join_${randomBytes(32).toString("base64url")}`;
  const seatCap = options.seatCap ?? 2;
  const seatsUsed = options.seatsUsed ?? 0;
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.devices (device_id, user_id, label)
      VALUES (${device}::uuid, ${g.ownerId}::uuid, ${`Join registrar ${id}`})`;
    await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
      VALUES (${principal}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${`join-registrar-${id}`})`;
    await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
      VALUES (${run}::uuid, ${principal}::uuid, ${device}::uuid)`;
    if (options.expired) {
      await tx`INSERT INTO swarm.agent_join_credentials (
          id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
          credential_hash, locator, seat_cap, seats_used, created_at, expires_at, mint_command_id)
        VALUES (${id}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${principal}::uuid,
          ${run}::uuid, ${createHash("sha256").update(secret).digest()},
          ${randomBytes(16).toString("base64url")}, ${seatCap}, ${seatsUsed},
          statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour',
          ${randomUUID()})`;
    } else {
      await tx`INSERT INTO swarm.agent_join_credentials (
          id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
          credential_hash, locator, seat_cap, seats_used, expires_at, mint_command_id)
        VALUES (${id}::uuid, ${g.workspace}::uuid, ${g.ownerId}::uuid, ${principal}::uuid,
          ${run}::uuid, ${createHash("sha256").update(secret).digest()},
          ${randomBytes(16).toString("base64url")}, ${seatCap}, ${seatsUsed},
          statement_timestamp() + interval '4 hours', ${randomUUID()})`;
    }
  });
  return { id, secret };
}

async function memberOf(g: Fixture, role: "member" | "admin" = "member") {
  const user = await createUser();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO swarm.users (user_id, display_name) VALUES (${user.id}::uuid, 'Join Quota Member')`;
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role)
      VALUES (${g.workspace}::uuid, ${user.id}::uuid, ${role})`;
  });
  return user;
}

const mintIn = (g: Fixture, jwt: string, commandId = randomUUID()) =>
  command(jwt, { kind: "mint_agent_join_credential", seat_cap: 1, ttl_hours: 1 }, commandId, g.workspace);

test("agent-join credential quotas", async (t) => {
  await t.test("expired registrars free their slots and a live one holds its slot — asymmetric, so every wrong exclusion is caught", async () => {
    /* The finding: a registrar was revoked only on explicit revoke, so an ordinary expiry left it
     * counted against the 50-principal ceiling forever, hidden from every view.
     *
     * AN EARLIER VERSION OF THIS TEST PROVED LESS THAN ITS COMMIT SAID. It used ONE live and ONE
     * expired registrar and called the pair of results proof of "both halves". A review arm inverted
     * the predicate — excluding the LIVE registrar and counting the EXPIRED one — and the test stayed
     * green: with one of each, excluding either leaves the same count. So the setup is now ASYMMETRIC,
     * one live and TWO expired, so each wrong implementation lands on a different count:
     *
     *   rows: fixture 1 + fillers 46 + live 1 + expired 2 = 50 unrevoked principals
     *   correct   (exclude expired only)  counts 48 -> create, create, REFUSE
     *   inverted  (exclude live only)     counts 49 -> create, REFUSE
     *   none      (count every registrar) counts 50 -> REFUSE
     *   all       (exclude every registrar) counts 47 -> create, create, create
     *
     * Only the correct implementation produces exactly [200, 200, 403]. */
    const g = await createFixture();
    await addPlainPrincipals(g, 46);
    await addRegistrar(g, "live");
    await addRegistrar(g, "expired");
    await addRegistrar(g, "expired");
    const create = () =>
      command(g.ownerJwt, { kind: "create_agent_principal", name: `probe-${randomUUID()}` }, randomUUID(), g.workspace);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await create()).status);
    assert.deepEqual(statuses, [200, 200, 403], `create statuses ${statuses.join(",")}`);
  });

  await t.test("an expired credential can create no seat, enforced by the table itself", async () => {
    const g = await createFixture();
    const expired = await addRegistrar(g, "expired");
    await assert.rejects(
      sql`UPDATE swarm.agent_join_credentials SET seats_used = 1 WHERE id = ${expired}::uuid`,
      /SWARM_AGENT_JOIN_CREDENTIAL_IMMUTABLE/,
    );
    /* Positive control: the same update on a LIVE credential is allowed, so the refusal above comes
     * from the expiry rule and not from seats being frozen outright. */
    const live = await addRegistrar(g, "live");
    await sql`UPDATE swarm.agent_join_credentials SET seats_used = 1 WHERE id = ${live}::uuid`;
    const rows = await sql<{ seats_used: number }[]>`
      SELECT seats_used FROM swarm.agent_join_credentials WHERE id = ${live}::uuid`;
    assert.equal(rows[0].seats_used, 1);
  });

  await t.test("live credentials are capped per person, then per workspace, with no row written", async () => {
    /* The finding: minting had no bound, so one member could mint until the principal ceiling was
     * gone. Five per person; twenty per workspace. */
    const g = await createFixture();
    const liveCount = async (owner?: string) => (await sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM swarm.agent_join_credentials
      WHERE workspace_id = ${g.workspace}::uuid
        AND (${owner ?? null}::uuid IS NULL OR owner_user_id = ${owner ?? null}::uuid)`)[0].n;

    for (let i = 0; i < 5; i++) {
      const ok = await mintIn(g, g.ownerJwt);
      assert.equal(ok.status, 200, `owner mint ${i + 1}: ${JSON.stringify(ok.body)}`);
    }
    const sixth = await mintIn(g, g.ownerJwt);
    assert.equal(sixth.status, 403, JSON.stringify(sixth.body));
    assert.deepEqual(
      { error: sixth.body.error, scope: sixth.body.scope, limit: sixth.body.limit },
      { error: "join_credential_limit_reached", scope: "identity", limit: 5 },
    );
    assert.equal(await liveCount(g.ownerId), "5");

    for (let m = 0; m < 3; m++) {
      const member = await memberOf(g);
      for (let i = 0; i < 5; i++) {
        const ok = await mintIn(g, member.jwt);
        assert.equal(ok.status, 200, `member ${m} mint ${i + 1}: ${JSON.stringify(ok.body)}`);
      }
    }
    assert.equal(await liveCount(), "20");
    const late = await memberOf(g);
    const refused = await mintIn(g, late.jwt);
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(
      { error: refused.body.error, scope: refused.body.scope, limit: refused.body.limit },
      { error: "join_credential_limit_reached", scope: "workspace", limit: 20 },
    );
    assert.equal(await liveCount(late.id), "0", "a refused mint writes no row");
  });

  await t.test("six concurrent mints with room for one produce exactly one registrar", async () => {
    /* A BEHAVIOUR test of the ceiling under concurrent calls — and explicitly NOT a test of the lock.
     * With the advisory lock removed this still passed locally: the local edge runtime does not
     * interleave these transactions, so the race the lock prevents never occurs here. The lock is
     * pinned structurally in tests/p1-cli/agent-join-credential.test.ts. This test stays because it
     * proves the ceiling refuses the other five with principal_limit_reached. */
    const g = await createFixture();
    await addPlainPrincipals(g, 48);
    const results = await Promise.all(Array.from({ length: 6 }, () => mintIn(g, g.ownerJwt)));
    const accepted = results.filter((r) => r.status === 200).length;
    assert.equal(accepted, 1, `accepted ${accepted}: ${results.map((r) => r.status).join(",")}`);
    for (const r of results.filter((r) => r.status !== 200)) {
      assert.equal(r.status, 403);
      assert.equal(r.body.error, "principal_limit_reached");
    }
  });

  await t.test("a refused revoke audits WHICH refusal, while the caller sees one 403", async () => {
    const g = await createFixture();
    const minted = await mintIn(g, g.ownerJwt);
    assert.equal(minted.status, 200, JSON.stringify(minted.body));
    const stranger = await memberOf(g);
    const revoke = (id: string) =>
      command(stranger.jwt, { kind: "revoke_agent_join_credential", join_credential_id: id }, randomUUID(), g.workspace);
    const reasonFor = async () => (await sql<{ reason: string }[]>`
      SELECT reason FROM swarm.audit_log
      WHERE command_kind = 'revoke_agent_join_credential'
        AND workspace_id = ${g.workspace}::uuid
        AND actor_user = ${stranger.id}::uuid
      ORDER BY audit_id DESC LIMIT 1`)[0]?.reason;

    const notPermitted = await revoke(String(minted.body.join_credential_id));
    assert.equal(notPermitted.status, 403);
    assert.equal(await reasonFor(), "agent_join_credential_not_permitted");

    const notFound = await revoke(randomUUID());
    assert.equal(notFound.status, 403);
    assert.deepEqual(notFound.body, notPermitted.body, "the caller cannot tell the two apart");
    assert.equal(await reasonFor(), "agent_join_credential_not_found");
  });
});

async function workspacePrincipalCount(g: Fixture): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM swarm.agent_principals
    WHERE workspace_id = ${g.workspace}::uuid
  `;
  return Number(rows[0]?.n ?? "0");
}

async function attemptCount(credentialId: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*)::text AS n
    FROM swarm.agent_join_attempts
    WHERE join_credential_id = ${credentialId}::uuid
  `;
  return Number(rows[0]?.n ?? "0");
}

async function registrationProjectionCounts(
  g: Fixture,
  ownerId: string,
  credentialId: string,
): Promise<Record<string, number>> {
  const rows = await sql<{
    devices: number;
    principals: number;
    runs: number;
    grants: number;
    tokens: number;
    attempts: number;
    seats_used: number;
  }[]>`
    SELECT
      (SELECT count(*)::int FROM swarm.devices AS d
        WHERE d.user_id = ${ownerId}::uuid) AS devices,
      (SELECT count(*)::int FROM swarm.agent_principals AS p
        WHERE p.workspace_id = ${g.workspace}::uuid
          AND p.owner_user_id = ${ownerId}::uuid) AS principals,
      (SELECT count(*)::int
        FROM swarm.agent_runs AS r
        JOIN swarm.agent_principals AS p ON p.principal_id = r.principal_id
        WHERE p.workspace_id = ${g.workspace}::uuid
          AND p.owner_user_id = ${ownerId}::uuid) AS runs,
      (SELECT count(*)::int
        FROM swarm.renewal_grants AS rg
        JOIN swarm.agent_principals AS p ON p.principal_id = rg.principal_id
        WHERE p.workspace_id = ${g.workspace}::uuid
          AND p.owner_user_id = ${ownerId}::uuid) AS grants,
      (SELECT count(*)::int
        FROM swarm.agent_tokens AS t
        JOIN swarm.agent_principals AS p ON p.principal_id = t.principal_id
        WHERE p.workspace_id = ${g.workspace}::uuid
          AND p.owner_user_id = ${ownerId}::uuid) AS tokens,
      (SELECT count(*)::int FROM swarm.agent_join_attempts AS a
        WHERE a.join_credential_id = ${credentialId}::uuid) AS attempts,
      c.seats_used
    FROM swarm.agent_join_credentials AS c
    WHERE c.id = ${credentialId}::uuid
  `;
  assert.ok(rows[0], "join credential disappeared");
  return rows[0];
}

test("registration credential owner must remain a live workspace member", async () => {
  const g = await createFixture();

  const assertUniformRefusalWithoutWrites = async (
    ownerId: string,
    credentialId: string,
    credentialSecret: string,
    label: string,
  ) => {
    const before = await registrationProjectionCounts(g, ownerId, credentialId);
    const refused = await registrationCommand(
      credentialSecret,
      randomUUID(),
      label,
    );
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
    assert.deepEqual(refused.body, { error: "forbidden" });
    const after = await registrationProjectionCounts(g, ownerId, credentialId);
    assert.deepEqual(after, before, `${label} registration wrote seat projection rows`);
  };

  const liveOwner = await memberOf(g);
  const liveMint = await mintIn(g, liveOwner.jwt);
  assert.equal(liveMint.status, 200, JSON.stringify(liveMint.body));
  const liveRegistration = await registrationCommand(
    String(liveMint.body.join_credential),
    randomUUID(),
    "live member seat",
  );
  assert.equal(liveRegistration.status, 200, JSON.stringify(liveRegistration.body));

  const removedOwner = await memberOf(g);
  const removedMint = await mintIn(g, removedOwner.jwt);
  assert.equal(removedMint.status, 200, JSON.stringify(removedMint.body));
  const removedCredentialId = String(removedMint.body.join_credential_id);
  const removal = await command(
    g.ownerJwt,
    { kind: "remove_member", user_id: removedOwner.id },
    randomUUID(),
    g.workspace,
  );
  assert.equal(removal.status, 200, JSON.stringify(removal.body));
  await assertUniformRefusalWithoutWrites(
    removedOwner.id,
    removedCredentialId,
    String(removedMint.body.join_credential),
    "removed member seat",
  );

  const missingOwner = await memberOf(g);
  const missingMint = await mintIn(g, missingOwner.jwt);
  assert.equal(missingMint.status, 200, JSON.stringify(missingMint.body));
  const missingCredentialId = String(missingMint.body.join_credential_id);
  await sql`
    DELETE FROM swarm.memberships
    WHERE workspace_id = ${g.workspace}::uuid
      AND user_id = ${missingOwner.id}::uuid
  `;
  await assertUniformRefusalWithoutWrites(
    missingOwner.id,
    missingCredentialId,
    String(missingMint.body.join_credential),
    "missing member seat",
  );
});

test("register_agent_seat authentication and exact-kind gate", async (t) => {
  const g = await createFixture();
  const attempt = randomUUID();
  const beforePrincipals = await workspacePrincipalCount(g);

  await t.test("missing, malformed, and unknown join credentials share one 403", async () => {
    const unknown = `swm_join_${randomBytes(32).toString("base64url")}`;
    const results = await Promise.all([
      registrationCommand(null, attempt),
      registrationCommand("swm_join_bad", attempt),
      registrationCommand(unknown, attempt),
    ]);
    for (const result of results) {
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.deepEqual(result.body, { error: "forbidden" });
    }
    assert.equal(await workspacePrincipalCount(g), beforePrincipals);
  });

  await t.test("human and agent credentials cannot register", async () => {
    const [human, agent] = await Promise.all([
      registrationCommand(g.ownerJwt, randomUUID()),
      registrationCommand(g.agentToken, randomUUID()),
    ]);
    for (const result of [human, agent]) {
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.deepEqual(result.body, { error: "forbidden" });
    }
    assert.equal(await workspacePrincipalCount(g), beforePrincipals);
  });

  await t.test("a join credential cannot perform any other command class", async () => {
    const minted = await mintJoinCredential(g, 2);
    const otherKinds = [
      "post_signal",
      "create_agent_principal",
      "mint_agent_join_credential",
      "claim_agent_inbox",
      "not_a_command",
    ];
    for (const kind of otherKinds) {
      const result = await command(
        minted.secret,
        { kind },
        randomUUID(),
        g.workspace,
      );
      assert.equal(result.status, 403, `${kind}: ${JSON.stringify(result.body)}`);
      assert.deepEqual(result.body, { error: "forbidden" });
    }
    assert.equal(await attemptCount(minted.id), 0);
  });

  await t.test("revoked and expired credentials use the same authn refusal", async () => {
    const revoked = await mintJoinCredential(g, 1);
    const revoke = await command(
      g.ownerJwt,
      { kind: "revoke_agent_join_credential", join_credential_id: revoked.id },
      randomUUID(),
      g.workspace,
    );
    assert.equal(revoke.status, 200, JSON.stringify(revoke.body));
    const expired = await addRegistrationCredential(g, { expired: true });
    for (const item of [revoked, expired]) {
      const principals = await workspacePrincipalCount(g);
      const result = await registrationCommand(item.secret, randomUUID());
      assert.equal(result.status, 403, JSON.stringify(result.body));
      assert.deepEqual(result.body, { error: "forbidden" });
      assert.equal(await attemptCount(item.id), 0);
      assert.equal(await workspacePrincipalCount(g), principals);
    }
  });

  await t.test("a full credential is a named domain refusal and writes no seat", async () => {
    const full = await addRegistrationCredential(g, {
      seatCap: 1,
      seatsUsed: 1,
    });
    const principals = await workspacePrincipalCount(g);
    const result = await registrationCommand(full.secret, randomUUID());
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.error, "join_credential_seat_cap_reached");
    assert.equal(await attemptCount(full.id), 0);
    assert.equal(await workspacePrincipalCount(g), principals);
  });
});

test("register_agent_seat consumes seats atomically and carries G3 attribution", async (t) => {
  const g = await createFixture();
  const credential = await mintJoinCredential(g, 2);
  const credentialRows = await sql<{
    owner_user_id: string;
    registrar_principal_id: string;
    registrar_run_id: string;
  }[]>`
    SELECT owner_user_id, registrar_principal_id, registrar_run_id
    FROM swarm.agent_join_credentials
    WHERE id = ${credential.id}::uuid
  `;
  const registrar = credentialRows[0]!;
  const acceptedCommandIds = [randomUUID(), randomUUID()];
  const attempts = [randomUUID(), randomUUID()];
  const first = await registrationCommand(
    credential.secret,
    attempts[0],
    "same display label",
    acceptedCommandIds[0],
  );
  const second = await registrationCommand(
    credential.secret,
    attempts[1],
    "same display label",
    acceptedCommandIds[1],
  );
  for (const result of [first, second]) {
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.status, "accepted");
    assert.match(String(result.body.agent_token), /^swm_agt_[A-Za-z0-9_-]{43}$/);
    assert.equal(result.body.workspace_id, g.workspace, "request routing fields are ignored");
  }
  assert.notEqual(first.body.principal_id, second.body.principal_id);
  assert.notEqual(first.body.run_id, second.body.run_id);
  assert.notEqual(first.body.token_id, second.body.token_id);

  const beforeThird = await workspacePrincipalCount(g);
  const refusedCommandId = randomUUID();
  const refusedAttempt = randomUUID();
  const third = await registrationCommand(
    credential.secret,
    refusedAttempt,
    "third",
    refusedCommandId,
  );
  assert.equal(third.status, 409, JSON.stringify(third.body));
  assert.equal(third.body.error, "join_credential_seat_cap_reached");
  assert.equal(await workspacePrincipalCount(g), beforeThird);

  await t.test("seat count, marker rows, bindings, TTL, and renewal grant agree", async () => {
    const rows = await sql<{
      seats_used: number;
      attempts: string;
      principals: string;
      bindings: string;
      ttl_ms: number;
      grants: string;
    }[]>`
      SELECT
        c.seats_used,
        count(DISTINCT a.attempt_id)::text AS attempts,
        count(DISTINCT a.principal_id)::text AS principals,
        count(DISTINCT (a.principal_id, a.run_id, a.token_id))::text AS bindings,
        min(extract(epoch FROM (t.expires_at - t.issued_at)) * 1000)::float8 AS ttl_ms,
        count(DISTINCT g.renewal_grant_id)::text AS grants
      FROM swarm.agent_join_credentials AS c
      LEFT JOIN swarm.agent_join_attempts AS a
        ON a.join_credential_id = c.id
      LEFT JOIN swarm.agent_tokens AS t
        ON t.token_id = a.token_id
       AND t.principal_id = a.principal_id
       AND t.run_id = a.run_id
      LEFT JOIN swarm.renewal_grants AS g
        ON g.renewal_grant_id = t.renewal_grant_id
      WHERE c.id = ${credential.id}::uuid
      GROUP BY c.seats_used
    `;
    assert.deepEqual(
      {
        seats: rows[0]?.seats_used,
        attempts: rows[0]?.attempts,
        principals: rows[0]?.principals,
        bindings: rows[0]?.bindings,
        grants: rows[0]?.grants,
      },
      { seats: 2, attempts: "2", principals: "2", bindings: "2", grants: "2" },
    );
    assert.equal(
      rows[0]?.ttl_ms,
      H0_SEAT_TOKEN_TTL_MS,
      "a registered seat must expire exactly one ruled lifetime after issue",
    );
    assert.equal(await attemptCount(credential.id), 2);
    assert.equal(
      (await sql<{ n: string }[]>`
        SELECT count(*)::text AS n
        FROM swarm.agent_join_attempts
        WHERE principal_id IN (${g.agentPrincipal}::uuid, ${registrar.registrar_principal_id}::uuid)
      `)[0]?.n,
      "0",
      "neither a human-minted principal nor the registrar is an H0 seat",
    );
  });

  await t.test("the registered token authenticates for a real agent command", async () => {
    const used = await useSeatToken(g, String(first.body.agent_token));
    assert.equal(used.status, 200, JSON.stringify(used.body));
    assert.equal(used.body.status, "accepted");
  });

  await t.test("accepted and domain-refused audit and events use the registrar actor", async () => {
    const audits = await sql<{
      command_id: string;
      actor_user: string;
      actor_agent_principal: string;
      actor_run: string;
      outcome: string;
    }[]>`
      SELECT
        i.command_id,
        a.actor_user,
        a.actor_agent_principal,
        a.actor_run,
        a.outcome
      FROM swarm.idempotency_keys AS i
      JOIN LATERAL (
        SELECT actor_user, actor_agent_principal, actor_run, outcome
        FROM swarm.audit_log
        WHERE credential_kind = 'join'
          AND credential_id = ${credential.id}::uuid
          AND command_kind = 'register_agent_seat'
          AND request_hash = i.request_hash
        ORDER BY audit_id DESC
        LIMIT 1
      ) AS a ON true
      WHERE i.principal_kind = 'join'
        AND i.principal_id = ${credential.id}
        AND i.command_id IN (${acceptedCommandIds[0]}, ${refusedCommandId})
      ORDER BY i.command_id
    `;
    assert.equal(audits.length, 2);
    assert.deepEqual(new Set(audits.map((row) => row.outcome)), new Set(["accepted", "domain"]));
    for (const row of audits) {
      assert.equal(row.actor_user, registrar.owner_user_id);
      assert.equal(row.actor_agent_principal, registrar.registrar_principal_id);
      assert.equal(row.actor_run, registrar.registrar_run_id);
    }

    const events = await sql<{
      command_id: string;
      actor_user: string;
      actor_agent_principal: string;
      actor_run: string;
      payload: Record<string, unknown>;
    }[]>`
      SELECT command_id, actor_user, actor_agent_principal, actor_run, payload
      FROM swarm.events
      WHERE command_id IN (${acceptedCommandIds[0]}, ${refusedCommandId})
      ORDER BY seq
    `;
    assert.equal(events.length, 3, "accepted emits principal+token; refusal emits CommandRejected");
    for (const event of events) {
      assert.equal(event.actor_user, registrar.owner_user_id);
      assert.equal(event.actor_agent_principal, registrar.registrar_principal_id);
      assert.equal(event.actor_run, registrar.registrar_run_id);
    }
    assert.ok(
      events.some((event) => event.payload.principal_id === first.body.principal_id),
      "the created seat is the event subject",
    );
    assert.equal(
      events.some((event) => event.payload.principal_id === registrar.registrar_principal_id),
      false,
      "the registrar is the actor, never the subject",
    );
  });

  await t.test("the attempt marker cannot be erased or repointed", async () => {
    await assert.rejects(
      sql`DELETE FROM swarm.agent_join_attempts
          WHERE join_credential_id = ${credential.id}::uuid
            AND attempt_id = ${attempts[0]}::uuid`,
      /SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE/,
    );
    await assert.rejects(
      sql`UPDATE swarm.agent_join_attempts
          SET principal_id = ${randomUUID()}::uuid
          WHERE join_credential_id = ${credential.id}::uuid
            AND attempt_id = ${attempts[0]}::uuid`,
      /SWARM_AGENT_JOIN_ATTEMPT_IMMUTABLE/,
    );
  });
});

test("registration refuses at the shared principal ceiling without a seat row", async () => {
  const g = await createFixture();
  const credential = await mintJoinCredential(g, 1);
  /* fixture visible principal + live credential registrar + 48 fillers = 50 */
  await addPlainPrincipals(g, 48);
  assert.equal(await workspacePrincipalCount(g), 50);
  const result = await registrationCommand(credential.secret, randomUUID());
  assert.equal(result.status, 403, JSON.stringify(result.body));
  assert.equal(result.body.error, "principal_limit_reached");
  assert.equal(result.body.limit, 50);
  assert.equal(await workspacePrincipalCount(g), 50);
  assert.equal(await attemptCount(credential.id), 0);
  const rows = await sql<{ seats_used: number }[]>`
    SELECT seats_used FROM swarm.agent_join_credentials
    WHERE id = ${credential.id}::uuid
  `;
  assert.equal(rows[0]?.seats_used, 0);
});

test("a revoked unused seat cannot be revived by retrying its attempt", async (t) => {
  const expectedMessage = REGISTRATION_SEAT_REVOKED.message;

  await t.test("revoked token", async () => {
    const g = await createFixture();
    const credential = await mintJoinCredential(g, 2);
    const attempt = randomUUID();
    const first = await registrationCommand(credential.secret, attempt, "revoked token seat");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const revoked = await command(
      g.ownerJwt,
      { kind: "revoke_agent_token", token_id: String(first.body.token_id) },
      randomUUID(),
      g.workspace,
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const retry = await registrationCommand(credential.secret, attempt, "revoked token seat");
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error, "registration_seat_revoked");
    assert.equal(retry.body.message, expectedMessage);
    assert.equal(retry.body.agent_token, undefined);
    const fresh = await registrationCommand(credential.secret, randomUUID(), "new token seat");
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal((await useSeatToken(g, String(fresh.body.agent_token))).status, 200);
  });

  await t.test("revoked principal", async () => {
    const g = await createFixture();
    const credential = await mintJoinCredential(g, 2);
    const attempt = randomUUID();
    const first = await registrationCommand(credential.secret, attempt, "revoked principal seat");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const revoked = await command(
      g.ownerJwt,
      { kind: "revoke_agent_principal", principal_id: String(first.body.principal_id) },
      randomUUID(),
      g.workspace,
    );
    assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
    const retry = await registrationCommand(credential.secret, attempt, "revoked principal seat");
    assert.equal(retry.status, 409, JSON.stringify(retry.body));
    assert.equal(retry.body.error, "registration_seat_revoked");
    assert.equal(retry.body.message, expectedMessage);
    assert.equal(retry.body.agent_token, undefined);
    const fresh = await registrationCommand(credential.secret, randomUUID(), "new principal seat");
    assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
    assert.equal((await useSeatToken(g, String(fresh.body.agent_token))).status, 200);
  });
});

test("a registered seat renews with a short successor inside its seat horizon", async () => {
  const g = await createFixture();
  const credential = await mintJoinCredential(g, 1);
  const registered = await registrationCommand(credential.secret, randomUUID(), "renewing seat");
  assert.equal(registered.status, 200, JSON.stringify(registered.body));
  const tokenId = String(registered.body.token_id);
  const token = String(registered.body.agent_token);
  const before = await sql<{
    issued_at: Date;
    expires_at: Date;
    horizon_expires_at: Date;
  }[]>`
    SELECT t.issued_at, t.expires_at, g.horizon_expires_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.renewal_grants AS g ON g.renewal_grant_id = t.renewal_grant_id
    WHERE t.token_id = ${tokenId}::uuid
  `;
  assert.ok(before[0]);
  assert.equal(
    before[0].expires_at.getTime() - before[0].issued_at.getTime(),
    H0_SEAT_TOKEN_TTL_MS,
  );
  assert.equal(before[0].horizon_expires_at.getTime(), before[0].expires_at.getTime());

  const used = await useSeatToken(g, token, "before-renewal");
  assert.equal(used.status, 200, JSON.stringify(used.body));
  const renewed = await command(
    token,
    { kind: "renew_agent_token" },
    randomUUID(),
    g.workspace,
  );
  assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
  const successor = await sql<{ issued_at: Date; expires_at: Date }[]>`
    SELECT issued_at, expires_at
    FROM swarm.agent_tokens
    WHERE token_id = ${String(renewed.body.token_id)}::uuid
  `;
  assert.ok(successor[0]);
  const successorTtl = successor[0].expires_at.getTime() - successor[0].issued_at.getTime();
  assert.ok(Math.abs(successorTtl - AGENT_TOKEN_DEFAULT_TTL_MS) < 10_000);
  assert.ok(successor[0].expires_at.getTime() <= before[0].horizon_expires_at.getTime());
});

test("same registration POST deliberately remints only while its token is unused", async () => {
  const g = await createFixture();
  const credential = await mintJoinCredential(g, 1);
  const attempt = randomUUID();
  const commandId = randomUUID();
  const name = "same POST seat";
  const first = await registrationCommand(credential.secret, attempt, name, commandId);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  const conflict = await registrationCommand(
    credential.secret,
    attempt,
    "different body",
    commandId,
  );
  assert.equal(conflict.status, 409, JSON.stringify(conflict.body));
  assert.deepEqual(conflict.body, { error: "command_id_conflict" });

  const reminted = await registrationCommand(credential.secret, attempt, name, commandId);
  assert.equal(reminted.status, 200, JSON.stringify(reminted.body));
  assert.notEqual(reminted.body.token_id, first.body.token_id);
  assert.equal(reminted.body.principal_id, first.body.principal_id);
  assert.equal(reminted.body.run_id, first.body.run_id);
  const used = await useSeatToken(g, String(reminted.body.agent_token), "same-post");
  assert.equal(used.status, 200, JSON.stringify(used.body));

  const afterUse = await registrationCommand(credential.secret, attempt, name, commandId);
  assert.equal(afterUse.status, 409, JSON.stringify(afterUse.body));
  assert.equal(afterUse.body.error, "registration_token_already_used");
  assert.equal(afterUse.body.message, "Revoke that seat and register again.");
  assert.equal(afterUse.body.agent_token, undefined);
});

test("registration retry recovers only an unused token and never stores a secret", async () => {
  const g = await createFixture();
  const credential = await mintJoinCredential(g, 3);
  const attempt = randomUUID();
  const firstCommandId = randomUUID();
  const first = await registrationCommand(
    credential.secret,
    attempt,
    "retry seat",
    firstCommandId,
  );
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstSecret = String(first.body.agent_token);
  const firstTokenId = String(first.body.token_id);
  const principalId = String(first.body.principal_id);
  const runId = String(first.body.run_id);

  const replacementCommandId = randomUUID();
  const replacement = await registrationCommand(
    credential.secret,
    attempt,
    "retry seat",
    replacementCommandId,
  );
  assert.equal(replacement.status, 200, JSON.stringify(replacement.body));
  const replacementSecret = String(replacement.body.agent_token);
  assert.notEqual(replacementSecret, firstSecret);
  assert.notEqual(replacement.body.token_id, firstTokenId);
  assert.equal(replacement.body.principal_id, principalId);
  assert.equal(replacement.body.run_id, runId);
  assert.equal(replacement.body.seats_used, 1);
  const replacementLifetime = await sql<{ expires_at: Date; horizon_expires_at: Date }[]>`
    SELECT t.expires_at, g.horizon_expires_at
    FROM swarm.agent_tokens AS t
    JOIN swarm.renewal_grants AS g ON g.renewal_grant_id = t.renewal_grant_id
    WHERE t.token_id = ${String(replacement.body.token_id)}::uuid
  `;
  assert.ok(replacementLifetime[0]);
  assert.ok(
    replacementLifetime[0].expires_at.getTime() <=
      replacementLifetime[0].horizon_expires_at.getTime(),
    "a replacement token must not outlive its seat horizon",
  );

  const oldUse = await useSeatToken(g, firstSecret, "old");
  assert.notEqual(oldUse.status, 200, "the replaced token must not authenticate");
  const replacementUse = await useSeatToken(g, replacementSecret, "replacement");
  assert.equal(replacementUse.status, 200, JSON.stringify(replacementUse.body));

  const usedRetryCommandId = randomUUID();
  const usedRetry = await registrationCommand(
    credential.secret,
    attempt,
    "retry seat",
    usedRetryCommandId,
  );
  assert.equal(usedRetry.status, 409, JSON.stringify(usedRetry.body));
  assert.equal(usedRetry.body.error, "registration_token_already_used");
  assert.equal(usedRetry.body.message, "Revoke that seat and register again.");
  assert.equal(usedRetry.body.seats_used, undefined);

  const secondAttempt = randomUUID();
  const second = await registrationCommand(
    credential.secret,
    secondAttempt,
    "second host",
  );
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.seats_used, 2);
  assert.notEqual(second.body.principal_id, principalId);
  const firstStillWorks = await useSeatToken(g, replacementSecret, "after-second-host");
  assert.equal(firstStillWorks.status, 200, JSON.stringify(firstStillWorks.body));
  assert.equal(await attemptCount(credential.id), 2);

  const tokenRows = await sql<{
    old_revoked_at: Date | null;
    old_first_used_at: Date | null;
    current_token_id: string;
    seats_used: number;
  }[]>`
    SELECT
      old.revoked_at AS old_revoked_at,
      old.first_used_at AS old_first_used_at,
      a.token_id AS current_token_id,
      c.seats_used
    FROM swarm.agent_tokens AS old
    JOIN swarm.agent_join_attempts AS a
      ON a.join_credential_id = ${credential.id}::uuid
     AND a.attempt_id = ${attempt}::uuid
    JOIN swarm.agent_join_credentials AS c ON c.id = a.join_credential_id
    WHERE old.token_id = ${firstTokenId}::uuid
  `;
  assert.ok(tokenRows[0]?.old_revoked_at instanceof Date);
  assert.equal(tokenRows[0]?.old_first_used_at, null);
  assert.equal(tokenRows[0]?.current_token_id, replacement.body.token_id);
  assert.equal(tokenRows[0]?.seats_used, 2);

  const stored = await sql<{
    ledger: string;
    audits: string;
    events: string;
    attempts: string;
  }[]>`
    SELECT
      coalesce((SELECT string_agg(response::text, E'\n')
        FROM swarm.idempotency_keys
        WHERE principal_kind = 'join' AND principal_id = ${credential.id}), '') AS ledger,
      coalesce((SELECT string_agg(coalesce(detail, ''), E'\n')
        FROM swarm.audit_log
        WHERE credential_kind = 'join' AND credential_id = ${credential.id}::uuid), '') AS audits,
      coalesce((SELECT string_agg(payload::text, E'\n')
        FROM swarm.events
        WHERE actor_agent_principal = (
          SELECT registrar_principal_id FROM swarm.agent_join_credentials
          WHERE id = ${credential.id}::uuid
        )), '') AS events,
      coalesce((SELECT string_agg(a::text, E'\n')
        FROM swarm.agent_join_attempts AS a
        WHERE join_credential_id = ${credential.id}::uuid), '') AS attempts
  `;
  const atRest = Object.values(stored[0] ?? {}).join("\n");
  for (const secret of [firstSecret, replacementSecret, String(second.body.agent_token)]) {
    assert.equal(atRest.includes(secret), false, "a raw seat secret reached stored state");
  }
  const replayRows = await sql<{ response: Record<string, unknown> }[]>`
    SELECT response FROM swarm.idempotency_keys
    WHERE principal_kind = 'join'
      AND principal_id = ${credential.id}
      AND command_id IN (${firstCommandId}, ${replacementCommandId}, ${usedRetryCommandId})
  `;
  assert.equal(replayRows.length, 3);
  assert.equal(
    replayRows.some((row) => Object.hasOwn(row.response, "agent_token")),
    false,
    "no stored response may contain the fresh-only key",
  );
});
