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
  // The TLS cases are never skipped: without openssl the check fails before it starts.
  assert.match(check, /for tool in curl openssl; do\n\s*command -v "\$tool" >\/dev\/null 2>&1 \|\| \{ echo "FAIL: /u);
  assert.doesNotMatch(check, /SKIPPED/u);
  // Both fixtures bind to loopback, the adapted listeners are checked, and no curl goes through a proxy.
  assert.equal(check.match(/\\n\\tbind 127\.0\.0\.1\\n/gu)?.length, 2, "each fixture's site block binds to 127.0.0.1");
  assert.equal(check.match(/^\s*loopback_only "\$work\/Caddyfile(?:\.tls)?"$/gmu)?.length, 2, "each fixture's listeners are checked");
  const curls = check.split("\n").filter(line => /\bcurl\b/u.test(line) && !/^\s*#/u.test(line) && !/for tool in curl/u.test(line));
  assert.ok(curls.length > 0);
  for (const line of curls) assert.match(line, /local_curl|curl --noproxy '\*'/u, line.trim());
});
