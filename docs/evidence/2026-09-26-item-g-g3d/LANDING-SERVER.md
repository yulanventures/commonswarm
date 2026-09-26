# Item G lane G3d, server half: per-seat presence (landed 2026-09-26)

Brief: `docs/design/2026-09-26-REST-OF-G-BRIEF.md`, section G3d (Tincan T1). The client half (client_build in every
envelope, the claim route, `touch_presence` from check and hook, the classifier) and G3e (surfaces) follow.

- Lane commit `e609bed3` (Alloy task `44329b14cde14dd8`: Codex Maker; Grok 4.7 Checker PASS), authored by the lead.
- Migration `20260927000002_agent_presence.sql`: `swarm.agent_presence` (RLS, command-role grants only),
  `signal_deliveries.ack_via` (`leased` or `unclaimed`, set once), config key `current_client_build`, member-scoped view
  `swarm_read.agent_presence` (explicit columns, `security_barrier`, `swarm.is_member`). No BEGIN/COMMIT of its own.
- Edge: one helper records presence after every successful authenticated agent response; the route comes from the
  command (lease → watcher; `claim_agent_inbox` `route` channel/listener; new `touch_presence` → turn); `route` on any
  other command is refused `route_not_allowed`; `client_build` stored only when valid semver of at most 64 characters.
- `scripts/current-client-build-sql.sh <sha>` and a new `deploy/RELEASE-TO-BOX.md` step record the published build.
  Section 5 now defers both G3c's (`20260927000001`) and G3d's (`20260927000002`) functional proofs to after the edge
  switch.

## Gates

| Gate | Result |
|---|---|
| Actions server suite 36262234674 at `e609bed3` | 288 of 290; the 2 failures are main's baseline (item L; h0 aborted poll) |
| mini `gates` on the merge | exit 0; `npm test` 1030 of 1030 |
| mini `p1-cli` on the merge | 1273 of 1282; 2 lane-introduced failures, fixed below |
| mini `cli-file` after the fixes | mcp-connect 105/105, mcp-connect-home-control 1/1 |

Landing fixes by the lead: `src/cloud/mcp-register-refusals.ts` regenerated with
`node scripts/generate-mcp-register-refusals.mjs` (the new `route_not_allowed` is a possible register refusal on the
shared validation path; it gets the existing default "The request was refused; this attempt created no seat" remedy,
no product code change); `tests/p1-cli/mcp-connect.test.ts` lists the code and its three call counts moved by one;
`deploy/RELEASE-TO-BOX.md` defers G3c's functional proof as well.

## Release

One box window after 2b with G3c's migration. Both functional proofs run after the edge switch with their `-v`
values. Not in 0.1.78.
