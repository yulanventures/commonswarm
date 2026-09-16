-allow-headers: <requestedHeaders>`
- empty body.
That matches `gatewayPreflight(request)`.

WAIT!
LOOK AT `rewriteFunctionRequest`:
```ts
export function rewriteFunctionRequest(
  request: Request,
  pathname: string,
): Request {
  const url = new URL(request.url);
  url.pathname = pathname;
  return new Request(url, request);
}
```
WAIT!
Let's examine `new Request(url, request)` AGAIN.
Wait!
Is there ANY situation where `new Request(url, request)` fails?
Let's think:
What if the incoming request has a body and method is `GET` or `HEAD`?
Wait! In HTTP/1.1, could a GET request have a body?
If a client sends `GET /functions/v1/read` with a body:
In Fetch API:
If `init` has a body and `method` is `GET`:
`new Request(url, { method: "GET", body: stream })` throws `TypeError: Request with GET/HEAD method cannot have body`!
WAIT!
Does `request` have a `body` when method is `GET`?
In standard Fetch (and Deno `Deno.serve`):
If the incoming HTTP request is `GET`, what is `request.body`?
In Deno, for a GET request, `request.body` is `null`!
So `init["body"]` is `null`.
In Fetch spec: if `body` is `null`, it does NOT throw!
What if a malicious or strange client sends a GET request with `Transfer-Encoding: chunked` or `Content-Length: 5` and a body?
In Deno, `request.body` might be non-null!
If `request.body` is non-null for a GET request, `new Request(url, request)` would throw `TypeError` because `method` is GET and `body` is not null!
Wait, but why would any CommonSwarm client send a GET with a body?
CommonSwarm functions:
- `command`: POST
- `read`: POST
- `activity`: POST
- `capability`: GET
- `h0`: GET
None of the GET endpoints take a body.

WAIT! WHAT ABOUT `content-length` HEADER IN `rewriteFunctionRequest`?
Wait! Look at `new Request(url, request)`.
When `request` has a body:
`request.headers` has `content-length: 123` (or similar).
Does `new Request(url, request)` preserve headers including `content-type`, `authorization`, etc.?
Yes!
Wait! What if `content-length` is in `request.headers`?
Does `worker.fetch(forwarded)` receive the body and headers?
Yes!

WAIT!
LOOK AT `main/index.ts` lines 98-103:
```ts
  // Supabase's Kong removes only /functions/v1. Preserve the function name,
  // the remaining path, the query, method, headers, body, and signal.
  const forwarded = rewriteFunctionRequest(request, route.pathname);
  EdgeRuntime.applySupabaseTag(request, forwarded);
  return await worker.fetch(forwarded);
```
Wait! Look at `EdgeRuntime.applySupabaseTag(request, forwarded);`.
What does `EdgeRuntime.applySupabaseTag` do?
Let's think about `EdgeRuntime.applySupabaseTag`:
In Supabase Edge Runtime:
`EdgeRuntime.applySupabaseTag(req, reqWithStrippedPrefix)`:
In `supabase/edge-runtime`, the native Rust bindings provide `EdgeRuntime.applySupabaseTag`:
It transfers the internal metadata (like request ID, execution context, etc.) from `request` to `forwarded`.
If `EdgeRuntime.applySupabaseTag` was NOT called, edge-runtime wouldn't track metrics / tags properly.
Calling `EdgeRuntime.applySupabaseTag(request, forwarded)` is the standard Supabase way to tag rewritten requests!

WAIT!
LOOK AT `main/index.ts` lines 105-113:
```ts
Deno.serve((request) =>
  handle(request).catch((error: unknown) => {
    if (isWorkerLimitError(error)) {
      return json(WORKER_LIMIT_STATUS, WORKER_LIMIT_BODY);
    }
    console.error("edge-runtime request failed", error);
    return json(500, { error: "internal_error" });
  })
);
```
WAIT!
LOOK AT `Deno.serve((request) => ...)`!
WAIT A MINUTE!
WHAT PORT DOES `Deno.serve` BIND TO?!
Let's check this again very, very carefully!
Wait!
In Deno 1.x / Deno 2:
`Deno.serve(handler)`
By default, what options does `Deno.serve(handler)` use?
In Deno:
Default options for `Deno.serve`:
`hostname: "0.0.0.0"`
`port: 8000`!
WAIT!
PORT 8000?!
WAIT!
Wait, earlier we asked:
Does `Deno.serve` in `edge-runtime` listen on port 8000 or port 9000?
WAIT!
Look at `compose.yaml`:
```yaml
      - start
      - --main-service
      - /home/deno/main
      - --port
      - "9000"
```
WAIT!
What is `edge-runtime`?
Is `edge-runtime` Deno?
`edge-runtime` is Supabase's Rust binary (`crates/base/src/...`) built on `deno_core` and hyper!
In `supabase/edge-runtime`:
How does `--port 9000` work in `edge-runtime start`?
In `edge-runtime`:
The Rust binary starts hyper listening on `--port 9000` (or `0.0.0.0:9000`).
When a request arrives at hyper on port 9000:
Hyper passes the request into the V8 runtime running the main service (`/home/deno/main/index.ts`).
In the main service:
When the main service calls `Deno.serve(handler)`:
WAIT! Does `edge-runtime` implement `Deno.serve`?
Yes! In `edge-runtime`, `Deno.serve` registers the handler with the hyper server!
It does NOT start a separate TCP listener on port 8000!
And remember:
The smoke test in step 3 & 4 of RUNBOOK:
`test: exec 3<>/dev/tcp/127.0.0.1/9000 && printf 'GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n' >&3`
And:
"wait for healthy. Confirm the published socket is only 127.0.0.1:9000."
"LIVE on the box at this SHA through Cloudflare on edge-staging.commonswarm.com... /auth/v1/health 200/200..."
And `GET /health` returned 200 on port 9000!
So port 9000 is indeed where the main service is serving!

---
WAIT! WHAT ABOUT WORKER MEMORY AND PARALLELISM?
Let's look at:
```ts
// Four workers at 96 MiB use at most 384 MiB. The 512 MiB container limit keeps
// 128 MiB for the main runtime, module cache, and process overhead.
const USER_WORKER_MEMORY_MB = 96;
```
And in `compose.yaml`:
`--max-parallelism "4"`
`mem_limit: 512m`

WAIT!
Let's think about this:
How many workers can run simultaneously?
Up to 4 workers.
Each worker has a hard memory limit of 96 MiB enforced by V8 heap limit in edge-runtime (`memoryLimitMb: 96`).
If all 4 workers hit their memory limit:
4 * 96 = 384 MiB.
The container limit is 512 MiB.
384 MiB leaves 128 MiB for the main runtime and Linux OS overhead.
Can the container be OOM-killed by the Linux kernel?
No! Because 384 MiB + 128 MiB = 512 MiB, and V8 will abort/kill any worker that tries to exceed 96 MiB before the container reaches 512 MiB.

WAIT! What if a 5th request comes in while 4 workers are executing?
In `compose.yaml`:
`--request-wait-timeout "10000"` (10 seconds)
The 5th request is queued in edge-runtime's request pool.
As soon as any of the 4 workers finishes its request, the queued request is picked up.
If all 4 workers take longer than 10 seconds to finish, the queued request times out with `RequestWaitTimeout` / 504.

WAIT!
LOOK AT THAT!
COULD 4 WORKERS BE BUSY FOR MORE THAN 10 SECONDS?!
Let's think!
When could 4 workers be busy for more than 10 seconds?
1. Under normal operation:
   Look at the recorded latency baseline in RUNBOOK.md line 208:
   "compare end-to-end latency with the recorded 2026-09-16 baseline: box p50/p95 read members 2.77/3.32 s, read feed 2.07/2.93 s, command receipt 1.68/2.11 s; production 0.85/1.16 s, 0.73/1.09 s, and 0.70/0.90 s."
   Notice:
   Command receipt latency is ~2 s.
   Read feed latency is ~2-3 s.
   Read members latency is ~3 s.
   Under normal traffic, requests take 2-3 s.
   A queue wait of 10 s is plenty of time for 2-3 s requests to finish!

BUT WHAT ABOUT:
"A later H0 long-poll holds 50 s."
AND:
"ATTACK: ... timeouts (request-read 15 s, request-wait 10 s, worker idle 65 s, Caddy response_header_timeout 65 s) against real command latency across an ocean and the future 50 s poll; worker memory and parallelism;"

WAIT!
LOOK AT THAT!
Let's analyze what happens when the 50 s H0 long-poll is introduced:
If H0 long-poll holds a worker for 50 seconds:
With `--max-parallelism 4`, if 4 clients connect to H0 long-poll simultaneously:
ALL 4 WORKER SLOTS ARE OCCUPIED FOR 50 SECONDS!
While those 4 workers are holding the long poll for 50 seconds:
What happens if ANY client sends a `command`, `read`, `activity`, or `capability` request?!
The incoming
### Review of N-edge (`lane/edge-runtime-box` at SHA `81159423351907bc33bd209c11cce30fee4c39fe`)

---

### Findings

#### RIGOUR 1: Worker saturation hazard under planned 50 s H0 long-poll
- **File & Line**: [`deploy/edge-runtime/compose.yaml:18,23`](file:///opt/commonswarm/current/deploy/edge-runtime/compose.yaml#L18-L23)
- **Concrete Request / Sequence**:
  Once the planned 50-second H0 long-poll is deployed, 4 clients initiate concurrent poll requests (`GET /functions/v1/h0/poll`). All 4 worker slots (`--max-parallelism 4`) are held for up to 50 seconds. A 5th client submits a standard command (`POST /functions/v1/command`). Because all workers are occupied, the request sits in the runtime queue. After 10 seconds, the queue timeout (`--request-wait-timeout 10000`) expires.
- **What a User Sees**:
  The 5th user receives an immediate 504 gateway timeout / queue failure after 10 seconds despite the database and edge box being healthy.
- **Assessment**:
  In this lane, H0 remains document-only ([`main/router.ts:182`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L182)) with sub-second response times, so production cutover is safe today. However, before the long-poll lane activates, `--max-parallelism` and worker memory allocation must be re-budgeted or long-polling routed outside the worker pool.

#### RIGOUR 2: GET/HEAD requests carrying unexpected payload fail with 500
- **File & Line**: [`deploy/edge-runtime/main/router.ts:104-110`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L104-L110)
- **Concrete Request / Sequence**:
  A non-standard or misbehaving HTTP client issues `GET /functions/v1/capability/smoke` with `Transfer-Encoding: chunked` and a non-empty request body. In Deno's Fetch implementation, passing a `Request` instance with a non-null body as `init` to `new Request(url, request)` when the method is `GET` throws a native `TypeError: Request with GET/HEAD method cannot have body`.
- **What a User Sees**:
  The unhandled `TypeError` bypasses `isWorkerLimitError` and falls into the top-level catch handler in [`deploy/edge-runtime/main/index.ts:111`](file:///opt/commonswarm/current/deploy/edge-runtime/main/index.ts#L111), returning HTTP 500 `{"error":"internal_error"}` instead of an HTTP 400 Bad Request or standard method evaluation.

---

### Verification and Attack Analysis

1. **Kong Routing & Gateway Parity**:
   - **Path stripping & trailing slashes**: [`main/router.ts:134-153`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L134-L153) strips `/functions/v1/` prefix while preserving function name, subpath, and query string. Bare `/functions/v1` yields Kong-parity 404 JSON `{"message":"no Route matched with those values"}` ([`main/router.ts:89-91`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L89-L91)).
   - **CORS & Unknown Functions**: Unknown functions return 404 `Function not found` with `Access-Control-Allow-Origin: *` for both regular and preflight requests ([`main/router.ts:92-94`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L92-L94)). Known functions properly intercept `OPTIONS` requests and return 200 with Kong's method list and requested headers ([`main/router.ts:54-67`](file:///opt/commonswarm/current/deploy/edge-runtime/main/router.ts#L54-L67)).

2. **Upstream Proxy & Cloudflare Stripping**:
   - [`deploy/edge-runtime/commonswarm.caddy:8-14,28-33`](file:///opt/commonswarm/current/deploy/edge-runtime/commonswarm.caddy#L8-L33) strips `CF-Connecting-IP`, `CF-Ray`, `CF-Visitor`, `CF-IPCountry`, `CDN-Loop`, and `True-Client-IP` before forwarding to Supabase, eliminating Cloudflare 403 "Attention Required" rejections while maintaining Caddy's `X-Forwarded-For` chain.
   - Realtime connections correctly use `versions 1.1` and `flush_interval -1` ([`commonswarm.caddy:36-40`](file:///opt/commonswarm/current/deploy/edge-runtime/commonswarm.caddy#L36-L40)) to enable unbuffered WebSocket handshakes.
   - Catch-all `handle` ([`commonswarm.caddy:85-88`](file:///opt/commonswarm/current/deploy/edge-runtime/commonswarm.caddy#L85-L88)) safely preserves unmapped project routes.

3. **Timeouts & Memory Sizing**:
   - Caddy `response_header_timeout 165s` provides a 15 s safety buffer over the worker timeout (`150_000 ms`), allowing edge-runtime's 504 `WORKER_LIMIT` ([`main/index.ts:107-109`](file:///opt/commonswarm/current/deploy/edge-runtime/main/index.ts#L107-L109)) to return cleanly to the client before proxy termination.
   - Body read timeout of 60 s (`--request-read-timeout 60000`) accommodates 128 KiB payloads under cross-ocean network latency (~2.2 KiB/s minimum throughput).
   - 4 workers × 96 MiB = 384 MiB heap ceiling inside a 512 MiB container constraint ([`compose.yaml:45`](file:///opt/commonswarm/current/deploy/edge-runtime/compose.yaml#L45)) guarantees 128 MiB headroom for the hyper/deno main process without triggering Linux OOM kills.

4. **Cutover & Rollback Safety**:
   - [`deploy/edge-runtime/RUNBOOK.md:158-193`](file:///opt/commonswarm/current/deploy/edge-runtime/RUNBOOK.md#L158-L193) strictly adheres to the binding operational order: rehearsal on staging -> deliberate deactivation of custom domain -> update GitHub OAuth callback and GoTrue to project URL -> end-to-end sign-in verification -> DNS switch with 48-hour fallback.
   - Section 8 ([`RUNBOOK.md:212-226`](file:///opt/commonswarm/current/deploy/edge-runtime/RUNBOOK.md#L212-L226)) provides an exact inverse rollback sequence that preserves authentication continuity while DNS propagates.

---

VERDICT: PASS
