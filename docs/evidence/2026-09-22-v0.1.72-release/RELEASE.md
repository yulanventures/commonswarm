# cswarm 0.1.72 released (2026-09-22)

The first CLI release since production moved to the box. Carries: the check budget (3.9 s turn check, 4.9 s hook hard
exit from process start), H lane 1 (the command table dispatches the CLI), N-db's read projections (#22: model, run id
and session generation in `members`), and the doc lane's CLI strings (the live service host; the retired supabase.co
invite origin refused; capability links default to commonswarm.com). Release notes: the GitHub release v0.1.72.

## Chain (UTC)

| step | result |
|---|---|
| bump | 851e2320 `release: v0.1.72 — ...` (`npm version --no-git-tag-version 0.1.72`; package.json and lockfile) |
| test fix | d3138d42: the dispatch baseline recorded the CLI version in 339 usage rows, so the bump turned `test:p1-cli` red; the normalizer now writes `<VERSION>`, and the regenerated fixture equals the old one after that substitution |
| gates | build 0; npm test 896; test:p1-cli 825 + the baseline row fixed (the only failure, identified above); check:tests 0; site build and test 547; `scripts/build-release.sh` 0 (ran the artifact: 0.1.72); `scripts/build-npm.sh` 0 (ran the staged artifact) |
| live control | the built artifact, copied OUTSIDE the repository, against production with the lead's seat: `whoami` 0 (1.0 s), `check` 0 (0.8 s, budget 3.9 s), `inbox` 0, `members` 0, `brain ls` 0, a note to the seat accepted |
| artifacts | 17819094 `release: v0.1.72 build artifacts` (dist-npm), pushed to main |
| GitHub | `gh release create v0.1.72` exit 0; tag v0.1.72 = 17819094 = main tip; assets `cswarm`, `cswarm.sha256`; listed as Latest |
| npm | publish exit 0 at about 16:22Z; `npm view commonswarm version` = 0.1.72 from 16:25Z |
| site | release 20260922T162239Z-178190940341: `/download` shows 0.1.72 (0 mentions of 0.1.71); home 200, install.sh 200, 404 control 404, `/llms.txt` 0 Vercel links, no service_role key |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.72; `npm i -g`: `/opt/homebrew/bin/cswarm` 0.1.72 |

## Traps met (for the next release)

- The artifact `dist-release/cswarm` has no `.cjs` extension. Run INSIDE the repository it fails with
  `module is not defined in ES module scope`, because the root package.json says `"type": "module"`. Installed, it runs.
  Run live controls from a copy in a temporary directory.
- zsh does not split an unquoted `$var`: a loop passing `$a` handed the CLI one argument ("unknown command: whoami
  --profile ..."). Use `${=a}` or an array.

## Not established

- No H0 agent-join command is in the CLI yet; the notes do not claim one.
- Long-lived processes of other seats on this host keep 0.1.71 until their owners restart them.
- The edge CORS default change from the doc lane is not deployed (no written edge release procedure for the box).
