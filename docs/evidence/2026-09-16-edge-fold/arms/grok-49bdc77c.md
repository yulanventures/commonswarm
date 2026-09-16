I'll review the exact SHA against main, then check postgres.js 3.4.9 and the four edge functions for real semantic and pipelining risks.HEAD matches the SHA. Next I’ll read the full diff and the postgres.js 3.4.9 transaction path.The truncated diff isn’t enough. I’ll read the four edge functions, the tests, and postgres.js 3.4.9 next.Docker is available. I’ll spin up Postgres 17.6 on loopback and run the allowed gates in parallel.`set_config` matches `SET LOCAL ROLE` so far. I’ll catch the non-member error outside `begin` and inspect the npm test failure.Reviewed `49bdc77ca863ea8f577b38e3b7f2a27cd5e9d3c9` vs `2097e837`. Measured postgres.js **3.4.9** and a throwaway **PostgreSQL 17.6** on `127.0.0.1:55432` (removed after). Did not touch `api.commonswarm.com`, staging, or `*.supabase.co`. Did not use the local Supabase ports.

Setup fold is equivalent. `BEGIN` really sends `begin isolation level read committed`. A throw still rolls back. `Promise.all` on the three directory reads stays on one connection and keeps result order, but with `prepare: false` it does **not** pipeline those parameterized queries.

---

### 1. Semantics

**PRODUCTION — no break.** `SELECT set_config('role', X, true)` is the same GUC path as `SET LOCAL ROLE X`.

On PG 17.6 as an `INHERIT` login member (same shape as `commonswarm_edge`):

| check | `SET LOCAL ROLE` | `set_config(..., true)` |
|---|---|---|
| `current_user` | `app_read` | `app_read` |
| `session_user` | login role | login role |
| `current_setting('role')` | `app_read` | `app_read` |
| RLS (`FORCE`, policy on `current_user`) | 1 row | 1 row |
| `SECURITY DEFINER` body `current_user` | owner (`postgres`) | owner |
| `RESET ROLE` | back to login, GUC `none` | same |
| non-member | `42501`, `guc.c` `call_string_check_hook` | same code, same message |
| missing role | `role "…" does not exist` | same |
| later statement in the tx | settings still on | settings still on |
| after `COMMIT` | back to login, `lock_timeout=0` | same |

`set_config('lock_timeout', '5s', true)` equals `SET LOCAL lock_timeout = '5s'` (`SHOW` both `5s` / `00:00:05`).

postgres.js 3.4.9 `db.begin("isolation level read committed", fn)` sends exactly `begin isolation level read committed` (`node_modules/postgres/src/index.js:242`, sanitizer keeps `[a-z ]`). Isolation inside the callback was `read committed`. An `INSERT` then `throw` issued `rollback`; the row was gone.

Activity still does `RESET ROLE` then `SET LOCAL search_path` then `realtime.send` (`activity/index.ts:162-170`). Measured: `RESET ROLE` after `set_config('role', …, true)` restores the login role, so `realtime.send` still runs as the connection role. Client still gets `202` on success, `500` if that statement fails.

No savepoint, `sql.savepoint`, nested `begin`, or `reserve()` on these request paths. A postgres.js savepoint rollback did restore the local role; unused here.

**6543 transaction mode:** `is_local=true` dies with the transaction. The reserved connection holds one backend until `COMMIT`. Activity’s `RESET ROLE` is session `SET ROLE NONE`, which is the default GUC, so a pooled backend is not left as `swarm_command`.

Case fold is the only mismatch (`SET LOCAL ROLE APP_READ` works; `set_config('role', 'APP_READ', true)` does not). This lane uses lowercase `'swarm_read'` / `'swarm_command'` / `'swarm_capability'`, same as the old unquoted `SET LOCAL ROLE` names.

---

### 2. Pipelining

**PRODUCTION — latency claim is false; behaviour is not.**

`read/index.ts:656-693` does `Promise.all` of three **parameterized** tagged queries on `tx`, with `prepare: false` (`read/index.ts:49-55`).

postgres.js 3.4.9 (`connection.js:173-174`, `236-238`): a query with parameters sets `describeFirst`, so `execute()` writes `Parse+Describe+Flush` and returns false. Later queries wait on `ReadyForQuery`.

Measured on 3.4.9, `prepare: false`, inside `sql.begin`:

- Parameterized `Promise.all` (the real shape): **6 writes**, describe then bind, three times. Not pipelined.
- Unparameterized `Promise.all`: **1 write** with three `Parse/Bind/Execute/Sync` groups. That is real pipelining, and it is not this code.
- Same backend pid for all three.
- Result order stayed `[members, agents, workspace]`.
- One of the three failing (`22P02`) rolled the transaction back. Same SQLSTATE as sequential `await`. `committed === false`.

If agents/workspace fail, `handle` still throws into `readFailureResponse` (`read/index.ts:366-373`, `910-918`). Client still sees **HTTP 500** with the generic read body. Success still returns the same `{ members, agents, identity }` object. `workspaceRows[0]?.name ?? null` is unchanged.

So: same connection, same transaction, same order, same status/body. **Not** “sent without waiting.” Comment at `read/index.ts:654-655` is wrong for this client config.

---

### 3. Coverage (check path, from the code)

`cswarm check` (`src/cloud/agent-check.ts:139-148`, 3 s whole operation): local credential open (no read SQL unless renewal is due), then **two HTTP reads in parallel** — `resource: "members"` and inbox `resource: "signals"`. Wall clock is `max(directory, inbox)`.

Count includes implicit `COMMIT`.

| request | before | after | what folded |
|---|---|---|---|
| directory (`members`) | **13** | **9** | 4 setup SETs + isolation-on-BEGIN; jwt claims + search_path now one `SELECT`; 3 roster reads still 3 statements |
| inbox (`signals`, no channel) | **11** | **7** | same setup/jwt fold; one signals `SELECT` |

Directory after, in order (`read/index.ts:427-693`):

1. `BEGIN isolation level read committed`
2. `set_config` role+search_path+lock_timeout
3. `swarm.agent_delivery_read_context`
4. `swarm.record_renewal_grant_use`
5. `set_config` jwt claims + search_path
6–8. members / agents / workspace
9. `COMMIT`

Inbox after: 1–5 the same, then the signals `SELECT`, then `COMMIT`.

Still sequential on that path, and still avoidable if you want more of the 3 s back:

- 6–8 still three round trips on the wire (Promise.all does not pipeline them).
- 4 then 5 have no data dependency; they are still `await`ed in order.
- postgres.js `begin` always waits for `BEGIN` before the callback (`index.js:242-245`), so setup is still two statements.

Other request transactions: command `handleTransaction` and `resolveLedgerRace` (`command/index.ts:8889`, `11021`) and capability/activity begins carry isolation and one `set_config`. File-purge drain (`command/index.ts:11295-11301`) still uses bare `db.begin` (default isolation, no `lock_timeout`); not on `check`. Activity still pays `RESET ROLE` + `SET LOCAL search_path` + `realtime.send` after auth.

---

### 4. Tests and citations

Lane tests pass (`tests/read-edge-diagnostics.test.ts`, citation-drift, workspace-name). `npm run check:edge` passed. Full `npm test` had two unrelated host-acp “held close” timing fails (Claude 1435 ms, OpenCode 2007 ms), not this diff.

Mutations fail on the assertion they name (ran them):

| mutation | actual throw |
|---|---|
| read BEGIN options removed | isolation-`begin` count `1` → `0` |
| read role setting removed | `setReadTransaction` / `swarm_read` regex |
| member reads serialized | `Promise.all` regex |
| command BEGIN options removed | isolation-`begin` count `2` → `1` |
| command search path removed | command `setTransaction` regex |
| activity/capability `SET LOCAL ROLE` unsafe | `assertNoUnfoldedSetup` unsafe-SET message |
| `FROM swarm.workspaces` | workspace-name `FROM swarm_read.workspaces` (and the negative `swarm.workspaces` check) |

**RIGOUR.** `Promise.all` is pinned as the latency control, but with `prepare: false` it is not pipelining. The green test defends the call shape, not the round-trip cut.

**RIGOUR.** Activity/capability tests do not pin the role string. `set_config('role', 'postgres', true)` still passes. A tagged `tx\`SET LOCAL ROLE …\`` (not `.unsafe`) also passes; the documented mutation only injects `.unsafe`.

Citations: the eight moved `command/index.ts` windows contain the claimed tokens (`3220-3230` device revoke, `9227-9233` scope check, `2690-2693` replay horizon, `2447-2449` / `2454` / `2508` / `4610` / `3661`). Observer comment now says `3407-3410`; citation-drift still lists `3405-3408`, which still contains `renewal_kind: wire.renewal_kind ?? "timeboxed"` at line 3407.

---

**PRODUCTION.** Directory `Promise.all` does not remove Falkenstein/us-east-1 waits for those three reads. Client still sees the same JSON; `check` still pays them in series. Setup fold (13→9 / 11→7 statements) is the real cut.

**RIGOUR.** Comment at `read/index.ts:654-655` claims pipelining that 3.4.9 does not do for these queries.

VERDICT: PASS — set_config/BEGIN isolation match the old SET LOCAL/SET TRANSACTION semantics (same GUC hook, RLS, DEFINER, RESET ROLE, rollback); Promise.all keeps order, connection, and 500-on-error but does not pipeline the parameterized directory reads.
