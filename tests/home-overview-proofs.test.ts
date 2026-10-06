import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('supabase/migrations/20261006000002_home_overview.sql');
const filenames = ['catalog', 'rollback', 'rollback-catalog'].map(s => `20261006000002-${s}.sql`);

test('home overview release SQL matches the complete reserve inventory byte for byte', () => {
  assert.deepEqual(readdirSync(new URL('../supabase/home-overview-reserve/', import.meta.url)).sort(), [...filenames].sort());
  assert.deepEqual(readdirSync(new URL('../deploy/release-proofs/home-overview/', import.meta.url)).filter(f => f.endsWith('.sql')).sort(), [...filenames].sort());
  for (const filename of filenames) {
    assert.deepEqual(readFileSync(new URL(`../supabase/home-overview-reserve/${filename}`, import.meta.url)),
      readFileSync(new URL(`../deploy/release-proofs/home-overview/${filename}`, import.meta.url)));
  }
});

test('home overview migration has the independent least-privilege function contract', () => {
  const functions = migration.match(/CREATE FUNCTION[\s\S]*?\$\$;/g)!;
  assert.equal(functions.length, 2);
  const [predicate, overview] = functions;
  assert.match(predicate!, /RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER\s+SET search_path = pg_catalog/);
  assert.match(overview!, /RETURNS jsonb\s+LANGUAGE plpgsql VOLATILE SECURITY DEFINER\s+SET search_path = pg_catalog/);
  for (const signature of ['swarm.household_human_can_read(uuid, uuid)', 'swarm_read.home_overview()']) {
    assert.ok(migration.includes(`ALTER FUNCTION ${signature} OWNER TO swarm_admin;`));
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+FROM PUBLIC, anon, authenticated, swarm_read, swarm_command;`));
  }
  assert.deepEqual(migration.match(/^GRANT .*$/gm), ['GRANT EXECUTE ON FUNCTION swarm_read.home_overview() TO authenticated;']);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|FOR SHARE|FOR UPDATE|clock_timestamp)\b/);
  assert.match(overview!, /statement_timestamp\(\)/);
});

test('overview source retains the human identity, consent, message-only and bounding contracts', () => {
  assert.match(migration, /claims->>'role' IS DISTINCT FROM 'authenticated'/);
  assert.match(migration, /claims \? 'agent_principal_id'/);
  assert.match(migration, /r\.revoked_at IS NULL AND r\.content_consent_id IS NOT NULL/);
  assert.match(migration, /FROM swarm_read\.signals s/g);
  assert.match(migration, /max\(r\.first_seen_at\)/);
  assert.doesNotMatch(migration, /['"]new_activity['"]/);
  for (const limit of [50, 25, 99, 10, 20]) assert.match(migration, new RegExp(`LIMIT ${limit}\\b`));
});

test('overview rollback removes only its two functions and leaves history and transaction control intact', () => {
  const rollback = read('supabase/home-overview-reserve/20261006000002-rollback.sql').replace(/^--.*$/gm, '');
  assert.deepEqual(rollback.split(';').map(s => s.trim()).filter(Boolean), [
    'DROP FUNCTION IF EXISTS swarm_read.home_overview()',
    'DROP FUNCTION IF EXISTS swarm.household_human_can_read(uuid, uuid)',
  ]);
  for (const filename of filenames) {
    assert.doesNotMatch(read(`supabase/home-overview-reserve/${filename}`), /^\s*(?:COMMIT|ROLLBACK)\s*;/mi);
  }
});
