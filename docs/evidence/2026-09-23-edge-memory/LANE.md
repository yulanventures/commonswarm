# Edge memory, step 1: observe

## Change

- The main service records one JSON line for each newly seen worker isolate key and
  one when that key disappears from `EdgeRuntime.userWorkers.memStats()`. The line
  contains `event`, `functionName`, `workerKey`, `reason`, and `ageMs`. The key is
  the runtime isolate UUID, which can be compared with its wall-clock and
  early-termination lines. Reused handles do not produce new start records.
- Once a minute the main service logs `EdgeRuntime.getRuntimeMetrics()` in one
  `edge_runtime_metrics` JSON record. The pinned v1.73.13 API exposes this call;
  its `ext/workers/user_workers.js` exposes `worker.key` and `memStats()`.
- The existing main router still maps only `command`, `read`, `capability`,
  `activity`, and `h0` under `/functions/v1`. Both Caddy route sets proxy only
  `/functions/v1` and `/functions/v1/*` to port 9000. Compose publishes that
  port on host loopback. The metrics route was removed after the pinned runtime
  proved unable to provide the actual socket peer to its main-service handler.
- `npm run check:edge` now checks the main-service entry point as well as the
  five function entries. Three new timeout-bound tests in the existing
  `tests/p1-cli/edge-runtime-box.test.ts` verify log shape with a stub worker
  API, metrics log shape, and Caddy plus five-function route scope.

## Reading on the box, after release by its operators

`deploy/edge-runtime/RUNBOOK.md` has the exact `docker logs | jq` filters.
Compare `retiredUserWorkersCount` and
`activeUserWorkersCount` with those keyed log records and container RSS over
time. The pinned upstream image does not install `curl`; the runbook also gives
an installed-Bash `/dev/tcp` read. This lane did not contact the box.

## What this does not change

The image, `per_worker` policy, parallelism, worker memory and time limits,
function source, request forwarding, retry behavior, and public Caddy routes
are unchanged. Inventory sampling observes workers every five seconds. It does
not create or retire them.

## Local verification and limits

| Gate | Exit | Count |
|---|---:|---|
| `npm run build` | 0 | 1 TypeScript build |
| `env -u FORCE_COLOR npm test` | 1 | 897 tests: 895 pass, 2 fail |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 842 tests: 824 pass, 18 fail |
| `npm run check:tests` | 0 | 1 test TypeScript project |
| `npm run check:edge` | 0 | 6 Deno entry points: 5 functions and main service |
| focused `edge-runtime-box.test.ts` | 0 | 17 tests: 17 pass |

The two `npm test` failures require `ps`, whose child process is rejected with
`spawn EPERM` here. The CLI suite's 18 failures include `ps` and home-directory
hook-lock `EPERM` errors and credential-store warning output that tests expected
to be empty. The focused edge test passed both alone and in the CLI suite. No
production service was probed to resolve unrelated sandbox failures.

The v1.73.13 main-worker API does not expose a user-worker retirement callback or its
reason. End records therefore mean disappearance seen at the next poll;
`reason` is `null`, and `ageMs` is measured from the first returned create
handle, not the internal Rust start time. A worker that ends before the main
service ever receives its key cannot be attributed. This lane did not establish
per-function retirement rates, a memory-leak root cause, or whether the new
metric and logs match the box's RSS trend under live traffic.

## Fold 1 — shutdown and metrics correction

The main worker now clears both the five-second inventory timer and the
one-minute metrics timer on `beforeunload`. The latter writes one JSON record
with `event: edge_runtime_metrics` and the runtime metrics; it does not serve
metrics over HTTP. One-minute sampling produces at most 1,440 records per day
and keeps metric collection off the request path. The pinned runtime supplies
`0.0.0.0` as `remoteAddr.hostname` to the main-service handler, so the former
loopback guard could not work. `/_internal/metric` again takes the ordinary
`Function not found` response with function CORS.

`deploy/edge-runtime/live-control.py` requires Docker and the locally present
`public.ecr.aws/supabase/edge-runtime:v1.73.13` image. It uses only throwaway
`edgemem-live-*` containers, removes them on exit, and is not part of `npm test`.
The saved output is `live-control.txt`: twelve request cases matched
`origin/main` on status, headers, and body; worker start and end lines appeared;
a metrics line appeared within one timer period; normal stop took under one
second; and removing the timer clears in a temporary mutation restored the
70-second shutdown delay and runtime diagnostic. This is a local live control,
not a box or long-duration memory measurement.

| Fold 1 gate | Exit | Count |
|---|---:|---|
| `npm run build` | 0 | 1 TypeScript build |
| `env -u FORCE_COLOR npm test` | 1 | 897 tests: 895 pass, 2 fail |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 842 tests: 824 pass, 18 fail |
| `npm run check:tests` | 0 | 1 test TypeScript project |
| `npm run check:edge` | 0 | 6 Deno entry points |
| `live-control.py` | 0 | 12 request cases, 1 metrics record, 1 worker end, 1 shutdown mutation |
| `git diff --check origin/main...HEAD` | 0 | 1 branch diff |
| `docker ps -a --filter name=edgemem-live` | 0 | 0 containers remaining |

The two `npm test` failures and eighteen CLI-suite failures match the prior
lane's sandbox failures: `ps` is denied with `spawn EPERM`, and the CLI suite
also encounters hook-lock `EPERM` and credential-store warning output. The
focused edge test has 17 passes. This fold has not established the box's RSS
trend, long-running observer memory cost, or the leak's root cause.
