An operations review was conducted on the production release plan **`BOX-WINDOW.md` (v3 RETRY)** for CommonSwarm HM lane 6 (OAuth 2.1 authorization service `services/mcp-auth` and migration `20260928000003_hm_oauth_store.sql` at release SHA `ad964ed158181ba1692dd05895f36fa7a1f87d3f`), as specified in [local path path).

---

### Analysis & Verification Summary

1. **Measured Input Hashes & File Existence**:
   - Re-verified all 14 listed input hashes in `BOX-WINDOW.md` ([prompt.md#L139-L155](local path)) against the repository tree at SHA `ad964ed158181ba1692dd05895f36fa7a1f87d3f`:
     - [`deploy/RELEASE-TO-BOX.md`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/RELEASE-TO-BOX.md) (`7c8494d3ec952aa3206d39cb99b49835e5c37cfe53cc5f4de61b815952d7eda5`)
     - [`supabase/migrations/20260928000003_hm_oauth_store.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/supabase/migrations/20260928000003_hm_oauth_store.sql) (`e6f6944154b01e7f80a366058754639700c81279cfec4eaff6fe601a6ad99638`)
     - [`deploy/release-proofs/item-hm/20260928000002-catalog.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000002-catalog.sql) (`83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144`)
     - [`deploy/release-proofs/item-hm/20260928000003-catalog.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-catalog.sql) (`5d65f11724b31dadceea089c010eea3ee641d4eb1582f9e9cf0ac3e674c88243`)
     - [`deploy/release-proofs/item-hm/20260928000003-functional.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-functional.sql) (`4c23fbd14ad2a04c9a74900b4bff097e42a239bf8847dcdd32b7426a678cac91`)
     - [`deploy/release-proofs/item-hm/20260928000003-rollback.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-rollback.sql) (`f6337cda45a8db86f4d2aa4e8e658e09125d5e3e2c2aa137519240e50a82a20f`)
     - [`deploy/release-proofs/item-hm/20260928000003-rollback-catalog.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-rollback-catalog.sql) (`c37b9be8c3cd69bfc82e8e67f3955d31b0f6c395aa592b46d1ce556a2b536d1d`)
     - [`deploy/release-proofs/item-hm/20260928000003-diagnostic.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-diagnostic.sql) (`101a014db0bbe7efbe7505c5efe04ded78637bc11bcb16a99964388d02d318e8`)
     - [`deploy/release-proofs/item-hm/20260928000004-catalog.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-catalog.sql) (`1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1`)
     - [`deploy/release-proofs/item-hm/20260928000004-functional.sql`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000004-functional.sql) (`26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659`)
     - [`services/mcp-auth/Dockerfile`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/services/mcp-auth/Dockerfile) (`02c355aafe8b90ffd6e1c7bb636f60d5d5ca7850e15b7b1c5543fb558484a66a`)
     - [`services/mcp-auth/package-lock.json`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/services/mcp-auth/package-lock.json) (`08da8a06cb5723641bca72967cbad5e52b0b91d29cf29b459d1bad496a1be1bd`)
     - [`deploy/mcp-auth/compose.yaml`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/mcp-auth/compose.yaml) (`4ca9f55899d84f52744030f12bc23dfe5429d87f150d6bbd18f5efe871beef2c`)
     - [`deploy/supabase-stack/commonswarm-mcp.caddy`](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/supabase-stack/commonswarm-mcp.caddy) (`c00c3ee1a4331335a7c078848c490a827afcb517bf5f94b729396c68e42f16f1`)
   - All 14 listed file hashes match the repository files perfectly.

2. **Step Formatting & Execution Locations**:
   - All 18 executable shell blocks in `BOX-WINDOW.md` use proper Markdown fenced code blocks (` ```sh `) starting with `# step: <id>` as required by `deploy/RELEASE-TO-BOX.md`.
   - Mac mini scripts (`# step: hm6-transfer-old-archive-for-verification`, `# step: hm6-create-and-read-back-dns`, `# step: hm6-probe-nonbrowser-ingress`) adhere strictly to macOS `/bin/bash` 3.2 compatibility: no heredocs inside `$()`, no associative arrays (`declare -A`), no `${var,,}`, no `mapfile`, no `|&`, no `&>>`, and no `wait -n`.

3. **Step Ordering & Preconditions**:
   - **Database Preconditions**: Precondition migration `20260928000002` is verified read-only first in step `hm6-prove-database-preconditions` ([prompt.md#L573-L584](local path)) before migration `20260928000003` is attempted.
   - **Backup Helper Activation**: Stack backup helpers are activated via the guarded stack switch in Step 6 ([prompt.md#L184](local path)) prior to executing migration `20260928000003`.
   - **Container Database & TLS Verification**: In-container getent hostname resolution and TLS identity are verified in step `hm6-prove-runtime-database` ([prompt.md#L905-L968](local path)) before HTTP listeners are started in step `hm6-start-dark-service`.
   - **DNS & Ingress**: Proxied DNS creation and readback ([prompt.md#L1102-L1191](local path)) occur prior to Caddy activation in step `hm6-install-reviewed-caddy` ([prompt.md#L1233-L1255](local path)).

4. **Database Catalog & Post-Apply Backup Contracts**:
   - `20260928000003-catalog.sql` evaluates cleanly to `catalog_ok = f` without relation or function errors prior to migration apply because object references use guarded `to_regnamespace`, `to_regclass`, and `to_regprocedure` checks ([20260928000003-catalog.sql#L19-L31](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-catalog.sql#L19-L31)).
   - Post-apply backup coverage proof step `hm6-prove-post-apply-backup-coverage` ([prompt.md#L1412-L1499](local path)) strictly validates `manifest.txt`, `pg_restore --list` entries, and `source-counts.tsv` for the `commonswarm_oauth` schema and all 6 target tables, preventing premature completion without schema contents.

5. **Rollback Integrity**:
   - Step `hm6-run-verbatim-reviewed-rollback` ([prompt.md#L1551-L1583](local path)) verifies that `20260928000003-rollback.sql` and `20260928000003-rollback-catalog.sql` match the repository tree verbatim (`cmp -s`) before executing the transaction.

---

### Findings & Nits

- **KEEP (Production-blocking defects)**: None found.
- **NITS**:
  - In step `hm6-run-verbatim-reviewed-rollback` ([prompt.md#L1575-L1582](local path)), after `release_psql --file /proof/20260928000003-rollback.sql` completes (which internally executes `\ir 20260928000003-rollback-catalog.sql` at [20260928000003-rollback.sql#L128](file:///private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/alloy-hmread/deploy/release-proofs/item-hm/20260928000003-rollback.sql#L128)), the script executes a second, redundant read-only query running `\i /proof/20260928000003-rollback-catalog.sql`. This is harmlessly idempotent and does not affect correctness or safety.

---

VERDICT: PASS (no KEEP)