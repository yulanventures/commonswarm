I'll verify each round-1 finding against the revised procedure and the repository, starting with the cited CLI, presence, and receipt code.All five round-1 findings and all five nits are fixed. The revised gates match the repository, and the changed text does not add a production-blocking defect.

## Findings

1. **FIXED.** `cswarm --version` prints one stdout line, `cswarm ${CLI_BUILD_VERSION} (protocol ${CLIENT_PROTOCOL_VERSION})` (`src/cli.ts:10478-10481`). The protocol is `0.1.0` (`src/cloud/config.ts:3`) and this tree’s build is `0.1.80` (`package.json:3`, `src/cloud/client-build.ts:23-24`). Preflight now requires `cswarm 0.1.80 (protocol 0.1.0)` and `cswarm 0.1.79 (protocol 0.1.0)`. Command substitution strips the trailing newline, so a correct install passes.

2. **FIXED.** `principal revoke --json` goes through `printJson`, which writes indented JSON (`src/cli.ts:1779-1780`) of `status`, `principal_id`, and `command_event_ids` (`src/cli.ts:2599-2607`). Accepted command responses always carry `event_ids` as an array (`src/cloud/command-client.ts:759`). The new gate parses each object, requires `status == "accepted"` for the requested principal, and reconciles 13 distinct ids. It no longer counts lines.

3. **FIXED.** `PROCEDURE.md` is outside `RUN/`, and the scanner reads only the enumerated files in that directory. Markers are built from parts (`swm` + `_agt` + `_`, `creden` + `tial`, `anon` + `key`, `commonswarm` + `anon-key`), so the procedure text is not a hit. The real meta name is `commonswarm:anon-key` (`site/src/layouts/Base.astro:206`); the token prefix is `swm_agt_` (`src/cloud/command-client.ts:21`). A clean `RUN/` does not contain those markers: revoke records are status, principal id, and event ids; configure, check, ask, receipt, and members JSON do not embed the credential or anon key.

4. **FIXED.** Control-C is handled in-process: stderr gets `cswarm: ` plus the stop sentence (`src/cli.ts:5004-5010`), and SIGINT’s exit code is 130 (`src/cloud/arrival-watch.ts:58`). After a successful release, the sentence is exactly `inbox --notify stopped because of SIGINT and this watcher's lease was released; nothing is watching this inbox now; restart it under the session's Monitor.` (`src/cloud/arrival-watch.ts:98-106`). `printedCommand` puts the restart command on the next line (`src/cloud/wake-lease-constants.ts:2-3`). Release returns `released: true` when the row is deleted (`supabase/migrations/20260926000001_agent_wake_leases.sql:116-125`; `src/cli.ts:5216-5224`). The procedure captures `$?` immediately and requires that exact line once in the redirected stderr file, then copies only that line into `RUN/`.

5. **FIXED.** Claude login and the development-channel key belong to Tom (`docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md:44-54`; host recovery is `claude auth login` in `docs/org/2026-08-29-RESUME-HERE.md:1016-1045`). Mint and revoke stay with Anvil under Tom’s existing CommonSwarm session (`docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:202-203`, `285-286`). The v2 checklist and sections 2.1–2.5 give Tom auth, the Haiku session, resume, both approvals, and session exit. Anvil’s steps are scratch setup, `cswarm` configure/status/ask/receipt, and revocation.

## Nits

1. **FIXED.** The roster control’s accessible name is `N agents — view and manage agents`, plus ` and M pending access items` when invites are waiting (`site/src/components/app/LiveDashboard.astro:4097-4104`; initial label at `468-476`). **People & agents** is the dialog title (`1030-1031`). The filter placeholder is **Filter agents…** and its label is **Filter agents** (`1056-1061`). The procedure uses that button, title, and placeholder.

2. **FIXED.** The anon-key tag is `site/src/layouts/Base.astro:206`. `cswarm target show --json --reveal-anon-key` returns `current_target.url` and `current_target.anon_key` (`src/cli.ts:1920-1940`, `src/cloud/current-target.ts:234-241`). The checker compares those fields and writes only `anon key fetched and matched` into `RUN/`.

3. **FIXED.** The `setup` command entry is `src/cli.ts:10110-10116`, including `--connection-file`, `--profile`, `--host-session-id`, and `--json`. The import-variant help string remains at `9964` and is no longer cited.

4. **FIXED.** Text and app lines omit `current` (`src/cli.ts:4332-4335`; `site/src/lib/agent-presence.ts:84-88`). A turn row is `turn, last <age>` (`src/cli.ts:4325-4327`; `site/src/lib/agent-presence.ts:76-78`). The app line has no `presence:` prefix (`site/src/lib/agent-presence.ts:88`). Section 3.5’s four lines match that renderer, including `none · last call: never · client build: unknown`.

5. **FIXED.** No command in this tree prints the raw configured build. `members --json` prints the seat’s `client_build` and the derived `client.kind` (`src/cli.ts:4310-4317`, `4515-4530`). `setup --check-version` prints the connection-format version (`src/onboarding-cli.ts:169-175`). `0.1.79` is `update available` only when it is strictly older than `current_client_build` (`src/cloud/agent-presence.ts:67-73`). Preflight records `current_client_build: NOT VERIFIED` and treats `docs/evidence/2026-09-27-box-g3c-g3d-t3a/BOX-WINDOW.md:473-495` as the old 0.1.79 publish sequence. G3e still requires the observed `update available` classification for the 0.1.79 watcher.

## New defects

None. The rewritten preflight, revoke parser, `RUN/`-only scan, stderr stop check, and Tom/Anvil split do not reject a correct run, accept a failed one, or hand Tom’s Claude session to Anvil.

VERDICT: PASS