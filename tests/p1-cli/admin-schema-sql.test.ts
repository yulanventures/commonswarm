/** Service-free contract for composing real database denial probes. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refuses } from '../support/admin-schema-db.js';

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
