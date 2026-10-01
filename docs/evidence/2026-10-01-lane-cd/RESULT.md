# Lane CD integration — working-tree report

2026-10-01. Branch `lane/cd-admin-integ`, base `262476d4`.
Prepared locally only. No commit, push, Actions dispatch, deployment, database
application, production contact, browser/GUI launch, keychain access, 1Password
command, or secret staging occurred. HezLead owns the independent check and any
authorized server-suite run.

## Changes

Installed Lane D's human recovery read function in the new migration
`supabase/migrations/20261001000003_admin_recovery_read.sql`. Its source is
mirrored in `supabase/functions/read/admin-recovery.sql`; the migration contains
the verbatim reserve SQL retained in
`supabase/admin-delegation-reserve/20261001000003-rollback.sql`.

The function is parameterized, `STABLE SECURITY DEFINER`, owned by
`swarm_admin`, and pins `search_path=pg_catalog`. All application tables and
`auth.uid()` are schema-qualified. Execution is revoked from PUBLIC, anon,
authenticated and swarm_command, and granted only to swarm_read. The edge
continues to authenticate a human before installing their claims and invoking
this function; it never assumes swarm_command. Private table ACLs/RLS are
unchanged. Pagination remains bounded to 100, with timestamp/UUID cursors.

Checked the complete read table inventory against the existing schema:

- `swarm.memberships`: workspace_id, user_id, role, revoked_at, from the base schema.
- `swarm.admin_grants`: grant/owner/admin/connection/client IDs, mode, scopes,
  selector/workspace/withdrawal lists, state and lifecycle deadlines/timestamps,
  reason_code and created_workspace_policy, from migration 00001.
- `swarm.admin_events`: owner_user_id, seq, event_id and JSON event envelope and
  payload fields, from migration 00001 and the Lane B/C decision functions.
- `swarm.admin_created_workspaces`: workspace_id, grant_id, scope_names, from
  migration 00002.

No renamed table, column, envelope field or event mismatch was found. The
integration mismatch was workspace coverage: Lane D recognized selected and
currently owned workspaces, but missed Lane C's granular created-workspace
association. Recovery authorization, grant pages and workspace active counts
now include that association. Counts respect the association's scopes and the
current narrowed created-workspace policy. Historical association remains
visible after narrowing or membership loss/archive; the immutable selected
workspace manifest is not enlarged to describe it.

History projects each routine operation's existing `AdminActionRecorded`, using
its action, target, actor, outcome, safe next step and linked domain-event IDs.
This covers workspace creation, seat creation/provisioning, credential
replacement/renewal, member and agent invitations, and invitation/seat/credential
revocation. It includes refusals and pending outcomes. It does not duplicate
cards by returning raw domain payloads. The existing minimal field contract,
terminal sanitization and browser textContent rendering remain unchanged.

Added real-server coverage to Lane C's existing scenarios, plus a `history`
scenario for seat/credential revoke. Every scenario reconciles human history
pagination against the entire durable action set and checks linked routine
domain events, actor/outcome fields and private-field exclusion. Workspace
coverage checks creation, narrowing and historical recovery. Lane D's server
case checks definer ownership, pinned path, execution ACLs and private-table
RLS/ACLs. Lane B's rollback drill now unwinds 00003 before 00002/00001 and
restores all three within the existing rollback transaction.

## Gates and exact exit codes

HOME stayed unchanged for every invocation. Dependencies were copied from the
existing Lane C node_modules; manifests/lockfiles were not changed. All commands
ran under the workspace sandbox. Existing build cleanup resolved to the guarded
`/Users/yulanbot/.local/bin/rm`; no cleanup was refused. No secret directory was
needed.

| Command | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript and executable CLI build passed. |
| `npm run check:edge` | 0 | All seven configured entry points passed. |
| `npm run check:tests` | 0 | Includes updated server-suite TypeScript. |
| `node --import tsx --test tests/p1-cli/admin-routine.test.ts` | 0 | 5 passed. |
| `node --import tsx --test tests/p1-cli/admin-recovery.test.ts` | 0 | 5 passed. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts` | 0 | 1 passed. |
| `node --import tsx --test tests/p1-cli/citation-drift.test.ts` | 0 | 5 passed. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | 3 passed. |
| `node --import tsx --test tests/protocol-admin-authority.test.ts` | 0 | 11 passed. |
| `node --import tsx --test tests/admin-runtime-auth.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/read-handler-main-only.test.ts` | 0 | 2 passed. |
| `node --import tsx --test tests/p1-cli/create-workspace.test.ts` | 0 | 9 passed. |
| `node --import tsx --test tests/p1-cli/d069-invite-revoke.test.ts` | 0 | 4 passed. |
| `node --import tsx --test tests/p1-cli/workspaces.test.ts` | 0 | 16 passed. |
| Command-table selection below | 0 | 5 passed; whole file not run. |
| Deno harness check below | 0 | All three updated harnesses checked; scenarios not executed. |
| Migration/source and verbatim reserve comparison | 0 | Python read-only comparison passed. |
| `git diff --check` | 0 | Passed. |
| `npm test` | Not run | Named tests override HOME and include an installed-Chrome containment probe. |
| Server suites / site browser suite | Not run | Deferred to HezLead; no local stack/browser execution authorized here. |

Exact command-table selection:

```sh
node --import tsx --test --test-name-pattern='generated help covers|variant help renders|every handler shape|every help entry|each direct help row' tests/p1-cli/command-table-gates.test.ts
```

Exact harness check:

```sh
deno check --config supabase/functions/command/deno.json tests/support/admin-recovery-server.mjs tests/support/admin-routine-server-harness.mjs tests/support/admin-server-harness.mjs
```

The 13 direct test invocations passed 70 tests total. Logs and the broad-gate
safety inventory are in ignored `scratchpad/lane-cd/`. The broad gate is not
green or measured by a filtered substitute. Standing-grants and whole
command-table cases that override HOME remain deferred as well.

## Server-suite cases for HezLead's authorized CI/server run

After applying all three migrations to an exclusive local test stack, run the
existing server script (its glob includes these files). No Actions dispatch is
requested or performed by this worker.

- `tests/p1-server/admin-routine.test.ts`: nine cases — workspace, invites,
  renewal, history, expiry, concurrency, parent, rollback, rights. They now
  include real human read/history reconciliation. The workspace case checks
  granular created-space visibility, unchanged selected manifest, narrowed
  association scopes and recovery after membership loss/archive. The history
  case checks accepted credential and seat revoke cards. Other cases cover
  pending provisioning/renewal/replacement/invitations and durable refusals.
- `tests/p1-server/admin-recovery.test.ts`: one case — real human isolation,
  owner-only workspace cards, aggregate counts, pagination, private-field
  exclusion, expiry and offline/idempotent revoke, plus the new function and
  table ACL/RLS catalog checks.
- `tests/p1-server/admin-delegation.test.ts`: eight existing cases — runtime,
  boundary, lifecycle, consent, limits, expiry, failure, storage. The storage
  case now verifies the read function's reserve removal/reapplication in the
  complete three-migration rollback drill.
- Keep the ordinary `command.test.ts`, `hosted-authority.test.ts`,
  `hosted-check.test.ts` and `hosted-mcp.test.ts` server regressions, plus worker
  renewal/revocation regressions named in Lane C's report.
- Lane D's Linux-only site observer case and remaining site suite still need
  their authorized headless Playwright environment. This task did not authorize
  a browser launch. The worker did not run that case on macOS.

All updated server wrappers continue to use `os.tmpdir()`; no macOS-specific
path was introduced. Repository CI currently contains only commit guards;
these cases still require HezLead to arrange their actual execution.

## Open risks and departures

SQL parsing/execution, migration application, actual role/RLS enforcement,
rollback execution and real server history remain unmeasured until the server
run. Browser behavior was not remeasured. HezLead's independent cross-family
check remains outstanding. The integration is prepared, not landed/applied/live.

The direct worker instruction forbidding HOME changes takes precedence over
base-cd.txt's `env HOME="$T"` recipe. That conflict and the installed-Chrome probe
prevented `npm test` and the HOME-changing CLI cases from running. They are
explicitly unrun, not assigned a fictional exit code. No permission boundary or
protected human action was weakened to make a gate pass.

Lane C's hosted runtime delivery, invitation delivery/redemption, legacy invite
adoption and vendor/session proof gaps, and Lane D's unavailable recovery-staff
and recipient-progress interfaces, remain as reported by those lanes. This
integration adds no implementation or completion claim for those surfaces.

## Files changed (9)

- `supabase/migrations/20261001000003_admin_recovery_read.sql`
- `supabase/admin-delegation-reserve/20261001000003-rollback.sql`
- `supabase/functions/read/admin-recovery.sql`
- `tests/p1-server/admin-recovery.test.ts`
- `tests/p1-server/admin-routine.test.ts`
- `tests/support/admin-recovery-server.mjs`
- `tests/support/admin-routine-server-harness.mjs`
- `tests/support/admin-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-cd/RESULT.md`
