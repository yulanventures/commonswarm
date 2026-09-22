- PRODUCTION — `deploy/supabase-stack/backup/README.md:118` and `deploy/supabase-stack/RUNBOOK.md:453`: The rollout does not stop both timers before replacing the code and units. An old backup can hold the old backup-only lock while a newly loaded restore drill takes the new shared lock. Both jobs then run together and can each report success. Stop both timers first, wait for both services to become inactive, install and reload the units, then start and verify both timers.

- RIGOUR — `deploy/supabase-stack/backup/test_restore_drill.py:266`: The shared-lock test checks strings only. Removing the restore-side `fcntl.flock`, changing it to a shared lock, or moving it after work begins still passes. The control must run both lock users against a temporary lock and prove the second exits 75 before doing work.

Local results: Python tests 18/18, marker Docker test 1/1, stack tests 13/13, and shell syntax checks passed. The activity SQL test could not run because local `initdb` is absent. No production service was contacted. No container or network remains.

VERDICT: FAIL — the documented live rollout can temporarily defeat the new shared lock, and its test does not prove mutual exclusion.
