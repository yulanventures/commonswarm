/** Rollback drill for 20261118000006 (an owner reads every agent admin grant covering a workspace) on a copy of the migrated schema. */
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/workspace-admin-access-read/20261118000006';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'workspace admin access read rollback catalog' : 'workspace admin access read catalog');

test('the workspace admin access read rolls back to nothing and applies again', () => {
  runSql(catalog()
    + repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + repoSql('supabase/migrations/20261118000006_workspace_seat_admin_grants.sql')
    + catalog()
    // With no signed-in person the read answers nothing.
    + dbAssert(`swarm_read.workspace_seat_admin_grants(gen_random_uuid()) IS NULL`, 'no claims, no answer')
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
