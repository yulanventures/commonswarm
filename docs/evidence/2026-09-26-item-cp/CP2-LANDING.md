# Item CP lane CP2: `cswarm login --provider`, Google by default (landed 2026-09-26)

Brief: `docs/design/2026-09-26-CP-CONSUMER-POSITIONING-BRIEF.md`, section CP2 (v4, brain `consumer-positioning` v2).

- Lane commit `a674f6a7` on `04f7813d` (Alloy task `66105014167c486b`: Codex Maker, Checker PASS), squashed and
  authored by the lead.
- `LOGIN_PROVIDERS = ["google", "github"]` drives the flag check, help and refusal. No flag opens Google;
  `--provider github` opens GitHub; nothing is stored. An unknown value exits 2 before any network call. README and
  the invitation message no longer tie CommonSwarm to a GitHub account.
- Landing fixes by the lead: `tests/p1-cli/citation-drift.test.ts` (seven `src/cli.ts` citations moved),
  `scripts/timeout-table/mapping.json` and `tests/p1-cli/timeout-table.test.ts` (the `HEAD` citations moved), and
  `tests/p1-cli/fixtures/command-dispatch-baseline.json` (the login help line and the login prompt now say Google;
  the two `accept` rows keep GitHub because `cswarm accept` still defaults to GitHub, `src/cloud/auth.ts:449-452`).

## Gates

One merged tree carried CP2 and G3a (`89a0d087` plus the fixes below), all through `scripts/run-gates.sh`:

| Gate | Result |
|---|---|
| `gates` (build, `npm test`, check:tests, check:edge, command-core, build-release, site build, diff check) | exit 0; `npm test` 1030 of 1030 |
| `p1-cli` (14:08:49Z; pressure 1; OrbStack off before and after) | 1258 of 1268 pass, 3 fail, 7 skipped (docker) |
| the 3 p1-cli failures | all citation drift from CP2's new `src/cli.ts` lines, in `tests/p1-cli/timeout-table.test.ts` |
| after the fix: `cli-file` timeout-table / citation-drift / command-dispatch-baseline / login-provider | 29/29, 5/5, 10/10, 4/4 |

The timeout mapping fix moves only the `HEAD` section of `scripts/timeout-table/mapping.json` (8 citations, mapped
line by line from a diff of `src/cli.ts`); the shipped `v0.1.71` section stays byte-identical, as its test requires.

## Not in 0.1.78

0.1.78 is built from `74804141`. CP2 rides the next npm release. Its live control is Tom's own login with each
provider; the first real Google round trip is still to be recorded.
