Fold 1 on item G lane 2a in the CommonSwarm repo. Your current directory is the lane worktree, branch
lane/item-g-lane2a, at 3d09d409 (your commits). Spec: docs/design/2026-09-24-ITEM-G-LANE-2A-BRIEF.md. Two reviews
FAILED; read both in full:
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemG2a/opus-r1.md
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemG2a/grok-r1.md
Implement every ruling below, each with a test that fails when the fix is reverted (measure it and record the result).
Record this fold in docs/evidence/2026-09-24-item-g-lane2a/LANE.md under "Fold 1".

RULINGS
F1 (PRODUCTION, Opus 1). The restart command printed after a signal must be runnable. Build it from the flags this
   watcher was actually started with: `cswarm inbox --notify` plus `--agent-token-file <path>` (the path, never file
   contents), `--workspace-id <id>`, and `--url <url> --anon-key <key>` only when the run passed them explicitly
   (the anon key is public; still print it only if it was passed). With `--agent-token-stdin`, the sentence says to
   restart with the same credential input on stdin. Quote paths with spaces safely. Test: parse the printed command
   and run it (loopback fake read service) - it must start watching; the old constant-only test is replaced.
F2 (PRODUCTION, Grok 1; Opus 6). The stdout check also runs during the retry backoff after failed reads, at the same
   bounded cadence, so an orphan made during a server outage exits 74 within IDLE_POLL_MAX_MS plus a margin. Test with
   a fake read service that keeps failing (5xx) and a destroyed stdout.
F3 (RIGOUR, Opus 4 + 5; Grok 2). Evidence order in resume: a PROVEN stdout result wins - `live_reader` means the
   watcher is live (not orphaned) even when its parent is pid 1 or missing; `orphaned` stdout means orphaned. Parent
   evidence decides only when stdout is `cannot_determine` or `not_pipe`. A parent that exists but refuses
   kill(pid, 0) with EPERM is alive (`parent_alive`), not unknown. The report keeps both evidence fields, and the
   next-step line names only what is actually unknown. Tests for each combination.
F4 (RIGOUR, Opus 2). Unit tests for the shared lsof parser from recorded real output shapes (unix live `->0x...`,
   unix `->(none)`, PIPE live, PIPE closed with an empty name, FIFO, REG, CHR, empty output, a second `n` line) and
   for the `ps` parent parser (ppid 1, a number, empty, garbage). Each mutation Opus listed in its F2 must now fail.
F5 (RIGOUR, Opus 3). The older resume test at tests/p1-cli/resume.test.ts:122-155 must inject a parent adapter so it
   never runs real `ps` on fake pids.
F6 (RIGOUR, Opus 7, 8). Fix the timeout-table citation range to include the timeout option. The signal message is
   exactly one sentence.
F7 (doc). LANE.md "Not established" states that on Linux lsof without +E prints no peer, so the idle check cannot
   prove an orphan there (the watcher then never exits 74 from the idle check; nothing else changes).

HARD RULES:
- Contact no production host: api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com, 178.105.29.28,
  100.115.66.74. Never run a cswarm command without a loopback --url (without one it contacts commonswarm.com).
  Never run cswarm against a real workspace.
- No supabase db push, supabase link, supabase functions deploy, anything with --linked, and no vercel. No db:reset or
  db:stop. This lane needs no database.
- Do not read or write ~/.cswarm or ~/.config/cswarm. Tests use a temporary HOME and temporary state dirs.
- Start no other model and use no skill. No auto-approve or bypass flags. Print no secret.
- Every test has a timeout; no process you start survives (kill children; check with pgrep before you finish).
- Never pipe scripts/build-release.sh into grep; read its exit code.
- Commit yourself, small commits: "feat(notify): ...", "fix(resume): ...", "test(...): ...". Author
  yulanbot@gmail.com / Yulan Bot (use git -c user.email=yulanbot@gmail.com -c user.name="Yulan Bot"). Trailers,
  exactly, one per line:
  Agent-Name: Yulan Bot
  Agent-Model: gpt-6-sol
  Agent-Family: openai
  Agent-Tool: codex 0.156.0
  Agent-Model-Source: runtime-ambiguous

GATES (report exit code and counts for each; name sandbox failures such as spawn EPERM separately):
npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ; npm run check:tests ;
npm run check:edge ; npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js ;
bash scripts/build-release.sh ; npm --prefix site run build ; git diff --check origin/main...HEAD

REPORT at the end: commit SHAs; each ruling -> change -> test -> measured mutation; gates; not established.
