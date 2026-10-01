/** Requires lane C to install read/admin-recovery.sql in the real migration. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";
import postgres from "postgres";

test("human recovery HTTP isolates accounts, workspace actions, effective expiry, and paginated audit", { timeout: 180000 }, async () => {
  const local = JSON.parse(execFileSync("supabase", ["status", "-o", "json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as {
    API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string;
  };
  for (const value of [local.API_URL, local.DB_URL]) assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname), "local stack required");
  const root = realpathSync(tmpdir()), secretDir = mkdtempSync(join(root, "anvil-secret.")); chmodSync(secretDir, 0o700);
  const db = postgres(local.DB_URL, { prepare: false });
  try {
    const auth = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    const people: Array<{ user_id: string; jwt: string }> = [];
    for (let i = 0; i < 3; i++) {
      const email = `admin-d-${randomUUID()}@example.test`, password = randomBytes(32).toString("base64url");
      const created = await auth.auth.admin.createUser({ email, password, email_confirm: true });
      assert.ok(!created.error && created.data.user, "local user creation failed");
      const signed = await auth.auth.signInWithPassword({ email, password });
      assert.ok(!signed.error && signed.data.session, "local sign-in failed");
      const user_id = created.data.user.id;
      await db`INSERT INTO swarm.users(user_id, display_name) VALUES (${user_id}::uuid, 'Recovery test')`;
      people.push({ user_id, jwt: signed.data.session.access_token });
    }
    const workspace = randomUUID(), owner = people[0]!.user_id;
    await db`INSERT INTO swarm.workspaces(workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Recovery test', ${owner}::uuid)`;
    for (const [i, person] of people.entries()) await db`INSERT INTO swarm.memberships(workspace_id, user_id, role) VALUES (${workspace}::uuid, ${person.user_id}::uuid, ${i < 2 ? "owner" : "member"})`;
    const config = join(secretDir, "test.json"); writeFileSync(config, JSON.stringify({ local, people, workspace }), { mode: 0o600 });
    const run = spawnSync("deno", ["run", "--no-lock", "--config", "supabase/functions/command/deno.json", "--allow-read", "--allow-env", "--allow-net", "tests/support/admin-recovery-server.mjs", config], {
      encoding: "utf8", timeout: 150000, env: { PATH: process.env.PATH ?? "", ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}) },
    });
    assert.equal(run.status, 0, run.stdout); assert.match(run.stdout, /ADMIN_RECOVERY_SERVER_OK/u);
  } finally {
    await db.end();
    const resolved = realpathSync(secretDir);
    assert.ok(dirname(resolved) === root && basename(resolved).startsWith("anvil-secret.") && resolved !== process.env.HOME, "unsafe cleanup path");
    execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
  }
});
