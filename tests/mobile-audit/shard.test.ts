import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inShard, ownsRunChecks, parseShard } from "./shard.js";

test("a shard is k/n with at least two shards; anything else stops the run", () => {
  assert.equal(parseShard(undefined), null);
  assert.equal(parseShard(""), null);
  assert.equal(parseShard("  "), null);
  assert.deepEqual(parseShard("1/6"), { index: 0, count: 6 });
  assert.deepEqual(parseShard(" 6/6 "), { index: 5, count: 6 });
  for (const bad of ["0/6", "7/6", "1/1", "1", "1/", "/6", "a/b", "1/6/2", "-1/6", "01/6"]) {
    assert.throws(() => parseShard(bad), /MOBILE_AUDIT_SHARD/, bad);
  }
});

test("every manifest screen is captured by exactly one shard, and the shards are even", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../site/mobile-audit/screens.json", import.meta.url), "utf8")) as
    { screens?: { id: string }[] } | { id: string }[];
  const ids = (Array.isArray(manifest) ? manifest : manifest.screens ?? []).map(screen => screen.id);
  assert.ok(ids.length > 20, "the manifest has screens");
  for (const count of [2, 4, 6]) {
    const shards = Array.from({ length: count }, (_, index) => ids.filter(id => inShard(ids, id, { index, count })));
    assert.deepEqual(shards.flat().sort(), [...ids].sort(), `${count} shards cover every screen once`);
    const sizes = shards.map(list => list.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${count} shards differ by at most one screen: ${sizes.join(", ")}`);
  }
  // Not sharded: everything. A name that is not in the manifest is in no shard.
  assert.ok(ids.every(id => inShard(ids, id, null)));
  assert.equal(inShard(ids, "no.such.screen", { index: 0, count: 2 }), false);
});

test("the once-per-run checks run in shard 1 only, or in a run that is not sharded", () => {
  assert.equal(ownsRunChecks(null), true);
  assert.equal(ownsRunChecks({ index: 0, count: 6 }), true);
  assert.equal(ownsRunChecks({ index: 3, count: 6 }), false);
});
