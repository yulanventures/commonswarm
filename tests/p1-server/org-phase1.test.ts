/** Real application DDL and role enforcement; rollback-only, no customer data. */
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { dbAssert, repoSql, runSql } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';

// Keep the historical projection explicit: existing CLI/MCP selects retain their types and order.
const baseline = JSON.parse(readFileSync(new URL('../support/org-phase1-catalog.json', import.meta.url), 'utf8'));
const viewColumns = (expected: unknown) => dbAssert(`SELECT jsonb_agg(jsonb_build_array(attname::text,
  format_type(atttypid,atttypmod)) ORDER BY attnum) = '${JSON.stringify(expected)}'::jsonb
  FROM pg_attribute WHERE attrelid='swarm_read.workspaces'::regclass AND attnum>0 AND NOT attisdropped`, 'workspace projection baseline');
const root = 'deploy/release-proofs/org/20261027000001';
test('organizations backfill, compatible writers and workspace-only visibility', () => {
  runSql(repoSql('deploy/release-proofs/agents/20261028000001-rollback.sql')
    + repoSql(`${root}-rollback.sql`)
    + viewColumns(baseline.historical)
    + repoSql('tests/fixtures/org-phase1-before.sql')
    + repoSql('supabase/migrations/20261027000001_organizations_phase1.sql')
    + viewColumns(baseline.phase1)
    + repoSql('tests/fixtures/org-phase1-after.sql')
    + `DO $check$ BEGIN IF NOT (${releaseCatalogQuery(repoSql(`${root}-catalog.sql`), 'catalog_ok').trim().replace(/;$/, '')})
      THEN RAISE EXCEPTION 'organization catalog'; END IF; END $check$;`
    + repoSql(`${root}-functional.sql`)
    + repoSql(`${root}-rollback.sql`)
    + `DO $check$ BEGIN IF NOT (${releaseCatalogQuery(repoSql(`${root}-rollback-catalog.sql`), 'rollback_ok').trim().replace(/;$/, '')})
      THEN RAISE EXCEPTION 'organization rollback catalog'; END IF; END $check$;`);
});
