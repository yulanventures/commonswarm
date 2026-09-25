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

## Next

1. Operator: `gh auth login`; mint seat files for CSwarmDevLead (4989ea3b) and CSwarmStrategist (f5b46ef8)
   and the anon key file; reinstall `claude`, `alloy`, `agy`; approve the prevention plan.
2. Lead: push the bundle's branches; rerun every lost lane's gates in a sandbox before any review.
3. Item M and item G lane 2b both FAILED their last review round (M round 7: partial credential write,
   wrong chmod advice on a repo path, unreadable orphan judged after revoke; 2b round 7: printed commands
   that do not run). Neither is ready to land. The next folds are written in
   `scratchpad/itemM/fold7-*` and `scratchpad/itemG2b/fold9.md` and wait for clearance.
