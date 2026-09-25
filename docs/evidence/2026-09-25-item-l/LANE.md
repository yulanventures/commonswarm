# Item L lane record — exactly-once file puts

Branch `lane/item-l`, based on `c6a227e4` (origin/main at assignment: `084f8a22`). This is source and local evidence only. No production host or real workspace was contacted. No schema or server handler changed.

Source commit `f6a480bf`; test commit `4847c430`.

## Decisions → change → test → mutation

| Decision | Change | Test and measured mutation |
|---|---|---|
| Stable identity across processes | `src/cloud/exact-file-put.ts` derives UUIDv5 file, version, create-command, and commit-command IDs from workspace, principal, request ID, lowercased target name, and SHA-256. The server's create handler replaces the proposed file ID with the existing name's ID; for a new name it accepts the proposed ID. Storage path is `<workspace>/<file_id>/<version_n>`, unique to the created version. A legacy bare token has no local principal claim, so CLI `--request-id` refuses it instead of using a token digest that would change on rotation. | `exact-file-put.test.ts` lost-response and deleted-record cases; identity mutation (random derivation) exit 1, 1 test / 0 pass / 1 fail. MCP process-kill cases: random create or commit ID mutations each exit 1, 1/0/1. Bare-token-refusal mutation exits 1, 1/0/1. |
| Durable local resume state | One 0600 JSON record per workspace/principal/request ID in a 0700 state directory beside an MCP profile or under the CLI state root. It is written before create, updated after create, PUT, and commit, pruned to 200 records and to the 3-hour sweep window. It stores no credential, signed URL, or token. | Persist-before-network, phase, mode, bound, and fake-clock tests. Mutations disabling first write, phase write, 200 bound, or 3-hour expiry each exit 1, 1/0/1. |
| Reused ID with changed input | A matching local record checks name, content hash, size, and `if_version` before file network calls; mismatch raises typed `request_id_conflict`. The check and first write hold a cross-process file lock so two different contents cannot both prepare. If the record was deleted, identical content reuses the derived IDs and the result reports `conflict_check: "unavailable"`. A newly written record also reports unavailable for historical conflict checking: without a prior record, the client cannot know whether one was deleted. | Unit, CLI, and MCP stdio checks assert no second create. Tests delete the record both after commit and after create but before PUT. Concurrent different-content and same-content tests pass; lock and random-command-ID mutations each exit 1, 1/0/1. Conflict-check bypass and false-available mutations each exit 1, 1/0/1. |
| Lost create, PUT, or commit response | Create and commit reuse their command IDs. Fold 1 supersedes the Storage refusal rule in this row; see below. The signed path is version-specific and upsert-off. | Stateful fake edge/storage tests for each lost phase, three killed MCP processes, and an expired-URL fake clock. Original lane mutation counts are preserved below; Fold 1 tests and mutations follow. |
| Preflight and brain compare-and-set | Size cap and extension map are checked before create/PUT. `brain_put` carries `if_version`, and precondition refusal remains typed and replay-safe. | Unit and MCP stdio tests. Size, type, and `if_version` omission mutations each exit 1, 1/0/1. |
| MCP and CLI surfaces | Stdio MCP `file_put {request_id,path,name?}` and `brain_put {request_id,topic,path,if_version?}` read absolute local paths. Responses project commit fields plus outcome and conflict status, never upload capability fields. CLI file and brain puts accept `--request-id`; without it, IDs remain fresh per invocation. Profile expansion retains its private state path for the CLI upload. Command table entries now name both tools and the item-L bridge marker is removed. | MCP stdio, direct file CLI, direct brain CLI, and command-table tests. CLI request-ID branch mutations for file and brain, command-table and MCP-list renames for both tools, absolute-path check, and profile-state-path retention each exit 1, 1/0/1. |

The source mutation commands changed one production condition at a time, ran a focused test with a timeout, and restored the original source in `finally`. All 26 source mutations and the three built-MCP process mutations failed the intended focused test (exit 1, 1/0/1). The final focused suite passed 86/86 with serial test-file execution. The added server test is typechecked but **reasoned, not run** in this lane.

## Mutation inventory

Each source row is a measured focused test: exit 1; 1 test, 0 pass, 1 fail. Source was restored after every probe. The three process rows also had build exit 0 before test exit 1.

| Mutation | Result |
|---|---|
| `identity` | exit 1; 1/0/1 |
| `durability` | exit 1; 1/0/1 |
| `conflict` | exit 1; 1/0/1 |
| `concurrent-conflict-lock` | exit 1; 1/0/1 |
| `concurrent-same-id` | exit 1; 1/0/1 |
| `duplicate-put` | exit 1; 1/0/1 |
| `lost-create` | exit 1; 1/0/1 |
| `lost-commit` | exit 1; 1/0/1 |
| `size-cap` | exit 1; 1/0/1 |
| `type-refusal` | exit 1; 1/0/1 |
| `precondition` | exit 1; 1/0/1 |
| `phase-record` | exit 1; 1/0/1 |
| `conflict-check-honesty` | exit 1; 1/0/1 |
| `deleted-after-create-identity` | exit 1; 1/0/1 |
| `record-bound` | exit 1; 1/0/1 |
| `sweep-window` | exit 1; 1/0/1 |
| `expired-url` | exit 1; 1/0/1 |
| `cli-request-id` | exit 1; 1/0/1 |
| `brain-cli-request-id` | exit 1; 1/0/1 |
| `bare-token-refusal` | exit 1; 1/0/1 |
| `command-table` | exit 1; 1/0/1 |
| `brain-command-table` | exit 1; 1/0/1 |
| `mcp-list` | exit 1; 1/0/1 |
| `brain-mcp-list` | exit 1; 1/0/1 |
| `absolute-path` | exit 1; 1/0/1 |
| `profile-state-location` | exit 1; 1/0/1 |
| `killed-after-create` | build 0; test exit 1; 1/0/1 |
| `killed-after-put` | build 0; test exit 1; 1/0/1 |
| `killed-after-commit` | build 0; test exit 1; 1/0/1 |

## Gates

| Gate | Exit and count | Notes |
|---|---|---|
| `npm run build` | 0 | Final TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1; 990 tests, 988 pass, 2 fail | Final run with temporary HOME. Both failures are sandbox `spawn EPERM` for `ps` in resume tests. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1; 976 tests, 973 pass, 3 fail | Final run with temporary HOME. All three failures are sandbox `spawn EPERM` for `ps` in resume/whoami tests. The new item-L tests passed. Earlier exact runs without temporary HOME also produced protected-home `EPERM` and expected help-baseline drift; those conditions were corrected before this final run. |
| `npm run check:tests` | 0 | Typechecked the added server test. |
| `npm run check:edge` | 0 | No edge handler change. |
| `npm run build:command-core` then `git diff --exit-code supabase/functions/_shared/protocol.js` | 0, 0 | Generated bundle unchanged. |
| `bash scripts/build-release.sh` | 0 | Final single-file bundle built and executed. |
| `npm --prefix site run build` | 0 after temporary writable dependency copy; 12 pages | Initial exit 1: site/node_modules links to a cache outside the writable worktree, and Vite got `EPERM` unlinking `_metadata.json`. A local dependency copy under ignored `scratchpad/` let the named site build complete. Original symlink restored. |
| `git diff --check origin/main...HEAD` | 0; 15 paths in the range | Full committed range, including the brief already on this branch, measured after the evidence commit. |

## Not established

- The local-stack server test in `tests/p1-server/file-artifacts.test.ts` was not run here. The lead measured the local Storage duplicate response reported in Fold 1; the corrected test and derived-ID create/commit sequence still need an exclusive local-stack run. No migration was applied.
- When the resume record is deleted after create but before PUT, the fake confirms the derived create ID still produces one version and `conflict_check` says unavailable. The server's source returns the same create body for a first create and a replay, with no replay marker. If that retry's PUT succeeds, the client cannot distinguish it from a first attempt and may report `outcome: "committed"` rather than `"replayed"`. A server replay indicator would be needed to guarantee that label in this record-loss case; this lane stopped short of a server change as instructed.
- Fresh-URL recovery after expiry is deferred. On a replayed PUT, commit checks whether bytes are present and can return typed `file_bytes_missing`. Replay after the three-hour sweep is not established.
- CLI invocation with a legacy bare agent token is refused for `--request-id` because it has no locally available principal claim. Profile-backed MCP, minted credential artifacts, and human CLI credentials use stable principal/user IDs. A person using only a bare token must obtain its minted credential artifact or saved profile first.
- The CLI writes its resume record before `file_version_create` and storage PUT, but credential/session resolution happens first and may contact the authentication service. The strict pre-network conflict guarantee is measured for MCP; CLI tests establish no *file* network call on a known local conflict.
- `pgrep` process inventory was attempted at the end, but exited 3 with `sysmond service not found` in this sandbox. The test fixtures close their child processes, and timeout wrappers kill their process groups, but an independent final process-list check is not established here.
- Branch content is neither landed nor live; no cross-family review or CI result is claimed in this lane.

## Fold 1 — Ruling L1 (2026-09-24)

The lead measured local storage-api v1.54.1 refusing a second upsert-off signed PUT with HTTP 400 and body
`{"statusCode":"409","error":"Duplicate","message":"The resource already exists"}`. The HTTP/body shape of
production storage-api v1.77.5 is **not established**. The old client accepted only HTTP 409, so a lost-PUT retry
failed against the measured local shape. The server test now asserts the local 400 body, then commits with the same
derived commit command ID and checks one live version. That server test is left for the lead's exclusive local stack.

Ruling L1: the resume record now records `putting` before the PUT request. A later attempt whose record shows a PUT
started, or the second in-process attempt after a no-response failure, proceeds to `file_version_commit` after any
Storage PUT refusal. The commit handler's `storage.objectSize(version.storage_path)` decides whether bytes exist:
present bytes can commit/replay; absent bytes yield typed `file_bytes_missing`, never a replayed success. The first
PUT still stops on an ordinary refusal; structured HTTP 400 (`statusCode: "409"`, `error: "Duplicate"`) and HTTP 409
duplicate responses are optional fast paths. Derived IDs and the same commit command ID remain unchanged.

The create handler assigns `storagePath = ${workspaceId}/${fileId}/${versionN}` after selecting `versionN` under its
file/workspace locks (`supabase/functions/command/file-artifacts.ts`); the server test asserts this per-version key.
The commit handler checks that exact `storage_path` before changing the pending row to live.

| Fold 1 verification | Exit and count |
|---|---|
| Focused source and MCP stdio tests | 0; 44 tests, 44 pass, 0 fail. Each of HTTP 400 duplicate, HTTP 409 duplicate, and HTTP 403 expired URL tests both present and missing bytes; commit controls the result. First PUT 403 reports unknown without committing. |
| Mutation: disable replay-refusal continuation | 1; focused expired-403 test: 3 tests, 2 pass, 1 fail. |
| Mutation: remove HTTP 400 structured duplicate fast path | 1; deleted-record test: 1 test, 0 pass, 1 fail. |
| `npm run build` | 0. |
| `env -u FORCE_COLOR npm test` | 1; 990 tests, 988 pass, 2 fail. Both are unrelated sandbox `spawn EPERM` in real `ps`/resume tests. |
| `env -u FORCE_COLOR npm run test:p1-cli` | Initial run: exit 124 after a 240-second process-group timeout, with 220 passing lines and no suite total. Bounded rerun with `--test-concurrency=4 --test-timeout=30000`: exit 1; 982 tests, 979 pass, 3 fail. All three are sandbox `ps` spawn `EPERM`; Item L tests passed. |
| `npm run check:tests`; `npm run check:edge` | 0; 0. |
| `npm run build:command-core`; generated bundle diff | 0; 0, unchanged. |
| `bash scripts/build-release.sh` | 0; checked single-file bundle. |
| `npm --prefix site run build` | Initial exit 1, Vite cache `EPERM` under the shared dependency symlink; exit 0 with a writable dependency copy, 12 pages. Original link restored. |
| `git diff --check origin/main...HEAD` | 0; 15 paths in the committed range. |

The local-stack server test, production v1.77.5 Storage refusal shape, and a final process
inventory (`pgrep` returned `sysmond service not found`) are not established here. The timeout wrapper killed its
process group. No production host, real workspace, migration, or local stack lifecycle command was used.

## Fold 2 — Round 1 rulings (2026-09-24)

Starting point `444db2b7`. Opus's two production findings and all rigour findings, plus Grok's prune and CLI notes, were read in full. The lead had already measured the server file-artifacts test at 22/22 on the local stack at that SHA; this fold did not run or change the stack.

| Ruling | Change | Regression and reverted-fix probe |
|---|---|---|
| P1 | `src/mcp/errors.ts` owns file refusal sentences and next steps. Missing bytes, transport, 429, and 5xx advise retrying the same `request_id`; even an `unknown` result takes its next step from that table. Argument refusals name an argument fix; actual 401/403 access loss names a person. | `every typed file refusal has an owned next step` checks each put refusal code and status; MCP 5xx and dropped-socket tests check the generated step on `unknown`. Removing the missing-bytes entry: exit 1, 0/1. The 5xx branch is separately killed below. |
| P2 | Terminal commit codes are persisted as `refused` with code and status. A same-id retry throws that code before create or PUT. Missing bytes, HTTP 429, and access refusals remain retryable. | `terminal commit refusal replays without any network or PUT` checks the saved phase, exact code, and unchanged create/PUT/commit counts; removing the early refusal check: exit 1, 0/1. Rate-limit and restored-access retries each passed 1/1; classing access loss as terminal: exit 1, 0/1. |
| R3 | Prune removes malformed or wrong-mode records under the lock and reports each removed record once to stderr. Other request IDs continue. | `bad JSON and wrong mode records do not block another request` checks both errors, removal, two warnings total, and another fresh request; restoring a throwing prune: exit 1, 0/1. |
| R4 | MCP `file_put`/`brain_put` lstat, resolve, open nonblocking, fstat, and cap the file before reading. A regular file only; missing, directory, FIFO, and FIFO symlink are typed argument errors. Resolved paths inside the CLI state roots, profile directory, or credential file are refused. | `MCP path preflight refuses nonfiles and private state before network` checks each path plus a positive regular-file control and zero file commands on refusals. Removing private-root checking or the separate credential-file check: each exit 1, 0/1. |
| R5 | Local name conflict comparison now ignores case, matching the server. Derived IDs and record keys retain workspace and principal. The created phase is persisted. File create 5xx remains `unknown`. | `if_version and name case`, `workspace and principal both namespace`, `created phase is durable`, and `MCP 5xx file create reports unknown` pass. The five surviving Opus mutations were rerun: if-version comparison off, derived ID seat removed, record key seat removed, created write removed, and 5xx-to-typed; **each exit 1, 0/1**. |
| R6 | `request_id_conflict` tells the model new content needs a new `request_id`; the precondition refusal says to reread the topic and use a NEW request ID. | The typed-refusal test checks both. Restoring the old conflict step: exit 1, 0/1. |
| R7 | CLI credential resolution again precedes file reading when `--request-id` is absent. Legacy size and extension messages are retained. JSON conflicts with `--request-id` emit `{code:"request_id_conflict"}` on stdout for both puts. | Legacy file and brain order tests, legacy file copy checks, and file/brain JSON conflict tests pass. Moving file or brain credential resolution after the read, or disabling the JSON conflict branch: each exit 1, 0/1. |
| R8 | Command entries explicitly mark MCP-served tools; the agreement test compares the complete marked set with `MCP_TOOLS`. Removed the stale assertion text. | `file and brain puts are model tools on the stdio transport`; unmarking `file_put`: exit 1, 0/1. |
| R9 | `replayed` now requires a previously saved completed commit. Storage's duplicate PUT proves bytes existed, but not a prior commit; a successful commit in the current call reports `committed`. The server commit response has no replay marker. | Killed-after-create and duplicate-PUT cases expect `committed`, while a saved committed record expects `replayed`. Restoring the prior-record-based label: exit 1, 0/1. |
| R10 | Phase writes skip any earlier phase; an uploaded record never becomes created or putting again. | `an uploaded resume record never writes an earlier phase`; removing the phase guard: exit 1, 0/1. |
| R11 | Prune exempts the record being checked for this request ID at the 200-record bound. | `prune protects the current request record at the 200-record bound`; removing the exemption: exit 1, 0/1. |

All mutation probes changed one source condition at a time, ran the named focused test with a process timeout, and restored the source. The final focused file/brain/exact-put/MCP/command-table run passed **107/107**. `npm run check:tests` passed after the final source and test edits.

### Fold 2 gates

All commands used an isolated temporary HOME. Logs are local scratch artifacts under `/private/tmp/iteml-*` and are not committed.

| Gate | Exit and count |
|---|---|
| `npm run build` | 0; TypeScript build. |
| `env -u FORCE_COLOR npm test` | 1; 990 tests, 988 pass, 2 fail. Both failures are sandbox `spawn EPERM` for real `ps` in resume tests. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1; final exact run: 997 tests, 994 pass, 3 fail. All three failures are sandbox `ps` spawn `EPERM` in resume/process-table/whoami tests. Every Item L test passed. |
| `npm run test:p1-cli -- --test-concurrency=4 --test-timeout=30000` | 124; bounded follow-up after the restored-access test, with 221 passing TAP lines and no suite total before the 240-second process-group timeout. No test assertion failure appeared before termination. The final focused Item L suite passed 107/107 separately. |
| `npm run check:tests` | 0; rerun after final test additions. |
| `npm run check:edge` | 0. |
| `npm run build:command-core` and generated protocol diff | 0 and 0; bundle unchanged. |
| `bash scripts/build-release.sh` | 0; single-file artifact built and version-checked. |
| `npm --prefix site run build` | 0; 12 pages. |
| `git diff --check origin/main...HEAD` | 0. |

### Not established in Fold 2

- No production Storage behavior was measured. The local-stack server test's 22/22 is the lead's pre-fold measurement at `444db2b7`; the server test was not rerun in this worktree. No production host or real workspace was contacted, and no migration or local-stack lifecycle command ran.
- With a lost record or a crash after the server committed but before the client saved the result, the commit response cannot distinguish first commit from replay. The client now says `committed` because `replayed` would lack evidence. Exactly-once version creation still rests on the derived IDs and server ledger.
- URL renewal after the two-hour expiry remains deferred as in the brief. `file_bytes_missing` is retryable with the same ID, but convergence after URL expiry is not established.
- The final `pgrep` inventory could not run in this sandbox (`sysmond service not found`, exit 3). Test fixtures closed their children and the bounded suite's process group was killed, but an independent process-list proof is not established.
