### Findings

#### 1. Credential retained in DOM after closing prompt
- **File & Line**: [`site/src/components/connect/AgentConnect.astro:499-525`](file:///site/src/components/connect/AgentConnect.astro#L499-L525) and [`site/src/components/connect/AgentConnect.astro:938-955`](file:///site/src/components/connect/AgentConnect.astro#L938-L955)
- **Severity**: PRODUCTION
- **Evidence**:
  Check (4) requires one-time display such that the credential cannot be read back later from the DOM, storage, or logs. When the user finishes or dismisses an invite via `finishPrompt("done")` or `clearPrompt()`:
  - [`#forget()`](file:///site/src/components/connect/AgentConnect.astro#L499-L525) sets `this.#prompt = null` and calls [`#restoreTokenResult()`](file:///site/src/components/connect/AgentConnect.astro#L938-L955).
  - While [`#markJoinRevoked()`](file:///site/src/components/connect/AgentConnect.astro#L922-L936) explicitly clears the DOM with `this.#text("prompt", "")`, neither [`#forget()`](file:///site/src/components/connect/AgentConnect.astro#L499-L525) nor [`#restoreTokenResult()`](file:///site/src/components/connect/AgentConnect.astro#L938-L955) clears the DOM slot.
  - The secret paste containing `joinCredential` remains in the text content of `[data-slot="prompt"]` in the DOM indefinitely after the user finishes the flow and returns to the ready state. Anyone or any script with DOM access can read the secret back from the page.

---

#### 2. In-flight revoke race with "Done" permanently locks prompt generation
- **File & Line**: [`site/src/components/connect/AgentConnect.astro:922-936`](file:///site/src/components/connect/AgentConnect.astro#L922-L936) and [`site/src/lib/h0-link-join.ts:304-325`](file:///site/src/lib/h0-link-join.ts#L304-L325)
- **Severity**: PRODUCTION
- **Evidence**:
  When a user clicks "Revoke this invite", [`onRevoke()`](file:///site/src/lib/h0-link-join.ts#L304-L325) awaits [`revokeJoinInvite()`](file:///site/src/lib/h0-link-join.ts#L225-L249). The "Done" button is not disabled during this async operation.
  - If the user clicks "Done" while revoke is in-flight, `finishPrompt("done")` executes [`#forget()`](file:///site/src/components/connect/AgentConnect.astro#L499-L525), which sets `this.#joinActive = false` and transitions the element to the `"ready"` state.
  - When [`revokeJoinInvite()`](file:///site/src/lib/h0-link-join.ts#L225-L249) completes, [`onRevoke()`](file:///site/src/lib/h0-link-join.ts#L304-L325) calls `api.markRevoked()`, invoking [`#markJoinRevoked()`](file:///site/src/components/connect/AgentConnect.astro#L922-L936), which unconditionally executes:
    ```ts
    this.#joinActive = true;
    ```
  - The component is now in the `"ready"` form state, but `this.#joinActive` is permanently stuck at `true`.
  - As a result, subsequent calls to [`requestPromptFor()`](file:///site/src/components/connect/AgentConnect.astro#L440-L455) are permanently rejected by line 446:
    ```ts
    let blocked = !principalId || this.#busy || this.#prompt !== null;
    if (h0LinkJoinEnabled) {
      blocked = blocked || this.#joinActive;
    }
    if (blocked) return;
    ```
    blocking all future prompt generation for that session.

---

#### 3. Top-level static import contradicts docstring claim of conditional bundling
- **File & Line**: [`site/src/lib/h0-link-join.ts:1-5`](file:///site/src/lib/h0-link-join.ts#L1-L5) and [`site/src/components/connect/AgentConnect.astro:263-268`](file:///site/src/components/connect/AgentConnect.astro#L263-L268)
- **Severity**: RIGOUR
- **Evidence**:
  The module header of [`site/src/lib/h0-link-join.ts`](file:///site/src/lib/h0-link-join.ts#L1-L5) states:
  > *"Imported only from the flag-on branch of AgentConnect, so a build with the flag off does not ship this module."*

  However, in [`AgentConnect.astro:263-268`](file:///site/src/components/connect/AgentConnect.astro#L263-L268), `attachLinkJoin` is imported statically at top level:
  ```ts
  import {
    attachLinkJoin,
    type JoinInviteReveal,
  } from "../../lib/h0-link-join";
  ```
  It is not dynamically imported behind a flag-on condition.

---

#### 4. Unused `selectAddAgentHandoff` helper introduces synthetic flag-test surface
- **File & Line**: [`site/src/lib/h0-link-join-flag-meaning.ts:16-26`](file:///site/src/lib/h0-link-join-flag-meaning.ts#L16-L26)
- **Severity**: RIGOUR
- **Evidence**:
  `selectAddAgentHandoff` is defined and exported with the comment:
  > *"The handoff a person gets. The flag-off arm is today's prompt, byte for byte. The flag-on arm is the join paste. Callers pass both and this picks one."*

  However, `selectAddAgentHandoff` is not called anywhere in [`AgentConnect.astro`](file:///site/src/components/connect/AgentConnect.astro) or any production code. Testing flag-off parity via this helper rather than against [`AgentConnect.astro`](file:///site/src/components/connect/AgentConnect.astro) is testing an unused artifact rather than the actual UI path.

---

#### 5. User-facing limits duplicated rather than imported from enforcement source
- **File & Line**: [`src/protocol/agent-join-limits.ts:12-32`](file:///src/protocol/agent-join-limits.ts#L12-L32)
- **Severity**: RIGOUR
- **Evidence**:
  Repo rule: *"any user-facing list of enforced things (limits, fields) must be generated from the constant the enforcement reads, with a test that fails when they differ"*.
  `supabase/functions/command/index.ts` (Deno) and migration `20260916000001_agent_join_credentials.sql` enforce seat cap and TTL limits independently. [`agent-join-limits.ts`](file:///src/protocol/agent-join-limits.ts#L12-L32) defines duplicate constants (`AGENT_JOIN_SEAT_CAP_MAX = 10`, `AGENT_JOIN_TTL_MAX_HOURS = 24`) which are kept in sync via test assertion rather than reading from the enforcement's constants directly.

---

#### 6. Test reachability for `h0-link-join-limits.ts` depends on `h0-link-join-app.test.ts`
- **File & Line**: [`package.json:23`](file:///package.json#L23)
- **Severity**: RIGOUR
- **Evidence**:
  `tests/p1-cli/h0-link-join-limits.ts` lacks the `.test.ts` suffix, meaning `npm run test:p1-cli` (which globs `tests/p1-cli/**/*.test.ts`) does not execute it. `package.json` only added `tests/p1-cli/h0-link-join-app.test.ts` to `"test"`. Unless `tests/p1-cli/h0-link-join-app.test.ts` explicitly imports `tests/p1-cli/h0-link-join-limits.ts`, `h0-link-join-limits.ts` will never run during test passes.

---

#### 7. Seat cap fallback accepts negative and non-compliant integers
- **File & Line**: [`site/src/lib/h0-link-join.ts:69-71`](file:///site/src/lib/h0-link-join.ts#L69-L71)
- **Severity**: RIGOUR
- **Evidence**:
  `shownSeatCap` checks:
  ```ts
  return typeof value === "number" && Number.isSafeInteger(value) ? value : fallback;
  ```
  It does not validate against `AGENT_JOIN_SEAT_CAP_MIN` or `AGENT_JOIN_SEAT_CAP_MAX`. A server response returning `0` or `-1` would pass validation and be rendered into the result lead sentence (`"Up to -1 agents can join."`).

---

VERDICT: FAIL
