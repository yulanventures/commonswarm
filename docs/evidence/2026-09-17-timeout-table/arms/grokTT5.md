I'll review the timeout-table lane at the exact SHA, starting with the commit range, the tree, and the review notes already in the README.Next I’ll read the remaining runner pieces and how the CLI picks state directories, so I can check isolation and mapping against the real timeout sites.I'll enumerate live timeout sites next and check which env vars the CLI still reads, so a parent `process.env` leak cannot reach a real workspace.I'll enumerate both refs, extract the mapping's safe-read rows, and hunt timeout forms the enumerator can miss.I’ll run the timeout-table tests and a loopback measurement next, then clean up any worktrees those runs create.Tests passed. Next I’ll run a loopback `runTable` for `v0.1.71` to check worktree cleanup, then confirm no leftover temp dirs.Review is of `d970c354` (detached HEAD) vs main `a6103088`. Contact was loopback only. No production host, no `supabase`, no other model.

**Measured:** `tests/p1-cli/timeout-table.test.ts` 15/15. `enumerate.mjs` HEAD 100 rows, v0.1.71 98 rows. `runTable --ref v0.1.71` on a 127.0.0.1 server with a throwaway profile. Real HEAD CLI `channel ls` / `file ls` / `check` on that same server. Worktrees and `cswarm-timeout-*` dirs from this review were removed.

## 1. Can the table say PASS while a real client would time out?

No current false-PASS path.

Inventory matches mapping for both refs (exact-set test). HEAD-only ids are the 3900 ms check budget files; v0.1.71 still has `src/cloud/agent-check.ts:AGENT_CHECK_TIMEOUT_MS` at **3000 ms**. `--ref` is required (`run.mjs:41-43`). `--ref v0.1.71` used that 3000 ms row, not the HEAD 3900 ms row.

Only two network rows can PASS:

- `site/src/lib/auth-providers.ts:AUTH_SETTINGS_TIMEOUT_MS` — same GET `/auth/v1/settings` the site build uses (`auth-providers.ts:193-210`). Loopback: **PASS**.
- `src/cloud/channels.ts:timeoutMs` — `listChannelsAsAgent` 30 s default (`channels.ts:248-251`). Real HEAD CLI: one `POST /functions/v1/read resource=channels`, exit 0. Loopback v0.1.71 table: **PASS**. Human `timeoutMs#2` stayed **NOT RUN** with proxy numbers.

Incomplete rows cannot PASS: check (no renewal; `expires_at` stripped), file-ls (no download/command), signal-read (one agent page). Slow incomplete rows FAIL before ack (`core.mjs:29`, `run.mjs:219-227`). Per-request with no log line is NOT MEASURED, not PASS. `class: "not-run"` is applied before headroom (`core.mjs:21`).

Warm 20-run p95 and nearest-rank drop of the slowest sample stay as documented. They are the gate contract, not a new hole.

## 2. Credentials and writes

No leak on the paths I ran.

Copy is 0700/0600, two files only, `expires_at` removed (`core.mjs:43-81`). Child env points `HOME`, `XDG_*`, `SWARM_AGENT_STATE_DIR`, `CLAUDE_CONFIG_DIR`, `GROK_HOME` inside that copy (`run.mjs:59-75`, `159-171`). Parent sentinel dirs were unchanged after `runTable` and after `agentCredentialStore`.

Cleanup on return, throw, SIGINT, SIGTERM, SIGHUP, exit 13: tests passed; v0.1.71 run left **no** new git worktree and **no** `cswarm-timeout-*` dir. Report and fetch log had no token (allowlist `preload.cjs:49-57`). Output file mode 0600.

Real CLI check/channel-ls/file-ls: **zero** `POST command` / `POST activity` / storage writes. Renewal `due()` is false when `expiresAt` is null (`renewal.ts:850`). `bearer()` does not POST.

## 3. Can the tests fail for the claimed reason?

Yes for the three named controls.

- Exit-path: fixture leaves a copy + worktree; emptying `cleanupRunResourcesSync` leaves them. SIGTERM/INT/HUP/exit 13 tests passed.
- Line-shift: pad lines keep `file:name` / `#N` ids (`timeout-table.test.ts:129-145`).
- Per-ref mapping: delete a live id or add a stale id throws; v0.1.71 section has no HEAD budget ids; unknown `--ref` throws.

`--ref` missing throws. `export *` skip of `default` and `{ timeout: N }` unit note have mutation tests.

## 4. Commits vs tree, docs vs code

Range is only `scripts/timeout-table/*` and `tests/p1-cli/timeout-table*.ts`. README `--ref v0.1.71` ack list matches that ref’s incomplete ids. Using that list with `--ref HEAD` is extra+missing, so the process fails closed.

No PRODUCTION defect. No RIGOUR defect that lets a FAIL or NOT MEASURED row become PASS.

VERDICT: PASS Round-4 folds hold: isolated state dirs, required `--ref`, per-ref mapping, incomplete rows cannot PASS, copy/worktree removed on the tested exit paths.
