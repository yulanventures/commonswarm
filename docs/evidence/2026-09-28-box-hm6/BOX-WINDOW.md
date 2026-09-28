# HM lane 6: dark OAuth service box window — v2

**Status: PLAN. This document does not establish execution, approval or closure of the HM6 window.**

**Release SHA: `9fa4217da9f6447e55fb8c6d577b8fd3997f926b`.**

**HM2 is live:** run 4 applied migration `20260928000002` and released edge `72c57e0d76d0aa86fe4f811a2cf51499919fed20` on 2026-09-28. Evidence was committed in `ffccd29c3e380f59a399d0d0887d9760c72f9e4f`. Retain the read-only dependency check below; it must pass. This window does not apply or repair HM2.

Anvil executes all Mac mini, box, Cloudflare and 1Password operations. HezLead approves the exact inputs, transitions, backup age, recovery proof and rollback; HezLead closes the window. CSwarmDevLead supplies reviewed inputs and reconciles evidence.

## Governing procedure

Follow [`deploy/RELEASE-TO-BOX.md`](../../../deploy/RELEASE-TO-BOX.md), including sections 1–3, 5, the guarded stack switch in section 7, section 8 and section 9 cleanup. Host operations also follow workspace `hetzner-handoff/HETZNER-OPERATIONS.md`.

The service contract is defined by:

- [`deploy/mcp-auth/compose.yaml`](../../../deploy/mcp-auth/compose.yaml)
- [`deploy/mcp-auth/env.example`](../../../deploy/mcp-auth/env.example)
- [`deploy/mcp-auth/RUNBOOK.md`](../../../deploy/mcp-auth/RUNBOOK.md)
- [`deploy/mcp-auth/VERIFICATION.md`](../../../deploy/mcp-auth/VERIFICATION.md)
- [`docs/design/2026-09-27-HM-LANE-PLAN.md`](../../design/2026-09-27-HM-LANE-PLAN.md), §§4.6, 4.7 and 7.

Runbook steps incorporated by reference remain required. Execute only the approved surface and migration decisions specified here. Every runnable block in this document has a unique step identifier and states its execution location. Mac mini blocks run under `/bin/bash` 3.2. No block nests a heredoc inside command substitution.

On failure, stop the stage, record the actual state and perform the runbook’s abort cleanup. Do not create success files for work that did not complete.

Never enable shell tracing, print complete environment files, inspect complete container environments, print credentials or private keys, or include secrets in arguments, logs or evidence.

## Measured release identity and scope

Read-only inspection of the supplied repository established:

| Fact | Result |
|---|---|
| Checked-out `HEAD` | `9fa4217da9f6447e55fb8c6d577b8fd3997f926b` |
| Locally recorded `origin/main` | Same SHA |
| Working tree | Clean |
| Merge subject | `Merge lane/hm6-land: OAuth release readiness and database host (item HM, lane 6)` |
| First parent | `db662507030f9f2a1374d7c3cae9a59352218a32` |
| Current remote ancestry, exact-SHA review acceptance and gate results | Not established by this inspection |
| Most recent recorded edge release | `72c57e0d76d0aa86fe4f811a2cf51499919fed20` |
| Most recent recorded active stack release | `e38b499fc29a01935333e38f66c4e68ac7e1f81e` |

The last two facts come from [HM2 run 4 close readback](../2026-09-28-release-72c57e0d76d0-rerun-4/close-readback.txt). Its [run log](../2026-09-28-release-72c57e0d76d0-rerun-4/run.log) records migration 02 ledger/catalog/functional success, unchanged stack current, restored timers and closure. Re-measure live state before changes.

The archive carries more than this window releases:

| Carried content | This window’s disposition |
|---|---|
| HM6 service, Dockerfile, lockfile, configuration and tests | Build and release the separate OAuth service, dark |
| `20260928000003_hm_oauth_store.sql` and reviewed proofs | Apply migration 03 only |
| OAuth-inclusive backup, restore and restore-drill helpers | Make them live through the guarded stack switch before migration 03 |
| OAuth-only `commonswarm-mcp.caddy` | Install after substituting only the measured port |
| GoTrue callback example | Append the callback to the actual live allowlist |
| HM3 `src/protocol/hosted-check.ts`, protocol bundle, hosted-seat authentication and command changes | Do not release the edge or CLI |
| `20260928000004_hm_hosted_check.sql` and proofs | Explicitly defer to the HM3 window |
| HM2 catalog correction, window-plan corrections and release evidence | Use applicable corrected proofs and procedure |
| Earlier client, listener, site, H0, migration and ingress changes carried beyond the old stack archive | Inventory them; do not infer deployment from archive presence |

Compared with the recorded live stack release, `compose.yaml`, `postgres/` and the four backup/restore unit files have no repository changes. Backup and migration helpers do change. Other stack-directory differences include API/maintenance Caddy files, removal of the fallback Caddy file, environment examples and documentation. This window does not install those unrelated Caddy changes.

Compared with live edge `72c57e0d`, this SHA carries HM3 command/authentication/protocol changes. The edge-runtime deployment directory itself has no intervening diff, but a new edge archive would contain changed function code. **Do not release it.**

The edge remains at `72c57e0d76d0aa86fe4f811a2cf51499919fed20`. The lane 7 MCP resource function is outside this window. `/mcp` and its protected-resource metadata remain dark. No site, CLI package, public authorization or real-client interoperability is released or claimed.

## Decisions and remaining measurements

| Item | Disposition |
|---|---|
| OAuth image | Anvil builds it on the box, from this archive, inside the window and before switching either release path. Use the resulting local image ID; no application-image registry publication or pull |
| Base image | `node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c` |
| Dependencies | Archived `services/mcp-auth/package-lock.json`; Dockerfile runs `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`; `oidc-provider` is exactly `9.12.2` |
| Database hostname | HezLead-confirmed `db.commonswarm.internal` |
| Database address | HezLead-confirmed `172.31.0.10`, supplied through Compose `extra_hosts` |
| Database port | `5432` |
| Database CA | Host `/etc/ssl/yulan-internal-ca.pem`, mounted read-only at the same container path |
| Database certificate | HezLead reports SAN `DNS:db.commonswarm.internal` and `IP:172.31.0.10`; repeat the runtime proof |
| TLS | `config.js` supplies the CA and `rejectUnauthorized: true`; prove hostname verification from the actual runtime container |
| Live database name, GoTrue provider, free port, DNS/rule identities, origin certificate and existing OAuth installation | Not established; measure before dependent changes |
| Exact-SHA gate results and isolated recovery acceptance | Not established; supply and approve evidence |

The build needs no signing key, cookie key, database password, build secret, SSH forwarding or private registry credential. The pinned public base and locked public npm dependencies still need to be available to the builder; “no registry” here means no separately published OAuth application image. Do not introduce secret-dependent build inputs.

The Compose comment asks for a registry-style digest reference, but its interpolation accepts an image reference. HezLead’s IMAGE (a) decision selects the immutable local `sha256:<image-id>` instead. Validate that exact reference with the installed Compose version and use `--pull never`.

The prose in `RUNBOOK.md` and `VERIFICATION.md` still groups the CA under `/etc/commonswarm-oauth/`. The actual Compose file and confirmed database decision use `/etc/ssl/yulan-internal-ca.pem`. Follow that mounted path; do not create an unused alternate CA copy.

## Order and approvals

| Order | Stage |
|---:|---|
| 0 | Approve exact SHA, gates, backup maximum age, HM3 deferral, image decision, recovery acceptance procedure and window timing |
| 1 | Run section 1: archive, checksums, immutable stack directory, manifest and durable window state |
| 2 | Run sections 2–3; verify HM2, first-install HM6 baseline, deferred HM3 state and complete pre-change backup |
| 3 | Prepare immutable OAuth release and build the local image; prepare protected account/key/configuration inputs |
| 4 | Review stack differences; guarded switch makes new backup/restore helpers live; no stack-container restart |
| 5 | Apply migration 03 through section 5; verify catalog, functional, privileges and empty cron deltas |
| 6 | Complete runtime password provisioning; prove in-container resolution and verified TLS before starting HTTP |
| 7 | Start the dark OAuth service; verify runtime controls and loopback probes |
| 8 | Append GoTrue callback; recreate only GoTrue if its environment changed |
| 9 | Install rendered OAuth-only Caddy site; verify certificate, DNS and hostname-scoped Cloudflare rules |
| 10 | Public probes, controlled OAuth restart, post-apply complete backup and isolated recovery acceptance |
| 11 | Reconcile unchanged edge, deferred migration 04, timers, cleanup and manifest-only copy-back; HezLead closes |

No CommonSwarm control, seed or proof principal is needed. The OS service account and 1Password item names use the one `WINDOW_PRINCIPAL_SUFFIX` saved by the box from `WINDOW_START_UTC`. A rerun uses a fresh window and unused names. Stop on any collision; never recycle a name.

`commonswarm_oauth_runtime` is the fixed role defined by the reviewed migration, not a minted control principal.

No `cswarm` credential JSON is read by these steps. If an approved control is subsequently added, it must read the real 0.1.80 fields `agent_token`, `principal_id`, `token_id` and `run_id`, rejecting every missing, empty or non-string field without printing the credential. Follow the [HM2 plan](../2026-09-28-box-hm2/BOX-WINDOW.md) and [`tests/hm2-box-window-plan.test.ts`](../../../tests/hm2-box-window-plan.test.ts); never substitute a guessed `token` field.

## Section 1 inputs, gates and manifest

Use these inputs in the current runbook’s section 1:

| Input | Value |
|---|---|
| `SHA` | `9fa4217da9f6447e55fb8c6d577b8fd3997f926b` |
| `KIND_LIST` | `stack` |
| `H0_LEDGER_BACKFILL` | `no` |
| `GUARDED_STACK_SWITCH` | `yes` |
| `BACKUP_STATUS_PROOF` | `yes` |
| `MIGRATION_VERSIONS` | `20260928000003`, `20260928000004` — the expected complete pending inventory |
| `FUNCTIONAL_VERSIONS` | `20260928000003` only |
| Apply decision | Migration 03 |
| Deferred decision | Migration 04, HM3; retain in the pending inventory |
| Expected cron additions/removals | Both empty |

Section 5 requires a proof and decision for every pending migration. Record HezLead’s explicit deferral of 04 before opening; do not filter it out of `pending-versions.txt`, insert a ledger row for it or run its functional proof against an unapplied schema. If that disposition is not accepted, stop before changes.

Supply exact-SHA gate evidence, including the mandatory result lines:

- `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS`
- `npm run check:edge: PASS`

Also require OAuth unit/security, PostgreSQL adapter/refresh, Docker acceptance, and backup/restore coverage results. Relevant sources include `services/mcp-auth/test/`, `services/mcp-auth/test-postgres/`, `tests/p1-cli/mcp-auth-container.test.ts`, `tests/hm5-router-box.test.ts` and `deploy/supabase-stack/backup/test_*.py`. `.github/workflows/server-suite.yml` wires OAuth unit/PostgreSQL tests into its `server` selection. Test files and workflow definitions do not establish a passing run.

Use the current manifest generator. Add these exact item paths through `ITEM_COPY_BACK_FILES`:

- `20260928000002-catalog.sql`
- `20260928000003-rollback.sql`
- `20260928000003-rollback-catalog.sql`
- `hm2-precondition.txt`
- `hm6-baseline.txt`
- `hm3-deferred-before.txt`
- `hm3-deferred-after.txt`
- `migration-dispositions.txt`
- `hm6-privileges.txt`
- `hm6-default-acl-before.json`
- `hm6-default-acl-after.json`
- `hm6-applied-at.txt`
- `stack-runtime-review.txt`
- `backup-unit-paths.txt`
- `backup-gate-before.txt`
- `backup-requested-at.txt`
- `oauth-backup-coverage.json`
- `oauth.SHA256SUMS`
- `oauth-image.json`
- `oauth-port.txt`
- `oauth-runtime.json`
- `oauth-database-proof.txt`
- `oauth-local-probes.json`
- `oauth-public-probes.json`
- `oauth-restart-probes.json`
- `gotrue-allow-list.json`
- `oauth-caddy-rendered.caddy`
- `oauth-caddy.diff`
- `oauth-ingress-facts.json`
- `oauth-recovery-proof.txt`
- `close-readback.txt`

The generator adds the migration catalog/functional SQL, stack checksums, timer proof and `backup-status.json`. Do not duplicate them in the item list.

These filenames specify required evidence, not completed measurements. Never copy `window.env`, secret files, Compose/service environment files, database dumps, 1Password documents, raw container inspection or raw logs. Resolve incomplete manifest handling with HezLead on abort.

## Database preflight

Stage the reviewed files directly from the archive. Preserve the rollback and sibling rollback catalog byte-for-byte.

```sh
# step: hm6-stage-reviewed-proofs
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test "$SHA" = 9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  for NAME in \
    20260928000002-catalog.sql \
    20260928000003-catalog.sql \
    20260928000003-functional.sql \
    20260928000003-rollback.sql \
    20260928000003-rollback-catalog.sql \
    20260928000004-catalog.sql \
    20260928000004-functional.sql
  do
    install -o root -g root -m 0600 \
      "$NEW_STACK/deploy/release-proofs/item-hm/$NAME" "$PROOF_DIR/$NAME"
    cmp -s "$NEW_STACK/deploy/release-proofs/item-hm/$NAME" "$PROOF_DIR/$NAME"
  done
  (
    cd "$PROOF_DIR"
    sha256sum \
      20260928000002-catalog.sql \
      20260928000003-catalog.sql \
      20260928000003-functional.sql \
      20260928000003-rollback.sql \
      20260928000003-rollback-catalog.sql \
      20260928000004-catalog.sql \
      20260928000004-functional.sql
  ) >"$PROOF_DIR/verification-sql.sha256"
)
```

Create the protected target-only database session through sections 2–3. Every database block sources `window.env` before the session helper.

```sh
# step: hm6-prove-hm2-precondition
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  cat >"$APPLY_SQL" <<'SQL'
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations
   WHERE version = '20260928000002') = 1
  AND to_regclass('swarm.hosted_mcp_grants') IS NOT NULL
  AND to_regclass('swarm.users') IS NOT NULL AS dependency_ok
\gset
\i /proof/20260928000002-catalog.sql
SELECT :'dependency_ok'::boolean AND :'catalog_ok'::boolean;
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm2-precondition.txt"
  test "$(cat "$PROOF_DIR/hm2-precondition.txt")" = t
)
```

The HM2 catalog checks the views’ `auth.uid()` dependency through `pg_rewrite`, `pg_depend` and the `pg_proc` object identity. Do not replace it with matching schema-qualified names in deparsed SQL.

Require first-install HM6 absence and the default ACL assumed by the reviewed inverse:

```sh
# step: hm6-prove-first-install-baseline
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000003-catalog.sql
SELECT
  :'catalog_ok' = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260928000003'
  )
  AND to_regnamespace('commonswarm_oauth') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'
  )
  AND EXISTS (
    SELECT 1 FROM pg_roles r
    CROSS JOIN LATERAL aclexplode(COALESCE(
      (SELECT d.defaclacl FROM pg_default_acl d
       WHERE d.defaclrole = r.oid
         AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
      acldefault('f', r.oid)
    )) a
    WHERE r.rolname = 'swarm_admin'
      AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'
  );
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm6-baseline.txt"
  test "$(cat "$PROOF_DIR/hm6-baseline.txt")" = t

  cat >"$APPLY_SQL" <<'SQL'
SELECT COALESCE(json_agg(x ORDER BY x.grantee, x.privilege_type), '[]'::json)
FROM (
  SELECT a.grantor, a.grantee, a.privilege_type, a.is_grantable
  FROM pg_roles r
  CROSS JOIN LATERAL aclexplode(COALESCE(
    (SELECT d.defaclacl FROM pg_default_acl d
     WHERE d.defaclrole = r.oid
       AND d.defaclnamespace = 0 AND d.defaclobjtype = 'f'),
    acldefault('f', r.oid)
  )) a
  WHERE r.rolname = 'swarm_admin'
) x;
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm6-default-acl-before.json"

  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000004-catalog.sql
SELECT :'catalog_ok' = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260928000004'
  )
  AND to_regclass('swarm.hosted_mcp_check_cursors') IS NULL
  AND to_regclass('swarm.hosted_mcp_check_batches') IS NULL;
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm3-deferred-before.txt"
  test "$(cat "$PROOF_DIR/hm3-deferred-before.txt")" = t
)
```

An SQL error is a failure, not equivalent to `catalog_ok=f`. A partial installation, surviving role, unexpected ledger row or different default ACL stops this plan. Do not repair the baseline during release.

Run section 5’s complete migration enumeration and ledger reconciliation. The expected pending set is **03 and 04**, with 03 approved for apply and 04 explicitly deferred. Any additional pending migration, unexplained older version or different live state stops the window.

## Pre-change complete-backup gate

Run section 5’s complete-backup gate before the helper switch and again immediately before migration apply. Save its safe outcome in `backup-gate-before.txt`.

Require:

- `ok`, `database_bytes_verified` and `object_bytes_verified` all true.
- `verified_at` within HezLead’s approved maximum age, with the runbook’s `-300` second clock allowance.
- Destination under `r2:yulan-vps-1-backups/000-commonswarm-postgres/`.
- No running backup.

Use the current five-second polling and 14,400-second deadline. `active`, **`activating`**, `deactivating` and `reloading` are busy states. A successful start command alone is insufficient.

If a fresh backup is needed before apply, HezLead must approve starting it **while the old helpers are still active**. The new `migrate/dump-source.sh` requires `commonswarm_oauth` to exist, so it cannot produce a successful pre-migration backup. Do not create an empty schema to appease it.

The first backup made after migration must use the new helpers and satisfy the separate coverage proof below.

## Immutable OAuth release and local build

Before creation, prove that no OAuth installation, service account, current symlink or protected secret directory will be overwritten. Existing state requires an upgrade plan.

```sh
# step: hm6-create-oauth-release
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test "$(date -u -d "$WINDOW_START_UTC" +%H%M%S)" = "$WINDOW_PRINCIPAL_SUFFIX"
  NEW_OAUTH="/home/commonswarm/oauth/releases/$SHA"
  SERVICE_ACCOUNT="cs-oauth-${WINDOW_PRINCIPAL_SUFFIX}"
  test ! -e "$NEW_OAUTH"
  test ! -e /home/commonswarm/oauth/current
  test ! -L /home/commonswarm/oauth/current
  test ! -e /etc/commonswarm-oauth
  if getent passwd "$SERVICE_ACCOUNT" >/dev/null; then exit 1; fi
  if getent group "$SERVICE_ACCOUNT" >/dev/null; then exit 1; fi
  test -z "$(docker ps -aq --filter label=com.docker.compose.project=commonswarm-oauth)"

  groupadd --system "$SERVICE_ACCOUNT"
  useradd --system --no-create-home --no-log-init \
    --home-dir /nonexistent --shell /usr/sbin/nologin \
    --gid "$SERVICE_ACCOUNT" "$SERVICE_ACCOUNT"
  MCP_OAUTH_UID="$(id -u "$SERVICE_ACCOUNT")"
  MCP_OAUTH_GID="$(id -g "$SERVICE_ACCOUNT")"
  test "$MCP_OAUTH_UID" -ne 0
  test "$MCP_OAUTH_GID" -ne 0

  test "$(sha256sum /tmp/commonswarm-release.tar | cut -d' ' -f1)" = \
    "$(cut -d' ' -f1 "$PROOF_DIR/box-archive.sha256")"
  install -d -o commonswarm -g commonswarm -m 0755 "$NEW_OAUTH"
  tar -xf /tmp/commonswarm-release.tar -C "$NEW_OAUTH"
  printf '%s\n' "$SHA" >"$NEW_OAUTH/RELEASE_SHA"
  chown -R commonswarm:commonswarm "$NEW_OAUTH"
  (
    cd "$NEW_OAUTH"
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
  ) >"$PROOF_DIR/oauth.SHA256SUMS"
  install -d -o root -g "$MCP_OAUTH_GID" -m 0750 /etc/commonswarm-oauth
  printf 'NEW_OAUTH=%q\nSERVICE_ACCOUNT=%q\nMCP_OAUTH_UID=%q\nMCP_OAUTH_GID=%q\n' \
    "$NEW_OAUTH" "$SERVICE_ACCOUNT" "$MCP_OAUTH_UID" "$MCP_OAUTH_GID" \
    >>"$PROOF_DIR/window.env"
)
```

Review available box capacity before building. Build only from the immutable service directory, using its `.dockerignore`; no secret directory is in the build context.

```sh
# step: hm6-build-local-image
# Runs: box over SSH, as root, operated by Anvil, before either release switch.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test ! -e "$PROOF_DIR/oauth-image.id"
  cmp -s "$NEW_STACK/services/mcp-auth/Dockerfile" \
    "$NEW_OAUTH/services/mcp-auth/Dockerfile"
  cmp -s "$NEW_STACK/services/mcp-auth/package-lock.json" \
    "$NEW_OAUTH/services/mcp-auth/package-lock.json"

  docker build --pull=false \
    --iidfile "$PROOF_DIR/oauth-image.id" \
    --file "$NEW_OAUTH/services/mcp-auth/Dockerfile" \
    "$NEW_OAUTH/services/mcp-auth"

  MCP_OAUTH_IMAGE="$(cat "$PROOF_DIR/oauth-image.id")"
  [[ "$MCP_OAUTH_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]]
  test "$(docker image inspect --format '{{.Id}}' "$MCP_OAUTH_IMAGE")" = "$MCP_OAUTH_IMAGE"

  python3 - "$NEW_OAUTH" "$PROOF_DIR" "$SHA" "$MCP_OAUTH_IMAGE" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
release, proof = map(pathlib.Path, sys.argv[1:3])
sha, image = sys.argv[3:]
service = release / 'services/mcp-auth'
dockerfile = (service / 'Dockerfile').read_text()
base = dockerfile.splitlines()[0].removeprefix('FROM ')
assert base == ('node:22.23.3-bookworm-slim@sha256:'
                '43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c')
assert re.fullmatch(r'sha256:[0-9a-f]{64}', image)
inspection = json.loads(subprocess.check_output(
    ['docker', 'image', 'inspect', image], text=True))[0]
assert inspection['Id'] == image
package = json.loads((service / 'package.json').read_text())
assert package['dependencies']['oidc-provider'] == '9.12.2'
result = {
    'release_sha': sha,
    'local_image_id': image,
    'base_reference': base,
    'base_digest': base.split('@', 1)[1],
    'dockerfile_sha256': hashlib.sha256((service / 'Dockerfile').read_bytes()).hexdigest(),
    'package_lock_sha256': hashlib.sha256((service / 'package-lock.json').read_bytes()).hexdigest(),
    'os': inspection['Os'],
    'architecture': inspection['Architecture'],
    'build_secrets': False,
    'application_registry_used': False
}
(proof / 'oauth-image.json').write_text(json.dumps(result, indent=2) + '\n')
PY
  printf 'MCP_OAUTH_IMAGE=%q\n' "$MCP_OAUTH_IMAGE" >>"$PROOF_DIR/window.env"
)
```

Retain the image and evidence. Do not rebuild after approval and silently substitute a new ID. A changed image ID requires renewed verification.

## Activate backup and restore helpers before migration

The backup unit executes:

`/home/commonswarm/stack/current/deploy/supabase-stack/backup/run-backup.sh`

That script calls `backup/dump-database.sh`, which calls `migrate/dump-source.sh` from the same stack tree. The restore unit executes:

`/home/commonswarm/stack/current/deploy/supabase-stack/backup/restore-drill.py`

The drill also runs helpers from that stack tree. Sources are the two committed service units and the corresponding scripts.

Therefore this window changes exactly:

`/home/commonswarm/stack/current`

from the recorded and reverified:

`/home/commonswarm/stack/releases/e38b499fc29a01935333e38f66c4e68ac7e1f81e`

to:

`/home/commonswarm/stack/releases/9fa4217da9f6447e55fb8c6d577b8fd3997f926b`.

Do not edit the old release in place, copy new scripts into it or change the unit to an unreviewed helper location.

Record installed `ExecStart`, `ExecStartPre`, `ExecStopPost` and any drop-in overrides in `backup-unit-paths.txt`, without recording environment values. Stop if the installed execution path differs from this measured contract.

Compare `compose.yaml`, `postgres/`, `backup/` **and `migrate/`** against `PREVIOUS_STACK`; review every difference in `stack-runtime-review.txt`. The standard runbook comparison omits `migrate/`, although the backup uses it.

The helper switch does not require any stack-container restart. Repository comparison establishes unchanged Compose, PostgreSQL files and unit files against the last recorded active stack. Reconfirm live files and overrides. Only GoTrue is later recreated for its allowlist change. No PostgreSQL, PostgREST, Realtime, Storage or edge restart is authorized.

Use section 7’s guarded switch and section 8’s unit-sync semantics. Its published block uses an associative array; use the following equivalent file-backed timestamp recording for this window. It preserves unit backup, service waiting, conditional unit installation, timer restoration and activation detection.

HezLead must choose a window outside the runbook’s prohibited periods and with both timer schedules after the planned window end. This avoids scheduling a new-helper backup during the brief schema-absent interval. If a persistent timer unexpectedly runs before apply, let it finish, inspect the result and stop on failure.

```sh
# step: hm6-guarded-stack-helper-switch
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  UNITS_BEFORE="$PROOF_DIR/units-before"
  test "$PREVIOUS_STACK" = /home/commonswarm/stack/releases/e38b499fc29a01935333e38f66c4e68ac7e1f81e
  test "$(readlink -f /home/commonswarm/stack/current)" = "$PREVIOUS_STACK"
  test "$(readlink -f /home/commonswarm/edge/current)" = \
    /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test -s "$PROOF_DIR/oauth-image.json"

  UTC_HM="$(date -u +%H%M)"
  UTC_DOW="$(date -u +%u)"
  UTC_MINUTES=$((10#${UTC_HM%??} * 60 + 10#${UTC_HM#??}))
  if (( UTC_MINUTES >= 210 && UTC_MINUTES < 270 )); then exit 1; fi
  if [ "$UTC_DOW" = 7 ] && (( UTC_MINUTES >= 270 && UTC_MINUTES < 330 )); then exit 1; fi

  for RELATIVE_PATH in compose.yaml postgres/pg_hba.conf postgres/10-runtime-roles.sh; do
    cmp -s "$PREVIOUS_STACK/deploy/supabase-stack/$RELATIVE_PATH" \
      "$NEW_STACK/deploy/supabase-stack/$RELATIVE_PATH"
  done
  for TIMER in commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer; do
    NEXT="$(systemctl show "$TIMER" -p NextElapseUSecRealtime --value)"
    test -n "$NEXT"
    test "$(date -u -d "$NEXT" +%s)" -gt "$(date -u -d "$WINDOW_END_UTC" +%s)"
  done

  test ! -e "$UNITS_BEFORE"
  install -d -o root -g root -m 0700 "$UNITS_BEFORE"
  for UNIT in \
    commonswarm-postgres-backup.service commonswarm-postgres-backup.timer \
    commonswarm-postgres-restore.service commonswarm-postgres-restore.timer
  do
    test -f "/etc/systemd/system/$UNIT"
    test -f "$NEW_STACK/deploy/supabase-stack/backup/$UNIT"
    install -o root -g root -m 0644 "/etc/systemd/system/$UNIT" "$UNITS_BEFORE/$UNIT"
  done

  sed -i 's/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED=1/' "$PROOF_DIR/window.env"
  systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
  DEADLINE=$(( $(date +%s) + 14400 ))
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    while :; do
      STATE="$(systemctl is-active "$SERVICE" || true)"
      case "$STATE" in
        inactive) break ;;
        active|activating|deactivating|reloading)
          test "$(date +%s)" -lt "$DEADLINE"
          sleep 5
          ;;
        *) exit 1 ;;
      esac
    done
    test "$(systemctl show "$SERVICE" -p Result --value)" = success
    systemctl show "$SERVICE" -p InactiveExitTimestampMonotonic --value \
      >"$UNITS_BEFORE/$SERVICE.inactive-exit-before"
  done

  printf 'stack switch direction=apply UTC=%s\n' "$(date -u +%FT%TZ)" \
    >>"$PROOF_DIR/box-run.log"
  ln -sfn "$NEW_STACK" /home/commonswarm/stack/current
  for UNIT in \
    commonswarm-postgres-backup.service commonswarm-postgres-backup.timer \
    commonswarm-postgres-restore.service commonswarm-postgres-restore.timer
  do
    if ! cmp -s "$NEW_STACK/deploy/supabase-stack/backup/$UNIT" "/etc/systemd/system/$UNIT"; then
      install -o root -g root -m 0644 \
        "$NEW_STACK/deploy/supabase-stack/backup/$UNIT" "/etc/systemd/system/$UNIT"
    fi
  done
  systemctl daemon-reload
  systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
  systemctl list-timers --all commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer \
    >"$PROOF_DIR/stack-switch-timers.txt"

  for TIMER in commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer; do
    NEXT="$(systemctl show "$TIMER" -p NextElapseUSecRealtime --value)"
    test -n "$NEXT"
    test "$(date -u -d "$NEXT" +%s)" -gt "$(date -u -d "$WINDOW_END_UTC" +%s)"
  done
  sed -i 's/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED=0/' "$PROOF_DIR/window.env"

  DEADLINE=$(( $(date +%s) + 14400 ))
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    while :; do
      STATE="$(systemctl is-active "$SERVICE" || true)"
      case "$STATE" in
        inactive) break ;;
        active|activating|deactivating|reloading)
          test "$(date +%s)" -lt "$DEADLINE"
          sleep 5
          ;;
        *) exit 1 ;;
      esac
    done
    AFTER="$(systemctl show "$SERVICE" -p InactiveExitTimestampMonotonic --value)"
    ACTIVATED=0
    if [ "$AFTER" != "$(cat "$UNITS_BEFORE/$SERVICE.inactive-exit-before")" ]; then ACTIVATED=1; fi
    printf 'after timer start: %s=%s activated=%s\n' "$SERVICE" "$STATE" "$ACTIVATED" \
      >>"$PROOF_DIR/box-run.log"
    test "$(systemctl show "$SERVICE" -p Result --value)" = success
  done
  test "$(readlink -f /home/commonswarm/stack/current)" = "$NEW_STACK"
)
```

This window uses the stricter precondition that both maintenance services are inactive and successful. It does not clear a failed service’s result to make the switch pass.

## Apply migration 03 and prove privileges

Repeat the complete-backup freshness gate. Then run section 5’s preflight, transactional apply and verify blocks with **`VERSION=20260928000003`**. Let the runbook derive `MIGRATION_FILE` from the enumerated archive; do not hand-select another file.

The runner owns transaction control, timeouts, ledger insertion and pre-commit catalog assertion. Never run the migration bare.

Require:

- Before apply: ledger count `0`, catalog `f`, no SQL error.
- After apply: ledger count `1`, catalog `t`.
- Functional output exactly `t`.
- Empty added and removed cron sets.
- Migration 04 remains unapplied.

The archived HM6 catalog checks six tables, ownership/RLS, the `provider_artifacts` and `interactions` column inventories, 15 named indexes, six primary keys, two foreign keys, one unique constraint, 29 checks, seven policies, role attributes and selected privileges/default ACLs. It does **not** check every table’s complete column inventory.

The corrected catalog checks columns through `pg_attribute` and function properties through `pg_proc`; it does not text-match deparsed definitions. Never replace those structural checks with schema-qualified relation-name text matching. The status function uses dynamic SQL, so a complete dependency graph for that body is not established by `pg_depend`. Behavioral acceptance therefore also requires the reviewed functional and PostgreSQL integration proofs.

```sh
# step: hm6-check-runtime-privileges
# Runs: box over SSH, as root, operated by Anvil, after migration 03.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  cat >"$APPLY_SQL" <<'SQL'
WITH runtime AS (
  SELECT oid FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime'
), expected_tables(name, allowed) AS (
  VALUES
    ('provider_artifacts', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
    ('browser_sessions', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
    ('interactions', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
    ('cimd_cache', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
    ('consent_orchestration', ARRAY['SELECT','INSERT','UPDATE','DELETE']),
    ('refresh_family_tombstones', ARRAY['SELECT','INSERT'])
), table_bits AS (
  SELECT COALESCE(bool_and(
    c.oid IS NOT NULL AND c.relkind = 'r'
    AND c.relrowsecurity
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege(r.oid, c.oid, bit) = (bit = ANY(e.allowed))
  ), false) AS ok
  FROM expected_tables e
  CROSS JOIN runtime r
  CROSS JOIN unnest(ARRAY[
    'SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'
  ]) bit
  LEFT JOIN pg_class c
    ON c.relnamespace = to_regnamespace('commonswarm_oauth')
   AND c.relname = e.name
), functions AS (
  SELECT count(*) = 3 AND bool_and(
    pg_get_userbyid(p.proowner) = 'swarm_admin'
    AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]
    AND p.prosecdef = (p.proname <> 'hosted_grant_is_active')
    AND p.provolatile =
      CASE WHEN p.proname = 'hosted_grant_is_active' THEN 'i'::"char"
           ELSE 's'::"char" END
    AND has_function_privilege(r.oid, p.oid, 'EXECUTE') =
      (p.oid = to_regprocedure('commonswarm_oauth.resolve_hosted_grant_status(text)'))
  ) AS ok
  FROM pg_proc p CROSS JOIN runtime r
  WHERE p.pronamespace = to_regnamespace('commonswarm_oauth')
)
SELECT COALESCE(
  (SELECT ok FROM table_bits)
  AND (SELECT ok FROM functions)
  AND (SELECT count(*) = 1 FROM runtime)
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN runtime r ON r.oid = m.member
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_namespace n CROSS JOIN runtime r WHERE n.nspowner = r.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN runtime r WHERE c.relowner = r.oid
  )
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN runtime r WHERE p.proowner = r.oid
  )
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'CREATE')
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'CREATE'),
  false
);
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm6-privileges.txt"
  test "$(cat "$PROOF_DIR/hm6-privileges.txt")" = t
  date -u +%FT%TZ >"$PROOF_DIR/hm6-applied-at.txt"
)
```

Each privilege call tests one privilege. Also review database/schema direct ACLs, column privileges and grant options for unexpected authority. Distinguish PUBLIC grants from direct grants. The runtime role must have LOGIN, NOINHERIT, no elevated role attributes, no parent-role membership and `search_path=commonswarm_oauth, pg_catalog`.

Record the post-apply global `swarm_admin` function default ACL using the same structural query as the baseline in `hm6-default-acl-after.json`; reconcile the change to PUBLIC EXECUTE only. An unexpected permission is a stop, not authorization to repair ACLs.

## Protected runtime inputs

Select a free port after inspecting listeners and recheck it immediately before service start.

```sh
# step: hm6-select-loopback-port
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  ss -ltnp
  MCP_OAUTH_HOST_PORT=''
  for PORT_CANDIDATE in $(seq 3490 3499); do
    SOCKETS="$(ss -H -ltnp "sport = :$PORT_CANDIDATE")"
    if [ -z "$SOCKETS" ]; then MCP_OAUTH_HOST_PORT="$PORT_CANDIDATE"; break; fi
  done
  test -n "$MCP_OAUTH_HOST_PORT"
  printf 'MCP_OAUTH_HOST_PORT=%s\n' "$MCP_OAUTH_HOST_PORT" >"$PROOF_DIR/oauth-port.txt"
  printf 'MCP_OAUTH_HOST_PORT=%q\n' "$MCP_OAUTH_HOST_PORT" >>"$PROOF_DIR/window.env"
)
```

Generate signing and cookie keys on the box. Despite its name, `signing-keys.pem` contains a private JSON JWK set.

```sh
# step: hm6-generate-protected-keys
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  umask 077
  MCP_OAUTH_ACTIVE_SIGNING_KID="hm6-${WINDOW_PRINCIPAL_SUFFIX}"
  node --input-type=module - "$MCP_OAUTH_ACTIVE_SIGNING_KID" <<'JS'
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const kid = process.argv[2];
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const key = { ...privateKey.export({ format: 'jwk' }), alg: 'ES256', use: 'sig', kid };
writeFileSync('/etc/commonswarm-oauth/signing-keys.pem',
  JSON.stringify({ keys: [key] }) + '\n', { flag: 'wx', mode: 0o640 });
writeFileSync('/etc/commonswarm-oauth/cookie-keys',
  randomBytes(48).toString('base64url') + '\n' +
  randomBytes(48).toString('base64url') + '\n',
  { flag: 'wx', mode: 0o640 });
JS
  chown "root:$MCP_OAUTH_GID" \
    /etc/commonswarm-oauth/signing-keys.pem /etc/commonswarm-oauth/cookie-keys
  chmod 0640 /etc/commonswarm-oauth/signing-keys.pem /etc/commonswarm-oauth/cookie-keys
  printf 'MCP_OAUTH_ACTIVE_SIGNING_KID=%q\n' "$MCP_OAUTH_ACTIVE_SIGNING_KID" \
    >>"$PROOF_DIR/window.env"
)
```

Through Anvil’s established secure file-transfer workflow, store **both signing and cookie keys** in protected items in **Yulan Ventures Infra**, with names derived from the recorded suffix. The signing item is the source of truth. Verify protected retrieval against the box files without displaying contents. Record only item identities, signing `kid` and verification outcomes.

Availability of a box-authenticated 1Password client is not established. Do not install or improvise an authentication path during the window.

After migration, Anvil provisions the runtime role’s SCRAM password out of band, as required by `deploy/mcp-auth/RUNBOOK.md`. Store its recovery material in the same vault. The runtime file `/etc/commonswarm-oauth/database-credentials` contains only the `user` and `password` fields consumed by `config.js`. Passwords never enter runnable release SQL, shell arguments or environment values.

The three secret files must be regular, non-symlink files owned `root:<service gid>`, mode `0640`. The existing shared CA is not a secret; verify its identity and protected permissions without changing its shared ownership merely for this service. It must be readable by the runtime user and satisfy `config.js`’s no-other-permissions check. Stop if it does not; obtain an approved permission remedy.

Prepare root-owned mode-`0600` `/etc/commonswarm-oauth/service.env`:

| Setting | Required value |
|---|---|
| `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED` | `0` |
| `MCP_OAUTH_NATIVE_LOOPBACK_ENABLED` | `0` |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_PUBLIC_ORIGIN` | `https://mcp.commonswarm.com` |
| `MCP_OAUTH_RESOURCE` | `https://mcp.commonswarm.com/mcp` |
| `MCP_OAUTH_ALLOWED_ORIGINS` | `https://commonswarm.com,https://www.commonswarm.com` |
| `MCP_OAUTH_GOTRUE_URL` | `https://api.commonswarm.com/auth/v1` |
| `MCP_OAUTH_GOTRUE_PROVIDER` | Measured enabled production provider; not established |
| `SUPABASE_ANON_KEY` | Existing public anon configuration, transferred without printing; never service-role |
| `MCP_OAUTH_DATABASE_PORT` | `5432` |
| `MCP_OAUTH_DATABASE_NAME` | Measured target database name |
| `MCP_OAUTH_ACTIVE_SIGNING_KID` | Recorded window value |
| Code/access/refresh lifetimes | `60`, `300`, `2592000` seconds |

Compose supplies the database hostname, `extra_hosts` address and four `*_FILE` paths. Do not put inline secret substitutes in either environment file.

```sh
# step: hm6-write-compose-inputs
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  [[ "$MCP_OAUTH_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]]
  test "$(docker image inspect --format '{{.Id}}' "$MCP_OAUTH_IMAGE")" = "$MCP_OAUTH_IMAGE"
  for NAME in signing-keys.pem cookie-keys database-credentials; do
    FILE="/etc/commonswarm-oauth/$NAME"
    test -f "$FILE"
    test ! -L "$FILE"
    test -s "$FILE"
    test "$(stat -c '%u:%g:%a' "$FILE")" = "0:${MCP_OAUTH_GID}:640"
  done
  test -f /etc/ssl/yulan-internal-ca.pem
  test ! -L /etc/ssl/yulan-internal-ca.pem
  test "$(stat -c '%u:%a' /etc/commonswarm-oauth/service.env)" = 0:600
  umask 077
  {
    printf 'MCP_OAUTH_IMAGE=%s\n' "$MCP_OAUTH_IMAGE"
    printf 'MCP_OAUTH_UID=%s\nMCP_OAUTH_GID=%s\n' "$MCP_OAUTH_UID" "$MCP_OAUTH_GID"
    printf 'MCP_OAUTH_HOST_PORT=%s\n' "$MCP_OAUTH_HOST_PORT"
    printf 'MCP_OAUTH_ENV_FILE=/etc/commonswarm-oauth/service.env\n'
    printf 'MCP_OAUTH_DATABASE_HOST=db.commonswarm.internal\n'
    printf 'MCP_OAUTH_DATABASE_ADDRESS=172.31.0.10\n'
  } >/etc/commonswarm-oauth/compose.env
  chmod 0600 /etc/commonswarm-oauth/compose.env
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" config -q
)
```

## Prove resolution and verified TLS before HTTP starts

Run through the actual image, runtime UID/GID, mounts, `extra_hosts` and network. The process runs `getent` inside the container, checks TLS authorization and hostname identity, and authenticates as the runtime role. It prints only a fixed success/failure message.

```sh
# step: hm6-prove-runtime-database
# Runs: box over SSH, as root, operated by Anvil; HTTP is not started.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" \
    run --rm --no-deps --pull never -T --entrypoint node oauth --input-type=module - \
    >"$PROOF_DIR/oauth-database-proof.txt" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkServerIdentity } from 'node:tls';
import { loadConfig, createPool } from './src/config.js';

let pool;
let client;
try {
  const host = 'db.commonswarm.internal';
  const resolved = execFileSync('getent', ['ahostsv4', host], { encoding: 'utf8' })
    .trim().split(/\n/).map(line => line.trim().split(/\s+/)[0]);
  assert.ok(resolved.length > 0);
  assert.deepEqual([...new Set(resolved)], ['172.31.0.10']);

  const config = await loadConfig();
  assert.equal(config.publicAuthorizationEnabled, false);
  assert.equal(config.nativeLoopbackEnabled, false);
  assert.equal(config.database.host, host);
  assert.equal(config.database.port, 5432);
  assert.equal(config.database.user, 'commonswarm_oauth_runtime');
  assert.equal(config.database.ssl.rejectUnauthorized, true);
  assert.notEqual(process.getuid(), 0);
  assert.notEqual(process.getgid(), 0);

  pool = createPool(config);
  client = await pool.connect();
  const socket = client.connection.stream;
  assert.equal(socket.encrypted, true);
  assert.equal(socket.authorized, true);
  const cert = socket.getPeerCertificate();
  assert.equal(checkServerIdentity(host, cert), undefined);
  const sans = cert.subjectaltname.split(/,\s*/);
  assert.ok(sans.includes('DNS:db.commonswarm.internal'));
  assert.ok(sans.includes('IP Address:172.31.0.10'));

  await client.query('BEGIN READ ONLY');
  const { rows: [row] } = await client.query(`
    SELECT current_user = 'commonswarm_oauth_runtime' AS role_ok,
      COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS tls_ok,
      to_regclass('commonswarm_oauth.provider_artifacts') IS NOT NULL AS schema_ok
  `);
  assert.equal(row.role_ok && row.tls_ok && row.schema_ok, true);
  await client.query('ROLLBACK');
  console.log('getent, runtime role, verified TLS hostname and schema: PASS');
} catch {
  console.error('OAuth database preflight: FAIL');
  process.exitCode = 1;
} finally {
  client?.release();
  await pool?.end();
}
JS
  test "$(cat "$PROOF_DIR/oauth-database-proof.txt")" = \
    'getent, runtime role, verified TLS hostname and schema: PASS'
)
```

Do not change to an IP-only database host, disable verification, substitute `sslmode=require`, or start HTTP after a failed proof.

## Start the dark service

```sh
# step: hm6-start-dark-service
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test -z "$(ss -H -ltnp "sport = :$MCP_OAUTH_HOST_PORT")"
  test ! -e /home/commonswarm/oauth/current
  test ! -L /home/commonswarm/oauth/current
  ln -s "$NEW_OAUTH" /home/commonswarm/oauth/current
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" up -d --no-deps --pull never oauth
  CID="$(docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" ps -q oauth)"
  test -n "$CID"
  DEADLINE=$(( $(date +%s) + 120 ))
  until [ "$(docker inspect --format '{{.State.Health.Status}}' "$CID")" = healthy ]; do
    test "$(date +%s)" -lt "$DEADLINE"
    sleep 5
  done
  test "$(docker inspect --format '{{.Image}}' "$CID")" = "$MCP_OAUTH_IMAGE"
  test "$(readlink -f /home/commonswarm/oauth/current)" = "$NEW_OAUTH"
  docker exec "$CID" node -e \
    'if(process.getuid()===0||process.getgid()===0)process.exit(1); console.log("non-root: PASS")'
  docker inspect --format \
    '{"image":{{json .Image}},"user":{{json .Config.User}},"memory":{{.HostConfig.Memory}},"nano_cpus":{{.HostConfig.NanoCpus}},"readonly":{{.HostConfig.ReadonlyRootfs}},"restart":{{json .HostConfig.RestartPolicy.Name}},"logging":{{json .HostConfig.LogConfig}},"ports":{{json .HostConfig.PortBindings}},"mounts":{{json .Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}},"networks":{{json .NetworkSettings.Networks}},"extra_hosts":{{json .HostConfig.ExtraHosts}},"health":{{json .State.Health.Status}},"healthcheck":{{json .Config.Healthcheck}},"security":{{json .HostConfig.SecurityOpt}},"cap_drop":{{json .HostConfig.CapDrop}}}' \
    "$CID" >"$PROOF_DIR/oauth-runtime.json"
)
```

Reconcile the actual inspection, not only Compose source:

- Exact recorded image ID and non-root UID/GID.
- `Memory=536870912`, `NanoCpus=1000000000`.
- Read-only root filesystem, all capabilities dropped, no-new-privileges.
- Exactly one host publication: `127.0.0.1:<recorded port>` to `3490`.
- Four read-only bind mounts with the reviewed sources and destinations.
- `/tmp` bounded to 32 MiB with `noexec,nosuid,nodev`.
- Only `commonswarm-net`; expected database host mapping.
- `unless-stopped`; `json-file`, `max-size=10m`, `max-file=3`.
- Healthy healthcheck: interval 10 seconds, timeout 3 seconds, six retries, start period 20 seconds.

## GoTrue callback

Append exactly:

`https://mcp.commonswarm.com/oauth/callback/gotrue`

to **`GOTRUE_URI_ALLOW_LIST`**, preserving every live entry and avoiding duplicates.

When the live list matches the repository’s three-entry baseline, the resulting value is:

`https://commonswarm.com/app,https://www.commonswarm.com/app,http://127.0.0.1:*/callback,https://mcp.commonswarm.com/oauth/callback/gotrue`

Anvil saves a protected rollback copy of `/home/commonswarm/.env`, edits only that assignment, and proves all other assignments unchanged without printing them. Record only previous/resulting callback URLs and whether a change was needed in `gotrue-allow-list.json`.

The helper switch has already made `NEW_STACK` current. Use that active Compose definition and preserve the existing environment wiring and overrides. If the callback was already present and the running service already has it, no recreate is needed.

```sh
# step: hm6-recreate-gotrue
# Runs: box over SSH, as root, operated by Anvil, only after an approved allowlist change.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$NEW_STACK"
  docker compose -p commonswarm-supabase-stack \
    --project-directory "$NEW_STACK/deploy/supabase-stack" config -q
  docker compose -p commonswarm-supabase-stack \
    --project-directory "$NEW_STACK/deploy/supabase-stack" \
    up -d --no-deps --force-recreate gotrue
  DEADLINE=$(( $(date +%s) + 180 ))
  until [ "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-gotrue)" = healthy ]; do
    test "$(date +%s)" -lt "$DEADLINE"
    sleep 5
  done
  curl --fail --silent --show-error http://127.0.0.1:18001/health
)
```

Extract only `GOTRUE_URI_ALLOW_LIST` when checking the running environment. Verify existing sign-in and redirect behavior and safe boot/database error summaries.

## Caddy and Cloudflare

Inventory the live hostname, imported Caddy files, DNS record and Cloudflare rules before changes. Save protected rollback copies and record prior absence when no object existed.

Require:

- Proxied DNS for `mcp.commonswarm.com`, following the live zone convention.
- Proven origin-certificate hostname coverage.
- A rule scoped by hostname equality to `mcp.commonswarm.com`, skipping Browser Integrity Check and applicable bot challenges.
- Effective coverage for health, metadata, JWKS, authorization, token, interaction, callback and MCP routes.

Current DNS/rule identities and certificate coverage are not established.

The reviewed Caddy file **already imports `mcp_oauth_active`** and leaves `mcp_resource_active` unimported. Render only its five OAuth-port substitutions. Do not inject another import or copy v1’s obsolete fallback transformation.

```sh
# step: hm6-render-oauth-caddy
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  python3 - "$NEW_OAUTH" "$PROOF_DIR" "$MCP_OAUTH_HOST_PORT" <<'PY'
from pathlib import Path
import sys
release, proof, port = Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])
assert 3490 <= port <= 3499
source = (release / 'deploy/supabase-stack/commonswarm-mcp.caddy').read_text()
assert source.count('{$MCP_OAUTH_HOST_PORT}') == 5
assert source.count('\t\timport mcp_oauth_active\n') == 1
assert '\t\timport mcp_resource_active' not in source
assert '@mcp_unavailable path /mcp /.well-known/oauth-protected-resource/mcp' in source
rendered = source.replace('{$MCP_OAUTH_HOST_PORT}', str(port))
(proof / 'oauth-caddy-rendered.caddy').write_text(rendered)
PY
  DIFF_STATUS=0
  diff -u "$NEW_OAUTH/deploy/supabase-stack/commonswarm-mcp.caddy" \
    "$PROOF_DIR/oauth-caddy-rendered.caddy" \
    >"$PROOF_DIR/oauth-caddy.diff" || DIFF_STATUS=$?
  test "$DIFF_STATUS" -eq 1
)
```

HezLead reviews the rendered diff and live installation path. Preserve method restrictions, 128 KB POST ingress limit, timeouts, forwarding headers and discarded access log. The service separately defaults to a 64 KiB body limit.

Record `MCP_CADDY_SITE` in `window.env` after verifying a single approved file under `/etc/caddy/sites/`, no conflicting hostname definition, and the prior site state.

```sh
# step: hm6-install-reviewed-caddy
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  : "${MCP_CADDY_SITE:?approved site path missing}"
  case "$MCP_CADDY_SITE" in /etc/caddy/sites/*.caddy) ;; *) exit 1 ;; esac
  openssl x509 -in /etc/caddy/certs/commonswarm.com.pem \
    -noout -checkhost mcp.commonswarm.com
  install -o root -g root -m 0644 \
    "$PROOF_DIR/oauth-caddy-rendered.caddy" "$MCP_CADDY_SITE"
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
)
```

On validation/reload failure, restore the recorded prior file or absence immediately, validate and reload. Do not leave invalid on-disk configuration.

Anvil applies or confirms DNS and the hostname-scoped rule through the established operator interface. Record only safe facts in `oauth-ingress-facts.json`.

## Public and restart controls

The committed routing gives these expectations:

| Request | Required result |
|---|---|
| GET `/health` | `200`, database-backed `status=ok` |
| Both authorization-server/OIDC metadata paths | `200`, exact issuer and endpoints |
| GET `/jwks` | `200`, public ES256/P-256 keys, recorded active `kid`, no private fields |
| GET `/authorize`; POST `/token` | `503 authorization_service_disabled` |
| GET/POST `/interaction/<non-secret-probe-id>` | Same disabled response |
| GET `/oauth/callback/gotrue` | Same disabled response |
| POST/OPTIONS `/mcp`; protected-resource metadata | `503 feature_disabled` |
| Bare `/interaction`; `/connections` | `404 not_found` at public Caddy |
| Wrong method on a known OAuth path | `405 method_not_allowed` |
| Existing API/site routes | Existing expected behavior |

The tree does not expose connection-management routes through Caddy. Do not claim `/connections` is routed or that this dark window proves management flows.

Copy the box’s non-secret signing `kid` into the protected Mac window state as `MCP_OAUTH_ACTIVE_SIGNING_KID`; compare it with the box value. Use the following outside-origin probe with no credentials and no redirects.

```sh
# step: hm6-probe-public-routes
# Runs: Mac mini, as Anvil, under /bin/bash 3.2, outside the origin.
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  : "${MCP_OAUTH_ACTIVE_SIGNING_KID:?recorded public kid missing}"
  python3 - "$EVIDENCE_DIR/oauth-public-probes.json" "$MCP_OAUTH_ACTIVE_SIGNING_KID" <<'PY'
import json, sys, urllib.request, urllib.error
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
base = 'https://mcp.commonswarm.com'
results = []
def probe(path, method, expected, error=None):
    req = urllib.request.Request(
        base + path, data=b'' if method == 'POST' else None, method=method,
        headers={'User-Agent': 'Python-urllib/3.12',
                 'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        response = opener.open(req, timeout=25)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        status = response.code
        content_type = response.headers.get('Content-Type', '')
        body = response.read(131073)
    assert status == expected, (path, status)
    assert 'application/json' in content_type
    assert len(body) <= 131072
    document = json.loads(body)
    if error is not None:
        assert document.get('error') == error, path
    results.append({'path': path, 'method': method, 'status': status, 'pass': True})
    return document
assert probe('/health', 'GET', 200)['status'] == 'ok'
for path in ['/.well-known/oauth-authorization-server',
             '/.well-known/openid-configuration']:
    document = probe(path, 'GET', 200)
    assert document['issuer'] == base
    assert document['authorization_endpoint'] == base + '/authorize'
    assert document['token_endpoint'] == base + '/token'
    assert document['jwks_uri'] == base + '/jwks'
jwks = probe('/jwks', 'GET', 200)
assert jwks.get('keys')
assert sys.argv[2] in {key.get('kid') for key in jwks['keys']}
for key in jwks['keys']:
    assert key['kty'] == 'EC' and key['crv'] == 'P-256'
    assert key.get('alg') == 'ES256' and key.get('kid')
    assert not set(key).intersection({'d','p','q','dp','dq','qi','oth','k'})
for path, method in [
    ('/authorize', 'GET'), ('/token', 'POST'),
    ('/interaction/hm6-dark-probe', 'GET'),
    ('/interaction/hm6-dark-probe', 'POST'),
    ('/oauth/callback/gotrue', 'GET')]:
    probe(path, method, 503, 'authorization_service_disabled')
for path, method in [
    ('/mcp', 'POST'), ('/mcp', 'OPTIONS'),
    ('/.well-known/oauth-protected-resource/mcp', 'GET')]:
    probe(path, method, 503, 'feature_disabled')
for path in ['/interaction', '/connections']:
    probe(path, 'GET', 404, 'not_found')
probe('/token', 'GET', 405, 'method_not_allowed')
with open(sys.argv[1], 'x') as f:
    json.dump(results, f, indent=2)
    f.write('\n')
PY
)
```

Transfer the reviewed non-secret result to the box proof directory before manifest copy-back.

Run equivalent loopback **OAuth** probes using the recorded port and external Host/scheme headers, recording `oauth-local-probes.json`. Caddy-only MCP/404/405 expectations do not apply directly to the service. Require positive discovery/JWKS/health controls alongside disabled issuance.

A 413, 502, redirect, HTML challenge or Cloudflare error 1010 is not a passing disabled response.

Perform one controlled OAuth-container restart, wait for health, recheck image ID and repeat the loopback/public expectations into `oauth-restart-probes.json`. Recheck the catalog, functional and privilege proofs. Confirm the active signing identity and protected files survive.

Dark restart checks do not prove real authorization, refresh continuity, rotation overlap or real-client interoperability. Require the corresponding exact-SHA tests and isolated recovery evidence; leave live-flow claims unestablished.

## Post-apply complete backup and schema inclusion

The readiness changes add `commonswarm_oauth` to:

- Canonical schema selection and dump/count queries in `migrate/lib.sh` and `migrate/dump-source.sh`.
- Restore manifest validation and count verification.
- Backup upload and restore-drill manifest validation.
- Restore-drill required table-count checks.

A complete timestamp alone is insufficient. After migration, Anvil must obtain a **new** complete backup from the now-active scripts. A manual backup requires HezLead’s explicit approval; record that approval before starting. Do not run the restore service as a rollout shortcut.

Record `backup-requested-at.txt` immediately before the approved start, then use section 5’s current start/wait block unchanged, including its four-hour deadline and busy-state handling. Require service `Result=success`, then repeat the full freshness gate and save `backup-status.json` under section 8.

The following reads the completed local artifact, verifies its binding and checksums, and examines only the `pg_restore --list` catalog. It prints no row data. It also proves that the dump file and completion were produced after the recorded post-apply backup request.

```sh
# step: hm6-prove-post-apply-backup-coverage
# Runs: box over SSH, as root, operated by Anvil, after the approved backup completes.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$NEW_STACK"
  test "$(systemctl show commonswarm-postgres-backup.service -p Result --value)" = success
  python3 - "$PROOF_DIR" <<'PY'
import datetime, hashlib, json, pathlib, re, subprocess, sys
proof = pathlib.Path(sys.argv[1])
root = pathlib.Path('/var/backups/commonswarm-postgres').resolve()
status = json.loads((root / 'status.json').read_text())
def timestamp(value):
    return datetime.datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
applied = timestamp((proof / 'hm6-applied-at.txt').read_text())
requested = timestamp((proof / 'backup-requested-at.txt').read_text())
verified = timestamp(status['verified_at'])
assert applied <= requested < verified
for field in ['ok', 'database_bytes_verified', 'object_bytes_verified']:
    assert status.get(field) is True
assert status['destination'].startswith(
    'r2:yulan-vps-1-backups/000-commonswarm-postgres/')

matches = []
for candidate in root.iterdir():
    if candidate.is_symlink() or not candidate.is_dir():
        continue
    marker = candidate / 'COMPLETE.json'
    if not marker.is_file() or marker.is_symlink():
        continue
    document = json.loads(marker.read_text())
    if document.get('destination') == status['destination']:
        assert all(status.get(k) == v for k, v in document.items())
        matches.append(candidate)
assert len(matches) == 1
artifact = matches[0].resolve()
assert artifact.parent == root
dump = artifact / 'database.dump'
assert dump.is_file() and not dump.is_symlink()
assert dump.stat().st_mtime >= requested.timestamp()

checksums = {}
for line in (artifact / 'SHA256SUMS').read_text().splitlines():
    match = re.fullmatch(r'([0-9a-f]{64})  ([a-zA-Z0-9_.-]+)', line)
    assert match and match[2] not in checksums
    checksums[match[2]] = match[1]
assert {'database.dump', 'manifest.txt', 'source-counts.tsv',
        'roles.sql', 'globals.sql', 'offsite-binding.json'} <= checksums.keys()
for name, expected in checksums.items():
    path = artifact / name
    assert path.is_file() and not path.is_symlink()
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1048576), b''):
            digest.update(chunk)
    assert digest.hexdigest() == expected
binding = json.loads((artifact / 'offsite-binding.json').read_text())
assert all(status.get(k) == v for k, v in binding.items())
manifest = dict(line.split('=', 1) for line in
                (artifact / 'manifest.txt').read_text().splitlines() if '=' in line)
assert 'commonswarm_oauth' in manifest['schemas'].split(',')

listing = subprocess.check_output(['pg_restore', '--list', str(dump)], text=True)
entries = [line.split() for line in listing.splitlines()
           if line and not line.startswith(';')]
assert any(parts[3:6] == ['SCHEMA', '-', 'commonswarm_oauth']
           for parts in entries)
expected_tables = {
    'provider_artifacts', 'refresh_family_tombstones', 'browser_sessions',
    'interactions', 'cimd_cache', 'consent_orchestration'
}
tables = {p[5] for p in entries if len(p) > 5 and
          p[3:5] == ['TABLE', 'commonswarm_oauth']}
data_tables = {p[6] for p in entries if len(p) > 6 and
               p[3:6] == ['TABLE', 'DATA', 'commonswarm_oauth']}
assert tables == expected_tables
assert data_tables == expected_tables
counts = {}
for line in (artifact / 'source-counts.tsv').read_text().splitlines():
    name, count = line.split('|')
    assert name not in counts and count.isdigit()
    counts[name] = count
assert {name.split('.', 1)[1] for name in counts
        if name.startswith('commonswarm_oauth.')} == expected_tables

result = {
    'pass': True,
    'destination': status['destination'],
    'verified_at': status['verified_at'],
    'dump_sha256': checksums['database.dump'],
    'schema': 'commonswarm_oauth',
    'table_count': len(tables),
    'table_data_entry_count': len(data_tables),
    'post_apply_backup': True,
    'row_data_printed': False
}
(proof / 'oauth-backup-coverage.json').write_text(json.dumps(result, indent=2) + '\n')
print('post-apply OAuth backup schema and six table-data entries: PASS')
PY
)
```

This proves inclusion and binding to the completed offsite-verified artifact. It is not a restore proof.

### Isolated recovery acceptance

Before closure, reconcile `oauth-recovery-proof.txt` with an isolated restore of the post-apply backup. Never restore over production.

Require evidence for:

- All six tables and their data/counts.
- Functions, indexes, constraints, ownership, ACLs, RLS and policies.
- Runtime role attributes, memberships, search path and database CONNECT.
- Catalog, functional and effective privilege checks after restore.
- Protected recovery of signing/cookie keys and runtime credentials.
- Successful runtime-role authentication after Anvil resets the restored role’s password from its protected recovery item.
- Stable signing identity and applicable exact-SHA restart/rotation tests.

The tree’s `dump-database.sh` exports `globals.sql` with `--no-role-passwords`. The normal `restore-target.sh` restores generated `roles.sql` and the database dump; the drill does not itself establish restoration of every OAuth role setting or database-level grant from globals. `roles.sql` generation explicitly restores `swarm_command`’s search path, not the OAuth role’s search path.

Therefore complete OAuth role/credential recovery is **not established by script inclusion alone**. HezLead must approve the isolated recovery procedure before opening, including how the saved role settings and database grants are restored. Any missing setting is a failed recovery check, not permission to silently weaken the check or modify production. Record the operator actions and resulting structural proofs. Do not close on a promise to test recovery later.

## Rollback

Prefer stopping the service while retaining the additive schema **and its backup coverage**. HezLead decides whether destructive schema rollback is necessary.

Required order:

1. Stop OAuth.
2. Restore the recorded prior MCP Caddy file or absence; validate, reload and externally prove no OAuth upstream remains.
3. Restore only this window’s DNS/rule changes, preserving pre-existing configuration.
4. Restore only the prior GoTrue allowlist assignment, preserving unrelated environment changes; recreate only GoTrue if needed and verify health.
5. Remove OAuth `current` only after verifying it points to this window’s release. Retain the image and immutable archive.
6. Decide whether to retain or remove migration 03.
7. Decide the corresponding backup-helper state; never leave a retained OAuth schema on helpers that exclude it.

```sh
# step: hm6-stop-oauth-for-rollback
# Runs: box over SSH, as root, operated by Anvil at HezLead's direction.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  test "$(readlink -f /home/commonswarm/oauth/current)" = "$NEW_OAUTH"
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" stop oauth
  test -z "$(docker ps -q --filter label=com.docker.compose.project=commonswarm-oauth)"
)
```

The exact ingress restoration command depends on recorded live prior state. Record it before installation. Do not proceed to schema rollback until validation/reload and external checks pass.

Before destructive rollback require:

- All six tables empty.
- No OAuth database sessions.
- No later dependent release.
- No intervening global default-ACL change since `hm6-default-acl-after.json`.
- A verified backup and HezLead’s explicit decision.

If data or credentials exist, retain the schema unless HezLead explicitly accepts the data loss. Never delete rows just to pass the empty-table gate.

### Verbatim reviewed SQL inverse

Execute [`20260928000003-rollback.sql`](../../../deploy/release-proofs/item-hm/20260928000003-rollback.sql) verbatim with its sibling rollback catalog. It owns its transaction. Do not wrap it as bare inverse DDL or add `CASCADE`.

```sh
# step: hm6-run-verbatim-reviewed-rollback
# Runs: box over SSH, as root, operated by Anvil, after all rollback approvals and gates.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  test -z "$(docker ps -q --filter label=com.docker.compose.project=commonswarm-oauth)"
  for NAME in 20260928000003-rollback.sql 20260928000003-rollback-catalog.sql; do
    cmp -s "$NEW_STACK/deploy/release-proofs/item-hm/$NAME" "$PROOF_DIR/$NAME"
  done
  cat >"$APPLY_SQL" <<'SQL'
SELECT
  NOT EXISTS (SELECT 1 FROM commonswarm_oauth.provider_artifacts)
  AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.refresh_family_tombstones)
  AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.browser_sessions)
  AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.interactions)
  AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.cimd_cache)
  AND NOT EXISTS (SELECT 1 FROM commonswarm_oauth.consent_orchestration)
  AND NOT EXISTS (
    SELECT 1 FROM pg_stat_activity WHERE usename = 'commonswarm_oauth_runtime'
  );
SQL
  test "$(release_psql_ro -Atq --file /run/commonswarm-release-apply.sql)" = t
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target
  release_psql --file /proof/20260928000003-rollback.sql
  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000003-rollback-catalog.sql
SELECT :'rollback_ok'::boolean;
SQL
  test "$(release_psql_ro -Atq --file /run/commonswarm-release-apply.sql)" = t
)
```

The reviewed inverse restores PUBLIC’s global default EXECUTE for future `swarm_admin` functions, drops the three functions and six tables/schema, revokes runtime CONNECT, resets its search path, refuses unexpected role dependencies, drops the role and removes only migration 03’s ledger row. It commits only after its rollback catalog passes.

A failed forward transaction needs no down-migration; first establish its resulting ledger/catalog state.

### Backup-helper rollback

If migration 03 is retained, retain the OAuth-inclusive helpers. Do not switch `stack/current` back to `e38b499f` and silently lose schema coverage.

If migration 03 was never applied, or has been successfully removed, restore the previous stack through section 7’s guarded **rollback** and section 8’s saved-unit restoration. Preserve the same service/timer guards and use file-backed timestamp storage instead of an associative array. Do not issue an unguarded symlink change.

Coordinate destructive schema removal and helper rollback outside scheduled maintenance work. The new dump helper requires the schema; after removal it cannot remain the unattended backup path. Record the transient state, restore the compatible helper release, restore timers and verify the next successful complete backup. No stack-container restart is required for this helper reversal.

Never roll back HM2, HM4 transport protection or the edge in this window.

### Key retention

Stop consumers before changing access. Retain signing, cookie and database recovery material and suffixed 1Password items. After permanent rollback, Anvil marks items retired and restricts unused on-box secret files to root-only access.

Do not delete keys automatically or reuse retired identities. Destruction needs a separate retention decision. Suspected compromise invokes key replacement and affected family/grant revocation, not ordinary rollback.

## Closure

Before closure, repeat the deferred-HM3 check into `hm3-deferred-after.txt` and require migration 04 to remain absent. Reconcile the actual pending set as 04 only after successful HM6 application.

HezLead closes only after accepting:

- Exact release/archive/local image identity, pinned base and required gates.
- HM2 read-only precondition.
- Migration 03 ledger/catalog/functional/privilege results and empty cron deltas.
- Migration 04’s explicit deferral and unchanged absence.
- New stack helper path, reviewed runtime diff, unchanged unrelated stack services and restored maintenance timers.
- Protected keys, vault recovery checks, runtime credential provisioning and verified in-container DNS/TLS.
- Non-root runtime, loopback publication, resource limits, health, restart, mounts and bounded logs.
- Preserved GoTrue allowlist plus the callback.
- Port-only Caddy rendering, certificate coverage, proxied DNS and hostname-scoped Cloudflare rules.
- Outside-origin non-browser positive controls, disabled issuance and dark MCP responses.
- A post-apply complete backup containing the OAuth schema and all six table-data entries.
- Isolated recovery of schema, role permissions/settings and credentials.
- Edge still at `72c57e0d76d0aa86fe4f811a2cf51499919fed20`.
- Transient cleanup and manifest-only copy-back.

Run section 1’s timer cleanup and section 9’s transient database cleanup on success and abort. Remove the Mac window file through the runbook. Respect deletion guards; do not bypass a refusal.

Report separately: **backup helpers released**, **migration applied**, **OAuth service released dark**, **GoTrue environment updated**, **OAuth ingress verified**, **recovery verified**, and **window closed**. Public authorization, HM3 edge release, lane 7, site/CLI release and real-client interoperability remain outside this window.

## Changes from v1

1. Replaced release SHA `fc80f6cd…` with `9fa4217d…` throughout; updated measured merge identity and parent.
2. Recorded HM2 run 4 as live, citing evidence commit `ffccd29c…`, live edge and applied migration 02; retained its mandatory read-only precondition.
3. Recorded the last measured active stack as `e38b499f…`, distinguishing committed evidence from current live verification.
4. Expanded archive scope to include HM3 code and migration 04.
5. Replaced the incorrect “03 is the only pending migration” assumption with complete 03/04 inventory and explicit HM3 deferral.
6. Updated manifest inputs to include deferred migration 04’s catalog/functional SQL without claiming its functional proof runs.
7. Removed the requirement for a separately released backup remedy: the selected SHA contains the schema-coverage changes.
8. Established the actual timer-to-helper execution chain through `stack/current`.
9. Added the exact `stack/current` transition to the selected SHA before migration apply.
10. Changed `GUARDED_STACK_SWITCH` and `BACKUP_STATUS_PROOF` to `yes`.
11. Added `migrate/` to runtime-difference review and identified unchanged Compose, PostgreSQL and unit files.
12. Specified no stack-container restart for helper activation; retained only the conditional GoTrue recreation.
13. Added the schema-absent backup ordering constraint: old complete backup first, helper switch, migration, new complete backup.
14. Added timer scheduling checks and a Bash-compatible guarded switch with file-backed activation timestamps.
15. Retained the corrected activating-oneshot backup wait and four-hour deadline.
16. Added post-apply artifact binding, checksum, schema and six-table-data-entry verification using `pg_restore --list`, without printing rows.
17. Distinguished backup inclusion from isolated recovery and identified role-setting/database-grant recovery that the drill does not itself establish.
18. Replaced registry image selection/pull with an on-box build before switching, local image-ID pinning and `--pull never`.
19. Added exact base digest, Dockerfile/lockfile hashes and local image identity evidence; prohibited secret build inputs.
20. Replaced unresolved database addressing with the confirmed hostname, fixed address and port.
21. Corrected the CA source and container path to `/etc/ssl/yulan-internal-ca.pem`; documented stale prose in the service runbooks.
22. Added actual in-container `getent`, TLS authorization, hostname/SAN and runtime-role authentication checks before HTTP starts.
23. Explicitly required both signing and cookie material in suffixed 1Password items, with protected retrieval verification.
24. Retained out-of-band SCRAM provisioning and file-only runtime password delivery.
25. Added explicit execution-location comments and explicit `PROOF_DIR` initialization; kept runnable blocks compatible with the stated shell restrictions.
26. Clarified that this window reads no `cswarm` credential artifact and documented the required 0.1.80 fields for any added control.
27. Corrected the catalog description: two complete column inventories are checked, not all six.
28. Preserved reviewed SQL while distinguishing its text checks from supplemental structural `pg_proc` checks and HM2’s `pg_depend` proof.
29. Added before/after global default-ACL evidence for rollback reconciliation.
30. Updated GoTrue recreation to use the newly active stack and skip recreation when the running allowlist already satisfies the requirement.
31. Removed v1’s OAuth-import injection; the source already activates OAuth. Rendering now substitutes five port occurrences only.
32. Corrected public probes to use `/interaction/<id>`, expect 404 for bare `/interaction` and `/connections`, and verify wrong-method 405.
33. Added public health and active-`kid` assertions; distinguished direct-service checks from Caddy behavior.
34. Expanded curated runtime evidence to include image ID, network, host mapping, tmpfs and healthcheck settings.
35. Added backup-helper rollback coordination: retained OAuth schema requires retained coverage; removed schema requires compatible helpers.
36. Preserved verbatim SQL rollback, empty-data/session gates, key retention, timer cleanup and manifest-only copy-back.
37. Kept the edge explicitly fixed at `72c57e0d…` and separated archive contents from deployed surfaces.
38. Expanded closure evidence and status reporting without claiming production execution or unmeasured recovery/interoperability success.
