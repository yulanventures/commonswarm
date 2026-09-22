I'll review the last commit against the whole lane and leave every file unchanged. First I'll read the diff and the pagehide path.The last commit adds a `pagehide` handler and edits three comments. I'll read that path and the test that claims to prove it.The pagehide test passed. I'll check a second connect and a second `pagehide`, because the listener is never removed.No findings. Commit `cd9f0ffe` fixes the back-forward case from round 4, and the flag-off path stays the same as `main`.

The handler is at `site/src/components/connect/AgentConnect.astro:400-403`, inside `if (h0LinkJoinEnabled)`. It takes no event argument, so `persisted` true and `persisted` false both clear. It runs only when `#joinActive` is true. `#showJoinInvite` sets that flag before it writes the paste (`:922` and `:946-947`).

`finishPrompt("done")` (`:485-504`) calls `#forget` (`:526-553`) before it fires any event. `#forget` sets `#prompt` to null, sets the prompt slot text to `""`, and sets `#joinActive` to false. There is no mint or revoke call on that path. The invite stays active on the server. The on-screen sentences are unchanged, including "Done leaves the invite active."

A second connect does not add a second listener. `connectedCallback` (`:307-311`) returns once `#ready` is set, and `#wire` is the only place that registers the listener. `disconnectedCallback` (`:314-317`) does not remove it. One listener remains for the life of the element, so a later invite is still cleared. A second `pagehide` sees `#joinActive` false and does nothing. `finishPrompt` is synchronous, so two listeners would still clear once and then stop.

Flag off does not register the handler. The three narrowed comments match the code. The per-person cap is counted inside one workspace (`supabase/functions/command/index.ts:6517-6524`). The page loads the invite module only from the flag-on `import()` in `site/src/lib/h0-link-join-flag.ts:11-13`.

The new test is in `site/src/components/connect/h0-link-join.observer.test.ts:357-449`. The site test script globs `*.observer.test.ts`, so the test runs. It executes the real class: with the flag on, the prompt slot holds the credential, and after `pagehide` the slot is empty, the state is `ready`, and Copy does not write. With the flag off, the listener count is 0. That test passed here, along with the flag-off control.

`package.json:23` adds `tests/p1-cli/h0-link-join-app.test.ts` to the literal `npm test` list. `h0-link-join-limits.ts` has no `.test.ts` suffix; that app test imports it, and `test:p1-cli` globs the app test.

VERDICT: PASS
