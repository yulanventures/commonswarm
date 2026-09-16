I'll review both commits, then mutate the quota/lock fixes and run the named gates. No production contact.I have both messages. Next I’ll pull the full HEAD message and the actual code paths those claims name.I’ll map the helper, mint/revoke paths, and the schema next so the mutations hit the real gates.The helper looks right at first glance. Next I’ll check lock order, other principal counts, and whether a dead registrar can still be used.The stream-lock comment may already serialize mints. I’ll trace dispatch and whether a registrar can still take a token after expiry.Local Supabase is loopback only. I’ll run the independent gates first, then mutate.Fast gates are green. Next I’ll mutate the lock and quota code, confirm each edit landed, then restore.Clean server tests passed 16/16. Next I’ll invert the expiry predicate and see whether that control stays green.Reviewed `lane/h0-join-credential` at `b2f9b8b0` (fix) on `165114ee` (feat). No request went to production. Local API was `127.0.0.1:54321`. Sources were restored byte-identical after every mutation.

## PRODUCTION

None. The deployed quota path is safe.

- Dead registrars (revoked **or** expired) drop out of `lockAndCountLivePrincipals`. Live ones stay in the count. A member cannot keep more **counted** principal slots than 50 by mint / revoke / expiry.
- Live credentials are capped at 5 per person per workspace and 20 per workspace. Slots free when the credential expires or is revoked.
- The workspace advisory lock is taken **before** the count, in the one helper, on both mint and `create_agent_principal`. Mint skips the stream `FOR UPDATE`; this lock is what serialises mint vs mint and mint vs create.
- The table trigger refuses `seats_used` going up on an expired row.
- Revoke still returns one 403. The audit row now says `not_found` or `not_permitted`.

An attacker cannot uncount a live registrar or count a dead one without a code edit. IDs of hidden registrars never leave the mint response, so an expired-but-unrevoked registrar is not a usable extra seat.

Seats are **not** reserved at mint. That is safe **for this lane**: nothing spends a seat yet. Registration must call the same helper under the same lock. That is a requirement on the next lane, not a hole in this one.

## RIGOUR

**The lock pin is honest. It is enough for what it claims.**

I removed `pg_advisory_xact_lock` / `'principal-ceiling'`. Confirmed applied. Server file stayed **16/16 green**. The structural test failed (`0 !== 1` locks). Same as the commit says.

I moved the count before the lock. Structural failed: “the lock must be taken BEFORE the count”.

I made `create_agent_principal` count inline again. Structural failed: `2 !== 1` counts.

So: the six-mint test is **not** a lock test. The AST test **is**. It pins one `count(*)` on `swarm.agent_principals`, lock before that count, helper used twice. It does **not** pin the exclusion SQL, the lock key, or “helper before insert”.

**Green mutation the commit did not name.** I changed `expires_at <= statement_timestamp()` to `>`. Confirmed applied.

- Named expiry test stayed **green** (first create 200, second 403).
- Six concurrent mints went **red**: `accepted 5` (the 5-per-person cap), not 1.

The expiry test only proves **exactly one** of the two registrars is excluded. Invert live/dead and it still passes. The concurrent test is what proves a **live** registrar still holds a slot. The commit is wrong when it says that one sequence “proves both halves”.

**Other mutations (all confirmed applied, all went red as claimed):**

| Mutation | Result |
|---|---|
| Expired registrars counted again | Expiry test 403 on first create |
| All registrars excluded | Expiry test second create 200; concurrent accepted 5 |
| Per-person cap 100 | Cap test sixth mint 200 |
| Revoke always audits `not_found` | Audit test wanted `not_permitted` |
| Trigger expiry clause removed, `db:reset` | Seat update on expired row did not reject |

**Commit vs tree**

- “Pre-existing race in `create_agent_principal`”: overstated. One workspace stream per workspace (`one_workspace_stream`). Creates already take that row `FOR UPDATE` before they count. The new race is mint (no stream lock) vs mint/create. The new lock **does** close that.
- Expired registrars are uncounted, not revoked. Rows, devices, and runs stay. Hidden. Not a quota bypass.

Lock order is safe: ceiling first, then the per-name lock. Only create takes both. Mint takes ceiling only. Revoke takes neither (it only lowers the count). `hashtext('principal-ceiling')` colliding with a name is the same key twice in one transaction (re-entrant), not a deadlock.

## Gates (clean tree, real exit codes)

| Gate | Exit | Result |
|---|---|---|
| `npm run build` | 0 | ok |
| `env -u FORCE_COLOR npm test` | 0 | 874/874 |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 | 723/723 |
| `npm run check:tests` | 0 | ok |
| `npm run check:edge` | 0 | ok |
| `git diff --check main HEAD` | 0 | ok |
| join-credential server file | 0 | 16/16, then 16/16 again after restore |

No host-stderr flake. No dropped gateway. Nothing else ran in this worktree during a server file.

VERDICT: PASS — quota fixes hold; lock pin is honest; the expiry test does not prove both halves, but the concurrent test catches a live registrar going uncounted.
