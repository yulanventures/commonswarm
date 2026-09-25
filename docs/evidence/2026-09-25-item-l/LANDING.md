# Item L landing: exactly-once `file_put` and `brain_put` over MCP (2026-09-25)

Branch `lane/item-l` from main `084f8a22`, tip `bd836290`, merged with `git merge --no-ff` (merge `12c676cd`; the merged
tree equals the lane tree). Spec: `docs/design/2026-09-25-ITEM-L-EXACTLY-ONCE-FILE-PUT-BRIEF.md`. The Maker's record,
fold by fold, is `LANE.md` here. Review outputs and prompts: `arms/`.

## What it does

- New MCP tools `file_put {request_id, path, name?}` and `brain_put {request_id, topic, path, if_version?}`, and an
  optional `--request-id` on `cswarm file put` and `cswarm brain put`. One `request_id` gives at most one committed
  version, also after a lost response at any phase or a killed process.
- The file, version and both command ids derive from the seat, the `request_id`, the name (case-insensitive, as the
  server) and the content's sha256. A small durable resume record (0600, bounded) detects a reused `request_id` with
  different content (`request_id_conflict`) and stores terminal commit refusals, which replay without a network call.
- A replayed upload that storage refuses goes on to the commit with the same command id; the server's commit checks
  that the bytes exist, so exactly-once does not depend on storage's duplicate response shape.
- The MCP server reads `path` itself (regular files up to 25 MiB; the CLI's credential and state locations are refused),
  so no file bytes, upload URL or token pass through a model turn. Each typed refusal has a generated next step.
- Without `--request-id`, `file put` and `brain put` behave as before.

## Release

Client only: no migration and no edge change. It ships in the next npm release built from main (0.1.78, which also
waits for item G lane 1's box release, because main carries G's client).

## Review (D-036)

Maker: Codex gpt-6-sol (direct `codex exec` lane), two folds. Checker: Claude Opus 5.5. Second arm: Grok 4.7.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | 444db2b7 | FAIL (false "restore access" next step for retryable refusals; retry after a commit-time precondition refusal re-uploaded to a purged path; nine RIGOUR) | PASS (five RIGOUR) |
| 2 | bd836290 | PASS (seven RIGOUR, below) | PASS (two RIGOUR, below) |

## Gates

Lead, lane tip `bd836290` on the local stack: build 0; test:p1-server 261/261 (the item L server test measured the local
storage-api v1.54.1 duplicate response: HTTP 400 with body `statusCode "409"`, `error "Duplicate"`, then the commit
outcome); npm test 990/990; test:p1-cli 997/997; check:tests 0; check:edge 0; command-core + protocol diff 0;
`scripts/build-release.sh` 0; site build 0; `git diff --check origin/main...HEAD` 0.

## Follow-ups (RIGOUR from round 2; not blocking; filed as one task)

- The protected-path guard does not cover relocated CLI state roots (`SWARM_AGENT_STATE_DIR`, `$XDG_STATE_HOME`) or a
  hard link to the credential file (Opus 3, Grok).
- Prune deletes the caller's own unreadable record, so a reused id with new content then gives a second version (the
  output says `conflict_check: "unavailable"`) (Opus 1).
- Some "fix the named argument" next steps name no argument; non-UTF-8 `brain_put` gets "retry" (Opus 2).
- No test pins the size check that runs before the read (Opus 4); `brain put --request-id` without `--json` drops the
  re-read text (Opus 5); the no-backward-phase rule uses the copy read at start (Opus 6).

## Not established

- Production storage-api v1.77.5's duplicate response shape (not needed for correctness after Fold 1).
- Recovery after the 2-hour upload URL expires: a retry fails until the 3-hour sweep; a new `request_id` works.
- The server gives no replay marker on a commit, so after a lost record the tool cannot prove `replayed`; it reports
  `committed` unless the record shows an earlier commit.
