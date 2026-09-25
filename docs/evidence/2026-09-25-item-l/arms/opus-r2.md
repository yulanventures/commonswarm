# Item L — exact review (Anthropic arm, Opus 5.5), round 2

Reviewed: `git diff 444db2b7..bd836290` closely and the whole lane `git diff 084f8a22..bd836290` (docs/design skipped),
in the detached worktree `scratchpad/arms-l` at `bd836290664253554d5e7a16bd1ba45f81900536`. I changed no tracked file
(`git status --short` is empty; only the ignored `dist/` was rebuilt). Probes and logs are in
`scratchpad/itemL/opus-r2-probes/`. All probe servers ran on loopback. Mutations ran in scratch copies that the script
deleted after each run. I contacted no production host, did not touch the local Supabase stack, and did not run
`test:p1-server`. After the last batch, `ps -ax | grep -E "arms-l|opus-r2|opus-l2"` returned 0 lines.

## Gates I ran (temporary HOME)

| Gate | Result |
|---|---|
| `npm run build` | exit 0 |
| `env -u FORCE_COLOR npm test` | exit 0; 990/990 (LANE.md records 988/990 with 2 sandbox `ps` EPERM; that failure does not occur on this host) |
| `env -u FORCE_COLOR npm run test:p1-cli` | exit 0; 997/997 |
| `npm run check:tests` | exit 0 |
| Focused set in a copy with docs and site (exact-file-put, file-verbs, brain-verbs, mcp-stdio, command-table-gates) | 106/107. The one failure ("MCP errors come from the owned table…") reads a file that the copy does not hold. It passes in the worktree (997/997), so it is my baseline, not a defect. |

Every changed test file is in a gate: `tests/p1-cli/**` goes through the `test:p1-cli` glob. `exact-file-put`, `file-verbs`,
`brain-verbs`, and `mcp-stdio` are also named in `npm test` (990 includes them).

## Round-1 findings: each is fixed as its ruling says

| R1 | Ruling | Evidence at bd836290 |
|---|---|---|
| 1 PRODUCTION (false "restore access" step) | P1 | Probe P1 (both PUT sockets dropped, then storage back): first `{"code":"file_bytes_missing","next_step":"retry this call with the same request_id","status":409}`; the retry with the same id gives `outcome:"committed"`. That step is now true. `errors.ts:171-178`: 5xx and 429 give `FILE_RETRY`, and only 401 and 403 give `PERSON`. The unknown-outcome output now carries `next_step: mapMcpError(error).next_step` (`server.ts:159`). |
| 2 PRODUCTION (re-PUT to a purged path) | P2 | `exact-file-put.ts:150-153` persists `{status, code}` as phase `refused` for `TERMINAL_COMMIT_CODES`. `:120` throws it before create and before PUT. Probe P2 (fake commit-time purge and drain): the first call and the retry both give `file_version_precondition_failed` with "read the topic again and use a NEW request_id…". The log shows one PUT only, and there are 0 objects under purged versions (the r1 result was 1 leaked object). |
| 3 bad record blocks all | R3 | Record probe: corrupt JSON and mode 0644 → `prepared OK` for a fresh id, with one stderr line each. |
| 4 unsafe path reads | R4 | Probe P3: missing path, directory, and FIFO each give `file_path_invalid` / FIX at once (the r1 FIFO call hung). Probe P4: direct credential path, a symlink to it, and a `..` path → `file_path_protected`. A relative path is refused as `InvalidParams` by the schema. The positive control (a regular file) commits. |
| 5 five surviving mutations | R5 | Now killed (table below). |
| 6 conflict/precondition steps | R6 | `errors.ts:63,67`. The mutations killed both. |
| 7 legacy CLI change | R7 | `cli.ts:8367,8676`: credentials are resolved before the read again. The legacy copy comes from `uploadNamedFile` (`cli.ts:8293-8309`). The mutations killed both reorders. |
| 8 tool-set test | R8 | `command-table-gates.test.ts:194-196` `deepEqual(MCP_TOOLS, entries with mcp)`. Killed by unmarking `file_put` and by unmarking `whoami`. The stale assertion text is gone. The only remaining copy of the marker is the release artifact `dist-npm/cswarm.cjs:72301`. |
| 9 replayed label | R9 | `exact-file-put.ts:159` returns `committed` unless a saved commit exists. Probe: killed-before-create gives `first=committed second=replayed`. |
| 10 phase regression | R10 | `exact-file-put.ts:110`. Killed. |
| 11 credential upload | R4 | Covered for the profile directory, `~/.cswarm`, and `~/.config/cswarm`. The limits are in finding 3. |

A terminal code stored for a code that is actually retryable: I checked each code in `TERMINAL_COMMIT_CODES` against
`supabase/functions/command/file-artifacts.ts`. Here file refusals are deliberately not ledgered (`index.ts:10159`), so
the client decides which codes are terminal.
- `file_version_precondition_failed` (`:900`): the row becomes purged, so the version can never commit.
- `file_commit_conflict` (`:840,978`): the row is live or purged. A live row always has a ledger replay first.
- `file_size_exceeds_declaration`: an upsert-off object cannot shrink.
- `file_not_found` (`:792,836`): a compound-key miss.
- `command_id_conflict`: the commit body comes from derived ids, so it does not change.
- `file_version_cap` (`:949`): for brain topics, `retireOnCommitCount` keeps it unreachable. For normal files, the live count never goes down.

Each code is terminal for that version id. `file_bytes_missing`, 429, and 403 stay retryable. The mutation
`terminal-all-codes` fails the rate-limit, access-restored, and resume tests.

## Mutations (each in a copy; failures diffed against the unmutated control copy)

Killed (at least one new failing test): terminal-check-off, terminal-persist-off, terminal-all-codes, phase-guard-off,
prune-throws, prune-preserve-off, if-version-compare-off, name-case-strict, identity-no-seat, record-key-no-seat,
created-phase-off, putting-not-persisted, fold1-off, fold1-any-first, no-conflict, no-lock, label-prior-record,
fast-path-off, mcp-5xx-to-typed, protected-roots-off, credential-check-off, fstat-isfile-off, nonblock-off,
bytes-missing-entry-off, file-5xx-person, access-to-fix, conflict-old-step, precondition-old-step, transport-map-off,
commit-conflict-retry, cli-file-cred-after-read, cli-brain-cred-after-read, json-conflict-off, mcp-flag-unmark,
mcp-flag-unmark-whoami. (35 killed. This includes all 13 round-1 mutations and the 5 round-1 survivors.)

Survivors: `size-precheck-off` (`server.ts:46` deleted) and `cli-brain-precondition-copy-always` (`cli.ts:8702` guard
removed). See findings 4 and 5. Logs: `opus-r2-probes/mut3-*.log`, `mut4-*.log`, `mutations.txt`.

## Findings (round 2)

No PRODUCTION finding. All are RIGOUR.

### 1. RIGOUR: prune deletes the caller's OWN unreadable record, so a real conflict becomes a silent second version

`exact-file-put.ts:66-69`:
```ts
} catch {
  process.stderr.write(`cswarm: skipped unreadable file put resume record ${name}\n`);
  await unlink(join(dir, name)).catch(() => undefined);
```
The `preserve` exemption (`:73`) covers only age and bound pruning. It does not cover this branch. Record probe `OWN`:
with the record intact, the same id with new content → `RequestIdConflict`. After `chmod 0644` on that record → `prepared,
conflict_check=unavailable same_version_id=false`. The server then creates a second version for one request_id.
The MCP output does report `conflict_check:"unavailable"`, and the stderr line goes only to the host log, so the result is
disclosed. But the brief asked that a quarantined record never hide a real conflict, and here it does. The test title and
Fold 2 say "quarantined", but the code deletes the file. Suggested fix: for `name === preserve`, refuse with a typed
code (or rename the file aside) instead of unlinking it. Deleting only foreign records is enough to keep fresh ids unblocked.
The catch also deletes on any error (EIO, EMFILE, `StoredRecordOversizedError`), not only on bad JSON or wrong mode.

### 2. RIGOUR: some owned next steps say "fix the named argument" for codes that name no argument, or for a transient state

`errors.ts:75-80`: `file_id_unavailable`, `version_id_unavailable`, `brain_version_in_flight_cap`,
`workspace_file_count` (and `file_tombstoned`, `workspace_quota_exceeded`) → `FIX`.
- `brain_version_in_flight_cap` is transient. `createAllowed = inFlight < 20` clears on commit or on the 3-hour sweep, and
  create refusals are not persisted, so the correct step is to wait and retry the same request_id.
- `version_id_unavailable` is reachable when a request_id is reused with the same content after the 3-hour record
  expiry and after the idempotency-key retention (`20260906000050_idempotency_retention_floor.sql`). The derived
  version id is then already taken. The correct step is "use a new request_id", but the model cannot "fix" an id that it did not choose.

Also, `brain_put` with non-UTF-8 bytes (`server.ts:142`, `TextDecoder` fatal → `TypeError`) maps to
`mcp_call_failed` / "retry the same call". Probe P5 shows the same result twice, so the retry never succeeds. This is the same
class as round-1 finding 4 (fixed there for paths).

### 3. RIGOUR: the path guard does not cover every CLI state root that holds a secret; the LANE.md R4 claim is broader than the code

`server.ts:36` protects `~/.cswarm`, `~/.config/cswarm`, and `dirname(profilePath)`. The live successor token is stored in
`defaultAgentCredentialDirectory()` (`agent-credential.ts:93-98`), which is `SWARM_AGENT_STATE_DIR`, or
`$XDG_STATE_HOME/cswarm/agent-credentials`, and only defaults to `~/.cswarm`. Probe P4 (the MCP server started with
`SWARM_AGENT_STATE_DIR=<root>/renewal`): a file in that directory → committed. A hard link to `credential.json` also
commits (realpath cannot see a hard link, which is acceptable for a hardening guard). LANE.md R4 says "Resolved paths inside
the CLI state roots … are refused". That holds only for the default roots. Fix: derive the roots from the same
functions the stores use (`defaultAgentCredentialDirectory()`, `defaultSessionRootDirectory()`, the XDG state roots), or
narrow the claim. Separately, `dirname(profilePath)` protects every file beside a profile. `assertPrivateLocation`
allows a profile such as `~/p.json`, and that profile would make every file directly under HOME refused. The default paths are
under `~/.cswarm`, so this is low risk.

### 4. RIGOUR: "cap the file before reading" has no control

The mutation deletes `server.ts:46` (`if (info.size > FILE_MAX_VERSION_BYTES) throw …`), and all tests still pass. The
refusal is the same `file_too_large` from `prepareExactPut`. Only the memory bound (reading a 1 GiB file) depends on this line, and
no test can see it. LANE.md R4 lists the cap as part of the preflight. The claim is true in the code, but no test fails when it is reverted.

### 5. RIGOUR: `brain put --request-id` (human output) loses the precondition guidance, with no test and no LANE entry

`cli.ts:8702` `args.optional("request-id") === undefined && error instanceof FileCommandRefused && …`: with
`--request-id` and no `--json`, the refusal prints the raw server sentence. On a replay from a stored refusal, it prints
`The service refused this file put (file_version_precondition_failed).` The text "Re-read it, apply your change…" is
dropped. Neither this text nor the text for `request_id_conflict` (`exact-file-put.ts:22`) says that new content needs a new
`--request-id`, which the MCP table now says (R6). JSON output keeps the typed code, which is correct. The mutation that
removes the guard survives, and LANE.md R7 does not name this change.

### 6. RIGOUR: the phase guard is in memory only; a concurrent same-id caller can still re-PUT after a terminal refusal

`exact-file-put.ts:110` compares against `prepared.record.phase`, which is the copy read at prepare time. It does not compare against the file on disk.
Record probe `CONC`: callers A and B prepare the same id. A gets a commit-time precondition refusal and stores
`refused`. B then runs create, PUT, and commit again (`commits=2`) and overwrites the record with earlier phases on the way. On the
server, B's PUT lands on A's purged path, which is the round-1 finding-2 leak. This needs two live callers with one
request_id, and the server still allows at most one version. Fix, if wanted: re-read the record under the lock
before the PUT and before each phase write.

### 7. RIGOUR (note): convergence after URL expiry is advised but not reached

When the signed URL expired (2 h), a same-id retry gets `file_bytes_missing` / "retry this call with the same
request_id" on every attempt, until the 3-hour sweep turns it into `file_commit_conflict` ("use a new request_id…").
`putObject` maps every refused replay PUT to `already_exists` (`exact-file-put.ts:139`). LANE.md "Not established"
names this and the brief deferred URL renewal. I record it only so that the step text is not read as a guarantee.

## Checks 1-6 (same as round 1), round-2 state

1. Exactly-once: no path that I found creates a second version for one request_id and one set of content while the record
   is intact. The server backstops (`version_id_unavailable`, the post-lock ledger recheck, per-version storage
   paths at `file-artifacts.ts:724-725`) are unchanged. `committed`/`replayed` now need a commit body. `replayed` needs
   a saved commit. The exception is finding 1, when the caller's own record is unreadable. That result is disclosed as `conflict_check:"unavailable"`.
2. Same id with different content: typed `request_id_conflict` before any network call. The CLI with `--json --request-id` now
   prints it as JSON on stdout (`cli.ts:9924-9928`, killed by `json-conflict-off`). Name-case semantics now match the server.
3. Record: 0600/0700, bounded (the current record is exempt from the bound, and that is killed), holds no secret, is locked,
   and never blocks a fresh id. Finding 1 applies.
4. MCP: absolute path only. The read is a regular file behind a nonblocking open (the FIFO hang is gone). The cap and the type
   refusal come before the network. The command table and `MCP_TOOLS` are equal by `deepEqual`. Findings 2-4 apply.
5. CLI parity with `--request-id`: holds. Legacy behavior without it is restored (order and copy). Finding 5 applies.
6. Controls: 35 of 37 mutations are killed. All 13 round-1 mutations are killed. The two survivors are in findings 4 and 5. The LANE.md
   Fold 2 claims that I checked are true, except that the R4 wording is broader than the code (finding 3).

## Not established

- The duplicate-PUT and expired-token shapes of production storage-api v1.77.5, and whether production storage lets a
  signed upload token be used again after its object is deleted. After P2, this matters only in the concurrent case (finding 6).
- The local-stack server test at bd836290. The lead's 22/22 was measured at 444db2b7, and Fold 2 did not change
  `supabase/`. I did not run it.
- Truncated objects from an interrupted first PUT (commit accepts an object smaller than its declaration). I did not measure this.

VERDICT: PASS
