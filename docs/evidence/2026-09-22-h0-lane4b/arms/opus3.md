# Opus Checker, round 3: H0 lane 4b (lane/h0-app-join @ 76855ae0)

Scope read: `git diff a103a512...76855ae0` (14 files) and `git diff c747a2ee...76855ae0` (fold 2), plus the command edge, the migration, `src/h0/paste.ts`, `supabase/functions/h0/core.ts`, and the LiveDashboard/InviteOnramp listeners of the AgentConnect events.
Commands run (read-only): `node --import tsx --test tests/p1-cli/h0-link-join-app.test.ts` in the worktree: 1/1 pass. `node --import tsx --test src/components/connect/h0-link-join.observer.test.ts` in the worktree's `site/`: 19/19 pass. `git status` stayed clean after both runs. I also enumerated the timeout inventory at a103a512 and at 76855ae0 with `scripts/timeout-table/enumerate.mjs` (in memory only; details in F3).

## Findings

### F1: PRODUCTION (reached only when the flag is on). The identity-scope limit message says the wrong scope
`src/protocol/agent-join-limits.ts:127`: `You already have ${limit} live invites, which is the limit for one person.`

The edge counts per person **per workspace**, not per person. `supabase/functions/command/index.ts:6519-6522`:
`count(*) FILTER (WHERE c.owner_user_id = ${userId}::uuid) AS mine ... WHERE c.workspace_id = ${route.workspaceId}::uuid`.
This is the same claim family that round 2 failed on (limit copy that does not match what the edge enforces). Two cases show the sentence is false:
- A person with 5 live invites in workspace B and 3 in workspace A mints in B. The page says "You already have 5 live invites". They have 8.
- The page says "the limit for one person", but that person can still mint in workspace A. The page tells them they cannot.

The comment at line 19 ("one person, then the whole workspace") and the edge's own comment repeat the imprecision. Under the repo rule, a claim is checked against the SQL, not against a comment that repeats it. The observer test at `h0-link-join.observer.test.ts` (scope test, around line 733: `error.message.includes("workspace") === false`) pins the wrong wording in place. Fix: say "in this workspace", e.g. "You already have 5 live invites in this workspace, which is the limit for one person in a workspace." Then change the test so that it requires the workspace qualifier.

### F2: RIGOUR. Flag OFF is not byte-for-byte main: a shared-code behaviour change ships to every user
`site/src/lib/commonswarm.ts:553-560` (fold 2) wraps `clearDeadSession(c)` in try/catch inside the shared `postCommand`. Every existing web command uses `postCommand`: invite_member, revoke_invitation, revoke_agent_token, remove_member, archive_workspace, revoke_agent_principal, set_agent_model, and others (about 15 call sites). On main, a throw from the local `signOut` after a 401 `unauthenticated` falls into the outer catch and becomes `CommandOutcomeUnknown` or `WorkspaceOutcomeUnknown`. On the lane it becomes `SessionExpired`, whatever the flag is. The new classification is arguably more correct, because a 401 means the command did not run. Even so:
- It breaks the brief's check (1): "OFF must leave the app exactly as it is on main".
- No commit message declares it.
- No test covers it. The "flag off matches today's" test (observer:328) inspects only AgentConnect.astro.

The lead must either accept it as a declared shared fix or move it behind the flag. It is RIGOUR because no wrong behaviour results. This is the only flag-independent runtime change I found. `export` on `postCommand` and `#resetCopyLabel` reading `#copyLabel` (always "Copy prompt" with the flag off) do not change behaviour.

### F3: RIGOUR. The timeout-table change is no longer needed, and its stated reason is not accurate
`tests/p1-cli/timeout-table.test.ts:56-65` removes the `main` measurement. After fold 2, `scripts/timeout-table/mapping.json` has no net change against a103a512, and the lane adds no timeout. I measured it: the inventory ids at a103a512 and at 76855ae0 are identical (100 = 100, no difference). `validateMapping(inventory@a103a512, mapping@76855ae0, "main")` returns `true`. So the lane would pass with the `main` row still present. The new comment says measuring main "would only repeat the HEAD row, and only when main's tree is HEAD's tree". On this lane, main's tree is not HEAD's, and measuring it passes anyway. The edit weakens a gate outside the lane's goal and adds a comment that is not accurate. Either revert it, or land it as a separate declared change to the gate.

### F4: RIGOUR. No gate tests the flag-off bundle claim
`site/src/lib/h0-link-join-flag.ts:6` says "the bundler drops the import below, so a default site build does not contain that module". The flag-off test (observer:328-354) strips `if (h0LinkJoinEnabled)` blocks from the .astro source text and compares the result with a typed `TODAY_ACTIONS` list. It does not compare with main's file, and it does not inspect a built `site/dist`. I did not build (brief rules), so I did not establish whether the chunk is absent. The runtime property does hold. `import.meta.env.PUBLIC_H0_LINK_JOIN === "1"` is fixed at build time, and nothing reads a URL, storage, or a server config for it (observer:356 enumerates one reader). With the flag off, no H0 code can run, and nothing at run time can turn it on.

## Checks that hold (verified on the code)
- (2) Request shapes. Mint `{kind, seat_cap: 10, ttl_hours: 24}` and revoke `{kind, join_credential_id}` (lowercased, UUID_RE) equal the edge's `exactKeys` lists (index.ts:2388, 2410) and `workspace-commands.ts:150-152,171-172`. The route `{workspace_id, stream:{kind:"workspace"}}` is the same as the existing web commands. The envelope carries `WEB_CLIENT_VERSION` through the shared `postCommand`.
- (3) Source of values. `join_credential_id`, `locator`, and `join_credential` come from the mint body (`h0-link-join.ts:103-105`). The document URL is `h0AgentDocumentUrl(deployment().url, locator)`. That function refuses a non-HTTPS base, userinfo, query, fragment, and path, and does not take the credential as an input. `h0AgentPaste` refuses a URL that holds 12 or more contiguous characters of the secret. A 200 mint without a credential, or with a bad locator, gives the withheld panel. Revoke stays available there.
- (4) One-time display. The secret exists only in `#prompt` and the `<pre>`. Done (`#forget` → `dismissShownJoin` → `#restoreTokenResult`) and a revoke both clear it. The event details carry only `workspaceId`. The site code has no console, storage, or history write. Error text never contains the secret. A revoke that finishes after Done cannot write, because `inviteStillShown` sees `inviteId === null` (the observer tests at 585/620/655 pass).
- (5) Limits. The seat cap 1..10, TTL 1..24, per-user 5, per-workspace 20, the locator regexp, and UUID_RE are read from the edge's AST and from the migration CHECKs (`BETWEEN 1 AND 10`, `interval '24 hours'`, the locator regexp) in `tests/p1-cli/h0-link-join-limits.ts`. That is an independent source, not the generator. The copy functions contain no typed digit (enforced at limits.ts:131-134). The limit copy branches on `scope` with the matching constant and gives no revoke advice. See F1 for the scope wording.
- Fold 2 claims. The deadline spans `response.text()` (`deadline.clear()` is in `finally`; observer:789 ticks 29 999 ms and then 1 ms). A lost mint says an invite may already exist. A 401 says no invite was created. A failed module import shows `LINK_JOIN_LOAD_ERROR` with no module text. "1 agent" vs "agents" is correct. The result lead says before Done that the page cannot revoke after Done.
- (6) Test reach. `h0-link-join-app.test.ts` is named in `npm test` and globbed by `test:p1-cli`. It imports `h0-link-join-limits.ts`, which the site observer test also imports. The observer test is globbed by site `test` (`src/components/**/*.observer.test.ts`).
- (7) Root package.json. The only change adds `tests/p1-cli/h0-link-join-app.test.ts` to the literal `test` list. It is needed so the pure gate runs it, it is correct, and the test is pure (file reads plus an in-process `handleH0Request`).
- Host integration. LiveDashboard gates workspace switches on `dataset.state === "done"`. The invite sets "done", and `clearPrompt(false)` → `finishPrompt` now also clears an invite whose `#prompt` is null (withheld or revoked).

## Not established
- Whether a default (flag-off) `site/dist` contains the h0-link-join chunk. I did not build.
- End-to-end mint and revoke against a running command edge. I contacted no service.

VERDICT: FAIL
