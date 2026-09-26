# Resume here: the home directory deletion on the Mac mini (2026-09-25)

Written by CSwarmDevLead for a cold successor. Read this before any lane work on the mini.

## What happened

- 10:57:58Z: the lead's Grok review arm for item M round 7 (grok 1.0.41, worktree `scratchpad/arms-m`, no
  permission mode, no sandbox) started a background shell task with, verbatim from `~/.grok/…/updates.jsonl`:
  `HOME="$(mktemp -d /tmp/item-m-r7-home.XXXXXX)" env -u FORCE_COLOR HOME="$HOME" node --import tsx --test
  tests/p1-cli/mcp-connect.test.ts tests/p1-cli/timeout-table.test.ts …` and then `rm -rf "$HOME"`.
- A prefix assignment applies to that one command only, and `"$HOME"` on the same line expands before it.
  The tests ran with the real home, and the last line was `rm -rf /Users/yulanbot`, which started at
  10:58:23Z.
- ~11:00Z: the lead found it with `ps` and killed it (pid 76155). It had run about 1.5 minutes.
- Root cause found by HezLead. The Opus arm, the Codex Makers, and the lane code are cleared.
- The macOS TCC log at 10:58:24Z attributes the `rm` (pid 76155) to the responsible process
  `com.anthropic.claude-code` pid 3713, the lead's Claude Code session, because the lead launched the Grok
  CLI from its Bash tool. Cause settled (HezLead).
- Host controls added by HezLead: an `rm` guard at `~/.local/bin/rm` (first in `PATH`) with refusals logged
  to `/Users/Shared/safe-rm.log`; hourly APFS local snapshots (`com.yulanbot.apfs-snapshot`); a Claude
  `PreToolUse` hook that blocks the pattern. Grok is signed out until the operator logs in again.

HezLead's incident report is outside this repository, at `Ridge.io/ops/incidents/2026-09-25-mini-home-deletion.md`
on the Mac mini. It names the lead as the launcher and the Grok arm as the actor, with the TCC line, and lists this
lane as a control.

## What was lost

`~/.config` (every cswarm seat credential, the anon key file, the `gh` login, alloy), `~/.cswarm` (every
profile), almost all of `~/Developer` (the main checkout and its `.git`, the prompteden checkout),
`~/.gbrain`, `~/.fusion`, the 1Password token file under `~/.hermes/secrets`, and the `claude`, `alloy`, and
`agy` CLIs. There was no Time Machine destination and no APFS snapshot. `~/.ssh`, `~/Library`, `~/.claude`,
`~/projects`, and `~/Documents` survived.

## What was saved

- `main` on GitHub was untouched (d437c291). HezLead re-cloned it to the old checkout path.
- The lanes whose commits were lost were rebuilt as single commits from their surviving worktree files:
  item M at acbaca57, item G lane 2b at f13a7b19, item F at 2d6734cd. Their per-fold history is lost; each
  `LANE.md` records it. They are in the verified bundle `/Users/Shared/cswarm-recovery/lanes-2026-09-25.bundle`
  until `gh auth login` lets the lead push them.
- The K Maker and the 2b fold 9 Maker were paused mid-work by HezLead (SIGSTOP). Their edits are in
  `scratchpad/wt-k` and `scratchpad/wt-g2b` and are snapshotted into the same bundle, uncommitted-state only.

## Standing orders (HezLead, until the operator approves the prevention plan)

No Grok CLI arm runs shell on the mini. No arm or Maker runs a test suite on the mini. No script contains
`rm -rf "$VAR"` where VAR can be HOME or empty. Reading, writing docs, and pushing are allowed.

## Prevention (this lane)

AGENTS.md "Sandbox and deletion rules" and `docs/design/LANE-BRIEF-TEMPLATE.md`. The lead's arm prompt
template line "pure tests with a temporary HOME" is retired: it is what produced the command.

## What is not established

Why the arm also ran background shell tasks with no permission mode; whether any earlier Grok arm's
temporary-HOME run wrote into the real `~/.cswarm` (HezLead is checking each session's `updates.jsonl`).

## Box windows moved (HezLead, 2026-09-25)

The item G lane 1 window (SHA 9627cb37) and the renewal-fix window (a54afaf6, its migration follows G's) move
from 2026-09-25 to **2026-09-26 21:45Z**, G first. Reasons: the G seed seats need `cswarm login` on the mini,
which was deleted, and the gate-evidence files were in the deleted checkout. Conditions: the operator's
`gh auth login` and `cswarm login`; the prevention and lane bundles pushed; gate evidence regenerated for
9627cb37 and a54afaf6 under `docs/evidence/2026-09-26-release-<12sha>/` (this needs the test hold lifted);
the operator mints the seed seats 20:00-21:30Z into `$HOME/.config/cswarm/g-seed-20260926` with the same
block as before. HezLead's Anvil prompts are ready and unchanged.

## Next

1. Operator: `gh auth login`; mint seat files for CSwarmDevLead (4989ea3b) and CSwarmStrategist (f5b46ef8)
   and the anon key file; reinstall `claude`, `alloy`, `agy`; approve the prevention plan.
2. Lead: push the bundle's branches; rerun every lost lane's gates in a sandbox before any review.
3. Item M and item G lane 2b both FAILED their last review round (M round 7: partial credential write,
   wrong chmod advice on a repo path, unreadable orphan judged after revoke; 2b round 7: printed commands
   that do not run). Neither is ready to land. The next folds are written in
   `scratchpad/itemM/fold7-*` and `scratchpad/itemG2b/fold9.md` and wait for clearance.

## State at 2026-09-26 04:30Z (lead; replaces the "Next" list above)

**Rules in force.**
- Every local gate runs through `scripts/run-gates.sh` (main `d77d1020`). The wrapper gives each gate a temporary HOME.
  It puts failing stand-ins for docker, docker-compose, orb, orbctl and supabase first on PATH, and lists every
  blocked call and skipped test as NOT RUN. Modes:
  - `gates`: static gates and `npm test`.
  - `site`: the site build only.
  - `cli-file`: one file; it refuses site and `*.observer.*` files.
  - `p1-cli`: HezLead's terms. The run starts only when memory pressure is level 1, OrbStack is off and no other
    wrapper run is active. A watchdog kills the run and fails it if OrbStack appears.
  - `server`: refused.
- No docker and no browser test on the mini (HezLead, 2026-09-26). The server suite runs in
  `.github/workflows/server-suite.yml` (suite `server`). Its `site` and `p1-cli` suites are not usable gates yet on
  ubuntu-latest: Chrome does not launch; the checkout is shallow; there is no keychain; p1-cli needs more than 30
  minutes. A follow-up task is filed. Dispatches this week: 5 of 20.
- The landing bar (brain `operating-model`): only verified, in-scope or lane-introduced PRODUCTION findings block.
- New Maker work runs as `alloy execute --route` from a clean clone, announced in CommonSwarm, with the wrapper as
  `--test`, and ends with `alloy integrate` (Tom via HezLead, 2026-09-26).

**Landed tonight.**

| Main SHA | What landed |
|---|---|
| `54900214` | The no-docker, no-browser gate wrapper and the workflow suite input. |
| `3ca16876` | The company address "Yulan Ventures, LLC, 1211 W 6th St, Ste #600-188, Austin, TX 78703" from `site/src/lib/company.ts`. HezLead sends it to Anvil for the site release. |
| `d77d1020` | The p1-cli wrapper mode. |
| `c29d4779` | Item M, crash-safe `cswarm mcp connect`. It is client only and ships with the next npm release. Evidence: `docs/evidence/2026-09-25-item-m/LANDING.md`. Follow-ups: brain `app-backlog` v37. |

**In flight.**
- **Item G lane 2b** (lane tip `511d7e22`, folds 17-19): rounds 17 and 18 PASS on both arms. Its merge with main
  conflicts in six files. That merge runs as Alloy task `ed2ca787509b481a` (Codex Maker, Grok Checker) in the clone
  `scratchpad/alloy-g2b`, on branch `land/g2b`. The branch has a local merge commit that holds the conflict markers
  and is never pushed. At landing, main gets one clean merge commit with the resolved tree. Then p1-cli mode, the
  server suite in Actions, and land.
- **Item K** (lane tip `a3f7bbd4`, fold 11): round 11 PASS on both arms. It merges main after 2b lands. The merge
  conflicts in six files and runs as the next Alloy task.
- **Item M fold 19** (`lane/item-m-fold19` at `c8b6f845`): a follow-up that needs its own review.
- **PR #27**: parked until Tom answers the Strategist. Tom's branch is untouched. The rebased content is on
  `lane/privacy-hosting-rebased` at `f71f5d70`, in the local repository only. Its patch lines are identical to #27.

**Known noise.** The ACP host timing tests and the resume `lsof` test fail under load and pass alone. A follow-up task
is filed. Each landing record lists the reruns alone.

**Box windows.** The item G lane 1 window (`9627cb37`) and then the renewal fix (`a54afaf6`) run at
2026-09-26 21:45Z (HezLead and Anvil). The gate-evidence files for both are in the main checkout under
`docs/evidence/2026-09-26-release-*`. They are untracked and mode 0600.
