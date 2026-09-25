Fold 1 on item L in the CommonSwarm repo. Your current directory is the lane worktree, branch lane/item-l, at
c188170a (your commits). Spec: docs/design/2026-09-25-ITEM-L-EXACTLY-ONCE-FILE-PUT-BRIEF.md.

The lead ran your server test on the local stack. It failed: `item L derived ids replay one live version and
upsert-off Storage refuses a second PUT` got HTTP 400, not 409. The measured duplicate PUT response of local
storage-api v1.54.1 is HTTP 400 with body {"statusCode":"409","error":"Duplicate","message":"The resource already
exists"}. Production runs storage-api v1.77.5 (deploy/supabase-stack/VERSIONS.md), whose duplicate shape is NOT
measured. Your client (src/cloud/files.ts ~368-371) accepts a duplicate only on HTTP 409, so against local storage a
lost-PUT retry fails.

RULING L1 (replaces "accept only structured Storage duplicate responses"): do not decide exactly-once from storage's
error shape. On a REPLAYED put (the resume record, or the derived ids, say this request already reached the PUT
phase), a refused storage PUT of any kind moves on to the commit with the SAME derived commit command id. The server's
commit is the source of truth: it checks that the object exists (see the F7 test in
tests/p1-server/file-artifacts.test.ts, "the same command id retried after the cause is fixed SUCCEEDS", and the commit
handler in supabase/functions/command/file-artifacts.ts). If the bytes are missing, the commit's typed refusal is the
result and the tool reports it (not "replayed"). A FIRST put (no evidence of an earlier PUT) still treats any PUT
failure as a failure (retry once in-process as today). Keep the structured-duplicate recognition only as a fast path
if you want, accepting both shapes (HTTP 409, and HTTP 400 with body statusCode "409" and error "Duplicate"), never as
the only evidence. The upload path must be per version (verify in the create handler) — state where.
Tests: the stdio/fake tests cover a replayed PUT refused with 400-shape, 409-shape, and a 403 (expired URL): each
proceeds to commit and the result follows the commit (bytes present -> replayed; bytes missing -> typed failure);
fix the server test to assert the measured local shape and then the commit outcome; each fails when reverted.
Record Fold 1 in docs/evidence/2026-09-25-item-l/LANE.md, including the measured shape above and that the v1.77.5
shape is not established.

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

REPORT at the end: commit SHAs; the ruling -> change -> test -> mutation; gates; not established.
