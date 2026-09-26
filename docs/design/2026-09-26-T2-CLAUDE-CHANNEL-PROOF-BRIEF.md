# T2 brief: prove that the Claude Code channel wakes an idle session (2026-09-26, v2 after Codex review)

Written by CSwarmDevLead. Source: hub brain `tincan-learnings` v1, item T2 (operator ruling 2026-09-26, option A).
Nothing ships from this item. The deliverable is a measured record, and the record informs item G.

## Question

CommonSwarm has `cswarm receive serve`, the Claude Code channel (`src/cloud/agent-channel.ts`, since 2026-09-08). The
server declares `experimental: { "claude/channel": {} }` (`agent-channel.ts:162`) and sends
`notifications/claude/channel` (`:282`). No one has proved that a directed ask reaches an IDLE terminal Claude Code
session through it, or that the model then checks and replies.

## Set-up (from the code)

- `cswarm receive configure --profile <P> --mode wake --provider claude --host-session-id <S> --preview-channel`
  (`src/cloud/agent-receive.ts:220-270`) does three things:
  - it installs the turn hooks;
  - it writes `claude-channel-<scope>.json`, which runs `cswarm receive serve --profile <P> --host-session-id <S>`;
  - it prints the start command
    `claude --resume <S> --mcp-config <config> --dangerously-load-development-channels server:cswarm`.
- Claude asks once to approve the development channel.
- `--preview-channel` is the consent flag. Without it, configure refuses with `wake_preview_consent_required`.

## Seats and safety

Two NEW test seats in Cold Agent Test (`c2ea0541-f56d-4c73-bf71-56c5405c4934`), never a working seat:

- `t2-channel-<date>` receives. It is the channel seat.
- `t2-sender-<date>` sends the one directed ask.

Tom mints them with the same block form as G's and 2b's windows: `cswarm principal create` and `cswarm token mint`,
6-hour tokens, a 0700 directory with 0600 files, and only `OK` printed. The lead builds each seat's `profile.json` and
`credential.json` the same way `deploy/release-proofs/item-g/g-seed.sh` does.

The Claude Code session runs in a scratch directory under `/tmp`, never in a repository. It has no tools approved
beyond Claude Code's defaults. The only task it gets is the one directed ask.

## Procedure

Every command below runs with the scratch directory `T2D=/tmp/t2-<date>` (created fresh, 0700), never a repository.
`receive configure` writes `.claude/settings.local.json` into the directory named by `--cwd` and accepts hooks only
from that directory (`src/cloud/agent-receive.ts:176`, `:231`); Claude runs from that same resolved directory.

1. Tom: `claude auth login` on the mini (today `claude auth status` reports `loggedIn: false`), and the seat block
   (two seats). The lead builds `profile.json` + `credential.json` for each seat in `$HOME/.config/cswarm/t2-seed-<date>/`
   the way `g-seed.sh` does.
2. The lead starts `claude` in a terminal tab from `$T2D` and sends one trivial prompt, so the session exists; the
   lead reads its real session id `S` from that session (the JSONL file name under Claude's project directory for
   `$T2D`), then exits. `S` is never a synthetic name.
3. `cswarm receive configure --profile <channel profile> --mode wake --provider claude --host-session-id S
   --cwd "$T2D" --preview-channel`; record the printed start command.
4. Run the start command from `$T2D` (`claude --resume S --mcp-config <config> --dangerously-load-development-channels
   server:cswarm`). Approve the channel prompt (Tom presses the key if needed).
5. Make the channel eligible: the channel waits for a matching host hook AFTER `receive serve` starts
   (`src/cloud/agent-channel.ts:225`). Send ONE benign turn ("reply ok"), then verify from `cswarm receive status
   --profile <channel profile> --host-session-id S --json` that the binding shows this session, the turn hooks, and a
   running channel with a fresh heartbeat. Only then leave the session IDLE for at least 5 minutes.
6. From the sender seat: `cswarm ask --to <channel seat> "T2 probe: reply with the word ACK and the current UTC time."`
   Record the ask id and `created_at`.
7. Record each event separately, with times (they are different events; one does not imply another):
   - (a) the channel notice appears in the idle session (terminal and the session's JSONL);
   - (b) the model starts a turn;
   - (c) the model calls `cswarm_received` (the channel ACK, `src/cloud/agent-channel.ts:172`) or `cswarm check`;
   - (d) a tool-approval prompt blocks it (record which);
   - (e) the model replies (reply `created_at`);
   - (f) the sender's `cswarm receipt --json` for the ask: `state` and `outcome`.
8. Negative control with the host session still OPEN and idle: stop only the receiver (the `cswarm receive serve`
   child process of that session, by its pid from `receive status`), confirm `receive status` no longer shows a live
   channel, send a second ask, wait 5 minutes, and record that the session shows nothing and the receipt stays
   `state: "not_delivered"`, `outcome: null` (`src/cloud/receipts.ts:62`, `:265`). If Claude restarts the server by
   itself, record that instead: it is a finding.
9. Cleanup, scratch-scoped, after the evidence is saved: exit `claude`; remove `$T2D` (including its
   `.claude/settings.local.json`); remove the channel config `claude-channel-*.json`, the receive binding and its
   journal next to the channel profile, and the seed copies of the credentials; Tom revokes both seats. There is no
   `receive remove` command, so each path is named and removed explicitly.

## Record

`docs/evidence/2026-09-26-t2-claude-channel/`: the times for (a)-(f), the negative control, the exact commands, and the
Claude Code and cswarm versions. No token, no raw JSONL, no transcript beyond the probe text and the reply. Result lines
go to brain `tincan-learnings` and to item G.

## Not in scope

No code change. If the channel does NOT wake an idle session, the record says what was observed, and the fix
becomes a G item with its own brief.
