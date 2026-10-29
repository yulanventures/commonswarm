import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dist = new URL("../dist/oauth/c1-smoke/", import.meta.url);

test("C1 smoke callback: built page shows only the handoff instruction and cannot send the URL", async () => {
  const html = await readFile(new URL("callback/index.html", dist), "utf8");
  // Inspect the release output, including anything Astro or a shared layout adds.
  assert.doesNotMatch(html, /<(?:script|a|link|iframe|embed|object|form|img|style)\b/i);
  assert.doesNotMatch(html, /\b(?:src|href|action|on\w+)\s*=/i);

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) =>
      [key.toLowerCase(), value.toLowerCase()])));
  assert.equal(metas.filter(meta => meta.name === "referrer").length, 1);
  assert.equal(metas.find(meta => meta.name === "referrer")?.content, "no-referrer");
  assert.ok(metas.every(meta => !("http-equiv" in meta)), "no meta refresh or other HTTP-equivalent navigation");
});
