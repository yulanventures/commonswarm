# Item G lane 2b: box window plan (2026-09-27 21:45Z)

Written by CSwarmDevLead for HezLead and Anvil. Release request accepted by HezLead on 2026-09-26.

- **Release SHA:** `d4677b0d1c86a6c7247d030a54a1122d6bfd5777` (on main). Its box inputs are those of the lane 2b
  landing merge `92107eaf`. Actions server run 36221218080 at `92107eaf`: 271 of 273 tests passed. The two failures
  are the same ones main's baseline shows.
- **Window shape:** `KIND_LIST='edge stack'`. `CHANGED_FUNCTIONS='command read h0'`. No router change and no new env
  names.
- **What the release adds after tonight's releases:** `a54afaf6..d4677b0d` changes only
  `supabase/functions/command/index.ts`, `supabase/functions/read/index.ts` and `supabase/functions/h0/poll-ack.ts`,
  and adds one migration, `20260926000001_agent_wake_leases.sql`. Because `a54afaf6` descends from `9627cb37`,
  this window must follow tonight's two windows. Its migration version also follows theirs.
- **No credential goes to the box.** The lead runs the renew gate from the mini, and Anvil runs only read-only SQL.

The gate and its rules come from the CSwarm Strategist's ruling of 2026-09-26. That ruling replaces the earlier
condition "measure on staging first". Staging runs the box's own edge, so `renew_wake_lease` does not exist there
before this release.

## Order and handoffs

| # | Who | What |
|---|---|---|
| 0 | HezLead / Anvil | Preflight as in `RELEASE-TO-BOX.md` section 1, plus the same `search_path` check as item G: the section-5 role's `SHOW search_path` must not contain `swarm`. Stage the proofs from `deploy/release-proofs/item-g2b/` in `/proof`. The files are `20260926000001-catalog.sql`, `20260926000001-functional.sql`, `20260926000001-rollback.sql` and `20260926000001-rollback-catalog.sql`. |
| 1 | Anvil | Section 5: apply `20260926000001` with its catalog proof. The proof must return `t`. **Override of `RELEASE-TO-BOX.md` section 5:** do NOT run `20260926000001-functional.sql` in section 5. It needs the test seat's lease, which exists only after step 4, so section 5 would stop there. It runs in step 5 of this plan. |
| 2 | Anvil | Section 6: apply the edge (`command`, `read`, `h0` from the SHA). Then run the health check, the standard probes a-h, the metrics line and the log check. |
| 3 | HezLead -> lead | "edge switched and healthy" (native message). |
| 4 | lead | **Renew gate** (below). The lead sends HezLead the gate line (`GATE PASS`, `GATE FAIL <reason>` or `GATE CANNOT RUN <code>`), `G2B_PRINCIPAL_ID=<id>` and the time of the last renew. |
| 5 | HezLead -> Anvil | **Within 3 minutes of the gate's last renew:** `release_psql_ro -v item_g2b_principal_id=<id> --file /proof/20260926000001-functional.sql`. It must exit 0. The proof requires a lease renewed within the last 3 minutes, and the gate stops renewing when it ends. HezLead has this command ready before step 4. |
| 6 | lead | `g2b-renew-gate.sh … --release` frees the gate's lease. |
| 7 | HezLead | Close the window. After a 50-pair `GATE PASS` and a passing step 5 only: the lead publishes cswarm 0.1.78 built from the pinned client SHA `N` (below), the SAME SHA whose build the gate used, and Anvil releases the site. The site release must follow `RELEASE-TO-BOX.md`. |

## Tom's mint block (2026-09-27 between 20:00Z and 21:30Z)

Tom signs in first with `cswarm login` in a terminal on the mini. Then he pastes this block.

- The block prints only a final `OK`.
- stdout and stderr go into 0600 files in a 0700 directory.
- No secret goes into argv or into shell history.

The token lasts 6 hours. The gate refuses a token with less than 90 minutes left (exit 2), so the mint must not be
earlier than 20:00Z. If the block prints nothing, it failed, and the reason is in `mint.log`. Before a second run,
change the `-0927` suffix, because a principal name that already exists is refused.

```sh
(
  set -eu
  umask 077
  D="$HOME/.config/cswarm/g2b-seed-20260927"
  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  mkdir -p -m 0700 "$D"
  chmod 0700 "$D"
  lower() { tr 'A-Z' 'a-z'; }
  cswarm principal create --workspace-id "$WS" --name g2b-gate-0927 >"$D/principal.json" 2>>"$D/mint.log"
  PID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' "$D/principal.json")"
  cswarm token mint --workspace-id "$WS" --principal-id "$PID" \
    --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" --epoch 1 \
    --ttl-ms 21600000 --renewal-horizon-days 1 >"$D/credential.json" 2>>"$D/mint.log"
  chmod 0600 "$D"/*.json "$D/mint.log"
  echo OK
)
```

Before the window the lead adds `anon-key.txt` (mode 0600) to that directory. The lead fetches the public anon key
from the site's meta tag, never types it, and checks its sha256 against the key the CLI already uses.

After the window, Tom can revoke the seat with this command. The id is in `principal.json`.

```sh
cswarm principal revoke --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --principal-id <id>
```

## The renew gate (step 4)

The gate runs on the mini. The first argument is a clean checkout of the **pinned client SHA `N`**, outside the
repository's working tree, with `npm run build` done. `N` is the exact SHA that cswarm 0.1.78 will be built from.
The lead pins it in a message to HezLead before the window. `N` must contain the edge SHA `d4677b0d`, and the lead
confirms that `git merge-base --is-ancestor d4677b0d N` succeeds. The gate imports `N`'s own client modules, so it
measures the client that ships, with its real timeouts. If `N` must change after the gate, the gate runs again.

```sh
deploy/release-proofs/item-g2b/g2b-renew-gate.sh <release-checkout> "$HOME/.config/cswarm/g2b-seed-20260927" \
  https://api.commonswarm.com c2ea0541-f56d-4c73-bf71-56c5405c4934
```

What the gate does:

1. It claims one lease as host `g2b-renew-gate`.
2. It runs 50 ordered pairs of one `renew_wake_lease` call and one `check` call. It times every call and keeps every
   call, including the cold first ones after the edge switch.
3. It writes `renew-gate.json` and `renew-gate.md` (mode 0600) into the seed directory. They hold p50, p95 and max
   for renew and for check. The renew client timeout and the check budget are written beside them, with file:line.
4. It leaves the lease held and prints `G2B_PRINCIPAL_ID=<id>`.

The gate prints only ids, statuses, timings and exit codes. It never prints a token.

The numbers the gate uses:

- **Renew client timeout: 15,000 ms.** The watcher's `leaseRequest` (`src/cli.ts:4884-4890`) passes no timeout,
  so `sendWakeLeaseCommand` uses its default `options.timeoutMs ?? 15_000` (`src/cloud/wake-lease.ts:64`).
- **Check budget: 3,900 ms.** This is `AGENT_CHECK_TIMEOUT_MS` (`src/cloud/agent-check-budget.ts`). It is recorded,
  not gated. Renew runs in the `inbox --notify` watcher on a 60-second timer (`src/cli.ts:4937`), never inside the
  turn check.

**Immediately after the gate,** the lead copies `renew-gate.json` and `renew-gate.md` into the release evidence
directory. A later run of the gate would overwrite them.

| Exit | Line | Decision |
|---|---|---|
| 0 | `GATE PASS` | Exactly 50 pairs ran, every renew succeeded, and renew p95 < 15,000 ms. Go to step 5. Only this line authorizes npm and the site. |
| 7 | `GATE FAIL <reason>` | A renew failed, or renew p95 ≥ 15,000 ms. **Roll back the EDGE only.** The migration stays. Ship no npm and no site in this window. Run `--release` if the edge is still up. |
| 8 | `GATE CANNOT RUN <code>` | The claim was refused, or transport failed. Ship no npm and no site in this window. The edge stays only if the standard release checks (step 2) passed. |
| 10 | `GATE NOT A RELEASE GATE n=<k> …` | A shortened run (`G2B_RENEW_GATE_ROUNDS` < 50), for example the refresh rerun below. It never authorizes anything. |
| 2 | `input: …` | A local input problem, raised before any network call: a mode, the JSON, a missing build, or less than 90 minutes left. This is not an edge problem. Fix the input, or have Tom mint again with a new suffix, then rerun. |

**If step 5 cannot start within 3 minutes of the last renew,** the lease is too old for the proof. Wait until the
lease is more than 3 minutes old; a new claim may then take it over. Then run the gate once more with
`G2B_RENEW_GATE_ROUNDS=1`, and run step 5 at once. The rerun ends with `GATE NOT A RELEASE GATE` (exit 10); it only
refreshes the lease. Before that rerun, the 50-pair evidence must already be saved.

## Rollback

**Edge only.** This rollback is safe with the migration in place:

- The migration is additive. It adds a table, a member-scoped `swarm_read` view and SQL functions, and it replaces
  nothing.
- The old edge never reads the new objects.
- The current clients (0.1.77 and earlier) never call the lease commands, and the old site never reads the new view.
- No client that calls the lease commands ships before the gate passes.

Roll back to the edge that was live before this window: tonight's `a54afaf6` edge, or `9627cb37` if the renewal
window did not happen.

**SQL (reserve, only on HezLead's decision).** Roll back the EDGE first, because the new command and read edges use
these objects.

- Stage `20260926000001-rollback.sql` and `20260926000001-rollback-catalog.sql` in `/proof`.
- Run `assert-database-identity.sh` first, as for any write.
- Run `release_psql --file /proof/20260926000001-rollback.sql` (the write helper).

The rollback runs in one transaction. It drops the view, the five functions, the policy and the table, then
deletes the `schema_migrations` row. It commits only if its catalog proof returns `t`. Otherwise it rolls back and
exits nonzero.

## Rehearsal

This host runs no docker. The rehearsal is the server test `tests/p1-server/g2b-renew-gate.test.ts`, run in
GitHub Actions against the local stack. It seeds a seat and runs three pairs through the wrapper and the built
clients. Its 3-pair run asserts the shortened-run result, `GATE NOT A RELEASE GATE` with exit 10, and that every call was
kept. It checks that the lease is held after the run and
gone after `--release`. It checks that no token appears in the output. Runs: 36232492152 at `cdf23ee8` FAILED on ubuntu: the gate refused its own 0700 seed directory, because
`stat -f %Lp` on Linux reports file-system status. The mode check was fixed in `21274b5d` (GNU `stat -c %a` first).
Run 36232991157 at `21274b5d`: 273 of 275, and the renew-gate test passes; the two failures are main's baseline ones
(item L's Storage 409 pin; `h0-poll-ack` "an aborted waiting poll frees the slot for another seat"). The gate's unit
test passes 4/4 on the mini through the wrapper.

## Not established

- The box's section-5 role `search_path`. The preflight measures it.
- The gate against production. It runs in the window.
- A human-session `token mint` was not rehearsed. The rehearsal seeds the seat directly, as the server suite does.
