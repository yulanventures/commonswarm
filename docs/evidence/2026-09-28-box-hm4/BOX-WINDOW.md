# HM lane 4: box window plan

This is the documentation-only plan for HezLead and Anvil. It records no deployment. Anvil runs every Mac mini and box command. HezLead approves the release SHA, backup age, transitions and rollback, and closes the window. CSwarmDevLead coordinates and supplies reviewed inputs.

The governing procedure is `deploy/RELEASE-TO-BOX.md` at the release SHA. Follow its current preparation, database-session, copy-back and cleanup blocks, including the fixes incorporated after the earlier windows.

## Release identity and measured shape

**Release SHA:** `9b085c82352390cf8f0fe515c02b3ccff423476a`.

At plan time, `HEAD`, `origin/main` and `git merge-base HEAD origin/main` all resolve to that commit. The working tree is clean. The release input is this base commit, not the later commit containing this document.

The SHA contains:

```text
supabase/migrations/20260928000001_hm_agent_transport.sql
deploy/release-proofs/item-hm/20260928000001-catalog.sql
deploy/release-proofs/item-hm/20260928000001-functional.sql
deploy/release-proofs/item-hm/20260928000001-rollback.sql
deploy/release-proofs/item-hm/20260928000001-rollback-catalog.sql
```

The measurement:

```sh
git diff --name-only 38343e74 9b085c82352390cf8f0fe515c02b3ccff423476a -- supabase/
```

returns exactly seven paths:

```text
supabase/functions/_shared/agent-auth.ts
supabase/functions/_shared/protocol.js
supabase/functions/activity/index.ts
supabase/functions/command/index.ts
supabase/functions/h0/poll-ack.ts
supabase/functions/read/index.ts
supabase/migrations/20260928000001_hm_agent_transport.sql
```

Therefore use:

```sh
SHA=9b085c82352390cf8f0fe515c02b3ccff423476a
KIND_LIST='edge stack'
CHANGED_FUNCTIONS='activity command h0 read'
ROUTER_CHANGED=no
ADDITIONAL_REQUIRED_ENV_NAMES=''
EXPECTED_NEW_CRON_JOBS=''
EXPECTED_REMOVED_CRON_JOBS=''
```

`stack` is required because section 5 reads migrations and database helpers from `NEW_STACK`. It does not itself authorize switching `stack/current`.

The same baseline comparison establishes:

- No changes under `deploy/edge-runtime/`, including its router.
- Two shared-function changes: `agent-auth.ts` and generated `protocol.js`.
- No changes under `deploy/supabase-stack/`, including `env.example`, Compose, PostgreSQL configuration and backup files.
- No new strict environment requirement in the changed functions. Anvil must still generate the exact-SHA environment-name inventory and verify it against the box without printing values.
- The migration contains no cron creation, scheduling or removal. Both expected cron change sets are empty.

A stack runtime switch is not expected. Anvil must perform the runbook’s box-side comparison; an unexpected difference is a stop for HezLead.

### Other code carried by this SHA

The edge release also carries HM lane 1, commit `3dfd8cac`: `supabase/functions/read/index.ts` exports `handleRequest` and calls `Deno.serve` only under `import.meta.main`. Include a real authenticated read in the edge verification.

The SHA also contains lane S’s OAuth compatibility spike under `services/mcp-auth/`, introduced by `05392fd1`. **This window does not deploy that service.** Its `SPIKE.md` explicitly does not establish production sign-in, consent, storage, deployment or key management. This window creates no hosted seat and enables no hosted connector.

### Gate evidence

The following Actions evidence was supplied with this assignment:

| Suite | Run | Supplied result |
|---|---|---|
| Server | `36334775386` | 303/305; known failures item L test 200 and H0 test 206; HM tests 221, 232 and 233 pass. |
| Site | `36334777378` | 573/589; 15 known failures; HM roster tests 289 and 290 pass. |

These are supplied results, not independently retrieved Actions logs. Neither suite is wholly green. The disposition of the additional site test implied by `589 − 573 − 15 = 1` is **not established**.

Before opening the window, attach the exact-SHA results and accepted failure analysis to `gate-evidence.txt`. Do not label either entire suite PASS. The runbook separately requires:

```text
SHA=9b085c82352390cf8f0fe515c02b3ccff423476a
npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS
npm run check:edge: PASS
```

Those exact-SHA gate results, the reviewed PR reference and HezLead’s acceptance of the suite exceptions are **not established** by this document.

## Order and handoffs

| # | Stage | Executor and approval | Required result |
|---:|---|---|---|
| 0 | Preflight | Anvil runs; HezLead approves | Run section 1 for the exact SHA. Verify main ancestry, review and gate evidence, archive identity/checksum, approved UTC window and backup maximum age. Prepare immutable edge and stack directories, the environment inventory, all four HM proof files and the copy-back manifest. Compare stack runtime files. Verify the existing Cold Agent Test recipient described below. |
| 1 | Section 5 | Anvil runs; HezLead approves proceeding | Use sections 2 and 3 as required. Verify database identity and a fresh complete backup. Enumerate migration files and ledger rows. Expected new pending version: `20260928000001`. Apply it transactionally, then require ledger count `1`, catalog `t` and functional output `t`. Compare cron sets; both changes must be empty. |
| 2 | Section 6: edge | Anvil runs; HezLead approves switching | Release `activity command h0 read` together. Preserve the box Compose override, verify environment names, recreate on `commonswarm-net`, require health and run all section 6 controls. |
| 3 | Edge handoff | Anvil reports; HezLead approves live controls | Report **“edge switched and healthy”** only after health, changed-function probes, positive controls and log checks pass. |
| 4 | Seeds and post-edge proof | Anvil runs as Tom under his standing order | The HM functional proof needs no seeds and has already run in section 5. For the separate local-wake control, mint the sender and refresh the existing recipient’s credential as described below; send and observe a primer, then leave a second directed note unobserved. Require an eligible local delivery row for that exact note. |
| 5 | Close box window | Anvil runs; HezLead closes | Reconcile ledger, catalog, functional proof, local-wake control, health and cron results. Restore any timers stopped by this window, clean transient database files, copy back only approved evidence and remove the Mac window file. |
| 6 | Site release | Anvil runs; HezLead approves and closes | After the box gate passes, release the site from the same SHA. Verify the Cold Agent Test roster and agent details show `Local`. Record site verification separately from box closure. |

On every stop, refusal or abort, Anvil runs section 1’s abort cleanup. A successful CLI response does not override a failed SQL assertion, health check or log check.

## Pre-approved copy-back inputs

Use the manifest-generation block in current section 1, with these inputs:

```sh
KIND_LIST='edge stack'
H0_LEDGER_BACKFILL=no
GUARDED_STACK_SWITCH=no
BACKUP_STATUS_PROOF=no
MIGRATION_VERSIONS=(20260928000001)
FUNCTIONAL_VERSIONS=(20260928000001)
ITEM_COPY_BACK_FILES=(
  '20260928000001-rollback.sql'
  '20260928000001-rollback-catalog.sql'
  'hm-local-seat-before.txt'
  'hm-local-wake-after.txt'
)
```

`BACKUP_STATUS_PROOF=no` means this window does not include section 8’s backup-unit change/proof. Section 5’s complete-backup requirement still applies.

The generator adds the standard archive, gate, edge, stack, migration, cron, catalog and functional artifacts. Do not replace it with the older window’s hand-written manifest.

The manifest must exist before production changes. Do not reconstruct or broaden it at close. Follow the current runbook’s handling of non-empty `.err` files. Logs, `window.env`, session helpers, credentials and `database/logs/` stay out of ordinary copy-back.

Mac-side client-control output and later site evidence remain in their protected evidence directories. Curate non-secret results before committing them.

## Migration, catalog proof and reserve rollback

| Migration | Catalog proof | Functional proof | Reserve rollback |
|---|---|---|---|
| `supabase/migrations/20260928000001_hm_agent_transport.sql` | `deploy/release-proofs/item-hm/20260928000001-catalog.sql` | `deploy/release-proofs/item-hm/20260928000001-functional.sql` | `deploy/release-proofs/item-hm/20260928000001-rollback.sql`, with `20260928000001-rollback-catalog.sql` from the same directory |

Stage all four proof files before section 5.

The migration adds:

- `transport text NOT NULL DEFAULT 'local'`.
- `turn_only boolean NOT NULL DEFAULT false`.
- Constraints accepting `local` and `hosted_mcp`, and requiring hosted seats to be turn-only.
- The restricted `swarm.agent_principal_transport(uuid)` helper.
- Transport fields appended to the member-scoped, registrar-filtered roster view.
- `p.turn_only = false` in the existing private wake-eligibility view.

Existing principals receive the local defaults. The migration preserves the wake view’s lease, acknowledgement, expiry, recipient, revocation, release-cutoff and signal-order predicates.

The catalog proof checks the new columns/defaults and constraints, table security, helper ownership and privileges, roster projection/security boundary, and private wake-view shape and predicates. Its `catalog_ok` value is consumed by section 5’s wrapper.

### Functional-proof timing: run in section 5

The proof header says:

> Read-only section-5 proof. Select one live local principal from the target; this lane intentionally creates no hosted seat.

The SQL selects an active local, non-turn-only principal whose owner remains a member of an active workspace, excluding registrar principals. It establishes that principal’s human claims, then checks the stored fields, roster fields, transport helper and absence of turn-only principals from wake eligibility.

It needs **no new edge, no seeded signal, no new client and no supplied psql variables**.

Section 5’s skip list at release-SHA lines 1176–1178 names:

```text
20260925000001
20260926000001
20260927000001
20260927000002
20260927000003
```

It correctly does not name `20260928000001`. **No skip-list line should be added for HM lane 4.** Do not defer this functional proof until section 6.

The section 5 invocation is:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"

  release_psql_ro \
    --file /proof/20260928000001-functional.sql \
    >"$PROOF_DIR/20260928000001-functional.txt"

  test "$(cat "$PROOF_DIR/20260928000001-functional.txt")" = t
)
```

This is the section 5 proof, not an additional mandatory rerun. No eligible principal, a false result or any SQL error stops the window.

The proof’s “no turn-only eligible row” assertion does **not** prove that an actual local delivery remains eligible. The separate seeded control below provides that positive result.

### Rollback order

Prefer a compatible code rollback while retaining the additive schema. Reserve SQL rollback requires HezLead’s decision.

1. Restore `PREVIOUS_EDGE` using section 6’s rollback. Wait for health and repeat its probes and log checks.
2. If the new site has already been released, restore the previous site before removing its queried columns.
3. Only after dependent edge and site code is restored, run the migration rollback:

   ```sh
   (
     set -euo pipefail
     . /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
     . "/run/commonswarm-release-${SHA}-session.sh"

     release_psql --file /proof/20260928000001-rollback.sql
   )
   ```

The rollback restores the complete prior roster and wake-view definitions, removes the helper and columns, and removes the migration ledger row. It includes the rollback catalog proof and commits only when `rollback_ok` is true.

Do not remove transport protection while hosted seats exist. This window creates none; Anvil must establish actual state before any destructive rollback. Compatibility after later hosted-seat issuance is **not established** by this window.

## Edge verification

Run current section 6 without weakening its controls:

- Preserve the existing Compose override and verify the effective 2 GiB memory limit.
- Use `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`.
- Require container health within the runbook deadline, `/health`, the expected network and the exact release working directory.
- Probe `activity`, `command`, `h0` and `read`.
- Include the existing H0 document, malformed command, authenticated read, unauthenticated activity, capability, unknown-function and preflight controls.
- Run loopback probes on the box and staging probes from the Mac mini. Staging is production-backed.
- Exercise a database-reaching path; an early authentication-format rejection is insufficient.
- Require the unauthenticated H0 note probe to return 401, not `h0_command_not_configured`.
- Capture the complete probe log interval and reject the errors named by the runbook.

HM lane 1’s exported handler makes the authenticated read control particularly relevant. HM’s shared credential lookup also affects activity and H0, even though their entry-point files are not both changed.

Do not manufacture a production hosted principal with SQL to test a refusal. Lane 4 exposes no hosted-seat creation command. The hosted negative controls belong to the supplied server tests.

## Seed-client requirements

The HM functional proof needs no client.

Released `0.1.80` is sufficient for ordinary local note and observation traffic used by the wake control; that traffic needs no HM-specific request fields. It does not establish the new transport projection in client output.

For reproducibility, the control below uses a clean build of the exact release SHA. This also supplies HM’s roster parsing. The new human workspace-directory code in `src/cloud/workspaces.ts` explicitly requests `transport,turn_only`; do not use this checkout against the pre-HM schema.

Anvil prepares the checkout before the window, without sending product commands until the edge handoff:

```sh
(
  set -euo pipefail
  umask 077
  SHA=9b085c82352390cf8f0fe515c02b3ccff423476a
  SOURCE_REPO="$PWD"
  CLIENT_ROOT="$(mktemp -d /tmp/commonswarm-hm4-client.XXXXXX)"
  CLIENT_CHECKOUT="$CLIENT_ROOT/checkout"

  git clone --quiet --no-local "$SOURCE_REPO" "$CLIENT_CHECKOUT"
  git -C "$CLIENT_CHECKOUT" checkout --quiet --detach "$SHA"
  test "$(git -C "$CLIENT_CHECKOUT" rev-parse HEAD)" = "$SHA"
  test -z "$(git -C "$CLIENT_CHECKOUT" status --porcelain)"
  (cd "$CLIENT_CHECKOUT" && npm ci && npm run build)
  test -f "$CLIENT_CHECKOUT/dist/cli.js"

  printf 'CLIENT_CHECKOUT=%q\n' "$CLIENT_CHECKOUT" >"$CLIENT_ROOT/client.env"
  chmod 0600 "$CLIENT_ROOT/client.env"
  printf '%s\n' "$CLIENT_ROOT/client.env"
)
```

Retain the printed file path in protected release notes. The package version remains `0.1.80`; the commit identity distinguishes this build from the already released package.

## Existing local-seat control

Use Cold Agent Test workspace:

```text
c2ea0541-f56d-4c73-bf71-56c5405c4934
```

The previous window’s `docs/evidence/2026-09-27-release-38343e74cbd5/seats.md` records this existing recipient:

```text
g3d-turn: b817513b-b554-472a-8d65-73a85411f012
```

Its current validity is **not established**. Before applying HM, Anvil must prove it remains an active, unmanaged, non-registrar principal in the active workspace with an active owner membership. HezLead must confirm it is idle and reserved for this control.

Run after section 3 has established the database helper, before section 5 applies HM:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"

  release_psql_ro -Atq --command "
    SELECT EXISTS (
      SELECT 1
      FROM swarm.agent_principals p
      JOIN swarm.memberships m
        ON m.workspace_id = p.workspace_id
       AND m.user_id = p.owner_user_id
       AND m.revoked_at IS NULL
      JOIN swarm.workspaces w
        ON w.workspace_id = p.workspace_id
       AND w.archived_at IS NULL
      WHERE p.principal_id = 'b817513b-b554-472a-8d65-73a85411f012'::uuid
        AND p.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
        AND p.revoked_at IS NULL
        AND p.managed_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM swarm.agent_join_credentials c
          WHERE c.registrar_principal_id = p.principal_id
        )
    );
  " >"$PROOF_DIR/hm-local-seat-before.txt"

  test "$(cat "$PROOF_DIR/hm-local-seat-before.txt")" = t
)
```

If that fails, stop and name another verified, pre-existing Cold Agent Test seat in the reviewed control. Do not silently substitute a newly created recipient and call it an existing-seat regression check.

### Mint block after “edge switched and healthy”

No mint is needed for the section 5 functional proof. This block is solely for the separate wake control.

Anvil runs as Tom under his standing order. It creates one new sender and mints a fresh credential for the existing recipient, following the previous window’s protected mint/setup form. It does not recreate the recipient.

Beforehand, Anvil prepares mode-`0700` directory:

```text
$HOME/.config/cswarm/box-hm4-20260928
```

Place the deployment’s verified public anon key in `anon-key.txt`, mode `0600`, using the previous window’s fetch-and-hash comparison. Never print its value or put it in argv.

```sh
(
  set -euo pipefail
  umask 077
  . <protected-client.env-path>

  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  ROOT="$HOME/.config/cswarm/box-hm4-20260928"
  ANON_FILE="$ROOT/anon-key.txt"
  test "$(stat -f %Lp "$ROOT")" = 700
  test "$(stat -f %Lp "$ANON_FILE")" = 600
  test -s "$ANON_FILE"

  lower() { tr 'A-Z' 'a-z'; }

  mint_seat() {
    NAME="$1"
    SLUG="$2"
    PID="$3"
    D="$ROOT/$SLUG"
    test ! -e "$D"
    mkdir -m 0700 "$D"
    install -m 0600 /dev/null "$D/mint.log"

    if [ -z "$PID" ]; then
      (
        cd "$CLIENT_CHECKOUT"
        node dist/cli.js principal create --workspace-id "$WS" --name "$NAME"
      ) >"$D/principal.json" 2>>"$D/mint.log"
      PID="$(python3 -c \
        'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
        "$D/principal.json" 2>>"$D/mint.log")"
    else
      python3 - "$PID" >"$D/principal.json" <<'PY'
import json, sys, uuid
print(json.dumps({"principal_id": str(uuid.UUID(sys.argv[1]))}))
PY
    fi

    (
      cd "$CLIENT_CHECKOUT"
      node dist/cli.js token mint --workspace-id "$WS" --principal-id "$PID" \
        --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" \
        --epoch 1 --ttl-ms 21600000 --renewal-horizon-days 1
    ) >"$D/credential-mint.json" 2>>"$D/mint.log"

    python3 - "$ANON_FILE" "$D/credential-mint.json" \
      "$D/connection.json" "$WS" "$PID" 2>>"$D/mint.log" <<'PY'
import json, pathlib, sys
anon_file, credential_file, output_file, workspace_id, principal_id = sys.argv[1:]
anon_key = pathlib.Path(anon_file).read_text().strip()
credential = json.loads(pathlib.Path(credential_file).read_text())
assert anon_key and credential["principal_id"] == principal_id
connection = {
    "version": 1,
    "url": "https://api.commonswarm.com",
    "anon_key": anon_key,
    "workspace_id": workspace_id,
    "principal_id": principal_id,
    "credential": credential,
}
pathlib.Path(output_file).write_text(json.dumps(connection) + "\n")
PY

    (
      cd "$CLIENT_CHECKOUT"
      node dist/cli.js setup --connection-file "$D/connection.json" \
        --profile "$D/profile.json" --host-session-id manual --json
    ) >"$D/setup.json" 2>>"$D/mint.log"

    chmod 0600 "$D"/*.json "$D/mint.log"
  }

  mint_seat box-hm4-sender-0928 sender ''
  mint_seat '' local b817513b-b554-472a-8d65-73a85411f012
  echo OK
)
```

Success is one final `OK`. On failure, stop and inspect protected output. Do not reuse partially populated directories or bypass duplicate-name refusal. Credentials and connection files never go to the box.

### Seed a positive wake-eligibility probe

Anvil sends one primer note, explicitly awaits its unclaimed observed acknowledgement, then sends a second note and leaves it unobserved.

This follows `DeliveryCommandClient.observeUnclaimedAgentDelivery` in `src/cloud/delivery.ts` and the local-seat control in `tests/p1-server/managed-delivery.test.ts`. No listener is started.

```sh
(
  set -euo pipefail
  umask 077
  . <protected-client.env-path>
  ROOT="$HOME/.config/cswarm/box-hm4-20260928"
  RECIPIENT=b817513b-b554-472a-8d65-73a85411f012
  cd "$CLIENT_CHECKOUT"

  node dist/cli.js note "HM4 local wake control: observation primer." \
    --profile "$ROOT/sender/profile.json" --to "$RECIPIENT" --json \
    >"$ROOT/primer.json"

  PRIMER_ID="$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$ROOT/primer.json")"

  node --input-type=module - "$ROOT/local/profile.json" "$PRIMER_ID" \
    >"$ROOT/primer-observed.json" <<'JS'
import { randomUUID } from "node:crypto";
import {
  profileTarget,
  readAgentProfile,
  readProfileCredential,
} from "./dist/cloud/agent-profile.js";
import { DeliveryCommandClient } from "./dist/cloud/delivery.js";

const profile = await readAgentProfile(process.argv[2]);
const credential = await readProfileCredential(profile);
const result = await new DeliveryCommandClient(profileTarget(profile))
  .observeUnclaimedAgentDelivery({
    workspaceId: profile.workspace_id,
    credential: credential.token,
    commandId: randomUUID(),
    signalId: process.argv[3],
  });
if (result.httpStatus < 200 || result.httpStatus >= 300) {
  throw new Error("unclaimed observation did not return 2xx");
}
process.stdout.write(JSON.stringify(result) + "\n");
JS

  node dist/cli.js note "HM4 local wake control: leave unobserved until SQL proof." \
    --profile "$ROOT/sender/profile.json" --to "$RECIPIENT" --json \
    >"$ROOT/pending.json"

  HM_SIGNAL_ID="$(python3 -c \
    'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$ROOT/pending.json")"
  printf 'HM_SIGNAL_ID=%s\n' "$HM_SIGNAL_ID"
)
```

Do not run `check`, receive, a watcher or any other consumer on the recipient before the following SQL proof. The primer acknowledgement is awaited; a successful advisory presence call is not used as delivery evidence.

Anvil transfers only the printed signal UUID, then runs on the box:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  HM_SIGNAL_ID='<UUID printed by the seed block>'

  cat >"$APPLY_SQL" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM swarm.wake_path_eligible_deliveries d
  JOIN swarm.agent_principals p
    ON p.workspace_id = d.workspace_id
   AND p.principal_id = d.principal_id
  WHERE d.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
    AND d.principal_id = 'b817513b-b554-472a-8d65-73a85411f012'::uuid
    AND d.signal_id = :'hm_signal_id'::uuid
    AND p.transport = 'local'
    AND p.turn_only = false
    AND p.revoked_at IS NULL
);
SQL

  release_psql_ro -Atq -v hm_signal_id="$HM_SIGNAL_ID" \
    --file /run/commonswarm-release-apply.sql \
    >"$PROOF_DIR/hm-local-wake-after.txt"

  test "$(cat "$PROOF_DIR/hm-local-wake-after.txt")" = t
)
```

A `t` proves that the pre-existing local principal has an actual eligible delivery after HM’s migration and edge release. It proves eligibility, not that a listener woke or a model started.

After recording the result, Anvil may consume the test note. HezLead directs cleanup of the new sender and temporary credentials. Do not revoke the pre-existing recipient merely to clean up this control.

## After the box window: site from the same SHA

Release the site from:

```text
9b085c82352390cf8f0fe515c02b3ccff423476a
```

The requested comparison with live site baseline `736bac7a` is:

```sh
git log --format='%h %s' 736bac7a..9b085c82352390cf8f0fe515c02b3ccff423476a -- site/
```

It lists exactly one site commit:

```text
163da7d4 feat(hm): hosted transport foundation — agent transport and turn_only (item HM, lane 4)
```

The changed site paths are:

```text
site/src/components/app/LiveDashboard.astro
site/src/components/app/entity-panel.observer.test.ts
site/src/components/app/slack-shape.observer.test.ts
site/src/components/app/transport-roster.observer.test.ts
site/src/lib/entity-panel.ts
site/src/lib/participant-rail.ts
```

The site requests the new roster columns, normalizes transport state, labels agents `Local` or `Hosted MCP`, and adds `Transport` to agent details. This release does not add hosted-seat issuance.

Anvil follows the site section of `deploy/RELEASE-TO-BOX.md`, `deploy/site/RUNBOOK.md` and `deploy/site/deploy.sh`. Preserve the prior build settings, including `PUBLIC_H0_LINK_JOIN=1`. Use the verified host fingerprint and the `commonswarm` deployment user.

From the checkout pinned to the release SHA:

```sh
(
  set -euo pipefail
  test "$(git rev-parse HEAD)" = 9b085c82352390cf8f0fe515c02b3ccff423476a
  deploy/site/deploy.sh commonswarm@yulan-vps-1
)
```

Run the site procedure’s validation and public-route checks. As Tom, open Cold Agent Test in `/app` and verify the existing recipient:

- Appears in the roster with the label **Local**.
- Shows **Transport: Local** in agent details.
- Has source roster values `transport = 'local'` and `turn_only = false`.

Retain curated evidence identifying the site SHA, workspace, principal and result. The UI check complements the box wake proof; it does not replace it.

### npm ordering

No npm publication is needed for lane 4 alone. The release SHA still declares version `0.1.80`.

The rule remains: **no npm from a SHA containing lane 4’s client changes before lane 4’s server is live**. Completing this migration and edge window satisfies that prerequisite for a later separately reviewed client release.

Do not republish `0.1.80`, invent a new version, or update `current_client_build` merely because the box or site was released. The runbook’s published-client-build step applies when an actual npm publication occurs.

## Not established before execution

- Exact-SHA command-core and edge-check results, reviewed PR reference, and acceptance of the supplied suite exceptions.
- The unexplained remaining site-test disposition.
- HezLead’s approvals, UTC window and maximum backup age.
- Current live edge/site identities beyond the supplied baselines; Anvil must remeasure them.
- Backup completeness and age, database identity, ledger state, cron state and resolved previous-release paths.
- Current validity and availability of the existing Cold Agent Test recipient, Tom’s human session and minting credentials.
- Client checkout path, sender principal, signal UUIDs and any production proof result.
- A completed migration, edge switch, site release, roster check or closed window.

The prior window’s PASS results do not establish these new results. HezLead closes this window only against its own recorded evidence.
## ADDENDUM — Local-wake control with a fresh recipient (replaces the b817513b steps)

HM lane 4 is live at `9b085c82352390cf8f0fe515c02b3ccff423476a`. This replaces the revoked `b817513b` recipient, its credential refresh, and the original seat-before/seed/wake-after sequence. It proves **post-release eligibility for a fresh local recipient**, not preservation of a pre-existing seat across the migration.

The other Cold Agent Test seats have no observed ACK and no credential available for this control. Do not mint credentials for them. The original migration requires a prior unclaimed `observed` ACK after the release cutoff; lane 4 preserves that requirement and adds `turn_only = false`. The ACK timestamp is `swarm.signal_deliveries.acked_at`, with outcome in `ack_outcome`; the delivery recipient column is `recipient_agent_principal_id`, projected as `principal_id` by the eligibility view. Sources: `supabase/migrations/20260925000001_unclaimed_observed_ack.sql:75–98`; `supabase/migrations/20260928000001_hm_agent_transport.sql:69–92`.

### Execution prerequisites

Anvil runs the Mac commands as Tom under his standing order, using the **released `cswarm` 0.1.80** and Tom’s existing production human session. None of these steps needs lane 4’s client: ordinary note/check traffic suffices, and SQL checks the transport columns. Source: `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:236–268`.

Reuse the plan’s protected directory and verified `anon-key.txt`: directory mode `0700`, file mode `0600`. If the key file is missing, prepare it using the established site-meta fetch and SHA-256 comparison with the CLI’s configured key; never print or pass its value in argv. Sources: `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:328–347`; `docs/evidence/2026-09-25-item-g-lane2b/BOX-WINDOW.md:64–65`.

The box’s existing database session must still be available. Source `window.env` before its session helper, as required by `deploy/RELEASE-TO-BOX.md:685–693`. SSH uses the established Mac-to-box path (`deploy/RELEASE-TO-BOX.md:544`).

**Constraint discrepancy:** the repository’s `release_psql_ro` implementation invokes Docker internally (`deploy/RELEASE-TO-BOX.md:744–761`). The commands below use that required helper and contain no direct Docker command. If “no docker” also forbids the helper’s implementation, these requirements conflict; resolve that before execution.

Run the following Mac blocks in order in the same Bash session. Stop on any failure; preserve protected artifacts for inspection and cleanup.

### 1. Create and mint R and S

This follows the plan’s create/mint/connection/setup form, with both seats newly created and isolated beneath a fresh scratch directory. R is `hm4-local-recv-0927`; S is `hm4-local-send-0927`. Sources: `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:351–415`; `src/cli.ts:2544–2575`, `src/cli.ts:2703–2748`.

```bash
bash
set -euo pipefail
umask 077

WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
ROOT="$HOME/.config/cswarm/box-hm4-20260928"
ANON_FILE="$ROOT/anon-key.txt"

test ! -L "$ROOT"
test ! -L "$ANON_FILE"
test "$(stat -f %Lp "$ROOT")" = 700
test "$(stat -f %Lp "$ANON_FILE")" = 600
test -s "$ANON_FILE"

RUN_ROOT="$(mktemp -d "$ROOT/fresh-local.XXXXXX")"
chmod 0700 "$RUN_ROOT"
printf 'Protected scratch directory: %s\n' "$RUN_ROOT"

lower() { tr 'A-Z' 'a-z'; }
principal_id() {
  python3 - "$1" <<'PY'
import json, sys, uuid
print(uuid.UUID(json.load(open(sys.argv[1]))["principal_id"]))
PY
}

mint_seat() {
  local NAME="$1" SLUG="$2" D PID
  D="$RUN_ROOT/$SLUG"
  test ! -e "$D"
  mkdir -m 0700 "$D"
  install -m 0600 /dev/null "$D/mint.log"

  cswarm principal create --workspace-id "$WS" --name "$NAME" \
    >"$D/principal.json" 2>>"$D/mint.log"
  PID="$(principal_id "$D/principal.json" 2>>"$D/mint.log")"

  cswarm token mint --workspace-id "$WS" --principal-id "$PID" \
    --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" \
    --epoch 1 --ttl-ms 21600000 --renewal-horizon-days 1 \
    >"$D/credential-mint.json" 2>>"$D/mint.log"

  python3 - "$ANON_FILE" "$D/credential-mint.json" \
    "$D/connection.json" "$WS" "$PID" 2>>"$D/mint.log" <<'PY'
import json, pathlib, sys
anon_file, credential_file, output_file, workspace_id, principal_id = sys.argv[1:]
anon_key = pathlib.Path(anon_file).read_text().strip()
credential = json.loads(pathlib.Path(credential_file).read_text())
assert anon_key and credential["principal_id"] == principal_id
connection = {
    "version": 1,
    "url": "https://api.commonswarm.com",
    "anon_key": anon_key,
    "workspace_id": workspace_id,
    "principal_id": principal_id,
    "credential": credential,
}
pathlib.Path(output_file).write_text(json.dumps(connection) + "\n")
PY

  cswarm setup --connection-file "$D/connection.json" \
    --profile "$D/profile.json" --host-session-id manual --json \
    >"$D/setup.json" 2>>"$D/mint.log"

  chmod 0600 "$D"/*.json "$D/mint.log"
}

mint_seat hm4-local-recv-0927 local
mint_seat hm4-local-send-0927 sender

RECIPIENT="$(principal_id "$RUN_ROOT/local/principal.json")"
SENDER="$(principal_id "$RUN_ROOT/sender/principal.json")"
test "$RECIPIENT" != "$SENDER"
printf 'R=%s\nS=%s\n' "$RECIPIENT" "$SENDER"
```

Do not bypass duplicate-name refusal or rerun minting into partially populated directories. All credential-bearing output remains in protected files.

### 2. Send the primer, run R’s check once, and prove its first ACK

The note command and signal-ID extraction follow `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:432–438`. Check accepts an explicit profile (`src/cli.ts:10121–10130`) and sends an unclaimed observation after presenting mail (`src/cloud/agent-check.ts:310–361`).

**Check output or exit status alone is insufficient:** ACK failures can leave both unchanged (`src/cloud/agent-check.ts:425–426`). Require the database record below before proceeding.

```bash
cswarm note "HM4 fresh local wake control: observation primer." \
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
umask 077
. /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
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
  --file /run/commonswarm-release-apply.sql
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
```

An empty result, missing timestamp, or failed assertion stops the control. The query uses the exact unclaimed-observation columns and release boundary required by the live view (`supabase/migrations/20260928000001_hm_agent_transport.sql:87–92`).

### 3. Run seat-before for R; require `t`

This retains the plan’s active-principal, active-membership, active-workspace, unmanaged and non-registrar gate, parameterized with R’s ID. Here “before” means **before the second note**, after the first ACK; it is not a pre-migration measurement. All gate columns come from `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:294–316`.

```bash
ssh ops@100.115.66.74 \
  "sudo -n -i bash -s -- $RECIPIENT" \
  >"$RUN_ROOT/hm-local-seat-before.txt" <<'BOX'
set -euo pipefail
. /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
. "/run/commonswarm-release-${SHA}-session.sh"

cat >"$APPLY_SQL" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM swarm.agent_principals p
  JOIN swarm.memberships m
    ON m.workspace_id = p.workspace_id
   AND m.user_id = p.owner_user_id
   AND m.revoked_at IS NULL
  JOIN swarm.workspaces w
    ON w.workspace_id = p.workspace_id
   AND w.archived_at IS NULL
  WHERE p.principal_id = :'recipient'::uuid
    AND p.workspace_id = 'c2ea0541-f56d-4c73-bf71-56c5405c4934'::uuid
    AND p.revoked_at IS NULL
    AND p.managed_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM swarm.agent_join_credentials c
      WHERE c.registrar_principal_id = p.principal_id
    )
);
SQL

release_psql_ro -Atq -v recipient="$1" \
  --file /run/commonswarm-release-apply.sql \
  >"$PROOF_DIR/hm-local-seat-before.txt"
test "$(cat "$PROOF_DIR/hm-local-seat-before.txt")" = t
cat "$PROOF_DIR/hm-local-seat-before.txt"
BOX

test "$(cat "$RUN_ROOT/hm-local-seat-before.txt")" = t
```

### 4. Seed the second note and run wake-after; require `t`

**Do not run R’s `check` between this seed and the completed wake-after query. Do not start a listener, watcher, receive path or other consumer.** ACKing the second note removes it from eligibility because the view requires `d.acked_at IS NULL` (`supabase/migrations/20260928000001_hm_agent_transport.sql:76`).

The seed and proof retain the plan’s exact-note check, replacing the fixed recipient with R. Sources: `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:465–507`. The `transport` and `turn_only` defaults are defined at `supabase/migrations/20260928000001_hm_agent_transport.sql:4–10`.

```bash
cswarm note "HM4 local wake control: leave unobserved until SQL proof." \
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
. /home/commonswarm/stack/release-proofs/9b085c82352390cf8f0fe515c02b3ccff423476a/window.env
. "/run/commonswarm-release-${SHA}-session.sh"

cat >"$APPLY_SQL" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM swarm.wake_path_eligible_deliveries d
  JOIN swarm.agent_principals p
    ON p.workspace_id = d.workspace_id
   AND p.principal_id = d.principal_id
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
```

A `t` proves that this exact delivery is eligible for R after its first observed ACK. It does not prove that a listener woke or a model started.

### 5. Revoke both fresh principals, preserve evidence, and remove scratch

Revoke S and R using IDs reread from their own `principal.json`, through Tom’s human session. Do not pass an agent profile to principal administration. The CLI requires an accepted revocation and returns the principal ID (`src/cli.ts:2578–2607`).

```bash
for SLUG in sender local; do
  PID="$(principal_id "$RUN_ROOT/$SLUG/principal.json")"
  cswarm principal revoke --workspace-id "$WS" --principal-id "$PID" --json \
    >"$RUN_ROOT/$SLUG/revoked.json" 2>>"$RUN_ROOT/$SLUG/mint.log"
  python3 - "$RUN_ROOT/$SLUG/revoked.json" "$PID" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
assert r["status"] == "accepted" and r["principal_id"] == sys.argv[2]
PY
done
```

Retain these three non-secret records with the window’s evidence commit:

- `hm-local-seat-before.txt`: exactly `t`.
- `hm-local-wake-after.txt`: exactly `t`.
- `hm-local-first-ack.txt`: R, primer ID, observed outcome and server ACK timestamp; append the sender, seed and cleanup facts below.

The two box filenames already belong to the approved copy-back inputs. The first-ACK record is curated Mac-side output, consistent with the plan’s separate handling of client-control evidence. Sources: `docs/evidence/2026-09-28-box-hm4/BOX-WINDOW.md:117–131`; `deploy/RELEASE-TO-BOX.md:524–531`.

From the repository root:

```bash
python3 - "$RUN_ROOT/hm-local-first-ack.txt" "$SENDER" "$HM_SIGNAL_ID" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
r = json.loads(p.read_text())
r.update({
    "release_sha": "9b085c82352390cf8f0fe515c02b3ccff423476a",
    "client": "released cswarm 0.1.80",
    "sender_principal_id": sys.argv[2],
    "seed_signal_id": sys.argv[3],
    "seat_before": True,
    "wake_after": True,
    "sender_revocation": "accepted",
    "recipient_revocation": "accepted",
})
p.write_text(json.dumps(r, indent=2) + "\n")
PY

EVIDENCE_DIR="$PWD/docs/evidence/2026-09-28-box-hm4"
test -d "$EVIDENCE_DIR"
for FILE in hm-local-seat-before.txt hm-local-wake-after.txt hm-local-first-ack.txt; do
  install -m 0600 "$RUN_ROOT/$FILE" "$EVIDENCE_DIR/$FILE"
  cmp "$RUN_ROOT/$FILE" "$EVIDENCE_DIR/$FILE"
done
```

The reviewed plan contains no explicit guarded scratch-removal implementation. The following supplies that missing block under `AGENTS.md:155–162`: resolve paths, constrain deletion to this invocation’s `mktemp` directory, and exercise refusal controls before deleting. It preserves the parent directory and its anon-key file.

```bash
python3 - "$RUN_ROOT" "$ROOT" <<'PY'
import json, os, pathlib, shutil, sys

raw, parent_raw = sys.argv[1:]
home = pathlib.Path.home().resolve()
parent = pathlib.Path(parent_raw).resolve(strict=True)
root_path = pathlib.Path(raw)
root = root_path.resolve(strict=True)

if (not raw or root_path.is_symlink()
        or root == home or root == pathlib.Path("/")
        or root.parent != parent
        or not root.name.startswith("fresh-local.")
        or root.stat().st_uid != os.getuid()):
    raise SystemExit("Refusing scratch removal")

def checked(candidate):
    if not candidate:
        raise ValueError("empty path")
    p = pathlib.Path(candidate)
    resolved = p.resolve()
    if p.is_symlink() or resolved in (home, pathlib.Path("/")):
        raise ValueError("unsafe path")
    if resolved != root and root not in resolved.parents:
        raise ValueError("outside this scratch root")
    return resolved

for forbidden in ("", "/", str(home), str(parent), str(parent / "outside-control")):
    try:
        checked(forbidden)
    except ValueError:
        pass
    else:
        raise SystemExit("Removal refusal control failed")

assert checked(str(root)) == root
for slug in ("sender", "local"):
    p = json.loads((root / slug / "principal.json").read_text())
    r = json.loads((root / slug / "revoked.json").read_text())
    assert r["status"] == "accepted"
    assert r["principal_id"] == p["principal_id"]

shutil.rmtree(checked(raw))
print("Fresh-recipient scratch removed")
PY
```

Commit the three curated evidence files with the window’s evidence commit. Keep profiles, credentials, connection files, raw check output and mint logs out of that commit.