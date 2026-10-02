# Lane C+D fold 7

Base: `c2b50af447f0fe1b12344cb43a52f5a6cf24354c`, branch `lane/cd-admin-integ`.
Implemented in the worktree; independent review and server verification remain with HezLead.

## Cause and trace

The fold-5 restoration in `supabase/functions/command/admin-routine.ts:116`
called `restoreAdminRoutineWorkspace` for every existing workspace. At the base,
`supabase/functions/command/admin-routine-workspace.ts:17` selected `swarm.events`.
The command transaction sets role `swarm_command`. The schema's exact SELECT
matrix (`supabase/migrations/20260723000001_p1_schema.sql:717`) excludes that
table; its event-log permission is INSERT only (`:739`). No later migration
grants SELECT on the raw log. This read fails with SQLSTATE 42501 before
either routine operation reaches its decision or write. This is a source-level
diagnosis of the supplied CI failures; no database reproduction was run here.

Both operations enter `prepareAdminRoutine` at
`supabase/functions/command/admin-delegation.ts:331`, lock the workspace stream,
load ordinary projections, and attempt this restoration. Workspace creation
has no existing stream and skips the restoration, explaining its successful
CI control. Once restoration is permitted, seat creation emits ordinary and
delegated seat events (`src/protocol/admin-routine.ts:569`), while member
invitation emits `AdminMemberInvited` (`:638`). The transactional adapter folds
the workspace events, writes the principal or invitation projection, appends
workspace events, then persists the account events/counters. Their writes and
the parent-grant fences in migrations 00002/00004 are unchanged.

`issue_admin_credential` has an active lineage and `awaiting_delivery` metadata
(`src/protocol/admin-authority.ts:306`). Its HTTP `pending` result derives from
delivery (`supabase/functions/command/admin-delegation.ts:404`), not an inactive
credential. Workspace creation used that same credential successfully.
`npm run build:command-core` exited 0 twice and produced no generated diff,
excluding stale generated protocol code as the cause.

## Fix and diagnostics

Migration `20261001000005_admin_routine_workspace_history.sql` adds a
security-barrier, owner-backed view of only attributed delegated routine event
types. Only `swarm_command` can SELECT it; that role still cannot SELECT the
raw event log, and anonymous, authenticated and worker read roles cannot read
the view. Restoration reads this view with its existing locked workspace,
stream, event-type and sequence filters. Ordinary events containing content or
invitation hashes remain excluded. A reserve rollback drops the view before
the event attribution columns are removed; the storage rollback drill includes
both removal and reapplication.

All three admin command failure catches now log a bounded, single-line error
class and message through `safeAdminError` (`supabase/functions/command/failures.ts:50`).
It redacts credential prefixes, JWT-shaped tokens, URLs, quoted SQL values and
labelled secrets, strips log controls, and never copies query, parameters or
database detail. The existing response and separate failure audit are retained.
The routine server test previously discarded child stderr; it now forwards
only these sanitized diagnostic lines on failure (`tests/p1-server/admin-routine.test.ts:126`).

The storage scenario checks permitted view reads beside SQLSTATE-42501 raw-log
denial, read-role separation and view immutability. All nine routine scenarios
reconcile command-visible history against eligible durable event IDs and reject
ordinary event types. Existing success, refusal, ancestry, budget, rollback and
recovery expectations were not relaxed.

## Gates

Commands ran inside the supplied workspace sandbox with HOME unchanged.
The explicit user instruction overrides base-cd.txt's disposable-HOME gate
recipe. No secret retrieval/staging, keychain access, browser, GUI, Docker,
server suite, migration application, commit, push or Actions dispatch occurred.
There was no task-owned secret directory to remove.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build:command-core` | 0 | Twice; generated JS and declarations unchanged. |
| `npm run build` | 0 | Passed, including guarded prebuild cleanup. |
| `npm run check:edge` | 0 | All seven entry points passed. |
| `npm run check:tests` | 0 | Passed initially and after server-test edits. |
| Filtered `npm test` | 0 | 21 selected admin assertions passed; 102 runner entries include filtered files, not 102 assertions. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/p1-cli/admin-routine.test.ts` | 0 | 5 passed. |
| `node --import tsx --test tests/p1-cli/admin-recovery.test.ts` | 0 | 6 passed. |
| `node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts` | 0 | 1 passed. |
| `node --import tsx --test tests/p1-cli/admin-failure-diagnostics.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | 3 passed; the new test is reached by the p1-cli glob. |
| `node --import tsx --test tests/p1-cli/citation-drift.test.ts` | 0 | 5 passed; command/index.ts line numbering preserved. |
| Diagnostic regression with unsafe formatter | 1 | Expected failure of credential-redaction assertion; original file restored in finally. |
| `node --check` on each changed server harness | 0 | Both parsed. |
| `git diff --check` | 0 | Passed. |

The filtered npm invocation used:

```sh
NODE_OPTIONS='--test-name-pattern=^(human.consent.is|full-account.consent.pins|refresh.preserves.deadlines|grant.reads.reject|surrender.is.exact|account.events.rebuild|human.narrowing.removes|replacement.revokes|pure.decisions.charge|credential.scope.widening|workspace.withdrawal.requires|admin.runtime|real.worker.HTTP.handlers.refuse.admin|the.generated|routine.)' npm test
```

Unpiped output is retained in ignored `scratchpad/fold-cd7/npm-test.log`.
The unfiltered npm gate was not run: its existing subprocess fixtures change
HOME and its browser controls conflict with this task's restrictions. No full
gate or live/server success is claimed.

## Files changed

- `supabase/functions/command/admin-routine-workspace.ts`
- `supabase/functions/command/failures.ts`
- `supabase/functions/command/index.ts`
- `supabase/migrations/20261001000005_admin_routine_workspace_history.sql`
- `supabase/admin-delegation-reserve/20261001000005-rollback.sql`
- `tests/p1-cli/admin-failure-diagnostics.test.ts`
- `tests/p1-server/admin-routine.test.ts`
- `tests/support/admin-routine-server-harness.mjs`
- `tests/support/admin-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-cd/FOLD7.md`

## Pending CI and risks

Run all nine cases in `tests/p1-server/admin-routine.test.ts` (#10–18 in the
supplied run) and the storage/rollback case in
`tests/p1-server/admin-delegation.test.ts`, using the real migrations, after
HezLead's cross-family review. The SQL view, its role checks, restoration,
rollback and the original server failure recovery remain unexecuted here.
The new migration must accompany the adapter change. Future delegated routine
event types require an updated restricted-view allowlist. No grant, credential,
role, deadline, budget or protected-action policy changed; no contract departure
was introduced.
