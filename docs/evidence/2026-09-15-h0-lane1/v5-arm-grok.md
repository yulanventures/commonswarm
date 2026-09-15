I'll treat this as a hostile mutation review: read the commit, then break the extraction, vocabulary, golden, and leaf walk until a test stays green.Detached HEAD at `e46a8520`. Next I’ll read the named commit and the files it actually changed.The named SHA and HEAD may differ. I’ll join the swarm and dump both commits before mutating anything.The review is on `src/h0/verbs.ts` and `tests/p1-cli/h0-verbs.test.ts`. I'll read those and the prior arm notes next.I'll read the real command types and prior arm notes, then start mutations against those.Baseline is 10/10. Next I’ll dump specifier AST shapes, then mutate the golden, extraction, and leaf walk.I’ll run a mutation loop: golden injections first, then leaf-specifier shapes against `deno check`.Triple-slash comments only count at the file top. I’ll prepend them and re-run.SHA `e46a8520`. Tree left clean. Probe deleted.

**Gates** (`env -u FORCE_COLOR`; real exits, no pipe):

| command | exit |
|---|---|
| `npm run build` | **0** |
| `npm test` | **0**, 874/874, **zero** H0 names |
| `npm run test:p1-cli` | **0**, 688/688, all **10** H0 names present |
| `npm run check:tests` | **0** |
| `npm run check:edge` | **0** |
| `git diff --check` | **0** |

---

**Product behaviour on production: none found.** This lane does not serve HTTP. The live `ack` table still matches `AckAgentDeliveryCommand` as written (`string \| null` on the property, `?` on `surfaced`). `working-on` still has no `to`. I did not find a current document that would make a deployed agent send a body the command edge rejects.

---

**Test-rigour (this is the FAIL).**

**1. Leaf walk still misses a specifier Deno resolves.** Same `.js` vs `.ts` split as last round.

Add at the bottom of `src/h0/verbs.ts`:

```ts
declare module "../cloud/session-wire.js" { export type _H0Leaf = string }
```

| gate | result |
|---|---|
| H0 tests | **10/10 green** |
| `tsc --noEmit -p tsconfig.json` | **0** |
| `npm run check:tests` | **0** |
| `deno check --config supabase/functions/command/deno.json supabase/functions/command/_h0_leaf_probe.ts` | **1**, `TS2307` cannot find `src/cloud/session-wire.js`, plus `TS2664` |

The walk records import, export-from, import-equals, `import()`, `ImportTypeNode`, and `file.referencedFiles`. It does not look at `ModuleDeclaration` names. `import type { X } from "../x.js"` now fails the test. `declare module "../x.js"` does not. Probe deleted after.

A second miss, weaker: `/// <reference types="../cloud/session-wire.js" />` at the **top** of the file. H0 stays **10/10**. Deno exits **1** (`TS2307`). `tsc` also exits **2**, so `npm run build` would catch it. The walk reads `referencedFiles` (`path=`), not `typeReferenceDirectives` (`types=`). `amd-dependency` and JSDoc `import()` do not move Deno; I am not counting those.

**2. Ack “nullability” is a `null` token on that node, not the type.**

Change `lease_id: string | null` to `type LeaseId = string | null; lease_id: LeaseId`, set the table to `req("lease_id", false, …)`, update the golden so the line drops `, may be null`. **10/10 green.** The document then omits “may be null” while the type is still `string | null`. Rename / move / `type` instead of `interface` / re-export all fail **loudly**. `extends` a base with a new required field stays **green** (partial extract; table == extracted members only).

**3. Signal presence is still not compared to the interface.** `opt("body")` on `ask` fails **only** the golden. Update the golden too: **10/10**. Same for `working-on` + `opt("to")` + golden: **10/10**, while `command/index.ts:1866` refuses a recipient on `working-on`. A bogus `wire` on `register.joinCredential` is **10/10** (not rendered; register is not in the signal loop). Drop `ask.body` / `made_up_field` / a second signal rename **fail** without a golden edit.

**4. Live `exactKeys` is still not read.** Spread `"admin_token"` into the ack `exactKeys` list: **10/10**. Checklist item 5 is still green.

**Golden (addendum).** Four-space intro, `POST`-prefix, summary, field note, auth-label, extra empty line: each **1 fail** (golden). That hole is closed unless you edit the golden.

**Zero-parameter.** Default / rest fail. `arguments[0]` with a conditional prepend: tests **10/10**, and `h0AgentDocumentDescription("Join credential TEST_SECRET_VALUE")` puts that line in the document. That is the COUNT the commit already names.

**Commit message.** The three old overclaims are gone. Named mutations that I re-ran fail as claimed. “Triple-slash” means `path=` only; that is wording, and they already say the list is not exhaustive. `declare module` is not named and is not covered.

Not established: no HTTP serve; no `test:p1-local` / `test:p1-server`.

VERDICT: FAIL — leaf walk misses `declare module "../x.js"` (H0 10/10, tsc 0, deno TS2307); ack nullability does not follow a type alias.
