# HM lanes 3 and 7 — DARK box window

**Release SHA:** `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d`
**Expected previous edge:** `72c57e0d76d0aa86fe4f811a2cf51499919fed20`
**Status:** PLAN. The three source blockers recorded in v1 are resolved. Window approval, current production prerequisites, exact-SHA gate results, and execution are **not established**.

Anvil runs every operation, including controls on the Mac mini. HezLead approves the release identity, backup age, stage transitions, rollback and closure. CSwarmDevLead coordinates, supplies reviewed inputs and reconciles evidence.

This document was prepared through read-only repository inspection. No release, migration, production probe, principal creation or test execution was performed.

## 1. Governing procedure and scope

Follow [`deploy/RELEASE-TO-BOX.md`](../../../deploy/RELEASE-TO-BOX.md), particularly its Window plan rules, sections 1–3, 5, 6 and 9, backup-service wait, manifest-only copy-back and abort cleanup. Incorporated runbook steps remain mandatory. Host operations also follow the workspace’s `hetzner-handoff/HETZNER-OPERATIONS.md`.

The release follows:

- [HM2 window](../2026-09-28-box-hm2/BOX-WINDOW.md) and [HM2 run-4 evidence](../2026-09-28-release-72c57e0d76d0-rerun-4/).
- [HM6 window](../2026-09-28-box-hm6/BOX-WINDOW.md), which must finish first.
- [HM lane plan](../../design/2026-09-27-HM-LANE-PLAN.md), §§4.4, 4.8 and 7.

This window releases:

| Surface | Change |
|---|---|
| Schema | Apply only `20260928000004_hm_hosted_check.sql`. |
| Hosted check | Durable `swarm.hosted_mcp_check_cursors` and `swarm.hosted_mcp_check_batches`; internal open/ACK commands through `supabase/functions/command/index.ts`. |
| Edge | Move the complete edge release from `72c57e0d76d0aa86fe4f811a2cf51499919fed20` to the release SHA. |
| Hosted MCP | Install `supabase/functions/mcp/` and its router changes, DARK. |

**Do not set `SWARM_MCP_PUBLIC_ENABLED=1`. Preserve disabled public OAuth authorization.**

Migration 03, the OAuth service, OAuth signing material, Caddy, DNS, GoTrue configuration, the site, installed CLI and npm publication are outside this window. Their presence in the archive does not authorize their deployment.

Every shell block below has a step identifier and execution location. Mac blocks run under macOS `/bin/bash` 3.2. Do not paste them into zsh. Never assign `HOME`, run Docker on the Mac mini, enable shell tracing, or print complete environments or credentials. No recursive deletion is required.

## 2. Measured release identity and inventory

The inspected checkout is clean and its `HEAD` is the full release SHA. The merge subject is:

> Merge lane/hm7-dark-gate: the edge router keeps /mcp dark before any worker starts (item HM, lane 7)

Current remote ancestry and independent acceptance of this exact SHA are **not established** by that local measurement. Section 1 of the release procedure must verify the GitHub origin, fetch `main`, prove ancestry, create the exact-SHA archive and reconcile its checksum on both machines.

### Exact edge diff

The requested comparison contains exactly **13 paths**:

| Changed path | This window’s treatment |
|---|---|
| `deploy/edge-runtime/env.example` | Inventory input; never replace the live environment with this example. |
| `deploy/edge-runtime/main/index.ts` | Release. |
| `deploy/edge-runtime/main/router.ts` | Release. |
| `supabase/functions/_shared/hosted-seat-auth.ts` | Release. |
| `supabase/functions/_shared/protocol.js` | Release the generated artifact unchanged. |
| `supabase/functions/command/index.ts` | Release. |
| `supabase/functions/mcp/auth.ts` | Release. |
| `supabase/functions/mcp/deno.json` | Release. |
| `supabase/functions/mcp/index.ts` | Release. |
| `supabase/functions/mcp/protocol.ts` | Release. |
| `supabase/functions/mcp/tools.ts` | Release. |
| `supabase/migrations/20260928000003_hm_oauth_store.sql` | Archive only; HM6 must already have applied it. |
| `supabase/migrations/20260928000004_hm_hosted_check.sql` | Apply through section 5. |

Directly changed function entry points are **`command` and `mcp`**. The router and shared dependencies also change. Set `ROUTER_CHANGED=yes`; section 1’s environment inventory therefore selects **`command read capability activity h0 mcp`**.

The release unit is the entire edge archive, not two copied function directories.

```sh
# step: hm37-source-identity
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
(
  set -euo pipefail
  SHA=e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d
  BASE=72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test "$(git rev-parse HEAD)" = "$SHA"
  test -z "$(git status --porcelain)"
  test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
  git merge-base --is-ancestor "$BASE" "$SHA"
  git cat-file -e "${SHA}:docs/evidence/2026-09-28-box-hm6/BOX-WINDOW.md"
  git diff --name-only "$BASE" "$SHA" -- supabase/ deploy/edge-runtime/
  test "$(git diff --name-only "$BASE" "$SHA" -- supabase/ deploy/edge-runtime/ | wc -l | tr -d ' ')" = 13
  git diff "$BASE" "$SHA" -- deploy/edge-runtime/env.example
  git diff --exit-code "$BASE" "$SHA" -- src/cloud/agent-check.ts src/mcp/
)
```

### Environment changes

Comparing `deploy/edge-runtime/env.example` between the two edge SHAs adds one assignment name:

| Name | Requirement |
|---|---|
| `SWARM_MCP_PUBLIC_ENABLED` | Optional. Only the exact string `1` enables MCP. Leave it absent or disabled. |

**New required edge environment names: none.** Set `ADDITIONAL_REQUIRED_ENV_NAMES=''`.

The router still requires nonempty `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, one of `SWARM_DATABASE_URL` or `SUPABASE_DB_URL`, and `SWARM_SELF_SERVE=1`.

Generate the required/optional inventory from the archived router. Do not reconstruct its allowlists manually. `MCP_ENV_NAMES` excludes the service-role key and OAuth-service credential material.

Optional MCP configuration is validated when its worker loads. In particular, `exactContract()` in `supabase/functions/mcp/index.ts` defaults absent issuer/resource/JWKS settings, not explicitly empty strings. Do not populate optional names with blank example assignments.

### Stack comparison

HM6’s plan names release `9fa4217da9f6447e55fb8c6d577b8fd3997f926b` and makes its OAuth-inclusive backup helpers live. Comparing that SHA with this release produces **no differences** in:

- `deploy/supabase-stack/compose.yaml`
- `deploy/supabase-stack/postgres/`
- `deploy/supabase-stack/backup/`

This supports a migration-only stack archive with no stack switch. It does not establish the actual live stack.

Anvil must run section 1’s directory comparison against recorded `PREVIOUS_STACK`. Any missing path, comparison error or runtime difference is a STOP for HezLead. Do not silently include a stack/helper rollout.

## 3. Read-only prerequisites — STOP on failure

Run read-only checks before release mutations. Preparing protected connection files and evidence does not authorize a database write, service change or control principal.

HM2 run 4 records:

| Historical evidence | Recorded result |
|---|---|
| `migration-state-after.txt` | Migration 02: `ledger=1 catalog=t`. |
| `close-readback.txt` | Edge `72c57e0d…`, healthy, memory `2147483648`, network `commonswarm-net`; recycle, backup and restore timers active. |
| `hm2-local-control.json` | Released cswarm `0.1.80`; local-seat control, observed delivery ACK and subsequent wake eligibility. |
| `revocation-readback.txt` | Principals revoked; zero active unexpired tokens. |

These are historical results, not current-state proof.

Before opening, Anvil must establish all of the following:

1. **Previous edge:** resolved symlink, `RELEASE_SHA`, actual Compose working directory and mounted source agree with `72c57e0d76d0aa86fe4f811a2cf51499919fed20`.
2. **HM2 live:** migration `20260928000002` has exactly one ledger row; its exact-tree catalog and functional proofs pass.
3. **HM6 closed:** HezLead supplies its closure evidence, including migration, service, ingress, backup and recovery disposition.
4. **HM6 schema:** migration `20260928000003` has exactly one ledger row; its catalog and functional proofs pass.
5. **OAuth service:** healthy; its actual release, image identity and loopback port match HM6’s closure.
6. **Public discovery:** `https://mcp.commonswarm.com/.well-known/oauth-authorization-server`, `/.well-known/openid-configuration` and `/jwks` return valid JSON without redirects or challenges.
7. **Discovery identity:** issuer is `https://mcp.commonswarm.com`; authorization, token and JWKS endpoints match HM6’s plan.
8. **JWKS:** nonempty public EC/P-256 verification keys, ES256 and nonempty `kid`; no private key members. Compare the active signing `kid` with HM6’s recorded public identity.
9. **Authorization remains off:** GET `/authorize` and POST `/token` return 503 with `error=authorization_service_disabled`; effective `MCP_OAUTH_PUBLIC_AUTHORIZATION_ENABLED` is not exactly `1`.
10. **MCP remains off:** effective edge `SWARM_MCP_PUBLIC_ENABLED` is not exactly `1`.
11. **Migration 04 absent:** ledger count zero and forward catalog false without error.
12. **No unexplained changes:** stack comparison, timers and concurrent operator state have an approved disposition.

Use HM6’s public probe contract, including its Python-style non-browser User-Agent, and equivalent OAuth loopback checks. Inspect effective configuration privately and emit only assertions. Do not copy complete container inspection or environment values into evidence.

The HM6 plan’s existence is established; HM6’s execution and live state are **not established** by this tree. Failure or missing evidence stops HM37. This window does not repair or finish HM6.

## 4. Opening inputs, gates and handoffs

Use these section 1 inputs:

| Input | Value |
|---|---|
| `SHA` | `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d` |
| `KIND_LIST` | `edge stack` |
| `MIGRATION_VERSIONS` | `20260928000004` only |
| `FUNCTIONAL_VERSIONS` | `20260928000004` |
| `H0_LEDGER_BACKFILL` | `no` |
| `GUARDED_STACK_SWITCH` | `no`, contingent on the live comparison |
| `BACKUP_STATUS_PROOF` | `no`; section 5’s backup gate still applies |
| `CHANGED_FUNCTIONS` | `command mcp`; router inventory expands to all six |
| `ROUTER_CHANGED` | `yes` |
| `ADDITIONAL_REQUIRED_ENV_NAMES` | Empty |
| Expected cron additions/removals | Both empty |

HezLead must approve the start/end times and positive integer `BACKUP_MAX_AGE_SECONDS`. Their actual values are **not established**. Persist them in root-only window state.

Require exact-SHA gate evidence for:

- Command-core regeneration and a clean generated-bundle diff.
- `npm run check:edge`, which includes the MCP entry point at this SHA.
- Hosted authority, hosted check, authentication-boundary, MCP authentication/protocol, router and release-proof tests.
- Database integration coverage in `tests/p1-server/hosted-authority.test.ts`, `hosted-check.test.ts` and `hosted-mcp.test.ts`.
- Applicable local check, stdio MCP and release-bundle compatibility gates.

A checked-in test is not a passing result. Observe the repository’s gate-wrapper and host-placement rules; no Docker or server suite runs on the Mac mini.

| Order | Anvil executes | HezLead handoff |
|---:|---|---|
| 1 | Read-only prerequisites | Accept current HM2/HM6 state and previous release paths. |
| 2 | Remote ancestry, archive, exact-SHA gates | Approve identity and backup age. |
| 3 | Immutable archives, manifest, window state, inventory | Accept scope and stack comparison. |
| 4 | Sections 2–3 database identity/session | Accept the production target. |
| 5 | Backup gate; migration 04 and proofs | Approve edge transition only after schema verification. |
| 6 | Section 6 edge recreate and controls | Accept health, routing and darkness. |
| 7 | Hosted and ordinary local controls; revocation | Accept behavior and zero-token cleanup. |
| 8 | Timers, transient-file cleanup, evidence copy-back | Explicitly close or record abort state. |

### Names and credential handling

Section 1 computes `WINDOW_PRINCIPAL_SUFFIX` **on the box**, once from approved `WINDOW_START_UTC`, and records it in `window.env` and `window-principal-suffix.txt`.

Every principal minted by this window must derive its name from that value:

- Hosted recipient: `hm37-hosted-${WINDOW_PRINCIPAL_SUFFIX}`
- Local recipient: `hm37-local-${WINDOW_PRINCIPAL_SUFFIX}`
- Ordinary sender: `hm37-sender-${WINDOW_PRINCIPAL_SUFFIX}`

A rerun uses a new approved start and unused names. A collision is a STOP, not permission to reuse a revoked principal.

Transfer the suffix outside command substitution:

```sh
# step: hm37-read-window-suffix
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d
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

Use protected files and process memory for secrets. No credential value belongs in argv, URLs, output or evidence. Read cswarm 0.1.80 credentials using `agent_token`, `principal_id`, `token_id` and `run_id`; fail closed on every missing, empty or non-string field. Never substitute `token`.

## 5. Backup gate

Run the section 5 existing-service wait **before reading backup status**. An active, activating, deactivating or reloading service is not complete. Maximum wait is 14,400 seconds, with bounded five-second polling.

```sh
# step: hm37-backup-gate
# Runs on the box over ssh, as Anvil in a root Bash shell.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d/window.env
  : "${BACKUP_MAX_AGE_SECONDS:?HezLead-approved backup age required}"
  case "$BACKUP_MAX_AGE_SECONDS" in
    ''|*[!0-9]*) false ;;
  esac
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
  python3 - /var/backups/commonswarm-postgres/status.json \
    "$BACKUP_MAX_AGE_SECONDS" >"$PROOF_DIR/hm37-backup-gate.txt" <<'PY'
import datetime, json, sys
data = json.load(open(sys.argv[1]))
assert data.get("state") != "running"
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

Failure stops the window. HezLead may explicitly authorize starting the existing backup service. Then follow section 5’s start-and-wait procedure, require service `Result=success`, and repeat the freshness gate. Do not kill a running backup or infer completion from the start command returning.

## 6. Migration 04 through section 5

Stage these exact-tree files from `deploy/release-proofs/item-hm/`:

| File | SHA-256 |
|---|---|
| `20260928000004-catalog.sql` | `1e9c147981babe5667282ac1fbddfc64199fd126888c12070af173fd77834fb1` |
| `20260928000004-functional.sql` | `26e3e6b0280eaa1f4c6b72a6c85d15bd8849940a7af47e42a181e452295d0659` |
| `20260928000004-rollback.sql` | `69053ccac11d4c5ae13cef447950130fdf2b7bef2c490f62d61c8e043bdf1c29` |
| `20260928000004-rollback-catalog.sql` | `f8cf2a14ae112a927674150ad5c7d50144c9ff3d37a168cbb94ece8a71102aed` |

Also stage the exact-tree catalog and functional proofs for migrations 02 and 03 for prerequisite and closing checks.

### Before apply

Run section 5’s complete file enumeration, checksums, ledger enumeration and reconciliation. The only permitted pending version is **`20260928000004`**. Any other pending migration, duplicate version or unexplained ledger entry is a STOP.

Require exactly:

- Ledger count: `0`
- Catalog result: `f`
- SQL process exit: `0`

Missing output, NULL, an exception, or a false value produced by suppressing an error does not pass.

The supplied catalog uses `to_regclass` and `to_regprocedure` so absent migration objects produce false without error. It checks ownership, RLS, policies, columns, constraints, active-batch uniqueness, function properties, search paths, privileges and triggers.

For function identity and return-contract checks, use catalog OIDs, `pg_proc` columns and dependencies. Do not match schema-qualified names in deparsed function source. The visibility function’s explicit output types/names, set-returning behavior and lack of dependency on the `swarm_read.signals` row type are structurally checked.

The supplied proof does contain expression checks for constraints and indexes; it is not wholly free of deparsed expressions. Do not replace its structural function checks with `pg_get_functiondef`/`prosrc` matching.

Every required privilege is checked individually. A comma-separated privilege argument must not replace separate positive or negative assertions.

### Apply and verify

Use section 5’s wrapper, one migration only:

1. Reassert database identity.
2. Begin a transaction.
3. Set five-second lock and five-minute statement timeouts.
4. Verify the ledger accepts a version-only row.
5. Include the uniquely enumerated migration file.
6. Insert its ledger row.
7. Include its catalog proof and require `catalog_ok=t`.
8. Commit only after all checks pass.

The runbook’s migration selection runs on the box. For this plan, select the single matching filename with a Bash array populated by a `while IFS= read -r` loop instead of `mapfile`.

After commit, require `ledger=1 catalog=t`. Migration 04 is not on the runbook’s deferred-functional list: run its functional proof **during section 5**.

```sh
# step: hm37-functional-section5
# Runs on the box over ssh, as Anvil in a root Bash shell.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro --file /proof/20260928000004-functional.sql \
    >"$PROOF_DIR/20260928000004-functional.txt"
  test "$(cat "$PROOF_DIR/20260928000004-functional.txt")" = t
)
```

The functional proof executes the visibility function and checks batch uniqueness, seat/cursor bindings, recipient visibility, terminal cursors and acknowledged cursor history. It can pass with no hosted rows; it does not replace the exercised control in section 9.

Reconcile cron before/after: **zero additions and zero removals**.

HezLead accepts these results before authorizing the edge switch.

## 7. Edge release and worker boundary

### Resolved v1 findings

At this SHA:

- `DISABLED_FUNCTION_NAMES` contains `mcp`.
- `isMcpPublicEnabled()` accepts only the exact string `1`.
- `resolveGatewayRequest()` checks the disabled function before OPTIONS handling.
- `handleGatewayRequest()` returns that response before calling its worker callback.
- `main/index.ts` places worker creation and fetch inside that callback.
- The worker protocol independently checks darkness before metadata and method handling.

These facts are measured in `deploy/edge-runtime/main/router.ts`, `main/index.ts` and `supabase/functions/mcp/protocol.ts`.

`tests/p1-cli/edge-runtime-box.test.ts` includes the instrumented test **“MCP dark gate refuses every method before worker creation and routes when enabled”**. It covers both endpoint suffixes, seven methods, zero disabled worker calls and enabled positive controls. Require a passing exact-SHA result. Enabling a Boolean in an isolated test is not permission to enable the production flag.

HTTP 503 alone, or absence of a worker log line alone, does not prove the worker boundary.

### Section 6 preflight and switch

Run section 6’s timer-overlap calculation. Stop the recycle timer only when the approved window overlaps its protected interval; persist the stopped marker first.

Then:

1. Verify the archive-derived edge manifest.
2. Copy the recorded previous edge’s box-only `compose.override.yaml`.
3. Generate and verify the manifest including that override.
4. Validate required environment names and reject test hooks.
5. Privately inspect effective Compose configuration; assert MCP remains disabled.
6. Validate Compose with `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
7. Confirm `PREVIOUS_EDGE`, its release identity and actual live container agree.
8. Switch and recreate from the exact new directory.

```sh
# step: hm37-edge-switch
# Runs on the box over ssh, as Anvil in a root Bash shell.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d/window.env
  test "$PREVIOUS_EDGE" = /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  test "$(readlink -f /home/commonswarm/edge/current)" = "$PREVIOUS_EDGE"
  test "$(cat "$NEW_EDGE/RELEASE_SHA")" = "$SHA"
  ln -sfn "$NEW_EDGE" /home/commonswarm/edge/current
  cd "$NEW_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge up -d edge-runtime
)
```

Require, within section 6’s 180-second bound:

- Docker health `healthy` and loopback `/health` success.
- Memory `2147483648`.
- Network mode `commonswarm-net`.
- Compose working directory `$NEW_EDGE/deploy/edge-runtime`.
- Active release and mounted source matching this SHA.
- Effective MCP flag still disabled.

Retain the ordinary command, authenticated read, capability, activity, H0, unknown-function and preflight controls. Unauthenticated H0 note must return 401.

If an authenticated read credential is unavailable, record that limitation and obtain HezLead’s runbook disposition. Use the runbook’s syntactically valid, known-nonexistent agent-token lookup if selected to establish database connectivity; do not confuse an early syntax rejection with a database-reaching probe.

Capture the full probe interval’s logs privately after loopback and public probes finish. Reject database connection, configuration, boot or module-loading errors. Raw logs stay on the box.

## 8. Post-release DARK and public-command controls

### Endpoint matrix

Run these three gateway probes against each base:

| Location | Base |
|---|---|
| Box loopback, executed over ssh | `http://127.0.0.1:9000` |
| Mac mini, staging route | `https://edge-staging.commonswarm.com` |
| Mac mini, production API | `https://api.commonswarm.com` |

| Method | Path | Required result |
|---|---|---|
| POST | `/functions/v1/mcp` | 503, exact disabled JSON |
| OPTIONS | `/functions/v1/mcp` | 503, exact disabled JSON |
| GET | `/functions/v1/mcp/.well-known/oauth-protected-resource/mcp` | 503, exact disabled JSON |

Exact JSON:

`{"error":"feature_disabled","feature":"hosted_mcp","message":"Hosted MCP is not available yet."}`

Bare `/mcp` is the public MCP-hostname route, not the direct edge gateway route. Separately recheck POST and OPTIONS `https://mcp.commonswarm.com/mcp`, and GET `https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp`, using HM6’s positive discovery/JWKS controls in the same invocation.

Staging reaches production services and the production database. Run its probes from the Mac mini, as the release procedure requires.

### Public command boundary

Generate the command list from `PUBLIC_HOSTED_ONLY_COMMANDS` in the exact release’s `src/protocol/hosted-authority.ts`. At this SHA it contains six kinds, including open and ACK.

Send each without Authorization and require 403 `{"error":"forbidden"}`. Pair this with an ordinary malformed request returning 400 and an ordinary mint request reaching the missing-bearer refusal with 401.

The ordering is established in `handlePostRequest()` in `supabase/functions/command/index.ts`: hosted-only refusal precedes command-ID validation, bearer classification and GoTrue. Exact-SHA boundary tests supplement the HTTP observations.

The following probe generates its list from source and exercises loopback, staging and API. It does not mint credentials or mutate authority.

```sh
# step: hm37-public-boundaries
# Runs on the Mac mini as Anvil, under /bin/bash 3.2.
# Its ssh subprocess runs the loopback probe on the box as Anvil.
(
  set -euo pipefail
  umask 077
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d
  test "$(git rev-parse HEAD)" = "$SHA"
  git diff --exit-code "$SHA" -- src/protocol/hosted-authority.ts
  PROBE="$(mktemp /tmp/hm37-boundaries.XXXXXX)"
  trap 'rm -f -- "$PROBE"' EXIT

  python3 - src/protocol/hosted-authority.ts >"$PROBE" <<'PY'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1]).read_text()
matches = re.findall(
    r"const PUBLIC_HOSTED_ONLY_COMMANDS = new Set\(\[([\s\S]*?)\]\);",
    source)
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
disabled = {
    "error": "feature_disabled",
    "feature": "hosted_mcp",
    "message": "Hosted MCP is not available yet.",
}

def probe(base, method, path, body, expected_status, expected_body):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(
        base + path, data=data, method=method,
        headers={"Content-Type": "application/json"})
    try:
        response = opener.open(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        status = response.code
        content_type = response.headers.get("Content-Type", "")
        raw = response.read(131073)
    assert status == expected_status, (base, method, path, status)
    assert len(raw) <= 131072
    assert "application/json" in content_type
    parsed = json.loads(raw)
    if expected_body is not None:
        assert parsed == expected_body, (base, method, path, "body mismatch")
    results.append({
        "base": base, "method": method, "path": path,
        "status": status, "pass": True,
    })

for base in sys.argv[1:]:
    probe(base, "GET", "/functions/v1/h0/agent-doc/smoke", None, 200, None)
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
    for method in ("POST", "OPTIONS"):
        probe(base, method, "/functions/v1/mcp", {}, 503, disabled)
    probe(base, "GET",
          "/functions/v1/mcp/.well-known/oauth-protected-resource/mcp",
          None, 503, disabled)

print(json.dumps({"hosted_command_count": len(KINDS), "results": results}, indent=2))
PY
  ssh ops@100.115.66.74 \
    'sudo -n -i python3 - http://127.0.0.1:9000' \
    <"$PROBE" >"$EVIDENCE_DIR/hm37-loopback-boundaries.json"

  python3 "$PROBE" \
    https://edge-staging.commonswarm.com \
    https://api.commonswarm.com \
    >"$EVIDENCE_DIR/hm37-public-boundaries.json"
)
```

Transport errors, HTML challenges, redirects and generic 503 responses fail. Do not change the User-Agent merely to turn a failed client path green.

During the hosted control below, repeat well-shaped unauthenticated open and ACK requests using its temporary seat/batch identifiers. Compare that seat’s cursor and batch rows before and after: neither request may open a batch, acknowledge one or advance the cursor.

## 9. Hosted open/ACK control

**A reviewed, production-window executable harness is not established in this tree. This remains an opening gate.** The lead must supply the exact control artifact, checksum, invocation and cleanup procedure for HezLead’s review before any migration or edge mutation.

`tests/p1-server/hosted-check.test.ts` establishes the relevant call shapes, but its fixture setup directly inserts authority rows, creates two hosted seats and supplies a stubbed provider-status callback. Do not run that setup against the box or staging, or present its existing fixture as this window’s live control.

The required control is a locally invoked, trusted control using the exact release’s entry points. It creates **one** temporary hosted seat. It must not add an HTTP bypass, enable public authorization or enable public MCP.

### Setup and trust boundary

The reviewed control must:

1. Read `WINDOW_PRINCIPAL_SUFFIX` from this window’s state and use the required fresh hosted name.
2. Use the approved control workspace and a freshly verified owner identity. HM2 used **Cold Agent Test**, `c2ea0541-f56d-4c73-bf71-56c5405c4934`; current access and available capacity must be rechecked.
3. Create grant/consent/activation through `handleHostedManagementCommand`, using the verified human identity. Do not fabricate `identityVerified`.
4. Establish a temporary provider grant through the reviewed OAuth-service storage path without opening public issuance.
5. Check durable provider status using `commonswarm_oauth.provider_family_active`, as `supabase/functions/mcp/index.ts` does. No always-active callback.
6. Construct the genuine grant capability through `authenticateHostedGrantCapability`; claim the single seat through `handleHostedCommand`.
7. Construct check capabilities through `authenticateHostedSeatCapability` with tool `check`; invoke `handleHostedCommand` for open and ACK.
8. Keep provider-status access on a separate connection/pool from capability resolution, matching the production code’s protection against nested-pool deadlock.
9. Persist a private cleanup journal before each creation so partial setup can be revoked after failure or a lost shell.

All CommonSwarm authority writes go through command entry points. SQL outside those entry points is read-only verification. Never mint a local agent token for the hosted principal.

### Required observations

| Step | Action | Required proof |
|---:|---|---|
| 1 | Post directed signal A through the normal command path. | Signal exists for the temporary hosted principal. |
| 2 | Send two concurrent opens, with distinct command IDs. | Both return 200, the same non-null batch A and identical ordered IDs; exactly one active persisted batch. |
| 3 | Read the durable cursor. | Opening did not advance the committed cursor. Do not mistake the response’s terminal cursor for the committed cursor. |
| 4 | Open again from a fresh local invocation. | Same persisted batch and ordered IDs. |
| 5 | Post directed signal B after A opened. | B exists beyond A’s terminal ordering pair. |
| 6 | Send unauthenticated public open and ACK requests. | Both 403; cursor/batch snapshot unchanged. |
| 7 | ACK A using its **upper-case UUID spelling**. | 200; A acknowledged; committed cursor equals A’s millisecond timestamp/UUID terminal pair. |
| 8 | Inspect the ACK result and open again. | Batch B exists and is active. ACK may itself open the next batch; do not require a separate open to create it. |
| 9 | Repeat ACK A with a fresh command ID. | 200; A’s acknowledgment timestamp and committed cursor unchanged; B remains active. |
| 10 | ACK B, then open again. | Cursor advances to B; empty result has `batch_id=null`; no empty batch persisted. |
| 11 | Run migration 04’s functional proof again. | Exact `t`, exit zero. |

Record safe IDs, counts, ordering pairs, timestamps and assertions only. Do not record tokens, seat handles, credentials or signal bodies.

### Cleanup is part of the control

In a finally path, including partial failure:

1. Revoke the temporary hosted seat through the management command path; verify seat, handle and principal revocation.
2. Revoke its CommonSwarm grant.
3. Revoke the temporary OAuth provider grant/family through its reviewed storage path.
4. Revoke every ordinary sender/local principal created by the window.
5. Verify all recorded principals are revoked and **zero active unexpired agent tokens** remain for them.
6. Verify the temporary provider family is inactive and no active temporary provider token family remains.
7. Retry hosted authorization/open/ACK using the retained private binding; require refusal.

Do not delete durable signals, events, cursor or batch history. The control’s cleanup revokes access; it does not erase history.

Missing cleanup proof prevents closure. A missing reviewed control artifact prevents opening; it is not permission to substitute a SQL fixture or weaken the provider check.

## 10. Local `check.json` and stdio MCP compatibility

The baseline-to-release diff is empty for `src/cloud/agent-check.ts` and `src/mcp/`. Local check still stores `check.json`; stdio MCP still commits through its deferred response-write path in `src/mcp/server.ts`.

That source comparison does not establish live compatibility.

Repeat HM2 run 4’s ordinary local-recipient/sender pattern with released cswarm `0.1.80`, Tom’s verified production human session and fresh suffix-based names. Use isolated mode-0700 directories and mode-0600 connection/profile files. Verify the installed executable/version and production target before minting.

Adapt HM2’s steps rather than pasting them unchanged:

- Use this SHA and the HM37 names.
- Transfer the suffix separately, as above.
- Extract JSON IDs with a helper function containing the heredoc, then call that function in command substitution. Never nest a heredoc directly inside `$(...)`.
- The baseline now requires migrations 02 and 03 present and migration 04 absent.
- Require all four real credential fields in both connection creation and cleanup readers.
- Persist the requested run ID and verify the returned `run_id` matches it.

The required credential validation is:

```sh
# step: hm37-validate-local-credential
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
def required_string(field):
    value = credential.get(field)
    if not isinstance(value, str) or not value:
        raise SystemExit(
            f'credential is missing required non-empty string field "{field}"')
    return value
values = {field: required_string(field) for field in
          ("agent_token", "principal_id", "token_id", "run_id")}
for field in ("principal_id", "token_id", "run_id"):
    uuid.UUID(values[field])
assert uuid.UUID(values["principal_id"]) == uuid.UUID(principal)
assert uuid.UUID(values["run_id"]) == uuid.UUID(run)
print("credential_shape=PASS")
PY
)
```

Required live control:

1. Create the ordinary recipient and sender before migration; verify active local, non-turn-only principals and owner membership.
2. After the edge is healthy, mint and validate their credentials, then create isolated profiles.
3. Send a directed primer and run recipient `cswarm check`.
4. Verify the **exact delivery’s** `ack_outcome=observed` and non-null `acked_at`, as HM2 did. CLI exit zero alone is insufficient.
5. Send a second signal. Before any recipient consumer runs, prove that exact delivery is wake-eligible.
6. Use the installed CLI’s stdio MCP with that isolated profile. Initialize, call local `check`, verify the directed signal is returned, then verify local `check.json` advancement and its exact observed delivery.
7. Require exact-SHA test evidence for failed/cancelled response writes leaving deferred cursor state uncommitted. Relevant tests are in `tests/p1-cli/mcp-stdio.test.ts`, including successful-write-only commit and post-write observation.
8. Revoke both ordinary principals and verify zero active unexpired tokens.

Do not start a listener. Do not use an existing agent’s profile. Retain only sanitized assertions in `hm37-local-control.json`; keep credential-bearing scratch private until cleanup is accepted.

## 11. Rollback — edge first, then SQL

HezLead decides; Anvil executes. Prefer restoring the compatible previous edge while retaining the additive schema.

1. Restore recorded `PREVIOUS_EDGE`.
2. Recreate from that exact directory with the preserved override and `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
3. Verify health, memory, network, mounted source, ordinary controls and MCP darkness.
4. Only then consider migration 04’s SQL inverse.

Do not roll back HM2 or HM6.

The SQL reserve below refuses any cursor or batch history. After a successful hosted control, that refusal is expected. Retain the additive schema unless a separate reviewed data-loss decision and verified recovery plan authorize removal. Never delete rows just to pass this guard.

The inverse SQL between the guard and rollback catalog is verbatim from the reviewed rollback file.

```sh
# step: hm37-reserve-schema-rollback
# Runs on the box over ssh, as Anvil in a root Bash shell.
# RESERVED: requires HezLead's decision and a verified previous-edge rollback.
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d/window.env
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
  release_psql --file /run/commonswarm-release-apply.sql
)
```

Afterward, prove migration 04’s ledger count zero, rollback catalog true and forward catalog false without error. Recheck HM2/HM6 catalogs and functional proofs and reconcile cron.

A failed migration transaction is not an instruction to run destructive rollback: first measure what remains. Never improvise a database restore, delete a release or prune Docker.

## 12. Evidence, cleanup and closure

Create section 1’s explicit copy-back manifest before applying anything. Its standard entries cover archives, environment inventory, migration reconciliation, catalog/functional proofs, cron and edge artifacts.

Add these exact item paths, without duplicating generated entries:

- `20260928000002-catalog.sql`
- `20260928000002-functional.sql`
- `20260928000003-catalog.sql`
- `20260928000003-functional.sql`
- `20260928000004-rollback.sql`
- `20260928000004-rollback-catalog.sql`
- `hm37-prerequisites.json`
- `hm37-stack-runtime-review.txt`
- `hm37-backup-gate.txt`
- `hm37-worker-boundary.txt`
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

`hm37-hosted-control-inputs.txt` records the reviewed harness identity/checksum, invocation, runtime and review acceptance—not its protected inputs. `hm37-worker-boundary.txt` records the exact-SHA instrumented test result and its positive control.

These are required outputs, not claims that files or passing results already exist. Transfer reviewed Mac-side results to the box proof directory before manifest-only copy-back.

Use the runbook’s copy-back procedure into `docs/evidence/<UTC-date>-release-e1faa08eb2b0/`. Preserve distinct Mac `archive.sha256` and box `box-archive.sha256`. Mac tar operations use `COPYFILE_DISABLE=1` and `--no-xattrs`.

Never copy:

- `window.env` or private cleanup journals.
- Credentials, profiles, connection files or complete environments.
- Database session helpers, password files or dumps.
- Raw logs or `database/logs/`.

Follow the runbook’s empty/nonempty `.err` handling, with secret review before transfer. Missing manifests or required artifacts stop successful copy-back; do not reconstruct a manifest by scanning the directory or fabricate PASS files.

On success, refusal, failure or abort:

1. Revoke every created temporary principal and provider grant/family; obtain readback.
2. Run section 1’s abort cleanup whenever durable window state exists. Restore only timers this window stopped.
3. Remove section 9’s transient database files and protected smoke files once no longer needed.
4. Preserve immutable releases and private diagnostics.
5. Copy approved evidence.
6. Remove the Mac window-state file only when HezLead closes the window.

Successful closure must explicitly record:

- Migration 04 applied and catalog/functional proofs passed.
- Edge at `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d`.
- HM2 and HM6 prerequisites still valid.
- Public MCP and OAuth authorization disabled.
- Loopback, staging, API and MCP-hostname boundary controls passed.
- Worker-boundary evidence accepted.
- Hosted concurrent open, upper-case ACK, repeated ACK and cursor controls passed.
- Local check and stdio MCP compatibility passed.
- Temporary principals revoked and zero active tokens verified.
- Timers restored, transient files removed and evidence copied.

Public activation and real Claude-client interoperability remain outside this window.

## Changes from v1

1. Updated the release identity from `2c228ee1…` to `e1faa08eb2b0dbfa6f6f1b0f9385b7659c36198d`.
2. Re-measured the HM6 plan’s presence. It exists at this SHA and names its own earlier OAuth-only release. Removed the missing-file stop; retained the requirement for actual HM6 closure and live verification.
3. Re-measured the lane 7 fix from `5e0d580e`, merged by this SHA. The main router now refuses every method before preflight or worker invocation unless the flag is exactly `1`. Removed the two obsolete dark-gate stops.
4. Added the exact-tree instrumented worker-boundary test and its enabled positive controls. Retained HTTP probes as separate deployed-route evidence.
5. Confirmed the same 13-path diff, only one added optional edge environment name, no new required names, and unchanged migration-proof checksums.
6. Compared stack runtime paths with HM6’s planned release: no differences. Retained the mandatory actual-directory comparison.
7. Expanded public refusal checks to the complete source-derived hosted-only command set, including open and ACK.
8. Preserved section 5’s false-without-error catalog gate, structural function checks, individual privilege checks, functional-proof timing and complete backup wait.
9. Corrected the hosted-control expectations: ACK can open the next batch; the response cursor is not proof of committed-cursor advancement.
10. Retained the unresolved production-control harness gate. The existing server test remains unsuitable as a production fixture; no executable harness or review acceptance is invented.
11. Required all four real cswarm credential fields and removed heredoc-inside-command-substitution patterns from the supplied blocks.
12. Preserved rollback order—edge first, SQL second—and the verbatim inverse, empty-history guard, revocation requirements and manifest-only evidence handling.