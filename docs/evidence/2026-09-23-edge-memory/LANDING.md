# Edge memory step 1 landing: observe (2026-09-23)

Branch `lane/edge-memory-observe` from main `ba42394f`, merged with `git merge --no-ff`. Not deployed: it reaches the
box only through an edge release with `deploy/RELEASE-TO-BOX.md`. It changes no limit, policy, image, route or request
behaviour; it adds observation so the memory growth can be tied to functions.

## What it does

- `deploy/edge-runtime/main/index.ts` logs one JSON line when the main service creates a user worker
  (`edge_worker_started`) and when a worker is seen to end (`edge_worker_ended`, detected by a 5-second inventory of
  `memStats` keys), with the function name, the worker key (the runtime's isolate id), `reason: null` (v1.73.13 gives
  none) and the worker's age; and one `edge_runtime_metrics` line per minute from `EdgeRuntime.getRuntimeMetrics()`
  (about 0.7 MB of logs per day). Both timers are cleared on `beforeunload`, so shutdown is unchanged.
- No HTTP route: in v1.73.13 the main service's `Deno.serve` handler gets `0.0.0.0` as the peer for every request,
  so a loopback guard cannot work. `/_internal/metric` gives the normal "Function not found".
- `deploy/edge-runtime/live-control.py` runs the main service in the pinned image and checks the request matrix
  against origin/main, the log lines, and the stop time (needs Docker and the local image; not part of npm test).
  Output: `live-control.txt`.
- Research on the cause, with sources: `research.md` (per_worker retires even idle workers at workerTimeoutMs/2; each
  retirement leaks a few MiB, upstream #719 and #740; a partial fix is in v1.74.0). Series: `edge-mem-series-*.csv`.

## Review (arms/)

| round | SHA | arm A | arm B | ruling |
|---|---|---|---|---|
| 1 | `89ca9a5f` | Opus FAIL (a timer kept the main worker alive: every restart hung all functions for 70 s; the loopback guard always got 0.0.0.0) | — (Grok out of quota) | fold 1 |
| 2 | `a2a966be` | Opus PASS on the code (one false doc sentence; lead text fix `004b822f`) | Grok FAIL, RIGOUR only (a test assertion that could not fail) | lead test fix `821783d9` with a mutation control; land |

Maker: Codex gpt-6-sol. Lead: the text fix and the test fix.

## Gates

At `a2a966be` (lead): build 0; npm test 897; test:p1-cli 842; check:tests 0; check:edge 0; diff-check 0. Live
control (Maker and Opus independently): 12 of 12 requests equal to origin/main; stop 0.3 s (70.2 s with the clears
removed). After `821783d9`: the edge test file 17 pass; its mutation (create call renamed) fails. The merged tree is
gated before the push.

## Next

1. Edge release to the box (HezLead/Anvil) with the next edge change or on its own; then a day of logs including
   daytime traffic.
2. Step 2 from the data: explicit cpuTime limits, a longer workerTimeoutMs, and an image bump to v1.74.0 or later with
   `EdgeRuntime.miCollect()`; then remove the recycle timer and the 2 GB cap if the growth stops.

## Not established

- The box's RSS trend against the new records; whether the observer itself changes memory over hours (no soak run).
