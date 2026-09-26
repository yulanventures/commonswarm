# Item T3 lane T3a: ask chain and loop limits, server (landed 2026-09-26)

Brief: `docs/design/2026-09-26-T3-ASK-CHAIN-LIMITS-BRIEF.md` v3 (Codex round 1 FAIL, round 2 PASS). The client lane
T3b (`--parent`, the tools' `parent_signal_id`, the turn-scoped default) follows.

- Lane commit `cc5e4386` (Alloy task `4efbbff0625145d2`: Codex Maker; Grok 4.7 Checker PASS), authored by the lead.
- Migration `20260927000003_ask_chain.sql` (no BEGIN/COMMIT): `parent_signal_id` (same-workspace FK) and internal
  `chain_root_id`, `chain_hop`, `chain_participants`; `swarm_read.signals` recreated with `chain_hop` only. Release
  proofs in `deploy/release-proofs/item-t3/`; section 5 of `deploy/RELEASE-TO-BOX.md` defers its functional proof.
- Edge: parent checked in the inserting statement; `chain_loop` before `chain_too_long` (4 hops); `chain_too_wide`
  (3 children); one generic `chain_parent_invalid`; 20 asks per agent per minute and 6 per agent pair per 10 minutes
  (`rate_limited`); constants in `src/cloud/ask-chain-constants.ts`.

## Gates

| Gate | Result |
|---|---|
| mini `gates` on the merge with the G3d client (`94e1f0be`) | exit 0; `npm test` 1031 of 1031 |
| mini `p1-cli` on `94e1f0be` (19:49Z; pressure 1; OrbStack off) | 1281 of 1288 pass, 0 fail, 7 skipped (docker) |
| Actions server suite 36267296883 at `cc5e4386` | 299 of 301; the 2 failures are main's baseline (item L; h0 aborted poll) |

## Release

Server first, in a box window with G3c and G3d (migrations `20260927000001`, `…02`, `…03`). T3b clients ship after.
T3 must be in production before any hosted MCP. The production controls (2-hop chain, loop, hop 5 with seven seats,
pair limit) follow the release, on Cold Agent Test seats.
