/** Rollback drill for 20261118000003 (seat admin grant end guard) on a copy of the migrated schema; rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/seat-admin-grant-end-guard/20261118000003';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'seat admin grant end guard rollback catalog' : 'seat admin grant end guard catalog');

test('the seat admin grant end guard rolls back to the earlier reads and applies again', () => {
  runSql(catalog()
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    // The grant table and its forward-only history are untouched.
    + dbAssert(`to_regclass('swarm.seat_admin_grants') IS NOT NULL
      AND to_regprocedure('swarm.seat_admin_grants_forward_only()') IS NOT NULL
      AND to_regprocedure('swarm.seat_admin_org_owner(uuid,uuid)') IS NOT NULL`, 'seat admin grants kept')
    + repoSql('supabase/migrations/20261118000003_seat_admin_grant_end_guard.sql')
    + catalog()
    + dbAssert(`swarm.seat_admin_grant_end_actor(gen_random_uuid(), gen_random_uuid()) IS NULL`, 'an unknown grant has no recorded end')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
