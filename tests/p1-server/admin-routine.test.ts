import { adminEdgeDatabase } from '../support/admin-edge-database.js';
/** Lane C: transactions, credential delivery and ancestry; server suite only. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { createClient } from "@supabase/supabase-js";

const scenarios = {
  workspace:
    "routine workspace creation is concurrent/idempotent, finite and only inherits confirmed scopes",
  invites:
    "routine invitations bind recipients, record pending authorization and revoke without budget refunds",
  renewal:
    "routine worker delivery, renewal and bounded replacement exclude secrets from replay and preserve ancestry",
  delivery:
    "protected worker delivery cancellation rolls back credentials while consuming the OAuth proof",
  history:
    "human history retains minimal linked cards for routine seat and credential revocation",
  expiry:
    "parent expiry refuses child authentication before a lazy expiration event",
  concurrency:
    "competing routine work and human revoke are ordered by the locked account stream",
  parent:
    "parent revocation fences existing child calls and subsequent delegated operations",
  rollback:
    "routine cross-stream rollback retains no principal, budget or success event",
  rights:
    "current role loss fences provisioned workers and delegated mutations while human recovery works",
} as const;

for (const [scenario, label] of Object.entries(scenarios)) {
  test(label, { timeout: 180000 }, async () => {
    // Never print status: it contains local test credentials. No production targets.
    const local = JSON.parse(
      execFileSync("supabase", ["status", "-o", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    ) as {
      API_URL: string;
      ANON_KEY: string;
      DB_URL: string;
      SERVICE_ROLE_KEY: string;
    };
    for (const target of [local.API_URL, local.DB_URL]) {
      assert.ok(
        ["127.0.0.1", "localhost", "[::1]"].includes(new URL(target).hostname),
        "local stack required",
      );
    }
    const root = realpathSync(process.platform === 'darwin' ? '/private/tmp' : tmpdir());
    const secretDir = execFileSync('mktemp', ['-d', join(root, 'anvil-secret.XXXXXX')], { encoding: 'utf8' }).trim();
    chmodSync(secretDir, 0o700);
    let isolated: Awaited<ReturnType<typeof adminEdgeDatabase>> | undefined;
    try {
      isolated = await adminEdgeDatabase(local.DB_URL);
      local.DB_URL = isolated.url;
      const sql = isolated.db;
      const auth = createClient(local.API_URL, local.SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const email = `admin-c-${randomUUID()}@example.test`,
        password = randomBytes(32).toString("base64url");
      const created = await auth.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
      });
      assert.ok(
        !created.error && created.data.user,
        "local human creation failed",
      );
      const signed = await auth.auth.signInWithPassword({ email, password });
      assert.ok(
        !signed.error && signed.data.session,
        "local human sign-in failed",
      );
      const invited = await auth.auth.admin.createUser({
        email: `admin-c-recipient-${randomUUID()}@example.test`,
        password: randomBytes(32).toString("base64url"),
        email_confirm: true,
      });
      assert.ok(
        !invited.error && invited.data.user,
        "local invitation recipient creation failed",
      );
      const owner = created.data.user.id,
        workspace = randomUUID(),
        recipient = invited.data.user.id;
      await sql`INSERT INTO auth.users(id, aud, role, email) VALUES(${owner}::uuid, 'authenticated', 'authenticated', ${email})`;
      await sql`INSERT INTO swarm.users(user_id, display_name) VALUES (${owner}::uuid, 'Lane C owner')`;
      await sql`INSERT INTO swarm.workspaces(workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Lane C', ${owner}::uuid)`;
      await sql`INSERT INTO swarm.memberships(workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner}::uuid, 'owner')`;
      await sql`INSERT INTO swarm.streams(stream_id, workspace_id, kind) VALUES (${randomUUID()}::uuid, ${workspace}::uuid, 'workspace')`;
      await sql`INSERT INTO auth.users(id, aud, role, email) VALUES(${recipient}::uuid, 'authenticated', 'authenticated', ${`recipient-${recipient}@example.test`})`;
      await sql`INSERT INTO swarm.users(user_id, display_name) VALUES (${recipient}::uuid, 'Invitation recipient')`;
      const configPath = join(secretDir, "local.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          local,
          owner,
          workspace,
          recipient,
          jwt: signed.data.session.access_token,
        }),
        { mode: 0o600 },
      );
      const run = spawnSync("deno", [
        "run",
        "--no-lock",
        "--config",
        "supabase/functions/command/deno.json",
        "--allow-read",
        "--allow-env",
        "--allow-net",
        "tests/support/admin-routine-server-harness.mjs",
        configPath,
        scenario,
      ], {
        encoding: "utf8",
        timeout: 150000,
        env: process.env,
      });
      // Forward only the handler's sanitized one-line diagnostics, never raw stderr.
      const failures = run.stderr.split(/\r?\n/u).filter(line => line.startsWith("admin_command_failed ")).join("\n");
      assert.equal(run.status, 0, run.stdout + failures);
      assert.match(run.stdout, /ADMIN_ROUTINE_SERVER_OK/u);
    } finally {
      try { await isolated?.close(); } finally {
        const resolved = realpathSync(secretDir);
        assert.ok(
          dirname(resolved) === root &&
            basename(resolved).startsWith("anvil-secret.") &&
            resolved !== process.env.HOME,
          "unsafe cleanup path",
        );
        execFileSync("rm", ["-r", resolved], { stdio: "pipe" });
      }
    }
  });
}
