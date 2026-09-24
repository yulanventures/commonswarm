import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

interface LocalEnvironment {
  API_URL: string;
  SERVICE_ROLE_KEY: string;
  DB_URL: string;
}

test("pending access is member scoped, omits secrets, and clears on durable state changes", { timeout: 60_000 }, async () => {
  const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000,
  })) as LocalEnvironment;
  assert.ok(local.API_URL.startsWith("http://127.0.0.1:"));
  assert.ok(local.DB_URL.includes("127.0.0.1"));
  const sql = postgres(local.DB_URL, { prepare: false, max: 2 });
  const admin = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  try {
    const a = await admin.auth.admin.createUser({ email: `pending-a-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"), email_confirm: true });
    const b = await admin.auth.admin.createUser({ email: `pending-b-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"), email_confirm: true });
    assert.ifError(a.error);
    assert.ifError(b.error);
    const ownerA = a.data.user!.id;
    const ownerB = b.data.user!.id;
    const workspaceA = randomUUID();
    const workspaceB = randomUUID();
    const noToken = randomUUID();
    const withToken = randomUUID();
    const otherTenant = randomUUID();
    const registrar = randomUUID();
    const run = randomUUID();
    const device = randomUUID();
    const tokenId = randomUUID();
    const joinId = randomUUID();
    const expiredJoin = randomUUID();
    const revokedJoin = randomUUID();
    const expiredRegistrar = randomUUID();
    const revokedRegistrar = randomUUID();
    const expiredRun = randomUUID();
    const revokedRun = randomUUID();
    await sql.begin(async (tx) => {
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES
        (${ownerA}::uuid, 'Pending A'), (${ownerB}::uuid, 'Pending B')`;
      await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES
        (${workspaceA}::uuid, 'Pending A', ${ownerA}::uuid),
        (${workspaceB}::uuid, 'Pending B', ${ownerB}::uuid)`;
      await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES
        (${workspaceA}::uuid, ${ownerA}::uuid, 'owner'),
        (${workspaceB}::uuid, ${ownerB}::uuid, 'owner')`;
      await tx`INSERT INTO swarm.devices (device_id, user_id, label)
        VALUES (${device}::uuid, ${ownerA}::uuid, 'pending-test')`;
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name) VALUES
        (${noToken}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'No token'),
        (${withToken}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'Issued token'),
        (${registrar}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'Hidden registrar'),
        (${expiredRegistrar}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'Expired registrar'),
        (${revokedRegistrar}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'Revoked registrar'),
        (${otherTenant}::uuid, ${workspaceB}::uuid, ${ownerB}::uuid, 'Other tenant')`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${run}::uuid, ${registrar}::uuid, ${device}::uuid),
          (${expiredRun}::uuid, ${expiredRegistrar}::uuid, ${device}::uuid),
          (${revokedRun}::uuid, ${revokedRegistrar}::uuid, ${device}::uuid)`;
      const tokenRun = randomUUID();
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${tokenRun}::uuid, ${withToken}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens
        (token_id, principal_id, run_id, scopes, token_hash, expires_at, lineage_id)
        VALUES (${tokenId}::uuid, ${withToken}::uuid, ${tokenRun}::uuid,
          ${tx.json(["post_signal"])}::jsonb, ${randomBytes(32)},
          statement_timestamp() + interval '1 hour', ${randomUUID()}::uuid)`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seat_cap, expires_at, mint_command_id)
        VALUES (${joinId}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${registrar}::uuid, ${run}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1,
          statement_timestamp() + interval '1 hour', 'pending-test-mint')`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seat_cap, created_at, expires_at, mint_command_id)
        VALUES (${expiredJoin}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${expiredRegistrar}::uuid, ${expiredRun}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1,
          statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour',
          'pending-expired-mint')`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seat_cap, expires_at, revoked_at, revoked_by, mint_command_id)
        VALUES (${revokedJoin}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${revokedRegistrar}::uuid, ${revokedRun}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1,
          statement_timestamp() + interval '1 hour', statement_timestamp(), ${ownerA}::uuid,
          'pending-revoked-mint')`;
    });

    async function readAs(userId: string, workspaceId: string) {
      return await sql.begin(async (tx) => {
        await tx`SELECT set_config('role', 'swarm_read', true),
          set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        return await tx<Record<string, unknown>[]>`
          SELECT kind, principal_id, principal_name, join_credential_id,
                 owner_user_id, issuer_display, issued_at, expires_at,
                 seats_used, seat_cap
          FROM swarm_read.pending_access(${workspaceId}::uuid)`;
      });
    }

    const visible = await readAs(ownerA, workspaceA);
    assert.equal(visible.length, 3);
    assert.deepEqual(visible.map((row) => row.kind).sort(), ["classic", "classic", "join"]);
    assert.ok(visible.some((row) => row.principal_id === noToken));
    assert.ok(visible.some((row) => row.principal_id === withToken));
    assert.ok(visible.some((row) => row.join_credential_id === joinId));
    assert.ok(visible.every((row) => row.issuer_display === "Pending A"));
    assert.ok(!visible.some((row) => row.principal_id === registrar));
    assert.ok(!visible.some((row) => row.join_credential_id === expiredJoin));
    assert.ok(!visible.some((row) => row.join_credential_id === revokedJoin));
    assert.deepEqual(Object.keys(visible[0]!).sort(), [
      "expires_at", "issued_at", "issuer_display", "join_credential_id", "kind",
      "owner_user_id", "principal_id", "principal_name", "seat_cap", "seats_used",
    ]);
    const catalog = await sql<{ proargnames: string[] }[]>`
      SELECT proargnames FROM pg_proc
      WHERE oid = 'swarm_read.pending_access(uuid)'::regprocedure`;
    const projected = catalog[0]!.proargnames.slice(1);
    assert.ok(projected.length >= 10);
    assert.ok(projected.every((name) => !/hash|secret|locator|token/i.test(name)));
    const privileges = await sql<{ human: boolean; agent: boolean; anonymous: boolean }[]>`
      SELECT
        has_function_privilege('authenticated', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS human,
        has_function_privilege('swarm_read', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS agent,
        has_function_privilege('anon', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS anonymous`;
    assert.deepEqual(privileges[0], { human: true, agent: true, anonymous: false });
    assert.deepEqual(await readAs(ownerA, workspaceB), []);
    assert.deepEqual(await readAs(ownerB, workspaceA), []);
    assert.equal((await readAs(ownerB, workspaceB)).length, 1);

    await sql`UPDATE swarm.agent_tokens SET first_used_at = statement_timestamp()
      WHERE token_id = ${tokenId}::uuid`;
    await sql`UPDATE swarm.agent_join_credentials SET seats_used = seat_cap
      WHERE id = ${joinId}::uuid`;
    await sql`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
      WHERE principal_id = ${noToken}::uuid`;
    // Mutation controls: all three were visible before the state changed.
    assert.deepEqual(await readAs(ownerA, workspaceA), []);
  } finally {
    await sql.end();
  }
});
