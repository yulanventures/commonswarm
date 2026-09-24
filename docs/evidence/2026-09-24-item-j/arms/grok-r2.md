I'll review lane item J at `a1ef90ff` against the fold-1 rulings and the diff from `c26b98a7`, without changing files or touching production. First I'm reading the rulings, the lane record, and the diff.HEAD is `a1ef90ff`. I'll read the SQL, the site and CLI paths, the tests, the release proofs, and `LANE.md` against the J1–J7 rulings.The fold at `a1ef90ff` meets rulings J1–J7. No findings.

Derived rule from `supabase/migrations/20260924000001_pending_access.sql`: a classic principal is pending only when it is unrevoked, its owner still has a live membership, no token has `first_used_at` set, and it either has no token or at least one unrevoked, unexpired token. Age and expiry come from the newest of those live tokens (`issued_at DESC, token_id DESC`). A principal with no token uses `created_at` and a null expiry.

```50:75:supabase/migrations/20260924000001_pending_access.sql
  LEFT JOIN LATERAL (
    SELECT t.issued_at, t.expires_at
    FROM swarm.agent_tokens AS t
    WHERE t.principal_id = p.principal_id
      AND t.revoked_at IS NULL
      AND t.expires_at > statement_timestamp()
    ORDER BY t.issued_at DESC, t.token_id DESC
    LIMIT 1
  ) AS tokens ON true
  WHERE p.workspace_id = p_workspace_id
    AND p.revoked_at IS NULL
    AND owner_membership.user_id IS NOT NULL
    ...
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_tokens AS used
      WHERE used.principal_id = p.principal_id
        AND used.first_used_at IS NOT NULL
    )
    AND (
      NOT EXISTS (SELECT 1 FROM swarm.agent_tokens AS any_token
                  WHERE any_token.principal_id = p.principal_id)
      OR tokens.issued_at IS NOT NULL
    )
```

| Case | Result |
|---|---|
| No token | Listed; age is `created_at` |
| Live unused only | Listed; age and expiry from that token |
| Revoked or expired sibling plus a newer live unused token | Listed; the dead token is outside the lateral |
| Any token with `first_used_at` set | Hidden |
| Revoked only, or expired only | Hidden (`tokens.issued_at` is null) |
| Revoked principal | Hidden |
| Owner membership revoked or absent | Hidden (`owner_membership.user_id IS NOT NULL`) |

The per-token loop in `site/src/lib/pending-access.ts` matches `e9fe4fe8`: same pending predicate, same state line, same `Cancel access for ${entry.agentName}`. Server rows are appended after that loop. A server classic row is skipped when that principal already has a live unused roster token, so the Cancel row stays and the join or no-token row is added (`site/src/lib/pending-access.ts:57-80`). `LiveDashboard.astro` still builds the Cancel button for every non-`pending` row (`2194-2214`).

J2. `tests/p1-server/pending-access.test.ts` seeds each case above and the join states (live, 1/3, revoked, expired, then both live codes exhausted). `proargnames.slice(1)` is compared with `deepEqual` to the ten names (`213-218`). Dropping the workspace filter would change `readAs(ownerB, workspaceB)` from 1. Dropping the live-token lateral would list the revoked-only and expired-only principals.

J3. The fixture runs in `sql.begin`, throws a sentinel, and rolls back (`56-245`). The follow-up count expects zero workspaces and zero join credentials (`246-252`). Names and mint ids include random UUIDs. Auth users are deleted in `finally`.

J4. `deploy/release-proofs/item-j/20260924000001-catalog.sql` is one `catalog_ok` boolean and ends with its own `\gset`. `20260924000001-functional.sql` is a read-only `DO` block, same shape as `deploy/release-proofs/h0/`. Section 5 requires both filenames.

J5. `readPendingAccessOptional` returns null on a failed read (`src/cloud/pending-access.ts:72-79`). `renderRoster` prints the member lines, then `Invited, not connected: could not load` (`src/cli.ts:4224-4248`), and `runMembers` calls the optional reader (`4286-4288`). The app wraps `pendingAgentAccess` in `loadPendingAccess` inside `openWorkspace` (`LiveDashboard.astro:6207-6235`). The pending section carries that same sentence (`1111`) and stays open when the flag is set and the row count is zero (`2177-2180`). A zero-agent workspace still shows the header door (`4011`).

J7. The owner join requires `revoked_at IS NULL` (`44-47`, `61`). The fixture’s “Owner left” principal is asserted absent (`194-196`).

The function, both read-edge selects (`supabase/functions/read/index.ts:461-464` and `626-629`), and `parsePendingAccess` return only the ten columns. The CLI roster test rejects `token_hash`, `credential_hash`, and `locator`.

`LANE.md` Fold 1 matches this code: the per-principal rule, the ten-column check, rollback, the proof paths, the release order, no new index, and the owner gate. `npm run build` exited 0. With a temporary `HOME`, the pending CLI tests, citation test, and both site observer files passed 43/43. `git diff --check origin/main...HEAD` exited 0. The server suite was not run here; `LANE.md` already says the lead’s installed function is still the pre-fold body.

VERDICT: PASS
