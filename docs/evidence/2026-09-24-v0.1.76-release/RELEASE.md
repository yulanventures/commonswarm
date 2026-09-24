# cswarm 0.1.76 released (2026-09-24)

Carries item H release 2, the operator-run connect code (`docs/evidence/2026-09-24-mcp-release2/LANDING.md`). Release
notes: `NOTES.md` here (also on the GitHub release). Item H stays OPEN until the production done-test passes.

## Chain (UTC)

| step | result |
|---|---|
| lane | merged to main 92c111f1 (merge 21398b74 of lane/mcp-connect 094d9563); final D-036 pair Opus PASS + Grok PASS at 094d9563 |
| bump | 11136c7c `release: v0.1.76 ...` (`npm version --no-git-tag-version 0.1.76`) |
| gates | build 0; npm test 962; test:p1-cli 922; check:tests 0; `scripts/build-release.sh` 0; `scripts/build-npm.sh` 0; site build 0; site test 569 (1 skipped) on the rerun — the first run had one headless-Chrome SEGV in the markdown screenshot test (`markdown-wordwrap-qa.observer.test.ts`), which passed on the rerun |
| live control | both artifacts copied OUTSIDE the repository: `--version` 0.1.76; `whoami`, `check`, `members` exit 0 on the lead's seat; `mcp connect` with a piped stdin -> `terminal_required`, no secret; `--code=swm_join_...` -> "invalid option: --code", the value not echoed; no `--anon-key` -> `connect_anon_key_required`; `mcp code` with no human login -> refused ("not logged in"); the item I control and the MCP control passed on each artifact as for 0.1.75. A refused connect left only an empty `~/.cswarm/credentials.d` directory in the temporary home (no file) |
| artifacts | c844c446 `release: v0.1.76 build artifacts`, pushed to main |
| GitHub | `gh release create v0.1.76` exit 0 at 12:02:06Z; tag v0.1.76 = c844c446 = main tip; assets `cswarm`, `cswarm.sha256` (checksum OK outside the repo); Latest = v0.1.76 |
| npm | `npm publish` after a dry run (commonswarm 0.1.76, 4 files, 579.7 kB); `npm view commonswarm version` = 0.1.76 from 12:05:16Z |
| site | release 20260924T120222Z-c844c446f7ce-4db6db65dbc20c0c, built with `PUBLIC_H0_LINK_JOIN=1`: home 200, install.sh 200, 404 control 404; `/download` shows 0.1.76 (0 mentions of 0.1.75); `/start` meta = api.commonswarm.com; service-role marker 0; the app still loads the link-join module |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.76; `npm i -g`: `/opt/homebrew/bin/cswarm` 0.1.76; the lead's seat `check` exit 0 |

## Not established (the item H done-test)

- A live `cswarm mcp code` (needs a person signed in with `cswarm login`; no one is signed in on the mini) and
  `cswarm mcp connect` at a real terminal, then a fresh Codex session and a fresh Claude Code session that read, ask
  and reply with only the MCP tools, and transcripts free of `swm_join_` / `swm_agt_`. The Claude Code run also needs
  `claude` signed in on the mini.
- That an H0-registered seat works on the read edge and posts through MCP on production.
- That `cswarm principal revoke` works on an H0 seat.
