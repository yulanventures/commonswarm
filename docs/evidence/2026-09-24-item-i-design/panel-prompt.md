# Design question: CommonSwarm backlog item I — "a profile is bound to the host session that ran setup"

You are a read-only design consultant. Repository: the current directory (CommonSwarm: the `cswarm` CLI in src/, Deno
edge functions in supabase/functions/, canonical spec docs/design/SWARM-CLOUD.md, session identity spec
docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md). Read the code you need. Do not contact any CommonSwarm host
(api.commonswarm.com, commonswarm.com) or run cswarm. You may search the web for host documentation.

## The item (operator backlog, verbatim)
"A profile is bound to the host session that ran setup (lesson 2026-09-14: after a failed setup the agent went looking
for other seats' profiles on the machine). Every `--profile` command carries the session proof the identity project
built; a different host session using the profile is refused with a stable code and the sentence 'This profile belongs
to another session. Stop and tell the operator.' The checksum and setup errors say the same next step, and the connect
message and `setup guide` state the rule. Enforcement, not copy. Done: on production: setup in session A,
`cswarm check --profile` from session B is refused with the code; from A it works; mutation: drop the proof header, the
refusal disappears."

## What exists today (mapped from origin/main, with citations)
- Managed vs unmanaged: `swarm.agent_principals.managed_at`, set only by the human command `enable_agent_management`
  (`cswarm session enable`, human credential). Unmanaged principals skip the proof fence entirely
  (supabase/functions/_shared/agent-auth.ts:233).
- Session proof = {session_id, generation, key} sent as headers x-cswarm-session-id / -generation / -key
  (src/cloud/session-proof.ts, session-wire.ts). Created by `acquire_agent_session` (requires managed_at). Stored in
  session-context files ~/.config/cswarm/sessions/<ws>/<principal>/<session>.json (0600), holding host_session_id; NOT
  keyed by host session, so any process of the same OS user can list and read them.
- The command edge enforces the proof for every agent mutation of a managed principal (except acquire_agent_session);
  codes session_proof_missing/invalid/expired 401, session_conflict 409. The READ edge (supabase/functions/read/) never
  checks a proof. `cswarm check` only uses the read edge.
- Host session id sources: only the `--host-session-id` flag, and Claude Code hook stdin `session_id` inside
  `cswarm hook check`. No environment-variable source: the identity spec says "Do not infer host identity from
  inherited environment variables" (a Codex child inherits CLAUDE_CODE_* variables and was once mislabelled).
- profileSessionContext(profile, hostSessionId) (src/cloud/agent-profile.ts:214-227): no id -> null (no proof, no
  refusal, even for a managed principal); an id that matches no live context -> profile_session_conflict (local).
- `cswarm setup` writes profile.json + credential.json only; it records no host session and does not make the
  principal managed. setup guide text (src/cloud/agent-onboarding-contract.ts) and the connect message
  (site/src/components/connect/agent-prompt.ts) say nothing about the rule.
- `cswarm mcp --profile P [--host-session-id ID]` (released 0.1.74) refuses to start for a principal with a live local
  managed context and no --host-session-id; its host config (e.g. `claude mcp add ...`, Codex config.toml) is static.
- So today: session B runs `cswarm check --profile <A's profile>` -> unmanaged: works; managed without the flag: works;
  managed with B's id: refused locally with profile_session_conflict.

## Questions (answer each; cite files; say what you verified vs assumed)
1. Host session identity per host: what stable per-session identifier does each host give to a tool call WITHOUT the
   model typing it — Claude Code (Bash tool subprocess, hooks, MCP server env/args; e.g. is a session id env var set
   for Bash tool children, and do MCP server configs expand per-session variables?), Codex CLI / codex exec, Grok CLI,
   Gemini/antigravity, OpenCode. Which of these would a CHILD process of another host inherit (the mislabel risk)?
   Cite official docs or source where you can.
2. Where should the binding live, given that any process of the same OS user can read every file: (a) client-only
   (profile records the setup host session; every --profile command must present a matching id), (b) server-side
   (make every setup-created seat managed and acquire a session bound to the setup host session; the read edge enforces
   the proof too), or (c) another design. What does each actually stop (an honest agent that wandered into another
   seat's profile vs a determined one), and what does it cost (edge changes, migration, latency on the per-turn check)?
3. Existing seats: every profile set up before this change has no binding. What should they do on the first command
   after the upgrade (refuse, bind on first use, grandfather), without locking out long-lived listener seats?
4. The done-test says "mutation: drop the proof header, the refusal disappears". Which design makes that a meaningful
   control, and is that control sufficient to show enforcement?
5. The minimal design you recommend for release 1 of item I: the exact rule, the stable code(s), where each check runs,
   the files and functions to change, the tests (positive, negative, mutation) and the production control, and what it
   deliberately does NOT stop. Keep it small: "ask for the minimum, detect the rest; detection must not guess".

Answer in under 1,200 words. End with one line: RECOMMENDATION: <a|b|c> — <one sentence>.
