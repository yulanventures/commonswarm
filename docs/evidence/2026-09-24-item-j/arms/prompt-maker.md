You are the Maker for item J ("invited, not connected" is visible), option A, in the CommonSwarm repo. Work ONLY in
your current directory, the git worktree of branch lane/item-j (from main e9fe4fe8). THE SPECIFICATION is
docs/design/2026-09-24-ITEM-J-INVITED-NOT-CONNECTED-BRIEF.md, decisions 1-3 (NOT the setup-error report: that is
option B and is out of scope). Read AGENTS.md first (D-053; generated enumerations; claim controls; "durable by
default"; view-star rule: enumerate view columns and assert no secret is projected), docs/design/SWARM-CLOUD.md
sections on read views and RLS, deploy/RELEASE-TO-BOX.md (migration and edge rules), the migrations
20260904000001_standing_grant_resume.sql (renewal_grant_roster), 20260916000001_agent_join_credentials.sql and
20260916000002_agent_join_attempts.sql, supabase/functions/read/index.ts, site/src/lib/pending-access.ts,
site/src/lib/commonswarm.ts (AgentAccessStatus), the app's pending-access UI, and `cswarm members` in src/cli.ts.

Build:
1. A new migration adding a `swarm_read` view or security-definer function that returns, for workspaces the caller is
   a member of, pending entries of two kinds: (a) classic: agent principals not revoked whose tokens are all unused
   (`first_used_at IS NULL`), unrevoked and unexpired, AND principals with no token yet; (b) join credentials that are
   unexpired, unrevoked and have seats_used < seat_cap. Columns: kind, principal id and name (classic), join credential
   id (not the secret, hash or locator), issued/created at, expires at, seats used / cap (join), issuer display (if
   already exposed elsewhere). Enumerate columns explicitly; a test asserts no hash, secret, locator or token column is
   projected. Follow the existing grant/RLS patterns exactly.
2. A read-edge resource (e.g. `pending_access`) serving it to a human session and to an agent credential of the same
   workspace; `npm run check:edge` must pass; regenerate the protocol bundle if the protocol changes
   (`npm run build:command-core`, never hand-edit supabase/functions/_shared/protocol.js).
3. The app roster shows those entries as "Invited, not connected · <age>" in the existing pending section, clearing when
   first used / used up / revoked / expired through the existing poll; `cswarm members` adds an "Invited, not connected"
   section (and in --json a `pending` array).
4. Tests: server tests in tests/p1-server/ (run by `npm run test:p1-server`; they need local Supabase, which the lead
   runs outside your sandbox — write them, and run what you can), CLI tests in tests/p1-cli/, site tests next to the
   component; each with a mutation control recorded.
5. docs/evidence/2026-09-24-item-j/LANE.md: what was built, the migration file name, the box-release steps it needs
   (per RELEASE-TO-BOX.md), tests, mutations, and what was not established.

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); never run a cswarm command without a loopback --url; NEVER run supabase db push, link,
functions deploy, --linked, or any command against a remote project; you may run the LOCAL stack commands only if they
work in your sandbox (`npm run db:start` etc.); do not touch ~/.cswarm or ~/.config/cswarm; start no other model; use no
skill; no auto-approve flags; print no secret. Every test has a timeout; no process of yours survives.
SANDBOX: network and the repository .git are writable. Commit yourself: subject "feat(pending): ..." / "test(...): ...",
trailers exactly (one per line): Agent-Name: Yulan Bot / Agent-Model: <your model id> / Agent-Family: openai /
Agent-Tool: codex <version> / Agent-Model-Source: runtime-ambiguous.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; npm run check:edge ; bash scripts/build-release.sh ; npm --prefix site run build ;
env -u FORCE_COLOR npm --prefix site test ; git diff --check origin/main...HEAD. Name sandbox failures. If the dispatch
baseline changes, regenerate it twice (byte-identical) and list the changed rows.

REPORT: commit SHAs; each decision -> implementation -> test; mutations; gates; not established.
