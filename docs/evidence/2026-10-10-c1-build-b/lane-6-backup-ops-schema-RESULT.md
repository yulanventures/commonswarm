# Lane 6 result: STOPPED before any code change

HEAD 7efbb67df10abec01c624deb4e89a05a0badfc49 (matches base). No source file was edited.

## Facts re-checked at HEAD
All facts in section 3 of the brief hold (dump-source.sh:23, lib.sh:303, restore-drill.py:31-33/:69/:221,
upload-snapshot.py:19-21/:36/:126, fixtures in both test files). `backup_ro` has `pg_read_all_data` and
BYPASSRLS (postgres/10-runtime-roles.sh:44-45), so it can read `commonswarm_ops.migration_checksums`.

## Why I stopped
The counts file is produced in two more places than the brief names, and one of them is not an allowed file:

1. `deploy/supabase-stack/migrate/dump-source.sh:144` (allowed): a literal schema list in the counts query
   (a fifth copy of the list; it is not `selected_schema_csv`). It must change, or `commonswarm_ops.migration_checksums`
   never appears in `source-counts.tsv`.
2. `deploy/supabase-stack/migrate/verify-counts.sh:44` (NOT allowed): the restore drill step that runs
   `diff -u source-counts.tsv target-counts` with its own literal list without `commonswarm_ops`.
   Once (1) is fixed, the source file has a `commonswarm_ops.migration_checksums|N` line the target query never
   emits, so `verify-counts.sh` exits 1 ("row-count verification failed") on every restore drill.
3. Same literal list, also not allowed: `migrate/verify-post-upgrade-counts.sh:49` and
   `migrate/test-h0-upgrade.py:108`. These serve the H0 upgrade path, not the backup; they need a lead decision.

Doing only the allowed edits would make the production restore drill fail. Doing the edit to verify-counts.sh breaks
the rule "anything else is a STOP".

## Needed from the lead
Add `deploy/supabase-stack/migrate/verify-counts.sh` to the allowed files (one-line list change), and say whether
`verify-post-upgrade-counts.sh` and `test-h0-upgrade.py` stay unchanged. Better, replace the literal lists in
dump-source.sh:144 and verify-counts.sh:44 with `$(selected_schema_csv)` (unquoted heredoc needed) so the list
is typed once; the consistency test then needs to cover only the sources that remain.
Also: tests/p1-cli/supabase-stack.test.ts or n-db tests may pin the literal text; check before the edit.

Agent trailers: none, nothing to commit.

# Round 2: change made (HEAD 7efbb67d, uncommitted)

## Diff summary
- `migrate/lib.sh`: new `SELECTED_SCHEMAS=(… commonswarm_oauth commonswarm_ops)` array, the one bash copy; `selected_schema_csv` joins it.
- `migrate/dump-source.sh`: `schemas=("${SELECTED_SCHEMAS[@]}")`; counts query uses `$(selected_schema_csv)` (heredoc now unquoted; its only expansion is that one call, checked).
- `migrate/verify-counts.sh`: same replacement (lead decision 1 and 3).
- `backup/restore-drill.py`, `backup/upload-snapshot.py`: `commonswarm_ops` added to the frozenset; both now require `commonswarm_ops.migration_checksums` in the counts (new ValueError text in upload-snapshot).
- `backup/test_restore_drill.py`, `test_upload_snapshot.py`: fixtures use the new set and count; four new refusal tests (missing schema, missing count; each in both scripts).
- `backup/README.md`: the lead's one line (the README held no schema list, so nothing else to update).
- New `tests/p1-cli/backup-schema-set.test.ts` (consistency) and `tests/p1-cli/backup-python-unit.test.ts` (runs the three Python files).
- Unchanged by decision: `verify-post-upgrade-counts.sh:49`, `test-h0-upgrade.py:108`; named in the test's explicit exclusion constant with the reason "historical H0 upgrade path; FOLLOW-UPS-C1 #39 aligns or retires it before any reuse".
- No test or script pins the literal list text (grep of tests/ and scripts/ for the list: no match).

## Consistency test
Compares lib.sh array, both Python frozensets, and the baseline `schemas=` manifest fixture in each Python test file (the refusal fixtures lack commonswarm_ops on purpose, so only the first is compared). Checks dump-source.sh and verify-counts.sh derive from lib.sh. Scans every file under deploy/supabase-stack for 4+ known schema names in a row; any holder outside the sources, fixtures and the exclusion constant fails. Positive control in the same test: the scan must reach both excluded files.

## Mutation evidence (real files edited, then restored from copies; git status shows only intended changes)
1. Drop commonswarm_ops from restore-drill.py: `✖ the backup schema set is the same in every place…` "restore-drill.py differs from lib.sh".
2. Drop it from lib.sh: `✖ …` "lib.sh set lacks commonswarm_ops".
3. Add `deploy/supabase-stack/zz-fake.sh` with a five-name literal: `✖ no other file … holds a schema-list literal`.
4. Restored: all 3 tests `✔`. (The exit code of the piped run was not captured; the ✖/✔ lines are the evidence.)

## Gates
- Python unit tests, from a temp dir, `python3 -I -m unittest discover -s <backup dir> -p <file>`: restore_drill 21 OK, upload_snapshot 7 OK, notify_healthcheck 9 OK; exit 0 each. Deviation: `-I` with an absolute path argument fails ("No module named"), so I used `discover -p` per file; the TS wrapper does the same.
- `node --import tsx --test` on both new files (temp HOME via `env`): 6 pass, 0 fail.
- `bash -n` lib.sh, dump-source.sh, verify-counts.sh: exit 0 each. Sourcing lib.sh prints the 9-name CSV; sort of the array matches the old expected-list shape.
- `tsc --noEmit`: exit 0.
- `npm run check:tests`: exit 2 with 54 errors, the base count; none in the new files.
- `git diff --check`: exit 0.
- Not run: bash end-to-end dump/verify (needs Postgres/Docker).

Agent trailers: per `scripts/lib/agent-trailer-vocab.sh`; the lead writes them. Nothing committed.

This is a stack release input; production installs it in the C1 production sequence (HezLead ruling 17).

## Round 3 (review FAIL: 2 P1, 1 P2)

### P1 zero checksum rows
- `restore-drill.py` (`validate_artifact`) and `upload-snapshot.py` (`upload`) now require `commonswarm_ops.migration_checksums` to be a positive integer, before restoration and before the completion marker is written.
- New cases: `test_zero_migration_checksum_rows_are_refused` in both test files (valid manifest and regenerated hashes, count `0`; the drill makes no `docker create`, the upload makes no copy/copyto) and positive controls `test_positive_migration_checksum_rows_are_accepted` (count 7; drill exits 0, upload completes).
- Mutation (guard changed from `< 1` to `< 0`): both zero-count tests FAIL, exit 1 each. Guard restored: both files exit 0.

### P1 tests/hm5-router-box.test.ts (allowed for this audit only)
- The audit now reads `SELECTED_SCHEMAS` in lib.sh (must hold `commonswarm_oauth`), checks `selected_schema_csv` derives from `${SELECTED_SCHEMAS[*]}`, the dump-source.sh array is `("${SELECTED_SCHEMAS[@]}")`, and the counts queries in dump-source.sh and verify-counts.sh use `$(selected_schema_csv)`. The Python and H0 lists keep their per-list OAuth check.
- Mutation controls kept and adapted: removing the OAuth name fails for lib, verifyPostUpgrade, testH0Upgrade, upload and restoreDrill; replacing each derived reference with a literal fails for the dump array, dump counts, verify counts and the csv function.
- Focused run `node --import tsx --test --test-name-pattern='nightly backup and restore paths include the OAuth schema' tests/hm5-router-box.test.ts`: exit 1 on the old diff (4 errors: canonical list missing, dump/counts/verify lack commonswarm_oauth); exit 0 now (1 pass).
- Whole `tests/hm5-router-box.test.ts`: exit 0, 7 pass, 0 fail.

### P2 multi-line sixth copy
- The scan now runs on whole-file text, with a shape that also allows newlines, quotes and brackets between names. A new test, `the sixth-copy scan sees multi-line, CSV and quoted lists`, checks four literal forms and a negative control (three names plus prose).
- Mutations under `deploy/supabase-stack/` (exit codes): multi-line array 1; CSV 1; quoted list 1; fake file removed 0. Dropping `commonswarm_ops` from restore-drill.py: 1; restored: 0.

### Other tests that name the five files (run one by one)
box-dry-run.test.ts: exit 1, 64 pass / 44 fail. Every failure is the sandbox ("sandbox_apply: Operation not permitted", sandbox-exec cannot nest inside the worker sandbox; 44 hits for 44 failures). Its only reference to these files is a byte copy of run-backup.sh and restore-drill.py (line 8170). A baseline run in a `.git`-less HEAD archive could not complete, so there is no clean before/after; CI must run this file.
file-size-limit-agreement 0 (45 pass); admin-release-plan 0 (111); p1-cli/n-db-target-marker 0 (0 tests); p1-cli/n-db-cron-job-compare 0 (2); p1-cli/supabase-stack 0 (18); p1-cli/n-db-cron-jobs 0 (0 tests); p1-cli/backup-python-unit 0 (3); p1-cli/backup-schema-set 0 (4). p1-cli/helpers/compare-cron-job-listings-if.sh and tests/box-dry-run/fixtures/non-substitutable.json are not tests.

### Full validation (round 3)
Python from a temp dir via `discover -p`: restore_drill 23 OK, upload_snapshot 9 OK, notify_healthcheck 9 OK, exit 0 each. `bash -n` lib/dump/verify: 0. `tsc --noEmit`: 0. `check:tests`: exit 2, 54 diagnostics (base count). `git diff --check`: 0. Nothing committed.
