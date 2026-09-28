# HM lane 6: dark OAuth service box window — v3 RETRY

**Status: PLAN. Retry execution, approval, production success and closure are not established.**

**Release SHA: `ad964ed158181ba1692dd05895f36fa7a1f87d3f`.**

The release SHA is the landed merge `ad964ed158181ba1692dd05895f36fa7a1f87d3f` on `main` (merge of `lane/hm6-proof-fix`, Actions server suite run 36416173603). The lead substituted it for the draft's placeholder and recomputed every listed file hash against that tree; only the rollback file's hash changed (proof fix round 6). Window approval and execution are not established.

Anvil executes all Mac mini, box, Cloudflare and 1Password operations. HezLead approves the exact inputs, transitions, backup age, isolated recovery procedure and rollback, and closes the window. CSwarmDevLead supplies reviewed inputs and reconciles evidence. A Cloudflare security change additionally requires Tom’s approval and suitable dashboard access.

## Governing procedure and execution rules

Follow [`deploy/RELEASE-TO-BOX.md`](../../../deploy/RELEASE-TO-BOX.md), especially sections 1–3, 5, the guarded stack switch in section 7, section 8 and section 9 cleanup. Host operations follow workspace `hetzner-handoff/HETZNER-OPERATIONS.md`.

Service contracts:

- [`deploy/mcp-auth/compose.yaml`](../../../deploy/mcp-auth/compose.yaml)
- [`deploy/mcp-auth/env.example`](../../../deploy/mcp-auth/env.example)
- [`deploy/mcp-auth/RUNBOOK.md`](../../../deploy/mcp-auth/RUNBOOK.md)
- [`deploy/mcp-auth/VERIFICATION.md`](../../../deploy/mcp-auth/VERIFICATION.md)
- [`docs/design/2026-09-27-HM-LANE-PLAN.md`](../../design/2026-09-27-HM-LANE-PLAN.md)

Referenced runbook operations remain required. Their inclusion does not authorize an edge release, unrelated service recreation or additional migration.

Every executable block below has a unique step identifier and execution location. Mac mini blocks run under macOS `/bin/bash` 3.2. Docker commands run only on the box. Do not enable tracing, assign `HOME`, print credentials or complete environment/container configurations, or put secret values in arguments, URLs, environment values, logs or evidence.

No block uses recursive deletion. Any later cleanup requiring `rm -rf` must be separately reviewed and may target only a checked absolute path created with `mktemp` in that same block.

On every refusal or failure, stop dependent work, record actual state and run the runbook’s abort cleanup. Do not manufacture successful evidence for skipped work.

## First window and retry baseline

The first window used suffix `080406` and release `9fa4217da9f6447e55fb8c6d577b8fd3997f926b`.

HezLead’s read-only box report through Anvil, **2026-09-28 08:33Z**, states:

| Surface | Reported state |
|---|---|
| First window | Aborted; migration transaction rolled back |
| Migration 03 | Ledger count `0`, catalog `f`, no `commonswarm_oauth` schema and no runtime role |
| Edge | Remained `72c57e0d76d0aa86fe4f811a2cf51499919fed20` |
| Stack | Restored to `e38b499fc29a01935333e38f66c4e68ac7e1f81e` |
| Maintenance timers | Active |
| Caddy and GoTrue | Unchanged |
| First-window checks | Plan hash and 19/19 blocks, HM2 dependency and HM6 first-install database baseline passed |
| First-window backup | Offsite verified at `08:14:08Z`; retry freshness remains to be checked |
| Leftovers | Old immutable OAuth release, local image, `cs-oauth-080406`, empty `/etc/commonswarm-oauth` |

Committed diagnostic evidence is in [`docs/evidence/2026-09-28-release-9fa4217da9f6/`](../2026-09-28-release-9fa4217da9f6/), recorded by evidence commit `ed6b55fe`.

The diagnostic identified exactly two false **leaf predicates**: `status_search_path_is_fixed` and `family_search_path_is_fixed`. Their parent conjunctions and final catalog result were consequently false. The failing leaf checks matched deparsed function text. Other diagnostic leaf predicates passed. See [`20260928000003-diagnostic-row.txt`](../2026-09-28-release-9fa4217da9f6/20260928000003-diagnostic-row.txt).

[`diagnostic-window-state.txt`](../2026-09-28-release-9fa4217da9f6/diagnostic-window-state.txt) records:

- Service account `cs-oauth-080406`, UID `996`, GID `986`.
- Configuration directory `root:cs-oauth-080406`, mode `0750`, zero entries.
- Preserved image `sha256:c298ced5404dbdeddbbf4225456387455f74a6211fdf0afa44bb75cda7fb9267`.

These are historical measurements, not substitutes for retry preflight. Any disagreement with them stops the window.

A failed forward transaction does not require a down-migration. Re-establish absence before proceeding.

## Release identity and scope

The release archive contains more than this window activates.

| Content measured in the supplied tree | Retry disposition |
|---|---|
| Migration `20260928000003_hm_oauth_store.sql` and corrected proofs | Apply migration 03 only |
| OAuth service and deployment configuration | Build from `ad964ed158181ba1692dd05895f36fa7a1f87d3f`; release with public authorization disabled |
| OAuth-inclusive backup, restore and drill helpers | Activate through the guarded `stack/current` switch before migration |
| OAuth-only `commonswarm-mcp.caddy` | Render its five port substitutions and install |
| GoTrue callback configuration | Append the callback while preserving the live allowlist |
| DNS | Create the missing proxied `mcp.commonswarm.com` A record |
| HM3 hosted-check protocol, command/authentication changes and migration 04 | Later window; do not apply 04 or release edge |
| HM7 MCP worker and router changes | Later window; do not release edge |
| HM8 consent and Connected apps changes | No site deployment or public feature activation |
| CLI, listener, site, H0, earlier migration, ingress, test and documentation changes carried beyond the old stack archive | Archive contents only unless explicitly named above |

There is an important scope distinction: the current OAuth source includes HM8 service-side changes in `services/mcp-auth/src/`, including consent, interaction and connection handling. Building the exact release tree necessarily includes those bytes. `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED=0` keeps their public flows disabled. This window does not release the lane 8 site or claim lane 8 acceptance.

Compared with restored stack `e38b499f`, the tree has no changes to `deploy/supabase-stack/compose.yaml`, `postgres/`, or the four backup/restore unit files. Backup and migration helpers do change. Other stack-directory differences include API/maintenance Caddy files, removal of the fallback Caddy file, examples and documentation. Do not install those unrelated Caddy changes.

Compared with live edge `72c57e0d`, **both function code and edge deployment code have changed**: `deploy/edge-runtime/main/index.ts`, `main/router.ts`, `env.example`, hosted-seat authentication, the protocol bundle, command handling and the new MCP worker. V2’s statement that the edge deployment directory has no intervening diff is no longer true.

**The active edge remains `72c57e0d76d0aa86fe4f811a2cf51499919fed20`.** Staging an edge archive does not release it. Do not change its current symlink, recreate its container or change its environment.

Lanes 3, 7 and 8 remain later windows. `/mcp` and protected-resource metadata remain dark. No site, CLI package, public authorization or real-client interoperability is released or claimed.

## Corrected migration and proof contract

The reviewed migration pins `createrole_self_grant=''` immediately before creating `commonswarm_oauth_runtime`. It does not attempt a self-grant or repair unsafe surviving role state.

The accepted creator shapes are:

- Non-superuser creator: exactly one admin-only creator membership, with `SET FALSE` and `INHERIT FALSE`.
- Superuser creator: no unnecessary creator membership.

Any membership granting SET or INHERIT **into** the runtime role is refused. Supplemental verification below also refuses any parent-role membership **of** the runtime role. An admin-only creator membership is not runtime access and must not be rejected merely because a membership row exists.

The catalog checks function properties using `pg_proc`, `pg_language` and `proconfig`, and column inventories using `pg_attribute`. It does not use deparsed function/view text, `prosrc` or `information_schema.columns`. This statement concerns the HM6 catalog proof; the governing release wrapper retains its own ledger-shape check.

[`tests/p1-server/oauth-store.test.ts`](../../../tests/p1-server/oauth-store.test.ts) exercises the non-superuser production-shaped apply path, production search path, default and configured creator self-grant settings, refusal of unsafe existing membership, superuser behavior and rollback. Ledger bookkeeping uses the stack migration owner. Test source establishes coverage intent, not a passing exact-SHA run.

The catalog checks six tables, ownership/RLS, two complete column-name inventories, 15 indexes, six primary keys, two foreign keys, one unique constraint, 29 checks, seven policies, role properties and selected privileges/default ACLs. It does not establish every column property of every table or the complete semantics of dynamic SQL. Functional and PostgreSQL integration acceptance remain required.

## Measured input hashes

All SHA-256 values below were recomputed from the supplied tree. The release archive hash, rendered Caddy hash, new image ID, final plan hash and runtime evidence hashes are **not established**; measure them during the approved preparation.

| Path | SHA-256 |
|---|---|
| `deploy/RELEASE-TO-BOX.md` | `7c8494d3ec952aa3206d39cb99b49835e5c37cfe53cc5f4de61b815952d7eda5` |
| `supabase/migrations/20260928000003_hm_oauth_store.sql` | `e6f6944154b01e7f80a366058754639700c81279cfec4eaff6fe601a6ad99638` |
| `deploy/release-proofs/item-hm/20260928000002-catalog.sql` | `83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144` |
| `deploy/release-proofs/item-hm/20260928000003-catalog.sql` | `5d65f11724b31dadceea089c010eea3ee641d4eb1582f9e9cf0ac3e674c88243` |
| `deploy/release-proofs/item-hm/20260928000003-functional.sql` | `4c23fbd14ad2a04c9a74900b4bff097e42a239bf8847dcdd32b7426a678cac91` |
| `deploy/release-proofs/item-hm/20260928000003-rollback.sql` | `f6337cda45a8db86f4d2aa4e8e658e09125d5e3e2c2aa137519240e50a82a20f` |
| `deploy/release-proofs/item-hm/20260928000003-rollback-catalog.sql` | `c37b9be8c3cd69bfc82e8e67f3955d31b0f6c395aa592b46d1ce556a2b536d1d` |
| `deploy/release-proofs/item-hm/20260928000003-diagnostic.sql` | `101a014db0bbe7efbe7505c5efe04ded78637bc11bcb16a99964388d02d318e8` |
| `deploy/release-proofs/item-hm/20260928000004-catalog.sql` | `1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1` |
| `deploy/release-proofs/item-hm/20260928000004-functional.sql` | `26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659` |
| `services/mcp-auth/Dockerfile` | `02c355aafe8b90ffd6e1c7bb636f60d5d5ca7850e15b7b1c5543fb558484a66a` |
| `services/mcp-auth/package-lock.json` | `08da8a06cb5723641bca72967cbad5e52b0b91d29cf29b459d1bad496a1be1bd` |
| `deploy/mcp-auth/compose.yaml` | `4ca9f55899d84f52744030f12bc23dfe5429d87f150d6bbd18f5efe871beef2c` |
| `deploy/supabase-stack/commonswarm-mcp.caddy` | `c00c3ee1a4331335a7c078848c490a827afcb517bf5f94b729396c68e42f16f1` |

The Dockerfile pins:

`node:22.23.3-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`

It installs locked dependencies with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`; `oidc-provider` is exactly `9.12.2`.

## Approvals, order and remaining measurements

Before opening, HezLead accepts:

1. Landed exact SHA, independent review, exact-SHA gates and this final plan’s hash and complete block inventory.
2. Window start/end, fresh suffix, maximum backup age and maintenance scheduling.
3. Migration 03 apply and explicit migration 04 deferral.
4. Verified reuse of the old service account and empty configuration directory.
5. Preservation of the old release/image and rebuild from the new archive.
6. Stack helper activation, dark OAuth deployment, conditional GoTrue recreation, DNS creation and Caddy installation.
7. Isolated recovery procedure, including role settings, database grants and protected credential recovery.
8. Cloudflare stop ownership. No security relaxation is authorized by this plan alone.

Required order:

| Order | Stage |
|---:|---|
| 1 | Exact-SHA archive, gates, checksums, manifest and durable window state |
| 2 | Retry leftovers, HM2 dependency, HM6 database absence, deferred HM3 and complete pending inventory |
| 3 | Fresh complete backup if needed, using old helpers |
| 4 | Verify old OAuth archive; stage fresh stack, edge and OAuth archives; build image |
| 5 | Prepare protected keys/configuration; review stack differences |
| 6 | Guarded stack helper switch, then fresh backup-age check and transactional migration 03 |
| 7 | Privileges, runtime password provisioning and actual-container database/TLS proof |
| 8 | Start dark OAuth; runtime and loopback controls |
| 9 | Preserve/append GoTrue callback and conditionally recreate only GoTrue |
| 10 | Read-only certificate verification; create/read back DNS |
| 11 | Install/validate/reload Caddy; immediately run both non-browser probe suites |
| 12 | Controlled OAuth restart, post-apply complete backup and isolated recovery acceptance |
| 13 | Deferred-lane and unchanged-edge checks, timers, cleanup, manifest-only copy-back and closure |

The database name, enabled GoTrue provider, free host port, Cloudflare zone/record IDs, DNS token field reference, final site path, exact-SHA gate results and isolated recovery results are **not established**. Measure before dependent steps.

### Names and credentials

The box computes `WINDOW_PRINCIPAL_SUFFIX` once from `WINDOW_START_UTC` and saves it in `window.env`. Require a fresh suffix different from `080406`, with no prior use or collision.

All newly minted principal/account/item names derive from that saved suffix. **The only reuse exception is the explicitly verified OS service account `cs-oauth-080406`.** Do not reuse its old suffix for new signing identities, vault items or control principals.

`commonswarm_oauth_runtime` is the fixed migration-defined database role, not a minted control principal.

This plan requires no CommonSwarm control principal and reads no `cswarm` credential JSON. If a separately approved control is added, read and validate all four real fields: `agent_token`, `principal_id`, `token_id`, `run_id`. Reject missing, empty or non-string values without printing credentials. Never substitute a guessed `token` field.

## Section 1 inputs and manifest

Use the current runbook’s section 1 with:

| Input | Value |
|---|---|
| `SHA` | `ad964ed158181ba1692dd05895f36fa7a1f87d3f` |
| `KIND_LIST` | `stack` |
| `H0_LEDGER_BACKFILL` | `no` |
| `GUARDED_STACK_SWITCH` | `yes` |
| `BACKUP_STATUS_PROOF` | `yes` |
| `MIGRATION_VERSIONS` | `20260928000003`, `20260928000004` |
| `FUNCTIONAL_VERSIONS` | `20260928000003` |
| Apply | 03 only |
| Defer | 04, with explicit recorded disposition |
| Expected cron additions/removals | Empty |

`KIND_LIST=stack` selects the deployed runbook surface. A separate named step below stages the **edge archive only**, using the current runbook’s identical directory verifier. This avoids selecting the runbook’s edge activation branch or generating false edge-release evidence. Both new stack and edge directories are expected to be fresh.

The current runbook supports reuse of an existing same-SHA directory only after verifying its complete path inventory/count, bytes, `RELEASE_SHA`, entry types, symlink targets/containment, ownership and modes. It never extracts over, deletes or repairs an existing release directory. Record `created` or `reused` truthfully. For this fresh retry, an unexpectedly existing new-SHA directory is a stop for HezLead to reconcile before accepting the verified reuse path.

Do not touch the old `9fa4217d` stack/edge directories. The old OAuth directory is read only for verification.

Require exact-SHA gate evidence, including:

- `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS`
- `npm run check:edge: PASS`
- OAuth unit/security tests.
- PostgreSQL adapter/refresh/consent tests and `tests/p1-server/oauth-store.test.ts`.
- Docker acceptance and routing checks.
- Backup/restore coverage checks.

Relevant sources include `services/mcp-auth/test/`, `services/mcp-auth/test-postgres/`, `tests/p1-cli/mcp-auth-container.test.ts`, `tests/hm5-router-box.test.ts`, `tests/p1-server/oauth-store.test.ts` and `deploy/supabase-stack/backup/test_*.py`. Do not infer success from their presence or workflow definitions.

Hash the final substituted plan and enumerate every executable block by unique step ID. Record syntax-check results and reconcile the count. First-window 19/19 evidence does not approve v3.

Add these exact item paths through `ITEM_COPY_BACK_FILES`:

- `20260928000002-catalog.sql`
- `20260928000003-rollback.sql`
- `20260928000003-rollback-catalog.sql`
- `reviewed-inputs.sha256`
- `verification-sql.sha256`
- `retry-leftovers.json`
- `oauth-old.SHA256SUMS`
- `oauth-old.release-dir-state.txt`
- `edge.SHA256SUMS`
- `edge.release-dir-state.txt`
- `edge-staging-only.txt`
- `oauth.SHA256SUMS`
- `oauth.release-dir-state.txt`
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
- `oauth-image.json`
- `oauth-port.txt`
- `oauth-runtime.json`
- `oauth-database-proof.txt`
- `oauth-local-probes.json`
- `oauth-nonbrowser-probes.json`
- `oauth-restart-probes.json`
- `gotrue-allow-list.json`
- `oauth-caddy-rendered.caddy`
- `oauth-caddy.diff`
- `oauth-certificate-check.txt`
- `oauth-dns-record.json`
- `oauth-ingress-facts.json`
- `oauth-recovery-proof.txt`
- `close-readback.txt`

The generator supplies migration catalog/functional SQL, stack checksums/state, timer proof and backup-status evidence. Do not duplicate those entries.

Never copy `window.env`, secret files, raw environment/inspection/log output, database dumps, 1Password documents or curl authorization configuration. On abort, use the runbook’s explicit incomplete-manifest handling; preserve failure evidence without creating missing success files.

## Verify reviewed inputs and stage SQL

```sh
# step: hm6-verify-reviewed-inputs
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  python3 - "$NEW_STACK" "$PROOF_DIR" <<'PY'
import hashlib, pathlib, sys
root, proof = map(pathlib.Path, sys.argv[1:])
expected = {
'deploy/RELEASE-TO-BOX.md': '7c8494d3ec952aa3206d39cb99b49835e5c37cfe53cc5f4de61b815952d7eda5',
'supabase/migrations/20260928000003_hm_oauth_store.sql': 'e6f6944154b01e7f80a366058754639700c81279cfec4eaff6fe601a6ad99638',
'deploy/release-proofs/item-hm/20260928000002-catalog.sql': '83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144',
'deploy/release-proofs/item-hm/20260928000003-catalog.sql': '5d65f11724b31dadceea089c010eea3ee641d4eb1582f9e9cf0ac3e674c88243',
'deploy/release-proofs/item-hm/20260928000003-functional.sql': '4c23fbd14ad2a04c9a74900b4bff097e42a239bf8847dcdd32b7426a678cac91',
'deploy/release-proofs/item-hm/20260928000003-rollback.sql': 'f6337cda45a8db86f4d2aa4e8e658e09125d5e3e2c2aa137519240e50a82a20f',
'deploy/release-proofs/item-hm/20260928000003-rollback-catalog.sql': 'c37b9be8c3cd69bfc82e8e67f3955d31b0f6c395aa592b46d1ce556a2b536d1d',
'deploy/release-proofs/item-hm/20260928000003-diagnostic.sql': '101a014db0bbe7efbe7505c5efe04ded78637bc11bcb16a99964388d02d318e8',
'deploy/release-proofs/item-hm/20260928000004-catalog.sql': '1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1',
'deploy/release-proofs/item-hm/20260928000004-functional.sql': '26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659',
'services/mcp-auth/Dockerfile': '02c355aafe8b90ffd6e1c7bb636f60d5d5ca7850e15b7b1c5543fb558484a66a',
'services/mcp-auth/package-lock.json': '08da8a06cb5723641bca72967cbad5e52b0b91d29cf29b459d1bad496a1be1bd',
'deploy/mcp-auth/compose.yaml': '4ca9f55899d84f52744030f12bc23dfe5429d87f150d6bbd18f5efe871beef2c',
'deploy/supabase-stack/commonswarm-mcp.caddy': 'c00c3ee1a4331335a7c078848c490a827afcb517bf5f94b729396c68e42f16f1',
}
for name, digest in expected.items():
    path = root / name
    assert path.is_file() and not path.is_symlink(), name
    assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, name
(proof / 'reviewed-inputs.sha256').write_text(''.join(
    f'{digest}  {name}\n' for name, digest in sorted(expected.items())))
print(f'reviewed input hashes: PASS ({len(expected)} files)')
PY
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

The old diagnostic is historical evidence, not the corrected acceptance proof. Do not run it instead of the new catalog.

## Retry leftovers: exact expected state

Before keys, configuration, service activation or helper switching, require:

- Only the old SHA directory under `/home/commonswarm/oauth/releases/`.
- No OAuth current symlink, including a dangling symlink.
- No OAuth Compose containers, including stopped containers.
- Exactly the old OAuth service account/group; no new-suffix collision.
- Empty, non-symlink `/etc/commonswarm-oauth` with recorded ownership/mode.
- The recorded local image exists.
- No old-account processes.
- No additional OAuth secret, installation or account state.

Unrelated Docker images are outside this inventory. Any additional OAuth-associated artifact requires a new disposition; do not delete it to make preflight pass.

```sh
# step: hm6-verify-retry-leftovers
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  test "$(date -u -d "$WINDOW_START_UTC" +%H%M%S)" = "$WINDOW_PRINCIPAL_SUFFIX"
  test "$WINDOW_PRINCIPAL_SUFFIX" != 080406
  test "$(readlink -f /home/commonswarm/stack/current)" = \
    /home/commonswarm/stack/releases/e38b499fc29a01935333e38f66c4e68ac7e1f81e
  test "$(readlink -f /home/commonswarm/edge/current)" = \
    /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test -z "$(docker ps -aq --filter label=com.docker.compose.project=commonswarm-oauth)"
  python3 - "$PROOF_DIR" "$WINDOW_PRINCIPAL_SUFFIX" <<'PY'
import grp, json, os, pathlib, pwd, stat, subprocess, sys
proof = pathlib.Path(sys.argv[1])
suffix = sys.argv[2]
old_sha = '9fa4217da9f6447e55fb8c6d577b8fd3997f926b'
account = 'cs-oauth-080406'
release_root = pathlib.Path('/home/commonswarm/oauth/releases')
assert release_root.is_dir() and not release_root.is_symlink()
assert {p.name for p in release_root.iterdir()} == {old_sha}
old = release_root / old_sha
assert old.is_dir() and not old.is_symlink()
assert not os.path.lexists('/home/commonswarm/oauth/current')
users = [p for p in pwd.getpwall() if p.pw_name.startswith('cs-oauth-')]
groups = [g for g in grp.getgrall() if g.gr_name.startswith('cs-oauth-')]
assert len(users) == len(groups) == 1
user, group = users[0], groups[0]
assert user.pw_name == group.gr_name == account
assert (user.pw_uid, user.pw_gid, group.gr_gid) == (996, 986, 986)
assert user.pw_dir == '/nonexistent'
assert user.pw_shell == '/usr/sbin/nologin'
assert not group.gr_mem
assert not [g for g in grp.getgrall() if account in g.gr_mem]
assert subprocess.run(['pgrep', '-u', str(user.pw_uid)],
    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 1
directory = pathlib.Path('/etc/commonswarm-oauth')
st = directory.lstat()
assert stat.S_ISDIR(st.st_mode)
assert (st.st_uid, st.st_gid, stat.S_IMODE(st.st_mode)) == (0, 986, 0o750)
assert list(directory.iterdir()) == []
image = 'sha256:c298ced5404dbdeddbbf4225456387455f74a6211fdf0afa44bb75cda7fb9267'
actual = subprocess.check_output(
    ['docker', 'image', 'inspect', '--format', '{{.Id}}', image],
    text=True).strip()
assert actual == image
result = {
    'pass': True, 'old_release_sha': old_sha,
    'service_account': account, 'uid': 996, 'gid': 986,
    'configuration_directory_empty': True,
    'old_image_id': image, 'new_window_suffix': suffix,
    'old_release_disposition': 'retain; verify against old archive',
    'old_image_disposition': 'retain; rebuild from retry archive',
    'service_account_disposition': 'reuse after verification',
    'configuration_directory_disposition': 'reuse after verification'
}
(proof / 'retry-leftovers.json').write_text(json.dumps(result, indent=2) + '\n')
PY
  printf 'SERVICE_ACCOUNT=%q\nMCP_OAUTH_UID=%q\nMCP_OAUTH_GID=%q\n' \
    cs-oauth-080406 996 986 >>"$PROOF_DIR/window.env"
)
```

Also verify the old account remains locked and has no unexpected authorized access, scheduled work or supplementary authority. Record only the outcome, not password/shadow material.

### Old OAuth release: retain and verify

Create a historical archive on the Mac from the exact old commit and transfer it separately. Do not overwrite the retry archive.

```sh
# step: hm6-transfer-old-archive-for-verification
# Runs: Mac mini, as Anvil, under /bin/bash 3.2.
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  OLD_SHA=9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  test "$(git rev-parse "${OLD_SHA}^{commit}")" = "$OLD_SHA"
  OLD_ARCHIVE="/tmp/commonswarm-hm6-old-${OLD_SHA}.tar"
  test ! -e "$OLD_ARCHIVE"
  env COPYFILE_DISABLE=1 git archive --format=tar --output "$OLD_ARCHIVE" "$OLD_SHA"
  test "$(git get-tar-commit-id <"$OLD_ARCHIVE")" = "$OLD_SHA"
  shasum -a 256 "$OLD_ARCHIVE" >"$EVIDENCE_DIR/oauth-old-archive.sha256"
  scp "$OLD_ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-hm6-old.tar
)
```

Transfer the measured old archive checksum through the approved non-secret channel into `OLD_ARCHIVE_SHA256` in box `window.env`. Its value is not established here.

The following extracts the **unchanged** `prepare_release_directory` function from the hash-verified current runbook. It uses that same verifier for historical OAuth verification, fresh edge staging and fresh OAuth preparation.

```sh
# step: hm6-prepare-reviewed-directory-verifier
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test "$(sha256sum "$NEW_STACK/deploy/RELEASE-TO-BOX.md" | cut -d' ' -f1)" = \
    7c8494d3ec952aa3206d39cb99b49835e5c37cfe53cc5f4de61b815952d7eda5
  VERIFIER="/run/commonswarm-hm6-${SHA}-directory.sh"
  test ! -e "$VERIFIER"
  umask 077
  python3 - "$NEW_STACK/deploy/RELEASE-TO-BOX.md" "$VERIFIER" <<'PY'
import pathlib, sys
source = pathlib.Path(sys.argv[1]).read_text()
start_marker = '  prepare_release_directory() {\n'
assert source.count(start_marker) == 1
start = source.index(start_marker)
end = source.index('\n  for KIND in $KIND_LIST; do\n', start)
body = source[start:end]
assert body.rstrip().endswith('}')
with open(sys.argv[2], 'x') as output:
    output.write(body + '\n')
PY
  chmod 0600 "$VERIFIER"
)
```

```sh
# step: hm6-verify-old-oauth-release
# Runs: box over SSH, as root, operated by Anvil; old release is not modified.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-hm6-${SHA}-directory.sh"
  : "${OLD_ARCHIVE_SHA256:?old archive checksum missing}"
  ARCHIVE=/tmp/commonswarm-hm6-old.tar
  test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = "$OLD_ARCHIVE_SHA256"
  SHA=9fa4217da9f6447e55fb8c6d577b8fd3997f926b
  OLD_OAUTH="/home/commonswarm/oauth/releases/$SHA"
  test -d "$OLD_OAUTH"
  test ! -L "$OLD_OAUTH"
  RELEASE_OWNER=commonswarm
  RELEASE_GROUP=commonswarm
  PROOF_OWNER=root
  PROOF_GROUP=root
  prepare_release_directory oauth-old "$OLD_OAUTH" 0755
  test "$RELEASE_DIR_RESULT" = reused
)
```

A mismatch stops the window. Do not repair or delete the old directory. It is retained as historical evidence and is not selected as the retry’s active release.

### Fresh edge and OAuth directories

```sh
# step: hm6-stage-new-edge-and-oauth
# Runs: box over SSH, as root, operated by Anvil; does not activate edge.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "/run/commonswarm-hm6-${SHA}-directory.sh"
  ARCHIVE=/tmp/commonswarm-release.tar
  test "$(sha256sum "$ARCHIVE" | cut -d' ' -f1)" = \
    "$(cut -d' ' -f1 "$PROOF_DIR/box-archive.sha256")"
  RELEASE_OWNER=commonswarm
  RELEASE_GROUP=commonswarm
  PROOF_OWNER=root
  PROOF_GROUP=root
  NEW_EDGE="/home/commonswarm/edge/releases/$SHA"
  NEW_OAUTH="/home/commonswarm/oauth/releases/$SHA"
  test ! -e "$NEW_EDGE"
  test ! -L "$NEW_EDGE"
  test ! -e "$NEW_OAUTH"
  test ! -L "$NEW_OAUTH"
  prepare_release_directory edge "$NEW_EDGE" 0750
  test "$RELEASE_DIR_RESULT" = created
  prepare_release_directory oauth "$NEW_OAUTH" 0755
  test "$RELEASE_DIR_RESULT" = created
  printf 'NEW_OAUTH=%q\nEDGE_RELEASE_DIR_STATE=created\n' "$NEW_OAUTH" \
    >>"$PROOF_DIR/window.env"
  printf '%s\n' \
    'edge archive staged only; no override, environment, current symlink or container changed' \
    >"$PROOF_DIR/edge-staging-only.txt"
  test "$(readlink -f /home/commonswarm/edge/current)" = \
    /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
)
```

The old account and empty directory are reused as verified. No `useradd`, `groupadd`, directory replacement or old-artifact deletion is required.

## Database preflight

Run sections 2–3 for the protected **target-only** session. Do not use historical cutover credentials. Every database block sources `window.env` before the session helper.

```sh
# step: hm6-prove-database-preconditions
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
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

  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000003-catalog.sql
SELECT :'catalog_ok' = 'f'
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260928000003')
  AND to_regnamespace('commonswarm_oauth') IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_oauth_runtime')
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
    WHERE version = '20260928000004')
  AND to_regclass('swarm.hosted_mcp_check_cursors') IS NULL
  AND to_regclass('swarm.hosted_mcp_check_batches') IS NULL;
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm3-deferred-before.txt"
  test "$(cat "$PROOF_DIR/hm3-deferred-before.txt")" = t
)
```

SQL errors are failures, not `catalog=f`. A partial schema, surviving role, unexpected ledger state or changed default ACL stops the plan.

Run section 5’s complete migration enumeration and ledger reconciliation. Expected pending inventory is **03 and 04**. Record 04’s explicit deferral in `migration-dispositions.txt`; do not filter it from inventory, insert its ledger row or run its functional proof. Any additional pending migration or unexplained older version stops the window.

## Pre-change complete backup

Run section 5’s complete-backup gate before switching helpers and again immediately before applying 03. Save the safe outcome in `backup-gate-before.txt`.

Require:

- `ok`, `database_bytes_verified` and `object_bytes_verified` all true.
- `verified_at` within HezLead’s approved maximum age, with the runbook’s `-300` second clock allowance.
- Destination under `r2:yulan-vps-1-backups/000-commonswarm-postgres/`.
- No running backup.

The first window’s `08:14:08Z` backup is historical evidence; it is not automatically fresh enough for the retry.

If a fresh backup is needed, HezLead must approve its start **while the old helpers remain active**. Use the current five-second polling and 14,400-second deadline. `active`, `activating`, `deactivating` and `reloading` are busy states. Require the completed service result and full offsite verification.

The new dump helper requires `commonswarm_oauth` to exist. Do not switch helpers and then attempt the pre-migration backup, and do not create an empty schema to satisfy the helper.

## Build the retry image

Review box capacity. Build only from the new immutable service directory and its `.dockerignore`. No signing key, cookie key, password, private registry credential, build secret or SSH forwarding belongs in the build context.

Preserve the old local image. It is not a retry candidate merely because it exists. Build from the retry archive and use the resulting image ID. Reuse of the old ID is acceptable only if this fresh build produces the identical ID and verifies the same pinned base. The source has changed since the first window, so equality must not be assumed.

```sh
# step: hm6-build-retry-image
# Runs: box over SSH, as root, operated by Anvil, before release switches.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test ! -e "$PROOF_DIR/oauth-image.id"
  cmp -s "$NEW_STACK/services/mcp-auth/Dockerfile" \
    "$NEW_OAUTH/services/mcp-auth/Dockerfile"
  cmp -s "$NEW_STACK/services/mcp-auth/package-lock.json" \
    "$NEW_OAUTH/services/mcp-auth/package-lock.json"
  BASE_REFERENCE="$(python3 - "$NEW_OAUTH/services/mcp-auth/Dockerfile" <<'PY'
import pathlib, re, sys
lines = pathlib.Path(sys.argv[1]).read_text().splitlines()
assert lines
match = re.fullmatch(r'FROM ([^@\s]+@sha256:[0-9a-f]{64})', lines[0])
assert match
print(match.group(1))
PY
)"
  docker pull "$BASE_REFERENCE"
  python3 - "$BASE_REFERENCE" <<'PY'
import json, re, subprocess, sys
base = sys.argv[1]
digest = base.rsplit('@', 1)[1]
assert re.fullmatch(r'sha256:[0-9a-f]{64}', digest)
inspection = json.loads(subprocess.check_output(
    ['docker', 'image', 'inspect', base], text=True))[0]
repo_digests = inspection.get('RepoDigests')
assert isinstance(repo_digests, list)
assert any(isinstance(value, str) and '@' in value and
           value.rsplit('@', 1)[1] == digest for value in repo_digests)
PY
  docker build --pull=false \
    --iidfile "$PROOF_DIR/oauth-image.id" \
    --file "$NEW_OAUTH/services/mcp-auth/Dockerfile" \
    "$NEW_OAUTH/services/mcp-auth"
  MCP_OAUTH_IMAGE="$(cat "$PROOF_DIR/oauth-image.id")"
  [[ "$MCP_OAUTH_IMAGE" =~ ^sha256:[0-9a-f]{64}$ ]]
  python3 - "$NEW_OAUTH" "$PROOF_DIR" "$SHA" "$MCP_OAUTH_IMAGE" \
    "$BASE_REFERENCE" <<'PY'
import hashlib, json, pathlib, re, subprocess, sys
release, proof = map(pathlib.Path, sys.argv[1:3])
sha, image, base = sys.argv[3:]
service = release / 'services/mcp-auth'
lines = (service / 'Dockerfile').read_text().splitlines()
assert lines and lines[0] == 'FROM ' + base
base_digest = base.rsplit('@', 1)[1]
assert re.fullmatch(r'sha256:[0-9a-f]{64}', base_digest)
inspection = json.loads(subprocess.check_output(
    ['docker', 'image', 'inspect', image], text=True))[0]
assert inspection['Id'] == image
base_inspection = json.loads(subprocess.check_output(
    ['docker', 'image', 'inspect', base], text=True))[0]
repo_digests = base_inspection.get('RepoDigests')
assert isinstance(repo_digests, list)
assert any(isinstance(value, str) and '@' in value and
           value.rsplit('@', 1)[1] == base_digest for value in repo_digests)
base_rootfs = base_inspection.get('RootFS')
image_rootfs = inspection.get('RootFS')
assert isinstance(base_rootfs, dict) and base_rootfs.get('Type') == 'layers'
assert isinstance(image_rootfs, dict) and image_rootfs.get('Type') == 'layers'
base_layers = base_rootfs.get('Layers')
image_layers = image_rootfs.get('Layers')
assert isinstance(base_layers, list) and base_layers
assert isinstance(image_layers, list)
assert image_layers[:len(base_layers)] == base_layers
assert json.loads((service / 'package.json').read_text())[
    'dependencies']['oidc-provider'] == '9.12.2'
old = 'sha256:c298ced5404dbdeddbbf4225456387455f74a6211fdf0afa44bb75cda7fb9267'
result = {
    'release_sha': sha, 'local_image_id': image, 'built_image_id': image,
    'base_reference': base, 'base_digest': base_digest,
    'base_image_id': base_inspection['Id'],
    'base_layer_count': len(base_layers), 'base_layer_prefix_verified': True,
    'fresh_build_completed': True,
    'old_image_retained': True, 'fresh_build_matches_old_id': image == old,
    'dockerfile_sha256': hashlib.sha256((service / 'Dockerfile').read_bytes()).hexdigest(),
    'package_lock_sha256': hashlib.sha256((service / 'package-lock.json').read_bytes()).hexdigest(),
    'os': inspection['Os'], 'architecture': inspection['Architecture'],
    'build_secrets': False, 'application_registry_used': False
}
(proof / 'oauth-image.json').write_text(json.dumps(result, indent=2) + '\n')
PY
  printf 'MCP_OAUTH_IMAGE=%q\n' "$MCP_OAUTH_IMAGE" >>"$PROOF_DIR/window.env"
)
```

Use the resulting local `sha256:<image-id>` in Compose with `--pull never`. Validate it against the installed Compose version. Do not silently rebuild or substitute another ID after acceptance.

## Activate backup helpers, then apply migration 03

The installed backup unit must execute:

`/home/commonswarm/stack/current/deploy/supabase-stack/backup/run-backup.sh`

The restore unit must execute:

`/home/commonswarm/stack/current/deploy/supabase-stack/backup/restore-drill.py`

Record installed `ExecStart`, `ExecStartPre`, `ExecStopPost` and drop-in effects in `backup-unit-paths.txt`, without environment values. Stop on an unexplained execution path.

Review `compose.yaml`, `postgres/`, `backup/` **and `migrate/`** against `PREVIOUS_STACK`, recording every difference in `stack-runtime-review.txt`. The standard comparison omits `migrate/`, although the backup invokes it.

The only stack helper transition is:

- From `/home/commonswarm/stack/releases/e38b499fc29a01935333e38f66c4e68ac7e1f81e`
- To `/home/commonswarm/stack/releases/ad964ed158181ba1692dd05895f36fa7a1f87d3f`

Use section 7’s guarded switch and section 8’s unit-sync semantics. No stack-container restart is required. Only GoTrue may be recreated later.

Preserve v2’s stricter maintenance gates:

- Both backup/restore services must be inactive with `Result=success`.
- Do not clear a failed result to pass.
- Window must avoid the runbook’s prohibited periods.
- Both timer next-run times must be later than `WINDOW_END_UTC`, before stopping and after restarting timers.
- Record activation timestamps using files, not associative arrays.
- Wait with five-second polling and a 14,400-second deadline; never kill a maintenance service.
- Record stopped-timer state durably before stopping timers.
- Save installed units before switching, conditionally install changed units, reload systemd, restore timers and verify results.

If a persistent timer activates work during the schema-absent interval, let it finish and stop on failure.

Repeat backup freshness immediately before migration. Execute section 5’s preflight, transactional apply and verification with **`VERSION=20260928000003`**. Let the runbook derive the unique migration filename from the enumerated archive.

The runner owns transaction control, timeouts, ledger insertion and the pre-commit catalog assertion. Never run the migration bare or substitute the historical diagnostic.

Require:

- Before: ledger `0`, catalog `f`, no SQL error.
- After commit: ledger `1`, catalog `t`.
- Functional output exactly `t`.
- Empty added/removed cron sets.
- Migration 04 remains absent.

### Effective privileges

```sh
# step: hm6-prove-runtime-privileges
# Runs: box over SSH, as root, operated by Anvil, after migration 03.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000003-catalog.sql
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
    c.oid IS NOT NULL AND c.relkind = 'r' AND c.relrowsecurity
    AND pg_get_userbyid(c.relowner) = 'swarm_admin'
    AND has_table_privilege(r.oid, c.oid, bit) = (bit = ANY(e.allowed))
  ), false) AS ok
  FROM expected_tables e CROSS JOIN runtime r
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
  :'catalog_ok'::boolean
  AND (SELECT ok FROM table_bits)
  AND (SELECT ok FROM functions)
  AND (SELECT count(*) = 1 FROM runtime)
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN runtime r ON r.oid = m.member)
  AND NOT EXISTS (
    SELECT 1 FROM pg_auth_members m JOIN runtime r ON r.oid = m.roleid
    WHERE m.set_option OR m.inherit_option)
  AND NOT EXISTS (
    SELECT 1 FROM pg_namespace n CROSS JOIN runtime r WHERE n.nspowner = r.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_class c CROSS JOIN runtime r WHERE c.relowner = r.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_proc p CROSS JOIN runtime r WHERE p.proowner = r.oid)
  AND NOT EXISTS (
    SELECT 1 FROM pg_database d CROSS JOIN runtime r WHERE d.datdba = r.oid)
  AND EXISTS (
    SELECT 1 FROM pg_db_role_setting s CROSS JOIN runtime r
    WHERE s.setrole = r.oid AND s.setdatabase = 0
      AND s.setconfig = ARRAY['search_path=commonswarm_oauth, pg_catalog']::text[])
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'USAGE')
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'swarm', 'CREATE')
  AND NOT has_schema_privilege('commonswarm_oauth_runtime', 'commonswarm_oauth', 'CREATE'),
  false);
SQL
  release_psql_ro -Atq --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm6-privileges.txt"
  test "$(cat "$PROOF_DIR/hm6-privileges.txt")" = t
  date -u +%FT%TZ >"$PROOF_DIR/hm6-applied-at.txt"
)
```

Also review direct database/schema ACLs, column privileges, grant options, creator identity and database-specific role settings for unexpected authority. Distinguish PUBLIC access from direct grants.

Repeat the baseline default-ACL query into `hm6-default-acl-after.json`. Reconcile exactly the intended removal of PUBLIC EXECUTE. Unexpected permissions stop the window; do not repair them during release.

## Protected runtime inputs

Choose an unused port from `3490`–`3499` after inspecting live listeners. Record it as `MCP_OAUTH_HOST_PORT` in `window.env` and `oauth-port.txt`; recheck immediately before start.

Reuse `/etc/commonswarm-oauth` only after the empty-directory gate. Generate **new** ES256/P-256 signing and cookie keys on the box:

- Signing `kid`: `hm6-${WINDOW_PRINCIPAL_SUFFIX}`.
- `signing-keys.pem` contains a private JSON JWK set despite its filename.
- Cookie file contains the current key and a prior key, newline-delimited.
- Create files exclusively; a pre-existing file is a stop.

Anvil stores items **CommonSwarm OAuth signing keys ${WINDOW_PRINCIPAL_SUFFIX}**, **CommonSwarm OAuth cookie keys ${WINDOW_PRINCIPAL_SUFFIX}** and **CommonSwarm OAuth database credentials ${WINDOW_PRINCIPAL_SUFFIX}** in **Yulan Ventures Infra** with Anvil’s service-account method. For protected readback, Anvil reads each named item with Anvil’s service-account method into a separate mode-`0600` file inside the window’s private directory, then uses Anvil’s established secure file-transfer workflow to compare it with the corresponding box file without displaying contents. Record only item identities, public `kid` and verification outcomes.

Availability of a box-authenticated 1Password client is not established. Do not improvise authentication during the window.

After migration, Anvil provisions the runtime role’s SCRAM password out of band, as required by `deploy/mcp-auth/RUNBOOK.md`. The protected `database-credentials` file contains only the `user` and `password` fields read by `config.js`. Passwords do not enter release SQL, shell arguments or environment variables.

Require all three secret files to be regular non-symlink files, owned `root:986`, mode `0640`, mounted read only.

The shared CA is `/etc/ssl/yulan-internal-ca.pem`, mounted at the same container path. The current service runbooks now agree with Compose. Verify identity, runtime readability and `config.js`’s permission requirements without changing shared ownership or weakening TLS.

Prepare root-owned mode-`0600` `/etc/commonswarm-oauth/service.env`:

| Setting | Value |
|---|---|
| `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED` | `0` |
| `MCP_OAUTH_NATIVE_LOOPBACK_ENABLED` | `0` |
| `MCP_OAUTH_ISSUER`, `MCP_OAUTH_PUBLIC_ORIGIN` | `https://mcp.commonswarm.com` |
| `MCP_OAUTH_RESOURCE` | `https://mcp.commonswarm.com/mcp` |
| `MCP_OAUTH_ALLOWED_ORIGINS` | `https://commonswarm.com,https://www.commonswarm.com` |
| `MCP_OAUTH_GOTRUE_URL` | `https://api.commonswarm.com/auth/v1` |
| `MCP_OAUTH_GOTRUE_PROVIDER` | Measured enabled production provider |
| `SUPABASE_ANON_KEY` | Existing public anon configuration, transferred without printing |
| Database name | Measured target database |
| Database port | `5432` |
| Active signing `kid` | New saved window value |
| Code/access/refresh lifetimes | `60`, `300`, `2592000` seconds |

Compose input is root-owned mode `0600`, with the accepted image ID, UID `996`, GID `986`, selected port, service-env path, database host `db.commonswarm.internal` and address `172.31.0.10`. Compose supplies the four file paths. Do not use inline secret substitutes.

Run Compose configuration validation without printing the resolved configuration.

## Actual-container database proof

Before HTTP starts, prove name resolution, certificate identity and runtime-role authentication through the actual image, user, mounts, network and `extra_hosts`.

```sh
# step: hm6-prove-runtime-database
# Runs: box over SSH, as root, operated by Anvil; HTTP is not started.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" config -q
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" \
    run --rm --no-deps --pull never -T --entrypoint node oauth --input-type=module - \
    >"$PROOF_DIR/oauth-database-proof.txt" <<'JS'
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { checkServerIdentity } from 'node:tls';
import { loadConfig, createPool } from './src/config.js';
let pool, client;
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

Do not use an IP-only database host, disable hostname verification, substitute `sslmode=require` or start HTTP after failure.

## Start the dark service

```sh
# step: hm6-start-dark-service
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test -z "$(ss -H -ltnp "sport = :$MCP_OAUTH_HOST_PORT")"
  test ! -e /home/commonswarm/oauth/current
  test ! -L /home/commonswarm/oauth/current
  ln -s "$NEW_OAUTH" /home/commonswarm/oauth/current
  docker compose -p commonswarm-oauth \
    --env-file /etc/commonswarm-oauth/compose.env \
    -f "$NEW_OAUTH/deploy/mcp-auth/compose.yaml" \
    up -d --no-deps --pull never oauth
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

Reconcile actual inspection against:

- Accepted image ID and UID/GID `996:986`.
- `Memory=536870912`, `NanoCpus=1000000000`.
- Read-only root, all capabilities dropped, no-new-privileges.
- Exactly one publication: `127.0.0.1:<recorded port>` to `3490`.
- Exactly four reviewed read-only bind mounts.
- `/tmp` limited to 32 MiB with `noexec,nosuid,nodev`.
- Only `commonswarm-net`, with the expected database mapping.
- `unless-stopped`; `json-file`, `max-size=10m`, `max-file=3`.
- Healthy healthcheck: interval 10 seconds, timeout 3 seconds, six retries, start period 20 seconds.

Run loopback OAuth probes with the external Host/scheme headers. Save `oauth-local-probes.json`. Require health/discovery/JWKS positive controls and disabled issuance together. Caddy-only MCP, 404 and 405 expectations do not apply directly to the service.

## GoTrue callback

Append exactly:

`https://mcp.commonswarm.com/oauth/callback/gotrue`

to `GOTRUE_URI_ALLOW_LIST`, preserving every existing entry and avoiding duplicates.

For the repository’s three-entry baseline, the resulting list is:

`https://commonswarm.com/app,https://www.commonswarm.com/app,http://127.0.0.1:*/callback,https://mcp.commonswarm.com/oauth/callback/gotrue`

Save a protected rollback copy of `/home/commonswarm/.env`. Edit only that assignment and prove all unrelated assignments unchanged without printing them. Record safe before/after URLs and whether a change was needed in `gotrue-allow-list.json`.

Use the now-active stack’s Compose definition and existing environment/override wiring. Recreate only GoTrue, and only if the running service needs the new allowlist. Validate Compose quietly first. Wait up to 180 seconds for health, then verify loopback health, existing sign-in/redirect behavior and safe boot/database error summaries. Never print the complete running environment.

## Certificate: reuse existing files, read only

The 08:33Z operator report establishes:

- Certificate: `/etc/caddy/certs/commonswarm.com.pem`
- Key: `/etc/caddy/certs/commonswarm.com.key`
- Cloudflare Origin CA certificate.
- SANs `*.commonswarm.com` and `commonswarm.com`.
- Expiry date `2041-09-12`.
- Identical to 1Password item **Cloudflare origin cert commonswarm.com**.
- Wildcard coverage includes `mcp.commonswarm.com`.

No new certificate is requested or authorized.

Before DNS/Caddy activation, Anvil reads item **Cloudflare origin cert commonswarm.com** with Anvil’s service-account method into separate mode-`0600` certificate and key files inside the window’s private directory. Repeat read-only hostname, SAN, expiry, key-pair and protected-vault identity checks from those files. Record only public certificate metadata/fingerprint and pass/fail; never private key material. Verify Caddy can read the existing files.

```sh
# step: hm6-check-existing-certificate
# Runs: box over SSH, as root, operated by Anvil; read only.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  test -f /etc/caddy/certs/commonswarm.com.pem
  test ! -L /etc/caddy/certs/commonswarm.com.pem
  test -f /etc/caddy/certs/commonswarm.com.key
  test ! -L /etc/caddy/certs/commonswarm.com.key
  {
    openssl x509 -in /etc/caddy/certs/commonswarm.com.pem \
      -noout -checkhost mcp.commonswarm.com
    openssl x509 -in /etc/caddy/certs/commonswarm.com.pem \
      -noout -checkend 86400
    openssl x509 -in /etc/caddy/certs/commonswarm.com.pem \
      -noout -issuer -dates -ext subjectAltName -fingerprint -sha256
  } >"$PROOF_DIR/oauth-certificate-check.txt"
)
```

HezLead reconciles the result with the reported SANs/expiry and Anvil’s protected certificate/key/vault comparison before continuing. A discrepancy is a stop.

## DNS: create before Caddy activation

The 08:33Z operator report states that proxied A records to `178.105.29.28` exist for the apex, `api`, `edge-staging`, `site-staging` and `www`; no AAAA, CNAME or `mcp` record was present.

Create **one** record:

| Field | Value |
|---|---|
| Type | `A` |
| Name | `mcp.commonswarm.com` |
| Content | `178.105.29.28` |
| Proxied | `true` |
| TTL | Automatic |

Use the active DNS Edit token from **Yulan Ventures Infra / Cloudflare DNS token commonswarm.com**. Before this step, Anvil reads item **Cloudflare DNS token commonswarm.com** with Anvil’s service-account method into a mode-`0600` file at a fixed path inside the window’s private directory. Anvil records only that path as `CF_DNS_TOKEN_FILE` in the protected Mac window file, never the token value.

The token may reach curl **only through a mode-0600 curl configuration file**. Never put it in argv, a URL, environment variable, output or evidence. Do not print the 1Password item.

This step refuses any existing record for the hostname. On an interrupted same-window retry, first reconcile the saved creation receipt and live record; do not blindly create a duplicate or overwrite an unexpected record.

```sh
# step: hm6-create-and-read-back-dns
# Runs: Mac mini, as Anvil, under /bin/bash 3.2; before Caddy activation.
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  : "${CF_DNS_TOKEN_FILE:?DNS-token file path missing}"
  test -e "$CF_DNS_TOKEN_FILE"
  test ! -e "$EVIDENCE_DIR/oauth-dns-record.json"
  DNS_TMP="$(mktemp -d /tmp/commonswarm-hm6-dns.XXXXXX)"
  case "$DNS_TMP" in /tmp/commonswarm-hm6-dns.*) ;; *) exit 1 ;; esac
  test -d "$DNS_TMP"
  test ! -L "$DNS_TMP"
  chmod 0700 "$DNS_TMP"
  trap 'rm -f "$DNS_TMP/curl.conf"; rmdir "$DNS_TMP"' EXIT
  umask 077
  python3 - "$CF_DNS_TOKEN_FILE" "$DNS_TMP/curl.conf" <<'PY'
import os, pathlib, re, stat, sys
path = pathlib.Path(sys.argv[1])
st = path.lstat()
if not stat.S_ISREG(st.st_mode):
    raise SystemExit("DNS token file must be a regular file")
if stat.S_IMODE(st.st_mode) != 0o600 or st.st_uid != os.getuid():
    raise SystemExit("DNS token file ownership or mode check failed")
with open(path) as f:
    token = f.read().strip()
if not re.fullmatch(r"[A-Za-z0-9_-]+", token):
    raise SystemExit("DNS token format check failed")
config = pathlib.Path(sys.argv[2])
with config.open("x") as output:
    output.write("header = \"Authorization: Bearer " + token + "\"\n")
os.chmod(config, 0o600)
PY
  python3 - "$DNS_TMP/curl.conf" "$EVIDENCE_DIR/oauth-dns-record.json" <<'PY'
import json, os, pathlib, re, stat, subprocess, sys
config, evidence = map(pathlib.Path, sys.argv[1:])
st = config.lstat()
assert stat.S_ISREG(st.st_mode)
assert stat.S_IMODE(st.st_mode) == 0o600 and st.st_uid == os.getuid()
base = 'https://api.cloudflare.com/client/v4'
def request(path, method='GET', payload=None):
    command = ['curl', '-q', '--config', str(config),
               '--silent', '--show-error', '--fail',
               '--connect-timeout', '10', '--max-time', '40',
               '--proto', '=https', '--request', method]
    data = None
    if payload is not None:
        command += ['--header', 'Content-Type: application/json', '--data-binary', '@-']
        data = json.dumps(payload).encode()
    command.append(base + path)
    result = subprocess.run(command, input=data, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE)
    if result.returncode:
        raise SystemExit('Cloudflare DNS request failed; STOP and reconcile privately')
    try:
        value = json.loads(result.stdout)
        assert value.get('success') is True
        return value
    except Exception:
        raise SystemExit('Cloudflare DNS response failed validation; STOP')
def rows(path):
    value = request(path)
    result = value['result']
    assert isinstance(result, list)
    info = value.get('result_info', {})
    assert info.get('total_pages', 1) <= 1
    assert info.get('total_count', len(result)) == len(result)
    return result
assert request('/user/tokens/verify')['result']['status'] == 'active'
zones = rows('/zones?name=commonswarm.com&per_page=100')
assert len(zones) == 1 and zones[0]['name'] == 'commonswarm.com'
assert zones[0]['status'] == 'active'
zone = zones[0]['id']
assert re.fullmatch(r'[0-9a-f]{32}', zone)
path = '/zones/' + zone + '/dns_records'
assert rows(path + '?name=mcp.commonswarm.com&per_page=100') == []
wanted = {'type': 'A', 'name': 'mcp.commonswarm.com',
          'content': '178.105.29.28', 'proxied': True, 'ttl': 1}
created = request(path, 'POST', wanted)['result']
record = created['id']
assert re.fullmatch(r'[0-9a-f]{32}', record)
receipt = {'zone_id': zone, 'record_id': record, 'prior_records': [],
           'created_this_window': True, 'readback_verified': False,
           **wanted}
with evidence.open('x') as output:
    json.dump(receipt, output, indent=2)
    output.write('\n')
for key, value in wanted.items():
    assert created.get(key) == value
readback = request(path + '/' + record)['result']
for key, value in wanted.items():
    assert readback.get(key) == value
listed = rows(path + '?name=mcp.commonswarm.com&per_page=100')
assert len(listed) == 1 and listed[0]['id'] == record
receipt['readback_verified'] = True
evidence.write_text(json.dumps(receipt, indent=2) + '\n')
print('mcp proxied A creation and readback: PASS')
PY
)
```

Transfer only the safe receipt to the box proof directory. A create timeout can leave an uncertain result; reconcile the exact hostname through a read-only query before any retry or rollback. Never treat an absent receipt as proof that no record was created.

## Caddy activation

Before installation, inventory imported files and confirm no conflicting hostname definition. Save a protected prior file or record prior absence. Record the single approved path under `/etc/caddy/sites/` as `MCP_CADDY_SITE` in box `window.env`.

The source already imports `mcp_oauth_active`, leaves `mcp_resource_active` unimported and references the existing certificate/key. Substitute **only its five port placeholders**.

```sh
# step: hm6-render-oauth-caddy
# Runs: box over SSH, as root, operated by Anvil.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
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
assert '\ttls /etc/caddy/certs/commonswarm.com.pem /etc/caddy/certs/commonswarm.com.key\n' in source
assert '@mcp_unavailable path /mcp /.well-known/oauth-protected-resource/mcp' in source
(proof / 'oauth-caddy-rendered.caddy').write_text(
    source.replace('{$MCP_OAUTH_HOST_PORT}', str(port)))
PY
  DIFF_STATUS=0
  diff -u "$NEW_OAUTH/deploy/supabase-stack/commonswarm-mcp.caddy" \
    "$PROOF_DIR/oauth-caddy-rendered.caddy" >"$PROOF_DIR/oauth-caddy.diff" \
    || DIFF_STATUS=$?
  test "$DIFF_STATUS" -eq 1
)
```

HezLead reviews the diff. Preserve method restrictions, 128 KB POST ingress bound, timeouts, forwarding headers, no-store policy and discarded access logging. The service separately defaults to a 64 KiB body bound.

```sh
# step: hm6-install-reviewed-caddy
# Runs: box over SSH, as root, operated by Anvil; DNS readback must already pass.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  . "$PROOF_DIR/window.env"
  : "${MCP_CADDY_SITE:?approved site path missing}"
  case "$MCP_CADDY_SITE" in /etc/caddy/sites/*.caddy) ;; *) exit 1 ;; esac
  python3 - "$PROOF_DIR/oauth-dns-record.json" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
assert value['readback_verified'] is True
assert value['type'] == 'A' and value['name'] == 'mcp.commonswarm.com'
assert value['content'] == '178.105.29.28' and value['proxied'] is True
PY
  openssl x509 -in /etc/caddy/certs/commonswarm.com.pem \
    -noout -checkhost mcp.commonswarm.com
  install -o root -g root -m 0644 \
    "$PROOF_DIR/oauth-caddy-rendered.caddy" "$MCP_CADDY_SITE"
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  systemctl reload caddy
)
```

On validation or reload failure, immediately restore the saved prior file or absence, validate and reload. Do not leave invalid disk configuration.

## Immediate non-browser gate and Cloudflare stop

The 08:33Z report states:

- Browser Integrity Check is **ON**.
- Security Level is **medium**.
- BIC already returns error `1010` to non-browser User-Agents on `edge-staging`.
- Bot-management and WAF rule reads return `403` with available tokens.
- Effective MCP security-rule configuration is **not established**.

Do not assume the hostname-scoped bypass described by service documentation exists. This plan does not authorize creating it.

**Immediately after DNS and Caddy activation**, run both:

1. curl with `-A "claude-connector-test/1.0"`.
2. Python urllib with its actual default User-Agent, not an explicitly supplied browser or Python-version string.

Both must reach health, discovery, JWKS, token and MCP behavior through the public proxied hostname. No credentials, redirects or origin bypass.

Copy the box’s public signing `kid` into the protected Mac window file as `MCP_OAUTH_ACTIVE_SIGNING_KID`.

```sh
# step: hm6-probe-nonbrowser-ingress
# Runs: Mac mini, as Anvil, under /bin/bash 3.2, immediately after DNS and Caddy.
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = ad964ed158181ba1692dd05895f36fa7a1f87d3f
  : "${MCP_OAUTH_ACTIVE_SIGNING_KID:?public signing kid missing}"
  python3 - "$EVIDENCE_DIR/oauth-nonbrowser-probes.json" \
    "$MCP_OAUTH_ACTIVE_SIGNING_KID" <<'PY'
import json, pathlib, subprocess, sys, urllib.error, urllib.request
output = pathlib.Path(sys.argv[1])
assert not output.exists()
kid = sys.argv[2]
base = 'https://mcp.commonswarm.com'
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
opener = urllib.request.build_opener(NoRedirect)
tests = [
('/health', 'GET', 200, None),
('/.well-known/oauth-authorization-server', 'GET', 200, None),
('/.well-known/openid-configuration', 'GET', 200, None),
('/jwks', 'GET', 200, None),
('/authorize', 'GET', 503, 'authorization_service_disabled'),
('/token', 'POST', 503, 'authorization_service_disabled'),
('/interaction/hm6-dark-probe', 'GET', 503, 'authorization_service_disabled'),
('/interaction/hm6-dark-probe', 'POST', 503, 'authorization_service_disabled'),
('/oauth/callback/gotrue', 'GET', 503, 'authorization_service_disabled'),
('/mcp', 'POST', 503, 'feature_disabled'),
('/mcp', 'OPTIONS', 503, 'feature_disabled'),
('/.well-known/oauth-protected-resource/mcp', 'GET', 503, 'feature_disabled'),
('/interaction', 'GET', 404, 'not_found'),
('/connections', 'GET', 404, 'not_found'),
('/token', 'GET', 405, 'method_not_allowed'),
]
results = []
def fetch(client, path, method):
    if client == 'curl':
        command = ['curl', '-q', '--silent', '--show-error',
            '--connect-timeout', '10', '--max-time', '25',
            '--proto', '=https', '-A', 'claude-connector-test/1.0',
            '--request', method,
            '--header', 'Content-Type: application/x-www-form-urlencoded']
        if method == 'POST':
            command += ['--data-binary', '']
        command += ['--write-out', '\n%{http_code}\n%{content_type}', base + path]
        value = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if value.returncode:
            raise RuntimeError('transport failure')
        body, status, content_type = value.stdout.rsplit(b'\n', 2)
        return int(status), content_type.decode(), body
    req = urllib.request.Request(base + path, method=method,
        data=b'' if method == 'POST' else None,
        headers={'Content-Type': 'application/x-www-form-urlencoded'})
    try:
        response = opener.open(req, timeout=25)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        return response.code, response.headers.get('Content-Type', ''), response.read(131073)
def validate(path, status, content_type, body, expected, error):
    assert status == expected
    assert 'application/json' in content_type and len(body) <= 131072
    document = json.loads(body)
    if error:
        assert document.get('error') == error
    if path == '/health':
        assert document['status'] == 'ok'
    if path in ('/.well-known/oauth-authorization-server',
                '/.well-known/openid-configuration'):
        assert document['issuer'] == base
        assert document['authorization_endpoint'] == base + '/authorize'
        assert document['token_endpoint'] == base + '/token'
        assert document['jwks_uri'] == base + '/jwks'
    if path == '/jwks':
        assert document.get('keys')
        assert kid in {key.get('kid') for key in document['keys']}
        for key in document['keys']:
            assert key['kty'] == 'EC' and key['crv'] == 'P-256'
            assert key.get('alg') == 'ES256' and key.get('kid')
            assert not set(key).intersection({'d','p','q','dp','dq','qi','oth','k'})
for client in ('curl', 'urllib-default'):
    for path, method, expected, error in tests:
        result = {'client': client, 'path': path, 'method': method, 'pass': False}
        try:
            status, content_type, body = fetch(client, path, method)
            result['status'] = status
            result['html_response'] = 'text/html' in content_type.lower()
            result['error_1010_observed'] = b'1010' in body
            validate(path, status, content_type, body, expected, error)
            result['pass'] = True
        except Exception:
            result['failure'] = 'transport or response contract failed'
        results.append(result)
passed = all(item['pass'] for item in results)
output.write_text(json.dumps({
    'pass': passed,
    'curl_user_agent': 'claude-connector-test/1.0',
    'urllib_user_agent': dict(opener.addheaders).get('User-agent'),
    'results': results
}, indent=2) + '\n')
if not passed:
    raise SystemExit('STOP: non-browser ingress failed; HezLead owns triage, Tom owns security approval')
print('both non-browser ingress suites: PASS')
PY
)
```

Transfer the safe result to the box proof directory even on failure. Record facts in `oauth-ingress-facts.json`; do not save raw response bodies or headers.

A redirect, HTML challenge, `1010`, 403, 413 or 502 is not the expected disabled JSON response.

**If BIC or another Cloudflare control blocks either client, STOP.** HezLead owns coordination and Tom owns approval for the hostname-scoped security change; dashboard access is required because the current tokens cannot establish or modify the relevant rule state. Do not spoof a browser UA, disable proxying, use direct-origin success as public acceptance, change zone-wide security or continue to closure.

After a separately approved security change, record the exact hostname scope and rule identity, then rerun both suites. Do not attribute every failure to BIC without evidence; transport, DNS, origin and application failures also stop acceptance.

These tests establish current non-browser reachability and dark responses. They do not prove Claude interoperability.

## Restart and post-apply backup

Perform one controlled **OAuth-only** container restart. Wait for health; verify the same image, runtime controls, protected files and active signing `kid`. Repeat loopback and both public non-browser suites into `oauth-restart-probes.json`, and repeat catalog, functional and privilege checks.

Do not claim live authorization, refresh or management flows while authorization is disabled. Use exact-SHA test evidence and isolated recovery acceptance for those contracts.

After migration, obtain a **new** complete backup using the now-active OAuth-inclusive helpers. A manual start requires HezLead’s approval. Record `backup-requested-at.txt` immediately before starting. Use section 5’s current start/wait block and full freshness gate; save `backup-status.json`.

Require the backup request after `hm6-applied-at.txt`, service `Result=success`, and completion/offsite verification after the request.

### Backup inclusion proof

```sh
# step: hm6-prove-post-apply-backup-coverage
# Runs: box over SSH, as root, operated by Anvil, after approved backup completion.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
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
assert status['destination'].startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/')
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
assert any(parts[3:6] == ['SCHEMA', '-', 'commonswarm_oauth'] for parts in entries)
expected_tables = {
    'provider_artifacts', 'refresh_family_tombstones', 'browser_sessions',
    'interactions', 'cimd_cache', 'consent_orchestration'
}
tables = {p[5] for p in entries if len(p) > 5 and p[3:5] == ['TABLE', 'commonswarm_oauth']}
data_tables = {p[6] for p in entries if len(p) > 6 and
               p[3:6] == ['TABLE', 'DATA', 'commonswarm_oauth']}
assert tables == data_tables == expected_tables
counts = {}
for line in (artifact / 'source-counts.tsv').read_text().splitlines():
    name, count = line.split('|')
    assert name not in counts and count.isdigit()
    counts[name] = count
assert {name.split('.', 1)[1] for name in counts
        if name.startswith('commonswarm_oauth.')} == expected_tables
(proof / 'oauth-backup-coverage.json').write_text(json.dumps({
    'pass': True, 'destination': status['destination'],
    'verified_at': status['verified_at'], 'dump_sha256': checksums['database.dump'],
    'schema': 'commonswarm_oauth', 'table_count': len(tables),
    'table_data_entry_count': len(data_tables),
    'post_apply_backup': True, 'row_data_printed': False
}, indent=2) + '\n')
print('post-apply OAuth backup schema and six table-data entries: PASS')
PY
)
```

This proves inclusion and binding to the completed offsite-verified artifact, not restoration.

### Isolated recovery acceptance

Before closure, require an isolated restore of the post-apply backup. Never restore over production or run the production restore service as a rollout shortcut.

Record `oauth-recovery-proof.txt` covering:

- All six tables and data/counts.
- Functions, indexes, constraints, ownership, ACLs, RLS and policies.
- Runtime role attributes, memberships, search path and database CONNECT.
- Corrected catalog, functional and effective privilege checks.
- Protected recovery of signing/cookie keys and runtime credentials.
- Runtime-role authentication after resetting the restored password from its recovery item.
- Stable signing identity and applicable restart/rotation tests.

`dump-database.sh` exports globals with `--no-role-passwords`. Normal `restore-target.sh` restores generated `roles.sql` and the database dump. Script inclusion does not establish every OAuth role setting or database grant; generated role handling explicitly restores `swarm_command`’s search path, not the OAuth role’s.

HezLead must approve the isolated recovery procedure before opening, including explicit recovery of role settings, grants and credential material. Missing settings fail acceptance. Do not weaken the proof or modify production to accommodate the drill.

## Rollback and abort

Prefer stopping OAuth while retaining the additive schema **and its backup coverage**. HezLead decides whether destructive schema rollback is necessary.

Use state-aware rollback; a stage that never ran has nothing to undo.

Required order:

1. Stop OAuth if started.
2. Restore prior MCP Caddy file or absence, validate/reload, and externally prove no OAuth upstream remains.
3. Reconcile/delete only the DNS record created by this window, using its exact saved zone/record identity, current matching content and the same protected curl-config method. Verify absence afterward. Never delete unrelated records or reverse a Tom-approved security change without its owner’s decision.
4. Restore only this window’s GoTrue allowlist change while preserving unrelated environment changes; conditionally recreate only GoTrue and verify health.
5. Remove OAuth `current` only after proving it points to this retry’s release. Retain both immutable OAuth releases and images.
6. Decide whether migration 03 is retained or removed.
7. Align helper state with that database decision.

Before destructive schema rollback require:

- All six tables empty.
- No runtime-role database sessions.
- No later dependent release.
- No intervening global default-ACL change since `hm6-default-acl-after.json`.
- Verified backup and HezLead’s explicit decision.

If data exists, retain the schema unless HezLead explicitly accepts its loss. Never delete rows to pass the gate.

Execute the hash-verified [`20260928000003-rollback.sql`](../../../deploy/release-proofs/item-hm/20260928000003-rollback.sql) verbatim with its sibling rollback catalog. It owns its transaction. Do not add `CASCADE`, rewrite memberships, or wrap it as bare inverse DDL.

```sh
# step: hm6-run-verbatim-reviewed-rollback
# Runs: box over SSH, as root, operated by Anvil after rollback approvals and gates.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/ad964ed158181ba1692dd05895f36fa7a1f87d3f
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
    SELECT 1 FROM pg_stat_activity WHERE usename = 'commonswarm_oauth_runtime');
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

The reviewed inverse restores PUBLIC’s global default EXECUTE for future `swarm_admin` functions, drops the three functions and six tables/schema, revokes runtime CONNECT, resets its search path, refuses unexpected ownership/dependencies, drops the role and removes only migration 03’s ledger row. It allows the safe creator membership that PostgreSQL removes with `DROP ROLE`. Commit requires its rollback catalog to pass.

If migration 03 remains, retain the OAuth-inclusive helpers. Do not restore old helpers that omit the retained schema.

If migration 03 never committed or was successfully removed, restore the previous stack through section 7’s guarded **rollback** and section 8’s saved-unit restoration. Keep the same maintenance protections and file-backed activation timestamps. The new dump helper cannot remain unattended after its required schema is removed.

Never roll back HM2, HM4 transport protection or the edge in this window.

Retain signing, cookie and database recovery material and suffixed vault items. After permanent rollback, mark unused items retired and restrict unused on-box secret files to root-only access. Do not delete keys automatically or reuse retired identities.

## Closure

Repeat the deferred-HM3 check into `hm3-deferred-after.txt`. After successful HM6 application, reconcile pending inventory to 04 only.

HezLead closes only after accepting:

- Landed release/archive identity, all measured input hashes, plan/block review and exact-SHA gates.
- Explicit dispositions for all four old leftovers.
- Fresh stack/edge/OAuth staging evidence; edge staging clearly distinguished from activation.
- HM2 precondition and HM6 database baseline.
- Migration 03 ledger/catalog/functional/privilege results and empty cron deltas.
- Migration 04 deferral and unchanged absence.
- New helper path, reviewed stack differences, unchanged unrelated services and restored timers.
- Protected new keys/items, runtime credential provisioning and verified in-container DNS/TLS.
- Runtime isolation, loopback publication, health and restart acceptance.
- Preserved GoTrue allowlist plus callback.
- Existing certificate/key reuse with coverage and protected identity verification.
- New proxied DNS record and successful readback.
- Reviewed port-only Caddy rendering.
- Both non-browser probe suites after ingress activation and restart.
- Any required Cloudflare security decision explicitly owned and recorded; no unresolved blocking challenge.
- Post-apply complete backup with OAuth schema and six table-data entries.
- Isolated recovery of schema, role settings, permissions and credentials.
- Edge still at `72c57e0d76d0aa86fe4f811a2cf51499919fed20`.
- Cleanup and manifest-only copy-back.

Run section 1 timer cleanup and section 9 transient database cleanup on success and abort. Remove the transient directory-verifier helper and temporary historical archive through scoped cleanup after preserving their non-secret evidence. Remove the Mac window file through the runbook. Retain immutable releases, images and recovery material.

Report separately:

**backup helpers released; migration applied; OAuth service released dark; GoTrue updated; DNS created; OAuth ingress verified; non-browser access verified; recovery verified; window closed.**

A partial or blocked window must say which of those conditions is actually true. Public authorization, lanes 3/7/8 activation, site/CLI release and real-client interoperability remain outside this window.

## Changes from v2

1. Changed the title/status to v3 RETRY and replaced the prospective release identity with `ad964ed158181ba1692dd05895f36fa7a1f87d3f`.
2. Removed claims that the inspected preview is the landed release or current remote `main`; exact landed identity and gate acceptance remain unestablished.
3. Added the first-window abort, rollback, restored stack, unchanged edge/Caddy/GoTrue, timer state and historical backup result.
4. Cited committed production diagnostic evidence and distinguished the two false leaf predicates from their false parent conjunctions.
5. Recomputed and listed all referenced proof hashes, plus migration, release procedure, Dockerfile, lockfile, Compose and Caddy hashes.
6. Added an executable hash gate and explicit final-plan/block enumeration; first-window 19/19 approval is not reused.
7. Updated the corrected catalog description to structural `pg_proc`/`pg_attribute` checks and preserved the limits of that proof.
8. Described the final migration’s `createrole_self_grant` behavior accurately: safe creation and refusal of unsafe surviving state, without a self-grant.
9. Added production-shaped apply-path test coverage and ledger-owner handling without claiming a passing test run.
10. Distinguished safe admin-only creator membership from forbidden SET/INHERIT paths and strengthened supplemental membership/role-setting checks.
11. Updated archive scope for lane 7 worker/router and lane 8 changes.
12. Corrected the obsolete claim that the edge deployment directory is unchanged.
13. Disclosed that the new OAuth image includes dormant HM8 service code while site deployment and public lane activation remain deferred.
14. Retained migration 04’s complete pending inventory and explicit deferral; lanes 3, 7 and 8 remain later windows.
15. Replaced blanket first-install filesystem absence with an exact retry-leftover inventory.
16. Added verified reuse of `cs-oauth-080406`, including measured UID/GID, account constraints and no unexpected access.
17. Added verified reuse of the empty `/etc/commonswarm-oauth` directory.
18. Added byte-for-byte verification and retention of the old OAuth release against its historical Git archive.
19. Added explicit preservation of the old local image and a fresh build from the retry archive; old-ID reuse requires fresh-build identity and base verification.
20. Incorporated the current release-directory verifier’s safe same-SHA reuse semantics without overwriting or repairing existing directories.
21. Added fresh edge archive staging through that verifier, separate from the stack deployment selection and without edge activation evidence.
22. Preserved fresh retry naming for all new identities/items while documenting the single old-account exception.
23. Updated the manifest for retry leftovers, directory states, hash verification, DNS, certificate and dual-UA evidence.
24. Retained old-helper pre-change backup ordering, helper activation before migration, strict maintenance/timer gates, post-apply backup coverage and isolated recovery requirements.
25. Removed the obsolete warning that service runbooks use the wrong CA path; current runbooks now agree with Compose.
26. Replaced unestablished certificate assumptions with the supplied Origin CA facts and read-only re-verification; prohibited new certificate issuance.
27. Added DNS creation as a separate step before Caddy activation, with active-token verification, mode-0600 curl configuration, exact record creation and readback.
28. Added creation receipts, uncertain-request reconciliation and record-specific DNS rollback.
29. Removed the assumption that a Cloudflare bypass rule already exists or can be installed with current tokens.
30. Recorded BIC ON, medium Security Level, known staging `1010` behavior and unreadable bot/WAF rules.
31. Added immediate public tests with literal curl UA `claude-connector-test/1.0` and Python urllib’s actual default UA.
32. Made failure evidence durable and required health/discovery/JWKS positive controls alongside token/MCP disabled responses.
33. Added a hard Cloudflare STOP owned by HezLead and Tom, with explicit prohibition on UA spoofing, origin bypass, proxy removal or unapproved security relaxation.
34. Required both non-browser suites again after the controlled OAuth restart.
35. Updated rollback language for the corrected inverse and safe creator membership; preserved verbatim SQL, empty-data/session gates and helper/schema compatibility.
36. Consolidated unchanged operational requirements into source-referenced instructions while retaining the protected-input, GoTrue, runtime, backup, recovery and cleanup gates.
37. Expanded closure reporting to distinguish DNS creation, non-browser reachability, dark deployment, recovery and actual window closure.
