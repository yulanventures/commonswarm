# Item I — Checker review (Claude Opus arm), round 4 (delta)

Delta `2dbbfe23..25ac71b1` (fold 3: H1 and H2). I built a fresh `git archive 25ac71b1` in `opus-probes/r4` and a
second copy for mutations in `opus-probes/mut4`. Both built with exit 0. Every run used a temporary HOME. **Every
`cswarm` command I ran in this round had a loopback `--url http://127.0.0.1:9`, a profile that points at loopback, or
was refused before any target was resolved. Nothing contacted a non-loopback host.** No process is left running.

## Findings

### 1. RIGOUR (blocks landing) — fold 3 turns the existing `command-table-gates` test red

`tests/p1-cli/command-table-gates.test.ts:245-252` fails at 25ac71b1:
```
✖ AGENT_PROFILE_COMMANDS is derived from table order data
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
      'listen',
  +   'session start',
```
This gate still expects one name per verb:
`.map(row => row.verb)`. H1 now produces names per command pair, so this test needs the new derivation, or it should
be replaced by the new item-I test. The file runs under `test:p1-cli`. LANE.md "Fold 3" reports the item-I file
(20/20) and the baseline, but not this gate. The only consumer of `AGENT_PROFILE_COMMANDS` in `src/` is the refusal
sentence (`src/cli.ts:763`), so no other code is affected.

### 2. RIGOUR (does not block; already true at 0260ab8d) — the sentence omits commands that accept `--profile`

I compared the sentence with `AGENT_COMMANDS` (`profilelist.mjs`), checking every row that accepts `--profile`
(`profile !== "refuse"` and `flags.includes("profile")`):

| | Sentence | Listed but refuses | Accepts but not listed |
|---|---|---|---|
| base 0260ab8d | `…, listen, session, channel` | none | `mcp, setup, check, receive configure|status|test|confirm|idle|serve` |
| r4 25ac71b1 | `…, listen, session start, session status, session stop, channel` | **none** | `mcp, setup, check, receive configure|status|test|confirm|idle|serve` (unchanged) |

Every listed name is true at r4, and H1 fixed the `session` case. The sentence reads as a complete list, but it leaves
out the NATIVE rows, including `check`, the command agents use most with `--profile` after item I. This was already
true at base, so the lane did not cause it. The new test cannot see an omission, because its `expected` value keeps
only roots that have `profileListOrder` and repeats the producer's algorithm. Its second loop (every named item
accepts the flag) is an independent check that the listed names are correct, but it does not check completeness.
Suggested follow-up: build the list from every accepting row, or change the sentence so it does not claim to be
complete.

## The questions you asked

| Question | Measurement | Result |
|---|---|---|
| Sentence true for listed commands | All 18 listed names accept `--profile` according to the table. The refusal printed for `session enable --profile … --url http://127.0.0.1:9` and `login --profile …` is exactly `--profile is supported by: whoami, resume, working-on, note, ask, reply, receipt, feed, inbox, brain, file, members, feedback, listen, session start, session status, session stop, channel.` | PASS |
| Sentence true for unlisted commands | 9 accepting rows are not listed. This was already so at base (finding 2). | Incomplete (already true at base) |
| Test derives from the table and fails if `session` returns | `expected` is computed from `AGENT_COMMANDS` (`profileListOrder`, `profile`, `flags`). K1 (the producer returns `[verb]` for every group, so `session` comes back) fails `profile refusal names exactly the accepting command pairs in table order`. K2 (always list pairs) fails it too. | PASS |
| H2 compared with 0260ab8d | `session status|stop` with no `--profile`. With `--agent-token-file … --workspace-id W`: base and r4 both give `unknown option: --workspace-id`; r3 gave `--session-context is required`. With `--workspace-id` and no credential: base and r4 give `unknown option: --workspace-id`. With no workspace id: all three give `--session-context is required`. With `--profile` (unbound, or bound + A): r4 gives `--session-context is required`, so the expansion parses; base refused the expanded `--workspace-id`. K3 (H2 revert) fails the H2 test. K4 (never allow `workspace-id`) fails the H2 test and the generated all-rows test. | PASS |
| Nothing else changed | `git diff --stat 2dbbfe23 25ac71b1`: `src/cli.ts` (the two `runSession` shapes and `AGENT_PROFILE_COMMANDS`), the item-I test (+2 tests), LANE.md, and the baseline fixture. Baseline: 273 of 1261 rows changed. In every one, only `stderr` changed, and it equals the old text with `listen, session, channel.` replaced by `listen, session start, session status, session stop, channel.` 0 rows still hold the old sentence. The counts file did not change. | PASS |

## Tests

These 9 files together give **106/107**: item I (20/20), mcp-stdio, command-dispatch-baseline (passes with the new
fixture), command-table-gates, citation-drift, agent-connection-token, permissions-default, agent-onboarding and the
site connect observer. The 1 failure is finding 1. `npm run check:tests` exits 0. The mutation sources were restored
and compared with `diff -r` (identical).

## Not established

This is a delta review. The earlier probes (the two-session hook, and all rows with A/B/no id) were not re-run,
because fold 3 changes neither the hook nor the opener path. Also not established: the production request count, live
hook-id equality, the static MCP config, and the full suites.

VERDICT: FAIL
