# Checker review (Claude Opus arm): H0 lane 5b, 7702e2b3 (base efe270c0)

Scope read: full `git diff efe270c0...7702e2b3` (9 files); `command/index.ts` register path
(`registerAgentSeat`, `replaceUnusedRegistrationToken`, `validateCommand` register branch, bearer
parse, signal rate limit); `deploy/edge-runtime/main/{index,router}.ts`, `compose.yaml`,
`env.example`, `README.md`; `tests/p1-cli/edge-runtime-box.test.ts`; `src/cli.ts` `runReply` and
`runPostSignal`; spec `spec/h0-link-join:docs/design/2026-09-15-H0-LINK-JOIN.md` sections 4-7.

## Findings

### F1. PRODUCTION: the box gives the h0 worker no `SUPABASE_URL`, so every forwarded verb returns 502. An existing gate fails at this SHA.

`supabase/functions/h0/forward.ts:158-159`:

```ts
const base = Deno.env.get("SUPABASE_URL");
if (!base) return unreadable();
```

`deploy/edge-runtime/main/router.ts:215` (not changed by this lane):

```ts
// Poll and ack read the same database environment names as command.
h0: DATABASE_ENV,
```

`deploy/edge-runtime/main/index.ts:49-60,87` sends a user worker only the names in
`FUNCTION_ENV_NAMES[functionName]` (`envVars: environmentFor(route.functionName)`). On
`yulan-vps-1`, the h0 worker therefore has no `SUPABASE_URL`. `register`, `ask`, `note`, `reply`,
and `working-on` all return `502 {"error":"h0_command_unreadable"}`. No log line says why:
forward.ts:159 returns before any `console.error`. An agent cannot register, so no H0 seat
works on the box.

The lane's server suite passes because `supabase functions serve` adds `SUPABASE_URL` to every
function on its own. The box does not. The local control and production differ on exactly this
input.

The repo already has a pure control for this, and it fails at 7702e2b3.
`tests/p1-cli/edge-runtime-box.test.ts:71-77`, "H0 source reads only environment names passed
to its worker", is in the `test:p1-cli` glob. I reproduced this read-only in the detached
worktree at 7702e2b3:

```
✖ H0 source reads only environment names passed to its worker
  + actual - expected
  + [
  +   'SUPABASE_URL'
  + ]
  - []
```

Control: at base efe270c0, `git grep 'Deno\.env\.get' efe270c0 -- supabase/functions/h0` shows
only the three database names, which `DATABASE_ENV` covers. So the test passes at the base and
fails only because of forward.ts:158.

LANE.md records `test:p1-cli` as "Interrupted after a long silent stall ... No complete count
established". That incomplete gate is where this failure went unseen.

Fix: add the command-edge URL name to `FUNCTION_ENV_NAMES.h0`. Better, add a dedicated internal
name (see F3). Update `deploy/edge-runtime/README.md:40`, which says h0 reads only the database
names. Make a missing URL a named configuration failure that logs a fixed code, not
`h0_command_unreadable`, which claims the upstream answer was unreadable.

### F2. RIGOUR: forward.ts:159 reports a configuration error as an upstream-answer error.

`h0_command_unreadable` means "the command answered with something we could not read". A
missing base URL means "we never called the command edge". This is the same class of false
signal as F1, and it is why F1 would appear in production as a silent 502. Use a distinct code,
for example 500 `internal_error`, plus a fixed `console.error("h0 forwarding not configured")`.

### F3. RIGOUR: the forward target and the worker budget are not established.

The target comes only from the environment: `new URL("/functions/v1/command", base)` (forward.ts:162).
The request host header, path, and body cannot redirect it. `redirect: "manual"` (forward.ts:164),
and the h0 response never copies upstream headers, so no `Location` reaches the client. I found
no SSRF path.

What is not established is the value that F1's fix will supply. The command edge uses
`SUPABASE_URL` as its Storage base (`command/index.ts:1043,1091`), and the stack's
`deploy/supabase-stack/env.example:111` has `SUPABASE_URL=https://api.commonswarm.com`. If the h0
worker gets that same public value, each forward leaves the container, goes through public DNS,
Caddy, and possibly Cloudflare, and comes back into the edge runtime.

The command edge reads no client-IP header: its only `request.headers.get` calls are
`content-length` and `authorization`. So its rate limits and audit do not change. Any IP-based
limit in front of Caddy would see every H0 agent as the box's own address. That is not
measured. A dedicated internal URL, for example the runtime's own `http://127.0.0.1:9000`,
avoids the hairpin (a round trip out to the public edge and back).

Worker budget: `compose.yaml` sets `--policy per_worker`, `--max-parallelism 4`, and
`--request-wait-timeout 10000`, with five functions. A forwarded verb now needs an h0 worker and
a command worker alive at the same time. When a worker retires while a 50 s poll drains it, one
function can hold two slots. So "h0 old + h0 new + command + read" can make `activity` or
`capability` wait 10 s and return 504 `WORKER_LIMIT`. This is not a deadlock: it ends at the
10 s wait. It is also not measured. LANE.md says nothing about the worker budget.

### F4. RIGOUR: the pure contract test cannot detect a parser that accepts an extra named field.

`tests/p1-cli/h0-forward-contract.test.ts:547-551`:

```ts
const accepted = [...new Set([...literals, ...row.fields.map((field) => field.name), "unknown_field"])]
  .filter((key) => key in samples || key === "unknown_field")
```

The AST walk collects every string literal in parse.ts. The next filter then drops every literal
that is not in the test's hand-typed `samples` object. Suppose `FORWARD_FIELDS.ask.omittable`
gained `"about"` (parse.ts:98-106). The parser would accept `{body, about}`, but the test never
probes `about`, and `unknown_field` stays refused, so the test passes. "Accept exactly the table
fields" holds only for the eight names in `samples`, so the AST scan does nothing.

Fix: probe every literal. Give each unknown literal a string value, or derive the probe set from
`FORWARD_FIELDS` exported as data. The test is independent of the generated document, which is
correct: it reads `H0_VERBS`, not the document.

### F5. RIGOUR: the "same as a CLI command" parity test does not use the CLI's shape for ask and note.

`tests/p1-server/h0-forward.test.ts:213-218` builds the "direct" ask and note with a `to` array.
The CLI sends a scalar target (`src/cli.ts` `runPostSignal`, `...postSignalTargets(recipient)`,
which sets `to_agent_principal_id`). So the direct command copies h0's own mapping, not the CLI's.

The stored rows still compare equal, because a one-entry `to` fills the scalar column. But
`signalRow` (test:90-98) does not compare `swarm.signal_recipients`, which exists for the `to`
form. The reply case does match `runReply` exactly (`signal_kind: "note"`, null scalars,
`in_reply_to`), and it compares against a direct command, not against h0 output. So this
finding is about the test name and its coverage, not about behavior.

### F6. RIGOUR: the document does not state the wire rules, and a refusal names no field.

`parse.ts:136` enforces `requestId` against `/^[A-Za-z0-9_-]{8,72}$/`. That is a typed copy of
`COMMAND_ID_RE` (`command/index.ts:649`), not an import. The document says only
`requestId (may be omitted) — reuse the same value when retrying this post`, and its OpenAPI
schema is `"type": "string"` with no pattern. An agent that sends `"ask-1"` gets
`400 "Signal fields are malformed."` (parse.ts:140). That sentence covers five rules and names
none of them. `name` 1..80 has the same problem (parse.ts:131). Per AGENTS.md, build the rule
text and the document pattern from the enforcing constant.

### F7. RIGOUR: an oversized body is reported as "not a JSON object".

`readJson` returns `null` for a body over 16 KiB (forward.ts:38, 47-49). The parser then answers
`400 "The body must be a JSON object."`. The command edge answers the same case with
`413 payload_too_large`.

### F8. RIGOUR: forwarding opens a second database pool and does not classify a database failure.

`h0Database()` (forward.ts:66-74) opens its own `postgres` client beside the one in
`poll-ack.ts:101-113`, which adds one connection per h0 worker. The pool budget is not stated.

A failure in `workspaceForToken` rejects into `index.ts:74-77`, which returns 500
`internal_error`. Poll and ack send the same failure through `h0RetryableDatabaseFailure`.

The lookup also runs before any authentication, for any well-formed `swm_agt_` string. It is
cheap, and the command edge still authenticates, but h0 does not limit its rate.

### F9. RIGOUR: the claim in the attemptId sentence is wider than the command edge's rule.

`src/h0/verbs.ts:110` says: "retry with the same value recovers this seat and replaces an unused
token". The command edge recovers the seat only while its token is unused and the seat is live.
Otherwise it returns 409 `registration_token_already_used` or `registration_seat_revoked`
(`command/index.ts` `registerAgentSeat`). A reader can take "recovers this seat" as
unconditional. `h0-verbs.test.ts:354` pins this sentence, so a claim control now defends it.

Suggested wording: "retry with the same value while the token is unused to replace it; a used
token is refused".

### F10. RIGOUR: two server tests do not prove all of what their names say.

- The three-seat test (test:270-301) registers `third` but never polls it. It does not show
  that the ask reached only its addressee, so the third seat proves only that three principal
  ids are distinct.
- The register-recovery test (test:173-200) asserts that the retry's token differs from the
  first. It does not assert that the first token is now refused. The replacement-revokes claim
  has no control.

## Checked and found correct

- **Secrets.** The join credential goes only in `authorization: Bearer` to the command edge
  (forward.ts:139, 167). No URL, log, or document contains it. The only log line is the fixed
  `"h0 forwarding failed"` (index.ts:75). The query-credential refusal covers `swm_join_` values
  (parse.ts:164). A header value with CR or LF makes `fetch` throw; the catch turns that into a
  502 with no echo. A non-register response that carries `agent_token` is refused
  (forward.ts:108-111). The server test shows that a refused credential is not echoed.
- **Identity, rate limits, audit.** Each h0 call makes exactly one command call with the
  caller's own bearer, so rate limits are not bypassed or counted twice. Identity and audit are
  the command edge's. The command edge trusts no client-IP or other forwarded header.
  `workspaceForToken` is only a routing hint; the command edge authenticates again.
- **Register semantics.** A fresh `command_id` per call is correct, because `attempt_id` is the
  retry key (spec §4, §5). Same attempt and unused token: the token is replaced. Different
  attempt: a new seat. Used token: 409 with the stated human action. `icon` is accepted and
  dropped, and the document says so. Spec §7 defers icon storage.
- **Wire.** `requestId` maps to `command_id` for ask, note, reply, and working-on. `reply` maps to
  `note` plus `in_reply_to` with null scalars, the same as `cswarm reply`. Unknown fields are
  refused, required fields are enforced, and null is refused for every field. This matches the
  table, where all of these fields are non-nullable.
- **Headers.** Every forward response, the 405, and the aborted-poll 204 carry `cache-control:
  no-store` and `x-robots-tag`.
- **D-053.** No branch reads `error.message`. Every catch has no binding or ignores the error.
- **Gates.** `h0-forward-contract.test.ts` runs under the `test:p1-cli` glob.
  `h0-forward.test.ts` runs under the `test:p1-server` glob. `client_version` equals the CLI's
  `CLIENT_PROTOCOL_VERSION` (`"0.1.0"`), which the `min_client_version` floor accepts.

## Not established

- The `SUPABASE_URL` value in the box's edge environment file. The Cloudflare or Caddy path of
  a hairpinned forward.
- The worker-pool behavior under `per_worker` with 4 slots, and database connection headroom.
- I did not run the server suite or any database or Docker command. I ran one pure test file
  (`tests/p1-cli/edge-runtime-box.test.ts`, two named tests) in the detached worktree, with no
  writes.
- Process note: one of my read commands wrote a temporary copy of `command/index.ts` into
  `h0lanes/arms-5b/.cmd.ts`. I deleted it at once. No repository or worktree file changed.

F1 is a production failure of every forwarded verb on the box, and a committed pure gate fails
at this SHA.

VERDICT: FAIL
