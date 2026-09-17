### Independent INVERSION Review (Gemini Family) — Part A2 of 6

**Scope:** Item H lane 1 (`6beba0d41dc3a3f44b3ee574fdbcd143c7e7b0b1` on `main` `9543527b10f308e932f98f9124da7f95fa63e26f`). All 5 commit messages and the second half of the `src/cli.ts` diff (`main()` dispatch table routing and `isCliMain()` error handling).

---

### 1. Unchecked Dependencies (Separate Calls)
As instructed, the following components outside Part A2 are noted as unverified in this call:
- **Part A1 (`src/cli.ts` first half):** Declaration and definitions of `AGENT_COMMANDS`, `selectCommandEntry`, `selectCommandVariant`, `selectedCommandContext`, and command-specific handlers/wrappers.
- **`src/onboarding-cli.ts`:** Deletion of `runOnboardingCommand`, onboarding turn-hook hard exit, and hook check deadlines.
- **Gate / Test Artifacts (Parts B–F):** `DECLARED-CHANGES.md`, `CONTROLS.md`, baseline test suites (`test:p1-cli`, etc.).

---

### 2. Analysis of Part A2 Changes

#### A. Commit Structure and Declared Changes
- **Commit sequence:** 5 distinct commits adhering strictly to the contract:
  1. `4ed1d6ae`: baseline recording (1248 rows, including prototype property rows and terminator `--json`).
  2. `a0a76ff8`: mechanical table dispatch conversion (declaring exactly the 36 `cswarm channel <prototype>` rows).
  3. `ac350dd0`: entry-driven error handling (declaring the 129 rows: flag-before-verb onboarding/workspace errors, file refusal terminator `--json`, help text for `cswarm resume --profile`, and guide phrases).
  4. `ae8f0505`: gate structure and allowlist pinning `Object.hasOwn` lookup.
  5. `6beba0d4`: citation remapping.
- **Prototype lookup fold (Round 5 fix):** `root.subcommands` lookup is now guarded by `Object.hasOwn(root.subcommands, action)`. This prevents `toString`, `valueOf`, `constructor`, etc. on closed groups from throwing `TypeError: entry.select is not a function`.

#### B. Main Dispatcher Replacement (`src/cli.ts` @@ -8974,180 +9472,17 @@)
```typescript
  const root = Object.hasOwn(AGENT_COMMANDS, verb) ? AGENT_COMMANDS[verb] : undefined;
  if (root === undefined) {
    // The old dispatcher expanded profiles before its unknown-command refusal.
    await args.expandAgentProfile("refuse", "drop");
    throw new UsageError(`unknown command: ${verb}`);
  }
  const entry = selectCommandEntry(root, args);
  const variant = selectCommandVariant(entry, args);
  selectedCommandContext = { entry, variant, args };
  await args.expandAgentProfile(entry.profile, entry.hostSessionId);
  await variant.handler(args);
```
- **Single table lookup:** Exactly one table lookup (`Object.hasOwn(AGENT_COMMANDS, verb)`) is performed before routing.
- **Prototype safety on root verbs:** Calling `cswarm toString` or `cswarm constructor` correctly resolves `root === undefined`, runs `expandAgentProfile("refuse", "drop")`, and throws `UsageError: unknown command: <verb>`, identical to `main`.
- **Profile expansion timing:** Profile expansion is performed with `entry.profile` and `entry.hostSessionId` *after* entry/variant selection, preserving the distinction for `resume --profile` (snapshot variant) and `check --profile` (native).

#### C. Error Handling Refactor (`src/cli.ts` @@ -9232,14 +9567,18 @@ and @@ -9257,22 +9596,8 @@)
- **Onboarding error routing:**
  ```typescript
  const selected = selectedCommandContext;
  if (selected?.entry.errorMode === "onboarding" && selected.args.has("json")) {
  ```
  Error routing reads from `selected.entry.errorMode` and `selected.args.has("json")`, eliminating raw `process.argv` inspections while ensuring all declared rows in `ac350dd0` (such as `refusal.flag-before.check` and `selected-error.*.json-before`) output JSON on stdout with exit 1.
- **Hook check error suppression:**
  ```typescript
  if (
    selected?.entry.errorMode === "hook-check" &&
    selected.args.startsWithLeadingPositionals("hook", "check")
  ) {
    process.exitCode = 0;
    return;
  }
  ```
  This preserves the requirement that `hook check` suppresses failures when run as a git hook (leading positionals `hook check`). Non-leading positionals or flags before verbs (e.g. `cswarm --profile foo hook check`) do not trigger silent exit 0, preserving old behavior.
- **WorkspaceCliError:**
  ```typescript
  const json = selected?.entry.workspaceErrorJson === true &&
    selected.args.has("json");
  ```
  Correctly derives JSON formatting eligibility from the table entry property `workspaceErrorJson` instead of the hardcoded verb list in `process.argv[2]`.
- **FileCommandRefused:**
  ```typescript
  if (selected?.args.has("json")) {
  ```
  Derives `--json` presence from parsed arguments (`selected.args.has("json")`), so `--json` after the `--` terminator is treated as a file argument rather than a flag, correctly matching the declared change for `refusal.file-refused.terminator-json.*`.

#### D. Check-Budget Lane Landing
- Rebase onto `9543527b` correctly updated the baseline in Commit 1 for the "3.9s ceiling" usage line (301 rows).
- Hook check deadline and error exit handling retain exit code 0 under the new dispatch error handler.

---

### 3. Findings

No undeclared discrepancies, behavioural regressions, or gate evasions were identified in the Part A2 changes.

---

VERDICT: PASS
The Part A2 dispatcher conversion in `src/cli.ts` strictly preserves command routing and error semantics, adheres to the single-lookup rule, safely guards prototype properties, correctly implements entry-based error handling, and accounts for all declared differences against main `9543527b`.
