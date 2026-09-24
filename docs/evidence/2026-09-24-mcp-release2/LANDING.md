# MCP release 2 landing: an operator-run connect code (2026-09-24)

Branch `lane/mcp-connect` from main `86a938f3`, tip `094d9563`, merged with `git merge --no-ff`. Spec:
`docs/design/2026-09-24-MCP-RELEASE-2-BRIEF.md`, option A, ruled by the Strategist on 2026-09-24 with three conditions
(connect refuses to run without a TTY; the code is single-use; the printed lines name the profile path only). The
Maker's record, fold by fold, is `LANE.md` here. Design input: `docs/evidence/2026-09-24-h-release2-design/`.

## What it does

- `cswarm mcp code` (a person, signed in with the human credential; refuses `--profile` and agent credentials before
  any request) mints the existing H0 join credential with `seat_cap` 1 and `ttl_hours` 1, prints the code once with
  its expiry, and prints the exact connect line to run on the agent's host (`--url` and the public `--anon-key`; no
  secret in it).
- `cswarm mcp connect --url <url> [--anon-key <key>] [--profile <path>]` (a person, in their own terminal on the
  agent's host):
  - refuses before the prompt: a non-terminal stdin (a pipe, `/dev/null`, closed stdin), an occupied or unsafe profile
    path, a missing anon key;
  - reads the code at a hidden prompt (echo off, restored on every exit path including Ctrl-C and SIGTERM); an empty
    line or Ctrl-D exits 1;
  - calls `h0/register` exactly once with a fresh `attemptId`, no retry, no redirect;
  - writes an UNBOUND profile (0600 files, 0700 directory) and prints only `Profile: <path>` and the Claude Code and
    Codex install lines.
- The code or the seat token never reaches stdout, stderr, an error, argv, the environment, or any file but the 0600
  `credential.json`. The general option parser no longer echoes an option's value (`--code=<secret>` shows `--code`).
- Refusals say only what the server proves: codes returned before any seat logic say "this attempt created no seat"
  with their own next step; the three codes the server returns only after a seat exists (`join_credential_seat_cap_reached`,
  `registration_token_already_used`, `registration_seat_revoked`) say the code was already used and to tell the
  operator to revoke that agent. Both sets are generated from the server source. Every failure after the request was
  sent that is not such a typed refusal (network, 5xx, bad body, any save failure, a lost race) says the seat may
  have been created and the operator must revoke it.
- The connect prompt and the setup guide describe the MCP path; the setup-file and H0-paste paths say that their secret
  passes through the model.
- `cswarm mcp --profile P` serves exactly as in 0.1.75 (item I binding included). No server, edge or migration change.

## What it does not stop

- A process of the same OS user can allocate a pseudo-terminal (`script`) and pass the TTY check. What keeps the code
  out of a model turn is that `mcp code` shows it only to the person who ran it.
- An agent on a host where a person's human login is stored could run `cswarm mcp code` itself (as for every
  human-credential command).
- Ctrl-C while the register request is in flight exits 130 with no message; a seat may exist (crash safety is item M).

## Review (D-036)

Maker: Codex gpt-6-sol (a direct `codex exec` lane; `alloy execute` was blocked by retained-task capacity). Lead fix:
`da5fa657` (the Strategist's conditions: path-only output, piped-code refusal). Checker: Claude Opus 5.5. Second arm:
Grok 4.7. Reviews and prompts: `arms/`.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | da5fa657 | FAIL (stranded seat without revoke advice; site tests; TTY claim; redirects; Ctrl-D) | FAIL (`--code=` echo; save failure without revoke advice) |
| 2 | f8328f83 | FAIL (path-dependent SHA test; "not used" false for seat-exists codes; timeout alias) | FAIL (same "not used" claim) |
| 3 | 057c79cb | FAIL (`forbidden` can follow a redeemed code) | FAIL (same, plus prompt meaning, Ctrl-C directory, citation) |
| 4 | 094d9563 | PASS | PASS |

Opus round 1 records one discovery request to the public site `commonswarm.com` (a probe ran `mcp code` without
`--url`; no login or credential was in its temporary home). Rounds 2-4 used loopback targets only.

## Gates on the merged tree (lead, 21398b74)

build 0; npm test 962/962; test:p1-cli 922/922; check:tests 0; check:edge 0; test:p1-server 242/242 (the first run had
one failure in tests/p1-server/command.test.ts, "durable-delivery: wrong principal/lease, revoked token,
delivery_unavailable non-enumeration", a rate-limit timing assertion (200 where 429 was expected); the file passed
72/72 twice on the merged tree and 72/72 on main 86a938f3, and the full suite rerun passed 242/242); build-release 0;
site build 0; site test 569 pass, 1 skipped; diff-check 0.

## Not established

- The production done-test: a live `mcp code` + `mcp connect`, then fresh Codex and Claude Code sessions using only the
  MCP tools, with transcripts free of `swm_join_` / `swm_agt_`. No person is signed in on the mini, so the lead cannot
  mint a code; the Claude Code run also needs `claude` signed in. Item H stays OPEN until this passes.
- That an H0 seat works on the read edge and posts through MCP on production (never run before).
- That `cswarm principal revoke` works on an H0 seat (the revoke advice depends on it).
- Whether the 10 s register timeout is enough on production.
