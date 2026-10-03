import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dist = new URL("../dist/oauth/c1-smoke/", import.meta.url);

test("C1 smoke metadata: built public client matches the hosted CIMD and DPoP contract", async () => {
  const metadata = JSON.parse(await readFile(new URL("client.json", dist), "utf8"));
  assert.deepEqual(metadata, {
    client_id: "https://commonswarm.com/oauth/c1-smoke/client.json",
    redirect_uris: ["https://commonswarm.com/oauth/c1-smoke/callback"],
    client_name: "CommonSwarm C1 smoke test client",
    application_type: "web",
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    dpop_signing_alg: "ES256",
  });
});

test("C1 smoke callback: built page shows only the handoff instruction and cannot send the URL", async () => {
  const html = await readFile(new URL("callback/index.html", dist), "utf8");
  // Inspect the release output, including anything Astro or a shared layout adds.
  assert.doesNotMatch(html, /<(?:script|a|link|iframe|embed|object|form|img|style)\b/i);
  assert.doesNotMatch(html, /\b(?:src|href|action|on\w+)\s*=/i);

  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map(([tag]) =>
    Object.fromEntries([...tag.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) =>
      [key.toLowerCase(), value.toLowerCase()])));
  assert.equal(metas.filter(meta => meta.name === "robots").length, 1);
  assert.equal(metas.find(meta => meta.name === "robots")?.content, "noindex");
  assert.equal(metas.filter(meta => meta.name === "referrer").length, 1);
  assert.equal(metas.find(meta => meta.name === "referrer")?.content, "no-referrer");
  assert.ok(metas.every(meta => !("http-equiv" in meta)), "no meta refresh or other HTTP-equivalent navigation");

  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1];
  assert.ok(body, "callback must render a body");
  assert.equal(body.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim(),
    "Copy the full address of this page and give it to the release worker. Do not share it with anyone else.");
});
