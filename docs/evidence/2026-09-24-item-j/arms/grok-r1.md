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
