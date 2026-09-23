I'll review the edge-memory observe lane as a read-only second arm: the diff against `origin/main`, the evidence docs, and the request path, then run only the pure tests the lane names.The lane is at `004b822f`, one docs commit after the fold Opus reviewed. I'll read the request path, timers, and the claims those docs make.The retry test named for `create` still passes after this lane removed the call it searches for. That is a rigour failure. The request path itself still delegates to the same create-and-fetch retry.

## Finding

**R1 — RIGOUR.** `tests/p1-cli/edge-runtime-box.test.ts:514` is named `main service retries WorkerAlreadyRetired around create and fetch`. Its create check no longer looks at the call the main service makes.

```528:532:tests/p1-cli/edge-runtime-box.test.ts
  assert.ok(
    main.indexOf("EdgeRuntime.userWorkers.create", retryStart) <
      fetchInsideRetry,
  );
```

`deploy/edge-runtime/main/index.ts` contains `EdgeRuntime.userWorkers.create` zero times. The retry now calls `workerObserver.create`:

```113:115:deploy/edge-runtime/main/index.ts
  return await withWorkerRetiredRetry(async (attemptNumber) => {
    const original = attemptRequests[attemptNumber];
    const worker = await workerObserver.create(route.functionName, {
```

`indexOf` from the retry start returns `-1`. `-1 < fetchInsideRetry` is true, so `assert.ok` passes whether or not create sits inside the retry. I ran `node --import tsx --test tests/p1-cli/edge-runtime-box.test.ts`: 17 pass, including this one. `worker.fetch` is still checked as the last statement of the callback. The create half of the name is not.

The current source does keep `workerObserver.create` inside that callback (the call is between the retry start and `worker.fetch`). The test would not catch a later move of create outside it.

## Checks that hold

Request handling for the five functions is the same shape as `origin/main`. `router.ts`, the five function trees, both Caddy files, and `compose.yaml` are unchanged. `handle()` still answers `/health`, then `resolveGatewayRequest` (bare `/functions/v1`, unknown name, known `OPTIONS` preflight) before any worker. `/_internal/metric` is not a branch; the gateway returns `Function not found` with `access-control-allow-origin: *`. Inside the retry, the options object is still `servicePath`, `memoryLimitMb` 96, `workerTimeoutMs` 150000, `noModuleCache: false`, and `envVars`. `createWorkerObserver` awaits `workers.create` and returns that handle; it does not catch. `WorkerAlreadyRetired` still retries once via `withWorkerRetiredRetry`. `InvalidWorkerCreation`, `WorkerRequestIdleTimeout`, and `WorkerRequestCancelled` still hit the same `isWorkerLimitError` branch and the 504 `WORKER_LIMIT` body.

The inventory timer sets `observingWorkers` before the await and clears it in `finally`, so polls do not overlap, and a rejected `memStats` does not reject the interval promise. `logRuntimeMetrics` catches `getRuntimeMetrics` and `JSON.stringify` failures. Both timer ids are cleared on `beforeunload`. In v1.73.13, `crates/base/src/worker/driver/managed.rs` dispatches that event on the main worker at termination, and `ext/runtime/js/http.js` listens for it. `http.js` passes `hostname: "0.0.0.0"` as `remoteAddr` for every request, which matches the README, RUNBOOK, and LANE Fold 1 note. On the success path `known` only keeps isolates still present in `memStats()`; ended keys are deleted. v1.73.13 `RuntimeMetrics` is heap counters plus `activeUserWorkersCount`, `retiredUserWorkersCount`, `receivedRequestsCount`, and `handledRequestsCount`. Worker lines are `event`, `functionName`, `workerKey`, `reason: null`, and `ageMs`. Neither log reads the request URL, headers, body, query, or `envVars`.

`deploy/edge-runtime/live-control.py` fails closed: assertions raise, and the `finally` runs `docker rm -f` for every `edgemem-live-<pid>-*` name it started. It is not in a package script. Its success lines match `docs/evidence/2026-09-23-edge-memory/live-control.txt`. I did not start a container. `npm run check:edge` exited 0 on the six entry points. The three new tests are in `tests/p1-cli/edge-runtime-box.test.ts`, which `test:p1-cli` globs, and each has a 5-second timeout. Their names match what they assert: log shape, one metrics record per sample, and the Caddy `/functions/v1` scope plus the gateway 404.

VERDICT: FAIL
