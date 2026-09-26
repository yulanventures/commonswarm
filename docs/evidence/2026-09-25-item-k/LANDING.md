# Item K landing: CLI help from the command table, `cswarm profile ls`, and `inbox --since` (2026-09-26)

Lane tip `a3f7bbd4` (folds 1-11). Landing merge `857675a0` on main `d4677b0d`: one merge commit whose tree is the
reviewed resolution plus its fixes (below); main never holds the local commit with conflict markers. Spec:
`docs/design/2026-09-25-ITEM-K-CLI-HYGIENE-BRIEF.md`. Record: `LANE.md`. Non-blocking findings: `FOLLOW-UPS.md`
(copied into brain `app-backlog` at landing).

## What it does

- `cswarm --help`, every `<verb> --help` and the usage block printed with a refusal are generated from the command
  table the parser enforces (`AGENT_COMMANDS`), so help and the parser cannot drift; a test fails when they do.
- `cswarm profile ls` lists every agent profile on the host (from a registry that each profile save updates), with
  seat, workspace and path; the bare-UUID `--profile` refusal shows an example.
- `inbox --since` and `check` return the same directed ask (a server control); a capped `inbox --since` read says more
  messages may remain and prints a follow step that is runnable as printed and carries the flags the user typed.

## Release

Client only: no migration, no edge change (one new server test). It ships in the next npm release.

## Review

Makers: Codex gpt-6-sol (folds 1-11). Arms: Codex and Opus 5.5 each round; round 11 (fold 11) PASS on both arms.
Merge with main after items M and G lane 2b (eight conflicted files): Alloy task `c429ac7f` (Maker Codex; its review
packet was over 96 KB because of the re-recorded dispatch fixture, so no Alloy review ran). An Opus check of the
resolution found one blocker (main's `listen status --wait` refusal and its refusal order were lost) and two help
lines no side intended; Alloy task `05f1422a` fixed them (Checker Grok 4.7 PASS) with a test through the real parser.
The landing p1-cli run then found two test failures from the merge (K's home inventory missed the new test file; an
MCP stdio test assumed `~/.cswarm` absent, but K's profile registry creates it by design); Alloy task `334a7228` fixed
both, tests only (Checker Grok 4.7 PASS).

The lead re-recorded the dispatch fixture with its recorder and checked it: K's baseline test masks generated help, so
K's fixture had kept the old hand-written text; with help masked every main row equals main and every K row equals K;
against the reviewed resolution only the help lines the fix changed moved; the baseline test passes 10/10.

## Gates

At `857675a0`, all through `scripts/run-gates.sh`:
- `gates` mode (08:14Z): build 0, npm test 1030/1032 with 2 docker-guarded skips and 0 fail, check:tests 0,
  check:edge 0, command-core diff 0, build-release 0, site build 0, `git diff --check` 0; OrbStack off before and after.
- `p1-cli` mode under HezLead's terms (started 08:15:47Z; memory pressure level 1, OrbStack off, no other wrapper run,
  no Maker): 1250 tests, 1243 pass, 6 skipped, 1 fail. The fail is the wrapper's own watchdog control, and it is a
  defect in the wrapper on main, not in this lane: in a full p1-cli run the outer wrapper's watchdog subshell carries
  the wrapper's command line and is not an ancestor of the nested run, so the nested p1-cli-mode wrapper counts it as
  another run and refuses (exit 3); the file alone passes 11/11. Fixed separately on main. Blocked docker calls:
  `docker version --format …` and `docker image inspect caddy:2.11` (6 calls); skipped docker-guarded tests: pg_cron
  schedules, the N-db freeze, the target marker, the Caddy 2.11 route and adapt tests, the database pass file test.
  OrbStack before=no, after=no.
- Server suite, GitHub Actions run 36227395973 at `198edce0` (the landing tree before fix 2, which changed only three
  p1-cli test files and this record): 272 of 274; the two failures are main's baseline ones (item L's Storage 409 pin;
  `h0-poll-ack` "an aborted waiting poll frees the slot for another seat"); K's new server test "check and inbox
  --since return the same directed ask across timestamps, filters, and default paging" passes.
