# Lane brief template

Copy this file to `docs/design/<date>-ITEM-<x>-BRIEF.md`. Keep every section.

## Order and base

Who ordered the lane and when; the base commit on `main`; client, server, site, or migration.

## What is true today (mapped read-only)

File and symbol citations. Re-check each line before implementing; cite symbols, not line numbers.

## Decisions

Numbered. Each is testable. Every user-facing list is generated from the constant the code enforces.

## Tests

Each decision has a test that fails when its fix is reverted; record the measured mutation in the lane's
`docs/evidence/<date>-item-<x>/LANE.md`. Name the package script that reaches each test.

## Sandbox rules (do not remove; see AGENTS.md "Sandbox and deletion rules")

- The Maker runs as `codex exec … -s workspace-write` (or another sandboxed CLI). It never runs with a
  bypass or full-access flag, and it never inherits a bypass-permissions session.
- The Maker and the arms do not run test suites. The lead runs the gates, in a sandbox or in a clean
  worktree with an absolute `HOME` the lead created. The brief names the exact gate commands.
- Review arms are read-only. A Grok arm runs with `--permission-mode plan` or
  `--disallowed-tools run_terminal_command,kill_command_or_subagent,get_command_or_subagent_output,search_replace`.
- Every arm and Maker prompt carries these two sentences verbatim: "HOME is never assigned in a shell
  script; pass it only inside `env HOME="$T" cmd`, where `T=$(mktemp -d /tmp/lane-home.XXXXXX) || exit 1`,
  and delete only $T." and "Run no test suite; the lead runs the gates."
- Every gate run goes through `scripts/run-gates.sh` (it creates the temporary HOME, runs each gate in its own
  process group, and fails if anything appears under the real home). Nobody types `npm test` or
  `npm run test:p1-cli` bare.
- Any command whose exit gates a decision runs with `set -o pipefail` or reads `${PIPESTATUS[0]}`; a pipe into
  `tail`, `head` or `grep` never decides a landing (measured 2026-09-26: a wrapper commit landed while its own
  control was red because the status went into `| tail`).
- Any script in the lane that removes a directory named from a variable resolves the path first and
  refuses `/`, the home directory, an empty value, and any path outside its own temporary root, with a
  control test.
- Contact no production host. Every `cswarm` command carries a loopback `--url`. Read no
  `~/.cswarm` or `~/.config/cswarm`.

## Gates

`npm run build`; `env -u FORCE_COLOR npm test`; `env -u FORCE_COLOR npm run test:p1-cli`;
`npm run check:tests`; `npm run check:edge`; `npm run build:command-core && git diff --exit-code
supabase/functions/_shared/protocol.js`; `bash scripts/build-release.sh` (check its exit code);
`npm --prefix site run build`; `git diff --check origin/main...HEAD`; server tests on the lead's local stack.

## Deferred and not established

What the lane does not do, and what it did not measure.
