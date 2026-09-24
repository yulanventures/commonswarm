### Analysis & Design Consultation: CommonSwarm Backlog Item I

#### 1. Host Session Identity per Host & Mislabel Risk
- **Claude Code**:
  - *Hooks*: Standard input JSON passed to `cswarm hook check` contains `session_id` ([src/cli.ts:321](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/src/cli.ts#L321)).
  - *Bash tool subprocesses*: No standardized per-session environment variable (such as `CLAUDE_SESSION_ID`) is guaranteed in child processes.
  - *MCP server env/args*: Configuration (`.claude.json`) is static JSON; Claude Code does not perform dynamic per-session variable expansion in MCP server environment blocks.
- **Codex CLI / `codex exec` / Grok CLI / Gemini (Antigravity) / OpenCode**: None inject a dynamic per-session identifier into tool subprocess execution arguments automatically without explicit flags (e.g., `--host-session-id`).
- **Mislabel Risk**: Inherited environment variables (e.g., `CLAUDE_CODE_*`). Child processes spawned inside a host environment inherit the parent's environment. Inferring host identity from environment variables mislabels sub-agents or nested runners (as specified in [docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md:32](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md#L32)).
- *Verified vs Assumed*: Verified `cswarm hook check` parsing in `src/cli.ts` and `AGENT-SESSION-IDENTITY.md`. Assumed host subprocess tool argument behavior based on documented CLI specifications.

---

#### 2. Where Binding Should Live & Trade-offs
- **(a) Client-only**: Store `bound_host_session_id` in `profile.json`. Every `--profile` command checks the current host session ID against `profile.json`.
  - *Stops*: An honest agent that accidentally wanders into another seat's profile path across host sessions.
  - *Does NOT stop*: A determined process on the same machine (all processes under the OS user can read `0600` profile files and forge `--host-session-id`).
  - *Cost*: Minimal. 0 server edge changes, 0 database migrations, 0 RTT latency penalty on read commands.
- **(b) Server-side**: Make every setup seat managed in PostgreSQL (`swarm.agent_principals.managed_at`) and enforce proof headers (`x-cswarm-session-id`, `x-cswarm-key`) on read edges ([supabase/functions/_shared/agent-auth.ts:233](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/supabase/functions/_shared/agent-auth.ts#L233)).
  - *Stops*: Unmanaged API access and cross-session proof reuse at the network boundary.
  - *Does NOT stop*: A determined local process reading `session.json` (`0600`) from disk and attaching valid headers.
  - *Cost*: High. DB `FOR SHARE` locks on every read RTT (`cswarm check`), edge function updates, and breaking legacy/unmanaged seats.
- **(c) Hybrid (Recommended)**: Client profile binding in `profile.json` backed by backend session proof validation on managed routes.
  - *Stops*: Honest cross-session profile mixing locally while preserving cryptographic session fences on managed backend mutations.
  - *Cost*: Low. Local assertion for read checks; proof verification overhead restricted to managed routes.

---

#### 3. Handling Existing Seats
- **Strategy**: Grandfather existing profiles on read/turn checks; bind on re-setup or opt-in.
- Existing profiles set up prior to this change lack `bound_host_session_id`. If `bound_host_session_id === undefined`, the CLI treats the profile as legacy grandfathered (unbound), allowing long-lived listener seats and existing profiles to continue operating without lockout.
- Re-running `cswarm setup` or executing `cswarm session enable` records `bound_host_session_id` for the seat.

---

#### 4. Done-Test & Mutation Control Evaluation
- In Design (c)/(b), when Session B uses Session A's managed profile, presenting Session B's proof triggers `profile_session_conflict` (locally) or backend `session_conflict` (409).
- The mutation test drops the proof header. On a managed principal route, dropping proof headers causes the backend to return `session_proof_missing` (401).
- This control is meaningful because it proves the refusal was actively produced by the session proof validation path rather than a static token error or unhandled edge case.

---

#### 5. Minimal Release 1 Design
- **Exact Rule**: `cswarm setup` records `bound_host_session_id` in `profile.json`. Any `--profile` command resolves the active `host_session_id`. If `bound_host_session_id` is set and does not match the active session ID, `cswarm` refuses immediately.
- **Stable Code(s)**: `profile_session_conflict` (local refusal) and `session_proof_missing` / `session_conflict` (server fence).
- **Exact Sentence**: `"This profile belongs to another session. Stop and tell the operator."`
- **Where Each Check Runs**:
  - Local check in `profileSessionContext()` in [src/cloud/agent-profile.ts:214-226](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/src/cloud/agent-profile.ts#L214-L226).
  - Server fence in `enforceAgentSessionProof()` in [supabase/functions/_shared/agent-auth.ts:214-260](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/supabase/functions/_shared/agent-auth.ts#L214-L260).
- **Files & Functions to Change**:
  - [src/cloud/agent-profile.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/src/cloud/agent-profile.ts): Add `bound_host_session_id?: string` to `AgentProfile`; assert host session match in `profileSessionContext()`.
  - [src/cloud/agent-onboarding-contract.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/src/cloud/agent-onboarding-contract.ts): Update `AGENT_QUICK_GUIDE` and `turnCheckInstruction()` to state the session binding rule.
  - [site/src/components/connect/agent-prompt.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/site/src/components/connect/agent-prompt.ts): Update `setupPrompt()` copy to state the rule.
  - [src/cli.ts](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-rel-0174/src/cli.ts): Update `cswarm setup` to accept and record `--host-session-id`.
  - `tests/p1-cli/profile-session.test.ts`: Add CLI integration tests for session matching, mismatch refusal, and proof header mutation.
- **Tests**:
  - *Positive*: Setup in Session A; `cswarm check --profile P --host-session-id A` succeeds.
  - *Negative*: `cswarm check --profile P --host-session-id B` is refused with `profile_session_conflict` and `"This profile belongs to another session. Stop and tell the operator."`
  - *Mutation*: Dropping proof header on a managed principal request changes refusal from `session_conflict` (409) to `session_proof_missing` (401).
- **What it Deliberately Does NOT Stop**: Direct OS-level disk reads of `0600` profile/session files by another process running under the same OS user.

RECOMMENDATION: c — Implement client profile binding in profile.json with grandfathering for legacy seats, backed by existing server session proof enforcement on managed routes.