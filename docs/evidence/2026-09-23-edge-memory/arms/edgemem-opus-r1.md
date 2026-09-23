# Checker review — lane/edge-memory-observe @ 89ca9a5f (Claude Opus arm)

Base: origin/main = merge-base ba42394f. Diff: 9 files, +857/-7.
Method: read-only git. v1.73.13 source fetched with `gh api .../contents/<path>?ref=v1.73.13`
(ext/runtime/js/http.js, ext/workers/user_workers.js, ext/workers/lib.rs,
crates/base/src/worker/pool.rs, crates/base/src/server.rs, types/global.d.ts, examples/main/index.ts).
Throwaway containers of the local image `public.ecr.aws/supabase/edge-runtime:v1.73.13`
(named `opusrev-edgemem-*`, all removed), with the compose flags (per_worker,
--max-parallelism 4, --graceful-exit-timeout 70), the lane's or origin/main's
`deploy/edge-runtime/{main,bootstrap.sh,h0-deno.json}`, and five stub functions.
No production host contacted. No repo file edited. Scratch removed.

## F1 — PRODUCTION: the 5-second timer makes every stop take the full 70 s graceful-exit deadline, and requests hang during it

`deploy/edge-runtime/main/index.ts:45-55` starts a `setInterval` and never clears it.
In v1.73.13, `server.rs` on SIGTERM cancels the graceful-exit token and then
`termination_tokens.terminate()` waits for the main worker. A live interval keeps the
main worker alive, so the wait runs to `--graceful-exit-timeout 70`.

Measured (same harness, `docker stop -t 80`, run in parallel):

| container | stop seconds | "did not able to terminate the workers within 70 seconds" |
|---|---:|---:|
| origin/main main service, 1 request | 0 | 0 |
| origin/main, no requests | 0 | 0 |
| lane 89ca9a5f, 1 request | 70 | 1 |
| lane 89ca9a5f, no requests | 70 | 1 |
| lane with only the `setInterval` block removed | 0 | 0 |
| lane + `addEventListener("beforeunload", () => clearInterval(timer))` | 1 | 0 |

During the lane's drain (3 s after `docker kill -s TERM`), both
`GET /functions/v1/command/a` and `GET /health` hung and timed out after 5 s with 0 bytes.
So every `docker compose -p commonswarm-edge up -d edge-runtime` that recreates the
container (RELEASE-TO-BOX.md Apply and Rollback) or any restart becomes a ~70 s
window in which all five functions hang, instead of ~0 s. This contradicts
LANE.md "change no ... request behaviour" and the task's "stops cleanly on shutdown".
Fix direction (measured above): keep the timer id and clear it on the main
worker's `beforeunload` event (the runtime's own `Deno.serve` shim uses that event
for the main worker, `http.js` `shutdownEventName`). Add a test that names this.

## F2 — PRODUCTION (feature not delivered) + RIGOUR (false claims): the loopback guard never sees the socket peer; `/_internal/metric` always returns 404

`index.ts:120-121` passes `info.remoteAddr.hostname` to the guard at
`observability.ts:78`. In v1.73.13, `Deno.serve` is the runtime's shim
(`ext/runtime/js/http.js` `serve()`/`respond()`), which calls the handler with
`{ remoteAddr: { port: options.port, hostname: options.hostname, transport } }`,
where `options.hostname` is the constant `"0.0.0.0"` of its internal listener. It is
not the peer.

Measured with a one-line probe main service (`Deno.serve((req, info) => Response(JSON.stringify(info)))`):
from the host through the published port and from inside the container over
`/dev/tcp/127.0.0.1`, both return `{"remoteAddr":{"port":9999,"hostname":"0.0.0.0","transport":"tcp"}}`.
On the lane container, the RUNBOOK's own Bash command (RUNBOOK.md:189) returns
`HTTP/1.1 404 Not Found` / `Not Found`. From the host, with and without
`X-Forwarded-For: 127.0.0.1` and `Host: 127.0.0.1`, it also returns 404.

Consequences:
- Security: it fails closed. No header, Caddy, or host process can get metrics. Caddy
  (both `deploy/supabase-stack/*.caddy`) proxies only `/functions/v1 /functions/v1/*`
  to 127.0.0.1:9000, and Caddy's path matcher cleans the path before matching.
  On the box, Caddy's connection would arrive from the `commonswarm-net` bridge
  gateway through Docker's port publishing, not from 127.0.0.1. But that is moot:
  the guard gets `0.0.0.0` for every request.
- The metric part of the lane does nothing. The RUNBOOK commands at RUNBOOK.md:181 and
  :189 cannot return metrics. `curl` is not in the image (checked:
  `command -v curl` → none). The comparison step at the RUNBOOK end cannot be done.
- False claims that must be corrected in the artifact: README.md:14-18 ("only when
  the socket peer is 127.0.0.1 or ::1"), RUNBOOK.md:173-176, LANE.md:10-12 and
  :18-19 ("checks the actual socket peer"). The test name at
  tests/p1-cli/edge-runtime-box.test.ts:89 says "accepts only a loopback socket
  peer". It passes a peer string to a pure function. It cannot show where the string
  comes from, and in the runtime it is a constant.
- Fix direction: the v1.73.13 main-service API gives no peer address, so a peer
  guard cannot work on this image. The simplest safe form has no route: log
  `await EdgeRuntime.getRuntimeMetrics()` as one JSON line on a slow timer (with the
  F1 shutdown fix), and read it with the same `docker logs | jq` filter.
- Minor side effect: a request for `/_internal/metric` now gets `Not Found` (text/plain,
  no ACAO). Before, it got `Function not found` with ACAO `*`. Caddy cannot route that
  path, so no public client sees the change.

## F3 — RIGOUR: LANE.md "Local verification" does not name a gate that exercises the runtime

`deno check` passes with `info.remoteAddr.hostname` because Deno's types describe
real Deno, not the edge-runtime shim. The three new tests are pure-function tests
and a Caddy-text test. None loads `main/index.ts` in the runtime, so F1 and F2 both
passed every listed gate. The lane needs one live control on the pinned image, as
AGENTS.md "A claim about a running listener needs a live control" requires.

## What holds (established)

- Request handling for the five functions is unchanged. I sent an 11-request
  matrix to origin/main and lane containers and diffed status, headers, and body
  (dates stripped): IDENTICAL. The matrix covered GET with a query on command,
  POST with a body on read, OPTIONS preflight on capability, `/functions/v1`,
  an unknown function, `/other`, activity, PUT on h0, HEAD, `/health`, and
  OPTIONS for an unknown function.
- Worker-limit path: a function that passes the 96 MiB limit returns 504 on both
  base and lane. The next request got 200 on a new worker.
- The retry path is unchanged by code reading. `workerObserver.create` wraps only
  `userWorkers.create` and rethrows its errors. `withWorkerRetiredRetry` and the
  clone logic are untouched (index.ts:104-117).
- Worker logs work on v1.73.13 (measured). There was one `edge_worker_started` per
  new key. Reuse (GET then HEAD on command) gave no second line. OPTIONS started no
  worker. After the memory kill, `edge_worker_ended` for key 87122bbf-... came with
  `ageMs` 6874 on the next poll. The key equals the runtime's own
  `memory limit reached for the worker: isolate: 87122bbf-...` line.
- The APIs exist in v1.73.13. `user_workers.js` has `UserWorker.key`, and static
  `memStats()` → `op_user_worker_mem_stats`. `global.d.ts` declares
  `getRuntimeMetrics()`, and `examples/main/index.ts` serves `/_internal/metric`
  with it. `memStats` returns `HashMap<Uuid, ...>`, which serde_v8 turns into a
  plain object keyed by UUID string. The observer's `Object.hasOwn` branch
  handles that.
- No false "ended" from a race. `pool.rs` sends `UserWorkerMsgs::Created` to the pool
  channel before it answers `create`, and `InqueryMemoryUsage` goes through the same
  ordered channel.
- Timer cost: `memory_usage` in pool.rs clones cached `mem_check` values under a
  read lock in `spawn_blocking`. It does not touch the isolates, so it cannot extend
  or retire a worker. The `observingWorkers` flag stops overlap. The callback catches
  everything, so there is no unhandled rejection. After the pool loop ends, the
  oneshot is dropped, the op rejects, and the catch handles it. `known` holds only
  live keys and keys that ended since the last poll. It grows without limit only if
  `memStats` rejects every time, and then by one entry per worker created.
- The logs carry no secret. The fields are `event`, `functionName`, `workerKey`
  (isolate UUID), `reason: null`, and `ageMs`. There is no URL, query, header, or
  body in them.
- The RUNBOOK `docker logs ... | jq -R 'fromjson? | select(...)'` filter extracts
  the records from real container logs (measured). A bare-number log line prints a
  jq error and jq goes on. This is cosmetic.
- Gates: the focused test file runs under `test:p1-cli` (glob
  `tests/p1-cli/**/*.test.ts`), 17/17 pass in a temporary `git archive` copy.
  `deno check` on the six entry points, from the same copy, exits 0.

## Not established

- Whether the timer or the logs change main-worker memory over hours. I ran no
  long soak. The box RSS trend was not compared (and could not be, per F2).
- The exact peer address Docker gives Caddy traffic on the box. It does not affect
  the ruling, because the runtime never exposes a peer (F2).
- Pre-existing, outside this lane: compose.yaml has `mem_limit: 512m`, and
  RELEASE-TO-BOX.md:1118 asserts 2147483648. I did not check which one the box
  runs.

VERDICT: FAIL
