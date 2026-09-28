# Security Review: CommonSwarm HM Lanes 3 & 7 (DARK Box Window v3)

**Target Plan File:** [`prompt.md`](local path) (Attached [`boxplan-hm37-v3-final.md`](local path))
**Release SHA:** `e7bb7a46b24e7bc794234416d43605bca52b55d4`
**Previous Edge:** `72c57e0d76d0aa86fe4f811a2cf51499919fed20`
**Mode:** READ-ONLY Consult Security Audit

---

## Executive Summary

A comprehensive security audit of the production release plan for CommonSwarm HM lanes 3 and 7 (DARK box window v3) was conducted against all production-blocking security criteria. The release introduces durable hosted check batches (`20260928000004_hm_hosted_check.sql`) and edge update `e7bb7a46b24e7bc794234416d43605bca52b55d4` containing the hosted MCP worker (`supabase/functions/mcp`) held strictly behind the router's dark gate.

---

## Detailed Audit Findings & Safety Verification

### 1. Feature Gate & Dark Boundary Security (`SWARM_MCP_PUBLIC_ENABLED`)
* **Public MCP Flag Unset:** The release plan explicitly enforces that `SWARM_MCP_PUBLIC_ENABLED` must remain unset / not equal to `1` across preflight, startup Compose configuration, loopback verification, and post-switch validation ([`prompt.md#L56`](local path), [`prompt.md#L319`](local path), [`prompt.md#L534`](local path), [`prompt.md#L578`](local path), [`prompt.md#L1046`](local path)).
* **503 Refusal on All HTTP Methods:** In step `hm37-public-boundaries`, the probe harness verifies that `/functions/v1/mcp`, `/functions/v1/mcp/.well-known/oauth-protected-resource/mcp`, `/mcp`, and `/.well-known/oauth-protected-resource/mcp` answer with `503` `feature_disabled` (`{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}`) across all 7 HTTP methods: `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS` ([`prompt.md#L654`](local path), [`prompt.md#L732-L734`](local path)).
* **No Worker Invocation on Disabled Routes:** The plan mandates exact-tree instrumented test evidence (`tests/p1-cli/edge-runtime-box.test.ts`) asserting zero worker invocations when dark routes return 503 ([`prompt.md#L540-L544`](local path), [`prompt.md#L1009`](local path)).

### 2. Authorization & Capability Enforcement
* **Pre-Bearer Refusal of Public Hosted Commands:** All 6 public-hosted-only commands (`begin_hosted_mcp_grant`, `consent_hosted_mcp_workspace`, `activate_hosted_mcp_grant`, `claim_hosted_seat`, `open_hosted_mcp_check_batch`, `ack_hosted_mcp_check_batch`) are checked before command-ID validation, bearer classification, or GoTrue auth, returning 403 `forbidden` (`{"error":"forbidden"}`) when unauthenticated ([`prompt.md#L611-L613`](local path), [`prompt.md#L692-L695`](local path)).
* **Unauthenticated & Cross-Seat Protection:** In Section 9, step 6 explicitly verifies that unauthenticated public `open` and `ACK` requests return 403 `forbidden` and leave seat cursors and batch state completely unchanged ([`prompt.md#L757-L758`](local path), [`prompt.md#L792`](local path)).

### 3. Principal Lifecycle & Credential Hygiene
* **Teardown & Zero Token Assertion:** Step 9 teardown revokes all temporary hosted seats, CommonSwarm grants, provider token families, and local/sender principals, requiring explicit verification that zero active unexpired agent tokens remain at closure ([`prompt.md#L801-L815`](local path), [`prompt.md#L1050`](local path)).
* **Strict Credential Validation:** Step `hm37-validate-local-credential` parses credentials strictly by checking non-empty string fields `agent_token`, `principal_id`, `token_id`, `run_id`, validating UUID types, enforcing mode `0600`, and failing closed on missing or unexpected fields ([`prompt.md#L421-L423`](local path), [`prompt.md#L835-L862`](local path)).
* **No Secret Exposure:** Secrets and tokens are strictly prohibited from argv, URLs, shell variables, stdout, or copied evidence files ([`prompt.md#L64`](local path), [`prompt.md#L420`](local path), [`prompt.md#L800`](local path), [`prompt.md#L1019`](local path)).
* **1Password Method:** 1Password access requires Anvil's non-interactive service-account, file-based method rather than an interactive `op` session ([`prompt.md#L64`](local path), [`prompt.md#L1060`](local path)).

### 4. Operational Safety, Rollback & Caddy Rules
* **Shell Safety Verification:** Audit of all 7 runnable shell blocks ([`prompt.md#L126-L198`](local path), [`prompt.md#L390-L418`](local path), [`prompt.md#L430-L470`](local path), [`prompt.md#L512-L521`](local path), [`prompt.md#L615-L753`](local path), [`prompt.md#L828-L863`](local path), [`prompt.md#L906-L976`](local path)) confirms zero `HOME` assignments, zero unsafe `rm -rf` operations (temporary file cleanup uses safe `rm -f` on checked `mktemp` paths), and zero Docker commands executed on the Mac mini.
* **Container Log Permissions:** Outgoing container logs captured before edge recreate are saved with strict mode `0600` permissions and capped at 10 MiB ([`prompt.md#L563-L567`](local path), [`prompt.md#L1019`](local path)).
* **Edge-First Rollback Safety:** Rollback restores previous edge `72c57e0d76d0aa86fe4f811a2cf51499919fed20` (which lacks the MCP worker entirely), ensuring the new worker cannot remain routable ([`prompt.md#L882-L897`](local path), [`prompt.md#L913-L916`](local path)).
* **Caddy Invariant:** `API_CADDY_PAIR=no` is set, and Caddy installation, editing, validation-triggered rollout, and reload are explicitly skipped ([`prompt.md#L37`](local path), [`prompt.md#L54`](local path), [`prompt.md#L60`](local path), [`prompt.md#L1045`](local path)).

---

## NITS (Style & Observational Items)

1. **Temporary File Placement in Probe Harness:** In step `hm37-public-boundaries` ([`prompt.md#L624`](local path)), `PROBE="$(mktemp /tmp/hm37-boundaries.XXXXXX)"` targets `/tmp` explicitly on the Mac mini rather than using `$TMPDIR`. The file is correctly trapped for removal and validated via `case`, but `$TMPDIR` is preferred on macOS.
2. **Caddy Hash Table Inventorying:** The release tree SHA hash inventory ([`prompt.md#L243-L247`](local path)) includes split Caddy files (`commonswarm-mcp.caddy`, etc.) despite Caddy rollout being explicitly skipped in this window (`API_CADDY_PAIR=no`). This is documented as repository inventory only, which is acceptable.

---

VERDICT: PASS (no KEEP)