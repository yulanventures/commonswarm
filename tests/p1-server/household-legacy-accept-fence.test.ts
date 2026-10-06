/** CI only: legacy accept repeats the household boundary check under the row locks. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import postgres from 'postgres';
import { localClusterAdminUrl } from '../support/admin-schema-db.js';

class RollbackProof extends Error {}

function openCluster() {
  let local: { DB_URL: string };
  try { local = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })); }
  catch { throw new Error('Local Supabase is unavailable; this proof requires the authorized CI stack.'); }
  return postgres(localClusterAdminUrl(local.DB_URL), { prepare: false, max: 2 });
}

async function fences() {
  const bundled = await build({
    stdin: { contents: `export { legacyAcceptEarlyRefusal, legacyAcceptLockedFence } from './supabase/functions/command/index.ts';`, resolveDir: process.cwd() },
    bundle: true, write: false, platform: 'node', format: 'esm', target: 'es2022', logLevel: 'silent',
    banner: { js: `
      const settings = { SWARM_ENV: 'test', SWARM_DATABASE_URL: 'postgres://127.0.0.1:1/unused',
        SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_ANON_KEY: 'inert-test-value' };
      const Deno = { env: { get: (name) => settings[name] }, serve: () => { throw new Error('unexpected server'); } };
      const priorDeno = Object.getOwnPropertyDescriptor(globalThis, 'Deno');
      Object.defineProperty(globalThis, 'Deno', { value: Deno, configurable: true });` },
    footer: { js: `
      if (priorDeno) Object.defineProperty(globalThis, 'Deno', priorDeno);
      else Reflect.deleteProperty(globalThis, 'Deno');` },
    plugins: [{ name: 'inert-legacy-transports', setup(builder) {
      builder.onResolve({ filter: /^npm:/ }, (args) => ({ path: args.path, namespace: 'inert-edge' }));
      builder.onLoad({ filter: /.*/, namespace: 'inert-edge' }, (args) => {
        if (args.path === 'npm:@supabase/supabase-js@2.110.8') {
          return { loader: 'js', contents: 'export function createClient() { return { auth: { async getUser() { return { error: null, data: { user: null } }; }, async getClaims() { return { error: null, data: { claims: {} } }; } } }; }' };
        }
        if (args.path === 'npm:postgres@3.4.9') {
          return { loader: 'js', contents: 'export default function postgres() { const sql = async () => []; sql.begin = async () => {}; sql.json = (value) => value; return sql; }' };
        }
        throw new Error(`unexpected edge dependency ${args.path}`);
      });
    } }],
  });
  return await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]!.text).toString('base64')}`) as {
    legacyAcceptEarlyRefusal(tx: postgres.TransactionSql<Record<string, unknown>>, route: { workspaceId: string }, auth: { email: string | null; actor: { user: string | null } }, invitationHash: Uint8Array | null): Promise<{ error: string; message: string } | null>;
    legacyAcceptLockedFence(tx: postgres.TransactionSql<Record<string, unknown>>, route: { workspaceId: string }, auth: { email: string | null; actor: { user: string | null } }, invitationHash: Uint8Array | null): Promise<{ error: string; message: string } | null>;
  };
}

function identity(userId: string, email: string | null) {
  return { email, actor: { user: userId, agent_principal: null, run: null } };
}

test('a workspace without a household boundary keeps legacy accept, and a boundary refuses it', { timeout: 120_000 }, async () => {
  const api = await fences();
  const db = openCluster();
  const user = randomUUID(), workspace = randomUUID(), invitation = randomUUID();
  const token = `swm_inv_${'B'.repeat(43)}`;
  const hash = createHash('sha256').update(token).digest();
  const route = { workspaceId: workspace };
  const matched = identity(user, 'Person@Example.test');
  const other = identity(user, 'other@example.test');
  try {
    await assert.rejects(db.begin(async (tx) => {
      await tx`INSERT INTO auth.users(id,aud,role,email) VALUES (${user}::uuid,'authenticated','authenticated',${'person@example.test'})`;
      await tx`INSERT INTO swarm.users(user_id,display_name,email) VALUES (${user}::uuid,'Synthetic owner',${'person@example.test'})`;
      await tx`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${workspace}::uuid,'Synthetic household',${user}::uuid)`;
      await tx`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by) VALUES
        (${invitation}::uuid,${workspace}::uuid,${'person@example.test'},'member',${hash},clock_timestamp()+interval '1 day',${user}::uuid)`;
      assert.equal(await api.legacyAcceptEarlyRefusal(tx, route, matched, hash), null);
      assert.equal(await api.legacyAcceptLockedFence(tx, route, matched, hash), null);
      assert.equal(await api.legacyAcceptEarlyRefusal(tx, route, other, hash), null);
      assert.equal(await api.legacyAcceptLockedFence(tx, route, other, hash), null);
      await tx`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${workspace}::uuid,'shared')`;
      const mismatch = await api.legacyAcceptEarlyRefusal(tx, route, other, hash);
      assert.equal(mismatch?.error, 'invitation_recipient_mismatch');
      assert.equal((await api.legacyAcceptLockedFence(tx, route, other, hash))?.error, 'invitation_recipient_mismatch');
      const consent = await api.legacyAcceptEarlyRefusal(tx, route, matched, hash);
      assert.equal(consent?.error, 'recipient_consent_required');
      assert.equal(consent?.message, 'Open the invitation in /invite and review it as yourself.');
      const lockedConsent = await api.legacyAcceptLockedFence(tx, route, matched, hash);
      assert.equal(lockedConsent?.error, 'recipient_consent_required');
      assert.equal(lockedConsent?.message, 'Open the invitation in /invite and review it as yourself.');
      await tx`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspace}::uuid`;
      await tx`INSERT INTO swarm.memberships(workspace_id,user_id,role,revoked_at)
        SELECT ${workspace}::uuid, ${user}::uuid, 'owner', created_at FROM swarm.invitations WHERE invitation_id=${invitation}::uuid`;
      const predates = await api.legacyAcceptLockedFence(tx, route, matched, hash);
      assert.equal(predates?.error, 'invitation_predates_removal');
      assert.equal(await api.legacyAcceptEarlyRefusal(tx, route, matched, hash), null);
      await tx`UPDATE swarm.memberships SET revoked_at=(SELECT created_at - interval '1 minute' FROM swarm.invitations WHERE invitation_id=${invitation}::uuid)
        WHERE workspace_id=${workspace}::uuid AND user_id=${user}::uuid`;
      assert.equal(await api.legacyAcceptLockedFence(tx, route, matched, hash), null);
      assert.equal(await api.legacyAcceptEarlyRefusal(tx, route, matched, hash), null);
      await tx`UPDATE swarm.memberships SET revoked_at=NULL WHERE workspace_id=${workspace}::uuid AND user_id=${user}::uuid`;
      assert.equal(await api.legacyAcceptLockedFence(tx, route, matched, hash), null);
      const [row] = await tx<{ consumed_at: Date | null }[]>`SELECT consumed_at FROM swarm.invitations WHERE invitation_id=${invitation}::uuid`;
      assert.equal(row?.consumed_at, null);
      throw new RollbackProof();
    }), RollbackProof);
  } finally {
    await db.end();
  }
});

test('a household boundary committed after the first check is visible before consumption', { timeout: 120_000 }, async () => {
  const api = await fences();
  const db = openCluster();
  const user = randomUUID(), workspace = randomUUID(), invitation = randomUUID();
  const hash = createHash('sha256').update(`swm_inv_${'H'.repeat(43)}`).digest();
  const route = { workspaceId: workspace };
  const matched = identity(user, 'person@example.test');
  try {
    await db`INSERT INTO auth.users(id,aud,role,email) VALUES (${user}::uuid,'authenticated','authenticated',${'person@example.test'})`;
    await db`INSERT INTO swarm.users(user_id,display_name,email) VALUES (${user}::uuid,'Synthetic owner',${'person@example.test'})`;
    await db`INSERT INTO swarm.workspaces(workspace_id,name,created_by) VALUES (${workspace}::uuid,'Synthetic household',${user}::uuid)`;
    await db`INSERT INTO swarm.invitations(invitation_id,workspace_id,email,role,token_hash,expires_at,created_by) VALUES
      (${invitation}::uuid,${workspace}::uuid,${'person@example.test'},'member',${hash},clock_timestamp()+interval '1 day',${user}::uuid)`;
    await db.begin(async (tx1) => {
      assert.equal(await api.legacyAcceptEarlyRefusal(tx1, route, matched, hash), null);
      await db.begin(async (tx2) => {
        await tx2`INSERT INTO swarm.household_workspace_boundaries(workspace_id,purpose) VALUES (${workspace}::uuid,'shared')`;
      });
      const locked = await api.legacyAcceptLockedFence(tx1, route, matched, hash);
      assert.equal(locked?.error, 'recipient_consent_required');
      const [row] = await tx1<{ consumed_at: Date | null }[]>`SELECT consumed_at FROM swarm.invitations WHERE invitation_id=${invitation}::uuid`;
      assert.equal(row?.consumed_at, null);
    });
  } finally {
    await db`DELETE FROM swarm.invitations WHERE workspace_id=${workspace}::uuid`;
    await db`DELETE FROM swarm.household_workspace_boundaries WHERE workspace_id=${workspace}::uuid`;
    await db`DELETE FROM swarm.workspaces WHERE workspace_id=${workspace}::uuid`;
    await db`DELETE FROM swarm.users WHERE user_id=${user}::uuid`;
    await db`DELETE FROM auth.users WHERE id=${user}::uuid`;
    await db.end();
  }
});
