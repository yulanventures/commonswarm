# H0 lane 5b: forwarding verbs (2026-09-22)

## Change and design

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

## Tests and scripts

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

## Gates

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

## Not established

- Optional `icon` is accepted but has no stored effect: the command edge's
  `register_agent_seat` wire and principal schema have no icon field. The agent
  document states this limit.
- The sandbox did not allow the existing process-inspection tests to pass, and
  the full CLI suite did not complete. The focused H0 CLI tests did pass.
- No production host, hosted service, release or deployment was contacted or
  exercised. Box runtime behavior and the three-host done-test remain open.
