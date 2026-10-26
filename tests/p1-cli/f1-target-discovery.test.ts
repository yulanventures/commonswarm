import assert from "node:assert/strict";
import { test } from "node:test";
import {
  discoverCloudTarget,
} from "../../src/cloud/current-target.js";

/* F-1 of the 2026-08-10 dogfood. `install.sh` closes by telling a stranger with no invite to run
 * `cswarm login` and `cswarm new`; both refused with "no Cloud target is selected", and the
 * remedy offered three routes, none open to that reader. Measured cold, in an isolated HOME.
 *
 * The values are published by us on the host the installer came from, so the fix is to ask the
 * deployment. AGENTS.md: "The anon key is a public identifier protected by RLS, not a secret." */

const URL = "https://ukezjcnxjvkpkeezxaew.supabase.co";
const KEY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.sig";

const page = (url = URL, key = KEY) =>
  `<html><head><meta name="commonswarm:url" content="${url}">` +
  `<meta name="commonswarm:anon-key" content="${key}"></head></html>`;

test("F-1: a plaintext origin is refused before any request is made", async () => {
  /* A discovered target is WRITTEN to the credential store, so an origin that can be tampered
   * with in flight chooses where this CLI sends its traffic from then on. */
  let called = false;
  const fetcher = (async () => {
    called = true;
    return new Response(page());
  }) as unknown as typeof fetch;

  const target = await discoverCloudTarget({
    origin: "http://commonswarm.com",
    fetcher,
  });

  assert.equal(target, null);
  assert.equal(called, false, "it contacted a plaintext origin");
});
