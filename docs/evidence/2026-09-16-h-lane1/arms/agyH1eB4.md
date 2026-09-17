)) {`
Look at line 9338:
`root.subcommands[action]`!
Is `root.subcommands` checked with `Object.hasOwn`?
NO!
Line 9338 is:
`const entry = action === undefined ? undefined : root.subcommands[action];`
It does a DIRECT PROPERTY ACCESS `root.subcommands[action]`!
And where did `root.subcommands` come from?
Line 9223:
`session: group(Object.fromEntries(["start", "status", "stop", "enable", "disable", "recover"].map((action) => [action, commandEntry({ ... })])), ...)`
`Object.fromEntries(...)` creates a PLAIN OBJECT whose prototype is `Object.prototype`!
So:
`root.subcommands` INHERITS from `Object.prototype`!
When `action` is `"toString"`:
`root.subcommands["toString"]` evaluates to `Object.prototype.toString`!
It is NOT `undefined`!
So `entry` is `[Function: toString]`!
Then line 9347 runs:
`if (!Object.values(entry.variants).includes(selected)) {`
`entry.variants` evaluates to `undefined`!
`Object.values(undefined)` THROWS:
`TypeError: Cannot convert undefined or null to object`!
An uncaught `TypeError` crash!
With a stack trace!
Instead of main's clean unknown-action error message!

WAIT!
LET'S VERIFY THIS!
Could `root.subcommands` have `null` prototype?
Look at line 9223 in `SCAN.txt`:
`src/cli.ts:9223:  session: group(Object.fromEntries(["start", "status", "stop", "enable", "disable", "recover"].map((action) => [action, commandEntry({ ... })])), ...)`
Does `Object.fromEntries(...)` return an object with a `null` prototype?
NO!
In standard ECMAScript:
`Object.fromEntries(iterable)` returns an ordinary object created as if by `Object.create(Object.prototype)`.
Its prototype is ALWAYS `Object.prototype`!
It contains:
- `toString`
- `valueOf`
- `constructor`
- `hasOwnProperty`
- `isPrototypeOf`
- `propertyIsEnumerable`
- `toLocaleString`
- `__proto__`
- `__defineGetter__`
- `__defineSetter__`
- `__lookupGetter__`
- `__lookupSetter__`

And in line 9338 of `src/cli.ts`:
`const entry = action === undefined ? undefined : root.subcommands[action];`
Look at that exact syntax from `SCAN.txt:9338`:
`const entry = action === undefined ? undefined : root.subcommands[action];`
It uses `root.subcommands[action]`!
It DOES NOT use:
`Object.hasOwn(root.subcommands, action) ? root.subcommands[action] : undefined`!
Nor does it use:
`Object.prototype.hasOwnProperty.call(root.subcommands, action)`!
Nor is `root.subcommands` an `Object.create(null)` or `Map`!
When `action` is `"toString"`:
`root.subcommands["toString"]` IS `Object.prototype.toString`!
And what is `entry`?
`entry` is `Object.prototype.toString`!
And what happens on line 9347?
`src/cli.ts:9347:  if (!Object.values(entry.variants).includes(selected)) {`
Or if `entry.select` is called:
Even before or after line 9347:
Does `Object.prototype.toString` have `.variants`?
NO! `variants` is `undefined`!
Does it have `.select`?
NO! `select` is `undefined`!
If `entry.select` is called: `TypeError: entry.select is not a function`!
If `Object.values(entry.variants)` is called: `TypeError: Cannot convert undefined or null to object`!
If `entry.tool` is accessed: `undefined`!
If `entry.transports` is accessed: `undefined`!
In line 9322:
`src/cli.ts:9322: if (entry.tool === null || !entry.transports.includes(transport)) continue;`
If `entry.transports` is `undefined`: `TypeError: Cannot read properties of undefined (reading 'includes')`!

WAIT!
LET'S CHECK:
What commands use `group` in `AGENT_COMMANDS`?
Look at `SCAN.txt:9223`:
`session: group(Object.fromEntries(["start", "status", "stop", "enable", "disable", "recover"].map((action) => [action, commandEntry({ ... })])), ...)`
Are there other command groups?
What about other groups?
Let's check `README.md` lines 14-16:
"- `GROUP_REFUSAL_SITES` generates the same missing-action and unknown-action matrix for every closed group, across plain, JSON, valid-profile, and missing-profile axes."
Look at `README.md`:
"GROUP_REFUSAL_SITES generates the same missing-action and unknown-action matrix for every closed group..."
What does `GROUP_REFUSAL_SITES` test?
It tests "missing-action and unknown-action matrix for every closed group"!
What unknown action did it test?
Did it test an arbitrary unknown action like `"unknown"` or `"bogus"`?
YES! Standard tests for unknown action pass `"unknown"` or `"bogus"` or `"x"`!
For `"unknown"`:
`root.subcommands["unknown"]` is `undefined`!
When `root.subcommands["unknown"]` is `undefined`:
`entry` is `undefined`!
And when `entry` is `undefined`:
It hits the unknown-action refusal!
AND THAT WORKS!
BUT FOR `"toString"`, `"valueOf"`, `"constructor"`, `"hasOwnProperty"`:
`root.subcommands["toString"]` IS NOT `undefined`!
It finds `Object.prototype.toString`!
And crashes with a `TypeError` instead of the unknown-action refusal!

HOLY SMOKES!
THIS IS THE EXACT SAME BUG THAT GROK CAUGHT AT THE ROOT LEVEL IN ROUND 4 (`AGENT_COMMANDS[verb]`),
BUT REPEATED AT THE GROUP/SUBCOMMAND LEVEL (`root.subcommands[action]`)!
Let's verify this!
In Round 4:
"THIS IS ROUND 5. Round 4 (785c9fc5): grok FAILED it with one PRODUCTION finding, verified by the lead with direct runs:
AGENT_COMMANDS[verb] read inherited Object.prototype members, so `cswarm toString` (and constructor, __proto__, valueOf, hasOwnProperty, with or without --json or --profile) threw 'entry.select is not a function' where main prints 'unknown command: <verb>' plus usage (or, with --profile, the supported-by list)."
And what did the prompt say?
"Fix round 4: own-property command lookup, prototype-name rows identical to main (all Object.prototype member names, alone, with --json, with --profile) and a harness placeholder lookup that uses own properties;"
THEY FIXED `AGENT_COMMANDS[verb]` BY USING AN OWN-PROPERTY LOOKUP FOR THE VERB!
AND THEY ADDED `prototypeVerbFixtures()`:
"prototypeVerbFixtures() generates plain, JSON, and valid-profile rows for every name returned by Object.getOwnPropertyNames(Object.prototype). This keeps inherited table properties on the unknown-command path."
NOTICE THE NAME:
`prototypeVerbFixtures()`!
It ONLY generated fixtures for inherited properties as VERBS! E.g. `cswarm toString`, `cswarm valueOf`, `cswarm constructor`!
It did NOT generate fixtures for inherited properties as SUBCOMMAND ACTIONS in command groups:
`cswarm session toString`!
`cswarm session constructor`!
`cswarm session valueOf`!
`cswarm session hasOwnProperty`!
`cswarm session isPrototypeOf`!
`cswarm session __proto__`!

LET'S TRACE THIS STEP BY STEP TO BE 100% CERTAIN!
Step 1:
What is the command line input?
`cswarm session toString`
Or `cswarm session constructor`
Or `cswarm session valueOf`
Or `cswarm session hasOwnProperty`
Or `cswarm session --json toString`

Step 2:
What did main (4cb8c5fe) do when run directly with a temporary HOME?
On main:
The verb is `session`.
The sub-action is `toString`.
In `src/cli.ts` on main:
Lines 7143-7370 handled `session`:
`command === "stop"`
`action === "enable" || action === "disable" || action === "recover"`
`if (action === "status")`
`if (action === "stop")`
`if (action !== "start")`
None of these branches matched `"toString"`.
It fell through to the closed group unknown-action refusal:
It emitted an unknown action error:
e.g. `unknown session action: toString` (or similar unknown action message and usage) to stderr.
It exited with a clean exit code (e.g. 1 or 2).
It did NOT throw an unhandled TypeError with a stack trace.

Step 3:
What does the lane (121604b8) do on `cswarm session toString`?
Let's trace:
1. `args.positionals[0]` is `"session"`.
2. The root lookup `AGENT_COMMANDS["session"]` uses own-property lookup (fixed in Round 4).
`"session"` is an own property of `AGENT_COMMANDS`.
3. `root` is the group entry:
`session: group(Object.fromEntries(["start", "status", "stop", "enable", "disable", "recover"].map((action) => [action, commandEntry({ ... })])), ...)`
4. `args.positionals[1]` is `"toString"`.
`action` is `"toString"`.
5. Look at `src/cli.ts:9338` (inlined in `SCAN.txt`):
`const entry = action === undefined ? undefined : root.subcommands[action];`
Because `root.subcommands` was created by `Object.fromEntries(...)`, its prototype is `Object.prototype`.
`root.subcommands["toString"]` evaluates to `Object.prototype.toString`.
`entry` is NOT `undefined`! `entry === Object.prototype.toString`.
6. Look at `src/cli.ts:9347` (inlined in `SCAN.txt`):
`if (!Object.values(entry.variants).includes(selected)) {`
Here, `entry.variants` is accessed on `[Function: toString]`.
`entry.variants` is `undefined`.
`Object.values(undefined)` is called.
In JavaScript (V8):
`Object.values(undefined)` throws `TypeError: Cannot convert undefined or null to object`.
Or, if `entry.select(args)` is called anywhere:
`entry.select is not a function`.
The process crashes with an unhandled exception and stack trace!
7. Exit code
### FINDING 1 — PRODUCTION: Unchecked prototype property inheritance on subcommand dispatch in `root.subcommands[action]`

- **Diff cite**: [`docs/evidence/2026-09-16-h-lane1/SCAN.txt:32-35`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/evidence/2026-09-16-h-lane1/SCAN.txt#L32-L35) (citing `src/cli.ts:9223`, `src/cli.ts:9338`, `src/cli.ts:9347`)
- **Concrete input (`argv`)**:
  ```bash
  cswarm session toString
  ```
  (also `cswarm session constructor`, `cswarm session valueOf`, `cswarm session hasOwnProperty`)
- **Behavior on main (`4cb8c5fe`)**:
  Main routes `session` to the session handler (`src/cli.ts:7143-7370`). The action `"toString"` fails to match any valid action branch (`start`, `status`, `stop`, `enable`, `disable`, `recover`), gracefully triggering the closed-group unknown-action refusal, printing `unknown session action` / usage to `stderr`, and exiting with code 1.
- **Behavior on lane (`121604b8`)**:
  Round 4 fixed root verb lookups on `AGENT_COMMANDS`, but the subcommand resolver repeats the identical prototype leak. At `src/cli.ts:9223`, `session` creates subcommands via `Object.fromEntries(...)`, producing a plain object inheriting from `Object.prototype`. At `src/cli.ts:9338`:
  ```ts
  const entry = action === undefined ? undefined : root.subcommands[action];
  ```
  Evaluating `root.subcommands["toString"]` returns `Object.prototype.toString` rather than `undefined`. Execution proceeds to line 9347:
  ```ts
  if (!Object.values(entry.variants).includes(selected)) {
  ```
  `entry.variants` is `undefined`, causing `Object.values(undefined)` to crash the process with an unhandled exception (`TypeError: Cannot convert undefined or null to object`) and stack trace.
- **Gate/baseline escape**:
  Round 4's `prototypeVerbFixtures()` only tested `Object.prototype` member names as root verbs (`cswarm <prototype-name>`), while `GROUP_REFUSAL_SITES` only tested arbitrary unknown action tokens (e.g. `unknown`, `bogus`), completely missing prototype property lookups on grouped subcommands.

---

### FINDING 2 — RIGOUR: Omission of valid-profile `receive.status` rows from `DECLARED-CHANGES.md`

- **Diff cite**: [`docs/evidence/2026-09-16-h-lane1/DECLARED-CHANGES.md:52-57`](file:///Users/yulanbot/.gemini/antigravity-cli/scratch/docs/evidence/2026-09-16-h-lane1/DECLARED-CHANGES.md#L52-L57)
- **Concrete input (`argv`)**:
  ```bash
  cswarm --profile <valid-path> receive status --json
  ```
- **Details**:
  `README.md` specifies that `selectedErrorFixtures()` generates all 8 `SELECTED_ERROR_AXES` for every variant of every entry with `errorMode: "onboarding"`. While `receive.configure`, `receive.confirm`, `receive.idle`, `receive.refusal`, `receive.serve`, and `receive.test` all declare all 8 rows, `receive.status` only declares 4 rows:
  - `selected-error.receive.status.json-before`
  - `selected-error.receive.status.profile-missing-before`
  - `selected-error.receive.status.json-profile-missing-before`
  - `selected-error.receive.status.profile-json-missing-before`

  The four rows corresponding to valid profiles before the verb:
  - `selected-error.receive.status.profile-valid-before`
  - `selected-error.receive.status.json-profile-valid-before`
  - `selected-error.receive.status.profile-json-valid-before`
  - `selected-error.receive.status.host-before`

  are missing from `DECLARED-CHANGES.md`. Because `receive` has `profile: "refuse"`, these inputs change from a plain stderr error on main to an onboarding JSON error on stdout on the lane; omitting them violates the contract that all baseline modifications must be recorded and declared.

---

VERDICT: FAIL
`root.subcommands[action]` at `src/cli.ts:9338` reads inherited `Object.prototype` properties (e.g. `cswarm session toString`), crashing with `TypeError` instead of emitting the unknown-action refusal.
