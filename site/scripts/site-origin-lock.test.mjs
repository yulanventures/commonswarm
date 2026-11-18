import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const read = path => readFile(new URL(path, import.meta.url), "utf8");

test("the site's web-server block requires a client certificate from its trust pool, and holds paths only", async () => {
  const caddy = await read("../../deploy/site/commonswarm-site.caddy");
  // Live has this block; a repo file without it would open the origin to direct requests on the next copy.
  assert.match(caddy, /\n\ttls \S+\.pem \S+\.key \{\n\t\tclient_auth \{\n\t\t\tmode require_and_verify\n\t\t\ttrust_pool file \S+\.pem\n\t\t\}\n\t\}\n/u);
  assert.doesNotMatch(caddy, /BEGIN [A-Z ]*(?:PRIVATE KEY|CERTIFICATE)/u);
});

test("the isolated check strips that block for plain HTTP and proves it on its own listener", async () => {
  const check = await read("../../deploy/site/check-site-caddy.sh");
  assert.match(check, /the TLS block was not fully removed from the loopback copy/u);
  for (const line of ["client certificate signed by the trust pool\" served", "no client certificate\" refused", "client certificate the pool did not sign\" refused"]) {
    assert.ok(check.includes(line), line);
  }
});
