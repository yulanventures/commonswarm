# G3c, G3d and T3a: box window plan

This is the documentation-only plan for HezLead and Anvil. It does not record a deployment. Anvil runs every Mac
mini and box command. HezLead approves the SHA, backup age, each transition and any rollback. CSwarmDevLead only
coordinates, supplies reviewed inputs and records the result. The governing procedure is
`deploy/RELEASE-TO-BOX.md`.

## Release identity and measured shape

- **Box release SHA:** `38343e74cbd51ec1375317fb4770d2522ca09d0b`. At plan time, `HEAD`, `origin/main` and the
  branch's merge base with `origin/main` all resolve to that commit. It descends from the live edge baseline
  `d4677b0d1c86a6c7247d030a54a1122d6bfd5777`.
- `git ls-tree -r --name-only 38343e74 -- supabase/` confirms that the SHA contains the three migrations and the
  changed edge files:

  ```text
  supabase/functions/command/durable-delivery.ts
  supabase/functions/command/index.ts
  supabase/functions/read/index.ts
  supabase/migrations/20260927000001_reply_status.sql
  supabase/migrations/20260927000002_agent_presence.sql
  supabase/migrations/20260927000003_ask_chain.sql
  ```

- The reviewed name-only measurement is:

  ```sh
  git diff --name-only d4677b0d 38343e74 -- supabase/
  ```

  It returns exactly the six paths above. Therefore:

  ```sh
  KIND_LIST='edge stack'
  CHANGED_FUNCTIONS='command read'
  ROUTER_CHANGED=no
  ADDITIONAL_REQUIRED_ENV_NAMES=''
  ```

  `stack` is required because section 5 reads migrations and database helpers from the immutable stack release.
  The diff has no change under `deploy/edge-runtime/`, the requested but absent
  supabase/functions/main/ scope,
  `supabase/functions/_shared/` or `deploy/supabase-stack/env.example`; that proves no router change and no new
  repository-declared required environment name. The changed `command` and `read` functions retain only the base
  strict requirements named by the runbook. Anvil must still generate and verify the exact-SHA environment
  inventory as section 1 requires.
- There is no diff from `d4677b0d` in `deploy/supabase-stack/compose.yaml`,
  `deploy/supabase-stack/postgres/` or `deploy/supabase-stack/backup/`. A stack runtime switch is therefore not
  expected. Anvil still runs the box-side comparison. A migration release builds `NEW_STACK`; it does not move
  `stack/current` unless that comparison finds a runtime difference.
- None of the three migrations names `cron`, `schedule` or `unschedule`. Use
  `EXPECTED_NEW_CRON_JOBS=''` and `EXPECTED_REMOVED_CRON_JOBS=''` for section 5's before/after comparison.

The reviewed PR required by section 1, the exact-SHA `gate-evidence.txt`, HezLead's approval, the approved UTC
window and maximum backup age are **not established** by the repository. They are preflight stop conditions, not
values for this plan to guess.

## Order and handoffs

| # | Who | What |
|---:|---|---|
| 0 | HezLead approves; Anvil runs | Run section 1 preflight for full SHA `38343e74cbd51ec1375317fb4770d2522ca09d0b`: prove it is on `origin/main`, verify the exact-SHA gates and archive checksum, agree the backup maximum age, build immutable `edge` and `stack` release directories, generate the `command read` environment inventory, and stage all catalog, functional, rollback and rollback-catalog SQL named below. Run the stack runtime comparison. Stop if it finds a difference not approved by HezLead. |
| 1 | HezLead approves; Anvil runs | Run sections 2 and 3 as needed, then section 5. Prove the fresh complete backup and database identity. Enumerate the ledger and pending files. Apply and verify `20260927000001`, then `20260927000002`, then `20260927000003`, one transaction at a time. Each ledger count must become `1` and each catalog proof must return `t`. The cron added/removed sets must both be empty. Section 5 deliberately skips all three functional proofs. |
| 2 | HezLead approves; Anvil runs | Run section 6 for the `command` and `read` functions. Carry the box-only Compose override, validate the required-name inventory, switch and recreate the edge with `COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net`, wait for `healthy`, and run the runbook health, loopback, staging, changed-function, positive-control, metrics and log checks. |
| 3 | Anvil to HezLead | Report the literal handoff **“edge switched and healthy”** only after step 2 is green. No seed command below may run before this handoff. HezLead approves starting the live proofs. |
| 4 | Anvil runs; HezLead reads | From the clean SHA checkout described below, mint all seven seats exactly once in Cold Agent Test under Tom's standing order. Then create G3c A's ask to B, create B's private `declined` reply, and run `20260927000001-functional.sql` with all four values. It must print only `t`. |
| 5 | Anvil runs; HezLead reads | Using the already-minted dedicated G3d seat, await one `touch_presence` command through the new edge, then immediately run `20260927000002-functional.sql` with its principal and workspace. The proof must start within three minutes of the routed command and print only `t`. Do not mint this seat again. |
| 6 | Anvil runs; HezLead reads | Using the four already-minted T3 seats, create root, hop 1 and hop 2 through the new command edge, and run `20260927000003-functional.sql` with its five values. It must print only `t`. Do not mint these seats again. |
| 7 | HezLead closes; Anvil runs | Reconcile edge health, ledger, catalogs, all three functional outputs and the unchanged cron set. Restart the recycle timer if the window stopped it. Run transient database-file cleanup, use the pre-approved `copy-back.list`, copy only curated non-secret evidence, remove the Mac window file, and close or abort according to the runbook. |

On any stop, Anvil runs section 1's abort cleanup. A successful-looking CLI response does not override a failed
ledger, catalog, functional, health or log check.

### Pre-approved copy-back paths

At section 1 preflight, after `$PROOF_DIR` exists and before the window can change production, HezLead writes the
following exact relative paths to root-owned mode-`0600` `$PROOF_DIR/copy-back.list`. The list includes itself and
contains no `*.log`, `window.env` or `database/logs/` path:

```text
copy-back.list
20260927000001-catalog.sql
20260927000001-functional.sql
20260927000001-functional.txt
20260927000001-rollback-catalog.sql
20260927000001-rollback.sql
20260927000002-catalog.sql
20260927000002-functional.sql
20260927000002-functional.txt
20260927000002-rollback-catalog.sql
20260927000002-rollback.sql
20260927000003-catalog.sql
20260927000003-functional.sql
20260927000003-functional.txt
20260927000003-rollback-catalog.sql
20260927000003-rollback.sql
box-archive.sha256
cron-added.txt
cron-after-sorted.txt
cron-after.txt
cron-before-sorted.txt
cron-before.txt
cron-removed.txt
edge-env-source-check.txt
edge-probe-start.txt
edge-with-override.SHA256SUMS
edge.SHA256SUMS
h0-note-unauth.json
ledger-before.txt
migration-files.sha256
migration-files.txt
migration-state-after.txt
migration-state-before.txt
pending-versions.txt
required-edge-env.json
stack.SHA256SUMS
verification-sql.sha256
```

These are the box-side files copied back by section 1's close block. Mac-side `gate-evidence.txt`, the reviewed
archive checksum, proof-transfer list and staging-probe output already remain in `$EVIDENCE_DIR`; they are not box
copy-back paths. `edge-probe-window.log`, `box-run.log`, `window.env`, transient `current-migration.env`, the
release session helper and everything under `database/logs/` stay on the box. If any listed file is absent at
close, Anvil stops; the list is not reconstructed or broadened.

## Migration order, proofs and reserve rollback inputs

Stage every file in this table in the release proof directory before section 5. The catalog files are the read-only
proofs used inside the release wrapper. Each reserve rollback includes its rollback catalog and commits only when
that Boolean is true.

| Order | Migration | Catalog proof | Catalog postcondition | Reserve rollback |
|---:|---|---|---|---|
| 1 | `supabase/migrations/20260927000001_reply_status.sql` | `deploy/release-proofs/item-g3c/20260927000001-catalog.sql` | `reply_status` and its constraint exist, `swarm_read.signals` projects it with the security barrier, and the receipt function has the reviewed owner, grants and ordered `replies` shape. | `deploy/release-proofs/item-g3c/20260927000001-rollback.sql` with `deploy/release-proofs/item-g3c/20260927000001-rollback-catalog.sql` |
| 2 | `supabase/migrations/20260927000002_agent_presence.sql` | `deploy/release-proofs/item-g3d/20260927000002-catalog.sql` | The command-owned presence table, route columns, ACK route, index, config row and member-scoped security-barrier view have the reviewed columns, grants and constraints. | `deploy/release-proofs/item-g3d/20260927000002-rollback.sql` with `deploy/release-proofs/item-g3d/20260927000002-rollback-catalog.sql` |
| 3 | `supabase/migrations/20260927000003_ask_chain.sql` | `deploy/release-proofs/item-t3/20260927000003-catalog.sql` | The four chain columns, same-workspace parent foreign key, child index and append-only trigger exist; the read view exposes only `chain_hop` and keeps its security boundary. | `deploy/release-proofs/item-t3/20260927000003-rollback.sql` with `deploy/release-proofs/item-t3/20260927000003-rollback-catalog.sql` |

The section 5 skip list explicitly names `20260927000001`, `20260927000002` and `20260927000003`. Do not invoke
their functional files during the automatic pre-edge verification. Their exact files are:

- `deploy/release-proofs/item-g3c/20260927000001-functional.sql`
- `deploy/release-proofs/item-g3d/20260927000002-functional.sql`
- `deploy/release-proofs/item-t3/20260927000003-functional.sql`

### Rollback order

Rollback is reserve-only and requires HezLead's decision. First restore `PREVIOUS_EDGE` with section 6's rollback,
wait for health, and repeat its probes and log check. `PREVIOUS_EDGE` is recorded by preflight; its exact path is not
established in this plan.

Only after the old edge is healthy, run the reviewed SQL rollbacks in **reverse migration order** with the write
helper:

```sh
release_psql --file /proof/20260927000003-rollback.sql
release_psql --file /proof/20260927000002-rollback.sql
release_psql --file /proof/20260927000001-rollback.sql
```

That order removes the T3 projection before G3c rebuilds the same signals view, and removes the G3d objects only
after the edge that writes them is gone. Do not publish the new client or release the new site before the box gate
passes, so an in-window rollback has no public new client to reconcile. Prefer a reviewed forward fix after close;
post-publication database rollback compatibility is **not established** by these reserve files.

## Build the seed client from the box SHA

The npm-published 0.1.78 binary was built before these lanes and does not send `reply_status`, `route`,
`touch_presence` or `parent_signal_id`. Anvil prepares a clean detached checkout of the exact box SHA and builds it
before the window. It must not contact the old edge with this client. The first live command from it occurs only
after “edge switched and healthy.”

Run from the repository used for release preflight:

```sh
(
  set -euo pipefail
  SHA=38343e74cbd51ec1375317fb4770d2522ca09d0b
  SOURCE_REPO="$PWD"
  CLIENT_ROOT="$(mktemp -d /tmp/commonswarm-box-client.XXXXXX)"
  CLIENT_CHECKOUT="$CLIENT_ROOT/checkout"
  git clone --quiet --no-local "$SOURCE_REPO" "$CLIENT_CHECKOUT"
  git -C "$CLIENT_CHECKOUT" checkout --quiet --detach "$SHA"
  test "$(git -C "$CLIENT_CHECKOUT" rev-parse HEAD)" = "$SHA"
  test -z "$(git -C "$CLIENT_CHECKOUT" status --porcelain)"
  (cd "$CLIENT_CHECKOUT" && npm ci && npm run build)
  test -x "$CLIENT_CHECKOUT/dist/cli.js"
  printf 'CLIENT_CHECKOUT=%q\n' "$CLIENT_CHECKOUT" >"$CLIENT_ROOT/client.env"
  chmod 0600 "$CLIENT_ROOT/client.env"
  printf '%s\n' "$CLIENT_ROOT/client.env"
)
```

Anvil retains the printed `client.env` path in the protected release notes and sources it for every mint and seed
block below. Every product command runs from that checkout as `node dist/cli.js`.

The exact-SHA `package.json` still declares `0.1.78`. That does not change the code under test, but it means this
checkout is not itself the later publishable 0.1.79 commit. The post-window release section resolves that measured
distinction.

## Seat mint block

Run this only after the edge handoff. Anvil runs it as Tom, using Tom's existing human session and standing order,
in Cold Agent Test workspace `c2ea0541-f56d-4c73-bf71-56c5405c4934`. The block creates seven new principals with
one private seed directory per seat. It does not use `--allow-duplicate-name`; any pre-existing name is a stop.

Before the block, Anvil places the deployment's public anon key in
`$HOME/.config/cswarm/box-g3c-g3d-t3a-20260927/anon-key.txt`, mode `0600`, using the same fetch-and-hash comparison
as the 2b plan. The key value is never printed, put in argv or copied to the box.

```sh
(
  set -euo pipefail
  umask 077
  . <protected-client.env-path>
  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  ROOT="$HOME/.config/cswarm/box-g3c-g3d-t3a-20260927"
  ANON_FILE="$ROOT/anon-key.txt"
  test -d "$CLIENT_CHECKOUT"
  test -s "$ANON_FILE"
  test "$(stat -f %Lp "$ROOT")" = 700
  test "$(stat -f %Lp "$ANON_FILE")" = 600

  lower() { tr 'A-Z' 'a-z'; }
  mint_seat() {
    NAME="$1"
    SLUG="$2"
    D="$ROOT/$SLUG"
    test ! -e "$D"
    mkdir -m 0700 "$D"
    install -m 0600 /dev/null "$D/mint.log"
    (
      cd "$CLIENT_CHECKOUT"
      node dist/cli.js principal create --workspace-id "$WS" --name "$NAME"
    ) >"$D/principal.json" 2>>"$D/mint.log"
    PID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
      "$D/principal.json" 2>>"$D/mint.log")"
    (
      cd "$CLIENT_CHECKOUT"
      node dist/cli.js token mint --workspace-id "$WS" --principal-id "$PID" \
        --run-id "$(uuidgen | lower)" --task-id "$(uuidgen | lower)" --epoch 1 \
        --ttl-ms 21600000 --renewal-horizon-days 1
    ) >"$D/credential-mint.json" 2>>"$D/mint.log"
    python3 - "$ANON_FILE" "$D/credential-mint.json" "$D/connection.json" "$WS" "$PID" \
      2>>"$D/mint.log" <<'PY'
import json
import pathlib
import sys

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
    chmod 0700 "$D"
    chmod 0600 "$D"/*.json "$D/mint.log"
  }

  mint_seat box-g3c-a-0927 g3c-a
  mint_seat box-g3c-b-0927 g3c-b
  mint_seat box-g3d-turn-0927 g3d-turn
  mint_seat box-t3-a-0927 t3-a
  mint_seat box-t3-b-0927 t3-b
  mint_seat box-t3-c-0927 t3-c
  mint_seat box-t3-d-0927 t3-d
  echo OK
)
```

Success is one final `OK`. If it prints no `OK`, stop and inspect the affected seat's protected `mint.log`; do not
reuse a partially populated directory or guess whether a principal was created. HezLead approves new suffixes before
a retry. No credential or connection file goes to the box. After the window, revoke each principal by the id in its
`principal.json` when HezLead says the evidence seats are no longer needed.

## G3c seed and functional proof

This uses seat A to ask seat B, then B privately replies with `--status declined`. The four SQL variables are the
workspace, ask signal, reply signal and the human user who reads the receipt. `item_g3c_author_user_id` is named that
way in the proof, but the SQL does not assert that the original signal's `from_kind` is `user`. A concrete valid
counterexample is this agent-authored ask: the receipt is visible because the supplied human owns seat A or B. The
proof's “human-authored signal” header is therefore not a tested precondition.

Anvil runs on the Mac mini after the edge handoff:

```sh
(
  set -euo pipefail
  . <protected-client.env-path>
  ROOT="$HOME/.config/cswarm/box-g3c-g3d-t3a-20260927"
  WS=c2ea0541-f56d-4c73-bf71-56c5405c4934
  A="$ROOT/g3c-a"
  B="$ROOT/g3c-b"
  cd "$CLIENT_CHECKOUT"

  node dist/cli.js ask "G3c production proof: please decline this test ask." \
    --profile "$A/profile.json" --to box-g3c-b-0927 --json >"$A/ask.json"
  ITEM_G3C_SIGNAL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$A/ask.json")"

  node dist/cli.js reply "$ITEM_G3C_SIGNAL_ID" "Declined for the G3c production proof." \
    --profile "$B/profile.json" --status declined --json >"$B/reply.json"
  ITEM_G3C_REPLY_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$B/reply.json")"
  python3 -c 'import json,sys; assert json.load(open(sys.argv[1]))["signal"]["reply_status"] == "declined"' \
    "$B/reply.json"

  node dist/cli.js whoami --profile "$A/profile.json" --json >"$A/whoami.json"
  ITEM_G3C_AUTHOR_USER_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["owner_user_id"])' \
    "$A/whoami.json")"
  printf 'ITEM_G3C_WORKSPACE_ID=%s\nITEM_G3C_SIGNAL_ID=%s\nITEM_G3C_REPLY_ID=%s\nITEM_G3C_AUTHOR_USER_ID=%s\n' \
    "$WS" "$ITEM_G3C_SIGNAL_ID" "$ITEM_G3C_REPLY_ID" "$ITEM_G3C_AUTHOR_USER_ID"
)
```

Anvil transfers only those four UUID values to the box, sets the corresponding protected shell variables, then
runs:

```sh
release_psql_ro -v item_g3c_workspace_id="$ITEM_G3C_WORKSPACE_ID" \
  -v item_g3c_signal_id="$ITEM_G3C_SIGNAL_ID" \
  -v item_g3c_reply_id="$ITEM_G3C_REPLY_ID" \
  -v item_g3c_author_user_id="$ITEM_G3C_AUTHOR_USER_ID" \
  --file "/proof/20260927000001-functional.sql" \
  >"$PROOF_DIR/20260927000001-functional.txt"
test "$(cat "$PROOF_DIR/20260927000001-functional.txt")" = t
```

## G3d seed and functional proof

Do not use `node dist/cli.js check` as this seed. In the release SHA, `check` reserves the seat's 60-second presence
throttle before starting `touch_presence` without awaiting it, and its deadline cleanup aborts that request after
the inbox reads finish. Exit zero from `check` therefore does not establish that the route reached the server, and
a second check inside the throttle window does not send another touch.

Instead, use the release build's `DeliveryCommandClient` directly and await its `touchPresence` promise. This sends
the same release-SHA `client_build` and `touch_presence` command envelope as the product client, through the new
edge, without the advisory `check` wrapper. It reads the credential through the release build's profile reader; no
credential is printed or placed in argv. Run the SQL immediately after the awaited HTTP success.

Anvil runs on the Mac mini:

```sh
(
  set -euo pipefail
  . <protected-client.env-path>
  ROOT="$HOME/.config/cswarm/box-g3c-g3d-t3a-20260927"
  D="$ROOT/g3d-turn"
  cd "$CLIENT_CHECKOUT"
  node --input-type=module - "$D/profile.json" >"$D/touch-presence.json" <<'JS'
import { randomUUID } from "node:crypto";
import {
  profileTarget,
  readAgentProfile,
  readProfileCredential,
} from "./dist/cloud/agent-profile.js";
import { DeliveryCommandClient } from "./dist/cloud/delivery.js";

const profile = await readAgentProfile(process.argv[2]);
const credential = await readProfileCredential(profile);
const result = await new DeliveryCommandClient(profileTarget(profile)).touchPresence({
  workspaceId: profile.workspace_id,
  credential: credential.token,
  commandId: randomUUID(),
});
if (result.httpStatus < 200 || result.httpStatus >= 300) {
  throw new Error("presence touch did not return a 2xx response");
}
process.stdout.write(JSON.stringify({ ok: true, http_status: result.httpStatus }) + "\n");
JS
  ITEM_G3D_PRINCIPAL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["principal_id"])' \
    "$D/principal.json")"
  printf 'ITEM_G3D_PRINCIPAL_ID=%s\nITEM_G3D_WORKSPACE_ID=%s\n' \
    "$ITEM_G3D_PRINCIPAL_ID" c2ea0541-f56d-4c73-bf71-56c5405c4934
)
```

Within three minutes of the completed `touch_presence`, Anvil transfers only the two UUIDs to the box and runs:

```sh
release_psql_ro -v item_g3d_principal_id="$ITEM_G3D_PRINCIPAL_ID" \
  -v item_g3d_workspace_id="$ITEM_G3D_WORKSPACE_ID" \
  --file "/proof/20260927000002-functional.sql" \
  >"$PROOF_DIR/20260927000002-functional.txt"
test "$(cat "$PROOF_DIR/20260927000002-functional.txt")" = t
```

A missing value, wrong seat/workspace pair or no `watcher_at`, `channel_at`, `listener_at` or `turn_at` timestamp in
the last three minutes fails the proof. Stop on failure. The awaited command eliminates `check`'s advisory race; it
does not weaken the SQL authority or authorize retrying a failed proof as though it passed.

## T3a seed and functional proof

The functional SQL requires three asks, not two: A asks B for the root, B asks C with the root as parent, then C asks
D with hop 1 as parent. This yields the exact root to hop 1 to hop 2 chain the proof reads. The human owner of any of
these Tom-owned seats is the reader.

Anvil runs on the Mac mini:

```sh
(
  set -euo pipefail
  . <protected-client.env-path>
  ROOT="$HOME/.config/cswarm/box-g3c-g3d-t3a-20260927"
  A="$ROOT/t3-a"
  B="$ROOT/t3-b"
  C="$ROOT/t3-c"
  cd "$CLIENT_CHECKOUT"

  node dist/cli.js ask "T3 production proof root." \
    --profile "$A/profile.json" --to box-t3-b-0927 --json >"$A/root.json"
  ITEM_T3_ROOT_SIGNAL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$A/root.json")"

  node dist/cli.js ask "T3 production proof hop 1." \
    --profile "$B/profile.json" --to box-t3-c-0927 --parent "$ITEM_T3_ROOT_SIGNAL_ID" --json \
    >"$B/hop1.json"
  ITEM_T3_HOP1_SIGNAL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$B/hop1.json")"

  node dist/cli.js ask "T3 production proof hop 2." \
    --profile "$C/profile.json" --to box-t3-d-0927 --parent "$ITEM_T3_HOP1_SIGNAL_ID" --json \
    >"$C/hop2.json"
  ITEM_T3_HOP2_SIGNAL_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["signal"]["id"])' \
    "$C/hop2.json")"

  node dist/cli.js whoami --profile "$A/profile.json" --json >"$A/whoami.json"
  ITEM_T3_READER_USER_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["owner_user_id"])' \
    "$A/whoami.json")"
  printf 'ITEM_T3_WORKSPACE_ID=%s\nITEM_T3_ROOT_SIGNAL_ID=%s\nITEM_T3_HOP1_SIGNAL_ID=%s\nITEM_T3_HOP2_SIGNAL_ID=%s\nITEM_T3_READER_USER_ID=%s\n' \
    c2ea0541-f56d-4c73-bf71-56c5405c4934 "$ITEM_T3_ROOT_SIGNAL_ID" \
    "$ITEM_T3_HOP1_SIGNAL_ID" "$ITEM_T3_HOP2_SIGNAL_ID" "$ITEM_T3_READER_USER_ID"
)
```

Anvil transfers only those five UUIDs to the box and runs:

```sh
release_psql_ro -v item_t3_workspace_id="$ITEM_T3_WORKSPACE_ID" \
  -v item_t3_root_signal_id="$ITEM_T3_ROOT_SIGNAL_ID" \
  -v item_t3_hop1_signal_id="$ITEM_T3_HOP1_SIGNAL_ID" \
  -v item_t3_hop2_signal_id="$ITEM_T3_HOP2_SIGNAL_ID" \
  -v item_t3_reader_user_id="$ITEM_T3_READER_USER_ID" \
  --file "/proof/20260927000003-functional.sql" \
  >"$PROOF_DIR/20260927000003-functional.txt"
test "$(cat "$PROOF_DIR/20260927000003-functional.txt")" = t
```

For the three supplied ids, the proof requires three `ask` rows in the named workspace; root hop `0`; child hops
`1` and `2`; the two parent links; one shared root id; `cardinality(chain_participants) >= 2` on the root; and all
three hops visible to the supplied reader. Other asks already in Cold Agent Test do not affect that count.

## After the window

The client/server ordering comes from `docs/evidence/2026-09-26-item-g-g3d/LANDING-CLIENT.md` and
`docs/evidence/2026-09-26-item-t3/LANDING-T3B.md`. The site payload is recorded in
`docs/evidence/2026-09-26-item-cp/CP1-LANDING.md` and `docs/evidence/2026-09-26-item-cp/CP3-LANDING.md`.

The order is binding:

1. **Publish cswarm 0.1.79 only after this box gate passes.** The G3d client cannot speak to the old server because
   older command validation refuses `client_build` and `route`. T3b also requires the new server before it sends
   `parent_signal_id`. The 0.1.79 release branch must start from box SHA `38343e74cbd51ec1375317fb4770d2522ca09d0b`,
   bump `package.json` and `package-lock.json` together, pass review and land on `main`. The resulting full
   `CLIENT_RELEASE_SHA` is **not established** until that release commit exists.
2. **Record the published client build.** Only after npm 0.1.79 is published from that exact reviewed
   `CLIENT_RELEASE_SHA`, Anvil follows section 6 and runs on the Mac mini:

   ```sh
   scripts/current-client-build-sql.sh "$CLIENT_RELEASE_SHA" \
     >"$EVIDENCE_DIR/current-client-build.sql"
   chmod 0600 "$EVIDENCE_DIR/current-client-build.sql"
   ```

   After proof-list review and transfer, Anvil re-proves database identity and applies it only with:

   ```sh
   release_psql --file /proof/current-client-build.sql
   ```

   Do not run the generator with the box SHA: `scripts/current-client-build-sql.sh 38343e74` reads that commit's
   package metadata and emits `0.1.78`, which is a concrete counterexample to calling the box commit itself the
   0.1.79 publish commit.
3. **Release the site after the published-build record.** Use the reviewed site release SHA that contains the box
   SHA and the 0.1.79 version bump, following the site portion of `deploy/RELEASE-TO-BOX.md`. That release carries
   CP1's Google-first sign-in, CP3's approved consumer copy, the Grok Bot guide page, and G3e's roster presence. The
   exact site release SHA is **not established** until the client release commit lands.

## Production controls unlocked after release

These are follow-up controls, not claims that this documentation task ran them:

- **G3a live control:** repeat the T2 procedure with two new Cold Agent Test seats. An idle Haiku session must call
  `cswarm_received` without a prompt from the new Claude channel notice, and its reply must arrive after approval.
  Source: `docs/evidence/2026-09-26-item-g-g3a/LANDING.md`.
- **G3e roster control:** exercise one production seat for each wake kind, then verify `cswarm members` and the app
  roster classify each route. Include one seat on an older build and verify it shows “update available.”
  Source: `docs/evidence/2026-09-26-item-g-g3d/LANDING-G3E.md`.
- **T3 controls:** prove a two-hop chain; a loop refusal; the hop-5 boundary with seven seats; and the per-agent-pair
  limit. Run them on Cold Agent Test seats after 0.1.79 is published, so the tested client sends parent ids.
  Source: `docs/evidence/2026-09-26-item-t3/LANDING-T3A.md`.

Their seat ids, commands, outputs and pass/fail results are **not established** until those controls run and their
evidence lands.

## Not established before the window

- The exact reviewed PR and exact-SHA gate evidence for `38343e74cbd51ec1375317fb4770d2522ca09d0b`.
- HezLead's approval, window times and maximum backup age.
- The live `PREVIOUS_EDGE`, `PREVIOUS_STACK`, ledger, catalog, cron and backup state. The runbook measures each.
- The clean checkout path, anon-key file, Tom human-session validity, minted principal ids, owner user id and signal
  ids. The protected blocks above produce them without guessing.
- A live edge switch, any functional proof result, a deployment, npm 0.1.79, `current_client_build`, a site release,
  or any post-release production control. This plan performs none of them.
