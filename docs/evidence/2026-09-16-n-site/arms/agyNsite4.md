### D-036 Review: Item N-site (`lane/site-on-box` at SHA `568b9490c0b7308580ebc8c7258a87328e33c3c6`)

---

### 1. Route and Header Parity

- **File URLs with Trailing Slashes (`/install.sh/`, `/og.png/`, `/_astro/*.js/`)**:
  - `commonswarm-site.caddy:16-17` matches any file path containing an extension followed by a trailing slash via `@fileWithSlash path_regexp fileWithSlash ^(.+\.[^/]+)/$` and rewrites it in-place to `{re.fileWithSlash.1}`.
  - This runs ahead of MIME matching and route handles inside `route { ... }`.
  - Concrete sequence: requesting `GET /install.sh/` rewrites internally to `/install.sh`, matches `@install path /install.sh`, sets `Content-Type: application/x-sh`, and is served directly by `try_files` with HTTP `200` (identical to Vercel, fixing the earlier Caddy `400` ENOTDIR error).
- **Clean URLs (`/x` vs `/x/`) & Directory Paths**:
  - Unslashed routes (`@cleanUrl not path */`) evaluate `try_files {path}/index.html {path}` with `disable_canonical_uris`, serving `/start` from `/start/index.html` without redirect.
  - Slashed routes (`/start/`, `/`) enter the fallback `handle` and rewrite to `{path}index.html`, serving index files without redirect.
  - Directories lacking an index (e.g. `/_astro/`, `/fonts/`) rewrite to missing index files and return `404` without directory indexing or canonical redirect loops.
- **Dotfiles & Path Traversal**:
  - `@dotfile path_regexp dotfile (?:^|/)\.` catches any dotfile-shaped path (e.g., `/.well-known/security.txt`, `/.env`, `/.git`) and triggers `error @dotfile 404`.
  - Caddy canonicalizes path traversal attempts (`../`), preventing directory escape.
- **Query Strings & HEAD Requests**:
  - Caddy matchers and `rewrite` preserve query strings (`?foo=bar`).
  - Standard HTTP HEAD requests are handled natively by `file_server`, returning identical headers without a payload.
- **404 Body Shape and Content Type**:
  - `handle_errors` filters on `@notFound expression {http.error.status_code} == 404`, outputs `Content-Type: text/plain; charset=utf-8`, and provides the exact 5-line Vercel error template with terminal newline (`matchesBodyShape` in [parity-check.mjs](file:///deploy/site/parity-check.mjs#L95-L107) validates line count, markers, and line structure).
- **Security & Cache Headers**:
  - `Strict-Transport-Security "max-age=63072000"` and `Cache-Control "public, max-age=0, must-revalidate"` are applied unconditionally at the entry of `route`.

---

### 2. Deploy Pipeline & Failure Modes

- **Clean Isolated Build**:
  - [deploy.sh](file:///deploy/site/deploy.sh#L90-L102) extracts a pristine tree from `git archive HEAD` into a temporary directory, symlinks local [site/.env](file:///site/.env) without copying secrets, cleans `site/dist`, runs `npm ci` and `npm run build` locally in checkout, and validates `dist/start/index.html` for `commonswarm:url`.
  - A failed build or missing backend URL terminates immediately (`set -eu`), removing the temporary directory without remote side effects.
- **Credential Validation**:
  - [validate-site-env.mjs](file:///deploy/site/validate-site-env.mjs#L24-L48) parses `PUBLIC_SUPABASE_ANON_KEY`, verifies its 3-segment JWT structure, decodes the payload, and refuses execution if `payload.role === "service_role"`, without printing key contents.
- **Upload & Atomic Activation**:
  - Generates a unique collision-resistant release name (`<timestamp>-<short_commit>-<16_hex_urandom>`).
  - Uploads to an isolated `$remote_temp` directory (`.tmp`). An interrupted upload leaves an unlinked `.tmp` directory that is cleaned up after 60 minutes.
  - Normalizes directory permissions (`755`) and file permissions (`644`) on the box in [finalize-release.sh](file:///deploy/site/finalize-release.sh#L39-L40), avoiding client-side `rsync --chmod` incompatibilities.
  - Carries forward previous `_astro` assets via `rsync -a --ignore-existing`, ensuring clients holding in-flight HTML do not encounter broken asset links.
  - Symlink cutover uses `mv -Tf current.next current` (with a safe fallback for non-GNU environments), guaranteeing atomic release activation.
- **Pruning & Rollback**:
  - Release pruning counts directories matching `20??????T??????Z-????????????-????????????????` and removes candidates older than the 5 newest releases.
  - Prune operations run after the symlink swap and are guarded against failing an active deploy.
  - Rollback procedure in [RUNBOOK.md](file:///deploy/site/RUNBOOK.md#L77-L86) provides exact atomic symlink reversal commands on the box as well as DNS rollback instructions to Vercel.

---

### 3. Verification Rigour & Parity Tooling

- **Build-Derived Reference**:
  - [generate-vercel-reference.mjs](file:///deploy/site/generate-vercel-reference.mjs#L64-L149) scans `site/dist`, hashes the build payload, synthesizes both slash and non-slash request variants for all stable routes, samples fingerprinted extensions, and records actual live responses from `https://commonswarm.com`.
- **Dynamic Asset Discovery & Rate Control**:
  - [parity-check.mjs](file:///deploy/site/parity-check.mjs#L134-L215) dynamically crawls HTML and dependent CSS/JS files to discover fingerprinted assets at check time, verifying both normal and trailing-slash variants for all 106 routes.
  - Remote requests pace at 550 ms intervals (`Math.max(500, requestIntervalMs)`), preventing upstream rate limiting.
  - `--allow-cloudflare-browser-ttl` strictly constrains allowed rewrites to `cache-control: public, max-age=14400, must-revalidate` exclusively on static extensions (`.css`, `.js`, `.png`, `.svg`, `.woff2`). Any other difference triggers exit code 1.

---

VERDICT: PASS
Reason: Caddy routing and error handling achieve complete parity with Vercel across all 106 routes (including trailing-slash file variants, clean URLs, and 404 body shapes), credentials and permissions are strictly enforced, and the atomic deployment and rollback procedures are fully resilient.
