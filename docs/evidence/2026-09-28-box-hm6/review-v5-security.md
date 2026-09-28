# Security Review Analysis: HM Lane 6 Production Continuation Plan (v5)

**Target Release SHA**: `826db6a34f235064a3a03c57377d8e32a35d2f05`
**Target Surface**: CommonSwarm HM Lane 6 (OAuth 2.1 Authorization Service, DARK)
**Plan Document**: `boxplan-hm6-v5.md` (lines 27–2182 in [prompt.md](local path))

---

## 1. Executive Summary & Verification Findings

A comprehensive security audit of `boxplan-hm6-v5.md` was conducted against all workspace policies, `AGENTS.md` rules, and the 17 specified `KEEP` blocking criteria.

All security invariants, secret handling requirements, container configurations, file permission boundaries, database TLS checks, ingress rules, rollback steps, and v5-specific conditions have been verified. No blocking `KEEP` violations were identified.

---

## 2. Detailed Audit of Blocking KEEP Criteria

### 1. Secret Exposure Prevention
- **Requirement**: No secret (signing key, cookie keys, database password, Cloudflare DNS token, service key) appears in `argv`, process environment variables, URLs, outputs, logs, evidence files, or `copy-back.list`.
- **Findings**:
  - Vault item readbacks in `hm6-verify-vault-secret-readback` ([prompt.md#L1040-L1064](local path)) use `op read ... --out-file "$SECRET_STAGE/..."` directly to disk without printing or passing secrets via `argv`/`env`. Identity checks use `cmp -s` and output only non-secret boolean status strings.
  - The Cloudflare DNS edit token in `hm6-create-and-read-back-dns` ([prompt.md#L1451-L1479](local path)) is read directly to `$DNS_TMP/dns-token` and written to a mode `0600` `curl.conf` header config (`header = "Authorization: Bearer <token>"`). `curl` is invoked via `-q --config "$DNS_TMP/curl.conf"`, keeping the token completely absent from command arguments and shell logs.
  - Secret file policy enforcement in `config.js` ([config.js#L46-L108](local path)) reads credentials directly from protected file descriptors inside the container. Passwords are never placed in shell environment variables or command lines.
  - `copy-back.list` sanitation in `hm6-finalize-copy-back-list` ([prompt.md#L2053-L2061](local path)) explicitly excludes `window.env`, secret files, database dumps, and log outputs.

### 2. File Ownership, Permissions, and Mount Boundaries
- **Requirement**: Keys and credential files must have mode `0640` or `0600`, correct owner/group (`root:986` / `root:root`), and be mounted read-only (`:ro`).
- **Findings**:
  - `/etc/commonswarm-oauth/signing-keys.pem`, `cookie-keys`, and `database-credentials` retain owner `root:cs-oauth-080406` (`root:986`) and mode `0640` ([prompt.md#L509-L520](local path)).
  - Service environment files (`service.env`, `compose.env`) retain owner `root:root` and mode `0600`.
  - In `deploy/mcp-auth/compose.yaml` ([compose.yaml#L27-L43](local path)), all volume mounts (`signing-keys.pem`, `cookie-keys`, `database-credentials`, `yulan-internal-ca.pem`) are configured with `read_only: true`.

### 3. 1Password Service Account Method
- **Requirement**: 1Password reads must use Anvil's service-account, file-based method (`op read ... --out-file`).
- **Findings**:
  - `hm6-verify-vault-secret-readback` ([prompt.md#L1040-L1044](local path)) and `hm6-create-and-read-back-dns` ([prompt.md#L1451](local path)) execute `op read "$REF" --out-file "$TMP_FILE"` exclusively on the Mac mini under Anvil's environment. No interactive auth or raw stdout secret printing is present.

### 4. Container Security Hardening
- **Requirement**: Container must run as non-root with no extra capabilities.
- **Findings**:
  - `deploy/mcp-auth/compose.yaml` specifies `user: "996:986"` ([compose.yaml#L8](local path)), `read_only: true` ([compose.yaml#L9](local path)), `cap_drop: [ALL]` ([compose.yaml#L50](local path)), and `security_opt: ["no-new-privileges:true"]` ([compose.yaml#L53](local path)).
  - Step `hm6-start-dark-service` ([prompt.md#L1255-L1256](local path)) executes an in-container check verifying `process.getuid() !== 0` and `process.getgid() !== 0`.

### 5. Database TLS & Hostname Verification
- **Requirement**: DB TLS connection enforces both CA certificate and hostname verification.
- **Findings**:
  - `config.js` ([config.js#L196-L203](local path)) sets `ssl: { ca: tlsCa, rejectUnauthorized: true }`.
  - In-container test `hm6-prove-runtime-database` ([prompt.md#L1195-L1202](local path)) verifies `socket.encrypted === true`, `socket.authorized === true`, and calls `checkServerIdentity(host, cert)` to validate the SANs (`db.commonswarm.internal`).

### 6. Database Least Privileges
- **Requirement**: Runtime role `commonswarm_oauth_runtime` must possess strictly reviewed least privileges.
- **Findings**:
  - Step `hm6-prove-runtime-privileges` ([prompt.md#L926-L994](local path)) verifies table permissions (5 tables get `SELECT, INSERT, UPDATE, DELETE`; `refresh_family_tombstones` gets `SELECT, INSERT`), verifies RLS enabled, verifies exactly 1 function (`resolve_hosted_grant_status`) is executable, and ensures `commonswarm_oauth_runtime` owns no database objects, has no inheritance/member escalation, and holds no privileges on the `swarm` schema.

### 7. Dark Service Isolation
- **Requirement**: Public authorization and `/mcp` endpoints remain dark/unreachable.
- **Findings**:
  - Environment variables set `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0` and `MCP_OAUTH_NATIVE_LOOPBACK_ENABLED=0`.
  - Caddy configuration `commonswarm-mcp.caddy` ([commonswarm-mcp.caddy#L176-L180](local path)) leaves `mcp_resource_active` unimported and returns `503 feature_disabled` for `/mcp` and `/.well-known/oauth-protected-resource/mcp`.
  - Service returns `503 authorization_service_disabled` for `/authorize`, `/token`, and `/interaction/*`.

### 8. Ingress Route Strictness
- **Requirement**: Caddy and Cloudflare must not expose routes unhandled by the underlying service.
- **Findings**:
  - `commonswarm-mcp.caddy` ([commonswarm-mcp.caddy#L182-L191](local path)) routes only explicit OAuth endpoints (`/health`, metadata, `/authorize`, `/token`, `/interaction/*`, `/oauth/callback/gotrue`). Unhandled paths return `404 not_found`, and wrong HTTP methods return `405 method_not_allowed`.

### 9. GoTrue Callback Append
- **Requirement**: GoTrue allowlist must be appended, not replaced.
- **Findings**:
  - Step `hm6-append-gotrue-callback` ([prompt.md#L1307-L1350](local path)) parses `GOTRUE_URI_ALLOW_LIST`, appends `https://mcp.commonswarm.com/oauth/callback/gotrue`, verifies all existing entries are preserved, and writes changes atomically.

### 10. Caddy Access Log Safety
- **Requirement**: Log path must resolve inside `/var/log/caddy/` and avoid creation by root `caddy validate`.
- **Findings**:
  - Step `hm6-install-reviewed-caddy` ([prompt.md#L1624-L1663](local path)) resolves the log path (`/var/log/caddy/mcp.commonswarm.com.access.log`), creates/chowns the file as `caddy:caddy` mode `0600`, runs validation as unprivileged `caddy` user (`runuser -u caddy -- caddy validate ...`), and verifies metadata afterwards.

### 11 & 16. Browser Integrity Check & Non-Browser Dual-Probe Ingress Gate
- **Requirement**: Ingress test cannot pass unless BOTH `curl` (custom UA) and Python `urllib` (default UA) pass without working around BIC or using direct origin bypasses.
- **Findings**:
  - Step `hm6-probe-nonbrowser-ingress` ([prompt.md#L1768-L1790](local path)) runs all probe checks across `('curl', 'urllib-default')`.
  - `passed = all(item['pass'] for item in results)` requires 100% pass across both clients. Any failure or Cloudflare block (403, error 1010, HTML page) triggers `if not passed: raise SystemExit('STOP: non-browser ingress failed...')`.
  - `urllib` uses `urllib.request`'s default User-Agent and `NoRedirect` handler ([prompt.md#L1696-L1698](local path)) without UA spoofing.

### 12. Command Safety Invariants
- **Requirement**: No `HOME` assignments, no unsafe `rm -rf` on unvalidated variables, and no `docker` usage on the Mac mini.
- **Findings**:
  - Zero `HOME=` assignments exist across all steps.
  - All `rm -rf` commands target checked, absolute temporary directories generated in the same script block via `mktemp -d` (e.g. `$SECRET_STAGE`, `$DNS_TMP`, `$POLICY_TMP`).
  - Mac mini script blocks (`hm6-transfer-continuation-archive`, `hm6-verify-vault-secret-readback`, `hm6-create-and-read-back-dns`, `hm6-probe-nonbrowser-ingress`, `hm6-probe-after-restart`) contain zero `docker` invocations.

### 13. State-Aware Clean Rollback
- **Requirement**: Rollback must cleanly remove created routes, DNS records, GoTrue allowlist additions, and container processes.
- **Findings**:
  - Section "Rollback and abort" ([prompt.md#L2033-L2137](local path)) defines a strict reverse teardown:
    1. Stop/remove container.
    2. Remove Caddy site file `/etc/caddy/sites/20-commonswarm-mcp.caddy` and reload Caddy.
    3. Delete specific DNS record by `record_id` via Cloudflare API.
    4. Restore `/home/commonswarm/.env` from backup copy `.env.hm6-${WINDOW_PRINCIPAL_SUFFIX}` and recreate GoTrue.
    5. Remove `/home/commonswarm/oauth/current` symlink.

### 14. Mac Mini Secret Staging Traps (v5 Specific)
- **Requirement**: Secret files on Mac mini staged in checked `local path` directory and removed on every exit path via traps.
- **Findings**:
  - Both `hm6-verify-vault-secret-readback` ([prompt.md#L1028-L1042](local path)) and `hm6-create-and-read-back-dns` ([prompt.md#L1436-L1450](local path)) validate `mktemp -d local path`, enforce mode `0700` / `umask 077`, and attach `cleanup_*` functions to `trap ... EXIT` and `trap ... HUP INT TERM`.

### 15. BIC Precondition Isolation (v5 Specific)
- **Requirement**: BIC precondition reads HezLead's confirmation reference without dashboard automation.
- **Findings**:
  - Step `hm6-verify-bic-decision` ([prompt.md#L1548-L1564](local path)) reads `BIC_DECISION_REFERENCE` from `window.env` and writes `bic-decision.txt` with `dashboard_automation=none`. No API calls or automated changes are made to Cloudflare BIC.

### 17. JWKS Content-Type Validation (v5 Specific)
- **Requirement**: `/jwks` probe accepts only `application/jwk-set+json` or `application/json`.
- **Findings**:
  - In `hm6-probe-nonbrowser-ingress` ([prompt.md#L1745-L1748](local path)) and `hm6-probe-after-restart` ([prompt.md#L1892-L1895](local path)):
    ```python
    media_type = content_type.split(';', 1)[0].strip().lower()
    if path == '/jwks':
        assert media_type in {'application/jwk-set+json', 'application/json'}
    else:
        assert media_type == 'application/json'
    ```

---

## 3. Style Nits

1. **Explicit Subshell Error Handling**: In `hm6-probe-nonbrowser-ingress` ([prompt.md#L1770-L1780](local path)), catching generic `Exception` cleanly catches transport and assertion failures into the `results` structure. Adding a brief log of the specific underlying exception type to stdout when `result['pass']` is `False` can assist rapid debugging during HezLead triage.

---

VERDICT: PASS (no KEEP)