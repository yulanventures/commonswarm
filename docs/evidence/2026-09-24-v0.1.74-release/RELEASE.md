# cswarm 0.1.74 released (2026-09-24)

Carries item H lane 2, `cswarm mcp` over stdio (`docs/evidence/2026-09-23-mcp-lane2/LANDING.md`). Release notes:
`NOTES.md` here (also on the GitHub release).

## Chain (UTC)

| step | result |
|---|---|
| lane | merged to main 5a7d5271 (merge 1062bdc3); final D-036 pair Opus PASS + Grok PASS at 0a45e791 |
| bump | 4ad627d1 `release: v0.1.74 ...` (`npm version --no-git-tag-version 0.1.74`) |
| gates | build 0; npm test 962; test:p1-cli 876; check:tests 0; `scripts/build-release.sh` 0; `scripts/build-npm.sh` 0; site build 0; site test 567 (1 skipped) |
| live control | both artifacts copied OUTSIDE the repository, against production with the lead's seat: `--version` 0.1.74; `whoami`, `check`, `members`, `brain ls` exit 0; the MCP production control (`docs/evidence/2026-09-23-mcp-lane2/production-control/control.mjs`) on the release binary and on the npm bundle: every tool answered, a same-`request_id` replay returned the same signal, the two expected refusals (403 `forbidden`, 409 `command_id_conflict`), `-32602` for a `profile` argument, empty server stderr, no token or path in the log |
| artifacts | e0078407 `release: v0.1.74 build artifacts`, pushed to main |
| GitHub | `gh release create v0.1.74` exit 0 at 01:57:21Z; tag v0.1.74 = e0078407 = main tip; assets `cswarm`, `cswarm.sha256` (checksum OK outside the repo); Latest = v0.1.74 |
| npm | `npm publish` after a dry run (commonswarm 0.1.74, 4 files, 573.5 kB); `npm view commonswarm version` = 0.1.74 from 02:01:04Z |
| site | release 20260924T015805Z-e0078407d8af-3c7a8e4c0503b87b, built with `PUBLIC_H0_LINK_JOIN=1`: home 200, install.sh 200, 404 control 404; `/download` shows 0.1.74 (0 mentions of 0.1.73); `/start` meta = api.commonswarm.com; service-role marker 0; the app still loads the link-join module |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.74; `npm i -g`: `/opt/homebrew/bin/cswarm` 0.1.74 |

## Not established

- A full Claude Code session with the server: Claude Code 2.1.280 connected and listed the seven tools, then stopped
  on "OAuth session expired and could not be refreshed" before any model turn. It needs a signed-in `claude` on the
  mini.
- Nothing on the box changed: this release is the CLI, npm and the site only.
- A trap met on the way: `dist-release/cswarm` run at its in-repository path fails ("module is not defined in ES
  module scope") because the repo's package scope is ESM; the copied artifact runs. Check release artifacts from a
  copy outside the repository.
