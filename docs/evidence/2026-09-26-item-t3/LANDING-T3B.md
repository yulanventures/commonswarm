# Item T3 lane T3b: ask chain clients (landed 2026-09-26)

Brief: `docs/design/2026-09-26-T3-ASK-CHAIN-LIMITS-BRIEF.md` v3, "Design > Clients". Server: `LANDING-T3A.md`.

- Lane commits `6c0ef1dd` (Alloy task `1a9a69271ddd4f6e`: Codex Maker; the review packet exceeded 96 KB because of
  the recorded help fixture, so no Alloy Checker ran) and `67501ab3` (Alloy task `6cfa58f371214ba2`, the fix round;
  Grok 4.7 Checker PASS). Both authored by the lead.
- A read-only Codex review of `6c0ef1dd` found five defects, fixed in `67501ab3`: an unbound profile shared a
  persistent "manual" context across sessions; a slow check could erase an ask the channel had just shown; a failed
  turn check left the last turn's parent active; `rate_limited` lost the server's message on all three surfaces; the
  channel notice had no hop. The web app's hop display is a follow-up (the roster file was in G3e at the time).
- What landed: `cswarm ask --parent`, the MCP ask tool's `parent_signal_id`, a channel `cswarm_ask` (never
  pre-approved); a per-host-session context with a turn generation (a turn check starts a new generation on every
  path; shown asks merge into it; older writes are ignored; one lock); automatic parenting only with a host-session id
  and exactly one ask shown this turn, else no parent and one line (CLI stderr, tool sentence); chain refusals and
  `rate_limited` shown with the server's message; "hop N of 4" in inbox, read and the channel's trusted prefix.

## Gates

| Gate | Result |
|---|---|
| mini `gates` on the G3e + T3b merge | exit 0; `npm test` 1031 of 1031 |
| mini `p1-cli` on the merge (21:46Z; OrbStack off) | 1293 of 1302; 2 failures, 7 skipped (docker) |
| the 2 failures | `pending-access.test.ts` mutation anchor moved by G3e (fixed; 7/7); `agent-channel.test.ts` stdio canary timed out under load (3/3 alone; the second load timeout today; follow-up) |
| citation data conflicts at the merge | resolved from T3b's version with `src/cli.ts` and `workspaces.ts` citations remapped; citation-drift 5/5, timeout-table 29/29 |

## Release rule

A client that fills a parent must ship after the T3a server is live (the current edge refuses `parent_signal_id`).
Same rule as the G3d client: no npm or `/download` from a commit containing T3b before the box window with
`20260927000001`-`…03` passes.
