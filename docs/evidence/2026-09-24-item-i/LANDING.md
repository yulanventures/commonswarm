# Item I landing: a profile is bound to the host session that ran setup (2026-09-24)

Branch `lane/item-i` from main `0260ab8d`, tip `1f4ffb73`, merged with `git merge --no-ff`. Spec:
`docs/design/2026-09-24-ITEM-I-PROFILE-SESSION-BINDING-BRIEF.md` (with a dated fold-1 correction). The Maker's record,
fold by fold, with every mutation control, is `LANE.md` here. Design input: `docs/evidence/2026-09-24-item-i-design/`.

## What it does

- `cswarm setup --connection-file <file> --host-session-id <id>` writes `host_session_id` into the profile. `manual`
  writes no binding. Setup with no `--host-session-id` is refused (`setup_host_session_required`) and names both forms.
  Setup reports `host_session_bound`. Setup cannot rebind a bound profile; it can bind an unbound one (the owner has the
  connection file).
- Every command that opens a bound profile checks the presented id in `readAgentProfile` (`requireProfileHost`) before
  the credential, the message cache, any lock, or the network:
  - a different id: `profile_other_session`, "This profile belongs to another session. Stop and tell the operator.";
  - no id: `host_session_required`, "This profile is bound to a host session. Pass --host-session-id with this session's id."
- The turn hook: when its stdin `session_id` differs from the session it was configured for, it exits silently, as
  before (the hook file is per project, so other sessions in the folder run it too). Only then does it check the binding.
- Every command the CLI prints for a bound profile carries `--host-session-id`; unbound output is unchanged. The setup
  guide, `SKILL.md` and the connect prompt show the setup command per host (Claude Code `"$CLAUDE_CODE_SESSION_ID"`,
  Codex `"$CODEX_THREAD_ID"`, expanded by the agent's own shell). The CLI reads no environment variable for the session id.
- `session enable|disable|recover` stay human-only: they refuse `--profile` and agent credentials.
- An unbound profile (every profile written before this release, and `manual`) behaves as before. An older CLI refuses a
  bound profile as damaged (it cannot skip the check). No server change.

## What it does not stop

A process of the same OS user that reads or edits the profile and replays the id. Unbound profiles.

## Review (D-036)

Makers: Codex gpt-6-sol (the lane and folds 1-2 through `alloy execute`; fold 3 as a direct `codex exec` lane, because
Alloy's retained-task capacity was full). Grok 4.7 as the routed Maker stalled twice without edits. Lead fixes: baseline
coverage and normaliser, usage errors, citation and guide drift, the order test. Checker: Claude Opus 5.5. Second arm:
Grok 4.7. Reviews and prompts: `arms/`.

| Round | SHA | Opus | Grok |
|---|---|---|---|
| 1 | 5fe61316 | FAIL (hook noise for other sessions; listen/session rows rejected the id) | FAIL (receive configure code) |
| 2 | 4cbe7d01 | FAIL (session enable/disable/recover accepted agent credentials) | FAIL (unbound resume) |
| 3 | 2dbbfe23 | PASS (2 minor) | FAIL (refusal list named `session`) |
| 4 | 25ac71b1 | FAIL (order test red) | FAIL (same) |
| 5 | dc834c50 | PASS | FAIL (order test too weak) |
| 6 | 1f4ffb73 | PASS | PASS |

The Opus arm contacted the public site `commonswarm.com` once in round 3 (a probe ran `cswarm session enable` without
`--url`, so the CLI resolved its own target), with no login or credential in its temporary home. Recorded in `arms/opus-r3.md`.

## Production control (the box, seat CSwarmDevLead, a copy of its profile bound to a fake session A)

`production-control/control.sh` with the release build copied outside the repo (`control-04c120ef.log`, sha256 prefix
`bf48407dc26a6ad9`; earlier runs on 2dbbfe23 and bc1781b0 gave the same results): session A read production (exit 0);
session B and no id, with outbound network blocked by `sandbox-exec`, got `profile_other_session` and
`host_session_required`; control: session A with the network blocked failed on the network, so the block works;
`note` from session B was refused with the exact sentence. The copy was removed. The seat's real profile was not changed.

## Gates on the merged tree (lead)

bc1781b0: build 0; npm test 962/962; test:p1-cli 896/896; check:tests 0; check:edge 0; test:p1-server 242/242;
build-release 0; site build 0; site test 567 pass, 1 skipped; diff-check 0. 04c120ef (adds one test commit): build 0;
npm test 962/962; test:p1-cli 896/896; check:tests 0; build-release 0; diff-check 0.

## Not established

- Whether `CLAUDE_CODE_SESSION_ID` and `CODEX_THREAD_ID` equal the ids hosts put on hook stdin, and what happens after
  `/clear` or resume.
- Whether a static MCP host config can pass a per-session id (for example Claude Code expanding
  `${CLAUDE_CODE_SESSION_ID}` in args).
- A real `cswarm setup` binding on production (the production control bound a copy by writing the field; setup's binding
  is covered by tests).
- Follow-up filed: the "--profile is supported by" list omits `mcp`, `setup`, `check` and `receive` (true since 0260ab8d).
