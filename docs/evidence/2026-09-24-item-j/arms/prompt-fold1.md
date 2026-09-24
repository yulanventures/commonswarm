Fold 1 on item J (option A) in the CommonSwarm repo, branch lane/item-j at c26b98a7. Spec:
docs/design/2026-09-24-ITEM-J-INVITED-NOT-CONNECTED-BRIEF.md decisions 1-3. Both review arms FAILED on the same SQL
defect; both reviews are pasted at the end (Opus measured on the local stack and proposes a tested replacement
condition in its review). Implement EVERY ruling with a test that fails when the fix is reverted; record rulings, tests
and mutation results in docs/evidence/2026-09-24-item-j/LANE.md under "Fold 1". Read AGENTS.md and
deploy/RELEASE-TO-BOX.md first.

HARD RULES: contact no production host (api.commonswarm.com, commonswarm.com, edge-staging.commonswarm.com,
178.105.29.28, 100.115.66.74); never run a cswarm command without a loopback --url; NEVER run supabase db push, link,
functions deploy, --linked or anything against a remote project; do not run db:reset or db:stop (the lead runs the
local stack); do not touch ~/.cswarm or ~/.config/cswarm; start no other model; use no skill; no auto-approve flags;
print no secret. Every test has a timeout; no process survives. You may EDIT the lane's migration file
(supabase/migrations/20260924000001_pending_access.sql): it has not been applied anywhere but the lead's local stack.
Commit yourself: "fix(pending): ..." / "test(pending): ...", trailers exactly (one per line): Agent-Name: Yulan Bot /
Agent-Model: <your model id> / Agent-Family: openai / Agent-Tool: codex <version> / Agent-Model-Source: runtime-ambiguous.

RULINGS
J1 (both arms, PRODUCTION). Judge tokens one by one. A classic principal is pending when: the principal is not revoked,
   its owner is still a live member of the workspace (see J7), NO token of it has ever been used (first_used_at IS NOT
   NULL on any token means it connected), and it has either at least one live unused token (unrevoked, unexpired,
   first_used_at IS NULL) or no token at all. A revoked or expired sibling token must not hide it (the server makes
   that state itself in replaceUnusedRegistrationToken, and mint_agent_token allows a second token). Age and expiry
   come from the live unused token(s) (state which: the newest issued live token), never from a dead token. Use the
   replacement condition Opus measured if it matches this rule.
   Site regression: the app's existing per-token "Pending access" rows and their Cancel action for live unused classic
   tokens must stay exactly as at origin/main (site/src/lib/pending-access.ts returned early before the old loop); the
   new "Invited, not connected" entries add to them, they do not replace them. Test both.
J2 (Opus 2, Grok). The server test (tests/p1-server/pending-access.test.ts) must cover: a dead (revoked) sibling plus a
   live unused token -> listed; an expired sibling plus a live unused token -> listed; several tokens with one used ->
   not listed; revoked token only -> not listed; expired token only -> not listed; no token -> listed; the join
   credential states. Each filter's removal must fail the test (record the mutations). The column check must assert the
   catalog has EXACTLY these ten columns, not ">= 10".
J3 (Opus 3). The server test leaves no rows behind: run each case inside a transaction that is rolled back (join
   credentials cannot be deleted by design), or use uniquely named rows removed at the end; no shared fixed names.
J4 (Opus 4). Box-release proofs per deploy/RELEASE-TO-BOX.md section 5 for this migration: the catalog proof and the
   functional proof files, in the same form and location as the H0 lane's (find them under docs/evidence/ and
   deploy/), ending with their own \gset as that document requires. Do not run them against any remote database.
J5 (Opus 5). No hard dependency: if the pending-access read fails (network, 404 from an edge without the resource, 5xx),
   `cswarm members` still prints the members and says "Invited, not connected: could not load"; the app still opens the
   workspace and shows the same note in the pending section. Tests for both. LANE.md states the release order: the
   migration and the read edge reach the box BEFORE the CLI (npm) and the site.
J6 (Opus 6, ruling): no new index in this release (measured 2.4-5.6 ms at ~3.8k agents / 3.1k credentials); record the
   measurement and the scaling note in LANE.md.
J7 (Opus 7). A principal whose owner is no longer a member cannot connect (it gets 403): do not list it as "invited,
   not connected". Test.

GATES (exit code and counts): npm run build ; env -u FORCE_COLOR npm test ; env -u FORCE_COLOR npm run test:p1-cli ;
npm run check:tests ; npm run check:edge ; bash scripts/build-release.sh ; npm --prefix site run build ;
env -u FORCE_COLOR npm --prefix site test ; git diff --check origin/main...HEAD. The server suite runs on the lead's
local stack after your fold; write the server tests so they pass there. Name sandbox failures.

REPORT: commit SHAs; each ruling -> change -> test -> mutation; gates; not established.

===== OPUS REVIEW (round 1) =====
# Item J (option A) — Checker review, Claude Opus arm, round 1

Subject: `lane/item-j` at `c26b98a7` (86a61a2b Codex + c26b98a7 lead), base `e9fe4fe8`.
Copy under test: `git archive c26b98a7` at `scratchpad/itemJ/opus-probes/` (node_modules symlinked).
Evidence files: `scratchpad/itemJ/opus-work/` (`cases.sql/.out`, `cases-proposed.*`, `perf.sql/.out`,
`mutants.sql`, `mut-*.log`, `check-*.log`) and the probe scripts `opus-probes/opus-edge-probe.mts`,
`opus-probes/opus-cli-probe.mts`, `opus-probes/opus-guard.mjs`.

Scope: local Supabase stack only (127.0.0.1:54321/54322). I confirmed that the applied function body
has the same md5 as the lane file (`fe8489bd…`) and that the local edge runtime serves the lane's
`read` (a `pending_access` body with a non-agent bearer gets 401, not the old 400). The CLI ran with a
fetch guard that blocks every non-loopback host. It blocked nothing. No production host was contacted.
Every row I created is gone: SQL case sets ran in rolled-back transactions, and the probe rows plus
the mutant schema were deleted and counted back to 0.

---

## 1. PRODUCTION — a principal with a live, unused re-minted credential is hidden, and its app Cancel row is lost

`supabase/migrations/20260924000001_pending_access.sql:61-67`

```sql
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_tokens AS used
      WHERE used.principal_id = p.principal_id
        AND (used.first_used_at IS NOT NULL
          OR used.revoked_at IS NOT NULL
          OR used.expires_at <= statement_timestamp())
    )
```

The brief (decision 1a) makes the classic rule per token: "classic tokens with `first_used_at IS NULL`,
not revoked, not expired, plus principals with no token yet". The SQL makes it per principal. Any
token that was ever revoked or ever expired hides the principal for good, even when the principal now
holds a fresh, unused, live token.

Measured (`opus-work/cases.out`, owner reading workspace A):

| case | expected by the brief | returned |
|---|---|---|
| P7: token revoked unused, then a new unused token (live 2 days) | listed | **hidden** |
| P8: token expired unused, then a new unused token (live 2 days) | listed | **hidden** |

The path is reachable:
- App: `site/src/components/connect/AgentConnect.astro:789-796` re-mints for an existing principal
  ("reusing the one you already have").
- CLI: `cswarm token mint --principal-id` (`src/cli.ts` token mint, around line 2620).
- The reducer allows any number of mints per live principal (`src/protocol/workspace-commands.ts:1048-1097`).

This is also a regression. `site/src/lib/pending-access.ts:57-77` now returns early whenever
`serverPending` is defined, and `LiveDashboard.astro:2139` always passes it outside sample mode.
The old per-token loop at `:79` no longer runs. Before this lane, the app's Pending access list showed
that re-minted unused token, from `renewal_grant_roster`, with a **Cancel** button. After this lane it
shows nothing. So a credential can be live for up to 30 days, still unused, and appear nowhere as
pending. It also cannot be cancelled from the list whose job is to show it.

A second defect in the same block, at `:49-54`: the LATERAL takes `min(issued_at)` and `min(expires_at)`
over **all** tokens of the principal, dead ones included. Once the predicate is fixed, the age and
expiry shown would come from the dead first token.

I measured a fix candidate in a rolled-back transaction (`opus-work/cases-proposed.out`). It lists P1,
P2, P7, P8 and P10, and it hides P3 (a token was used), P5 and P6 (dead tokens only), and the registrars:

```sql
AND NOT EXISTS (SELECT 1 FROM swarm.agent_tokens u
                WHERE u.principal_id = p.principal_id AND u.first_used_at IS NOT NULL)
AND (NOT EXISTS (SELECT 1 FROM swarm.agent_tokens a WHERE a.principal_id = p.principal_id)
     OR EXISTS (SELECT 1 FROM swarm.agent_tokens l
                WHERE l.principal_id = p.principal_id AND l.revoked_at IS NULL
                  AND l.expires_at > statement_timestamp()))
-- and restrict the LATERAL min() to live tokens (revoked_at IS NULL AND expires_at > now)
```

With this rule, a principal that has EVER connected stays hidden. That covers a reconnect re-mint for
a previously connected agent, and it also keeps pending renewal successors from flagging connected
agents (see `_shared/agent-auth.ts:28-37`). That is a product choice, so LANE.md should say it in
words. Add P7 and P8 cases to the server test (see finding 2).

## 2. RIGOUR — the server test leaves two classic clearing filters unguarded, and its column check is circular

`tests/p1-server/pending-access.test.ts:127-135`

```ts
    assert.deepEqual(Object.keys(visible[0]!).sort(), [ ...ten names... ]);
    ...
    assert.ok(projected.length >= 10);
    assert.ok(projected.every((name) => !/hash|secret|locator|token/i.test(name)));
```

Mutation run. Each mutant was a scratch copy of the migration's function in a throwaway schema, with a
copy of the test pointed at it (logs in `opus-work/mut-*.log`). The unmodified base passes: 1/1.

| mutant | result |
|---|---|
| M1 drop `used.first_used_at IS NOT NULL` | FAIL (killed, `:154`) |
| **M2 drop `OR used.revoked_at IS NOT NULL`** | **PASS (survives)** |
| **M3 drop `OR used.expires_at <= now`** | **PASS (survives)** |
| M4 drop registrar NOT EXISTS | killed `:118` |
| M5 drop `is_member` gate | killed `:143` |
| M6 drop `seats_used < seat_cap` | killed `:154` |
| M7 drop join expiry | killed `:118` |
| M8 drop join revoked | killed `:118` |
| M9 drop `p.revoked_at IS NULL` | killed `:154` |
| M10 drop `p.workspace_id = p_workspace_id` | killed `:118` |
| M11 drop `c.workspace_id = p_workspace_id` | killed `:118` |
| M12 put `c.locator` into `issuer_display` | killed `:123` (value assert only) |

- The test has no classic token that is revoked or expired, and none of the brief's "several tokens,
  one used" or re-mint cases. The brief lists revoked and expired tokens as clearing cases, so
  "each clearing case" is not proven for classic entries.
- The "exact ten-column" claim in LANE.md does not hold. `readAs` SELECTs the ten names itself, so
  `Object.keys(visible[0])` always returns the test's own list, whatever the function returns. The
  catalog check accepts `>= 10` columns, so an eleventh output column with a harmless name (for
  example `code`) that carries the locator would pass. Assert exact equality on
  `pg_get_function_result('swarm_read.pending_access(uuid)'::regprocedure)`, or on
  `proargnames` plus `proargmodes`.

## 3. RIGOUR — the server test leaves rows that nobody can delete

`tests/p1-server/pending-access.test.ts:47-99` inserts workspaces with the shared names
`'Pending A'` and `'Pending B'`, plus join credentials. It never deletes them. The trigger
`agent_join_credentials_guard` forbids DELETE, so only a superuser in `session_replication_role =
replica` can remove them. Measured on the shared local stack: 6 workspaces named `Pending A/B` and
9 join credentials with `pending-*-mint` ids remain from earlier runs. This does not affect
production, but it adds noise to the shared DB slot on every run.

## 4. RIGOUR — the box release proofs that RELEASE-TO-BOX §5 needs are not written

`deploy/RELEASE-TO-BOX.md:718-735` requires `<version>-catalog.sql` (ending in `\gset` of `catalog_ok`)
and `<version>-functional.sql` for each pending version. The wrapper refuses to apply the version
without them. The H0 lane shipped these proofs under `deploy/release-proofs/h0/`, but this lane
ships none for `20260924000001`. LANE.md only says "supply … the migration catalog proof".

Migration safety itself: **OK**.
- The file runs one `CREATE FUNCTION`, then `ALTER FUNCTION … OWNER`, `REVOKE`, `GRANT` and `COMMENT`.
  It takes no table lock, rewrites nothing and has no data step.
- The non-idempotent `CREATE FUNCTION` is correct under the wrapper: it applies only when ledger = 0
  and catalog = f, and it runs in one transaction with the ledger insert.
- plpgsql does not check the table references at create time, but every table it names exists
  since `20260916000001`.

## 5. RIGOUR — a failed pending read now breaks the whole `cswarm members` and workspace open

- `src/cli.ts:4286` calls `const pending = await readPendingAccess(...)` with no catch.
- `site/src/components/app/LiveDashboard.astro:6204` puts `pendingAgentAccess(selected.id)` inside
  the `openWorkspace` `Promise.all`.

If the read fails, both fail completely: an edge that does not have the resource yet answers
`400 invalid_request` (measured on this stack for an unknown resource), and a 500 or timeout does the
same. `cswarm members` then prints no member list at all. The order edge → site → CLI in LANE.md is
therefore required, not optional. The npm CLI is also released on its own track. Recommended: omit
the section and print one line saying the pending read failed, instead of failing the roster.

## 6. RIGOUR — the query cost grows with global history (existing pattern, not blocking)

`perf.out`: 3842 principals, 20420 tokens, 3119 join credentials, one workspace with 60 agents,
3003 registrars and 3003 codes. The function took 3.6–5.6 ms; the raw query executed in 2.4 ms.
The plan:
- `Seq Scan on agent_principals` (all workspaces): there is no index on `agent_principals(workspace_id)`.
- `Seq Scan on agent_join_credentials` for the registrar anti-join.
- The join tail uses `agent_join_credentials_live_by_workspace`, and token probes use
  `agent_tokens_by_principal`.

Every minted code adds a registrar principal and a credential row that can never be deleted, so both
seq scans grow with all history. `swarm_read.agent_principals` already has the same shape, so this is
not new. It is cheap today. An index on `agent_principals(workspace_id)` would bound it.

Also, `hasPendingAccess` (`LiveDashboard.astro:5668-5671`) is now true for a principal with no token.
An abandoned principal (created, never minted) keeps that workspace on the 12 s active poll cadence
for good, instead of 30 s.

## 7. RIGOUR (low) — an agent whose owner has left is shown as "Invited, not connected"

Case P10 in `cases.out`: the principal's owner membership is revoked, so the row is listed with
`issuer_display = 'Workspace member'`. An agent credential in that state gets `403 forbidden` from
the edge (measured: `agent_after_owner_membership_revoked`), so it can never connect. `MemberRemoved`
(`command/index.ts:4253-4268`) does not revoke principals. The existing roster lists these agents too,
so this is low severity, but "Invited, not connected" makes a claim here that is not true.

---

## What passed (measured)

- **Access control** (`cases.out`, per role in one rolled-back transaction):
  - The owner and a plain member of A get 5 rows.
  - A revoked member of A, the owner of B, an outsider, owner A on workspace B, owner A on an archived
    workspace, a random workspace id, empty claims and claims with no sub all get 0 rows. There is no
    error and no oracle: a non-member gets the same empty result as a workspace that does not exist.
  - `anon` and `swarm_command` get `permission denied for schema swarm_read`.
  - `has_function_privilege`: authenticated t, swarm_read t, anon f, swarm_command f, service_role f,
    authenticator f.
  - The ACL is `{swarm_admin=X, authenticated=X, swarm_read=X}` with no PUBLIC. It is byte-identical
    in shape to `renewal_grant_roster`.
  - The function is SECURITY DEFINER, `search_path=swarm, pg_catalog`, owned by swarm_admin, and STABLE.
  - Every relation is schema-qualified, so pg_temp shadowing does not apply.
- **Projection**: exactly 10 output columns: kind, principal_id, principal_name, join_credential_id,
  owner_user_id, issuer_display, issued_at, expires_at, seats_used, seat_cap. It projects no hash,
  locator, token id, wake_id or registrar. The edge selects the same ten names explicitly
  (`read/index.ts:460-465`, `:621-627`).
- **Row cases**:
  - Listed: a principal with no token (issued = `created_at`, expires null); one unused token.
  - Hidden: two tokens with one used; a revoked principal; an expired-only token; a revoked-only token.
  - Join codes: unexpired → listed (0/1); revoked, expired and used-up (2/2) → hidden; 1/3 → listed
    with 1/3.
  - Registrar principals never appear, including the three registrars behind the hidden codes.
- **Read edge** (`opus-edge-probe.mts`, human JWT and agent token on the local edge):
  - Own workspace → 200 `{pending:[…3]}`, and an upper-case workspace id works too. Other or random
    workspace → 200 `{pending:[]}`.
  - Extra key, bad UUID, missing workspace_id, bad JSON → 400 `invalid_request`. No bearer, or the
    anon key as bearer → 401. GET → 405.
  - A human asking for `members` is still 401: the lane widened only `pending_access`.
  - Agent: another workspace → empty envelope, and that call still stamped `first_used_at`. Own
    workspace → its own seat is already cleared. A revoked token → 403. An unknown token → 401. An
    owner whose membership was revoked → 403.
  - `npm run check:edge` exit 0 (6 entry points). `npm run check:tests` exit 0.
- **`cswarm members`** (`opus-cli-probe.mts`, `tsx src/cli.ts`, loopback `--url`, token on stdin,
  HOME in scratch):
  - Text shows `Invited, not connected:` with the no-token seat `1d ago` (created 26 h before), the
    issued token `1h ago` (95 min before), and `Agent connect code (…) · 7m ago · 1/3 seats used ·
    issued by … Owner`.
  - `--json` adds `pending`, whose rows have exactly the ten keys.
  - Across stdout and stderr: no locator, no credential hash, no bearer and no registrar.
  - After one authenticated `read` with the pending seat's token, that seat is gone on the next run.
    The no-token seat and the code stay.
- **Gates**: the server test runs in `test:p1-server` (node globs `tests/p1-server/**/*.test.ts`, and
  `pending-access.test.ts` is among the 15 files). The CLI tests are in the `test:p1-cli` glob. The
  site observer test is in the site `test` glob. The focused runs pass: CLI + citation 4/4, site
  observer 23/23, server base 1/1.
- **LANE.md**: the claims are true except "the exact ten-column result" (finding 2). LANE.md also
  does not state that the classic rule is per principal (finding 1).

## Not established

- Production row counts, and the plan on the box.
- The one-minute clearing measured in a real browser. I checked it only from code: the 30 s
  discovery cadence and the 12 s active cadence.
- The site UI rendering of the pending rows in a browser.
- `scripts/build-release.sh`. I did not run it, because the lane changes no module loading.

VERDICT: FAIL

===== GROK REVIEW (round 1) =====
I'll review lane item J at `c26b98a7` against the brief, the lane record, and the diff. No files will be changed and no production host will be contacted.The migration is a security-definer function. I'll compare it with the existing read patterns and the token, membership, and join-credential schema.The lane fails because a live, never-used classic token is hidden whenever an older token on the same principal is revoked or expired. That state is produced by registration token replacement and by a later `mint_agent_token` on the same principal.

Checked at `c26b98a7` against `origin/main` `e9fe4fe8`. `npm run check:edge` exited 0 on all six entry points. The focused CLI, citation, and site tests exited 0 with 27 passed.

**Migration access control.** `swarm_read.pending_access(uuid)` matches `renewal_grant_roster`: `SECURITY DEFINER`, `search_path = swarm, pg_catalog`, owner `swarm_admin`, the same JWT `sub` plus `swarm.is_member` early return, `REVOKE ALL` from `PUBLIC` and `anon`, `GRANT EXECUTE` to `authenticated` and `swarm_read`. A non-member gets an empty set. The output columns are `kind`, `principal_id`, `principal_name`, `join_credential_id`, `owner_user_id`, `issuer_display`, `issued_at`, `expires_at`, `seats_used`, `seat_cap`. `credential_hash`, `locator`, `token_id`, `token_hash`, `wake_id`, `registrar_principal_id`, `registrar_run_id`, and `mint_command_id` are not projected. Registrar principals are excluded with the same `registrar_principal_id` predicate as `swarm_read.agent_principals`.

**Eligibility that holds.** A principal with no token is included. Several tokens, one with `first_used_at` set, are excluded, which matches decision 3. A revoked principal is excluded by `p.revoked_at IS NULL`. Join rows require `revoked_at IS NULL`, `expires_at > statement_timestamp()`, and `seats_used < seat_cap`.

**Apply and performance.** The migration is `CREATE FUNCTION`, owner change, revoke, grant, and comment. It rewrites no rows and does not lock `agent_tokens` or `agent_join_credentials`. That fits `deploy/RELEASE-TO-BOX.md`: additive, old edge keeps working, migration before the new `read`, and a migration-only change does not move `stack/current`. Workspace principals use `UNIQUE (workspace_id, name)`. Token probes use `agent_tokens_by_principal`. Registrar exclusion uses `UNIQUE (registrar_principal_id)`. Join rows use `agent_join_credentials_live_by_workspace (workspace_id, expires_at) WHERE revoked_at IS NULL`.

**Read edge.** A human session is `getUser`, then `request.jwt.claims.sub` set to that user, then the function. An agent credential goes through `agent_delivery_read_context`; the same workspace then sets `sub` to the owner and calls the function. Another workspace returns `200 {pending: []}` before that query. A non-member human gets the same empty envelope from `is_member`. Missing credentials are `401 unauthenticated`, a bad body is `400 invalid_request`, a revoked agent is `403 forbidden`, and a thrown query is `500 internal_error` with `request_id` and no SQL text.

**App and `cswarm members`.** Both render the server list. Age is `issued_at` (`min(token.issued_at)`, otherwise `principal.created_at`; join uses `created_at`). The poll gate is 12 seconds with rows and 30 seconds at local zero. JSON `pending` is the ten parsed fields; `parsePendingAccess` drops any extra server field, and the text roster is passed through `sanitizeDisplayLabel`. First use clears because any `first_used_at` removes the principal. The surfaces inherit the hide bug below.

**Tests and `LANE.md`.** `tests/p1-server/pending-access.test.ts` is in the `test:p1-server` glob. The CLI file is in the `test:p1-cli` glob. The site file is in the site `test` glob. The record’s “27 passed” and “check:edge exit 0, six entry points” both reproduced. Its statement that the server test was not executed here matches this review: that test needs the local stack and was not run.

## Findings

**PRODUCTION** — `supabase/migrations/20260924000001_pending_access.sql:61-67`

A principal is kept only when every token is unused, unrevoked, and unexpired. One revoked or expired token removes the principal even if another token is still unused and unexpired, so `first_used_at` is still null and the seat is not connected.

```61:67:supabase/migrations/20260924000001_pending_access.sql
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_tokens AS used
      WHERE used.principal_id = p.principal_id
        AND (used.first_used_at IS NOT NULL
          OR used.revoked_at IS NOT NULL
          OR used.expires_at <= statement_timestamp())
    )
```

`replaceUnusedRegistrationToken` builds that state on purpose: it revokes the unused registration token and inserts a replacement with `first_used_at` left null.

```5805:5889:supabase/functions/command/index.ts
  const revoked = await tx<{ token_id: string }[]>`
    UPDATE swarm.agent_tokens
    SET revoked_at = ${new Date(frame.now)}
    WHERE token_id = ${existing.token_id}::uuid
      ...
      AND first_used_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > ${new Date(frame.now)}
    ...
  await tx`
    INSERT INTO swarm.agent_tokens (
      token_id, principal_id, run_id, task_id, epoch,
      scopes, token_hash, issued_at, expires_at, lineage_id,
      renewal_grant_id
    ) VALUES ( ... )
```

`mint_agent_token` also accepts another token for a live principal (`src/protocol/workspace-commands.ts:1048-1097`) with no requirement that older tokens be gone. After the older token is revoked or expires, the new unused token stays off the list. For a one-seat join code, `seats_used` is already spent, so the join row is gone too and the seat is absent until something else authenticates.

**RIGOUR** — `tests/p1-server/pending-access.test.ts:74-78` and `:147-154`

The server test inserts one token. The clearing assertion then sets that token’s `first_used_at`, exhausts the join credential, and revokes the no-token principal in one step. It never seeds a second token, so it does not prove “several tokens, one used” and does not catch the revoked-or-expired sibling above. `LANE.md` does not claim that case, and it does say this test was not executed.

VERDICT: FAIL
