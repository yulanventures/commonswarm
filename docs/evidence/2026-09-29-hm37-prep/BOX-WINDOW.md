# HM37 Window A pre-window preparation

## Named prompt inputs

This is a preparation plan, not a release or deployment plan. Anvil runs it on
the Mac mini before HM37 Window A. It exercises the currently live edge release
`72c57e0d76d0aa86fe4f811a2cf51499919fed20` through the normal `cswarm` CLI.
Every failure is a STOP. If a failure occurs after any principal is created,
run `hm37-prep-final-no-cleanup`; do not start Window A.

The only prompt inputs for this preparation are:

| Name | Supplier and meaning | Exact format and expected value |
|---|---|---|
| `APPROVER` | HezLead, approval identity | Exact string `HezLead`. |
| `PLAN_COMMIT` | HezLead/Anvil, reviewed PREP plan | Exactly 40 hexadecimal characters. |
| `PROMPT_NUMBER` | HezLead, approval record | Positive decimal integer. |

No path, identifier, seat name, timestamp, or cleanup target is chosen by the
operator. `hm37-prep-open` derives `PREP_ID` from the Mac clock in UTC as
`YYYYMMDDTHHMMSSZ`. The fixed preparation root is
`/Users/yulanbot/anvil-work/hm37-prep`; the run directory is the child named by
`PREP_ID`. The legacy `~/anvil-work/uat-20260927/seat-b/` profile and the
principal whose ID begins `cee27f94` are never read, used, changed, or deleted.

Run the blocks in order. Run `hm37-prep-final-yes` only after the baseline
passes. Run `hm37-prep-final-no-cleanup` instead after any failure once a
principal may exist. Each later block reads only the fixed `active.env` state
written by the open block; it does not inherit shell variables from a prior
block.

## 1. Open the preparation

This block validates the three named inputs, the saved human session, the one
allowed workspace, and the live edge before its first write. It refuses an
existing active state or any prior run directory under the preparation root.

```sh
# step: hm37-prep-open
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only SSH child on box /bin/bash 5.2 as root
(
  set -euo pipefail
  umask 077

  APPROVER="${APPROVER:?APPROVER is required}"
  PLAN_COMMIT="${PLAN_COMMIT:?PLAN_COMMIT is required}"
  PROMPT_NUMBER="${PROMPT_NUMBER:?PROMPT_NUMBER is required}"
  test "$APPROVER" = "HezLead"
  case "$PLAN_COMMIT" in
    *[!0-9a-fA-F]*|'') exit 1 ;;
  esac
  test "${#PLAN_COMMIT}" -eq 40
  case "$PROMPT_NUMBER" in
    *[!0-9]*|''|0*) exit 1 ;;
  esac

  WORKSPACE_ID="c2ea0541-f56d-4c73-bf71-56c5405c4934"
  HUMAN_USER_ID="d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"
  EXPECTED_EDGE_SHA="72c57e0d76d0aa86fe4f811a2cf51499919fed20"
  PREP_ROOT="/Users/yulanbot/anvil-work/hm37-prep"
  ACTIVE_STATE="$PREP_ROOT/active.env"
  test "$WORKSPACE_ID" = "c2ea0541-f56d-4c73-bf71-56c5405c4934"

  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  printf '%s' "$STATUS_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg user "$HUMAN_USER_ID" \
    '.identity.user_id == $user and
     .selected_project.workspace_id == $workspace and
     (.warnings | type == "array" and length == 0)' >/dev/null

  EDGE_CURRENT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 ops@yulan-vps-1 \
    "sudo -n /bin/bash -c 'readlink -f /home/commonswarm/edge/current'")"
  test "$EDGE_CURRENT" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA"

  if [ -e "$PREP_ROOT" ]; then
    test -d "$PREP_ROOT"
    test ! -L "$PREP_ROOT"
    test "$(stat -f '%Su' "$PREP_ROOT")" = "$(id -un)"
    test "$(stat -f '%Lp' "$PREP_ROOT")" = "700"
    test ! -e "$ACTIVE_STATE"
    test -z "$(find "$PREP_ROOT" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  fi

  PREP_ID="$(date -u '+%Y%m%dT%H%M%SZ')"
  CREATED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  case "$PREP_ID" in
    20[0-9][0-9][0-1][0-9][0-3][0-9]T[0-2][0-9][0-5][0-9][0-5][0-9]Z) ;;
    *) exit 1 ;;
  esac
  PREP_DIR="$PREP_ROOT/$PREP_ID"
  SENDER_DIR="$PREP_DIR/sender"
  RECEIVER_DIR="$PREP_DIR/receiver"
  THIRD_DIR="$PREP_DIR/third"
  test ! -e "$PREP_DIR"

  install -d -m 700 "$PREP_ROOT" "$PREP_DIR" \
    "$SENDER_DIR" "$RECEIVER_DIR" "$THIRD_DIR"
  STATE_TEMP="$PREP_ROOT/.active.$PREP_ID.tmp"
  {
    printf "PREP_ID='%s'\n" "$PREP_ID"
    printf "CREATED_AT='%s'\n" "$CREATED_AT"
    printf "WORKSPACE_ID='%s'\n" "$WORKSPACE_ID"
    printf "HUMAN_USER_ID='%s'\n" "$HUMAN_USER_ID"
    printf "EXPECTED_EDGE_SHA='%s'\n" "$EXPECTED_EDGE_SHA"
    printf "APPROVER='%s'\n" "$APPROVER"
    printf "PLAN_COMMIT='%s'\n" "$PLAN_COMMIT"
    printf "PROMPT_NUMBER='%s'\n" "$PROMPT_NUMBER"
    printf "PREP_ROOT='%s'\n" "$PREP_ROOT"
    printf "PREP_DIR='%s'\n" "$PREP_DIR"
    printf "SENDER_DIR='%s'\n" "$SENDER_DIR"
    printf "RECEIVER_DIR='%s'\n" "$RECEIVER_DIR"
    printf "THIRD_DIR='%s'\n" "$THIRD_DIR"
    printf "SENDER_NAME='hm37a-sender-%s'\n" "$PREP_ID"
    printf "RECEIVER_NAME='hm37a-receiver-%s'\n" "$PREP_ID"
    printf "THIRD_NAME='hm37a-third-%s'\n" "$PREP_ID"
    printf "SENDER_PROFILE='%s/profile.json'\n" "$SENDER_DIR"
    printf "RECEIVER_PROFILE='%s/profile.json'\n" "$RECEIVER_DIR"
    printf "THIRD_PROFILE='%s/profile.json'\n" "$THIRD_DIR"
    printf "SENDER_PRINCIPAL_ID=''\n"
    printf "RECEIVER_PRINCIPAL_ID=''\n"
    printf "THIRD_PRINCIPAL_ID=''\n"
    printf "SENDER_TOKEN_EXPIRES_AT=''\n"
    printf "RECEIVER_TOKEN_EXPIRES_AT=''\n"
    printf "THIRD_TOKEN_EXPIRES_AT=''\n"
    printf "SENDER_READY='no'\n"
    printf "RECEIVER_READY='no'\n"
    printf "THIRD_READY='no'\n"
    printf "BASELINE_RESULT='not-run'\n"
  } >"$STATE_TEMP"
  chmod 600 "$STATE_TEMP"
  mv "$STATE_TEMP" "$ACTIVE_STATE"
  test "$(stat -f '%Lp' "$ACTIVE_STATE")" = "600"
)
```

## 2. Create and verify the three seats

This block creates each principal, records its ID immediately, mints a 24-hour
credential, pipes the revealed anon key directly into a private connection
file, imports the profile, and checks the authenticated identity. It emits no
credential, anon key, or connection document.

```sh
# step: hm37-prep-create-seats
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only SSH child on box /bin/bash 5.2 as root
(
  set -euo pipefail
  umask 077
  ACTIVE_STATE="/Users/yulanbot/anvil-work/hm37-prep/active.env"
  test -f "$ACTIVE_STATE"
  test ! -L "$ACTIVE_STATE"
  test "$(stat -f '%Su' "$ACTIVE_STATE")" = "$(id -un)"
  test "$(stat -f '%Lp' "$ACTIVE_STATE")" = "600"
  . "$ACTIVE_STATE"
  test "$WORKSPACE_ID" = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
  test "$PREP_ROOT" = "/Users/yulanbot/anvil-work/hm37-prep"
  test "$PREP_DIR" = "$PREP_ROOT/$PREP_ID"

  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  printf '%s' "$STATUS_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg user "$HUMAN_USER_ID" \
    '.identity.user_id == $user and
     .selected_project.workspace_id == $workspace and
     (.warnings | type == "array" and length == 0)' >/dev/null
  EDGE_CURRENT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 ops@yulan-vps-1 \
    "sudo -n /bin/bash -c 'readlink -f /home/commonswarm/edge/current'")"
  test "$EDGE_CURRENT" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA"

  create_seat() {
    ROLE="$1"
    SEAT_NAME="$2"
    SEAT_DIR="$3"
    PROFILE_PATH="$4"
    PRINCIPAL_KEY="$5"
    EXPIRY_KEY="$6"
    READY_KEY="$7"
    test -d "$SEAT_DIR"
    test ! -L "$SEAT_DIR"
    test "$(stat -f '%Lp' "$SEAT_DIR")" = "700"
    test ! -e "$PROFILE_PATH"

    PRINCIPAL_JSON="$(cswarm principal create \
      --workspace-id "$WORKSPACE_ID" --name "$SEAT_NAME" --json)"
    PRINCIPAL_ID="$(printf '%s' "$PRINCIPAL_JSON" | jq -er \
      '.principal_id | select(type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))')"
    printf "%s='%s'\n" "$PRINCIPAL_KEY" "$PRINCIPAL_ID" >>"$ACTIVE_STATE"

    RUN_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    TASK_ID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
    MINTED_FILE="$SEAT_DIR/minted.json"
    CONNECTION_FILE="$SEAT_DIR/connection.json"
    cswarm token mint --workspace-id "$WORKSPACE_ID" \
      --principal-id "$PRINCIPAL_ID" --run-id "$RUN_ID" \
      --task-id "$TASK_ID" --epoch 0 --ttl-ms 86400000 --json >"$MINTED_FILE"
    chmod 600 "$MINTED_FILE"
    TOKEN_EXPIRES_AT="$(jq -er \
      '.expires_at |
       select(type == "string" and
              (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601) > now)' \
      "$MINTED_FILE")"
    printf "%s='%s'\n" "$EXPIRY_KEY" "$TOKEN_EXPIRES_AT" >>"$ACTIVE_STATE"

    cswarm target show --reveal-anon-key --json | jq -e \
      --slurpfile credential "$MINTED_FILE" \
      --arg workspace "$WORKSPACE_ID" \
      --arg principal "$PRINCIPAL_ID" '
        .current_target as $target |
        if (($target.url | sub("/$"; "")) == "https://api.commonswarm.com" and
            ($target.anon_key | type) == "string" and
            ($target.anon_key | length) > 0 and
            ($credential | length) == 1)
        then {version: 1, url: ($target.url | sub("/$"; "")),
              anon_key: $target.anon_key, workspace_id: $workspace,
              principal_id: $principal, credential: $credential[0]}
        else error("saved production target is unavailable")
        end
      ' >"$CONNECTION_FILE"
    chmod 600 "$CONNECTION_FILE"

    cswarm setup --connection-file "$CONNECTION_FILE" \
      --profile "$PROFILE_PATH" --host-session-id manual --json >/dev/null
    WHOAMI_JSON="$(cswarm whoami --profile "$PROFILE_PATH" --json)"
    printf '%s' "$WHOAMI_JSON" | jq -e \
      --arg workspace "$WORKSPACE_ID" \
      --arg principal "$PRINCIPAL_ID" \
      '.credential_valid == true and
       .workspace_id == $workspace and
       .principal_id == $principal' >/dev/null

    find "$SEAT_DIR" -type f -exec chmod 600 {} +
    test -z "$(find "$SEAT_DIR" -type l -print -quit)"
    test -z "$(find "$SEAT_DIR" -type f ! -perm 0600 -print -quit)"
    test "$(stat -f '%Lp' "$SEAT_DIR")" = "700"
    test -f "$PROFILE_PATH"
    test ! -L "$PROFILE_PATH"
    printf "%s='yes'\n" "$READY_KEY" >>"$ACTIVE_STATE"
    printf '%s\n' "$ROLE seat ready" >/dev/null
  }

  create_seat sender "$SENDER_NAME" "$SENDER_DIR" "$SENDER_PROFILE" \
    SENDER_PRINCIPAL_ID SENDER_TOKEN_EXPIRES_AT SENDER_READY
  create_seat receiver "$RECEIVER_NAME" "$RECEIVER_DIR" "$RECEIVER_PROFILE" \
    RECEIVER_PRINCIPAL_ID RECEIVER_TOKEN_EXPIRES_AT RECEIVER_READY
  create_seat third "$THIRD_NAME" "$THIRD_DIR" "$THIRD_PROFILE" \
    THIRD_PRINCIPAL_ID THIRD_TOKEN_EXPIRES_AT THIRD_READY
  chmod 600 "$ACTIVE_STATE"
)
```

## 3. Run the S3/S4 baseline once

The one directed note has body exactly equal to `PREP_ID`. The receiver must see
that signal exactly once, its next check must be empty, the sender's receipt must
show `observed`, and the third seat must not see the signal. A failure means the
check or seats are faulty; run cleanup and keep Window A closed.

```sh
# step: hm37-prep-baseline-s3-s4
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only SSH child on box /bin/bash 5.2 as root
(
  set -euo pipefail
  umask 077
  ACTIVE_STATE="/Users/yulanbot/anvil-work/hm37-prep/active.env"
  test -f "$ACTIVE_STATE"
  test ! -L "$ACTIVE_STATE"
  test "$(stat -f '%Lp' "$ACTIVE_STATE")" = "600"
  . "$ACTIVE_STATE"
  test "$WORKSPACE_ID" = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
  test "$PREP_DIR" = "$PREP_ROOT/$PREP_ID"
  test "$SENDER_READY" = "yes"
  test "$RECEIVER_READY" = "yes"
  test "$THIRD_READY" = "yes"

  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  printf '%s' "$STATUS_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg user "$HUMAN_USER_ID" \
    '.identity.user_id == $user and
     .selected_project.workspace_id == $workspace and
     (.warnings | type == "array" and length == 0)' >/dev/null
  EDGE_CURRENT="$(ssh -o BatchMode=yes -o ConnectTimeout=10 ops@yulan-vps-1 \
    "sudo -n /bin/bash -c 'readlink -f /home/commonswarm/edge/current'")"
  test "$EDGE_CURRENT" = "/home/commonswarm/edge/releases/$EXPECTED_EDGE_SHA"

  for IDENTITY in \
    "$SENDER_PROFILE:$SENDER_PRINCIPAL_ID" \
    "$RECEIVER_PROFILE:$RECEIVER_PRINCIPAL_ID" \
    "$THIRD_PROFILE:$THIRD_PRINCIPAL_ID"
  do
    PROFILE_PATH="${IDENTITY%%:*}"
    PRINCIPAL_ID="${IDENTITY#*:}"
    WHOAMI_JSON="$(cswarm whoami --profile "$PROFILE_PATH" --json)"
    printf '%s' "$WHOAMI_JSON" | jq -e \
      --arg workspace "$WORKSPACE_ID" \
      --arg principal "$PRINCIPAL_ID" \
      '.credential_valid == true and
       .workspace_id == $workspace and
       .principal_id == $principal' >/dev/null
  done

  NOTE_JSON="$(cswarm note "$PREP_ID" --to "$RECEIVER_PRINCIPAL_ID" \
    --profile "$SENDER_PROFILE" --json)"
  SIGNAL_ID="$(printf '%s' "$NOTE_JSON" | jq -er \
    --arg marker "$PREP_ID" \
    '.signal | select(.body == $marker) | .id |
     select(type == "string" and test("^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"))')"

  RECEIVER_FIRST="$(cswarm check --profile "$RECEIVER_PROFILE" --full --json)"
  printf '%s' "$RECEIVER_FIRST" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg signal "$SIGNAL_ID" \
    --arg marker "$PREP_ID" \
    '.checked == true and .workspace_id == $workspace and
     ([.messages[] | select(.id == $signal and .body == $marker)] | length) == 1' \
    >/dev/null

  RECEIVER_SECOND="$(cswarm check --profile "$RECEIVER_PROFILE" --full --json)"
  printf '%s' "$RECEIVER_SECOND" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    '.checked == true and .workspace_id == $workspace and .messages == []' \
    >/dev/null

  RECEIPT_JSON="$(cswarm receipt "$SIGNAL_ID" \
    --profile "$SENDER_PROFILE" --json)"
  printf '%s' "$RECEIPT_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg signal "$SIGNAL_ID" \
    --arg receiver "$RECEIVER_PRINCIPAL_ID" \
    '.workspace_id == $workspace and .signal_id == $signal and
     ([.receipts[] |
       select(.recipient_agent_principal_id == $receiver and
              .state == "observed" and .outcome == "observed" and
              (.acked_at | type) == "string")] | length) == 1' >/dev/null

  THIRD_CHECK="$(cswarm check --profile "$THIRD_PROFILE" --full --json)"
  printf '%s' "$THIRD_CHECK" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg signal "$SIGNAL_ID" \
    --arg marker "$PREP_ID" \
    '.checked == true and .workspace_id == $workspace and
     ([.messages[] | select(.id == $signal or .body == $marker)] | length) == 0' \
    >/dev/null

  for SEAT_DIR in "$SENDER_DIR" "$RECEIVER_DIR" "$THIRD_DIR"
  do
    find "$SEAT_DIR" -type f -exec chmod 600 {} +
    test "$(stat -f '%Lp' "$SEAT_DIR")" = "700"
    test -z "$(find "$SEAT_DIR" -type l -print -quit)"
    test -z "$(find "$SEAT_DIR" -type f ! -perm 0600 -print -quit)"
  done
  printf "BASELINE_RESULT='pass'\n" >>"$ACTIVE_STATE"
  chmod 600 "$ACTIVE_STATE"
)
```

## 4. Final yes receipt

Run this block only when all prior blocks passed. It leaves the principals and
their private files in place for Window A. Its stdout is the derived named input
line that Anvil gives to Window A; it contains a path, not a credential.

```sh
# step: hm37-prep-final-yes
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  umask 077
  ACTIVE_STATE="/Users/yulanbot/anvil-work/hm37-prep/active.env"
  test -f "$ACTIVE_STATE"
  test ! -L "$ACTIVE_STATE"
  test "$(stat -f '%Lp' "$ACTIVE_STATE")" = "600"
  . "$ACTIVE_STATE"
  test "$WORKSPACE_ID" = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
  test "$PREP_DIR" = "$PREP_ROOT/$PREP_ID"
  test "$SENDER_READY" = "yes"
  test "$RECEIVER_READY" = "yes"
  test "$THIRD_READY" = "yes"
  test "$BASELINE_RESULT" = "pass"

  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  printf '%s' "$STATUS_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg user "$HUMAN_USER_ID" \
    '.identity.user_id == $user and
     .selected_project.workspace_id == $workspace and
     (.warnings | type == "array" and length == 0)' >/dev/null

  for SEAT_DIR in "$SENDER_DIR" "$RECEIVER_DIR" "$THIRD_DIR"
  do
    test -d "$SEAT_DIR"
    test ! -L "$SEAT_DIR"
    test "$(stat -f '%Lp' "$SEAT_DIR")" = "700"
    test -z "$(find "$SEAT_DIR" -type l -print -quit)"
    test -z "$(find "$SEAT_DIR" -type f ! -perm 0600 -print -quit)"
  done
  for PROFILE_PATH in "$SENDER_PROFILE" "$RECEIVER_PROFILE" "$THIRD_PROFILE"
  do
    test -f "$PROFILE_PATH"
    test ! -L "$PROFILE_PATH"
    test "$(stat -f '%Lp' "$PROFILE_PATH")" = "600"
  done

  PREP_RECEIPT_PATH="$PREP_DIR/prep-receipt.json"
  test ! -e "$PREP_RECEIPT_PATH"
  jq -n \
    --arg prep_id "$PREP_ID" \
    --arg created_at "$CREATED_AT" \
    --arg workspace_id "$WORKSPACE_ID" \
    --arg sender_id "$SENDER_PRINCIPAL_ID" \
    --arg sender_name "$SENDER_NAME" \
    --arg sender_profile "$SENDER_PROFILE" \
    --arg sender_expiry "$SENDER_TOKEN_EXPIRES_AT" \
    --arg receiver_id "$RECEIVER_PRINCIPAL_ID" \
    --arg receiver_name "$RECEIVER_NAME" \
    --arg receiver_profile "$RECEIVER_PROFILE" \
    --arg receiver_expiry "$RECEIVER_TOKEN_EXPIRES_AT" \
    --arg third_id "$THIRD_PRINCIPAL_ID" \
    --arg third_name "$THIRD_NAME" \
    --arg third_profile "$THIRD_PROFILE" \
    --arg third_expiry "$THIRD_TOKEN_EXPIRES_AT" '
      {schema: 1, prep_result: "yes", prep_id: $prep_id,
       created_at: $created_at, workspace_id: $workspace_id,
       seats: [
         {role: "sender", principal_id: $sender_id, name: $sender_name,
          profile_path: $sender_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: $sender_expiry},
         {role: "receiver", principal_id: $receiver_id, name: $receiver_name,
          profile_path: $receiver_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: $receiver_expiry},
         {role: "third", principal_id: $third_id, name: $third_name,
          profile_path: $third_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: $third_expiry}
       ],
       baseline_result: "pass"}
    ' >"$PREP_RECEIPT_PATH"
  chmod 600 "$PREP_RECEIPT_PATH"
  jq -e \
    --arg prep_id "$PREP_ID" \
    --arg workspace "$WORKSPACE_ID" \
    '.prep_result == "yes" and .prep_id == $prep_id and
     .workspace_id == $workspace and .baseline_result == "pass" and
     (.seats | length) == 3 and
     ([.seats[].principal_id | select(type == "string" and length == 36)] | length) == 3' \
    "$PREP_RECEIPT_PATH" >/dev/null
  printf "PREP_RECEIPT_PATH='%s'\n" "$PREP_RECEIPT_PATH"
)
```

## 5. Final no receipt and failure cleanup

This is the failure-only tail. It attempts revocation for every nonempty
principal ID persisted by this run, then requires `cswarm status` to report
`revoked=true` for each. It never reads a seat profile. It deletes only the
resolved current run directory, and only after refusing an empty path, `/`, the
Mac user's home, a path outside the fixed preparation root, a symlink, or a
basename different from `PREP_ID`. A guard refusal leaves the directory in
place. The failure receipt is written outside that directory, so it records
revocation and deletion outcomes even after a successful delete.

```sh
# step: hm37-prep-final-no-cleanup
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  umask 077
  ACTIVE_STATE="/Users/yulanbot/anvil-work/hm37-prep/active.env"
  test -f "$ACTIVE_STATE"
  test ! -L "$ACTIVE_STATE"
  test "$(stat -f '%Lp' "$ACTIVE_STATE")" = "600"
  . "$ACTIVE_STATE"
  test "$WORKSPACE_ID" = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
  test "$PREP_ROOT" = "/Users/yulanbot/anvil-work/hm37-prep"
  test "$PREP_DIR" = "$PREP_ROOT/$PREP_ID"

  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  printf '%s' "$STATUS_JSON" | jq -e \
    --arg workspace "$WORKSPACE_ID" \
    --arg user "$HUMAN_USER_ID" \
    '.identity.user_id == $user and
     .selected_project.workspace_id == $workspace and
     (.warnings | type == "array" and length == 0)' >/dev/null

  REVOKE_RESULT="pass"
  revoke_one() {
    PRINCIPAL_ID="$1"
    if [ -z "$PRINCIPAL_ID" ]; then
      return 0
    fi
    ALREADY_REVOKED="$(printf '%s' "$STATUS_JSON" | jq -r \
      --arg id "$PRINCIPAL_ID" \
      '[.agents[] | select(.principal_id == $id and .revoked == true)] | length')"
    if [ "$ALREADY_REVOKED" = "0" ]; then
      if ! cswarm principal revoke --workspace-id "$WORKSPACE_ID" \
        --principal-id "$PRINCIPAL_ID" --json >/dev/null
      then
        REVOKE_RESULT="fail"
        return 0
      fi
    fi
    READBACK="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
    if ! printf '%s' "$READBACK" | jq -e \
      --arg workspace "$WORKSPACE_ID" \
      --arg user "$HUMAN_USER_ID" \
      --arg id "$PRINCIPAL_ID" \
      '.identity.user_id == $user and
       .selected_project.workspace_id == $workspace and
       (.warnings | type == "array" and length == 0) and
       ([.agents[] | select(.principal_id == $id and .revoked == true)] | length) == 1' \
      >/dev/null
    then
      REVOKE_RESULT="fail"
    fi
  }

  revoke_one "$SENDER_PRINCIPAL_ID"
  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  revoke_one "$RECEIVER_PRINCIPAL_ID"
  STATUS_JSON="$(cswarm status --workspace-id "$WORKSPACE_ID" --json)"
  revoke_one "$THIRD_PRINCIPAL_ID"

  DELETE_RESULT="refused"
  DELETE_REASON="guard"
  RESOLVED_ROOT=""
  RESOLVED_PREP_DIR=""
  if [ -d "$PREP_ROOT" ] && [ ! -L "$PREP_ROOT" ]; then
    RESOLVED_ROOT="$(cd "$PREP_ROOT" && pwd -P)"
  fi
  if [ -n "$RESOLVED_ROOT" ] && [ -d "$PREP_DIR" ] && [ ! -L "$PREP_DIR" ]; then
    RESOLVED_PREP_DIR="$(cd "$PREP_DIR" && pwd -P)"
  fi
  if [ -n "$RESOLVED_PREP_DIR" ] && \
     [ "$RESOLVED_PREP_DIR" != "/" ] && \
     [ "$RESOLVED_PREP_DIR" != "$HOME" ] && \
     [ "$RESOLVED_PREP_DIR" = "$RESOLVED_ROOT/$PREP_ID" ] && \
     [ "${RESOLVED_PREP_DIR%/*}" = "$RESOLVED_ROOT" ] && \
     [ "${RESOLVED_PREP_DIR##*/}" = "$PREP_ID" ]
  then
    if /bin/rm -R -- "$RESOLVED_PREP_DIR"; then
      DELETE_RESULT="removed"
      DELETE_REASON="guarded-delete-complete"
    else
      DELETE_RESULT="failed"
      DELETE_REASON="guarded-delete-error"
    fi
  elif [ ! -e "$PREP_DIR" ]; then
    DELETE_RESULT="absent"
    DELETE_REASON="already-absent"
  fi

  FAILURE_RECEIPT="$PREP_ROOT/failed-$PREP_ID.json"
  jq -n \
    --arg prep_id "$PREP_ID" \
    --arg created_at "$CREATED_AT" \
    --arg workspace_id "$WORKSPACE_ID" \
    --arg sender_id "$SENDER_PRINCIPAL_ID" \
    --arg sender_name "$SENDER_NAME" \
    --arg sender_profile "$SENDER_PROFILE" \
    --arg sender_expiry "$SENDER_TOKEN_EXPIRES_AT" \
    --arg receiver_id "$RECEIVER_PRINCIPAL_ID" \
    --arg receiver_name "$RECEIVER_NAME" \
    --arg receiver_profile "$RECEIVER_PROFILE" \
    --arg receiver_expiry "$RECEIVER_TOKEN_EXPIRES_AT" \
    --arg third_id "$THIRD_PRINCIPAL_ID" \
    --arg third_name "$THIRD_NAME" \
    --arg third_profile "$THIRD_PROFILE" \
    --arg third_expiry "$THIRD_TOKEN_EXPIRES_AT" \
    --arg baseline_result "$BASELINE_RESULT" \
    --arg revoke_result "$REVOKE_RESULT" \
    --arg delete_result "$DELETE_RESULT" \
    --arg delete_reason "$DELETE_REASON" '
      def optional($value): if $value == "" then null else $value end;
      {schema: 1, prep_result: "no", prep_id: $prep_id,
       created_at: $created_at, workspace_id: $workspace_id,
       seats: [
         {role: "sender", principal_id: optional($sender_id), name: $sender_name,
          profile_path: $sender_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: optional($sender_expiry)},
         {role: "receiver", principal_id: optional($receiver_id), name: $receiver_name,
          profile_path: $receiver_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: optional($receiver_expiry)},
         {role: "third", principal_id: optional($third_id), name: $third_name,
          profile_path: $third_profile, directory_mode: "0700",
          files_mode: "0600", token_expires_at: optional($third_expiry)}
       ],
       baseline_result: $baseline_result,
       cleanup: {revocation: $revoke_result, directory: $delete_result,
                 reason: $delete_reason}}
    ' >"$FAILURE_RECEIPT"
  chmod 600 "$FAILURE_RECEIPT"

  if [ "$REVOKE_RESULT" = "pass" ] && \
     { [ "$DELETE_RESULT" = "removed" ] || [ "$DELETE_RESULT" = "absent" ]; }
  then
    test "$ACTIVE_STATE" = "$PREP_ROOT/active.env"
    /bin/rm -- "$ACTIVE_STATE"
  else
    exit 1
  fi
)
```

## Receipt consumed by Window A

The success receipt schema is `schema=1`, `prep_result=yes`, `prep_id`,
`created_at`, `workspace_id`, three `seats` records, and
`baseline_result=pass`. Each seat record contains only its role, principal ID,
unique name, profile path, directory/file modes, and token expiry time. It has
no anon key, bearer, credential document, run ID, task ID, signal body, or
signal ID.

Window A takes one named prompt input, `PREP_RECEIPT_PATH`, equal to the exact
path printed by `hm37-prep-final-yes`. Its open block must validate that receipt
and run `cswarm whoami --profile ... --json` for all three profiles before any
Window A change. Each result must report `credential_valid=true`, workspace
`c2ea0541-f56d-4c73-bf71-56c5405c4934`, and the receipt's matching principal
ID. Any invalid result is a STOP. Window A must begin before all three 24-hour
expiry times in the receipt.

Window A's close owns S2 cleanup. It must run `cswarm principal revoke
--workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --principal-id ... --json`
for each of the three receipt IDs, read back `revoked=true` for every ID with
`cswarm status --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --json`,
and run a read-only box query against `swarm.agent_tokens` for exactly those
three IDs. A left join from the three expected IDs must return three rows, each
with zero tokens satisfying `revoked_at IS NULL AND expires_at > now()`. Window
A is not closed until all three controls pass.
