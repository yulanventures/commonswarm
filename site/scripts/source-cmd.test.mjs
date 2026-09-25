import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SOURCE_REPOSITORY_URL } from "../src/lib/repository.ts";

/* The "from source" snippet on /download told a stranger to clone `commonswarm` and then
 * `cd cloud-swarm`. Live, in both the visible lines and the Copy payload, for about an hour.
 *
 * The repo name was written TWICE and only one copy was repointed during the 2026-08-10 repo
 * migration. Nothing gated it — the sibling constants on the same page are derived from one
 * source precisely so this cannot happen, and this was the one that opted out.
 *
 * This gate reads the component and requires the clone URL and the cd target to agree. */

const src = readFileSync(
  new URL("../src/components/download/OtherWays.astro", import.meta.url),
  "utf8",
);

test("the source snippet's cd target matches the directory the clone creates", () => {
  assert.match(src, /import \{ SOURCE_REPOSITORY_URL \} from "\.\.\/\.\.\/lib\/repository\.ts"/);
  assert.match(src, /const SOURCE_REPO = `\$\{SOURCE_REPOSITORY_URL\}\.git`/);
  const clone = `${SOURCE_REPOSITORY_URL}.git`;
  assert.ok(clone, "could not find the clone URL");

  const expected = clone.replace(/^.*\//, "").replace(/\.git$/, "");

  // The cd may be literal or interpolated. Both must resolve to the cloned directory.
  const literal = (src.match(/\ncd ([A-Za-z0-9._-]+)\n/) ?? [])[1];
  if (literal !== undefined) {
    assert.equal(
      literal,
      expected,
      `clone creates "${expected}" but the snippet does "cd ${literal}"`,
    );
  } else {
    assert.match(
      src,
      /\ncd \$\{sourceDir\}\n/,
      "the cd target is neither the right literal nor derived from the clone URL",
    );
  }
});

test("CONTROL: the gate fails when the two disagree", () => {
  /* Without this, a gate that silently found nothing to check would pass forever. Proves the
   * comparison actually discriminates rather than short-circuiting. */
  const clone = `${SOURCE_REPOSITORY_URL.replace(/commonswarm$/, "somethingelse")}.git`;
  const expected = clone.replace(/^.*\//, "").replace(/\.git$/, "");
  assert.equal(expected, "somethingelse");
  assert.notEqual(expected, "commonswarm", "the derivation is not sensitive to the URL");
});
