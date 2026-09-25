You implement item L in the CommonSwarm repo. Your current directory is the lane worktree, branch lane/item-l.
Spec: docs/design/2026-09-25-ITEM-L-EXACTLY-ONCE-FILE-PUT-BRIEF.md (read it fully), then AGENTS.md, then
docs/design/2026-08-18-FILE-ARTIFACTS.md, src/mcp/, src/cloud/files.ts, the file put / brain put code in src/cli.ts,
supabase/functions/command/file-artifacts.ts and tests/p1-cli/mcp-stdio.test.ts. Implement every decision with the
tests the brief names; each test must fail when its fix is reverted; record each mutation result you measured (server
tests are reasoned until the lead runs them; say so). If you find that a server change is needed, STOP that part and
report the evidence in LANE.md instead of writing a migration. Write a lane record at
docs/evidence/2026-09-25-item-l/LANE.md: decisions -> change -> test -> mutation; gates with exit codes and counts;
what is NOT established.

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

REPORT at the end: commit SHAs; each decision -> change -> test -> mutation; gates; not established.
