I'll review item L as a read-only pass: the fold rulings, the round-1 findings, and the diff from `444db2b7` to `bd836290`, then the full lane against `084f8a22`.The fold-2 rulings and both round-1 reviews are in. Next I’ll confirm the worktree SHA and read the fold-2 diff against those rulings.The fold-2 source is in place. I’ll check each ruling against the commit handler, path checks, and the new tests, looking for a retryable refusal stored as terminal or a conflict the prune step drops.The path check and refusal set are the two places a fold-2 fix can still be wrong. I’ll probe those directly, then run the pure item-L tests.Round-1 findings P1, P2, and R3–R11 are fixed as Fold 2 ruled, and the same six checks still hold. Focused pure tests under a temporary `HOME` passed **107/107** after `npm run build`. No production host was contacted.

Two residuals remain. Neither reopens a round-1 production failure, and neither creates a second version for one `request_id` and the same bytes.

### RIGOUR — a hard link to the credential file is still read

`readMcpPutFile` refuses a path only when `realpath` text sits inside a protected root or equals the credential path. A hard link is a different path to the same inode, so the check misses it.

```36:40:src/mcp/server.ts
    const protectedRoots = await Promise.all([join(homedir(), ".cswarm"), join(homedir(), ".config", "cswarm"), dirname(profilePath)]
      .map(root => realpath(root).catch(() => resolve(root))));
    if (protectedRoots.some(root => inside(resolved, root)) ||
        (credentialFile !== undefined && resolved === await realpath(credentialFile).catch(() => resolve(credentialFile)))) {
```

A local probe with a temporary `HOME` denied a symlink, a relative symlink, a `..` path, and `/var` versus `/private/var`. The same probe allowed a hard link of `credential.json` and returned `SECRET-CRED`. `file_put` cannot create that link; it can only read one that already exists.

### RIGOUR — relocated CLI state roots are not in the protected set

The guard hardcodes `~/.cswarm`, `~/.config/cswarm`, the profile directory, and the one credential file. Session keys and agent tokens move when the environment overrides are set:

```273:276:src/cloud/session-context.ts
export function defaultSessionRootDirectory(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "cswarm", "sessions");
  return join(homedir(), ".config", "cswarm", "sessions");
}
```

```93:98:src/cloud/agent-credential.ts
export function defaultAgentCredentialDirectory(): string {
  const configured = process.env.SWARM_AGENT_STATE_DIR;
  if (configured) return configured;
  return process.env.XDG_STATE_HOME
    ? join(process.env.XDG_STATE_HOME, "cswarm", "agent-credentials")
    : join(homedir(), ".cswarm", "agent-credentials");
}
```

With those variables unset, both directories sit inside the hardcoded roots and are refused. A file under a different `XDG_CONFIG_HOME` was read. The default layout the ruling’s test names is covered.

### Round-1 rulings

**P1.** `file_bytes_missing` and transport failures say to retry the same `request_id`. Status 401 and 403 are the only file refusals that name a person. Status 429 and 5xx do too, including on `outcome: "unknown"`.

```71:72:src/mcp/errors.ts
  file_transport: entry("The file request did not complete.", FILE_RETRY),
  file_bytes_missing: entry("The uploaded bytes are not yet present for this version.", FILE_RETRY),
```

```178:181:src/mcp/errors.ts
  const sentence = fileStatus !== null && (fileStatus >= 500 || fileStatus === 429)
    ? entry(`The file service returned ${safeCode}.`, FILE_RETRY)
    : fileStatus === 401 || fileStatus === 403
    ? entry("The file service refused this agent's access.", PERSON)
```

**P2.** A commit-time precondition refusal is stored as `refused` and the same id returns that code before create or PUT. `file_bytes_missing`, HTTP 429, and 403 `forbidden` are not in the terminal set, so a later retry can still commit. The server purges the losing version in the same transaction (`file-artifacts.ts:885-903`); stopping the retry is what avoids a second PUT onto that path.

```13:16:src/cloud/exact-file-put.ts
const TERMINAL_COMMIT_CODES = new Set([
  "file_version_precondition_failed", "file_commit_conflict", "file_size_exceeds_declaration",
  "file_not_found", "file_version_cap", "command_id_conflict",
]);
```

```119:120:src/cloud/exact-file-put.ts
  if (record.phase === "committed" && record.result) return { result: record.result, outcome: "replayed", conflict_check: prepared.conflict_check };
  if (record.phase === "refused" && record.refusal) throw new FileCommandRefused(record.refusal.status, record.refusal.code, `The service refused this file put (${record.refusal.code}).`);
```

`file_version_cap` is in that set, but the create check (`live + in-flight < 20`, or the brain in-flight cap) makes that commit refusal unreachable: another create cannot land, and a brain commit retires down to 19 live versions. Create-time `file_version_precondition_failed` is not stored, so a later retry still re-evaluates, which matches the server note that file refusals are not ledgered (`supabase/functions/command/index.ts:10165-10176`).

**R3.** Unreadable and wrong-mode records are removed under the lock, one stderr line each, and another id continues (`exact-file-put.ts:66-70`). A mode-0600 record is not removed. Deleting a wrong-mode file is the ruled loss of that record: same bytes still reuse the derived ids; different bytes are the spec’s `conflict_check: "unavailable"` case.

**R4.** The MCP reader `lstat`s, resolves, opens nonblocking, `fstat`s, and caps before `readFile` (`server.ts:33-46`). FIFO and FIFO-symlink return `file_path_invalid`. Symlinks into private state return `file_path_protected`.

**R5.** Name comparison is case-insensitive (`exact-file-put.ts:96`). Identity and the record key still include workspace and principal (`exact-file-put.ts:55` and `:88`). The created phase is written (`:128`). A 5xx create stays `outcome: "unknown"`.

**R6.** `request_id_conflict` says to use a new `request_id` (`errors.ts:63`). The precondition sentence says to reread the topic and use a new `request_id` (`errors.ts:68`).

**R7.** `fileContext` runs before the file read (`cli.ts:8367`, and the brain put at `:8676`). Legacy size and extension sentences remain in `uploadNamedFile` (`cli.ts:8293-8308`). A `--json` conflict with `--request-id` writes `{code:"request_id_conflict"}` to stdout (`cli.ts:9924-9927`).

**R8.** The command table’s `mcp: true` set is compared in full with `MCP_TOOLS` (`command-table-gates.test.ts:194-196`). The item-L marker is gone from `src/`.

**R9.** `replayed` is only a saved `committed` record with a result (`exact-file-put.ts:119`). A commit this call returns `committed` (`:159`), including after a duplicate PUT.

**R10.** A phase write returns when the new phase is earlier (`exact-file-put.ts:110`). An uploaded record is not rewritten as `created` or `putting`.

**R11.** Prune exempts the record for this request id (`exact-file-put.ts:73` and `:93`). A retry of the oldest of 200 records with different bytes still conflicts before create.

### Six checks

1. **Exactly-once.** Identity is workspace, principal, request id, lowercased name, and SHA-256 (`exact-file-put.ts:88`). The create handler assigns one storage key per version after the file and workspace locks: `storagePath = ${workspaceId}/${fileId}/${versionN}` (`file-artifacts.ts:724-725`). A taken `version_id` is refused (`file-artifacts.ts:702-712`). A ledger hit returns the stored create body before that assignment (`file-artifacts.ts:546`). Lost create, PUT, and commit responses reuse those ids. Killed MCP processes report one create and one commit. No path reports `committed` or `replayed` without a commit body or a saved commit result.

2. **Different content.** With the record present, `RequestIdConflict` is thrown before any file command (`exact-file-put.ts:96-97`). With the record gone, the hash changes the ids and the result says `conflict_check: "unavailable"`.

3. **Record.** Mode 0600 in a 0700 directory (`storage.ts:156-160` and `:449-472`). The lock covers prune, read, and the first write only (`exact-file-put.ts:92`). The bound is 200 records and 3 hours. The JSON has no token and no upload URL.

4. **MCP.** Absolute `path` only (`tools.ts:64`). The server process reads it after the cap. Output is the commit body plus `outcome` and `conflict_check`. `if_version` stays a typed precondition. The marked command-table set matches `MCP_TOOLS`.

5. **CLI.** `--request-id` uses the same prepare and execute path. Without it, ids are minted once per run (`cli.ts:8336-8339`) and a duplicate object is not success.

6. **Controls and gates.** The new assertions fail if the refusal check, phase guard, seat, case fold, prune, or 5xx branch is removed. Changed tests are under `tests/p1-cli/**/*.test.ts` (`test:p1-cli`) or `tests/p1-server/**/*.test.ts` (`test:p1-server`). This run’s focused total matches the lane’s **107/107**. The server suite was not run here. The lead’s 22/22 remains the pre-fold measurement at `444db2b7`.

VERDICT: PASS
