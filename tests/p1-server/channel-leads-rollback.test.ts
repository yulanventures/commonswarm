/** Rollback drill for 20261117000001 (channel leads) on a copy of the migrated schema; rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/channel-leads/20261117000001';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'channel lead rollback catalog' : 'channel lead catalog');

test('channel leads roll back to the private-channels view and apply again', () => {
  runSql(catalog()
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    // The older lead objects it leans on are untouched.
    + dbAssert(`to_regprocedure('swarm.workspace_live_lead(uuid)') IS NOT NULL
      AND to_regprocedure('swarm.actor_can_access_channel(uuid,uuid,text,uuid)') IS NOT NULL`, 'workspace lead kept')
    + repoSql('supabase/migrations/20261117000001_channel_leads.sql')
    + catalog()
    + dbAssert(`swarm.channel_effective_live_lead(gen_random_uuid(), NULL) IS NULL
      AND swarm.channel_effective_live_lead(NULL, gen_random_uuid()) IS NULL`, 'an unknown workspace has no lead')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
