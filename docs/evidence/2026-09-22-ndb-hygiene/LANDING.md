# N-db hygiene landing (2026-09-22)

Lane `lane/ndb-hygiene`: c7542599 (the five RIGOUR items the N-db landing listed) and 699ae241 (review folds), both by a
Grok Maker. Merged to main with `git merge --no-ff`. NOT DEPLOYED: the box still runs the N-db release; the operator steps
to apply the unit changes are in `deploy/supabase-stack/backup/README.md` and the RUNBOOK (stop both timers, wait until
both services are inactive, switch the release and copy the four unit files, daemon-reload, start both timers, check
`systemctl list-timers`).

## What changed

1. The target-identity gate reads the database-level marker (`pg_db_role_setting`, `setrole = 0`), so a connection option
   can no longer fake it; `make-pg-service.mjs` refuses an `options` URL parameter. Docker test
   `tests/p1-cli/n-db-target-marker.test.ts`.
2. `prepare-target.sh` logs what its SQL does (grants three roles; other memberships are not revoked, as
   `ACTIVITY-PUBLISH.md` requires).
3. A test pins the restore drill's temporary storage access scope to `object-read-only`.
4. Backup and restore units: `docker.service` ordering, one shared lock (the second job exits 75 before any work), the
   restore timer names its unit like the backup timer, and the drill keeps its current work directory plus one earlier run.
5. The activity publish grant refuses to run when row security is off on `realtime.messages` (SQLSTATE 55000).

## Review (arms/), one pair on c7542599 (Grok Maker, so antigravity and Codex)

- antigravity: PASS, two notes: retention counted the current run (now stated), and the grant log is pinned by a test.
- Codex: FAIL. PRODUCTION claim: the rollout did not stop both timers first, so during the switch an old backup (old lock)
  and a new drill (new lock) could run at once. RIGOUR: the lock test checked strings only. The lead ruled both RIGOUR:
  the overlap is possible once, during the rollout, and puts no data at risk (the drill restores into an isolated
  container; the backup only reads). Both fixed in 699ae241; the new lock test runs two real processes and fails under
  three mutations (flock removed, made shared, moved after the work starts).

## Gates at 699ae241 (Maker)

`npm run build` 0; `npm test` 893 pass; `npm run test:p1-cli` 821 pass; `check:tests` 0; backup Python tests 33 passed
(pytest in a temporary virtualenv); `git diff --check` 0.

## Not established

- No live backup or drill ran with these changes; nothing was applied on the box.
- The source-side and backup-role checks still read `current_setting()` for their own values; only the target write gate
  reads the database row.
