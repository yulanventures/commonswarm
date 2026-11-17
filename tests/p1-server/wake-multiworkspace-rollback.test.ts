/** Rollback drill for 20261117000003 (multi-workspace wake eligibility) on a copy of the migrated schema; rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/wake-multiworkspace/20261117000003';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'wake eligibility rollback catalog' : 'wake eligibility catalog');

test('multi-workspace wake eligibility rolls back to the private-channels definitions and applies again', () => {
  runSql(catalog()
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + repoSql('supabase/migrations/20261117000003_multiworkspace_wake_eligibility.sql')
    + catalog()
    + dbAssert(`NOT swarm.agent_has_live_workspace_seat(gen_random_uuid(), gen_random_uuid())
      AND NOT swarm.agent_has_live_workspace_seat(NULL, gen_random_uuid())`, 'an unknown agent has no seat')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});

test('the 20261028000001 rollback still drops the memberships table under the new view, which then reads by first workspace', () => {
  runSql(catalog()
    + repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000002-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000001-rollback.sql')
    + dbAssert(`to_regclass('swarm.agent_workspace_memberships') IS NULL`, 'memberships table dropped')
    + dbAssert(`(SELECT count(*) FROM swarm.wake_path_eligible_deliveries) = 0`, 'the view reads without the memberships table'));
});
