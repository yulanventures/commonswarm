# Security Review Report: CommonSwarm HM Lane 6 Release Plan (v2)

**Target SHA:** `9fa4217da9f6447e55fb8c6d577b8fd3997f926b`
**Plan Document:** `BOX-WINDOW.md` (v2) in `local path`
**Review Type:** Read-Only Production Security Review

---

## 1. Summary of Analysis

I have completed a thorough read-only security evaluation of the production release plan `BOX-WINDOW.md` (v2) and the corresponding repository artifacts for CommonSwarm HM lane 6 (OAuth 2.1 service `services/mcp-auth` and migration `20260928000003_hm_oauth_store.sql`).

Every item specified in the production security review mandate was evaluated against the codebase and release plan.

---

## 2. Category-by-Category Review Findings

### 2.1 Secret Handling & Exposure Controls
- **Finding:** No secret values (signing keys, cookie keys, database passwords, tokens) are printed, echoed, logged, passed in CLI flags/argv, embedded in URLs, committed to Compose files, or exposed to evidence files.
- **Verification:**
  - `services/mcp-auth/src/config.js` (lines 71–86): Keys and credentials are read strictly from protected host file paths passed via env vars (`MCP_OAUTH_SIGNING_KEYS_FILE`, `MCP_OAUTH_COOKIE_KEYS_FILE`, `MCP_OAUTH_DATABASE_CREDENTIALS_FILE`).
  - `deploy/mcp-auth/compose.yaml` (lines 19–21, 28–39): Secrets are mounted as read-only files from `/etc/commonswarm-oauth/` into `/run/commonswarm-oauth/`.
  - `BOX-WINDOW.md` (lines 735–762, step `hm6-generate-protected-keys`): Secrets are written directly via Node script `writeFileSync` with mode `0640`. No keys are echoed or printed to stdout.
  - `services/mcp-auth/src/logger.js` (lines 1–15): The logger strictly enforces a field allowlist (`ALLOWED_FIELDS`) and strips query strings from path logs (`split("?", 1)[0]`).
  - `BOX-WINDOW.md` (lines 195): Explicitly forbids copying `window.env`, secret files, or raw logs into evidence output.

### 2.2 Key File Ownership, Permissions & Volume Mounts
- **Finding:** Key files have restricted file permissions (`0640` / `0600`) owned by `root:<service_gid>`, and all container volume mounts are read-only.
- **Verification:**
  - `deploy/mcp-auth/compose.yaml` (lines 28–43): All 4 volume mounts (`signing-keys.pem`, `cookie-keys`, `database-credentials`, `yulan-internal-ca.pem`) specify `read_only: true`.
  - `BOX-WINDOW.md` (lines 756–758, 805, 809, 819): Host files `/etc/commonswarm-oauth/signing-keys.pem` and `/etc/commonswarm-oauth/cookie-keys` are set to `chown "root:$MCP_OAUTH_GID"` and `chmod 0640`. Environment configuration files use `0600`.

### 2.3 Container Execution Privileges & Isolation
- **Finding:** The container runs as an unprivileged user with no extra Linux capabilities and a read-only root filesystem.
- **Verification:**
  - `services/mcp-auth/Dockerfile` (line 11): Specifies `USER 10001:10001`.
  - `deploy/mcp-auth/compose.yaml` (lines 8–10, 50–53): Enforces `user: "${MCP_OAUTH_UID}:${MCP_OAUTH_GID}"`, `read_only: true`, `cap_drop: [- ALL]`, and `security_opt: [- no-new-privileges:true]`.
  - `BOX-WINDOW.md` (lines 928–929, step `hm6-start-dark-service`): Includes an explicit runtime check `docker exec "$CID" node -e 'if(process.getuid()===0||process.getgid()===0)process.exit(1);'` ensuring non-root execution.

### 2.4 Database TLS Verification
- **Finding:** Database connections strictly verify TLS certificates and hostnames against `/etc/ssl/yulan-internal-ca.pem`.
- **Verification:**
  - `services/mcp-auth/src/config.js` (lines 125): Configures `ssl: { ca: tlsCa, rejectUnauthorized: true }`.
  - `deploy/mcp-auth/compose.yaml` (lines 24, 40–43): Passes `MCP_OAUTH_DATABASE_TLS_CA_FILE: /etc/ssl/yulan-internal-ca.pem` and mounts it `read_only: true`.
  - `BOX-WINDOW.md` (lines 830–897, step `hm6-prove-runtime-database`): Executes a pre-flight probe confirming `socket.encrypted === true`, `socket.authorized === true`, and `checkServerIdentity('db.commonswarm.internal', cert) === undefined`.

### 2.5 Database Least Privileges
- **Finding:** The runtime database role `commonswarm_oauth_runtime` is strictly constrained to minimum necessary table privileges and function execution rights.
- **Verification:**
  - `supabase/migrations/20260928000003_hm_oauth_store.sql` (lines 6–53, 173–182, 234–235): Role created with `LOGIN NOINHERIT NOCREATEDB NOCREATEROLE`. `USAGE` granted on schema `commonswarm_oauth`. No access to `swarm` schema. `SELECT, INSERT, UPDATE, DELETE` granted on application tables except `refresh_family_tombstones` (`SELECT, INSERT` only).
  - `BOX-WINDOW.md` (lines 628–703, step `hm6-check-runtime-privileges`): Automates a detailed SQL check verifying table privilege bits, schema isolation, role attributes, and function execute rights.

### 2.6 Dark Service & Ingress Routing
- **Finding:** Public authorization and `/mcp` remain disabled (dark) and exposed routes proxy exclusively to the designated loopback port.
- **Verification:**
  - `services/mcp-auth/src/server.js` (lines 56–59): Rejects all non-discovery/health requests with `503 authorization_service_disabled` when `publicAuthorizationEnabled` is false.
  - `deploy/supabase-stack/commonswarm-mcp.caddy` (lines 11–92, 157–161): Exposes only health, discovery, JWKS, and OAuth endpoints to `127.0.0.1:{$MCP_OAUTH_HOST_PORT}`. `/mcp` returns `503 feature_disabled`.

### 2.7 GoTrue URI Allowlist
- **Finding:** GoTrue URI allowlist entries are appended, preserving existing entries.
- **Verification:**
  - `BOX-WINDOW.md` (lines 948–960): Explicitly mandates appending `https://mcp.commonswarm.com/oauth/callback/gotrue` to `GOTRUE_URI_ALLOW_LIST` while preserving all existing live entries.

### 2.8 Minted Principal Uniqueness
- **Finding:** Service accounts and signing key identifiers use unique timestamp-derived suffixes and check for prior existence.
- **Verification:**
  - `BOX-WINDOW.md` (lines 368–375, step `hm6-create-oauth-release`): Mints `cs-oauth-${WINDOW_PRINCIPAL_SUFFIX}` and checks `getent passwd` / `getent group` to fail on any name collision.

### 2.9 Execution Safety Guardrails
- **Finding:** Script blocks adhere to execution safety rules (no `HOME=` assignments, no unvalidated `rm -rf` commands, no `docker run` on the Mac mini).
- **Verification:**
  - All 19 executable shell blocks in `BOX-WINDOW.md` were inspected. No block assigns `HOME`, uses `rm -rf` on unvalidated variables, or executes `docker run` on the Mac mini host.

### 2.10 Rollback Integrity
- **Finding:** Rollback procedures restore prior Caddy configurations and GoTrue allowlists, and retire/restrict key files.
- **Verification:**
  - `BOX-WINDOW.md` (lines 1299–1308, 1394–1397): Specifies restoring prior Caddy site files, reverting GoTrue allowlists, terminating container execution, and restricting unused key files to `root`-only access.

---

## 3. Findings List

### KEEP (Production-Blocking Security Defects)
None.

### NITS (Style & Minor Documentation Observations)
- `deploy/mcp-auth/RUNBOOK.md` and `deploy/mcp-auth/VERIFICATION.md` reference `/etc/commonswarm-oauth/yulan-internal-ca.pem` in prose, whereas the authoritative Compose specification (`deploy/mcp-auth/compose.yaml#L24`) and plan (`BOX-WINDOW.md#L108`) standardly use `/etc/ssl/yulan-internal-ca.pem`. The plan correctly resolves this to `/etc/ssl/yulan-internal-ca.pem`.

---

VERDICT: PASS (no KEEP)