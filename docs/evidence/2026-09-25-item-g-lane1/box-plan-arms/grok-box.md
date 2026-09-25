I'll review commit `e55deb3d` read-only: the rollback SQL, the edge-only claim, `g-seed.sh`, Tom's mint block, and the runbook tables against the code and the local migration.The runbook and rollback SQL are in place. Next I’ll compare them to the migration, the release helper, and the CLI flags they depend on.The shell and catalog checks are next: psql's `\if` on a `\gset` boolean, the rollback against the local migration inside a transaction I'll roll back, and whether Tom's block actually runs.The window plan is safe to run. The reserve rollback is the inverse of migration `20260925000001` (check9 stays widened only while unclaimed observed rows exist), the old edge and old clients still fit that schema, and the seed stop gates fail closed. Four rigour notes are below. Nothing here was committed. The local transaction that exercised the rollback was rolled back; `swarm.wake_path_release`, the renamed receipt function, and ledger row `20260925000001` were present again afterward.

## 1. Rollback SQL

The migration renames `swarm_read.signal_delivery_receipts` to `signal_delivery_receipts_without_wake_path`, revokes that function, and creates a new wrapper (`supabase/migrations/20260925000001_unclaimed_observed_ack.sql:137-169`). It also adds the widened check9 (`:25-33`), the partial index (`:59-61`), `swarm.wake_path_release` (`:65-70`), and three views (`:75-133`). The ledger row is inserted by section 5, not by the migration file (`deploy/RELEASE-TO-BOX.md:936`).

`deploy/release-proofs/item-g/20260925000001-rollback.sql:14-26` drops the wrapper, renames the previous function back, restores owner `swarm_admin`, revokes `PUBLIC`, and grants `EXECUTE` to `authenticated` and `swarm_read`. On the local catalog, after those statements and still inside a transaction that was later rolled back, that function's ACL was `{swarm_admin=X/swarm_admin,authenticated=X/swarm_admin,swarm_read=X/swarm_admin}`, `prosecdef` was true, `anon` had no `EXECUTE`, the body still called `signal_delivery_receipts_without_main_queue_count`, the body did not contain `wake_path`, and the pre-G comment was still on that same function. `without_main_queue_count` stayed. Views, the release table, and the index dropped with no dependency error.

Keeping check9 widened is required when unclaimed observed rows exist, and it is safe. The pre-G predicate (`supabase/migrations/20260731000001_signal_deliveries.sql:69-74`, repeated at `20260925000001-rollback.sql:37-42`) rejects those rows. With 5 such rows present, `ADD CONSTRAINT` of the pre-G text failed with `check constraint "signal_deliveries_check9" ... is violated by some row`, and the script's notice was `check9 KEPT widened: 5 unclaimed observed ACK rows exist`. The widened predicate measured on the live constraint is the pre-G branches plus `(ack_outcome = 'observed'::text) AND (last_error_code IS NULL)`. Every row the pre-G check accepts still passes. The script does not rewrite ACK rows (`20260925000001-rollback.sql:44-46`).

On this PostgreSQL 17.6 client (the box image is 17.6), `\gset` stores a boolean as `t` or `f`, and `\if :rollback_ok` takes the true branch only for `t`. The false branch rolls back and raises; that path exited 3. `release_psql` sets `ON_ERROR_STOP` and mounts the proof directory at `/proof` (`deploy/RELEASE-TO-BOX.md:565-569`). The section-5 role in `deploy/supabase-stack/env.example` is `supabase_admin`, a superuser here, so it can `DROP` objects owned by `swarm_admin`. `lock_timeout` is 5s (`20260925000001-rollback.sql:11`); a lock failure aborts the session and the open transaction rolls back with it.

The catalog proof returned `f` before any rollback. After the full statement list with those 5 rows still present, it returned `t`. After the rows were neutralized inside the same transaction and check9 was restored, it returned `t`, and `pg_get_constraintdef` matched the proof's pre-G literal (`20260925000001-rollback-catalog.sql:23`). Leaving the index in place returned `f`. Leaving the ledger row in place returned `f`.

**RIGOUR.** `20260925000001-rollback-catalog.sql:24-27` accepts a widened check9 by a substring, `(ack_outcome = 'observed'::text) AND (last_error_code IS NULL)`, once any unclaimed observed row exists. The script itself either restores the exact pre-G text or leaves the migration's check9, both of which this proof accepts. A different constraint that merely contains that substring would also return `t`.

## 2. Old edge, old clients, old site

With the migration applied, `4ef0f300` plus clients at or before 0.1.77 and the site at `4ef0f300` still fit.

The old code touches two changed surfaces:

- It writes `swarm.signal_deliveries`. check9 only gains one OR branch (`20260925000001_unclaimed_observed_ack.sql:30`). The lease-ack path at `4ef0f300` still writes a lease pair, `expired`, or `failed_terminal` with `delivery_attempts_exhausted`. An already-acked unclaimed observed row has `last_lease_id` null, so the old identity check returns unavailable and does not update it (`supabase/functions/command/durable-delivery.ts:826-832` in the current file; that lease path is the old one). H0 still selects `acked_at IS NULL` (`supabase/functions/h0/poll-ack.ts:404-407`). `git diff 4ef0f300 7c0bee1e` does not change `h0`.
- It calls `swarm_read.signal_delivery_receipts`. The wrapper keeps that signature and adds `wake_path_observing` only on directed agent receipt objects (`20260925000001_unclaimed_observed_ack.sql:152-163`). The old read edge returns `receipts` as the function gave them (`supabase/functions/read/index.ts:599-604`; the `4ef0f300` diff does not change that). `src/cloud/delivery-receipts.ts` at `4d4cb3f7` is the same file as at `4ef0f300` and copies named fields only. The site parser does the same (`site/src/lib/commonswarm.ts:2512-2568`); that file is unchanged since `4ef0f300`. The old dashboard does not query `swarm_read.agent_wake_path`; that call is added after `4ef0f300`.

The old edge's `exactKeys` list has no `unclaimed` key (`git diff 4ef0f300 7c0bee1e -- supabase/functions/command/index.ts`). A check ACK that sends `unclaimed` is `invalid_request` before any write. Authentication still runs before `validateCommand` (`supabase/functions/command/index.ts:8915-8928`, then `:9068`), so an unknown bearer is 401 for both `unclaimed: true` and `unclaimed: false`.

`git diff f7fa1227 7c0bee1e -- src supabase` is empty, so the rehearsal's "same src and supabase as the release SHA" claim matches this tree.

## 3. `g-seed.sh`

The stop gates fail closed. Step 1 exits 4 unless the server receipt for that note has `outcome == "observed"` and `acked_at` (`g-seed.sh:64-71`). `receipt --json` puts the server column on `outcome` (`src/cloud/receipts.ts:288-290`). `cswarm check` awaits the ACK before it returns, and a refused ACK does not change the check's exit status (`src/cloud/agent-check.ts:349-351`), so a refused ACK stays off the receipt. Step 3 exits 5 unless the status is `200` and note 2 is in `signals[].id` (`g-seed.sh:89-94`). The agent token is passed by file (`--agent-token-file`, `--profile`) and by a curl header file (`g-seed.sh:43`, `:83-87`), not as an argument. `--anon-key` is the public anon key (`g-seed.sh:43`).

No path prints `PASS` when the receipt is not observed or the read did not return note 2.

**RIGOUR.** `g-seed.sh:79-88` writes `Authorization: Bearer` into `$DIR/read-headers.txt` and deletes it only after curl returns. With `set -euo pipefail`, a curl that cannot connect exits before `rm`. A local `curl` to `127.0.0.1:9` exited 7 and left the file. That copy is outside `sender.json`, `recipient.json`, `anon-key.txt`, and `recipient-profile/`. It is mode `0600` in the same `0700` directory that already holds the token. `check0.json`, `check1.json`, and `receipt1.json` are check and receipt JSON; they do not contain the token.

## 4. Tom's mint block

The block's body runs in bash and in `zsh -f`: `set -eu`, `umask 077`, `mkdir -p -m 0700`, `uuidgen | lower`, the `pid` helper, and the redirects. Both produced a `0700` directory, `0600` JSON, a lowercase run id, and `OK` on stdout. macOS `stat -f %Lp` prints `700` and `600`, which is what `g-seed.sh:12-15` compares.

The flags match `src/cli.ts` at this commit. `token mint` accepts `--workspace-id`, `--principal-id`, `--run-id`, `--task-id`, `--epoch`, `--ttl-ms`, and `--renewal-horizon-days` (`src/cli.ts:937`, `:2610-2685`, `:9648`). `--epoch` allows `1` (minimum 0, `:1137-1147`). `--ttl-ms 21600000` is within `1..2592000000` (`:2681-2684`) and within the server's 30-day cap (`src/protocol/workspace-commands.ts:1067-1069`). `--renewal-horizon-days 1` is within `1..90`. The command edge's UUID check is case-insensitive (`supabase/functions/command/index.ts:665-666`); the block lowercases anyway.

The token goes to the redirected stdout file (`src/cli.ts:2708-2714`). It is not in the pasted command.

**RIGOUR.** `src/cli.ts:2701-2707` writes `describeMintRenewal` to stderr before the JSON. The block redirects stdout only (`BOX-SECTION6.md:49-57`), so the terminal shows that renewal sentence and then `OK`. The sentence does not contain the token (`src/cloud/renewal.ts:101-105`). `BOX-SECTION6.md:35` says the block prints nothing but `OK`. `BOX-SECTION6.md:55` copies `$HOME/.config/cswarm/anon-key.txt`. Nothing under `src/` writes that path. If the file is absent, `set -e` stops before `OK`.

## 5. Order and failure table

The order matches the runbook where it cites it. Section 5 skips this version's functional proof (`deploy/RELEASE-TO-BOX.md:1002-1007`). Step 4 uses `release_psql_ro -v item_g_seed_signal_id=... --file /proof/20260925000001-functional.sql` (`BOX-SECTION6.md:29`, `deploy/RELEASE-TO-BOX.md:1289-1290`). Under `PGOPTIONS=-c default_transaction_read_only=on`, a missing `-v` exited 3 with `item_g_seed_signal_id is required`, and an unknown id exited 3 with `seed signal is not an eligible live unobserved delivery for a known, active seat` (`20260925000001-functional.sql:7`, `:27`). The preflight is right: with `search_path` `"$user", public, auth, extensions` (the local `supabase_admin` setting, which does not contain `swarm`), `20260925000001-catalog.sql` returned `t`. Adding `swarm` made it `f`, because `pg_get_viewdef` then drops the `swarm.` on `swarm.is_member` (`20260925000001-catalog.sql:31`, `LANE.md:16`).

**RIGOUR.** `deploy/RELEASE-TO-BOX.md:1276-1288` still tells Anvil to post the seed on the box, with credentials, through loopback. `BOX-SECTION6.md:4-7` and `:23-29` tell him to keep credentials off the box and to let the lead run `g-seed.sh` from the mini. The failure table (`BOX-SECTION6.md:86-91`) covers search_path, a catalog `f`, step 1 or 3 `STOP`, and step 4. It does not cover a section 6 health, probe, or log failure (step 2), a `g-seed.sh` exit 6, or curl's own non-zero exit (measured 7) after step 1 has already recorded an observed ACK. Section 6's edge rollback is still in the runbook (`deploy/RELEASE-TO-BOX.md:1310-1329`).

## 6. Rehearsal table

Checked by reading and by rolled-back SQL:

- Receipt field `outcome`, profile `credential_file` must be `credential.json` beside the profile (`src/cloud/agent-profile.ts:174`), and `\quit` is not what the rollback uses. The false proof path exits 3.
- Rollback catalog before any rollback is `f`. With unclaimed rows, check9 stays widened and the proof is `t`. With those rows neutralized, check9 restores to the pre-G literal and the proof is `t`.
- Functional proof exit 3 texts match the file, including under `default_transaction_read_only`.
- The stale sentence is `Accepted ${relativeAge}. The recipient's session has not checked this in ${WAKE_STALE_LABEL}` when `wake_path_observing` is true and the row is at least `WAKE_STALE_MS` old (`src/cloud/receipts.ts:173-177`). `WAKE_STALE_LABEL` is `3m` (`src/cloud/idle-poll.ts:27-29`). `relativeAge` renders `4m ago` (`src/cloud/workspaces.ts:758-762`). The following lines are `cswarm listen status` and `cswarm receipt`.
- Command auth returns 401 before command validation, for either `unclaimed` value.

The served-edge runs (`g-seed.sh` exit 0 and exit 4, the literal `SEED_NOTE_ID`, and the HTTP 401 timings) were not re-executed. `pg_dump` was not compared: a dump would not show uncommitted DDL, and the rollback was not committed.

**RIGOUR.** `BOX-SECTION6.md:78-79` calls limit `50` the exact body `cswarm check` sends. Check sends `limit: AGENT_CHECK_PAGE_SIZE`, which is 20 (`src/cloud/agent-check.ts:30`, `:201`), with the same keys once `ascending` is set (`src/cloud/signals.ts:1167-1200`). The read edge accepts `50` (`supabase/functions/read/index.ts:334-336`). A fresh seat's two notes fit in either page.

VERDICT: PASS
