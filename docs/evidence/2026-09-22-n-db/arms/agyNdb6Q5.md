### Part Q5 of 7: Cron-Compare and Stack Tests

---

### External Dependencies Not Checkable in this Part
Because Part Q5 contains only the test files and `package.json` test targets, the following implementations are reviewed in their respective parts:
- [`deploy/supabase-stack/migrate/lib.sh`](file:///deploy/supabase-stack/migrate/lib.sh): implementation of `compare_cron_job_listings`.
- [`deploy/supabase-stack/migrate/restore-cron-jobs.sh`](file:///deploy/supabase-stack/migrate/restore-cron-jobs.sh) and [`deploy/supabase-stack/migrate/verify-counts.sh`](file:///deploy/supabase-stack/migrate/verify-counts.sh): caller scripts calling `compare_cron_job_listings`.
- [`deploy/supabase-stack/docker-compose.yml`](file:///deploy/supabase-stack/docker-compose.yml): PostgREST native `--ready` command and `PGRST_SERVER_HOST: "0.0.0.0"` service definition.
- [`deploy/supabase-stack/migrate/prepare.sh`](file:///deploy/supabase-stack/migrate/prepare.sh): script layout where `assert_target_identity` precedes `ALTER/CREATE ROLE`.
- [`deploy/supabase-stack/migrate/test-h0-upgrade.py`](file:///deploy/supabase-stack/migrate/test-h0-upgrade.py) and [`test-post-upgrade-counts.py`](file:///deploy/supabase-stack/migrate/test-post-upgrade-counts.py): H0 upgrade verification test scripts.
- PRs #18, #19 (backups and restore drill), #21 (activity publish grant), and #22 (read edge / CLI fields).

---

### 1. Backups and Restore Drill Isolation
- The test scripts added or modified in Part Q5 (`n-db-cron-job-compare.test.ts`, `n-db-cron-jobs.test.ts`, and `supabase-stack.test.ts`) run strictly in isolated local environments:
  - `n-db-cron-job-compare.test.ts` operates entirely in disposable `mkdtemp` directories (`/tmp/ndb-cron-compare-*`).
  - No network egress, AWS/R2 credentials, or production connection strings are used or exposed.
  - Test helper [`compare-cron-job-listings-if.sh`](file:///tests/p1-cli/helpers/compare-cron-job-listings-if.sh) only reads `$EXPECTED` and `$ACTUAL` listing files and performs local sorting and diffing.

---

### 2. H0 Upgrade and Verification Guards
- In [`tests/p1-cli/supabase-stack.test.ts:531-544`](file:///tests/p1-cli/supabase-stack.test.ts#L531-L544), `migrationErrors` enforces that in `prepare.sh`, the `assert_target_identity` guard must appear before any `ALTER ROLE` or `CREATE ROLE` statement (`guard < roleMutation`).
- This test gate prevents regression where role mutations could be executed against an incorrect database before target identity verification completes.
- [`package.json`](file:///package.json#L39-L40) wires `test:h0-upgrade:local` and `test:h0-counts` to run the upgrade and post-upgrade count verification scripts.

---

### 3. Activity Publish Grant Scope
- No changes to database grants or RLS policies are present in Part Q5 (handled in Part Q4 / #21).

---

### 4. Read Edge and CLI Fields
- No read edge functions or CLI field mappings are modified in this diff (handled in Part Q6 / #22).

---

### 5. Test Validity & Failure Mode Analysis

#### [`tests/p1-cli/n-db-cron-job-compare.test.ts`](file:///tests/p1-cli/n-db-cron-job-compare.test.ts)
1. **Multiset collation comparison**:
   - Accurately reproduces the bug where collation differences sort `_` (ASCII `0x5F`) and `-` (ASCII `0x2D`) in opposite orders.
   - Proves old behavior failed by asserting `oldDiff.status === 1`.
   - Confirms bidirectional equivalence (`compare(hyphen, underscore)` and `compare(underscore, hyphen)` both exit 0).
   - Verifies the source artifact is never rewritten (`assert.equal(await readFile(hyphenFile, "utf8"), hyphenText)`).
2. **Rejection of invalid listings**:
   - Specifically rejects altered schedules, omitted jobs, surplus jobs, and duplicate count drift.
   - Specifically tests identical line counts with differing multiplicity (e.g. 2 copies of job A vs 2 copies of job B), verifying that deduplication (`sort -u`) is not used and that multiset line counts are strictly preserved.
   - Tests empty listing boundaries (`empty vs empty` passes; `empty vs oneJob` fails).
3. **Failure propagation and error handling**:
   - Tests missing file and unreadable file scenarios.
   - Injects mock `sort`, `mktemp`, and `chmod` binaries returning non-zero codes to verify that failures are caught with specific error messages.
   - Verifies that upon failure, temporary sort files (`commonswarm-cron-*`) are cleaned up and not leaked into `TMPDIR`.

#### [`tests/p1-cli/n-db-cron-jobs.test.ts:130-145`](file:///tests/p1-cli/n-db-cron-jobs.test.ts#L130-L145)
- Reverses line order of exported `cron-jobs.ndjson` before invoking `restore-cron-jobs.sh`.
- Asserts that restore matches the full set (`/4 cron jobs match cron-jobs\.ndjson/`), exits 0, and preserves the artifact on disk without rewriting.

#### [`tests/p1-cli/supabase-stack.test.ts`](file:///tests/p1-cli/supabase-stack.test.ts)
- **PostgREST Readiness**:
  - `validateStack` asserts `test: ["CMD", "/bin/postgrest", "--ready"]` and `PGRST_SERVER_HOST: "0.0.0.0"`.
  - Negative mutation tests verify that changing `--ready` to `--live` or modifying `PGRST_SERVER_HOST` fails validation with the exact expected error tokens.
- **Migration Safety Controls**:
  - 10 negative mutation tests enforce all cron comparator requirements: comparator existence in `lib.sh`, use in `verify-counts.sh` and `restore-cron-jobs.sh`, absence of raw `diff -u`, caller invocation under `if !`, avoidance of grep masking (`|| true`), and explicit error handling for `sort`, `mktemp`, and `chmod`.
  - All tests can fail for the reasons claimed.

---

### Findings

#### [RIGOUR] [`tests/p1-cli/supabase-stack.test.ts:678-681`](file:///tests/p1-cli/supabase-stack.test.ts#L678-L681)
- **Concrete Sequence**: In `test("migration safety controls reject their named mutations")`:
  ```typescript
  ["cron verify comparator", { ...original, verify: verifyCounts.replace("compare_cron_job_listings", "diff -u") }, /cron verify comparator/],
  ["cron restore comparator", { ...original, restoreCron: restoreCronJobs.replace("compare_cron_job_listings", "diff -u") }, /cron restore comparator/],
  ```
  Mutating `compare_cron_job_listings` to `diff -u` simultaneously triggers both the missing comparator check (`cron verify comparator`) and the explicit bytewise diff check (`cron verify bytewise diff`).
- **What an Operator/CI Sees**: The assertion passes because `/cron verify comparator/` matches within the composite error string (`"cron verify comparator, cron verify bytewise diff, cron compare if-not caller"`). However, the mutation does not test the missing comparator in isolation from the bytewise diff prohibition (unlike the `lib` mutation which replaces the token with `removed_compare`).
- **Impact**: Zero production impact; test remains strict and rejects the regression.

---

VERDICT: PASS Part Q5 cron-compare and stack tests are rigorous, Collation-independent, verify error handling and cleanup, and include comprehensive negative mutation guards.
