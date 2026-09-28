# Security Review Report: CommonSwarm HM Lanes 3 and 7 (v2 Dark Box Window Plan)

This security review evaluates the production release plan `BOX-WINDOW.md` (v2) at release SHA `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d` for CommonSwarm HM lanes 3 and 7 (durable hosted check batches and dark hosted MCP worker). The evaluation strictly checks for production-blocking security defects across all 9 specified categories against both the plan text in `local path` and the authority codebase.

---

## Findings by Category

### 1. Gate Configuration & Dark Route Enforcement
- **Release Plan Verification**:
  - In `local path`, the plan explicitly requires `SWARM_MCP_PUBLIC_ENABLED` to remain unset.
  - `local path` states: *"Do not set `SWARM_MCP_PUBLIC_ENABLED=1`. Preserve disabled public OAuth authorization."*
  - `local path` confirms `SWARM_MCP_PUBLIC_ENABLED` is optional and must be left absent or disabled.
  - Pre-switch prerequisites (`local path`), post-switch checks (`local path`), and closure rules (`local path`) all enforce that effective `SWARM_MCP_PUBLIC_ENABLED` is not `1`.
- **Codebase Enforcement**:
  - In [router.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/edge-runtime/main/router.ts#L38-L44), `DISABLED_FUNCTION_NAMES` includes `"mcp"`.
  - In [router.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/edge-runtime/main/router.ts#L160-L161), `resolveGatewayRequest()` evaluates `isFunctionDisabled(route.functionName, mcpPublicEnabled)` *before* checking preflight `OPTIONS` or invoking `invokeWorker`. When disabled, it returns `functionDisabledResponse()` (`503` status with `{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}`).
  - In [protocol.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/supabase/functions/mcp/protocol.ts#L192-L198), the worker handler independently returns HTTP `503` if `!options.publicEnabled`.
- **Probe Matrix Verification**:
  - Section 8 (`local path`) probes `POST /functions/v1/mcp`, `OPTIONS /functions/v1/mcp`, and `GET /functions/v1/mcp/.well-known/oauth-protected-resource/mcp`, asserting `503` and exact JSON. The test script (`local path`) fails if any response status or body differs.

### 2. Check Batch Opening & Acknowledgment Security
- **Codebase Enforcement**:
  - In [hosted-authority.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/src/protocol/hosted-authority.ts#L14-L21), `PUBLIC_HOSTED_ONLY_COMMANDS` includes `open_hosted_mcp_check_batch` and `ack_hosted_mcp_check_batch`.
  - In [command/index.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/supabase/functions/command/index.ts#L12940-L12956), public HTTP entry point `handlePostRequest` rejects any payload with these command kinds with HTTP `403 forbidden` before bearer authentication or GoTrue processing.
  - In [command/index.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/supabase/functions/command/index.ts#L13255-L13270), `handleHostedCheck` authorizes ACK requests against locked DB rows requiring `batch_id`, `seat_id`, `grant_id`, `workspace_id`, and `principal_id` to match the validated capability. Cross-seat batch ACK attempts return `403 hosted_check_batch_forbidden`.
- **Plan Controls**:
  - Section 8 (`local path`) requires unauthenticated public open/ACK probes and verifies cursor/batch state remains unchanged.
  - Section 9 Step 6 (`local path`) and Step 9 (`local path`) mandate checking unauthenticated refusals and cross-seat / upper-case UUID ACK semantics.

### 3. Public Hosted Command Pre-Auth Boundary
- In [command/index.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/supabase/functions/command/index.ts#L12954-L12956), public hosted commands are blocked immediately upon body parsing.
- Section 8 probe script `hm37-public-boundaries` (`local path`) dynamically parses `PUBLIC_HOSTED_ONLY_COMMANDS` from source and verifies that unauthenticated POST requests for all 6 command kinds return `403 forbidden`.

### 4. Principal and Token Revocation at Closure
- In `local path`, the plan outlines a mandatory cleanup sequence revoking temporary hosted seats, CommonSwarm grants, OAuth provider grants, and all ordinary principals created during testing.
- Section 10 (`local path`) and Section 12 (`local path`, `L856`) require verifying zero active unexpired agent tokens remain before closure.

### 5. Credential Handling & Secret Disclosure
- `local path` forbids putting any credential value in argv, URLs, process output, or evidence.
- In `hm37-validate-local-credential` (`local path`), credential validation reads only `agent_token`, `principal_id`, `token_id`, and `run_id`, and raises `SystemExit` (fails closed) if any required string field is missing or empty.
- `local path` explicitly excludes `window.env`, cleanup journals, credentials, profiles, connection files, environments, password files, and dumps from evidence copy-back.

### 6. Shell & Command Safety
- No step assigns or exports `HOME`.
- In `hm37-public-boundaries` (`local path`), `PROBE="$(mktemp /tmp/hm37-boundaries.XXXXXX)"` is cleaned up via `trap 'rm -f -- "$PROBE"' EXIT`. `rm -rf` is not used.
- Docker execution (`local path`, `L728`) occurs exclusively over SSH on the remote production box (`ops@100.115.66.74` as root/commonswarm). No Docker command is run on the Mac mini.

### 7. Rollback Safety
- Section 11 (`local path`) requires edge rollback to precede SQL migration reversal.
- Edge rollback restores `PREVIOUS_EDGE` (`72c57e0d76d0aa86fe4f811a2cf51499919fed20`), which does not contain the `supabase/functions/mcp` worker directory or router definition, preventing any worker exposure during or after rollback.

---

## NITS (Non-Blocking Advisory Notes)

- **Nit 1**: In `hm37-public-boundaries` (`local path`), the trap uses `rm -f -- "$PROBE"`. This is fully safe as `$PROBE` is resolved directly from `mktemp` in the same block.

---

VERDICT: PASS (no KEEP)