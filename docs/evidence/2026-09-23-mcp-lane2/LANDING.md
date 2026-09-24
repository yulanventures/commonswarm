# MCP lane 2 landing: `cswarm mcp` over stdio, release 1 (2026-09-24)

Branch `lane/mcp-stdio` from main `adef94b4`, tip `0a45e791`, merged with `git merge --no-ff`. The specification is
`docs/design/2026-09-23-MCP-LANE-2-BRIEF.md` (with dated corrections from fold 1). The Maker's record, fold by fold,
with every mutation control, is `LANE.md` here.

## What it does

`cswarm mcp --profile <path> [--host-session-id <id>]` is one long-lived MCP server over stdio. It serves one seat in
one workspace with seven tools: `whoami`, `check`, `ask`, `note`, `reply`, `working_on`, `members`.

- The profile and host session are process flags only. No tool argument carries a profile, token, file, URL or flag;
  a deny-set gate checks the advertised schemas, and each denied key sent through `tools/call` gets `-32602`.
- Tools call library functions in process. stdout carries JSON-RPC only, from spawn to exit.
- Arguments and results are allow-lists, with limits from the constants the code enforces. Results have a 32 KiB cap.
  A capped `check` returns fewer messages and moves the cursor only to the last message the model received.
- `request_id` is the signal's `command_id`: a retry with the same id returns the same signal; the same id with new
  arguments gets `command_id_conflict` (409) and the step "stop". A failure after the request left returns
  `{outcome: "unknown", retry_with_same_request_id: true}`. A cancelled call gets no response (MCP spec).
- The `check` cursor moves only after the response is written, and only forward. `check {message_id}` re-reads one
  cached message.
- Errors come from one MCP-owned table keyed by class or stable code (D-053). No producer message, shell command,
  flag or path reaches the model. Each code has a next step that is true for it (fix the named argument; retry; wait
  and retry; restart the server with the current host session; a person must act).

## Review (D-036)

Maker: Codex gpt-6-sol (lane, folds 1, 2, 4). Lead fixes: `d7c17124`, `b52245b3`, `0a45e791` (text and tests).
Checker: Claude Opus 5.5. Second arm: Grok. All reviews and prompts are in `arms/`.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | 064a1cdd | FAIL (shell text to the model, `replayed` from memory, response after cancel, ...) | FAIL |
| 2 | 8321eae3 | FAIL (post `forbidden` told the model a person must restore access) | FAIL (same) |
| 3 | d7c17124 | PASS | FAIL (the `forbidden` sentence read as a permission) |
| 4 | c32abeb5 | FAIL (`rate_limited` named only the agent limit) | PASS |
| 5 | 0a45e791 | PASS (delta) | PASS (delta) |

Note: the fold 1 prompt (`arms/prompt-maker-fold1.txt`) lost three backticked words to an unquoted heredoc (`replayed`
twice in R3, `to` in R9). The Maker implemented the intent (both reviews checked it).

## Production control (the box, `api.commonswarm.com`, seat CSwarmDevLead)

`production-control/control.mjs` drives the shipped release bundle, copied outside the repo, with the SDK stdio
client. Logs: `control-c32abeb5.log` and `control-0a45e791.log` (bundle sha256 prefix `23c0f6ff8801358c`).
Every tool answered; a replay with the same `request_id` returned the same signal; a reply to an unknown signal got
the post `forbidden` sentence (403); the same id with new arguments got `command_id_conflict` (409); a `profile`
argument got `-32602`; `check` returned the posts and `check {message_id}` returned the cached one; server stderr was
empty. Signals went to the seat itself only, plus one `working_on`.

## Live hosts

- Codex 0.156.0 (`codex exec`, `mcp_servers.cswarm` with `default_tools_approval_mode = "approve"` for this server
  only; shell approval and the sandbox unchanged): whoami, check, note to self, reply, check on production, no shell
  command. Transcript excerpt: `production-control/codex-host-run.txt`. No token, profile path or `cswarm` command
  text appears in it. Without the approval setting, `codex exec` refuses every MCP call ("approval policy is never").
- Claude Code 2.1.280: the server connected and Claude Code listed all seven tools, but the run stopped before any
  model turn: "OAuth session expired and could not be refreshed". NOT ESTABLISHED; it needs a signed-in `claude`.

## Gates at 0a45e791 (lead, outside the sandbox)

build 0; npm test 962/962; test:p1-cli 876/876; check:tests 0; check:edge 0; build-release 0; bundle `mcp --help` from
a directory outside the repo 0; diff-check 0.

## Not established

- The Claude Code live run (above).
- A managed seat whose session context is on another host (detection is local only; `LANE.md`).
- `rate_limited` and the four session-proof codes on production (fake-edge tests only).
- npm publication (release step).
