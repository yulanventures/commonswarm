I have completed the read-only security review of the production release plan `boxplan-hm6-v3-final.md` (CommonSwarm HM lane 6, SHA `ad964ed158181ba1692dd05895f36fa7a1f87d3f`) and its corresponding codebase artifacts.

---

### Security Review Findings

#### 1. Secret Handling and Protection
- **Secrets Storage & Delivery**: Signing keys, cookie keys, and database credentials are stored in `/etc/commonswarm-oauth/` as root-owned files with mode `0640` [`prompt.md#L873-L874`]. Compose mounts these files into `/run/commonswarm-oauth/` with `read_only: true` [`deploy/mcp-auth/compose.yaml#L28-L43`].
- **Environment & Evidence Isolation**: Service environment settings are placed in `/etc/commonswarm-oauth/service.env` with root-only mode `0600` [`prompt.md#L878`]. Secret files, `window.env`, database dumps, and credentials are explicitly excluded from `ITEM_COPY_BACK_FILES` [`prompt.md#L287-L288`].
- **Cloudflare DNS Token Security**: The Cloudflare DNS API token is read directly via `op read` into Python stdin and written exclusively to a temporary mode `0600` `curl.conf` file [`prompt.md#L1113-L1123`]. It is never exposed in process arguments, environment variables, URLs, or output [`prompt.md#L1132`, `prompt.md#L1144`].

#### 2. Container Security & Capabilities
- **Unprivileged Execution**: The container runs under unprivileged UID/GID `996:986` (`cs-oauth-080406`) [`deploy/mcp-auth/compose.yaml#L8`, `prompt.md#L1000-L1001`]. The Dockerfile explicitly sets `USER 10001:10001` [`services/mcp-auth/Dockerfile#L11`].
- **Hardening Flags**: `read_only: true` is enforced [`deploy/mcp-auth/compose.yaml#L9`], all Linux capabilities are dropped (`cap_drop: - ALL`) [`deploy/mcp-auth/compose.yaml#L50-L51`], and `no-new-privileges:true` is set [`deploy/mcp-auth/compose.yaml#L52-L53`].

#### 3. Database TLS & Hostname Verification
- **TLS Configuration**: The node-postgres driver configuration sets `ssl: { ca: tlsCa, rejectUnauthorized: true }` [`services/mcp-auth/src/config.js#L125`]. The CA file is loaded strictly from `/etc/ssl/yulan-internal-ca.pem` [`services/mcp-auth/src/config.js#L86`].
- **Runtime Hostname Assertion**: The database preflight assertion validates TLS handshake authorization and verifies the certificate SANs against `db.commonswarm.internal` [`prompt.md#L936-L947`].

#### 4. Least-Privilege Database Role & Permissions
- **Role Isolation**: The `commonswarm_oauth_runtime` role is created with `LOGIN NOINHERIT NOCREATEDB NOCREATEROLE` and `createrole_self_grant = ''` [`supabase/migrations/20260928000003_hm_oauth_store.sql#L16-L18`].
- **Schema & Table Access**: `REVOKE ALL ON SCHEMA swarm FROM commonswarm_oauth_runtime` is enforced [`supabase/migrations/20260928000003_hm_oauth_store.sql#L109`]. Tables are granted strictly necessary DML permissions [`supabase/migrations/20260928000003_hm_oauth_store.sql#L231-L239`].
- **Function Executions**: Function execution permissions are restricted; `commonswarm_oauth_runtime` can execute only `resolve_hosted_grant_status` [`supabase/migrations/20260928000003_hm_oauth_store.sql#L291-L292`]. `hosted_grant_is_active` and `provider_family_active` are explicitly revoked from the runtime role [`supabase/migrations/20260928000003_hm_oauth_store.sql#L257-L258`, `supabase/migrations/20260928000003_hm_oauth_store.sql#L310-L311`].
- **Verification Assertions**: The privilege verification block checks every privilege and default ACL setting individually [`prompt.md#L782-L850`].

#### 5. Dark State & Ingress Isolation
- **Service Inactive Flag**: `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0` keeps public authorization disabled, returning HTTP 503 `authorization_service_disabled` [`prompt.md#L881`, `services/mcp-auth/src/config.js#L104`].
- **Caddy Ingress & Loopback Binding**: Caddy proxies traffic strictly to the loopback port `127.0.0.1:{$MCP_OAUTH_HOST_PORT}` [`deploy/supabase-stack/commonswarm-mcp.caddy#L11`]. `/mcp` endpoints return HTTP 503 `feature_disabled` directly at Caddy [`deploy/supabase-stack/commonswarm-mcp.caddy#L157-L162`].
- **GoTrue Allow List**: The GoTrue allow list is appended cleanly without replacing pre-existing callback URLs [`prompt.md#L1024-L1028`].

#### 6. Retry Leftovers & Pre-execution Guardrails
- **Preflight Leftovers Inspection**: Step `hm6-verify-retry-leftovers` verifies the existing OS user `cs-oauth-080406` (UID 996, GID 986, shell `/usr/sbin/nologin`, home `/nonexistent`, 0 processes running), the empty config directory `/etc/commonswarm-oauth`, the historical release directory, and the local image hash before proceeding [`prompt.md#L370-L430`].
- **Non-Browser UA & Cloudflare BIC Compliance**: Step `hm6-probe-nonbrowser-ingress` tests both `curl` (`claude-connector-test/1.0`) and default `urllib` [`prompt.md#L1298-L1385`]. If Cloudflare BIC or security controls block non-browser traffic (returning HTML or HTTP 1010), the step halts execution for HezLead and Tom without attempting UA spoofing or origin bypass [`prompt.md#L1381-L1393`].

#### 7. Script Execution Safety
- **Path and Tool Safety**: No shell scripts assign `HOME`. Directory cleanup inside the DNS step uses `rm -f "$DNS_TMP/curl.conf"` and `rmdir "$DNS_TMP"` on a verified, freshly created `mktemp -d` directory [`prompt.md#L1107-L1110`]. No `docker run` commands execute on the Mac mini.

---

### Nits
1. `deploy/mcp-auth/compose.yaml#L7`: The image tag uses `${MCP_OAUTH_IMAGE:...}` variable substitution derived from the runtime image build step [`prompt.md#L718`]. This is standard for this deployment workflow.

---

VERDICT: PASS (no KEEP)