# Item G lane 2a — exact-review arm (Anthropic family, Claude Opus 5.5), round 1

Reviewed: `git diff b3e9eab3..3d09d409` in the detached worktree `scratchpad/arms-g2a` (HEAD verified
`3d09d40911ce401299ca2581e0baaca779a8356a`). Brief: `docs/design/2026-09-24-ITEM-G-LANE-2A-BRIEF.md`.
Record: `docs/evidence/2026-09-24-item-g-lane2a/LANE.md`.

What I ran (all loopback or local, temporary HOME under `opus-r1-probes/home`; no production host, no cswarm
command without a loopback `--url`, no model, no skill):

- The four changed test files directly (`tests/support/arrival-watch.test.ts`, `tests/p1-cli/resume.test.ts`,
  `tests/p1-cli/arrival-notify.test.ts`, `tests/p1-cli/citation-drift.test.ts`): 41/41 pass.
- `env -u FORCE_COLOR npm test` in the worktree: 977 tests, 967 pass, 10 fail. All 10 are host-stderr timing
  tests (`host-acp-{claude,codex,grok,opencode}` via `tests/support/host-stderr-exit-parity.ts`). The four
  host-acp files pass 84/84 alone on the lane tree, and the lane changes no file under `src/host` or
  `src/listener`. Not caused by this lane.
- `npm run build` (exit 0) then `npm run test:p1-cli`: see "p1-cli" at the end.
- `tests/p1-cli/timeout-table.test.ts` name-filtered to the read-only mapping tests: 3/3 pass.
- 10 mutations on an extracted copy of 3d09d409 (`opus-r1-probes/tree`, `mutate.sh`, logs `mut-*.log`).
- Real `/usr/sbin/lsof` shapes on this Mac (`opus-r1-probes/lsof-probe.mts`); every child I started was
  killed and `pgrep -lf "/bin/sleep 30"` was empty afterwards.

## Measured: real lsof shapes against the shared parser (`src/stdout-consumer.ts`)

| fd 1 of the probed process | lsof `-F pftan` | parser |
|---|---|---|
| libuv socketpair, peer live | `tunix`, `n->0x30df…` | live_reader |
| libuv socketpair, peer destroyed | `tunix`, `n->(none)` | orphaned |
| real PIPE, reader live | `tPIPE`, `n->0x5c10…` | cannot_determine |
| real PIPE, reader killed | `tPIPE`, `n` (empty) | cannot_determine |
| named unix socket, client side, peer live | `tunix`, `n->0x2683…` | live_reader |
| named unix socket, client side, parent's copy closed but a second holder alive | `tunix`, `n->0x2683…` | live_reader |
| named unix socket, client side, peer process gone | `tunix`, `n->(none)` | orphaned |
| named unix socket, accepted (server) side, peer live AND peer gone | `tunix`, `n/var/folders/…/s.sock` | cannot_determine |
| `/dev/null` | `tCHR` | not_pipe |
| regular file | `tREG` | not_pipe |
| nonexistent pid | lsof exit 1, no output | cannot_determine |

`lsof` took about 10 ms per call on this host (load average about 5). On this Mac, `->(none)` appeared only
when the peer was gone. I found no live-reader shape that the parser reads as `orphaned`, so the answer to
"could a live watcher be killed by a wrong orphaned" is **no for every shape I measured on Darwin**. A PIPE is
never proved (only the old EPIPE write path can end it). The accepted side of a named socket is never proved
either (it prints the path, not `->`). Linux was not measured (see Not established).

## Findings

### F1 — PRODUCTION: the "command that restarts it" cannot restart the watcher
`src/cloud/arrival-watch.ts:46`, `:49-51`; the same text at `src/resume.ts:518`.

```ts
export const NOTIFY_RESTART_COMMAND = `cswarm inbox --${NOTIFY_FLAG}`;
... Restart it under the session's Monitor with ${NOTIFY_RESTART_COMMAND}.
```

The brief (decision 2) requires "the command that restarts it". The printed command always fails. I ran it
with only a loopback target added (`inbox --notify --url http://127.0.0.1:9 --anon-key anon-x`, temporary HOME):

```
cswarm: inbox --notify is for one agent; provide its JSON credential with --agent-token-file or --agent-token-stdin
exit=1
```

`runInboxNotifyCommand` refuses to start without `--agent-token-file`, `--agent-token-stdin` or `--profile`
(`src/cli.ts` `hasAgentCredential`, `CREDENTIAL_FLAGS` at `:812`; the dispatch baseline runs notify as
`inbox --profile <PROFILE> --notify --json`). The watcher knows its own flags, but the sentence leaves out the
credential, profile, workspace and target. The command in resume's `Next:` line (`src/resume.ts:518`) is also
typed by hand ("then restart cswarm inbox --notify under the session's Monitor") rather than built from
`NOTIFY_RESTART_COMMAND`, so the two can drift. The control `tests/p1-cli/resume.test.ts:546-549` compares the
constant to its own definition (`NOTIFY_RESTART_COMMAND === \`cswarm inbox --${NOTIFY_FLAG}\``) plus one
literal regex. It pins the wrong claim, and it does not run the named command through the CLI parser. This
is the AGENTS.md "claim controls prove stability, not truth" case. Fix: build the restart command from the
watcher's own parsed selection (profile or credential path, workspace id, and a non-default `--url`), using the
same approach as `arrivalFullTextCommand` and resume's `restartCommand`. For `--agent-token-stdin`, name the
flag and not a secret. Add a control that runs the printed argv (with a loopback target) and requires that it
selects the notify variant and passes the credential check.

### F2 — RIGOUR: the shared lsof parser and the real parent adapter have no control
`src/stdout-consumer.ts:24-34`; `src/resume.ts:242-262`.

Neither the lane nor the earlier code tests `lsofStdoutConsumer` against lsof output, and no test exercises
`systemParentProcess` (the ppid test injects final states, not a process table). These mutations survive
every test in the four changed files plus `resume-process-table.test.ts`:

| mutation | result |
|---|---|
| m4: `if (type === "PIPE" \|\| type === "FIFO") return "orphaned"` | exit 0, 40/40 pass |
| m5: a unix socket with a path name (accepted side) → `"orphaned"` | exit 0, 40/40 pass |
| m8: `systemParentProcess` marks every parent as `parent_is_init` | exit 0, 15/15 pass |
| m9: `EPERM` from `kill(parent, 0)` → `parent_missing` | exit 0, 15/15 pass |

m4 is exactly the "PIPE" false-orphan that review question 1 asks about. With m4, every watcher whose stdout
is a pipe (`cswarm inbox --notify | tee …`, or any shell pipeline under a Monitor) would exit 74 at its first
idle check while its reader is alive, and no gate would notice. The brief asked for "an injected process table
with ppid 1, a dead parent, a live parent, and an unreadable parent". The test injects a `ParentProcessAdapter`
that returns those four answers, so the `ps -o ppid=` parse, the `parent <= 0` guard and the ESRCH
classification are never run. There is also no control that the lsof child is killed on cancel (drop
`signal` from the `execFile` options: nothing fails). Fix: split parsing into a pure
`parseLsofStdout(output)` and a pure ppid classifier, test them with the shapes in the table above (recorded
from this host), and inject the `ps`/`kill` pair.

### F3 — RIGOUR: an existing resume test now reads the host's process table
`tests/p1-cli/resume.test.ts:122-155` (the "resume pins each section…" test).

It injects `processTable` and `stdoutConsumer` but not `parentProcess`. `findNotifyWatchers` therefore runs the
real `ps -o ppid= -p 5101` and `-p 5102` (`src/resume.ts:305`). If pid 5101 is live on the host with ppid 1,
the Next line becomes `kill 5101 5102` and `assert.match(output, /CommonSwarm did not kill anything: kill 5102/)`
fails. On this Mac, 375 of 532 processes have ppid 1. I measured this with a live launchd child
(`opus-r1-probes/host-ppid-probe.mts`, pid 1113):

```
- PID 1113: stdout has a live pipe reader; ORPHAN: parent PID is 1; matched credential path.
Next: stop the orphan watchers; CommonSwarm did not kill anything: kill 1113 999990; then restart …
existing-test-style regex … matches: false
```

`resume-process-table.test.ts:109-114` also runs real `ps` for pids 4242 and 4243, but it asserts nothing that
depends on the result. Under a sandbox that denies `spawn` (the lane's own EPERM gate runs), every parent
comes back `cannot_determine`, which hides this. Fix: inject a fixed `parentProcess` in both tests.

### F4 — RIGOUR (decision set): ppid 1 overrides direct evidence of a live reader, and resume then says "kill"
`src/resume.ts:425-433`.

```ts
if (watcher.stdout === "orphaned" || watcher.parent === "parent_is_init" || watcher.parent === "parent_missing") {
  return "orphaned";
```

The brief asks for this ("orphaned also when its parent pid is 1"), and the lane implements it as written.
Together with keeping stdout as separate evidence, it produces the output shown in F3: one line says "stdout
has a live pipe reader" and the next says "kill" that pid. `ppid == 1` is a normal state for a live watcher
when PID 1 is the process that launched it: a container whose entrypoint shell or tini starts
`cswarm inbox --notify | reader`, or a launchd job on macOS. When stdout is proved `live_reader`, it is
stronger evidence than the parent. The lead should rule on whether `live_reader` + `parent_is_init` must say
"conflicting evidence, verify" instead of printing a `kill`. resume kills nothing, so this is advice, not an
automatic action. The notify self-exit path uses only lsof and is not affected.

### F5 — RIGOUR: an unknown parent downgrades a proven live watcher, and the Next line then says the stdout reader is unknown
`src/resume.ts:429-431`, `:520-523`.

With `stdout: "live_reader"` and `parent: "cannot_determine"` (for example `ps` is not on PATH, spawn is
denied, or `ps` fails), `watcherState` returns `cannot_determine` and resume prints
`Next: verify each unknown stdout reader in the host Monitor…`. The stdout reader is known. Measured with
`opus-r1-probes/parent-unknown-probe.mts`:

```
- PID 4321: stdout has a live pipe reader; parent process cannot be determined; matched credential path.
Next: verify each unknown stdout reader in the host Monitor before you start another watcher.
{"stdout":"live_reader","parent":"cannot_determine","state":"cannot_determine"}
```

The brief says an unreadable parent "stays `cannot_determine` for that check", which means the parent field,
not the whole watcher. Either keep `state` at the stdout result when only the parent is unknown, or change the
sentence so it names the evidence that is unknown.

### F6 — RIGOUR: an orphan in read-retry backoff is never checked
`src/cloud/arrival-watch.ts:775` (`await wait(delayMs);` in the catch path).

`inspectStdout` runs only in `idleWait` (`:609`) and in the wake loop (`:651`). While reads fail with a
retryable error (5xx, transport, 429, or a 401/403 that is not confirmed as a credential failure), the watcher
loops on backoff of up to `SIGNAL_FOLLOW_BACKOFF_MAX_MS` (30 s) and writes nothing. An orphan created during an
outage lives until reads succeed again. That is bounded by the outage and is not a regression. The brief says
"while `inbox --notify` waits with nothing to write", and LANE.md says "checks fd 1 while idle". Either run
`inspectStdout` before the backoff wait or name this gap in LANE.md.

### F7 — RIGOUR: the timeout-table citation leaves out the timeout line
`scripts/timeout-table/mapping.json:3229`: `"citation": "src/stdout-consumer.ts:10-17"`. The bounded option
`timeout: timeoutMs` is on line 18 (`{ encoding: "utf8", maxBuffer: …, timeout: timeoutMs, signal }`). Use
`:10-18`. No test checks this citation. The mapping tests pass (3/3).

### F8 — RIGOUR (nit): "one sentence" is two sentences
`src/cloud/arrival-watch.ts:50`: `…stopped because of SIGTERM; nothing is watching this inbox now. Restart it
under the session's Monitor with …`. The brief asks for one sentence. Folding this into the F1 fix costs
nothing.

## Checklist answers

1. **Idle closed-reader check.** It runs in the poll idle wait (`:599-615`) and while blocked on `wake.next`
   (`:648-660`, where the wait is split at `nextStdoutCheckAt`). The cadence is at most one check and at least
   one check per `IDLE_POLL_MAX_MS` (60 s) while idle. The first check runs at the first idle wait, and the
   next check time moves forward before the await (`:568`). The check never writes to stdout: the only child
   output is captured by `execFile`, the CLI test asserts `stdout === ""`, and the unit tests capture stderr.
   There is never more than one lsof child: each check is awaited in turn, and on timeout the callback waits
   for the child's `close`. The child is bounded by a timeout: `min(5000, interval/2)`, which is 5 s in
   production and 150 ms under the test knob. On cancel, the child gets the watch's `AbortSignal`. Exit 74
   comes only from `!cancelled() && state === "orphaned"` (`:575`). `NotifyStdoutClosedError` is not
   retryable (typed classifier, no message branch), and mutation m10 confirms it. `live_reader`, `not_pipe`,
   `cannot_determine` and a thrown error never exit and never log. The parser is shared, not copied: resume
   re-exports it from `src/stdout-consumer.ts`, and the CLI imports it from there. False orphan: none in any
   Darwin shape I measured, and a PIPE is never proved. But nothing guards this (F2).
2. **Signals.** SIGTERM gives 143 and SIGINT gives 130, measured by real children. The test derives the code
   as `128 + os.constants.signals[...]`. The codes come from one table, and a programmatic abort still returns
   `cancelled` with exit 0 (`src/cli.ts` comment at the `stopSignal` check). The sentence's command is wrong
   (F1). Callers that depend on exit 0 at SIGTERM: I searched every `--notify` occurrence in `src/`, `tests/`,
   `uxtest/`, `scripts/`, `npm/`, `install.sh`, `.claude/`, `.github/`, `site/src/` and `docs/` (72 evidence
   files included, searched for exit 0, SIGTERM, 143 and restart loops). The only dependents are the two
   `tests/p1-cli/arrival-notify.test.ts` controls, and the lane updated both. The listener
   (`src/listener/main-routing.ts:130`, attendance) reads only the lock, and the `finally` still releases it
   after a signal. The MCP server (`src/mcp`) and the hooks do not spawn notify. The command-dispatch baseline
   records notify exiting 1 at a fixture boundary, not at a signal. Brain topics live on the server and were
   not read (hard rule).
3. **resume ppid evidence.** All four states are covered by an injected adapter, the evidence is kept
   separately in JSON (`stdout`, `parent`, `state`), and the next-step line is present. But see F1 (restart
   command), F2 (the real adapter is untested), F3 (host-dependent test), F4 and F5.
4. **Controls fail on revert.** My mutations: m1 (no idle inspection) FAILS 1; m2 (no push inspection) FAILS 1;
   m3 (the CLI does not pass the consumer) FAILS 1; m6 (codes 0) FAILS 2; m7 (parent evidence ignored) FAILS 1;
   m10 (orphan on cannot_determine) FAILS 2. These match the LANE.md claims for the controls it names.
   Surviving mutations: m4, m5, m8, m9 (F2).
5. **LANE.md claims.** Each row matches the code. The mutation count is 10 as stated, and my reruns agree for
   the overlapping ones. My `npm test` run gave 967/10, against LANE's 966/11 (the lead's `gates-r1.log` also
   shows 967/10). The failing set is the same host-stderr timing family, so this is run-to-run variance and
   not a false claim. "enabled only for a loopback target": the code checks the hostname `127.0.0.1` only
   (not `localhost` or `::1`). That is stricter, so the claim holds. No new test file was added. Every modified
   test file is gated: `arrival-watch.test.ts`, `resume.test.ts` and `citation-drift.test.ts` are in the
   literal `npm test` list and/or the `test:p1-cli` glob, and `arrival-notify.test.ts` is in the
   `test:p1-cli` glob. Omission: LANE.md's "Not established" does not say that the idle check can prove an
   orphan only where lsof prints a `->` peer, which is Darwin. See below.

## Not established

- Linux. Node's stdio `pipe` is a socketpair there too. By reading the code: Linux `lsof` without `+E`
  prints no `->` peer for a unix socket, so the idle check can never return `orphaned` on Linux. It only
  spawns `lsof` once a minute and returns `cannot_determine`. That is safe (no false kill), but on Linux the
  lane does not fix the empty-inbox orphan. I did not measure it.
- The live Monitor control (the lead's) and a real Realtime socket in a child CLI.
- Whether any operator loop outside the repo (brain topics, cmux scripts) restarts only on exit 0.

## p1-cli

`npm run build` exit 0; `env -u FORCE_COLOR npm run test:p1-cli` exit 0: 944 tests, 944 pass, 0 fail, 0 cancelled (host `ps` available here, unlike the lane's sandbox, so its three EPERM failures do not reproduce). F3 did not fire on this run because pid 5101 was not live.

VERDICT: FAIL
