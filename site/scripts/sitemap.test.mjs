import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the built sitemap lists content pages and leaves out doors, callbacks and the not-found page", async t => {
  let xml;
  try { xml = await readFile(new URL("../dist/sitemap.xml", import.meta.url), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" && !process.env.CI) { t.skip("site build required; CI builds before this suite"); return; }
    throw error;
  }
  const paths = [...xml.matchAll(/<loc>https:\/\/commonswarm\.com(\/[^<]*)<\/loc>/gu)].map(([, path]) => path);
  assert.ok(paths.length >= 10, `expected the content pages, got ${paths.length}`);
  for (const path of ["/", "/download/", "/guides/claude-connector/", "/compare/codeman/", "/terms/"]) {
    assert.ok(paths.includes(path), `${path} should be listed`);
  }
  const unlisted = paths.filter(path => /^\/(?:404|oauth\/|start\/?$|invite\/?$)/u.test(path));
  assert.deepEqual(unlisted, []);
});
