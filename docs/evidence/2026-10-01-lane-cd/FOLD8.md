# Lane C+D fold 8

Base: `26188fc1c804d39312cf51f699732a622d9dd40e`, branch `lane/cd-admin-integ`.
Changes are in the worktree. HezLead owns independent review and server verification.

## Scoped history read

Migration `20261001000005_admin_routine_workspace_history.sql` replaces the broad
view with `swarm.admin_routine_workspace_history(uuid, uuid, uuid)`. The SQL
predicate pins workspace ID, grant ID and the locked workspace stream ID. The
stream must belong to that workspace and have kind `workspace`. The migration
also drops the former view if present. The `swarm_admin`-owned function is
`STABLE SECURITY DEFINER`, pins `search_path=pg_catalog`, uses qualified relations,
revokes public/anonymous/authenticated/worker execution, and grants execution to
`swarm_command`. No SELECT privilege on `swarm.events` is added.

The ten returned columns are consumed by ordering, envelope validation or the
routine reducer: sequence, type, schema version, human/worker actor fields,
admin identity, grant, manifest digest, server time and payload. Unused workspace,
stream, event, command and run identifiers are not returned. Payload keys are
allowlisted per event type; nested credential and policy objects have their own
allowlists. Duplicate top-level credential metadata, unrelated invitation fields
and future keys are excluded. Recipient identifiers and credential metadata that
the current reducer requires remain restricted to this workspace and grant.

The adapter passes the command's grant ID into the function and validates the
delegated envelope before calling `reduceAdminRoutine`. Its parameter type now
names only the four fields it consumes; the generated declaration was rebuilt.
The runtime protocol bundle is unchanged. Existing required-payload assertions
remain intact. Policy and account-wide budgets still use the account projection;
workspace replay restores the current grant's state for folding its next event.
Seat creation and invitations continue to avoid a direct raw-event read.

The reserve rollback drops the exact function signature before attribution
columns are removed. That statement is also retained verbatim in the migration's
commented rollback. Server storage checks now cover two populated grants,
populated workspaces, mismatched stream/workspace inputs, ordinary-event exclusion,
future fields at both payload and nested-credential levels, function permissions,
owner/search-path properties, raw-event denial and rollback/reapplication. Every
routine scenario reconciles every eligible event by stream sequence and type and
compares the minimized replay state with replay of its durable raw events.
The old event-ID enumeration is replaced by sequence/type enumeration because
event IDs are not consumed by replay and are intentionally no longer exposed.
No success, refusal, budget, ancestry or recovery expectation was relaxed.

## Handler diagnostic regression

`tests/p1-cli/admin-failure-diagnostics.test.ts` now parses the real command entry
point with TypeScript's AST. It checks the transaction failure catch in each of
`runAdminAccountCommand`, `handleAdminRuntimeCommand`, and
`handleAdminWorkerRuntimeCommand`. Each must issue exactly one `console.error`
with the failure label and the caught exception passed through the imported
`safeAdminError`, with no extra log arguments. The expectation is independent of
the formatter's implementation and survives local import/exception renaming.
The test remains covered by the existing p1-cli glob; gate-coverage checks passed.

Mutation proof ran a positive control, then reverted each handler individually
to `safeError`. Each run exited 1 at the new handler assertion while the two
formatter tests passed. The command source was restored byte for byte in a
`finally` block. The restored test exited 0 and `git diff --quiet` on
`supabase/functions/command/index.ts` exited 0. The formatter itself is unchanged;
its specific redaction patterns do not guarantee removal of arbitrary UUIDs or
other personal identifiers from driver messages.

## Gates

Commands ran directly in the supplied workspace sandbox, with HOME unchanged.
The direct user instruction overrides base-cd.txt's temporary-HOME recipe.
Guarded `rm` performed the existing build cleanup; no refusal occurred. No live
secret retrieval or staging, keychain, browser, GUI, Docker, server suite,
migration application, production operation, commit, push, Actions dispatch,
Alloy invocation or delegated reviewer occurred. No secret directory was needed.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build:command-core` | 0 | Generated declaration updated; runtime bundle unchanged. |
| `npm run build` | 0 | Passed, including guarded prebuild cleanup. |
| `npm run check:edge` | 0 | All seven entry points passed, both invocations. |
| `npm run check:tests` | 0 | Passed, both invocations. |
| Filtered `npm test` | 0 | 21 selected admin assertions passed; 102 runner entries include filtered files. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/p1-cli/admin-routine.test.ts` | 0 | 5 passed. |
| `node --import tsx --test tests/p1-cli/admin-recovery.test.ts` | 0 | 6 passed. |
| `node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts` | 0 | 1 passed. |
| `node --import tsx --test tests/p1-cli/admin-failure-diagnostics.test.ts` | 0 | 3 passed, including restored-handler controls. |
| Same diagnostic test with account handler reverted | 1 | Expected failure at the independent handler assertion. |
| Same diagnostic test with admin runtime handler reverted | 1 | Expected failure at the independent handler assertion. |
| Same diagnostic test with worker runtime handler reverted | 1 | Expected failure at the independent handler assertion. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | 3 passed. |
| `node --import tsx --test tests/p1-cli/citation-drift.test.ts` | 0 | 5 passed; cited source lines preserved. |
| `node --check tests/support/admin-server-harness.mjs` | 0 | Parsed. |
| `node --check tests/support/admin-routine-server-harness.mjs` | 0 | Parsed. |
| `git diff --check` | 0 | Passed. |
| `git diff --quiet -- supabase/functions/command/index.ts` | 0 | Mutation target restored exactly. |

The restricted npm invocation used:

```sh
NODE_OPTIONS='--test-name-pattern=^(human.consent.is|full-account.consent.pins|refresh.preserves.deadlines|grant.reads.reject|surrender.is.exact|account.events.rebuild|human.narrowing.removes|replacement.revokes|pure.decisions.charge|credential.scope.widening|workspace.withdrawal.requires|admin.runtime|real.worker.HTTP.handlers.refuse.admin|the.generated|routine.)' npm test
```

Unpiped output and mutation logs are in ignored `scratchpad/fold-cd8/`. Unfiltered
`npm test` was not run: existing subprocess fixtures change HOME and browser
controls conflict with the direct task restrictions. No full-suite or database
success is claimed.

## Files changed

- `src/protocol/admin-routine.ts`
- `supabase/functions/_shared/admin-routine.d.ts` (regenerated)
- `supabase/functions/command/admin-routine-workspace.ts`
- `supabase/functions/command/admin-routine.ts`
- `supabase/migrations/20261001000005_admin_routine_workspace_history.sql`
- `supabase/admin-delegation-reserve/20261001000005-rollback.sql`
- `tests/p1-cli/admin-failure-diagnostics.test.ts`
- `tests/support/admin-server-harness.mjs`
- `tests/support/admin-routine-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-cd/FOLD8.md`

Measured code delta: production/generated SQL and TypeScript, 113 added and
31 removed lines; tests and test support, 136 added and 15 removed lines.

## Pending server proof and risks

Run `storage` in `tests/p1-server/admin-delegation.test.ts`, including its new
history isolation, payload, privilege and rollback checks. Run all nine cases in
`tests/p1-server/admin-routine.test.ts`: workspace, invites, renewal, history,
expiry, concurrency, parent, rollback and rights. These now additionally prove
that minimized history remains reducer-complete for real routine events.
The migration/function, permissions, live transaction restoration and rollback
were not executed here. They require HezLead's authorized server run; none was
dispatched. The revised migration must accompany the adapter. New routine event
types or reducer-required fields need an explicitly reviewed SQL allowlist update.
There is no new departure from the grant contract, no policy widening, and no
claim that the overall delegated-admin feature is released or live.
