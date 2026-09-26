# Item G lane 2b landing: one watcher per seat through a server wake lease (2026-09-26)

Lane tip `511d7e22` (folds 1-19; the lane was recovered after the 2026-09-25 home deletion). Landing merge `92107eaf`
on main `20cc601b`: one merge commit whose tree is the reviewed resolution (below); main never holds the local
commit with conflict markers. Spec: `docs/design/2026-09-25-ITEM-G-LANE-2B-BRIEF.md`. Record: `LANE.md`. Non-blocking
findings: `FOLLOW-UPS.md` (copied into brain `app-backlog` at landing).

## What it does

- Table `swarm.agent_wake_leases` (migration `20260926000001_agent_wake_leases.sql`) and the command-edge commands
  `claim_wake_lease` and `renew_wake_lease` (session-fenced): one watcher per seat. A second watcher gets the stable
  refusal `notify_held_elsewhere` naming the host and the surface (watcher or H0 poll); a superseded watcher exits
  with `wake_lease_superseded`; `--take-over` claims a fresh lease; a crashed predecessor on the same host is taken
  over without it. Transport errors never exit; the renewal runs on a timer. `resume` and `listen status` show the
  lease. Stop sentences come from one constant table and say what is true (refused, superseded, unknown, released).
- One lock module for every lock and gate in the client: owner records are published complete, removal is
  rename-then-verify, a lock is reclaimed only when its owner is dead, reused (pid start after the record's
  createdAt), foreign and aged, or unreadable and aged; a live owner is never removed.

## Release

This lane needs a BOX RELEASE (migration, command edge, read edge) before npm and the site; HezLead directs it and
Anvil runs it through `deploy/RELEASE-TO-BOX.md`. Precondition from the Strategist's ruling (2026-09-25): measure the
renew call on staging (p50/p95) and record it with the command-edge check budget in the timeout table before the box
release. A merge to main deploys nothing.

## Review

Makers: Codex gpt-6-sol (folds 1-19). Arms: Codex and Opus 5.5 each round; rounds 17 (fold 18) and 18 (fold 19)
PASS on both arms under the landing bar (earlier rounds: `LANE.md`). The merge with main after item M conflicted in six
files and ran as Alloy task `ed2ca787` (Maker Codex gpt-5.6-sol; its review packet exceeded 96 KB because of the
regenerated dispatch fixture, so no Alloy review ran). The lead checked the fixture mechanically: 1,330 rows in each
parent and in the result, no row added or lost, no argv changed, and all 337 rows that differ from both parents equal
the base plus both sides' usage additions minus both sides' removals. An Opus check of the code found one composed
defect: on a file system without hard links the lock module publishes a symlink lock and item M's connect preflight
refused it, so `cswarm mcp connect` failed on every run. Alloy task `511af083` fixed it (Maker Codex; Checker Grok 4.7
PASS, no findings; the preflight now accepts the lock module's own symlink form through the module's validator).

## Gates

At `92107eaf`, all through `scripts/run-gates.sh`:
- `gates` mode (05:34Z): build 0, npm test 1030/1032 with 2 docker-guarded skips and 0 fail, check:tests 0,
  check:edge 0, command-core diff 0, build-release 0, site build 0, `git diff --check` 0; OrbStack off before and after.
- `p1-cli` mode under HezLead's terms (started 05:36:05Z; pressure level 1, OrbStack off, no other wrapper run, no
  Maker): 1190 tests, 1183 pass, 6 skipped, 1 fail. The fail is the wrapper's own watchdog control: its nested
  p1-cli-mode wrapper refused to start (exit 3), most likely because memory pressure rose above level 1 after the
  control decided not to skip; the file alone passed 11/11 (both p1-cli controls pass). Blocked docker calls:
  `docker version --format …` and `docker image inspect caddy:2.11` (6 calls); skipped docker-guarded tests: pg_cron
  schedules, the N-db freeze, the target marker, the Caddy 2.11 route and adapt tests, the database pass file test.
  OrbStack before=no, after=no.
- Server suite, GitHub Actions run 36221218080 at `92107eaf`: 271 of 273. The two failures are the ones main's baseline
  shows (run 36214115638 at `54900214`): item L's test pins Storage's 409 body (supabase CLI 2.118.0 adds `code`), and
  `h0-poll-ack` "an aborted waiting poll frees the slot for another seat" (subtest 14 here because this lane adds H0
  tests). The lane's nine new server tests pass (273 tests against main's 264).
