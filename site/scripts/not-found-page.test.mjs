import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("the built not-found page works from any address and stays out of the sitemap", async t => {
  let page;
  try { page = await read("../dist/404.html"); }
  catch (error) {
    if (error.code === "ENOENT" && !process.env.CI) { t.skip("site build required; CI builds before this suite"); return; }
    throw error;
  }
  assert.match(page, /<meta name="robots" content="noindex"/u);
  assert.match(page, /<h1[^>]*>We can’t find that page\.<\/h1>/u);
  assert.match(page, /<a class="btn btn--primary" href="\/"[^>]*>Home<\/a>/u);
  // It is served at every wrong path and depth, so a relative reference would break below the root.
  const relative = [...page.matchAll(/\s(?:href|src)="([^"]*)"/gu)].map(([, value]) => value)
    .filter(value => !/^(?:\/|https?:|mailto:|data:|#)/u.test(value));
  assert.deepEqual(relative, []);
  assert.doesNotMatch(await read("../dist/sitemap.xml"), /\/404/u);
});

test("the web server serves that page with status 404 and keeps the plain answer when it is missing", async () => {
  const caddy = await read("../../deploy/site/commonswarm-site.caddy");
  const errors = caddy.slice(caddy.indexOf("handle_errors {"));
  assert.match(errors, /@notFoundPage \{\s*expression \{http\.error\.status_code\} == 404 \|\| \{http\.error\.status_code\} == 400\s*file \/404\.html\s*\}/u);
  assert.match(errors, /handle @notFoundPage \{[\s\S]*?rewrite \* \/404\.html\s*file_server \{\s*status 404\s*\}/u);
  assert.ok(errors.indexOf("handle @notFoundPage") < errors.indexOf("handle @notFound {"), "the page is tried before the plain answer");
  assert.match(errors, /handle @notFound \{[\s\S]*?respond <<BODY[\s\S]*?BODY 404/u);
});
