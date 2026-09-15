I'll treat this as the third failed attempt and hunt for mutations that stay green. First I'll read the commit, the review surface, and the current tree.Worktree is on `e8e1a069`. Next I’ll read the full patch and the two files that actually enforce the claims.The last two rounds failed on circular tests and regex holes. I’ll read the live command types next, then mutation-test the AST and allowlist.Baseline is 10/10. Next I’ll mutation-test the seams, then run the real gates on a clean tree.Claimed failures are real. Next I’ll attack the allowlist, AST extraction, signal presence, and leaf walk.Allowlist and signal presence both stayed green. Next I’ll hit extraction, zero-param, leaf imports, and exactKeys.SHA `e8e1a069`. Worktree left clean. Probe removed.

Ack vs the **interface** is real. The rest of the new method is still text, or it does not look at the thing it names.

## Gates (real exits, `env -u FORCE_COLOR`)

| command | exit |
|---|---|
| `npm run build` | **0** |
| `env -u FORCE_COLOR npm test` | **0**, 874/874, **zero** H0 names |
| `env -u FORCE_COLOR npm run test:p1-cli` | **0**, 688/688, all 10 H0 names present |
| `npm run check:tests` | **0** |
| `npm run check:edge` | **0** |
| `git diff --check` | **0** |

Those gate claims in the commit are true.

## What this round did fix

I broke the table and the tests went red, as the commit says:

| mutation | H0 result |
|---|---|
| `req("lease_id", true)` → `opt(...)` | **1 fail** (ack deepEqual) |
| `lease_id` nullable → `false` | **1 fail** |
| drop `surfaced` | **1 fail** |
| extra `admin_token` on ack | **1 fail** |
| drop `ask.body` | **1 fail** (signal test) |
| `ask` + `made_up_field` | **1 fail** |
| `ask` + copy of `signal_id → in_reply_to` | **1 fail** |
| default / rest / destructure / `this` param | **fail** (zero-param) |
| new prose line `Join credential TEST_SECRET_VALUE` | **1 fail** (allowlist) |
| `shadow_field: required` in the intro (no 4-space indent) | **1 fail** |
| `import type { X } from/* split */"../cloud/config.js"` | **1 fail** (leaf) |

Rename / move / `type` alias / re-export of `AckAgentDeliveryCommand` all fail **loudly** (`expected one interface`). Empty extraction does not pass. Heritage (`extends` a base) is a **partial** set and also fails loudly.

So axis 1 is not a silent empty compare. Name, `?`, and a syntactic `null` union member **are** compared for ack **members written on that interface**.

## 1. The compare is still not the live wire

H0 reads `interface AckAgentDeliveryCommand`. Runtime ack uses `exactKeys` in `command/index.ts`.

Spread `"admin_token"` into that `exactKeys` list. **10/10 green.** Lead checklist item 5 is still green.

`includesNull` does not follow a type alias. `type LeaseId = string \| null; lease_id: LeaseId` plus table `nullable: false` is **10/10 green**. The document then omits `may be null` while the type is still `string | null`.

A generic `AckAgentDeliveryCommand<T>` still extracts members. That one is fine.

## 2. Signal vocabulary is names only

`interfaceContract` **does** compute presence and nullability for `SignalCommand`. The test then only does `signal.has(name)` plus “is `body` mapped”. It never compares the two flags.

| mutation | H0 |
|---|---|
| `ask` `req("body")` → `opt("body")` | **10/10 green** |
| `ask` `req("body", true)` (nullable) | **10/10 green** |
| `working-on` + `opt("to")` (edge refuses `to` on working-on at `command/index.ts:1866`) | **10/10 green** |
| `ask` + `opt("about")` (`about` is a required key on the post_signal list) | **10/10 green** |
| bogus rename / drop `body` / unknown field **on ask** | **fail** (good) |
| bogus rename or `made_up_field` **on register** | **10/10 green** |

The v1 presence bug moved. Ack is pinned. Ask/note/reply/working-on are not. Register/poll have no contract, as the commit says.

## 3. The allowlist is a regex. That is the seam.

```224:227:tests/p1-cli/h0-verbs.test.ts
  const tableDerived = (line: string) =>
    /^POST [a-z-]+ /.test(line) || /^ {4}\S/.test(line);
  const prose = h0AgentDocumentDescription().split("\n").filter((l) => !tableDerived(l));
  assert.deepEqual(prose, ALLOWED_PROSE);
```

`parseDocumentFields` still does `if (currentVerb === null) continue`. Intro lines are skipped, not failed. If `tableDerived` is true, the allowlist never sees them.

The round-2 spelling `Join credential TEST_SECRET_VALUE` (no `:` / `=` / `is`) is still in the served document, **10/10 green**, if you put it on a line the regex trusts. `ALLOWED_PROSE` is not edited.

| injection | secret in doc | H0 |
|---|---|---|
| intro `"    Join credential TEST_SECRET_VALUE"` | yes | **green** |
| intro `"POST hidden Join credential TEST_SECRET_VALUE"` (no em dash) | yes | **green** |
| intro `"    admin_token (required) — Join credential TEST_SECRET_VALUE"` (fake field, skipped) | yes | **green** |
| field **note** on `joinCredential` | yes | **green** |
| verb **summary** | yes | **green** |
| auth label `"join credential TEST_SECRET_VALUE in the body"` | yes | **green** |
| extra empty intro line | no | **fail** (good) |
| rename `register` | no | **fail** (good) |

The denylist still misses that no-separator spelling. The allowlist was added to catch it. `tableDerived` lets it through.

## 4. Zero parameters is a count, not a wall

Default / rest / destructure / `this` fail. Good.

`arguments[0]`: `parameters.length === 0`, tests **10/10 green**. `h0AgentDocumentDescription.length === 0`. Call with `'Join credential TEST_SECRET_VALUE'` and that line is in the document. Call with no args (the test) and it is not.

`export let extraDocumentLine` plus interpolate: **10/10 green**.

`process.env` is the ambient global the commit already admits.

## 5. Leaf walk misses `import()` types. Deno proves it.

The visitor records `ImportDeclaration`, `ExportDeclaration`, `import = require()`, and `import()`. It does not record `ImportTypeNode` or triple-slash `referencedFiles`.

Add:

```ts
type _LeafProbe = import("../cloud/session-wire.js").AgentSessionProof;
```

H0 leaf test: **10/10 green**. Project `tsc --noEmit`: **0**. Then:

```
deno check --config supabase/functions/command/deno.json supabase/functions/command/_h0_leaf_probe.ts
```

- clean `verbs.ts`: **exit 0**
- with that line: **exit 1**, `TS2307` cannot find `src/cloud/session-wire.js`

`typeof import("../cloud/session-wire.js")` is the same miss. `/// <reference path="./definitely-missing.ts" />` is also green in H0 and **exit 1** in Deno.

Probe deleted. `verbs.ts` restored.

The commit says “every specifier shape is covered”. That is false. This is the `.js` vs `.ts` split the leaf rule exists to stop.

## 6. Commit message vs tree

True: the listed “must fail” mutations fail; gates and 688/688; H0 present in `test:p1-cli` and absent from `npm test`; ambient global not covered; register/poll have no contract.

False / too big:

- “every specifier shape is covered”
- “Adding any line fails until someone edits the list”
- “RUNTIME secret structurally impossible”
- “the round-2 gap where only two fields were pinned cannot recur” — true for ack, false for signal presence
- checklist item 5 (extra `exactKeys` key) still green in these tests

Not established: I did not serve this document over HTTP. I did not run `test:p1-local` or `test:p1-server`. The `exactKeys` spread was only shown green under `h0-verbs.test.ts`, not the whole suite.

VERDICT: FAIL — `tableDerived` is a text regex that lets `Join credential TEST_SECRET_VALUE` into the document (4-space intro, POST-prefix, notes, summaries) at 10/10; signal presence is uncompared (`opt("body")` green); leaf misses `import("../x.js")` types (deno TS2307, tests green).
