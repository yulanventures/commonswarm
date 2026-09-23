# cswarm 0.1.73 released (2026-09-23)

Carries the listener lane (`docs/evidence/2026-09-22-listener-outage/LANDING.md`): a listener survives a server
outage. Release notes: `NOTES.md` here (also on the GitHub release).

## Chain (UTC)

| step | result |
|---|---|
| bump | 0387a955 `release: v0.1.73 — ...` (`npm version --no-git-tag-version 0.1.73`) |
| gates | build 0; npm test 962; test:p1-cli 854; check:tests 0; `scripts/build-release.sh` 0; `scripts/build-npm.sh` 0; site test 567 (after a site build) |
| live control | the built artifact copied OUTSIDE the repository, against production with the lead's seat: `--version` 0.1.73; `whoami`, `check`, `inbox`, `members`, `brain ls` exit 0; turn-mode `check` exit 0. The listener's own live control against production through a fault proxy is in the lane record. |
| artifacts | 06989e9c `release: v0.1.73 build artifacts`, pushed to main |
| GitHub | `gh release create v0.1.73` exit 0 at 20:38:56Z; tag v0.1.73 = 06989e9c = main tip; assets `cswarm`, `cswarm.sha256`; listed as Latest |
| npm | `npm publish` exit 0 after a dry run (commonswarm 0.1.73, 4 files, 564.7 kB); `npm view commonswarm version` = 0.1.73 from 20:43:38Z |
| site | release 20260923T203921Z-06989e9c46a8, built with `PUBLIC_H0_LINK_JOIN=1` (the link-join stays on): `/download` shows 0.1.73 (0 mentions of 0.1.72); home 200, install.sh 200, 404 control 404, `/start` meta = api.commonswarm.com, no service_role key; the app still loads the link-join module |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.73; `npm i -g`: `/opt/homebrew/bin/cswarm` 0.1.73 |

## Not established

- Restarting the listeners that stopped in the outages: they belong to seats in workspace 292be0f9 (05f7ac37,
  a9c1a7fb, 214fa712, 023fd46b); the restart is the owning seats' (see the resume file).
- Long-lived processes of other seats keep 0.1.72 until their owners restart them.
