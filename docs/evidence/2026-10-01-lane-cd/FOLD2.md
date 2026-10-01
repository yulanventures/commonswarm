# C+D integration fold 2

Base: `cae2ac33397fb71468e9aec23615b353b74428b5`, branch
`lane/cd-admin-integ`. Changes are uncommitted. Server findings below are
source findings; the task explicitly excludes running the server suite here.
No Actions dispatch, commit, push, deployment, database application, browser,
GUI application, keychain read, credential retrieval, or Alloy run occurred.
HezLead owns independent review and CI execution.

| Test | Cause with file:line | Fix / remaining proof |
|---|---|---|
| Server #9, human recovery | The harness expected `body.ok`; the actual account receipt uses `status` and events (`supabase/functions/command/admin-delegation.ts:403`). The same wrong assumption also existed in the offline revoke assertion and CLI client (`src/cloud/admin-delegations.ts:44`). | Require accepted status and the exact grant activation/revocation event in the server harness. Make the client consume the actual receipt. Its existing behavior test now supplies the real response shape: failed before the client fix, passed afterward. |
| Server #10, workspace creation | **Not diagnosed from the supplied CI summary.** Its new workspace has no existing row, so `prepareAdminRoutine` skips the missing-stream check (`supabase/functions/command/admin-routine.ts:48`). | Reviewed concurrent retry, counters, event reduction, history, restricted inheritance and narrowing. No independent source defect identified in this branch. Need the case's `ADMIN_ROUTINE_SERVER_FAILED` marker / CI verification; no claim that #10 is fixed. |
| Server #11, invitations | The seed omitted its workspace stream; the first routine operation throws at `supabase/functions/command/admin-routine.ts:55`. | Seed the stream at `tests/p1-server/admin-routine.test.ts:83`. Reviewed recipient, protected-role, retry, pending-state, revocation and no-refund branches; no further independent defect identified. |
| Server #12, renewal/replacement | Same missing stream. The old authentication probe used `loadAgentCredential`, which can return a revoked record; that function returns facts, not the final authorization decision (`supabase/functions/_shared/agent-auth.ts:134`). | Seed the stream. Exercise the real worker `members` read with verified recipient identity and exact authentication statuses (`tests/support/admin-routine-server-harness.mjs:389`), including revoked replacement denial and usable successor. |
| Server #13, history/revocation | Same missing stream and revoked-record probe error. | Seed the stream and use the real read boundary. Retain exact linked-card, pagination, private-field exclusion and credential/seat revocation assertions. |
| Server #14, expiry | Same missing stream. The real read helper is a table-owner `SECURITY DEFINER` (`supabase/migrations/20260906000020_agent_execution_sessions.sql:113`); token RLS for command/read roles (`supabase/migrations/20261001000002_admin_routine.sql:73`) does not fence this helper. | New migration `20261001000004_admin_worker_read_fence.sql:57` checks parent state/deadline/coverage/current rights and scope before first-use stamping or reads. Exercise real reads before and after expiry, retaining the pre-materialization assertion. |
| Server #15, concurrency | Same missing stream. Real child reads also need the definer parent check after a committed revoke. | Seed the stream and install the read fence. Keep exact event ordering, accepted-or-refused race outcome, stopped child and later mutation denial. |
| Server #16, parent revocation | Same missing stream; real reads bypassed the parent RLS policy. | Seed the stream, use the actual read endpoint and install its SQL parent fence. |
| Server #17, rollback | Same missing stream prevents reaching the write under test. | Seed the stream. Retain the reached-write positive control, thrown transaction, unchanged event count and absent principal. No further independent source defect identified. |
| Server #18, rights loss | Same missing stream. An ordinary member remains entitled to workspace reads through the legacy definer, so losing admin rights alone did not stop its delegated descendant read. | The SQL parent fence checks the grantor's current owner/admin rights. Real worker reads now cover the role-loss denial; human recovery remains unchanged. |
| CLI #267, MCP row names | Fixture enumeration fails on four missing admin policy entries (`tests/p1-cli/command-dispatch-baseline.test.ts:76`), before its MCP assertions. | Extend independent policy inventory and admin fixtures; retain MCP route assertions. |
| CLI #270, profile help | Generated help baseline predates the three admin commands (`src/cli.ts:10194`). | Regenerate through the existing baseline test's new limited `UPDATE_DISPATCH_BASELINE=help` mode (`tests/p1-cli/command-dispatch-baseline.test.ts:940`). |
| CLI #271, bare device refusal | Same missing policy inventory; refusal body itself is unchanged. | Extend inventory; unchanged exact wording and recorded-row assertion pass. |
| CLI #272, notify/follow priority | Same missing policy inventory; refusal body itself is unchanged. | Extend inventory; unchanged priority and recorded-row assertion pass. |
| CLI #273, repeated wait | Same missing policy inventory; refusal body itself is unchanged. | Extend inventory; unchanged exact wording and recorded-row assertion pass. |
| CLI #274, since validation order | Same missing policy inventory; refusal bodies themselves are unchanged. | Extend inventory; unchanged target/kind ordering and recorded-row assertions pass. |
| CLI #276, profile variants | Same missing policy inventory prevents fixture enumeration. | Extend inventory; unchanged profile-variant assertions pass. |

The migration preserves the SQL helper's existing signature/OID, privileges,
return fields and legacy body. Only parent declarations and the early fence are
added. Parent scope checks become volatile so they use a fresh snapshot after
waiting for the grant lock. The reserve rollback restores the exact legacy
helper and scope volatility. The lane B rollback drill unwinds migration 4
first and reapplies it last, without shifting the harness's existing lines.
None of this SQL was applied or executed here.

## Generated baseline wording

The existing complete generator requires a loopback server; its invocation
failed with `listen EPERM`. The limited mode reruns every existing help row and
all newly added admin refusal rows through the same fixture runner. It refuses
any existing non-help output, argument, exit-code or handler-trace change,
retains untouched rows, and writes both generated JSON artifacts. The normal
network-backed generator and ordinary comparison gate remain unchanged.

Invocation, exit 0:

```sh
env UPDATE_DISPATCH_BASELINE=help node --import tsx --test \
  --test-name-pattern='the command dispatcher matches' \
  tests/p1-cli/command-dispatch-baseline.test.ts
```

338 existing rows changed only by adding these three help blocks:

```text
  cswarm admin grants [--workspace-id <uuid>] [--limit <n>] [--before <cursor>] [--json]
    List your admin grants.
    Additional options: --url <url>, --anon-key <key>, --force-file-store
  cswarm admin history [--workspace-id <uuid>] [--limit <n>] [--before <cursor>] [--json]
    See your account actions or workspace admin history.
    Additional options: --url <url>, --anon-key <key>, --force-file-store
  cswarm admin revoke --grant-id <uuid> [--request-id <uuid>] [--json]
    Revoke an admin grant without a workspace.
    Additional options: --url <url>, --anon-key <key>, --force-file-store
```

All are intended descriptions/options for the new human-only commands. No
existing help or refusal wording was removed or replaced. No non-output field
changed on an existing row. The original 1,347 rows remain; 56 added admin rows
make 1,403 total (43 zero exits, 1,360 nonzero exits): three argument refusals,
12 missing/unknown selector variants, 36 prototype selector variants, one
profile refusal and four host-session policies. Their additional refusal text:

- `cswarm: --limit must be an integer in 1..100`
- `cswarm: Choose a valid workspace ID, page size, and cursor.`
- `cswarm: Use the full grant ID and a UUID request ID.`
- `cswarm: cswarm admin takes grants, history, or revoke`
- The existing `--profile is supported by: ...` list, unchanged; admin is excluded.

These are intended new-command validation paths, not changes to existing text.

## Gate exit codes

The runner's HOME was kept unchanged, following the user's direct instruction;
this departs from base-cd.txt's `env HOME="$T"` gate directive. Existing tests
still use their own repository-provided child-process temporary-home fixtures.
No shell HOME assignment was made. Browser, host integration and keychain
launches were blocked by task-owned stand-ins and a Node preload guard for the
broad invocation; the guard's refused keychain launch and allowed Node launch
were checked together. No secrets were staged.

| Command | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | Passed. |
| `npm run check:edge` | 0 | All seven named entry points passed. |
| `npm run check:tests` | 0 | Passed. |
| `npm test` | 1 | Interrupted at about 134 seconds with no forward output. Flushed summary: 1,140 tests, 1,062 passed, 75 failed, one cancelled, two skipped. Failures include TCP/Unix socket EPERM, release-plan checks and unavailable nested containment. No baseline comparison establishes that all failures predate this fold. This run preceded the SQL-only migration addition, which this gate cannot exercise. |
| Seven reported dispatcher cases, before fixes | 1 | All seven failed; inventory and stale help causes reproduced. |
| Dispatcher generator, limited help/admin mode | 0 | Generated both JSON files; existing non-help behavior unchanged. |
| `node --import tsx --test tests/p1-cli/command-dispatch-baseline.test.ts` | 1 | Ten passed; only the complete network-backed comparison failed with loopback EPERM. |
| Same file, ten service-free cases selected with `--test-name-pattern` | 0 | All ten passed, including all seven reported CI failures. |
| `node --import tsx --test tests/p1-cli/admin-recovery.test.ts` | 0 | Five passed. Actual lane B receipt fixture failed before the client fix (exit 1), passed afterward. |
| Same direct command: `admin-routine.test.ts` | 0 | Five passed. |
| Same direct command: `admin-protocol-bundle.test.ts` | 0 | Two passed. |
| Same direct command: `admin-worker-boundary.test.ts` | 0 | One passed. |
| Same direct command: `citation-drift.test.ts` | 0 | Five passed. |
| Same direct command: `test-gate-coverage.test.ts` | 0 | Three passed. |
| Same direct command: `command-table-gates.test.ts` | 0 | 38 passed. |
| `node --check` on each of the three admin server harnesses | 0 each | Syntax only; no server execution. |
| Static forward/rollback body comparison | 0 | Rollback exactly matches the old helper; forward changes only the named additions. Not SQL runtime proof. |
| `git diff --check` | 0 | Passed. |

Logs are in ignored `scratchpad/fold-cd2/`. The task-owned gate directory was
resolved, checked with positive/negative cleanup controls, and removed with
guarded rm. No generated protocol files required regeneration.

## Files changed

- `src/cloud/admin-delegations.ts`
- `tests/p1-cli/admin-recovery.test.ts`
- `tests/p1-cli/command-dispatch-baseline.test.ts`
- `tests/p1-cli/fixtures/command-dispatch-baseline.json` (generated)
- `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json` (generated)
- `tests/p1-server/admin-routine.test.ts`
- `tests/support/admin-recovery-server.mjs`
- `tests/support/admin-routine-server-harness.mjs`
- `tests/support/admin-server-harness.mjs`
- `supabase/migrations/20261001000004_admin_worker_read_fence.sql`
- `supabase/admin-delegation-reserve/20261001000004-rollback.sql`
- `docs/evidence/2026-10-01-lane-cd/FOLD2.md`

## Remaining proof and risks

HezLead must arrange the cross-family check, all ten C/D server cases (#9–#18),
lane B's storage/rollback scenario and worker read/renewal regressions, plus the
ordinary network-backed dispatcher comparison. **Case #10 needs its failure
marker; its cause remains unresolved.** No server-green or migration-runtime
claim is made. The copied SQL body must remain aligned with the legacy helper
when future schema migrations change it.

No grant-contract authorization departure was introduced: admin credentials
remain on the admin path, protected actions retain human confirmation, and the
new SQL check strengthens the existing fail-closed parent contract. Item L #218
was left unchanged, as instructed.
