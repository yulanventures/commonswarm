/** Rollback drill for 20261118000004 (conversations) on a copy of the migrated schema; rolled back by the shared
 * harness. The harness ends in ROLLBACK, so deferred filing would never fire: the drill makes constraints
 * immediate, seeds a workspace with a general post, a channel post and a 1:1, and checks that rolling back
 * keeps every message and applying again files them the same way. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/conversations/20261118000004';
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
  runSql(catalog()
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
