Fold 2 on item L in the CommonSwarm repo. Your current directory is the lane worktree, branch lane/item-l, at
444db2b7. Spec: docs/design/2026-09-25-ITEM-L-EXACTLY-ONCE-FILE-PUT-BRIEF.md. Round 1: Opus FAIL (two PRODUCTION),
Grok PASS with RIGOUR notes. Read both in full, and Opus's probes:
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemL/opus-r1.md  (probes: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemL/opus-r1-probes/)
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/itemL/grok-r1.md
The lead measured at 444db2b7: file-artifacts server test 22/22 on the local stack; full gates green (server 261/261,
npm test 990/990, p1-cli 982/982). Implement every ruling below, each with a test that fails when the fix is
reverted; rerun Opus's five surviving mutations (Opus finding 5) and show each now fails. Record "Fold 2" in
docs/evidence/2026-09-25-item-l/LANE.md.

RULINGS
P1 (PRODUCTION, Opus 1). Every typed file refusal the MCP tools can return gets a correct, generated next step from one
   table: retryable ones (file_bytes_missing, 5xx, 429, transport) say "retry this call with the same request_id";
   argument errors say what to change; only a real access loss says a person must restore access. Test each code.
P2 (PRODUCTION low, Opus 2). A terminal commit-time refusal (for example the if_version precondition, after which the
   server purges the version) is stored in the resume record as terminal; a retry with the same request_id returns the
   same typed refusal with NO network call and never PUTs again. The precondition message says: read the topic again
   and use a NEW request_id for new content.
R3 (Opus 3). One bad record (bad JSON, wrong mode) never blocks other request_ids: skip or quarantine it, and say so
   once on stderr.
R4 (Opus 4, 11). Before reading, lstat the path: a regular file only, at most 25 MiB; FIFO, directory, symlink to a
   non-regular file, and missing path are typed argument errors (no retry advice). Refuse any path inside the CLI's
   own credential and state locations (~/.cswarm, ~/.config/cswarm, the profile's directory, the credential file
   itself) with a typed refusal, resolved after following symlinks.
R5 (Opus 5; Grok if_version, name case). Tests that kill each surviving mutation: the if_version part of the conflict
   check; workspace and principal in the derived ids and in the record key; the "created" phase write; the 5xx ->
   unknown branch. Make the local conflict check compare the name case-insensitively, as the server does.
R6 (Opus 6). request_id_conflict says new content needs a new request_id.
R7 (Opus 7; Grok CLI notes). Without --request-id, `file put` and `brain put` behave exactly as before: the same
   messages and the same order (credential errors before file errors). With --request-id and --json, a conflict
   prints a JSON error with code request_id_conflict. Tests for both.
R8 (Opus 8). The tool-list agreement test compares the full set of MCP-served tools with the command table's
   entries marked for MCP, not only the two new names; fix the stale "CLI-only until item L" assertion text.
R9 (Opus 9). Label `replayed` only on evidence that the commit happened before this call (the record shows a
   completed commit, or the server says it replayed); otherwise `committed`. Say which evidence is used.
R10 (Opus 10). Record phases never move backwards.
R11 (Grok prune). Pruning at the 200-record bound never deletes the record being checked for this request_id.

HARD RULES:
- Contact no production host: api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com, 178.105.29.28,
  100.115.66.74. Never run a cswarm command without a loopback --url (without one it contacts commonswarm.com).
  Never run cswarm against a real workspace.
- No supabase db push, supabase link, supabase functions deploy, anything with --linked, and no vercel. No db:reset,
  db:stop, supabase stop/start. You may NOT apply migrations to the local database; write the server tests carefully
  (tests/p1-server/managed-delivery.test.ts shows the patterns: acked rows need delivered_at/surfaced_at; swarm.signals
  is append-only; the functions are served by `supabase functions serve --env-file` with SWARM_ENV=test). The lead
  runs them on the local stack.
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

REPORT at the end: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.
