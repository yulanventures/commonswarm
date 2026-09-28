An analysis of the production plan for the continuation window of CommonSwarm HM lane 6 (OAuth 2.1 authorization service, DARK) at SHA `826db6a34f235064a3a03c57377d8e32a35d2f05` (`BOX-WINDOW.md` v4 / `boxplan-hm6-v4.md`) has been conducted against all 13 blocking KEEP criteria.

---

### Analysis against KEEP (blocking) criteria

#### 1. Secret leakage protection
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 248–289, lines 927–940, lines 1291–1340.
- **Details:**
  - **Signing & Cookie Keys:** Stored in mode `0640` files (`/etc/commonswarm-oauth/signing-keys.pem`, `cookie-keys`) owned by `root:986` and mounted read-only into the container ([`deploy/mcp-auth/compose.yaml`](local path) lines 28–35).
  - **Database Credentials:** Stored in mode `0640` file `/etc/commonswarm-oauth/database-credentials` and read directly by [`services/mcp-auth/src/config.js`](local path) lines 153–157. Passwords do not enter environment variables or process arguments.
  - **Cloudflare DNS Token:** Read from a mode `0600` file into a temporary mode `0600` `curl` configuration file (`header = "[REDACTED:bearer]"`). The token is never passed via argv, environment, or URL, and output is captured quietly without leaking stderr/stdout (lines 1323–1352).
  - **Evidence Copy-back:** `ITEM_COPY_BACK_FILES` (lines 248–284) lists only non-secret status/catalog files. Secret files, raw environment dumps, and 1Password documents are explicitly excluded from copy-back (lines 288–289).

#### 2. File permissions and ownership
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 940–943, lines 969–1022; [`services/mcp-auth/src/config.js`](local path) lines 77–90; [`deploy/mcp-auth/compose.yaml`](local path) lines 28–43.
- **Details:**
  - Secret files (`signing-keys.pem`, `cookie-keys`, `database-credentials`) are owned `root:986`, mode `0640` (refused if `other` permissions exist: `mode & 0o007 !== 0`), and mounted `read_only: true`.
  - Public CA (`yulan-internal-ca.pem`) is owned `root:root` (uid 0), mode `0644` (refused if group/other writable: `mode & 0o022 !== 0`), and mounted `read_only: true`.
  - File policy step `hm6-prove-runtime-file-policy` (lines 969–1022) explicitly executes in-container assertions validating that mode `0644` CA is accepted while mode `0644` secret files are refused.

#### 3. 1Password service account integration
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 930–934, lines 1254–1256, lines 1291–1294.
- **Details:** 1Password items are accessed exclusively via Anvil’s service-account method into private mode `0600` files without printing values or improvising interactive CLI credentials.

#### 4. Container security posture
- **Finding:** PASS
- **Reference:** [`deploy/mcp-auth/compose.yaml`](local path) lines 8, 9, 50–54; [`boxplan-hm6-v4.md`](local path) lines 1125–1129.
- **Details:** Runs as unprivileged UID/GID `996:986` (`cs-oauth-080406`), `read_only: true` root filesystem, `cap_drop: ALL`, and `security_opt: [no-new-privileges:true]`. `hm6-start-dark-service` verifies non-root UID/GID at runtime.

#### 5. Database TLS verification
- **Finding:** PASS
- **Reference:** [`services/mcp-auth/src/config.js`](local path) line 202; [`boxplan-hm6-v4.md`](local path) lines 1059–1072.
- **Details:** `rejectUnauthorized: true` is enforced with custom CA (`yulan-internal-ca.pem`). Runtime database proof (`hm6-prove-runtime-database`) explicitly checks `socket.encrypted === true`, `socket.authorized === true`, `checkServerIdentity(host, cert) === undefined`, and SAN matching `DNS:db.commonswarm.internal`.

#### 6. Least privilege for database runtime role
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 838–917.
- **Details:** Step `hm6-prove-runtime-privileges` verifies exact column/table privileges (CRUD on 5 tables, SELECT+INSERT on tombstones), EXECUTE on a single function (`resolve_hosted_grant_status`), no membership in parent roles, no INHERIT/SET options into the role, and no schema/DB CREATE privileges.

#### 7. Dark status of public authorization & `/mcp`
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) line 948, lines 1552–1562; [`deploy/supabase-stack/commonswarm-mcp.caddy`](local path) lines 176–180.
- **Details:** `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0` turns `/authorize`, `/token`, and `/interaction/*` into 503 `authorization_service_disabled`. Caddy snippet `(mcp_resource_active)` remains unimported, responding 503 `feature_disabled` for `/mcp` and protected resource metadata. Both non-browser probe suites assert 503 responses.

#### 8. Route mapping in Caddy & Cloudflare
- **Finding:** PASS
- **Reference:** [`deploy/supabase-stack/commonswarm-mcp.caddy`](local path) lines 5–93, 174–192; [`boxplan-hm6-v4.md`](local path) lines 1278–1397.
- **Details:** Caddy proxies only endpoints implemented by `mcp-auth` (`/health`, metadata, `/authorize`, `/token`, `/interaction/*`, `/oauth/callback/gotrue`). Unmatched paths return 404, wrong methods return 405, and `/mcp` returns 503. Cloudflare DNS record creates a single proxied A record for `mcp.commonswarm.com`.

#### 9. GoTrue allow list preservation
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 1163–1220.
- **Details:** Step `hm6-append-gotrue-callback` parses `GOTRUE_URI_ALLOW_LIST`, appends `https://mcp.commonswarm.com/oauth/callback/gotrue` if absent, and asserts that all other lines in `/home/commonswarm/.env` remain unchanged.

#### 10. Caddy log file creation & validation
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 1468–1505.
- **Details:** Log path is parsed from the rendered Caddyfile and asserted to reside strictly inside `/var/log/caddy/`. If missing, the file is pre-created as `caddy:caddy` mode `0600`. `caddy validate` is run as the unprivileged `caddy` user (`runuser -u caddy -- caddy validate ...`), avoiding root-owned log creation. Ownership is re-verified after validation.

#### 11. Browser Integrity Check (BIC) handling
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 1533–1647.
- **Details:** Step `hm6-probe-nonbrowser-ingress` tests non-browser clients (`claude-connector-test/1.0` and standard `urllib`). If BIC blocks (e.g. error `1010` or `403`), validation fails and halts execution immediately. Spoofing User-Agents or bypassing proxying is explicitly prohibited.

#### 12. Execution script safety
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 293–1934.
- **Details:**
  - No `HOME` variable assignments exist across any of the 24 shell execution blocks.
  - No recursive deletion (`rm -rf`) of variables or loose paths exists. Cleanup uses `rm -f` for specific files and `rmdir` for validated `mktemp -d` directories created in the same block (`POLICY_TMP` lines 974–982; `DNS_TMP` lines 1308–1314).
  - No `docker` commands run on the Mac mini (Mac mini blocks use only `git`, `shasum`, `scp`, `python3`, `curl`).

#### 13. Teardown & rollback completeness
- **Finding:** PASS
- **Reference:** [`boxplan-hm6-v4.md`](local path) lines 1873–1945.
- **Details:** Teardown stops/removes the container, restores the prior Caddy file (removing the route), deletes the Cloudflare DNS record via API (verifying absence), removes the GoTrue allowlist entry, and restricts on-host secret files while marking vault items retired. No route, DNS record, or GoTrue callback is left active.

---

### Nits
- None noted; procedural steps and inline Python script assertions are well-bounded and match repository contracts.

---

VERDICT: PASS (no KEEP)