### 1. Can the table disagree with the real ack or signal wire in a way that would make the served document tell an agent something the server REJECTS, while all tests pass?

Yes. While the golden snapshot ([tests/p1-cli/h0-verbs.test.ts:245-308](file:///tests/p1-cli/h0-verbs.test.ts#L245-L308)) pins the literal document text, the programmatic contract tests can pass despite server-rejecting disagreements:

1. **`reply.signal_id` presence is not verified by AST contract checks** ([tests/p1-cli/h0-verbs.test.ts:156](file:///tests/p1-cli/h0-verbs.test.ts#L156)): `reply.signal_id` maps to `in_reply_to` on `SignalCommand`, where `in_reply_to` is optional (`presence: "omittable"`). If `reply.signal_id` is changed to `opt("signal_id")`, `assertContract` passes because `member.presence === "required"` is false. If the golden were updated, all tests pass while the served document tells agents `signal_id` is omittable, which `supabase/functions/command/index.ts:1860` rejects.
2. **Per-verb server validation vs broad `SignalCommand` interface** ([tests/p1-cli/h0-verbs.test.ts:130-181](file:///tests/p1-cli/h0-verbs.test.ts#L130-L181)): The test checks signal fields against the generic `SignalCommand` interface. If an optional field from `SignalCommand` (e.g. `to_user_id` or an unpinned addressing field) is added to a verb that the runtime handler forbids, `assertContract` passes.
3. **Required nullable fields omitted from signal verbs** ([tests/p1-cli/h0-verbs.test.ts:136-140](file:///tests/p1-cli/h0-verbs.test.ts#L136-L140), [183-188](file:///tests/p1-cli/h0-verbs.test.ts#L183-L188)): `requiredInputs` filters by `field.presence === "required" && !field.nullable`. If `SignalCommand` requires a key that is nullable (`foo: string | null`) and the adapter does not default it, an H0 verb can omit it entirely without failing `requiredInputs` or `assertContract`.
4. **Envelope mapping (`requestId`) lacks AST comparison** ([tests/p1-cli/h0-verbs.test.ts:163-170](file:///tests/p1-cli/h0-verbs.test.ts#L163-L170)): `requestId` is asserted against hardcoded literals rather than parsing the command envelope interface. Drift in envelope requirements is not detected by AST checks.
5. **Types and conditional shapes are unmodelled** ([src/h0/verbs.ts:41-57](file:///src/h0/verbs.ts#L41-L57)): `H0Field` models only name, presence, and nullability, not types (scalar vs list for `to`), UUID formats, or conditional requirements (e.g., `lease_id` must be null when `outcome === "observed"`).

---

### 2. Is the directional rule right? Find a case where "stricter than the wire" is actually wrong for an agent, or where a looser field slips through.

The directional rule is **partially right** for basic input narrowing (e.g., requiring an input that the shared wire route leaves optional), but **flawed as a universal axiom**:

- **Where "stricter than the wire" is wrong for an agent**:
  1. **Conditional nullability requirements** ([src/h0/verbs.ts:123-126](file:///src/h0/verbs.ts#L123-L126), [tests/p1-cli/h0-verbs.test.ts:121-127](file:///tests/p1-cli/h0-verbs.test.ts#L121-L127)): If H0 enforces `nullable: false` on a field nullable on the wire, this is invalid whenever the backend *demands* null under specific outcomes (e.g. `ack.lease_id` must be null when `outcome === "observed"`, and `ack.last_error_code` must be null unless `outcome === "failed_terminal"`). Telling the agent the field cannot be null forces a non-null value that the server rejects with a 400.
  2. **Prohibited optional fields** ([tests/p1-cli/h0-verbs.test.ts:114-120](file:///tests/p1-cli/h0-verbs.test.ts#L114-L120), [401-416](file:///tests/p1-cli/h0-verbs.test.ts#L401-L416)): If H0 marks an optional wire field `required` on a verb that forbids addressing (e.g. `req("to")` on `working-on`), `assertContract` passes ("stricter than wire"), but the server rejects the request at runtime.
- **Where a looser field slips through**:
  1. **Omittable renamed field (`reply.signal_id`)** ([tests/p1-cli/h0-verbs.test.ts:114-120](file:///tests/p1-cli/h0-verbs.test.ts#L114-L120), [156](file:///tests/p1-cli/h0-verbs.test.ts#L156)): Because `in_reply_to` is `omittable` in `SignalCommand`, changing `reply.signal_id` to `opt("signal_id")` passes `assertContract` without error.
  2. **Required nullable wire fields** ([tests/p1-cli/h0-verbs.test.ts:136-140](file:///tests/p1-cli/h0-verbs.test.ts#L136-L140)): A required wire property with `nullable: true` is excluded from `requiredInputs` and can be completely omitted by an H0 verb.

---

### 3. For each test: can it fail? Name any that cannot.

**All 12 test suites can fail** as top-level tests:
1. `ack's table equals AckAgentDeliveryCommand on name, presence, and nullability` ([tests/p1-cli/h0-verbs.test.ts:88](file:///tests/p1-cli/h0-verbs.test.ts#L88)): **Can fail** if `ack` members, presence, nullability, or ordering differ from `AckAgentDeliveryCommand`.
2. `signal verb fields name a SignalCommand member or declare their envelope mapping` ([tests/p1-cli/h0-verbs.test.ts:130](file:///tests/p1-cli/h0-verbs.test.ts#L130)): **Can fail** if unknown fields exist, `body` is omitted, rename target is not `in_reply_to`, or `requestId` mapping deviates. *(Caveat: the inner `assertContract` call on line 156 cannot fail on presence for `reply.signal_id`).*
3. `the document's strictly parsed field contracts equal the table` ([tests/p1-cli/h0-verbs.test.ts:220](file:///tests/p1-cli/h0-verbs.test.ts#L220)): **Can fail** if renderer output deviates from parser regex grammar or table fields.
4. `h0AgentDocumentDescription has zero parameters` ([tests/p1-cli/h0-verbs.test.ts:228](file:///tests/p1-cli/h0-verbs.test.ts#L228)): **Can fail** if parameters are added or if function declaration count !== 1.
5. `the SERVED DOCUMENT equals its golden, line for line` ([tests/p1-cli/h0-verbs.test.ts:245](file:///tests/p1-cli/h0-verbs.test.ts#L245)): **Can fail** on any character, whitespace, or line difference.
6. `the document contains none of the known join-credential assignment spellings` ([tests/p1-cli/h0-verbs.test.ts:310](file:///tests/p1-cli/h0-verbs.test.ts#L310)): **Can fail** if banned assignment patterns appear or "not in this document" is removed.
7. `the H0 module is a LEAF — no relative imports, or the edge function stops building` ([tests/p1-cli/h0-verbs.test.ts:325](file:///tests/p1-cli/h0-verbs.test.ts#L325)): **Can fail** if any relative import/export, dynamic import, `declare module`, `import()`, or triple-slash reference (`path=`, `types=`, `lib=`) is detected.
8. `exactly one verb is reachable without a seat, and it is register` ([tests/p1-cli/h0-verbs.test.ts:369](file:///tests/p1-cli/h0-verbs.test.ts#L369)): **Can fail** if `H0_PREAUTH_VERBS !== ["register"]` or preauth verb count !== 1.
9. `the table is the seven verbs H0 specifies, in order` ([tests/p1-cli/h0-verbs.test.ts:374](file:///tests/p1-cli/h0-verbs.test.ts#L374)): **Can fail** if verbs are added, removed, or reordered.
10. `h0Verb resolves a known verb and refuses an unknown one` ([tests/p1-cli/h0-verbs.test.ts:382](file:///tests/p1-cli/h0-verbs.test.ts#L382)): **Can fail** if `ack` fails to resolve or `activity` does not return `null`.
11. `` `reply` is addressed by in_reply_to and by nothing else `` ([tests/p1-cli/h0-verbs.test.ts:387](file:///tests/p1-cli/h0-verbs.test.ts#L387)): **Can fail** if `to`, `to_user_id`, or `to_agent_principal_id` is declared on `reply`.
12. `` `working-on` addresses nobody, because the server refuses a recipient on it `` ([tests/p1-cli/h0-verbs.test.ts:401](file:///tests/p1-cli/h0-verbs.test.ts#L401)): **Can fail** if addressing fields (`to`, `signal_id`, etc.) are declared on `working-on`.

---

### 4. Does any comment or the commit message claim more than the code does?

Yes:
1. **[tests/p1-cli/h0-verbs.test.ts:150-156](file:///tests/p1-cli/h0-verbs.test.ts#L150-L156) & Commit message claim on `reply.signal_id`**: The comment claims `reply.signal_id -> in_reply_to` has its presence contract-checked. Because `in_reply_to` is optional on `SignalCommand`, `assertContract` skips checking presence entirely.
2. **[tests/p1-cli/h0-verbs.test.ts:172-177](file:///tests/p1-cli/h0-verbs.test.ts#L172-L177) claim on `working-on.to`**: The comment states comparing presence to the interface catches `opt("to")` on `working-on`. Because `to` is optional in `SignalCommand`, `assertContract` does not catch it; it is caught solely by lines 401–416 and the golden test.
3. **[tests/p1-cli/h0-verbs.test.ts:104](file:///tests/p1-cli/h0-verbs.test.ts#L104) claim that "Narrowing is safe"**: Narrowing presence or nullability is unsafe whenever the backend conditionally mandates null or prohibits a field.
4. **Duplicate comment block ([tests/p1-cli/h0-verbs.test.ts:348-354](file:///tests/p1-cli/h0-verbs.test.ts#L348-L354))**: Leftover redundant triple-slash comment preceding lines 351–354.

---

### Findings Ranking

- **PRODUCTION**: None. [src/h0/verbs.ts](file:///src/h0/verbs.ts) accurately reflects backend wire requirements for all 7 verbs, auth boundaries, leaf module constraints, and document rendering.
- **RIGOUR**:
  1. [tests/p1-cli/h0-verbs.test.ts:156](file:///tests/p1-cli/h0-verbs.test.ts#L156): `assertContract` on `reply.signal_id -> in_reply_to` does not test presence due to directional asymmetry against an optional wire field.
  2. [tests/p1-cli/h0-verbs.test.ts:136-140](file:///tests/p1-cli/h0-verbs.test.ts#L136-L140): `requiredInputs` excludes required nullable wire fields (`!field.nullable`).
  3. [tests/p1-cli/h0-verbs.test.ts:163-170](file:///tests/p1-cli/h0-verbs.test.ts#L163-L170): `requestId -> command_id` mapping is verified against literals rather than the command envelope AST.
  4. [tests/p1-cli/h0-verbs.test.ts:104](file:///tests/p1-cli/h0-verbs.test.ts#L104), [150-156](file:///tests/p1-cli/h0-verbs.test.ts#L150-L156), [172-177](file:///tests/p1-cli/h0-verbs.test.ts#L172-L177): Comments overstate the enforcement provided by directional `assertContract`.

VERDICT: PASS
The production table and generated agent document match server contracts with zero production defects, and the golden snapshot prevents drift despite the directional AST test's theoretical blind spot on reply.signal_id presence.
