# Item G lane G3c: reply status for private replies (landed 2026-09-26)

Brief: `docs/design/2026-09-26-REST-OF-G-BRIEF.md`, section G3c (Tincan T4).

- Lane commits `8dd7ff8b` (Alloy task `e12602f04eac4c2e`, Codex Maker; the review packet exceeded 96 KB, so no Alloy
  Checker ran) and `42464758` (Alloy task `ea14b8a3ddab460e`, the fix round; Checker PASS). Both authored by the lead.
- A read-only Codex review of `8dd7ff8b` found two defects, both fixed in `42464758`:
  1. BLOCKER: the functional proof set the caller claim transaction-locally, so under the production `psql --file`
     run the receipt query ran without it; now session-level, prints `t` only on success, and runs only after the
     edge switch with its four `-v` values (never in section 5's automatic step);
  2. MAJOR: the migration had its own `BEGIN`/`COMMIT`, which would end the release wrapper's transaction before
     its ledger row and catalog gate; removed.
- The Actions server suite also found two test bugs (the CHECK test used UPDATE and hit the append-only trigger; one
  ask carried two recipient fields); fixed in the same round.

## What landed

`REPLY_STATUSES` (`src/cloud/reply-status.ts`, shared by the CLI and the edge); `cswarm reply --status` (private
replies only; `--status --thread` exits 2 with `reply_status_thread`); `cswarm_reply` gains `status`; migration
`20260927000001_reply_status.sql` (nullable `reply_status` with a CHECK, and a `replies` list in the sender's receipt
ordered by `(created_at, reply id)`); release proofs `deploy/release-proofs/item-g3c/20260927000001-*.sql`. No new
reminder timer: the reminders are the durable 15-minute lease with 10 attempts (`supabase/functions/command/durable-delivery.ts:29`,
`:31`) and lane 1's 180 s stale badge.

## Gates

| Gate | Result |
|---|---|
| Actions server suite 36253190605 at `42464758` | 279 of 281; the 2 failures are main's baseline (item L Storage 409 pin; h0 aborted poll) |
| mini `gates` on the merge (after the landing fixes) | exit 0; `npm test` 1030 of 1030 |
| mini `p1-cli` on the merge | 1267 of 1277 before the landing fixes; the 3 failures were lane-introduced and are fixed below |
| mini `cli-file` after the fixes | file-create-rate-limit 41/41, h0-agent-document 16/16, agent-channel 2/2, dispatch baseline 10/10, citation-drift 5/5, timeout-table 29/29, reply-status 5/5, login-provider 6/6 |

Landing fixes by the lead (the lane's test command ran neither `npm test` nor the full p1-cli suite; that was the
lead's test script, not the Maker):

- `tests/chat-signal-wire-compat.test.ts`: the `validateCommand` signature slice anchors on `reason: string`, because
  the return type now carries a constant `error` code (the safety argument holds: codes are constants);
- `tests/delivery-receipts.test.ts`: the parsed receipt now includes `replies: []`;
- `tests/p1-cli/h0-agent-document.test.ts`: `SignalCommand` has 14 members (`reply_status`);
- `site/src/pages/acceptable-use.astro`: eight `command/index.ts` citations in its source comment moved by a
  line-by-line diff mapping;
- `tests/p1-cli/fixtures/command-dispatch-baseline.json`: re-recorded with `UPDATE_DISPATCH_BASELINE=1` on the merged
  build; it differs from main's only by the `reply --status` help line.

## Release

The migration is a production operation in a box window after 2b (with G3d's). Its functional proof runs after the
edge switch. Not in 0.1.78.
