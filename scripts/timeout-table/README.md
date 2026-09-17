# Client timeout table

This tool inventories shipped client wait bounds, classifies each call site, and measures safe reads. It writes no secret to its report or request log.

## Commands

From the repository root, enumerate the working tree:

```sh
node scripts/timeout-table/enumerate.mjs
```

Enumerate the shipped `v0.1.71` sources without checking out the tag:

```sh
node scripts/timeout-table/enumerate.mjs --ref v0.1.71
```

Measure the shipped client against one base URL. Use absolute paths. The temporary ref worktree and profile copy are removed after success, failure, SIGINT, SIGTERM, or an unexpected process exit.

```sh
node scripts/timeout-table/run.mjs \
  --ref v0.1.71 \
  --client /absolute/path/to/cswarm \
  --profile /absolute/path/to/profile.json \
  --base-url https://edge-staging.commonswarm.com \
  --runs 20 \
  --pause-ms 500 \
  --output /absolute/path/to/edge-staging-timeout-table.md
```

Run the reference URL as a separate invocation:

```sh
node scripts/timeout-table/run.mjs \
  --ref v0.1.71 \
  --client /absolute/path/to/cswarm \
  --profile /absolute/path/to/profile.json \
  --base-url https://api.commonswarm.com \
  --runs 20 \
  --pause-ms 500 \
  --output /absolute/path/to/api-timeout-table.md
```

`--client` has no default. Without it, client operations are `NOT RUN`; the auth-settings probe and uncapped source check can still run. `--runs` defaults to 20. `--pause-ms` defaults to 500. Percentiles use the nearest-rank method.

The preload changes only requests whose origin equals the profile URL. It records only method, path without query, status, and duration. A WebSocket uses method `CONNECT`. The operations above do not open Realtime, so Realtime needs a separate measurement.

## Operations

| Operation | Class | What it writes | What it removes |
|---|---|---|---|
| `check` | safe-read | `check.json` only inside the private profile copy | the complete private copy and isolated home |
| `inbox --limit 1` | safe-read | nothing | nothing |
| `file ls` | safe-read | nothing | nothing |
| `GET /auth/v1/settings` | safe-read | nothing | nothing |

There are no bounded-write measurements. Signal, feedback, receipt, activity, delivery, channel, capability, workspace, membership, file mutation, and credential operations are `not-run`. The reason and any proxy are in `mapping.json` for each source ID.

Before a check, the runner copies the profile directory with directories at mode `0700` and files at mode `0600`. It rewrites the copied profile to use the copied credential. It removes optional `expires_at` from the copied credential and gives the child an isolated `HOME`; this prevents automatic credential renewal and prevents reads from the running seat's state. The original profile and cursor are not opened by the child.

For the whole-operation check budget, each sample has two parts:

1. The released client runs with its real cap. The report counts every exit code and each output containing the stable `check_timeout` code.
2. `checkAgentMessages` is imported from the selected source ref through `tsx` with a 120-second timeout. This uncapped wall time supplies p50, p95, max, and headroom.

Client `--version` is run the same number of times. Its p50, p95, and max show the start-up cost inside Claude Code's five-second hook ceiling.

## Inventory rules

The TypeScript compiler API reads tracked `.ts`, `.tsx`, and `.astro` client sources under `src/` and `site/src/`. Test, spec, and fixture files are excluded. It finds:

- numeric const declarations containing `TIMEOUT`, `DEADLINE`, or `BUDGET`;
- numeric `AbortSignal.timeout(...)` calls;
- numeric `timeoutMs`, `timeout`, and `connect_timeout` properties;
- direct numeric `setTimeout` and `setInterval` waits.

Postgres and Claude hook seconds are converted to milliseconds. Non-time byte, character, and count budgets keep their raw value and are marked as non-time rows.

Inventory ids are `file:name`, with `#N` for the second and later same name in one file (`src/cli.ts:setTimeout#2`). The source line is report data only. A pure line shift does not change an id.

`mapping.json` is version 2. It holds one `refs.<ref>.rows` section per measured client. The window gate measures the released CLI (`v0.1.71`) and the next release (`HEAD`; `main` is an alias of that section). Omit `--ref` to use the `HEAD` section against the working tree. `run.mjs --ref <ref>` uses that section and refuses a ref with no section. The exact-set test fails for an unmapped inventory ID and for a stale mapped ID, for each measured ref.

## Mutation controls

| Control | Mutation proved to fail |
|---|---|
| Mapping completeness | For each measured ref, delete one live mapping row, or add a stale ID. |
| Line-independent ids | Insert lines above a fixture timeout site; ids must stay the same. |
| Headroom gate | Replace the slow fake-server delay with the fast delay, or reverse the `>= 2` comparison. |
| Origin rewrite | Remove the rewrite; the original fake server receives the request and the target receives none. |
| Log privacy | Add request headers, body, query, or the secret-shaped value to a log row. |
| Profile cleanup | Remove either the success cleanup or the `finally` cleanup after an injected failure. |
| Exit-path cleanup | Empty `cleanupRunResourcesSync`; an exit-13 or SIGTERM child leaves a temp root, credential copy, and git worktree. |

Run the controls with:

```sh
env -u FORCE_COLOR node --import tsx --test tests/p1-cli/timeout-table.test.ts
```

## What the table does not establish

- It does not establish production latency until the lead runs it against the named URLs.
- It does not establish statement counts inside an edge function.
- It does not measure write-only rows marked `not-run`.
- A proxy establishes timing for the named proxy, not exact timing for the skipped operation.
- It does not measure Realtime because no safe operation in this table opens a WebSocket.
- Twenty sequential samples describe that test window. They do not prove future availability or tail latency beyond p95.
- A PASS proves `budget / p95 >= 2` for the measured operation. It does not prove the response data is correct.
