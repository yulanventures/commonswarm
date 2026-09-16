I'll start with the commit message in full, then attack the claimed tests, gates, and live mutations. No other agents, no production, no swarm.Commit is on HEAD. Next I’ll read the implementation, tests, and citations, then mutate each claimed property.The tests and reducer shape are in. Next I’ll read the adapter, migration, and server tests so the mutations hit real enforcement.Citations and the adapter gate are next. I’ll also check how join credentials are classified at the HTTP boundary.Environment is in place. I’ll mutate each claimed property, then run the gates with nothing else in this worktree.Tree is clean and local Supabase is on loopback. Starting claimed-property mutations on the CLI controls first.CLI controls miss FOR SHARE and the trigger body — those need the server suite. Running the non-server gates on the clean tree next.Non-server gates are green. Next I’ll mutate the adapter and live registration paths against the server tests.I’ll live-probe READ, renewal, and same-`command_id` replay on the clean tree, then run the full server suite alone.Checked the commit, mutated the claimed gates, ran the real gates, and probed READ / renew / `command_id` live on loopback. Tree is clean. Nothing hit production.

## PRODUCTION

**1. An H0 seat can renew on the command edge. The lane says it cannot.**

The commit and `src/protocol/workspace-commands.ts:28-31` say there is no renew path and nothing renews an H0 seat. Registration still inserts a live timeboxed grant (`supabase/functions/command/index.ts:6256-6271`) with 800 successors and a 30-day horizon.

Live, on this SHA, with a fresh registered `swm_agt_` token:

- `POST /functions/v1/command` `{ kind: "renew_agent_token" }` → **200 `accepted`**, new `agent_token`, new `token_id`
- `swarm.renewal_grants.successors_used` went **0 → 1**

Successor TTL is `AGENT_TOKEN_DEFAULT_TTL_MS` = **1 hour** (`workspace-commands.ts:1481-1486`). A client that renews (the CLI listener does this) swaps a 30-day seat for a 1-hour token. The H0 document still says the seat lasts 30 days and then the agent must ask for a new invite.

No test covers this. `fenceRenewal` does not look at `agent_join_attempts`. “Renewal is ruled out” is a sentence, not a fence.

## RIGOUR

**2. Same `command_id`, different body — implemented, not tested.**

`registerAgentSeat` returns 409 `command_id_conflict` at `command/index.ts:6036-6053`. I deleted that block. Registration server tests stayed **14/14 green**. Live on the clean tree, the same `command_id` with a different `attempt_id` is 409. The check works. No test holds it.

**3. Same `command_id` + same body is not a replay.**

If the first token is still unused, the second identical POST remints: 200, new `agent_token`, new `token_id`. The ledger row is not returned. Spec §5 recovery runs even when the idempotency key matches. A retried POST can kill the token from the first response.

After the token is used, the same POST is 409 `registration_token_already_used`, not a stored success. Untested.

**4. Weak structural controls (stay green).**

| Mutation | Applied | Result |
|---|---|---|
| Drop `FOR SHARE` on the membership `SELECT` (`:5592`) | yes | CLI structural test still passes — `indexOf("FOR SHARE")` hits the **comment** at `:5944` |
| Comment out `CREATE TRIGGER agent_join_attempts_guard` | yes | CLI still matches the substring in the comment |
| Remove `RAISE EXCEPTION` from the SQL file | yes | CLI green (does not read the raise); live DB still has the old function until reset |
| Skip only the outer `first_used_at !== null` used-token check (`:6075`) | yes | Server **14/14 green** — `replaceUnusedRegistrationToken` still refuses when `UPDATE … first_used_at IS NULL` returns 0 rows |
| `live >= FREE_TIER_PRINCIPAL_LIMIT` → `>` | yes | CLI green; server test fails (200 instead of 403) |

**5. Commit claims a poll-lane fence this tree does not have.**

“A principal is an H0 SEAT iff an attempt row names it; the poll lane's listener fence reads exactly this.” `agent_join_attempts` is written here. Nothing in `claimAgentInbox` / poll reads it. That fence is a later lane.

**6. One remapped citation is still wrong.**

`site/src/pages/acceptable-use.astro` now cites `index.ts:1982-1992` for `about <= 500` and `until <= 30d`. `about.length <= 500` is at **1973-1976**. `until_ms <= SIGNAL_MAX_UNTIL_MS` is at **1980-1984**. The range starts inside the until check and never sees `about`.

## Mutations (claimed properties)

Each change was applied, shown, then restored with `git checkout`.

| Claim | Mutation | Test |
|---|---|---|
| Exact-kind, join on other reducer commands | `false && cmd.kind !== 'register_agent_seat'` `:651` | FAIL `a join credential is refused for every non-registration reducer kind` |
| Exact-kind, human/agent cannot register (reducer) | `cmd.kind === 'register_agent_seat' && false` `:652` | FAIL `the reducer admits only a join credential` |
| Exact-kind, join on other HTTP commands | removed `swm_join_` 403 `:11137` | FAIL `a join credential cannot perform any other command class` (401 not 403) |
| Owner not a member (reducer) | `if (false)` `:692` | FAIL `the reducer refuses registration when the credential owner is not a live member` |
| Owner not a member (adapter) | skipped `lockJoinCredentialOwnerMembership` `:5947` | FAIL, **500** `internal_error` not 403 (reducer then throws) |
| Uniform 403 revoked/expired | dropped `revoked_at` / `unexpired` checks `:5929` | FAIL `revoked and expired credentials…` (500 from the later spend `UPDATE`) |
| Seat cap `>=` → `>` | `:6104` | FAIL structural `registration uses the one principal-ceiling helper…` |
| Principal ceiling `>=` → `>` | `:6124` | CLI green; server FAIL `registration refuses at the shared principal ceiling` (200) |
| Bypass `lockAndCountLivePrincipals` | `:6123` | FAIL helper-count + fold-order tests |
| G3 audit actor | `joinAuth` registrar → null `:5604` | FAIL `accepted and domain-refused audit and events use the registrar actor` |
| G3 event actor | `registrationEvent` registrar → null `:5703` | FAIL same test |
| G3 reducer events | stripped `ctx.actor` `:738` | FAIL reducer join-kind test |
| Unused-token recovery bypass | skip `replaceUnusedRegistrationToken` `:6091` | FAIL `registration retry recovers only an unused token…` |
| Skip old-token `UPDATE revoked_at` | `:5790` | FAIL retry test (500; trigger requires the old row revoked) |
| Store `agent_token` in the ledger | `:6337` | FAIL `a raw seat secret reached stored state` |
| Skip attempt `INSERT` | `:6308` | FAIL CLI fold-order + server marker/retry tests |
| `H0_SEAT_TOKEN_TTL_MS` = 24h | `:31` | FAIL TTL + document tests |
| Type `30` into the sentence | `verbs.ts:233` | FAIL `the document derives its whole-day seat lifetime…` |
| Pass a literal from `h0/index.ts` | `:23` | FAIL `the H0 edge passes the imported H0 seat lifetime…` |
| Drop `FOR UPDATE OF c` | `:5578` | FAIL structural lock test |

Human/agent register at HTTP still 403 after a kind-gate weaken, because the JWT hash is not a join hash. The reducer test is the control that actually sees kind.

## Gap shown by mutation

Needed, untested: **same `command_id`, different body**. Delete `:6036-6053`. Server registration tests stay green. Live, the check still 409. Also untested: READ with the registered token (live **200** on `members`, principal present) and command-edge renew (live **200**, see PRODUCTION).

Lock order (reason only; this runtime does not interleave): register takes credential `FOR UPDATE`, then stream, then membership `FOR SHARE`. Revoke is dispatched **before** the workspace stream lock (`:9194` vs `:10330`) and updates the credential row. That pair does not deadlock. Register vs `remove_member` (stream then membership) also does not wait on the credential row.

## Citations (5, including the two named files)

| Cite | Code | Verdict |
|---|---|---|
| `agent-connect.ts` device bind `index.ts:3218-3228` | `device.revoked_at !== null` at 3227 | match |
| `agent-connect.ts` horizon `index.ts:10709-10714` | `horizon_expires_at: prepared.command.renewal_horizon_ms === null` | match |
| `agent-connect.ts` scope `index.ts:9147-9153` | `scopes.includes` at 9152 | match |
| `acceptable-use.astro` `:765` / `:642-643` / `:632` | `FREE_TIER_WORKSPACE_LIMIT=10`, signal 120/1000, `AGENT_TOKEN_MAX_TTL_MS` 30d | match |
| `acceptable-use.astro` `:1982-1992` about+until | about is **1973-1976**; until is **1980-1984** | miss |

## Commit vs tree

The tree does **not** do: “nothing renews an H0 seat”; “the poll lane's listener fence reads exactly this.”

Honest, and true: h0 does not forward `POST /register`; locks are structural, not concurrent; nothing is deployed.

## Gates (real exit codes, no pipe)

| Gate | Exit | Count |
|---|---|---|
| `npm run build` | 0 | |
| `npm run build:command-core` then `git status --porcelain` | 0, empty | bundle unchanged |
| `env -u FORCE_COLOR npm test` | 0 | 875 pass |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 732 pass |
| `npm run check:tests` | 0 | |
| `npm run check:edge` | 0 | includes `h0/index.ts` |
| `git diff --check 1cc1a663...8f76c8a8` | 0 | |
| `env -u FORCE_COLOR npm run test:p1-server` (alone) | 0 | 215 pass |

No `host-stderr-exit-parity` flake. No dropped-connection flake. I did not reset the local DB. I did not establish production, concurrency, or h0 `POST /register`.

VERDICT: FAIL H0 seats renew on the command edge (live 200, 1-hour successor); the lane claims they cannot.
