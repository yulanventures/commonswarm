# Item L — exact review (Anthropic arm, Opus 5.5), round 1

Reviewed: `git diff 084f8a22..444db2b7` (docs/design skipped) in the detached worktree
`scratchpad/arms-l` at `444db2b734f3c8a0c14449c2ecb250423d8d6188`. I changed no file in that worktree. Probes are in
`scratchpad/itemL/opus-r1-probes/`. All probe servers ran on loopback. Mutations ran in a scratch copy
(`opus-r1-probes/mut`, `mut2`). I contacted no production host and did not touch the local Supabase stack.

## Gates I ran (temporary HOME)

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| Focused: exact-file-put, mcp-stdio, file-verbs, brain-verbs, command-table-gates | exit 0; 92/92 |
| `env -u FORCE_COLOR npm test` | exit 0; 990/990 |
| `env -u FORCE_COLOR npm run test:p1-cli` | exit 0; 982/982 (no `ps` EPERM on this host) |
| `npm run check:tests` | exit 0 |
| Sampled mutations (in a copy) of claimed controls: no-lock, Fold 1 off, Fold 1 always-on, conflict off, `putting` not persisted, 400-duplicate fast path off | each exit 1, as LANE.md claims. The no-op control mutation passes 14/14. |

The changed test files are all in a gate: `tests/p1-cli/**` goes through the `test:p1-cli` glob, and
`tests/p1-server/file-artifacts.test.ts` goes through the `test:p1-server` glob. I did not run the server test, because the lead owns the stack.

## What holds (checked with evidence)

- **Upload path is per version.** `supabase/functions/command/file-artifacts.ts:724-725`:
  `const versionN = Number(maxRows[0]?.n ?? "0") + 1; const storagePath = \`${workspaceId}/${fileId}/${versionN}\`;`
  This is computed under the workspace and file row locks. Version rows are never deleted, so `max(version_n)` only goes up and a path is never used twice.
- **Backstop against a second version.** `file-artifacts.ts:702-712` refuses a taken `version_id`
  (`version_id_unavailable`). The ledger recheck after the locks (`:533-548`) replays a concurrent same-id create. So a
  derived `version_id` can own at most one row, even when both the ledger row and the local record are gone.
- **Derived identity is collision-safe.** `exact-file-put.ts:74` joins `[workspace, principal, request_id, lower(name),
  sha256]` with `\0`. The request id pattern `^[A-Za-z0-9_-]{8,72}$` has no `\0`, the UUIDs have a fixed width, and the sha256 is the last field with a fixed width, so the tuple parses one way only. A same id with a different name case or `if_version` and no record gives the same ids with a different body, which gives a typed `command_id_conflict`. It does not give a second version.
- **Same id with different content and a record present:** a typed `request_id_conflict` before any network call (unit, CLI, and MCP tests; the no-conflict mutation fails 2 tests). **Record gone:** new ids and `conflict_check: "unavailable"`. This is the stated behavior, and it is honest.
- **Record:** 0600 file in a 0700 directory (`storage.ts:449-475`, asserted in the test). Atomic rename. It holds no token and no upload path. The lock covers prune, read, and first write. The bound is 200 records and 3 hours.
- **The cap and the type refusal come before any network call** (the MCP test asserts that `fileCommands.length` does not change). Commit output passes through with no URL and no token.
- **Commit is the source of truth on a replayed PUT** (Fold 1). I found no path that reports `committed` or `replayed` without a
  successful commit body. Probe P1 confirms it: after an outage, the retry replays the one version.

## Findings

### 1. PRODUCTION — MCP tells the agent "a person must restore this agent's access" for recoverable file refusals, including a storage outage (Fold 1 regression)

`src/mcp/errors.ts:138` now maps `FileCommandRefused` to its bare server code, but `MCP_ERROR_SENTENCES` holds only
`file_too_large`, `file_type_refused`, and `file_version_precondition_failed`. Every other file code falls to
`errors.ts:163-164`:
```ts
: entry(`The service returned ${safeCode}...`, error instanceof CommandHttpError && error.status >= 500 ? RETRY
    : error instanceof CommandHttpError && ... ? CHECK_ARGUMENTS : PERSON);
```
`FileCommandRefused` is not a `CommandHttpError`, so the next step is always `PERSON`. `server.ts:124` rethrows every 4xx
`FileCommandRefused`. Fold 1 makes this the normal result of a storage outage. `exact-file-put.ts:116-122`: the second
in-process PUT attempt (`attempted` is true) turns ANY `FileTransportError`, including a second no-response, into
`"already_exists"`. Commit then returns `409 file_bytes_missing`. Before Fold 1, the same failure returned
`{outcome:"unknown", retry_with_same_request_id:true}`.

Probe P1 (`opus-r1-probes/mcp-probe.test.mts`, built `dist/cli.js mcp`, loopback edge, storage drops both PUT sockets):
```
P1 first: {"isError":true,"value":{"code":"file_bytes_missing","message":"The service returned file_bytes_missing.",
  "next_step":"a person must restore this agent's access outside this session","status":409}} puts: 2
P1 retry same id after storage back: {... "outcome":"replayed","conflict_check":"available"}
```
The next step is false: the same call with the same `request_id` succeeds. The same wrong `PERSON` step also comes back for
`file_commit_conflict` (retry after the 3-hour sweep, or after a commit-time precondition purge; probe P2), `version_id_unavailable`,
`file_tombstoned`, `file_version_cap`, `brain_version_in_flight_cap`, `workspace_file_count`, and `file_not_found`. No test
asserts `next_step` for any of these codes. The 5xx→`unknown` branch at `server.ts:125` is also uncontrolled: when I
changed it to `FileTransportError` only, no test failed (mutation `mcp-5xx-to-typed`, 79/81, which is the same as the copy's control).
Fix: add owned sentences for the file refusal codes. `file_bytes_missing` should say to wait and retry with the same `request_id`, or it should map to `outcome: "unknown"` when this call sent a PUT and got no answer. Add a test per code.

### 2. PRODUCTION (low) — after a commit-time precondition refusal, a same-id retry re-uploads bytes to a purged path that nothing reclaims

The commit-time `if_version` loss (`file-artifacts.ts:862-904`) sets the row to `purged`, queues its path, and the drain deletes the object. The create
succeeded and was ledgered, so a retry with the same `request_id` replays the create body, which still holds a valid
2-hour signed URL. The record phase is `uploaded`, so `priorPut` is true and the client PUTs again (`exact-file-put.ts:104-126`). The
object path is now empty, so the upsert-off PUT succeeds. Commit then refuses with `file_commit_conflict`. The re-written object is
permanent:
- the orphan sweep skips any object that has a version row
  (`20260818000001_file_artifacts.sql:202` `NOT EXISTS (SELECT 1 FROM swarm.file_versions AS v WHERE v.storage_path = o.name)`);
- the queue insert is `ON CONFLICT (storage_path) DO NOTHING`, and the queue row already has `deleted_at` set;
- purged bytes are outside the byte quota.

Probe P2 (fake that models this refusal, drain included):
```
P2 first: {"code":"file_version_precondition_failed",...,"next_step":"fix the named argument"}
P2 retry: {"code":"file_commit_conflict",...,"next_step":"a person must restore this agent's access outside this session"}
P2 log: ["PUT ok …/1","purged+drained …/1","PUT ok …/1"]
P2 objects under purged versions: ["…/ed851345-…/1"]
```
There is at most one leaked object (up to 25 MiB) for each lost race. A retry loop in a script, or a model that retries the same call, reaches it. The brief
also asks that the precondition refusal be "replay-safe". Here the retry changes the code, re-uploads the bytes, and gives the wrong next step.
Fix: after a typed commit refusal, store it in the record as a terminal state, and replay the refusal without a PUT. Not established:
whether production storage v1.77.5 accepts a second use of a signed upload token after its object is deleted. The
local shape was not measured for this either.

### 3. RIGOUR — one unreadable record blocks every fresh request_id

`exact-file-put.ts:52-56`. `prune` reads and `JSON.parse`s every `<64hex>.json` in the directory under the lock, with no
`try`. A record that has bad JSON, or that is not mode 0600, throws for all request ids, including new ones. Probe
`record-probe.test.mts`:
```
REC positive control (valid record): prepared OK
REC corrupt JSON: fresh request refused: SyntaxError …
REC mode 0644: fresh request refused: Error: credential file must be mode 0600 (found 644) …
```
In MCP this becomes `mcp_call_failed` with "retry the same call", which fails the same way every time. The brief requires that the record "never
blocks a fresh request_id". Fix: in prune, skip (or unlink) a record it cannot read.

### 4. RIGOUR — MCP reads the whole path before the cap and does not check what kind of file the path is

`src/mcp/server.ts:109` `const bytes = await readFile(args.path!);`. This reads the full file before `prepareExactPut`'s
25 MiB check (the brief rule "before any network call" holds, but a 1 GiB file is read into memory). It also reads a FIFO or a
character device with no limit. Probe P3: a FIFO path gave `NO ANSWER after 3 s (call blocked reading the FIFO)`. A missing
path or a directory gives `mcp_call_failed` with "retry the same call", which is a wrong next step for a bad argument. Fix: `stat` first; require
a regular file of at most `FILE_MAX_VERSION_BYTES`; map ENOENT, EISDIR, and non-regular files to a FIX code.

### 5. RIGOUR — claimed controls that no test enforces (mutations survive every lane suite)

In a scratch copy I ran exact-file-put, file-verbs, brain-verbs, and mcp-stdio (after a fresh `tsc` build) against each mutation. Every mutation
passed the whole set (79/81; the same two doc-read tests fail on the unmutated control copy):
- `exact-file-put.ts:83` with ` || prior.if_version !== (input.ifVersion ?? null)` removed: a reused id with a new
  `if_version` then quietly reuses the stored precondition. LANE.md row 3 claims that the check covers `if_version`.
- `exact-file-put.ts:74` with workspace and principal removed from the identity, and `:48` with them removed from the record key.
  Nothing tests seat namespacing.
- `exact-file-put.ts:111` with `await phase(prepared, "created")` deleted.
- `server.ts:125` (see finding 1).

### 6. RIGOUR — the conflict and precondition next steps do not say "use a new request_id"

`errors.ts:62` `request_id_conflict` → "stop and keep the same request id". `errors.ts:67` precondition → "Read it again
before writing." (FIX). Say a model follows the brain loop (refused, re-read, edit, put again) and keeps its `request_id`, as the tool
description invites. It gets `request_id_conflict` and is told to stop. New content needs a new `request_id`, and no
model-facing text says so.

### 7. RIGOUR — "without --request-id, behaviour unchanged" is not exact

`cli.ts:8374-8375` now refuses before `fileContext` with new text. The old text is `this file is X; the per-file limit is … so the upload was not
started` and `"x" has no allowed file extension; the workspace accepts …`. The new text is `this file exceeds the 25 MiB upload limit`
and `the name needs an allowed extension: …`. The preflight messages at `cli.ts:8292-8307` can no longer be reached from
`file put`. File read and preflight errors now come before credential errors (`cli.ts:8364-8376`; the same for brain put at `8691-8693`).
No test covers the old or the new text. The change is small, but LANE.md and the brief say it is unchanged.

### 8. RIGOUR — the tool-list "agree" test only checks that two names are present; one stale marker copy remains

`tests/p1-cli/command-table-gates.test.ts:190-199` asserts only that `file_put` and `brain_put` are in both lists.
`agentToolsForTransport("stdio")` returns 18 names. The MCP server lists 9 (`MCP_TOOLS`): `file_ls`, `file_get`, `brain_ls`,
`brain_get`, `resume`, `channel_ls`, `receipt`, `feed`, and `inbox` are stdio "tools" in the table but are not served. This mismatch existed before the lane, but the
brief asked for a test that fails when the lists differ. The input schemas also differ (table: CLI flags and `positionals`; MCP: `request_id`, `path`,
`name`). A copy of the retired marker text is still in the assertion message at `command-table-gates.test.ts:174`
("nor CLI-only until item L"). `dist-npm/cswarm.cjs` still has it too; that file is a release artifact.

### 9. RIGOUR — `outcome: "replayed"` for a call that made the first commit; LANE.md names the opposite case

`exact-file-put.ts:131` `prepared.existed || put === "already_exists" ? "replayed" : "committed"`. The case: a record exists but the
process was killed before create. The next call does the first create, PUT, and commit, and reports `replayed` (probe:
`creates=1 commits=1 outcome=replayed`). The MCP killed-after-create test requires this. LANE.md "Not established" says the
record-loss-after-create case "may report committed rather than replayed". That label is correct, because that call did make the commit.
The actual mislabel is the case above, and LANE.md does not state it. In both cases the version count is correct.

### 10. RIGOUR — the phase goes backward on a resumed attempt

`exact-file-put.ts:111,114` writes `created`, then `putting`, over a saved `uploaded`. A crash between the two writes loses the
PUT evidence. The next first PUT refusal (for example an expired URL) then returns `unknown` once more before the call converges. There is no
false result.

### 11. RIGOUR (hardening) — `file_put` can upload the MCP server's own credential

`server.ts:108-109`: any absolute path that the MCP process can read, with a `name` that the model chooses (for example `x.md`). A
prompt-injected model can publish `<profile dir>/…` credentials or `~/.ssh/*` to every workspace member. The spec
chose server-side path reads. A cheap guard is to refuse paths inside the profile and credential directories.

## Not established

- The duplicate-PUT shape of production storage-api v1.77.5, and whether a signed upload token can be used again after its object
  is deleted (this decides finding 2 on production).
- The local-stack server test. The lead reports 22/22; I did not run it.
- Whether storage-api can keep a truncated object from an interrupted first PUT. Commit accepts an object smaller
  than its declaration (`file-artifacts.ts:919-925`), and Fold 1 now commits after a second no-response PUT.
  I did not measure this.

## Process hygiene

Every probe server and MCP child was closed. `ps -ax | grep -E "opus-l-probe|arms-l|opus-r1-probes/mut"` was empty after
each batch. `git status` in the worktree was clean (only the ignored `dist/`).

VERDICT: FAIL
