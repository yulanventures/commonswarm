import { adminEdgeDatabase } from '../support/admin-edge-database.js';
/** Lane B: real command/read adapters and database migration; server suite only. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { createClient } from '@supabase/supabase-js';
import { emptyApplicationSchema } from '../support/admin-schema-db.js';

const scenarios = {
  runtime: 'legacy-admin-unreachable: opaque access, refresh, private mint and callbacks refuse with actual OAuth positive',
  boundary: 'admin-boundary-isolation: both schemes stay separate from human and worker surfaces',
  lifecycle: 'admin-revoke-every-request: init list read action idempotent and queued calls refuse with independent active control',
  consent: 'admin human consent is CSRF/session-bound, single-use, and full-account must be selected',
  limits: 'admin-request-audit: D3 init list read action and cached retries remain counted; surrender audit is atomic',
  expiry: 'admin-current-rights: rights loss narrowing and expiry refuse with human recovery and independent control',
  failure: 'admin rollback produces one failure card, no success event, and a replayable failure receipt',
  replay: 'edge-dpop-shared-replay: signed proofs across two SQL-backed instances restart rollback and cross-entry uniqueness',
  issuance: 'admin-access-issuance-required: signed unknown and mismatched JWTs refuse with committed issuance control',
  storage: 'admin migration preserves RLS, append-only audit, rollback, and account recovery after membership loss',
} as const;

for (const [scenario, label] of Object.entries(scenarios)) {
  test(label, { timeout: 180000 }, async () => {
    // Never print status: it contains local test credentials. No production targets.
    const local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    })) as { API_URL: string; ANON_KEY: string; DB_URL: string; SERVICE_ROLE_KEY: string };
    for (const target of [local.API_URL, local.DB_URL]) {
      assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(target).hostname), 'local stack required');
    }
    const root = '/private/tmp';
    const secretDir = execFileSync('mktemp', ['-d', '/private/tmp/anvil-secret.XXXXXX'], { encoding: 'utf8' }).trim();
    chmodSync(secretDir, 0o700);
    let isolated: Awaited<ReturnType<typeof adminEdgeDatabase>> | undefined;
    try {
      isolated = await adminEdgeDatabase(local.DB_URL);
      local.DB_URL = isolated.url;
      const sql = isolated.db;
      const auth = createClient(local.API_URL, local.SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
      const email = `admin-b-${randomUUID()}@example.test`, password = randomBytes(32).toString('base64url');
      const created = await auth.auth.admin.createUser({ email, password, email_confirm: true });
      assert.ok(!created.error && created.data.user, 'local human creation failed');
      const signed = await auth.auth.signInWithPassword({ email, password });
      assert.ok(!signed.error && signed.data.session, 'local human sign-in failed');
      const owner = created.data.user.id, workspace = randomUUID();
      await sql`INSERT INTO auth.users(id, aud, role, email) VALUES(${owner}::uuid, 'authenticated', 'authenticated', ${email})`;
      await sql`INSERT INTO swarm.users(user_id, display_name) VALUES (${owner}::uuid, 'Lane B owner')`;
      await sql`INSERT INTO swarm.workspaces(workspace_id, name, created_by) VALUES (${workspace}::uuid, 'Lane B', ${owner}::uuid)`;
      await sql`INSERT INTO swarm.memberships(workspace_id, user_id, role) VALUES (${workspace}::uuid, ${owner}::uuid, 'owner')`;
      const configPath = join(secretDir, 'local.json');
      writeFileSync(configPath, JSON.stringify({ local, owner, workspace, jwt: signed.data.session.access_token,
        ...(scenario === 'storage' ? { rollbackSchema: emptyApplicationSchema() } : {}) }), { mode: 0o600 });
      const run = spawnSync('deno', ['run', '--no-lock', '--config', 'supabase/functions/command/deno.json',
        '--allow-read', '--allow-env', '--allow-net', 'tests/support/admin-server-harness.mjs', configPath, scenario], {
        encoding: 'utf8', timeout: 150000, env: process.env,
      });
      // The harness emits only fixed assertion labels, never raw errors or secrets.
      assert.equal(run.status, 0, run.stdout);
      assert.match(run.stdout, /ADMIN_SERVER_OK/u);
    } finally {
      try { await isolated?.close(); } finally {
        const resolved = realpathSync(secretDir);
        assert.ok(dirname(resolved) === root && basename(resolved).startsWith('anvil-secret.') && resolved !== process.env.HOME, 'unsafe cleanup path');
        execFileSync('rm', ['-r', resolved], { stdio: 'pipe' });
      }
    }
  });
}
