# cswarm 0.1.75 released (2026-09-24)

Carries item I, a profile bound to the host session that ran setup (`docs/evidence/2026-09-24-item-i/LANDING.md`).
Release notes: `NOTES.md` here (also on the GitHub release).

## Chain (UTC)

| step | result |
|---|---|
| lane | merged to main 1c5079b6 (merge 04c120ef of lane/item-i 1f4ffb73); final D-036 pair Opus PASS + Grok PASS at 1f4ffb73 |
| bump | 222b5e2b `release: v0.1.75 ...` (`npm version --no-git-tag-version 0.1.75`) |
| gates | build 0; npm test 962; test:p1-cli 896; check:tests 0; `scripts/build-release.sh` 0; `scripts/build-npm.sh` 0; site build 0; site test 567 (1 skipped) |
| live control | both artifacts copied OUTSIDE the repository, against production: `--version` 0.1.75; `whoami`, `check`, `members`, `brain ls` exit 0 on the lead's unbound seat; the item I control (`docs/evidence/2026-09-24-item-i/production-control/control.sh`) on each artifact: session A reads, session B `profile_other_session` and no id `host_session_required` with the network blocked, the block's own control fails on the network, the copy removed; the MCP control on each artifact: 2 expected refusals, one signal for a same-id replay, no token or path |
| artifacts | 12627a66 `release: v0.1.75 build artifacts`, pushed to main |
| GitHub | `gh release create v0.1.75` exit 0 at 06:54:13Z; tag v0.1.75 = 12627a66 = main tip; assets `cswarm`, `cswarm.sha256` (checksum OK outside the repo); Latest = v0.1.75 |
| npm | `npm publish` after a dry run (commonswarm 0.1.75, 4 files, 575.3 kB); `npm view commonswarm version` = 0.1.75 from 06:57:54Z |
| site | release 20260924T065431Z-12627a6617b6-5c3d4fb2a34d51b1, built with `PUBLIC_H0_LINK_JOIN=1`: home 200, install.sh 200, 404 control 404; `/download` shows 0.1.75 (0 mentions of 0.1.74); `/start` meta = api.commonswarm.com; service-role marker 0; `/skills/cswarm/SKILL.md` names `--host-session-id` (4); the app still loads the link-join module |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.75; `npm i -g`: `/opt/homebrew/bin/cswarm` 0.1.75; the lead's own (unbound) seat `check` exit 0 on 0.1.75 |

## Not established

- A real `cswarm setup` that binds a profile on production (tests cover it; the control bound a copy).
- Host id equality between `$CLAUDE_CODE_SESSION_ID` / `$CODEX_THREAD_ID` and hook stdin, and after `/clear` or resume.
- Nothing on the box changed: CLI, npm and the site only.
