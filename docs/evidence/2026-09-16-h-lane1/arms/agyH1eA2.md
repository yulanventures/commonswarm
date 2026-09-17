### Inversion Review: Lane 1 (Round 5 — Part A2 of 6)

#### 1. Scope & Unchecked Dependencies (Per Instruction)
The following dependencies are located in other lane parts not inlined in Part A2 and could not be independently inspected:
- **Part A1**: The first half of `src/cli.ts` containing the `AGENT_COMMANDS` table declaration, entry schemas, reasons for `tool: null` entries, and the implementations of `selectCommandEntry` and `selectCommandVariant`.
- **Parts A3–A6**: The test files (`test:p1-cli`, `check:tests`, baseline harness updates in `test/`, and site integration tests).

Per review instructions, this part is not failed for the absence of these external components.

---

### Analysis of Part A2 Diff & Commit Structure

#### A. Commit Pipeline & Constraints Verification
1. **Mechanical Conversion in Exactly One Commit**: Satisfied (`45faf993 refactor: make the command table dispatch CLI routes`).
2. **Baseline and Deliberate Delta Separation**:
   - Baseline established in `c479769a`.
   - Deliberate changes isolated to `3736af0d` (`selected-error.*` JSON output changes and help text additions for `resume --profile`).
   - Gates added in `24dbc6cf`.
   - Line citations remapped in `121604b8`.
3. **Dispatch Flow & Single Table Lookup**:
   ```typescript
   @@ -9472,17 +9472,17 @@
   +  const root = Object.hasOwn(AGENT_COMMANDS, verb) ? AGENT_COMMANDS[verb] : undefined;
   +  if (root === undefined) {
   +    // The old dispatcher expanded profiles before its unknown-command refusal.
   +    await args.expandAgentProfile("refuse", "drop");
   +    throw new UsageError(`unknown command: ${verb}`);
   +  }
   +  const entry = selectCommandEntry(root, args);
   +  const variant = selectCommandVariant(entry, args);
   +  selectedCommandContext = { entry, variant, args };
   +  await args.expandAgentProfile(entry.profile, entry.hostSessionId);
   +  await variant.handler(args);
   ```
   - Top-level command lookup uses `Object.hasOwn(AGENT_COMMANDS, verb)`, preventing prototype pollution attacks (`toString`, `constructor`, `__proto__`, `valueOf`, `hasOwnProperty`, etc.) from resolving to inherited functions.
   - For unknown verbs, `args.expandAgentProfile("refuse", "drop")` preserves main's behavior of executing profile expansion refusal (printing the supported profile commands list) before `UsageError` is thrown.

#### B. Error Handling & Selected Context
In `if (isCliMain())`:
- **Onboarding Errors**: Evaluates `selected?.entry.errorMode === "onboarding" && selected.args.has("json")`, matching the declared baseline rows where flags preceding verbs are normalized by `args`.
- **Hook Check Exemption**:
  ```typescript
  +    if (
  +      selected?.entry.errorMode === "hook-check" &&
  +      selected.args.startsWithLeadingPositionals("hook", "check")
  +    ) {
  +      process.exitCode = 0;
  +      return;
  +    }
  ```
  Using `startsWithLeadingPositionals("hook", "check")` precisely matches main's index check (`process.argv[2] === "hook" && process.argv[3] === "check"`), ensuring flags before `hook check` do not inadvertently swallow exit codes.
- **WorkspaceCliError & FileCommandRefused**: Evaluates `selected?.entry.workspaceErrorJson === true && selected.args.has("json")` and `selected?.args.has("json")`, cleanly decoupling error formatting from raw `process.argv` indices.

---

### Findings

No `PRODUCTION` or `RIGOUR` defects were identified in the Part A2 changes. The prototype resolution vulnerability from Round 4 is resolved via `Object.hasOwn`, profile expansion ordering mirrors main across all dispatch paths, and the error catcher correctly references the selected command entry context.

VERDICT: PASS
The dispatcher conversion in Part A2 strictly preserves dispatch behavior, resolves prototype-lookup edge cases with `Object.hasOwn`, and enforces the required single-lookup architectural discipline.
