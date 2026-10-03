/** Isolated edge fixture lifecycle regressions. Docker-dependent, server only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import postgres from 'postgres';
import { adminEdgeDatabase } from '../support/admin-edge-database.js';
import { localClusterAdminUrl } from '../support/admin-schema-db.js';

function localDatabaseUrl(): string {
  // Local status contains credentials; never retain or print its raw output.
  const status = JSON.parse(execFileSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  })) as { DB_URL?: string };
  assert.ok(status.DB_URL, 'local database required');
  return localClusterAdminUrl(status.DB_URL);
}

test('isolated edge restore resets dump session settings before RLS-protected cutover', async (t) => {
  const isolated = await adminEdgeDatabase(localDatabaseUrl());
  t.after(() => isolated.close());
  const [settings] = await isolated.db<{ row_security: string; check_function_bodies: string; search_path: string }[]>`
    SELECT current_setting('row_security') AS row_security,
      current_setting('check_function_bodies') AS check_function_bodies,
      current_setting('search_path') AS search_path`;
  assert.equal(settings?.row_security, 'on');
  assert.equal(settings?.check_function_bodies, 'on');
  assert.notEqual(settings?.search_path, '', 'dump must not leave an empty search path');
  await isolated.db.begin(async tx => {
    await tx.unsafe('SET LOCAL ROLE commonswarm_admin_release');
    const [state] = await tx<{ admin_issuance_enabled: boolean }[]>`
      SELECT admin_issuance_enabled FROM commonswarm_oauth.admin_cutover_state WHERE singleton`;
    assert.equal(state?.admin_issuance_enabled, true, 'isolated test-only cutover succeeds under RLS');
  });
});

test('isolated edge close drops its created database even when disconnect throws', async (t) => {
  const sourceUrl = localDatabaseUrl();
  const inspector = postgres(sourceUrl, { prepare: false, max: 1 });
  t.after(() => inspector.end());
  const isolated = await adminEdgeDatabase(sourceUrl);
  const name = new URL(isolated.url).pathname.slice(1);
  const end = isolated.db.end.bind(isolated.db);
  const failure = new Error('synthetic_disconnect_failure');
  const endMock = t.mock.method(isolated.db, 'end', async () => {
    await end();
    throw failure;
  });
  t.after(async () => { endMock.mock.restore(); await isolated.close(); });
  const [before] = await inspector<{ present: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${name}) AS present`;
  assert.equal(before?.present, true, 'positive control: fixture allocated the database');
  await assert.rejects(isolated.close(), error => error === failure);
  const [after] = await inspector<{ present: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=${name}) AS present`;
  assert.equal(after?.present, false, 'disconnect failure must not leak the created database');
});
