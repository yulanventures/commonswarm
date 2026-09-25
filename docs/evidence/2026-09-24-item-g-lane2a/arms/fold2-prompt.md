Fold 2 on item G lane 2a in the CommonSwarm repo. Your current directory is the lane worktree, branch
lane/item-g-lane2a, at 5071a703 (your fold 1). Spec: docs/design/2026-09-24-ITEM-G-LANE-2A-BRIEF.md. Round 2: Grok
FAILED on one PRODUCTION finding; Opus PASSED with RIGOUR findings. Read both in full:
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemG2a/grok-r2.md
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemG2a/opus-r2.md
Implement every ruling below, each with a test that fails when the fix is reverted (measure it and record the result).
Record this fold in docs/evidence/2026-09-24-item-g-lane2a/LANE.md under "Fold 2".

RULINGS
H1 (PRODUCTION, Grok). The restart command must be the LAST thing in the sentence and must itself be runnable, also
   for a watcher started with --agent-token-stdin: that command includes --agent-token-stdin, and the instruction to
   pipe the same credential on stdin sits outside the command text (before it). Test: start a watcher with the
   credential on stdin, stop it with SIGTERM, extract the printed command the same way the other test does, run it
   through /bin/sh with the credential piped on stdin against the same loopback read service, and see a new read.
H2 (RIGOUR, Opus 1 + 3; replaces the hand-typed flag list). Build the restart command from the arguments this watcher
   was actually started with (every flag and value it parsed, in order), not from a typed subset, so --json,
   --session-context, --force-file-store, --profile and any future flag survive. Never add a secret: argv carries only
   paths and public values; keep it that way and assert no agent token appears. A --profile start restarts with
   --profile <path>, not the expanded credential. Test: for every flag `inbox --notify` accepts (take the list from
   the parser's own constant, not a typed list), a start with that flag prints a restart command that contains it.
H3 (RIGOUR, Opus 2). Every file-path argument in the restart command is absolute (resolved against the watcher's cwd),
   so the command works from another directory. Test: start from one cwd with a relative path, run the printed
   command from a different cwd, see a new read.
H4 (RIGOUR, Opus 4). A test proves that cancelling the watch kills an in-flight lsof child (the inspector's signal).
H5 (doc, Opus 5 + 6). Mark the round-1 "Parent orphan evidence" row in LANE.md as superseded by Fold 1 F3; fix the
   probe count so it matches the table.

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
