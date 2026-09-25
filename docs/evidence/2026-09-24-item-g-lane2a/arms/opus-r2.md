# Item G lane 2a — exact-review arm (Anthropic family, Claude Opus 5.5), round 2

Reviewed: `git diff 3d09d409..5071a703` closely and `git diff b3e9eab3..5071a703` for the whole lane. The
detached worktree `scratchpad/arms-g2a` was at HEAD `5071a703140c597b87d5589d0f3d73f4b6dc7c6b` and stayed clean.
Brief: `docs/design/2026-09-24-ITEM-G-LANE-2A-BRIEF.md`. Fold rulings: `itemG2a/fold1.md`. Record:
`docs/evidence/2026-09-24-item-g-lane2a/LANE.md` ("Fold 1").

What I ran: everything was loopback or local, with a temporary HOME under `opus-r2-probes/home`. I contacted no
production host, ran no cswarm command without a loopback `--url`, and started no model or skill.

- `npm run build`: exit 0. The five changed test files together: 54/54 pass.
- 23 mutations on an extracted copy of 5071a703 (`opus-r2-probes/tree`, `mutate.sh`, with a 60 s process-group
  watchdog; logs `mut-*.log`, summary `mutations.txt`). The tree was restored and diffed as pristine afterwards.
- `restart-probe.mts` (output in `restart-probe.out`): real CLI children against a loopback fake read service. Each
  child is started in one way and gets SIGTERM. The printed restart command then runs through `/bin/sh`, with a
  `cswarm` wrapper on PATH, and must make a new read.
- `lsof-probe.mts` (from round 1) against the new `parseLsofStdout`.
- `env -u FORCE_COLOR npm test`, `npm run test:p1-cli`, `npm run check:tests`, and the host-acp files alone.
- Afterwards: no probe, CLI child, `sleep`, or test runner of mine was alive (`ps` filtered on my paths was empty).

## Measured

### F1: the printed restart command (restart-probe.out)

| How the watcher started | exit on SIGTERM | printed command run by `/bin/sh` | secret printed |
|---|---|---|---|
| `--agent-token-file <abs> --url --anon-key --workspace-id --json` | 143 | makes a new read, exit 143 on SIGTERM; **`--json` is missing** | no |
| `--agent-token-stdin` (credential piped) + explicit target | 143 | not run (it needs stdin); the sentence names `--agent-token-stdin … with the same credential input on stdin` | no |
| `--profile <abs profile>` | 143 | makes a new read; prints the expanded `--agent-token-file <profile dir>/credential.json --workspace-id … --url … --anon-key anon-prof` | no (the anon key is public) |
| path with a space, `'`, `$HOME` and a backtick | 143 | makes a new read; the quoting holds under `/bin/sh` | no |
| relative `--agent-token-file agent.json`, restart from the same cwd | 143 | makes a new read | no |
| relative `--agent-token-file agent.json`, restart from another cwd | 143 | **fails**: `[agent_token_file_unreadable] … credential directory must be mode 0700 (found 755): .` | no |
| default target (no `--url`) | not run: that would contact commonswarm.com | by reading the code, the command carries no `--url` and resolves the same default in the same environment | — |

The lane test `the printed restart command starts a watcher against the same loopback read service` does run the
printed command through `/bin/sh` and requires a second read. Its `includes("--url …")` and
`includes("--workspace-id")` assertions run before the spawn, so a regression that drops `--url` cannot reach
production from the test.

### Mutations (all 23 against 5071a703, all five changed test files)

| id | mutation | result |
|---|---|---|
| m1 | no inspection in `waitWithStdoutChecks` (idle and retry) | FAIL 2 (+2 unit tests hang to their 5 s limit) |
| m2 | no inspection in the push wait | FAIL 1 |
| m3 | the CLI passes no `stdoutConsumer` | FAIL 3 |
| m4 | PIPE/FIFO → `orphaned` | FAIL 1 (lsof fixtures) — survived in round 1 |
| m5 | unix socket with a path name → `orphaned` | FAIL 1 — survived in round 1 |
| m6 | exit codes 0 | FAIL 3 |
| m7 | parent evidence ignored | FAIL 1 |
| m8 | `ps` parser always init | FAIL 1 — survived in round 1 |
| m9 | EPERM → `parent_missing` | FAIL 1 — survived in round 1 |
| m10 | any non-`live_reader` → exit | FAIL 3 |
| n1 | retry backoff uses the plain `wait` | FAIL 1 |
| n2 | restart command = the constant only | FAIL 2 |
| n3 | no shell quoting | FAIL 2 |
| n4 | CLI drops `anonKey` from the restart options | FAIL 6 |
| n5 | parent-first state order (round-1 code) | FAIL 2 |
| n6 | `->(none)` checked before a live peer | FAIL 1 |
| n7 | resume Next line typed by hand | FAIL 1 |
| n8 | unknown-evidence sentence always says "stdout reader" | FAIL 1 |
| **n9** | **drop `signal` from the lsof `execFile` options** | **exit 0, 54/54 pass (survives)** |
| n10 | CLI drops `workspaceId` | FAIL 6 |
| n11 | drop the stdin suffix | FAIL 1 |
| n12 | `ORPHAN:` prefix even with a live reader | FAIL 1 |
| n13 | EPERM → `cannot_determine` | FAIL 1 |

### Real lsof shapes (lsof-probe.out)

These match round 1 exactly: socketpair live → `live_reader`, peer closed → `orphaned`, PIPE live or closed →
`cannot_determine`, named-socket server side → `cannot_determine`, client side with its peer gone → `orphaned`,
`/dev/null` and REG → `not_pipe`, nonexistent pid → `cannot_determine`. Real output also has an `a` (access) line.
The recorded fixtures leave it out, but the parser reads only the `t` and `n` lines, so this changes nothing.

### Gates

| Gate | Exit | Count |
|---|---:|---|
| `npm run build` | 0 | — |
| `env -u FORCE_COLOR npm test` | 1 | 984 tests, 973 pass, 11 fail. All 11 are `host-acp-*` stderr-timing tests. Those files pass 91/91 alone on this tree, and the lane changes nothing under `src/host` or `src/listener`. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 951/951 (host `ps` is available here, so the lane's three sandbox EPERM failures do not occur) |
| `npm run check:tests` | 0 | — |

## Checklist

1. **F1.** The printed command is runnable for the token file, explicit target, `--profile`, and odd-path cases,
   and it prints no credential contents (measured above). The stdin case names the flag, not the secret. The test
   runs the printed command. Gaps: findings 1–3.
2. **F2.** `waitWithStdoutChecks` (`src/cloud/arrival-watch.ts:626-638`) now serves both idle and retry backoff
   (`:806`). It shares `nextStdoutCheckAt`, so the cadence stays at one check per `stdoutCheckIntervalMs` (60 s in
   production) across idle and retry waits. Checks are awaited in turn, so there is never a second lsof. Cancel
   ends the loop (`while (!cancelled())`, and `wait` resolves on abort). A proven orphan during backoff throws out of
   the `catch` block, so `runArrivalWatch` rejects instead of returning `{reason: "error"}`. The CLI maps both
   forms to 74 (`src/cli.ts:9831`), and the retry test measures 74. The only uncontrolled part is n9 (finding 4).
3. **F3.** `watcherState` (`src/resume.ts:450-455`): proven `live_reader`/`orphaned` wins, and parent evidence
   decides only for `cannot_determine`/`not_pipe`. EPERM is `parent_alive` (`:250-257`). JSON keeps `stdout`,
   `parent`, and `state`. The Next line names only the unknown evidence (`:545-551`). Nine combinations are
   tested, and n5, n8, n12 and n13 fail as they should.
4. **F4–F6.** The parser tests use recorded shapes (with the `a` line left out; this does not matter). Every
   round-1 survivor (m4, m5, m8, m9) now fails. Both resume tests that used fake pids inject `parentProcess`
   (`tests/p1-cli/resume.test.ts:186`, `tests/p1-cli/resume-process-table.test.ts:114`). No remaining test calls
   `inspectResume`/`findNotifyWatchers` without an adapter. The citation `src/stdout-consumer.ts:24-32` contains
   `timeout: timeoutMs` at line 32, and a test resolves it. The signal message is one sentence.
5. **Round-1 checks still hold.** Idle (m1), push (m2), codes 130/143 (m6), only a proven orphan exits (m10), and
   the retry test asserts `stdout === ""` (no keepalive write).
6. **LANE.md and gates.** The Fold 1 rows match the code and my mutation results. My `npm test` count (984/973/11)
   equals the Fold 1 gate row. Every changed test file is gated: `arrival-watch`, `resume`, `citation-drift` and
   `resume-process-table` are in the literal `npm test` list, and all four `tests/p1-cli/` files are in the
   `test:p1-cli` glob. `arrival-notify.test.ts` is only in the glob, as LANE says. Doc gaps: findings 5 and 6.

## Findings

### 1 — RIGOUR: the restart command drops `--json` (and `--session-context`, `--force-file-store`)
`src/cli.ts:4762-4768`.

```ts
const restartOptions: NotifyRestartOptions = {
  ...(args.has("agent-token-file") ? { agentTokenFile: … } : {}),
  ...(args.has("agent-token-stdin") ? { agentTokenStdin: true } : {}),
  ...(args.has("workspace-id") ? …), ...(args.has("url") ? …), ...(args.has("anon-key") ? …),
};
```

The notify shape accepts `[...TARGET_FLAGS, "workspace-id", ...CREDENTIAL_FLAGS, "notify", "json",
...SESSION_CONTEXT_FLAGS]` (`src/cli.ts:4551-4558`). The usage line documents `[--json]` (`:873`), and the dispatch
baseline runs `inbox … --notify --json`. Measured: a watcher started with `--json` printed a restart without
`--json`. Its restart emits readable lines instead of JSON lines, so it is not "the command that restarts it"
(brief decision 2; ruling F1: "from the flags this watcher was actually started with"). The flag list is typed by
hand beside the shape list it copies, which is the drift that AGENTS.md "An enumeration inside a message must be
generated" describes. No repo code parses notify JSON, so nothing in the repo breaks. Fix: add `json` and
`session-context` (and `force-file-store`) to `NotifyRestartOptions`, or derive them from the notify shape list, and
extend the `/bin/sh` restart test to start with `--json` and require that the restarted child's first line is JSON.

### 2 — RIGOUR (low): a relative `--agent-token-file` is printed as given
`src/cli.ts:4763`, `src/cloud/arrival-watch.ts:64`. Measured: started with `--agent-token-file agent.json`, the
restart works from the same cwd but fails from another one (`[agent_token_file_unreadable] … (found 755): .`). A
Monitor usually restarts in the same cwd. `resolve()` the path before printing it costs nothing.

### 3 — RIGOUR (low): a `--profile` watcher prints the expanded flags, not `--profile <path>`
`src/cli.ts:4762-4768` (after `expandAgentProfile`, `src/cli.ts:763-786`). Measured: the printed command is runnable
and names the profile's credential path, URL, and anon key. The anon key is public, so no secret leaks. It differs
from ruling F1 ("`--url … --anon-key …` only when the run passed them explicitly"). It also drops the profile's
host-session binding and the `--session-context` that the expansion pushed. `Arguments.hadProfileOption` is already
recorded, and printing `cswarm inbox --profile <path> --notify` (plus `--host-session-id` when given) would keep the
original selection.

### 4 — RIGOUR (low, carried from round 1 F2): no control that cancel kills the lsof child
`src/stdout-consumer.ts:32` (`{ …, timeout: timeoutMs, signal }`). Mutation n9 removes `signal`: 54/54 still pass.
Without it, a SIGTERM that lands during an inspection waits for lsof. That is about 10 ms here and at most 5 s (the
timeout), so the stop is delayed, not lost. LANE.md does not name this.

### 5 — RIGOUR (doc): the round-1 "Parent orphan evidence" row is now false and is not marked superseded
`docs/evidence/2026-09-24-item-g-lane2a/LANE.md:12`: "marks ppid 1 or a missing parent as orphaned". After Fold 1
F3, a watcher with a proven `live_reader` and ppid 1 is `live_reader` and gets no `kill`. The Fold 1 section states
the new rule, but a reader of the decisions table meets the retired rule with no marker. Per AGENTS.md
("Corrections go in the artifact"), mark the row "superseded by Fold 1 F3" and keep the old wording.

### 6 — RIGOUR (nit): "11 targeted probes" against 12 listed reverted behaviours
`LANE.md:53` says "Each of the 11 targeted probes", but the Fold 1 table lists 12 reverted behaviours. EPERM →
missing appears under both F3 and F4, so this is probably one probe counted twice. Say so, or list 12.

No PRODUCTION finding. Every round-1 PRODUCTION item is fixed and measured: the restart command runs through
`/bin/sh` for every start method I could run on loopback, and the retry backoff checks stdout (n1 fails without it).
Every round-1 RIGOUR item is fixed, except the cancel control (finding 4), which round 1 mentioned only in passing.

## Not established

- Linux lsof output (unchanged from round 1; LANE.md now names it).
- The default-target restart, because running it would contact commonswarm.com. It was checked by reading the code
  only.
- The `--agent-token-stdin` restart through a shell with real stdin: I checked only the sentence.
- A live Monitor, a real Realtime socket in a child CLI, and any restart loop outside the repo that keys on exit 0.

VERDICT: PASS
