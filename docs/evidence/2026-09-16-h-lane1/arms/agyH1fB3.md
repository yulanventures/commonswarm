### Review: Part B3 of 6 — Command-Table Gate Test (`tests/p1-cli/command-table-gates.test.ts`)

#### Dependencies Not Directly Inlined
This part reviews only `tests/p1-cli/command-table-gates.test.ts`. Dependencies external to this test file that are validated in other parts of the lane review include:
1. `src/cli.ts` (the full `AGENT_COMMANDS` table, helper functions, and CLI runtime error handlers).
2. `src/cloud/agent-onboarding-contract.ts` (`AGENT_QUICK_GUIDE`).
3. `src/onboarding-cli.ts` (`onboardingUsage`).
4. `site/public/skills/cswarm/SKILL.md` and `site/src/components/connect/agent-prompt.ts` (read from disk in tests 3 and 4).
5. All `.ts` source files in `src/` (scanned recursively in test 10).

---

### Analysis of Gates and Dispatch Invariants

#### 1. Single Table Lookup & Strict Allowlist of `main()` (Test 8, lines 258–306)
- **Gate Check**: An AST visitor checks that `AGENT_COMMANDS` is accessed via `ElementAccessExpression` exactly once within `main()`. Furthermore, every statement in `main()` is compared statement-for-statement against the expected template using `ts.createPrinter({ removeComments: true })`.
- **Invariants Preserved**:
  - Meta-commands (`--version`, `-v`, bare `help`, `--help`, no positional) match the old dispatcher order and short-circuit prior to any table lookup.
  - Unknown command handling (`root === undefined`) preserves profile error semantics by invoking `args.expandAgentProfile("refuse", "drop")` before throwing `UsageError`.
  - Dispatch sequence is pinned: lookup $\rightarrow$ `selectCommandEntry` $\rightarrow$ `selectCommandVariant` $\rightarrow$ set `selectedCommandContext` $\rightarrow$ `args.expandAgentProfile` $\rightarrow$ `variant.handler(args)`.
  - No statements can be inserted or reordered in `main()` without failing the AST allowlist gate.

#### 2. Prototype Pollution & Own-Property Resolution (Test 9, lines 341–354)
- **Gate Check**: `selectCommandEntry` is pinned to require `Object.hasOwn(root.subcommands, action)`.
- **Invariants Preserved**:
  - Prevents the Round 5 regression where sub-action names matching `Object.prototype` properties (such as `toString`, `valueOf`, `constructor`) returned inherited prototype methods instead of command entries.
  - Non-existent subcommands and inherited prototype names reliably evaluate to `undefined` and fall back to `root.refusal`.

#### 3. Profile Expansion & Flag Consistency (Tests 6, 7, 9)
- **Gate Check**:
  - Test 6 enforces that any entry with `profile: "refuse"` must have `hostSessionId: "drop"` and neither `"profile"` nor `"host-session-id"` in `entry.flags`, whereas entries accepting profile (`"native"` or `"expand"`) must include both flags.
  - Schema consistency is enforced: `entry.argumentSchema.properties` must exactly match `["positionals", ...entry.flags]`, with `additionalProperties: false`.
  - Test 7 derives `AGENT_PROFILE_COMMANDS` directly from `profileListOrder` on `AGENT_COMMANDS`.
  - Test 9 pins `Arguments.expandAgentProfile`: profile validation runs before expansion, detecting conflicts (`--agent-token-file`, `--url`, etc.), resolving and dropping `--host-session-id` when `hostSessionId === "drop"`, and stripping `--profile`.

#### 4. Multi-Variant Command Shapes & Help Coverage (Tests 1, 2)
- **Gate Check**:
  - Test 1 ensures that every visible variant declared in `entry.variants` references a non-empty help line present in `usage()` or `onboardingUsage()`.
  - Test 2 enforces that all entries with $> 1$ variant (`setup`, `check`, `resume`, `inbox`, `accept`) are enumerated in `SELECTED_VARIANT_HELP_SHAPES`, ensuring no variant can be added, deleted, or misconfigured without an explicit help-shape mapping.

#### 5. Model-Facing Surfaces & Item-L Bridge (Tests 3, 4, 5)
- **Gate Check**:
  - Tests 3 & 5 extract all `cswarm` invocations from `AGENT_QUICK_GUIDE`, `SKILL.md`, and `agent-prompt.ts`, confirming that every model-facing command pair exists in `AGENT_COMMANDS` and is classified as a tool, bootstrap, or item-L CLI bridge.
  - Test 4 asserts that `brain put` remains on both model-facing surfaces and retains `CLI_ONLY_UNTIL_ITEM_L_REASON_MARKER` with `tool: null`.

#### 6. Deletion of Secondary Dispatcher (Test 10)
- **Gate Check**:
  - Recursively walks `src/` to confirm that `runOnboardingCommand` is neither exported as a function, variable, namespace re-export, named export, nor default export.

---

### Findings

No `PRODUCTION` or `RIGOUR` findings identified in this part. The test suite thoroughly enforces the table architecture, preserves baseline behaviour, and pins the AST of all intermediate dispatch functions against tampering or unintended regressions.

VERDICT: PASS The command-table gate test strictly verifies table metadata, own-property subcommand selection, profile expansion rules, documentation parity, and AST invariance of the dispatch sequence.
