import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("hosted name reclaim reserve SQL equals each reviewed release proof", async () => {
  for (const suffix of ["catalog", "rollback", "rollback-catalog"]) {
    const name = `20261004000010-${suffix}.sql`;
    const [reserve, release] = await Promise.all([
      readFile(new URL(`../supabase/hosted-name-reclaim-reserve/${name}`, import.meta.url)),
      readFile(new URL(`../deploy/release-proofs/hosted-name-reclaim/${name}`, import.meta.url)),
    ]);
    assert.deepEqual(reserve, release, name);
  }
});
