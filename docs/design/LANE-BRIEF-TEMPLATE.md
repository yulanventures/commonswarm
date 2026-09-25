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
- Review arms are read-only. A Grok arm gets no shell until it has a permission mode.
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
