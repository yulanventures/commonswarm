# Item G lane 1: box window plan (2026-09-25 21:45Z)

Written by CSwarmDevLead for HezLead and Anvil. Release SHA: `7c0bee1e750450f305bab5ada68fb8f813a10c83`.
KIND_LIST `edge stack`; CHANGED_FUNCTIONS `command read`; no router change; no new env names; migration
`20260925000001_unclaimed_observed_ack.sql`. Agreed with HezLead on 2026-09-25 ~01:00Z: no credential goes to the box.
The lead runs steps 1-3 from the mini against `https://api.commonswarm.com`, and Anvil runs only the read-only step 4.
Everything below was rehearsed on the local stack; the results are in "Rehearsal". For this window this plan
REPLACES `RELEASE-TO-BOX.md`'s item-G section-6 seed text (the paragraph that has Anvil post the seed on the box with
credentials through loopback): no credential goes to the box, and Anvil runs only step 4.

## Correction to the lead's 01:00Z message

The lead offered a credential-free stop-gate probe (an `unclaimed` ACK body with a well-formed unknown token: 401 on
the new command edge, 400 on the old). **That probe cannot discriminate, so it is withdrawn.** Measured on the local
new edge: the same body with `"unclaimed": false`, which the new validator refuses, also returns 401. The command
edge authenticates the bearer before it validates the command, so an unknown token never reaches the validator on
either edge. The stop gate that CAN fail is step 1 below: with a real seat credential, the new edge records the
unclaimed observed ACK and the old edge refuses the `unclaimed` key, and step 1 reads the result from the server's
receipt.

## Order and handoffs

| # | Who | What |
|---|---|---|
| 0 | HezLead / Anvil | Preflight as in RELEASE-TO-BOX section 1, plus: `release_psql_ro -Atq --command 'SHOW search_path'` as the section-5 role. PASS = the output does not contain `swarm` (expected default `"$user", public`, possibly with `extensions`). If it contains `swarm`, stop: the catalog proof would return `f` on a good catalog. |
| 1 | Anvil | Section 5: apply `20260925000001` with its catalog proof `deploy/release-proofs/item-g/20260925000001-catalog.sql` (must be `t`). The functional proof is skipped in section 5. |
| 2 | Anvil | Section 6: apply the edge (command + read from the SHA), health, the standard probes a-h, metrics line, log check. |
| 3 | HezLead -> lead | "edge switched and healthy" (native message). |
| 4 | lead | `g-seed.sh` steps 0-3 from the mini (below). Sends HezLead `SEED_NOTE_ID=<uuid>` natively, or the STOP line and exit code. |
| 5 | HezLead -> Anvil | the note id. |
| 6 | Anvil | Step 4: `release_psql_ro -v item_g_seed_signal_id=<uuid> --file /proof/20260925000001-functional.sql` (exit 0 = pass; missing or ineligible seed exits 3). |
| 7 | HezLead | close the window. Then the lead releases cswarm 0.1.78 and the site. |

## Tom's mint block (2026-09-25 between 20:00Z and 21:30Z)

Tom signs in first with `cswarm login` in a terminal on the mini (the mint uses the human session and its device).
Then he pastes this block. It prints nothing but a final `OK`: stdout and stderr go into 0600 files in a 0700
directory (the mint's renewal sentence goes to `mint.log`); no secret is in argv or history (the ids are not secrets).
The tokens last 6 hours; `g-seed.sh` refuses a token with less than 90 minutes left, so mint no earlier than 20:00Z.
If the block fails part way, change the `-0925` name suffix before running it again (a principal name that already
exists is refused).

```sh
(
  set -eu
  umask 077
  D="$HOME/.config/cswarm/g-seed-20260925"
  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  mkdir -p -m 0700 "$D"
  lower() { tr 'A-Z' 'a-z'; }
  pid() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' "$1"; }
  cswarm principal create --workspace-id "$WS" --name g-seed-sender-0925 >"$D/sender-principal.json" 2>>"$D/mint.log"
  cswarm principal create --workspace-id "$WS" --name g-seed-recipient-0925 >"$D/recipient-principal.json" 2>>"$D/mint.log"
  cswarm token mint --workspace-id "$WS" --principal-id "$(pid "$D/sender-principal.json")" \
    --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" --epoch 1 \
    --ttl-ms 21600000 --renewal-horizon-days 1 >"$D/sender.json" 2>>"$D/mint.log"
  cswarm token mint --workspace-id "$WS" --principal-id "$(pid "$D/recipient-principal.json")" \
    --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" --epoch 1 \
    --ttl-ms 21600000 --renewal-horizon-days 1 >"$D/recipient.json" 2>>"$D/mint.log"
  chmod 0600 "$D"/*.json "$D/mint.log"
  echo OK
)
```

The two seats are ordinary agents in the test workspace (their names are visible to its members). After the window,
Tom can revoke both with `cswarm principal revoke --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --principal-id
<id>` (the ids are in the two `*-principal.json` files).

## Steps 1-3 (lead, on the mini)

Before the window the lead adds `anon-key.txt` (0600) to the seed directory: the public anon key fetched from the
site's `/start` meta tag (never typed), checked by sha256 against the key the CLI already uses.

`deploy/release-proofs/item-g/g-seed.sh <bundle> "$HOME/.config/cswarm/g-seed-20260925" https://api.commonswarm.com
c2ea0541-f56d-4c73-bf71-56c5405c4934`, where `<bundle>` is cswarm built from the release SHA and copied outside the
repository. It refuses to run unless the directory is 0700 and the three files are 0600. It prints only ids, statuses
and exit codes.

- Step 0: the recipient's first `cswarm check` (its profile is written into the same directory) sets its cursor.
- Step 1: the sender posts note 1 to the recipient; the recipient's `cswarm check` shows it and sends one unclaimed
  observed ACK. **Stop gate:** the sender's `cswarm receipt` for note 1 must show the recipient with
  `ack_outcome: observed`. The CLI swallows a refused ACK, so only the server's receipt proves that the new edge
  accepted the new shape. Failure exits 4 (`STOP step 1`).
- Step 2: the sender posts note 2; the recipient does not check it.
- Step 3: the read-edge probe with the recipient's credential, with the keys the CLI sends (the CLI's `check` pages
  20 at a time; this probe asks for 50, which the read edge accepts):
  `{"resource":"signals","workspace_id":"<ws>","inbox":true,"about":null,"kind":null,"since":null,"in_reply_to":null,"after_created_at":null,"after_id":null,"limit":50,"include_stale":false}`
  with headers `Authorization: Bearer <recipient token>`, `apikey: <anon key>`, `Content-Type: application/json`
  (from a 0600 file, deleted on every exit path), with a 30-second limit. Must return 200 and contain note 2; a
  non-200, a connection failure or a missing note exits 5 (`STOP step 3`). Step 3 checks the read path's health; it
  does NOT tell the new read edge from the old one (both return 200 with note 2). Step 1 is the only discriminator.
- Before step 0 the script refuses (exit 2) a credential with less than 90 minutes left: a token that expired, or one
  the recipient's check renewed (renewal retires the old token and writes the new one outside the seed directory),
  would otherwise fake a STOP.
- The script ends with `SEED_NOTE_ID=<note 2 id>`.

## If a step fails

| Failure | Action |
|---|---|
| Preflight `search_path` contains `swarm` | Stop before section 5. Nothing changed. |
| Section 5 catalog proof `f` | The runbook's section 5 abort (the migration transaction does not commit). |
| Section 6 edge apply, health or probes a-h fail | The runbook's section 6 edge rollback (to `4ef0f300`). The migration stays: rolling back the edge alone is safe (below). |
| `g-seed.sh` exit 2 (inputs, or a credential with < 90 minutes left) | Not an edge problem. Tom mints again (new name suffix); the lead reruns `g-seed.sh`. The edge stays. |
| `g-seed.sh` exit 4 (step 1 STOP: the edge did not record the ACK) | Roll back the EDGE only. The migration stays. Then debug. |
| `g-seed.sh` exit 5 (step 3 STOP) | The lead reads `read-resp.json` and the HTTP code. A 5xx or a wrong body from the edge: roll back the EDGE only. A connection failure on the mini: rerun `g-seed.sh` once. |
| `g-seed.sh` exit 6 (an unexpected CLI failure) | The lead reads the JSON files the script wrote (`check0.json`, `check1.json`, `receipt1.json`; they hold no token). An HTTP 5xx from the edge: roll back the EDGE only. A local or input problem: fix it and rerun. |
| Step 4 (functional proof) fails, steps 1-3 passed | Keep the edge and the migration: both are safe, step 1 already proved the new write path, and the proof is read-only. The lead debugs with the proof's error text and the seed ids. HezLead may still roll back the edge; the SQL rollback runs only on HezLead's decision. |

## Rollback

**Edge only (safe with the migration in place).** The new check9 only widens (it adds the unclaimed `observed`
shape), so every write of the old edge passes it. The old edge never reads the new table, views or index.
`swarm_read.signal_delivery_receipts` keeps its signature and only adds a `wake_path_observing` field to directed
agent receipts; the old CLI (0.1.77 and earlier) and the old site parse receipts without strict key checks
(`src/cloud/delivery-receipts.ts` at 4d4cb3f7 has no exact-key check), so they ignore it.

**SQL (reserve; only on HezLead's decision).** This is an exception to `RELEASE-TO-BOX.md`'s rule that a
down-migration must arrive in the same PR as its migration (it came later, reviewed separately); HezLead decides.
Stage both rollback files into `/proof` in section 1 with the other proofs, run `assert-database-identity.sh` first as
for any write, and roll back the EDGE before the SQL (the new edge's writes need the widened check9 and the new
receipts wrapper). After step 1 has run in production, the SQL always takes the "check9 KEPT widened" branch (step 1
writes an unclaimed observed ACK). The SQL rollback is safe only while the old site and the 0.1.77 CLI are current:
after the 0.1.78 site deploy, the site reads `swarm_read.agent_wake_path` (the roster tolerates its absence, but roll
the site back too). `deploy/release-proofs/item-g/20260925000001-rollback.sql`, one
transaction, run with the write helper `release_psql --file /proof/20260925000001-rollback.sql` (not
`release_psql_ro`), with
`deploy/release-proofs/item-g/20260925000001-rollback-catalog.sql` at `/proof/`. It drops the receipts wrapper and
renames the inner function back (owner `swarm_admin`, PUBLIC revoked, EXECUTE to `authenticated` and `swarm_read`, as
before G), drops the three views, `swarm.wake_path_release` and the partial index, and deletes the
`supabase_migrations.schema_migrations` row. check9 goes back to the pre-G definition only when no unclaimed observed
ACK row exists; otherwise it stays widened (it admits one more shape; every pre-G writer still passes) and a NOTICE says
so. It never rewrites ACK rows (clearing them would make old mail claimable again). Its catalog proof must be `t`, or
the transaction rolls back and psql exits 3.

## Rehearsal (local stack, main f7fa1227, 2026-09-25)

All on the local stack, 2026-09-25 01:00-01:20Z, with the edge functions served by `supabase functions serve
--no-verify-jwt --env-file <SWARM_ENV=test>` (the way the server suite serves them; without that env file the local
edge's database lookups failed with `ENOTFOUND`, a local-only condition). The bundle was built from main `f7fa1227`,
which has the same `src/` and `supabase/` as the release SHA `7c0bee1e` (only docs differ). Seats were seeded in the
database the way `tests/p1-server/managed-delivery.test.ts` seeds them, and written in the minted credential shape.

| Run | Result |
|---|---|
| `g-seed.sh`, NEW edge (main) | exit 0: step 0 baseline check; step 1 note 1, receipt `outcome: observed`; step 2 note 2 left unchecked; step 3 read edge 200 and contains note 2; `SEED_NOTE_ID=150fd068-...` |
| `g-seed.sh`, OLD edge (`4ef0f300`, the edge in production now) against the G schema | exit 4: `STOP step 1: the edge did not record the unclaimed observed ACK`. Step 0 (check), the note post and the receipt read all worked on the old edge with the G schema in place, which is also evidence for the edge-only rollback |
| Step 4 functional proof on note 2, with `PGOPTIONS=-c default_transaction_read_only=on` | exit 0 (`DO`) |
| Step 4 on note 1 (observed, so not eligible) | exit 3: `seed signal is not an eligible live unobserved delivery for a known, active seat` |
| Step-1 gate negative control (a fresh note the recipient never checked) | the receipt is `not_delivered`, `outcome: null`: the gate returns FAIL (exit 4) |
| Credential-free probe (withdrawn) | NEW edge: unclaimed `true` -> 401 and unclaimed `false` -> 401 (auth precedes command validation) |
| SQL rollback, no unclaimed ACK rows | exit 0, `check9 restored to the pre-G definition`; `pg_dump -s -n swarm -n swarm_read` identical to the pre-G dump except pg_dump's random `\restrict` key |
| SQL rollback, one unclaimed observed ACK row | exit 0, `check9 KEPT widened: 1 unclaimed observed ACK rows exist`; the only schema difference from pre-G is check9 |
| SQL rollback with a catalog proof mutated to fail | exit 3, `rollback catalog proof FAILED`; afterwards the G objects and the ledger row were all still present |
| Rollback catalog proof before any rollback | `rollback_ok=f` |
| After the Opus box review (e55deb3d FAIL), the fixed `g-seed.sh`, NEW edge | exit 0, `SEED_NOTE_ID=61a8684b-...` |
| Fixed `g-seed.sh` with a recipient credential 30 minutes from expiry | exit 2, `expires in 29 min (< 90); mint again`, before any network call |
| Fixed `g-seed.sh` with step 3's URL mutated to a closed port | exit 5, `STOP step 3: read-edge probe failed (HTTP 000)`; `read-headers.txt` is gone |
| Rollback, then the rollback catalog proof with EXECUTE granted to `anon` / with the function comment dropped | `rollback_ok=f` / `f`; unmutated `t` (each mutation inside a rolled-back transaction) |
| After the Grok box review: full rollback with 5 unclaimed rows, the proof comparing the widened check9 exactly | committed (`check9 KEPT widened`); a different check9 containing the old substring gives `rollback_ok=f` inside a rolled-back transaction |

Two defects in the first `g-seed.sh` were found by the rehearsal and fixed: a profile's `credential_file` must be
`credential.json` beside `profile.json`, and `receipt --json` names the field `outcome`, not `ack_outcome`. The first
rollback file used `\quit 3`, which psql ignores (exit 0); it now raises an error under ON_ERROR_STOP (exit 3).
After the NEW-edge run, the sender's human receipt for note 2 (left unchecked), read 4 minutes later:
`Accepted 4m ago. The recipient's session has not checked this in 3m.` followed by the `cswarm listen status` next
step and the `cswarm receipt` re-check command. This is the stale mark the lane exists for, end to end on the local
stack. The lead repeats this read on production after step 4 (it needs no box action).

## Not established

- The box's section-5 role `search_path` (the preflight measures it).
- Steps 1-3 and the stale receipt against production (they run in the window).
- `token mint` with a human session was not rehearsed locally (no local human login); the rehearsal minted local
  tokens in the same credential shape.
