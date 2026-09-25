# Item G box window plan, round 2: exact review (Anthropic arm)

Commit under review: `e8c5fa70` (detached worktree `scratchpad/arms-gbox`; `git log --oneline -1` = `e8c5fa70`).
The round-2 diff is `e55deb3d..e8c5fa70` (cb877d52, e8c5fa70). The whole plan is `f7fa1227..e8c5fa70`. Both change only
the four files: `BOX-SECTION6.md`, `g-seed.sh`, `20260925000001-rollback.sql`, and `20260925000001-rollback-catalog.sql`.

I contacted no production host and ran no cswarm command. I did not read `~/.cswarm` or `~/.config/cswarm`. All SQL ran on the
local stack inside transactions that rolled back. Afterwards the local database still has migration 20260925000001 applied:
the ledger count is 1, 5 unclaimed observed rows exist, and `swarm_read.agent_wake_path` is present. I tested `g-seed.sh` with
fake input files and a fake CLI, against a closed loopback port and a fake loopback read server that I started and killed.
No process of mine is still running. Probes and outputs are in `scratchpad/itemG/opus-box2-probes/`.

## Round-1 findings: status

| Round-1 finding | Status | Evidence |
|---|---|---|
| Opus 1 (PRODUCTION): token expiry or renewal could fake a STOP | FIXED | `g-seed.sh:20-32` refuses to start (exit 2) when a credential is missing `expires_at` or has < 90 min left, and does so before any network call. A minted artifact from `src/cli.ts:1173-1190,2695-2714` always carries `expires_at` when the mint event has one. Renewal is due at `expiresAt - 6 min`, because the session assumes a 1 h lifetime (`renewal.ts:743-745`, `139-146`; `AGENT_TOKEN_DEFAULT_TTL_MS` = 1 h). A 90-min margin therefore rules out a renewal during the run. Without a renewal, no secret is written to the store (`renewal.ts:1073-1083`). Probes: 30, 89, -5 min, no `expires_at`, and a garbage value all exit 2 with the fake CLI never invoked. With 200 min the run proceeds. The date parse was tested on the mini's Python 3.9.6 with a `toISOString` value (`.123Z`). |
| Opus 2: a curl failure left the header file and exited 7 | FIXED | `g-seed.sh:96` sets an EXIT trap, `105-106` uses `--max-time 30` and `|| CODE="000"`, and `111-112` fails any non-200. Closed port 9: exit 5, `HTTP 000`, header file gone. Hang: exit 5 after 30 s, header file gone. SIGTERM, SIGHUP, and SIGINT during curl: header file gone in each case. |
| Opus 3: failure-table gaps | FIXED (residual in finding 3 below) | `BOX-SECTION6.md:103-107` adds rows for the section-6 edge, exit 2, exit 5, and exit 6. |
| Opus 4: reserve SQL not aligned with the runbook | FIXED | `BOX-SECTION6.md:118-121` names the down-migration exception (RELEASE-TO-BOX.md:1039-1045), staging into `/proof` (the proof list takes every `*.sql` in `$EVIDENCE_DIR`, RELEASE-TO-BOX.md:296-298), `assert-database-identity.sh` first, and the edge before the SQL. `rollback.sql:12` adds `statement_timeout 60s`. |
| Opus 5: the proof missed the anon grant, NULL proacl, and the comment | FIXED | `rollback-catalog.sql:17-20`. Mutations `anon_grant`, `comment_gone`, and `comment_other` now give `f`. The pre-G comment prefix matches `20260902000004_signal_agent_receipts.sql:223` and the live inner function. I could not run the NULL-proacl mutation (postgres is not a superuser here). By reading, `p.proacl IS NOT NULL` closes it. |
| Opus 6: step 3 does not discriminate | FIXED (by statement) | `BOX-SECTION6.md:90-91` and `g-seed.sh:94-95` now say step 3 is a health check and step 1 is the only discriminator. Line 108 now credits step 1 only. |
| Opus 7: rollback scope | FIXED | `BOX-SECTION6.md:121-125`: the KEPT branch after step 1, the edge first, and the old site and 0.1.77 CLI only. |
| Opus 8: the mint block prints more than OK; the rerun name | FIXED (residual in finding 2 below) | Each command now has `2>>"$D/mint.log"`. The rerun note is at `:40-41`. |
| Grok: check9 matched by substring | FIXED | `rollback-catalog.sql:30` uses exact equality. It is `t` on the live migration check9 (PG 17.6). `check9_widened_plus` (the widened text plus one more OR) and `check9_superwide` both give `f`. |
| Grok: the header leftover and mint stderr | FIXED | As above. |
| Grok: anon-key path | FIXED | `cp ~/.config/cswarm/anon-key.txt` is removed from the block. `BOX-SECTION6.md:71-72` has the lead add it, fetched from the `/start` meta tag. |
| Grok: RELEASE-TO-BOX on-box seed text conflicts | FIXED (by statement) | `BOX-SECTION6.md:7-9` says this plan replaces RELEASE-TO-BOX.md:1276-1288 for this window. |
| Grok: limit 50 vs 20 | FIXED | `BOX-SECTION6.md:85-86`. |

## The six checks

### 1. Rollback SQL and its proof

- **Round trips** (`build.sh`, the rollback lines 11-51 as written): `probeA.sql` and `probeB.sql`.
  - Mode A (5 unclaimed rows): `check9 KEPT widened: 5`, `rollback_ok=t`. The migration re-apply gives `catalog_ok=t`.
  - Mode B (the rows deleted inside the transaction): `check9 restored to the pre-G definition`, `rollback_ok=t`. The re-apply
    gives `catalog_ok=t`.
  - In both modes, the G snapshot before equals the G snapshot after the re-apply (the only diff line is my own echo).
  - After the rollback, `signal_delivery_receipts` has owner `swarm_admin`, ACL
    `{swarm_admin=X/swarm_admin,authenticated=X/swarm_admin,swarm_read=X/swarm_admin}`, the pre-G comment, VOLATILE, and
    SECURITY DEFINER. The ledger count is 0.
- **Mutation table** (`buildC.sh`, each mutation in a savepoint after the rollback):
  - The control gives `t` in both modes.
  - Each of these gives `f` in both modes: each of the three views, the release table, the index, the inner function not
    renamed, the owner, no `authenticated`, no `swarm_read`, a PUBLIC grant, an anon grant, the comment dropped, a different
    comment, the ledger row re-inserted, check9 missing, check9 NOT VALID (pre and widened), the widened check9 plus one OR,
    and a superwide check9.
  - The exact widened check9 gives `t` with rows and `f` with no rows.
  - The exact pre-G check9 gives `t` (mode B).
  - The proof is therefore `t` exactly when the rollback is complete. The one exception is NULL proacl, which I closed by
    reading only.
- **File as written**: `probeD1.sql` (the `\i` inlined, `COMMIT` swapped for `ROLLBACK` plus an echo) exits 0 through the
  pass branch. `probeD2.sql` (the proof forced false) exits 3 with `rollback catalog proof FAILED`. Afterwards the G objects
  and the ledger row were still present.
- **search_path**: the rollback proof does not depend on `search_path`. `pg_get_constraintdef` and `pg_get_functiondef` do not
  qualify anything that it compares. The only `SET search_path` in the migration is function-level (`:145`).

### 2. Edge-only rollback

The migration and the edge-only text are unchanged since round 1. My round-1 reading still holds: the old edge's writes pass
the widened check9, and the wrapper keeps its signature and grants. The rehearsal's old-edge run (`old-edge-run2.out`) shows
step 0, the note post, and the receipt read all working on the old edge with G applied.

### 3. g-seed.sh

- **Argv**: across all fake-CLI runs, argv never contained the token. The sender uses `--agent-token-file`, the recipient uses
  `--profile`, and curl uses `-H @file`.
- **The fake read server** received `Bearer <token>`, the anon `apikey`, and the 11 body keys.
- **Outcomes**:
  - 200 with note 2: exit 0.
  - 200 without note 2: exit 5.
  - 500: exit 5.
  - A 200 that is not JSON: exit 5.
  - Closed port: exit 5 (000).
  - Hang: exit 5 after 30 s.
  - Receipt not `observed`: exit 4 (`STOP step 1`).
- **No false PASS path exists.** The step-1 gate needs `outcome == observed` and `acked_at`. The step-3 gate needs 200 and
  note 2.
- **Leftover secrets**: only `recipient.json`, `sender.json`, and `recipient-profile/credential.json`. All are 0600 in the
  0700 seed directory. The header file is removed on every exit path I tested, including signals.

### 4. Tom's mint block

- **Test method**: I extracted the block from the doc and ran it under `/bin/bash --norc` and `/bin/zsh -f`. A fake `cswarm`
  was first on `PATH`, and `HOME` was a probe directory.
- **Success**: stdout+stderr is exactly `OK` in both shells. The directory is 0700 and every file is 0600, including
  `mint.log`. `mint.log` holds the two renewal sentences. No token is in argv.
- **Failure** (the principal name already exists): rc 1 and no terminal output at all. The error is only in `mint.log`
  (finding 2).
- **Flags**: unchanged from round 1 and valid.

### 5. Order and failure table

- **Order**: matches the runbook's section 5 skip of the functional proof and the section-6 edge rollback.
- **Staging**: covered, because the proof list takes every `*.sql` in `$EVIDENCE_DIR`.
- **Exit codes**: 2, 4, 5, and 6 have rows now. Residual gaps are in finding 3.

### 6. Rehearsal claims

- **Checked against code and probes**:
  - The recipient 30-minute expiry gives exit 2 with `expires in 29 min (< 90)`. My probe gives the same text, naming
    whichever file expires first.
  - The closed port gives exit 5, `HTTP 000`, and the header file gone. Reproduced.
  - The anon and comment mutations give `f`. Reproduced.
  - The exact widened check9, and `f` for a different check9 that contains the substring. Reproduced (`check9_widened_plus`).
  - The committed full rollback with 5 rows: `rollback/run4.out` shows the file running from `/proof` through `COMMIT` with
    `KEPT widened: 5`. The local database is back at the G state now, and my snapshots match a fresh re-apply.
- **Not reproduced**: the fixed NEW-edge run `SEED_NOTE_ID=61a8684b-...` (the edge is not served, and no output file for
  it is in `seed-rehearsal/`). The earlier `150fd068` run is in `new-edge-run2.out`.

## Findings

1. **RIGOUR: the step-3 comment makes a false claim.**
   - Location: `g-seed.sh:93`.
   - The comment says the profile's `credential.json` is "the profile's copy, which the CLI keeps current". The CLI never
     rewrites a profile's `credential_file`. `openProfileCredential` (`agent-profile.ts:188-193`) keeps successors in the
     lineage store under `~/.cswarm/agent-credentials` (`agent-credential.ts:96-98`, `renewal.ts:1073-1097`).
   - `BOX-SECTION6.md:92-94` states this correctly.
   - The claim is harmless because the 90-minute guard prevents renewal, so the file equals `recipient.json`. The comment
     should say "a byte copy of recipient.json".

2. **RIGOUR: the mint block fails silently.**
   - Location: `BOX-SECTION6.md:37-41,52-59`.
   - Because stderr now goes to `mint.log`, a failed command prints nothing: rc 1, empty terminal, measured in bash and zsh.
   - The doc says the block prints only `OK`. It does not tell Tom that a missing `OK` means failure, or that the reason is
     in `mint.log`.
   - Line 40 ("If the block fails part way") assumes that Tom can see the failure.

3. **RIGOUR: the failure table still has decision gaps.**
   - Location: `BOX-SECTION6.md:106-107`.
   - Exit 6 at `g-seed.sh:71` ("the recipient check did not show note 1") is a read result from the edge, not a 5xx or a
     local problem, and no rule covers it. A 4xx from the new edge at step 0, 1, or 2 is not covered either.
   - Note-post and receipt failures (`g-seed.sh:67,78,90`) write no JSON file. The diagnosis is on the terminal stderr, not
     in "the JSON files".
   - Exit 5 says "rerun once" for a connection failure but gives no rule for a second `000`. A `000` right after steps 1-2
     reached the same host points at the read edge.

4. **RIGOUR: the latest start time is not stated.**
   - Location: `BOX-SECTION6.md:34,39`.
   - The guard makes the latest `g-seed.sh` start the mint time + 4 h 30 m (00:30Z for a 20:00Z mint). The doc does not
     give that time, or say that a window which slips past it needs Tom back to mint again.
   - The guard keeps this safe: exit 2, no STOP, no rollback.

**No PRODUCTION finding.** Every round-1 finding from both arms is fixed.

## Not established

- The fixed NEW-edge run (`61a8684b`) and any served-edge behaviour in this round, because the edge is not served.
- The NULL-proacl mutation, which cannot be done as local `postgres`.
- `token mint` against a real human session, and production's `expires_at` in the mint event (by reading only).
- Whether Tom's live shell has `noclobber` set. The repo user's `~/.zshrc`, `~/.zprofile`, and `~/.zshenv` do not set it.

VERDICT: PASS
