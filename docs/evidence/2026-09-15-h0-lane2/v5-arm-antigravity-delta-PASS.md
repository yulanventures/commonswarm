### Findings

#### [PRODUCTION]
1. **`outcome` on `POST /ack` is typed as an unconstrained string instead of an enum**
   - **Server Interface:** `AckAgentDeliveryCommand.outcome` is typed as `DeliveryAckOutcome` (a closed enum of valid delivery outcomes, enforced by the server with a `400` refusal for invalid values).
   - **Golden Fixture:** Types `outcome` as an open `{"type": "string"}` without an `enum` definition. A deployed system tells AI agents that arbitrary strings are acceptable, but sending any value outside `DELIVERY_ACK_OUTCOMES` will be rejected by the server.
   *(Note: This is a pre-existing discrepancy in the base document acknowledged in the commit's "NOT ESTABLISHED" notes, pinned in the new golden fixture and masked by the new wire AST test).*

---

#### [RIGOUR]
1. **`to` schema diverges from server rules on case-folded duplicates and explicit `null`**
   - **Case-insensitive duplicates (permitted by schema, refused by server):** The schema declares `uniqueItems: true`, which in JSON Schema checks strict equality. The server's `signalRecipientListProblem` folds case (`${entry.kind}:${entry.id.toLowerCase()}`) and refuses duplicates with `"to names the same recipient twice."`.
   - **Explicit `null` (refused by schema, permitted by server):** The schema specifies `to: { type: "array", ... }`, refusing `null`. The server's `signalRecipientListProblem` explicitly permits `null` (`if (value === undefined || value === null) return null;`), treating explicit `null` as absent ("no list").
2. **`test("every field's JSON TYPE matches the wire member it maps to")` can pass while properties are broken**
   - **Array items unchecked:** The test only extracts and compares the top-level kind (`"array" === "array"`). If `to.items` were typed as `integer`, `string`, or an empty object, the test would still pass.
   - **Type references default to `"string"`:** In `wireMembers`, any non-array/boolean/number type falls through to `"string"`. If a wire property were an object interface or a closed union/enum (like `DeliveryAckOutcome`), it is read as `"string"`, allowing a mismatch in the schema to pass undetected.
   - **Nullability and optionality unchecked:** `wireMembers` computes `nullable` and `optional`, but the test assertion ignores them completely.
   - **Incomplete coverage:** Skips `register` and `poll` (`if (!wire) continue;`), and skips envelope fields like `requestId`.
3. **`test("the whole served OpenAPI document equals its REVIEWED golden")` does not test the served document**
   - The test invokes `agentDocument()` directly (`buildH0AgentDocument(...)`). It does not invoke `handleH0Request()`; any divergence or failure in the actual HTTP serving logic would leave this test green.
4. **`test("index.ts passes the ENFORCEMENT's recipient constants, not a copy")` lacks semantic symbol resolution**
   - The test checks AST identifier text (`property.initializer.text === "SIGNAL_RECIPIENT_MAX"`). If `index.ts` shadowed or redeclared that identifier locally (`const SIGNAL_RECIPIENT_MAX = 99`), the AST check would still pass.
5. **Commit message overclaims**
   - **Failing tests message:** The message claims reverting `to` to string *"fails 2 tests with 'ask.to: document says string, wire to is array'"*. Only the wire AST test produces that assertion message; the golden test fails with an `AssertionError` from `assert.deepEqual`.
   - **Bounds "read from parser and verified":** The commit claims *"each bound read from the parser and verified there rather than asserted: `minItems: 1` ... `uniqueItems` ... `{ kind, id }`"*. In reality, `minItems: 1`, `uniqueItems: true`, and the item object schema are hardcoded in `core.ts` (only `SIGNAL_RECIPIENT_MAX` and `SIGNAL_RECIPIENT_KINDS` are imported), and no test executes the parser to verify those schema bounds.
   - **Completeness of wire comparison:** Claims *"Each field's JSON type is now compared to the wire member's TypeScript type"*, but it skips unmapped verbs (`register`, `poll`), skips envelope fields (`requestId`), and checks only coarse top-level kinds.

---

### Questions Answered

1. **Does the new `to` schema match the server code exactly?**
   No. It permits case-insensitive duplicate IDs that the server refuses (because JSON Schema `uniqueItems: true` is case-sensitive while `signalRecipientListProblem` folds case via `.toLowerCase()`). It refuses explicit `null` (`type: "array"`) that the server permits (`value === null` returns `null`, meaning "no list").

2. **In the GOLDEN FIXTURE, is any OTHER field typed differently from its server interface?**
   Yes: `outcome` on `POST /ack`. In `AckAgentDeliveryCommand`, `outcome` is typed as the union/enum `DeliveryAckOutcome`. In the golden fixture, it is typed as an unconstrained `{"type": "string"}`. The AST reader defaults the named type reference `DeliveryAckOutcome` to `"string"`, allowing this divergence to pass the wire type test.

3. **Could any of the new tests pass while the property it names is broken?**
   Yes:
   - `test("every field's JSON TYPE matches the wire member it maps to")` passes if `to` array item schemas are completely wrong (only checks top-level `"array"`), if type references are objects, or if nullability/optionality diverges.
   - `test("the whole served OpenAPI document equals its REVIEWED golden")` passes even if `handleH0Request` fails to serve or mutates the document (it tests `agentDocument()`, not the HTTP handler).
   - `test("index.ts passes the ENFORCEMENT's recipient constants, not a copy")` passes if the constants are shadowed locally by identifiers of the same name.

4. **Does the commit message claim anything the diff does not do?**
   Yes:
   - It claims putting `to` back to string fails two tests with `"ask.to: document says string, wire to is array"`, but only one test produces that message.
   - It claims schema bounds (`minItems: 1`, `uniqueItems`, `{ kind, id }`) are read from the parser and verified there; they are hardcoded in `core.ts` and never verified against parser execution.
   - It claims each field is compared to its TypeScript wire type, but skips envelope fields, skips `register` and `poll`, and only compares coarse types.

---

VERDICT: PASS — The commit successfully resolves the production defect where `to` was typed as a string instead of a recipient array, isolates the shared constants to preserve leaf constraints, and introduces no new production defects into this lane.
