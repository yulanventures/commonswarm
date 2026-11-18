/** Rollback drill for 20261118000002 (conversations) on a copy of the migrated schema; rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/conversations/20261118000002';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'conversations rollback catalog' : 'conversations catalog');

test('conversations roll back to addressed messages only and apply again, filing the same messages', () => {
  runSql(catalog()
    + dbAssert(`(SELECT count(*) FROM swarm.conversation_signals cs JOIN swarm.signals s ON s.id = cs.signal_id
      WHERE s.channel_id IS NOT NULL) = 0`, 'no channel message is filed')
    + `CREATE TEMP TABLE filed_before ON COMMIT DROP AS SELECT signal_id FROM swarm.conversation_signals;\n`
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + repoSql('supabase/migrations/20261118000002_conversations.sql')
    + catalog()
    + dbAssert(`NOT EXISTS (SELECT signal_id FROM filed_before EXCEPT SELECT signal_id FROM swarm.conversation_signals)`,
      'applying again files every message the first apply filed')
    + dbAssert(`swarm.file_direct_messages() = 0`, 'and a second run files nothing more')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
