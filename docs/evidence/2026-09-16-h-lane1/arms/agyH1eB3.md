### Dependencies Not Inlined

As Part B3 of 6 contains only `tests/p1-cli/command-table-gates.test.ts`, the following external dependencies imported or read by the test file are not inlined and cannot be directly inspected:
- `src/cli.ts` (full implementation of `AGENT_COMMANDS`, `AGENT_PROFILE_COMMANDS`, `CLI_ONLY_UNTIL_ITEM_L_REASON_MARKER`, `agentToolsForTransport`, `usage`, `Arguments`, etc.)
- `src/cloud/agent-onboarding-contract.js` (`AGENT_QUICK_GUIDE`)
- `src/onboarding-cli.js` (`onboardingUsage`)
- `site/public/skills/cswarm/SKILL.md`
- `site/src/components/connect/agent-prompt.ts`

---

### Findings

#### [PRODUCTION] Prototype property lookup on grouped command subcommands crashes with unhandled `TypeError`

* **Diff hunk**: `tests/p1-cli/command-table-gates.test.ts` lines 347–353:
  ```typescript
  +  assertStatementAllowlist(source, functionBody(source, "selectCommandEntry"), `
  +    function expected(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
  +      if (!isCommandGroup(root)) return root;
  +      const action = root.choose(args);
  +      const entry = action === undefined ? undefined : root.subcommands[action];
  +      return entry ?? root.refusal;
  +    }
  +  `, "selectCommandEntry");
  ```
* **Concrete input (argv)**:
  `cswarm brain toString`
  (Also: `cswarm brain constructor`, `cswarm brain valueOf`, `cswarm brain hasOwnProperty`, `cswarm brain __proto__`, `cswarm brain isPrototypeOf`, `cswarm brain propertyIsEnumerable`, `cswarm brain toLocaleString`, and for any other grouped command such as `token`).
* **Mechanism**:
  1. In Round 4, `main()` was patched to guard top-level verb lookup with `Object.hasOwn(AGENT_COMMANDS, verb)` to prevent resolving prototype members of `Object.prototype`.
  2. However, for grouped commands (such as `brain`, which is verified as a group in line 189), dispatch delegates to `selectCommandEntry(root, args)`.
  3. Inside `selectCommandEntry`:
     ```typescript
     const action = root.choose(args);
     const entry = action === undefined ? undefined : root.subcommands[action];
     return entry ?? root.refusal;
     ```
     When the action argument is `"toString"`, `root.subcommands["toString"]` performs an unchecked property read against `root.subcommands`. Because `root.subcommands` is a standard object literal inheriting from `Object.prototype`, this evaluates to `Object.prototype.toString` (a function, truthy, not `undefined`).
  4. Because `entry` is not `null` or `undefined`, `entry ?? root.refusal` returns `Object.prototype.toString` instead of falling back to `root.refusal`.
  5. In `main()`, dispatch immediately executes:
     ```typescript
     const variant = selectCommandVariant(entry, args);
     ```
     `selectCommandVariant` executes:
     ```typescript
     const id = entry.select(args);
     ```
  6. Because `Object.prototype.toString` has no `.select` property, Node throws an unhandled exception:
     `TypeError: entry.select is not a function`
* **Divergence from main (4cb8c5fe)**:
  On main (and for any other unrecognized subcommand like `cswarm brain nonexistent`), the CLI exits via the refusal/usage error path (`root.refusal`). On the lane, `cswarm brain toString` crashes with an uncaught `TypeError` and runtime stack trace on stderr with exit code 1.

---

#### [RIGOUR] AST allowlist gate freezes the `selectCommandEntry` prototype bug and lacks execution testing

* **Diff hunk**: `tests/p1-cli/command-table-gates.test.ts` lines 347–353:
  ```typescript
  +  assertStatementAllowlist(source, functionBody(source, "selectCommandEntry"), `
  +    function expected(root: AgentCommandRoot, args: Arguments): AgentCommandEntry {
  +      if (!isCommandGroup(root)) return root;
  +      const action = root.choose(args);
  +      const entry = action === undefined ? undefined : root.subcommands[action];
  +      return entry ?? root.refusal;
  +    }
  +  `, "selectCommandEntry");
  ```
* **Mechanism**:
  1. `command-table-gates.test.ts` does not have an execution gate testing `selectCommandEntry` or grouped command dispatch with invalid actions or `Object.prototype` property names.
  2. The AST comparison in `assertStatementAllowlist` stringently enforces statement-for-statement equality with the expected AST text.
  3. Any plausible future bug fix in `src/cli.ts` (e.g. changing line 3 to `const entry = action !== undefined && Object.hasOwn(root.subcommands, action) ? root.subcommands[action] : undefined;`) will be rejected by this test suite as a gate failure (`selectCommandEntry statement 3 is not allowlisted`), directly freezing the vulnerability into the codebase.

---

#### [RIGOUR] `exportedRunOnboardingCommand` blind to aliased re-exports

* **Diff hunk**: `tests/p1-cli/command-table-gates.test.ts` lines 417–423:
  ```typescript
  +    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
  +      return statement.exportClause.elements.some(element =>
  +        element.name.text === "runOnboardingCommand" ||
  +        (element.name.text === "default" && element.propertyName?.text === "runOnboardingCommand")
  +      );
  +    }
  ```
* **Mechanism**:
  If a source file re-exports the deleted dispatcher under a non-default alias (e.g., `export { runOnboardingCommand as runOnboardingDispatcher } from "./onboarding-cli.js"`), in TypeScript AST `element.name.text` is `"runOnboardingDispatcher"` and `element.propertyName?.text` is `"runOnboardingCommand"`. Because the check only inspects `element.propertyName?.text` when `element.name.text === "default"`, the alias re-export is not detected by `exportedRunOnboardingCommand`, passing the gate while exporting the symbol under a different identifier.

---

VERDICT: FAIL
`selectCommandEntry` lacks an own-property check on `root.subcommands[action]`, causing `cswarm brain toString` (and other prototype names) to throw `TypeError: entry.select is not a function` instead of returning `root.refusal`.
