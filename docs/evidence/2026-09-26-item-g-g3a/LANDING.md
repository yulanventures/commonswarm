# Item G lane G3a: the Claude channel notice leads to an ACK and a reply (landed 2026-09-26)

Brief: `docs/design/2026-09-26-REST-OF-G-BRIEF.md`, section G3a. Cause: the T2 result
(`docs/evidence/2026-09-26-t2-claude-channel/RESULT.md`).

- Lane commit `9b8562bf` on `74804141`, merged as the G3a merge on main. Alloy tasks `f151e095cb7440f4` (Codex Maker;
  Grok 4.7 Checker FAIL after three rounds with two lane-introduced defects) and `51f003492f75406b` (the fix; Checker
  PASS). Squashed and authored by the lead.
- Defects the first Checker found and the fix closed:
  1. a superseded wake test waited for idle and held the claim slot, so a teammate ask behind it waited for the whole
     busy turn; now only the current wake test waits;
  2. a self-addressed note lost its body; it now keeps the escaped, fenced body.
- Changed: `src/cloud/agent-channel.ts` (trusted prefix with `signal_id`, `receipt`, `host_session_id`; fenced
  untrusted body; `cswarm_reply` tool without a status field; refusals for wake tests and self-addressed notes),
  `src/cloud/agent-receive.ts` (`mcp__cswarm__cswarm_received` in `permissions.allow` only for Claude wake mode,
  removed on a move to turn, malformed permissions refused), tests in `tests/p1-cli/agent-channel.test.ts` and
  `tests/p1-cli/agent-onboarding.test.ts`.

## Gates (this host, through `scripts/run-gates.sh`)

See the CP2 landing record for the shared run: G3a and CP2 were verified together on one merged tree.

## Not established

- The live control (the T2 procedure with the new notice: an idle Haiku session calls `cswarm_received` without a
  prompt, and a reply arrives after approval). It needs two new Cold Agent Test seats minted by Tom, and it ships to
  users only with the next npm release after 0.1.78. 0.1.78 is built from `74804141` and does not carry G3a.
