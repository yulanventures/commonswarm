I'll start by reading the commit in full, then attack the tests, gates, and live mutations on this worktree.Commit is on this worktree. Next I’ll read the authority code and tests, then run the gates.Worktree is at the right SHA. Next I’ll read the authority code, tests, and the round-1 findings.I’ll read the registration path and tests next, then start the independent gates.I’ll read the remaining tests, routing, and site citations, then start the non-server gates.I’ll keep reading the registration path and tests, and start the non-server gates in parallel.I’ll verify the cited lines and start the non-server gates while I keep reading the remaining authority code.Citations look consistent so far. I’ll start the non-server gates and keep reading the transaction path.Local Supabase is up. I’ll run the non-server gates first, then mutate.Gates are running. I’ll inspect agent auth and the READ path while they finish.Gates are green. Next I’ll mutate each claimed property, restore it, then run the server suite.I’ll add temporary live probes for READ and expired-retry, then mutate the expiry checks to show the gap.SHA `08fbb0cd` on `fca81374`. Tree is clean. No leftover serve process from this arm.

## Gates (real exit codes)

| Gate | Exit |
|---|---|
| `npm run build` | 0 |
| `npm run build:command-core` then `git status --porcelain` | 0, empty (bundle did not change) |
| `env -u FORCE_COLOR npm test` | 0 |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (733 pass) |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 |
| `git diff --check fca81374...08fbb0cd` | 0 |
| `env -u FORCE_COLOR npm run test:p1-server` | 0 (220/220). T-10 concurrent-acquire passed in 20.4s. No flake. |

Ran the server suite with nothing else in this worktree.

## Round-3 fixes (attacked)

Revoked unused retry is live. I dropped the outer liveness `if` at `supabase/functions/command/index.ts:6142`. The test `revoked token` failed. Restore byte for byte.

Same-body remint and `command_id` conflict are live. I forced the conflict predicate to `false`. `same registration POST…` failed.

Grant horizon is the seat expiry. Structural test `H0 registration and renewal share one horizon and one stream frame` failed when I pointed the grant insert at `RENEWAL_HORIZON_DEFAULT_MS` and when I dropped `Math.min` on replacement expiry.

Comment strip works. `-- CREATE TRIGGER agent_join_attempts_guard` still failed `the attempt relation is private…`.

One stream frame: a second `lockRegistrationStream` failed the order test.

## Mutations

Caught (then restored):

- Exact-kind both ways (reducer `workspace-commands.ts:651-652`)
- `FOR UPDATE OF c` (`command/index.ts:5584`)
- Membership `FOR SHARE` (`command/index.ts:5598`)
- Seat cap `>=` → `>` (structural + live parent `register_agent_seat authentication…`)
- Bypass `lockAndCountLivePrincipals` at registration
- Principal ceiling `>=` → `>` (live: `registration refuses at the shared principal ceiling…`)
- Adapter join-on-other-command (`command/index.ts:11215`)
- Revoked/expired credential checks removed (`command/index.ts:5960-5962`)
- Adapter membership skip → live 403 test failed (reducer then 500)
- Reducer membership skip (`workspace-commands.ts:692`)
- G3 event/audit registrar cleared
- Unused recovery bypass, old-token revoke ignored, secret written into stored response
- Attempt insert renamed away
- Seat TTL `H0_SEAT_TOKEN_TTL_MS = AGENT_TOKEN_MAX_TTL_MS - 1`
- Document sentence typed `30`; `h0/index.ts` passed a literal
- Acceptable-use line `:765` → `:764`

Stayed green on committed tests (then restored):

- Inner `EXISTS` liveness in `replaceUnusedRegistrationToken` (`command/index.ts:5804-5822`). Outer check still classifies. Race fence only.
- Outer `first_used_at` skip. Inner `first_used_at IS NULL` still returns `registration_token_already_used`.
- Token-expiry liveness (see gap).

## Gap (RIGOUR)

Committed tests never expire the current unused token. They only revoke the token or the principal.

I removed `existing.token_expires_at.getTime() <= frame.now` and the inner `expires_at > now`. Then:

- A temp probe that backdated `swarm.agent_tokens.expires_at` got **200** and a new `swm_agt_` secret.
- `a revoked unused seat cannot be revived…` stayed **green**.

On the unmodified tree the same expiry probe returned `409 registration_seat_revoked`. READ with the registered token also worked and stamped `first_used_at`, which then blocked retry. `roster()` in the suite still uses the fixture agent, not the registered seat.

Natural 30-day end still has `grant_horizon_expires_at` (`command/index.ts:6148` and `5821`). That branch has no committed test either. Grant horizon cannot be moved (trigger `SWARM_RENEWAL_GRANT_IMMUTABLE`). I did not establish a natural dual-expiry retry.

`run_ended_at` and `grant_revoked_at` are in the same `if` and are also untested.

## Citations (five spot-checks)

Updated pointers match:

- `site/src/pages/acceptable-use.astro`: `:765` is `FREE_TIER_WORKSPACE_LIMIT = 10`; `:642`/`:643` are the signal caps; `:5095` is `date_trunc('hour', …)`; `:1973-1976` is `about.length <= 500`.
- `site/src/lib/agent-connect.ts`: `index.ts:3218-3228` is the device bind; `index.ts:9225-9231` is the scope check; `index.ts:10787-10792` is `horizon_expires_at`.

Still wrong in the same `agent-connect.ts` file (not in `citation-drift.test.ts`):

- `HUMAN_ONLY_COMMANDS (…workspace-commands.ts:106-116)` — that range is `set_agent_model`. The set is at `407-423`.
- `src/cli.ts:1145` / `:1173` — credential-file/stdin, not `principal create` / `token mint`.
- `src/cloud/auth.ts:342` — login timeout cleanup. `registerLoginDevice` starts at `357`; label `cswarm-cli` is at `374`.

## Commit message vs tree

The tree does the claimed fold, exact-kind gates, uniform 403, seat cap, shared ceiling helper, G3 on accept and domain refuse, unused remint, used refusal, new-attempt spend, secret-not-stored, attempt marker + trigger, 30-day TTL, generated document sentence, grant horizon = seat expiry.

It does **not** claim production deploy, HTTP `/register`, or a concurrency proof. Those match.

It claims retry needs a live token, principal, run, **and** grant. Code has all four. Tests only hit token revoke and principal revoke.

## Findings

**PRODUCTION:** none.

**RIGOUR:**

1. Token-expiry (and grant-horizon, run, grant-revoke) retry liveness is untested. Dropping the token-expiry clauses remints an expired unused token; revoke tests stay green.
2. Registered token on READ works; no committed test covers it.
3. Drifted line citations remain in `site/src/lib/agent-connect.ts` for CLI/auth/`HUMAN_ONLY_COMMANDS`.

VERDICT: PASS Round-1 revival and false “nothing renews” claims are gone and gated; leftover holes are untested live branches, not missing checks.
