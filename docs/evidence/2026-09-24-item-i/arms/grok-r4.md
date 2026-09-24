I'll review only the diff from `2dbbfe23` to `25ac71b1`, derive the profile-support sentence from the command table, and check the H1 and H2 claims without changing anything.The diff touches four files. Next I’ll read the command table and the profile-refusal path so the new sentence can be checked against every command.The command table and the refusal sentence are in place. I’ll derive the accepting set independently and check the baseline diff row by row.The profile sentence and the workspace-id refusal match the command table. The p1-cli derivation gate still expects the bare verb `session`, so that suite fails.

**RIGOUR** — `tests/p1-cli/command-table-gates.test.ts:245`

`AGENT_PROFILE_COMMANDS is derived from table order data` still builds one verb per `profileListOrder` root and expects `session`. The producer at `src/cli.ts:9575` now emits `session start`, `session status`, and `session stop`. `npm run test:p1-cli` globs this file (`package.json:25`). The file run here was 10 passed and this test failed. The assertion diff is those three pairs against `session`.

The other checks hold.

The sentence from the table is `whoami, resume, working-on, note, ask, reply, receipt, feed, inbox, brain, file, members, feedback, listen, session start, session status, session stop, channel`. Every listed root accepts `--profile` on every subcommand (`brain`, `file`, `listen`, `channel`). The three session pairs accept. `session enable`, `session disable`, and `session recover` refuse and are absent. No `profileListOrder` command is missing or falsely covered. `mcp`, `setup`, `check`, and the six `receive` actions also accept `--profile`; they have no `profileListOrder`, which is the same boundary as `2dbbfe23`.

`tests/p1-cli/item-i-profile-binding.test.ts:264` builds its expected list from that table. `deepEqual` at line 274 fails if the producer returns bare `session`. The loop at line 279 fails as well, because not every `session` subcommand accepts the flag.

Without `--profile`, `session status` and `session stop` omit `workspace-id` (`src/cli.ts:7485`, `src/cli.ts:7521`), so `assertShape` throws `unknown option: --workspace-id` (`src/cli.ts:799`), the same refusal as `0260ab8d`. With `--profile`, `hadProfileOption` stays set after expansion (`src/cli.ts:721`, `src/cli.ts:779`) and the injected `workspace-id` is allowed. The focused test at `tests/p1-cli/item-i-profile-binding.test.ts:295` checks both refusals, the no-profile credential error, and the profile path reaching `--session-context is required`.

Of 1,261 baseline rows, 273 changed: 213 `refusal`, 39 `policy`, 21 `selected-error`. Each change is only `stderr`, and each is one replacement of `listen, session, channel.` with `listen, session start, session status, session stop, channel.`. The `session.status` and `session.stop` rows are unchanged. `command-dispatch-baseline-counts.json` is identical. The diff is those four files.

VERDICT: FAIL
