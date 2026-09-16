# Edge database statement measurement — RUN 2026-09-16

This measurement used the already-running local Supabase PostgreSQL database. It did not contact production. The before server loaded the parent commit's `read` and `command` function sources from a temporary directory. The after server loaded commit `0c66836f`. Each server used the same generated fixture and the same credentials.

## Method

The harness enabled the installed `pg_stat_statements` extension and used its execution counters. For each request it:

1. ran one temporary function server at a time and warmed it before measurement;
2. called `pg_stat_statements_reset()`;
3. made exactly one HTTP request to the function;
4. read `calls` for the `postgres` and `swarm_read` roles in the local `postgres` database;
5. excluded only the reset and measurement queries; and
6. summed the remaining calls, including `BEGIN` and `COMMIT`.

Each before and after request ran three times. Every repeat produced the same count. The harness also compared the complete before and after HTTP response bodies and required exact equality.

## Counts

| Request | Before | After | Reduction |
|---|---:|---:|---:|
| `members` | 13 | 9 | 4 |
| `feed --limit 5` | 11 | 7 | 4 |
| `receipt` | 9 | 6 | 3 |

The captured statement groups sum as follows:

| Request | Before groups | After groups |
|---|---|---|
| `members` | transaction 3 + setup 5 + credential 2 + result 3 = 13 | transaction 2 + setup 2 + credential 2 + result 3 = 9 |
| `feed --limit 5` | transaction 3 + setup 5 + credential 2 + result 1 = 11 | transaction 2 + setup 2 + credential 2 + result 1 = 7 |
| `receipt` | transaction 3 + setup 3 + credential 2 + result 1 = 9 | transaction 2 + setup 1 + credential 2 + result 1 = 6 |

The before path issued separate `BEGIN`, `SET TRANSACTION`, `SET LOCAL ROLE`, `SET LOCAL search_path`, and `SET LOCAL lock_timeout` statements. The after path puts the isolation mode on `BEGIN`, sets role, search path, and lock timeout with one `set_config` statement, and sets request claims plus the read search path with one statement. The independent member, agent, and workspace reads run concurrently. The transaction start and commit boundaries, roles, search paths, lock timeout, request claims, and response bodies are unchanged.
