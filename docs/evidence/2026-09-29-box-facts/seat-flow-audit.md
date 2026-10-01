### A. Principal, token, and profile

**Yes, if the saved human session can refresh and its user is a member of that workspace.** The lower-level commands need no TTY, browser, email, or 2FA prompt. Choose a private path outside the repository; the following is an **example to run later**, not a command I ran:

```sh
set -euo pipefail
umask 077
PROFILE=/absolute/private/hm37a-sender/profile.json
DIR=${PROFILE%/*}
install -d -m 700 "$DIR"

PRINCIPAL_ID=$(cswarm principal create \
  --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 \
  --name hm37a-sender --json | jq -r .principal_id)
RUN_ID=$(uuidgen)
TASK_ID=$(uuidgen)

cswarm token mint \
  --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 \
  --principal-id "$PRINCIPAL_ID" --run-id "$RUN_ID" \
  --task-id "$TASK_ID" --epoch 0 --json > "$DIR/minted.json"

cswarm target show --reveal-anon-key --json |
  jq --slurpfile credential "$DIR/minted.json" \
     --arg workspace c2ea0541-f56d-4c73-bf71-56c5405c4934 \
     --arg principal "$PRINCIPAL_ID" \
     '{version:1, url:.current_target.url,
       anon_key:.current_target.anon_key,
       workspace_id:$workspace, principal_id:$principal,
       credential:$credential[0]}' > "$DIR/connection.json"

cswarm setup --connection-file "$DIR/connection.json" \
  --profile "$PROFILE" --host-session-id manual --json
cswarm whoami --profile "$PROFILE" --json
```

The minted secret is in `minted.json`, never in an argument or terminal output. `token mint` **does not write a profile**: the connection envelope must be assembled, then supported `cswarm setup` writes `profile.json` and adjacent `credential.json` as private files. The default bearer lifetime is **one hour**; the default timeboxed renewal horizon is **30 days**, with renewal on use. An explicit `--ttl-ms` can set the initial bearer lifetime up to 30 days. This creates a `local`, non-turn-only agent principal, the same transport kind used by `mcp connect`’s registered local seat; it can use the local receive path once that path is configured. A failed refresh, name collision, or principal limit can still prevent creation. Evidence: `src/cli.ts:2546-2577`, `src/cli.ts:2659-2756`, `src/cli.ts:1696-1704`, `src/cloud/auth.ts:567-609`, `src/cloud/agent-profile.ts:29-35`, `src/cloud/agent-profile.ts:282-349`, `src/cloud/agent-setup.ts:19-72`, `src/cloud/storage.ts:816-835`, `src/protocol/workspace-commands.ts:977-994`, `src/protocol/workspace-commands.ts:1067-1095`, `src/protocol/workspace-commands.ts:16-43`, `src/protocol/workspace-commands.ts:753-762`. Unlike this flow, `mcp connect` explicitly requires a TTY to enter its code (`src/cloud/mcp-connect.ts:371-397`).

### B. Linked identity providers

**No.** There is no useful provider-name `jq` filter for `cswarm status --json`: its `identity` contains only `user_id`, `email`, and `device_id`. `workspaces --json` likewise emits only user ID and email. Refreshing the saved human session returns those IDs and an access token, not provider metadata to the JSON builder. Evidence: `src/cli.ts:2028-2042`, `src/cli.ts:2113-2130`, `src/cli.ts:1813-1822`, `src/cloud/auth.ts:599-609`.

### C. Directed signal and cursor

Use `cswarm note "window probe" --to <B-principal-id> --profile <A-profile> --json` to send; its JSON has `.signal.id`. Use `cswarm check --profile <B-profile> --full --json` for B’s **once-only turn read**, then repeat it: the second result has `messages: []` if no other messages arrived. `check` commits its local cursor after presenting output and then attempts an `observed` delivery ACK; there is **no separate CLI ACK command** for this path. Verify the server ACK with `cswarm receipt <signal-id> --profile <A-profile> --json` and its recipient receipt’s `outcome`/`acked_at`. A third principal’s `cswarm check --profile <C-profile> --json` should omit that directed ID. Evidence: `src/cli.ts:10352-10357`, `src/cli.ts:3919-3928`, `src/onboarding-cli.ts:204-211`, `src/cloud/agent-check.ts:250-301`, `src/cloud/agent-check.ts:318-426`, `src/cloud/delivery.ts:1032-1051`, `src/cli.ts:5318-5362`, `src/cloud/receipts.ts:274-305`.

`cswarm inbox --profile <B-profile> --json` is a useful history read, but **it does not consume the message or advance `check`’s cursor**; repeating it can return the same signal. A second empty `check` proves the local cursor moved. A receipt showing `observed` proves the server accepted the ACK, since `check` does not fail its output when a later ACK attempt fails. Evidence: `src/cli.ts:4861-4904`, `src/cloud/agent-check.ts:397-426`.

I read the checkout only; I did not run these commands or dispatch an Alloy subprocess under the no-run constraint.