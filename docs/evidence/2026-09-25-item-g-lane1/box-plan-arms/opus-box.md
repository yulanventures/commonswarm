# Item G box window plan: exact review (Anthropic arm)

Commit under review: `e55deb3d` (detached worktree `scratchpad/arms-gbox`, `git log --oneline -1` = `e55deb3d`).
Files: `docs/evidence/2026-09-25-item-g-lane1/BOX-SECTION6.md`, `deploy/release-proofs/item-g/g-seed.sh`,
`deploy/release-proofs/item-g/20260925000001-rollback.sql`, `deploy/release-proofs/item-g/20260925000001-rollback-catalog.sql`.
Context read: `deploy/RELEASE-TO-BOX.md` sections 1, 3, 5, 6 and 9, the migration, the G catalog and functional proofs,
`src/cli.ts` (token mint, principal create), `src/cloud/{renewal,agent-profile,agent-credential,receipts,delivery-receipts,signals}.ts`,
the command and read edges at this commit and at `4ef0f300`, the site receipt parser at `4ef0f300`.

No production host contacted. No cswarm command run. All SQL ran on the local stack (`supabase_db_cloud-swarm`) inside
transactions that rolled back. After all probes the local database still has migration 20260925000001 applied
(`wake_path_release` present, `signal_delivery_receipts_without_wake_path` present, ledger count 1). Probes and outputs are in
`scratchpad/itemG/opus-box-probes/`.

## What I verified (evidence)

### 1. Rollback SQL is the exact inverse (rolled-back SQL rehearsal)

Probe `build.sh` A/B: one transaction per mode; snapshot every function named `swarm_read.signal_delivery_receipts*`
(owner, ACL, comment, volatility, SECURITY DEFINER, md5 of the definition), every constraint and index on `swarm.signal_deliveries`,
every relation in `swarm`/`swarm_read`, and the ledger row. Then rollback lines 11-50, rollback catalog proof, snapshot, re-apply
the migration text plus ledger row, G catalog proof, snapshot, `ROLLBACK`.

- Mode A (local has 3 unclaimed observed rows): `NOTICE: check9 KEPT widened: 3 ...`, `rollback_ok=t`, re-apply `catalog_ok=t`,
  G-before and G-after snapshots identical (94 lines).
- Mode B (the unclaimed rows deleted inside the transaction first): `NOTICE: check9 restored to the pre-G definition`,
  `rollback_ok=t`, re-apply `catalog_ok=t`, round trip identical.
- Rolled-back state versus G: the wrapper is gone; `signal_delivery_receipts` is the renamed inner function with owner
  `swarm_admin`, ACL `{swarm_admin=X/swarm_admin,authenticated=X/swarm_admin,swarm_read=X/swarm_admin}`, and the pre-G COMMENT
  (it follows the OID through both renames), VOLATILE, SECURITY DEFINER. This matches
  `20260902000004_signal_agent_receipts.sql:214-224` (REVOKE FROM PUBLIC, anon; GRANT authenticated, swarm_read; COMMENT).
  The three views, `swarm.wake_path_release`, and `signal_deliveries_unclaimed_observed` are gone. The ledger row is gone. In mode B,
  check9 is byte-equal to the original `20260731000001_signal_deliveries.sql:69-74` definition. The migration has no COMMENT and
  no other object. That makes the inverse complete for every object in the migration.
- Dependencies: the only `pg_depend` normal dependents of the dropped relations are their own rewrite rules and the
  `wake_path_release` singleton CHECK. Drop order (aggregate view, member view, eligible view, table) is valid. The wrapper
  reaches the eligible view only through plpgsql text, and the wrapper is dropped first. No edge function references the
  views (`grep` of `supabase/functions`).
- No race on check9: `DROP INDEX swarm.signal_deliveries_unclaimed_observed` (rollback.sql:26) takes ACCESS EXCLUSIVE on
  `swarm.signal_deliveries` before the count in the DO block (rollback.sql:32-34). So no unclaimed ACK can land between the
  count and the re-added constraint. The count predicate is a superset of the rows the widened arm admits, so the restore
  branch can never fail validation.
- Keeping check9 widened is correct and safe. The widened clause only admits `observed` with `last_error_code IS NULL` and no
  lease pair. Every pre-G writer still passes. ACKed rows are never claimable. Re-applying the migration later works: the
  mode A re-apply after a KEPT rollback returned `catalog_ok=t` (the migration uses `DROP CONSTRAINT IF EXISTS`).
- Role: `release_psql` connects through `PGSERVICE=target`, which RELEASE-TO-BOX section 2 sets to the `supabase_admin` URL. It can
  drop objects owned by `swarm_admin` and can delete from the ledger.
- `\if :rollback_ok` with a `\gset` value of `t`/`f`: probe D1 (the file as written, with `COMMIT` swapped for `ROLLBACK` so that
  nothing persists, and the `\i` inlined) exits 0 through the pass branch. Probe D2 (the proof forced false) runs the file's own
  `\else ROLLBACK;` and then the `RAISE`, exit 3, `ERROR: rollback catalog proof FAILED ...`. Afterwards the G objects and the
  ledger row were still present.

### 1b. Rollback catalog proof discriminates (mutation table, both branches)

After the rollback, each of these mutations, run inside a savepoint, turned `rollback_ok` from `t` to `f`: the eligible view,
the member view, the aggregate view, the `wake_path_release` table, the partial index, the inner function left un-renamed, the
owner changed, EXECUTE revoked from `authenticated`, EXECUTE revoked from `swarm_read`, EXECUTE granted to PUBLIC, the ledger row
re-inserted, check9 missing, check9 NOT VALID, and check9 widened with no unclaimed rows (mode B). check9 widened with unclaimed
rows correctly stays `t` (mode A). Before any rollback the proof returns `f`. Gaps are in finding 5.

### 2. Edge-only rollback claim (by reading)

- Old read edge `4ef0f300:supabase/functions/read/index.ts:543-605` calls `swarm_read.signal_delivery_receipts(uuid,uuid,bytea)`,
  checks only `addressed`, `receipts` is an array, and the broadcast roster. It then passes `receipts` through unchanged. The
  wrapper keeps the signature and the grants (`authenticated`, `swarm_read`), and it adds `wake_path_observing` only to addressed
  agent rows.
- The v0.1.77 CLI parser (`src/cloud/delivery-receipts.ts` `parseDeliveryReceipt`) builds its row from named fields. The
  `4ef0f300..7c0bee1e` diff only adds an optional field. The old site parser (`4ef0f300:site/src/lib/commonswarm.ts:2496-2600`)
  also reads named fields, with no key-count check. Unknown keys are ignored.
- The old command edge writes only leased ACKs, and these pass the widened check9.
- The old read edge orders by microseconds, not milliseconds. This affects only the heal consistency of the new views, which
  the old edge and the old site never read.
- Conclusion: the claim holds. What was not established: an old (<= 0.1.77) CLI binary run against the G schema. The rehearsal
  used the new bundle against the old edge.

### 3/4. Mint flags and read body

- `cswarm principal create --workspace-id --name` prints JSON with `principal_id` (`src/cli.ts:2525-2536`).
  `token mint --workspace-id --principal-id --run-id --task-id --epoch --ttl-ms --renewal-horizon-days` is valid at this commit
  (`src/cli.ts:2610-2701`; TTL bound 2_592_000_000; server `AGENT_TOKEN_MAX_TTL_MS` 30 days; client successor bound 8 h;
  horizon 1..90 days). It is also valid in v0.1.77 (`"renewal-horizon-days"` present). `principal revoke` flags match
  `src/cli.ts:936`.
- The zsh and bash block reads correctly: `( set -eu; umask 077 ... )`, `lower`/`pid` helpers, `uuidgen | lower`, redirects into
  0600 files in a 0700 directory, and no secret in argv.
- The step-3 body matches `src/cloud/signals.ts:1180-1200` (no channel) and passes the read edge's `exactKeys`
  (`supabase/functions/read/index.ts:299-311`).
- The step-1 gate fields match `receipt --json` (`src/cloud/receipts.ts:286-294`: `recipient_agent_principal_id`, `outcome`,
  `acked_at`).
- The note JSON carries `signal.id` (`src/cli.ts` runPostSignal `printJson({... signal ...})`).
- The default note `until` is 30 days (`command/index.ts:647-651`), so the step-4 seed cannot expire in the window.
- The command edge authenticates before it validates (`command/index.ts:8915-8937` before `9068`). The withdrawal of the
  credential-free probe is correct.
- The `search_path` preflight is justified: the G catalog proof matches `'%swarm.is_member%'` (catalog.sql:31) and the index
  definition `ON swarm.signal_deliveries` (catalog.sql:77). Both lose the `swarm.` qualifier when `swarm` is on the search path.
  The local `SHOW search_path` is `"$user", public, extensions`.

## Findings

1. **PRODUCTION (medium): credential lifetime is not guarded.** One step can stop for a reason the doc does not name, and after
   expiry the failure table has no row for the result.
   - Location: BOX-SECTION6.md:32, 50-54, 84-91; g-seed.sh:13-20, 47, 82.
   - Tom mints 6-hour tokens (`--ttl-ms 21600000`) any time from 18:00 to 21:30Z. The window opens at 21:45Z, and g-seed
     runs only after sections 5 and 6. An 18:00 mint expires at 00:00Z.
   - g-seed never reads `expires_at`, which is present in the minted artifact (`src/cli.ts:1187-1189`).
   - After expiry, step 0 exits 6 ("unexpected CLI failure"). The failure table has no row for exit 6.
   - Just before expiry, the step-0/step-1 `check --profile` opens a credential session with a store
     (`agent-profile.ts:190-194`). The session assumes a 1-hour lifetime for a minted artifact (`renewal.ts:743-745`), so it
     renews in the last 6 minutes (`renewal.ts:139-146`).
   - A renewal supersedes the predecessor on the server (`renewal.ts:845-851`) and writes the successor under
     `~/.cswarm/agent-credentials/` (`agent-credential.ts:93-98`, `renewal.ts:1084`). That is a second secret outside `$DIR`.
   - Step 3 then presents the dead token from `recipient.json` (g-seed.sh:82). It returns 401 and prints `STOP step 3`, and
     the failure table sends HezLead to roll back a good edge.
   - Fix: g-seed refuses to start unless both artifacts have `expires_at` at least 60 minutes ahead (exit 2, with a stated
     reason). The doc states the latest start time, or Tom mints nearer the window with the 8-hour maximum
     (`--ttl-ms 28800000`).

2. **PRODUCTION (low) / RIGOUR: a curl transport failure breaks two claims.**
   - Location: g-seed.sh:87-88.
   - The doc says the bearer-header file is "deleted after the call" (BOX-SECTION6.md:80-81) and that step-3 failure exits 5
     (g-seed.sh:9).
   - Under `set -euo pipefail`, a failed `CODE="$(curl ...)"` ends the script before `rm -f read-headers.txt`.
   - Control probe (`opus-box-probes/curlfail.sh`, loopback port 9, fake token): exit 7, no STOP line, and `read-headers.txt`
     still present.
   - curl exit 6 (DNS failure) collides with the documented exit 6 meaning. There is also no `--max-time`, so step 3 can hang.
   - Fix: `trap 'rm -f "$DIR/read-headers.txt"' EXIT`, add `--max-time 30`, and map curl failure to `STOP step 3`, exit 5.

3. **RIGOUR: the failure table does not cover every g-seed exit.**
   - Location: BOX-SECTION6.md:84-91.
   - Exit 2 (bad input) and exit 6 have no row. Exit 6 at step 0, 1 or 2 can come from the new command or read edge (check,
     note post, or receipt read fail), so it can be a new-edge regression.
   - Other exits (for example curl 7) have no row either.
   - Also no row for: section 6 health or probes a-h failing after section 5 committed. The edge-only reasoning covers it, but
     the table should say "keep the migration".

4. **RIGOUR: the reserve SQL rollback does not follow the runbook's rules.**
   - Location: BOX-SECTION6.md:101-110 against RELEASE-TO-BOX.md:1039-1045, 285-335, 671.
   - Identity check: every other write block runs `assert-database-identity.sh` before `release_psql`; this rollback command
     does not.
   - Staging: the doc does not say to stage the two rollback files in the section-1 proof transfer, and the rollback
     `\i`s `/proof/...-rollback-catalog.sql`. If they are not staged, an incident needs a second transfer.
   - Down-migration rule: RELEASE-TO-BOX.md:1041 allows a down-migration "only when it was supplied and reviewed in the same
     PR as the up-migration". This file comes after the migration (`ec44cc95`/`d3d49fcd`), so the doc should name it as a
     HezLead exception.
   - Timeout: there is no `SET LOCAL statement_timeout` (section 5 uses `5min`).

5. **RIGOUR: the rollback catalog proof misses two ACL states.**
   - Location: rollback-catalog.sql:15-17.
   - An EXECUTE grant to `anon` returns `t` (mutation `anon_grant=t`). The pre-G function revoked `anon`
     (20260902000004:216-217).
   - A NULL `proacl` (PUBLIC can execute by default) would pass: `aclexplode(NULL)` is empty and `has_function_privilege` is
     true. I could not run this mutation (postgres cannot update `pg_proc` locally).
   - Loss of the COMMENT is also not detected (`comment_gone=t`).
   - The rollback SQL creates none of these states (verified above), so this is a gap in the proof only.
   - Fix: add `NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.proacl IS NOT NULL`.

6. **RIGOUR: step 3 does not discriminate between the new and old read edge.**
   - Location: BOX-SECTION6.md:78-81, 90-91.
   - The old read edge (`4ef0f300`) returns 200 with note 2 for this body just as well: the only read-edge change is the
     millisecond ordering. No negative control is recorded for step 3 (the old-edge rehearsal stopped at step 1).
   - "Steps 1-3 already proved the new write and read paths" (line 91) overstates this. Step 3 is a read-edge health check with
     the recipient credential; only step 1 separates the new edge from the old one.

7. **RIGOUR: the rollback scope is not stated.**
   - Location: BOX-SECTION6.md:101-110.
   - After step 1 on production, at least one unclaimed observed row exists (the seed's note 1). A post-seed SQL rollback
     therefore always takes the KEPT branch; "check9 goes back to the pre-G definition" applies only before step 1.
   - The doc does not say that the SQL rollback is valid only while the old site and CLI 0.1.77 are current. The new site reads
     `swarm_read.agent_wake_path` (`site/src/components/app/LiveDashboard.astro`). It also does not say whether the edge must be
     rolled back first. That matters only in the restore branch, where the new edge's unclaimed ACK would violate the restored
     check9.

8. **RIGOUR: the mint block prints more than `OK`.**
   - Location: BOX-SECTION6.md:35 against src/cli.ts:2694-2700 and renewal.ts:101-105.
   - Each `token mint` writes the `describeMintRenewal` sentence to stderr, so the block prints that sentence twice before
     `OK`. It is not sensitive, but the claim is false.
   - If Tom re-runs after a partial failure, `principal create` of an existing name fails (no `--allow-duplicate-name`). The
     doc does not say so.

## Rehearsal-table claims (BOX-SECTION6.md:120-131)

- Checked by rolled-back SQL: both SQL rollback rows, the mutated-proof row (exit 3, objects and ledger kept), and "rollback
  catalog proof before any rollback" (`f`). I did not run `pg_dump`. My catalog snapshot covers every object the migration
  touches and shows the expected pre-G state.
- Checked by reading:
  - The step-1 gate and its negative control. A never-checked note has a null `acked_at` and outcome, so the gate fails.
  - Step 4 on note 1 exits 3: an ACKed delivery is not in `wake_path_eligible_deliveries`, so `v_workspace` is NULL and the
    proof raises.
  - Step 4 on note 2 exits 0: the only eligible row, and an earlier unclaimed observed ACK exists.
  - The credential-free probe returns 401 for both bodies (auth before validation).
  - The two g-seed defect fixes are present (`credential.json` beside the profile, g-seed.sh:28-41; `outcome` field,
    g-seed.sh:68-70).
  - The `\quit` note is correct: psql `\quit` takes no exit code.
- Not verified: the served NEW and OLD edge runs, the old-edge exit 4, and the four-minute stale receipt text. Only the
  served edges can show these.

## Not established

- The box role's `search_path` (the preflight measures it).
- An old CLI binary against the G schema.
- `token mint` with a real human session.
- Behaviour of a mid-call function drop for in-flight receipt calls during the SQL rollback.

VERDICT: FAIL
