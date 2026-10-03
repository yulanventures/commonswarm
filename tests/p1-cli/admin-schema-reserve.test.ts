/** The release reserve must match the migration's reviewed inverse byte for byte. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { migrationNames, repoSql, versions } from '../support/admin-schema-db.js';

// M4 installs the checksum gate; it is a separate window and a separate inverse.
const reserveVersions = [...versions, '20261003000004'];
const reserveMigrations = [...migrationNames, '20261003000004_migration_checksums.sql'];
for (const [i, version] of reserveVersions.entries()) {
  test(`admin-schema reserve ${version} is verbatim and artifact-preserving`, () => {
    const source = repoSql(`supabase/migrations/${reserveMigrations[i]}`);
    const marker = '-- Reserve rollback (verbatim sibling reserve; data-free only):\n';
    assert.equal(source.split(marker).length, 2);
    const inverse = source.split(marker)[1]!.split('\n').filter(Boolean)
      .map(line => { assert.ok(line.startsWith('-- ')); return line.slice(3); }).join('\n') + '\n';
    assert.equal(inverse, repoSql(`supabase/admin-delegation-reserve/${version}-rollback.sql`));
    assert.match(inverse, /Never drops data once OAuth\/admin artifacts exist/);
    assert.ok(inverse.indexOf('RAISE EXCEPTION') < inverse.indexOf('DROP TABLE'), 'refusal precedes every drop');
    assert.doesNotMatch(inverse, /\bCASCADE\b|\bTRUNCATE\b|\bDELETE FROM\b/);
    if (version === '20261003000004') {
      assert.match(inverse, /DROP FUNCTION commonswarm_ops\.migration_checksum_failures\(\);/);
      assert.doesNotMatch(inverse, /DROP (?:SCHEMA|TABLE) (?:commonswarm_oauth|supabase_migrations)/);
    }
  });
  test(`admin-schema catalog ${version} pins every function body`, () => {
    const source = repoSql(`supabase/migrations/${reserveMigrations[i]}`).split('-- Reserve rollback')[0]!;
    const proof = repoSql(`deploy/release-proofs/item-ai/${version}-catalog.sql`);
    const functions = [...source.matchAll(/CREATE FUNCTION ([\w.]+)\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g)];
    assert.ok(functions.length > 0, 'positive control: migration function bodies found');
    for (const [, name, body] of functions) {
      const entry = proof.split(`p.oid=to_regprocedure('${name}(`)[1];
      assert.ok(entry, `catalog must check ${name}`);
      const pinned = entry.match(/md5\(p\.prosrc\)='([0-9a-f]{32})'/)?.[1];
      assert.equal(pinned, createHash('md5').update(body!).digest('hex'), `${name} reviewed body hash`);
    }
  });
}
