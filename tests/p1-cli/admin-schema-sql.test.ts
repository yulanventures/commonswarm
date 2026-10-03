/** Service-free contract for composing real database denial probes. */
import assert from 'node:assert/strict';
import { type SpawnSyncReturns } from 'node:child_process';
import { test } from 'node:test';
import { refuses } from '../support/admin-schema-db.js';
import { assertSqlProcessResult, runSqlProcess, sqlPhase } from '../support/admin-schema-process.js';

test('admin-schema SQL child reports status, SQLSTATE and phase even with EPIPE, without row or secret text', () => {
  const result: SpawnSyncReturns<string> = { pid: 1, status: 3, signal: null,
    error: Object.assign(new Error('sensitive spawn message'), { code: 'EPIPE' }),
    stdout: 'sensitive row output', output: [], stderr:
      'admin-schema-phase: test-body\nadmin-schema-phase: hosted-upgrade-m4\n'
      + 'psql:/dev/stdin:123: ERROR:  42501: permission denied for database sensitive_database\n'
      + 'DETAIL: sensitive row detail\nCONTEXT: sensitive SQL statement\nLINE 1: sensitive input\n'
      + 'ERROR:  P0001: sensitive exception text\n' };
  assert.throws(() => assertSqlProcessResult(result), error => {
    assert.ok(error instanceof assert.AssertionError);
    assert.match(error.message, /phase=hosted-upgrade-m4 exit_status=3 signal=null spawn_code=EPIPE/);
    assert.match(error.message, /ERROR: 42501: permission denied for database \(input line 123\)/);
    assert.match(error.message, /ERROR: P0001: SQL error text withheld/);
    assert.doesNotMatch(error.message, /sensitive/);
    return true;
  });
  assert.doesNotThrow(() => assertSqlProcessResult({ ...result, error: undefined, status: 0 }));
  assert.throws(() => assertSqlProcessResult({ ...result, error: undefined }), /exit_status=3.*spawn_code=none/);
  assert.throws(() => assertSqlProcessResult({ ...result, status: null, stderr: '' }), /exit_status=null.*spawn_code=EPIPE[\s\S]*no SQL error captured/);
  assert.throws(() => sqlPhase('invalid\nlabel', ''), assert.AssertionError);
});

test('admin-schema SQL child retains an early exit on large input and reads successful input unchanged', () => {
  // A real child closes stdin without consuming 8 MiB, like ON_ERROR_STOP.
  // The owning process boundary must retain exit 3 and its original stderr.
  const stderr = 'admin-schema-phase: hosted-upgrade-m4\nERROR:  42501: permission denied for database postgres\n';
  assert.throws(() => runSqlProcess(process.execPath, ['-e',
    `require('node:fs').closeSync(0); require('node:fs').writeSync(2, ${JSON.stringify(stderr)}); process.exit(3);`],
  'x'.repeat(8 * 1024 * 1024)), /phase=hosted-upgrade-m4 exit_status=3.*spawn_code=none[\s\S]*ERROR: 42501/);
  const sql = sqlPhase('roundtrip-control', 'BEGIN;\nSELECT 1;\nROLLBACK;');
  runSqlProcess(process.execPath, ['-e',
    `const sql = require('node:fs').readFileSync(0, 'utf8'); process.exit(sql === ${JSON.stringify(sql)} ? 0 : 9);`], sql);
  assert.throws(() => runSqlProcess('/missing-admin-schema-child', [], sql), /spawn_code=ENOENT/);
});

test('admin-schema denial probes accept terminated scripts without empty PL/pgSQL statements', () => {
  const statement = "INSERT INTO test_table(id) VALUES(1)";
  const bare = refuses(statement, '23514');
  for (const ending of [';', ';\n', ';\r\n  ']) {
    assert.equal(refuses(statement + ending, '23514'), bare);
  }
  const script = 'DO $reserve$ BEGIN RAISE EXCEPTION USING ERRCODE=\'55000\'; END $reserve$;\nDROP TABLE test_table;\n';
  const probe = refuses(script, '55000');
  assert.doesNotMatch(probe, /;\s*;/, 'no empty statement before the refusal sentinel');
  assert.ok(probe.includes("RAISE EXCEPTION 'negative control admitted' USING ERRCODE='ZX001'"));
  assert.ok(probe.includes("EXCEPTION WHEN SQLSTATE '55000' THEN NULL"));
  assert.throws(() => refuses(statement, 'invalid'), assert.AssertionError);
});
