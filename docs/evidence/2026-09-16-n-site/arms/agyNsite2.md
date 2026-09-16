Etag, Last-Modified) and omits the body.
Wait, what about the error handler?
In `handle_errors`:
```caddy
	handle_errors {
		@notFound expression {http.error.status_code} == 404
		header @notFound Content-Type "text/plain; charset=utf-8"
		respond @notFound "The page could not be found" 404
	}
```
If a 404 occurs on a HEAD request:
Caddy's `respond` directive:
Does `respond` handle HEAD requests?
In Caddy, `respond` writes headers and omits body for HEAD.

WAIT! What about:
"HSTS duplicated by Cloudflare"?
Look at the attack prompt:
"ATTACK: any route or header where the Caddy block differs from the reference or from Vercel's behaviour (clean URLs, /x versus /x/, directories without index, dotfiles, path traversal, query strings, HEAD requests, 404 body and type, MIME types, cache headers, HSTS duplicated by Cloudflare);"
Wait! Why did the prompt mention:
"HSTS duplicated by Cloudflare"?
LET'S THINK ABOUT THIS!
Why did the user specifically mention "HSTS duplicated by Cloudflare"?!
Let's check:
In `commonswarm-site.caddy`:
```caddy
	route {
		header {
			Strict-Transport-Security "max-age=63072000"
			Cache-Control "public, max-age=0, must-revalidate"
		}
```
Wait!
On Hetzner VPS (`commonswarm-site.caddy`):
Caddy sends:
`Strict-Transport-Security: max-age=63072000`
Now:
When Cloudflare proxies `https://commonswarm.com`:
Cloudflare connects to the origin via HTTPS (port 443).
The origin (Caddy) sends `Strict-Transport-Security: max-age=63072000` to Cloudflare.
Now Cloudflare responds to the visitor / browser.
WHAT DOES CLOUDFLARE DO WITH HSTS?
In Cloudflare:
If HSTS is enabled in Cloudflare's dashboard (under SSL/TLS -> Edge Certificates -> Enable HSTS):
Cloudflare ADDS an `Strict-Transport-Security` header to edge responses!
Does Cloudflare OVERWRITE the origin's HSTS header, or does Cloudflare APPEND a second `Strict-Transport-Security` header?!
WAIT!
In Cloudflare's documentation:
"If HSTS is enabled in Cloudflare Edge Certificates AND the origin server sends an HSTS header:
Cloudflare sends BOTH headers, separated by a comma (or multiple headers):
`Strict-Transport-Security: max-age=31536000; includeSubDomains, max-age=63072000`!"
OR:
What if Cloudflare does NOT have HSTS enabled?
Then Cloudflare simply passes through the origin's HSTS header!
Wait, but on Vercel:
Did Vercel send HSTS?
Let's check `recordedHeaders` in `generate-vercel-reference.mjs` line 14:
```javascript
const recordedHeaders = [
  "strict-transport-security",
  "cache-control",
  "content-security-policy",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "location",
];
```
In `generate-vercel-reference.mjs`, it queried `https://commonswarm.com` (which was on Vercel)!
And what did Vercel send?
`Strict-Transport-Security: max-age=63072000` (that's why Caddy has `max-age=63072000`!).
And when the lead tested `site-staging.commonswarm.com` through Cloudflare live:
What did the prompt say?
"LIVE since: the lead deployed this lane to the box with deploy.sh (exit 0) and ran parity-check.mjs through Cloudflare on site-staging.commonswarm.com: every HTML route matched; the only 21 differences were Cloudflare rewriting cache-control to max-age=14400 on static-extension files (a zone Browser Cache TTL setting, raised with the box operator)."
EVERY HTML ROUTE MATCHED!
Including HSTS!
There was NO duplication of HSTS on `site-staging.commonswarm.com`!

WAIT!
LOOK AT WHAT THE PROMPT SAYS:
"the only 21 differences were Cloudflare rewriting cache-control to max-age=14400 on static-extension files (a zone Browser Cache TTL setting, raised with the box operator)."
Wait, why did the 21 static files have a difference?
Because in Cloudflare:
When a request passes through Cloudflare for a file with a static extension (e.g. `.js`, `.css`, `.png`, `.jpg`, `.ico`, `.svg`), Cloudflare caches the file and applies the zone's "Browser Cache TTL" setting!
If Browser Cache TTL is set to 4 hours (14400 seconds), Cloudflare replaces `Cache-Control: public, max-age=0, must-revalidate` with `Cache-Control: max-age=14400`!
And for HTML routes (which do not have static extensions), Cloudflare does not cache by default, so it preserves `Cache-Control: public, max-age=0, must-revalidate`!
And the prompt says: "(a zone Browser Cache TTL setting, raised with the box operator)."
So the operator needs to change Browser Cache TTL in Cloudflare to "Respect Existing Headers" if they want parity through Cloudflare for static extensions too.

NOW WAIT!
LET'S LOOK AT THE TESTS AGAIN:
"whether the tests can fail for the reason they claim."
LOOK AT THAT PROMPT INSTRUCTION:
"whether the tests can fail for the reason they claim."
LET'S GO THROUGH EVERY TEST IN `tests/p1-cli/site-on-box.test.ts` WITH A MICROSCOPE!

Test 1: `the Caddy clean-URL rules match every recorded Vercel route`
Lines 55-103:
```ts
test("the Caddy clean-URL rules match every recorded Vercel route", async () => {
  const inventory = await reference();
  const caddyfile = await readFile(join(deployRoot, "commonswarm-site.caddy"), "utf8");
  const artifacts = new Set(inventory.artifacts);

  assert.equal(inventory.stableArtifactCount, inventory.artifacts.length);
  assert.equal(
    inventory.artifactCount,
    inventory.stableArtifactCount + inventory.fingerprintedAssetPolicies.reduce(
      (count, policy) => count + policy.observedFileCount,
      0,
    ),
  );
  assert.equal(inventory.routeCount, inventory.routes.length);
  assert.match(caddyfile, /handle @cleanUrl \{/);
  assert.match(caddyfile, /try_files \{path\}\/index\.html \{path\}/);
  assert.doesNotMatch(caddyfile, /try_files\s+@cleanUrl|=404/);
  assert.match(caddyfile, /error @dotfile 404/);
  assert.match(caddyfile, /root \* \/srv\/commonswarm\/site\/current/);

  for (const route of inventory.routes) {
    const resolved = caddyArtifact(route.path, artifacts);
    assert.equal(
      route.status === 200,
      resolved !== undefined,
      `${route.path}: reference status ${route.status}, Caddy resolves ${String(resolved)}`,
    );
  }

  for (const path of ["/__commonswarm_missing__", "/_astro/", "/fonts/", "/.well-known/security.txt"]) {
    const route = inventory.routes.find((candidate) => candidate.path === path);
    assert.equal(route?.status, 404, `${path} must be in the negative inventory`);
    assert.equal(caddyArtifact(path, artifacts), undefined);
  }
  assert.match(caddyfile, /header @install Content-Type "application\/x-sh"/);
  assert.match(caddyfile, /header @markdown Content-Type "text\/markdown; charset=utf-8"/);
  assert.match(caddyfile, /header @javascript Content-Type "application\/javascript; charset=utf-8"/);
  assert.match(caddyfile, /header @manifest Content-Type "application\/manifest\+json; charset=utf-8"/);
  assert.match(caddyfile, /header @xml Content-Type "application\/xml"/);
  assert.doesNotMatch(caddyfile, /immutable|max-age=31536000/i);
  assert.equal(inventory.artifacts.some((file) => file.startsWith("_astro/")), false);
  assert.equal(inventory.routes.some((route) => /^\/_astro\/.+\.[A-Za-z0-9]+$/.test(route.path)), false);
  assert.deepEqual(
    inventory.fingerprintedAssetPolicies.map((policy) => policy.extension).sort(),
    [".css", ".js"],
  );
});
```
Wait! Look at lines 75-81:
```ts
  for (const route of inventory.routes) {
    const resolved = caddyArtifact(route.path, artifacts);
    assert.equal(
      route.status === 200,
      resolved !== undefined,
      `${route.path}: reference status ${route.status}, Caddy resolves ${String(resolved)}`,
    );
  }
```
WHAT IS `caddyArtifact`?
```ts
function caddyArtifact(path: string, artifacts: Set<string>): string | undefined {
  const relativePath = path.slice(1);
  if (path.endsWith("/")) {
    const index = `${relativePath}index.html`;
    return artifacts.has(index) ? index : undefined;
  }
  const cleanIndex = `${relativePath}/index.html`;
  if (artifacts.has(cleanIndex)) return cleanIndex;
  return artifacts.has(relativePath) ? relativePath : undefined;
}
```
WAIT!
Look at what `caddyArtifact` is:
It is a JavaScript function written in the test file!
Does this test test Caddy?
NO! It tests that `caddyArtifact` (a JS simulation written by the test author) matches `inventory.routes`!
It asserts that `caddyfile` contains certain regexes (`/handle @cleanUrl \{/`, `/try_files \{path\}\/index\.html \{path\}/`, etc.).
It does NOT actually invoke Caddy to route those 65 routes!
Wait! What test DOES invoke Caddy?
Test 2:
```ts
test("Caddy 2.11 adapts the route graph and retains the error route", async (t) => {
...
```
Test 2 runs `caddy adapt` to check that Caddy 2.11 accepts the Caddyfile and outputs a valid JSON config with an error route!
Does Test 2 actually serve HTTP requests with Caddy?
No, it runs `caddy adapt`.

### PRODUCTION

#### 1. Missing or stale local `site/dist` breaks pre-cutover parity check in the runbook path
- **File:Line:** [deploy/site/parity-check.mjs:20](file:///deploy/site/parity-check.mjs#L20), [deploy/site/parity-check.mjs:57-59](file:///deploy/site/parity-check.mjs#L57-L59), [deploy/site/deploy.sh:85-101](file:///deploy/site/deploy.sh#L85-L101), [deploy/site/RUNBOOK.md:24-37](file:///deploy/site/RUNBOOK.md#L24-L37)
- **Concrete Sequence:**
  1. An operator follows [deploy/site/RUNBOOK.md](file:///deploy/site/RUNBOOK.md) on a clean checkout (or without having manually run `npm run build` in `site/`):
     ```sh
     deploy/site/deploy.sh yulan-vps-1
     ```
  2. [deploy/site/deploy.sh](file:///deploy/site/deploy.sh#L85-L101) creates an ephemeral archive checkout in `$temp_root/checkout`, runs `npm run build` into `$temp_root/checkout/site/dist`, uploads that build to the box via rsync, and terminates. Upon exit, the trap executes `rm -rf -- "$temp_root"`. The script never copies or syncs the built `dist` into `$repo_root/site/dist`.
  3. The operator executes the next runbook step verbatim:
     ```sh
     node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com --ca ./cloudflare-origin-ca-root.pem
     ```
  4. [deploy/site/parity-check.mjs](file:///deploy/site/parity-check.mjs#L20) defaults `distPath` to `site/dist`. At line 57, it calls `filesBelow(resolve(distPath, "_astro"))` to derive hashed asset routes.
- **What Visitor or Operator Sees:**
  - **Clean checkout / no local build:** `site/dist/_astro` does not exist. `readdir` throws an unhandled exception:
    `node:fs/promises: ENOENT: no such file or directory, scandir '.../site/dist/_astro'`. The parity check crashes and exits 1.
  - **Stale local build:** If `site/dist/_astro` exists from an older build or previous commit, `parity-check.mjs` discovers the old hashes (e.g. `_astro/page.OLD.js`) and requests them from `https://BOX_ADDRESS`. Because this is a fresh release or first deploy, the box only serves the new hashes (`_astro/page.NEW.js`). The box returns HTTP 404, and `parity-check.mjs` reports:
    `/_astro/page.OLD.js: status expected 200, got 404`
    `Parity failed with 1 difference(s)`.
  Per [deploy/site/RUNBOOK.md:39](file:///deploy/site/RUNBOOK.md#L39) (*"The result must say that all routes passed. Do not move DNS if it reports a difference"*), the operator is blocked from cutting over DNS.

---

### RIGOUR

#### 1. Pre-cutover staging domain (`site-staging.commonswarm.com`) omitted from runbook instructions
- **File:Line:** [deploy/site/RUNBOOK.md:28-40](file:///deploy/site/RUNBOOK.md#L28-L40), [deploy/site/commonswarm-site.caddy:1-3](file:///deploy/site/commonswarm-site.caddy#L1-L3)
- **Concrete Sequence:**
  Commit `97ab1455` added `https://site-staging.commonswarm.com` to the Caddy site block specifically so that edge parity through Cloudflare could be verified before moving the production DNS records. However, `RUNBOOK.md` was not updated; it only documents checking the raw box IP with `--host commonswarm.com --ca ./cloudflare-origin-ca-root.pem`.
- **What Visitor or Operator Sees:**
  The operator is never instructed to run `parity-check.mjs https://site-staging.commonswarm.com` through Cloudflare before cutover. Consequently, Cloudflare zone-level modifications (such as edge cache rules or Cloudflare rewriting `Cache-Control` to `max-age=14400` on static extensions) remain unmeasured until production DNS moves.

#### 2. Test 1 asserts a JavaScript mock rather than Caddy route execution
- **File:Line:** [tests/p1-cli/site-on-box.test.ts:44-53](file:///tests/p1-cli/site-on-box.test.ts#L44-L53), [tests/p1-cli/site-on-box.test.ts:75-81](file:///tests/p1-cli/site-on-box.test.ts#L75-L81)
- **Concrete Sequence:**
  In `test("the Caddy clean-URL rules match every recorded Vercel route")`, the test evaluates route resolution using `caddyArtifact(route.path, artifacts)`, an in-memory JS path rewriter written in the test file, rather than testing Caddy's actual path rewriting engine on the 65 routes.
- **What Visitor or Operator Sees:**
  A logic discrepancy or change in Caddy's `try_files` semantics vs. `caddyArtifact()` would not be detected by this test; only discrepancies between the JS helper and `vercel-reference.json` are caught.

#### 3. Interrupted uploads leave `.tmp` release directories permanently unpruned
- **File:Line:** [deploy/site/finalize-release.sh:55-66](file:///deploy/site/finalize-release.sh#L55-L66)
- **Concrete Sequence:**
  If `rsync` or the network drops during upload, or `deploy.sh` is terminated, `/srv/commonswarm/site/releases/<release>.tmp` is left behind. During future deploys, `finalize-release.sh` loops over `$releases/20*` and encounters `.tmp` directories, but line 57 explicitly executes `*.tmp) continue ;;`.
- **What Visitor or Operator Sees:**
  Failed or partial uploads accumulate indefinitely in `/srv/commonswarm/site/releases/`, consuming disk space without being swept by the 5-release retention policy.

---

VERDICT: FAIL - The runbook's pre-cutover verification fails out-of-the-box on a clean checkout because deploy.sh builds in an ephemeral directory that is deleted before parity-check.mjs scans the local site/dist/_astro directory.
