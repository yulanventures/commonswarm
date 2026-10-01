# Lane C routine administration — working-tree report

2026-10-01. Base `2297f071`, branch `lane/c-routine-admin`.
No commit, push, Actions dispatch, deployment, production contact, browser,
GUI application, keychain access, or secret staging was performed. HezLead owns
independent cross-family review and authorized CI execution.

## Implemented

Routine decisions retain the delegated actor, check the presenting credential,
current grant and rights, workspace coverage, target/recipient/transport rules,
worker ceilings, finite budgets, expiry and withdrawal. They append domain events
and action records; accepted effects and both streams' projections commit with
the command receipt. Retries use Lane B's identity/command/digest ledger and do
not redeliver secrets or spend again. Protected operations remain refused.

Workspace creation has a separate scope, owns the new space for the grant holder,
and records only the confirmed new-workspace scope association. Seat creation
retains tombstones and name uniqueness. Local provisioning, renewal and bounded
undelivered replacement require both delegated access and signed recipient
runtime proof through a private callback. Secrets are absent from replayable
results and events. Replacement preserves ancestry, lineage, horizon and finite
spend. Revocation handles whole seats and credential lineages.

Member and own-agent invitations are recipient-bound durable records with
`awaiting_authorization` state. Revocation does not refund issuance. Human invite
counts include these records, and ordinary and delegated paths share the daily
policy constants and account lock. Both account and workspace reducers fold the
new canonical domain events. Existing hosted turn-only behavior remains pinned
at its original cited line in the workspace reducer.

The new migration adds durable invitation and new-workspace associations,
delegated event attribution and worker ancestry. Restrictive token SELECT policy
checks parent state, deadline, scope ceiling, workspace coverage and current
rights; ordinary worker successors inherit immutable ancestry. Grant end cancels
pending invitations using the same timestamps as the pure account reducer.
Nothing was applied to a database here.

## Gate exits

All invocations used a created `/private/tmp/lane-home.XXXXXX` directory passed
through `env HOME="$T"`; the shell HOME was never assigned. The guarded rm was
used by existing build scripts. The owned disposable home/cache was resolved,
validated with positive/negative cleanup controls, and removed at the end.
Dependencies were copied from the existing local install into this worktree;
no package download or dependency-version change was needed. Deno's npm cache
was copied into the disposable home after the first DNS failure.

| Gate | Exit | Result |
|---|---:|---|
| Initial `npm run build:command-core` | 127 | Worktree lacked esbuild. |
| Initial `npm run build` | 2 | Worktree lacked Node type definitions. |
| `npm run build:command-core` after dependency copy | 0 | Bundle and six type declaration files regenerated; final regeneration passed. |
| `npm run build` after dependency copy | 0 | All subsequent builds, including final source, passed. |
| Initial `npm run check:edge` | 1 | Sandbox DNS prevented npm dependency download. |
| Cached `npm run check:edge` | 0 | Passed on final sources across all seven named entry points. |
| Diagnostic edge checks during implementation | 1 | Two failures: nullable lookup typing, then quote-sensitive declaration import rewriting after formatting. Both repaired; final check 0. |
| Initial `npm run check:tests` | 2 | Readonly test table typing; repaired. |
| Subsequent/final `npm run check:tests` | 0 | Passed, including new server-suite TypeScript. |
| Initial new pure routine test | 1 | Grant event carried an extra replacement field; fixed by extracting exactly the shared manifest keys before validation. |
| Final pure/bundle/Lane B admin invocation | 0 | 18 tests passed; final routine/bundle follow-up: seven passed. |
| `npm test` | 130 | Interrupted after 76 seconds without output. Flushed summary: 1,140 tests, 1,062 passed, 75 failed, one cancelled, two skipped. Broad gate is not green. |
| `node --import tsx --test tests/p1-cli/admin-routine.test.ts` | 0 | Five behavior cases. |
| Same direct command: `admin-protocol-bundle.test.ts` | 0 | Two generated-bundle behavior cases. |
| Same direct command: `admin-worker-boundary.test.ts` | 0 | Real worker handlers refuse admin credentials. |
| Same direct command: `citation-drift.test.ts` | 0 | All five checks passed; verified hosted reducer citation separately. |
| Same direct command: `test-gate-coverage.test.ts` | 0 | All three checks passed. |
| Same direct command: `create-workspace.test.ts` | 0 | Passed. |
| Same direct command: `d069-invite-revoke.test.ts` | 0 | Passed. |
| Same direct command: `workspaces.test.ts` | 0 | Passed. |
| Same direct command: `standing-grants.test.ts` | 1 | Five passed; two fixture servers failed with `listen EPERM` on 127.0.0.1. |
| `node --check tests/support/admin-routine-server-harness.mjs` | 0 | Syntax check only, not server proof. |
| `git diff --check` | 0 | Passed. |

Broad-gate output is retained in ignored `scratchpad/lane-c/npm-test.log`.
Focused CLI logs are beside it. Broad failures include socket/process permission
denials and release-plan assertions. No broad baseline comparison was made, so
this report does not assert that all 75 failures predate this lane. All new routine,
bundle and Lane B admin tests passed in the broad invocation. Docker, Supabase,
and browser launcher stand-ins blocked host integrations in that invocation;
no server suite or browser gate was executed.

## Server cases requiring CI

`tests/p1-server/admin-routine.test.ts` names eight scenarios and invokes the real
Deno command adapter against a local stack. Temporary paths use `os.tmpdir()`.
No server scenario was run on this host:

- `workspace`: concurrent same-request creation, digest conflict, finite budget,
  reducer-complete workspace history and restricted new-space inheritance.
- `invites`: approved recipient, pending authorization, protected role refusal,
  idempotent retry, member/agent invitation revoke and no budget refund.
- `renewal`: private provisioning, actual worker authentication, bounded successor,
  no retry delivery/spend, undelivered replacement and retained lineage.
- `expiry`: actual child authentication before and after parent deadline, before
  lazy expiration materialization.
- `concurrency`: human parent revoke competing with routine mutation, ordered
  canonical events, stopped child access and later mutation refusal.
- `parent`: durable parent revoke fences child and admin calls.
- `rollback`: cross-stream rollback retains no principal or success event.
- `rights`: current role loss fences child and admin mutations while human
  account recovery still works.

Retain Lane B's eight server scenarios; its rollback drill now unwinds/restores
this migration before testing the lane-B schema. Also run ordinary command,
worker renewal/revocation and hosted authority regressions. The new migration's
SQL, RLS, locking and legacy-schema compatibility require that actual stack run.
These repository cases are not a claim that a CI workflow already ran them.

## Open risks and contract departures

This is a prepared backend slice, not a complete released admin product.

1. Hosted seat records may be created, but hosted provisioning refuses
   `hosted_runtime_authorization_required`. No hosted connector is upgraded or
   given a local worker bearer. A separately authorized hosted runtime delivery
   path is still missing; hosted access/renewal completion is not claimed.
2. Invitations can be issued, inspected in durable history and revoked, but
   delivery and recipient redemption are not implemented. They stay
   `awaiting_authorization`; they are not delivered invites or accepted access.
   The legacy anonymous join credential is intentionally not reused because it
   does not satisfy the recipient/proof/parent dependency contract.
3. Invitation revocation covers this grant's newly issued routine invitations.
   Adoption/revocation of independently human-issued legacy invitations is not
   implemented by this slice.
4. Actual vendor/session enrollment and connection proof remain unmeasured.
   Signed issuer/runtime binding and private credential callback do not establish
   that a particular vendor session is connected. Provisioning remains pending.
5. Server suites, migration application, independent review and a green broad
   gate remain outstanding. No production or release readiness is claimed.

No admin credential boundary, protected human action, worker scope or terminal
ancestry rule was weakened to conceal these gaps. No read/, site/, CLI, deploy/,
HM37 or release-plan file was edited. The requested operations are implemented
at the core/local-worker boundary with the explicit delivery/hosted/legacy gaps
above; the full contract is not claimed complete.

## Files changed

- `package.json`
- `scripts/build-admin-types.mjs`
- `src/protocol/admin-authority.ts`
- `src/protocol/admin-policy.ts`
- `src/protocol/events.ts`
- `src/protocol/index.ts`
- `src/protocol/workspace-events.ts`
- `src/protocol/workspace-reducer.ts`
- `supabase/functions/_shared/admin-authority.d.ts`
- `supabase/functions/_shared/admin-policy.d.ts`
- `supabase/functions/_shared/protocol.js`
- `supabase/functions/command/admin-delegation.ts`
- `supabase/functions/command/index.ts`
- `tests/p1-cli/admin-protocol-bundle.test.ts`
- `tests/support/admin-server-harness.mjs`
- `src/protocol/admin-routine-events.ts`
- `src/protocol/admin-routine.ts`
- `supabase/admin-delegation-reserve/20261001000002-rollback.sql`
- `supabase/functions/_shared/admin-routine-events.d.ts`
- `supabase/functions/_shared/admin-routine.d.ts`
- `supabase/functions/_shared/events.d.ts`
- `supabase/functions/_shared/workspace-events.d.ts`
- `supabase/functions/command/admin-routine.ts`
- `supabase/functions/command/worker-scopes.ts`
- `supabase/migrations/20261001000002_admin_routine.sql`
- `tests/p1-cli/admin-routine.test.ts`
- `tests/p1-server/admin-routine.test.ts`
- `tests/support/admin-routine-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-c/RESULT.md` — this report.
