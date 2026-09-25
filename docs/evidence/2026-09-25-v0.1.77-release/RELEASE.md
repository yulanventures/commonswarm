# cswarm 0.1.77 released (2026-09-25) — item J: invited, not connected

Carries item J (`docs/evidence/2026-09-24-item-j/LANDING.md`). Release notes: `NOTES.md` here (also on the GitHub
release). Built from main `4d4cb3f7` on branch `release/0.1.77`, **before** item G's client landed on main: item G's
server part is not on the box yet, so this CLI and site do not carry G. The branch was merged into main afterward
(`5e50fc28`).

## Chain (UTC)

| step | result |
|---|---|
| lane | item J merged to main 4ef0f300 (merge 3fe2b6db); final D-036 pair Opus PASS + Grok PASS |
| box, phase A (HezLead directs, Anvil applies) | 00:18Z: migration `20260924000001` applied (ledger 0 -> 1, catalog proof f -> t), functional proof `DO` (seeded row visible to a member, 0 rows without identity), cron unchanged, no stack switch. Two stops before any write: KIND_LIST `edge` must be `edge stack` for a migration release; a retyped section-5 block with `\\$` |
| box, phase B | first try ~00:22Z stopped on probe j2 (expected 401, got 400): the probe used the nil UUID, which fails the read edge's UUID check before the token check; edge rolled back to 1200ebb1 (healthy), migration kept. Retry 00:30Z PASS: edge `releases/4ef0f300...`, health ok, memory 2147483648, network commonswarm-net, loopback and staging probes a-h and j1-j5 as expected, metrics line present, log check clean. Evidence: `box/` (copied from Anvil's copy-back) and `box-notes-from-hezlead.md` |
| positive read | 00:31Z, landed bundle (sha256 prefix 53d90ef579d61528), `members --profile <lead seat> --json`: exit 0, stderr empty, `pending: []`, `pending_error: null` (`positive-read.json`). Before the box: `pending: null`, `pending_error: "could not load"` |
| bump | fa16765e `release: v0.1.77 — item J: invited, not connected` on `release/0.1.77` (`npm version --no-git-tag-version 0.1.77`) |
| gates (4d4cb3f7 + bump) | build 0; check:tests 0; check:edge 0; `scripts/build-release.sh` 0; `scripts/build-npm.sh` 0; site build 0; test:p1-cli 929/929; site test 573 pass (1 skipped); npm test 952/962 — the 10 failures are `host-acp-*` timing tests under parallel load, which pass 84/84 with `--test-concurrency=1` (filed as a separate task) |
| live control | artifact copied OUTSIDE the repository, sha256 `725636bf...` (rebuild reproduced the same digest): `--version` 0.1.77; `check --profile` exit 0; `members` shows "Invited, not connected: none yet" and a `pending` list; the item I control gave the same codes as for 0.1.75/0.1.76 (`profile_other_session`, `host_session_required`, the network-off control fails on the network, the other-session note is refused) |
| artifacts | 218cf921 `release: v0.1.77 build artifacts` on `release/0.1.77` |
| GitHub | `gh release create v0.1.77` at 00:33:05Z; tag v0.1.77 = 218cf921; assets `cswarm`, `cswarm.sha256` (checksum OK on a fresh download outside the repo; `--version` 0.1.77); Latest = v0.1.77. The first attempt with a 10-character `--target` was refused ("target_commitish is invalid") and created nothing |
| npm | `npm publish` after a dry run (commonswarm 0.1.77, 4 files, 580.7 kB); registry time 00:35:08Z; `latest` = 0.1.77 |
| site | release 20260925T003349Z-218cf921d07d-3a154c81c821946d from the release worktree, built with `PUBLIC_H0_LINK_JOIN=1`: home 200, install.sh 200, 404 control 404; `/download` shows 0.1.77 (0 mentions of 0.1.76); `/start` meta = api.commonswarm.com; service-role marker 0; `/app` contains "Invited, not connected" |
| main | `release/0.1.77` merged into main as 5e50fc28 |
| installs on the mini | public installer: `~/.local/bin/cswarm` 0.1.77; `npm i -g commonswarm@0.1.77`: `/opt/homebrew/bin/cswarm` 0.1.77 (the first npm install hit the CDN before it had the version; the retry passed) |

## Not established (the item J done-test)

- A person issues a code (`cswarm mcp code`) or adds an agent, sees "Invited, not connected" with its age in the app
  and in `cswarm members` within one minute, connects the agent, and sees the entry clear. It needs a signed-in person;
  no one is signed in with `cswarm login` on the mini. The positive read above shows only that the resource answers
  with an empty list for the hub workspace.

## Procedure notes for the next RELEASE-TO-BOX fold (from HezLead and Anvil)

1. Extract section blocks by line number; never retype them (a retyped block broke section 5 with `\\$`).
2. A migration release needs KIND_LIST `edge stack`, not `edge`.
3. Never use the nil UUID in probes; the edges' UUID check refuses it before the token check.
4. Pin a curl-like User-Agent in the Mac staging probe script (Python urllib's default got Cloudflare 1010).
5. After a rollback, the section-6 preflight is not a clean rerun: the override is already in NEW_EDGE and
   `sha256sum -c` ignores extra files; NEW_EDGE also had an extra `site/CLAUDE.md` outside the archive manifest.
6. The recycle block still has window-time placeholders.
