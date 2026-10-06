/** Release repair contract: ordered locks and guarded historical-only writes.
 * Database behavior and invitation rejoin are proved by the CI/server twin. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const migration = readFileSync(new URL('../supabase/migrations/20261005000001_household_member_removal.sql', import.meta.url), 'utf8');
const repair = migration.match(/DO \$household_member_removal_backfill\$([\s\S]*?)\$household_member_removal_backfill\$;/)?.[1];

test('repair shipped for removals between schema and edge release is verbatim in both copies', () => {
  const block = migration.match(/DO \$household_member_removal_backfill\$[\s\S]*?\$household_member_removal_backfill\$;/)?.[0];
  assert.ok(block, 'migration must contain the repeatable repair');
  const release = readFileSync(new URL('../deploy/release-proofs/household-member-removal/20261005000001-backfill.sql', import.meta.url));
  const reserve = readFileSync(new URL('../supabase/household-member-removal-reserve/20261005000001-backfill.sql', import.meta.url));
  assert.deepEqual(release, Buffer.from(`${block}\n`), 'release operator runs exactly the migration repair');
  assert.deepEqual(reserve, release, 'reserve copy matches the reviewed release artifact');
});

test('historical removal repair follows the documented lock order before any write', () => {
  assert.ok(repair, 'migration must repair members removed before live content revocation');
  const sql = repair.replace(/--[^\n]*/g, '');
  const locks = [...sql.matchAll(/PERFORM\b[^;]+;/g)].map(match => match[0]);
  // Independent contract from the removal/approval lock order, not from a helper.
  const ordered = [
    ['workspaces', 'w.workspace_id'],
    ['memberships', 'm.workspace_id, m.user_id'],
    ['household_member_content_roles', 'r.workspace_id, r.user_id'],
    ['household_content_connections', 'c.workspace_id, c.connection_id, c.grant_id, c.principal_id'],
    ['admin_routine_invitations', 'i.workspace_id, i.invitation_id'],
    ['invitations', 'i.workspace_id, i.invitation_id'],
  ];
  assert.equal(locks.length, ordered.length);
  ordered.forEach(([table, key], index) => {
    assert.match(locks[index]!, new RegExp(`FROM swarm\\.${table}\\s`));
    assert.ok(locks[index]!.includes(`ORDER BY ${key} FOR UPDATE OF`), `stable lock key for ${table}`);
    assert.match(locks[index]!, /m\.revoked_at IS NOT NULL/);
  });
  const firstWrite = sql.search(/UPDATE swarm\./);
  assert.ok(firstWrite > sql.lastIndexOf('PERFORM'), 'all row locks precede all writes');
});

test('repair stamps only unrevoked rows of removed members and keeps consent and history', () => {
  assert.ok(repair);
  const sql = repair.replace(/--[^\n]*/g, '');
  const writes = [...sql.matchAll(/UPDATE swarm\.([a-z_]+)\s+([a-z])\s+SET\s+([^;]+);/g)];
  assert.deepEqual(writes.map(match => match[1]), [
    'household_member_content_roles', 'household_content_connections',
    'admin_routine_invitations', 'invitations',
  ]);
  for (const write of writes) {
    assert.match(write[3]!, /^revoked_at=m\.revoked_at\s+FROM/);
    assert.match(write[3]!, /m\.revoked_at IS NOT NULL/);
    assert.ok(write[3]!.includes(`${write[2]}.revoked_at IS NULL`));
    assert.ok(write[3]!.includes(`m.workspace_id=${write[2]}.workspace_id`));
  }
  assert.match(writes[0]![3]!, /m\.user_id=r\.user_id/);
  assert.match(writes[1]![3]!, /m\.user_id=c\.owner_user_id/);
  assert.doesNotMatch(writes[1]![3]!, /expires_at/); // expired connections are revoked too
  assert.match(writes[2]![3]!, /m\.user_id=i\.recipient_user_id/);
  assert.match(writes[2]![3]!, /i\.accepted_at IS NULL/);
  assert.match(writes[3]![3]!, /lower\(i\.email\)=lower\(u\.email\)/);
  assert.match(writes[3]![3]!, /i\.consumed_at IS NULL/);
  assert.match(writes[3]![3]!, /i\.expires_at>pending_at/);
  assert.match(sql, /pending_at timestamptz := statement_timestamp\(\)/);
  assert.doesNotMatch(sql, /\b(?:INSERT|DELETE|TRUNCATE|ALTER|CREATE|DROP)\b/i);
});

test('repair and release counts exclude invitations created after removal', () => {
  assert.ok(repair);
  const sql = repair.replace(/--[^\n]*/g, '');
  for (const table of ['admin_routine_invitations', 'invitations']) {
    const lock = [...sql.matchAll(/PERFORM\b[^;]+;/g)].find(match => match[0].includes(`FROM swarm.${table} `));
    const write = sql.match(new RegExp(`UPDATE swarm\\.${table}\\b[^;]+;`));
    assert.ok(lock && write);
    for (const statement of [lock[0], write[0]]) {
      assert.match(statement, /i\.created_at\s*<=\s*m\.revoked_at/, `${table}: only invitations present at removal`);
    }
  }
  const precount = readFileSync(new URL('../deploy/release-proofs/household-member-removal/20261005000001-precount.sql', import.meta.url), 'utf8');
  for (const table of ['admin_routine_invitations', 'invitations']) {
    const query = precount.match(new RegExp(`FROM swarm\\.${table}\\b[^$]+`));
    assert.ok(query);
    assert.match(query[0], /i\.created_at\s*<=\s*m\.revoked_at/);
  }
});

test('forward and rollback catalog proofs check structure independently of member data', () => {
  for (const suffix of ['catalog', 'rollback-catalog']) {
    const proof = readFileSync(new URL(`../deploy/release-proofs/household-member-removal/20261005000001-${suffix}.sql`, import.meta.url), 'utf8')
      .replace(/--[^\n]*/g, '');
    assert.match(proof, /FROM pg_proc/, 'positive control: function catalog is checked');
    assert.doesNotMatch(proof, /\b(?:FROM|JOIN)\s+swarm\./i, 'member data cannot block release or rollback');
  }
});
