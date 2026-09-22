# CommonSwarm production cutover window — 2026-09-18

Box: `yulan-vps-1` (Hetzner CPX42, Tailscale `100.115.66.74`). Cutover time of record: **2026-09-18 16:20:12 UTC**.

## Important source note (read this first)

**Neither source log contains a raw, live execution transcript of the cutover itself.** The main Claude session log has no entries at all dated 2026-09-18 (its last 2026-09-17 entry is 14:55:32Z; its next entries are 2026-09-19). Astra2's Codex session that covers the morning of 2026-09-18 (`rollout-2026-09-17T10-13-07-...`, forked from the 09-17 rehearsal session) ends at **14:34:55 UTC on 09-18** — before the 16:20:12 UTC cutover — and was doing isolated-fixture testing of a new "H0 schema upgrade" migration step at that point, not a live box run. The next available Astra2 Codex session (`rollout-2026-09-18T13-16-35-...`) starts at **18:16:35 UTC**, about two hours *after* the cutover, and its visible work in that window is PromptEden-repository code review, not CommonSwarm cutover commands.

Everything below about the cutover's steps, controls, and checks comes from retrospective documentation, not a step-by-step log with individual UTC timestamps and exit codes. HezLead read `hetzner-handoff/HETZNER-OPERATIONS.md` and `hetzner-handoff/OLD-SERVICES-RETIREMENT.md` into its Claude session on 2026-09-19. The workspace record `hetzner-handoff/evidence/2026-09-18-core-cutover-HISTORICAL.md` was also read directly on 2026-09-22. Where a specific time, count, or check is used below, its source is named.

## Written record of the cutover

The operations record `hetzner-handoff/evidence/2026-09-18-core-cutover-HISTORICAL.md` (workspace runbook repository, not this repository) was written at the time of the cutover. Its CommonSwarm facts:

- Cutover at 16:20:12 UTC for https://commonswarm.com/app and https://api.commonswarm.com. Edge release `94353b42db4dadf54864f0c8935b3144081e22a9`, stack release `90e84f0eeca19482ffbe9a64e51f9ae659b3f5fb`.
- Final source snapshot restored. All 78 source table counts and five cron records matched. 791 files copied and SHA-256 checked. Two H0 tables added and the original counts rechecked.
- Google and GitHub sign-in completed in the production browser. GitHub opened an existing workspace and its Files view. Three native agent reads passed. The installed `cswarm check` passed in 464 ms.
- Direct verified-TLS database connections replaced pooled connections for the source pause and final copy. The production Google client ID and the GoTrue browser `apikey` header allowance were corrected in the protected environment file.
- The first backup after cutover finished at 16:49:55 UTC. Database bytes and all 791 object versions were verified offsite under `r2:yulan-vps-1-backups/000-commonswarm-postgres/20260918T164405Z-0f034376fc234195bce55181503ee158`.
- The old physical target directory and a full new recovery artifact set are kept on the box.

That record gives outcomes, not per-step exit codes. The per-step times and exit codes of the window were not captured in any session log found (see below).

## Summary

| Item | Value | Source |
|---|---|---|
| CommonSwarm production cutover | **2026-09-18 16:20:12 UTC** | HETZNER-OPERATIONS.md (read 2026-09-19) |
| PromptEden app cutover | 2026-09-18 16:23:34 UTC | HETZNER-OPERATIONS.md |
| PromptEden marketing source cutover | 2026-09-18 19:21:00.572634 UTC | OLD-SERVICES-RETIREMENT.md |
| CommonSwarm table/cron parity | "final copy matched all 78 source table counts and five cron records" | OLD-SERVICES-RETIREMENT.md |
| File objects | "All 791 copied file objects were SHA-256 checked" | OLD-SERVICES-RETIREMENT.md |
| Schema upgrade | "Two H0 tables were added and original counts rechecked" | OLD-SERVICES-RETIREMENT.md |
| Identity/auth checks | "Production Google and GitHub sign-in passed; an existing workspace and Files view opened" | OLD-SERVICES-RETIREMENT.md |
| `cswarm check` | "the real installed `cswarm check` passed in 464 ms" | HETZNER-OPERATIONS.md §6 |
| Native reads | "native reads passed" | HETZNER-OPERATIONS.md §6 |
| Detailed step-by-step transcript with per-step UTC times/exit codes | **Not found.** The historical cutover record was read and contains outcomes, not a command-by-command transcript. | `hetzner-handoff/evidence/2026-09-18-core-cutover-HISTORICAL.md` |

## Steps, in the order the handoff plan specified them (2026-09-17 14:50Z plan, not a 09-18 execution log)

HezLead's handoff note to Astra2 (2026-09-17, in the Claude session log) states the planned order for the cutover window, verbatim:

> "reset (in flight) → rehearsal 5–13 → **cutover window (freeze, dump/restore, api DNS to box, custom-domain deactivation, GitHub+Google sign-in check)** → 48 h fallback → retire Supabase + Vercel projects → later own auth/wake"

No later log in either source shows this sequence being executed with per-step timestamps. The retrospective documentation (below) confirms outcomes consistent with this plan having been carried out, but not the individual step timings or exit codes.

## Controls referenced

These are the named control scripts that the RUNBOOK and Astra2's rehearsal-prep work (2026-09-17) associate with the freeze/verify/identity steps of a cutover. **No log in either source shows these being invoked live during the 09-18 cutover window** — they are documented here because they are the controls the plan and tooling point to; their names and roles came from Astra2's script review on 2026-09-17 (`deploy/supabase-stack/migrate/`), not from a 09-18 run.

| Control | Script | Stated purpose (from tooling review, 09-17) |
|---|---|---|
| Freeze probe / enable / disable | `probe-database-freeze.sh`, `source-read-only.sh` | Statement-level write freeze (SQLSTATE 25006) plus database default read-only, enabled/disabled as one transaction each way |
| Count verification | `verify-counts.sh` / `verify-post-upgrade-counts.sh` | Per-table row counts + `cron-jobs.ndjson` compared as a multiset (order-independent) |
| Identity assertion | `assert-database-identity.sh` | Confirms the target database is the intended one before a destructive step runs |
| Schema upgrade | `apply-h0-upgrade.sh` | Applies two "H0" tables/migrations to the target, checked transactionally; explicitly never run against `source` |
| Storage parity | `restore-storage-metadata.sh`, `copy-storage.sh` | Storage object copy + metadata restore; retrospective doc states 791 objects SHA-256 checked |

Retrospective outcome claims for these controls, quoted from `OLD-SERVICES-RETIREMENT.md` (§"Cutover evidence"):

> "CommonSwarm final copy matched all 78 source table counts and five cron records. All 791 copied file objects were SHA-256 checked. Two H0 tables were added and original counts rechecked. Production Google and GitHub sign-in passed; an existing workspace and Files view opened. Native reads and installed `cswarm check` passed. See `evidence/2026-09-18-core-cutover-HISTORICAL.md`."

## GitHub and Google sign-in checks

`HETZNER-OPERATIONS.md` §6 ("Routine health and troubleshooting"), read 2026-09-19T19:55:20Z, states:

> "At cutover, the real installed `cswarm check` passed in 464 ms, native reads passed, and Google/GitHub browser sign-in worked. Do not claim those were rerun by this documentation pass."

This is the only mention of the GitHub/Google sign-in checks and the `cswarm check` timing in either source log. No separate log line shows the browser session, the account used, or a screenshot/URL for the sign-in check. The same document elsewhere notes (OLD-SERVICES-RETIREMENT.md): "Production Google and GitHub sign-in passed; an existing workspace and Files view opened" — i.e., after sign-in, a pre-existing CommonSwarm workspace and its Files view were confirmed to load against the new production stack.

## Post-cutover state, as reconciled 2026-09-19 13:50 UTC (read-only check by Anvil, quoted from `live-inventory.json` / `evidence/2026-09-19-retirement-reconcile.json` via the Claude session)

- Public health at reconcile time: `app_prompteden_api_health: ok`, `commonswarm_app: 200`, `commonswarm_auth: 200`, `prompteden_www: 200`, `eve_loopback: ready`.
- `live_matches_inventory: true`; active PromptEden slot `app-blue:3101`.
- Backups: host Postgres backup ok at 2026-09-19T03:15:43Z; CommonSwarm DB+object backup verified at 2026-09-19T03:51:51Z (791 objects, destination suffix `20260919T034642Z-28273a0883d744ed95a966f77ce87804`).
- Restore drills: last host restore drill 2026-09-17T00:37:14Z (**pre-cutover**); last CommonSwarm restore drill 2026-09-18T03:16:47Z (**pre-cutover**). Next scheduled: host 2026-09-20T04:00:00Z, CommonSwarm 2026-09-20T04:47:19Z. The documentation is explicit that a fresh, **post**-cutover isolated restore had not yet been proven as of this reconcile.
- 48-hour minimum retention holds recorded: CommonSwarm source until 2026-09-20T16:20:12Z; PromptEden core source until 2026-09-20T16:23:34Z; PromptEden marketing source until 2026-09-20T19:21:00.572634Z.
- `commonswarm_edge_restart_count: 68` at reconcile time, "still healthy" — logged as an ops-watch item, not a retirement or cutover failure signal.
- Explicit `not_done` list at reconcile time: post-cutover isolated restore proof; PromptEden R2 image restore proof; Eve volume restore/recurring coverage proof; remap or prove unused `NEXT_PUBLIC_SUPABASE_URL`; Vercel project/billing retirement; Railway project/billing retirement; CommonSwarm old website hosting identity.

## What is NOT in these logs

See `transcript-sources.md` for the complete list. In short: no raw command-by-command transcript of the 16:20:12 UTC cutover exists in the Claude or Astra2 Codex session logs examined, and the historical cutover record contains outcomes rather than per-step exit codes. Everything above is either the 09-17 pre-cutover plan or attributed retrospective documentation.
