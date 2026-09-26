# T2 result: the Claude Code channel wakes an idle session (2026-09-26)

Written by CSwarmDevLead. Procedure: `docs/design/2026-09-26-T2-CLAUDE-CHANNEL-PROOF-BRIEF.md` (v2). No code changed.

## Answer

- **Yes, the channel wakes an idle terminal Claude Code session.** The notice reached the idle session about 1.0 s
  after the ask was created, and the model started a turn about 3.2 s later.
- **No, the model did not check or reply through CommonSwarm.** It printed an ACK line in the terminal only. It
  called no tool: no `cswarm_received`, no `cswarm check`. The sender saw no reply, and the receipt stayed
  `working` with `outcome: null`.
- **Because nothing acknowledged the delivery, the ask came back.** When the 15-minute lease ended, the service
  delivered the same ask again, and the idle session woke again with the same terminal-only ACK.
- **Negative control passed.** With the session still open and only the receiver stopped, a second ask was never
  delivered and the session showed nothing.

The channel server already tells the model what to do. Its MCP `instructions` (`src/cloud/agent-channel.ts:163`)
say to confirm each event with `cswarm_received` and to answer with `cswarm reply`. The notice itself carries only
the signal body and ids (`src/cloud/agent-channel.ts:282-284`). The model followed the body ("reply with the word
ACK …") and ignored the server instructions.

What this means for item G: the wake path works; the notice does not yet make the model acknowledge and answer.
The notice text must itself lead the model to call `cswarm_received` and to reply.

## Set-up

| Item | Value |
|---|---|
| Claude Code | 2.1.281, model `claude-haiku-4-5` (restarted from Opus to save budget; the model is recorded, not a variable under test) |
| cswarm | 0.1.77 (protocol 0.1.0), `/opt/homebrew/bin/cswarm` |
| Workspace | Cold Agent Test `c2ea0541-f56d-4c73-bf71-56c5405c4934` |
| Channel seat | `t2-channel`, principal `0e1e2dcc-9d43-4da3-ae27-f17a53cfdb5a` |
| Sender seat | `t2-sender`, principal `a0445659-e41d-44b1-9280-61f8e50a9d05` |
| Scratch directory | `/private/tmp/t2-20260926` (0700, not a repository) |
| Host session | `b48db8c6-3aba-40f0-9f83-ca0c0a64c086` (the real session id, read from Claude's project directory) |

Commands (paths shortened; `<P>` is the channel seat's `profile.json`, `<S>` the session id):

```sh
cswarm receive configure --profile <P> --mode wake --provider claude --host-session-id <S> \
  --cwd /private/tmp/t2-20260926 --preview-channel --json
# printed start command, run from the scratch directory, plus --model:
claude --resume <S> --mcp-config <channel-profile>/claude-channel-<scope>.json \
  --dangerously-load-development-channels server:cswarm --model claude-haiku-4-5
cswarm ask --to 0e1e2dcc-9d43-4da3-ae27-f17a53cfdb5a "T2 probe: reply with the word ACK and the current UTC time."
```

Claude asked once to confirm the development channel; it was confirmed once.

State before the ask (from `cswarm receive status --json` after one benign turn at 11:41Z): requested `wake`,
effective `turn`, turn check verified, `channel_running: true`, `wake_verified: false`. The product's own canary,
`cswarm receive test`, was not run; configure's `next_action` asks for it. The session was idle from 11:41:15Z to
11:46:57Z.

## Events (UTC)

Ask `b812fe09-1cbf-4ffd-887e-af64e9f65d40`, from `t2-sender` to `t2-channel`.

| # | Event | Time | Observed |
|---|---|---|---|
| — | ask `created_at` | 11:46:57.478 | |
| — | `delivered_at` | 11:46:58.269 | `leased_until` 12:01:58.269 (15 min), attempt 1 |
| a | channel notice in the idle session | 11:46:58.47 | transcript entry `<channel source="cswarm" signal_id=… receipt=… sender_id=…>`, about 1.0 s after the ask |
| b | model starts a turn | 11:47:01.72 | assistant text `ACK 2026-09-26T11:46:57Z`, terminal only |
| c | `cswarm_received` or `cswarm check` | — | none; no tool call of any kind |
| d | tool-approval prompt | — | none |
| e | reply through CommonSwarm | — | none |
| f | sender `cswarm receipt --json` (~11:48) | — | `state: working`, `outcome: null`, `acked_at: null` |

### Lease expiry and redelivery

| Time | Observed |
|---|---|
| 12:01:58.27 | lease ends with no ACK |
| 12:01:59.5 | same ask delivered again, new receipt `fb8f6d14-eb0a-4a39-ae35-cca2285dc8f1` |
| 12:01:59.51 | channel entry in the same idle session |
| 12:02:01.99 | model prints `ACK 2026-09-26T11:46:57Z` again, terminal only, no tool call |
| 12:02:42 | receipt: `working`, `outcome: null`, `acked_at: null`, `leased_until` 12:16:59 |

Without a `cswarm_received` ACK, an ask returns every 15 minutes and wakes the session each time.

## Negative control

Host session still open and idle. Only the receiver was stopped: the `cswarm receive serve` child of the session
(pid 94698) was killed, and `receive status` then showed no live channel.

| Time | Observed |
|---|---|
| 12:03:23 | second ask `e1b5e472…` sent to `t2-channel` |
| 12:08 | 0 new transcript entries in the session; receipt `not_delivered`, `attempt_count: 0` |

Claude did not restart the server by itself.

## Not established

- Whether a different model (for example Opus or Sonnet) calls `cswarm_received` or replies on its own. Only Haiku
  4.5 was measured.
- Whether running `cswarm receive test` first changes the model's behavior.
- Whether the Claude desktop app's Code tab can load a development channel. Not measured. Claude Code's channel
  documentation (https://code.claude.com/docs/en/channels.md) describes only the terminal flags
  (`--channels`, `--dangerously-load-development-channels`) and the organization switch `channelsEnabled`; the
  desktop documentation does not mention channels. The expected answer stays "no".

## Cleanup

After this record was written (12:11Z), the scratch directory with its `.claude/settings.local.json`, the channel
config, the receive binding and journal, and the seed directory with its credential copies were removed. Anvil
revoked both test seats with Tom's human session at about 12:14Z (`cswarm principal revoke`, exit 0 for each). The
first ask was still `working` at 12:11Z (attempt 2, lease until 12:16:59) and had no live receiver after that.
