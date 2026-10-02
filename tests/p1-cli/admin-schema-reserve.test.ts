/** The release reserve must match the migration's reviewed inverse byte for byte. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { migrationNames, repoSql, versions } from '../support/admin-schema-db.js';

for (const [i, version] of versions.entries()) {
  test(`admin-schema reserve ${version} is verbatim and artifact-preserving`, () => {
    const source = repoSql(`supabase/migrations/${migrationNames[i]}`);
    const marker = '-- Reserve rollback (verbatim sibling reserve; data-free only):\n';
    assert.equal(source.split(marker).length, 2);
    const inverse = source.split(marker)[1]!.split('\n').filter(Boolean)
      .map(line => { assert.ok(line.startsWith('-- ')); return line.slice(3); }).join('\n') + '\n';
    assert.equal(inverse, repoSql(`supabase/admin-delegation-reserve/${version}-rollback.sql`));
    assert.match(inverse, /Never drops data once OAuth\/admin artifacts exist/);
    assert.ok(inverse.indexOf('RAISE EXCEPTION') < inverse.indexOf('DROP TABLE'), 'refusal precedes every drop');
    assert.doesNotMatch(inverse, /\bCASCADE\b|\bTRUNCATE\b|\bDELETE FROM\b/);
  });
  test(`admin-schema catalog ${version} pins every function body`, () => {
    const source = repoSql(`supabase/migrations/${migrationNames[i]}`).split('-- Reserve rollback')[0]!;
    const proof = repoSql(`deploy/release-proofs/item-ai/${version}-catalog.sql`);
    const functions = [...source.matchAll(/CREATE FUNCTION ([\w.]+)\([\s\S]*?AS \$fn\$([\s\S]*?)\$fn\$;/g)];
    assert.ok(functions.length > 0, 'positive control: migration function bodies found');
    for (const [, name, body] of functions) {
      const entry = proof.split(`to_regprocedure('${name}(`)[1];
      assert.ok(entry, `catalog must check ${name}`);
      const pinned = entry.match(/md5\(p\.prosrc\)='([0-9a-f]{32})'/)?.[1];
      assert.equal(pinned, createHash('md5').update(body!).digest('hex'), `${name} reviewed body hash`);
    }
  });
}
