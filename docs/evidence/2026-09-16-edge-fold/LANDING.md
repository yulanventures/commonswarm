# Edge fold landing: fewer database round trips per edge transaction (2026-09-16)

Lane `lane/edge-fold`, tip **855b5216**, landed with `git merge --no-ff`. Ruling c05b6dda (path A): fold the round trips
server-side after `cswarm check` timed out through the Falkenstein box (CUTOVER-ROLLBACK.md in 2026-09-16-n-edge).

## What changed

- read, command, activity, capability: BEGIN carries the isolation level (`db.begin("isolation level read committed")`)
  instead of BEGIN then SET TRANSACTION; SET LOCAL ROLE / search_path / lock_timeout become one
  `SELECT set_config(..., true)` statement. The read edge folds its jwt-claims and search_path settings into one statement.
  The detached file purge drain folds its two SET LOCAL statements.
- Commits: 3b96c80b (Codex, cherry-pick of the N-db lane's 2df793c6: read and command); 2db77117 (lead: eight citations
  moved by two, a source-shape control); 49bdc77c (lead: activity, capability, drain, a control over every function);
  3527f952 (lead: acceptable-use citations, assert typing); 855b5216 (lead: grok's RIGOUR items).

## Review pair on 49bdc77c (arms/)

- antigravity: PASS. set_config('role') is the same GUC path as SET LOCAL ROLE (check_role membership test, RLS,
  SECURITY DEFINER, RESET ROLE); estimated check path 32 to 18 round trips.
- grok: PASS, with a measurement on postgres.js 3.4.9 and a throwaway postgres:17: with `prepare: false`, parameterized
  queries send Parse+Describe first, so `Promise.all` on the transaction did NOT pipeline the three roster reads. Behaviour
  identical (order, connection, rollback, 500 body). Ruled RIGOUR and fixed in 855b5216: the reads are back to main's
  sequential form, the control that pinned Promise.all as a latency cut is removed, the fold controls pin each function's
  role and also catch a tagged SET LOCAL ROLE (mutations: role 'postgres', tagged SET LOCAL ROLE, each fails). grok's
  statement counts: directory read 13 to 9, inbox read 11 to 7, including COMMIT.

## Gates at 855b5216

build 0; `npm test` 0 (878); `test:p1-cli` 0 (744); `check:tests` 0; `check:edge` 0; `git diff --check` 0; site build and
site tests 0 (547). Earlier runs had one 4 s hook-deadline test and one ACP held-close test fail under host load; each
passes alone.

## Measured on the box (edge-staging, release 3a5935f8 = main + 3527f952; same statements as 855b5216 except the three roster reads)

`cswarm check` 0.1.71, 20 runs, private profile copy, requests rewritten to edge-staging (window/check-bench.py):

| path | outcomes | network span p50 / p95 | read call min / p50 / p90 |
|---|---|---|---|
| box before (70d17d08) | 20/20 check_timeout | capped at 3.0 s | 1.97 / 2.31 / 2.55 s |
| box after (fold) | 16 ok, 4 check_timeout | 2.54 / 2.96 s | 1.47 / 2.29 / 2.76 s |
| Supabase today | 20/20 ok | 0.85 / 1.10 s | 0.54 / 0.77 / 0.99 s |

The fold removes about 0.5 s from a warm call. Most calls in a turn-paced check are cold: the read edge closes idle
connections after 3 s (`idle_timeout: 3`, sized for the pooler), so each call also pays TCP, TLS and authentication to
the us-east-1 pooler. The fold alone does not give 2x headroom on the 3 s budget; path C (a NYC droplet) or the N-db
window carries the edge cutover.

## Not established

- The local server suite (tests/p1-server) did not run on this lane: another lane held the local Supabase stack. It must
  run green before any deploy of these functions to Supabase production or a production cutover through the box.
- Command, activity and capability latency through the box (the table tool measures the read paths first).
