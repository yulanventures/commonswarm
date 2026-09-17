# H lane 1 landing: the command table dispatches the CLI (2026-09-17)

Lane `lane/mcp-command-table`, tip **8348ceb3**, landed with `git merge --no-ff`. Item H lane 1 (spec §3 "Lane 1" of
`docs/design/2026-09-14-MCP-SERVER.md`): `AGENT_COMMANDS` in `src/cli.ts` becomes the CLI dispatcher, the first step
toward an MCP server. NOT RELEASED: this lands on main only; it ships with the next npm release.

## What changed

- `main()` does one own-property lookup in `AGENT_COMMANDS`; a group selects its sub-action only when
  `Object.hasOwn(root.subcommands, action)`; every handler runs through `traced()`. The old `if (verb === ...)` chain and
  `runOnboardingCommand` are gone.
- Error handling reads the selected entry's parsed arguments, never raw `process.argv`.
- Help: every selected variant has its own usage line (`check` split into three shapes, `cswarm resume --profile` added).
- `AGENT_QUICK_GUIDE` names `cswarm working-on`, `cswarm reply`, `cswarm brain put` and `cswarm check` (Strategist ruling
  43c86116: `brain put` stays CLI-only until item L).

## Commits (five-commit shape)

4ed1d6ae baseline (1248 recorded rows), a0a76ff8 conversion, 7914eeca selected-entry errors (declared rows),
104e8eae gates, 8348ceb3 citations. Codex (gpt-5.6-sol) and opencode wrote rounds 1-4; the lead wrote the round-5 and
round-6 folds by hand (Strategist 947005d2 and the 2026-09-17 model-balance order) and rebased the lane onto 9543527b
(check budget) with the baseline regenerated and checked at commits 1, 2 and 3.

## Declared behaviour changes

`DECLARED-CHANGES.md`: the selected-entry error class (129 rows, no exit-code change), the help lines, the item-L quick
guide, the 36 `channel <Object.prototype name>` rows (main exited 0 with no output for `toString` and `constructor`; now
the channel refusal), and three `file get|rm|restore -- --json` rows (after `--` the word is a file name).

## Review (arms/)

| round | SHA | grok | antigravity |
|---|---|---|---|
| 4 | 785c9fc5 | FAIL: `cswarm toString` crashed (inherited verb lookup) | FAIL: claims refuted by direct runs; one RIGOUR folded |
| 5 | 121604b8 | FAIL: `cswarm file toString` crashed (inherited sub-action lookup) | FAIL (3 of 6 parts) on the same class |
| 6 | 6beba0d4 | PASS (3 RIGOUR) | PASS 5 of 6 parts; B1 FAIL refuted |

Round-6 rulings, verified directly: B1's "undeclared `setup guide` change" is declared (DECLARED-CHANGES.md, commit 3,
ruling 43c86116); "onboarding help is never printed" is false (`meta.help-flag` prints it); `check --hook --message-id`
matches main in both orders (direct run). RIGOUR folded in 7914eeca and 104e8eae: the DECLARED-CHANGES exit-code sentence
was false for six channel rows; a note on the unchanged `receive.status` rows; the one-lookup gate now also pins `traced()`
and the process entry (one `main().catch`, no top-level `process.argv` read); the baseline requires the table export;
SCAN.txt re-run. Declined with reasons: the shipped dispatch instrument (documented in README; no subscriber, no effect);
help-only argv rows (same class as `meta.bare`); host-session rows for refuse-profile entries (they record the old
dispatcher); a duplicate hook fixture (harmless); prose "asks and notes" in the quick guide (not command invocations; the
coverage inventory catches a removed entry). The RIGOUR folds changed the SHA after the clean pair; the pacing rule lands
RIGOUR folds without another pair.

## Gates at 8348ceb3

build 0; `npm test` 0 (878 pass); `test:p1-cli` 0 (781 pass) on the rerun; `check:tests` 0;
`scripts/build-release.sh` 0; `git diff --check` 0. The first `test:p1-cli` run had one failure, the check-budget timing
row "receive hook took 5185ms with 1200ms preload", at a host load average near 8.8; that row passed 3 of 3 alone on this
lane and 3 of 3 on main 9543527b, and the full rerun passed.

Mutations (CONTROLS.md), each failing for its named reason: inherited verb lookup; inherited sub-action lookup (360
baseline rows and the allowlist); Map or switch in `main()`; an argv intercept in the process entry; a Map intercept in
`traced()`; a top-level `process.argv` read; the table export removed; empty or wrong `resume.profile` help; `cswarm file
put` in SKILL.md; a derived profile list slice; an exported `runOnboardingCommand`.

## Not established

- `test:p1-server`, `test:p1-local`, and any live CLI run against a hosted workspace.
- Rounds 1-3 verdict details are not re-recorded here.
- MCP server work (lanes 2+) has not started.
