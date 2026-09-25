I'll review item L as a read-only check against the spec and the diff from `084f8a22` to `444db2b7`, then run the pure tests. No files will be changed.The lane record and source diff are in. Next I’ll read the exact-put implementation, the create handler, and the tests that claim each failure mode.Item L at `444db2b7` keeps one committed version for one `request_id` and the same bytes. The pure item-L tests passed here: 92/92 under a temporary `HOME`, after `npm run build`. No production host was contacted.

The create handler assigns one storage key per version, and a replay returns the stored create body before that assignment:

```546:546:supabase/functions/command/file-artifacts.ts
  if (storedCreate !== null) return { ok: "replay", stored: storedCreate.stored };
```

```715:725:supabase/functions/command/file-artifacts.ts
  const fileId = file?.file_id ?? cmd.file_id;
  // ...
  const versionN = Number(maxRows[0]?.n ?? "0") + 1;
  const storagePath = `${workspaceId}/${fileId}/${versionN}`;
```

An existing name is chosen with `lower(f.name) = lower(cmd.name)` (`file-artifacts.ts:613`), and that row's `file_id` replaces the proposed one. A new name keeps the proposed id. The sweep sets an expired pending row to `purged` and leaves the row in place (`supabase/migrations/20260818000001_file_artifacts.sql:187-192`), so `version_id` stays taken (`file-artifacts.ts:702-712`). Idempotency keys are retained for two days (`supabase/migrations/20260906000050_idempotency_retention_floor.sql:10`). A retry after the three-hour sweep therefore cannot insert a second version under the same derived ids.

Identity is a UUIDv5 of workspace, principal, request id, lowercased name, and SHA-256, with a distinct suffix for the file, version, create command, and commit command:

```74:88:src/cloud/exact-file-put.ts
  const identity = [input.workspaceId, input.principalId, input.requestId, input.name.toLowerCase(), sha256].join("\0");
  // ...
      file_id: uuidV5(`${identity}\0file`),
      version_id: uuidV5(`${identity}\0version`), create_command_id: uuidV5(`${identity}\0create`),
      commit_command_id: uuidV5(`${identity}\0commit`), phase: "prepared", updated_at: now, result: null,
```

Request ids must match `^[A-Za-z0-9_-]{8,72}$` (`src/h0/verbs.ts:107-109`). CLI workspace overrides and saved profiles are lowercased before they reach this function (`src/cloud/workspaces.ts:636`, `src/cloud/agent-profile.ts:130`). The SHA-256 is fixed-length hex, so a NUL inside the name does not alias another content hash.

Lost create, PUT, and commit responses reuse those ids (`exact-file-put.ts:106-130`). A killed MCP process leaves the phase file and the restarted call reports `replayed` with one create and one commit. Concurrent identical callers share one version; concurrent different bytes, one prepare wins. A URL that fails on replay continues to `file_version_commit`, which returns `file_bytes_missing` when `storage.objectSize` is null (`file-artifacts.ts:911-918`). That refusal is not a committed version. An upload that never stored bytes cannot be finished later under the same id, because the version id remains reserved. That matches the deferred fresh-URL case the lane recorded.

A deleted record keeps the same derived ids and sets `conflict_check` to `"unavailable"` (`exact-file-put.ts:91`). If this call is the one that first commits, the outcome is `committed` (`exact-file-put.ts:131-132`). After a commit that already landed, the measured local storage shape (HTTP 400, `statusCode` `"409"`, `error` `"Duplicate"`) is treated as `already_exists` and the outcome is `replayed` (`src/cloud/files.ts:369-372`).

Same request id and different bytes, with the record still present, throw `request_id_conflict` before any file command (`exact-file-put.ts:82-83`). With the record gone, the hash changes, the ids change, and the result says `conflict_check: "unavailable"`, which is the loss behaviour the brief allows.

## Findings

**RIGOUR.** At 200 records, prune deletes the record under consideration before the conflict read.

```58:82:src/cloud/exact-file-put.ts
  rows.sort((a, b) => b.updated - a.updated);
  await Promise.all(rows.filter((row, index) => index >= MAX_RECORDS - 1 || now - row.updated > RECORD_LIFETIME_MS)
    .map(row => unlink(join(dir, row.name)).catch(() => undefined)));
  // ...
    const raw = await readSecureJsonFileIfPresent(path, 8192);
    const prior = raw === null ? null : JSON.parse(raw) as RecordFile;
    if (prior && (prior.request_id !== input.requestId || prior.name !== input.name || ...
```

Retrying the oldest id with different bytes drops that record inside the same call, writes a new one, and can commit a second version with `conflict_check: "unavailable"`. The bound test (`tests/p1-cli/exact-file-put.test.ts:269-285`) checks eviction of an older id, not a retry of that same id.

**RIGOUR.** `if_version` is stored and compared, and it is not part of `identity`. After the record is gone, a different `if_version` reuses the command id. The server then returns `command_id_conflict` (`file-artifacts.ts` around the create ledger check) and no second row is inserted. The MCP error from that throw does not carry `conflict_check`. No test changes only `if_version` on an existing request id, so deleting that one comparison would still leave the suite green.

**RIGOUR.** The conflict comparison uses the raw name (`exact-file-put.ts:82`) while the id uses `name.toLowerCase()`. The server treats the name as case-insensitive (`file-artifacts.ts:613`). Same bytes and a different case, with the record present, raise `request_id_conflict`. With the record gone, the same command id and a different name body also conflict on the server. Neither path inserts a second version.

**RIGOUR.** CLI `--request-id` calls `fileContext` before `prepareExactPut` (`src/cli.ts:8376-8379`, then `8310-8323`), so credential resolution can touch the network before the local conflict check. MCP writes the record before `authenticated()` (`src/mcp/server.ts:111-120`). The lane record states this. The file-command conflict test still sees no extra create.

**RIGOUR.** Without `--request-id`, ids are still minted once per run (`src/cli.ts:8336-8339`) and `putObject` does not treat an existing object as success. The no-flag path now refuses an oversized file or a bad extension before `fileContext`, with a different sentence (`src/cli.ts:8374-8375`) than `uploadNamedFile` (`src/cli.ts:8293-8308`). A CLI `--json` conflict prints `RequestIdConflict` on stderr (`src/cli.ts:10004`) and does not emit `{code:"request_id_conflict"}`. MCP does (`src/mcp/errors.ts:62`, `src/mcp/server.ts:160-163`).

The resume file is mode `0600` in a `0700` directory (`src/cloud/storage.ts:156-160`, `449-472`). Tests assert both modes. The JSON holds ids, the hash, the phase, and the commit body. The commit body has no upload URL or token (`src/cloud/files.ts:120-131`). The directory lock is held only around prepare (`exact-file-put.ts:78`), so an in-flight upload does not refuse a new request id. The cap keeps 200 files and drops records older than three hours.

MCP `file_put` takes `request_id`, an absolute `path`, and an optional `name`. `brain_put` takes `request_id`, `topic`, `path`, and optional `if_version` (`src/mcp/tools.ts:38-39`, `64`). The server process reads the path (`src/mcp/server.ts:109`). The 25 MiB cap and the extension map run inside `prepareExactPut` before create or PUT (`exact-file-put.ts:65-69`); the stdio tests see no file command on those refusals. `if_version` must be a nonnegative integer, and a precondition miss stays `file_version_precondition_failed` across a retry. Success output is the commit body plus `outcome` and `conflict_check`. The stdio test rejects `SECRET-UPLOAD-TOKEN`.

`file put` and `brain put` are `tool: "file_put"` and `tool: "brain_put"` (`src/cli.ts:9632`, `9645`). `agentToolsForTransport` is generated from that table (`src/cli.ts:9729-9743`). The hand-written MCP list includes both names. Help text in `usage()` carries `--request-id`, and the dispatch baseline matches it. The product reason `CLI_ONLY_UNTIL_ITEM_L_REASON_MARKER` is gone from `src/`. The words remain in the test failure string at `tests/p1-cli/command-table-gates.test.ts:174` and in older evidence files.

Changed tests sit in `npm run test:p1-cli` (`tests/p1-cli/**/*.test.ts`) or `npm run test:p1-server` (`tests/p1-server/**/*.test.ts`). The assertions for lost phases, deletion, conflict, the cap, the lock, process kill, and the duplicate PUT shapes fail if those branches are removed. I did not edit source to re-apply the lane's mutation list. I did not re-run the full `npm test` or `test:p1-cli` gates, so the lane's sandbox `ps` `EPERM` counts were not re-measured. The server test at `tests/p1-server/file-artifacts.test.ts:1831` matches the handler and the local storage shape the lead already ran.

VERDICT: PASS
