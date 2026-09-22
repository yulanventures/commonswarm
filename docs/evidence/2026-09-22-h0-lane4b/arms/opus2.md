# D-036 Checker (Claude Opus) — H0 lane 4b, round 2, SHA c747a2ee

Scope read: `git diff a103a512...c747a2ee` (13 files), plus `supabase/functions/command/index.ts`,
`src/protocol/workspace-commands.ts`, `supabase/migrations/20260916000001_agent_join_credentials.sql`,
`supabase/functions/h0/{index,core}.ts`, `src/h0/paste.ts`, `site/src/lib/commonswarm.ts`,
`site/src/components/app/LiveDashboard.astro` (the AgentConnect callers), `scripts/timeout-table/mapping.mjs`,
all at c747a2ee. No build, no test run, no network, no file written except this one.

## Findings

### F1 — PRODUCTION (flag on): the invite-limit refusal tells the user to do something no surface allows, and blames them for a workspace limit
`site/src/lib/h0-link-join.ts:186-189`

The copy is: "You already have as many live invites as this workspace allows. Revoke one, or wait for one to
expire. No new invite was created."

- The command edge sends this error for two scopes (`supabase/functions/command/index.ts:6528-6542`):
  `scope: "identity"` (5 live per person) and `scope: "workspace"` (20 live per workspace). The page ignores
  `body.scope` and always says "You already have". When the other members hold the 20 invites, this is false.
- "Revoke one" cannot be done. The only revoke control is `data-action="revoke-join"` on the result panel,
  which exists only while that one invite is on screen. Done, a page reload, a workspace switch or sign-out
  drops `#inviteId` (`AgentConnect.astro:514-531`, `h0-link-join-flag-meaning.ts:26-34`). No other surface
  sends `revoke_agent_join_credential` or lists join credentials. `git grep` of `src/cli.ts`, `src/cloud`,
  `site/src/components/app` and `supabase/functions/read/index.ts` at c747a2ee finds none. A person at the
  limit has one real choice: wait up to 24 hours.
- This is the claim-family problem that AGENTS.md "Claim controls prove stability, not truth" describes. No
  test checks this string. The result lead has the same gap: "Done leaves the invite active."
  (`src/protocol/agent-join-limits.ts:105`) is true. It does not say that after Done nobody can revoke the
  invite from this product, and that is the fact a reader needs before they click Done.
- Fix: branch on `body.scope` (the scope values come from the edge). Drop "Revoke one", or say that invites
  expire within `AGENT_JOIN_TTL_MAX_HOURS` hours. Add to the lead that after Done this page cannot revoke the
  invite.

### F2 — RIGOUR: the timeout-table `main` row is now either skipped or a copy of the HEAD row
`tests/p1-cli/timeout-table.test.ts:56-65`

The change is needed. `mapping.json` has `aliases.main -> HEAD`. On this lane the HEAD section has the two new
`site/src/lib/h0-link-join.ts` rows and local `main` does not have that file, so the old unconditional `main`
row would always report `stale=`. The pre-fold gate log shows this failure mode.

After the change the row runs only when `main^{tree} == HEAD^{tree}`. In that case `enumerateRepository`
reads the same committed tree that the HEAD row reads from the working tree. The two rows can differ only
when there are uncommitted edits. So the `main` row can never fail for a reason the HEAD row would not also
catch, and on every lane it is skipped. It is not an independent control any more. It never really was one:
through the alias it only ever checked "main equals the HEAD mapping".

The code comment "After the merge, `main` is HEAD and is measured again" is true only for a checkout whose
local `main` ref has been updated. Nothing asserts which branch was taken. No behaviour is wrong. Remove the
row, or state in the comment that it duplicates HEAD.

### F3 — RIGOUR: the response body read is outside the 30 s deadline
`site/src/lib/h0-link-join.ts:139-168`

`clearTimeout(timer)` runs in the `finally` block before `await response.text()`. A body that stalls after
the headers arrive is therefore not aborted. `#busy` / `data-mint-busy` then stay set, the button keeps
showing "Creating the invite…", and the dashboard's `keepConnectCredentialVisible` holds the screen until a
reload. The site's own `postCommand` (`site/src/lib/commonswarm.ts:519-566`) keeps the deadline until
`text()` resolves. The new `mapping.json` row describes this timeout as the per-request abort for mint and
revoke, but it covers the headers only. The likelihood is low.

### F4 — RIGOUR: `client_version` is sent from the wrong constant, and the test pins that constant against itself
`site/src/lib/h0-link-join.ts:151`; `site/src/components/connect/h0-link-join.observer.test.ts:400,513`

The site sends `client_version: WEB_CLIENT_VERSION` (`commonswarm.ts:537`). The comment at `commonswarm.ts:57-66`
says that this constant is the one to check against the seed `min_client_version`. The lane sends
`CLIENT_PROTOCOL_VERSION` instead. Both are "0.1.0" today, so there is no wrong behaviour now. If
`WEB_CLIENT_VERSION` is bumped, the invite path would lag it and could get 426, which the page shows only as
"HTTP 426". The test compares the envelope with the same imported constant the code uses, which is circular.
The lane also does not reuse `postCommand`, so a 401 `unauthenticated` does not call `clearDeadSession`,
unlike every other site command.

### F5 — RIGOUR: the component-level fixes for P1 and P2 are proven only by regex over the `.astro` source
`h0-link-join.observer.test.ts:472-490, 554-587`

`concealJoinInvite`, `dismissShownJoin` and `shownJoinAfterRevoke` are small pure functions, and their tests
are close to identities. The `AgentConnectElement` methods (`finishPrompt`, `#forget`, `#markJoinRevoked`)
are never run. The test only checks the source order of their text (`indexOf` comparisons).

The `onRevoke` guards that matter are run with a real in-flight fetch: `inviteStillShown` at
`h0-link-join.ts:333,336`, tested by the observer tests at lines 589-650. Removing either guard would fail a
test. So the P1 guard itself is covered, but the wiring from `api.inviteId` to `#inviteId` is covered only
by text match.

### F6 — RIGOUR (minor)
- `h0-link-join.ts:111-127`: the page validates the service URL (HTTPS, no path) only after the mint. A
  deployment URL with a path would mint a live invite on every click and then withhold it. Production's URL
  has no path, so this is latent. Validate `h0AgentDocumentUrl`'s base before posting.
- `h0-link-join.ts:158-163`: a lost mint response says "Reload this page before trying again". It does not
  say that an invite may already exist and hold one of the 5 slots for up to 24 hours. That invite's
  credential was never shown, so it does not leak.
- `AgentConnect.astro:440-445`: if the dynamic `import()` rejects (chunk load failure), the click does
  nothing and gives no feedback.
- `agent-join-limits.ts:102`: "Up to 1 agents can join." is pinned by the test at line 375. It cannot happen
  in practice, because the page always requests 10 and a replay returns the stored 10.

## Checks the brief requires

1. **Flag off.** Diff of `AgentConnect.astro` against a103a512: only three existing lines change
   (`requestPromptFor` guard, `finishPrompt` guard, `#resetCopyLabel` label). With the flag false, each
   reduces to the original expression or the literal "Copy prompt". Everything else added is inside
   `{h0LinkJoinEnabled && …}` / `if (h0LinkJoinEnabled)`, or is a new private field or method. Behaviour
   with the flag off is the same as on main. Byte identity is not claimed: the lead measured +11 bytes.
   `h0LinkJoinEnabled` is `import.meta.env.PUBLIC_H0_LINK_JOIN === "1"`. This is a build-time replacement, and
   there is no URL, storage, meta tag or server-config reader. The test at observer line 348 enumerates the
   readers. **I did not establish** the lead's flag-off bundle measurement (0 files with
   joinCredential/agent-doc/mint_agent_join_credential; 18,760 vs 18,749 bytes), because I could not build.
2. **Request shapes.** Mint `{kind, seat_cap: 10, ttl_hours: 24}` and revoke `{kind, join_credential_id
   (lower-cased UUID)}` match the edge validator exactly (`command/index.ts:2387-2424`: `exactKeys`, bounds,
   `UUID_RE`, `.toLowerCase()`). They also match `workspace-commands.ts:149-173`. The envelope is
   `workspace_id` + `stream:{kind:"workspace"}`, the same as the other connect commands. The status codes the
   page handles match the handlers: 409 `already_revoked` at 6780s, 403 `join_credential_limit_reached` at
   6528-6542, 403 `forbidden`. The tests check the fields against `exactKeys` in the edge (AST) and against
   the protocol type (AST). Both are independent of the app.
3. **Locator, credential, URL.** `join_credential_id`, `locator` and `join_credential` all come from the mint
   body (`h0-link-join.ts:89-91`). This matches the edge's fresh response at `command/index.ts:6672-6686`.
   The URL is `new URL(H0_AGENT_DOCUMENT_PATH_PREFIX + locator, deployment().url origin)`. There is no typed
   host. The path is checked against `handleH0Request` (limits helper lines 125-139). The credential is
   refused inside the URL by both `revealFromMintBody:113` and `h0AgentPaste`'s 12-character window.
4. **One-time display.** The paste is written only to `#prompt` and the `<pre data-slot="prompt">`.
   `#forget` (`AgentConnect.astro:533-541`) and `#markJoinRevoked` clear both. Events carry no secret. The
   code has no storage or console writes, and the error strings do not echo response bodies (tested). The
   clipboard is outside the page's control, the same as for the token prompt.
5. **Limits.** Checked against the enforcing files, not against a copy. Seat cap 1..10 and TTL 1..24 match
   the edge constants (`command/index.ts:714-719`) and the migration CHECKs (`seat_cap BETWEEN 1 AND 10`,
   `expires_at <= created_at + interval '24 hours'`, locator `^[A-Za-z0-9_-]{22}$`). The migration has no
   1-hour floor, only `expires_at > created_at`. That is not a mismatch. The helper parses these files (AST
   for TS, regex for SQL). The sentence is built from the constants and contains no digit literal (observer
   line 370).
6. **Test reach.** `tests/p1-cli/h0-link-join-limits.ts` (no `.test` suffix) is imported by
   `tests/p1-cli/h0-link-join-app.test.ts`. That file is globbed by `test:p1-cli` and named in `npm test`. The
   helper is also imported by the site observer test, which the site `test` glob
   `src/components/**/*.observer.test.ts` reaches. The new `mapping.json` rows are reached by
   `timeout-table.test.ts`.
7. **Root `package.json`.** The only change appends `tests/p1-cli/h0-link-join-app.test.ts` to `npm test`.
   Strictly, it is not needed, because `test:p1-cli` already globs the file. It is correct: the file is pure
   (file reads plus the in-process `handleH0Request`), and it puts the limits control into the pure gate.
   `check:edge` already named `h0` on main.

## Round-1 fold claims
- P1 (late revoke leaves `#joinActive` true): fixed. `#forget` nulls `#inviteId`. `onRevoke` returns when the
  id is no longer shown, and `#markJoinRevoked` returns on a null `shownJoinAfterRevoke`.
- P2 ("Done leaves the invite active" after revoke): fixed. The lead and the status are replaced with
  `JOIN_INVITE_REVOKED_MESSAGE`.
- P3 (module in the flag-off build): dynamic `import()` behind the flag. Not re-measured (see check 1).
- `shownSeatCap` bounded to 1..10: yes. Document path checked by `handleH0Request`: yes. No git call to a
  historical SHA in the new tests: yes. The two claims the lead refuted are correct: `#forget` clears the
  prompt slot (line 539), and a test imports the limits helper.

## Not established
- I ran no test and no build. I did not measure the flag-off or flag-on bundle, and I did not run any gate
  on c747a2ee.
- I did not check whether the production gateway serves `/functions/v1/h0/agent-doc/<locator>` for the h0
  function. The flag stays off until it does.

VERDICT: FAIL
