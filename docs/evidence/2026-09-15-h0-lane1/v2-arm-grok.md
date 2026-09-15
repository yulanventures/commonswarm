I'll review commit `9c2c2002` as a D-036 arm: unset `FORCE_COLOR` first, then re-derive the claims from the diff and mutation tests.Worktree is on `9c2c2002`. Next I’ll read both files against the command-edge `exactKeys` sites, then run the gates with `FORCE_COLOR` unset.I'll read the ack `exactKeys` block and `post_signal` enforcement next, then start the gates with `FORCE_COLOR` unset.The ack branch is in the right place. Next I’ll check `post_signal` and the other six verbs, and wait for the gate.`FORCE_COLOR=` still leaves the var set, so that p1-cli run failed on the Node warning. I’ll unset it properly, then mutation-test the controls.All 10 H0 tests passed in that run. Next I’ll run the gates with `FORCE_COLOR` actually unset, and mutation-test the controls.Gates are green except the empty `FORCE_COLOR=` p1-cli run. Next I’ll mutation-test the controls and rerun p1-cli with the variable actually unset.The leaf mutations have to keep the module loadable, or every test dies before the regex runs. I’ll add a dummy sibling and insert the imports at top level.Two extraction holes stayed green. I’ll pin those with unused-function imports, then confirm the claimed leaf modules.SHA `9c2c2002`. Worktree left clean.

`FORCE_COLOR=` still **sets** the var (empty). That is what caused the 15 stderr fails. True unset:

| gate | exit |
|---|---|
| `env -u FORCE_COLOR -u NO_COLOR npm run test:p1-cli` | **0**, 688/688, all 10 H0 names present |
| `npm test` | **0**, 874/874, **zero** H0 names; `h0-verbs` is not in the literal list |
| `npm run build` / `check:tests` / `check:edge` / `git diff --check` | **0** |

The new tests run under `test:p1-cli` and not under `npm test`. That claim is true.

---

**1. Extraction finds the right block. It does not pin the contract.**

`ackWireKeys` at `tests/p1-cli/h0-verbs.test.ts:39-50` looks for `if (cmd.kind === ACK_AGENT_DELIVERY_KIND) {` (`command/index.ts:1578`). That string occurs once. Window is 2000 chars. The ack `exactKeys` is at offset 767. `SIGNALS_SEEN` is at 2102, just outside. There are 30 `exactKeys(cmd, [` sites. First match in the window is the ack call.

Extracted keys: `kind, signal_id, lease_id, listener_instance_id, outcome, last_error_code, surfaced`. After dropping `kind`, that list matches the table **names**.

Anchor gone → **loud fail** (`ack branch anchor not found`).
`]) &&` removed → **loud fail** (`no exactKeys(...) call`).
~2000 chars of padding before `exactKeys` → **loud fail** (empty compare does not pass).

Then I made the table wrong and the tests stayed green.

- Spread a **variable** into the ack list (`...extraKeys` with `extraKeys = ["admin_token"]`) at `command/index.ts:1594-1597`. Enforcement now requires `admin_token`. The regex only copies quoted `[a-z_]+` literals inside the array, so it never sees the new key. **10/10 green.**
- Mark `last_error_code` optional on the **edge** with one remaining quoted `"last_error_code"` (`...(hasLast ? ["last_error_code"] : [])`). Names still match. Presence test at `:60-65` only reads the **table**. **10/10 green.**

The control compares names. It does not read presence from `exactKeys`.

---

**2. First-round mutations. The name gut is fixed. The class of bug moved.**

| mutation | result |
|---|---|
| Gut ack to `signal_id` + `made_up_field` | **3 fail** (key set, `last_error_code` presence, document presence). Same 3 the commit names. |
| Drop `surfaced` from the table | **2 fail** |
| Inject `    admin_token (required)` (4 spaces) | **1 fail** |
| Inject `admin_token (required)` with **no** 4-space indent | **10/10 green** (`:72` only parses `^ {4}…`) |
| `Join credential: SECRET` / `= SECRET` | **1 fail each** |
| Swap presence rendering | **1 fail** |
| Double / single / backtick `from`, re-export, side-effect, `import()`, `import type`, `export *` | leaf test **fails** |
| `/// <reference path="./missing.ts" />` | **10/10 green** |
| `const p = "./missing.js"; void import(p)` | **10/10 green** |
| unused `import("./missing.js", { with: { type: "json" } })` | **10/10 green** (regex wants `)` right after the specifier, `:127`) |
| `createRequire` then `r("./missing.js")` | **10/10 green** |

v1 class, still green:

- `req("lease_id")` → `opt("lease_id")` at `src/h0/verbs.ts:109` → **10/10 green**
- same for `signal_id` (`:108`), `outcome` (`:111`), `listener_instance_id` (`:110`) → **10/10 green**
- `last_error_code` → `opt` → **fails** (the one field they pinned)

The document then says those keys **may be omitted**. `exactKeys` at `:1474-1482` still wants the key. That is the v1 `last_error_code` bug on four other fields. The fix did not cover the rule. It covered one name.

---

**3. The six-verb admission is narrow, not a full limit.**

`ack` is the only verb whose **H0 body** matches a live `exactKeys` list. That part is true.

`register` and `poll` have no matching wire. `claim_agent_inbox` is `listener_instance_id` + `limit`, not `wait` / `ackBatch`.

`ask` / `note` / `reply` / `working-on` **do** have live rules:

- `SIGNAL_KINDS` is `working-on, note, ask` (`supabase/functions/_shared/channels.ts:37`)
- `post_signal` always requires `body` (`command/index.ts:1830-1846`)
- `working-on` must not have a recipient (`:1866-1872`; CLI `allowTo = kind !== "working-on"` at `src/cli.ts:3648`)
- `reply` is not a signal kind. The CLI requires the signal UUID (`src/cli.ts:3955-3957`) and sends `in_reply_to`

Mutations, all **10/10 green**: add `to` to `working-on` (`verbs.ts:139`); drop `body` from `ask`; drop `signal_id` from `reply`.

So “only ack has enforcement” is true for a same-list `exactKeys` compare. It is not true that nothing exists to check. Those four verbs have rules. The table is not checked against them.

---

**4. The document can still carry a secret.**

`h0AgentDocumentDescription()` takes no argument (`verbs.ts:190`). That does not stop a typed-in secret. It also does not stop a later optional argument: existing callers pass nothing.

Test name at `h0-verbs.test.ts:102`: “in any shape”. Body at `:107-111` only rejects `join[\s_-]*credential\s*[:=]`.

Green leaks (document still contains `not in this document`):

- `Join credential is TEST_SECRET_VALUE.`
- `{"joinCredential": "TEST_SECRET_VALUE"}`
- `Join credential TEST_SECRET_VALUE` (no `:` / `=`)
- `Join credential — TEST_SECRET_VALUE`
- `join_credential is TEST_SECRET_VALUE`
- add `(joinCredential?: string)` and interpolate `` `join credential is ${joinCredential}` ``

The v1 `:` / `=` spellings now fail. “Any shape” is false.

The function is only called from this test file. Nothing serves the document yet. That matches the commit’s NOT ESTABLISHED note.

---

**5. Gates vs the commit message**

Reproduced: build 0, `npm test` 874/874 with no H0 names, `test:p1-cli` 688/688 with the 10 H0 names, `check:tests` 0, `check:edge` 0, `diff --check` 0.

Message vs tree: “gut ack → 3 fail”, “drop surfaced → 2 fail”, “four new test names”, “~30 `exactKeys(cmd, [` sites” (measured 30), `exactKeys` at `:1474-1482`, `verbs-vs-wire.check.ts` absent (`git cat-file` 128), dispatcher comments no longer claim it is wired. Those hold.

Overclaim: “checked against the enforcement rather than itself” is names only. Presence is a hardcoded `last_error_code` check. “in any shape” is not what the regex does.

---

**6. Other**

- `credential-redaction.ts` and `session-wire.ts` are leaves. That comment is true.
- `as const satisfies readonly H0Verb[]` does not bind presence to the edge.
- Comment at `verbs.ts:102-103` (“this comment cannot quietly go stale”) is false for presence. The test does not read `[, surfaced]` vs required.
- No dead export. Mixed `joinCredential` / `signal_id` matches a new adapter vs the ack wire.

Not established: I did not serve an H0 document. I did not re-run a Deno import probe. I did not run `test:p1-local` or `test:p1-server`.

VERDICT: FAIL — ack presence is still unchecked except for `last_error_code`; `opt("lease_id")` (and signal_id/outcome/listener_instance_id) stays 10/10 green, so the v1 exactKeys bug moved, and a variable-spread extra wire key also stays green.
