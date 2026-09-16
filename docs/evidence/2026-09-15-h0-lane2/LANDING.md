# H0 lane 2 — landing record

Landed commits (oldest first): 24b1df45 feat, d702852e fix `to`, 2bc56127 fix closed sets.

## The pair
- antigravity PASSED d702852e: no new production defect. Flagged pre-existing `outcome` open
  string, fixed in 2bc56127.
- grok PASSED d702852e: no production defect.
Both arms reviewed the same SHA. 2bc56127 fixes their rigour findings in place under the sprint's
pacing rule. It also closes `outcome`, which antigravity labelled PRODUCTION. That item was
pre-existing, and the fix follows the same tested pattern as `to`, with its own mutations. Recorded
as a judgment call, not hidden.

## Accepted rigour gaps, stated rather than chased
- Recipient `id` is `format: uuid`. The server's CHAT_UUID_RE
  (supabase/functions/_shared/channels.ts:116) also requires a version nibble in [1-8] and a variant
  in [89ab], so the schema permits a nil UUID the server refuses. Matching it would mean exporting a
  deliberately module-local regex and translating its `/i` flag, which JSON Schema `pattern` cannot
  express. Agents take recipient ids from server responses, so they do not produce nil UUIDs.
- `minItems: 1` and `uniqueItems` follow the lead's reading of signalRecipientListProblem; no test
  executes the parser. The server also folds id case before its duplicate check, which uniqueItems
  cannot express.
- The document's prose field list says `to (may be omitted)` without the array shape; the shape is
  in the schema.

## Corrections to landed commit messages (messages are immutable; corrected here)
- d702852e: "parseSignalRecipients returns null for anything but that array" is imprecise. A string
  returns null, but an EMPTY array returns []. The empty list is refused by
  signalRecipientListProblem, the function the minItems bound actually follows.
- d702852e: "each bound read from the parser and verified there" — the bounds were read by the lead,
  not verified by any test. 2bc56127 corrects this and adds an item-shape test.
- d702852e: "cannot load under Node tests" — false. Measured: tsx, tsc, and deno check all load
  durable-delivery.ts, exit 0. Corrected and acted on in 2bc56127.
- The evidence file v4-arm-grok-PASS.md reviewed 104f48a7, the pre-rebase twin of 24b1df45.
  `git range-diff` shows the patch is identical (104f48a7 = 24b1df45).

## Flake, three occurrences, not this lane
host-stderr-exit-parity.ts failed with a wall-clock ceiling of 1300 ms: Codex at 1440 ms, OpenCode at
1504 ms, and OpenCode at 1510 ms (the last in grok's own run). All three runs were under load and all
passed on rerun. None of these diffs touch host code. Filed as a separate task.

## Not established
Nothing is deployed. No live request has reached an h0 function. `register` and `poll` have no wire
to compare against yet.
