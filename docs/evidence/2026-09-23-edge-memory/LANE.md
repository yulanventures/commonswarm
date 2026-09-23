# Edge memory, step 1: observe

## Change

- The main service records one JSON line for each newly seen worker isolate key and
  one when that key disappears from `EdgeRuntime.userWorkers.memStats()`. The line
  contains `event`, `functionName`, `workerKey`, `reason`, and `ageMs`. The key is
  the runtime isolate UUID, which can be compared with its wall-clock and
  early-termination lines. Reused handles do not produce new start records.
- `GET /_internal/metric` returns `EdgeRuntime.getRuntimeMetrics()` for a socket
  peer of `127.0.0.1` or `::1` inside the container. Other peers get 404 without
  reading metrics. The pinned v1.73.13 `types/global.d.ts` and example main
  service expose this API; its `ext/workers/user_workers.js` exposes `worker.key`
  and `memStats()`.
- The existing main router still maps only `command`, `read`, `capability`,
  `activity`, and `h0` under `/functions/v1`. Both Caddy route sets proxy only
  `/functions/v1` and `/functions/v1/*` to port 9000. Compose publishes that
  port on host loopback. The metric route also checks the actual socket peer,
  not the request Host header.
- `npm run check:edge` now checks the main-service entry point as well as the
  five function entries. Three new timeout-bound tests in the existing
  `tests/p1-cli/edge-runtime-box.test.ts` verify log shape with a stub worker
  API, metric peer gating, and Caddy plus five-function route scope.

## Reading on the box, after release by its operators

`deploy/edge-runtime/RUNBOOK.md` has the exact `docker logs | jq` filter and
container-loopback metric commands. Compare `retiredUserWorkersCount` and
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

The v1.73.13 main-worker API does not expose a worker shutdown callback or its
reason. End records therefore mean disappearance seen at the next poll;
`reason` is `null`, and `ageMs` is measured from the first returned create
handle, not the internal Rust start time. A worker that ends before the main
service ever receives its key cannot be attributed. This lane did not establish
per-function retirement rates, a memory-leak root cause, or whether the new
metric and logs match the box's RSS trend under live traffic.
