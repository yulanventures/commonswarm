Implement item I release 1 in the CommonSwarm repo exactly as specified in docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md
(six decisions and "Done for release 1"). Read AGENTS.md first (D-053: never branch on error.message; an enumeration
inside a message must be generated from the constant the enforcement reads; claim controls).

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); no supabase, vercel, ssh; no swarm/cswarm against a real workspace; do not read
~/.cswarm or ~/.config/cswarm (tests use a temporary HOME). No server or migration change (decision 6). Every test has
a timeout. The production control is the lead's.

Deliver: one `requireProfileHost` in src/cloud/agent-profile.ts called by every profile opener before the credential,
the cache or the network; the setup changes; the MCP start check and error-table entries; the repair/guide/connect
text; tests under tests/p1-cli/ (globbed by test:p1-cli) including a test generated from AGENT_COMMANDS that every
--profile row reaches requireProfileHost; the mutation control (remove the comparison -> the B-refusal test fails),
recorded; docs/evidence/2026-09-24-item-i/LANE.md with what was built per decision, tests, mutation results and what
was not established. For decision 4's host list, name a host's variable only if you can cite that host's own
documentation or source; otherwise leave the host out and say so in LANE.md.
