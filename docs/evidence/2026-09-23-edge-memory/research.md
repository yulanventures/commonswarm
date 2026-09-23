# edge-runtime memory growth — research (read-only, no server touched)

## Summary

The 6-hourly restart is very likely covering two separate, both-known, both-currently-unfixed problems in `supabase/edge-runtime`:

1. **Idle workers are recycled on a fixed wall-clock timer, not on activity.** Under `--policy per_worker`, the supervisor retires *every* worker — busy or idle — at **half of `workerTimeoutMs`**, i.e. every 75 s for the box's `workerTimeoutMs: 150_000`. This is read directly from the runtime's own supervisor source. With five functions each keeping one warm worker overnight, that math alone reproduces the measured ~4.1/min "early termination"/"wall clock" rate almost exactly (5 workers × 60/75 s ≈ 4.0/min vs. measured 4.07/min).
2. **Each worker retirement leaks a few MiB of native (mimalloc/V8) memory that a container restart is currently the only way to reclaim.** This is an open, unresolved upstream issue (`supabase/edge-runtime#740`, `#719`), reproduced independently by two different reporters on recent versions, including v1.74.3. Nobody — including Supabase — has landed a real fix; the only mitigation shipped so far is a manual purge API (`EdgeRuntime.miCollect()`, added in v1.74.0), which the box's current image (v1.73.13) predates.

So the churn (cause #1, tunable today) and the per-retirement leak (cause #2, only mitigated, not fixed, upstream) compound: more churn → more retirements → more leaked MiB/hour. The box's own numbers (declining growth: +399, +104, +26, +27, +41, +20 MiB/hr) look like a one-time module/JIT warm-up in hour 1 (five functions compiling their module graphs, including `postgres.js`/`supabase-js` dependency trees, for the first time) followed by the steady per-retirement leak from causes #1+#2 — but this taper is not proven to plateau, and daytime traffic (far more real requests/retirements) was not measured.

---

## Q1 — Is a `per_worker` worker recycled at its wall-clock limit even when idle, and what rate would explain the logs?

**Yes, unconditionally.** SOURCED: `crates/base/src/worker/supervisor/strategy_per_worker.rs` (https://github.com/supabase/edge-runtime/blob/main/crates/base/src/worker/supervisor/strategy_per_worker.rs).

The supervisor starts a `tokio::time::interval` sized to `workerTimeoutMs / 2` **the moment the worker's supervise task starts** — this timer is not reset by requests, acks, or idleness:

> `// Split wall clock duration into 2 intervals.`
> `// At the first interval, we will send a msg to retire the worker.`

At the first real tick (i.e. at `workerTimeoutMs/2`, = 75 000 ms for the box's `workerTimeoutMs: 150_000`), the code does:

```rust
early_retire_fn();
error!("wall clock duration warning: isolate: {:?}", key);
```

`early_retire_fn()` marks the worker retired (`is_retired.raise()`), which means it stops accepting *new* requests immediately — regardless of whether it ever served one. For an idle worker, `have_all_pending_tasks_been_resolved()` is trivially true, so `can_early_drop()` fires at once, V8 runs its beforeunload interrupt, and:

```rust
_ = &mut early_drop_fut => {
  info!("early termination has been triggered: isolate: {:?}", key);
  complete_reason = Some(ShutdownReason::EarlyDrop);
}
```

logs "early termination has been triggered" and the worker is torn down. So one idle worker produces one "wall clock duration warning" + one "early termination has been triggered" pair roughly every `workerTimeoutMs/2` = **75 s**, forever, with zero traffic.

**Rate check (INFERENCE, arithmetic on the SOURCED mechanism above):** the box runs 5 user functions (`command`, `read`, `capability`, `activity`, `h0`). If each keeps one warm/idle worker under `per_worker` reuse, that's 5 independent 75-second cycles → 5 × (60/75) = **4.0 recycles/min**, against a measured 4.07/min (1,466 "early termination" over 360 minutes). This matches far better than any story built around `--max-parallelism 4` (that flag caps *concurrent* workers per function path, per `crates/base/src/worker/pool.rs`'s `ActiveWorkerRegistry` design referenced in `supabase/edge-runtime#717` — https://github.com/supabase/edge-runtime/issues/717 — it does not create or retire idle workers on its own). Not established: which specific 4–5 of the isolate ids repeat (the log carries only isolate ids, not function names — see Q4 for how to get that attribution cheaply).

Also SOURCED, same file: a *reused* worker's wall-clock timer is **not reset by traffic reaching it** — there is no code path in `strategy_per_worker.rs` that restarts `wall_clock_duration_alert` on a request. So under `per_worker`, a worker that keeps getting real work also still dies at `workerTimeoutMs/2` from its original creation time, not from its last-use time.

---

## Q2 — Known memory leaks in edge-runtime ~v1.73.x?

**Yes, open and unresolved as of today (2026-09-23).**

- **`supabase/edge-runtime#740`** — "Memory grows linearly without release eventually hitting container ceiling and causing crash (CPU time soft limit reached)." Opened 2026-09-17, **still OPEN, no maintainer response yet**. Minimal repro: an inert handler invoked on a fixed interval, memory climbs continuously from the moment the container starts, jumps up (not down) after every logged isolate termination, and never returns to baseline short of a restart. Reporter's version: v1.68.4, and they note it also affects "higher limits… just takes proportionally longer." (https://github.com/supabase/edge-runtime/issues/740)

- **`supabase/edge-runtime#719`** — "Retired user workers are not fully reclaimed — RSS grows ~2.5 MiB per retirement with `activeUserWorkersCount: 0`." Version tested: **v1.74.3**. Measured **≈2.46 MiB retained per retired worker** while the JS heap stayed flat (`mainWorkerHeapStats.usedHeapSize` ~8–10 MiB throughout), and confirms container `docker restart` is the only thing that reclaims it. Directly states: *"the same growth occurs under `per_worker`, roughly 2× faster"* than `oneshot`. A community comment on the issue theorizes the cause is V8/mimalloc not returning committed pages to the OS on isolate disposal — consistent with Supabase's own mitigation (below). (https://github.com/supabase/edge-runtime/issues/719)

- **`supabase/edge-runtime#212`** (closed 2024-05-29, but the *cause* was never fixed, only worked around by a CLI default change) — a Supabase engineer (`nyannyacha`) states: *"The root reason causing the leak memory is at the Deno code base I think"* and links **`denoland/deno_core#386`**. (https://github.com/supabase/edge-runtime/issues/212)

- **`denoland/deno_core#386`** — still **open**, no fix landed. Diagnosis: `JsRuntime` creation intentionally leaks `ExternalReferences` via `Box::leak()`; the reporter argues this leak is unnecessary for normal (non-snapshot) isolate creation and built a fork showing removal eliminates the observed growth, but this has not been merged upstream. (https://github.com/denoland/deno_core/issues/386)

- **Mitigation that *has* shipped**: `supabase/edge-runtime` PR **#698**, merged 2026-04-30, released in **v1.74.0** (2026-04-30): *"Exposes `EdgeRuntime.miCollect()` as a main-worker-only API to allow explicit control over when mimalloc returns freed memory back to the OS."* It wraps `mi_collect(force: bool)` via a new `op_mi_collect()` op. This confirms the allocator in use is **mimalloc**, and that Supabase's own fix-in-progress for this class of leak is a manual force-purge call, not an automatic reclaim. (https://github.com/supabase/edge-runtime/pull/698, commit `b1edf45`)

**The box's image, v1.73.13 (released 2026-04-21), predates v1.74.0 (2026-04-30) — it does not have `miCollect()` available at all.** I scanned every v1.73.x changelog entry from v1.73.0 through v1.73.13 (`gh release view` on each) and found nothing memory-, leak-, mimalloc-, worker-, or isolate-related in that range — only an idle-timeout error-response fix (v1.73.1) and connection/TLS-adjacent fixes (v1.73.14/15, also not on the box). So there is no missed 1.73.x point patch that already fixes this; the fix path runs through 1.74.0+.

No comments have been posted on #740 yet (checked via `gh api .../issues/740/comments`, empty), so there's no confirmed root-cause or ETA from Supabase for it as of today.

---

## Q3 — Which settings reduce churn or leak, and what do they cost?

**Note first: the box's `deploy/edge-runtime/main/index.ts` passes only `servicePath`, `memoryLimitMb`, `workerTimeoutMs`, `noModuleCache`, `envVars` to `EdgeRuntime.userWorkers.create()`. It omits `forceCreate`, `cpuTimeSoftLimitMs`, and `cpuTimeHardLimitMs` entirely.** SOURCED (`ext/workers/context.rs`, `ext/workers/lib.rs`): when omitted, these fall back to compile-time defaults —
```rust
force_create: false,
cpu_time_soft_limit_ms: cpu_time_soft_limit_ms.unwrap_or(DEFAULT.cpu_time_soft_limit_ms),
cpu_time_hard_limit_ms: cpu_time_hard_limit_ms.unwrap_or(DEFAULT.cpu_time_hard_limit_ms),
```
where `DEFAULT.cpu_time_soft_limit_ms` / `_hard_limit_ms` are read at compile time from `SUPABASE_RESOURCE_LIMIT_CPU_SOFT_MS` / `_HARD_MS` build env vars, which are **not set** in the repo's `Dockerfile` (checked — only `NVIDIA_*` vars are set there), so whatever value is baked into the published `public.ecr.aws/supabase/edge-runtime` image applies unseen. Supabase's own reference example (`examples/main/index.ts`) explicitly sets `cpuTimeSoftLimitMs: 10000, cpuTimeHardLimitMs: 20000` rather than relying on the default — suggesting the baked-in default is not meant to be relied on in production. **I could not pin the literal default ms value from primary source in this session (not established) — this should be read off `/_internal/metric` or a debug log on the box, not assumed.**

Options, in the order the questions raise them:

- **Longer `workerTimeoutMs`.** SOURCED effect (Q1): retirement-of-idle-workers happens at `workerTimeoutMs/2`. Doubling it to e.g. 300 000 ms would roughly *halve* the idle-churn rate (and thus roughly halve the churn-driven share of the leak), without touching the per-retirement leak itself (#719/#740, still present). Trade-off: the code's own comment says 150 000 ms was chosen because "the hosted free-plan wall-clock limit is 150 seconds" and to end genuinely stuck work — a much longer timeout lets a truly wedged worker (e.g. a hung `postgres.js` query) pin ~96 MiB and a DB connection for proportionally longer before the hard kill.

- **`--policy oneshot` vs `per_worker` vs `per_request`.** SOURCED: `oneshot` retires a fresh worker after every single request (no reuse), so there is **no idle worker to wall-clock-recycle** between requests — the ~4/min background churn measured overnight would drop to ~0 during quiet periods, since nothing is created when nothing is requested. But #719 explicitly measured `oneshot` still leaking, just "roughly 2× slower" per-request than `per_worker`'s per-idle-cycle leak, and every request now pays a cold start (fresh module compile/dependency resolution for `postgres.js`/`supabase-js`) instead of hitting a warm worker. **Important, SOURCED-from-code constraint**: `--policy` is a single, process-wide CLI flag on `start --main-service`; `EdgeRuntime.userWorkers.create()`'s option type (`types/global.d.ts`) has no per-call `policy` field, so this cannot be set per function — switching to `oneshot` would apply to all five functions, including the request-served ones (`command`, `read`, `capability`, `activity`), not just the mostly-idle `h0` poller. `per_request` is a different self-hosted-scale tuning knob (limits in-flight requests per worker; see `supabase/edge-runtime#717`) and doesn't target this idle-recycle problem.

- **`cpuTimeSoftLimitMs`/`cpuTimeHardLimitMs`.** Setting these explicitly (rather than relying on an unverified compile-time default) mainly protects against *CPU-bound* runaway functions triggering early retirement independently of the wall-clock timer — a secondary, currently-invisible contributor to churn on this box, since the code also early-retires on `CPU time soft limit reached`, logged separately from "wall clock"/"early termination." Low risk to set explicitly; does not by itself reduce the underlying per-retirement leak.

- **`forceCreate`.** Defaults to `false` (worker reuse allowed) when omitted — this is exactly what makes `per_worker` keep an idle warm worker around to be wall-clock-recycled in the first place. Setting it `true` would force a fresh worker on every call regardless of `--policy`, functionally similar to `oneshot`'s create side, same trade-offs as above.

- **A newer image (v1.74.0+).** Required just to get access to `EdgeRuntime.miCollect()` (Q2) — this is a mitigation for the leak, not a settings change to reduce churn.

---

## Q4 — How to confirm the cause cheaply, without restarting or guessing?

All of the below are **read-only additions to `deploy/edge-runtime/main/index.ts`** (the main service the box already runs), no user-function changes, no restart required beyond redeploying that one file — I did not make this change; it is a recommendation.

1. **`EdgeRuntime.getRuntimeMetrics()`** — SOURCED, `examples/main/index.ts` (https://github.com/supabase/edge-runtime/blob/main/examples/main/index.ts) already wires this up as a debug route:
   ```ts
   if (pathname === "/_internal/metric") {
     const metric = await EdgeRuntime.getRuntimeMetrics();
     return Response.json(metric);
   }
   ```
   and its shape is typed in `types/global.d.ts`:
   ```ts
   interface RuntimeMetrics {
     mainWorkerHeapStats: HeapStatistics;
     eventWorkerHeapStats?: HeapStatistics;
     activeUserWorkersCount: number;
     retiredUserWorkersCount: number;
     receivedRequestsCount: number;
     handledRequestsCount: number;
   }
   ```
   Polling this every few minutes alongside `docker stats` RSS is exactly the methodology `#719` used to prove the leak tracks `retiredUserWorkersCount`, not `activeUserWorkersCount` (which stays 0) or JS heap (which stays flat). Doing the same here would confirm whether the box's growth is retirement-count-driven (matches #719/#740) or something else (e.g. `postgres.js` sockets/connections not being released on worker termination — not ruled out by anything I read; genuinely **not established** either way from source alone).

2. **`EdgeRuntime.systemMemoryInfo()`** — also SOURCED in `global.d.ts`, returns `{ total, free, available, buffers, cached, swapTotal, swapFree }` from inside the container, a second read-only cross-check against `docker stats`.

3. **Function-name attribution**: the "early termination"/"wall clock" log lines carry only isolate ids because that's what `strategy_per_worker.rs` logs (`key`, the isolate uuid) — there is no function name in that log line at any log level I found in source. The closest thing to attribution without a code change is running the same isolate-id set past `getRuntimeMetrics()`'s counts at tighter intervals to correlate recycle timing with which function(s) were last invoked, or (if acceptable to touch the main service) logging `route.functionName` next to the isolate id the box's own code already threads through `EdgeRuntime.userWorkers.create()` — this is a one-line addition to the box's own `handle()` function, not an upstream change. **Not established**: whether upstream exposes the isolate-id-to-servicePath mapping any other way (I did not find one in the public API surface).

4. **A heap snapshot** is the wrong tool here per #719's own finding — `mainWorkerHeapStats.usedHeapSize` stays flat (8–10 MiB) while RSS grows by hundreds of MiB, because the growth is native (mimalloc/V8 isolate-disposal) memory, not JS heap. A V8 heap snapshot would show nothing.

---

## Ranked fix list, with risk

1. **Add a read-only `/_internal/metric` (+ `systemMemoryInfo()`) route to the box's own main service and watch it for a full day (including daytime traffic), before changing anything else.** Risk: **near zero** — additive, read-only, no behavior change to request handling. This turns "we think it's retirement-count-driven" into a measured fact matching (or not) the #719/#740 shape, and is the one step that removes the most guesswork per dollar spent. Do this first.

2. **Explicitly set `cpuTimeSoftLimitMs`/`cpuTimeHardLimitMs` and `forceCreate: false` in the `userWorkers.create()` call**, instead of relying on an unread, unverified compile-time default. Risk: **low** — pure config, makes today's actual behavior legible and tunable instead of implicit; does not by itself change the leak.

3. **Double (or more) `workerTimeoutMs`** (e.g. 150 000 → 300 000+ ms), since the idle-recycle interval is `workerTimeoutMs/2` and the box's own churn math (Q1) shows this is roughly half of what's driving the "early termination"/"wall clock" log rate at near-zero traffic. Risk: **low-medium** — proportionally slows the idle-driven share of the leak; the cost is a genuinely wedged worker (stuck DB query, etc.) now pins ~96 MiB and a `postgres.js` connection for longer before the hard kill. Keep `workerTimeoutMs` comfortably above the H0 poll's real ceiling (currently 50 s per the code comment) but don't remove the safety margin entirely.

4. **Upgrade the image to v1.74.0 or later (ideally the current v1.76.2, released 2026-09-02) and call `EdgeRuntime.miCollect()` on an interval from the main service** (e.g. every N minutes, off the request hot path), to force mimalloc to return freed pages to the OS between restarts. Risk: **medium** — this is Supabase's own shipped mitigation for exactly this leak shape, but it is new (April 2026), the underlying leak issues (#740, #719) are still open against versions *after* v1.74.0, and jumping from v1.73.13 across five minor releases (1.74.0–1.76.2) is an untested dependency bump for this stack (`postgres.js` pools, `@supabase/supabase-js`, `noModuleCache: false`) that needs its own regression pass before production — and a forced `mi_collect(force: true)` purge is itself a stop-the-world-ish operation that could cause a latency spike if called too often or too close to live traffic. Test in a low-traffic window first, watch `/_internal/metric` before/after to confirm it actually drops RSS on this box specifically (not guaranteed by the upstream reports alone).

5. **Do not switch `--policy` to `oneshot` yet.** It plausibly eliminates the idle-recycle churn entirely (since nothing is created with nothing requested), but per #719 it still leaks (roughly half the per-worker-idle-cycle rate per created worker) and — because policy is process-wide, not per-function — it would also strip warm-worker reuse from `command`/`read`/`capability`/`activity` during real daytime traffic, trading a measured overnight problem for an unmeasured daytime cold-start-latency and per-request-leak problem. Risk: **medium-high**, and reversible only by another deploy; revisit only after step 1's measurement shows churn (not per-request volume) is the dominant driver.

6. **Keep the 6-hourly restart / 2 GiB cap as the safety net until 1–4 are measured**, but consider re-tuning the interval once step 1 has a full day of data — the observed taper (+399 → +104 → +26 → +27 → +41 → +20 MiB/hr) suggests the restart cadence may currently be more conservative than needed for the *overnight* pattern specifically, but daytime request volume (far more retirements/hour than the quiet window measured) was not observed and could easily be worse, not better. Risk: **low to change nothing**; treat any loosening of the restart cadence as provisional until measured under real load.

---

## Not established

- The literal compile-time default for `cpuTimeSoftLimitMs`/`cpuTimeHardLimitMs` baked into `public.ecr.aws/supabase/edge-runtime:v1.73.13` (I traced the fallback mechanism in source but not the literal millisecond constant for this build).
- Whether the leak's root cause on this box is specifically V8/mimalloc isolate-disposal retention (per #719/#740's own diagnosis) versus something stack-specific — e.g. `postgres.js` (npm:postgres@3.4.9) connections/sockets or `@supabase/supabase-js` 2.110.8 client state not being fully released when a worker is force-terminated mid-request. Nothing I read confirms or rules this out; step 1 above (metrics + a day of data) is what would actually distinguish it.
- Whether the observed per-hour growth taper (+399 → ... → +20 MiB) plateaus, keeps slowly declining toward zero, or resumes climbing — only a ~6 h, near-zero-traffic window was measured; daytime behavior with real request volume across five functions was not.
- Exact per-function attribution of the 1,466/1,461 log lines — the 5-function/75-second arithmetic in Q1 matches the aggregate rate closely but is inference from the mechanism, not a direct read of which isolate id belongs to which function (the logs don't carry function names; see Q4 for how to get that without guessing).
- Whether `EdgeRuntime.miCollect()` actually reduces RSS meaningfully on *this* box's specific workload — it is upstream's shipped mitigation and mechanically plausible, but I found no report of anyone using it in production against this exact symptom; it needs to be measured here, not assumed.
- Whether Supabase has triaged or has a fix ETA for `#740` (opened 2026-09-17) — as of this research, it has zero comments.
