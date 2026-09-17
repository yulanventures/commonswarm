# H lane 1 mutation controls

Each mutation was applied alone. A Bash command printed the changed source line
before it ran the named test. Each mutation was then restored byte for byte;
the restored SHA-256 matched the pre-mutation SHA-256.

| applied mutation | result |
|---|---|
| Added `new Map().get(verb)` before the table lookup | AST allowlist failed on 7 pre-lookup statements. |
| Added `switch (verb)` before the lookup | AST allowlist failed on 7 statements. |
| Added `includes(verb)` before the lookup | AST allowlist failed on 7 statements. |
| Added `preLookupDispatch(args)` before the lookup | AST allowlist failed on 7 statements. |
| Aliased `verb` to `routedVerb` and compared the alias | AST allowlist failed on 8 statements. |
| Added `switch (verb)` after the table lookup | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Aliased `AGENT_COMMANDS` after the lookup and evaluated `T[verb]` | Whole-`main()` AST allowlist failed on 15 statements instead of 13. |
| Wrapped the table lookup in `if (verb)` | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Made the selected `resume.profile` variant's help array empty | Variant help gate failed: `resume.profile has no help line`. |
| Removed the printed `cswarm resume --profile` line | Variant help gate failed: the declared marker was missing. |
| Replaced a variant's help marker with only `cswarm` | Help-line resolver failed because the marker did not identify one whole command line. |
| Returned undeclared ID `undeclared` from the check selector | `npm run build` failed with TS2322 against the closed variant-key union. |
| Added model copy naming `cswarm file put` | Pair gate failed because `file.put` is neither a tool nor bootstrap, despite the sibling `file.ls` tool. |
| Added model copy naming `npm test` | Pair gate stayed green, proving non-`cswarm` code spans are ignored. |
| Added exported `runOnboardingCommand` as a function declaration | Deleted-dispatcher gate failed. |
| Added exported `runOnboardingCommand` as a const arrow | Deleted-dispatcher gate failed. |
| Re-exported `runSetupGuide as runOnboardingCommand` | Deleted-dispatcher gate failed. |
| Added `export default runOnboardingCommand` under `src/` | Recursive deleted-dispatcher gate failed on the exact file. |
| Made refuse-mode flags include `profile` | Flag-policy gate failed on `__listen-supervisor`. |
| Removed the login `tool: null` reason | `npm run build` failed with TS2345 because `reason` is required. |
| Set the login reason to an empty string | Metadata gate failed: `login tool:null reason is empty`. |
| Changed `check` from native profile handling to expansion | Baseline failed the valid check profile rows with `unknown option: --agent-token-file`. |
| Routed every resume invocation to inspect | Baseline failed `resume.profile`: wrong handler, exit code, stdout, and stderr. |
| Swapped the receive configure and status handlers | Baseline failed both rows and named the wrong specific handler in each. |
| Removed the `members` entry | Baseline failed the command and every derived supported-profile sentence containing `members`. |
| Removed the first derived profile command with `.slice(1)` | Derivation gate failed with missing `whoami`. |

Round 3 added these controls. Each showed the applied source line or replacement,
returned a nonzero test exit code, and restored the original SHA-256:

| applied mutation | result |
|---|---|
| Added `if (verb === "x")` before the table lookup | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Added `if (verb === "x")` after the table lookup | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Added `if (args.positionals[0] === "x")` before the table lookup | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Added `if (args.positionals[0] === "x")` after the table lookup | Whole-`main()` AST allowlist failed on 14 statements instead of 13. |
| Added the measured `whoami` branch inside `selectCommandEntry()` | Selection-helper allowlist failed on its statement count. |
| Added a positional verb branch inside `selectCommandVariant()` | Selection-helper allowlist failed on its statement count. |
| Removed the item-L marker from the `brain.put` reason | Model-facing gate failed because `cswarm brain put` was no longer a tool, bootstrap command, or derived CLI-only-until-item-L entry. |
| Added model copy naming `cswarm --profile p token mint` | Pair gate parsed `token mint` past the leading flag and failed because the entry is not in an allowed model-facing category. |
| Added `export const { runOnboardingCommand } = x` | Deleted-dispatcher gate found the binding export. |
| Added `export * as runOnboardingCommand from ...` | Deleted-dispatcher gate found the namespace export. |
| Changed only `whoami` from `EXPAND_PROFILE` to `EXPAND_PROFILE_KEEP_HOST` | Full baseline failed; the generated `policy.host-session.whoami` row no longer matched after `--host-session-id` reached `runWhoami`. |

After restoration, the dispatch baseline and all eight command-table tests pass.

Round 4 added these controls. Each mutation was applied alone, confirmed in the
source, run with closed stdin, and restored byte for byte:

| applied mutation | result |
|---|---|
| Restored inherited `AGENT_COMMANDS[verb]` lookup | All generated `Object.prototype` verb rows failed with `entry.select is not a function`. |
| Pointed `resume.profile` help at `cswarm resume --agent-token-file` | Selected-variant help-shape gate failed on `resume.profile`. |
| Removed `cswarm brain put <topic> <markdown-path>` from `SKILL.md` | Item-L bridge gate failed on the missing skill surface. |
| Added a `whoami` positional branch inside `expandAgentProfile()` | Parsed-argument function allowlist failed on the extra statement. |

Round 5 added this control. The mutation was applied alone (source SHA-256
prefix `707993bf350b25cf` to `71208bec56e45c2c`), run with closed stdin, and
restored to `707993bf350b25cf`:

| applied mutation | result |
|---|---|
| Restored inherited `root.subcommands[action]` lookup in `selectCommandEntry()` | Parsed-argument allowlist failed with `selectCommandEntry statement 3 is not allowlisted`. The dispatch baseline failed on 360 `refusal.prototype-sub-action.*` rows with `entry.select is not a function`; the 180 rows of `token`, `invite`, `member`, `grant`, and `workspace` did not fail because those selectors map an unknown action to a declared sub-action. Direct runs printed the same error for `file toString`, `channel toString`, and `brain constructor`. |

Round 6 added these controls (grok round 6: the one-lookup gate did not watch
the process entry or `traced()`; antigravity round 6: the coverage inventory
fell back silently when the table was not exported). Each mutation was applied
alone, run with closed stdin, and `src/cli.ts` was restored to SHA-256 prefix
`549931c7786202d1`:

| applied mutation | result |
|---|---|
| `if (process.argv[2] === "ask") process.exit(2);` inside `if (isCliMain())` | Entry gate failed: `the isCliMain() entry must hold only main().catch(...)`. |
| A handler-name `Map` intercept inside `traced()` | Parsed-argument allowlist failed: `traced statement count changed`. |
| Top-level `const argvVerb = process.argv[2];` | Entry gate failed: `top-level statements read process.argv at src/cli.ts lines 9568`. |
| `export const AGENT_COMMANDS` made non-exported | Dispatch baseline failed: `AGENT_COMMANDS must be exported from src/cli.ts`. |
