# Client timeout table

This tool inventories shipped client wait bounds, classifies each call site, and measures safe reads. It writes no secret to its report or request log. It never writes to the origin.

A PASS row means the measured operation exercised the path that timeout guards, and `budget / p95 >= 2`. If the tool cannot measure that path safely, the row is `NOT MEASURED` and the process exits non-zero unless every such id is listed on `--acknowledge-not-measured`.

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
  --acknowledge-not-measured src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS,src/cloud/files.ts:REQUEST_TIMEOUT_MS \
  --output /absolute/path/to/loopback-timeout-table.md
```

`--client` has no default. Without it, client operations are `NOT RUN`; `auth-settings`, `signal-read`, and the uncapped source check can still run. `--runs` defaults to 20. `--pause-ms` defaults to 500. Percentiles use the nearest-rank method. The report names the `--ref` and the `--client` path; inventory comes from the ref, timings come from the given client and the source helpers.

`--acknowledge-not-measured` is an exact list of inventory ids whose gate is `NOT MEASURED`. Extra ids fail. Missing ids fail. `FAIL` rows always fail the process.

The preload rewrites requests whose origin equals the profile URL onto `--base-url`. It records only method, path without query, status, and duration, measured through the end of the cloned response body. A WebSocket uses method `CONNECT`. A request to any other origin is not forwarded. A write (`POST /functions/v1/command`, `POST /functions/v1/activity`, `POST` or `PUT` under `/storage/v1/`) is not forwarded. The operations above do not open Realtime, so Realtime needs a separate measurement.

## Operations

| Operation | Class | What it writes | What it removes | What is measured |
|---|---|---|---|---|
| `check` | safe-read, `measures_guarded_path: false` | `check.json` only inside the private profile copy | the complete private copy and isolated home | Whole-operation wall time of `checkAgentMessages` with a 120 s cap (directory + inbox reads, including bodies). Renewal is not exercised because `expires_at` is stripped. Gate is `NOT MEASURED`. |
| `signal-read` | safe-read | nothing | nothing | Whole `readAgentSignalPage` call from the selected ref, including the response body. Limit 1. Does not post `signals_seen`. Per-request timeout covering the body. |
| `channel-ls` | safe-read | nothing | nothing | One `cswarm channel ls --json` agent read (`POST /functions/v1/read`, resource `channels`), including the body. |
| `file-ls` | safe-read, `measures_guarded_path: false` | nothing | nothing | One `cswarm file ls` metadata read. `REQUEST_TIMEOUT_MS` also guards file commands and storage downloads, which are not run. Gate is `NOT MEASURED`. |
| `auth-settings` | safe-read | nothing | nothing | One `GET /auth/v1/settings`, duration through the end of the body. Per-request. |

`cswarm inbox` is not a measured operation. It POSTs `signals_seen` for rendered broadcasts, with or without `--json`.

There are no bounded-write measurements. Signal, feedback, receipt, activity, delivery, channel mutation, capability, workspace, membership, file mutation, session, and credential operations are `not-run`. The reason and any proxy are in `mapping.json` for each source ID. A proxy fills p50/p95 columns only; the gate stays `NOT RUN`.

Before a check, the runner copies only the profile file and the credential file it names, into a new directory at mode `0700` with files at mode `0600`. It does not copy the parent directory. It rewrites the copied profile to use the copied credential named `credential.json`. It removes optional `expires_at` from the copied credential and gives the child an isolated `HOME`; this prevents automatic credential renewal and prevents reads from the running seat's state. The original profile and cursor are not opened by the child.

For the whole-operation check budget, each sample has two parts:

1. The released client runs with its real cap when `--client` is given. The report counts every exit code and each output containing the stable `check_timeout` code. Any such timeout makes the row `FAIL`.
2. `checkAgentMessages` is imported from the selected source ref through `tsx` with a 120-second timeout. This uncapped wall time supplies p50, p95, max, and headroom. Because renewal is skipped, the gate is `NOT MEASURED` even when headroom is `>= 2`.

Client `--version` is run the same number of times. Its p50, p95, and max show the start-up cost inside Claude Code's five-second hook ceiling.

### Measurement vs timeout semantics

| Scope | Sample | Body |
|---|---|---|
| `per-request` | One matching HTTP request from that operation (max if the invocation made more than one). | Duration includes the cloned response body. A fetch timeout that covers the body is compared to that number. |
| `whole-operation` | Child wall time, or the source helper's reported `duration_ms` for `check` and `signal-read`. | The helper reads the body before it reports. |

Nearest-rank p95 of 20 samples is the 19th sorted value. The slowest sample is dropped. Twenty sequential runs with a 500 ms pause describe that warm window; they do not prove cold-start or tail latency beyond p95.

## Inventory rules

The TypeScript compiler API reads tracked `.ts`, `.tsx`, and `.astro` client sources under `src/` and `site/src/`. Test, spec, and fixture files are excluded. It finds:

- numeric const declarations containing `TIMEOUT`, `DEADLINE`, or `BUDGET`, including `as const` and imported aliases (`HOOK_CHECK_TIMEOUT_MS = AGENT_CHECK_TIMEOUT_MS`);
- `AbortSignal.timeout(...)` calls, including identifiers and `??` numeric fallbacks;
- `timeoutMs`, `timeout`, and `connect_timeout` properties, parameter defaults, and `??` literals;
- `setTimeout` and `setInterval` waits, including identifiers and `??` fallbacks.

Postgres and Claude hook seconds are converted to milliseconds. Non-time byte, character, and count budgets keep their raw value and are marked as non-time rows.

Inventory ids are `file:name`, with `#N` for the second and later same name in one file (`src/cli.ts:setTimeout#2`). The source line is report data only. A pure line shift does not change an id.

`mapping.json` is version 2. It holds one `refs.<ref>.rows` section per measured client. The window gate measures the released CLI (`v0.1.71`) and the next release (`HEAD`; `main` is an alias of that section). Omit `--ref` to use the `HEAD` section against the working tree. `run.mjs --ref <ref>` uses that section and refuses a ref with no section. The exact-set test fails for an unmapped inventory ID and for a stale mapped ID, for each measured ref.

## Mutation controls

| Control | Mutation proved to fail |
|---|---|
| Mapping completeness | For each measured ref, delete one live mapping row, or add a stale ID. |
| Line-independent ids | Insert lines above a fixture timeout site; ids must stay the same. |
| Enumerator forms | Remove handling of a `timeoutMs` default, a `??` literal, `as const`, `AbortSignal.timeout(IDENTIFIER)`, or an import alias. |
| Headroom gate | Replace the slow fake-server delay with the fast delay, or reverse the `>= 2` comparison. |
| Markdown PASS/FAIL | Feed `markdownReport` the fast durations and require `FAIL`, or the slow durations and require `PASS`. |
| Origin rewrite | Remove the rewrite; the original fake server receives the request and the target receives none. |
| Other-origin block | Allow a second origin through; that server receives a request. |
| Body duration | Record duration at headers; a delayed body then logs under 100 ms. |
| Write detector | Classify `POST /functions/v1/command` as a non-write, or skip `assertNoOriginWrites`. |
| Log privacy | Add request headers, body, query, or the secret-shaped value to a log row. |
| Profile cleanup | Remove either the success cleanup or the `finally` cleanup after an injected failure. |
| Profile copy set | Restore a recursive parent-directory copy; `sibling-secret.txt` appears in the copy. |
| Exit-path cleanup | Empty `cleanupRunResourcesSync`; an exit-13, SIGTERM, or SIGHUP child leaves a temp root, credential copy, and git worktree. |
| FAIL / NOT MEASURED exit | Return from `runTable` while a row is `FAIL`, or while a `NOT MEASURED` id is missing from `--acknowledge-not-measured`. |

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
- `check` and `file-ls` numbers can still be read while the gate is `NOT MEASURED`. They do not prove renewal or storage download headroom.

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
