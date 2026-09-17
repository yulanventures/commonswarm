I'll review this lane as a D-036 exact-review arm: read the spec and commits first, then attack behaviour, the move, declared changes, gates, and the baseline instrument. No other agents, no production contact.Commit messages match the five-commit shape. Next I’ll pull Lane 1 from the spec and map the dispatcher, declared rows, and gates.Lane 1 is the table-as-dispatcher. I’ll map the five commits, declared rows, and lookup shape, then run main vs this SHA on routes the baseline does not cover.I have the table and `main()` lookup. Next I’ll set up a main worktree and read the baseline coverage so I can run routes it does not pin.Commit 2 looks like a dispatcher move plus a few extracted handlers. I’ll pin those bodies against main and stand up a main worktree for live CLI comparison.Subcommand lookup may still inherit `Object.prototype` — that is the round-4 bug one level down. I’ll run those routes against main and inspect the rest of the conversion.I’ll run a direct main-vs-lane CLI matrix next: prototype subcommands, flag-before-verb, extra positionals, and the other uncovered routes.The full matrix is still running. I’ll prove the subcommand prototype lookup in-process and keep reading commit 2, the instrument, and the gates.Direct runs show the round-4 bug on nested tables: `cswarm file toString` becomes `entry.select is not a function`. I’ll pin more of those routes, then run gates and mutations.Nested `subcommands[action]` still inherits `Object.prototype`; that is a production break. I’ll run the named gates next, then mutate each gate and restore.Named gates are green. Next I’ll mutate each one, confirm the edit landed, then restore.Round 4 fixed top-level `AGENT_COMMANDS[verb]` with `Object.hasOwn`. Nested `root.subcommands[action]` still reads `Object.prototype`. That is a behaviour change versus main, not in commit 3’s named rows, and not in the baseline.

## PRODUCTION

**1. Nested command lookup inherits `Object.prototype`. Unknown sub-actions that collide with those names no longer refuse the same way as main.**

`src/cli.ts:9475` uses own-property lookup for the verb:

```9475:9475:src/cli.ts
  const root = Object.hasOwn(AGENT_COMMANDS, verb) ? AGENT_COMMANDS[verb] : undefined;
```

`src/cli.ts:9420-9425` does not:

```9420:9425:src/cli.ts
function selectCommandEntry(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
  if (!isCommandGroup(root)) return root;
  const action = root.choose(args);
  const entry = action === undefined ? undefined : root.subcommands[action];
  return entry ?? root.refusal;
}
```

In-process on this SHA, every group’s `subcommands` object inherits `toString`, `constructor`, `valueOf`, `hasOwnProperty`, `__proto__`, and the other `Object.getOwnPropertyNames(Object.prototype)` names. `choose()` for `file`, `brain`, `channel`, `listen`, `hook`, `session`, `link`, `principal`, `target`, and `receive` returns the raw positional, so those names become the “entry”. `selectCommandVariant` then throws `entry.select is not a function`.

Direct runs, temporary `HOME` / `XDG_CONFIG_HOME`, `SWARM_CLOUD_URL=http://127.0.0.1:9`, `node --import tsx src/cli.ts`, main `4cb8c5fe` vs lane `121604b8`:

| argv | main exit / stderr | lane exit / stderr |
|---|---|---|
| `file toString` | 1 / `cswarm file takes put, ls, get, rm, or restore` + `usage()` | 1 / `cswarm: entry.select is not a function` |
| `file constructor` | 1 / same usage refusal | 1 / `entry.select is not a function` |
| `file hasOwnProperty` | 1 / same | 1 / `entry.select is not a function` |
| `file __proto__` | 1 / same | 1 / `entry.select is not a function` |
| `file valueOf` | 1 / same | 1 / `entry.select is not a function` |
| `brain toString` | 1 / `cswarm brain takes ls, get, or put` + `usage()` | 1 / `entry.select is not a function` |
| `hook toString` | 1 / `hook requires check, install, or uninstall` + `usage()` | 1 / `entry.select is not a function` |
| `listen constructor` | 1 / `listen requires start, status, stop, or canary` + `usage()` | 1 / `entry.select is not a function` |
| `session toString` | 1 / `session requires start, status, stop, enable, disable, or recover` + `usage()` | 1 / `entry.select is not a function` |
| `target toString` | 1 / `unknown target command: toString` | 1 / `entry.select is not a function` |
| `receive toString` | 1 / `Run cswarm --help for receive commands.` | 1 / `entry.select is not a function` |
| `principal toString` | 1 / `unknown principal command: toString` | 1 / `entry.select is not a function` |
| `link toString` | 1 / `unknown link command: toString` + `usage()` | 1 / `entry.select is not a function` |
| `channel constructor` | **0 / empty** | **1 / `entry.select is not a function`** |
| `channel toString` | **0 / empty** | **1 / `entry.select is not a function`** |

`channel` on main already used `CHANNEL_SUBCOMMANDS[action]` (`c479769a` `runChannel`). That inherited `Object.prototype.toString`, called it, discarded the string, and exited 0. The conversion changes that to a TypeError and exit 1.

`token` / `invite` / `member` / `grant` still match main, because `choose()` maps unknown actions onto a real subcommand and the old handler still rejects. `cswarm token toString` is `unknown token command: toString` on both.

Top-level round-4 rows still match: `cswarm toString` is `unknown command: toString` + `usage()` on both.

This class is not in the baseline. `prototypeVerbFixtures()` only puts prototype names in argv[0].

**2. Commit 2 is a move of handler bodies, but it loses if-chain behaviour that lived in position.**

Deleted wrappers on `45faf993` (`runFile`, `runBrain`, `runListen`, `runHook` path, `runLink`, `runPrincipal`, `runTarget`, `runChannel`) were `if (action === "put")` chains. Unknown names fell through to `UsageError`. The table lookup is not the same for inherited names. `runLogin` / `runLogout` bodies match the old `main()` branches. `runAsk` and the other leaf handlers did not change.

## Commit 3 (declared rows)

Required by the spec sentence “error handling reads the SELECTED ENTRY, never raw `process.argv`”. Measured `--json setup guide` and `--json check --hook …`: exit 1 both sides; main writes the refusal on stderr, lane writes onboarding JSON on stdout. That is a script-visible stream change, and it is named. For a caller who passed `--json`, JSON on stdout is the selected-entry behaviour.

Resume help line and split `check` lines are in `onboardingUsage()` (`src/onboarding-cli.ts:32-35`). `setup.guide` now prints `cswarm working-on`, `cswarm reply`, `cswarm brain put`, `cswarm check` (`src/cloud/agent-onboarding-contract.ts:44`). That matches the Strategist ruling. `SKILL.md:16` still has `cswarm brain put <topic> <markdown-path>`.

Bare `--json` / `--help` stdout also grows those onboarding lines. Same help function as the named `meta.*` rows, not a second dispatcher change.

## Gates

`npm run build` 0. `env -u FORCE_COLOR npm test` 878 pass, 0 fail, exit 0. `env -u FORCE_COLOR npm run test:p1-cli` 768 pass, 0 fail, exit 0. `npm run check:tests` 0. `git diff --check 4cb8c5fe...121604b8` 0. `bash scripts/build-release.sh` 0 (artifact reported 0.1.71). No `host-stderr-exit-parity` flake.

Mutations, each SHA-256 changed, then restored byte-for-byte. None stayed green:

| mutation | applied | gate result |
|---|---|---|
| `new Map(...).get(verb)` before the table lookup | `src/cli.ts:9475` | `main() statement count changed: 14` vs 13 |
| `switch (verb)` before the lookup | `src/cli.ts:9475` | same 14 vs 13 |
| empty `resume.profile` help | yes | `resume.profile has no help line` |
| `resume.profile` help pointed at `--agent-token-file` | yes | `resume.profile help does not match its command shape: --profile` |
| `SKILL.md` names `cswarm file put` | yes | pair is neither tool, bootstrap, nor item-L |
| `AGENT_PROFILE_COMMANDS` `.slice(1)` | yes | derivation gate missing `whoami` |
| exported `runOnboardingCommand` | `src/onboarding-cli.ts:113` | deleted-dispatcher gate |

**RIGOUR:** the select-helper allowlist pins the inherited lookup. Changing `src/cli.ts:9423` to `Object.hasOwn(root.subcommands, action)` fails `selectCommandEntry statement 3 is not allowlisted` (`tests/p1-cli/command-table-gates.test.ts:343`, expected the old `root.subcommands[action]` line). A plausible fix of this PRODUCTION bug fails the gate until that allowlist changes.

## Instrument

`src/dispatch-trace.ts` is unchanged from commit 1 through `121604b8`. `tests/fixtures/dispatch-trace-preload.mjs` is unchanged. Same `diagnostics_channel` name `commonswarm.cli.dispatch` on both sides of the conversion.

It ships. `package.json` `files: ["dist"]`. `dist/cli.js` imports `./dispatch-trace.js`. `scripts/build-release.sh` bundles it: `dist-release/cswarm` contains `commonswarm.cli.dispatch` and `recordDispatch`. The preload is not in the bundle. With no subscriber, publish is a no-op. A subscriber in-process can still see handler names.

Harness placeholder replace uses `Object.hasOwn(replacements, value)` (`tests/p1-cli/command-dispatch-baseline.test.ts:614`). Direct `toString` as a verb was not rewritten. Direct `file toString` is outside the harness.

## Commit messages vs tree

Five commits, one conversion commit (`45faf993`). Every `tool: null` entry has a non-empty `reason`. Citation remap lines at HEAD contain the cited strings.

**RIGOUR:** commit 3 also switched `FileCommandRefused` from `process.argv.includes("--json")` to `selected?.args.has("json")` (`src/cli.ts:9635`) and did not name that class. I did not fire a `FileCommandRefused` on both SHAs, so I did not measure a live stdout/stderr split there.

**RIGOUR:** `npm test` does not run `command-table-gates.test.ts` or the baseline file. `test:p1-cli` does. That matches the existing script split.

Uncovered routes that **matched** main (same exit, stdout, stderr): `hook check extra`; `resume --profile` / `check --profile` with a missing profile; `--version` / `-v`; `token mint` / `token revoke`; `--json whoami`; `--json token mint`; `whoami extra`; `file ls extra`; `--json file ls` without a credential; `--host-session-id hid whoami`.

Not established: `test:p1-server`, `test:p1-local`, any database, any non-loopback host.

VERDICT: FAIL Nested `subcommands[action]` still inherits Object.prototype, so `cswarm file toString` (and the same class on brain/hook/listen/session/target/receive/principal/link/channel) no longer matches main.
