/** Rollback drills for 20261118000004 (conversations) and 20261118000005 (step 2a) on a copy of the migrated
 * schema; rolled back by the shared harness. The harness ends in ROLLBACK, so deferred filing would never fire:
 * the drills make constraints immediate. Step 2a's rollback always runs first, as it must at a release. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/conversations/20261118000004';
const root2a = 'deploy/release-proofs/conversations-2a/20261118000005';
const rollback2b = repoSql('deploy/release-proofs/conversations-2b/20261120000001-rollback.sql');
const catalog2a = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root2a}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'conversations 2a rollback catalog' : 'conversations 2a catalog');
const rollback2a = rollback2b + catalog2a() + repoSql(`${root2a}-rollback.sql`) + catalog2a(true);
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'conversations rollback catalog' : 'conversations catalog');

const [alice, bob, ws, room] = ['a1', 'b1', 'c1', 'd1'].map((tail) => `00000000-0000-4000-8000-0000000000${tail}`);
const seed = `SET CONSTRAINTS ALL IMMEDIATE;
INSERT INTO auth.users (id, aud, role, email) VALUES
  ('${alice}', 'authenticated', 'authenticated', 'drill-a@example.test'), ('${bob}', 'authenticated', 'authenticated', 'drill-b@example.test');
INSERT INTO swarm.users (user_id, display_name) VALUES ('${alice}', 'DrillA'), ('${bob}', 'DrillB');
INSERT INTO swarm.workspaces (workspace_id, name, created_by) VALUES ('${ws}', 'Drill', '${alice}');
INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES ('${ws}', '${alice}', 'owner'), ('${ws}', '${bob}', 'member');
INSERT INTO swarm.channels (channel_id, workspace_id, slug, created_by_principal, created_by_kind)
  VALUES ('${room}', '${ws}', 'drill', '${alice}', 'user');
INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until, channel_id) VALUES
  (gen_random_uuid(), '${ws}', '${alice}', 'user', NULL, 'note', 'drill general', statement_timestamp() + interval '1 day', NULL),
  (gen_random_uuid(), '${ws}', '${alice}', 'user', NULL, 'note', 'drill channel', statement_timestamp() + interval '1 day', '${room}'),
  (gen_random_uuid(), '${ws}', '${alice}', 'user', '${bob}', 'note', 'drill dm', statement_timestamp() + interval '1 day', NULL);
`;
const placements = `SELECT s.body, c.kind, cs.audience FROM swarm.conversation_signals cs
  JOIN swarm.signals s ON s.id = cs.signal_id JOIN swarm.conversations c ON c.conversation_id = cs.conversation_id
  WHERE s.workspace_id = '${ws}'`;

test('conversations roll back to messages alone and apply again, filing the same messages the same way', () => {
  runSql(rollback2a
    + catalog()
    + seed
    + dbAssert(`(SELECT count(*) FROM (${placements}) p) = 3`, 'the seeded messages are filed')
    + `CREATE TEMP TABLE filed_before ON COMMIT DROP AS ${placements};\n`
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + dbAssert(`(SELECT count(*) FROM swarm.signals WHERE workspace_id = '${ws}') = 3`, 'rolling back keeps every message')
    + repoSql('supabase/migrations/20261118000004_conversations.sql')
    + catalog()
    + dbAssert(`NOT EXISTS ((SELECT * FROM filed_before EXCEPT ${placements}) UNION ALL (${placements} EXCEPT SELECT * FROM filed_before))`,
      'applying again files every message in the same kind of conversation, for the same audience')
    + dbAssert(`(swarm.conversations_backfill() ->> 'filed')::int = 0`, 'and a second run files nothing more')
    + dbAssert(`(SELECT count(*) FROM swarm.conversation_members m JOIN swarm.conversations c USING (conversation_id)
      WHERE c.workspace_id = '${ws}' AND c.kind IN ('general', 'public_channel')) = 4`, 'both people join #general and the channel')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});

const [carol] = ['c2'].map((tail) => `00000000-0000-4000-8000-0000000000${tail}`);
const explicit = '00000000-0000-4000-8000-0000000000f1';
const seed2a = `${seed}
INSERT INTO auth.users (id, aud, role, email) VALUES ('${carol}', 'authenticated', 'authenticated', 'drill-c@example.test');
INSERT INTO swarm.users (user_id, display_name) VALUES ('${carol}', 'DrillC');
INSERT INTO swarm.memberships (workspace_id, user_id, role) VALUES ('${ws}', '${carol}', 'member');
CREATE TEMP TABLE opened ON COMMIT DROP AS
  SELECT swarm.conversation_open('${ws}', 'user', '${alice}', ARRAY['${bob}', '${carol}']::uuid[], '{}'::uuid[], false) AS r;
GRANT SELECT ON opened TO swarm_command;
-- As the edge posts it: deferred, so the message is filed by its poster after its recipients and checked at commit
-- (here, at SET CONSTRAINTS ... IMMEDIATE).
SET CONSTRAINTS ALL DEFERRED;
SET LOCAL ROLE swarm_command;
INSERT INTO swarm.signals (id, workspace_id, from_principal, from_kind, to_user_id, kind, body, until)
  VALUES ('${explicit}', '${ws}', '${alice}', 'user', '${bob}', 'note', 'drill group', statement_timestamp() + interval '1 day');
INSERT INTO swarm.signal_recipients (signal_id, workspace_id, recipient_user_id, position)
  VALUES ('${explicit}', '${ws}', '${bob}', 0), ('${explicit}', '${ws}', '${carol}', 1);
SELECT swarm.conversation_prefile('${ws}', '${explicit}', (SELECT (r -> 'conversation' ->> 'conversation_id')::uuid FROM opened));
RESET ROLE;
SET CONSTRAINTS ALL IMMEDIATE;
`;

test('step 2a rolls back to step 1 and applies again; then step 1 rolls back after it', () => {
  runSql(rollback2b
    + catalog2a()
    + seed2a
    + dbAssert(`(SELECT audience = 'conversation' FROM swarm.conversation_signals WHERE signal_id = '${explicit}')`,
      'a post to a group is filed in it for everyone in it')
    + dbAssert(`(SELECT count(*) FROM swarm.conversation_members m JOIN swarm.conversations c USING (conversation_id)
      WHERE c.workspace_id = '${ws}' AND c.kind = 'general' AND m.left_at IS NULL) = 3`, 'each person joined #general on arrival')
    + repoSql(`${root2a}-rollback.sql`)
    + catalog2a(true)
    + catalog()
    + dbAssert(`(SELECT count(*) FROM swarm.signals WHERE workspace_id = '${ws}') = 4`, 'rolling back keeps every message')
    + dbAssert(`(SELECT count(*) FROM swarm.conversation_signals cs JOIN swarm.signals s ON s.id = cs.signal_id
      WHERE s.workspace_id = '${ws}') = 4`, 'and every filing')
    + repoSql('supabase/migrations/20261118000005_conversations_commands.sql')
    + catalog2a()
    + repoSql(`${root2a}-rollback.sql`)
    + catalog2a(true)
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});

test('step 2b rolls back to step 2a cleanly, reapplies cleanly, and rolls back before step 2a', () => {
  runSql(rollback2b
    + catalog2a()
    + dbAssert(`to_regprocedure('swarm_read.conversations(uuid,boolean)') IS NULL`, 'step 2b read RPC dropped on rollback')
    + dbAssert(`to_regprocedure('swarm.conversation_thread_root(uuid,uuid,uuid)') IS NULL`, 'step 2b thread root helper dropped on rollback')
    + repoSql('supabase/migrations/20261120000001_conversations_reads.sql')
    + dbAssert(`to_regprocedure('swarm_read.conversations(uuid,boolean)') IS NOT NULL
      AND to_regprocedure('swarm_read.conversation_history(uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,boolean,boolean)') IS NOT NULL
      AND to_regprocedure('swarm_read.conversation_oversight(uuid,uuid)') IS NOT NULL
      AND to_regprocedure('swarm_read.conversation_oversight_history(uuid,uuid,uuid,timestamptz,uuid,timestamptz,uuid,integer,boolean,boolean)') IS NOT NULL
      AND to_regprocedure('swarm.conversation_thread_root(uuid,uuid,uuid)') IS NOT NULL`, 'step 2b functions reapplied cleanly')
    + rollback2b
    + catalog2a());
});
