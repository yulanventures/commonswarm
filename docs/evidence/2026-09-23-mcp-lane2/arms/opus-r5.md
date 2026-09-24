# Checker review, round 5 (delta, Claude Opus arm): `lane/mcp-stdio` at `0a45e791`

## Scope and method

- **Range:** `git diff c32abeb5..0a45e791`, two lead commits:
  - `b52245b3`: the `rate_limited` sentence, and the LANE F4-3 correction;
  - `0a45e791`: the `profile_*` next steps, and a new test.
- **Copy under test:** a fresh `git archive 0a45e791` copy at `scratchpad/mcp/opus-probes/src0a4`, built first (`npm run build` exit 0). The stdio tests run `dist/`.
- **Mutations:** `opus-probes/mutate.sh`. Each mutant gets its own fresh archive and a rebuild.
- **Worktree:** `scratchpad/arms-mcp` still points at `c32abeb5`. I did not use or change it.
- **Safety:** loopback only. No model CLI. No process of mine remains.

## What changed

- **Changed files:** `src/mcp/errors.ts` (4 lines), `tests/p1-cli/mcp-stdio.test.ts` (+1 test, 1 pinned string), and `docs/evidence/2026-09-23-mcp-lane2/LANE.md` (the F4-3 row).
- **Code:** no other source changed. No other sentence, next step, or mapping branch changed.
- **Tests at `0a45e791`:** `mcp-stdio`, `signals`, `command-dispatch-baseline`, `signal-body` and `citation-drift` pass 54/54. That is 53 plus the new profile test.

## Claim 1: `rate_limited`

- **New sentence:** "The signal rate limit for this agent or its workspace was reached; it resets within an hour."
- **Next step (unchanged):** "wait, then retry the same call with the same request_id".
- **True against the edge.** `enforceSignalRate` (`supabase/functions/command/index.ts:5226-5262`) returns the same `429 rate_limited` for two buckets:
  - `signal:credential:<kind>:<credentialId>`, `SIGNAL_CREDENTIAL_LIMIT` = 120. This is "this agent".
  - `signal:workspace:<workspaceId>`, `SIGNAL_WORKSPACE_LIMIT` = 1000. This is "its workspace".
- **"Resets within an hour" is true.** The window is `date_trunc('hour', statement_timestamp())` and `resets_at = window_start + interval '1 hour'` (`:5100-5116`).
- **The retry step is true for both buckets.** A refused request stores no command result, so a later retry with the same id is judged afresh.
- **LANE F4-3** now states both limits with their constant names and quotes the retired sentence. That matches the repo rule on corrections.
- **Revert control (measured):** putting back "for this agent was reached" fails "MCP stdio edge refusal codes give exact post and read next steps" (1 fails / 20 pass).

## Claim 2: `profile_path_invalid`, `profile_symlink`, `profile_inside_repository` now use PERSON

- **New next step:** "a person must restore this agent's access outside this session".
- **True under the process model.** The profile path is set only by the process flag `--profile`. The brief's decision 2 keeps it out of every tool schema, so the model has no argument that could fix it.
- These codes reach a tool call only if the path check fails after start-up. `privatePath` runs again inside `checkAgentMessages` and `cachedAgentMessage` on each call. The fix, such as moving the profile or removing a symlink, happens outside the session and is done by the person who set up the server. So the step is true.
- **The new test** checks every table key that starts with `profile_` (9 today, asserted to be at least 8) and requires the next step to be anything but "fix the named argument".
- **Revert control (measured):** setting `profile_symlink` back to FIX fails the new test (1 fails / 20 pass).
- **Limit of the control:** it guards against FIX only. It does not pin PERSON. The exact choice between PERSON and another truthful step is not tested. That is acceptable for a claim-shaped guard.

## Is the round-4 FAIL resolved by this delta alone?

**Yes.** My round-4 verdict rested on one finding only: R4-1, the `rate_limited` clause "for this agent", which was false for the shared workspace bucket. `b52245b3` fixes the clause and its pinned test, and the revert control fails as expected.

The profile change resolves my round-4 note N-a, which did not block.

My other round-4 notes stay open and non-blocking:
- N-b: `message_not_cached` with FIX;
- N-c: `signal_refused` is a dead fake-edge code;
- N-d: the circular session-code coverage;
- N-e: `until` and `body` rules are stricter than the schema advertises.

Everything else that round 4 measured at `c32abeb5` is unchanged by this delta: the ruling fixes, the mutation controls, and probes P1–P11.

## Not established

- The Done-for-release-1 live items: production controls, the Claude Code and Codex transcripts, and npm.
- I did not re-run the full `npm test` or `test:p1-cli` for this delta.

VERDICT: PASS
