I'll review only `d702852e` against `24b1df45`. First I'll read the commit message and the delta, then check the schema against the server parser. No production hosts.Parent is `24b1df45`. Next I'll pull the full delta and the parser/schema files.The diff was truncated. I'll read the source files and the parser next.Next I’ll read the parser and both wire types so I can compare every field.I'll check whether the new tests are in the `npm test` list, then dump the wire-type AST.Gates first on the clean tree. Then I’ll probe schema vs parser and mutation-test the new controls.Case-fold duplicate gap is real. Waiting on the three gates, then I’ll mutation-test.`npm test` exited 1 on a timing assert while other gates ran. I'll re-run it alone and check whether that failure is in this delta.M1 failed the two tests the commit named. Restoring, then breaking the other controls.M4 didn't apply — the restore raced it. I'll re-apply, confirm the edit, then run the test.Bound to `d702852e` on parent `24b1df45`. Review is this delta only. No request went to `api.commonswarm.com`, `commonswarm.com`, or any `*.supabase.co` host.

No PRODUCTION finding. The old lie (`to` as a string) is gone. Remaining gaps are RIGOUR.

## 1. `to` vs the parser

Schema now:

- `type: array`
- `minItems: 1`
- `maxItems` from `SIGNAL_RECIPIENT_MAX` (8)
- `uniqueItems: true`
- items: object, exact keys `kind` + `id`, `additionalProperties: false`
- `kind` enum from `SIGNAL_RECIPIENT_KINDS` (`user`, `agent`)
- `id`: `string` + `format: uuid`

Checked against `isRecipientEntry`, `signalRecipientListProblem`, `parseSignalRecipients`.

Match: omit the field; one well-formed entry; both kinds; empty list refused; cap 8; extra keys refused; a string `to` refused; exact duplicate refused.

Schema permits, parser refuses:

- `format: uuid` accepts nil / version 0 / version 9 / variant `c` / `ffff…`. `CHAT_UUID_RE` does not. Measured: `00000000-0000-0000-0000-000000000000` is schema-ok, parser-400.
- Case-folded duplicate ids (`aaaaaaaa-…` and `AAAAAAAA-…`). `uniqueItems` sees two JSON values. The parser folds case and refuses. The comment already says this.

Schema refuses, parser permits:

- `to: null`. Parser treats null as absent. H0 field is omittable, not nullable. An agent that omits `to` is fine.

`index.ts` passes the real constants. That wiring is pinned by AST.

## 2. Every other field vs the wire

Compared JSON `.type` to `AckAgentDeliveryCommand` and `SignalCommand` by AST.

| Verb | Field | Document | Wire | Outer type |
|---|---|---|---|---|
| ack | `signal_id` | string | `string` | match |
| ack | `lease_id` | `[string,null]` | `string \| null` | match |
| ack | `listener_instance_id` | `[string,null]` | `string \| null` | match |
| ack | `outcome` | string | `DeliveryAckOutcome` (TypeRef) | match as string; not an enum |
| ack | `last_error_code` | `[string,null]` | `string \| null` | match |
| ack | `surfaced` | boolean | `boolean?` | match |
| ask/note | `body` | string | `string` | match |
| ask/note | `to` | array | `SignalRecipient[]` | match at the array layer |
| ask/note | `requestId` | string | skipped (`command-envelope`) | not compared |
| reply | `signal_id` → `in_reply_to` | string | `string \| null?` | match as string; H0 is stricter |
| reply / working-on | `body` | string | `string` | match |
| register / poll | all | — | no wire in those two interfaces | skipped, as stated |

The type test reads a TypeRef as `"string"`. That holds for `outcome` (`DeliveryAckOutcome` is a string union). It is **false** for `SignalRecipient`: that is an object. It sits inside `to?: SignalRecipient[]`, so the extractor never sees it. Same shape: `attachments?: SignalAttachmentRef[]` on `SignalCommand` (not an H0 field).

Mutation, confirmed on disk first: `items: { type: "string" }` while keeping `type: "array"`. Type test **green**. Golden **red**. The new type test would not catch the next `to` lie if the outer type stayed `array`.

`optional` and `nullable` are extracted and never asserted. Presence lives in `h0-verbs.test.ts` from the parent commit.

## 3. Mutations (each confirmed applied before the run; tree restored after)

| Break | Applied? | Result |
|---|---|---|
| `to` type → `string` | yes | **2 fail**: type test `ask.to: document says string, wire to is array`; golden |
| `index.ts` `{ kinds: ["user","agent"], max: 8 }` | yes | **1 fail**: wiring AST |
| OPTIONS 204 with no `responseHeaders()` | yes | **1 fail**: OPTIONS headers (`null !== 'no-store'`). Old HEAD/OPTIONS test stayed green |
| Delete the unclassified throw | yes (second try; first restore raced, green discarded) | **1 fail**: throw test. Partition stayed green |
| `to` items → `{ type: "string" }` | yes | **1 fail**: golden only. Type test green |

Controls do what the commit says, at the layer they claim.

## 4. Commit message vs diff

The diff does the things it names: `to` is an array of `{ kind, id }`; kinds and max come from the enforcement constants; core stays a leaf; the five new controls exist.

Overclaims, not missing work:

- “each bound read from the parser and verified there” — `minItems: 1` is typed. `id` uses `format: uuid`, not `CHAT_UUID_RE` (and that regex is not exported).
- “`parseSignalRecipients` returns null for anything but that array” — a string does return null. An empty array returns `[]`. Empty is refused by `signalRecipientListProblem`, which is the function they actually used for `minItems`.
- “generating the `outcome` enum would mean importing `durable-delivery.ts`” — the new test already reads that file as text. A runtime import would pull `postgres`. An AST enum would not.
- Evidence file `v4-arm-grok-PASS.md` is bound to `104f48a7` (parallel copy of the parent), not `24b1df45`. Opening lines are concatenated stream text. The review body is readable.

## Gates (`env -u FORCE_COLOR`)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `npm test` | 0, 874/874 (alone). A parallel run with `test:p1-cli` was 873/874 on `OpenCode: a held close cannot hang the child failure` at 1510 ms vs 1300 ms. That file is not this delta. |
| `npm run test:p1-cli` | 0, 704/704 (all 14 H0 tests ran) |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 (`h0/index.ts` included) |
| `git diff --check` | 0 |

`npm test` still does not name `h0-agent-document.test.ts`. `test:p1-cli` does, via the glob. Same as the parent.

Not established: no `functions deploy` of `h0`. No live request returned this document.

## Findings

**PRODUCTION:** none on this SHA. The served schema no longer tells an agent to send a string `to`.

**RIGOUR**

1. `id` is `format: uuid`, not `CHAT_UUID_RE`. Nil and other RFC-shaped ids that the parser refuses are schema-legal.
2. Type test compares only the outer JSON type. `SignalRecipient` is an object TypeRef. Array-of-string stays green; the golden is the item-shape control.
3. `outcome` is still a plain string. Disclosed. The reason (“must import durable-delivery”) is weaker than stated, because they already parse that file.
4. Prose in the description still says only `to (may be omitted)`. The array shape lives in the schema, not in the field list.

VERDICT: PASS — `to` is now an array of `{kind,id}` against the parser; the new controls fail when broken; leftover uuid/item-shape gaps are RIGOUR.
