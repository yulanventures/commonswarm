# Item M landing: a crashed `cswarm mcp connect` recovers its seat (2026-09-26)

Lane tip `49c6eefd` (folds 1-18; the lane content was recovered as `362de306` after the 2026-09-25 home deletion),
merged with main as `b4cbfb0a` (on `aec203a4`), `cea27c4b` (on `54900214`, the no-docker gate wrapper) and `2424d84d`
(on `d77d1020`, the p1-cli wrapper mode), with one fix between them: `86446769` (AS1, below). The landing is `2424d84d`
plus this evidence commit. Spec: `docs/design/2026-09-25-ITEM-M-CRASH-SAFE-CONNECT-BRIEF.md`. The
Maker's record, fold by fold, is `LANE.md` here; arm outputs for round 19 are in `arms/`; non-blocking findings are in
`FOLLOW-UPS.md`.

## What it does

- Before the register POST, `mcp connect` writes a pending record (0600, in the profile's 0700 directory) with the
  `attemptId`, the target, the agent name, and an HMAC of the code keyed with the `attemptId`. It holds no secret.
- A rerun after a crash at any point resumes: the same code re-registers with the same `attemptId`, and the server
  returns the same seat with a fresh token (the unused one is revoked), so one code gives one seat. A different code,
  a used token, or an expired code gets a typed refusal with the revoke and clear steps, generated from constants.
- The files are written credential, profile, then the pending record is removed; each crash state in between is one
  the rerun recognizes. A directory with a pending record and a credential but no profile is an interrupted connect,
  not an occupied path. `register_outcome_unknown` now says to rerun the same command with the same code first.
- No server change (the server's same-`attemptId` retry already existed; `tests/p1-server/agent-join-credential.test.ts`
  gains the lost-response case).

## Release

Client only: no migration and no edge change. It ships in the next npm release built from main.

## Review (D-036)

Maker: Codex gpt-6-sol, 18 folds. Arms: Opus 5.5 with Grok 4.7 (rounds 1-7), then Opus 5.5 with Codex gpt-6-sol
(rounds 8-19). The loop did not converge (every round found a new edge; brain `operating-model`,
"Review convergence rule"), which produced the 2026-09-26 landing bar: only a verified, in-scope or lane-introduced
PRODUCTION finding blocks.

Round 19 at `49c6eefd`: Opus PASS; Codex FAIL with two items, ruled by the lead:
- Item 1 (the generic `withFileLock` creates the lock before writing its owner): pre-existing on main, and lane 2b
  replaces that module. Not lane-introduced; FOLLOW-UPS item 2.
- Item 2 (the exclusive fallback claim is not chmodded, so with a umask that masks the owner write bit and no hard
  links, a kill in that window leaves a 0400 claim and the rerun refuses with `connect_credential_mode`): real, but
  it needs all three conditions and ends in a typed refusal, not a lost seat. Fixed on `lane/item-m-fold19`
  (`c8b6f845`, AK1), which lands after its own scoped review; FOLLOW-UPS item 1.

## A defect found by Actions: AS1

The p1-cli run in GitHub Actions (run 36214107768, Node 22.23.2) showed that the home control
`tests/p1-cli/mcp-connect-home-control.test.ts` passed `--test-isolation=none`, which Node 22.23.2 rejects ("bad option",
exit 9). The repository supports Node 22 and newer; the mini runs Node 26, so it had passed here. `86446769` (Codex
Maker) reads `node --help` of the running binary and passes the name it lists (`--test-isolation=none`, or
`--experimental-test-isolation=none` on Node 22); a reverted fixture made the control fail. Node 22 itself is not
available on the mini (its Homebrew build is broken), so the Node 22 path is proven only by the help text rule.

## Gates

All local runs go through `scripts/run-gates.sh` (temporary HOME, real-home check, docker stand-ins).

At `2424d84d`, `gates` mode: build 0, check:tests 0, check:edge 0, command-core diff 0, build-release 0, site build 0,
`git diff --check` 0; npm test 987/990 with 2 docker-guarded skips and 1 fail, "cancelling an in-flight stdout
inspection kills its lsof child" (the lsof fixture did not start within 1 s under load); `tests/p1-cli/resume.test.ts`
alone: 20/20.

At `2424d84d`, `p1-cli` mode (HezLead's terms of 2026-09-26): started 04:10:05Z with memory pressure level 1, OrbStack
off, no other wrapper run and no Maker running. 1094 tests: 1085 pass, 8 skipped, 1 fail. The fail is the wrapper's own
docker control, whose nested home check saw `~/.cswarm/agents/…/292be0f9-…/78249a33-…/check.lock` appear during its
5 s run: an external write by another session's turn check (seat 78249a33, workspace 292be0f9), not by these tests,
which ran under the temporary HOME; the outer run's home check was clean. The file alone: 11/11. Memory pressure rose
to level 2 during the run (so the two p1-cli-mode controls skipped). Docker calls blocked by the stand-ins (listed as
NOT RUN): `docker version --format {{.Server.Version}}` and `docker image inspect caddy:2.11`, 6 calls in all; skipped
docker-guarded tests: pg_cron schedules, the N-db freeze, the target marker, the Caddy 2.11 route and adapt tests, the
database pass file test. OrbStack running: before=no, after=no.

Server suite, GitHub Actions: at `b4cbfb0a`, run 36212518314, 262/265; main baseline at `54900214`, run 36214115638,
262/264 with the same two failures (item L's Storage 409 body pin and h0 subtest 12), so both are pre-existing; F7
failed once in M's run and passed on main (a flake; see FOLLOW-UPS item 4). Between `b4cbfb0a` and the landing, no file
under `supabase/`, `src/protocol/` or `tests/p1-server/` changed (main's merges touched the gate wrapper, the manual
workflow and site pages; AS1 changed one p1-cli test), so that result stands for the landing.

## Follow-ups

See `FOLLOW-UPS.md` (copied into brain `app-backlog` at landing).
