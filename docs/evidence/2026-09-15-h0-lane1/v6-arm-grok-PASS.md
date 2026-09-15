I'll start by reading the review commit and the current tree, then mutation-test the AST extraction, vocabulary, golden, and leaf walk.HEAD is `5e6d9769`, not `e8e1a069`. I’ll read this round’s commit and the implementation files next.I'll read the implementation, the tests, and the prior arm notes in parallel.I’ll read the live command types and the leaf-walk edges next, then start mutations.I’ll pull the H0 spec for the intended wire, then run a mutation harness against the tests.I’ll snapshot the two files, then run a mutation loop against the H0 tests and a Deno leaf probe.Baseline is 11/11. Next I’ll run the claimed-fail mutations and the attack cases.Claimed failures hold. Next I’ll hunt coordinated table+golden holes and leaf-specifier misses.JSDoc did not move Deno. Next I’ll try `lib=` without `./`, `new URL(..., import.meta.url)`, and other specifier shapes tsc might ignore.Worktree is clean. Running the required gates with real exit codes next.`test:p1-cli` raced `build` wiping `dist/`. I’ll rerun it now and count H0 names in both gates.SHA `5e6d9769`. Tree left clean. Probe deleted.

**PRODUCTION (would be wrong if this document were served today): none.**  
Ack matches `AckAgentDeliveryCommand` and the live `exactKeys` list (`kind`, `signal_id`, `lease_id`, `listener_instance_id`, `outcome`, `last_error_code`, optional `surfaced`). `working-on` has no recipient field. `reply` has no `to`. The served text equals the golden. This lane still does not serve HTTP.

**RIGOUR (stays green; current document is still right).**

The same `command/index.ts` comment names two per-verb refusals. Only one is pinned.

```1859:1881:supabase/functions/command/index.ts
      /* `to` is a THIRD way to address a signal... A working-on signal says what you are
       * doing and is addressed to nobody; a private reply is addressed by
       * in_reply_to and by nothing else. Both spellings are refused here... */
      (
        cmd.signal_kind !== "working-on" ||
        ( ... !addressedByList )
      ) &&
      (
        inReplyTo === null ||
        (
          cmd.signal_kind === "note" &&
          ... !addressedByList
        )
      )
```

`working-on` + `opt("to")` + golden: **1 fail** (the new per-verb rule). Good.

`reply` + `opt("to")` + golden: **11/11 green.**  
`ask` + `opt("in_reply_to")` + golden: **11/11 green.**  
`req("body", true)` on `ask` + golden: **11/11 green** (signal nullability is extracted, then ignored).  
`opt("signal_id")` on `reply` + golden: **11/11 green** (the rename branch does not compare presence).  
A signal rename on `register.joinCredential`: **11/11 green** with no golden edit (register is not in the signal loop; `wire` is not printed).

Table-only edits of those still fail the golden. The hole is the one they just closed for `working-on`: edit the table and the golden together, and the interface check says yes.

Golden injections (four-space, `POST`-prefix, summary, note, auth label, extra empty line): each **1 fail**. That hole is closed.

**Leaf walk.** Covered shapes now fail the H0 test: import, export-from, import-type, `typeof import`, `declare module "../x.js"`, `path=`, `types=`. I did not find another tsc-green / Deno-red `.js` vs `.ts` split.

Misses that are **not** that split (H0 11/11, and `tsc` also fails, so `npm run build` catches them):

- `/// <reference path="cloud/session-wire.js" />` (no `./`) — walk only records specifiers that start with `.`. Deno **TS2307**, `tsc` **2**.
- `/// <reference lib="../cloud/session-wire.js" />` — `libReferenceDirectives` is unread. Deno **TS2726**, `tsc` **2**.

JSDoc `@import` / `@type {import("../x.js")}`, `amd-dependency`, `new URL(..., import.meta.url)`, `createRequire`: H0 green, **and Deno 0**. They do not break the edge build.

Zero-parameter: default / rest / destructure / `this` fail. `arguments[0]` (only when an arg is passed) and a module-level `export let` stay **11/11**. Calling `h0AgentDocumentDescription("Join credential TEST_SECRET_VALUE")` puts that line in the document. That is the COUNT the commit already names.

**Deferred items — plausible or only a fight with the test?**

| hole | single plausible edit? | stay-green? |
|---|---|---|
| Nullability does not follow a type alias | `type LeaseId = string \| null` is a normal DRY move | **No.** Tests go red. Green only if you then change the table and the golden to drop “may be null”. That is trusting a broken extractor. The golden diff would show the words going away. **Defer is fair.** |
| `extends` a base | Moving **existing** fields onto a base **fails** (good). Adding a **new** required field on the base stays green | Unusual way to add a wire field. People add it on the interface itself, and that **fails**. **Defer is fair.** |
| Live `exactKeys` unread | Spreading `"admin_token"` is a fight with the test. A validator-only new key with no interface change is a sloppy PR and **would 400**. The usual complete edit (interface + `exactKeys`) **is** caught if H0 is forgotten | **Defer is fair** if the compare stays “interface, not validator”. |

**Commit message.** Named mutations fail as claimed. The three old overclaims are gone. One remaining stretch: “NAME AND PRESENCE” is true only for unmapped signal fields. The one declared rename (`reply.signal_id`) is the field whose presence is **not** compared.

**Gates** (`env -u FORCE_COLOR`; real exits, no pipe):

| command | exit |
|---|---|
| `npm run build` | **0** |
| `npm test` | **0**, 874/874, **zero** H0 names |
| `npm run test:p1-cli` | **0**, 689/689, all **11** H0 names |
| `npm run check:tests` | **0** |
| `npm run check:edge` | **0** |
| `git diff --check` | **0** |

Not established: no HTTP serve; no `test:p1-local` / `test:p1-server`.

Fix-in-place if you want it: pin `reply` the same way as `working-on` (no `to` / no extra address), and compare signal **nullability** plus **presence on the rename**. That is RIGOUR, not a current product lie.

VERDICT: PASS — no current product mismatch vs the live ack/signal edge; stay-green holes are RIGOUR (reply+to with golden, signal nullability, rename presence).
