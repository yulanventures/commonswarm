# Operations Review: CommonSwarm HM Lane 6 Production Plan (`boxplan-hm6-v5.md`)

This read-only operations review evaluates `boxplan-hm6-v5.md` at release SHA `826db6a34f235064a3a03c57377d8e32a35d2f05` against the production requirements and verification guardrails outlined in `local path`.

---

## Detailed Evaluation of Plan & Verification Guardrails

### 1. Retention & Non-Re-application of Migration 03 (DONE Steps)
- **Check**: Migration `20260928000003` is already APPLIED (ledger `1`, catalog `t`) and kept from the v3/v4 windows.
- **Verification**: In `# step: hm6-verify-retained-migration-state` (lines 683–718), the plan runs a strictly read-only catalog check (`release_psql_ro -Atq --file /run/commonswarm-release-apply.sql`) verifying `version = '20260928000003'` in `schema_migrations` and `catalog_ok`. It does not attempt to re-apply the migration file.

### 2. Step Ordering & Preconditions (NOT-DONE Steps)
- **Order Verification**:
  - **Runtime Proof before HTTP**: Step 14 `# step: hm6-prove-runtime-database` (line 1159) runs before Step 15 `# step: hm6-start-dark-service` (line 1231).
  - **DNS before Caddy**: Step 18 `# step: hm6-create-and-read-back-dns` (line 1426) runs before Step 21 `# step: hm6-install-reviewed-caddy` (line 1602).
  - **Non-browser Test right after Caddy**: Step 22 `# step: hm6-probe-nonbrowser-ingress` (line 1683) runs immediately after Caddy installation & reload in Step 21.
  - **Block Inventory**: All 27 runnable shell blocks are formatted as standalone ```sh blocks starting with `# step: <id>` and match their referenced names in the plan text.

### 3. Image Verification & Base Digest / Layer-Prefix Proofs
- **Check**: `# step: hm6-build-retry-image` (lines 783–901) inspects and verifies image `sha256:5511a358...`:
  - Executes `docker pull "$BASE_REFERENCE"` for `node:22.23.3-bookworm-slim@sha256:43ac6c6...`.
  - Verifies base image `RepoDigests` match the base digest (`base_digest = base.rsplit('@', 1)[1]`).
  - Verifies the 5-layer RootFS prefix (`assert len(base_layers) == 5` and `assert image_layers[:len(base_layers)] == base_layers`).
  - Reuses image `5511a358...` when all checks pass, and falls back to `docker build --pull=false` only if verification fails.
  - Inspects and retains prior image `sha256:208fe56d...` without deleting it.

### 4. File-Policy Proof (CA & Weak Secrets)
- **Check**: `# step: hm6-prove-runtime-file-policy` (lines 1101–1153) runs inside the container as non-root UID/GID `996:986`:
  - Asserts `/etc/ssl/yulan-internal-ca.pem` is root-owned mode `0644` and verifies `await assert.doesNotReject(loadConfig())` succeeds with it.
  - Passes mode `0644` files for `MCP_OAUTH_SIGNING_KEYS_FILE`, `MCP_OAUTH_COOKIE_KEYS_FILE`, and `MCP_OAUTH_DATABASE_CREDENTIALS_FILE` and asserts `loadConfig()` rejects them with `/path must be a file with no permissions for other users/`.

### 5. Caddy Ingress & Access Log Pre-Creation
- **Check**: `# step: hm6-install-reviewed-caddy` (lines 1602–1665):
  - Resolves `$CADDY_LOG` under `/var/log/caddy/`.
  - Pre-creates the file with `install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG"` (or asserts `caddy:caddy 0600` if present) **before** executing `runuser -u caddy -- caddy validate`.

### 6. Input Hashes Alignment
- **Check**: All 15 SHA-256 hashes listed in Section *Measured input hashes* (lines 150–170) match the repository files:
  - `deploy/RELEASE-TO-BOX.md` (`791d57fb...`)
  - `supabase/migrations/20260928000003_hm_oauth_store.sql` (`e6f69441...`)
  - `services/mcp-auth/Dockerfile` (`02c355aa...`)
  - `services/mcp-auth/src/config.js` (`56bda1ae...`)
  - `deploy/mcp-auth/compose.yaml` (`4ca9f558...`)
  - `deploy/supabase-stack/commonswarm-mcp.caddy` (`5f48dab0...`)
  - All proof catalog/functional/rollback SQL files.

### 7. Execution Block Syntax & Mac mini Compatibility
- **Check**: All `# step: <id>` runnable blocks pass bash syntax checks.
- **Mac mini Compatibility**: Mac steps (`hm6-transfer-continuation-archive`, `hm6-verify-vault-secret-readback`, `hm6-create-and-read-back-dns`, `hm6-probe-nonbrowser-ingress`, `hm6-probe-after-restart`) run under `/bin/bash 3.2` without bash 4 syntax or heredocs inside command substitutions `$(...)`.

### 8. Embedded Python Scripts
- **Check**: All embedded Python snippets across all steps compile cleanly with `python3` and follow standard library constructs (`json`, `hashlib`, `pathlib`, `urllib`, `subprocess`, `stat`, `os`).

### 9. Rollback Governance
- **Check**: Rollback logic retains migration 03 by default. `# step: hm6-run-verbatim-reviewed-rollback` (lines 2096–2127) requires HezLead's explicit approval, an empty database state (all 6 tables empty and no runtime sessions), and execution of `20260928000003-rollback.sql` verbatim with its rollback catalog.

### 10. v5 Continuation Baseline & Copy-Back Manifest
- **First Step Manifest**: Step 1 `# step: hm6-open-continuation-window` (lines 302–374) creates `$PROOF_DIR/copy-back.list` as `root:root:600` in the first box step.
- **Explicit Caddy Setting**: `MCP_CADDY_SITE=/etc/caddy/sites/20-commonswarm-mcp.caddy` is set in `window.env` and validated in multiple steps before rendering/installation.
- **Baseline Expectation**: Explicitly expects and asserts the exact rolled-back v4 baseline (retained migration 03, live helpers, releases & images retained; absent service, Caddy site, DNS record, GoTrue callback, and OAuth `current` symlink).

---

## Style & Nits

- **Nit 1**: In Step 10 `# step: hm6-build-retry-image` (line 808), `RECORDED_IMAGE="$(python3 ... <<'PY'...PY)"` uses command substitution around a heredoc on the box step. While fully supported by Linux bash on the box, avoiding command substitution around heredocs enhances readability and cross-platform consistency.

---

VERDICT: PASS (no KEEP)