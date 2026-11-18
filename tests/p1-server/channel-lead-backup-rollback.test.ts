/** Rollback drill for 20261118000001 (channel lead backup) on a copy of the migrated schema; rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/channel-lead-backup/20261118000001';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'channel lead backup rollback catalog' : 'channel lead backup catalog');

test('the channel lead backup rolls back to the 20261117000002 lead function and applies again', () => {
  runSql(catalog()
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + repoSql('supabase/migrations/20261118000001_channel_lead_backup.sql')
    + catalog()
    + dbAssert(`swarm.channel_effective_live_lead(gen_random_uuid(), gen_random_uuid()) IS NULL
      AND NOT swarm.agent_listener_is_live(gen_random_uuid())
      AND NOT swarm.agent_listener_is_live(NULL)`, 'an unknown channel has no lead and an unknown agent is not listening')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
