/** Real migrated authority functions; no synthetic schema or credentials. */
import { test } from 'node:test';
import { runSql,repoSql } from '../support/admin-schema-db.js';
test('local account credential survives sibling membership, origin loss and dormant restoration; tenancy and revocation stay fenced',()=>{
  runSql(repoSql('tests/fixtures/account-agents-before.sql')+repoSql('tests/fixtures/local-agent-workspaces.sql'));
});
