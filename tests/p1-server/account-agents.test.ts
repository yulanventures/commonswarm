/** Actual application DDL/roles; fixture data only, rolled back by the shared harness. */
import { test } from 'node:test';
import { dbAssert, refuses, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

const root = 'deploy/release-proofs/agents/20261028000001';
const catalog = (rollback = false) => dbAssert(
  releaseCatalogQuery(repoSql(`${root}-${rollback ? 'rollback-catalog' : 'catalog'}.sql`), rollback ? 'rollback_ok' : 'catalog_ok')
    .trim().replace(/;$/, ''), rollback ? 'agent rollback catalog' : 'agent catalog');

test('account agents backfill, legacy writers, owner isolation and guarded rollback', () => {
  runSql(repoSql(`${root}-rollback.sql`)
    + catalog(true)
    + repoSql('tests/fixtures/account-agents-before.sql')
    + repoSql('supabase/migrations/20261028000001_account_agents.sql')
    + catalog()
    + repoSql(`${root}-functional.sql`)
    + repoSql('tests/fixtures/account-agents-after.sql')
    + catalog()
    + repoSql(`${root}-functional.sql`)
    + `UPDATE swarm.agent_workspace_memberships SET added_by='02000000-0000-4000-8000-000000000002'
      WHERE principal_id='22000000-0000-4000-8000-000000000001';`
    + refuses(repoSql(`${root}-rollback.sql`), '55000')
    + `UPDATE swarm.agent_workspace_memberships SET added_by=owner_user_id
      WHERE principal_id='22000000-0000-4000-8000-000000000001';`
    + repoSql(`${root}-rollback.sql`)
    + catalog(true));
});
