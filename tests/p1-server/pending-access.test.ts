import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  let ownerA = "";
  let ownerB = "";
  try {
    const a = await admin.auth.admin.createUser({ email: `pending-a-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"), email_confirm: true });
    const b = await admin.auth.admin.createUser({ email: `pending-b-${randomUUID()}@example.test`,
      password: randomBytes(24).toString("base64url"), email_confirm: true });
    assert.ifError(a.error);
    assert.ifError(b.error);
    ownerA = a.data.user!.id;
    ownerB = b.data.user!.id;
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
    const partialRegistrar = randomUUID();
    const expiredRun = randomUUID();
    const revokedRun = randomUUID();
    const partialRun = randomUUID();
    const partialJoin = randomUUID();
    const rolledBack = new Error("pending access fixture rolled back");
    await assert.rejects(sql.begin(async (tx) => {
      // Source-mode is for local mutation probes only. Normal server runs assert
      // the function actually installed in the database.
      if (process.env.CSWARM_PENDING_ACCESS_SOURCE) {
        const source = readFileSync(process.env.CSWARM_PENDING_ACCESS_SOURCE, "utf8")
          .replace(/^CREATE FUNCTION /m, "CREATE OR REPLACE FUNCTION ");
        await tx.unsafe(source);
      }
      await tx`INSERT INTO swarm.users (user_id, display_name) VALUES
        (${ownerA}::uuid, 'Pending A'), (${ownerB}::uuid, 'Pending B')`;
      await tx`INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES
        (${workspaceA}::uuid, ${`Pending ${workspaceA}`} , ${ownerA}::uuid),
        (${workspaceB}::uuid, ${`Pending ${workspaceB}`} , ${ownerB}::uuid)`;
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
        (${partialRegistrar}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid, 'Partial registrar'),
        (${otherTenant}::uuid, ${workspaceB}::uuid, ${ownerB}::uuid, 'Other tenant')`;
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${run}::uuid, ${registrar}::uuid, ${device}::uuid),
          (${expiredRun}::uuid, ${expiredRegistrar}::uuid, ${device}::uuid),
          (${revokedRun}::uuid, ${revokedRegistrar}::uuid, ${device}::uuid),
          (${partialRun}::uuid, ${partialRegistrar}::uuid, ${device}::uuid)`;
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
          statement_timestamp() + interval '1 hour', ${`pending-${joinId}`})`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seat_cap, created_at, expires_at, mint_command_id)
        VALUES (${expiredJoin}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${expiredRegistrar}::uuid, ${expiredRun}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1,
          statement_timestamp() - interval '2 hours', statement_timestamp() - interval '1 hour',
          ${`pending-${expiredJoin}`})`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seat_cap, expires_at, revoked_at, revoked_by, mint_command_id)
        VALUES (${revokedJoin}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${revokedRegistrar}::uuid, ${revokedRun}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1,
          statement_timestamp() + interval '1 hour', statement_timestamp(), ${ownerA}::uuid,
          ${`pending-${revokedJoin}`})`;
      await tx`INSERT INTO swarm.agent_join_credentials
        (id, workspace_id, owner_user_id, registrar_principal_id, registrar_run_id,
         credential_hash, locator, seats_used, seat_cap, expires_at, mint_command_id)
        VALUES (${partialJoin}::uuid, ${workspaceA}::uuid, ${ownerA}::uuid,
          ${partialRegistrar}::uuid, ${partialRun}::uuid, ${randomBytes(32)},
          ${randomBytes(16).toString("base64url")}, 1, 3,
          statement_timestamp() + interval '1 hour', ${`pending-${partialJoin}`})`;

    const revokedSibling = randomUUID();
    const expiredSibling = randomUUID();
    const usedSibling = randomUUID();
    const revokedOnly = randomUUID();
    const expiredOnly = randomUUID();
    const ownerLeft = randomUUID();
    for (const [id, name, owner] of [
      [revokedSibling, "Revoked sibling", ownerA],
      [expiredSibling, "Expired sibling", ownerA],
      [usedSibling, "Used sibling", ownerA],
      [revokedOnly, "Revoked only", ownerA],
      [expiredOnly, "Expired only", ownerA],
      [ownerLeft, "Owner left", ownerB],
    ]) {
      await tx`INSERT INTO swarm.agent_principals (principal_id, workspace_id, owner_user_id, name)
        VALUES (${id}::uuid, ${workspaceA}::uuid, ${owner}::uuid, ${name})`;
    }
    await tx`INSERT INTO swarm.memberships (workspace_id, user_id, role, revoked_at)
      VALUES (${workspaceA}::uuid, ${ownerB}::uuid, 'member', statement_timestamp())`;
    async function addToken(principal: string, state: "live" | "revoked" | "expired" | "used", ageHours: number) {
      const tokenRun = randomUUID();
      const id = randomUUID();
      await tx`INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
        VALUES (${tokenRun}::uuid, ${principal}::uuid, ${device}::uuid)`;
      await tx`INSERT INTO swarm.agent_tokens
        (token_id, principal_id, run_id, scopes, token_hash, issued_at, expires_at,
         revoked_at, first_used_at, lineage_id)
        VALUES (${id}::uuid, ${principal}::uuid, ${tokenRun}::uuid,
          ${tx.json(["post_signal"])}::jsonb, ${randomBytes(32)},
          statement_timestamp() - ${ageHours} * interval '1 hour',
          statement_timestamp() + ${state === "expired" ? -1 : 24} * interval '1 hour',
          ${state === "revoked" ? new Date() : null},
          NULL, ${randomUUID()}::uuid)`;
      if (state === "used") await tx`UPDATE swarm.agent_tokens
        SET first_used_at = statement_timestamp() WHERE token_id = ${id}::uuid`;
    }
    await addToken(revokedSibling, "revoked", 10);
    await addToken(revokedSibling, "live", 5);
    await addToken(revokedSibling, "live", 2);
    await addToken(expiredSibling, "expired", 10);
    await addToken(expiredSibling, "live", 3);
    await addToken(usedSibling, "live", 2);
    await addToken(usedSibling, "used", 1);
    await addToken(revokedOnly, "revoked", 2);
    await addToken(expiredOnly, "expired", 2);

    async function readAs(userId: string, workspaceId: string) {
      return await tx.savepoint(async (sp) => {
        await sp`SELECT set_config('role', 'swarm_read', true),
          set_config('request.jwt.claims', ${JSON.stringify({ sub: userId, role: "authenticated" })}, true)`;
        // postgres.js returns a Result array subclass; compare plain rows.
        const rows = [...await sp<Record<string, unknown>[]>`
          SELECT kind, principal_id, principal_name, join_credential_id,
                 owner_user_id, issuer_display, issued_at, expires_at,
                 seats_used, seat_cap
          FROM swarm_read.pending_access(${workspaceId}::uuid)`];
        await sp`SELECT set_config('role', 'none', true)`;
        return rows;
      });
    }

    const visible = await readAs(ownerA, workspaceA);
    assert.equal(visible.length, 6);
    assert.deepEqual(visible.map((row) => row.kind).sort(), ["classic", "classic", "classic", "classic", "join", "join"]);
    assert.ok(visible.some((row) => row.principal_id === noToken));
    assert.ok(visible.some((row) => row.principal_id === withToken));
    assert.ok(visible.some((row) => row.principal_id === revokedSibling));
    assert.ok(visible.some((row) => row.principal_id === expiredSibling));
    for (const hidden of [usedSibling, revokedOnly, expiredOnly, ownerLeft]) {
      assert.ok(!visible.some((row) => row.principal_id === hidden), `hidden principal ${hidden}`);
    }
    const renewed = visible.find((row) => row.principal_id === revokedSibling)!;
    assert.ok(Date.now() - new Date(String(renewed.issued_at)).getTime() < 3 * 3_600_000);
    assert.ok(new Date(String(renewed.expires_at)).getTime() > Date.now());
    const afterExpiry = visible.find((row) => row.principal_id === expiredSibling)!;
    assert.ok(Date.now() - new Date(String(afterExpiry.issued_at)).getTime() < 4 * 3_600_000);
    assert.ok(new Date(String(afterExpiry.expires_at)).getTime() > Date.now());
    assert.ok(visible.some((row) => row.join_credential_id === joinId));
    assert.ok(visible.some((row) => row.join_credential_id === partialJoin && row.seats_used === 1 && row.seat_cap === 3));
    assert.ok(visible.every((row) => row.issuer_display === "Pending A"));
    assert.ok(!visible.some((row) => row.principal_id === registrar));
    assert.ok(!visible.some((row) => row.join_credential_id === expiredJoin));
    assert.ok(!visible.some((row) => row.join_credential_id === revokedJoin));
    assert.deepEqual(Object.keys(visible[0]!).sort(), [
      "expires_at", "issued_at", "issuer_display", "join_credential_id", "kind",
      "owner_user_id", "principal_id", "principal_name", "seat_cap", "seats_used",
    ]);
    const catalog = await tx<{ proargnames: string[] }[]>`
      SELECT proargnames FROM pg_proc
      WHERE oid = 'swarm_read.pending_access(uuid)'::regprocedure`;
    const projected = catalog[0]!.proargnames.slice(1);
    assert.deepEqual(projected, ["kind", "principal_id", "principal_name", "join_credential_id",
      "owner_user_id", "issuer_display", "issued_at", "expires_at", "seats_used", "seat_cap"]);
    const privileges = await tx<{ human: boolean; agent: boolean; anonymous: boolean;
      command: boolean; service: boolean; authenticator: boolean }[]>`
      SELECT
        has_function_privilege('authenticated', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS human,
        has_function_privilege('swarm_read', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS agent,
        has_function_privilege('anon', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS anonymous,
        has_function_privilege('swarm_command', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS command,
        has_function_privilege('service_role', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS service,
        has_function_privilege('authenticator', 'swarm_read.pending_access(uuid)', 'EXECUTE') AS authenticator`;
    assert.deepEqual(privileges[0], { human: true, agent: true, anonymous: false,
      command: false, service: false, authenticator: false });
    assert.deepEqual(await readAs(ownerA, workspaceB), []);
    assert.deepEqual(await readAs(ownerB, workspaceA), []);
    assert.equal((await readAs(ownerB, workspaceB)).length, 1);

    await tx`UPDATE swarm.agent_tokens SET first_used_at = statement_timestamp()
      WHERE token_id = ${tokenId}::uuid`;
    await tx`UPDATE swarm.agent_join_credentials SET seats_used = seat_cap
      WHERE id IN (${joinId}::uuid, ${partialJoin}::uuid)`;
    await tx`UPDATE swarm.agent_principals SET revoked_at = statement_timestamp()
      WHERE principal_id = ${noToken}::uuid`;
    // Mutation controls: all three were visible before the state changed.
    const remaining = await readAs(ownerA, workspaceA);
    assert.deepEqual(remaining.map((row) => row.principal_id).sort(),
      [revokedSibling, expiredSibling].sort());
    throw rolledBack;
    }), (error) => error === rolledBack);
    const leftovers = await sql<{ workspaces: number; credentials: number }[]>`
      SELECT
        (SELECT count(*)::integer FROM swarm.workspaces
         WHERE workspace_id IN (${workspaceA}::uuid, ${workspaceB}::uuid)) AS workspaces,
        (SELECT count(*)::integer FROM swarm.agent_join_credentials
         WHERE workspace_id IN (${workspaceA}::uuid, ${workspaceB}::uuid)) AS credentials`;
    assert.deepEqual(leftovers[0], { workspaces: 0, credentials: 0 });
  } finally {
    await sql.end();
    const deleted = await Promise.all([ownerA, ownerB].filter(Boolean).map((id) =>
      admin.auth.admin.deleteUser(id)));
    for (const result of deleted) assert.ifError(result.error);
  }
});
