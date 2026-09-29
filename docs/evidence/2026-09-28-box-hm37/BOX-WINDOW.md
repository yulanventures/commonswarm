# HM lanes 3 and 7 — DARK box window — v4

**Release SHA:** `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`
**Required HM6 stack release:** `ad964ed158181ba1692dd05895f36fa7a1f87d3f`
**Required HM6 OAuth release:** `826db6a34f235064a3a03c57377d8e32a35d2f05`
**Expected previous edge:** `72c57e0d76d0aa86fe4f811a2cf51499919fed20`
**Status:** PLAN. Approval, exact-SHA gate results, current production prerequisites, execution and closure are **not established**.

Anvil executes only the named `hm37-*` and `runbook-*` steps, including Mac
mini controls. HezLead approves the release identity, backup age, transitions,
rollback and closure. CSwarmDevLead supplies reviewed inputs and reconciles
evidence.

This revision was prepared by read-only inspection of the release tree and local plan-validation tests. No product gate, production probe, migration, deployment or principal creation was performed.

## 1. Governing procedure and scope

Follow [`deploy/RELEASE-TO-BOX.md`](../../../deploy/RELEASE-TO-BOX.md) **from this release SHA**, particularly section 1’s preparation, verified directory reuse, manifest, copy-back and abort cleanup; sections 2–3’s database identity/session; section 5’s migration procedure; and section 6’s edge release and rollback. Section 9 contains the API Caddy-pair and MCP-site procedures; both are explicitly skipped by this window.

Host operations also follow the workspace’s `hetzner-handoff/HETZNER-OPERATIONS.md`. Its contents and hash are outside this repository’s release tree; the applicable operational revision is **not established** here.

Dependencies:

- [HM2 window](../2026-09-28-box-hm2/BOX-WINDOW.md) and its [run-4 evidence](../2026-09-28-release-72c57e0d76d0-rerun-4/).
- [HM6 window v4](../2026-09-28-box-hm6/BOX-WINDOW.md), whose two completed production parts must both be live before this window opens: migration 03 and the backup helpers from `ad964ed158181ba1692dd05895f36fa7a1f87d3f`, and the OAuth service/ingress from `826db6a34f235064a3a03c57377d8e32a35d2f05`.
- [HM lane plan](../../design/2026-09-27-HM-LANE-PLAN.md), particularly §§4.4, 4.8 and 7.

| Surface | This window |
|---|---|
| Schema | Apply **only** `20260928000004_hm_hosted_check.sql`. |
| Hosted check | Install durable check cursors/batches and internal open/ACK handling. |
| Edge | Release the complete edge archive at `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`. |
| Hosted MCP | Install the worker and router changes, **DARK**. |
| Stack archive | Prepare or verify the exact-SHA directory for migration inputs; no `stack/current` switch if the required runtime comparison is empty. |
| Caddy | **No installation, edit, validation-triggered rollout or reload in this window.** |

**Do not set `SWARM_MCP_PUBLIC_ENABLED=1`. Preserve disabled public OAuth authorization.**

Migration 03 must already have been applied from HM6’s corrected file, and the HM6 OAuth service must already be live from its continuation release. Do not reapply or backfill migration 03, rebuild or redeploy OAuth, or change its signing material, DNS, GoTrue configuration or ingress in this window. Site, installed CLI and npm publication are also outside scope.

The release carries the split API Caddy pair: `commonswarm-api.caddy` serves only `api.commonswarm.com`, and `commonswarm-edge-staging.caddy` serves only `edge-staging.commonswarm.com`; the maintenance pair has the same one-host-per-file split. The release runbook handles those two installed files as one pair. Its current Caddy apply and rollback paths derive each access-log path from the installed site, pre-create or repair each regular log as `caddy:caddy` mode `0600`, validate as `caddy`, and recheck after validation. Those paths do not run here. Their presence in the stack archive does not activate them. This window sets `API_CADDY_PAIR=no` and `MCP_CADDY_RELEASE=no`, does not execute runbook steps `runbook-56` through `runbook-59` or any `runbook-mcp-caddy-*` step, and performs no Caddy install, edit, log-file preparation, validation-triggered rollout or reload. Keep HM6's existing OAuth-only ingress and dark MCP routes.

The release also carries HM6 continuation plan repairs, OAuth CA-policy changes, site-deletion guards and the server-suite `server-repeat` dispatch mode. They are archive contents and exact-SHA gate inputs only in this window: do not deploy the site, rerun HM6, rebuild OAuth or treat workflow presence as a passing server result.

Every runnable block below begins with a step identifier and states its execution location. Mac mini blocks require macOS `/bin/bash` 3.2. Never paste them into zsh, assign `HOME`, enable tracing, run Docker on the Mac mini, or print complete environments or credentials. No recursive deletion is required. Any 1Password read uses Anvil's service-account method on the Mac mini, writes each value directly to a separate mode-`0600` file in the private window directory, and transfers it through Anvil's established secure file workflow. Anvil's shell is not interactively signed in; do not use an interactive `op` session, expose a value in argv or an environment variable, or print the file.

On failure, stop dependent work, preserve actual state and execute the runbook’s abort cleanup. Do not turn skipped checks into PASS evidence.

## 2. Measured source identity and comparisons

The release Git object inspected for this refresh is:

- Release commit: `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`.
- Subject: `docs(evidence): HM lane 6 box plan v4 for the continuation window at release 826db6a3`.
- Expected previous edge `72c57e0d76d0aa86fe4f811a2cf51499919fed20`, HM6 stack release `ad964ed158181ba1692dd05895f36fa7a1f87d3f`, HM6 OAuth release `826db6a34f235064a3a03c57377d8e32a35d2f05` and prior HM37 release `e7bb7a46b24e7bc794234416d43605bca52b55d4` are local ancestors.
- This requested plan edit is not itself a release input.

Current GitHub ancestry, independent acceptance of this revision and deployment approval remain **not established**. The runbook must fetch the approved origin, prove ancestry on `origin/main`, create an exact-SHA archive and reconcile its checksum on both machines.

### Edge comparison

Against expected live edge `72c57e0d76d0aa86fe4f811a2cf51499919fed20`, the comparison restricted to `supabase/` and `deploy/edge-runtime/` contains exactly these **18 paths**:

| Status | Path | Treatment |
|---|---|---|
| Modified | `deploy/edge-runtime/README.md` | Archive support documentation; no runtime input. |
| Modified | `deploy/edge-runtime/RUNBOOK.md` | Archive support documentation; no runtime input. |
| Modified | `deploy/edge-runtime/VERIFICATION.md` | Archive support documentation; no runtime input. |
| Modified | `deploy/edge-runtime/build-caddy-validation-fixture.mjs` | Exact-SHA validation tooling; not executed on the production request path. |
| Modified | `deploy/edge-runtime/check-caddy-adapted.mjs` | Exact-SHA validation tooling for the split Caddy pair; no Caddy rollout in this window. |
| Modified | `deploy/edge-runtime/env.example` | Inventory only; never replace the live environment with this example. |
| Modified | `deploy/edge-runtime/main/index.ts` | Release. |
| Modified | `deploy/edge-runtime/main/router.ts` | Release. |
| Modified | `supabase/functions/_shared/hosted-seat-auth.ts` | Release. |
| Modified | `supabase/functions/_shared/protocol.js` | Release generated bytes unchanged. |
| Modified | `supabase/functions/command/index.ts` | Release. |
| Added | `supabase/functions/mcp/auth.ts` | Release. |
| Added | `supabase/functions/mcp/deno.json` | Release. |
| Added | `supabase/functions/mcp/index.ts` | Release. |
| Added | `supabase/functions/mcp/protocol.ts` | Release. |
| Added | `supabase/functions/mcp/tools.ts` | Release. |
| Added | `supabase/migrations/20260928000003_hm_oauth_store.sql` | Archive only; corrected file already applied by HM6. |
| Added | `supabase/migrations/20260928000004_hm_hosted_check.sql` | Apply once through runbook section 5. |

Directly changed function entry points are `command` and `mcp`. Set `ROUTER_CHANGED=yes`; the archived-router inventory therefore includes `command read capability activity h0 mcp`.

The release unit is the entire edge archive. Do not copy individual worker directories into an existing release.

### HM6 source consistency

Between `ad964ed158181ba1692dd05895f36fa7a1f87d3f` and this release:

- **No file under `supabase/migrations/` differs. There are no additions, modifications or deletions.**
- Both migration directories have Git tree ID `201ce7c00828ee566c0effde2fcec74ccefebeb9`.
- Each contains 63 tracked entries: 62 SQL migrations and one placeholder.
- The complete `deploy/release-proofs/item-hm/` directory is unchanged.
- `supabase/` is unchanged. Under `deploy/edge-runtime/`, exactly five documentation/validation paths changed: `README.md`, `RUNBOOK.md`, `VERIFICATION.md`, `build-caddy-validation-fixture.mjs` and `check-caddy-adapted.mjs`.
- Runtime edge inputs `deploy/edge-runtime/compose.yaml`, `env.example` and `main/` are unchanged from HM6.
- Stack runtime paths `deploy/supabase-stack/compose.yaml`, `postgres/` and `backup/` are unchanged.

The OAuth service runtime inputs under `services/mcp-auth/`, `deploy/mcp-auth/` and `deploy/supabase-stack/commonswarm-mcp.caddy` are unchanged between the continuation release `826db6a34f235064a3a03c57377d8e32a35d2f05` and this release. The intervening release-runbook change adds guarded access-log preparation to Caddy apply/rollback paths; HM37 follows the updated non-Caddy steps and sets both Caddy switches to `no`.

Migration 04 was already present in the HM6 archive but explicitly deferred by its plan. It is the **only permitted pending migration** for this window, subject to live ledger reconciliation.

Relative to v2’s release `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d`, migration 03 and its catalog, functional and rollback proofs changed, and its diagnostic proof was added. This release carries the corrected HM6 bytes. Do not use an `e1faa08e` stack archive beside a ledger row applied from `ad964ed1`.

### Reproducible source check

```sh
# step: hm37-source-identity
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
# Runs on the Mac mini as Anvil, under /bin/bash 3.2, in the release checkout.
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  BASE=72c57e0d76d0aa86fe4f811a2cf51499919fed20
  HM6_STACK=ad964ed158181ba1692dd05895f36fa7a1f87d3f
  HM6_OAUTH=826db6a34f235064a3a03c57377d8e32a35d2f05
  PRIOR_HM37=e7bb7a46b24e7bc794234416d43605bca52b55d4
  test "$(git rev-parse HEAD)" = "$SHA"
  test -z "$(git status --porcelain)"
  test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
  git merge-base --is-ancestor "$BASE" "$SHA"
  git merge-base --is-ancestor "$HM6_STACK" "$SHA"
  git merge-base --is-ancestor "$HM6_OAUTH" "$SHA"
  git merge-base --is-ancestor "$PRIOR_HM37" "$SHA"

  python3 - "$BASE" "$HM6_STACK" "$SHA" <<'PY'
import subprocess, sys
base, hm6, sha = sys.argv[1:]
def git(*args):
    return subprocess.check_output(["git", *args], text=True)

expected = """deploy/edge-runtime/README.md
deploy/edge-runtime/RUNBOOK.md
deploy/edge-runtime/VERIFICATION.md
deploy/edge-runtime/build-caddy-validation-fixture.mjs
deploy/edge-runtime/check-caddy-adapted.mjs
deploy/edge-runtime/env.example
deploy/edge-runtime/main/index.ts
deploy/edge-runtime/main/router.ts
supabase/functions/_shared/hosted-seat-auth.ts
supabase/functions/_shared/protocol.js
supabase/functions/command/index.ts
supabase/functions/mcp/auth.ts
supabase/functions/mcp/deno.json
supabase/functions/mcp/index.ts
supabase/functions/mcp/protocol.ts
supabase/functions/mcp/tools.ts
supabase/migrations/20260928000003_hm_oauth_store.sql
supabase/migrations/20260928000004_hm_hosted_check.sql""".splitlines()
actual = git("diff", "--name-only", base, sha, "--",
             "supabase/", "deploy/edge-runtime/").splitlines()
assert len(actual) == 18
assert sorted(actual) == sorted(expected)

for revision in (hm6, sha):
    paths = git("ls-tree", "-r", "--name-only", revision, "--",
                "supabase/migrations/").splitlines()
    assert len(paths) == 63
    assert sum(path.endswith(".sql") for path in paths) == 62
    assert git("rev-parse", revision + ":supabase/migrations").strip() == \
        "201ce7c00828ee566c0effde2fcec74ccefebeb9"
hm6_expected = {
    "deploy/edge-runtime/README.md",
    "deploy/edge-runtime/RUNBOOK.md",
    "deploy/edge-runtime/VERIFICATION.md",
    "deploy/edge-runtime/build-caddy-validation-fixture.mjs",
    "deploy/edge-runtime/check-caddy-adapted.mjs",
}
hm6_actual = set(git("diff", "--name-only", hm6, sha, "--",
                      "supabase/", "deploy/edge-runtime/",
                      "deploy/release-proofs/item-hm/").splitlines())
assert hm6_actual == hm6_expected
print("edge_diff_paths=18; hm6_stack_delta_paths=5; migration_tree_identity=PASS")
PY

  git diff --exit-code "$HM6_STACK" "$SHA" -- \
    supabase/ deploy/release-proofs/item-hm/
  git diff --exit-code "$HM6_STACK" "$SHA" -- \
    deploy/supabase-stack/compose.yaml \
    deploy/supabase-stack/postgres/ deploy/supabase-stack/backup/
  git diff --exit-code "$HM6_OAUTH" "$SHA" -- \
    services/mcp-auth/ deploy/mcp-auth/ \
    deploy/supabase-stack/commonswarm-mcp.caddy
  git diff --exit-code "$BASE" "$SHA" -- src/cloud/agent-check.ts src/mcp/
  git diff "$BASE" "$SHA" -- deploy/edge-runtime/env.example
)
```

### Environment

The example adds exactly one assignment name relative to the previous edge: `SWARM_MCP_PUBLIC_ENABLED`. It is optional; only the exact string `1` enables MCP.

**New required edge environment names: none.** Set `ADDITIONAL_REQUIRED_ENV_NAMES=''`.

Generate the required/optional inventory from the archived router using runbook step `runbook-04`. The router requires nonempty Supabase URL/anon/service-role names, either database URL alias, and `SWARM_SELF_SERVE=1`. Do not maintain a second manually typed enforcement list.

The MCP worker allowlist excludes the service-role key and OAuth-service credential material. Optional issuer/resource/JWKS settings default when absent; explicitly empty strings fail `exactContract()` if the worker loads. Do not copy blank optional example assignments into production.

The live edge environment is known to omit `SWARM_ENV`, `SWARM_MCP_ALLOWED_ORIGINS`, `SWARM_MCP_CLOCK_SKEW_SECONDS`, `SWARM_MCP_ISSUER`, `SWARM_MCP_JWKS_CACHE_TTL_SECONDS`, `SWARM_MCP_JWKS_URL`, `SWARM_MCP_MAX_BODY_BYTES`, `SWARM_MCP_MAX_CONCURRENT_REQUESTS`, `SWARM_MCP_MAX_RESPONSE_BYTES`, `SWARM_MCP_PUBLIC_ENABLED`, `SWARM_MCP_REQUEST_TIMEOUT_MS`, and `SWARM_MCP_RESOURCE`. Which of these become required belongs to the future MCP-enable plan, not this DARK release.

Code proof that both controls work with all twelve unset:

- `deploy/edge-runtime/main/router.ts:265-284` forwards those names only to the future MCP worker; the DARK router gate prevents worker creation before any of them are read.
- `supabase/functions/mcp/index.ts:40-88,370-380` supplies defaults for absent limits, issuer/resource/JWKS, origins, cache TTL and clock skew, and treats absent `SWARM_MCP_PUBLIC_ENABLED` as false. This is supporting DARK-worker proof, not permission to load the worker publicly.
- `deploy/release-proofs/item-hm/hm37-open-ack-control.ts:729-744` imports the command/auth paths directly and requires only the existing database alias plus existing Supabase and optional database-CA inputs. Its only `SWARM_ENV` reads are test-only forced-failure hooks; unset production behavior skips them. It never reads a `SWARM_MCP_*` name.
- The local control runs released `cswarm 0.1.80` and stdio MCP, whose source comparison is empty from the already-live HM2 release; it receives its credential/profile files and no edge `SWARM_MCP_*` input. The plan must not add any of the twelve names to `/home/commonswarm/.env` or the edge Compose environment for either control.

## 3. Exact-tree file hashes

These SHA-256 values were recomputed from the inspected release tree. They identify repository inputs, not deployed files.

The hash of the **replacement document**, release archive, rendered/live Caddy files, box-only override, installed executable, live configuration and generated evidence is **not established**. Measure those during approved preparation. Section 9 establishes the reviewed control-harness and Deno-config hashes. The HM37 document hash below identifies the v3 document in the `eb2a87ac` release tree, not this replacement.

### Release and source inputs

| Repository path | SHA-256 |
|---|---|
| `deploy/RELEASE-TO-BOX.md` | `e136e2e6353c546846313bb45f523042793c0a8cfdef8a19ef0248910cf14191` |
| `deploy/edge-runtime/README.md` | `2624370450eb2559863568bce4c7f022352a1f51174f0def3dead51ad5dc1427` |
| `deploy/edge-runtime/RUNBOOK.md` | `a61f6324e3ae23215d89f0380359388ff876397742d43d0f1a85e4022215e147` |
| `deploy/edge-runtime/VERIFICATION.md` | `e3cb4797b157dec565124a49cc6216f2d2b5cd9c32ca6a7b5367439311dbf693` |
| `deploy/edge-runtime/build-caddy-validation-fixture.mjs` | `88cb6bb7e1df1e07ec0350b786e7f4e121aed075b0b07ab235e630a3b23b4406` |
| `deploy/edge-runtime/check-caddy-adapted.mjs` | `d92e556d2f5375743df71bd994282117d8703e5e65fde6362225956e38da0b35` |
| `deploy/edge-runtime/compose.yaml` | `2c5d69dc741e81d93f94776bea1baae557f4e36dfe4094b271f530d70b38143b` |
| `deploy/edge-runtime/env.example` | `06e0d89b2de310c295a26809bf9cf82c47312c09ad8e1e5d6b0511769ce426a9` |
| `deploy/edge-runtime/main/index.ts` | `a0df6b139984259b3ad4a8d19cbb5869518466c8c69d8ac6c4cd8087e0bf9e0a` |
| `deploy/edge-runtime/main/router.ts` | `0f4758c4833f019727b04e27d19f8b139adc5f26669552dac7babae236a69848` |
| `supabase/functions/_shared/hosted-seat-auth.ts` | `43273844c13068e19b9ae6fb2f90e933b3613c4eb284a084a743f429b812ebd6` |
| `supabase/functions/_shared/protocol.js` | `ed791f2a6e3349cc1b3db91b1a4a50e32b7cd203a6cfe07d981fd4ffa72ad2ea` |
| `supabase/functions/command/index.ts` | `2ff117b73c30491d29321902f5e61a58ee49fa19371dd3c5631e13661ab9d782` |
| `supabase/functions/mcp/auth.ts` | `4109b7accdf6d1ba55ee7c7f87139589af31c9c9d2d731decd6aa0044f1e3496` |
| `supabase/functions/mcp/deno.json` | `3b75b82099c36460d907df5ce2ca81691f5b8acc22204cbfd505feff724fc604` |
| `supabase/functions/mcp/index.ts` | `cd8a21b0fa47ed6c9601c6d94137100041eb6c22037d07c5cf81d241b4ddc189` |
| `supabase/functions/mcp/protocol.ts` | `eee45bf5b8dbedc4a190f49edd7436a8879fa3b32ed9b9a4e729b72e42ef14dc` |
| `supabase/functions/mcp/tools.ts` | `9a204f9b80ccc4b268601750f52b892f4b2e7d89c127c4ebc200ff9e7320d9e0` |
| `supabase/migrations/20260928000003_hm_oauth_store.sql` | `e6f6944154b01e7f80a366058754639700c81279cfec4eaff6fe601a6ad99638` |
| `supabase/migrations/20260928000004_hm_hosted_check.sql` | `a056398fba6cfb401532f6e2983786fda1be4cb40c8a5db0e2b55c3b00120719` |
| `deploy/supabase-stack/compose.yaml` | `f983a24a73cad6a26206fd63a85fa3f1b604cfe22215fb9101079261323d38fb` |
| `deploy/supabase-stack/migrate/run-db-tool.sh` | `b8cdf34b9e556fc9fea89be807d60fd57aeca8eb1f3eed849456db97e79a6670` |
| `deploy/supabase-stack/migrate/assert-database-identity.sh` | `ba0c14ab00d75e4cbd156d7c9ae07c57c98d6e89435e35559c1cccc5390888fb` |
| `deploy/supabase-stack/commonswarm-api.caddy` | `abc0ed5ff54989390c7b210d0a901100b87af9d417629f2478b0a4c288232290` |
| `deploy/supabase-stack/commonswarm-api-maintenance.caddy` | `bd37f7ecb928c88eabd80b7f8d18b299aff060f3554d5187782c90d4a4101b24` |
| `deploy/supabase-stack/commonswarm-edge-staging.caddy` | `caa4321ed62c1837776d7f083690ed33b2b0ad8a6c85da160f1fa298bc4a0010` |
| `deploy/supabase-stack/commonswarm-edge-staging-maintenance.caddy` | `f40447c155601a8b0f93175fdb5f9688cb55ed8d514fcbfaa099868580242356` |
| `deploy/supabase-stack/commonswarm-mcp.caddy` | `5f48dab0d08171c529f8c00a10822dbf298fb392a862a54f6f361e17565ee5d1` |
| `deploy/site/deploy.sh` | `29f415213d54435417da4c74e2dfb1be3ea938fab4e51066d525d17059b810b6` |
| `deploy/site/finalize-release.sh` | `f71301ddb9dc519718179d08e8f2f8e63efa0caa24d1af62fe9daeefe3552ba7` |
| `.github/workflows/server-suite.yml` | `b9d6e808a23bc119c4d724ea91e46bb9acb07756e4e3f1052a6b82a4ade0eb2d` |
| `src/protocol/hosted-authority.ts` | `b85b8ebb5b748a2d60c76341e94b42544e99ffdb1837c41c1ce1657e487ab9d2` |
| `src/cloud/agent-check.ts` | `e24875ce1c37d768b7b38a6afc7bc5a86d03d0af4380cf616b7814f45d6bed35` |
| `src/mcp/server.ts` | `1233d587300d7c98f2fe597771413cb395b17c100e5d5e4d66b7d0b0e69ab563` |
| `package.json` | `715c333deb2f623ee37c07712fe94dfc594526d979e88199706ec45e85ec4503` |

### Proof inputs

All paths in this table are relative to `deploy/release-proofs/item-hm/`.

| File | SHA-256 |
|---|---|
| `20260928000002-catalog.sql` | `83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144` |
| `20260928000002-functional.sql` | `1e8274f07674960748a4217022a65f3cca5fcb5e43a14476abf5e2b4ae006fa3` |
| `20260928000003-catalog.sql` | `5d65f11724b31dadceea089c010eea3ee641d4eb1582f9e9cf0ac3e674c88243` |
| `20260928000003-functional.sql` | `4c23fbd14ad2a04c9a74900b4bff097e42a239bf8847dcdd32b7426a678cac91` |
| `20260928000004-catalog.sql` | `1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1` |
| `20260928000004-functional.sql` | `26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659` |
| `20260928000004-rollback.sql` | `69053ccac11d4c5ae13cef447950130fdf2b7bef2c490f62d61c8e043bdf1c29` |
| `20260928000004-rollback-catalog.sql` | `f8cf2a14ae112a927674150ad5c7d50144c9ff3d37a168cbb94ece8a71102aed` |

### Supporting plans and test sources

| Repository path | SHA-256 |
|---|---|
| `docs/evidence/2026-09-28-box-hm37/BOX-WINDOW.md` — v3 release-tree input | `24a900ff04320ba40a0f8dcc8536372bfbd37e56ee5a0a68745b019a1c2d9eab` |
| `docs/evidence/2026-09-28-box-hm6/BOX-WINDOW.md` | `a24742b15000009560c1265ed98d818ebfd7a6f05be7a01890e015987324c4d5` |
| `docs/evidence/2026-09-28-box-hm2/BOX-WINDOW.md` | `fc7c70dd402d80d85893f28ccaba9d9089126a3548ffb36e13516d082eb69c8b` |
| `docs/design/2026-09-27-HM-LANE-PLAN.md` | `77f55010d94e5b2a99cbb315476ac414b57722f63feaca2102049d795272caf8` |
| `tests/box-window-plans.test.ts` | `112b680a03f2cc495f744e8e5f2e8ba3b2e17f65f2975f692322595de5270dc7` |
| `tests/hm6-box-window-plan.test.ts` | `3f20a15604a2d2f922f46b2673f48f0259ca15899f324e713a29342095b4f8a8` |
| `tests/p1-cli/edge-runtime-box.test.ts` | `4ddd651e1afa57e648e2ad23d154b1b21bf167e29d11e66bc9f4031a1badfcde` |
| `tests/p1-cli/site-deletion-safety.test.ts` | `ed972eb2821da4ae0b485fed899f776031482611ece2617df335497580a6b6e4` |
| `tests/p1-cli/site-on-box.test.ts` | `1009c3221c63a442cd4239efd3d6161d9399000dd0654fe4f91d26f33d5a0d99` |
| `tests/p1-cli/supabase-stack.test.ts` | `f4a38c9bd86e82d06ede413521d072d3214e9c47daec99a51d1a3058ce78e9e2` |
| `tests/p1-cli/mcp-stdio.test.ts` | `22bab26984806ec20e048c4545a51d269d038dccd3c77e42e860777cc1649295` |
| `tests/p1-server/hosted-authority.test.ts` | `185b782268b8f8325105e4b9dcc7c6b9d5763a3a1bf481cdd2166f1778a79535` |
| `tests/p1-server/hosted-check.test.ts` | `820f24f50ff28ec66570b5f98a15f12e9021b93fed20bddc2f511dd551fd795b` |
| `tests/p1-server/hosted-mcp.test.ts` | `8e07c468e083503ccbda9ab49906fe4eb334de3d91e5a66616c674f7e2efc28d` |
| `tests/release-proof-format.test.ts` | `4a342ffe886389b32082eea14e0af4766f2173bdeb8d594349681a77149a626e` |

Historical HM2 evidence paths below are relative to `docs/evidence/2026-09-28-release-72c57e0d76d0-rerun-4/`.

| File | SHA-256 |
|---|---|
| `migration-state-after.txt` | `3c4eba8bff206527fa1141315cb781ad214407781995d3a450e0867f9b96144f` |
| `close-readback.txt` | `d2247974c0d43041cb03250aba47f66726b7355e7faa03dda256d6629ccbb49f` |
| `hm2-local-control.json` | `21fb1c0dcb379635c15ebdcfb73314c965e87c709d96e95f53a9d395736ffed0` |
| `revocation-readback.txt` | `60dee356902b13842d92fb54ea043a45cd4f3a5572b939a18a83b29862353573` |

The runbook’s archive-derived manifests cover the remaining archive files and directories. Future runtime/evidence filenames below are output requirements; their existence and hashes are **not established**.

## 4. Read-only prerequisites and opening inputs

### Required live baseline

HM6 is a two-part opening precondition. Both release commits are local ancestors of this window's release, but ancestry and archive presence do not prove production state.

#### Part A — migration 03 and helpers from `ad964ed1`

Migration `20260928000003` must have exactly one ledger row, and its corrected catalog and functional proofs must return true without SQL error. `stack/current` and the effective backup/restore helper paths must resolve through `ad964ed158181ba1692dd05895f36fa7a1f87d3f`. The post-apply backup and active timers remain opening evidence. A version-only ledger row or an inactive archive is insufficient.

```sh
# step: hm37-hm6-schema-helpers-precondition
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell, after runbook sections 1–3 and proof transfer; production checks are read only.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  HM6_STACK_SHA=ad964ed158181ba1692dd05895f36fa7a1f87d3f
  HM6_STACK="/home/commonswarm/stack/releases/${HM6_STACK_SHA}"
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  test -d "$HM6_STACK"
  test -f "$HM6_STACK/RELEASE_SHA"
  test "$(cat "$HM6_STACK/RELEASE_SHA")" = "$HM6_STACK_SHA"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$HM6_STACK"
  test "$(readlink -f /home/commonswarm/stack/current/deploy/supabase-stack/backup/run-backup.sh)" = \
    "$HM6_STACK/deploy/supabase-stack/backup/run-backup.sh"
  test "$(readlink -f /home/commonswarm/stack/current/deploy/supabase-stack/backup/restore-drill.py)" = \
    "$HM6_STACK/deploy/supabase-stack/backup/restore-drill.py"
  systemctl is-active --quiet commonswarm-postgres-backup.timer
  systemctl is-active --quiet commonswarm-postgres-restore.timer
  test "$(systemctl show commonswarm-postgres-backup.service -p Result --value)" = success
  test "$(systemctl show commonswarm-postgres-restore.service -p Result --value)" = success

  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000003-catalog.sql
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations
   WHERE version = '20260928000003') = 1
  AND :'catalog_ok'::boolean;
SQL
  release_psql_ro -Atq --file "$APPLY_SQL" \
    >"$PROOF_DIR/hm37-hm6-migration-03-catalog.txt"
  test "$(cat "$PROOF_DIR/hm37-hm6-migration-03-catalog.txt")" = t
  release_psql_ro -Atq --file "$PROOF_DIR/20260928000003-functional.sql" \
    >"$PROOF_DIR/hm37-hm6-migration-03-functional.txt"
  test "$(cat "$PROOF_DIR/hm37-hm6-migration-03-functional.txt")" = t
  printf '%s\n' \
    "stack_release=${HM6_STACK_SHA}" \
    'migration_03_ledger_and_catalog=true' \
    'migration_03_functional=true' \
    'backup_restore_helpers_live=true' \
    'backup_restore_timers_active=true' \
    >"$PROOF_DIR/hm37-hm6-schema-helpers.txt"
)
```

#### Part B — OAuth service from `826db6a3`

The live OAuth release directory and `oauth/current` must identify `826db6a34f235064a3a03c57377d8e32a35d2f05`. The one running OAuth container must be healthy, use that release as its Compose working directory, and use the exact accepted image ID recorded by the continuation window. Public discovery and JWKS must be served through `https://mcp.commonswarm.com`, while the effective public-authorization flag is not `1` and both authorization endpoints refuse with the owned disabled error. The `/jwks` endpoint answers `application/jwk-set+json` per RFC 7517.

```sh
# step: hm37-hm6-oauth-precondition
# readonly: yes
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell; all production checks are read only.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  HM6_OAUTH_SHA=826db6a34f235064a3a03c57377d8e32a35d2f05
  HM6_OAUTH="/home/commonswarm/oauth/releases/${HM6_OAUTH_SHA}"
  HM6_OAUTH_PROOF="/home/commonswarm/stack/release-proofs/${HM6_OAUTH_SHA}"
  . "$PROOF_DIR/window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  test -d "$HM6_OAUTH"
  test -f "$HM6_OAUTH/RELEASE_SHA"
  test "$(cat "$HM6_OAUTH/RELEASE_SHA")" = "$HM6_OAUTH_SHA"
  test "$(readlink -f /home/commonswarm/oauth/current)" = "$HM6_OAUTH"
  test -f "$HM6_OAUTH_PROOF/oauth-image.id"
  IFS= read -r MCP_OAUTH_IMAGE <"$HM6_OAUTH_PROOF/oauth-image.id" || [ -n "$MCP_OAUTH_IMAGE" ]
  test "$(cat "$HM6_OAUTH_PROOF/oauth-image.id")" = "$MCP_OAUTH_IMAGE"
  case "$MCP_OAUTH_IMAGE" in sha256:*) ;; *) false ;; esac
  case "${MCP_OAUTH_IMAGE#sha256:}" in ''|*[!0-9a-f]*) false ;; esac
  test "${#MCP_OAUTH_IMAGE}" -eq 71
  CIDS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    test -n "$VALUE" && CIDS[${#CIDS[@]}]="$VALUE"
  done < <(docker ps -q \
    --filter label=com.docker.compose.project=commonswarm-oauth \
    --filter label=com.docker.compose.service=oauth)
  test "${#CIDS[@]}" -eq 1
  CID="${CIDS[0]}"
  test "$(docker inspect --format '{{.Image}}' "$CID")" = "$MCP_OAUTH_IMAGE"
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$CID")" = \
    "$HM6_OAUTH/deploy/mcp-auth"
  test "$(docker inspect --format '{{.State.Health.Status}}' "$CID")" = healthy
  docker exec "$CID" node -e \
    'process.exit(process.env.MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED === "1" ? 1 : 0)'
  printf '%s\n' \
    "oauth_release=${HM6_OAUTH_SHA}" \
    'oauth_current_matches=true' \
    'oauth_image_identity_matches=true' \
    'oauth_container_healthy=true' \
    'public_authorization_effective_disabled=true' \
    >"$PROOF_DIR/hm37-hm6-oauth-runtime.txt"

  python3 - https://mcp.commonswarm.com \
    >"$PROOF_DIR/hm37-hm6-oauth-public-precondition.json" <<'PY'
import json, sys, urllib.error, urllib.request

base = sys.argv[1]
results = []

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def request(path):
    req = urllib.request.Request(base + path)
    try:
        response = opener.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(131073)
        actual_status = response.code
        content_type = response.headers.get("Content-Type", "")
        server = response.headers.get("Server")
        cf_ray = response.headers.get("CF-Ray")
    media_type = content_type.split(";", 1)[0].strip().lower()
    record = {
        "method": "GET", "path": path, "status": actual_status,
        "user_agent": "Python urllib default",
        "headers": {"server": server, "cf-ray": cf_ray,
                    "content-type": content_type},
    }
    if media_type not in ("application/json", "application/jwk-set+json"):
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
    if actual_status == 403 and b"error code: 1010" in raw[:2048].lower():
        record["failure_kind"] = "cloudflare_challenge"
    results.append(record)
    if path == "/jwks":
        expected_media = "application/jwk-set+json"
    else:
        expected_media = "application/json"
    if actual_status != 200 or len(raw) > 131072 or media_type != expected_media:
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    try:
        value = json.loads(raw)
    except Exception:
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    return value

for path in (
    "/.well-known/oauth-authorization-server",
    "/.well-known/openid-configuration",
):
    document = request(path)
    assert document["issuer"] == base
    assert document["authorization_endpoint"] == base + "/authorize"
    assert document["token_endpoint"] == base + "/token"
    assert document["jwks_uri"] == base + "/jwks"

keys = request("/jwks").get("keys")
assert isinstance(keys, list) and keys
for key in keys:
    assert key.get("kty") == "EC" and key.get("crv") == "P-256"
    assert key.get("alg") == "ES256"
    assert isinstance(key.get("kid"), str) and key["kid"]
    assert isinstance(key.get("x"), str) and key["x"]
    assert isinstance(key.get("y"), str) and key["y"]
    assert not {"d", "p", "q", "dp", "dq", "qi", "oth", "k"} & key.keys()

print(json.dumps({"pass": True, "results": results}, indent=2))
PY
)
```

Run the refusal checks separately with the same shell options, environment and
working directory. The unauthenticated request carries no real principal,
resource ID, credential, Authorization header or Cookie header.

```sh
# step: hm37-hm6-oauth-refusal-probe
# readonly: probe
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell; every request must refuse.
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  . "$PROOF_DIR/window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  python3 - https://mcp.commonswarm.com \
    >"$PROOF_DIR/hm37-hm6-oauth-refusals.json" <<'PY'
import json, sys, urllib.error, urllib.request

base = sys.argv[1]

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())
results = []
PROBE_UA = "commonswarm-release-probe/1.0"

def request(path, method, body, status):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        response = opener.open(req, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        raw = response.read(131073)
        actual_status = response.code
        content_type = response.headers.get("Content-Type", "")
        server = response.headers.get("Server")
        cf_ray = response.headers.get("CF-Ray")
    media_type = content_type.split(";", 1)[0].strip().lower()
    record = {
        "method": method, "path": path, "status": actual_status,
        "user_agent": "Python urllib default",
        "headers": {"server": server, "cf-ray": cf_ray,
                    "content-type": content_type},
    }
    if media_type != "application/json":
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
    if actual_status == 403 and b"error code: 1010" in raw[:2048].lower():
        record["failure_kind"] = "cloudflare_challenge"
    results.append(record)
    if actual_status != status or len(raw) > 131072 or media_type != "application/json":
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    try:
        value = json.loads(raw)
    except Exception:
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    return value

response = request("/authorize", "GET", None, 503)
assert response.get("error") == "authorization_service_disabled"
response = request("/token", "POST", {}, 503)
assert response.get("error") == "authorization_service_disabled"

print(json.dumps({"pass": True, "results": results}, indent=2))
PY
)
```

The MCP-hostname probe deliberately keeps Python urllib's actual default User-Agent because non-browser reachability is the claim for `mcp.commonswarm.com`. The gateway public bases use `User-Agent: commonswarm-release-probe/1.0`; loopback may keep the urllib default. Every evidence row records which rule applied. Redirects and HTML challenges fail. HezLead accepts Part B only from this release-directory, image, effective-flag and endpoint evidence together.

After both parts pass, the required checks have executable owners:

1. `hm37-current-window-state` proves the previous edge symlink, `RELEASE_SHA`, actual Compose working directory and mounted source all identify `72c57e0d76d0aa86fe4f811a2cf51499919fed20`.
2. `hm37-current-window-state` proves migration 02 has exactly one ledger row and that its catalog and functional proofs pass. `hm37-hm6-schema-helpers-precondition` separately proves the migration-03 prerequisite.
3. `hm37-current-window-state` proves the applied migration-03 file hash matches this document; a version-only ledger row cannot prove which bytes were applied.
4. `hm37-hm6-oauth-precondition` proves effective `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED` is not exactly `1`; `hm37-current-window-state` separately proves effective edge `SWARM_MCP_PUBLIC_ENABLED` is not exactly `1`.
5. `hm37-current-window-state` proves migration 04 has ledger count zero and catalog result false **without SQL error**.
6. `hm37-current-window-state` performs complete migration reconciliation and requires only `20260928000004` pending.
7. `hm37-current-window-state` records actual stack runtime comparison, timers and exact active-window state. Concurrent-operator disposition is explicitly a HezLead decision recorded in `GO.txt`; the block requires that decision before it passes.

```sh
# step: hm37-current-window-state
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  PROOF_DIR=/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  . "$PROOF_DIR/window.env"
  . "/run/commonswarm-release-${SHA}-session.sh"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  test -f "$PROOF_DIR/GO.txt"
  grep -qFx 'CONCURRENT_OPERATOR_ACTIVITY=accepted by HezLead' "$PROOF_DIR/GO.txt"

  EXPECTED_EDGE=/home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test "$(readlink -f /home/commonswarm/edge/current)" = "$EXPECTED_EDGE"
  test "$(cat "$EXPECTED_EDGE/RELEASE_SHA")" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  EDGE_CID="$(docker compose -p commonswarm-edge -f "$EXPECTED_EDGE/deploy/edge-runtime/compose.yaml" ps -q edge-runtime)"
  test -n "$EDGE_CID"
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$EDGE_CID")" = \
    "$EXPECTED_EDGE/deploy/edge-runtime"
  docker inspect --format '{{ range .Mounts }}{{ println .Source .Destination }}{{ end }}' "$EDGE_CID" \
    | grep -qF "$EXPECTED_EDGE/deploy/edge-runtime/main /home/deno/main"
  docker exec "$EDGE_CID" deno eval \
    'Deno.exit(Deno.env.get("SWARM_MCP_PUBLIC_ENABLED") === "1" ? 1 : 0)'

  cat >"$APPLY_SQL" <<'SQL'
\i /work/deploy/release-proofs/item-hm/20260928000002-catalog.sql
SELECT
  (SELECT count(*) FROM supabase_migrations.schema_migrations
   WHERE version = '20260928000002') = 1
  AND :'catalog_ok'::boolean;
SQL
  test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
  cat >"$APPLY_SQL" <<'SQL'
\i /work/deploy/release-proofs/item-hm/20260928000002-functional.sql
SQL
  test "$(release_psql_ro -Atq --file "$APPLY_SQL")" = t
  test "$(release_psql_ro -Atq --command \
    "SELECT to_regclass('swarm_read.agent_presence') IS NOT NULL
      AND to_regclass('swarm_read.agent_wake_path') IS NOT NULL
      AND (SELECT count(*) = 2 FROM information_schema.columns
           WHERE table_schema = 'swarm_read' AND table_name = 'agent_principals'
             AND column_name IN ('transport', 'turn_only'));" )" = t

  test "$(sha256sum "$NEW_STACK/supabase/migrations/20260928000003_hm_oauth_store.sql" | awk '{print $1}')" = \
    e6f6944154b01e7f80a366058754639700c81279cfec4eaff6fe601a6ad99638
  LEDGER_04="$(release_psql_ro -Atq --command \
    "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '20260928000004';")"
  test "$LEDGER_04" = 0
  CATALOG_04="$(release_psql_ro -Atq --file "$PROOF_DIR/20260928000004-catalog.sql")"
  test "$CATALOG_04" = f

  find "$NEW_STACK/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print \
    | LC_ALL=C sort >"$PROOF_DIR/hm37-all-migration-files.txt"
  release_psql_ro -Atq --command \
    'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;' \
    >"$PROOF_DIR/hm37-ledger-before.txt"
  sed -E 's#.*/##; s/_.*//' "$PROOF_DIR/hm37-all-migration-files.txt" | LC_ALL=C sort \
    | comm -23 - "$PROOF_DIR/hm37-ledger-before.txt" \
    >"$PROOF_DIR/hm37-pending-before.txt"
  test "$(cat "$PROOF_DIR/hm37-pending-before.txt")" = 20260928000004

  for RUNTIME_PATH in compose.yaml postgres backup; do
    diff -qr "$PREVIOUS_STACK/deploy/supabase-stack/$RUNTIME_PATH" \
      "$NEW_STACK/deploy/supabase-stack/$RUNTIME_PATH"
  done
  systemctl is-active --quiet commonswarm-edge-recycle.timer
  systemctl is-active --quiet commonswarm-postgres-backup.timer
  systemctl is-active --quiet commonswarm-postgres-restore.timer
  test -f "$PROOF_DIR/window.env"
  printf '%s\n' \
    "edge_release=$EXPECTED_EDGE" \
    'edge_public_mcp_disabled=true' \
    'migration_02_ledger_catalog_functional=true' \
    'roster_transport_presence_wake=true' \
    'migration_03_hash=true' \
    "migration_04_ledger=$LEDGER_04" \
    "migration_04_catalog=$CATALOG_04" \
    'pending_versions=20260928000004' \
    'stack_runtime_comparison=equal' \
    'timers=active' \
    'concurrent_operator_activity=accepted_by_HezLead' \
    >"$PROOF_DIR/hm37-current-window-state.txt"
)
```

Historical HM2 run 4 records migration 02 applied, edge health with memory `2147483648` and network `commonswarm-net`, active maintenance timers, released cswarm `0.1.80`, an observed delivery ACK and subsequent wake eligibility, and revoked temporary principals with zero active unexpired tokens. Recheck current state.

### Runbook inputs

| Input | Value |
|---|---|
| `SHA` | `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` |
| `KIND_LIST` | `edge stack` |
| `MIGRATION_VERSIONS` | `20260928000004` only |
| `FUNCTIONAL_VERSIONS` | `20260928000004` |
| `H0_LEDGER_BACKFILL` | `no`; skip `runbook-18`, `runbook-19` and `runbook-20` |
| `GUARDED_STACK_SWITCH` | `no`; skip `runbook-48`, contingent on actual runtime comparison |
| `BACKUP_STATUS_PROOF` | `no`; skip `runbook-54` and `runbook-55`; the section 5 backup gate still applies |
| `API_CADDY_PAIR` | `no`; skip runbook steps `runbook-56` through `runbook-59` and their pair artifacts |
| `MCP_CADDY_RELEASE` | `no`; skip every `runbook-mcp-caddy-*` step and artifact |
| `CHANGED_FUNCTIONS` | `command mcp` |
| `ROUTER_CHANGED` | `yes` |
| `ADDITIONAL_REQUIRED_ENV_NAMES` | Empty |
| Expected cron additions/removals | Both empty |

The successful path uses this exact whole-block order after applying the input
table and the runbook's switch-to-step mapping:

```text
hm37-source-identity runbook-02 runbook-04 1-upload-release-archive
1-open-root-shell 1-apply-release-directories runbook-03 runbook-05
runbook-07 runbook-08 runbook-09 runbook-10 runbook-14 runbook-15
runbook-16 runbook-17 hm37-hm6-schema-helpers-precondition
hm37-hm6-oauth-precondition hm37-hm6-oauth-refusal-probe
hm37-current-window-state hm37-read-window-suffix
hm37-hosted-human-session-input hm37-deno-install hm37-hosted-control-stage hm37-backup-gate
runbook-23 runbook-24 runbook-25 runbook-26 runbook-27 runbook-28
hm37-functional-section5 runbook-29 runbook-30 runbook-31 runbook-32
runbook-33 runbook-34 hm37-public-boundary-reads hm37-public-boundaries
runbook-35 hm37-hosted-open-ack-control hm37-validate-local-credential
runbook-13 runbook-11 hm37-deno-remove runbook-60 runbook-61 runbook-12
```

The pre-COMMIT-POINT and S1–S5 rollback tail is
`runbook-42`, `hm37-reserve-schema-rollback`, `runbook-13`, `runbook-11`,
`hm37-deno-remove`, `runbook-60`, `runbook-61`, `runbook-12`, in that order.
A post-COMMIT-POINT
`control` failure instead uses `hm37-hosted-control-cleanup-only`, `runbook-13`, `runbook-11`,
`hm37-deno-remove`, `runbook-60`, `runbook-61`, `runbook-12`, in that order.

Window start/end and positive integer `BACKUP_MAX_AGE_SECONDS` require HezLead’s approval and durable root-only recording. Their values are **not established**.

Require exact-SHA evidence for command-core regeneration with a clean generated diff, `npm run check:edge`, hosted authority/check/authentication boundaries, MCP authentication/protocol, router and release-proof coverage, the three named server integration sources, and local check/stdio/release-bundle compatibility. `package.json` includes the MCP and main-router entries in `check:edge`.

Test source presence is not a passing result. Follow repository gate-wrapper and host-placement rules. Do not run Docker or server suites on the Mac mini.

### Directory creation and reuse

Use runbook section 1’s `1-apply-release-directories` verifier. It supports a missing directory or an existing **same-SHA** directory.

Reuse requires matching the full release identity, complete path inventory/count, file hashes, entry types, symlink targets/containment, ownership and modes. The only permitted extra is `deploy/edge-runtime/compose.override.yaml`, and the verifier derives its expected mode and SHA-256 from the exact previous-release source that `runbook-31` copies and records `accepted known box-only file`. Any unknown, missing, changed or metadata-mismatched entry stops the window; the verifier does not extract over, delete or repair an existing directory.

Record `EDGE_RELEASE_DIR_STATE`, `STACK_RELEASE_DIR_STATE` and aggregate `RELEASE_DIR_STATE` truthfully as created/reused/mixed where applicable. On every close or rollback, follow copy-back with `runbook-60`, `runbook-61`, and `runbook-12`; proof state becomes `<sha>.closed-window-<window-id>`, and Mac/temp state is removed. A rerun uses a new approved `WINDOW_ID`; every step addresses exact active or per-window names and must never list, glob, or select a `.closed-window-<id>` leftover.

After preparation, compare recorded `PREVIOUS_STACK` against `NEW_STACK` for the three runbook runtime paths. The source comparison with `ad964ed1` is empty, but actual live equality is **not established**. Any runtime difference, missing path or comparison error stops this migration-only stack plan.

### Handoffs

| Order | Anvil executes | HezLead accepts |
|---:|---|---|
| 1 | Read-only prerequisites | Current HM2/HM6 state and previous paths |
| 2 | Origin ancestry, exact archive and gates | Release identity, final plan and backup age |
| 3 | Manifests, immutable directories, window state, inventory | Reuse/create results and stack comparison |
| 4 | Runbook database identity/session; assert the pinned psql image is the running PostgreSQL image without pulling; prepare the human input; run `hm37-deno-install` and `hm37-hosted-control-stage`, then finish `deno cache` | Production target, pinned image identity, pinned Deno zip and installed-binary hashes, harness hashes, protected-file modes, and complete offline control cache |
| 5 | Close the no-network opening gate; backup gate, migration 04 and proofs | Schema before edge transition; no later Deno/npm install, cache fill, Docker pull, or dependency fetch |
| 6 | Edge recreate, saved outgoing logs, route controls | Runtime health and darkness |
| 7 | Reach the named COMMIT POINT; run hosted/local controls and revocation | Static assertion classification, behavior and cleanup |
| 8 | Timer restoration, copy-back, `hm37-deno-remove`, transient cleanup; continue directly to lane 8 | Explicit closure or post-COMMIT-POINT control-failure disposition, Deno absent again, and the per-window Deno cache removed |

The reviewed hosted-control artifact in section 9 is an **opening gate**, not work to invent after migration.

## 5. Names, credentials and backup gate

The box computes `WINDOW_PRINCIPAL_SUFFIX` once from approved `WINDOW_START_UTC` and persists it in `window.env` and `window-principal-suffix.txt`.
The same file carries `WINDOW_ID=YYYYMMDDTHHMMSSZ`; HM37 protected input, staging, control, journal and cache paths include that exact ID.

Use:

- Hosted recipient: `hm37-hosted-${WINDOW_PRINCIPAL_SUFFIX}`.
- Local recipient: `hm37-local-${WINDOW_PRINCIPAL_SUFFIX}`.
- Ordinary sender: `hm37-sender-${WINDOW_PRINCIPAL_SUFFIX}`.

A rerun uses a fresh approved start and unused names. Never reuse a revoked principal or resolve a collision by silently changing the suffix.

```sh
# step: hm37-read-window-suffix
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
# The ssh subprocess reads state on the box as root.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  ssh ops@100.115.66.74 \
    "sudo -n -i bash -s -- $SHA" \
    >"$EVIDENCE_DIR/window-principal-suffix.txt" <<'BOX'
(
  set -euo pipefail
  SHA="$1"
  . "/home/commonswarm/stack/release-proofs/${SHA}/window.env"
  case "$WINDOW_PRINCIPAL_SUFFIX" in
    [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) false ;;
  esac
  printf 'WINDOW_PRINCIPAL_SUFFIX=%s\n' "$WINDOW_PRINCIPAL_SUFFIX"
)
BOX
  . "$EVIDENCE_DIR/window-principal-suffix.txt"
  case "$WINDOW_PRINCIPAL_SUFFIX" in
    [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) false ;;
  esac
)
```

Secrets belong only in protected files and process memory. No credential value belongs in argv, URLs, shell environment values, output or evidence.

Read cswarm credentials using **`agent_token`, `principal_id`, `token_id`, `run_id`**. Connection creation and cleanup readers must reject every missing, empty or non-string field. Never substitute a guessed `token` field.

### Backup

Wait for the existing backup service **before** reading status. Active, activating, deactivating and reloading states are incomplete. Bound the wait to 14,400 seconds with five-second polling.

```sh
# step: hm37-backup-gate
# readonly: yes
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  : "${BACKUP_MAX_AGE_SECONDS:?HezLead-approved backup age required}"
  case "$BACKUP_MAX_AGE_SECONDS" in ''|*[!0-9]*) false ;; esac
  test "$BACKUP_MAX_AGE_SECONDS" -gt 0
  DEADLINE=$(( $(date +%s) + 14400 ))
  while :; do
    STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    case "$STATE" in
      inactive|failed) break ;;
      active|activating|deactivating|reloading)
        NOW="$(date +%s)"
        test "$NOW" -lt "$DEADLINE"
        WAIT_SECONDS=5
        if [ "$((DEADLINE - NOW))" -lt "$WAIT_SECONDS" ]; then
          WAIT_SECONDS=$((DEADLINE - NOW))
        fi
        sleep "$WAIT_SECONDS"
        ;;
      *) false ;;
    esac
  done
  test "$(systemctl show commonswarm-postgres-backup.service --property=Result --value)" = success
  python3 - /var/backups/commonswarm-postgres/status.json \
    "$BACKUP_MAX_AGE_SECONDS" >"$PROOF_DIR/hm37-backup-gate.txt" <<'PY'
import datetime, json, sys
data = json.load(open(sys.argv[1]))
assert data.get("ok") is True
assert data.get("database_bytes_verified") is True
assert data.get("object_bytes_verified") is True
verified = datetime.datetime.fromisoformat(data["verified_at"].replace("Z", "+00:00"))
age = (datetime.datetime.now(datetime.timezone.utc) - verified).total_seconds()
assert -300 <= age < int(sys.argv[2])
assert data.get("destination", "").startswith(
    "r2:yulan-vps-1-backups/000-commonswarm-postgres/")
print("backup_gate=PASS")
PY
)
```

Failure stops the window. HezLead may authorize starting the existing backup service; then use runbook step `runbook-22`, wait for completion, require `Result=success` and repeat freshness verification. Never kill a running backup or infer completion from the start command returning.

## 6. Migration 04

Stage the eight proof inputs listed in section 3 through the runbook’s reviewed proof-transfer manifest. Verify checksums after transfer.

Run complete file enumeration, file checksums, ledger enumeration and reconciliation. Require only `20260928000004` pending. Reject duplicate versions, unexpected ledger entries or unexplained older gaps.

Before apply, require:

| Measurement | Required |
|---|---|
| Migration-04 ledger count | `0` |
| Forward catalog | `f` |
| SQL process exit | `0` |

Missing, NULL, malformed or error-suppressed output does not pass.

The catalog uses safe object lookup for absent migration objects. It checks ownership, RLS, policies, column inventories, constraints, uniqueness, function properties, search paths, privileges and triggers.

Function identity/return-contract checks use OIDs, `pg_proc`, types and dependencies, including no dependency on the replaceable `swarm_read.signals` row type. Do not replace these with deparsed source matching. The proof still contains expression checks for constraints/indexes; do not describe the entire proof as free of deparsed expressions.

Check each privilege individually. A comma-separated privilege argument cannot replace the separate assertions.

Use runbook section 5, one migration only. In step `runbook-26`, replace the `mapfile` selection with a Bash array populated by a `while IFS= read -r X || [ -n "$X" ]; do` loop; retain the exact-one-match assertion and all following guards.

The transactional apply must:

1. Reassert database identity.
2. Begin a transaction with five-second lock and five-minute statement timeouts.
3. Verify version-only ledger-row compatibility.
4. Include the uniquely enumerated migration.
5. Insert its ledger row.
6. Include the catalog proof and require exactly `catalog_ok=t`.
7. Commit only after all checks pass.

After commit require `ledger=1 catalog=t`. Migration 04 is not deferred by the runbook’s functional-proof list: execute its functional proof **during section 5**.

```sh
# step: hm37-functional-section5
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro --file "$PROOF_DIR/20260928000004-functional.sql" \
    >"$PROOF_DIR/20260928000004-functional.txt"
  test "$(cat "$PROOF_DIR/20260928000004-functional.txt")" = t
)
```

The functional proof executes the visibility function and checks active-batch uniqueness, bindings, recipient visibility, terminal cursors and acknowledged cursor history. It can pass with no hosted rows; it does not replace section 9’s exercised control.

Reconcile cron: **zero additions and zero removals**. HezLead accepts schema results before the edge switch.

## 7. Edge release and saved outgoing logs

### Worker boundary

Measured in the router, main entry point and MCP protocol:

- `mcp` is in `DISABLED_FUNCTION_NAMES`.
- Only exact string `1` enables it.
- The disabled gate runs before OPTIONS/preflight.
- `handleGatewayRequest()` returns the disabled response before its worker callback.
- Worker creation and fetch are inside that callback.
- The worker protocol independently refuses dark MCP and protected-resource metadata before normal method handling.

Thus the gateway refusal is method-independent for both MCP paths. The exact-tree instrumented test in `tests/p1-cli/edge-runtime-box.test.ts`, named **“MCP dark gate refuses every method before worker creation and routes when enabled”**, explicitly covers both suffixes and seven methods: GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS. It requires zero disabled worker calls and enabled positive controls.

Require a passing result at this SHA. A 503 or absence of a worker log line alone does not prove that no worker was invoked. An enabled isolated test is not permission to enable production MCP.

### Preflight

Execute runbook steps `runbook-30` and `runbook-31`:

1. Measure recycle-timer overlap; stop it only when required, recording the marker before stopping.
2. Verify the archive-derived edge manifest.
3. Preserve the previous edge’s box-only `compose.override.yaml`.
4. Generate and verify the manifest including that override.
5. Validate required names and reject test hooks.
6. Privately inspect effective Compose/container configuration; assert MCP remains disabled.
7. Validate Compose with `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
8. Reconcile previous edge identity and actual mounted source.

### Switch

Use **this SHA’s complete runbook step `runbook-32`**. Do not use v2’s shortened switch block: it omits outgoing log preservation.

Before changing the symlink or recreating the container, that step captures timestamped stdout/stderr from `commonswarm-edge-edge-runtime-1`, retaining at most **10,485,760 bytes** in the root-owned mode-0600 proof file:

`commonswarm-edge-edge-runtime-1.72c57e0d76d0aa86fe4f811a2cf51499919fed20.docker.log`

It appends that exact filename to the existing copy-back manifest. The filename is generated from the outgoing release’s measured `RELEASE_SHA`, not the incoming SHA.

The helper tolerates a Docker-log read error. Privately inspect the result and record any collection failure; file creation alone is not proof of captured container history.

After capture, the runbook switches to `NEW_EDGE` and recreates from its exact directory with:

- `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
- The protected production environment-file path.
- The preserved box-only override.

No stack, OAuth or GoTrue container is recreated by this plan.

Within the runbook’s 180-second bound, require healthy Docker status, loopback `/health`, memory `2147483648`, network `commonswarm-net`, exact new Compose working directory, matching release/mounted source and disabled effective MCP flag.

Retain ordinary command, authenticated read, capability, activity, H0, unknown-function and preflight controls. Unauthenticated H0 note must return 401.

If an authenticated read credential is unavailable, record NOT VERIFIED and obtain HezLead’s runbook disposition. If selected, the runbook’s syntactically valid, known-nonexistent agent-token lookup must reach the database and return 401. An early token-syntax rejection does not establish connectivity.

Capture the complete post-switch probe interval’s logs privately **after** loopback and public probes. Reject connection, configuration, boot or module-loading errors. This probe-window log remains box-only.

## 8. DARK routes and public-command refusal

Required disabled JSON:

`{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}`

Probe both gateway paths on box loopback, staging and production API:

- `/functions/v1/mcp`.
- `/functions/v1/mcp/.well-known/oauth-protected-resource/mcp`.

The public MCP hostname uses:

- `/mcp`.
- `/.well-known/oauth-protected-resource/mcp`.

For GET, POST, PUT, PATCH, DELETE and OPTIONS require 503 and exact disabled JSON. For HEAD require 503 and JSON content type; HTTP HEAD has no response body to parse. Retain the instrumented worker test for the no-worker assertion.

The MCP-hostname refusal can be served by HM6’s existing Caddy dark handler. It does not establish edge routing or worker behavior; loopback/API and instrumented controls remain necessary.

Staging is production-backed. Execute staging probes from the Mac mini.

### Public hosted commands

Derive the list from `PUBLIC_HOSTED_ONLY_COMMANDS` in the release’s `src/protocol/hosted-authority.ts`; it contains six kinds, including open and ACK.

`handlePostRequest()` refuses hosted-only commands and claimed hosted context before command-ID validation, bearer classification or GoTrue. Require unauthenticated 403 `{"error":"forbidden"}`, paired with ordinary malformed-command 400 and missing-bearer mint 401 controls.

Run the successful public reads separately from every refusal probe. Both blocks
repeat their Mac and box execution context so either can run alone.

```sh
# step: hm37-public-boundary-reads
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
# Its ssh subprocess runs only the gateway loopback read on the box as root.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  test "$(git rev-parse HEAD)" = "$SHA"
  git diff --exit-code "$SHA" -- src/protocol/hosted-authority.ts
  READS="$(mktemp /tmp/hm37-boundary-reads.XXXXXX)"
  case "$READS" in /tmp/hm37-boundary-reads.??????) ;; *) false ;; esac
  trap 'rm -f -- "$READS"' EXIT

  cat >"$READS" <<'PY'
import json, sys, urllib.error, urllib.request

results = []
PROBE_UA = "commonswarm-release-probe/1.0"

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())

def read(base, path, media_type):
    explicit_ua = base in (
        "https://edge-staging.commonswarm.com",
        "https://api.commonswarm.com",
    )
    headers = {"User-Agent": PROBE_UA} if explicit_ua else {}
    request = urllib.request.Request(base + path, headers=headers)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        content_type = response.headers.get("Content-Type", "")
        server = response.headers.get("Server")
        cf_ray = response.headers.get("CF-Ray")
        raw = response.read(131073)
    actual_media_type = content_type.split(";", 1)[0].strip().lower()
    record = {
        "base": base, "method": "GET", "path": path, "status": status,
        "user_agent": PROBE_UA if explicit_ua else "Python urllib default",
        "headers": {"server": server, "cf-ray": cf_ray,
                    "content-type": content_type},
        "assertion_id": (
            "gateway.public-hosted-command-refusal"
            if mode == "gateway" and path == "/functions/v1/command"
            else ("gateway.dark-route-refusal" if mode == "gateway"
                  else "mcp.dark-route-refusal")
        ),
    }
    json_media = actual_media_type in ("application/json", "application/jwk-set+json")
    if not json_media:
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
    if status == 403 and b"error code: 1010" in raw[:2048].lower():
        record["failure_kind"] = "cloudflare_challenge"
    results.append(record)
    if status != 200 or actual_media_type != media_type or len(raw) > 131072:
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    try:
        value = json.loads(raw)
    except Exception:
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    return value

mode = sys.argv[1]
assert mode in ("gateway", "mcp")
for base in sys.argv[2:]:
    if mode == "gateway":
        read(base, "/functions/v1/h0/agent-doc/smoke", "application/json")
    else:
        for path in (
            "/.well-known/oauth-authorization-server",
            "/.well-known/openid-configuration",
        ):
            document = read(base, path, "application/json")
            assert document["issuer"] == base
            assert document["authorization_endpoint"] == base + "/authorize"
            assert document["token_endpoint"] == base + "/token"
            assert document["jwks_uri"] == base + "/jwks"
        jwks = read(base, "/jwks", "application/jwk-set+json")
        keys = jwks.get("keys")
        assert isinstance(keys, list) and keys
        for key in keys:
            assert isinstance(key, dict)
            assert key.get("kty") == "EC" and key.get("crv") == "P-256"
            assert key.get("alg") == "ES256"
            assert isinstance(key.get("kid"), str) and key["kid"]
            assert isinstance(key.get("x"), str) and key["x"]
            assert isinstance(key.get("y"), str) and key["y"]
            assert not {"d", "p", "q", "dp", "dq", "qi", "oth", "k"} & key.keys()

print(json.dumps({"pass": True, "mode": mode, "results": results}, indent=2))
PY

  ssh ops@100.115.66.74 \
    'sudo -n -i python3 - gateway http://127.0.0.1:9000' \
    <"$READS" >"$EVIDENCE_DIR/hm37-loopback-reads.json"

  python3 "$READS" gateway \
    https://edge-staging.commonswarm.com \
    https://api.commonswarm.com \
    >"$EVIDENCE_DIR/hm37-public-reads.json"

  python3 "$READS" mcp https://mcp.commonswarm.com \
    >"$EVIDENCE_DIR/hm37-mcp-hostname-reads.json"
)
```

```sh
# step: hm37-public-boundaries
# readonly: probe
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
# Its ssh subprocess runs only the gateway loopback probes on the box as root.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  test "$(git rev-parse HEAD)" = "$SHA"
  git diff --exit-code "$SHA" -- src/protocol/hosted-authority.ts
  PROBE="$(mktemp /tmp/hm37-boundaries.XXXXXX)"
  case "$PROBE" in /tmp/hm37-boundaries.??????) ;; *) false ;; esac
  trap 'rm -f -- "$PROBE"' EXIT

  python3 - src/protocol/hosted-authority.ts >"$PROBE" <<'PY'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1]).read_text()
matches = re.findall(
    r"const PUBLIC_HOSTED_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\);", source)
assert len(matches) == 1
kinds = re.findall(r"'([a-z_]+)'", matches[0])
assert len(kinds) == 6 and len(set(kinds)) == 6
assert {"open_hosted_mcp_check_batch", "ack_hosted_mcp_check_batch"} <= set(kinds)
print("KINDS = " + repr(kinds))
PY
  cat >>"$PROBE" <<'PY'
import json, sys, urllib.error, urllib.request, uuid

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

opener = urllib.request.build_opener(NoRedirect())
results = []
PROBE_UA = "commonswarm-release-probe/1.0"
disabled = {
    "error": "feature_disabled",
    "feature": "hosted_mcp",
    "message": "Hosted MCP is not available yet.",
}
methods = ("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")

def probe(base, method, path, body, expected_status, expected_body=None):
    data = None if body is None else json.dumps(body).encode()
    explicit_ua = base in (
        "https://edge-staging.commonswarm.com",
        "https://api.commonswarm.com",
    )
    headers = {"Content-Type": "application/json"}
    if explicit_ua:
        headers["User-Agent"] = PROBE_UA
    request = urllib.request.Request(
        base + path, data=data, method=method,
        headers=headers)
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        content_type = response.headers.get("Content-Type", "")
        server = response.headers.get("Server")
        cf_ray = response.headers.get("CF-Ray")
        raw = response.read(131073)
    media_type = content_type.split(";", 1)[0].strip().lower()
    record = {
        "base": base, "method": method, "path": path, "status": status,
        "expected_status": expected_status,
        "user_agent": PROBE_UA if explicit_ua else "Python urllib default",
        "headers": {"server": server, "cf-ray": cf_ray,
                    "content-type": content_type},
    }
    if media_type != "application/json":
        record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
    if status == 403 and b"error code: 1010" in raw[:2048].lower():
        record["failure_kind"] = "cloudflare_challenge"
    results.append(record)
    if status != expected_status or len(raw) > 131072 or media_type != "application/json":
        print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
        raise SystemExit(1)
    if method == "HEAD":
        if raw != b"":
            record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
            print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
            raise SystemExit(1)
        parsed = None
    else:
        try:
            parsed = json.loads(raw)
        except Exception:
            record["body_prefix"] = raw[:2048].decode("utf-8", "replace")
            print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
            raise SystemExit(1)
        if expected_body is not None:
            if parsed != expected_body:
                print(json.dumps({"pass": False, "failure": record, "results": results}, indent=2))
                raise SystemExit(1)
    record["pass"] = True
    return parsed

mode = sys.argv[1]
assert mode in ("gateway", "mcp")
for base in sys.argv[2:]:
    if mode == "gateway":
        probe(base, "POST", "/functions/v1/command",
              {}, 400, {"error": "invalid_request"})
        for kind in KINDS:
            probe(base, "POST", "/functions/v1/command",
                  {"command_id": str(uuid.uuid4()), "command": {"kind": kind}},
                  403, {"error": "forbidden"})
        probe(base, "POST", "/functions/v1/command",
              {"command_id": str(uuid.uuid4()),
               "command": {"kind": "mint_agent_token"}},
              401, {"error": "unauthenticated"})
        paths = (
            "/functions/v1/mcp",
            "/functions/v1/mcp/.well-known/oauth-protected-resource/mcp",
        )
    else:
        result = probe(base, "GET", "/authorize", None, 503)
        assert result.get("error") == "authorization_service_disabled"
        result = probe(base, "POST", "/token", {}, 503)
        assert result.get("error") == "authorization_service_disabled"
        paths = ("/mcp", "/.well-known/oauth-protected-resource/mcp")

    for path in paths:
        for method in methods:
            probe(base, method, path, None, 503, disabled)

print(json.dumps({
    "pass": True, "mode": mode, "hosted_command_count": len(KINDS), "results": results,
}, indent=2))
PY

  ssh ops@100.115.66.74 \
    'sudo -n -i python3 - gateway http://127.0.0.1:9000' \
    <"$PROBE" >"$EVIDENCE_DIR/hm37-loopback-boundaries.json"

  python3 "$PROBE" gateway \
    https://edge-staging.commonswarm.com \
    https://api.commonswarm.com \
    >"$EVIDENCE_DIR/hm37-public-boundaries.json"

  python3 "$PROBE" mcp https://mcp.commonswarm.com \
    >"$EVIDENCE_DIR/hm37-mcp-hostname-boundaries.json"
)
```

Requests to `edge-staging.commonswarm.com` and `api.commonswarm.com` send and record `User-Agent: commonswarm-release-probe/1.0`. Requests to `mcp.commonswarm.com` deliberately retain and record Python urllib's default User-Agent; loopback may do the same. A 403 containing `error code: 1010` is recorded as `cloudflare_challenge`, with status, `Server`, `CF-Ray`, `Content-Type`, and the first 2,048 bytes of its non-JSON body. Transport errors, redirects, challenges and generic 503s fail. Repeat HM6’s separate curl and OAuth-loopback controls as well.

During section 9, send well-shaped unauthenticated public open/ACK requests using the temporary seat/batch identifiers. Read the seat’s durable cursor/batch state before and after: neither request may open, acknowledge or advance anything.

### COMMIT POINT — DARK edge and migration 04 stay live

The named **COMMIT POINT** is reached only after all loopback DARK checks, both gateway public-boundary blocks, and all MCP-hostname boundary checks above pass. Before this point, any failure follows the full edge-first rollback in section 11. After this point, an ordinary hosted- or local-control failure runs the applicable control cleanup and revocation, records `CONTROLS=failed`, leaves edge `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` and migration `20260928000004` live and DARK, restores any stopped timers, copies failure evidence, and stops. After the COMMIT POINT, full rollback is permitted only for the following statically classified product-safety assertions:

- **S1:** a public or unauthenticated write is accepted, including any 2xx where refusal is required, or a refused open/ACK nevertheless opens, acknowledges, or advances state.
- **S2:** cleanup cannot remove control state: an active unexpired agent token, active provider family/artifact, or unrevoked control seat, handle, principal, or grant remains.
- **S3:** the customer-live LOCAL path skips or repeats a committed signal, advances a cursor without a valid ACK, accepts an ACK from the wrong principal, or returns a batch to the wrong principal. A local setup or harness failure before its first product assertion is `control`, not S3.
- **S4:** either control exposes cross-principal or cross-workspace data.
- **S5:** a hosted-only command succeeds with a human bearer or without hosted credentials, or a seat handle authenticates by itself.

The classification is not an operator choice. Every failure JSON carries `assertion_id`, and the action is selected from this complete mapping:

| Assertion id | Class | On failure |
|---|---|---|
| `gateway.public-hosted-command-refusal`, `gateway.dark-route-refusal`, `mcp.dark-route-refusal`, `hosted.public-unauthenticated-refusal` | S1 | Cleanup, revoke, then full rollback. |
| `hosted.cleanup-complete`, `local.cleanup-complete` | S2 | Preserve diagnostics, then full rollback. |
| `local.delivery-exactly-once`, `local.cursor-requires-valid-ack`, `local.ack-principal-binding`, `local.batch-principal-binding` | S3 | Cleanup if possible, then full rollback. |
| `hosted.visibility-confined`, `local.visibility-confined` | S4 | Cleanup, revoke, then full rollback. |
| `hosted.public-human-bearer-refusal`, `hosted.seat-handle-alone-refusal` | S5 | Cleanup, revoke, then full rollback. |
| `hosted.concurrent-open-single-batch`, `hosted.ack-a-commits-cursor`, `hosted.repeat-ack-idempotent`, `hosted.ack-b-empty-open`, `hosted.migration-functional-proof`, `local.setup`, `local.harness`, and every `control.*` id | control | Cleanup and revocation only; record `CONTROLS=failed`; leave the release live and DARK; stop. |

The hosted harness's JSON `error` object contains `assertion_id`, `step`, `code`, and `class`. The local control output must use the same field name and one of the local ids above. A failure without a recognized id is `control` and cannot authorize rollback; preserve it for plan correction.

## 9. Hosted open/ACK control

The executable control is
`deploy/release-proofs/item-hm/hm37-open-ack-control.ts`, with Deno import map
`deploy/release-proofs/item-hm/hm37-open-ack-deno.json`. The committed harness
SHA-256 is `dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013`; the import-map SHA-256 is
`f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b`. Anvil recomputes both from the accepted
commit before staging and records the accepted commit, hashes and independent
review in `hm37-hosted-control-inputs.txt`. A mismatch stops before migration
or edge mutation.

The harness runs with `/usr/local/bin/deno` on the box, not with
`/usr/local/bin/edge-runtime` in the edge container. The pinned edge image
contains the embedded edge-runtime server binary but no standalone Deno CLI;
the box Deno runs against the exact release tree while receiving the same edge
environment. Before approval, Anvil runs `hm37-hosted-control-stage`, which
proves that `/usr/local/bin/deno` is a regular root-owned executable, records
its `deno --version`, and pre-caches the pinned npm graph into the control
directory. No dependency install or network fetch is allowed after this
opening gate. The harness does not edit the release tree.

Protected inputs are exactly:

- `human-session.json`, a regular mode-`0600` file containing only
  `{"access_token":"..."}`. Tom runs a fresh `cswarm login`; the Mac-side
  preparation below refreshes that same stored human session through the
  released credential code and writes the short-lived access JWT without
  printing it. The harness independently calls GoTrue `getUser` and verifies
  JWT claims through Supabase `getClaims`; it derives `identityVerified` from
  the confirmed user and never accepts that field from input.
- `oauth-database.json`, a regular mode-`0600` file containing exactly
  `host`, `port`, `database`, `user`, `password` and `ssl_ca`. Anvil builds it
  on the box from the already-reviewed OAuth service database credential,
  service configuration and internal CA. It is the least-privilege
  `commonswarm_oauth_runtime` login, not a service-role key.
- The command database URL, Supabase URL, anon key and database CA come only
  from the existing edge environment `/home/commonswarm/.env`. They are never
  placed in argv, output or evidence. The service-role key is neither required
  nor read by this control.

Prepare Tom's protected session on the Mac mini immediately before secure
transfer. This uses the same current target and human credential store as the
HM2 controls; it rotates the refresh credential under the store lock and keeps
the access token only in the private file.

```sh
# step: hm37-hosted-human-session-input
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
# Runs on the Mac mini as Anvil, under /bin/bash 3.2, in the accepted harness checkout.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  INPUT_ROOT="$HOME/.config/cswarm/box-hm37-${WINDOW_ID}"
  mkdir -m 0700 "$INPUT_ROOT"
  test ! -e "$INPUT_ROOT/human-session.json"
  cat >"$INPUT_ROOT/write-human-session.ts" <<'TS'
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
const output = process.argv[2];
const root = process.argv[3];
if (!output || !root) throw new Error("output and checkout paths required");
const moduleUrl = (path) => pathToFileURL(resolve(root, path)).href;
const { readCurrentTarget } = await import(moduleUrl("src/cloud/current-target.ts"));
const { refreshedCredential } = await import(moduleUrl("src/cloud/auth.ts"));
const { credentialStore } = await import(moduleUrl("src/cloud/storage.ts"));
const target = await readCurrentTarget();
if (!target || target.url !== "https://api.commonswarm.com") {
  throw new Error("current CommonSwarm target is not production");
}
const store = await credentialStore({ target });
const session = await refreshedCredential(target, store);
const file = await open(output, "wx", 0o600);
try {
  await file.writeFile(JSON.stringify({ access_token: session.accessToken }) + "\n");
  await file.sync();
  await file.chmod(0o600);
} finally {
  await file.close();
}
TS
  node --import tsx "$INPUT_ROOT/write-human-session.ts" \
    "$INPUT_ROOT/human-session.json" "$PWD"
  test "$(stat -f %Lp "$INPUT_ROOT/human-session.json")" = 600
  rm "$INPUT_ROOT/write-human-session.ts"
  printf 'protected human session prepared; transfer through the approved secure file path\n'
)
```

Stage the reviewed files beside the immutable release, build the second
protected input without printing it, and pre-cache dependencies before the
opening gate closes. `CONTROL_ROOT` is window state, not a release directory
and not copied as evidence.

The measured box baseline has no `/usr/local/bin/deno`. Install the reviewed
runtime while network access is still permitted. The download may contact only
the hard-coded GitHub URL and its measured
`release-assets.githubusercontent.com` redirect. The later cache fill may
contact only `registry.npmjs.org`.

```sh
# step: hm37-deno-install
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash before the opening gate closes.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  DENO_PATH=/usr/local/bin/deno
  DENO_ZIP_SHA256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
  DENO_URL=https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip
  DOWNLOAD_ROOT="/run/commonswarm-deno-${WINDOW_ID}"
  case "$DOWNLOAD_ROOT" in /run/commonswarm-deno-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) false ;; esac
  test "$(stat -c '%U:%G:%a' /usr/local/bin)" = root:root:755

  RECORDED_DENO_SHA256=${DENO_INSTALLED_BINARY_SHA256:-}
  if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
    test -n "$RECORDED_DENO_SHA256"
    test -f "$DENO_PATH"
    test ! -L "$DENO_PATH"
    test "$(stat -c '%U:%G:%a' "$DENO_PATH")" = root:root:755
    test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$RECORDED_DENO_SHA256"
    test "$("$DENO_PATH" --version | sed -n '1p')" = 'deno 2.9.7'
    exit 0
  fi

  if [ -n "$RECORDED_DENO_SHA256" ]; then
    case "$RECORDED_DENO_SHA256" in (*[!0-9a-f]*|'') false ;; esac
    test "${#RECORDED_DENO_SHA256}" -eq 64
  fi
  test ! -e "$DOWNLOAD_ROOT"
  install -d -m 0700 -o root -g root "$DOWNLOAD_ROOT"
  cleanup_download() {
    case "$DOWNLOAD_ROOT" in
      /run/commonswarm-deno-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z)
        find "$DOWNLOAD_ROOT" -xdev -depth -delete
        ;;
      *) return 1 ;;
    esac
  }
  trap cleanup_download EXIT
  REDIRECT_HEADERS="$DOWNLOAD_ROOT/redirect.headers"
  curl --fail --silent --show-error --head --proto '=https' --max-time 30 \
    --dump-header "$REDIRECT_HEADERS" --output /dev/null "$DENO_URL"
  test "$(grep -ic '^location:' "$REDIRECT_HEADERS")" -eq 1
  REDIRECT_URL="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print}' "$REDIRECT_HEADERS")"
  case "$REDIRECT_URL" in https://release-assets.githubusercontent.com/*) ;; *) false ;; esac
  EFFECTIVE_URL="$DOWNLOAD_ROOT/effective-url.txt"
  curl --fail --silent --show-error --proto '=https' --max-time 120 \
    --output "$DOWNLOAD_ROOT/deno.zip" --write-out '%{url_effective}\n' \
    "$REDIRECT_URL" >"$EFFECTIVE_URL"
  test "$(cat "$EFFECTIVE_URL")" = "$REDIRECT_URL"
  test "$(sha256sum "$DOWNLOAD_ROOT/deno.zip" | awk '{print $1}')" = "$DENO_ZIP_SHA256"
  python3 - "$DOWNLOAD_ROOT/deno.zip" "$DOWNLOAD_ROOT/deno" <<'PY'
import os
import shutil
import stat
import sys
import zipfile

archive, output = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    assert source.namelist() == ["deno"]
    info = source.getinfo("deno")
    assert not stat.S_ISLNK(info.external_attr >> 16)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, "wb") as target, source.open(info) as binary:
        shutil.copyfileobj(binary, target)
        target.flush()
        os.fsync(target.fileno())
os.chmod(output, 0o755)
PY
  INSTALLED_SHA256="$(sha256sum "$DOWNLOAD_ROOT/deno" | awk '{print $1}')"
  case "$INSTALLED_SHA256" in (*[!0-9a-f]*|'') false ;; esac
  test "${#INSTALLED_SHA256}" -eq 64
  if [ -n "$RECORDED_DENO_SHA256" ]; then
    test "$INSTALLED_SHA256" = "$RECORDED_DENO_SHA256"
  else
    printf 'DENO_INSTALLED_BINARY_SHA256=%q\n' "$INSTALLED_SHA256" >>"$PROOF_DIR/window.env"
  fi
  python3 - "$DOWNLOAD_ROOT/deno" "$DENO_PATH" <<'PY'
import os
import shutil
import sys

source, target = sys.argv[1:]
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
with os.fdopen(fd, "wb") as output, open(source, "rb") as binary:
    shutil.copyfileobj(binary, output)
    output.flush()
    os.fsync(output.fileno())
os.chmod(target, 0o755)
PY
  test -f "$DENO_PATH"
  test ! -L "$DENO_PATH"
  test "$(stat -c '%U:%G:%a' "$DENO_PATH")" = root:root:755
  test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$INSTALLED_SHA256"
  test "$("$DENO_PATH" --version | sed -n '1p')" = 'deno 2.9.7'
  cleanup_download
  trap - EXIT
  test ! -e "$DOWNLOAD_ROOT"
)
```

```sh
# step: hm37-hosted-control-stage
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after the accepted files arrive.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  STAGING_ROOT="/run/commonswarm-hm37-${WINDOW_ID}"
  HARNESS="$CONTROL_ROOT/hm37-open-ack-control.ts"
  DENO_CONFIG="$CONTROL_ROOT/hm37-open-ack-deno.json"
  test "$(cat "$RELEASE_ROOT/RELEASE_SHA")" = "$SHA"
  test -f /usr/local/bin/deno
  test ! -L /usr/local/bin/deno
  test -x /usr/local/bin/deno
  test "$(stat -c %U /usr/local/bin/deno)" = root
  test ! -e "$CONTROL_ROOT"
  install -d -m 0700 "$CONTROL_ROOT" "$CONTROL_ROOT/journal" "$CONTROL_ROOT/deno-cache"
  install -m 0600 "$STAGING_ROOT/hm37-open-ack-control.ts" "$HARNESS"
  install -m 0600 "$STAGING_ROOT/hm37-open-ack-deno.json" "$DENO_CONFIG"
  install -m 0600 "$STAGING_ROOT/human-session.json" "$CONTROL_ROOT/human-session.json"
  test "$(sha256sum "$HARNESS" | awk '{print $1}')" = dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013
  test "$(sha256sum "$DENO_CONFIG" | awk '{print $1}')" = f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b
  OAUTH_CIDS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    test -n "$VALUE" && OAUTH_CIDS[${#OAUTH_CIDS[@]}]="$VALUE"
  done < <(docker ps -q \
    --filter label=com.docker.compose.project=commonswarm-oauth \
    --filter label=com.docker.compose.service=oauth)
  test "${#OAUTH_CIDS[@]}" -eq 1
  MCP_OAUTH_DATABASE_HOST_LINE="$(docker inspect --format \
    '{{range .Config.Env}}{{if eq (index (split . "=") 0) "MCP_OAUTH_DATABASE_HOST"}}{{println .}}{{end}}{{end}}' \
    "${OAUTH_CIDS[0]}")"
  case "$MCP_OAUTH_DATABASE_HOST_LINE" in MCP_OAUTH_DATABASE_HOST=?*) ;; *) false ;; esac
  MCP_OAUTH_DATABASE_HOST=${MCP_OAUTH_DATABASE_HOST_LINE#MCP_OAUTH_DATABASE_HOST=}
  python3 - "$CONTROL_ROOT/oauth-database.json" "$MCP_OAUTH_DATABASE_HOST" <<'PY'
import json, os, pathlib, sys
out = pathlib.Path(sys.argv[1])
host = sys.argv[2]
credentials = json.loads(pathlib.Path(
    "/etc/commonswarm-oauth/database-credentials").read_text())
service = {}
for line in pathlib.Path("/etc/commonswarm-oauth/service.env").read_text().splitlines():
    if line and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        service[key] = value
document = {
    "host": host,
    "port": int(service.get("MCP_OAUTH_DATABASE_PORT", "5432")),
    "database": service["MCP_OAUTH_DATABASE_NAME"],
    "user": credentials["user"],
    "password": credentials["password"],
    "ssl_ca": pathlib.Path("/etc/ssl/yulan-internal-ca.pem").read_text(),
}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(document, handle, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
PY
  test "$(stat -c %a "$CONTROL_ROOT/human-session.json")" = 600
  test "$(stat -c %a "$CONTROL_ROOT/oauth-database.json")" = 600
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno cache --no-lock \
    --config "$DENO_CONFIG" "$HARNESS" \
    "$RELEASE_ROOT/services/mcp-auth/src/postgres-adapter.js" \
    "$RELEASE_ROOT/supabase/functions/command/index.ts" \
    "$RELEASE_ROOT/supabase/functions/_shared/hosted-seat-auth.ts" \
    "$RELEASE_ROOT/supabase/functions/_shared/database-options.ts"
  /usr/local/bin/deno --version >"$CONTROL_ROOT/deno-version.txt"
  chmod 0600 "$CONTROL_ROOT/deno-version.txt"
)
```

Run only after the migration and edge gates that section 9 observes are live.
The suffix comes from the existing root-owned window file. Sourcing the edge
environment exports secrets only to the Deno process; the command line remains
secret-free. The one stdout document is safe evidence. The private journal is
never copied.

```sh
# step: hm37-hosted-open-ack-control
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash; no container or service is restarted.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  case "$WINDOW_PRINCIPAL_SUFFIX" in
    [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) false ;;
  esac
  set -a
  . /home/commonswarm/.env
  set +a
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno run --cached-only --no-lock \
    --config "$CONTROL_ROOT/hm37-open-ack-deno.json" \
    --allow-env --allow-net \
    --allow-read="$RELEASE_ROOT,$CONTROL_ROOT" \
    --allow-write="$CONTROL_ROOT/journal" \
    "$CONTROL_ROOT/hm37-open-ack-control.ts" \
    --release-root "$RELEASE_ROOT" \
    --journal-dir "$CONTROL_ROOT/journal" \
    --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 \
    --human-session-file "$CONTROL_ROOT/human-session.json" \
    --oauth-database-config-file "$CONTROL_ROOT/oauth-database.json" \
    >"$PROOF_DIR/hm37-hosted-check-control.json"
  chmod 0600 "$PROOF_DIR/hm37-hosted-check-control.json"
)
```

If the shell is lost, rerun cleanup from the recorded private journal. This is
idempotent and still verifies complete revocation before returning zero.

```sh
# step: hm37-hosted-control-cleanup-only
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after a lost shell or interrupted control.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  JOURNAL="$CONTROL_ROOT/journal/hm37-open-ack-${WINDOW_PRINCIPAL_SUFFIX}.journal.json"
  test "$(stat -c %a "$JOURNAL")" = 600
  set -a
  . /home/commonswarm/.env
  set +a
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno run --cached-only --no-lock \
    --config "$CONTROL_ROOT/hm37-open-ack-deno.json" \
    --allow-env --allow-net \
    --allow-read="$RELEASE_ROOT,$CONTROL_ROOT" \
    --allow-write="$CONTROL_ROOT/journal" \
    "$CONTROL_ROOT/hm37-open-ack-control.ts" \
    --release-root "$RELEASE_ROOT" \
    --human-session-file "$CONTROL_ROOT/human-session.json" \
    --oauth-database-config-file "$CONTROL_ROOT/oauth-database.json" \
    --cleanup-only "$JOURNAL" \
    >"$PROOF_DIR/hm37-hosted-cleanup-recovery.json"
  chmod 0600 "$PROOF_DIR/hm37-hosted-cleanup-recovery.json"
)
```

After copy-back on every successful close and every rollback/abort tail, remove
the per-window Deno cache and return `/usr/local/bin/deno` to the measured absent
baseline. An unknown or changed file is never removed.

```sh
# step: hm37-deno-remove
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after copy-back on close or rollback.
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  DENO_PATH=/usr/local/bin/deno
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  DENO_DIR="$CONTROL_ROOT/deno-cache"
  case "$DENO_DIR" in
    "/home/commonswarm/edge/controls/${SHA}-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z/deno-cache) ;;
    *) false ;;
  esac
  RECORDED_DENO_SHA256=${DENO_INSTALLED_BINARY_SHA256:-}
  if [ -z "$RECORDED_DENO_SHA256" ]; then
    if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
      printf 'STOP: %s exists but window.env has no installed Deno sha256; refusing to remove an unknown file\n' \
        "$DENO_PATH" >&2
      exit 1
    fi
    if [ -e "$DENO_DIR" ] || [ -L "$DENO_DIR" ]; then
      printf 'STOP: %s exists but window.env has no installed Deno sha256; refusing to remove an unknown path\n' \
        "$DENO_DIR" >&2
      exit 1
    fi
    printf 'deno_remove=not-installed\n' >>"$PROOF_DIR/window.env"
    exit 0
  fi
  case "$RECORDED_DENO_SHA256" in (*[!0-9a-f]*|'') false ;; esac
  test "${#RECORDED_DENO_SHA256}" -eq 64
  if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
    test -f "$DENO_PATH"
    test ! -L "$DENO_PATH"
    test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$RECORDED_DENO_SHA256"
    rm -f -- "$DENO_PATH"
  fi
  test ! -e "$DENO_PATH"
  test ! -L "$DENO_PATH"
  if [ -e "$DENO_DIR" ] || [ -L "$DENO_DIR" ]; then
    test -d "$DENO_DIR"
    test ! -L "$DENO_DIR"
    find "$DENO_DIR" -xdev -depth -delete
  fi
  test ! -e "$DENO_DIR"
  printf 'DENO_REMOVED=1\n' >>"$PROOF_DIR/window.env"
)
```

`tests/p1-server/hosted-check.test.ts` supplies useful call shapes, but its setup inserts authority rows directly, creates two hosted seats and uses an always-active provider-status callback. It is not this window’s production fixture.

The trusted locally invoked control must create **one temporary hosted seat**, using the exact release’s entry points. No HTTP bypass, public issuance, public MCP enablement or local agent token for the hosted principal is allowed.

### Setup

1. Read the saved suffix and use `hm37-hosted-${WINDOW_PRINCIPAL_SUFFIX}`.
2. Verify a human owner identity and current access/capacity in the approved control workspace. HM2 used Cold Agent Test, `c2ea0541-f56d-4c73-bf71-56c5405c4934`; present access is **not established**.
3. Create grant/consent/activation through `handleHostedManagementCommand`; never fabricate `identityVerified`.
4. Establish the temporary provider grant through the reviewed OAuth storage path while public issuance stays off.
5. Check durable provider status through `commonswarm_oauth.provider_family_active`, matching the MCP entry point.
6. Construct the genuine grant capability through `authenticateHostedGrantCapability`; claim the seat through `handleHostedCommand`.
7. Construct check capabilities through `authenticateHostedSeatCapability` with tool `check`; invoke internal open/ACK handling.
8. Keep provider-status work on a separate connection/pool from capability resolution, matching the production protection against nested-pool deadlock.
9. Persist a private cleanup journal before each creation, including recovery after partial failure or lost shell.

All CommonSwarm authority writes use transactional command entry points. SQL outside those entry points is read-only verification.

### Observations

| Step | Action | Required proof |
|---:|---|---|
| 1 | Send directed signal A normally. | A exists for the temporary hosted principal. |
| 2 | Run two concurrent opens with distinct command IDs. | Both 200; same non-null batch A and identical ordered IDs; exactly one persisted active batch. |
| 3 | Read committed cursor. | Open did not advance it. A response terminal cursor is not committed-cursor evidence. |
| 4 | Open from a fresh local invocation. | Same persisted batch and ordered IDs. |
| 5 | Send directed signal B after A opened. | B is beyond A’s terminal ordering pair. |
| 6 | Send unauthenticated public open and ACK. | Both 403; cursor/batch snapshot unchanged. |
| 7 | ACK A with its **upper-case UUID spelling**. | 200; A acknowledged; committed cursor equals A’s millisecond timestamp/UUID terminal pair. |
| 8 | Inspect ACK result and open again. | B exists and is active. ACK may itself open B. |
| 9 | Repeat ACK A with a fresh command ID. | 200; A’s acknowledgment timestamp and committed cursor unchanged; B remains active. |
| 10 | ACK B, then open. | Cursor advances to B; empty result has `batch_id=null`; no empty batch persisted. |
| 11 | Rerun migration-04 functional proof. | Exact `t`, SQL exit zero. |

Retain only safe IDs, counts, ordering pairs, timestamps and assertions. Never retain tokens, seat handles, credentials or signal bodies in copied evidence.

### Finally-path cleanup

Including partial failures:

1. Revoke the hosted seat through management commands; verify seat, handle and principal revocation.
2. Revoke its CommonSwarm grant.
3. Revoke the temporary provider grant/family through its reviewed storage path.
4. Revoke every ordinary local/sender principal created by this window.
5. Verify every recorded principal is revoked and **zero active unexpired agent tokens** remain.
6. Verify the provider family is inactive and no active temporary provider token family remains.
7. Retry hosted authorization/open/ACK with the retained private binding; require refusal.

Preserve durable signal, event, cursor and batch history. Cleanup revokes access; it does not erase history.

Missing harness acceptance prevents opening. Missing cleanup proof prevents closure.

## 10. Local `check.json` and stdio MCP

The previous-edge-to-release comparison is empty for `src/cloud/agent-check.ts` and the entire `src/mcp/` directory. Local check still uses `check.json`; stdio MCP retains its deferred response-write commit path.

That source comparison does not prove live compatibility.

Repeat HM2’s ordinary local-recipient/sender control with released cswarm `0.1.80`, Tom’s freshly verified production human session and the suffix-based names. Verify installed executable identity/version and production target before minting.

Use isolated mode-0700 directories and mode-0600 credential, connection and profile files. Persist the requested run ID and require the returned `run_id` to match. Both connection creation and cleanup readers must validate all four credential fields.

```sh
# step: hm37-validate-local-credential
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
(
  set -euo pipefail
  : "${CREDENTIAL_FILE:?protected credential file required}"
  : "${EXPECTED_PRINCIPAL_ID:?created principal ID required}"
  : "${EXPECTED_RUN_ID:?requested run ID required}"
  python3 - "$CREDENTIAL_FILE" "$EXPECTED_PRINCIPAL_ID" "$EXPECTED_RUN_ID" <<'PY'
import json, os, stat, sys, uuid
path, principal, run = sys.argv[1:]
info = os.lstat(path)
assert stat.S_ISREG(info.st_mode)
assert stat.S_IMODE(info.st_mode) == 0o600
credential = json.load(open(path))
assert isinstance(credential, dict)
def required_string(field):
    value = credential.get(field)
    if not isinstance(value, str) or not value:
        raise SystemExit(
            'credential missing required non-empty string field: ' + field)
    return value
values = {field: required_string(field) for field in
          ("agent_token", "principal_id", "token_id", "run_id")}
try:
    parsed = {field: uuid.UUID(values[field])
              for field in ("principal_id", "token_id", "run_id")}
    expected_principal = uuid.UUID(principal)
    expected_run = uuid.UUID(run)
except (ValueError, AttributeError):
    raise SystemExit("credential UUID validation failed")
assert parsed["principal_id"] == expected_principal
assert parsed["run_id"] == expected_run
print("credential_shape=PASS")
PY
)
```

When adapting HM2’s steps, transfer the suffix separately. Put JSON-reading heredocs inside helper functions before calling those functions in command substitution; never place a heredoc directly inside `$(...)`.

Required control:

1. Before migration, create ordinary recipient/sender through normal commands; verify active local, non-turn-only principals and owner membership.
2. After edge health, mint/validate credentials and create isolated profiles.
3. Send a directed primer and run recipient `cswarm check`.
4. Verify that exact delivery has `ack_outcome=observed` and non-null `acked_at`; CLI exit zero is insufficient.
5. Send a second signal and prove that exact delivery is wake-eligible before any recipient consumer runs.
6. Initialize the installed CLI’s stdio MCP with the isolated profile; call local `check`, verify the directed signal, local `check.json` advancement and exact observed delivery.
7. Require exact-SHA stdio test evidence for failed/cancelled response writes leaving deferred cursor state uncommitted, successful-write-only commit and post-write observation.
8. Revoke both ordinary principals and verify zero active unexpired tokens.

Do not start a listener or use another agent’s profile. Keep credential-bearing scratch private until cleanup acceptance; copy only sanitized assertions.

## 11. Rollback — edge first, SQL second

This section is callable before the COMMIT POINT on any failure. After the COMMIT POINT it is callable only when the failing `assertion_id` maps to S1, S2, S3, S4, or S5 in section 8; a `control` failure must not enter it. HezLead verifies that static classification and directs the already-defined action; Anvil executes. Prefer restoring the compatible previous edge while retaining the additive schema when its guarded inverse refuses durable control history.

Use this release’s **complete runbook step `runbook-42`**, including outgoing-container log capture **before** restoring the symlink or recreating.

If rolling back the new edge, the expected captured filename is:

`commonswarm-edge-edge-runtime-1.eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922.docker.log`

Resolve the actual outgoing directory and verify its release/mount identity first. Preserve the same bounded, root-owned mode-0600 logging and exact-name manifest handling as the forward switch.

Then:

1. Restore recorded `PREVIOUS_EDGE`.
2. Recreate from that exact directory with its override and `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
3. Verify health, memory, network, mounted source, ordinary controls and MCP darkness.
4. Only then consider the migration-04 inverse.

Do not roll back HM2 or HM6. Do not change Caddy.

The SQL reserve refuses any cursor or batch history. After a successful hosted control, this refusal is expected. Retain the schema unless a separately reviewed data-loss decision and recovery plan authorize removal. Never delete rows to satisfy the guard.

The inverse below is verbatim from the hashed rollback file.

```sh
# step: hm37-reserve-schema-rollback
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on the box over ssh, as Anvil in a root Bash shell.
# RESERVED: requires HezLead's decision and verified previous-edge rollback.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  test "$PREVIOUS_EDGE" = /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"
  test "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)" = healthy
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' commonswarm-edge-edge-runtime-1)" \
    = "$PREVIOUS_EDGE/deploy/edge-runtime"
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target

  cat >"$APPLY_SQL" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE swarm.hosted_mcp_check_cursors,
           swarm.hosted_mcp_check_batches IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations
      WHERE version = '20260928000004') <> 1
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_check_cursors)
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_check_batches)
  THEN
    RAISE EXCEPTION 'HM37 rollback state is unsafe or unexpected';
  END IF;
END
$guard$;

-- Complete inverse for 20260928000004_hm_hosted_check.sql.
-- Restores the 20260928000002 hosted-authority catalog unchanged.
-- Function identity is its input signature; the explicit TABLE return has no
-- dependency on the replaceable swarm_read.signals row type.
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_visible_signals(uuid, uuid, uuid[]);
DROP FUNCTION IF EXISTS swarm.resolve_hosted_mcp_check_authorization(uuid, text);

DROP TRIGGER IF EXISTS hosted_mcp_check_batches_guard
  ON swarm.hosted_mcp_check_batches;
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_batches_guard();
DROP TRIGGER IF EXISTS hosted_mcp_check_cursors_guard
  ON swarm.hosted_mcp_check_cursors;
DROP FUNCTION IF EXISTS swarm.hosted_mcp_check_cursors_guard();

DROP TABLE IF EXISTS swarm.hosted_mcp_check_batches;
DROP TABLE IF EXISTS swarm.hosted_mcp_check_cursors;

\i /proof/20260928000004-rollback-catalog.sql
\if :{?rollback_ok}
SELECT :'rollback_ok' = 't' AS rollback_is_t
\gset
\if :rollback_is_t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM37 rollback catalog failed'; END $$;
\endif
\else
DO $$ BEGIN RAISE EXCEPTION 'HM37 rollback catalog result missing'; END $$;
\endif

DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260928000004';
COMMIT;
SQL
  release_psql --file "$APPLY_SQL"
)
```

Afterward require migration-04 ledger count zero, rollback catalog true and forward catalog false without SQL error. Recheck HM2/HM6 catalog/functional proofs and reconcile cron.

A failed forward transaction does not automatically require destructive rollback. Measure remaining state first. Never improvise a restore, delete a release or prune Docker.

## 12. Evidence, cleanup and closure

Run `runbook-03` immediately after `1-apply-release-directories` and before any database, service, timer, symlink, or Caddy mutation. It creates the explicit copy-back manifest from the persisted `window.env`. Standard entries cover archive identity, directory state, environment inventory, migration reconciliation, proofs, cron and edge artifacts.

Add these exact item-relative paths without duplicating standard generated entries:

- `20260928000002-catalog.sql`
- `20260928000002-functional.sql`
- `20260928000003-catalog.sql`
- `20260928000003-functional.sql`
- `20260928000004-rollback.sql`
- `20260928000004-rollback-catalog.sql`
- `hm37-hm6-schema-helpers.txt`
- `hm37-hm6-migration-03-catalog.txt`
- `hm37-hm6-migration-03-functional.txt`
- `hm37-hm6-oauth-runtime.txt`
- `hm37-hm6-oauth-public-precondition.json`
- `hm37-hm6-oauth-refusals.json`
- `hm37-all-migration-files.txt`
- `hm37-ledger-before.txt`
- `hm37-pending-before.txt`
- `hm37-current-window-state.txt`
- `hm37-prerequisites.json`
- `hm37-stack-runtime-review.txt`
- `hm37-backup-gate.txt`
- `hm37-worker-boundary.txt`
- `hm37-loopback-reads.json`
- `hm37-public-reads.json`
- `hm37-mcp-hostname-reads.json`
- `hm37-loopback-boundaries.json`
- `hm37-public-boundaries.json`
- `hm37-mcp-hostname-boundaries.json`
- `hm37-hosted-control-inputs.txt`
- `hm37-hosted-check-control.json`
- `hm37-public-check-no-mutation.json`
- `hm37-functional-after-control.txt`
- `hm37-local-control.json`
- `hm37-revocation-readback.json`
- `hm37-close-readback.txt`

`hm37-hosted-control-inputs.txt` records the accepted harness identity/checksum, invocation, runtime and review acceptance, never protected inputs. `hm37-worker-boundary.txt` records the exact-SHA instrumented result and positive control.

These are required outputs, not existing PASS claims. Transfer accepted Mac-side results to the proof directory before manifest-only copy-back.

Use `docs/evidence/<UTC-date>-release-eb2a87ac4b5a/`. Preserve distinct Mac `archive.sha256` and box `box-archive.sha256`. Mac tar operations use `COPYFILE_DISABLE=1` and `--no-xattrs`.

### Log exception and secret review

The updated runbook permits the bounded outgoing-container `*.docker.log` files appended by its recreate steps. Do not add arbitrary logs to the initial item manifest.

The copy-back procedure validates allowed container names, full lowercase release SHAs, root ownership, mode 0600 and the 10 MiB bound. Privately review these logs for secrets/request data before transfer. Capturing logs does not authorize exposing sensitive contents; if unsafe, stop copy-back for HezLead’s disposition.

Keep all other raw logs, including the probe-window log and `database/logs/`, on the box.

Never copy window state, private cleanup journals, credentials, profiles, connection files, complete environments, database session helpers, password files or dumps.

Follow the runbook’s empty/nonempty `.err` handling and review nonempty errors before transfer. Missing manifests or required artifacts stop successful copy-back. Do not reconstruct a manifest by scanning the directory or fabricate missing results.

### Every exit path

On success, refusal, failure or abort:

1. Revoke every temporary principal and provider grant/family; obtain readback.
2. Run runbook abort cleanup whenever durable window state exists; restore only timers this window stopped.
3. Remove transient database-session and protected smoke files when no longer needed.
4. Preserve immutable releases and private diagnostics.
5. Copy approved evidence through the manifest.
6. Run `runbook-60`, then `runbook-61`, so transient files are removed and the active proof directory becomes the exact per-window closed name.
7. Run Mac `runbook-12` only when HezLead closes the window.

Successful closure must explicitly establish:

- Only migration 04 was applied; catalog and functional proofs passed.
- Edge is at `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`.
- HM2 remains valid.
- HM6 migration 03 and the OAuth-aware helpers remain live from `ad964ed158181ba1692dd05895f36fa7a1f87d3f`.
- HM6 OAuth remains live from `826db6a34f235064a3a03c57377d8e32a35d2f05`, with its accepted image, discovery/JWKS and disabled public authorization.
- Stack runtime/helpers remain at the accepted HM6 baseline; no stack switch occurred.
- No Caddy change occurred in this window.
- Public MCP remains disabled on loopback, staging, API and MCP-hostname routes.
- Worker-boundary evidence and public pre-auth refusal controls passed.
- Hosted concurrent-open, upper-case ACK, repeated ACK, cursor and no-public-mutation controls passed.
- Local `check.json` and stdio MCP compatibility passed.
- Temporary principals/grants/families were revoked; zero active unexpired agent tokens remain.
- Outgoing-container capture disposition is recorded, timers restored, transient files removed and approved evidence copied.

Public MCP activation, every Caddy or access-log change, and real Claude-client interoperability remain outside this window.

## Changes from v3

1. Moved the release from `e7bb7a46b24e7bc794234416d43605bca52b55d4` to `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`, which is a local descendant of the prior HM37 release and both HM6 production releases.
2. Split the HM6 opening precondition into migration 03/helpers from `ad964ed158181ba1692dd05895f36fa7a1f87d3f` and the OAuth runtime/ingress from `826db6a34f235064a3a03c57377d8e32a35d2f05`; added complete read-only checks for both.
3. Re-measured the previous-edge comparison at the new SHA. It remains exactly 18 paths; the environment example still adds only optional `SWARM_MCP_PUBLIC_ENABLED`, so `ADDITIONAL_REQUIRED_ENV_NAMES` remains empty.
4. Recomputed every listed SHA-256 from the `eb2a87ac` tree. The release runbook, HM37 v3 input, HM6 plan and two affected test-source hashes changed; every other listed digest remained the same.
5. Updated the runbook contract for its fifth manifest switch, `MCP_CADDY_RELEASE=no`. The current Caddy paths pre-create or repair derived access logs before validation, but this window runs neither Caddy path and changes no Caddy file or log.
6. Kept migration 04 as the only permitted pending migration, preserved the complete edge switch/rollback and evidence contracts, and left all previously reviewed feature scope unchanged.
7. Established the reviewed hosted open/ACK harness, its portable Deno import map, exact hashes, protected-input preparation, box invocation and cleanup-only recovery path.

## Historical changes from the 79f70b7d draft to v3

1. Changed the release from `79f70b7d77b2341e685d796bb918b3a3a7660e8d` to `e7bb7a46b24e7bc794234416d43605bca52b55d4`; the expected previous edge remains `72c57e0d…`.
2. Re-measured the exact edge/schema diff from `72c57e0d…`: 18 paths rather than 13, adding five edge documentation/validation paths while leaving the runtime edge inputs unchanged from HM6.
3. Recomputed every listed SHA-256 from the `e7bb7a4` Git tree and added the split Caddy pair, its adapted-config tools, HM6 plan controls, site-deletion guards and server-repeat workflow inputs.
4. Preserved migration-directory identity with `ad964ed1`: 63 tracked entries, 62 SQL migrations and Git tree ID `201ce7c…`. Migration 04 remains the only permitted pending version after HM6 is genuinely live.
5. Corrected the unsupported HM6-closure statement. The release-tree evidence records an abort before runtime mutation, so live and closed HM6 at `ad964ed1` remains an independently measured opening precondition.
6. Reconfirmed no stack runtime differences against HM6, no local-check/stdio source changes and no new required edge environment names; `ADDITIONAL_REQUIRED_ENV_NAMES` remains empty.
7. Updated the runbook contract to include `API_CADDY_PAIR=no`. Section 9's two-file live/maintenance handling is acknowledged but steps `runbook-56` through `runbook-59`, pair artifacts, installation and reload are all excluded.
8. Retained the complete forward and rollback edge steps, each saving the outgoing container's bounded mode-0600 log before any symlink change or recreate.
9. Kept site deployment, server-repeat execution, HM6 retry and all public activation outside this window; source or workflow presence is not passing evidence.
10. Required Anvil's non-interactive service-account, file-based 1Password method and retained all no-secret-output rules.
11. Recorded the then-unresolved hosted-control harness gate, one suffix-named hosted seat, genuine capability/provider checks, cleanup and zero-token requirements; section 9 of this revision resolves the artifact and invocation portion of that gate.
12. Preserved DARK probes, false-without-error migration gating, immediate functional proof, local credential validation, local/stdio controls, edge-first rollback and the verbatim guarded SQL inverse.
