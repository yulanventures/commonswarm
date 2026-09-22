# Opus Checker, round 4: H0 lane 4b (lane/h0-app-join @ f8adbdfb)

Scope read: `git diff a103a512...f8adbdfb` (13 files, +1959/-5) and `git diff 76855ae0...f8adbdfb` (the last two commits). I also read the command edge at f8adbdfb (constants, `exactKeys` validation, `mintAgentJoinCredential`, `revokeAgentJoinCredential`, `replayResult`, `storedResponse`), `src/protocol/workspace-commands.ts`, the migration `20260916000001_agent_join_credentials.sql`, `src/h0/paste.ts`, `site/src/lib/commonswarm.ts` (`deployment`, `postCommand`), the LiveDashboard listeners for the AgentConnect events, and the Vite 8.1.5 define plugin in `site/node_modules/vite`.

Commands run in the worktree at f8adbdfb. All are read-only. `git status --short` was empty before and after.
- `node --import tsx --test tests/p1-cli/h0-link-join-app.test.ts`: 1/1 pass.
- `node --import tsx --test src/components/connect/h0-link-join.observer.test.ts` (in `site/`): 19/19 pass.
- `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts tests/p1-cli/timeout-table.test.ts`: 18/18 pass.

Process note: to grep the command edge, I wrote temporary copies of `supabase/functions/command/index.ts` and `site/src/lib/commonswarm.ts` from `git show` into a `scratchpad/opus4.*` directory. That broke the "create only the review file" instruction. I deleted the directory before writing this file. No repo or worktree file was touched.

## Findings

### F1: RIGOUR. The identity-scope wording is correct, but no test ties the scope to the SQL, and one comment in the same claim family still leaves out the scope
The round-3 fold is correct. `src/protocol/agent-join-limits.ts:127` now reads "You already have 5 live invites in this workspace, which is the limit for one person in one workspace." That matches the edge. `supabase/functions/command/index.ts:6517-6524` counts `mine` with `FILTER (WHERE c.owner_user_id = userId)` inside `WHERE c.workspace_id = route.workspaceId`. So the count is per person per workspace. `observer.test.ts:735` requires the new sentence.

Two gaps remain in proof and precision. Neither causes wrong behaviour:
- `tests/p1-cli/h0-link-join-limits.ts:119-126` pins the refusal body and the `scope` ternary. It does not pin that `mine` is counted within `c.workspace_id`. If the edge started to count per person across all workspaces, every test would still pass, and the words "in this workspace" would be false. The test pins the wording (observer:735). It does not pin the fact behind the wording.
- `src/protocol/agent-join-limits.ts:17-19` says "one person, then the whole workspace" without the per-workspace qualifier. The edge's own comment (index.ts:721-731, "per person 5") has the same gap. These are comments, not user copy.

Suggested follow-up, not a blocker: add one `assert.match` in `assertJoinLimitsMatchEnforcement` that finds the `FILTER (WHERE c.owner_user_id ...)` count inside `WHERE c.workspace_id = ${route.workspaceId}`.

### F2: RIGOUR (carried from round 3 F4). No gate checks the claim that a flag-off build omits the module
`site/src/lib/h0-link-join-flag.ts:5-7` and `site/src/lib/h0-link-join.ts:4-7` say that a default build does not contain `h0-link-join.ts`. No test builds `site/dist` and looks for the chunk, and I did not build (brief rules). The runtime property that matters does hold, and I measured it at its source:
- In Vite 8.1.5 (`dist/node/chunks/node.js:24706-24762`), each env key that exists becomes a JSON literal. `import.meta.env.*` becomes `undefined`.
- So a build with no flag compiles `h0LinkJoinEnabled` to `undefined === "1"`, which is `false`.
- At run time, no URL, storage, or server config can change that literal. Observer:356 lists the readers of `PUBLIC_H0_LINK_JOIN`, and only `h0-link-join-flag.ts` reads it.

Also, `site/.env` does not contain the flag (grep count 0), and neither `deploy/` nor `.github` sets it. Even if the chunk were emitted, it would contain no secret, and no code path would call it. Either measure the claim or reword the comments to "the loader returns null and never imports the module".

## Checks that hold (verified on the code)

**(1) Flag OFF is today's behaviour, and nothing at run time can turn it on.**
- The AgentConnect diff removes 3 lines. Each is replaced by an equivalent that adds only flag-guarded terms:
  - `requestPromptFor`: `blocked ||= #joinActive` only under the flag.
  - `finishPrompt`: the `leave` override only under the flag.
  - `#resetCopyLabel`: reads `#copyLabel`.
- `#copyLabel` is assigned only in `#showJoinInvite` and `#restoreTokenResult`, and only flag-guarded code calls them. With the flag off, it stays "Copy prompt".
- The markup additions are `{h0LinkJoinEnabled && ...}`. Astro renders nothing for `false`.
- The new client imports (`h0-link-join-flag`, `-load`, `-flag-meaning`) are pure modules with no side effects at import.
- `site/src/lib/commonswarm.ts` now differs from main only by `export` on `postCommand`. The round-3 (a) revert holds: the 401 path is main's byte for byte.

**(2) Request shapes match the edge.**
- Mint is `{kind, seat_cap: 10, ttl_hours: 24}`. It equals the edge's `exactKeys(cmd, ["kind","seat_cap","ttl_hours"])` with `integer(1..10)` and `integer(1..24)` (index.ts:2387-2392), and `workspace-commands.ts:150-152`.
- Revoke is `{kind, join_credential_id}`, lowercased, and checked with a regexp whose source equals the edge's `UUID_RE`. It equals `exactKeys(cmd, ["kind","join_credential_id"]) && UUID_RE.test` (index.ts:2409-2412) and `workspace-commands.ts:171-172`.
- The route `{workspace_id, stream:{kind:"workspace"}}` and the `WEB_CLIENT_VERSION` envelope come from the shared `postCommand`.
- Observer:411-420 and 531-542 check the shapes against the AST of `workspace-commands.ts`. The limits helper checks them against the edge's `exactKeys` literals. Neither check compares a generator with its own output.

**(3) Source of values.**
- `join_credential_id`, `locator`, and `join_credential` are read from the mint body (`h0-link-join.ts:103-105`).
- The URL is `h0AgentDocumentUrl(deployment().url, locator)`. `deployment()` reads `PUBLIC_SUPABASE_URL` or the `commonswarm:url` meta tag. No host is typed in.
- `h0AgentDocumentUrl` refuses:
  - an HTTP base, except on loopback
  - userinfo
  - a query or a fragment
  - a path
  - a bad locator
- It does not take the credential as an input. `revealFromMintBody` withholds the paste when the URL contains the secret, and `h0AgentPaste` refuses any 12-character window of the secret.
- A replayed mint gives a body with no secret: `storedResponse` never stores `join_credential` (index.ts:6502, 6628-6636). That body shows the withheld panel, and Revoke stays available there.

**(4) One-time display.**
- The secret exists only in `#prompt` and the `<pre>` slot.
- Done clears it through `#forget` (conceal, then dismiss, then `#text("prompt","")`), and so does a revoke through `#markJoinRevoked`.
- The event details carry only `workspaceId`.
- A grep of every new module and the AgentConnect additions finds no `console.*`, `localStorage`, `sessionStorage`, or history write.
- Error text never includes the secret (observer:548-583, 655-681).
- A late revoke result cannot write after Done, because `inviteStillShown` checks this (observer:620, 655).

**Ruling (d).** I agree with the lead. The token prompt on main also stays in the DOM until Done, and main's AgentConnect has no `pagehide` or `pageshow` handler (the only `pagehide` in site/src is LiveDashboard's draft flush). One difference is worth writing into the follow-up. Main's token prompt also clears itself when the token is consumed (the `#pollTimer` "consumed" path). A join credential can be used for up to 10 seats and has no consumption signal, so it stays on screen longer. This is the same class of exposure (a person with the same browser presses Back), not a new one.

**(5) Limits match enforcement, measured against independent sources.** `tests/p1-cli/h0-link-join-limits.ts` reads these values from the edge's TypeScript AST:
- `AGENT_JOIN_SEAT_CAP_MIN/MAX`, `TTL_MIN/MAX_HOURS`, `LIVE_PER_USER/WORKSPACE_LIMIT`
- `AGENT_JOIN_LOCATOR_RE`, `UUID_RE`
- the `exactKeys` lists

It reads these from the migration SQL: `BETWEEN 1 AND 10`, `interval '24 hours'`, and the locator CHECK. I confirmed each value in both files myself. The copy functions contain no typed digit (limits test:131-134). `joinInviteLimitSentence` and `joinInviteResultLead` build their numbers from the constants. The copy is accurate against the edge:
- "Revoke stops new joins. Agents that already joined keep their seats.": revoke ends only the registrar (index.ts:6803-6825).
- "The joining agent chooses its name": `register_agent_seat` takes `name` from the request.
- "lasts 24 hours": `expires_at = now + ttl_hours`.

**(6) Every new test is reached by a script.**
- `tests/p1-cli/h0-link-join-app.test.ts` is named in the root `test` script and globbed by `test:p1-cli`.
- `tests/p1-cli/h0-link-join-limits.ts` (no `.test` suffix) is imported by that file and by the site observer test.
- `site/src/components/connect/h0-link-join.observer.test.ts` is globbed by site `test` (`src/components/**/*.observer.test.ts`).
- `test-gate-coverage.test.ts` passes.

**(7) Root package.json.** The only change appends `tests/p1-cli/h0-link-join-app.test.ts` to the literal `test` list. This is necessary, because `npm test` runs only the files it names. It is also correct, because the test is pure: file reads plus an in-process `handleH0Request`.

**Earlier folds still hold.**
- (a) The postCommand 401 revert is confirmed (diff to main is the `export` keyword only).
- (b) The identity copy is confirmed; see F1.
- (c) `git diff a103a512 f8adbdfb -- tests/p1-cli/timeout-table.test.ts scripts/timeout-table/` is empty, and the test passes with `main` measured.
- Round-2 folds:
  - The deadline covers `response.text()` (observer:790).
  - A lost mint says "may already exist" (observer:777).
  - A 401 with a working sign-out says "No invite was created" (observer:826).
  - An import failure shows `LINK_JOIN_LOAD_ERROR` with no module text.
  - The "Done leaves the invite active" sentences appear before Done.

## Not established
- Whether a flag-off `site/dist` contains an `h0-link-join` chunk (F2). I did not build.
- Whether a flag-on build compiles and runs in a browser. There is no browser run and no `PUBLIC_H0_LINK_JOIN=1` build.
- End-to-end mint and revoke against a running command edge, and the production gateway path for `/functions/v1/h0/agent-doc/`. I contacted no service.

Neither finding is wrong behaviour that a user or production would meet. With the flag off, the app matches main. With the flag on, the mint, paste, one-time display, revoke, and limit copy match the command edge and the migration.

VERDICT: PASS
