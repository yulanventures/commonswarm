# Lane D — human admin access and recovery

Source prepared on `lane/d-audit-revoke`, based on
`2297f071cba05a78b18a51564331b81cb31666f4`. No commit, push, Actions dispatch,
deployment, migration application, browser launch, keychain access, or production
contact occurred. HezLead owns the independent check.

## Result and integration prerequisite

Added human-only `admin_grants` and `admin_history` read resources, bounded to
100 rows per page with stable timestamp/ID cursors and explicit output fields.
Account grants/history stay private to their grantor. Current workspace owners
see only workspace action cards and a local active-access count; they do not get
another person's grant manifest, other workspace targets, or account-only audit.
Expiry is reflected before its lazy event is materialized. Aggregate active
counts do not depend on which page is displayed.

Added `cswarm admin grants`, `cswarm admin history`, and
`cswarm admin revoke --grant-id <uuid>`. They refuse worker/profile options and
are absent from model tools. Account revoke uses lane B's existing
`revoke_admin_delegation` command, without workspace discovery. An uncertain
result gives the CLI request ID for a safe retry; the browser retains that ID.

`/app` now has an active-access indicator, stronger for full-account grants,
grant summaries, recorded outcomes, paging, and Revoke buttons. The account menu,
Connected apps, workspace menu/settings, and first-workspace view expose access
and history. Rendering uses inert text. Signing out clears private rows;
workspace changes invalidate pending reads. The view does not promise to undo
completed actions or recall data already read.

**Lane C must integrate `supabase/functions/read/admin-recovery.sql` into its
migration after the admin tables.** This lane deliberately did not edit
migrations or assume `swarm_command` in a read transaction. The read resource
will fail closed until the SQL function exists. SQL execution, visibility/RLS,
and real server behavior are not verified locally.

The edge container mounts only `supabase/functions`. Its copy of the shared
validator is generated with:

```sh
node supabase/functions/read/build-admin-recovery.mjs
```

Run that command whenever `src/cloud/admin-delegations-contract.ts` changes.
The new CLI test checks generated/source agreement. No deployment file changed.

## Files changed (18 including this report)

- `src/cli.ts`
- `src/cloud/admin-delegations.ts`
- `src/cloud/admin-delegations-contract.ts`
- `supabase/functions/read/index.ts`
- `supabase/functions/read/admin-recovery.ts`
- `supabase/functions/read/admin-recovery.sql` — migration input only
- `supabase/functions/read/admin-recovery-contract.ts` — generated
- `supabase/functions/read/build-admin-recovery.mjs`
- `site/src/pages/app.astro`
- `site/src/components/app/LiveDashboard.astro`
- `site/src/components/app/AdminDelegations.astro`
- `site/src/lib/admin-delegations.ts`
- `site/src/components/app/admin-delegations.observer.test.ts`
- `tests/p1-cli/admin-recovery.test.ts`
- `tests/p1-cli/command-table-gates.test.ts` — reconcile two new handler shapes and three command rows
- `tests/p1-server/admin-recovery.test.ts`
- `tests/support/admin-recovery-server.mjs`
- `docs/evidence/2026-10-01-lane-d/RESULT.md`

## Gates and exit codes

All executed checks kept HOME unchanged and ran within the existing workspace
sandbox. No site/browser test or server suite was run on the mini.

| Command | Exit | Result |
|---|---:|---|
| `node supabase/functions/read/build-admin-recovery.mjs` | 0 | Generated the edge-local contract. |
| `npm run build` | 0 final; 2 on two earlier attempts | First failed for missing dependencies; second found CLI type errors, then fixed. |
| `npm run check:edge` | 0 final; 1 initial | Initial request-union narrowing errors fixed; all seven configured entry points pass. |
| `npm run check:tests` | 0 final; 2 on one intermediate run | Corrected the test's transport type. |
| `node --import tsx --test tests/p1-cli/admin-recovery.test.ts` | 0 final; 1 initial | Five final tests pass. Initial failure was the expected profile-refusal wording. |
| `node --import tsx --test --test-name-pattern='generated help covers\|variant help renders\|every handler shape\|every help entry\|each direct help row' tests/p1-cli/command-table-gates.test.ts` | 0 final; 1 earlier selection | Five final checks pass. Earlier fixed inventory still counted 68 shapes; now reconciles 70. Full file deferred because some tests replace HOME. |
| `node --import tsx --test tests/p1-cli/citation-drift.test.ts tests/p1-cli/test-gate-coverage.test.ts tests/p1-cli/admin-worker-boundary.test.ts` | 0 | Nine tests pass; existing citations and credential fences remain valid. |
| `node --import tsx --test tests/p1-cli/citation-drift.test.ts tests/p1-cli/test-gate-coverage.test.ts` | 0 | Eight tests pass on the final source. New CLI/server/site tests are reached by existing globs. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts tests/read-handler-main-only.test.ts` | 0 | Three tests pass. |
| `deno check --config supabase/functions/command/deno.json tests/support/admin-recovery-server.mjs` | 0 | Harness and imported adapters check; no scenario executed. |
| `npm --prefix site run build` | 0 | Final static build passes. |
| `bash scripts/build-release.sh` | 0 | Final standalone CLI runs and verifies version 0.1.80. |
| `git diff --check` | 0 | No whitespace errors. |
| `npm test` | Not run | Its literal list contains HOME-changing tests and a real-Chrome containment probe. |
| Site tests / server suite | Not run | Deferred as the task requires. |

Dependency preparation: both offline npm attempts exited 1 (`ENOTCACHED`);
neither changed a package manifest/lockfile. Existing root/site dependencies
were copied into this lane from the CommonSwarm checkout. Those copies and build
artifacts are ignored, not release evidence. No actual secrets were staged.

## Cases needing HezLead's authorized CI run

`tests/p1-server/admin-recovery.test.ts` / its Deno harness require lane C's
migration. The single server case covers:

1. Real human grant activation, private account isolation, and aggregate counts
   independent of the visible grant page.
2. Current workspace-owner action visibility, hidden foreign grant details,
   and refusal of ordinary members, worker/admin credentials, unknown account
   selectors, and oversized pages, with human positive controls.
3. Grant and action pagination with no duplicate/missing IDs, reconciled against
   the durable event set, and exclusion of private audit payload fields.
4. Existing human workspace withdrawal and account-only lifecycle isolation.
5. Effective expiry before materialization, recovery after membership loss and
   workspace archive, durable account revoke, and idempotent retry.

`site/src/components/app/admin-delegations.observer.test.ts` is skipped on
macOS. On Linux CI it uses globally installed Playwright with its bundled
Chromium, headless, `--password-store=basic`, and a fresh temporary profile.
It exercises the real component/browser transport: strong full-account status,
inert hostile names, refused history, uncertain-result retry with the same
command ID, durable revoke display, and private-row cleanup after a cross-tab
sign-out. CI must provide global Playwright plus its Chromium installation.
Run the rest of the site suite there too. No Actions run was requested here.

## Open risks and departures

- Integration is incomplete until lane C includes and verifies the SQL read
  function. No real SQL execution, migration/RLS check, browser interaction,
  visual/layout check, or production behavior is claimed.
- The checked-in authorization interfaces have no reviewed recovery-staff
  identity or recipient-progress authorization path. This resource grants
  neither; it exposes grantor and workspace-owner views only. Those additional
  contract surfaces require their own reviewed interface, not a caller-supplied
  account ID or an invented staff bypass.
- Workspace cards assume lane C retains `AdminActionRecorded` account audit
  records with the contract's `payload.workspace_id` and linked event IDs.
- The shared gate file asks for `env HOME="$T"`, while the worker prompt says
  never change HOME in tests. The worker prompt took precedence. The full
  `npm test` gate and HOME-changing CLI cases remain outstanding; they were not
  relabelled as passed by a name filter.
- No change to lane B's credential separation, consent, protected-action,
  authority, command, or migration code was made. No new protocol command or
  wider permission was introduced. Review and CI remain with HezLead.
