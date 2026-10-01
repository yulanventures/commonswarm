# HM lane 2: box window plan

**Status: PLAN — production execution and closure are not established.**

This window keeps the stack and edge release at **`72c57e0d76d0aa86fe4f811a2cf51499919fed20`**. It takes **only** the four `20260928000002` proof files from main commit **`202be656`**; it does not take any other file from current main. Current main also carries migration **`20260928000003_hm_oauth_store.sql`** for HM lane 6, and this window must not stage or apply that migration.

The reviewed proof bytes are fixed by these full SHA-256 digests:

| Proof file from `202be656` | SHA-256 |
|---|---|
| `deploy/release-proofs/item-hm/20260928000002-catalog.sql` | `83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144` |
| `deploy/release-proofs/item-hm/20260928000002-functional.sql` | `1e8274f07674960748a4217022a65f3cca5fcb5e43a14476abf5e2b4ae006fa3` |
| `deploy/release-proofs/item-hm/20260928000002-rollback.sql` | `4f645461833cc828c1624b0d7268bd13e12b0f6efc959c724707419df59d7a7b` |
| `deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql` | `b870d101bfea39018c165f2b8f527dcc7ac1b0f2175a81f5490311da3ec0e54c` |

Release hosted authority and internal authentication from that unchanged release SHA, applying migration **`20260928000002_hm_hosted_authority.sql`** before switching the edge.

Anvil runs every Mac mini and box command. HezLead approves the SHA, backup age, transitions and rollback, and closes the window. CSwarmDevLead coordinates and supplies reviewed inputs.

The governing procedure is `deploy/RELEASE-TO-BOX.md` at this release SHA, together with the workspace’s `hetzner-handoff/HETZNER-OPERATIONS.md`. Use the runbook’s current archive, environment-inventory, database-session, migration, edge, copy-back and cleanup procedures.

Every runnable block below has a unique step ID. Execute it with Bash, taking only the lines inside its fence. Runbook procedures referenced in prose remain required; this document does not replace them.

## Release identity and measured shape

Repository inspection established:

| Fact | Measurement |
|---|---|
| Stack and edge release SHA | `72c57e0d76d0aa86fe4f811a2cf51499919fed20` |
| Corrected proof source | `202be65661f9c3084bb2ebf6cbba0b977e6aa71b` on `origin/main` |
| Release content boundary | Migration `20260928000003` is absent from the release SHA and proof source |
| Current remote GitHub state | **Not established**; Anvil must fetch and verify through runbook section 1 |
| Live edge and stack baseline | Supplied as `9b085c82352390cf8f0fe515c02b3ccff423476a`; current box paths must be remeasured |

The unchanged release contains the migration, and the proof commit supplies the four corrected proofs:

- `supabase/migrations/20260928000002_hm_hosted_authority.sql`
- `deploy/release-proofs/item-hm/20260928000002-catalog.sql`
- `deploy/release-proofs/item-hm/20260928000002-functional.sql`
- `deploy/release-proofs/item-hm/20260928000002-rollback.sql`
- `deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql`

Reproduce the release-shape measurement:

```sh
# step: hm2-measure-release
(
  set -euo pipefail
  SHA=72c57e0d76d0aa86fe4f811a2cf51499919fed20
  PROOF_SHA=202be65661f9c3084bb2ebf6cbba0b977e6aa71b
  BASE=9b085c82352390cf8f0fe515c02b3ccff423476a
  test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
  test "$(git rev-parse "${PROOF_SHA}^{commit}")" = "$PROOF_SHA"
  git merge-base --is-ancestor "$BASE" "$SHA"
  git merge-base --is-ancestor "$PROOF_SHA" origin/main

  git cat-file -e "${SHA}:supabase/migrations/20260928000002_hm_hosted_authority.sql"
  if git cat-file -e "${SHA}:supabase/migrations/20260928000003_hm_oauth_store.sql" 2>/dev/null; then
    false
  fi
  if git cat-file -e "${PROOF_SHA}:supabase/migrations/20260928000003_hm_oauth_store.sql" 2>/dev/null; then
    false
  fi

  for SPEC in \
    'deploy/release-proofs/item-hm/20260928000002-catalog.sql:83e16d2ae549137e1abcd599428c6f94800b357ee06c982ae060c30d96a61144' \
    'deploy/release-proofs/item-hm/20260928000002-functional.sql:1e8274f07674960748a4217022a65f3cca5fcb5e43a14476abf5e2b4ae006fa3' \
    'deploy/release-proofs/item-hm/20260928000002-rollback.sql:4f645461833cc828c1624b0d7268bd13e12b0f6efc959c724707419df59d7a7b' \
    'deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql:b870d101bfea39018c165f2b8f527dcc7ac1b0f2175a81f5490311da3ec0e54c'
  do
    FILE="${SPEC%%:*}"
    EXPECTED="${SPEC##*:}"
    ACTUAL="$(git show "${PROOF_SHA}:${FILE}" | shasum -a 256)"
    test "${ACTUAL%% *}" = "$EXPECTED"
  done

  for FILE in \
    deploy/release-proofs/item-hm/20260928000002-catalog.sql \
    deploy/release-proofs/item-hm/20260928000002-functional.sql \
    deploy/release-proofs/item-hm/20260928000002-rollback.sql \
    deploy/release-proofs/item-hm/20260928000002-rollback-catalog.sql
  do
    git cat-file -e "${PROOF_SHA}:${FILE}"
  done

  git diff --name-only "$BASE" "$SHA" -- supabase/
  git diff --name-only "$BASE" "$SHA" -- deploy/edge-runtime/
  git diff "$BASE" "$SHA" -- deploy/supabase-stack/env.example
)
```

The `supabase/` comparison returns exactly **six paths**:

1. `supabase/functions/_shared/agent-auth.ts`
2. `supabase/functions/_shared/hosted-seat-auth.ts`
3. `supabase/functions/_shared/protocol.js`
4. `supabase/functions/command/index.ts`
5. `supabase/functions/read/index.ts`
6. `supabase/migrations/20260928000002_hm_hosted_authority.sql`

Use these runbook inputs:

| Input | Value |
|---|---|
| `SHA` | `72c57e0d76d0aa86fe4f811a2cf51499919fed20` |
| `KIND_LIST` | `edge stack` |
| `CHANGED_FUNCTIONS`, directly from entry-point diff | `command read` |
| `ROUTER_CHANGED` | `yes` |
| Effective section 1 inventory selection | `command read capability activity h0 mcp` |
| `ADDITIONAL_REQUIRED_ENV_NAMES` | Empty |
| `EXPECTED_NEW_CRON_JOBS` | Empty |
| `EXPECTED_REMOVED_CRON_JOBS` | Empty |

`stack` prepares the immutable migration/helper archive. It does **not** authorize switching `stack/current`.

The baseline comparison also establishes:

- Three changed shared-function files, listed above.
- Four changed edge-runtime paths: `RUNBOOK.md`, `env.example`, `main/index.ts`, and `main/router.ts`.
- No changes to `deploy/supabase-stack/compose.yaml`, `postgres/`, or `backup/`.
- The stack environment example changes the value example for `GOTRUE_URI_ALLOW_LIST`, adding the future OAuth callback. It adds no variable name.
- The router adds ten reserved `SWARM_MCP_*` names to its future worker allowlist. They are optional inventory entries while MCP remains disabled, not new strict requirements.
- The HM2 migration contains no cron scheduling or removal.

Anvil must still generate the environment-name inventory from the exact archive and compare stack runtime files on the box. Unexpected runtime differences stop this plan for HezLead’s review.

### Other contents of the SHA

**Lane 5’s dark router entry is deployed with this edge.** The whole archive includes `deploy/edge-runtime/main/router.ts`, which recognizes `mcp` but refuses it before worker creation, including OPTIONS requests. Both methods must return HTTP 503 with:

`{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}`

This window does **not**:

- Deploy `services/mcp-auth/` or `deploy/mcp-auth/`.
- Install `deploy/supabase-stack/commonswarm-mcp.caddy`, change Caddy/DNS, or enable the OAuth callback.
- Provision OAuth signing material, enable public hosted issuance, or create a hosted grant.
- Publish npm, record a new published client build, or release the site.
- Release the SHA’s CLI, listener, wake-lease or attendance changes to installed clients.

The `site/src/lib/agent-connect.ts` changes are comments only. The other changed site file, `site/src/components/connect/agent-connect-mint.observer.test.ts`, changes comments and assertion diagnostic strings. It is therefore slightly inaccurate to call **every** `site/` change comment-only, but there is no changed site application behavior requiring a site release.

## Gates and prior evidence

The previous window’s closure is recorded in `docs/evidence/2026-09-27-release-9b085c823523/run.log`. Its local-wake evidence records an observed ACK, eligible delivery and accepted revocation of both temporary principals.

Those results do not establish this release’s gates.

Before opening, supply exact-SHA review and gate evidence, including the runbook’s required command-core regeneration comparison and edge type check. Include the relevant hosted-authority, public-boundary, protocol and router tests, and their actual suite dispositions. Relevant source coverage includes:

- `tests/p1-server/hosted-authority.test.ts`
- `tests/hosted-auth-boundary.test.ts`
- `tests/protocol-hosted-authority.test.ts`
- `tests/protocol-workspace.test.ts`
- `tests/hm5-router-box.test.ts`
- `tests/release-proof-format.test.ts`

Exact-SHA gate results, review acceptance, GitHub check results and any accepted failures are **not established** by this read-only plan. Do not transfer HM4’s PASS labels to HM2.

## Order and handoffs

| # | Stage | Executor and approval | Required result |
|---:|---|---|---|
| 0 | Preflight | Anvil runs; HezLead approves | Section 1: fetched main ancestry, reviewed SHA, gates, archive/checksum, immutable directories, environment inventory, previous paths, UTC window, backup-age agreement and approved copy-back manifest. Stage all four proof files. |
| 1 | Existing-seat baseline | Anvil runs as Tom; HezLead reserves the seats | Prepare isolated local recipient R and sender S **before HM2 applies**, then prove both active local seats in Cold Agent Test. This supplies a recipient that exists across this window. |
| 2 | Section 5 | Anvil runs; HezLead approves each transition | Sections 2–3 database identity/session; fresh complete backup; enumerate ledger and migrations. Expected sole pending migration: `20260928000002`. Require `ledger=0/catalog=f` without error, transactional apply, then `ledger=1/catalog=t/functional=t`. Cron delta empty. |
| 3 | Section 6 edge | Anvil runs; HezLead approves switch | Preserve override, validate environment and Compose, recreate on `commonswarm-net`, verify health, memory, release path and all router/function controls. |
| 4 | Edge handoff | Anvil reports; HezLead approves controls | Say “edge switched and healthy” only after section 6’s required verification. Shared authentication and router changes require coverage beyond the two directly changed entry points. |
| 5 | Seeds/proofs and controls | Anvil runs as Tom | No hosted seeds. Mint ordinary local credentials after the switch; run R’s check, prove its observed ACK, then prove a second unobserved delivery eligible. Verify hosted public refusal and MCP darkness. |
| 6 | Close | Anvil reconciles; HezLead closes | Record evidence, revoke only this window’s temporary seats, restore stopped timers, remove transient database/smoke files, copy approved evidence and remove the Mac window file. No npm or site stage. |

On every stop, refusal or abort, run section 1’s abort cleanup. Preserve diagnostic evidence; do not improvise a stack switch or expand the release.

## Pre-approved copy-back inputs

Use the current section 1 manifest generator with:

| Input | Value |
|---|---|
| `KIND_LIST` | `edge stack` |
| `H0_LEDGER_BACKFILL` | `no` |
| `GUARDED_STACK_SWITCH` | `no` |
| `BACKUP_STATUS_PROOF` | `no` |
| `MIGRATION_VERSIONS` | `(20260928000002)` |
| `FUNCTIONAL_VERSIONS` | `(20260928000002)` |

Item-specific filenames:

- `20260928000002-rollback.sql`
- `20260928000002-rollback-catalog.sql`
- `hm-local-seat-before.txt`
- `hm-local-first-ack.txt`
- `hm-local-wake-after.txt`

`BACKUP_STATUS_PROOF=no` excludes section 8’s unit-rollout proof; section 5’s complete-backup requirement still applies.

The generator supplies standard archive, migration, catalog, functional, cron and edge artifacts. Do not recreate the manifest at closure. Follow current `.err` handling. Logs, `window.env`, database session helpers, credentials and `database/logs/` remain outside ordinary copy-back.

Boundary-probe JSON and sanitized client-control results below are Mac-side evidence. Review them before committing; never copy complete credential/setup files.

## Migration, catalog and functional proof

The migration creates:

- Four authority tables: hosted grants, workspace consents, seats and seat handles.
- RLS and narrow table privileges.
- Three restricted authorization-resolution functions for grant commands, seat commands and seat reads.
- Two owner-scoped read views.
- `hosted_grant` and `hosted_seat` idempotency principal kinds.

The catalog proof checks table ownership/RLS/privileges, command policies, resolver ownership/security/role separation, read-view boundaries, composite foreign keys and the expanded idempotency constraint.

### Before apply: false without error

The catalog file uses `to_regclass`/`to_regprocedure`, OID-based checks and false-coalescing rather than resolving absent hosted objects by throwing name casts. Its final result is `catalog_ok`, followed by its own `\gset`.

Runbook section 5 must measure **exactly `ledger=0 catalog=f` with a successful command exit before applying**. A SQL error is not a false result. `0:t`, NULL, malformed output or an unexpected ledger state stops the window.

Error-free behavior against the current production database is **not established** until Anvil executes that preflight. After apply, the same catalog proof must return `t`, providing the positive control.

Only the named pending migration is authorized. Any additional pending version requires a new disposition before proceeding.

### Functional-proof timing: section 5

The proof header states:

> Read-only functional reconciliation. Internal fixture/race coverage runs in the server suite; a dark production release need not already contain grants.

It checks:

- Hosted seat/principal workspace, owner, transport, turn-only and name agreement.
- Complete consent coverage for active grants.
- No grant with more than ten live seats.
- Handle/seat/principal binding and revocation agreement.

**No new edge, hosted rows, client, seed, psql variable or rolled-back fixture transaction is required.** Empty hosted tables can pass this reconciliation. That result proves consistency, not exercised hosted issuance or internal authentication.

At release-SHA runbook lines 1177–1179, section 5 skips only `20260925000001`, `20260926000001`, `20260927000001`, `20260927000002`, and `20260927000003`.

**Do not add HM2 to that skip list. No runbook line needs adding.** HM2 runs automatically in section 5. The exact invocation, with an explicit output assertion, is:

```sh
# step: hm2-functional-section5
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/72c57e0d76d0aa86fe4f811a2cf51499919fed20/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"

  release_psql_ro --file /proof/20260928000002-functional.sql \
    >"$PROOF_DIR/20260928000002-functional.txt"
  test "$(cat "$PROOF_DIR/20260928000002-functional.txt")" = t
)
```

This is the section 5 invocation, not a required second run after edge switching. Public routes must never be used to manufacture hosted proof fixtures.

## Edge verification and public refusal controls

Run section 6 without weakening its checks:

- Preserve the existing override; effective memory must be `2147483648`.
- Require network mode `commonswarm-net`, healthy container, `/health` and the exact new Compose working directory.
- Exercise all five runnable functions, plus the disabled MCP route.
- Retain H0 document, malformed command, authenticated read, activity, capability, unknown-function and preflight controls.
- Exercise a database-reaching authentication path. Follow the runbook’s explicit disposition if the box lacks an authenticated smoke credential.
- Require unauthenticated H0 note HTTP 401, never `h0_command_not_configured`.
- Run loopback checks on the box; staging checks from the Mac mini.
- Capture the full probe interval and reject `CONNECT_TIMEOUT`, `h0 command configuration missing`, boot/module failures and any attempt to load an MCP worker.

The public command guard in `supabase/functions/command/index.ts:12941` precedes command-ID validation and bearer classification. Its command set comes from `src/protocol/hosted-authority.ts`. The following probe pairs hosted refusals with normal-path controls in the same invocation.

Run on the Mac after the edge switch. It sends no credential, creates no grant and records only public responses. The loopback subprocess runs on the box as Anvil.

```sh
# step: hm2-public-boundaries
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  ROOT="$HOME/.config/cswarm/box-hm2-20260928"
  test -d "$ROOT"

  cat >"$ROOT/boundary-probe.py" <<'PY'
import json, sys, urllib.error, urllib.request, uuid

results = []
def probe(base, method, path, body, expected_status, expected_body):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        raw = response.read()
    parsed = json.loads(raw)
    assert status == expected_status, (base, path, method, status)
    if expected_body is not None:
        assert parsed == expected_body, (base, path, method, parsed)
    results.append({
        "base": base, "method": method, "path": path,
        "status": status, "body": parsed,
    })

for base in sys.argv[1:]:
    probe(base, "GET", "/functions/v1/h0/agent-doc/smoke",
          None, 200, None)
    probe(base, "POST", "/functions/v1/command",
          {}, 400, {"error": "invalid_request"})
    for kind in ("claim_hosted_seat", "activate_hosted_mcp_grant"):
        probe(base, "POST", "/functions/v1/command",
              {"command_id": str(uuid.uuid4()), "command": {"kind": kind}},
              403, {"error": "forbidden"})
    probe(base, "POST", "/functions/v1/command",
          {"command_id": str(uuid.uuid4()),
           "command": {"kind": "mint_agent_token"}},
          401, {"error": "unauthenticated"})
    for method in ("POST", "OPTIONS"):
        probe(base, method, "/functions/v1/mcp", {},
              503, {
                  "error": "feature_disabled",
                  "feature": "hosted_mcp",
                  "message": "Hosted MCP is not available yet.",
              })
print(json.dumps(results, indent=2))
PY

  ssh ops@100.115.66.74 \
    'sudo -n -i python3 - http://127.0.0.1:9000' \
    <"$ROOT/boundary-probe.py" \
    >"$EVIDENCE_DIR/hm2-loopback-boundaries.json"

  python3 "$ROOT/boundary-probe.py" \
    https://edge-staging.commonswarm.com \
    https://api.commonswarm.com \
    >"$EVIDENCE_DIR/hm2-public-boundaries.json"
)
```

Hosted HTTP 403 without any bearer, paired with the ordinary mint request’s HTTP 401 and source ordering, establishes the intended public boundary. It does not independently instrument GoTrue calls. Internal no-GoTrue and capability-revalidation coverage belongs to the exact-SHA server tests.

The successful authenticated local mint below is the positive control that `mint_agent_token` remains usable. Its unauthenticated HTTP 401 above is not that proof.

## Existing local-seat control

Use **Cold Agent Test**, `c2ea0541-f56d-4c73-bf71-56c5405c4934`.

The previous addendum’s recipient `fb9de4e3-000c-4230-a7e0-b35fec362302` and sender `29bf679e-df26-4253-90f7-91795ead0834` were revoked according to its committed ACK evidence. The original `b817513b` recipient was also superseded as revoked. Do not reuse them.

No currently usable historical recipient is established. Therefore this plan adapts the fresh-recipient addendum: **create R and S before HM2’s migration**, prove their baseline, then mint after the edge switch. R is fresh for this test but already exists when HM2 applies. This proves preservation across this release; it does not claim coverage of a long-lived historical seat.

Use the released `cswarm` 0.1.80 and Tom’s existing production human session. No new client build or npm publication is needed. Anvil must verify the executable/version and production target before use.

Reuse the last window’s protected, verified anon-key file. If unavailable, prepare it through the established site-meta fetch/hash comparison before continuing; never print its value or put it in argv.

### Create the isolated principals before migration

Run after common preparation and before section 5 apply. These are the only new principals required by this plan.

```sh
# step: hm2-local-prepare-before-migration
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20

  WINDOW_PRINCIPAL_SUFFIX="$(
    ssh ops@100.115.66.74 \
      "sudo -n -i bash -s -- $SHA" <<'BOX'
set -euo pipefail
SHA="$1"
PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
. "$PROOF_DIR/window.env"
case "$WINDOW_PRINCIPAL_SUFFIX" in
  [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *) false ;;
esac
printf '%s\n' "$WINDOW_PRINCIPAL_SUFFIX"
BOX
  )"
  case "$WINDOW_PRINCIPAL_SUFFIX" in
    [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) false ;;
  esac

  ROOT="$HOME/.config/cswarm/box-hm2-20260928"
  ANON_FILE="$HOME/.config/cswarm/box-hm4-20260928/anon-key.txt"
  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  test ! -e "$ROOT"
  test ! -L "$ANON_FILE"
  test "$(stat -f %Lp "$ANON_FILE")" = 600
  test -s "$ANON_FILE"
  mkdir -m 0700 "$ROOT"
  RUN_ROOT="$(mktemp -d "$ROOT/fresh-local.XXXXXX")"

  for SLUG in local sender; do
    D="$RUN_ROOT/$SLUG"
    mkdir -m 0700 "$D"
    cswarm principal create --workspace-id "$WS" \
      --name "hm2-${SLUG}-${WINDOW_PRINCIPAL_SUFFIX}" \
      >"$D/principal.json" 2>"$D/mint.log"
  done

  principal_id() {
    python3 - "$1" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["principal_id"]))
PY
  }
  RECIPIENT="$(principal_id "$RUN_ROOT/local/principal.json")"
  SENDER="$(principal_id "$RUN_ROOT/sender/principal.json")"
  test "$RECIPIENT" != "$SENDER"

  {
    printf 'RUN_ROOT=%q\n' "$RUN_ROOT"
    printf 'ANON_FILE=%q\n' "$ANON_FILE"
    printf 'WS=%q\n' "$WS"
    printf 'RECIPIENT=%q\n' "$RECIPIENT"
    printf 'SENDER=%q\n' "$SENDER"
    printf 'WINDOW_PRINCIPAL_SUFFIX=%q\n' "$WINDOW_PRINCIPAL_SUFFIX"
  } >"$ROOT/control.env"
  chmod 0600 "$ROOT/control.env"
  printf 'R=%s\nS=%s\n' "$RECIPIENT" "$SENDER"
)
```

Stop on duplicate-name refusal or partial failure. Do not rerun creation into an existing directory or silently substitute principals.

### Establish the pre-migration baseline

The box database session must already exist. This requires both principals active, local, non-turn-only, unmanaged and non-registrar, with active owner membership and workspace. It also requires HM2’s ledger row absent.

```sh
# step: hm2-local-seat-before
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  . "$HOME/.config/cswarm/box-hm2-20260928/control.env"

  ssh ops@100.115.66.74 \
    "sudo -n -i bash -s -- $RECIPIENT $SENDER" \
    >"$RUN_ROOT/hm-local-seat-before.txt" <<'BOX'
set -euo pipefail
. /home/commonswarm/stack/release-proofs/72c57e0d76d0aa86fe4f811a2cf51499919fed20/window.env
. "/run/commonswarm-release-${SHA}-session.sh"
cat >"$APPLY_SQL" <<'SQL'
SELECT (
  SELECT count(*) = 2
  FROM swarm.agent_principals p
  JOIN swarm.memberships m
    ON m.workspace_id = p.workspace_id
   AND m.user_id = p.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.workspaces w
    ON w.workspace_id = p.workspace_id AND w.archived_at IS NULL
  WHERE p.principal_id IN (:'recipient'::uuid, :'sender'::uuid)
    AND p.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
    AND p.revoked_at IS NULL
    AND p.managed_at IS NULL
    AND p.transport = 'local'
    AND p.turn_only = false
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_join_credentials c
      WHERE c.registrar_principal_id = p.principal_id
    )
) AND NOT EXISTS (
  SELECT 1 FROM supabase_migrations.schema_migrations
  WHERE version = '20260928000002'
);
SQL
release_psql_ro -Atq -v recipient="$1" -v sender="$2" \
  --file /run/commonswarm-release-apply.sql \
  >"$PROOF_DIR/hm-local-seat-before.txt"
test "$(cat "$PROOF_DIR/hm-local-seat-before.txt")" = t
cat "$PROOF_DIR/hm-local-seat-before.txt"
BOX
  test "$(cat "$RUN_ROOT/hm-local-seat-before.txt")" = t
)
```

Reserve R and S exclusively for this control. Do not start a listener.

### Mint after “edge switched and healthy”

This retains the previous window’s mint/connection/setup form, using the already-created principals.

`src/protocol/workspace-commands.ts:1075` refuses token minting for `hosted_mcp` or turn-only principals. It retains the normal ownership and credential rules for ordinary local seats.

```sh
# step: hm2-local-mint-after-edge
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  . "$HOME/.config/cswarm/box-hm2-20260928/control.env"

  lower() { tr 'A-Z' 'a-z'; }
  for SLUG in local sender; do
    D="$RUN_ROOT/$SLUG"
    test ! -e "$D/credential-mint.json"
    PID="$(python3 - "$D/principal.json" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["principal_id"]))
PY
)"
    cswarm token mint --workspace-id "$WS" --principal-id "$PID" \
      --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" \
      --epoch 1 --ttl-ms 21600000 --renewal-horizon-days 1 \
      >"$D/credential-mint.json" 2>>"$D/mint.log"

    python3 - "$ANON_FILE" "$D/credential-mint.json" \
      "$D/connection.json" "$WS" "$PID" 2>>"$D/mint.log" <<'PY'
import json, pathlib, sys, uuid
anon_file, credential_file, output_file, workspace_id, principal_id = sys.argv[1:]
anon_key = pathlib.Path(anon_file).read_text().strip()
credential = json.loads(pathlib.Path(credential_file).read_text())
def required_string(value, field):
    found = value.get(field)
    if not isinstance(found, str) or not found:
        raise SystemExit(f'credential is missing required non-empty string field "{field}"')
    return found
credential_principal_id = required_string(credential, "principal_id")
agent_token = required_string(credential, "agent_token")
token_id = required_string(credential, "token_id")
if not anon_key:
    raise SystemExit("anon key file is empty")
if credential_principal_id != principal_id:
    raise SystemExit("credential principal_id does not match the requested principal")
uuid.UUID(token_id)
pathlib.Path(output_file).write_text(json.dumps({
    "version": 1,
    "url": "https://api.commonswarm.com",
    "anon_key": anon_key,
    "workspace_id": workspace_id,
    "principal_id": principal_id,
    "credential": credential,
}) + "\n")
PY
    cswarm setup --connection-file "$D/connection.json" \
      --profile "$D/profile.json" --host-session-id manual --json \
      >"$D/setup.json" 2>>"$D/mint.log"
    chmod 0600 "$D"/*.json "$D/mint.log"
  done
  printf 'ordinary local token mint and setup: PASS\n'
)
```

Credentials, connection files and profiles stay on the Mac in protected storage. No credential goes into evidence, argv or the box.

### Primer, check and first observed ACK

A successful check alone is insufficient: the last addendum documents that observation failures may not change its exit status. Require the exact database ACK.

```sh
# step: hm2-local-primer-and-check
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  . "$HOME/.config/cswarm/box-hm2-20260928/control.env"

  cswarm note "HM2 local wake control: observation primer." \
    --profile "$RUN_ROOT/sender/profile.json" --to "$RECIPIENT" --json \
    >"$RUN_ROOT/primer.json" 2>>"$RUN_ROOT/sender/mint.log"
  PRIMER_ID="$(python3 - "$RUN_ROOT/primer.json" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["signal"]["id"]))
PY
)"
  cswarm check --profile "$RUN_ROOT/local/profile.json" \
    --host-session-id manual --json \
    >"$RUN_ROOT/first-check.json" 2>>"$RUN_ROOT/local/mint.log"

  ssh ops@100.115.66.74 \
    "sudo -n -i bash -s -- $RECIPIENT $PRIMER_ID" \
    >"$RUN_ROOT/hm-local-first-ack.txt" <<'BOX'
set -euo pipefail
. /home/commonswarm/stack/release-proofs/72c57e0d76d0aa86fe4f811a2cf51499919fed20/window.env
. "/run/commonswarm-release-${SHA}-session.sh"
cat >"$APPLY_SQL" <<'SQL'
SELECT json_build_object(
  'workspace_id', d.workspace_id,
  'principal_id', d.recipient_agent_principal_id,
  'signal_id', d.signal_id,
  'acked_at', d.acked_at,
  'ack_outcome', d.ack_outcome,
  'last_lease_id', d.last_lease_id,
  'last_leased_by', d.last_leased_by
)
FROM swarm.signal_deliveries d
WHERE d.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
  AND d.recipient_agent_principal_id = :'recipient'::uuid
  AND d.signal_id = :'primer'::uuid
  AND d.ack_outcome = 'observed'
  AND d.last_lease_id IS NULL
  AND d.last_leased_by IS NULL
  AND d.acked_at >= (
    SELECT applied_at FROM swarm.wake_path_release WHERE singleton
  );
SQL
release_psql_ro -Atq -v recipient="$1" -v primer="$2" \
  --file /run/commonswarm-release-apply.sql \
  >"$PROOF_DIR/hm-local-first-ack.txt"
cat "$PROOF_DIR/hm-local-first-ack.txt"
BOX

  python3 - "$RUN_ROOT/hm-local-first-ack.txt" "$RECIPIENT" "$PRIMER_ID" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["workspace_id"] == "c2ea0541-f56d-4c73-bf71-56c5405c4934"
assert r["principal_id"] == sys.argv[2] and r["signal_id"] == sys.argv[3]
assert r["acked_at"] and r["ack_outcome"] == "observed"
assert r["last_lease_id"] is None and r["last_leased_by"] is None
print("first observed ACK: PASS")
PY
)
```

An empty result or failed assertion stops the control.

### Second note and exact-delivery wake eligibility

**Do not run R’s check, receive path, watcher or any other consumer between sending this note and completing the SQL proof.**

```sh
# step: hm2-local-wake-after
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  . "$HOME/.config/cswarm/box-hm2-20260928/control.env"

  cswarm note "HM2 local wake control: leave unobserved until SQL proof." \
    --profile "$RUN_ROOT/sender/profile.json" --to "$RECIPIENT" --json \
    >"$RUN_ROOT/pending.json" 2>>"$RUN_ROOT/sender/mint.log"
  HM_SIGNAL_ID="$(python3 - "$RUN_ROOT/pending.json" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["signal"]["id"]))
PY
)"

  ssh ops@100.115.66.74 \
    "sudo -n -i bash -s -- $RECIPIENT $HM_SIGNAL_ID" \
    >"$RUN_ROOT/hm-local-wake-after.txt" <<'BOX'
set -euo pipefail
. /home/commonswarm/stack/release-proofs/72c57e0d76d0aa86fe4f811a2cf51499919fed20/window.env
. "/run/commonswarm-release-${SHA}-session.sh"
cat >"$APPLY_SQL" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM swarm.wake_path_eligible_deliveries d
  JOIN swarm.agent_principals p
    ON p.workspace_id = d.workspace_id AND p.principal_id = d.principal_id
  WHERE d.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
    AND d.principal_id = :'recipient'::uuid
    AND d.signal_id = :'hm_signal_id'::uuid
    AND p.transport = 'local'
    AND p.turn_only = false
    AND p.revoked_at IS NULL
);
SQL
release_psql_ro -Atq -v recipient="$1" -v hm_signal_id="$2" \
  --file /run/commonswarm-release-apply.sql \
  >"$PROOF_DIR/hm-local-wake-after.txt"
test "$(cat "$PROOF_DIR/hm-local-wake-after.txt")" = t
cat "$PROOF_DIR/hm-local-wake-after.txt"
BOX
  test "$(cat "$RUN_ROOT/hm-local-wake-after.txt")" = t
  printf 'recipient=%s signal=%s wake-eligible=PASS\n' "$RECIPIENT" "$HM_SIGNAL_ID"
)
```

This proves that an ordinary local principal present before HM2 can receive a newly minted token, check and acknowledge a delivery, and have a subsequent delivery remain wake-eligible after HM2. It proves eligibility, not a listener wake or model start.

### Revoke temporary seats and preserve safe evidence

Run only after recording the proof, through Tom’s human session. Both principals were created solely for this window.

```sh
# step: hm2-local-cleanup-and-evidence
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = 72c57e0d76d0aa86fe4f811a2cf51499919fed20
  . "$HOME/.config/cswarm/box-hm2-20260928/control.env"

  for SLUG in sender local; do
    D="$RUN_ROOT/$SLUG"
    PID="$(python3 - "$D/principal.json" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["principal_id"]))
PY
)"
    cswarm principal revoke --workspace-id "$WS" --principal-id "$PID" --json \
      >"$D/revoked.json" 2>>"$D/mint.log"
    python3 - "$D/revoked.json" "$PID" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["status"] == "accepted" and r["principal_id"] == sys.argv[2]
PY
  done

  python3 - "$RUN_ROOT" "$SHA" "$WINDOW_PRINCIPAL_SUFFIX" >"$EVIDENCE_DIR/hm2-local-control.json" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
ack = json.loads((root / "hm-local-first-ack.txt").read_text())
seed = json.loads((root / "pending.json").read_text())["signal"]["id"]
assert (root / "hm-local-seat-before.txt").read_text().strip() == "t"
assert (root / "hm-local-wake-after.txt").read_text().strip() == "t"
seats = {}
for slug in ("local", "sender"):
    principal = json.loads((root / slug / "principal.json").read_text())["principal_id"]
    credential = json.loads((root / slug / "credential-mint.json").read_text())
    revoked = json.loads((root / slug / "revoked.json").read_text())
    def required_string(value, field):
        found = value.get(field)
        if not isinstance(found, str) or not found:
            raise SystemExit(f'credential is missing required non-empty string field "{field}"')
        return found
    credential_principal_id = required_string(credential, "principal_id")
    agent_token = required_string(credential, "agent_token")
    if credential_principal_id != principal:
        raise SystemExit("credential principal_id does not match the created principal")
    assert revoked["status"] == "accepted" and revoked["principal_id"] == principal
    seats[slug] = {"principal_id": principal, "mint": "accepted", "revocation": "accepted"}
print(json.dumps({
    "release_sha": sys.argv[2],
    "window_principal_suffix": sys.argv[3],
    "client": "released cswarm 0.1.80",
    "seat_before": True,
    "wake_after": True,
    "first_ack": ack,
    "seed_signal_id": seed,
    "seats": seats,
}, indent=2))
PY
)
```

Retain protected scratch until HezLead accepts evidence and cleanup. Never use an unguarded recursive deletion. If the window aborts earlier, report the exact principals and credentials still requiring cleanup.

## Reserve rollback

Prefer a reviewed forward fix or compatible edge rollback while retaining the additive schema. HezLead decides; Anvil executes.

Order:

1. Restore recorded `PREVIOUS_EDGE` through section 6.
2. Require restored edge health, network, memory, probes and log checks.
3. Only then consider HM2’s schema rollback.

No site or service rollback is needed for this window because neither is deployed. Do not remove lane 4’s transport migration.

**The HM2 rollback SQL is bare inverse DDL.** It does not begin a transaction, execute its rollback catalog proof or remove the ledger row. Never run it bare.

The reserve block below refuses any hosted authority rows, hosted principals or hosted idempotency rows. If any exist, safety of schema rollback is **not established**; retain the schema and escalate rather than deleting authority history. Confirm separately that no internal hosted workflow ran during the window.

After HezLead authorizes schema rollback and the old edge is verified:

```sh
# step: hm2-reserve-schema-rollback
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/72c57e0d76d0aa86fe4f811a2cf51499919fed20/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  test -n "$PREVIOUS_EDGE"
  test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"

  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target

  cat >"$APPLY_SQL" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';

LOCK TABLE
  swarm.hosted_mcp_grants,
  swarm.hosted_mcp_grant_workspaces,
  swarm.hosted_mcp_seats,
  swarm.hosted_mcp_seat_handles
IN ACCESS EXCLUSIVE MODE;

DO $guard$
BEGIN
  IF (SELECT count(*) FROM supabase_migrations.schema_migrations
      WHERE version = '20260928000002') <> 1
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_grants)
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_grant_workspaces)
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seats)
     OR EXISTS (SELECT 1 FROM swarm.hosted_mcp_seat_handles)
     OR EXISTS (SELECT 1 FROM swarm.agent_principals WHERE transport = 'hosted_mcp')
     OR EXISTS (
       SELECT 1 FROM swarm.idempotency_keys
       WHERE principal_kind IN ('hosted_grant', 'hosted_seat')
     )
  THEN
    RAISE EXCEPTION 'HM2 rollback state is unsafe or unexpected';
  END IF;
END
$guard$;

\i /proof/20260928000002-rollback.sql
\i /proof/20260928000002-rollback-catalog.sql
\if :{?rollback_ok}
SELECT :'rollback_ok' = 't' AS rollback_is_t
\gset
\if :rollback_is_t
\else
DO $$ BEGIN RAISE EXCEPTION 'HM2 rollback catalog failed'; END $$;
\endif
\else
DO $$ BEGIN RAISE EXCEPTION 'HM2 rollback catalog result missing'; END $$;
\endif

DELETE FROM supabase_migrations.schema_migrations
WHERE version = '20260928000002';
COMMIT;
SQL
  release_psql --file /run/commonswarm-release-apply.sql

  cat >"$APPLY_SQL" <<'SQL'
\i /proof/20260928000002-rollback-catalog.sql
SELECT :'rollback_ok' = 't'
  AND NOT EXISTS (
    SELECT 1 FROM supabase_migrations.schema_migrations
    WHERE version = '20260928000002'
  );
SQL
  RESULT="$(release_psql_ro -Atq --file /run/commonswarm-release-apply.sql)"
  test "$RESULT" = t
  printf 'HM2 rollback catalog=t ledger=0\n' >>"$PROOF_DIR/box-run.log"
)
```

A failed up-migration transaction needs no down-migration: first prove its ledger and catalog state. A full restore requires Tom’s explicit approval. Never edit the ledger to conceal partial state.

## Close criteria and facts not established

HezLead closes only after reconciling:

- Exact approved SHA and archive identity.
- One applied HM2 ledger row, catalog `t`, functional `t`.
- Empty cron added/removed sets.
- New edge identity, health, memory, network and complete probe/log results.
- Public hosted commands refused before bearer authentication.
- MCP POST and OPTIONS still disabled, with no MCP worker load.
- Existing-across-window local seat: accepted mint, successful check with verified observed ACK, and exact second delivery eligible.
- Accepted revocation of both temporary principals.
- Timer restoration, transient database/smoke-file cleanup and approved evidence copy-back.
- No npm publication, site release, OAuth service deployment or stack runtime switch.

Before execution, the following remain **not established**: current live paths, backup freshness/completeness, database identity and ledger/catalog state, exact-SHA gate and review acceptance, HezLead’s approvals and UTC window, Tom’s usable session, verified client executable, newly assigned principal/signal IDs, production proof outcomes, rollback execution and window closure.

A passing empty-table functional reconciliation does not establish working hosted issuance. Hosted public issuance remains **disabled** in this release.
