# CommonSwarm N-db migration rehearsal — 2026-09-17

Box: `yulan-vps-1` (Hetzner CPX42, Tailscale `100.115.66.74`). Lane `n-db-stack`, release `6d13314c7b3b432dd7a38a751c45047d6f95562c`. Secrets redacted throughout.

Runbook reference: `deploy/supabase-stack/RUNBOOK.md`, section "Box rehearsal from a fresh production dump" (steps 1–13), plus a "Recovery drill" section referenced but not captured in these logs.

## Summary

| Phase | Who ran it | UTC window | Result as shown in logs |
|---|---|---|---|
| Steps 1–4 (layout, versions, certs, env files) | HezLead (Claude session) | 11:39:38–11:42:03 | All exit 0 |
| Step 5 (Postgres up) + Step 6 (fresh-data-dir practice, run early) | HezLead (Claude session) | 11:42:03–11:42:55 | All exit 0; dump itself deferred (source password not yet reset) |
| Edge-staging interim restart | HezLead (Claude session) | 11:44:37–11:44:56 | compose up exit 0, `/health` → `{"status":"ok"}` |
| Incident: hosted Supabase function secrets broken by the password reset HezLead authorized | HezLead (Claude session) | 12:25–12:40 (logged 14:52:23) | Fixed via `supabase secrets set` |
| First Codex rehearsal worker (steps 5–13) | HezLead-launched Codex worker | started ~14:44, killed 14:49:51 | Hung reading stdin; **no commands executed** (0 exec calls in its own log) |
| Handoff of the whole migration to Astra2 (Codex) | HezLead → Astra2 (cswarm message) | 14:50:15–14:53:10 | Accepted |
| Production source-DB password reset | Anvil (not in either source log directly; referenced by HezLead) | 14:53 UTC | Reset confirmed, pooler `select 1` OK |
| `migration.env` `SOURCE_DATABASE_URL` rewritten + verified | HezLead (Claude session) | 14:54:52–14:55:08 | "source login OK"; file rewritten 0600 |
| Gate-open message: "run rehearsal steps 5–13 now" | HezLead → Astra2 | 14:55:19 | Accepted — **this is the last CommonSwarm-rehearsal action in the Claude session log; the session has no further 2026-09-17 entries after 14:55:32** |
| Steps 5–8 (dump, restore-target, prepare-target, restore-cron-jobs, seed-realtime, setup-realtime, verify-counts) | Astra2 / its worker | artifact directory timestamped 15:15:52Z | **Not directly visible as raw command output in the Astra2 Codex session log.** By 15:19:26 Astra2 is already reading completed result artifacts from `/home/commonswarm/migration-artifacts/n-db-rehearsal-20260917T151552Z/` (see below) |
| Steps 9–13 (edge cutover to box DB, freeze/probe/enable/disable sequence) | Astra2 | runner script written and reviewed by 15:36:48; explicitly marked **"not executed"** | No later execution found in these logs |
| Recovery drill | — | — | **Not found in these logs** — only mentioned as a RUNBOOK section name, never as an executed step |

**Important caveat:** the two source logs do not contain a raw, per-step transcript for rehearsal steps 5–8 with individual exit codes (the kind HezLead produced for steps 1–6). What the Astra2 Codex session shows is (a) the *prepared* runner scripts and RUNBOOK text, and (b) Astra2 *reading the output artifacts* of a run that had already finished by 15:15:52Z — 20 minutes after HezLead's 14:55Z handoff. The process that actually executed steps 5–8 is not captured as an `exec` tool call in the Astra2 rollout files examined (`rollout-2026-09-17T10-13-07-...`, `rollout-2026-09-17T10-12-34-...`, `rollout-2026-09-17T20-20-16-...`). See `SOURCES.md`.

---

## Steps 1–6 (pre-dump), run directly by HezLead

Source: main Claude session, tool call `toolu_013a8ZA74nNTsNAPdUmhCwLS` (2026-09-17T11:43:31Z), which is HezLead writing its own transcript file (`scratchpad/ndb-transcript-1.md`) from the raw command output it had just read. Quoted as written (exit codes as HezLead recorded them):

**STEP 1 — layout, 11:39:54Z**
- Unpack release `6d13314c` → `/home/commonswarm/stack/releases/6d13314c` and `/home/commonswarm/edge/releases/6d13314c` (owner `commonswarm`) — exit 0
- `readlink -f /home/commonswarm/stack/current` → `/home/commonswarm/stack/releases/6d13314c`
- `readlink -f /home/commonswarm/edge/current` → `/home/commonswarm/edge/releases/6d13314c` (switched 11:40:31Z from a prior release)
- `docker network inspect commonswarm-net` → `commonswarm-net 172.31.0.0/24` — exit 0

**STEP 2 — production versions, ~11:40Z**
- Public endpoint checks: `storage/v1/version` → 200 `"1.77.5"` (pin matches). `auth/v1/health`, `rest/v1/`, `realtime/v1/api/ping` → 401 without an API key (not independently confirmed from the mini).

**STEP 3 — certificates, 11:40:31Z**
- `stat` on `/etc/commonswarm/pg-tls` and its contents: directory `100:101 750`; `server.crt 100:101 644`; `server.key 100:101 600`; `ca.crt 100:101 644`; `/etc/ssl/yulan-internal-ca.pem 0:0 644`
- `openssl x509 -checkhost db.commonswarm.internal` → "does match" — exit 0
- `openssl x509 -checkip 172.31.0.10` → "does match" — exit 0
- `cmp ca.crt /etc/ssl/yulan-internal-ca.pem` — exit 0

**STEP 4 — env files, 11:42:03Z**
- `/home/commonswarm/.env` rendered from `env.example` at `6d13314c`: 40 values filled from vault/JWKS/CA; edge pooler values kept at current settings; old file saved as `.env.bak-pre-ndb-<timestamp>`; mode 0600 `commonswarm`.
- `/home/commonswarm/migration.env` rendered: `SOURCE_DATABASE_URL` = session pooler as `postgres.ukezjcnxjvkpkeezxaew` with the **then-stale vault password** (replaced later, see below); `SOURCE_SYSTEM_IDENTIFIER=7662742571317219726`; `TARGET_DATABASE_URL` = `supabase_admin@db.commonswarm.internal` verify-full + sslrootcert; `CUTOVER_CONFIRM` empty; mode 0600.
- JWT digest check → `"JWT secret digests match: 1 distinct digest"` — exit 0
- Empty-value scan of `.env` → none found

**STEP 5 (database only), 11:42:03Z**
- `docker compose ... up -d postgres` → Created/Started — exit 0
- `wait_healthy postgres 180` → exit 0 after 6s (container `af69f063…`)
- `dump-source.sh` **not run yet** — waiting on the production DB password reset

**STEP 6 — fresh-data-directory practice (run early, before the dump), 11:42:48Z**
- Edge compose down — exit 0 (edge-staging is therefore down from 11:42:48Z until step 9)
- Stack down — exit 0
- `mv /var/lib/commonswarm/postgres → postgres.rehearsal-before-restore-20260917T114249Z` (40 MB, kept) — exit 0
- `install -d -m 0700 -o 100 -g 101 /var/lib/commonswarm/postgres` — exit 0
- `up -d postgres` → exit 0; `wait_healthy` → exit 0 after 6s

State at 11:42:55Z: `commonswarm-postgres` Up (healthy) on the fresh data directory; box memory used 1.95 GB. HezLead stopped here as agreed, to continue from the dump once the production DB password was available.

**Edge-staging interim restart, 11:44:37–11:44:56Z**
- `docker compose -p commonswarm-edge ... up -d` on today's pooler values — exit 0
- `GET http://127.0.0.1:9000/health` → `{"status":"ok"}`

## Incident during the window (12:25–12:40Z, logged 14:52:23Z)

HezLead's own retrospective note: the production DB password reset it had authorized broke CommonSwarm's **hosted** Supabase edge-function secrets (`SUPABASE_DB_URL` / `SWARM_DATABASE_URL` on the hosted side also used the postgres login — HezLead had told Tom nothing hosted used it, which was wrong). Fixed via `supabase secrets set --project-ref ukezjcnxjvkpkeezxaew --env-file` using the box's `commonswarm_edge` pooler URLs. Lesson recorded: enumerate every consumer of a shared credential before rotating it.

## First rehearsal-worker attempt (killed)

- HezLead launched a Codex worker on the "steps 5–13" prompt at approximately 12:18 (HezLead's own note) / the kill command ran at **14:49:51Z**: `kill 88579; pgrep -f "codex exec --model gpt-5.6-sol" | ... | xargs kill` → "stuck codex worker stopped".
- HezLead's own handoff note states plainly: "I launched a Codex worker on that prompt at 12:18Z and killed it (it hung reading stdin); nothing ran."
- Cross-checked against that worker's own rollout file (`rollout-2026-09-17T09-48-57-...`, 14:48:57–14:49:00Z): **0 exec tool calls** — consistent with "nothing ran".

## Handoff to Astra2 (Codex)

- 14:50:15–14:53:10Z: HezLead sends `handoff-astra2.md` (full migration state, access, and remaining-work list) to Astra2 via `cswarm ask`, per Tom's operator order ("offload the work of you and the other claude management agents to codex astra2 and have it run point from now on … it can spin up its own subagents"), driven by a Claude token shortage until 2026-09-18 21:00 local.
- The handoff doc's own remaining-work line for CommonSwarm: *"reset (in flight) → rehearsal 5–13 → cutover window (freeze, dump/restore, api DNS to box, custom-domain deactivation, GitHub+Google sign-in check) → 48 h fallback → retire Supabase + Vercel projects → later own auth/wake."*

## Password reset and gate-open (14:53–14:55Z)

- **14:53 UTC**: Anvil resets the production Supabase DB password (per HezLead's log of Anvil's report: "Reset is done. When: 2026-09-17 14:53 UTC. Dashboard said the database password updated. API returned 200."). Anvil's own action is not itself in either of the two source logs — only HezLead's record of receiving that report is.
- **14:54:52Z**: HezLead reads the new password from vault (length 48, value not printed) and pipes it through `ssh` to run `select 1` against the source pooler from the box → `source login OK`.
- **14:55:08Z**: HezLead rewrites only the `SOURCE_DATABASE_URL` line of `/home/commonswarm/migration.env` on the box via a `sudo python3` one-liner (no secret on argv) → `migration.env SOURCE_DATABASE_URL updated`; file re-chowned/chmod 0600 `commonswarm:commonswarm`.
- **14:55:19Z**: HezLead sends the gate-open message to Astra2: *"the gate is open ... Run rehearsal steps 5–13 now per the worker prompt in brain astra2-migration-handoff (skip its step 0)."*
- **14:55:32Z**: last timestamp in the Claude session log for 2026-09-17. HezLead does not appear again in this session log until 2026-09-19.

## Steps 5–8, as reconstructed from Astra2's own session

Astra2's Codex session (`rollout-2026-09-17T10-13-07-01a0afed-baf5-72b1-a905-005a1d90240a.jsonl`) begins its working turn at **15:13:07Z**, reading the same prompt and scripts HezLead prepared (`ndb-rehearsal-prompt.md`, `ndb-steps-5-9.sh`, `RUNBOOK.md`).

By **15:19:26Z**, Astra2 is reading files inside `/home/commonswarm/migration-artifacts/n-db-rehearsal-20260917T151552Z/` — i.e., an artifact directory whose name encodes a run that started at **15:15:52Z**, about 20 minutes after HezLead's gate-open message. This is the only evidence in these logs that steps 5–8 (dump-source, restore-target, prepare-target, restore-cron-jobs, seed-realtime-tenant ×2, setup-realtime, `verify-counts`, stack up, restart realtime, copy-storage forward, restore-storage-metadata, `verify-counts` again) actually ran. **No exec call in Astra2's session shows the runner script (`sudo bash /tmp/ndb-steps-5-8.sh`, or equivalent) being launched, so per-step exit codes and start/end times for steps 5–8 are not available from these logs.**

What Astra2 *does* show, working from the resulting artifacts (all exit 0 on the `python3` inspection commands used):

- **15:19:26Z**: reads `logs/restore-cron-jobs-target.log` — flags one diagnostic line: "the target cron jobs differ" (a diff present, no completion marker found for that one log).
- **15:19:41Z**: parses the diff — `source_diff_rows 1`, `target_diff_rows 1`; the single differing row on each side is job `swarm_purge_file_artifacts` (schedule `17 * * * *`, database `postgres`, user `postgres`); field-by-field comparison shows **no actual value differences** (`positional_different_fields []`).
- **15:19:57Z**: confirms the two JSON lines are byte-for-byte equal (`exact_equal True`) and the source `cron-jobs.ndjson` has 5 rows, ends with a single trailing newline, no CR characters.
- **15:20:08Z**: confirms the discrepancy is pure ordering — `source_order` and `target_order` list the same 5 job names, just in a different sequence; `same_names True`.

Conclusion Astra2 reaches from the artifact (not a fresh run, just analysis): the "cron jobs differ" line was a row-order artifact of the diff tool, not a real migration defect — all 5 cron jobs carried over with identical fields.

## Steps 9–13 (edge cutover to box DB, freeze/probe/enable/disable) and the Recovery drill

- At **15:36:17–15:36:48Z**, Astra2 writes and reviews a standalone runner, `/tmp/astra-hetzner/ndb-steps-9-13.sh`, plus a notes file `ndb-steps-9-13-notes.md`. The notes file's own header states: **"N-db steps 9–13 runner — not executed. GPT review this file and `ndb-steps-9-13.sh` before root runs anything."**
- The notes describe (as design, not as an executed log): the compose `--force-recreate` requirement for step 9 (env-file content changes don't trigger a container recreate otherwise); the `.env.bak-pre-step9` `O_EXCL` backup; the step-13 freeze sequence — "unset → preflight target → SET unguarded from that output → enable target → frozen probe (expect 65) → SET unprobed from that output → frozen probe → enable target again → disable target → writable probe"; and health checks against loopback ports only.
- At **15:36:48Z**, Astra2 unit-tests the *helper functions* inside that script (password rewriting, freeze-acknowledgment parsing) against synthetic fixtures in a temp directory — these are dry-run correctness checks of the script's logic, not a run against the box. All fixture checks passed as coded (e.g., `rewrite plain rc 0`, `ack empty rc 0 expected 0`, `ack missing rc 1 expected 1`).
- No later exec call in any of the three examined Astra2 Codex session files shows `ndb-steps-9-13.sh` actually being invoked against the box, and no call shows a `steps-9-13/transcript.txt` being read back.
- The RUNBOOK's "Recovery drill" section is referenced only by name (e.g., a Python snippet slicing the RUNBOOK text between "## Cutover window" and "## Recovery drill", and one line in `deploy/supabase-stack/RUNBOOK.md` itself: *"Run the rehearsal, the cutover window, and the recovery drill from one root shell started with `sudo -i`."*). **No recovery-drill execution, transcript, or result appears in either source log.**

## What is NOT in these logs (see SOURCES.md for the full gap list)

- The raw per-step transcript for rehearsal steps 5–8 (start/end UTC times, individual exit codes) — only the artifact-directory timestamp (15:15:52Z) and Astra2's post-hoc reading of result files are present.
- Any execution of steps 9–13 or the recovery drill.
- Anvil's own action log for the 14:53Z password reset (only HezLead's summary of Anvil's report is present).
