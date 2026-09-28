I have completed a thorough security review of the production release plan in [`prompt.md`](local path) (`BOX-WINDOW.md` v4 for CommonSwarm HM lanes 3 and 7, DARK at release SHA `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`).

Below is the detailed evaluation of each production-blocking security requirement (KEEP categories) and style observations (NITS), grounded with concrete file and line citations.

---

### Security Audit Findings

#### 1. Public MCP Flag Protection (`SWARM_MCP_PUBLIC_ENABLED`)
* **Requirement**: Any step that sets or could set `SWARM_MCP_PUBLIC_ENABLED` must be flagged.
* **Findings**:
  * [`prompt.md#L57`](local path): `Do not set SWARM_MCP_PUBLIC_ENABLED=1. Preserve disabled public OAuth authorization.`
  * [`prompt.md#L212`](local path): `The example adds exactly one assignment name relative to the previous edge: SWARM_MCP_PUBLIC_ENABLED. It is optional; only the exact string 1 enables MCP.`
  * [`prompt.md#L488`](local path): `4. Effective edge SWARM_MCP_PUBLIC_ENABLED is not exactly 1.`
  * [`prompt.md#L721`](local path): `6. Privately inspect effective Compose/container configuration; assert MCP remains disabled.`
  * [`deploy/edge-runtime/main/router.ts#L114-L116`](local path): `export function isMcpPublicEnabled(value: string | undefined): boolean { return value === "1"; }`
* **Status**: **PASS**. The flag is explicitly kept unset throughout the entire plan, and environment configuration checks verify it is not `1`.

---

#### 2. Dark Gate, 503 `feature_disabled` Response & Worker Creation Controls
* **Requirement**: Controls must fail if `/mcp`, `OPTIONS /mcp`, or protected-resource metadata paths respond with anything other than `503 feature_disabled`, or if a worker isolate is spawned.
* **Findings**:
  * [`deploy/edge-runtime/main/router.ts#L38-L44`](local path): `export const DISABLED_FUNCTION_NAMES = ["mcp"] as const satisfies readonly FunctionName[]; export const FUNCTION_DISABLED_BODY = { error: "feature_disabled", feature: "hosted_mcp", message: "Hosted MCP is not available yet." } as const; export const FUNCTION_DISABLED_STATUS = 503;`
  * [`deploy/edge-runtime/main/router.ts#L160-L162`](local path): Router intercepts dark routes before preflight or worker creation: `if (isFunctionDisabled(route.functionName, mcpPublicEnabled)) { return { route: null, response: functionDisabledResponse() }; }`
  * [`prompt.md#L709-L710`](local path): `The exact-tree instrumented test in tests/p1-cli/edge-runtime-box.test.ts... explicitly covers both suffixes and seven methods: GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. It requires zero disabled worker calls and enabled positive controls.`
  * [`prompt.md#L824-L851`](local path) & [`prompt.md#L900-L902`](local path): Python probe script verifies 503 and exact JSON payload across all 7 HTTP methods.
* **Status**: **PASS**. Dark gate checks enforce 503 `feature_disabled` for all HTTP methods (including OPTIONS and HEAD) before worker creation.

---

#### 3. Unauthenticated and Cross-Seat Check Batch Protection
* **Requirement**: Unauthenticated or cross-seat requests to open or ACK a check batch must be blocked and caught by plan controls.
* **Findings**:
  * [`src/protocol/hosted-authority.ts#L14-L21`](local path): `PUBLIC_HOSTED_ONLY_COMMANDS` includes `'open_hosted_mcp_check_batch'` and `'ack_hosted_mcp_check_batch'`.
  * [`supabase/functions/command/index.ts#L12941-L12956`](local path): `handlePostRequest` refuses public hosted commands with `403 {"error":"forbidden"}` prior to bearer auth or GoTrue.
  * [`supabase/functions/command/index.ts#L13255-L13271`](local path): `handleHostedCheck` verifies that requested ACK batches strictly match `seat_id`, `grant_id`, `workspace_id`, and `principal_id` for the authenticated seat capability, returning `403 {"error":"hosted_check_batch_forbidden"}` on mismatch.
  * [`prompt.md#L860-L863`](local path): `probe(base, "POST", "/functions/v1/command", {"command_id": str(uuid.uuid4()), "command": {"kind": kind}}, 403, {"error": "forbidden"})`
  * [`prompt.md#L961`](local path): `6. Send unauthenticated public open and ACK. Both 403; cursor/batch snapshot unchanged.`
* **Status**: **PASS**. Both unauthenticated public access and cross-seat batch access are refused with 403 status and validated in plan controls.

---

#### 4. Public Hosted Command Boundary
* **Requirement**: Public hosted commands must not be reachable before bearer auth.
* **Findings**:
  * [`supabase/functions/command/index.ts#L12953-L12956`](local path): `// This check deliberately precedes bearer classification and GoTrue. Public HTTP input cannot opt into an internal hosted capability by naming one. if (publicHostedClaim || bodyClaimsHostedContext || headerClaimsHostedContext) { return json(403, { error: "forbidden" }); }`
  * [`prompt.md#L51-L52`](local path) & [`prompt.md#L779-L781`](local path): Plan requires public hosted-only commands to refuse unauthenticated calls with 403 forbidden prior to command validation or bearer classification.
* **Status**: **PASS**. Public hosted commands are intercepted and refused before bearer authentication.

---

#### 5. Principal Cleanup and Unexpired Token Verification
* **Requirement**: No temporary principal or live token may remain active at window closure.
* **Findings**:
  * [`prompt.md#L970-L980`](local path): Finally-path cleanup specifies revoking hosted seats, grants, provider families, and local principals, and requires verifying zero active unexpired tokens.
  * [`prompt.md#L1046`](local path): `8. Revoke both ordinary principals and verify zero active unexpired tokens.`
  * [`prompt.md#L1204`](local path) & [`prompt.md#L1224`](local path): Closure verification explicitly requires readback confirming zero active unexpired tokens.
* **Status**: **PASS**. Closure protocol enforces full revocation and zero active unexpired token readback.

---

#### 6. Secret & Token Confidentiality
* **Requirement**: Secrets or tokens must not be printed, echoed, passed via argv, placed in URLs, or saved in evidence files.
* **Findings**:
  * [`prompt.md#L65`](local path): `do not use an interactive op session, expose a value in argv or an environment variable, or print the file.`
  * [`prompt.md#L589`](local path): `Secrets belong only in protected files and process memory. No credential value belongs in argv, URLs, shell environment values, output or evidence.`
  * [`prompt.md#L967`](local path): `Never retain tokens, seat handles, credentials or signal bodies in copied evidence.`
  * [`prompt.md#L1174`](local path): `hm37-hosted-control-inputs.txt records the accepted harness identity/checksum, invocation, runtime and review acceptance, never protected inputs.`
  * [`prompt.md#L1196`](local path): `Never copy window state, private cleanup journals, credentials, profiles, connection files, complete environments, database session helpers, password files or dumps.`
* **Status**: **PASS**. Strict confidentiality rules prevent secrets from appearing in stdout, argv, URLs, or evidence output.

---

#### 7. Credential Reading Contract & Fail-Closed Behavior
* **Requirement**: Credential reading must only accept `agent_token`, `principal_id`, `token_id`, `run_id`, and fail closed on invalid/missing fields.
* **Findings**:
  * [`prompt.md#L590-L591`](local path): `Read cswarm credentials using agent_token, principal_id, token_id, run_id. Connection creation and cleanup readers must reject every missing, empty or non-string field. Never substitute a guessed token field.`
  * [`prompt.md#L1007-L1027`](local path): Script helper enforces exact non-empty string and UUID validation for all 4 required fields, exiting immediately with error on failure.
* **Status**: **PASS**. Credential field validation strictly follows the required 4-field schema and fails closed.

---

#### 8. Shell and Script Execution Safety
* **Requirement**: Must not assign `HOME`, perform `rm -rf` on variables/paths not created by `mktemp` in the same block, or execute Docker on the Mac mini.
* **Findings**:
  * **HOME assignment**: No block assigns `HOME` (e.g. `HOME=...` or `export HOME=...`). Only `$HOME` parameter expansion is used (e.g. [`prompt.md#L565`](local path)).
  * **rm -rf usage**: [`prompt.md#L65`](local path) notes `No recursive deletion is required.` Cleanup scripts use safe temporary files via `mktemp` and `rm -f -- "$PROBE"` (e.g. [`prompt.md#L786-L788`](local path)).
  * **Mac mini Docker execution**: Mac mini steps ([`prompt.md#L130`](local path), [`prompt.md#L559`](local path), [`prompt.md#L783`](local path), [`prompt.md#L996`](local path)) run only `git`, `python3`, and `ssh`. Docker commands execute exclusively on the remote VPS host.
* **Status**: **PASS**. Execution constraints conform to safe script guidelines.

---

#### 9. Edge Rollback Routability
* **Requirement**: Edge rollback must not leave the new worker routable.
* **Findings**:
  * [`prompt.md#L1052-L1064`](local path): Edge rollback restores `PREVIOUS_EDGE` (`72c57e0d76d0aa86fe4f811a2cf51499919fed20`), recreates the container from that exact directory on `commonswarm-net`, and verifies health and darkness.
  * The previous edge SHA `72c57e0d` does not contain the `mcp` worker code or router entries, ensuring the worker is completely unroutable post-rollback.
* **Status**: **PASS**. Edge rollback restores the baseline edge release tree, completely eliminating worker routes.

---

#### 10. Non-Interactive 1Password Method
* **Requirement**: 1Password access must use Anvil's non-interactive service-account file-based method, not interactive sessions.
* **Findings**:
  * [`prompt.md#L65`](local path): `Any 1Password read uses Anvil's service-account method on the Mac mini, writes each value directly to a separate mode-0600 file in the private window directory, and transfers it through Anvil's established secure file workflow. Anvil's shell is not interactively signed in; do not use an interactive op session...`
* **Status**: **PASS**. Service-account file-based method is explicitly mandated.

---

#### 11. Container Log Permissions & Handling
* **Requirement**: Saved container logs must be mode `0600` and must not be printed.
* **Findings**:
  * [`prompt.md#L730-L732`](local path) & [`prompt.md#L1058`](local path): Preserves outgoing logs in root-owned mode `0600` proof files bounded to 10 MiB.
  * [`prompt.md#L1191-L1194`](local path): Log copy-back validates root ownership, mode `0600`, and 10 MiB bounds, requiring private review prior to transfer without printing contents.
* **Status**: **PASS**. Container logs are restricted to mode `0600`, bounded in size, and kept private.

---

#### 12. Caddy Configuration Immutability
* **Requirement**: The window must not modify any Caddy file.
* **Findings**:
  * [`prompt.md#L55-L61`](local path): `Caddy: No installation, edit, validation-triggered rollout or reload in this window. This window sets API_CADDY_PAIR=no and MCP_CADDY_RELEASE=no, does not execute runbook steps runbook-56 through runbook-59 or any runbook-mcp-caddy-* step, and performs no Caddy install, edit, log-file preparation, validation-triggered rollout or reload.`
  * [`prompt.md#L1067`](local path): `Do not change Caddy.`
  * [`prompt.md#L1219`](local path): `No Caddy change occurred in this window.`
* **Status**: **PASS**. Caddy files remain completely untouched and un-reloaded.

---

### Nits & Observations

* **Informational**:
  * [`prompt.md#L27-L28`](local path) & [`prompt.md#L133-L137`](local path): The required HM6 stack release (`ad964ed1`) and OAuth release (`826db6a3`) are verified as local ancestors of the target release commit (`eb2a87ac`).
  * [`prompt.md#L837-L843`](local path): Boundary probe script explicitly handles HTTP `HEAD` method semantics (asserting HTTP 503 status, `application/json` content-type, and empty body `raw == b""`), accurately accounting for HTTP specification differences.

---

VERDICT: PASS (no KEEP)