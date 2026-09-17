# Client timeout table

This tool inventories shipped client wait bounds, classifies each call site, and measures safe reads. It writes no secret to its report or request log. It never writes to the origin.

A PASS row means the measured operation exercised the path that timeout guards, and `budget / p95 >= 2`. If the tool cannot measure that path safely, the row is `NOT MEASURED` and the process exits non-zero unless every such id is listed on `--acknowledge-not-measured`. A lower bound that already fails is conclusive: when the row is incomplete (`measures_guarded_path: false`) but the part it did measure already has p95 above half the budget, or the real client timed out, the row is `FAIL` and the process exits non-zero, acknowledgement or not.

## Commands

From the repository root, enumerate the working tree:

```sh
node scripts/timeout-table/enumerate.mjs
```

Enumerate the shipped `v0.1.71` sources without checking out the tag:

```sh
node scripts/timeout-table/enumerate.mjs --ref v0.1.71
```

Measure the shipped client against one base URL. Use absolute paths. The temporary ref worktree and profile copy are removed after success, failure, SIGINT, SIGTERM, SIGHUP, or an unexpected process exit.

```sh
node scripts/timeout-table/run.mjs \
  --ref v0.1.71 \
  --client /absolute/path/to/cswarm \
  --profile /absolute/path/to/profile.json \
  --base-url http://127.0.0.1:PORT \
  --runs 20 \
  --pause-ms 500 \
  --acknowledge-not-measured src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS,src/cloud/files.ts:REQUEST_TIMEOUT_MS,src/cloud/signals.ts:SIGNAL_READ_TIMEOUT_MS \
  --output /absolute/path/to/loopback-timeout-table.md
```

`--client` has no default. Without it, client operations are `NOT RUN`; `auth-settings`, `signal-read`, and the uncapped source check can still run. A production-window gate must pass `--client`. `--runs` defaults to 20. `--pause-ms` defaults to 500. Percentiles use the nearest-rank method. The report names the `--ref` and the `--client` path; inventory comes from the ref, timings come from the given client and the source helpers.

`--acknowledge-not-measured` is an exact list of inventory ids whose gate is `NOT MEASURED`. Extra ids fail. Missing ids fail. `FAIL` rows always fail the process. An acknowledgement on a `FAIL` row is not extra.

The preload rewrites requests whose origin equals the profile URL onto `--base-url`. It records only method, path without query, status, and duration, measured through the end of the cloned response body. A WebSocket uses method `CONNECT`. A request to any other origin is not forwarded. A relative URL is blocked; the log stores the pathname only, never the query or fragment. A write (`POST /functions/v1/command`, `POST /functions/v1/activity`, `POST` or `PUT` under `/storage/v1/`) is not forwarded. The operations above do not open Realtime, so Realtime needs a separate measurement. Child stdout and stderr are always captured.

## Operations

| Operation | Class | What it writes | What it removes | What is measured |
|---|---|---|---|---|
| `check` | safe-read, `measures_guarded_path: false` | `check.json` only inside the private profile copy | the complete private copy and isolated home | Whole-operation wall time of `checkAgentMessages` with a 120 s cap (directory + inbox reads, including bodies). Renewal is not exercised because `expires_at` is stripped. Gate is `NOT MEASURED` unless that sample's p95 is already above half the budget, in which case `FAIL`. |
| `signal-read` | safe-read, `measures_guarded_path: false` | nothing | nothing | One `readAgentSignalPage` call from the selected ref, including the response body. Limit 1. Does not post `signals_seen`. The timeout is per-request and covers the body. The helper wall time is that one request. The same constant also bounds the members directory, human PostgREST `/rest/v1/signals`, retries, and delivery-receipt reads, which are not run. Gate is `NOT MEASURED` unless that sample's p95 is already above half the budget, in which case `FAIL`. |
| `channel-ls` | safe-read | nothing | nothing | One `cswarm channel ls --json` agent read (`POST /functions/v1/read`, resource `channels`), including the body. |
| `file-ls` | safe-read, `measures_guarded_path: false` | nothing | nothing | One `cswarm file ls` metadata read. `REQUEST_TIMEOUT_MS` also guards file commands and storage downloads, which are not run. Gate is `NOT MEASURED` unless that sample's p95 is already above half the budget, in which case `FAIL`. |
| `auth-settings` | safe-read | nothing | nothing | One `GET /auth/v1/settings`, duration through the end of the body. Per-request. |

`cswarm inbox` is not a measured operation. It POSTs `signals_seen` for rendered broadcasts, with or without `--json`.

There are no bounded-write measurements. Signal, feedback, receipt, activity, delivery, channel mutation, capability, workspace, membership, file mutation, session, and credential operations are `not-run`. The reason and any proxy are in `mapping.json` for each source ID. A proxy fills p50/p95 columns only; the gate stays `NOT RUN`.

Before a check, the runner copies only the profile file and the credential file it names, into a new directory at mode `0700` with files at mode `0600`. It does not copy the parent directory. It rewrites the copied profile to use the copied credential named `credential.json`. It removes optional `expires_at` from the copied credential and gives the child an isolated `HOME`; this prevents automatic credential renewal and prevents reads from the running seat's state. The original profile and cursor are not opened by the child.

For the whole-operation check budget, each sample has two parts:

1. The released client runs with its real cap when `--client` is given, after the uncapped source sample on that iteration. The report counts every exit code and each output containing the stable `check_timeout` code. Any such timeout makes the row `FAIL`, including when the path is otherwise `NOT MEASURED`.
2. `checkAgentMessages` is imported from the selected source ref through `tsx` with a 120-second timeout. This uncapped wall time supplies p50, p95, max, and headroom. Because renewal is skipped, the gate is `NOT MEASURED` when headroom is `>= 2`, unless step 1 recorded `check_timeout`. If this sample already has p95 above half the budget, the gate is `FAIL`.

Client `--version` is run the same number of times. Its p50, p95, and max show the start-up cost inside Claude Code's five-second hook ceiling.

### Measurement vs timeout semantics

| Scope | Sample | Body |
|---|---|---|
| `per-request` | One matching HTTP request from that operation (max if the invocation made more than one). A per-request row with no matching log line is `NOT MEASURED`; the runner does not fall back to child wall time. | Duration includes the cloned response body. A fetch timeout that covers the body is compared to that number. |
| `whole-operation` | Child wall time, or the source helper's reported `duration_ms` for `check` and `signal-read`. `signal-read` is one page, so that wall time is one per-request sample of the helper, not a multi-path budget. | The helper reads the body before it reports. |

Nearest-rank p95 of 20 samples is the 19th sorted value. The slowest sample is dropped. Twenty sequential runs with a 500 ms pause describe that warm window; they do not prove cold-start or tail latency beyond p95.

## Inventory rules

The TypeScript compiler API reads tracked `.ts`, `.tsx`, and `.astro` client sources under `src/` and `site/src/`. Test, spec, and fixture files are excluded. It finds:

- numeric const declarations containing `TIMEOUT`, `DEADLINE`, or `BUDGET`, including `as const` and imported aliases (`HOOK_CHECK_TIMEOUT_MS = AGENT_CHECK_TIMEOUT_MS`);
- `AbortSignal.timeout(...)` calls, including identifiers and `??` numeric fallbacks;
- `timeoutMs`, `timeout`, `connect_timeout`, and other `TIMEOUT`/`DEADLINE`/`BUDGET` properties, parameter defaults, and `??` literals;
- namespace imports (`import * as T from "./x"` then `T.TIMEOUT_MS`), default imports, `export { TIMEOUT_MS } from "./x"` re-exports, `export * from "./x"`, and directory-index specifiers (`from "./config"` → `config/index.ts`);
- function-local timeout constants, each in its own scope so two functions can both declare `TIMEOUT_MS`;
- `setTimeout` and `setInterval` waits, including identifiers and `??` fallbacks.

Postgres and Claude hook seconds are converted to milliseconds. Non-time byte, character, and count budgets keep their raw value and are marked as non-time rows.

Inventory ids are `file:name`, with `#N` for the second and later same name in one file (`src/cli.ts:setTimeout#2`). The source line is report data only. A pure line shift does not change an id.

`mapping.json` is version 2. It holds one `refs.<ref>.rows` section per measured client. The window gate measures the released CLI (`v0.1.71`) and the next release (`HEAD`; `main` is an alias of that section). Omit `--ref` to use the `HEAD` section against the working tree. `run.mjs --ref <ref>` uses that section and refuses a ref with no section. The exact-set test fails for an unmapped inventory ID and for a stale mapped ID, for each measured ref.

## Mutation controls

| Control | Mutation proved to fail |
|---|---|
| Mapping completeness | For each measured ref, delete one live mapping row, or add a stale ID. |
| Line-independent ids | Insert lines above a fixture timeout site; ids must stay the same. |
| Enumerator forms | Remove handling of a `timeoutMs` default, a `??` literal, `as const`, `AbortSignal.timeout(IDENTIFIER)`, an import alias, a namespace property `T.TIMEOUT_MS`, a `requestTimeoutMs` property, a module-level const shadowed by a later local, a directory-index import, `export * from`, or two function-local `TIMEOUT_MS` values. |
| Headroom gate | Replace the slow fake-server delay with the fast delay, or reverse the `>= 2` comparison. An incomplete row with p95 already over half the budget must `FAIL` even when acknowledged. Zero-duration samples must `PASS` with infinite headroom, not `NOT RUN`. |
| Markdown PASS/FAIL | Feed `markdownReport` the fast durations and require `FAIL`, or the slow durations and require `PASS`. |
| Origin rewrite | Remove the rewrite; the original fake server receives the request and the target receives none. |
| Other-origin block | Allow a second origin through; that server receives a request. |
| Body duration | Record duration at headers; a delayed body then logs under 100 ms. |
| Write detector | Classify `POST /functions/v1/command` as a non-write, or skip `assertNoOriginWrites`. |
| Log privacy | Add request headers, body, query, or the secret-shaped value to a log row. A blocked relative URL with `?token=` must log the pathname only. |
| Profile cleanup | Remove either the success cleanup or the `finally` cleanup after an injected failure. |
| Profile copy set | Restore a recursive parent-directory copy; `sibling-secret.txt` appears in the copy. A source profile named `credential.json` must still copy. |
| Exit-path cleanup | Empty `cleanupRunResourcesSync`; an exit-13, SIGTERM, SIGHUP, or SIGINT child leaves a temp root, credential copy, and git worktree. Reverse `finalizeRunResources` to uninstall then delete; the uninstall callback sees the temp root. |
| FAIL / NOT MEASURED exit | Return from `runTable` while a row is `FAIL`, or while a `NOT MEASURED` id is missing from `--acknowledge-not-measured`. |
| `check_timeout` vs incomplete path | Set `measures_guarded_path: false` and `realTimeouts: 1`; the row must still be `FAIL`. |
| Per-request path | Record child wall time when the fetch log has no matching endpoint; `channel-ls` must not `PASS`. |
| Mixed operation scopes | Map two `safe-read` rows to one operation name with different scopes; `validateMapping` must throw. Omit `operation.name`; `validateMapping` must throw. |
| Child capture | Spawn `runChild` without `{ capture: true }`; stdout must still be in the result. |

Run the controls with:

```sh
env -u FORCE_COLOR node --import tsx --test tests/p1-cli/timeout-table.test.ts
```

## What the table does not establish

- It does not establish production latency until the lead runs it against the named URLs.
- It does not establish statement counts inside an edge function.
- It does not measure write-only rows marked `not-run`.
- A proxy establishes timing for the named proxy, not exact timing for the skipped operation. The gate for that row is `NOT RUN`.
- It does not measure Realtime because no safe operation in this table opens a WebSocket.
- Twenty sequential samples describe that test window. They do not prove future availability, cold-start, or tail latency beyond p95.
- A PASS proves `budget / p95 >= 2` for the measured operation on the guarded path. It does not prove the response data is correct.
- `check`, `file-ls`, and `signal-read` numbers can still be read while the gate is `NOT MEASURED`. They do not prove renewal, storage download, members-directory, human PostgREST, or delivery-receipt headroom. They do fail the process when the measured part is already slower than half the budget.
- A `setTimeout` whose delay is only a function parameter, with no numeric default in that scope, is not a row. The caller site that supplies the number is.

## Review round 1 (2026-09-17): rulings

| Claim (arm) | Ruling | Evidence and fix |
|---|---|---|
| `inbox --json` POSTs `signals_seen` while mapping/README called it a safe read with `writes: []` (grokTT PRODUCTION 1; grokTT RIGOUR) | CONFIRMED | Loopback: `cswarm inbox --limit 1 --json` exit 0 and `POST /functions/v1/command` `{"kind":"signals_seen","signal_ids":["00000000-0000-4000-8000-000000000099"]}`. Replaced inbox with `signal-read` (`readAgentSignalPage`). Mapping/README list writes. `assertNoOriginWrites` fails on a command POST. |
| PASS can be the wrong path: `file ls` vs storage download; `expires_at` stripped so check skips renewal (grokTT PRODUCTION 2; agyTTT2a 1.1, 1.3) | CONFIRMED | Mapping names storage and command for `REQUEST_TIMEOUT_MS` but `run.mjs` ran `file ls`. Copy deletes `expires_at`. Rows now set `measures_guarded_path: false` and gate `NOT MEASURED` unless acknowledged. |
| Enumerator misses `timeoutMs` defaults, `??` literals, `as const`, identifier `AbortSignal.timeout`, import aliases including HEAD `HOOK_CHECK_TIMEOUT_MS` (grokTT PRODUCTION 3; agyTTT1 PRODUCTION 4; agyTTT2a 1.4) | CONFIRMED | Fixtures enumerated to `[]`. HEAD hook inventory was empty; v0.1.71 had the numeric const. Enumerator now follows those forms. Fixture test plus HEAD `HOOK_CHECK_TIMEOUT_MS` value equals `AGENT_CHECK_TIMEOUT_MS`. |
| Check gate ignores real client `check_timeout` counts (agyTTT1 PRODUCTION 1) | CONFIRMED | `durations` came only from uncapped `duration_ms`. `summarize` now `FAIL`s when `realTimeouts > 0`. |
| `preload.cjs` records TTFB, not body (agyTTT1 PRODUCTION 2) | CONFIRMED | Header-then-250 ms body: log `duration_ms=7.5`, child wall ~292 ms. Preload now drains `response.clone().arrayBuffer()` before recording. |
| Whole-operation samples used `Math.max` of requests (agyTTT1 PRODUCTION 3) | CONFIRMED | `Math.max` still used for per-request (each request is independently bounded). Whole-operation uses child wall time or the source helper's `duration_ms`. |
| Profile copy copies the parent directory (agyTTT1 PRODUCTION 5) | CONFIRMED | Copy contained `sibling-secret.txt`. Copy is now the profile file plus the named credential file only. |
| No SIGHUP cleanup; Node does not emit `exit` on unhandled SIGHUP (agyTTT1 PRODUCTION 6) | CONFIRMED | SIGHUP child `signal=SIGHUP`, exit marker absent. Handler now `process.exit(129)`. Fixture test. Worktree path is recorded before `git worktree add`. |
| Preload does not rewrite a second origin (agyTTT1 PRODUCTION 7; agyTTT2a 1.5) | CONFIRMED | Other-origin server received 1 hit. Non-profile origins now throw and are not forwarded. |
| `run.mjs` exits 0 when a row is FAIL (grokTT RIGOUR; live agyTTT1) | CONFIRMED | Slow auth-settings 6 s vs 10 s budget: table had `FAIL`, process exit 0. `runTable` now throws on `FAIL` or unacknowledged `NOT MEASURED`. |
| Nearest-rank p95 of 20 drops the worst sample / cold start (agyTTT1 RIGOUR 8; agyTTT2a 1.2) | CONFIRMED | `percentile([1..20], 0.95) === 19`. Not changed: the gate contract is 2× p95. Documented. |
| `--client` is not checked against `--ref` (agyTTT1 RIGOUR 9) | CONFIRMED | Report now prints both. Inventory is still from `--ref`. Documented. |
| Teardown omits `exit` listener removal; missing `.d.mts` exports (agyTTT1 RIGOUR 10; agyTTT3 Finding 1) | CONFIRMED | Teardown now removes `exit`. `core.d.mts` / `run.d.mts` export the used functions. |
| `sourceRootForRef` uses `ref === null` (agyTTT3 Finding 2) | CONFIRMED | Now `ref == null`. |
| `chmod`/`writeFile` of temp root sat outside `try` (agyTTT3 Finding 3) | CONFIRMED | Those calls now sit inside `try`/`finally`. |
| Bounded writes unmeasured (agyTTT2a RIGOUR 2.1) | CONFIRMED | Kept `not-run`. The tool must not write to the origin. |
| `hook-hard-exit` omits `proxy_operation` (agyTTT2a RIGOUR 3.1) | CONFIRMED | Set `proxy_operation: "check"`. Gate stays `NOT RUN` for local class. |
| README operation names vs mapping keys (agyTTT2a RIGOUR 4.1) | CONFIRMED | README now uses mapping names (`signal-read`, `file-ls`, `auth-settings`, `channel-ls`). |
| `markdownReport` PASS not asserted (agyTTT2b) | CONFIRMED | Source uses `/\\| FAIL \\|/`; the test now also asserts `\| PASS \|` on fast durations. |
| Unit test uses 5 samples, not 20 (agyTTT2b) | CONFIRMED | `argsOf` default `runs === 20` is now asserted. The 5-iteration local delay test stays short. |
| `npm test` does not name `timeout-table.test.ts` (grokTT RIGOUR) | CONFIRMED | File is already in `test:p1-cli` glob and the lane gate invokes it directly. Not added to the `npm test` literal list. |

## Review round 2 (2026-09-17): rulings

| Claim (arm) | Ruling | Evidence and fix |
|---|---|---|
| `check_timeout` does not fail the process: `notMeasured` short-circuits `realTimeouts`; acked 3 s row exits 0 (grokTT2 PRODUCTION 1; grokTT2 RIGOUR 4, 5) | CONFIRMED | Loopback fake client printed `{"error":{"code":"check_timeout"}}`, exit 1; table `{"1":1} / 1`, gate `NOT MEASURED`, process exit 0. `summarize` now FAILs on `realTimeouts > 0` first. Test with `measures_guarded_path: false` and `realTimeouts: 1`. README: timeout still FAILs the row. |
| PASS with no request on the guarded path: silent `--client`, `channel-ls` PASS, origin had no `resource: channels` (grokTT2 PRODUCTION 2) | CONFIRMED | Loopback: channel row PASS at 33 ms, `channelHits=0`. Per-request no longer falls back to child wall time. Attempted safe-read with no sample is `NOT MEASURED`. |
| `SIGNAL_READ_TIMEOUT_MS` PASSes on agent page only; mapping lists directory and `/rest/v1` (grokTT2 PRODUCTION 3) | CONFIRMED | Loopback: signal row PASS, `restHits=0`. `readAgentSignalPage` only. Set `measures_guarded_path: false`; ack required. |
| Tests did not catch finding 1 (grokTT2 RIGOUR 4) | CONFIRMED | Old test used `realTimeouts: 1` without the incomplete-path flag. New test sets the flag. |
| README says `check_timeout` → FAIL and also NOT MEASURED even with headroom ≥ 2 (grokTT2 RIGOUR 5) | CONFIRMED | Both sentences were present. Aligned: `check_timeout` FAILs; otherwise the incomplete path is NOT MEASURED. |
| Cleanup race: uninstall signal handlers, then delete temp root (grokTT2 RIGOUR 6) | CONFIRMED | Child uninstalled then waited; SIGTERM left the temp root. `finally` now cleans up, then uninstalls. |
| Operation map last-write wins on `operation.name` (agyTT2T1 PRODUCTION 1) | CONFIRMED as code; REFUTED on live mapping | Live safe-read names do not mix scopes. Runner unions endpoints and throws on mixed scopes. `validateMapping` throws on mixed scopes. |
| `summarize` ignores `realExitCodes`; only the `check_timeout` substring increments `realTimeouts` (agyTT2T1 PRODUCTION 2) | CONFIRMED | `summarize([10], 3900, { realTimeouts: 0 })` is PASS. Kept the stable `check_timeout` code as the timeout classifier (other non-zero exits are not timeouts). Finding 1 now makes that count FAIL the row. |
| `check` then `check-uncapped` warms the origin before the p95 sample (agyTT2T1 PRODUCTION 3) | CONFIRMED | Source order was real client then uncapped. Uncapped now runs first. Twenty sequential runs remain a warm window (documented). |
| Omitting `--client` marks CLI ops `NOT RUN` and can exit 0 (agyTT2T1 RIGOUR 4) | CONFIRMED as documented | Loopback without `--client`: 34 `NOT RUN` rows, exit 0 after acking check/signal-read. README: a window gate must pass `--client`. `NOT RUN` is not `NOT MEASURED`. |
| Re-exports, namespace/default imports, property access, and `requestTimeoutMs` properties missed (agyTT2T1 RIGOUR 5; agyTT2T5a PRODUCTION 4) | CONFIRMED on fixtures; no live `import * as` | Fixtures enumerated to `[]` for namespace property access and `{ requestTimeoutMs: 12_000 }`. Enumerator now follows those forms and `export { TIMEOUT_MS } from "./x"`. New host `requestTimeoutMs` and agent-channel deadline rows mapped `not-run`. |
| Measurement child stdout/stderr dropped (agyTT2T1 RIGOUR 6) | CONFIRMED | `runChild` used `stdio ignore` unless `capture`. Always capture; throw includes truncated stdout/stderr. Test: client exit 7 with `channel boom`. |
| README lists `signal-read` as per-request and as whole-operation helper time (agyTT2T2 RIGOUR 1) | CONFIRMED | Both sentences were present. Operations table: per-request timeout, one page, NOT MEASURED. Measurement table: helper wall time is that one request. |
| `AbortSignal.timeout` and `AUTH_SETTINGS_TIMEOUT_MS` both `safe-read` `auth-settings` (agyTT2T3b RIGOUR) | CONFIRMED | Both mapped to the same GET. Call site is now `not-run` / use of the constant. |
| Exit fixture omits SIGINT (agyTT2T4 RIGOUR 1) | CONFIRMED | `sigint` mode exited 2. Fixture and test added; handler already called `process.exit(130)`. |
| `summarize` tests used uniform samples only (agyTT2T4 RIGOUR 2) | CONFIRMED | 18×10 ms + 2×80 ms vs 100 ms budget is FAIL (`p95=80`). Arm's 19+1 example PASSes under nearest-rank (documented). |
| `runTable` integration used `runs: 1` only (agyTT2T4 RIGOUR 3) | CONFIRMED | Now `runs: 2`; auth-settings has two durations. |
| `makePrivateProfileCopy` never writes `credential_file` to the copied profile (agyTT2T5a PRODUCTION 1) | REFUTED | Disk `credential_file` is the copy path; live path not used; `expires_at` stripped. Split review of Grok commits. |
| Commit `18241582` omitted `run.mjs` (agyTT2T5a PRODUCTION 2) | REFUTED | `git show --name-only 18241582` lists `scripts/timeout-table/run.mjs` (142-line diff). T5a/T5b split omitted mapping/README. |
| SIGHUP handler missing (agyTT2T5a PRODUCTION 3) | REFUTED | `installRunResourceCleanup` registers SIGHUP; existing fixture test exit 129. |
| `localConstantInitializers` flattens scopes (agyTT2T5a RIGOUR 5) | CONFIRMED | Fixture inner `TIMEOUT_MS = 100` made module `AbortSignal.timeout` 100. Module-level bindings are recorded first. |
| Uninstaller leaks `exit` listener (agyTT2T5a RIGOUR 6) | REFUTED | `removeListener("exit", onExit)` is present; counts return to baseline. |
| Claude hook seconds conversion missing (agyTT2T5a RIGOUR 7) | REFUTED | `HOST_HOOK_TIMEOUT_SECONDS` → 5000 ms; `agent-receive.ts:timeout` and `seed.ts:timeout` convert. |
| Redundant `oneOperation` dispatch branches (agyTT2T5b RIGOUR 1) | REFUTED | Current `run.mjs` runs real check then `check-uncapped`; not three identical branches. |
| `realTimeouts` unused because `runTable` throws on first non-zero (agyTT2T5b RIGOUR 2) | REFUTED | Real check exit 1 does not throw; throw is the measurement child. Overlap with grokTT2 PRODUCTION 1. |
| Relative `fetch` in preload catch throws before `record()` (agyTT2T5b RIGOUR 3) | CONFIRMED | `fetch("/functions/v1/read")` exited 1 with empty log. Catch now records BLOCKED without requiring an absolute URL. |

## Review round 3 (2026-09-17): rulings

| Claim (arm) | Ruling | Evidence and fix |
|---|---|---|
| Incomplete path with p95 already over half the budget stays `NOT MEASURED`; acked window exits 0 (grokTT3 PRODUCTION 1; grokTT3 RIGOUR 1) | CONFIRMED | Loopback HEAD, 2200 ms delay on `/functions/v1/read`: check p95 2221 ms vs 3900 ms, headroom 1.76, gate `NOT MEASURED`, process would exit 0 with ack. `rowSummary` 2226 vs 3900 same. `summarize` now FAILs when `headroom < 2` before `notMeasured`. Ack on a FAIL row is not extra. Test: incomplete `[70]` vs 100 ms is `FAIL` even when acked. |
| `file-ls` uses the same incomplete-path skip (grokTT3 PRODUCTION 1) | CONFIRMED as the same gate | Same `notMeasured` short-circuit. The 2216 ms file-ls vs 30 s budget would still be `NOT MEASURED` (headroom > 2). The new lower-bound rule FAILs that row only when its own p95 is already over half its budget. |
| Credentials and writes: 0700/0600 copy, `expires_at` stripped, no origin writes (grokTT3 PRODUCTION 2) | CONFIRMED holding (no defect) | Copy modes 0700/0600; `credential_file` is the copy path; sibling secret absent; command/activity/storage hits 0. SIGHUP/SIGINT/SIGTERM/exit-13 cleanup already present. |
| `runTable` finally order is untested (grokTT3 RIGOUR 2) | CONFIRMED | Source already cleaned up then uninstalled. Fixtures never uninstall. Added `finalizeRunResources`; test asserts the temp root is gone inside the uninstall callback. |
| Omitting `--client` marks CLI ops `NOT RUN` and can exit 0 (grokTT3 RIGOUR 3) | CONFIRMED as documented | Loopback `client: null`: `channel-ls` / `file-ls` `NOT RUN`. README: a window gate must pass `--client`. `NOT RUN` is not `PASS`. |
| Blocked relative `fetch` logs the raw query string (agyTT3T1a PRODUCTION query leak) | CONFIRMED | `fetch("/api/query?token=secret123")` log path `/api/query?token=secret123`. `pathOnly()` now stores pathname only. |
| Enumerator drops directory-index imports and `export *` (agyTT3T1a PRODUCTION; live `cli.ts:turnBudgetMs`) | CONFIRMED | Fixture `from "./config"` and `export * from "./config"`: `use.ts` rows `[]`. Live HEAD `src/cli.ts:turnBudgetMs` absent (import through `listener/index.js` `export *`). Enumerator now follows both. Mapped `turnBudgetMs` and `deliveryHoldBudgetMs` as `not-run` / `listener-prompt-site`. Scoped lookup dropped five `setTimeout` rows whose delay was only a parameter (wrongly bound to a sibling `timeoutMs` before); mapping no longer lists them. |
| Relative `WebSocket` throws before `record()` (agyTT3T1a PRODUCTION) | CONFIRMED | `new WebSocket("/realtime/v1/websocket")` exit 2, empty log, `TypeError: Invalid URL`. Catch now records `CONNECT` `BLOCKED` with pathname only. |
| Profile named `credential.json` collides with the credential copy (agyTT3T1a RIGOUR) | CONFIRMED | `EEXIST` on `profile/credential.json`. Profile copy is now `profile.json` when the source basename is `credential.json`. |
| Zero-duration samples report `NOT RUN` (agyTT3T1a RIGOUR) | CONFIRMED | `summarize([0,0,0,0,0], 100)` → `headroom null`, gate `NOT RUN`. p95 0 is now infinite headroom / `PASS`. |
| `runChild` still drops stdio unless `capture: true`; `--version` omits capture (agyTT3T1a RIGOUR; agyTT3T1b RIGOUR) | CONFIRMED | Default `runChild` stdout/stderr empty. Always pipe. |
| `validateMapping` accepts a safe-read with no `operation.name` (agyTT3T1a RIGOUR) | CONFIRMED | Unnamed entry validated. Name is now required. |
| `check-uncapped` omits `capture` / uses `probe.mjs` (agyTT3T5 RIGOUR 1) | REFUTED | Cut mismatch. Real tree: `source-check.ts` with `{ capture: true }`. |
| Nested locals share a flat Map (agyTT3T5 RIGOUR 2) | CONFIRMED | Two functions `TIMEOUT_MS = 1000` and `2000`: both `AbortSignal.timeout` rows were 1000. Enumerator now uses per-block scopes. |
| README / mapping chunks / tests in T2 T3 T4 T1b remainder (agyTT3T2, T3a–d, T4a–b, T1b PASS slices) | CONFIRMED holding (no defect) | Read against the real tree. Antigravity parts were cut at line boundaries; missing-file claims were checked on disk. |
