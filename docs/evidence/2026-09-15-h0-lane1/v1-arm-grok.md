I'll review the H0 verb-table lane at `27e97f04` on its own terms: read the commit, run the gates, then try to break the controls.Worktree is at `27e97f04`. Next I’ll join the swarm, read the commit, and start the gates.Joining the swarm, then I’ll read the verb table against the wire and start the gates.Join succeeded as Kevel. Next I’ll read the wire checks, then run the gates with real exit codes.The evidence file the comment names is missing. I’ll hunt the H0 spec and start the gates.The comment cites a wire-check file that is not in this SHA. I’ll read the H0 spec next and start the gates.Build is green. Next I’ll run `npm test`, then the Deno leaf probe.`npm test` is 0 and did not run `h0-verbs`. Next I’ll run `test:p1-cli` and the remaining gates.`test:p1-cli` exited 1 with 15 failures. I’ll inspect those next, then mutation-test the H0 controls.The 15 `p1-cli` failures are a `FORCE_COLOR` stderr warning, not H0. I’ll clean the probe files, then mutation-test the eight controls.The table is wrong against the wire, and the eight tests cannot see that.

`POST ack` tells an agent `last_error_code` is optional. `exactKeys` on the live ack path requires that key. I changed the ack field set to a fake one; all eight tests stayed green.

SHA: `27e97f0495df5f5124951e193e9a1e24e0efb659`. One commit vs `main` (`de10d96c`). Two files.

## Gates (real exit codes, no pipes)

| command | exit |
|---|---|
| `npm run build` | **0** |
| `npm test` | **0** (874 pass; `h0-verbs` not in the run) |
| `npm run test:p1-cli` | **1** |
| `npm run check:tests` | **0** |
| `npm run check:edge` | **0** |
| `git diff --check` | **0** (workdir and the commit) |

`p1cli=1` is this harness, not the lane. 15 CLI tests failed because `FORCE_COLOR` writes a Node warning on stderr. ARM-H says unset it. The eight H0 tests still ran and passed in that same log.

`src/h0/verbs.ts` has no newline after the last `}`. `git diff --check` did not flag it.

## 1. The controls

Eight tests. They bind the **document to the table**, not the table to the wire. That is the property this lane said it would deliver, and it does not.

| # | test | what a break does |
|---|---|---|
| 1 | every verb appears in the document (`tests/p1-cli/h0-verbs.test.ts:21`) | Restatement. `verbLine` already prints `POST ${verb.name}`. |
| 2 | document names no extra `POST` verb (`:28`) | Control for a typed `POST activity` in the intro. Not a control for a wrong field list. |
| 3 | “every required field the document prints is a field the table requires” (`:34`) | **Name and body disagree.** Body checks `table.required ⊆ line` (`:39-41`), the inverse of the name. `line.includes(field)` is a substring check on a line the generator built from the same array. |
| 4 | join credential never appears (`:45`) | Looks for `joincredential:` after `toLowerCase` (`:49`). One spelling. |
| 5 | one preauth verb, `register` (`:53`) | Control. Changing `auth` on a second verb fails it. |
| 6 | seven named verbs (`:57`) | Control for rename/add/drop of **names**. A typed snapshot. Does not pin fields. |
| 7 | `h0Verb("activity") === null` (`:66`) | Control for the `activity`/`poll` name bug. |
| 8 | leaf, no relative imports (`:71`) | Control for **one** spelling: `import … from "./x"` with double quotes (`:84`). |

**Break the tests do not catch (restored after each run; baseline 8/8, exit 0):**

**Mutation 1 — wrong field set vs the wire.** In `src/h0/verbs.ts:68-69` I set ack to `required: ["signal_id", "lease_id", "listener_instance_id", "fake_field"]` and `optional: ["outcome", "last_error_code"]`. **8/8 pass, exit 0.** The document then names `fake_field` as required and `outcome` as optional. That is the v0.1.48–v0.1.50 class.

**Mutation 6 — wrong list inside a correct-looking sentence.** I swapped the two lists in `verbLine` (`src/h0/verbs.ts:140-144`) so required fields print after `optional:`. **8/8 pass, exit 0.** Test 3 still sees each required name on the line.

**Mutation 7 — `poll` → `activity`.** Fails tests 6 and 7 only (exit 1, 6 pass / 2 fail). Tests 1–3 stay green because they follow the table. The commit’s mutation A catches a **name** change, not a **field** change.

## 2. The leaf constraint

The dual-runtime claim is true. The test that guards it is not a control for that claim.

Probe `supabase/functions/command/_h0_probe.ts`:

```ts
import { H0_VERBS, h0AgentDocumentDescription } from "../../../src/h0/verbs.ts";
```

`deno check --config supabase/functions/command/deno.json supabase/functions/command/_h0_probe.ts` → **exit 0**. Then deleted.

Split with a `.js` specifier (tsc’s ESM form):

- `tsc --noEmit` on `src/h0/_import_js.ts` (`from "./_dummy.js"`) → **exit 0**
- `deno check` of an edge file that imports that module → **exit 1**, `TS2307 Cannot find module '.../src/h0/_dummy.js'`
- `from "./_dummy.ts"`: `tsc` → **exit 2**, `TS5097`; `deno check` → **exit 0**

No specifier satisfies both. That part of the commit is true.

The leaf test is a regex (`:84`), not `deno check`. With a real sibling `src/h0/missing.ts` present so the module still loads:

| change | leaf test |
|---|---|
| `import { DUMMY } from "./missing.js"` (double quotes) | **fails** (the one spelling it searches for) |
| `import { DUMMY } from './missing.js'` (single quotes) | **8/8 pass** |
| `export { DUMMY } from "./missing.js"` (the split shape) | **8/8 pass** |
| `import "./missing.js"` (side-effect, no `from`) | **8/8 pass** |

`export { DUMMY } from "./missing.js"` is the split that makes Deno fail `TS2307`. The test stays green.

`npm run check:edge` still names four functions. There is no H0 edge function. The comment at `src/h0/verbs.ts:119-126` speaks in the present tense (“the H0 edge function imports this module”). That is a claim the tree does not support.

## 3. The table vs the wire

`ack` is the miss this lane exists to prevent.

Table (`src/h0/verbs.ts:68-69`):

```
required: ["signal_id", "lease_id", "listener_instance_id", "outcome"],
optional: ["last_error_code"],
```

Generated line (from `h0AgentDocumentDescription()` in this tree):

```
POST ack — … (seat token in Authorization: Bearer; signal_id, lease_id, listener_instance_id, outcome; optional: last_error_code)
```

Wire type (`supabase/functions/command/durable-delivery.ts:63-71`):

```
signal_id: string;
lease_id: string | null;
listener_instance_id: string | null;
outcome: DeliveryAckOutcome;
last_error_code: string | null;   // required key, nullable value
surfaced?: boolean;               // the only optional key
```

Wire check (`supabase/functions/command/index.ts:1594-1605`) always passes `"last_error_code"` to `exactKeys` (`:1474-1481`). The key set must match. Omit the key → 400 `ack_agent_delivery fields are malformed`. Value `null` is the non-failure case (`:1586-1589`). The live client always sends the key (`src/cloud/delivery.ts:891`, `:926`).

`last_error_code` is not optional. The document says it is. That is a generated list that does not match enforcement.

`surfaced` is optional on that wire (`:1590-1596`, `:70-71`) and required only for managed principals. H0 does not name it. I do not treat that as the same miss; the spec’s cited range is `:63-69`.

Other verbs: `register` / `poll` / `ask` / `note` / `reply` / `working-on` are a new H0 body, not `post_signal` / `claim_agent_inbox` `exactKeys`. I did not pin those field names to the command edge. `working-on` correctly has no `to`.

## 4. The generated document and the join credential

Test 4 (`:45-51`) is a control for one serialization: lowercase `joincredential:` with no space.

- Put `joinCredential: SECRETTOKEN` in the prose → test 4 **fails** (exit 1).
- Put `join credential: SECRETTOKEN` in the prose → **8/8 pass, exit 0**.

`h0AgentDocumentDescription()` takes no argument today (`src/h0/verbs.ts:151`), so a runtime secret has to be typed into the strings. A later edit that interpolates `join credential: ${credential}` (space, the words the document already uses) keeps all eight tests green and puts a secret in a prefetch-safe GET. The second assert (`:50`, must contain `not in this document`) still passes if both the sentence and the secret are present.

## 5. Gate reachability

**`npm run test:p1-cli` does run it.** Same invocation, names present:

```
✔ every verb in the table appears in the generated document
✔ the document names no verb the table does not hold
✔ every required field the document prints is a field the table requires
✔ the join credential never appears in the document
✔ exactly one verb is reachable without a seat, and it is register
✔ the table is the seven verbs H0 specifies
✔ h0Verb resolves a known verb and refuses an unknown one
✔ the H0 module is a LEAF — no relative imports, or the edge function stops building
```

**`npm test` does not.** The `test` script is a literal list. `h0-verbs` is not in that list (`NOT_NAMED` from `package.json`). The `npm test` log has no H0 test name. That commit claim is true.

## 6. Other

`src/h0/verbs.ts:15` says the table is checked against the wire by `docs/evidence/2026-09-14-mcp-spec/verbs-vs-wire.check.ts`. **That path is not in this SHA** (`ls` exit 1). The comment names a control that is not here. (In a sibling worktree that file only diffs verb **names** in spec markdown. It would not catch `last_error_code`.)

`src/h0/verbs.ts:4-6` says the dispatcher and the paste are generated from this table. This commit adds neither. The paste is still `dashboardAgentPrompt`.

Test 3’s title claims `document ⊆ table.required`. Its body tests the other direction. A generator that prints extra field names stays green.

No dead export. `H0VerbName` is the literal union. Mixed camelCase (`joinCredential`) and snake_case (`signal_id`) matches the split between new H0 fields and the existing ack wire; that is not the miss.

Not established: I did not serve an H0 document (none is wired). I did not run `test:p1-cli` to 686/686 with `FORCE_COLOR` unset.

VERDICT: FAIL `ack` lists `last_error_code` as optional while `command/index.ts:1594-1605` requires the key, and the eight tests stay green when the field set is wrong.
