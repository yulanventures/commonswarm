# Item G lane 2a: exact-review arm (Anthropic family, Claude Opus 5.5), round 3

Reviewed: `git diff 5071a703..700f2927` closely and `git diff b3e9eab3..700f2927` for the whole lane. The
detached worktree `scratchpad/arms-g2a` was at `700f2927` and stayed clean. `git status --short` was empty at the
end. Fold rulings H1-H5 are in `itemG2a/fold2.md`. The record is `docs/evidence/2026-09-24-item-g-lane2a/LANE.md`
("Fold 2").

What I ran: all loopback or local work, with a temporary HOME under `opus-r3-probes/home` or per-run temporary
directories. I contacted no production host. Every cswarm child had a loopback `--url` or a profile whose `url` was
loopback. I started no model and used no skill.

- `npm run build`: exit 0.
- `restart-probe.mts` → `restart-probe.out`: real CLI children against a loopback fake read service. Each child
  starts in one way and gets SIGTERM. I extract the printed command with the lane's own regex,
  `with (cswarm inbox --notify .*)\.$`. `/bin/sh` then runs it **from a different cwd**, with a `cswarm` wrapper on
  PATH, and it must make a new read.
- `lsof-probe.mts` → `lsof-probe.out`: real lsof shapes, rerun against `700f2927`.
- 30 mutations on an extracted copy of `700f2927` (`run-mutations.sh`, `mutate.sh`, a 60 s process-group watchdog,
  logs `mut-*.log`, summary `mutations.txt`). The positive control ran on the same five files first: 60/60 pass
  (`positive.log`). Afterwards the tree was diffed against a fresh `git archive 700f2927`, with no difference.
- Gates, with HOME set to the temporary home and `FORCE_COLOR` unset: `npm test`, `npm run test:p1-cli`,
  `npm run check:tests` (`gates.txt`).
- Afterwards, `ps` filtered on `opus-r3-probes` or `arms-g2a` was empty. No probe, CLI child, `sleep`, or test
  runner of mine is alive.

## Measured

### Restart command (restart-probe.out). The restart always runs from `<root>/elsewhere`, not the start cwd.

| Start form | exit on SIGTERM | printed command (last in sentence?) | `/bin/sh` restart from another cwd | token printed |
|---|---|---|---|---|
| `--json --force-file-store --agent-token-file <abs> --url --anon-key --workspace-id` | 143 | `cswarm inbox --notify --json --force-file-store --agent-token-file … --url … --anon-key anon-x --workspace-id …` (yes) | new read, 143, prints the identical command | no |
| `--agent-token-stdin` + explicit target, credential piped | 143 | `…; pipe the same credential on stdin, then restart it … with cswarm inbox --notify --agent-token-stdin --url … --anon-key … --workspace-id ….` (yes) | with the credential piped: new read, 143 | no |
| relative `--agent-token-file agent.json` | 143 | path printed as `<root>/agent.json` (yes) | new read, 143 | no |
| `--profile <abs>` | 143 | `cswarm inbox --notify --profile <root>/prof/profile.json` (yes) | new read, 143 | no |
| `--profile <abs bound profile> --host-session-id host-sess-1` | 143 | `… --profile <root>/prof/bound.json --host-session-id host-sess-1` (yes) | new read, 143 | no |
| **`--profile '~/hp/profile.json'` (literal tilde, no shell expansion)** | 143 | **`--profile '<root>/~/hp/profile.json'`** | **fails, exit 1: `The agent profile is missing.`** | no |
| path with space, `'`, `"`, `$HOME`, backtick | 143 | single-quoted correctly (yes) | new read, 143 | no |
| relative `--session-context ctx/session.json` | n/a: the CLI refuses it at start (`[session_context_path_not_absolute]`) | — | — | no |
| default target (no `--url`) | not run: that would need env targeting or contact commonswarm.com | code reading: agent mode never falls back to discovery (`src/cli.ts:1102-1108`), and the argv replay prints no `--url` | — | — |

### Mutations: all 30 against 700f2927, on the five lane test files

Every mutation applied, and every one ended with exit 1. Positive control: 60/60.

| id | mutation | failing tests |
|---|---|---|
| m1 | no inspection in `waitWithStdoutChecks` | 2 (+ hangs to 60 s) |
| m2 | no inspection in the push wait | 1 |
| m3 | CLI passes no `stdoutConsumer` | 2 |
| m4 / m5 / n6 | PIPE → orphan / unix path → orphan / `->(none)` checked first | 1 each (lsof fixtures) |
| m6 | exit codes 0 | 6 |
| m7 / n5 / n12 | parent ignored / parent-first order / `ORPHAN:` prefix always | 1 / 2 / 1 |
| m9 / n13 | EPERM → missing / EPERM → unknown | 1 each |
| m10 | any non-`live_reader` → exit 74 | 3 |
| n1 | retry backoff uses plain `wait` | 1 |
| h1 | stdin instruction after the command (round-2 form) | 2 (incl. the `/bin/sh` stdin test) |
| h1b | stdin instruction removed | 2 |
| h2a | hand-typed subset restored in `notifyRestartOptions` | 8 |
| h2b / h2c / h2d / h2f | drop `json` / `session-context` / `force-file-store` / `host-session-id` from replay | 3 / 2 / 2 / 1 |
| h2e | profile replaced by its expanded flags | 1 (`/bin/sh` profile test) |
| h3 | no `resolve()` | 2 |
| h3b | resolve only `agent-token-file` | 1 |
| h4 | drop `signal` from lsof `execFile` (**survived in round 2**) | 1 (`cancelling an in-flight stdout inspection kills its lsof child`) |
| h5a / h5b | remove the superseded marker / write the count as 11 | 1 each |
| n2 / n3 | restart = constant only / no shell quoting | 5 / 1 |
| n14 | replay drops the first parsed option | 1 |

### Real lsof shapes (lsof-probe.out)

These are unchanged from rounds 1-2: socketpair live → `live_reader`, peer closed → `orphaned`, PIPE (live or
closed) → `cannot_determine`, named-socket server side → `cannot_determine`, client side with its peer gone →
`orphaned`, `/dev/null` and REG → `not_pipe`, nonexistent pid → `cannot_determine`.

### Gates (gates.txt)

| Gate | Exit | Count |
|---|---:|---|
| `npm run build` | 0 | — |
| `env -u FORCE_COLOR npm test` | 0 | 990 tests, 990 pass |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 957 tests, 957 pass |
| `npm run check:tests` | 0 | — |

The totals match LANE.md Fold 2 (990 and 957). The lane's 2 and 3 failures were sandbox `ps` `spawn EPERM`. They do
not occur on this host, which has `ps`. I did not run `check:edge`, `build:command-core`, `build-release.sh`, the site
build, or `git diff --check origin/main...HEAD`: I am read-only, and the lane changes nothing under `supabase/` or
`site/`. `git diff --check b3e9eab3..700f2927` exits 0.

## Checklist

1. **H1-H3.** For every start form the CLI accepts and that I could run on loopback, the command is the last thing
   in the sentence. It runs through `/bin/sh` from another directory and prints no agent token. The stdin form
   is fixed: the Grok round-2 PRODUCTION finding reproduces as fixed, and h1/h1b fail without the fix. The replay
   is built from the parser's own data. `Arguments` records `{name, value}` exactly where it calls `push` in the
   constructor (`src/cli.ts:697-700`, `:725-728`), before `expandAgentProfile`. `NOTIFY_ACCEPTED_FLAGS`
   (`src/cli.ts:834-836`) is now the same constant that `assertShape` reads (`src/cli.ts:4573-4574`), so the
   per-flag test enumerates the enforcement list. **Unsafe replay:** notify accepts only
   `NOTIFY_ACCEPTED_FLAGS` plus `--profile`/`--host-session-id` through expansion. No accepted flag takes a secret
   by value: the credential comes from a file path or stdin, and the anon key is public. The replay can therefore
   add nothing that `ps` does not already show. Repeated value flags cannot reach the print, because `optional()`
   throws "may only be provided once" first. A repeated boolean is replayed as given, which is harmless. The one
   gap is the path resolution rule: finding 1.
2. **H4.** Fixed. h4 (the round-2 survivor n9) now fails the new test at 639 ms. The test uses a fixture
   executable (`src/stdout-consumer.ts:24-27`). The production default stays `/usr/sbin/lsof` on darwin. **H5.**
   `LANE.md:12` is marked "(superseded by Fold 1 F3)" and keeps the old wording. `LANE.md:53` reconciles 12 listed
   with 11 unique probes. `citation-drift.test.ts` derives the count from the table, and h5a/h5b fail.
3. **Rounds 1-2 hold.** Idle (m1), push (m2), retry backoff (n1), exit 74 only for a proven orphan (m10), 130/143
   (m6), stdout-first evidence order (n5, n12), EPERM → alive (m9, n13), and the parser fixtures (m4, m5, n6). All
   fail on revert. The lsof shapes are unchanged.
4. **Controls and gates.** All 30 mutations fail. `resume.test.ts`, `citation-drift.test.ts`, and
   `resume-process-table.test.ts` are in the literal `npm test` list. All `tests/p1-cli` files are in the
   `test:p1-cli` glob, and `arrival-notify.test.ts` is only there, as LANE.md says. `arrival-watch.test.ts` is
   unchanged in Fold 2 and is in `npm test`. The Fold 2 rows in LANE.md match my measurements, with one wording
   point: finding 3.

## Findings

### 1: RIGOUR (low): `resolve()` breaks a literal `~/` profile path. The rule resolves paths the CLI never accepts as relative.
`src/cli.ts:763` and `src/cli.ts:833`:

```ts
return [`--${name}`, ...(value === undefined ? [] : [NOTIFY_PATH_FLAGS.has(name) ? resolve(value) : value])];
const NOTIFY_PATH_FLAGS = new Set(["agent-token-file", "profile", "session-context"]);
```

`--profile` goes through `privatePath` (`src/cloud/agent-profile.ts:59-65`). That function expands a leading `~/`
itself and rejects any other relative path. `--session-context` must be absolute
(`src/cloud/session-context.ts:210`, measured: `[session_context_path_not_absolute]`). So for these two flags,
`resolve()` is either a no-op (absolute paths) or wrong (`~/`). Measured: a watcher started with
`--profile '~/hp/profile.json'` works. Its printed restart is `--profile '<cwd>/~/hp/profile.json'`, and that
command exits 1 with `The agent profile is missing.` A literal tilde reaches argv only when the launcher does not
expand it: a quoted path, or an argv array from a JSON config. A Monitor command typed in a shell expands it
first. No repo doc shows `--profile ~` for notify. The parser test pins `resolve("relative/profile.json")`
(`tests/p1-cli/resume.test.ts:698-700`) and `"relative/file.json"` for `session-context` (`:685`). Those are inputs
the CLI refuses at start, so the test shows the tokens are transformed, not that the restart works. Fix: resolve
only `agent-token-file`, and expand `~/` for `profile` with `privatePath` (or leave it as given).

### 2: RIGOUR (low): the `resume` orphan line still prints the restart command mid-sentence
`src/resume.ts:541`: `` `…; then restart ${watcherRestartCommand(report)} under the session's Monitor.` ``

H1 made "the restart command is the last thing in the sentence" the rule for the watcher's stop sentence. This
lane-added `resume` line is the other surface that prints a notify restart command. There, the command is followed
by prose that contains an apostrophe. A reader who extracts from `restart ` to the final `.`, as the lane test does
for the watcher, gets an unbalanced quote. The "Found: 0" line (`Next: … under a live Monitor: <cmd>`) already puts
the command last. The same wording would fix this line: `…; then restart it under the session's Monitor with <cmd>.`
The line is prose for an agent to read, not parsed by code, so the severity is RIGOUR.

### 3: RIGOUR (doc nit): the LANE.md H3 wording claims coverage for inputs the CLI refuses
Fold 2 H3 in LANE.md says: "The parser test also covers profile and session-context path resolution." That is true
of `Arguments` in isolation. But a relative `--profile` or `--session-context` never starts a watcher (finding 1).
The sentence reads as though those restarts were checked. Say "token transformation only; the CLI refuses relative
profile and session-context paths at start".

No PRODUCTION finding. The round-2 PRODUCTION item (Grok: the stdin restart was not runnable) is fixed and
measured. Its revert fails the new `/bin/sh` stdin test. Every round-2 RIGOUR item (my 1-6) is fixed and has a
control that fails on revert.

## Not established

- The default-target restart (no `--url`), because running it would need env targeting or a production target.
  It was checked by reading the code only.
- `check:edge`, `build:command-core` + bundle diff, `build-release.sh`, the site build, and
  `git diff --check origin/main...HEAD` were not rerun by me. The lane changes no file those gates read, except the
  release bundle, which it compiles from `src/`.
- Linux lsof output, a live Monitor, a real Realtime socket in a child CLI, and any restart loop outside the repo.
- A literal-tilde `--agent-token-file`. The credential reader does not expand `~`, so that start fails before any
  restart is printed. Behaviour is consistent there, and I did not probe it.

VERDICT: PASS
