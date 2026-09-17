# Timeout table landing (2026-09-17)

Lane `lane/timeout-table`, tip **d970c354**, landed with `git merge --no-ff`. Strategist gate after the 2026-09-16 edge
cutover rollback: every client timeout must be at least twice the p95 of what it guards, measured through
edge-staging.commonswarm.com before the N-db window. This is a measurement tool; it changes no shipped client code.

## What it does

`scripts/timeout-table/enumerate.mjs` lists every timeout site in `src/` and `site/src/` (ids are `file:name#ordinal`, not
line numbers). `mapping.json` maps each site to a measurable operation, exactly, once per measured ref (`v0.1.71`, the
released CLI; `HEAD`/`main`, the next release). `run.mjs --ref <ref> --client <cswarm> --base-url <origin>` checks the
ref out in a temporary worktree, copies only the profile and credential files into a 0700 directory, points every state
and config directory variable inside it, blocks any origin but the target and any write, runs each operation 20 times,
and renders the table. A row PASSes only when the measured operation exercises the guarded path and headroom is at least
2; a row whose operation covers only part of the path is NOT MEASURED and must be acknowledged, unless its measured part
already fails, which is a FAIL. Any FAIL or unacknowledged NOT MEASURED exits non-zero. The copy and the worktree are
removed on return, throw, SIGINT, SIGTERM, SIGHUP, and an unexpected exit.

## Commits and authors

75f2c8d6, 502ac8cf, 8bfbfd3d (Codex); a2c60c62 (lead: pause timer); 5758a351, dcb041c0, 18241582, 90bec239, 9860904b,
d970c354 (Grok Maker). Strategist ruling: three author families, so antigravity reviewed the whole lane and Grok's commits
on their own, and grok reviewed the whole lane.

## Review

| round | SHA | grok | antigravity |
|---|---|---|---|
| 1 | dcb041c0 | FAIL (inbox posted receipts; unmapped timeouts) | FAIL |
| 2 | 18241582 | FAIL (check_timeout exited 0) | FAIL (2 of 9 parts) |
| 3 | 90bec239 | FAIL (an acknowledged row hid a failing lower bound) | FAIL (1 of 10 parts) |
| 4 | 9860904b | PASS with one PRODUCTION note (inherited state directories) | PASS 8 of 10; both FAILs refuted by the lead with direct runs |
| 5 | d970c354 | PASS | PASS (10 of 10) |

Every claim and ruling is in `scripts/timeout-table/README.md` ("Review round 1" to "Review round 4"). Arm outputs of rounds
4 and 5 are in `arms/`.

## Gates at d970c354

build 0; `npm test` 878 pass; timeout-table test 15 pass; `check:tests` 0; `git diff --check` 0 (Grok Maker);
`test:p1-cli` 796 pass and `scripts/build-release.sh` 0 (lead).

## Not established

- No run against edge-staging or production yet; the N-db rehearsal runs it through edge-staging (runbook step 11).
- The shipped `cswarm` binary as `--client` over 20 runs; cold-start p95 (20 sequential runs are a warm window).
- A SIGKILL leaves the copy behind (Node runs no exit handler).
