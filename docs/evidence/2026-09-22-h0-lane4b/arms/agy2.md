### Findings

#### site/src/components/connect/h0-link-join.observer.test.ts:273-276
**Severity**: RIGOUR
**Evidence**:
The test compares `joinInviteLimitSentence()` directly against a template string interpolated with the generator's own constants:
```ts
assert.equal(
  joinInviteLimitSentence(),
  `Up to ${AGENT_JOIN_SEAT_CAP_MAX} agents can join. This invite lasts ${AGENT_JOIN_TTL_MAX_HOURS} hours.`,
);
```
This duplicates the implementation of the generator function instead of validating against the expected user-facing copy (e.g. `"Up to 100 agents can join. This invite lasts 168 hours."`). This violates the repo rule: *"a test that compares a generated artifact to its own generator is circular and proves nothing"*.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:303
**Severity**: RIGOUR
**Evidence**:
In `test("mint sends seat_cap and ttl_hours inside the server limits and no credential")`:
```ts
assert.deepEqual(command, mintAgentJoinCredentialCommand());
```
`mintJoinInvite` builds its outgoing command using `mintAgentJoinCredentialCommand()`. Comparing `command` against `mintAgentJoinCredentialCommand()` compares the generated command artifact directly to its own generator rather than asserting its shape and fields against an independent contract.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:380
**Severity**: RIGOUR
**Evidence**:
In `test("revoke sends join_credential_id and nothing else")`:
```ts
assert.deepEqual(command, revokeAgentJoinCredentialCommand(mixed));
```
`revokeJoinInvite` builds the revoke command payload using `revokeAgentJoinCredentialCommand(mixed)`. Comparing the payload directly against `revokeAgentJoinCredentialCommand(mixed)` is circular and does not independently prove the command structure.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:322-325
**Severity**: RIGOUR
**Evidence**:
The paste output returned by `mintJoinInvite` is verified by calling `h0AgentPaste` with the same inputs:
```ts
assert.equal(reveal.paste, h0AgentPaste({
  joinCredential: SECRET,
  documentUrl,
}));
```
This compares the generated artifact directly to the return value of its generator function, providing no independent verification of the paste format.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:232-239
**Severity**: RIGOUR
**Evidence**:
In `test("the invite flag is off unless the value is exactly 1, and off keeps today's prompt")`:
```ts
const compiled = new Function(
  "flag",
  `return ${expr.replace("import.meta.env.PUBLIC_H0_LINK_JOIN", "flag")};`,
) as (flag: string | undefined) => boolean;
for (const flag of [undefined, "", "0", "true", "1"]) {
  assert.equal(compiled(flag), h0LinkJoinFlagEnabled(flag));
}
```
If `h0-link-join-flag.ts` defines `h0LinkJoinEnabled` by delegating to `h0LinkJoinFlagEnabled(import.meta.env.PUBLIC_H0_LINK_JOIN)`, then `compiled(flag)` evaluates to `h0LinkJoinFlagEnabled(flag)`. Asserting `compiled(flag) === h0LinkJoinFlagEnabled(flag)` evaluates the same function against itself.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:243-259
**Severity**: RIGOUR
**Evidence**:
Check (1) requires proving that flag OFF produces byte-for-byte today's behaviour. The test fails to prove this:
1. `stripFlagged` is a synthetic parser that slices out `if (h0LinkJoinEnabled)` and `{h0LinkJoinEnabled && ...}` code blocks from the raw source text instead of evaluating or rendering the component with the flag disabled.
2. The assertion only checks `dataActions` (the list of `data-action` values) and `headings` (`<h2>` text). All other template markup, HTML attributes, text copy, layout, and style changes are unverified.
3. `execFileSync("git", ["show", "a103a512:site/src/components/connect/AgentConnect.astro"], ...)` hardcodes git commit SHA `a103a512`. In shallow git clones (e.g. `git clone --depth 1` in CI workflows), this command fails with `fatal: bad object a103a512`.

---

#### tests/p1-cli/h0-link-join-limits.ts:89-134
**Severity**: RIGOUR
**Evidence**:
Check (2) requires verifying that mint and revoke request shapes match both `supabase/functions/command/index.ts` and `src/protocol/workspace-commands.ts`. Neither `h0-link-join-limits.ts` nor `h0-link-join.observer.test.ts` imports, reads, or verifies the command definitions against `src/protocol/workspace-commands.ts`.

---

#### site/src/components/connect/h0-link-join.observer.test.ts:354-367
**Severity**: RIGOUR
**Evidence**:
Check (4) requires proving that the credential cannot be read back later from the DOM, storage, or logs. The test only checks `concealJoinInvite()` in memory and performs static regex pattern checks on `AgentConnect.astro` source text (`assert.match(CONNECT, ...)`). It does not test an actual DOM instance to verify content removal, nor does it test `localStorage`, `sessionStorage`, or console logging.

---

#### tests/p1-cli/h0-link-join-limits.ts:125-126
**Severity**: RIGOUR
**Evidence**:
The test validates the public document URL path prefix against a natural-language docstring/comment in `supabase/functions/h0/core.ts`:
```ts
const described = core.match(/The public URL is (\/functions\/v1\/h0\/agent-doc\/)<locator>/);
assert.equal(H0_AGENT_DOCUMENT_PATH_PREFIX, described[1]);
```
Matching a comment in `core.ts` proves documentation wording rather than runtime route enforcement.

---

VERDICT: FAIL
