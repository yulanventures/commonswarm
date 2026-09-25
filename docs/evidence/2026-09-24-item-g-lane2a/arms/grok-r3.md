I'll review lane 2a at `700f2927` against the brief, the fold rulings, and the round-2 notes. No files will change.The fold-2 diff is in view. Next I’ll read the restart-command path and the rulings it claims to satisfy.The lane tests passed. Next I’ll probe restart quoting, profile tilde paths, and whether a revert still fails the new controls.The restart command is built from the parser's own option list, and the round-2 failures are fixed. One profile path spelling still restarts against the wrong file.

### 1 — RIGOUR: a `~/` profile path is resolved against the watcher cwd

`src/cli.ts:763` and `src/cloud/agent-profile.ts:60-64`.

```763:763:src/cli.ts
      return [`--${name}`, ...(value === undefined ? [] : [NOTIFY_PATH_FLAGS.has(name) ? resolve(value) : value])];
```

```59:64:src/cloud/agent-profile.ts
export function privatePath(path: string): string {
  if (path.startsWith("~/")) path = join(homedir(), path.slice(2));
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) {
    throw new AgentSetupError("profile_path_invalid", "Use an absolute private file path outside a repository.");
  }
  return resolve(path);
}
```

`NOTIFY_PATH_FLAGS` includes `profile` (`src/cli.ts:833`). `path.resolve("~/agents/profile.json")` joins that string onto the watcher cwd. `readAgentProfile` expands `~/` through `privatePath` before it opens the file.

Measured with `HOME` set to a temporary directory and the profile URL on loopback: a watcher started as `inbox --notify --profile ~/agents/profile.json` from cwd `/bin` read the loopback service and exited 143. The printed command was:

`cswarm inbox --notify --profile '/bin/~/agents/profile.json' --json`

The file it had opened was `/tmp/g2a-live-home-zbLj/agents/profile.json`. The sentence did not contain the profile anon key or the agent token. An absolute `--profile` path still restarts; the suite test made a second loopback read. An unquoted `~/` typed in a shell is expanded before `cswarm` sees it. The literal `~/` form, which `privatePath` accepts, prints a command that points at a different file.

The other checks hold.

- **H1.** The stdin instruction is before the command. `notifySignalStopSentence` ends with the command (`src/cloud/arrival-watch.ts:79-80`). The suite test extracts it, pipes the credential into `/bin/sh`, and gets a second loopback read. The extracted command is `cswarm inbox --notify --agent-token-stdin …` and does not contain the pipe instruction or the agent token.
- **H2.** `Arguments` stores option tokens in the constructor (`src/cli.ts:700` and `src/cli.ts:728`), before `expandAgentProfile` adds derived flags (`src/cli.ts:797-798`). `notifyRestartOptions` replays those tokens (`src/cli.ts:838-842`). A real `--profile` start keeps `--profile` and does not print `--agent-token-file` or the anon key from the profile file. Explicit `--anon-key` is replayed because it was on argv; it is the public anon key. `--json`, `--force-file-store`, `--session-context`, and `--host-session-id` survive. Paths with spaces, `'`, `"`, `$`, backticks, `;`, `$(…)`, and `*` reach `/bin/sh` from `/bin` as one absolute argv each. A live credential file named `cred $(no) \`no\` $HOME "q" 's'.json` restarted from `/bin` and made a second loopback read. No marker file was created, and the agent token was absent.
- **H3.** Relative `--agent-token-file` is made absolute at `src/cli.ts:763`. The suite test, with a space and an apostrophe, restarts from another cwd. That is the case above, apart from the `~/` profile spelling.
- **H4.** `runArrivalWatch` passes the watch signal into `inspect` (`src/cloud/arrival-watch.ts:601`), and `execFile` receives it (`src/stdout-consumer.ts:35`). The fixture test aborts that signal, requires `cannot_determine` within 400 ms, and requires the child pid to exit. It passed in 286 ms.
- **H5.** The parent-evidence row is marked `superseded by Fold 1 F3` (`docs/evidence/2026-09-24-item-g-lane2a/LANE.md:12`). The Fold 1 paragraph counts 12 `exit 1` results and 11 unique probes. `tests/p1-cli/citation-drift.test.ts:29-40` derives those counts from the table. That test passed.
- **Earlier rounds.** Idle exit 74, the push-mode check, silent non-orphan results, retry exit 74 with empty stdout, signals 130 and 143, and proven-stdout-over-parent all passed in `tests/p1-cli/resume.test.ts` and `tests/support/arrival-watch.test.ts`. `tests/p1-cli/arrival-notify.test.ts` passed 2/2. Those files are on `npm test` or the `test:p1-cli` glob. `arrival-notify.test.ts` is only on the glob, as `LANE.md` says.

52 tests in the lane files and 2 arrival-notify tests passed under a temporary `HOME`. Full `npm test` and `test:p1-cli` were not re-run here.

VERDICT: PASS
