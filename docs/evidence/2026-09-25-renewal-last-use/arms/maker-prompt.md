You fix one production bug in the CommonSwarm repo. Your current directory is the lane worktree, branch
lane/renewal-last-use (from main). Read AGENTS.md first.

THE BUG (production, measured by HezLead from the box's edge and Postgres logs, 2026-09-25): the read edge answers
HTTP 500 in its "membership" phase when two reads by the same seat overlap. The Postgres log shows
`ERROR: SWARM_RENEWAL_LAST_USE_REWOUND` (ERRCODE 55000) from `swarm.renewal_grants_spend_or_revoke_only()` (the
no-rewind trigger on swarm.renewal_grants). The read edge calls `SELECT swarm.record_renewal_grant_use(token_id,
device_id, NULL)`; its latest definition (supabase/migrations/20260904000001_standing_grant_resume.sql, ~line 333) sets
`last_used_at = statement_timestamp()`. When statement A starts first but waits on the grant row's lock held by a
later statement B, A re-checks the row after B commits and writes its older timestamp; the trigger refuses the
rewind. Seen 4 times on 2026-09-25 and 3 times earlier (since 2026-09-18).

THE FIX: a new migration `supabase/migrations/20260925000002_renewal_last_use_monotonic.sql` that replaces
swarm.record_renewal_grant_use with the same signature, owner, grants and behaviour, except that last_used_at never
moves backwards (for example GREATEST(grant_row.last_used_at, statement_timestamp())), and new_host_at logic is
unchanged. KEEP the trigger's no-rewind rule unchanged. Check every other writer of renewal_grants.last_used_at
(grep the migrations and supabase/functions) for the same race and fix each the same way in the same migration, or
state why it cannot race. Add release proofs under deploy/release-proofs/renewal-last-use/ (a read-only catalog proof
that returns t only for the fixed function body; follow the shape of deploy/release-proofs/item-g/).

TESTS (server tests run only on the lead's local stack; write them carefully; the lead runs them): a server test that
reproduces the race deterministically with two database connections: connection B takes the grant row lock
(BEGIN; SELECT ... FOR UPDATE), connection A starts `SELECT swarm.record_renewal_grant_use(...)` (it blocks), B then
calls record_renewal_grant_use itself and commits, then A completes. On the old function A fails with
SWARM_RENEWAL_LAST_USE_REWOUND; on the fixed one A succeeds and last_used_at equals B's (later) timestamp. Also a
served read-edge test if practical. Record the mutation (old function body -> the test fails) as reasoned until the
lead runs it. Write docs/evidence/2026-09-25-renewal-last-use/LANE.md: bug, fix, test, mutation, gates, what is not
established (the box release).

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

REPORT at the end: commit SHAs; change -> test -> mutation; gates; not established.
