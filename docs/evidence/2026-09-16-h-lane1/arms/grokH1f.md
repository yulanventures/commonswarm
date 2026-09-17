I'll start by reading the commit messages and the Lane 1 spec, then compare main vs this SHA myself. No other agents, no production contact.Commit history is in place. Next I’ll pull the Lane 1 spec text and the declared-change docs so I can compare main vs this SHA.I'll set up a main worktree for side-by-side CLI runs and read the declared-change docs plus the dispatcher.Worktrees are ready. I’ll build both CLIs and start reading the dispatcher, gates, and baseline.I’ll start the official gates, then run direct CLI comparisons on routes the baseline does not cover.npm test is still running. I’ll inspect hook-check error handling and start direct CLI comparisons on routes the baseline misses.Handler bodies look like a move. Next I’ll run direct CLI comparisons and inspect commit 1, the shipped bundle, and check-budget parity.I’ll write a direct CLI comparison runner and start the gate mutations.npm test passed. I’ll start the other gates and the mutation checks while the CLI comparison finishes.Gates failed as claimed. I’ll probe for a stay-green dispatch hole, inspect the shipped bundle, and start `test:p1-cli`.`test:p1-cli` had one wall-clock miss in the hook deadline test. I’ll read the bound, then rerun that file alone.No undeclared behaviour change. Direct CLI runs on a temp HOME and a loopback origin matched main, except the rows commit 2 and commit 3 already name.

## PRODUCTION

None undeclared.

These are declared, spec-required, and I re-ran them on `dist/cli.js` (main `9543527b` vs lane `6beba0d4`):

| argv | main | lane | required by |
|---|---|---|---|
| `channel toString` / `constructor` (plain, `--json`, valid `--profile`) | exit 0, empty | exit 1, `cswarm channel takes create, ls, rename, or archive` plus usage | commit 2; same bytes as `channel not-an-action` |
| `channel __proto__` / `valueOf` / `hasOwnProperty` | TypeError on stderr | same channel refusal | commit 2 |
| `file get\|rm\|restore --profile P -- --json` | refusal JSON on stdout | `cswarm: file list failed (HTTP 400)` on stderr | commit 3; `--json` after `--` is a file name |
| `file get --json -- --json` | JSON on stdout | JSON on stdout (unchanged control) | commit 3 |
| `--json check --profile P --force`, `--json setup`, `--json receive` | text on stderr | onboarding JSON on stdout | spec: error handling reads the selected entry, not `process.argv[2]` |
| `--help` / bare / `--json` | old check one-liner | split check lines + `cswarm resume --profile` | variant help gate |
| `setup guide` | unqualified verbs | `cswarm working-on` / `reply` / `brain put` / `check` | item L ruling |

A script that parsed stderr for `--json` before `check`/`setup`/`receive`, or JSON for `file … -- --json`, will see a different stream. That is the spec change, not a miss.

`file toString`, `brain constructor`, `receive toString`, `listen toString`, `token toString` matched main (exit 1). Round 5’s inherited lookup is gone: `src/cli.ts:9423` uses `Object.hasOwn(root.subcommands, action)`.

Check-budget on both SHAs: `runHook` bodies equal (3960 bytes), `runTurnHook` / `exitTurnHookProcess` equal, `src/cloud/agent-check-budget.ts` diff 0, help both say `hook check has its own 3.9s ceiling` (`src/cli.ts:966`). Hard exit still `src/cli.ts:7872-7874` and `src/onboarding-cli.ts:77-79,106-109`.

## RIGOUR

1. **One-lookup AST gate does not watch the process entry.** I inserted `if (process.argv[2] === "ask") process.exit(2)` inside `if (isCliMain())` before `main().catch` at `src/cli.ts:9568`. Confirmed in source. `command-table-gates.test.ts` stayed 10 pass / 0 fail. A `new Map` inside `traced()` (`src/cli.ts:9074`) also stayed green. Map/switch **inside** `main()` failed as claimed (`main() statement count changed: 14 !== 13` at gates test `:300`). The 1248-row baseline would still catch a real intercept. The AST rule does not.

2. **The dispatch instrument ships.** `src/dispatch-trace.ts` is imported by `dist/cli.js:3` and bundled into `dist-release/cswarm` (`commonswarm.cli.dispatch` at the esbuild `src/dispatch-trace.ts` chunk). `package.json` `files: ["dist"]` therefore ships `dist/dispatch-trace.js`. No subscriber ⇒ `publish` is a no-op. A user `--import` preload can activate it. Commit 1 added the same `recordDispatch("…")` names the conversion later wraps with `traced()`; the baseline preload is only `tests/fixtures/dispatch-trace-preload.mjs` (not in `dist/`).

3. **Help-only argv not named as rows.** `cswarm --`, `cswarm --json --json`, and `cswarm --json --profile P` print help (no positional). Stdout differs only by the declared check/resume help lines. Same class as `meta.bare`.

## 1. Behaviour (routes the 1248-row baseline does not name)

Direct `node dist/cli.js` in a throwaway HOME, `XDG_CONFIG_HOME`, `SWARM_CLOUD_URL=http://127.0.0.1:<port>`. 183 argv first pass, then a valid-credential pass for profile/file/channel.

Matched main, including: extra positionals (`whoami extra`, `token mint extra`, `help extra`, `hook check extra extra`); flag before a non-onboarding verb (`--json whoami`, `--json token mint`); flag between verb and action (`file --json ls`, `hook --json check`); `--version`/`-v` after a verb; `--json -v`; `resume` vs `resume --profile`; `check --profile`; `hook check` / extra / `--json hook check extra`; token/invite/member/grant unknown mapping; `--host-session-id` keep (`listen`/`session`) vs drop (`whoami`/`file`); `token toString`.

First credential fixture used a short `message` field, so some `--profile` routes died in the parser on **both** SHAs. Second pass used the minted message string. Channel prototype and terminator-json then showed the declared diffs only.

Harness note: the baseline spawn uses `--import tsx --import preload` plus `normalize()`. Direct `dist/cli.js` does not. Agreement was not a harness artefact.

## 2. Commit 2 is a move

`a0a76ff8` vs parent `4ed1d6ae`. Inner handler bodies equal (`runListenStart`, `runChannelCreate`/`Ls`/`Rename`/`Archive`, `runFile*`, `runBrain*`, `runLinkNew`/`Revoke`). `runLogin`/`runLogout` match the old `main()` blocks. Deleted wrappers (`runChannel`, `runFile`, `runBrain`, `runListen`, `runLink`) become `choose` + `Object.hasOwn`. Baseline JSON: 36 channel prototype rows only; exit-code changes are the six `toString`/`constructor` axes (0→1). `AGENT_PROFILE_COMMANDS` moves from `agent-onboarding-contract.ts` to table `profileListOrder` (`src/cli.ts:9382`).

Position behaviour is table data: `expandAgentProfile(profileMode, hostSessionId)` at `src/cli.ts:734`; `check`/`setup`/`receive`/`resume --profile` are `native` so they never hit expand.

## 3. Commit 3

129 baseline rows, **0 exit-code changes**, 0 handler-name changes. Classes match `DECLARED-CHANGES.md` (selected-entry JSON, three terminator-json file refusals, help split, `setup.guide`). Inbox `notify`/`follow` axes unchanged. Control `refusal.file-refused.flag-and-terminator-json.get` unchanged. Direct runs match the doc.

JSON-on-stdout for `--json` before `check`/`setup`/`receive` is what the spec sentence asks for. Terminator `--json` as a file name is correct for that user.

## 4. Gates (mutation applied, then restored; SHA-256 matched)

| mutation | applied | result |
|---|---|---|
| `new Map(Object.entries(AGENT_COMMANDS)).get(verb)` before lookup | `src/cli.ts:9475` | fail: `main() statement count changed: 14 !== 13` (`command-table-gates.test.ts:300`) |
| `switch (verb)` before lookup | `:9475` | same 14 !== 13 |
| empty `resume.profile` help | `:9194` | fail: `resume.profile has no help line` (`:80`) and shape gate (`:103`) |
| `cswarm file put` in SKILL.md | skill line 16 | fail: pair is not tool/bootstrap/item-L (`:172`); item-L bridge (`:185`) |
| `.slice(1)` on derived profile list | `:9389` | fail: missing `whoami` (`:251`) |
| `export async function runOnboardingCommand` | `onboarding-cli.ts:245` | fail: deleted-dispatcher (`:449`) |
| drop `Object.hasOwn` on subcommands | `:9423` | fail: `selectCommandEntry statement 3 is not allowlisted` (`:343`) |

Stay-green: `isCliMain()` interceptor and `traced()` Map (above). Restored to `549931c7786202d1cff957eecf76ea33fbe0d948787b2a5e850981b66dcfa1b3`.

## 5. Instrument

Same `recordDispatch` + `diagnostics_channel` on both sides of the conversion. Commit 1 records against the unmodified `if (verb === …)` chain plus those calls. Shipped CLI **contains and loads** it. Preload is test-only.

## 6. Commit messages vs tree

| claim | tree |
|---|---|
| 1248 rows, 600 s | `command-dispatch-baseline-counts.json` total 1248; test timeout `600_000` at `command-dispatch-baseline.test.ts:734` |
| commit 2 changes 36 channel prototype rows | counted 36; other prototype groups unchanged |
| commit 3 129 rows, exit codes kept | 129 changed, 0 exit-code diffs |
| citations remapped | all 7 new `cli.ts` lines contain the cited strings |
| `tool: null` has `reason` | `noTool(reason)` at `:9179`; `brain.put` uses the item-L marker template at `:9328` |

## Official gates

| command | result |
|---|---|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | **878 pass, 0 fail**, exit 0 (first run, `/tmp` worktree) |
| `env -u FORCE_COLOR npm run test:p1-cli` | first run: 779 pass, 1 fail, exit 1 |
| `npm run check:tests` | 0 |
| `git diff --check 9543527b...6beba0d4` | 0 |
| `bash scripts/build-release.sh` | 0 (`version 0.1.71` verified on the artifact) |

`test:p1-cli` failure: `hook hard deadline … took 5033ms` vs 5000 ms ceiling (`hook-routing.test.ts:58,1615`), while `npm test` was also running. Isolated rerun: **pass, 4952 ms, exit 0**. `runHook` is byte-identical to main. Not a lane dispatch bug.

A second `npm test` on the review tree under that load hit the known flake `tests/support/host-stderr-exit-parity.ts` (`failure took 1327 ms`) plus a `host-acp-claude` handshake. Isolated rerun of the flake file: **pass, exit 0**. First `npm test` was already 878/878.

Baseline test itself passed (`the command dispatcher matches the recorded behavior baseline (303259 ms)`).

Did not run `test:p1-server`, `test:p1-local`, or any `db:` script. Did not contact production. Worktrees `/tmp/d036-main-9543527b` and `/tmp/d036-lane-6beba0d4` removed.

VERDICT: PASS — conversion is a move; undeclared argv matched main; declared stdout/stderr shifts match the spec; claimed gates fail; check-budget matches main.
