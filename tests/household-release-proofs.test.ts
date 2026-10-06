import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catalogProblems, functionalProblems, proofSql, releaseProofs } from './support/household-release-proofs.js';

test('all eleven release boundaries have error-safe catalogs and read-only functional artifacts', () => {
  assert.equal(releaseProofs.length, 11);
  assert.equal(new Set(releaseProofs.map(proof => proof.version)).size, 11);
  for (const proof of releaseProofs) {
    const catalog = proofSql(`${proof.release}-catalog.sql`);
    const functional = proofSql(`${proof.release}-functional.sql`);
    assert.deepEqual(catalogProblems(catalog), [], proof.version);
    assert.deepEqual(functionalProblems(functional), [], proof.version);
    for (const suffix of ['catalog', 'functional', 'rollback-catalog']) {
      assert.equal(proofSql(`${proof.release}-${suffix}.sql`), proofSql(`${proof.reserve}-${suffix}.sql`), `${proof.version} ${suffix} copy`);
    }
    // Rollback has its own alias, but must obey the same object safety rule.
    assert.deepEqual(catalogProblems(proofSql(`${proof.release}-rollback-catalog.sql`).replace(/AS rollback_ok/gi, 'AS catalog_ok')), [], `${proof.version} rollback safety`);
  }
});

test('proof lint detects unsafe fixtures and admits nullable lookups and read-only blocks', () => {
  assert.deepEqual(catalogProblems("SELECT 'swarm_read.missing()'::regprocedure IS NOT NULL AS catalog_ok\n\\gset\n"), ['throwing object cast']);
  for (const lookup of [
    "CAST('swarm.missing' AS regclass)",
    "'swarm.missing'::pg_catalog.regclass",
    "CAST('swarm_read.missing()' AS pg_catalog.regprocedure)",
  ]) {
    assert.deepEqual(catalogProblems(`SELECT ${lookup} IS NOT NULL AS catalog_ok\n\\gset`), ['throwing object cast'], lookup);
  }
  assert.deepEqual(catalogProblems("SELECT has_table_privilege('swarm.missing','SELECT') AS catalog_ok\n\\gset"), ['throwing privilege lookup']);
  assert.deepEqual(catalogProblems("SELECT has_function_privilege('authenticated','swarm_read.missing()','EXECUTE') AS catalog_ok\n\\gset"), ['throwing privilege lookup']);
  assert.deepEqual(catalogProblems("SELECT coalesce(has_function_privilege('authenticated',to_regprocedure('swarm_read.missing()'),'EXECUTE'),false) AS catalog_ok\n\\gset"), []);
  assert.deepEqual(catalogProblems('SELECT true AS catalog_ok;'), ['catalog Boolean/gset shape']);
  for (const command of ['INSERT INTO x VALUES (1)', 'UPDATE x SET a=1', 'DELETE FROM x', 'TRUNCATE x', 'ALTER TABLE x ADD a int', 'CREATE TABLE x(a int)', 'DROP TABLE x', 'GRANT SELECT ON x TO PUBLIC', 'REVOKE SELECT ON x FROM PUBLIC', 'COPY x TO STDOUT']) {
    assert.ok(functionalProblems(`${command};`).includes('write statement'), command);
    assert.ok(functionalProblems(`DO $$ BEGIN EXECUTE '${command}'; END $$;`).includes('dynamic write statement'), command);
  }
  assert.deepEqual(functionalProblems("-- DROP TABLE x\nDO $$ BEGIN PERFORM set_config('request.jwt.claims','{}',true); END $$; SELECT 'passed';"), []);
});
