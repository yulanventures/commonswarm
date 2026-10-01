import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

test('real worker HTTP handlers refuse admin credentials before parsing, authentication, or database work', () => {
  const run = spawnSync('deno', ['run', '--no-lock', '--node-modules-dir=manual', '--config', 'supabase/functions/command/deno.json',
    '--allow-read', '--allow-env', 'tests/support/admin-worker-boundary.mjs'], {
    encoding: 'utf8', timeout: 60000,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '',
      ...(process.env.DENO_DIR ? { DENO_DIR: process.env.DENO_DIR } : {}) },
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /ADMIN_WORKER_BOUNDARY_OK/u);
});
