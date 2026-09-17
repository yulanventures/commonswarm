### Part A1 of 6 Review: `src/cli.ts` (First Half)

#### Scope & Dependencies
This review covers Part A1 (first half of `src/cli.ts` diff). Per instructions, the following dependencies outside this diff cannot be verified in this call and must be reviewed in subsequent parts:
1. **`./dispatch-trace.js` (`recordDispatch`)**: Implementation of trace recording.
2. **`src/cli.ts` second half (`main()`)**: Meta-command handling, single table lookup, dispatch execution, error handling reading `selectedCommandContext`, and process termination.
3. **`src/onboarding-cli.ts` & budget checks**: Hook-check deadlines and turn-hook exit mechanics in `onboarding-cli.ts`.
4. **Commits 1, 3, 4, 5 artifacts**: Baseline records, `DECLARED-CHANGES.md`, and gate allowlists in `CONTROLS.md`.

---

### Analysis & Verification

1. **Table Dispatch & Schema Integrity**:
   - `AGENT_COMMANDS` cleanly defines the dispatcher table.
   - All entries define `tool` (or `tool: null` with a string `reason`), `description`, `argumentSchema`, `mutates`, `flags`, `transports`, `profile`, `hostSessionId`, and `visible`.
   - Every `tool: null` entry (including group refusals and mapped session entries) carries an explicit non-empty justification string.

2. **Prototype Pollution Guard (`Object.hasOwn`)**:
   - `selectCommandEntry` checks `action !== undefined && Object.hasOwn(root.subcommands, action)`.
   - For all 15 closed groups (`receive`, `hook`, `listen`, `session`, `invite`, `member`, `workspace`, `target`, `channel`, `file`, `brain`, `principal`, `token`, `grant`, `link`), passing `toString`, `valueOf`, `constructor`, or any other inherited property from `Object.prototype` cleanly misses `root.subcommands` and falls through to `root.refusal` (or the respective group's handler), eliminating the Round 5 TypeError regression.

3. **Profile Expansion Order & Semantics**:
   - `expandAgentProfile(profileMode, hostSessionId)` accurately reflects the legacy execution sequence:
     - `profileMode === "refuse"` rejects `--profile` with `profile_command_invalid`.
     - `profileMode === "native"` returns before conflict checks and credential resolution, accurately preserving behaviour for onboarding verbs (`setup`, `check`, `receive`, and snapshot `resume`).
     - `hostSessionId === "drop"` drops `--host-session-id` and converts to `--session-context` only on commands other than `session` and `listen` (`EXPAND_PROFILE_KEEP_HOST`).
   - `AGENT_PROFILE_COMMANDS` derives dynamically from `profileListOrder`, matching the exact 16-command array in legacy order (0: `whoami` through 15: `channel`).

4. **Argv Order Preservation for Error Handling**:
   - `Arguments.leadingPositionals` tracks positionals preceding any `--` or `--flag`.
   - `Arguments.startsWithLeadingPositionals("hook", "check")` precisely mirrors `main`'s legacy `process.argv[2] === "hook" && process.argv[3] === "check"` error-swallowing condition without inspecting raw `process.argv` directly.

5. **Handler Body Invariance**:
   - Handlers for `runBrain`, `runChannel`, `runFile`, `runListen`, and `runLink` subcommands directly call original handler functions (`runBrainLs`, `runChannelCreate`, etc.).
   - `runLogin` and `runLogout` extract the exact inline logic previously in `main()` without altering shape assertions or error conditions.

---

### Findings

No `PRODUCTION` or `RIGOUR` findings identified in Part A1.

---

VERDICT: PASS
Part A1 is strictly behaviour-preserving, protects sub-action selection via Object.hasOwn, adheres to profile mode legacy classifications, and provides valid reasons for every null tool entry.
