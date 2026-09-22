### Part Q2 of 7 Review: Restore Drill and Backup Tests

#### Scope & Unchecked External Dependencies
This review covers the diffs for:
- `deploy/supabase-stack/backup/restore-drill.py`
- `deploy/supabase-stack/backup/test_notify_healthcheck.py`
- `deploy/supabase-stack/backup/test_restore_drill.py`
- `deploy/supabase-stack/backup/test_upload_snapshot.py`

**Dependencies outside Part Q2 (evaluated in other parts):**
- Implementation of `upload-snapshot.py` and `notify-healthcheck.py` (Part Q1/Q3).
- Migration scripts invoked in Docker by `restore-drill.py`: `/work/migrate/restore-target.sh`, `prepare-target.sh`, `restore-cron-jobs.sh`, and `verify-counts.sh` (Part Q1/Q3/Q4).
- Database H0 migration sequence, target guards, and activity publish grant scripts (Parts Q3–Q6).
- Read edge and CLI agent field adjustments (Part Q7).

---

### Findings

#### [PRODUCTION] Hallucinated Cloudflare R2 Scoped Credential Scheme Breaks Real-World Drill Execution
- **File & Lines:** [`deploy/supabase-stack/backup/restore-drill.py:82-118`](file:///deploy/supabase-stack/backup/restore-drill.py#L82-L118), [`deploy/supabase-stack/backup/restore-drill.py:120-137`](file:///deploy/supabase-stack/backup/restore-drill.py#L120-L137), and [`deploy/supabase-stack/backup/restore-drill.py:319-323`](file:///deploy/supabase-stack/backup/restore-drill.py#L319-L323)
- **Concrete Sequence:**
  1. `restore-drill.py` attempts to generate isolated, read-only credentials for Cloudflare R2 by creating an in-memory HMAC-SHA256 JWT signed with the parent `secret_access_key`. It takes the SHA256 hex digest of the signed JWS as the `AWS_SECRET_ACCESS_KEY` (`digest`) and a base64 string `jwt/<signed_jws>` as the `AWS_SESSION_TOKEN` (`session`).
  2. In `fetch_offsite_bytes()`, `boto3.client('s3')` connects to the Cloudflare R2 endpoint (`endpoint_url=endpoint`) using `aws_access_key_id=acc_key`, `aws_secret_access_key=digest`, and `aws_session_token=session` to download object bodies.
  3. Cloudflare R2 is an S3-compatible object storage system that validates AWS SigV4 requests against the account's secret access key. It does not implement AWS STS or client-minted HMAC-JWT session tokens. Because `boto3` signs the SigV4 authorization header using `digest` rather than the actual R2 secret key, Cloudflare R2 rejects the request with HTTP 403 (`SignatureDoesNotMatch`).
  4. The same invalid credentials are passed into `cold-storage` (`storage_env` lines 321–323). When Supabase `storage-api` attempts to read backing objects from R2 via `@aws-sdk/client-s3`, R2 similarly rejects requests with 403.
  5. `fetch_offsite_bytes` raises `botocore.exceptions.ClientError`, causing `run_drill()` to fail.
- **What Production / Operator Sees:**
  The weekly restore drill fails on every run on `yulan-vps-1`. `restore-status.json` records `{"ok": false, "state": "failed", "error_type": "ClientError"}`. `notify-healthcheck.py` reads `ok=False` and sends a `/fail` alert to Healthchecks.io, triggering weekly false alerts for backup recovery failure.

---

#### [RIGOUR] Unit Tests Mock Out All S3/API Verification, Hiding Broken Production Integration
- **File & Lines:** [`deploy/supabase-stack/backup/test_restore_drill.py:53-55`](file:///deploy/supabase-stack/backup/test_restore_drill.py#L53-L55)
- **Concrete Sequence:**
  1. In `setUp()`, `test_restore_drill.py` patches `generate_temp_credentials`, `fetch_offsite_bytes`, and `fetch_api_bytes` with dummy return values.
  2. As a result, the test runner never executes the actual `generate_temp_credentials` token minting, never attempts a boto3 S3 API call, and never executes the node fetching logic inside `storage-api`.
- **What Production / Operator Sees:**
  `test_restore_drill.py` passes 100% in CI and local test runs, giving false assurance that cold recovery works, while the script deployed live on the VPS is non-functional.

---

#### [RIGOUR] Unbounded Workdir Disk Accumulation in `/var/backups/commonswarm-postgres/restore-drill`
- **File & Lines:** [`deploy/supabase-stack/backup/restore-drill.py:384`](file:///deploy/supabase-stack/backup/restore-drill.py#L384), [`deploy/supabase-stack/backup/restore-drill.py:407`](file:///deploy/supabase-stack/backup/restore-drill.py#L407)
- **Concrete Sequence:**
  1. For every drill, `workdir = Path(WORKDIR_BASE) / secrets.token_hex(16)` is created, and `rclone copy` downloads the entire database artifact directory (including the full uncompressed `database.dump`).
  2. `cleanup()` unlinks only credentials (`database.env`, `storage.env`, `pass`), leaving the copied database artifacts in `workdir` as evidence (`evidence=str(workdir)`).
  3. No retention or pruning logic exists in `restore-drill.py` to purge historical drill directories in `WORKDIR_BASE`.
- **What Production / Operator Sees:**
  With weekly runs, full database dumps accumulate indefinitely on the host filesystem at `/var/backups/commonswarm-postgres/restore-drill/`, eventually causing VPS disk exhaustion.

---

### Verification Against Review Criteria

1. **Backups & Restore Drill Safety and Isolation:**
   - **Protection of Production:** Safe. The drill creates an isolated Docker container `cold-db-<hex>` on an internal Docker bridge network (`--internal`) with no port bindings to the host. `assert_owned_db()` enforces that the container's IP is private, non-loopback, and explicitly not production (`172.31.0.10`).
   - **R2 / Offsite Copies:** Safe against overwrite. R2 sync operations are not used; `rclone copy` with `--immutable` is strictly local destination. In `test_upload_snapshot.py`, destructive operations (`delete`, `purge`, `sync`, `move`) are verified absent.
   - **Credentials & Leakage:** Passwords and JWT secrets are written to mode `0600` files inside mode `0700` directories (`umask 0077`), passed via `--env-file`, and unlinked during cleanup. No credentials appear in CLI args or process listings.
   - **Alerting on Failure:** In `notify-healthcheck.py` (verified via `test_notify_healthcheck.py`), any state other than clean, fresh success (`ok=True`, matching `invocation_id`, `SERVICE_RESULT=success`) sends a `/fail` ping. Delivery errors re-raise `OSError`.

2. **H0 Upgrade & Target Identity Guards (in `restore-drill.py`):**
   - Line 267 sets GUC parameters `commonswarm.stack_identity = 'n-db-target-v1'`, `commonswarm.local_rehearsal = '1'`, and `commonswarm.local_target_address = '{address}'`. Because `assert_owned_db` fails if `address == '172.31.0.10'`, target-identity checks prevent the rehearsal scripts from targeting the production database.

3. **Test Integrity (Docs vs Code):**
   - In `test_notify_healthcheck.py`: Tests verify that stale status, service failures, missing invocation IDs, and invalid URLs trigger `/fail` or raise exceptions.
   - In `test_upload_snapshot.py`: Tests for `missing-object`, `corrupt-object`, `partial-database`, and `wrong-marker` verify that failures prevent publishing `COMPLETE.json`.
   - In `test_restore_drill.py`: Fault injection tests verify that checksum mismatch, cardinality mismatch, address collisions, and cleanup failures abort the drill. However, happy-path test coverage is invalid due to mocking out the broken credential and R2 fetch functions.

---

VERDICT: FAIL - `restore-drill.py` implements a fictitious HMAC-JWT scheme for Cloudflare R2 credentials that is rejected with HTTP 403 `SignatureDoesNotMatch`, causing the live weekly restore drill to fail and fire false alerts.
