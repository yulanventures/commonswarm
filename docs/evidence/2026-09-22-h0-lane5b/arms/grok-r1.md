I'll review lane 5b as a read-only check against the H0 spec and the verb table, starting with the lane record, the diff, and the normative sections.The forwarder and tests are in place. Next I’ll check the command edge’s auth, rate limits, and worker budget against the spec.The box only passes a fixed env allowlist into the h0 worker. I'll check whether this lane's `SUPABASE_URL` read is on that list, and run the pure test that pins it.The five forwarded verbs return 502 on the box. The h0 worker's environment allowlist never includes `SUPABASE_URL`, so the forward never calls the command function.

## Findings

### 1. PRODUCTION — the box h0 worker cannot see the command URL

`handleH0ForwardRequest` builds the upstream URL only from `SUPABASE_URL`, and returns 502 `h0_command_unreadable` when that name is missing:

```158:164:supabase/functions/h0/forward.ts
  const base = Deno.env.get("SUPABASE_URL");
  if (!base) return unreadable();
  let upstream: Response;
  try {
    upstream = await fetch(new URL("/functions/v1/command", base), {
      method: "POST",
      redirect: "manual",
```

```32:34:supabase/functions/h0/forward.ts
function unreadable(): Response {
  return json(502, { error: "h0_command_unreadable" });
}
```

The main service passes each user worker only `FUNCTION_ENV_NAMES` for that function. For h0 that list is the three database names:

```181:185:deploy/edge-runtime/main/router.ts
const DATABASE_ENV = [
  "SWARM_DATABASE_URL",
  "SUPABASE_DB_URL",
  "SWARM_DATABASE_TLS_CA_B64",
] as const;
```

```214:215:deploy/edge-runtime/main/router.ts
  // Poll and ack read the same database environment names as command.
  h0: DATABASE_ENV,
```

```82:87:deploy/edge-runtime/main/index.ts
    const worker = await EdgeRuntime.userWorkers.create({
      servicePath: `${FUNCTIONS_ROOT}/${route.functionName}`,
      memoryLimitMb: USER_WORKER_MEMORY_MB,
      workerTimeoutMs: USER_WORKER_TIMEOUT_MS,
      noModuleCache: false,
      envVars: environmentFor(route.functionName),
```

`register`, `ask`, `note`, `reply`, and `working-on` therefore answer 502 on the box. The incoming host and path are not part of the upstream URL (`new URL("/functions/v1/command", base)`), so a request cannot point the forward at another host. The forward never starts.

The server gate stays green because `tests/p1-server/h0-forward.test.ts` starts `supabase functions serve` (line 109), which is a different environment from this allowlist. The pure gate that compares h0's `Deno.env.get` names with the allowlist fails. I ran it:

`node --import tsx --test --test-name-pattern "H0 source reads only environment" tests/p1-cli/edge-runtime-box.test.ts`

Exit 1. Actual missing name: `SUPABASE_URL` (`tests/p1-cli/edge-runtime-box.test.ts:70-76`). That file is included by `npm run test:p1-cli`. The lane record says that full run did not finish. The focused 30/30 run does not include this test.

### 2. PRODUCTION — one forward holds two of the four workers, and a waiting poll makes a short burst fill the pool

The runtime is `--policy per_worker` with `--max-parallelism 4` and `--request-wait-timeout 10000` (`deploy/edge-runtime/compose.yaml:13-24`). A waiting poll holds one worker for up to 50 seconds, and `H0_MAX_CONCURRENT_WAITS` is 1 (`src/h0/verbs.ts:94`, `deploy/edge-runtime/README.md:37-39`). That is the steady state of this API.

Each forward keeps its own worker until `fetch` returns, and the fetch is another `/functions/v1/command` request on the same pool. The only abort is the caller's signal. There is no deadline in the forward:

```162:177:supabase/functions/h0/forward.ts
    upstream = await fetch(new URL("/functions/v1/command", base), {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        ...(credential === null ? {} : { authorization: `Bearer ${credential}` }),
      },
      body: JSON.stringify({
        command_id: commandId,
        client_version: CLIENT_PROTOCOL_VERSION,
        workspace_id: workspaceId,
        stream: { kind: "workspace" },
        command,
      }),
      signal: request.signal,
    });
```

With the poll on one worker, three overlapping forwards take the other three. No worker remains for `command`. Those inner calls wait 10 seconds and then the main service answers 504 `WORKER_LIMIT` (`deploy/edge-runtime/main/router.ts:28-33`). `commandResponse` treats that JSON object as a readable command response and returns it with status 504 (`supabase/functions/h0/forward.ts:92-119`). For those 10 seconds the pool has no free worker for command, read, capability, activity, or another h0 call. Four overlapping forwards do the same with no poll at all. The command edge's rate limiter never sees those requests, because they never enter `command`.

When a forward does reach `command`, it is one HTTP call with the caller's bearer. Signal limits are `signal:credential:…` and `signal:workspace:…` inside that call (`supabase/functions/command/index.ts:5224-5258`). h0 writes no bucket of its own. `insertAudit` records the actor from that bearer and writes `ip` as NULL (`supabase/functions/command/index.ts:1527-1549`). h0 does not copy `x-forwarded-for` or session-proof headers. Register's `workspace_id` is a random UUID and `registerAgentSeat` uses the locked join credential's workspace (`supabase/functions/command/index.ts:8899-8903`). For the other verbs, `resolveRoute` rejects a workspace that is not the token's (`supabase/functions/command/index.ts:2841-2845`).

### 3. RIGOUR — the contract test does not see an extra field the parser allows

`tests/p1-cli/h0-forward-contract.test.ts:36-41` builds candidate keys from string literals in `parse.ts`, the verb-table names, and `"unknown_field"`, then keeps only keys that sit in a hand-written `samples` object. An allowed name that is not in `samples` is never sent to `parseH0ForwardBody`. The parser's live allowlist is a second copy, `FORWARD_FIELDS` (`supabase/functions/h0/parse.ts:98-107`). Today that copy matches the verb table: unknown keys are refused, every required key must be present, and any null is refused, which matches `nullable: false` on all five verbs. The test does not read the generated document. It also does not lock the wire renames. Those are in the forwarder: `requestId` becomes `command_id` (`forward.ts:155-157`) and reply's `signal_id` becomes `in_reply_to` (`forward.ts:147-151`). The server parity test compares stored rows with a direct `command` call (`tests/p1-server/h0-forward.test.ts:226-235`), including `in_reply_to`.

## Checked, and holding

Secrets stay out of h0 logs, h0 error bodies, the upstream URL, redirect targets, and the agent document. Failures log fixed strings (`supabase/functions/h0/index.ts:74-76`). The query-string bearer check runs before the forward (`forward.ts:127-132`). `redirect: "manual"` is set, and the client response copies only `content-type`, `cache-control`, and `x-robots-tag` (`forward.ts:112-118`). A non-register body that contains top-level `agent_token` becomes 502 (`forward.ts:108-110`). The register success body returns the seat token once, which is the spec's rule. `icon` is parsed and omitted from `register_agent_seat`, whose keys are `kind`, `attempt_id`, and `name` (`forward.ts:143-144`, `command/index.ts:2259`). The verb note and the golden document both say this release does not store an icon. The same `attemptId` is passed through as `attempt_id`. The command edge recovers that seat only while the token is unused, and replaces it (`command/index.ts:6128-6184`). A different `attemptId` inserts another attempt and spends a seat (`command/index.ts:6393-6405`). h0 issues a new `command_id` on every register, so the retry takes that attempt path. No new h0 code branches on `error.message`. Both new test files sit under the globs for `test:p1-cli` and `test:p1-server`.

VERDICT: FAIL
