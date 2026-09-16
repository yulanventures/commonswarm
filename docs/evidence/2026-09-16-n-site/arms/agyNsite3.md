### Findings

#### RIGOUR: `deploy/site/RUNBOOK.md:72`
- **Request / Sequence**: In [`deploy/site/RUNBOOK.md`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/deploy/site/RUNBOOK.md#L72), under *Move Cloudflare DNS*, step 3 instructs the operator to run:
  ```sh
  node deploy/site/parity-check.mjs https://commonswarm.com
  ```
- **Operator / Visitor Impact**: As documented earlier in the runbook (lines 39–44), the Cloudflare zone enforces a 4-hour Browser Cache TTL on static extensions (`.css`, `.js`, `.png`, `.svg`, `.woff2`), rewriting `Cache-Control` to `public, max-age=14400, must-revalidate` on 21 routes. The operator accepted this for cutover with the plan to adjust the zone setting later. Because `commonswarm.com` resides in the exact same Cloudflare zone as `site-staging.commonswarm.com`, running step 3 without `--allow-cloudflare-browser-ttl` causes `parity-check.mjs` to report all 21 differences and exit with code 1, which blocks the post-cutover verification gate before Vercel retirement. Step 3 should include `--allow-cloudflare-browser-ttl`.

---

### Analysis of Invariants and Fixes

1. **Caddy Route Parity & Behavior**:
   - Clean URLs (`/x` and `/x/`) serve `/x/index.html` without redirects via mutually exclusive `handle @cleanUrl` (`try_files {path}/index.html {path}`) and fallback `handle` (`rewrite * {path}index.html`).
   - Root `/` correctly bypasses `@cleanUrl` and is rewritten to `/index.html`.
   - Missing routes and directories without an index (`/fonts/`, `/_astro/`, `/__commonswarm_missing__`) return 404 with text `The page could not be found` and `Content-Type: text/plain; charset=utf-8`.
   - Dotfile-shaped paths (`/.well-known/security.txt`, `/.env`) are caught by `@dotfile path_regexp dotfile (?:^|/)\.` and served as 404.
   - Exact MIME overrides are applied inside the `route` block for `.sh`, `.md`, `.js`, `.webmanifest`, and `.xml`.
   - Docker Caddy 2.11 integration test executes against all 52 stable routes and validates parity.

2. **Deploy & Finalization Atomicity**:
   - Builds cleanly from `git archive HEAD` into an isolated temporary directory with `site/.env` symlinked locally (read-only 0600, never copied into `dist/`).
   - Rejects `service_role` JWTs locally before building.
   - Uploads to a timestamped + random 16-hex suffix directory (`.tmp`) without `--chmod`.
   - `finalize-release.sh` carries forward prior `_astro/` hashed assets with `rsync -a --ignore-existing`, normalizes permissions to 0755/0644, performs an atomic symlink swap (`mv -Tf`), prunes stale `.tmp` directories older than 1 hour, and prunes releases to the 5 newest.

3. **Dynamic Asset Parity Checking**:
   - `parity-check.mjs` has no dependency on local `site/dist`.
   - Discovers hashed assets dynamically from HTML responses and follows imports in CSS and JS.
   - Cloudflare TTL exemption strictly isolates the 21 measured static-extension rewrites when `--allow-cloudflare-browser-ttl` is active.

VERDICT: PASS
