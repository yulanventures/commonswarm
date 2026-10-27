/** Real organization DDL, command-role writers and workspace-only visibility. */
import { test } from 'node:test';
import { repoSql, runSql, refuses } from '../support/admin-schema-db.js';
import { releaseCatalogQuery } from '../support/release-catalog-query.js';
const root='deploy/release-proofs/org/20261027000002';
const migration=()=>repoSql('supabase/migrations/20261027000002_organizations_phase2.sql');
const proof=(suffix:string,alias:string)=>`DO $check$ BEGIN IF NOT (${releaseCatalogQuery(repoSql(`${root}-${suffix}.sql`),alias).trim().replace(/;$/,'')})
 THEN RAISE EXCEPTION 'organization phase 2 ${suffix}'; END IF; END $check$;`;
test('organization roles survive siblings; create admission and moves preserve workspace authority',()=>{
  runSql(repoSql('deploy/release-proofs/agents/20261028000003-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000002-rollback.sql')
    + repoSql('deploy/release-proofs/agents/20261028000001-rollback.sql')
    +repoSql(`${root}-rollback.sql`)
    +repoSql('deploy/release-proofs/org/20261027000001-rollback.sql')
    +repoSql('tests/fixtures/org-phase1-before.sql')
    +repoSql('supabase/migrations/20261027000001_organizations_phase1.sql')
    +migration()+proof('catalog','catalog_ok')
    +repoSql(`${root}-rollback.sql`)+proof('rollback-catalog','rollback_ok')
    +migration()+repoSql('tests/fixtures/org-phase2-after.sql')
    +repoSql(`${root}-functional.sql`)+proof('catalog','catalog_ok')
    +refuses(repoSql(`${root}-rollback.sql`),'55000'));
});
