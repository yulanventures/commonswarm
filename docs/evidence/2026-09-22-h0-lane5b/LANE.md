# H0 lane 5b: forwarding verbs (2026-09-22)

## Initial change and design (superseded by Fold 1)

Implementation commit `e926e734`. `POST /functions/v1/h0/register`, `ask`, `note`, `reply`, and `working-on` now
parse their table-declared fields and forward one HTTP request to the command
function at the configured `SUPABASE_URL`. This uses the command edge's existing
authentication, registration attempt record, rate buckets, command-id ledger,
and audit. A direct in-process call would bypass its HTTP authentication gate.
The adapter resolves the seat's workspace from a token-hash lookup only to fill
the command route; the command edge reauthenticates and authorizes that route.
The adapter does not follow redirects with a credential. No token or join
credential is logged or placed in a URL.

| H0 verb | H0 request | Command sent |
|---|---|---|
| register | `joinCredential`, `attemptId`, `name`, optional `icon` | `register_agent_seat` with `attempt_id`, `name`; join credential in Authorization |
| ask | `body`, optional `to`, `requestId` | `post_signal` `ask`, null scalar targets and reply, optional `to`; `requestId` becomes `command_id` |
| note | same as ask | `post_signal` `note`, same addressing and ID mapping |
| reply | `signal_id`, `body`, optional `requestId` | `post_signal` `note` with `signal_id` as `in_reply_to`; `requestId` becomes `command_id` |
| working-on | `body`, optional `requestId` | `post_signal` `working-on`, no recipient; `requestId` becomes `command_id` |

All command responses that are JSON objects keep the upstream status and exact
body. An unreadable or oversized answer becomes 502 `h0_command_unreadable`.
Every H0 response has `Cache-Control: no-store` and `x-robots-tag`, including
an aborted poll's 204. The generated agent document and golden fixture now
explain retries and the optional icon's current behavior.

## Initial tests and scripts

- `tests/p1-cli/h0-forward-contract.test.ts` in `npm run test:p1-cli`:
  the parsers' accepted field sets, required keys, and nullability equal the
  verb table independently of the generated document. Its focused run passed.
- `tests/p1-server/h0-forward.test.ts` in `npm run test:p1-server`:
  register retry preserves a seat and remints an unused token, a new attempt
  consumes another seat, and revoked or malformed credentials are refused
  without an echo. It compares all four signal verbs' stored rows with direct
  CLI-equivalent command calls; verifies `requestId` replay, malformed-body and
  bearer refusals; and runs the three-seat ask, poll, ack, reply path. Four tests
  passed both focused and in the full server gate.
- Existing `tests/p1-cli/h0-verbs.test.ts` and
  `tests/p1-cli/h0-agent-document.test.ts` verify the generated document and
  golden fixture. The focused H0 CLI run passed 30/30.

## Initial gates

Run in this worktree, with `test:p1-server` alone:

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build |
| `env -u FORCE_COLOR npm test` | 1 | 895 pass, 2 existing sandbox `spawn EPERM` failures in resume process tests |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Interrupted after a long silent stall; existing sandbox process failures included `spawnSync ps EPERM`. No complete count established. Focused H0 CLI: 30/30, exit 0. |
| `npm run check:tests` | 0 | Test type-check |
| `npm run check:edge` | 0 | Five edge entry points |
| `env -u FORCE_COLOR npm run test:p1-server` | 0 | 242/242, including all four H0 forwarding tests |
| `bash scripts/build-release.sh` | 0 | Shipped bundle ran, version 0.1.72 |
| `git diff --check origin/main...HEAD` | 0 | Checked after implementation commit `e926e734`; the evidence-only commit will be checked again. |

## Initial limits

- Optional `icon` is accepted but has no stored effect: the command edge's
  `register_agent_seat` wire and principal schema have no icon field. The agent
  document states this limit.
- The sandbox did not allow the existing process-inspection tests to pass, and
  the full CLI suite did not complete. The focused H0 CLI tests did pass.
- No production host, hosted service, release or deployment was contacted or
  exercised. Box runtime behavior and the three-host done-test remain open.

## Fold 1

The HTTP forward was removed. `h0/forward.ts` now creates a fresh `Request` with
only JSON content type, the caller credential in `Authorization`, and the command
envelope in the body. It calls the exported `command/index.ts` `handleRequest`
inside the H0 worker. `index.ts` still serves that same handler when it is the
entry module; an import does not start another server. The command handler still
runs its own authentication, rate limits, idempotency, audit, and authorization.
The adapter's workspace lookup remains a routing hint. There is no HTTP redirect
to follow, no credential in a URL, and no copied `Location` header.

The box router now uses one `COMMAND_ENV` allowlist for both `command` and `h0`.
Besides the three database names, H0 receives `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SWARM_ENV`,
`SWARM_COMMAND_ALLOWED_ORIGINS`, `SWARM_CAPABILITY_URLS`,
`SWARM_SELF_SERVE`, `SWARM_CMD_TEST_SLEEP_AFTER_STEP`, and
`SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP`. These are the names read by the command
handler, including its test hooks. A missing command configuration now logs the
fixed line `h0 command configuration missing` and returns 500
`h0_command_not_configured`. The database lookup shares the command pool; H0
poll and ack keep their one-connection pool. A warm H0 worker can open at most
three database connections (two command plus one poll/ack). A forwarded verb
occupies one edge worker slot.

The forward parser contract test reads `FORWARD_FIELDS` from the parser AST and
compares its complete required and omittable sets with the verb table. As a
mutation control, adding `about` to ask's parser allowlist made that test fail
with `ask omittable` (exit 1); restoring the parser made its two tests pass
(exit 0). The server parity test now sends ask and note's direct command using
the CLI's scalar `to_agent_principal_id`. The three-seat test polls the third
seat, and registration recovery tests both refusal of the replaced token and
409 after the recovered token is used. Oversized H0 bodies return 413
`payload_too_large`. Forward database errors use the same SQLSTATE 40001/40P01
retryable 503 classifier as poll and ack.
The pure SQLSTATE test sends 40001 and 40P01 through that shared classifier,
checks the stable 503 body and H0 headers without wildcard CORS, and confirms
that nonretryable errors do not take the retry path.

The shared `H0_REQUEST_ID_RE` and `H0_REGISTRATION_NAME_MAX` are used by the
command edge, H0 parser, verb table, and generated OpenAPI schema. The document
states the request ID pattern, the 1..80 character name bound, and that retrying
an attempt recovers a seat only while its token is unused. It tells a caller
whose token was used to ask the inviter for a new join credential.

### Fold 1 verification

| Gate | Exit | Measured result |
|---|---:|---|
| `npm run build` | 0 | TypeScript CLI build completed. |
| `env -u FORCE_COLOR npm test` | 1 | 895/897 pass. The two failures are existing sandbox `spawn EPERM` resume process tests. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Completed: 818/836 pass. H0 parser, document, configuration, SQLSTATE and box environment tests pass. The 18 failures are sandbox denied `~/.cswarm` lock files (7), denied `ps` or process calls (3), and credential-store warnings on stderr in receipt/feed fixtures (8). The 1,248-fixture dispatcher baseline passed separately and in this gate. |
| `npm run check:tests` | 0 | Test and source typecheck completed. |
| `npm run check:edge` | 0 | Five edge entry points checked. |
| `env -u FORCE_COLOR npm run test:p1-server` | 0 | 242/242 pass, including all four H0 forwarding tests, run alone. |
| `bash scripts/build-release.sh` | 0 | Built and executed the 0.1.72 single-file CLI. |
| `git diff --check origin/main...HEAD` | 0 | Checked after the Fold 1 commit. |

An initial server run was 241/242: the new replaced-token test expected 401,
while the command handler correctly returned 403 `forbidden`. The assertion
was corrected before the 242/242 run. The exact CLI gate was first interrupted
after a silent interval; that interval came from the existing dispatcher
baseline's 1,248 sequential fixtures, which took about 195 seconds in a
focused run. The final exact CLI run was allowed to complete.

No box worker load test, production host behavior, production database pool
headroom, or three-host done-test was established here. The reviewed code and
local suite establish the worker path and a per-worker maximum of three
connections; they do not measure live concurrency or deployed state.
