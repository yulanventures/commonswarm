# Item K review follow-ups

The lead's Fold 10 landing bar blocks only verified, lane-introduced production findings. These review findings did not meet that bar. Resolved items remain here to account for the full round 8 and 9 review record.

| Review | File | Finding and disposition | Why it does not block |
|---|---|---|---|
| Codex 8, rigour | `src/cloud/agent-profile.ts`; `tests/p1-cli/mcp-connect.test.ts`, `agent-onboarding.test.ts`, `agent-channel-grok-bot.test.ts` | Profile saves in tests could reach the runner's HOME; Fold 9 added fixtures and Fold 10 covers the remaining call sites. | Test isolation is now measured by the Fold 10 inventory control; the finding is resolved. |
| Codex 8, rigour | `tests/p1-server/inbox-since-check.test.ts` | In-process credential checks lacked HOME and state-directory fixtures; Fold 9 added both. | The unsafe test path was removed; the server test still awaits the lead's CI run. |
| Opus 8, item 3 | `src/cli.ts` | A refused outer synopsis group survived when its inner group was accepted; Fold 9 fixed and mutation-tested it. | The issue is resolved and did not affect a shipped hint. |
| Opus 8, item 4 | `scripts/timeout-table/mapping.json` | Three HEAD signal-read citations were stale; Fold 9 corrected their cited lines and added a check. | Citation accuracy is documentation rigour, and the cited defaults now resolve. |
| Codex 9 | `tests/p1-cli/item-k-home-control.test.ts` | The HOME spy does not observe the credential-store path when `SWARM_AGENT_STATE_DIR` is set. | The fixture explicitly directs that store to a temporary path; this limits spy coverage without changing production behavior. |
| Opus 9, item 2 | `src/cli.ts` | The inbox workspace check follows the read and any requested wait. | It has no side effect or wrong refusal; on mismatch the read returns empty rows before renewal use. |
| Opus 9, item 4 | `src/cli.ts` | Filtering a refused inner synopsis group can leave a space before the outer bracket. | The cosmetic residue occurs in no shipped hint. |
| Opus 9, item 5 | `tests/p1-cli/item-k-home-control.test.ts` | `--test-isolation=none` may be unavailable on an older Node 22 minor. | This was not verified in review and affects a test control, not production. |
| Opus 9, item 6 | `scripts/timeout-table/mapping.json` | One signal-read citation range starts inside `checkedSince`. | The range still includes the cited read default; the two single-line citations are exact. |
| Codex 10, follow-up | `tests/p1-cli/item-k-home-control.test.ts` | The AN1 inventory recognizes named imports and literal setup/connect spawn expressions; namespace imports or argv variables could evade it. No real-HOME access was demonstrated in the reviewed call sites. | Test-control coverage only; no verified lane-introduced production finding. |
| Opus 10, F4 | `tests/p1-cli/item-k-home-control.test.ts`; `src/onboarding-cli.ts` | The AN1 control misses `runSetupImport` through `setupAgent`, does not check helpers outside test callbacks, and its whole-file `HOME:` pattern can satisfy a fixture check unrelated to the call site. No current test imports `runSetupImport`. | Test-control coverage only; no verified lane-introduced production finding. |

## Round 11 (fold 11 review; Codex PASS, Opus PASS)

- Opus F1: `INBOX_FOLLOW_REFUSED_FLAGS = ["channel", "wait", "json"]` makes a capped `--since --wait` read say there
  is no equivalent follow step; dropping `--wait` would give a valid step (it changes timing, not what is read).
- Opus F2: the cap notice prints the server's `created_at` raw on the human text path; main already does the same in
  `renewal-grants.ts`, so no new class of risk.
- Opus F3: `tests/p1-cli/inbox-follow-step.test.ts` types its own boolean-flag set instead of `BOOLEAN_FLAGS`.
- Opus F4: the printed follow command is followed by the sentence's period; copying it gives a since value ending in
  `.`, which is refused (never a wrong read).

## Merge with main after items M and G lane 2b (Opus check of the resolution, 2026-09-26)

- The blocker (main's `listen status --wait` refusal lost) and the two help deviations are FIXED before landing
  (Alloy task 05f1422a). The two p1-cli failures the landing run found are FIXED (Alloy task 334a7228).
- `inbox --notify`'s synopsis lacks main's `[--session-context <path>] [--take-over]`; both are still listed under
  Additional options.
- `saveAgentProfile`'s sixth argument now takes a boolean or a function to keep both call shapes; an options object
  would be clearer.
- `mcp-connect-home-control.test.ts` types the `lane-home-mcp-` prefixes; derive them from `lane-temp-home.ts`.
- Pre-existing stale citations (not from the merge): `control.ts:1196`, `agent-receive.ts:148` and `:249-257`.
- Alloy task `c429ac7f` (the merge resolution) is retained: its review packet was over 96 KB because of the
  re-recorded dispatch fixture, so no Alloy review ran and `alloy cleanup` refuses. HezLead decides its disposal.
