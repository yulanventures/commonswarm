# Renewal grant last-use race — lane evidence (2026-09-25)

## Bug and scope

HezLead measured seven production read-edge 500s since 2026-09-18, four on 2026-09-25, with `SWARM_RENEWAL_LAST_USE_REWOUND` (SQLSTATE 55000) in the membership phase. An earlier `record_renewal_grant_use` statement can wait on a grant row locked by a later statement. After the later use commits, the earlier statement's `statement_timestamp()` is older than the row's `last_used_at`, so the no-rewind trigger rejects the update.

Source inventory: `rg -n 'last_used_at\s*=' supabase/migrations supabase/functions` finds two active assignments in `20260904000001_standing_grant_resume.sql`: `record_renewal_grant_use` and `agent_tokens_successor_fence`. The older copies in `20260901000001_standing_grants.sql` are superseded by the September 4 definitions. The read and command edges call the recorder; they do not write `last_used_at` directly. The successor fence first locks the grant row, then writes the same vulnerable statement timestamp, so it is included.

## Change

`20260925000002_renewal_last_use_monotonic.sql` replaces those two functions. Each update uses `GREATEST(existing last_used_at, statement_timestamp())`. The record function keeps its signature, owner, grants, predicates, device fields, and `new_host_at` logic. The successor fence keeps its other behavior. The no-rewind trigger is untouched. A source comparison asserted that each replacement body differs from its September 4 body only at the timestamp assignment. The catalog proof in `deploy/release-proofs/renewal-last-use/catalog.sql` is read-only and returns `t` only when both exact function bodies, the recorder's owner/security/grants, and the enabled no-rewind trigger are present. Its `prosrc` digests were checked against the migration source.

## Test and mutation

`tests/p1-server/renewal-last-use.test.ts` uses separate PostgreSQL connections. B locks the grant row; A starts a use and the test waits until PostgreSQL reports its backend blocked on a lock. B then records use and commits. A must succeed, and the final timestamp must equal B's later timestamp. The same test starts the local served read edge under a temporary HOME and `SWARM_ENV=test`, repeats the lock ordering with an HTTP member read, and requires HTTP 200 and the same final timestamp. It has a 45-second test timeout, bounded lock and HTTP waits, and process-group cleanup.

Mutation is **reasoned, not executed** in this lane: restoring `last_used_at = statement_timestamp()` in `record_renewal_grant_use` makes A attempt to write its older statement start after B commits. `swarm.renewal_grants_spend_or_revoke_only()` then raises `SWARM_RENEWAL_LAST_USE_REWOUND`; the direct assertion fails and the served read returns 500. HezLead must run the test on the lead's local stack after applying the new migration there. This lane did not apply migrations or run server tests.

## Gates run in this lane

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

## Not established

The new migration has not been applied to any database, the server race and served-edge tests have not been run, and the box has not been contacted or released. The catalog proof has not been run against a live catalog. HezLead owns local-stack execution and review; only Anvil under HezLead may release a reviewed main SHA to the box. `pgrep` cannot inspect processes in this sandbox (`sysmond service not found`); the test's own child process group is explicitly terminated in `finally`.
