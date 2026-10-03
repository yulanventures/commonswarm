import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("OA-03: built support page offers product help, private security reporting, and policies", () => {
  const html = readFileSync(new URL("../dist/support/index.html", import.meta.url), "utf8");
  const main = html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/)?.[1];
  assert.ok(main, "support route must render its main content");
  assert.match(html, /<link\b[^>]*rel="canonical"[^>]*href="https:\/\/commonswarm\.com\/support"/);
  assert.match(main, /<h1\b[^>]*>How to get help<\/h1>/);
  assert.match(main, /<a\b[^>]*href="mailto:support@commonswarm\.com"[^>]*>support@commonswarm\.com<\/a>/);
  assert.match(main, /<a\b[^>]*href="mailto:security@commonswarm\.com"[^>]*>security@commonswarm\.com<\/a>/);
  for (const policy of ["privacy", "terms", "acceptable-use"]) {
    assert.match(main, new RegExp(`<a\\b[^>]*href="/${policy}"`));
  }
});

test("OA-03: shared footer links to support from home and legal pages", () => {
  for (const route of ["", "privacy/", "terms/", "acceptable-use/", "support/"]) {
    const html = readFileSync(new URL(`../dist/${route}index.html`, import.meta.url), "utf8");
    const footer = html.match(/<footer\b[^>]*class="ft"[^>]*>([\s\S]*?)<\/footer>/)?.[1];
    assert.ok(footer, `${route || "home"}: shared site footer must render`);
    assert.match(footer, /<a\b[^>]*href="\/support"[^>]*>\s*Support\s*<\/a>/);
  }
});
