# Lane B continuation report — 2026-10-01

Implemented in the working tree; no commit, push, deployment, database application,
GitHub Actions dispatch, browser, keychain access, or production contact occurred.
HezLead owns the independent check and subsequent server-suite execution.

The account reducer supports human consent, grant activation/replacement/narrowing,
revocation/suspension/expiry, local workspace withdrawal, private runtime credential
issuance and rotation, replay revocation, exact-grant surrender, and grant metadata.
Routine admin operations remain refused. Grants are timeboxed and default to granular,
read-only scope. Credential material is hashed in storage and excluded from events,
audit, and stored command responses. Runtime delivery uses a private callback.

## Files changed

- `package.json`
- `scripts/build-admin-types.mjs`
- `src/protocol/admin-policy.ts`
- `src/protocol/admin-authority.ts`
- `src/protocol/index.ts`
- `supabase/functions/_shared/protocol.js` (regenerated)
- `supabase/functions/_shared/admin-authority.d.ts` (generated)
- `supabase/functions/_shared/admin-policy.d.ts` (generated)
- `supabase/functions/command/admin-delegation.ts`
- `supabase/functions/command/index.ts`
- `supabase/functions/read/index.ts`
- `supabase/migrations/20261001000001_admin_delegation.sql`
- `supabase/admin-delegation-reserve/20261001000001-rollback.sql`
- `tests/protocol-admin-authority.test.ts`
- `tests/support/admin-fixture.ts`
- `tests/p1-cli/admin-protocol-bundle.test.ts`
- `tests/p1-server/admin-delegation.test.ts`
- `tests/support/admin-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-b/RESULT.md`

## Gates and exit codes

Every invocation used a separately created `/private/tmp/lane-home.XXXXXX` directory
via `env HOME="$T"`; HOME was never assigned. Those directories were removed with the
guarded rm, including the directories retained by interrupted test invocations.
Required commands were not piped. Logs were captured before inspecting them.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build:command-core` | 0 | JS bundle and declarations regenerated after protocol changes. |
| `npm run build` | 0 | Passed both runs. |
| `npm run check:tests` | 0 | Passed every run, including the final server-test source. |
| `npm run check:edge` initial attempt | 1 | Dependency download failed on sandbox DNS. |
| `npm run check:edge` cached retries | 0 | All entry points passed. Only cached npm packages were copied into the disposable Deno cache. |
| `npm test` full attempt | 130 | Interrupted after no-progress period; summary: 1,217 tests, 1,082 passed, 116 failed, one cancelled, 18 skipped. All ten then-present admin tests passed. |
| `npm test -- --test-name-pattern=...` attempted focused retry | 130 | Trailing flag did not filter the runner. Interrupted; summary: 1,130 tests, 1,052 passed, 75 failed, one cancelled, two skipped. All eleven admin tests passed. |
| `npm test` with initial NODE_OPTIONS name filter | 0 | Filter value was split at spaces; this selected human-related tests, including three admin tests. Not counted as complete admin proof. |
| `npm test` with final NODE_OPTIONS name filter | 0 | All eleven admin protocol tests passed. Runner summary: 92 passed, including empty filtered-file entries; 92 is not the number of admin assertions. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | One bundle boundary test passed on both runs. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | Three script/typecheck coverage tests passed on both runs. |
| `git diff --check` | 0 | Final diff passed. |

The final focused environment option was:

```text
NODE_OPTIONS=--test-name-pattern=human.consent.is|full-account.consent.pins|refresh.preserves.deadlines|grant.reads.reject|surrender.is.exact|account.events.rebuild|human.narrowing.removes|replacement.revokes|pure.decisions.charge|credential.scope.widening|workspace.withdrawal.requires
```

A preliminary extra `sandbox-exec` launcher exited 71 (`sandbox_apply: Operation not
permitted`) before the build ran. Subsequent gates ran inside the existing workspace
sandbox. The box dry-run suite retains its own fail-closed containment controls.
The failed broad runs include socket/process permission denials, unavailable nested
sandbox containment, release-plan assertions, and citation drift. No baseline comparison
was run, so this report does not assert that every failure predates this patch.

## Server tests still needing an authorized CI/server run

`tests/p1-server/admin-delegation.test.ts` contains seven cases:

1. HTTP credential separation, GoTrue isolation, resource/workspace/grant substitution,
   widened requests, public refresh refusal, unknown-credential attribution, and current rights.
2. Atomic rotation, idempotency without repeat secret delivery, concurrent refresh replay,
   durable revocation, and uncertain delivery failure.
3. Granular defaults, session/CSRF binding, single-use consent, and full-account selection.
4. Durable refused-attempt charging, idempotent retries, human audit, and exact surrender
   after allowance exhaustion.
5. Narrowed deadlines, expiry enforcement before lazy materialization, refused refresh,
   and human recovery after expiry.
6. Real transaction rollback, separate failure audit, no success event, and failure replay.
7. Real migration/RLS catalogs, append-only events, reserve rollback/reapplication within
   a rollback transaction, and recovery after membership loss.

Also run the existing `command.test.ts`, `hosted-authority.test.ts`,
`hosted-check.test.ts`, and `hosted-mcp.test.ts` server regressions, because the shared
command and read entry points changed. No server test, Docker command, or migration
execution occurred in this worker session.

## Open risks and contract departures

- Runtime/OAuth integration is unfinished: the separate admin audience is enforced by the
  new account adapter and opaque credential records, but no OAuth provider integration,
  protected runtime store, or concrete authenticated delivery transport was added. The
  exported runtime entry requires a server-verified connection/client identity. Public
  HTTP cannot select it. Existing hosted MCP grant/provider code was left untouched as
  instructed. This foundation is not a complete end-to-end OAuth release.
- Unknown credentials have a separate security bucket using the pinned aggregate mutation
  ceiling of 60/hour. The contract requires a separate limiter but supplies no dedicated
  value. This reuses a reviewed value instead of inventing a new constant; HezLead must
  review whether the shared security bucket is the intended policy.
- The contract calls for bounded replacement after lost credential delivery but does not pin
  an admin replacement budget. This lane terminally revokes uncertain delivery and requires
  a new human-consented grant instead of implementing replacement with an invented budget.
  A failed recovery transaction reports `admin_delivery_recovery_unavailable` and needs
  operator recovery; it never reports delivery success.
- Full-account indicators, rendered action cards, and consent UI were not added because the
  site is excluded. Their durable backend data/events exist; no UI behavior is claimed.
- Server tests, migration application, race execution, and independent cross-family review
  remain unverified. The full local test gate is not green.
