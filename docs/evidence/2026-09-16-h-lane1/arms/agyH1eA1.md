### PRODUCTION Findings

#### Finding 1 (PRODUCTION): Subcommand group dispatch reads inherited `Object.prototype` properties, crashing on `cswarm <group> toString`

- **Diff Hunk**:
  ```ts
  @@ -8950,7 +8890,565 @@
  ...
  function selectCommandEntry(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
    if (!isCommandGroup(root)) return root;
    const action = root.choose(args);
    const entry = action === undefined ? undefined : root.subcommands[action];
    return entry ?? root.refusal;
  }
  ```
  (`src/cli.ts`, lines ~9306–9311)

- **Concrete Inputs**:
  - `cswarm file toString` (also `valueOf`, `constructor`, `hasOwnProperty`, `__proto__`, etc.)
  - `cswarm brain toString`
  - `cswarm hook toString`
  - `cswarm listen toString`
  - `cswarm receive toString`
  - `cswarm link toString`
  - `cswarm target toString`
  - `cswarm session toString`
  - `cswarm principal toString`

- **Discrepancy (Exit Code / Stderr)**:
  - **On `main`**:
    - `cswarm file toString`: Throws `UsageError("cswarm file takes put, ls, get, rm, or restore")`, caught by the CLI error handler, exiting with code `1` and formatting the usage error to `stderr`.
    - `cswarm brain toString`: Throws `UsageError("cswarm brain takes ls, get, or put")`, exiting with code `1` and formatting the error to `stderr`.
    - `cswarm hook toString`: Throws `UsageError("hook requires check, install, or uninstall")`, exiting with code `1` and formatting the error to `stderr`.
    - `cswarm listen toString`: Throws `UsageError("listen requires start, status, stop, or canary")`, exiting with code `1` and formatting the error to `stderr`.
  - **On Lane 1**:
    - `root.subcommands` is a plain JavaScript object literal (`Record<string, AgentCommandEntry>`) inheriting from `Object.prototype`.
    - When `action` is `"toString"` (or any `Object.prototype` property name), `root.subcommands[action]` does **not** evaluate to `undefined`; it resolves to `Object.prototype.toString` (a function).
    - `entry ?? root.refusal` therefore selects `Object.prototype.toString` instead of `root.refusal`.
    - `selectCommandVariant(entry, args)` then executes `const id = entry.select(args);`. Because `Object.prototype.toString.select` is `undefined`, it crashes with an uncaught runtime error:
      ```
      TypeError: entry.select is not a function
      ```
      exiting with code `1` and dumping a Node.js stack trace to `stderr` instead of printing the command group's usage/refusal message.

---

### RIGOUR Findings

#### Finding 2 (RIGOUR): Prototype-name baseline rows and gates omit subcommand groups

- **Diff Hunk**:
  ```ts
  @@ -8950,7 +8890,565 @@
  function selectCommandEntry(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
    if (!isCommandGroup(root)) return root;
    const action = root.choose(args);
    const entry = action === undefined ? undefined : root.subcommands[action];
    return entry ?? root.refusal;
  }
  ```
- **Analysis**:
  - The Round 4 fix addressed top-level verb lookups on `AGENT_COMMANDS` and added baseline rows verifying all `Object.prototype` member names at the root level (`cswarm toString`, `cswarm toString --json`, `cswarm toString --profile <path>`).
  - However, the baseline matrix generation and variant class generators only test declared `(entry, variant)` pairs and top-level prototype verbs. They do not generate test rows for `<group> <prototype-member>`.
  - Consequently, `npm test`, `test:p1-cli`, and `diff-check` all pass even though `selectCommandEntry` contains the exact same prototype lookup flaw on subcommands that broke top-level verbs in Round 4. Any future edit modifying subcommand selection will pass these gates while leaving subcommand prototype collisions uncaught. `selectCommandEntry` must guard lookup using `Object.hasOwn(root.subcommands, action)` or create `subcommands` with `Object.create(null)`.

---

### Unchecked Dependencies (Not Inlined in Part A1)

As specified in the prompt, Part A1 only provides the first half of `src/cli.ts` (up to `async function main()`). The following dependencies cannot be checked within Part A1:
1. **`src/cli.ts` (Part A2)**: The remainder of `main()`, specifically how `AGENT_COMMANDS` is looked up, how `errorMode` ("standard" | "onboarding" | "hook-check") handles errors, and the implementation of meta-command guards.
2. **Parts A2 through A6**: The test baseline harness commits, gating scripts, and diff-check rules.

---

VERDICT: FAIL - selectCommandEntry reads inherited Object.prototype members on subcommand groups (e.g. cswarm file toString), crashing with TypeError: entry.select is not a function instead of triggering the group's refusal.
