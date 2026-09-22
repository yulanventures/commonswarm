# D-036 Checker (Claude Opus) — H0 lane 4b, round 5, SHA cd9f0ffe

Scope: the last commit cd9f0ffe (`git diff f8adbdfb...cd9f0ffe`), read against the whole lane
(`git diff a103a512...cd9f0ffe`, 8 commits, 13 files). Method: read-only `git show` / `git diff` /
`git grep` at the named SHAs. I ran no test, no build, and no browser.

## What cd9f0ffe changes

1. `site/src/components/connect/AgentConnect.astro:400-403`: inside the existing `if (h0LinkJoinEnabled)`
   block of `#wire()`, a `window` `pagehide` listener that runs `this.finishPrompt("done")` when
   `this.#joinActive` is true.
2. `site/src/components/connect/h0-link-join.observer.test.ts:357-450`: a new test that transpiles the
   component's own class source and runs it in `node:vm` with stubs, with the flag on and off.
3. Three comments made narrower: `site/src/lib/h0-link-join-flag.ts:5-7`, `site/src/lib/h0-link-join.ts:4-6`,
   `src/protocol/agent-join-limits.ts:19`.

## Checks from the brief

**Handler clears DOM and component state on every pagehide (persisted or not).** PASS.
The handler ignores the event object, so `persisted` true and false take the same path. The path is
`finishPrompt("done")` (AgentConnect.astro:485-505). With the flag on, `leave` is false while `#joinActive`
is true, so `#forget()` runs (:526-553). `#forget()` sets `#prompt` to null through
`concealJoinInvite`/`dismissShownJoin`, then again directly. It sets `#inviteId` to null and `#joinActive` to
false. It restores the token title and lead, hides Revoke, and writes `""` to `[data-slot="prompt"]` and
`[data-slot="copy-status"]`. It then calls `#state("ready")`. The shown credential is written to only one
DOM node, `#text("prompt", reveal.paste)` (:949). The title and lead never carry it, and the component
keeps no storage write or log of it. The handler also covers the revoked state (`#joinActive` stays true
after `#markJoinRevoked`) and the withheld state (prompt already null). In both states the handler only
dismisses the result panel. Per the HTML spec, `pagehide` fires before a page enters the back-forward
cache, so the DOM that is cached is the cleared DOM.

**No server revoke; copy stays true.** PASS. `finishPrompt` → `#forget` → `#restoreTokenResult` sends no
command. `startJoinRevoke` is reached only from the Revoke button's click listener (:453-457). The test
supports this: its `loadLinkJoin` stub has no `startJoinRevoke`, so a revoke call from pagehide would throw
and fail the test. The shown copy is "Done leaves the invite active. After Done, this page cannot revoke the
invite." (`src/protocol/agent-join-limits.ts:106-111`). Leaving the page now has the effect of Done, and the
invite stays active on the server. So both sentences stay true. The copy does not tell the reader that
leaving the page also removes the Revoke control. A reload always did this, even before this commit, so
the copy makes no false claim.

**Registered only with the flag on.** PASS. The listener is inside `if (h0LinkJoinEnabled)`. That value is
the build-time constant `import.meta.env.PUBLIC_H0_LINK_JOIN === "1"` (`h0-link-join-flag.ts:9`), and
nothing at run time can change it. The test checks that the listener count is 0 with the flag off and 1
with the flag on (test:439).

**Cannot throw or run twice in a harmful way.** PASS.
- One listener per element instance: `connectedCallback` returns early when `#ready` is set (:307-308).
  `#ready` is never reset, so a disconnect and reconnect do not wire the element again.
- There is one static `<AgentConnect>` in `LiveDashboard.astro:614`, and no code makes new instances. The
  listener is never removed, so the window keeps a reference to one long-lived element. This has no effect.
- A repeat event is a no-op. After the first clear, `#prompt === null && !#joinActive`, so `finishPrompt`
  returns at once.
- Every `querySelector` result in the path has a null guard. An error in a listener of the
  `commonswarm:agent-secret-cleared` event does not reach `dispatchEvent`'s caller.
- Side effect, checked and not a finding: the cleared event makes `LiveDashboard.astro:9103-9130` run its
  Done path during pagehide. That path runs `returnToChannel()`, an `agentAccessStatuses` fetch, and
  `openWorkspace(pendingWorkspaceId)` if the reader asked for a workspace switch while a mint was busy.
  Done does the same work. A fetch that is still open at pagehide can make the page ineligible for the
  back-forward cache, and that is the safe direction.

**Flag off is exactly main's behaviour.** PASS. Every new line in the component is either inside an
`if (h0LinkJoinEnabled)` block or sets a new private field that only flag-on code reads. With the flag
false, the changed guards in `requestPromptFor` (:469-473) and `finishPrompt` (:486-490) reduce to main's
expressions. The static test at test:329-355 compares the stripped template's actions, headings, and
`#copy` against today's.

**New test proves what it names and is not circular.** PASS, with the RIGOUR items below. The test does not
compare an artifact to its own generator. It takes the class text from the shipped `.astro` file,
transpiles it, and runs it. The only inputs it controls are the stubs for dependencies outside the class.
The real `concealJoinInvite`/`dismissShownJoin`/`shownJoinAfterRevoke` are passed in. If the handler were
removed, the count check would fail. If the handler did not reach `#forget`, the state and textContent
checks would fail. The site `test` script reaches the test through its glob
`src/components/**/*.observer.test.ts`.

**Comment changes.** Correct. The retired claim was "a default site build drops the branch, so this file is
not in that build". Both comments that carried it now say only that the module loads through the flag-on
dynamic import, and that is true of the code. No other text in the lane still makes the bundle-exclusion
claim (grep over the lane diff). The new per-user limit wording, "one person in one workspace", matches
`supabase/functions/command/index.ts:6516-6524`: the `mine` count is filtered by `c.workspace_id =
route.workspaceId` and `owner_user_id = userId`.

## Findings

1. **RIGOUR** — `site/src/components/connect/h0-link-join.observer.test.ts:447-448`. The check that
   `copied === 0` after pagehide has no positive control in the same run. The test never clicks Copy
   while the invite is shown, so it does not show that this stub setup would count a copy. The check
   probably does discriminate: `#copy` (AgentConnect.astro:1020-1024) calls `navigator.clipboard.writeText`
   synchronously before its first `await`, and `navigator` resolves to the vm stub. Also, the textContent
   and state checks at test:445-446 are the main proof. To close it, click Copy once before pagehide and
   check `copied === 1`.

2. **RIGOUR** — `site/src/components/connect/h0-link-join.observer.test.ts:380`. The page stub calls each
   listener with no argument (`listener()`), and the test dispatches one event with no `persisted` field.
   The brief's "persisted or not" holds only because the handler (AgentConnect.astro:401-403) does not read
   the event. That is true by construction, but the test does not show it. If a later edit branches on
   `event.persisted`, this stub would throw a TypeError. It would not show which branch is correct.

No PRODUCTION findings. Round 4's PRODUCTION item is closed. With the flag on, a shown join credential no
longer stays in the DOM or in `#prompt` across a pagehide, so a back-forward cache restore cannot show it
again.

## Not established

- I did not run `npm --prefix site test`, `npm test`, or `npm run test:p1-cli` at cd9f0ffe. Whether the new
  test passes rests on a read of the stub setup against the class code. I found no step that would throw.
- I made no live browser control of a real bfcache round trip, for example Chrome
  `chrome://back-forward-cache` or a navigate-away-and-back. The claim that a restore does not show the
  credential rests on the spec order of `pagehide`, plus the vm test.
- This round did not measure lane-wide items 2, 3, 5, 6, and 7 of the brief again, past a spot check of
  the per-user limit scope and the root `package.json` diff. That diff adds only
  `tests/p1-cli/h0-link-join-app.test.ts` to `npm test`. The file also matches the `test:p1-cli` glob, and
  it imports the non-`.test.ts` helper `tests/p1-cli/h0-link-join-limits.ts`. Rounds 1-4 measured those
  items, and cd9f0ffe does not touch them.

VERDICT: PASS
