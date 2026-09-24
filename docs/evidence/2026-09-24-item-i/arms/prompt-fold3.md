Fold 3 on item I in the CommonSwarm repo (branch lane/item-i at 2dbbfe23). Spec:
docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md. Round 3: Opus PASS with two minor findings, Grok FAIL
on the first of them. Implement both, each with a test that fails when the fix is reverted; record rulings, tests and
mutation results in docs/evidence/2026-09-24-item-i/LANE.md under "Fold 3". Read AGENTS.md first ("An enumeration
inside a message must be generated, not typed"; claim controls).

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74) — note: a cswarm command run WITHOUT --url resolves its own target and contacts
commonswarm.com; in tests always pass a loopback --url or none of the network paths; no supabase, vercel, ssh; no
swarm/cswarm against a real workspace; do not read ~/.cswarm or ~/.config/cswarm (tests use a temporary HOME). No
server or migration change. Every test has a timeout. Leave changes uncommitted; the lead commits.

H1 (Grok 1 / Opus minor 1, claim). The refusal "--profile is supported by: ..." (src/cli.ts, profile_command_invalid)
   names `session` although `session enable|disable|recover` refuse a profile. Build the list from AGENT_COMMANDS at
   the level of the command PAIRS that accept a profile: a group whose variants all accept it is named by its root
   (e.g. "listen"); a group with some refusing variants names only the accepting pairs (e.g. "session start",
   "session status", "session stop"). Keep the order data (profileListOrder). The test derives the expected set from
   the table (not a typed list) and asserts that no refusing command pair is named; mutation: naming the whole
   `session` group again fails it. Regenerate the dispatch baseline (UPDATE_DISPATCH_BASELINE=1, run twice, the two
   runs byte-identical) and list every changed row in LANE.md with why it changed.
H2 (Opus minor 2). `session status|stop` WITHOUT --profile accept `--workspace-id` and ignore it (at 0260ab8d this was
   `unknown option: --workspace-id`). Restore the 0260ab8d refusal when --profile is absent; with --profile the
   expanded arguments still work. Test both.

Report: each ruling -> change -> test -> mutation result; focused tests; baseline rows changed; what you did not
establish.
