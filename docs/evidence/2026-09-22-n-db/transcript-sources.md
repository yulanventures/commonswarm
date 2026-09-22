# Sources and gaps

## Files read

### 1. Claude Code session log (JSONL)
`/Users/yulanbot/.claude/projects/-Users-yulanbot-Developer-Ridge-io/53da0680-4ac1-42db-b90b-ef8b695aee7e.jsonl` (6,812 lines; dates present: 2026-09-14, 15, 16, 17, 19, 20, 22 — **no lines dated 2026-09-18**).

Used ranges / anchors (line numbers are approximate, from the raw JSONL as read on 2026-09-22; not stable across edits to the log):
- Lines ~555–735 (timestamps 2026-09-17T11:39:38Z–14:55:32Z): HezLead's direct pre-dump work on the box (steps 1–6), the password-reset incident note, the killed first Codex worker, the handoff to Astra2, the password verification, and the gate-open message. Specific tool-call IDs quoted: `toolu_013a8ZA74nNTsNAPdUmhCwLS` (steps 1–6 transcript), `toolu_01SEpGTnqBfKhiBbrHzCZvwh` (incident note), `toolu_01SMBu8qUNVhqDFhnLBEeCko` (killed worker + handoff doc), `toolu_01SCXTsNvzpWjnNT2hYcpKkT` (handoff message to Astra2), `toolu_011YuaZMw8BsBd3DE4HZrgoK` (Anvil's password-reset report + box verification), `toolu_01QPAyC4JpX3NyJRgfTPFrFF` (migration.env rewrite), `toolu_01GFeuUXdeQa2drxVdbWJEst` (gate-open message).
- Lines ~3152–3170 (timestamp 2026-09-19T19:55:15Z–19:55:20Z): HezLead reads `hetzner-handoff/HETZNER-OPERATIONS.md`, `hetzner-handoff/OLD-SERVICES-RETIREMENT.md`, and `hetzner-handoff/evidence/live-inventory.json` (or the 09-19 reconcile JSON) in full, as `ls`/`cat` tool results. These are the source for the cutover-window facts (16:20:12 UTC time, 78-table/5-cron parity, 791 objects, H0 tables, GitHub/Google sign-in, `cswarm check` 464 ms).
- Lines ~3260–3273 (2026-09-19T20:01:59Z–20:02:34Z): HezLead restates the 16:20:12 UTC cutover time and live traffic path in a `cswarm reply` to another agent (EMP-1) — consistent with, not additional to, the documentation above.

Date-scan method: parsed every line's `timestamp` field; confirmed no `2026-09-18` prefix appears anywhere in the file.

### 2. Codex session logs for Astra2

Examined every `.jsonl` file in `~/.codex/sessions/2026/09/17/` (29 files) and `~/.codex/sessions/2026/09/18/` (1 file), by `cwd`, time range, and keyword density (`step 5`…`step 13`, `recovery drill`, `yulan-vps-1`, `100.115.66.74`, `cutover`). Files clearly used:

- `rollout-2026-09-17T10-13-07-01a0afed-baf5-72b1-a905-005a1d90240a.jsonl` — the main Astra2 orchestration thread, `cwd=/Users/yulanbot/Developer/Ridge.io/prompteden`, session_id `01a08736-c173-7ca3-a6e6-ce7e3f8ee6ec`. Covers **2026-09-17T15:13:07Z through 2026-09-18T14:34:55Z**. Source for: the rehearsal-prep reading (15:13–15:14Z), the cron-jobs-diff investigation on the completed steps 5–8 artifact (15:19–15:20Z), the steps 9–13 runner script + "not executed" notes (15:36Z), and later (09-18 early morning) isolated-fixture testing of a new H0 schema-upgrade step (02:34–02:35Z on 09-18).
- `rollout-2026-09-17T10-12-34-01a0afed-3743-72f0-ab69-3105d4dacc3c.jsonl` — a sibling/earlier fork of the same parent thread (15:12:34Z–16:03:16Z). Checked for a direct SSH rehearsal run; found none (its one `100.115.66.74` SSH call is an unrelated Caddy-config read).
- `rollout-2026-09-17T20-20-16-01a0b219-9645-7122-9c48-3996f8ee3d17.jsonl` — another fork of the same parent thread (2026-09-18T01:20:16Z–05:32:26Z). Checked; its 4 SSH calls to the box are Postgres activity-topic queries unrelated to rehearsal steps 5–13 or the cutover.
- `rollout-2026-09-17T09-48-57-01a0afd7-985a-7e82-8f1c-0dd2e4d50668.jsonl` — the first, killed rehearsal-worker attempt (14:48:57Z–14:49:00Z). Contains 0 `exec` tool calls, confirming HezLead's own note that it "hung reading stdin; nothing ran."
- `rollout-2026-09-18T13-16-35-01a0b5bc-0e73-7fa2-8d27-8d0b649bda05.jsonl` — the only Codex session file in the `2026/09/18` directory, `cwd=prompteden`, covering 18:16:35Z–19:08:59Z on 09-18. Checked in full for CommonSwarm/cutover content (`grep -i "commonswarm\|16:20:12"`); **zero matches** — its visible work is PromptEden code review, not the CommonSwarm cutover.

Files in `~/.codex/sessions/2026/09/17/` with `cwd=/private/tmp/pe-hz-f-review` or `/private/tmp/pe-hz-g2-review` (the majority of the 29 files) were scanned by keyword density and found to be unrelated PromptEden review sessions; not used.

Extraction method: for each rollout file, parsed `response_item` entries of type `custom_tool_call`/`custom_tool_call_output` with `name="exec"`, recovering the shell command from the `input` field (a JS-wrapped `tools.exec_command({cmd:"..."})` call) and the real stdout from the nested JSON `{"output": "..."}` structure inside the `output` field's `input_text` blocks. The temporary `extract_codex2.py` and `extract_claude_pairs.py` helpers were deleted and are not committed.

### 3. Workspace cutover record

`hetzner-handoff/evidence/2026-09-18-core-cutover-HISTORICAL.md` in the workspace runbook repository was read directly on 2026-09-22. It is the source for the recorded 16:20:12Z CommonSwarm cutover, release SHAs, parity counts, sign-in and native-read results, first backup result, and retained recovery artifacts. It records outcomes, not a command-by-command transcript.

## What could NOT be found in these logs (do not assume it happened as described elsewhere)

1. **A raw, per-step execution transcript for rehearsal steps 5–8** (2026-09-17). An artifact directory named `n-db-rehearsal-20260917T151552Z` exists, and Astra2 read one file from it, `logs/restore-cron-jobs-target.log`, starting at 15:19:26Z. No `exec` call in any of the three examined Astra2 rollout files shows the runner script being launched (e.g., `ssh ... 'sudo bash /tmp/ndb-steps-5-8.sh'`), so the run itself, individual step start/end times, and exit codes for steps 5–8 were not captured.
2. **Execution of rehearsal steps 9–13.** Astra2 wrote and reviewed a runner script and notes file whose own header states "not executed." No later log shows it being run, and no `steps-9-13/transcript.txt` is ever read back in either source.
3. **The recovery drill**, in its entirety. It is referenced only as a RUNBOOK section name (e.g., in `deploy/supabase-stack/RUNBOOK.md`: "Run the rehearsal, the cutover window, and the recovery drill from one root shell..."). No execution, transcript, or result for a recovery drill appears in either source log.
4. **A raw execution transcript for the 2026-09-18 16:20:12 UTC cutover itself.** The Claude session log has no 2026-09-18 entries at all. The Astra2 Codex session that runs up to 14:34:55Z on 09-18 ends before the cutover; the next available Astra2 Codex session starts at 18:16:35Z, after the cutover, and its content is unrelated (PromptEden). The cutover facts in `cutover-window-2026-09-18.md` come from retrospective documentation: `hetzner-handoff/HETZNER-OPERATIONS.md` and `hetzner-handoff/OLD-SERVICES-RETIREMENT.md`, read into HezLead's Claude session on 2026-09-19, plus the historical cutover record read directly on 2026-09-22. None is a live command transcript.
5. **Anvil's own action log for the 14:53Z production DB password reset** (2026-09-17). Only HezLead's summary of Anvil's report appears in the Claude session log; Anvil's own session is not one of the two designated sources.
6. **A `2026-09-19` reconcile JSON tool result was truncated mid-read** (line ~3166 in the Claude log begins with a stray "Exit code 1" / shell artifact before the JSON body); the JSON itself parsed cleanly and was used, but note that its surrounding shell context showed a non-zero exit code from an unrelated `(eval)` error in the same combined command, not from the JSON-producing command itself.

## Secret-scanning method

Before writing the two evidence transcripts, every value copied from the source logs was checked against the following before inclusion:
- Manually excluded any line containing a password, token, connection-string credential, JWT, or key from being quoted — and connection strings were kept to scheme/user/host/port only (e.g., "session pooler 5432 as `postgres.ukezjcnxjvkpkeezxaew`", no password).
- After drafting, ran `grep -inE "eyJ|password=|postgres://[^ ]*:[^ @]*@|sk-[a-zA-Z0-9]|api[_-]?key\s*[:=]"` against both `rehearsal-2026-09-17.md` and `cutover-window-2026-09-18.md`. Zero matches in both files.
- Personal email addresses encountered in the raw logs were paraphrased out rather than quoted.
- No SHA-256 checksums, image tags, commit hashes, or object counts were treated as secrets (they are not credentials); these were kept as-is per the task's redaction rule, which targets passwords/tokens/keys/JWTs/connection-string passwords/cookies/private keys, not content hashes.

## Working files

Raw extraction dumps and Python helper scripts used to research this task (unredacted, not secret-scanned line-by-line) were deleted from this output directory after the three deliverable files were written, so that only secret-scanned content remains here.
