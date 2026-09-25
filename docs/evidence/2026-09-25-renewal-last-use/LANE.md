# Renewal grant last-use race — lane evidence (2026-09-25)

## Bug and scope

HezLead measured seven production read-edge 500s since 2026-09-18, four on 2026-09-25, with `SWARM_RENEWAL_LAST_USE_REWOUND` (SQLSTATE 55000) in the membership phase. An earlier `record_renewal_grant_use` statement can wait on a grant row locked by a later statement. After the later use commits, the earlier statement's `statement_timestamp()` is older than the row's `last_used_at`, so the no-rewind trigger rejects the update.

Source inventory: `rg -n 'last_used_at\s*=' supabase/migrations supabase/functions` finds two active assignments in `20260904000001_standing_grant_resume.sql`: `record_renewal_grant_use` and `agent_tokens_successor_fence`. The older copies in `20260901000001_standing_grants.sql` are superseded by the September 4 definitions. The read and command edges call the recorder; they do not write `last_used_at` directly. The successor fence first locks the grant row, then writes the same vulnerable statement timestamp, so it is included.

## Change

`20260925000002_renewal_last_use_monotonic.sql` replaces those two functions. The first version clamped the timestamp with `GREATEST`; Fold 1 adds a WHERE condition to both use updates so a statement older than the row's recorded use skips its use-field update when PostgreSQL rechecks the row after a lock wait. This also preserves the newer use's device, source, and new-host fields. The successor fence increments `successors_used` separately so a stale use still spends capacity. The no-rewind trigger remains enabled. The read-only catalog proof pins both exact bodies, search paths, security-definer modes, owners, and EXECUTE grants, plus the enabled no-rewind trigger.

## Test and mutation

`tests/p1-server/renewal-last-use.test.ts` uses separate PostgreSQL connections. B locks the grant row; A starts a use and the test confirms its backend waits on B while holding a relation lock on `swarm.renewal_grants`. B records a later use and commits. The SQL test uses a different device and source for A, then requires A to succeed and leave B's timestamp, device, source, and new-host fields unchanged. A successor test checks the same stale-use rule while requiring `successors_used` to increment. A separate test starts the local served read edge under a temporary HOME and `SWARM_ENV=test`, repeats the lock order with an HTTP member read, and requires HTTP 200 and B's timestamp. The edge has a 60-second boot window, and all tests have bounded timeouts and process cleanup.

HezLead ran the original race test at `e1cfd84c` on the reset local stack. It passed with the new body; reinstalling the old recorder body made it fail with `SWARM_RENEWAL_LAST_USE_REWOUND` (SQLSTATE 55000). The served-read assertion was after the SQL assertion, so that mutation did **not** measure a served HTTP 500. Fold 1 separates those assertions. With the Fold 1 SQL test, reverting only to the `GREATEST` body is expected to fail with `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` (55000) when A supplies another device or source; this server mutation is reasoned until HezLead runs it. The source contract test verifies the migration body digests and release proof, and its GREATEST-only negative control fails the digest comparison.

## Fold 1

Opus and Grok both passed Round 1 with RIGOUR notes. Opus measured, in rolled-back local SQL probes, that the `GREATEST` body succeeds for a same-device/NULL-source stale use but raises `SWARM_RENEWAL_USE_WITHOUT_TIMESTAMP` for a different device or non-NULL source. Fold 1 changes both writers' use-update WHERE clauses to reject a row whose `last_used_at` exceeds the statement start. The successor writer still increments its spend counter; its own race test checks this. The SQL race now makes the field differences observable. The served-read race is its own test, with the blocked backend tied to the grant relation and B's PID. The boot deadline is 60 seconds. The catalog proof also checks each function's execution context and grants.

HezLead's full gates at `e1cfd84c` on the reset local stack: `test:p1-server` 262/262, `npm test` 990/990, `test:p1-cli` 997/997, all other requested gates exit 0. These are **pre-Fold 1** results; the Fold 1 server tests and catalog proof have not been rerun against an installed Fold 1 migration. This lane has not applied a migration or contacted the box.

## Initial lane gates at `e1cfd84c`

| Gate | Exit | Counts / result |
| --- | ---: | --- |
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 990 tests, 988 pass, 2 fail; both existing resume tests hit sandbox `spawn EPERM`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1, interrupted | Initial run showed sandbox process-spawn failures and was interrupted. A bounded retry reached 10 failure markers, then its process group was terminated after 180 seconds (`-15`); no final test count was emitted. |
| `npm run check:tests` | 0 | Test TypeScript check passed, including new server test. |
| `npm run check:edge` | 0 | 6 Deno entry points checked. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 / 0 | Bundle regenerated with no diff. |
| `bash scripts/build-release.sh` | 0 | Shipped bundle built and execute-checked. |
| `npm --prefix site run build` | 1 | Sandbox `EPERM` unlinking existing `site/node_modules/.vite/deps/_metadata.json`. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors across the branch commits. |

## Fold 1 gates in this worktree

| Gate | Exit | Counts / result |
| --- | ---: | --- |
| `npm run build` | 0 | TypeScript build passed. |
| `env -u FORCE_COLOR npm test` | 1 | 990 tests: 988 pass, 2 fail on sandbox `spawn EPERM` in the existing resume tests. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 130 after interrupt | Node emitted 999 tests: 980 pass, 18 fail, 1 cancelled. The run attempted protected home paths and process spawning (`EPERM`) despite the suite's fixture isolation; `command-dispatch-baseline.test.ts` remained alive after the summary, so the process was interrupted. Both new contract tests passed. |
| `node --import tsx --test tests/p1-cli/renewal-last-use-contract.test.ts` | 0 | 2/2 passed, including the GREATEST-body negative control. |
| `npm run check:tests` | 0 | Test TypeScript check passed. |
| `npm run check:edge` | 0 | Six Deno entry points checked. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 / 0 | Bundle regenerated with no diff. |
| `bash scripts/build-release.sh` | 0 | Shipped bundle built and execute-checked. |
| `npm --prefix site run build` | 0 | 12 pages built. |
| `git diff --check origin/main...HEAD` | 0 | No whitespace errors across the five branch commits. |

## Not established

The Fold 1 migration has not been applied to a database. Its revised server races and catalog proof remain unmeasured on the local stack. Whether production has the preceding `20260925000001` migration is unverified; the box has not been contacted or released. HezLead owns local-stack execution and review; only Anvil under HezLead may release a reviewed main SHA to the box. `pgrep` and `ps` cannot inspect processes in this sandbox (`sysmond service not found` and `operation not permitted`); the CLI gate's process session ended after the interrupt, and the server tests, which start a served function, were not run here.
