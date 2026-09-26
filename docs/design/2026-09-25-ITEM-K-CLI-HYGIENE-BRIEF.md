# Item K brief: CLI hygiene — generated help, `profile ls`, `inbox --since` (2026-09-25)

Written by CSwarmDevLead. Source: brain `app-backlog` item K (HezLead's onboarding report, signal 40ca138f, 2026-09-14):
"(a) `cswarm --help` and every `<verb> --help` are stale (no setup, check, brain, receive, listen, profile; `receive
configure --help` prints nothing) — generate top-level and per-verb help from the same command table the parser
enforces; (b) `--profile` with a bare UUID returns `profile_path_invalid` with no example, and profiles live in two
layouts — add `cswarm profile ls` (seat, workspace, path) and put an example in the error; (c) `inbox --since` missed
an ask that `check` returned — measure and fix." Done when: "help text and the command table cannot drift (a test
fails when they do); `profile ls` lists every profile on the host; a control where `inbox --since` and `check` return
the same directed ask." Base: origin/main d437c291. Client only unless (c) proves a server cause (then stop and report).

## What is true today (mapped read-only; re-check each line)

- The command table is `AGENT_COMMANDS` (`src/cli.ts`, around :9509): description, flags, tool, transports, profile,
  help markers. `usage()` (`src/cli.ts`, around :868) is ONE hand-typed template literal; each entry's `help` array
  holds marker substrings that `resolveHelpLine()` must find in that literal. So the table checks the banner, it does
  not produce it. `tests/p1-cli/command-table-gates.test.ts` holds those checks.
- `MCP_TOOL_TABLE` (`src/mcp/tools.ts`) has its own descriptions on purpose; out of scope.
- There is no `cswarm profile` command. Profiles are written by `saveAgentProfile` (`src/cloud/agent-profile.ts`) at
  `defaultAgentProfilePath()` = `~/.cswarm/agents/<profileId>/<workspace_id>/<principal_id>/profile.json`, and by the
  web connect flow / `setup --profile <path>` at other paths (for example `~/.cswarm/connect-<principal>/profile.json`).
- `inbox --since <timestamp>` exists (`runSignalRead`, `checkedSince` in `src/cloud/signals.ts`); the read edge filters
  `s.created_at >= since`. `check` reads deliveries (`src/cloud/agent-check.ts`). Why they disagreed is not measured.

## Decisions

1. **Help is generated.** Top-level `cswarm --help` and `cswarm <verb> [<action>] --help` render from `AGENT_COMMANDS`
   (synopsis from the variants and flags, one-line description) plus the onboarding and human commands from their own
   table (make one if they have none). Prose sections that are not per-command (credential selection, channel notes)
   stay as named constants appended after the generated part. Every visible verb and action answers `--help` with
   exit 0 and a non-empty synopsis, including `receive configure --help`. Remove the marker mechanism if generation
   makes it redundant. A test fails when a command, flag, or variant exists in the table and not in help, or the
   reverse; keep the existing gates in command-table-gates.test.ts meaningful (update them, do not delete coverage).
2. **`cswarm profile ls`** lists every profile the CLI can find on this host: seat (principal id and name if stored),
   workspace (name and id), URL host, and path; `--json` for machines. It searches every layout the CLI writes, with
   the roots taken from the same functions that write them (no second typed list of paths), and says which roots it
   searched. It reads profile.json only; it never reads or prints a credential. A profile it cannot parse is listed
   with its path and the reason. It needs no network.
3. **`profile_path_invalid`** (a bare UUID or other non-path) says what a profile path looks like, with one example
   built from the real layout, and says `cswarm profile ls` lists them.
4. **`inbox --since` vs `check`:** reproduce first. Write a server test (tests/p1-server) that sends one directed ask
   and then runs the real `inbox --since <t>` and `check` code paths against the local edge, for the cases that can
   differ: `since` equal to the ask's created_at at millisecond and microsecond precision, `since` in another time
   zone offset, the ask older than the stale window (inbox hides stale unless `--include-stale`?), the default
   `--limit`, `about`/`channel` defaults. Record which case differs and why in LANE.md, then fix the client so a
   directed ask that `check` returns is returned by `inbox --since` for any `since` at or before it (or, if the
   difference is intended, say it in `inbox` output and help, generated from the constant). The lead runs the server
   test on the local stack; you write it and run the pure parts.
5. Every user-facing list in these messages is generated from the constant the code enforces (AGENTS.md).

## Tests

Each decision has a test that fails when its fix is reverted; record the measured mutation in
`docs/evidence/2026-09-25-item-k/LANE.md`. Tests reach a package script (check the glob or list).
