I verified the relevant source paths and current host documentation. I ran no CLI or runtime tests and contacted no CommonSwarm host. **The existing proof identifies an execution-lease holder; it does not independently authenticate the calling host conversation.**

1. **What hosts supply automatically**

| Host | Verified identifier and limitations |
|---|---|
| Claude Code | Current docs specify `CLAUDE_CODE_SESSION_ID` in Bash/PowerShell, hooks, and stdio MCP subprocesses. Hooks also receive `session_id` through stdin. Bash/hooks update after `/clear`; an MCP subprocess retains its launch-time ID. `.mcp.json` expands environment variables in arguments and other fields, but that is not a per-call identity mechanism. [Environment reference](https://code.claude.com/docs/en/env-vars), [MCP reference](https://code.claude.com/docs/en/mcp). |
| Codex CLI / exec | Shell construction explicitly injects `CODEX_THREAD_ID`, overriding an inherited value when the current thread is supplied. `exec --json` also emits `thread.started.thread_id` to its supervisor. MCP documentation describes configured/forwarded environment variables, without establishing automatic per-call thread identity. [Source](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/shell_environment.rs), [exec](https://developers.openai.com/codex/noninteractive), [MCP](https://developers.openai.com/codex/mcp). |
| Grok | Official Grok Build hooks receive runtime-injected `GROK_SESSION_ID`. I did not verify equivalent injection into ordinary shell tools or MCP, or establish that every product called “Grok CLI” implements this contract. [Hook source](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/10-hooks.md). |
| Gemini CLI | Hooks receive stdin `session_id` and `GEMINI_SESSION_ID`. Ordinary shell/MCP injection remains unverified. [Hook reference](https://geminicli.com/docs/hooks/reference/), [environment](https://geminicli.com/docs/hooks/). |
| Antigravity | Hooks receive `conversationId`, including `PreToolUse`. I did not verify automatic shell/MCP environment injection. [Official hooks](https://antigravity.google/docs/hooks). |
| OpenCode | Plugin `tool.execute.before` receives `sessionID`; `shell.env` receives an **optional** `sessionID`. A plugin can supply context without model involvement; absence must refuse. [Plugin interface](https://github.com/anomalyco/opencode/blob/dev/packages/plugin/src/index.ts). |

**Inheritance inference:** exported identifiers can reach descendant hosts unless scrubbed or overwritten. Hook stdin and plugin callback arguments are fresh invocation data; they are not ambient environment. Never select a host by whichever environment variable exists. `src/cloud/agent-host.ts:25` already uses process ancestry and foreign-host boundaries, but does not establish session identity.

These are documentation/source findings, not certification of installed host versions.

2. **Where binding belongs**

- **(a) Client-only:** persist `(host kind, conversation ID)` during setup and require a matching caller before opening credentials or cached messages. This stops accidental profile wandering through the supported CLI, with no additional network latency. Editing files, supplying A’s identifier, older clients, and direct requests bypass it.
- **(b) Managed session plus read enforcement:** stops missing/wrong proof through direct API requests too. It requires provisioning changes, read authorization, lifecycle handling, and migration. However, existing acquisition permits a fresh holder after expiry; the setup conversation must remain bound separately. The server also cannot distinguish B replaying A’s readable key.
- **(c) Recommended hybrid:** durable setup binding, mandatory local caller comparison, and existing execution-proof enforcement server-side. Keep the durable binding across execution-lease expiry. This satisfies the backlog’s proof requirement without pretending same-user files isolate hostile processes.

Verified anchors: `src/cloud/agent-profile.ts:214` returns no context when identity is omitted; `supabase/functions/_shared/agent-auth.ts:233` skips unmanaged principals; `supabase/functions/read/index.ts:428` uses the restricted read role; `command/index.ts:11721` implements acquisition.

The read role needs a narrowly scoped proof-verification database function; do not expose key hashes or switch reads to `swarm_command`. Valid proofs add database work within existing requests, not another HTTP round trip. Idle reacquisition does add a round trip.

3. **Existing seats**

Do **not** bind on first ordinary use: that awards an unbound profile to whichever session discovers it first.

Upgraded `--profile` operations should return `profile_binding_required` until an operator explicitly migrates that profile. Preserve existing server policy and running listener sessions until individually migrated; do not globally enable management or rewrite their contexts.

Migrate a listener seat through the existing stop/lease-drain/enable procedure. Unmigrated seats remain explicitly legacy and outside item I’s completion claim.

This preserves the human opt-in contract in `docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md`, §8. New connection issuance should visibly authorize managed, session-bound setup; an agent must not silently enable itself.

4. **The mutation control is backwards**

If “drop the proof header” means remove it from the request, **refusal must remain**—usually as `session_proof_missing`, or `session_proof_invalid` for a partial proof. Acceptance would demonstrate a bypass.

A meaningful mutation test removes the **verification code** in an isolated test build: the corresponding negative test must then fail. For a server check, bypass the client guard so the request actually reaches that check.

Neither control alone proves host binding. A/B identity tests, omitted identity, expiry, cached reads, and nested-host inheritance must also be covered. No production security bypass should be introduced.

5. **Minimal release 1**

Exact rule: a newly enrolled profile belongs to its setup host conversation until human-authorized rebinding. Every profile operation requires current caller identity; every authenticated request for its enrolled principal requires valid execution proof. Setup acquisition is the narrow bootstrap exception.

Implement:

- `agent-setup.ts:setupAgent` and `agent-profile.ts:saveAgentProfile`: persist binding atomically and make retries retain it.
- `agent-profile.ts`: one mandatory binding guard; invoke before credentials, caches, or network access through `cli.ts:expandAgentProfile`, `agent-check.ts`, receive paths, and `mcp/server.ts`.
- A host adapter supplies invocation identity independently of model arguments. Certify supported versions; reject unknown identity and static MCP bindings that cannot detect conversation changes.
- A migration plus `command/index.ts:acquireAgentSession`: retain durable binding across fresh execution generations. Renew/reacquire only during authorized use; no new idle agent process.
- `read/index.ts` and shared auth: enforce proof for enrolled principals. Revise the identity spec’s explicit read exemption.

Reuse `profile_session_conflict` with exactly: “This profile belongs to another session. Stop and tell the operator.” Use `host_session_required` for missing identity and `profile_binding_required` for legacy profiles. Preserve existing wire codes, including `session_expired`. Update checksum/setup errors, `agent-onboarding-contract.ts`, and `site/src/components/connect/agent-prompt.ts` with the appropriate operator next step.

Extend onboarding, session-bound-write, MCP, and server-session suites. Cover A success/B refusal, missing identity, stripped/partial/wrong proofs, cached-message access, nested hosts, MCP conversation changes, setup retry, idle expiry, and unaffected legacy listeners. Ensure named package gates include them.

Production evidence: Anvil deploys the reviewed SHA; a disposable enrolled seat demonstrates A success/B refusal and missing-proof rejection, recording versions, codes, and redacted results.

This deliberately does not stop a determined same-OS-user process copying credentials, proof, and identity. That requires an isolation boundary.

RECOMMENDATION: c — Combine durable setup binding with mandatory caller checks and existing server proofs, while treating same-user credential theft as outside release 1.