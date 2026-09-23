# Checker review, round 2 (Claude Opus arm): H0 lane 5b at 6cfb063e (base efe270c0, round 1 at 7702e2b3)

What I read: `git diff 7702e2b3...6cfb063e` (all 16 files) and the parts of `git diff efe270c0...6cfb063e` that
it touches. At 6cfb063e I read `supabase/functions/h0/{forward,index,parse,core}.ts`,
`supabase/functions/command/index.ts` (module init 1036-1184, `readBody` 1400-1450, `bearer` 1450-1456,
`handlePostRequest` 11200-11390, `handleRequest` 11391-11405, the register retry branch 6128-6175, the
signal rate limit 5224-5258 and 9701), `command/cors.ts`, `_shared/agent-auth.ts` `enforceAgentSessionProof`,
`deploy/edge-runtime/{compose.yaml,bootstrap.sh,h0-deno.json,main/index.ts,main/router.ts,README.md}`,
`tests/p1-cli/{h0-forward-contract,edge-runtime-box}.test.ts`, the fold's diffs to
`tests/p1-server/h0-forward.test.ts`, `h0-verbs.test.ts` and `h0-agent-document.test.ts`, `LANE.md`, and the spec
(`spec/h0-link-join`, sections 3 to 7).

## Round-1 findings: status at 6cfb063e

| Round 1 | Status | Evidence |
|---|---|---|
| F1 PRODUCTION: box h0 worker has no `SUPABASE_URL`, every forwarded verb fails | FIXED | `router.ts:199-217`: `h0: COMMAND_ENV`, the same array as `command`. The HTTP fetch is gone. I ran the gate that failed in round 1, `tests/p1-cli/edge-runtime-box.test.ts`, in the detached worktree at 6cfb063e: 14/14 pass, exit 0. At 7702e2b3 that file failed with `+ ['SUPABASE_URL']` (round-1 positive control). |
| Grok 2 PRODUCTION: an HTTP forward holds two of four workers | FIXED | `forward.ts:159-175` builds a `Request` and calls `handleRequest` from `await import("../command/index.ts")` (`forward.ts:137`). No fetch, so no second worker. |
| F2 config reported as upstream error | FIXED | `forward.ts:132-136`: 500 `h0_command_not_configured` plus the fixed log `"h0 command configuration missing"`. The pure test at `h0-forward-contract.test.ts:83-106` checks the code and that the log line has no credential. |
| F3 SSRF / hairpin | GONE | No outbound request. The synthetic URL `https://command.internal/...` is never read: the command edge's only header reads are `content-length`, `authorization` (index.ts:1407,1452) and `origin` (cors.ts:41), and it never reads `request.url`. |
| F4 contract test blind to an extra field | FIXED | `h0-forward-contract.test.ts:23-60` reads `FORWARD_FIELDS` from the parser AST and compares the required and omittable sets with `H0_VERBS`. LANE.md records a mutation control (`about` added, then exit 1). The test reads `H0_VERBS`, not the generated document. |
| F5 parity used h0's `to` shape | FIXED for `swarm.signals` | The direct ask/note now send the scalar `to_agent_principal_id` (h0-forward.test.ts:222-242). See R6 for the residue. |
| F6 wire rules not stated | PARTLY | `H0_REQUEST_ID_RE` and `H0_REGISTRATION_NAME_MAX` now come from `src/h0/verbs.ts:106-107`. The command edge (index.ts:649, 2261), the parser (parse.ts:131,138) and the document (pattern, minLength, maxLength) all use them. Refusal messages still name no field. |
| F7 oversized body | FIXED | `forward.ts:122-123` answers 413 `payload_too_large`. The server test checks this at h0-forward.test.ts:264-267. |
| F8 second pool, unclassified DB failure | FIXED / residue | The lookup uses command's exported `db` (`forward.ts:137-140`). The h0 catch uses the shared 40001/40P01 classifier (index.ts:74-79). The lookup still runs before authentication (R3). |
| F9 attemptId sentence too wide | FIXED, new problem | The sentence now states the unused-token rule. Its remedy conflicts with the edge's remedy (R1). |
| F10 three-seat and replaced-token proofs | FIXED | The third seat polls and does not see the ask (test:298-301). The replaced token gets 403 `forbidden`, and a used-token retry gets 409 `registration_token_already_used` (test:181-189). |

## Round-2 checks (the brief's CHECK list)

**The caller's identity and command-edge checks under the in-process call.**
- Authentication is unchanged. `handleRequest` -> `handlePostRequest` (index.ts:11200-11300) authenticates the
  one `authorization` header that h0 sets from the caller's own credential (`forward.ts:129,163`). The join
  credential goes in only for `register`. Only the join-credential path, not an agent token, can register
  (index.ts:11226-11262).
- There is no client IP. The command edge reads no `x-forwarded-for`, `x-real-ip` or `cf-connecting-ip`
  (git grep in `command/`, `_shared/`, `src/cloud/session-wire.ts` found none). So identity, audit and the
  rate buckets (`signal:credential:*`, `signal:workspace:*` in the database, index.ts:5224-5258) are the same
  as for a direct call. The command edge has no in-memory rate state: the only `new Map/Set` are local
  (index.ts:1739, 4402, 10850). One h0 request makes one `handleRequest` call, so nothing is counted twice.
- CORS and origin. The command edge uses `Origin` only to add CORS headers (cors.ts:38-46). It refuses no
  POST by origin. So when h0 drops `Origin`, no gate is bypassed, and h0 copies none of command's headers
  (forward.ts:100-107).
- Session proof. h0 does not pass `x-*` session-proof headers. For a principal with `managed_at` set,
  `enforceAgentSessionProof` refuses a missing proof (agent-auth.ts:233-253). This fails closed: there is
  no bypass. An unmanaged H0 seat behaves the same as with a direct call.
- Size and abort. h0 caps the input at 16 KiB. The command's own 128 KiB `readBody` cap still runs on the
  synthetic body. `request.signal` goes onto the synthetic `Request` (forward.ts:174). A direct HTTP call
  has the same abort behavior: a committed transaction stays committed.

**Side effects of importing command/index.ts in the h0 worker.**
- It does not start a server: `if (import.meta.main) Deno.serve(handleRequest)` (index.ts:11405).
  `import.meta.main` is true for the command worker's own entry. The fold's server gate (242/242, with direct
  `/functions/v1/command` calls and a readiness wait) shows this on the local runtime. The installed
  Supabase CLI pins `FROM supabase/edge-runtime:v1.73.13`, and the box uses the same image
  (compose.yaml:3). I took that from the CLI binary's strings, not from a running container.
- Module init: env reads, one lazy `postgres` pool (`max: 2`, `idle_timeout: 3`), and
  `createClient(..., { persistSession: false, autoRefreshToken: false })` (index.ts:1066-1075, 1182-1184).
  There is no `setInterval`, no listener and no global state that differs from the command worker.
- The import is lazy, so the anonymous document GET, poll and ack do not depend on command config
  (forward.ts:130-137).
- The import map is the same. `h0-deno.json` and `command/deno.json` both map only `postgres` ->
  `npm:postgres@3.4.9`. In command and `_shared`, the bare `postgres` imports are type-only. The other
  imports are `npm:` or `node:crypto`.
- The box path resolves. `bootstrap.sh` stages to `/var/tmp/commonswarm-functions/<fn>`, and `../../../src`
  resolves to `/var/src`, which is mounted (compose.yaml:44). command/index.ts already imported
  `../../../src/cloud/session-wire.ts` at efe270c0, so its new `src/h0/verbs.ts` import (no imports of its
  own) adds no new path class.

**Test knobs.** `main/index.ts:49-60` `environmentFor` drops every `COMMAND_TEST_HOOKS` name unless the main
service's `SWARM_ENV === "test"`. If a knob gets through anyway, command's import-time check throws
(index.ts:1059-1064). The h0 catch turns that into 500 `internal_error` with a fixed log. Production cannot
turn the knobs on.

**Connections.** The worst case for an h0 worker is 2 (command pool) + 1 (poll/ack pool) = 3, which matches
README:40-44. The prior shape used an h0 worker at 2 plus a command worker at 2 for each forward. With four
worker slots, the ceiling is 12 plus draining workers. That does not exceed what four command workers could
already hold. The box database's connection limit is not in the repo (NOT ESTABLISHED).

**Secrets.** The fold adds no log line that carries a value. `h0 command configuration missing`,
`h0 forwarding failed` and the command's own `safeError` logs are fixed strings. The seat token appears only
in the register response body. A non-register body that contains `agent_token` still becomes 502
(forward.ts:96-99). No credential reaches a URL, because there is no URL. The service-role key is readable
in the h0 worker, but no h0 path emits it (see R2).

**D-053.** The new branches classify on `error.code` (core.ts:302-312) and on a module-private `Symbol`
(forward.ts:17,122). None reads `error.message`.

**Gates reach the tests.** `h0-forward-contract.test.ts`, `edge-runtime-box.test.ts`, `h0-verbs.test.ts` and
`h0-agent-document.test.ts` are under the `test:p1-cli` glob. `h0-forward.test.ts` is under the `test:p1-server`
glob. The stored-row parity compares against a direct `command` call, not against h0's own output.

## Findings

No PRODUCTION finding.

### R1. RIGOUR: the document's remedy for a used attempt conflicts with the command edge's remedy.

`src/h0/verbs.ts:123`:

```ts
req("attemptId", false, "client-generated; retry with the same value while its token is unused to recover this seat and replace that token; a used token returns 409, so ask the inviter for a new join credential"),
```

The command edge answers the same state with another remedy (index.ts:6144-6146):

```ts
409, "registration_token_already_used", "registration_token_already_used",
"Revoke that seat and register again.",
```

The join credential is multi-use and has a seat cap (spec lines 40, 261-271). So a new `attemptId` on the same
credential can also get a seat, and the edge's revoked-seat branch tells the caller to do exactly that
(index.ts:6165: "Register again with a new attempt."). The document sends an agent to a human for a new
credential in a case where the 409 body names a different action. The sentence also groups
`registration_seat_revoked` (also 409) under "a used token". `h0-verbs.test.ts:354` pins the sentence, so a
claim control now defends a remedy that the enforcing code does not state. Fix: build the remedy from the
same place as the edge's message, or say "a used or revoked seat returns 409; follow the message in that
response".

### R2. RIGOUR: the h0 worker receives `SUPABASE_SERVICE_ROLE_KEY`, which none of its commands use.

h0 sends only `register_agent_seat` and `post_signal` (forward.ts:141-151). The service-role key is read only in
`fileStorage()` (index.ts:1081-1084). `fileStorage()` is called only for file commands (index.ts:10105) and for
the file purge drain, which is gated on `FILE_COMMAND_KINDS` (index.ts:11323-11332). The h0 worker is the one
that serves the anonymous, public agent document. It now holds the most powerful key in the environment for
no functional reason. `edge-runtime-box.test.ts:79-81`
(`assert.deepEqual(FUNCTION_ENV_NAMES.h0, FUNCTION_ENV_NAMES.command)`) makes this required. I found no path
that exposes the key. This is a least-privilege gap, not a leak. The lane record lists the key but does not
state why h0 needs it.

### R3. RIGOUR: the routing lookup is still an unauthenticated database query with no rate limit.

`forward.ts:65-78` runs `SELECT ... FROM swarm.agent_tokens ... WHERE t.token_hash = $1` for any bearer that
matches `swm_agt_[A-Za-z0-9_-]{43}`, before the command edge authenticates. It now shares command's
two-connection pool (`forward.ts:137-140`), so a flood of well-formed fake tokens competes with the real
command work in that h0 worker. The query is cheap and indexed. It cannot change the result, because command
authenticates again and `resolveRoute` rejects a workspace that is not the token's. This is not measured.

### R4. RIGOUR: the 40001/40P01 claim is wider than the code.

LANE.md says "Forward database errors use the same SQLSTATE 40001/40P01 retryable 503 classifier as poll and
ack." That is true only for the routing lookup, which is a single `SELECT` and is unlikely to raise either
code. A serialization failure or deadlock inside the command transaction is caught in `handlePostRequest`.
The comment there says it "deliberately still fall[s] through to the existing 500" (index.ts:11364-11366), and
h0 passes that 500 through unchanged. The brief's summary "40001/40P01 give the shared 503" therefore does not
hold for the command work of a forwarded verb.

### R5. RIGOUR: typed copies and coupling added by the fold.

- `forward.ts:132-133` retypes command's import-time requirement (`SWARM_DATABASE_URL ?? SUPABASE_DB_URL`,
  `SUPABASE_URL`, `SUPABASE_ANON_KEY`; index.ts:1049-1053). If command adds a required name, the h0
  pre-check passes. The import then throws, and the user gets the generic 500 instead of
  `h0_command_not_configured`. That is safe but can drift. Export the requirement from command.
- `COMMAND_ID_RE = H0_REQUEST_ID_RE` (index.ts:649). The command_id grammar for every client (CLI and web) is
  now defined in an H0 file. An H0 edit changes the command edge for everyone.
- The document puts `maxLength: 80` in a JSON Schema. JSON Schema counts code points. The parser and
  `boundedText` count UTF-16 units (parse.ts:131, index.ts:1589-1591), and `boundedText` also refuses control
  characters that the schema does not mention. Outside the BMP (for example emoji), a name that is valid
  under the schema can get 400 from h0.

### R6. RIGOUR: the parity test compares one table.

`signalRow` (h0-forward.test.ts:90-98) compares only `swarm.signals`. h0 sends ask and note with a `to` array
(forward.ts:151). The direct call now uses the CLI's scalar target. `swarm.signal_recipients` (written for
the `to` form) and the delivery rows are not compared. The three-seat test shows that delivery reaches only
the addressee. "The same signal fields as a CLI command" holds for the `signals` row only.

### R7. RIGOUR: observability and dependency pinning moved with the handler.

- Command's `logCommandFailure` and `console.error` lines for h0 traffic now come out under the `h0` worker,
  not `command`. The durable `insertCommandFailure` row is unchanged. No runbook tells the operator to
  look in both places.
- `command/` has a `deno.lock`, and `h0/` has none. The h0 worker now loads
  `npm:@supabase/supabase-js@2.110.8` and resolves its transitive packages without that lock. On the box,
  the command code that runs in h0 can use different transitive versions from the command worker. I did not
  establish whether edge-runtime reads a lockfile under a service path.

## Not established

- The box database `max_connections` and pooler mode, so connection headroom with four workers at up to 3
  connections each.
- The h0 worker's memory with the command graph loaded, against 96 MiB (the command worker runs the same
  graph in the same limit, so this is likely fine, but it is not measured). Cold-start time for the first
  h0 worker after the change.
- `import.meta.main` on the box. I inferred it from the local 242/242 server gate and from the CLI's pinned
  `edge-runtime:v1.73.13`, which is the box image. I did not measure it on a live box worker. The lane did
  not deploy it.
- I did not run the server suite or any database, Docker, supabase or network command. I ran one pure file,
  `tests/p1-cli/edge-runtime-box.test.ts`, in the detached worktree at 6cfb063e: 14/14 pass, exit 0. It wrote
  nothing there. I wrote one scratch copy of `command/index.ts` to my own scratchpad
  (`scratchpad/opus2-cmd.ts`) to read it. No repository or worktree file changed.

Both round-1 PRODUCTION findings are fixed at 6cfb063e. The in-process call keeps authentication, rate
buckets, idempotency, audit and the caller's identity inside the command edge. Importing the command module
does not start a server, and I found no bypass of any check that depends on the HTTP request. What remains is
RIGOUR: a conflicting 409 remedy in the document, the service-role key given to h0 without need, a 40001/40P01
claim that is too wide, and typed copies.

VERDICT: PASS
