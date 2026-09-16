### Findings

#### Finding 1: Caddy `handle_errors` drops `Strict-Transport-Security` and `Cache-Control` on 404 routes
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/commonswarm-site.caddy:6-9](file:///deploy/site/commonswarm-site.caddy#L6-L9) and [deploy/site/commonswarm-site.caddy:33-37](file:///deploy/site/commonswarm-site.caddy#L33-L37)
- **Concrete request or sequence**:
  ```sh
  node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com
  # or directly:
  curl -sS -k -D - -o /dev/null -H "Host: commonswarm.com" https://BOX_ADDRESS/__commonswarm_missing__
  ```
- **What a visitor or operator sees**:
  In `commonswarm-site.caddy`, `Strict-Transport-Security` and `Cache-Control` are defined only inside the main `route { header { ... } }` block. In Caddy, when an error occurs (such as a 404 returned by `file_server` or `try_files`), execution leaves the primary route and enters `handle_errors`. The `handle_errors` directive runs with a reset header map and only sets `Content-Type: text/plain; charset=utf-8` before responding.
  
  On Vercel, all 404 routes (such as `/__commonswarm_missing__`, `/_astro/`, and `/fonts/`) return:
  - `strict-transport-security: max-age=63072000`
  - `cache-control: public, max-age=0, must-revalidate`
  
  On Caddy, those headers are completely omitted (`null`). When the operator runs `parity-check.mjs` as required by [RUNBOOK.md](file:///deploy/site/RUNBOOK.md#L35-L38), the script outputs:
  ```text
  Parity failed with 6 difference(s):
  - /__commonswarm_missing__: strict-transport-security expected "max-age=63072000", got null
  - /__commonswarm_missing__: cache-control expected "public, max-age=0, must-revalidate", got null
  - /_astro/: strict-transport-security expected "max-age=63072000", got null
  - /_astro/: cache-control expected "public, max-age=0, must-revalidate", got null
  - /fonts/: strict-transport-security expected "max-age=63072000", got null
  - /fonts/: cache-control expected "public, max-age=0, must-revalidate", got null
  ```
  The process exits with code 1. Per the runbook ("Do not move DNS if it reports a difference"), the operator is hard-blocked from executing the DNS cutover.

---

#### Finding 2: Directories without index redirect with 308 instead of returning 404
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/commonswarm-site.caddy:27-28](file:///deploy/site/commonswarm-site.caddy#L27-L28)
- **Concrete request or sequence**:
  ```sh
  curl -sS -k -D - -o /dev/null -H "Host: commonswarm.com" https://BOX_ADDRESS/fonts
  curl -sS -k -D - -o /dev/null -H "Host: commonswarm.com" https://BOX_ADDRESS/_astro
  ```
- **What a visitor or operator sees**:
  In `commonswarm-site.caddy`, `@cleanUrl not path */` matches any path without a trailing slash. For a request like `/fonts` or `/_astro`, `try_files` checks `{path}/index.html` (which does not exist) and then `{path}`. Because `/fonts` and `/_astro` exist as directories on the filesystem under `current/`, `try_files` leaves the path as `/fonts` and hands it off to `file_server`.
  
  Caddy's `file_server` canonicalizes directory requests without a trailing slash by returning an HTTP `308 Permanent Redirect` with `Location: /fonts/` (or `/_astro/`). Vercel does not perform directory-redirect canonicalization on static build asset directories without an index; it returns 404 directly. A visitor requesting `/fonts` or `/_astro` sees an extraneous 308 redirect before receiving a 404 on the following request.

---

#### Finding 3: Non-404 HTTP errors in Caddy produce an empty response body
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/commonswarm-site.caddy:33-37](file:///deploy/site/commonswarm-site.caddy#L33-L37)
- **Concrete request or sequence**:
  ```sh
  curl -sS -k -X POST -H "Host: commonswarm.com" https://BOX_ADDRESS/
  ```
- **What a visitor or operator sees**:
  The `handle_errors` block strictly matches 404:
  ```caddy
  @notFound expression {http.error.status_code} == 404
  header @notFound Content-Type "text/plain; charset=utf-8"
  respond @notFound "The page could not be found" 404
  ```
  If a request triggers 405 (Method Not Allowed, e.g., POST/PUT on static routes), 403 (Forbidden), or 500 (Internal Server Error), `@notFound` does not match, and no handler runs. Caddy sends back a completely empty response body (0 bytes), differing from Vercel's standard error response format (`405: METHOD_NOT_ALLOWED`).

---

#### Finding 4: Pre-cutover `curl` verification commands fail on untrusted Cloudflare Origin CA certificate
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/RUNBOOK.md:44-52](file:///deploy/site/RUNBOOK.md#L44-L52)
- **Concrete request or sequence**:
  ```sh
  U=https://commonswarm.com
  curl -sS --resolve commonswarm.com:443:BOX_ADDRESS -o /dev/null -w '%{http_code}\n' "$U"
  ```
- **What a visitor or operator sees**:
  Caddy is configured with `/etc/caddy/certs/commonswarm.com.pem` (a Cloudflare Origin CA certificate). Cloudflare's Origin CA root certificate is not part of default OS CA trust stores. While the runbook instructs the operator to set `NODE_EXTRA_CA_CERTS` for Node.js, `curl` does not read `NODE_EXTRA_CA_CERTS`.
  
  When the operator runs the curl commands on lines 44–52, curl aborts with:
  ```text
  curl: (60) SSL certificate problem: unable to get local issuer certificate
  ```
  `curl -w '%{http_code}\n'` outputs `000` instead of `200`, and all downstream `grep` pipelines fail, preventing pre-cutover control verification. The runbook lacks `--cacert` or `-k` for the pre-cutover controls.

---

#### Finding 5: `deploy.sh` preserves local umask via `rsync -a`, risking 403/404 errors on the server
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/deploy.sh:79](file:///deploy/site/deploy.sh#L79)
- **Concrete request or sequence**:
  ```sh
  umask 0077
  deploy/site/deploy.sh yulan-vps-1
  ```
- **What a visitor or operator sees**:
  In `deploy.sh`, files are built locally and uploaded via:
  ```sh
  rsync -a --delete "$checkout/site/dist/" "$box:$remote_temp/"
  ```
  `rsync -a` strictly preserves local file and directory modes. If the deploying operator or CI runner has a restrictive umask (`0077` or `0027`), the uploaded files will be mode `0600` and directories `0700`, owned by the SSH deploy user.
  
  Because `deploy.sh` lacks `--chmod=D755,F644` in rsync or a remote `chmod -R a+rX`, the Caddy daemon (running as unprivileged `caddy` or `www-data`) cannot read the static files or traverse the release directory. Visitors immediately receive 403 Forbidden or 404 Not Found across the entire site upon release.

---

#### Finding 6: Asset requests from active visitors immediately 404 across releases
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/commonswarm-site.caddy:3](file:///deploy/site/commonswarm-site.caddy#L3) and [deploy/site/deploy.sh:80](file:///deploy/site/deploy.sh#L80)
- **Concrete request or sequence**:
  1. A visitor fetches `GET /` right before deploy finishes, receiving HTML referencing `_astro/App.oldhash.js`.
  2. The operator runs `deploy.sh`, swapping `/srv/commonswarm/site/current` to the new release.
  3. The visitor's browser attempts `GET /_astro/App.oldhash.js`.
- **What a visitor or operator sees**:
  Caddy sets `root * /srv/commonswarm/site/current`. As soon as `current` points to the new release directory, the previous release's hashed assets are no longer within the document root. Unlike Vercel, which keeps earlier deployment assets available on CDN edge nodes during cutovers, Caddy returns 404 for any in-flight visitor loading older asset chunks. Active users experience broken layouts and failed client-side routing.

---

#### Finding 7: Hardcoded asset paths in `vercel-reference.json` break parity checks for future builds
- **Label**: PRODUCTION
- **File:Line**: [deploy/site/generate-vercel-reference.mjs:54-60](file:///deploy/site/generate-vercel-reference.mjs#L54-L60) and [deploy/site/parity-check.mjs:57](file:///deploy/site/parity-check.mjs#L57)
- **Concrete request or sequence**:
  1. Any frontend file in `site/src/` is modified and committed.
  2. The operator runs `deploy.sh yulan-vps-1` and then `node deploy/site/parity-check.mjs https://BOX_ADDRESS --host commonswarm.com`.
- **What a visitor or operator sees**:
  Astro produces content-hashed filenames for assets under `site/dist/_astro/`. `vercel-reference.json` contains 14 hardcoded asset routes (such as `/_astro/Base.CU6LT-wJ.css` and `/_astro/commonswarm.BdF9KN8q.js`) measured from one historical build.
  
  When a new release is built with new hashes, the historical filenames no longer exist in `site/dist/`. `parity-check.mjs` queries the 14 old asset paths against the new release, Caddy returns 404 for each, and `parity-check.mjs` exits with 14 status errors (`status expected 200, got 404`), permanently breaking post-commit parity checking.

---

#### Finding 8: Invalid Nginx-style `=404` argument in Caddy's `try_files` directive
- **Label**: RIGOUR
- **File:Line**: [deploy/site/commonswarm-site.caddy:28](file:///deploy/site/commonswarm-site.caddy#L28)
- **Concrete request or sequence**:
  ```caddy
  @cleanUrl not path */
  try_files @cleanUrl {path}/index.html {path} =404
  ```
- **What a visitor or operator sees**:
  In Nginx, `=404` indicates a fallback status code. In Caddy, `try_files` does not support `=<code>` syntax. Every argument is parsed as a relative file path. Caddy attempts to stat a literal file named `/srv/commonswarm/site/current/=404`. When none of the files match, `try_files` performs no rewrite and falls through to `file_server`. While `file_server` happens to 404 when `{path}` does not exist, `=404` is a configuration bug stemming from Nginx/Caddy directive confusion.

---

#### Finding 9: Test 1 does not execute Caddy and cannot detect Caddy routing or header failures
- **Label**: RIGOUR
- **File:Line**: [tests/p1-cli/site-on-box.test.ts:36-78](file:///tests/p1-cli/site-on-box.test.ts#L36-L78)
- **Concrete request or sequence**:
  ```sh
  node --test tests/p1-cli/site-on-box.test.ts
  ```
- **What a visitor or operator sees**:
  Test 1 (`the Caddy clean-URL rules match every recorded Vercel route`) claims to test that Caddy matches Vercel's behavior. In reality, it never runs Caddy or its config adapter. It runs a synthetic TypeScript helper (`caddyArtifact`) that does trivial string lookups in a JavaScript `Set`. It matches raw regex substrings in the Caddyfile (`/rewrite @trailingSlash/`). The test passes completely green even though Caddy's actual runtime execution fails parity checks on headers and error handling.

---

#### Finding 10: Unbounded release accumulation on the server disk
- **Label**: RIGOUR
- **File:Line**: [deploy/site/deploy.sh:74-80](file:///deploy/site/deploy.sh#L74-L80) and [deploy/site/RUNBOOK.md:29](file:///deploy/site/RUNBOOK.md#L29)
- **Concrete request or sequence**:
  Repeated invocations of `deploy/site/deploy.sh yulan-vps-1`.
- **What a visitor or operator sees**:
  `deploy.sh` uploads each build to a timestamped directory in `/srv/commonswarm/site/releases/`. It contains no pruning logic (such as keeping the last 5 releases). Over time, unpruned releases with static assets, images, and fonts accumulate, eventually exhausting server disk space and failing subsequent deployments.

---

#### Finding 11: Deploying twice within the same second corrupts the release directory
- **Label**: RIGOUR
- **File:Line**: [deploy/site/deploy.sh:74-80](file:///deploy/site/deploy.sh#L74-L80)
- **Concrete request or sequence**:
  Re-running `deploy/site/deploy.sh` within the same UTC second.
- **What a visitor or operator sees**:
  The release name uses UTC seconds: `$(date -u +%Y%m%dT%H%M%SZ)-$(git ... rev-parse --short=12 HEAD)`. If re-run in the same second, `$remote_release` already exists. The remote command `mv '$remote_temp' '$remote_release'` nests the incoming temporary directory inside the existing release directory as `$remote_release/$release.tmp`, polluting the release directory and leaving `current` pointing to un-updated content.

---

#### Finding 12: `deploy.sh` lacks pre-deploy validation against `service_role` key leakage
- **Label**: RIGOUR
- **File:Line**: [deploy/site/deploy.sh:21-24](file:///deploy/site/deploy.sh#L21-L24) and [deploy/site/deploy.sh:49-54](file:///deploy/site/deploy.sh#L49-L54)
- **Concrete request or sequence**:
  An operator inadvertently configures `PUBLIC_SUPABASE_ANON_KEY` with a Supabase `service_role` secret in `site/.env` and executes `deploy.sh`.
- **What a visitor or operator sees**:
  `deploy.sh` verifies that `PUBLIC_SUPABASE_ANON_KEY` is non-empty, but unlike [RUNBOOK.md:51](file:///deploy/site/RUNBOOK.md#L51), it does not check for the `service_role` JWT payload marker (`InNlcnZpY2Vfcm9sZSI`). The script compiles and publishes the high-privilege service secret to the production server.

---

VERDICT: FAIL - Caddy's handle_errors drops HSTS and Cache-Control headers on 404 routes causing parity-check failure, directory requests redirect instead of 404, curl controls fail on untrusted Origin CA certs, and asset switches break in-flight visitors.
