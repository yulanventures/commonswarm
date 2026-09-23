# Checker review, round 2: lane/edge-memory-observe @ a2a966be (Claude Opus arm)

Base: origin/main = merge-base ba42394f. Fold diff 89ca9a5f..a2a966be: 8 files, +352/-86.
Lane diff origin/main...a2a966be: 11 files, +1120/-4.
Method: read-only git; the local image `public.ecr.aws/supabase/edge-runtime:v1.73.13`
(sha256:cfa86b9a…, not pulled); throwaway containers named `opusrev2-*` (all removed,
0 left); a scratch copy of `deploy/edge-runtime/live-control.py` with only three changes:
the container prefix (`opusrev2-<tag>-<pid>`), the lane tree path (from `git archive`), and
two extra print lines to show the metrics line. `origin/main` still was ba42394f.
The v1.73.13 source was read with `gh api` (github.com only). No production host was
contacted. No repo file was edited. Scratch files were removed.

## Round-1 findings: status

### F1 (timer kept the main worker alive for 70 s): FIXED, measured
`deploy/edge-runtime/main/index.ts:45` and `:60` keep the two timer ids, and `:66-69`
clears both on `beforeunload`. I ran the lane's live control three times in parallel, with `docker stop -t 80`:

| tree | lane stop | mutant (clears removed) stop | 70 s diagnostic | exit |
|---|---:|---:|---|---:|
| a2a966be | 0.3 s | 70.2 s | present | 0 |
| a2a966be with only the two `clearInterval` lines removed | 70.2 s | not reached | n/a | 1 (`lane stop took 70.2s`) |
| origin/main baseline in the same runs | 0.3-0.4 s | n/a | n/a | n/a |

The claim "stop 0.3 s; without the clears 70.3 s" holds (I measured 0.3 s and 70.2 s).

### F2 (loopback guard got 0.0.0.0; route always 404; false claims): FIXED in code, one claim left
- The route and guard are removed (`observability.ts` has no `localMetricsResponse`;
  `index.ts:95-100` `handle()` has no metrics branch). Live: `GET /_internal/metric` on the
  lane gives 404, `Function not found`, `access-control-allow-origin: *`, which is
  byte-equal to origin/main (request 12 of the matrix).
- The metrics line exists live: one `edge_runtime_metrics` record inside the first 60 s.
  I read the full line. It holds only `mainWorkerHeapStats` (10 numbers),
  `eventWorkerHeapStats: null`, and four counters (`activeUserWorkersCount`,
  `retiredUserWorkersCount`, `receivedRequestsCount`, `handledRequestsCount`). It holds no
  URL, header, body, env value, or key. It is 484 bytes. At 1,440 lines per day that is
  about 0.7 MB per day. The RUNBOOK filter (`RUNBOOK.md:180-183`) extracts it from the real
  log (1 of 1).
- README.md:14-20, RUNBOOK.md:175-183, index.ts comments and the test name
  (`tests/p1-cli/edge-runtime-box.test.ts:89`, `:102`) are now correct. `git grep` at
  a2a966be for `localMetricsResponse`, `RUNTIME_METRICS_PATH`, `peerHostname`,
  `socket peer`, `remoteAddr`, `/dev/tcp`, `_internal/metric`, `curl` finds no false
  statement in README, RUNBOOK, code, or tests. It finds the one below (R1) and the note (R2).

### F3 (no live control): FIXED, and the control can fail
`deploy/edge-runtime/live-control.py` runs on the pinned image with the compose flags. I
re-ran it (fold tree): exit 0, with every line of `docs/evidence/2026-09-23-edge-memory/live-control.txt`
reproduced: 12/12 match origin/main; 4 unique start keys, one line each; 1 end line
(key `fdaca0aa…`, `ageMs` 4369, equal to the runtime's `memory limit reached … isolate: fdaca0aa…` line);
1 metrics line; lane stop 0.3 s; mutation 70.2 s with the diagnostic.
Checks that fail, measured (both exit 1 with an `AssertionError`):
- With round-1's `main/` (89ca9a5f): exit 1 after 3 s at `request 12`
  (`'Function not found'` with ACAO != `'Not Found'` without ACAO).
- With the clears removed from the fold: exit 1 at `lane stop took 70.2s`.
So a failed check gives a non-zero exit (`assert` → uncaught `AssertionError` → exit 1;
the `finally` removes the containers).

## Request handling for the five functions: unchanged
`git diff origin/main...a2a966be -- deploy/edge-runtime/main/index.ts`: the only
request-path change is `EdgeRuntime.userWorkers.create(...)` → `workerObserver.create(name, ...)`
(index.ts:115), which calls `create` and logs a start line on a new key only. Live: the
12-case matrix (GET with query, POST with body, OPTIONS preflight, bare `/functions/v1`,
unknown function, `/other`, activity, PUT on h0, HEAD, `/health`, unknown OPTIONS,
`/_internal/metric`) is equal to origin/main on status, headers (without date and connection), and body.

## Gates I ran (from a `git archive a2a966be` copy)
- `node --import tsx --test tests/p1-cli/edge-runtime-box.test.ts`: 17 tests, 17 pass, exit 0.
- `deno check` on the six entry points in `check:edge`: exit 0.
- `git diff --check origin/main...a2a966be`: exit 0.

## Findings

### R1: RIGOUR: a false claim is left in LANE.md (blocks the fold's "every false claim corrected")
`docs/evidence/2026-09-23-edge-memory/LANE.md:28-29`:
"The pinned upstream image does not install `curl`; the runbook also gives an
installed-Bash `/dev/tcp` read." At a2a966be the runbook has no `/dev/tcp` read
(`git grep /dev/tcp a2a966be -- deploy/edge-runtime/RUNBOOK.md` → nothing; the fold removed it,
RUNBOOK.md diff at old lines 176-190). The sentence belonged to the removed metric route
(round-1 F2) and is now false. Fix: replace both sentences with "The metrics are in the log;
there is no HTTP read." or delete them. This is a doc-only change and does not change the
code SHA content.

### R2: RIGOUR (note, not blocking): research.md still tells the reader to read `/_internal/metric` on the box
`docs/evidence/2026-09-23-edge-memory/research.md:75` ("should be read off
`/_internal/metric` … on the box"), `:125` (recommendation 1: add that route), `:131` ("watch
`/_internal/metric` before/after"). This is a dated research record, so its text may stay,
but AGENTS.md "Corrections go in the artifact" asks for a short note where later readers
meet it: for example, under recommendation 1, "Implemented as a one-minute
`edge_runtime_metrics` log line; v1.73.13 cannot guard an HTTP route (see LANE.md Fold 1)."

### N1: nit: comment names the wrong actor
`deploy/edge-runtime/main/index.ts:64`: "the pinned runtime's Deno.serve shim dispatches
beforeunload". In v1.73.13, `ext/runtime/js/http.js:185,210` shows the shim *listens* for
`beforeunload` on the main worker (`shutdownEventName`). The runtime dispatches it. The
behaviour is measured correct. Only the verb is wrong.

## Not established
- Main-worker memory over hours with both timers running. I ran no soak test.
- Box log rotation. `deploy/edge-runtime/compose.yaml` sets no `logging:` options. The
  added volume is small (about 0.7 MB per day of metrics, plus two lines per worker life), but the
  box daemon's json-file rotation settings were not checked. This existed before the lane.
- Whether `beforeunload` also fires on the main worker for any reason other than shutdown.
  If it did, only observation would stop; requests would not change.
- The box's RSS trend compared with the new records (no box access, by design).

VERDICT: FAIL
