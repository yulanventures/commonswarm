I'll review lane 5b at `6cfb063e` as a read-only check: the in-process command forward, identity and rate-limit behavior, secrets, and whether the new tests actually prove the claims.The fold switches the forward from HTTP to an in-process `handleRequest`. I'll read that path against the command handler's real request checks, then the round-1 findings.The in-process forward fixes the round-1 box failure and the two-worker hold. One pinned sentence in the agent document still tells the caller the wrong next step after a used registration token.

## Findings

### 1. PRODUCTION — the attemptId note tells a used token to ask for a new join credential

`src/h0/verbs.ts:123` (rendered into the agent document and pinned at `tests/p1-cli/h0-verbs.test.ts:354` and `tests/p1-cli/fixtures/h0-agent-document.golden.json:32`):

```text
retry with the same value while its token is unused to recover this seat and replace that token; a used token returns 409, so ask the inviter for a new join credential
```

The unused-token half matches the command edge. The remedy does not. A retry whose token has `first_used_at` set returns 409 `registration_token_already_used` with this message (`supabase/functions/command/index.ts:6132-6147`):

```text
Revoke that seat and register again.
```

That is the human action in spec §5. The same join credential still accepts a different `attemptId` and spends another seat until the seat cap (`supabase/functions/command/index.ts:6187-6201`). The seat-cap refusal is the one that says to mint a new join credential. The document attaches that advice to the used-token 409. An agent that follows the document will ask for a new paste. The 409 body says to revoke the seat and register again.

## Checked

In-process call. `supabase/functions/h0/forward.ts:159-174` builds one `Request` to `https://command.internal/functions/v1/command` and calls `handleRequest`. There is no `fetch`. The host, path, and body cannot choose another target. `supabase/functions/command/index.ts:11405` starts `Deno.serve` only when `import.meta.main` is set. Edge Runtime v1.73.13 loads each function's `index.ts` with `load_main_es_module`, so the command worker still serves, and an import from the h0 worker does not. The import does create the command module's pool (`max: 2` at `command/index.ts:1066-1071`) inside the h0 isolate, beside poll/ack's pool (`max: 1` at `poll-ack.ts:108-109`). That is the stated three connections for one warm h0 isolate. I did not measure live Postgres headroom.

Caller identity and command checks. The synthetic request carries `content-type` and `Authorization` only, plus the caller's abort signal. `handlePostRequest` authenticates that bearer and runs the same database rate buckets, idempotency ledger, and audit as a direct command. Audit writes `ip` as NULL (`command/index.ts:1549`); the command edge reads no client-IP header. Origin is used only to set CORS on the inner response, and `commandResponse` does not copy those headers. Session-proof headers are not forwarded. For an unmanaged seat (`managed_at` null, which is how `register_agent_seat` inserts the principal) `enforceAgentSessionProof` returns success before it reads the proof. A managed principal fails closed with `session_proof_missing`. H0 still caps the body at 16 KiB and returns 413 `payload_too_large`; the command handler then applies its own 128 KiB limit to the rebuilt envelope.

Secrets. The join credential is copied from the register body into `Authorization` only. The seat token is returned only on a register JSON body. Other verbs that contain a top-level `agent_token` become 502. Logs on this path are the fixed strings `h0 command configuration missing` and `h0 forwarding failed`. The query-string refusal runs before the forward. The agent document says the credential is not in the document.

Service-role key and test hooks. `FUNCTION_ENV_NAMES.h0` is `COMMAND_ENV`, so the h0 worker receives `SUPABASE_SERVICE_ROLE_KEY`. The only reader is `fileStorage()` (`command/index.ts:1081-1084`), and the adapter never builds a file command. Nothing in the h0 response or its fixed logs prints the key. `environmentFor` (`deploy/edge-runtime/main/index.ts:50-55`) drops `SWARM_CMD_TEST_SLEEP_AFTER_STEP` and `SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP` unless `SWARM_ENV` is `test`. If those values are present and `SWARM_ENV` is not `test`, importing the command module throws before it serves.

Verb table and tests. Unknown keys are refused, and presence and nullability are compared with `H0_VERBS` from the parser's own `FORWARD_FIELDS` (`tests/p1-cli/h0-forward-contract.test.ts:18-79`). That test does not read the generated document. `requestId` uses `H0_REQUEST_ID_RE`; `name` uses `H0_REGISTRATION_NAME_MAX`. `icon` is parsed and omitted from `register_agent_seat`; the note and the golden both say this release does not store an icon. No new h0 code branches on `error.message`. `h0-forward-contract.test.ts` is under `test:p1-cli`; `tests/p1-server/h0-forward.test.ts` is under `test:p1-server`. The parity case sends the direct ask/note with scalar `to_agent_principal_id` and compares `swarm.signals` columns with that direct command. I ran the pure files: 46 passed, 0 failed. I did not run the server suite.

A command-transaction `40001` or `40P01` still becomes the command handler's 500 (`command/index.ts:11370-11372`). The shared 503 applies to errors thrown in the h0 adapter, including the workspace lookup. With `--policy per_worker`, a forward no longer takes a second function worker. One h0 isolate can run the waiting poll and the forward together. It does not hold two of four slots.

VERDICT: FAIL
