import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

for (const suffix of ['catalog', 'rollback', 'rollback-catalog']) {
  test(`household approval ${suffix} reserve equals the release proof byte for byte`, () => {
    const filename = `20261004000015-${suffix}.sql`;
    const reserve = readFileSync(new URL(`../supabase/household-approval-reserve/${filename}`, import.meta.url));
    const release = readFileSync(new URL(`../deploy/release-proofs/household-approval/${filename}`, import.meta.url));
    assert.deepEqual(reserve, release);
  });
}
