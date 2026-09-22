import assert from "node:assert/strict";
import test from "node:test";
import {
  CAPABILITY_ALLOWED_HOSTS,
  CAPABILITY_SITE_ORIGIN,
  capabilitySiteOrigin,
  capabilityUrl,
} from "../../src/cloud/capability-link.js";
import { usage } from "../../src/cli.js";

const TOKEN = `swm_cap_${"a".repeat(43)}`;

test("capability link default host is https://commonswarm.com", () => {
  assert.equal(CAPABILITY_SITE_ORIGIN, "https://commonswarm.com");
  assert.deepEqual(
    [...CAPABILITY_ALLOWED_HOSTS],
    ["commonswarm.com", "www.commonswarm.com"],
  );
  assert.equal(
    capabilitySiteOrigin(undefined, undefined),
    "https://commonswarm.com",
  );
  assert.equal(
    capabilityUrl(CAPABILITY_SITE_ORIGIN, TOKEN),
    `https://commonswarm.com/see#${TOKEN}`,
  );
});

test("capability link refuses the deleted Vercel host", () => {
  assert.throws(
    () => capabilitySiteOrigin("https://coswarm-site.vercel.app", undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /https:\/\/commonswarm\.com/);
      assert.match(error.message, /https:\/\/www\.commonswarm\.com/);
      assert.doesNotMatch(error.message, /coswarm-site\.vercel\.app/);
      assert.match(error.message, /returns 404/);
      return true;
    },
  );
});

test("help lists capability hosts from the allowlist and does not claim /see works", () => {
  const help = usage();
  assert.match(help, new RegExp(CAPABILITY_SITE_ORIGIN.replace(/[.]/g, "\\.")));
  for (const host of CAPABILITY_ALLOWED_HOSTS) {
    assert.match(help, new RegExp(`https://${host.replace(/[.]/g, "\\.")}`));
  }
  assert.doesNotMatch(help, /coswarm-site\.vercel\.app/);
  assert.match(help, /opening the link\s+returns 404/);
  assert.doesNotMatch(help, /page is being developed/);
  assert.doesNotMatch(help, /which CommonSwarm page the link points at/);
});
