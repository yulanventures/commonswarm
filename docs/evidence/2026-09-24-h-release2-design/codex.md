I recommend operator-only redemption with a dedicated connect-code record, reusing H0’s seat/token machinery internally. This needs a box release. An npm-only H0 wrapper could remove secrets from the normal model transcript, but would not implement v20’s contract.

Verified: repository source, the two release briefs, v20 on `spec/mcp-server`, and official host documentation. I ran no hosts, tests, `cswarm`, or production requests. Commands below describe proposed release-2 behavior.

1. **Human operation and secret exposure**

Use the human’s terminal on the machine running the MCP subprocess. `connect` should prompt for the code with terminal echo disabled, redeem it, and write the credential privately. Then configure the host with only the executable and profile path.

Prefer:

```sh
cswarm mcp connect --host-session-id manual
```

The human pastes the code at its hidden prompt. This is a justified adjustment to v20’s positional `<code>` syntax: a code is a bootstrap secret, and positional arguments expose it through shell history/process inspection. Workspace `SECURITY.md:11` explicitly prohibits secrets in shell arguments and environment variables.

A one-line installer can wrap this interaction, but adds no secrecy property. The crucial boundary is **human terminal input, outside the agent’s shell tool**.

First-start redemption from static config/environment can avoid automatically placing the token in a model turn, but leaves a usable bootstrap secret somewhere the model may read. Short expiry and one-use reduce exposure; they do not establish “never entered a turn.” It also contradicts v20’s operator-only redemption rule.

The current leaks are confirmed in `site/src/components/connect/agent-prompt.ts` (`dashboardAgentPrompt`, `dashboardAgentFilePrompt`) and `src/h0/paste.ts` (`h0AgentPaste`). Replace the MCP onboarding handoff with secret-free instructions.

Important scope: 0600 protects against other OS users, not a model’s shell running as the same user. The normal flow can keep both secrets out of every turn; an absolute guarantee against arbitrary same-user file reads requires an additional execution boundary.

2. **Host session binding**

Claude documents `${VAR}` expansion in `.mcp.json`, including arguments. Separately, it now documents `CLAUDE_CODE_SESSION_ID` in stdio MCP subprocesses. Those statements do **not** establish that the session variable exists at config-interpolation time. A subprocess wrapper expanding it at execution is a candidate, still needing measurement. Furthermore, Claude explicitly says an MCP subprocess retains its original ID after `/clear`. A startup check therefore cannot prove the identity of every later conversation. [MCP configuration](https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcp-json), [session environment](https://code.claude.com/docs/en/env-vars).

Official OpenAI documentation establishes static `command`, `args`, `env`, and `env_vars`; I found no documented guarantee of automatic per-thread ID injection into MCP arguments. Treat that capability as unverified, not impossible. [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp).

For release 2, require an explicit choice:

- **Bound:** an actual host session ID, named at issuance and matched at redemption/startup, using a measured host integration.
- **Manual:** explicitly unbound, visibly described that way. v20 lane 3 permits this weaker mode; it must not become a silent fallback.

Do not invent a session label and present it as the host’s actual ID. Do not hard-code yesterday’s ID into a globally shared config.

The server binding still earns its cost: `requireProfileHost` checks one profile against a presented ID (`src/cloud/agent-profile.ts:49`). It cannot prevent another principal obtaining another profile for that same workspace/session. Keep v20’s durable partial unique index for bound connections. Neither mechanism authenticates a hostile same-user process.

3. **H0 reuse versus a new table**

H0 already supplies hashing, human-authorized issuance, ownership, expiry, transactional seat allocation, and renewal-capable tokens:

- `supabase/migrations/20260916000001_agent_join_credentials.sql`
- `supabase/migrations/20260916000002_agent_join_attempts.sql`
- `supabase/functions/command/index.ts` — `mintAgentJoinCredential`, `registerAgentSeat`

But unchanged H0 misses material requirements:

- Its secret is `swm_join_` plus 43 base64url characters, not a convenient typed code.
- TTL enforcement is **1–24 hours** (`src/protocol/agent-join-limits.ts:14`).
- Issuance limits count live credentials; they are not redemption-attempt throttles.
- No intended host session or durable cross-principal session binding exists.
- `seat_cap: 1` limits seats, not successful exchanges: a repeated `attemptId` replaces an unused token before the seat-cap check.
- `revokeAgentJoinCredential` explicitly leaves registered seats unchanged (`command/index.ts:6696`).

Therefore, a CLI redeemer over unchanged `h0 register` is the **npm-only option**, assuming deployed H0 matches this source. It can satisfy the narrow transcript demonstration, but calling it v20 completion would conceal relaxed one-use, binding, throttling, and unbind semantics.

Use separate connect-code and durable binding records. Reuse reviewed seat/grant/token allocation and revocation helpers inside the transactional command path; do not route connect codes through H0’s retry/replacement semantics. Extending H0 with a separate purpose could work, but still needs migration and edge changes and complicates its existing contract.

4. **Minimal release 2**

Proposed human flow, repeated independently for Claude and Codex:

1. In the web app, choose workspace/seat and explicitly select **Manual — not bound to a host session** for the portable baseline. Copy the short-lived code.
2. In the human’s terminal on the agent host, run the proposed `cswarm mcp connect --host-session-id manual`; paste into its hidden prompt.
3. Connect writes 0600 credentials in a 0700 directory and prints only connection status and nonsecret installation instructions.
4. Install using the returned absolute profile path:

```sh
claude mcp add --transport stdio commonswarm -- cswarm mcp --profile /absolute/profile.json
codex mcp add commonswarm -- cswarm mcp --profile /absolute/profile.json
```

Use each line only for its respective host. **Omit** `--host-session-id manual` from server startup: `src/mcp/server.ts:39` currently rejects it. Start fresh sessions; the model receives seven tools and sanitized results, with no code or credential attachment.

Server additions: human-authorized issuance, hashed codes with stated entropy and expiry, atomic single redemption, redemption throttling, server-authoritative identity response, optional explicitly unbound issuance, bound-session uniqueness, and human-authorized unbind that revokes the resulting credential lineage before freeing the slot. Proposed defaults: 100 random bits, grouped for typing, ten-minute expiry.

Implement v20’s fail-closed local requirement too: profile `token_id` must match the saved bootstrap credential before authentication. Today `readProfileCredential` compares only principal identity. Preserve renewal behavior. Do not implement item M’s crash recovery or replay secret issuance; interrupted redemption requires operator unbind/revocation and a new code.

Required tests: redemption races, expiry/throttling, wrong-session refusal, cross-principal binding collision, unbind revoking renewed credentials, stdout/error redaction, and killed-connect controls including an existing stale profile. Include positive controls, existing MCP/profile suites, edge checks, and release-bundle verification.

Production acceptance: fresh Claude and Codex sessions each connect, read, ask, and reply through MCP; inspect transcripts and exposure surfaces. Record manual-mode limitations explicitly. Publish npm only after the reviewed migration/edge/site release is applied under `deploy/RELEASE-TO-BOX.md`: HezLead directs, Anvil executes.

RECOMMENDATION: Ship operator-only hidden-input connect with dedicated one-use server records, explicit manual mode where host binding is unverified, reused H0 allocation internals, and the required box release.