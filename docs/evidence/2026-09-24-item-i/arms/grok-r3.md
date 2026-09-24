I'll review lane item I at `2dbbfe23` against the fold-2 rulings and the earlier unbound-resume failure. No files will change. I'll start with the rulings, the round-2 notes, and both diffs.The lane is `2dbbfe23` on `0260ab8d`, with three commits after the failed round. Next I’ll read those diffs against the G1–G4 rulings.The human-session refusal is in place, and the fold-2 tests pass. The refusal sentence is still false for the three commands that print it.

## Findings

### 1. RIGOUR — `session enable|disable|recover --profile` says `session` accepts `--profile`

`src/cli.ts:763` builds the refusal from the verb list:

```763:763:src/cli.ts
      throw new AgentSetupError("profile_command_invalid", `--profile is supported by: ${AGENT_PROFILE_COMMANDS.join(", ")}.`);
```

That list is every root with `profileListOrder` (`src/cli.ts:9575-9582`). The `session` group still has `profileListOrder: 14` (`src/cli.ts:9461`) even though enable, disable, and recover are `REFUSE_PROFILE` (`src/cli.ts:9455-9458`).

Measured stderr for `session enable --profile` (same for disable and recover), pinned at `tests/p1-cli/fixtures/command-dispatch-baseline.json:13892`:

```text
cswarm: --profile is supported by: whoami, resume, working-on, note, ask, reply, receipt, feed, inbox, brain, file, members, feedback, listen, session, channel.
```

`session start`, `status`, and `stop` do accept `--profile`. `session enable`, `disable`, and `recover` refuse it, and this is the sentence those three print. `human session lifecycle refuses agent credentials before human login` only checks that the line matches `/--profile is supported by:/` (`tests/p1-cli/item-i-profile-binding.test.ts:254`), so it stays green while the verb is listed. The baseline now records the false sentence as the expected text.

The refusal still happens before `humanCredential`. No agent flag reaches the stored human login.

## Checks that hold

- **G1.** `runSession` for enable, disable, and recover uses the `0260ab8d` shape (`src/cli.ts:7445-7450`): no credential flags, no `host-session-id`. `expandAgentProfile` throws on `--profile` before `readAgentProfile`. `--agent-token-file` and `--agent-token-stdin` die in `assertShape` before `humanCredential` (`src/cli.ts:7452`). `runHumanSessionLifecycle` has that one caller. The group refusal policy is only for an unknown sub-action. Re-adding `CREDENTIAL_FLAGS` to the shape, or switching those three rows back to expand, fails `human session lifecycle refuses agent credentials before human login`.
- **G2.** Unbound resume uses `profile.host_session_id ?? binding?.host_session_id` (`src/onboarding-cli.ts:279`). With no `host_session_id` key that is the `0260ab8d` argument, and `turnCheckInstruction` is unchanged. The new test covers session B on an unbound receive binding and session A on a bound profile. Dropping the `??` fallback removes `--host-session-id 'session-B'`.
- **G3.** `requireProfileWithHostSessionId` (`src/cli.ts:808-811`) runs in `runListenStart`, `runListenStatusOrStop`, `runListenCanary`, and `session status|stop`. `hadProfileOption` is taken at parse time, before expansion deletes `--profile`. `session start` still requires the id on its own. The six-row test fails if the guard is removed. The dispatch rows for those commands with both flags reach the handler (`--wait` / `session_context_missing` / `not_found`), so a guard that also rejected a real `--profile` would fail the baseline.
- **G4.** A non-`AgentSetupError` keeps its object and gets the step on `error.message` (`src/onboarding-cli.ts:170-172`). The renewal test’s stderr contains “stopped renewing the credential” and the operator step, and does not start with `cswarm:`, which is the `RenewalReauthorisationRequired` branch at `src/cli.ts:9786-9793`. Wrapping that error in `new Error` fails the test. Argument errors are outside the try (`src/onboarding-cli.ts:156-159`); `setup argument errors are the caller's to fix` expects `--connection-file is required` with no operator step.
- **Lead fixes.** The guide says “The CLI reads no environment variable for the session id” (`src/cloud/agent-onboarding-contract.ts:44`). `command-table-gates` passes. Citation lines 6368, 6394, and 7030 match. The normalizer only rewrites `"profile_id": "<24 hex>"` and `/state/<64 hex>` (`tests/p1-cli/command-dispatch-baseline.test.ts:678-679`). Those are the origin hash and `listenerInstanceKey` of that hash plus the printed workspace and principal. A fresh baseline run passed. `workspace_id` and `principal_id` stay in the JSON.
- **Openers.** Every `readAgentProfile` call passes the presented id, and `readAgentProfile` calls `requireProfileHost` before return (`src/cloud/agent-profile.ts:178`). Setup’s raw existence read is followed by that call.
- **LANE.md, the brief, and SKILL.md.** Fold 2’s 39 rows, the six usage refusals, the resume ids, and the renewal class match the tests. The brief’s “cswarm reads no environment variable for the session id” is the behavior claim. The live guide uses the gate-safe wording. SKILL.md’s bound-profile commands match flags the table actually accepts.

Item I, command-table gates, and citation-drift passed (30 tests; the hook case failed only while `FORCE_COLOR` was set, and passed with it unset). The dispatch baseline passed (1261 rows).

VERDICT: FAIL
