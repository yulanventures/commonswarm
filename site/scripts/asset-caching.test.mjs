import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const caddy = await readFile(new URL("../../deploy/site/commonswarm-site.caddy", import.meta.url), "utf8");
const route = caddy.slice(caddy.indexOf("route {"), caddy.indexOf("handle_errors {"));
const errors = caddy.slice(caddy.indexOf("handle_errors {"));

test("only content-hashed files are kept without asking again", () => {
  // Everything starts as revalidate-every-time; the one exception comes after it and names /_astro/ and /next/assets/.
  const everything = route.indexOf('Cache-Control "public, max-age=0, must-revalidate"');
  const hashed = route.indexOf('header @hashed Cache-Control "public, max-age=31536000, immutable"');
  assert.ok(everything >= 0 && hashed > everything, "the hashed rule must come after the default so it wins");
  assert.match(route, /@hashed path \/_astro\/\* \/next\/assets\/\*\n/u);
  assert.equal(route.match(/immutable/gu)?.length, 1, "no other path may be marked immutable");
  assert.match(route, /@nextHtml path \/next \/next\/ \/next\/index\.html \/next\/index\.html\/\n\t\theader @nextHtml Cache-Control "no-cache"\n/u);
});

test("an error is never kept, even for a hashed name", () => {
  const reset = errors.indexOf('header Cache-Control "public, max-age=0, must-revalidate"');
  assert.ok(reset >= 0, "handle_errors resets Cache-Control");
  assert.ok(reset < errors.indexOf("handle @notFoundPage {"), "the reset applies to every answer the handler gives");
  assert.doesNotMatch(errors, /immutable/u);
});

test("the build still puts scripts and styles under the hashed folder", async t => {
  let page;
  try { page = await readFile(new URL("../dist/app/index.html", import.meta.url), "utf8"); }
  catch (error) {
    if (error.code === "ENOENT" && !process.env.CI) { t.skip("site build required; CI builds before this suite"); return; }
    throw error;
  }
  const assets = [...page.matchAll(/\s(?:href|src)="([^"]+\.(?:js|css))"/gu)].map(([, value]) => value);
  assert.ok(assets.length > 0);
  // A script or stylesheet outside /_astro/ would be re-checked on every visit; one inside it must carry a hash.
  for (const asset of assets) assert.match(asset, /^\/_astro\/[^/]+\.[A-Za-z0-9_-]{8}\.(?:js|css)$/u, asset);
});
