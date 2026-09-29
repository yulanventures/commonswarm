#!/bin/bash
set -euo pipefail

name=${0##*/}
: "${BOX_DRY_RUN_STUB_LOG:?stub log required}"
printf '%s' "$name" >>"$BOX_DRY_RUN_STUB_LOG"
printf ' %q' "$@" >>"$BOX_DRY_RUN_STUB_LOG"
printf '\n' >>"$BOX_DRY_RUN_STUB_LOG"

fail_unproduced() {
  printf 'UNPRODUCED %s\n' "$1" >&2
  exit 69
}

cswarm_state_dir="${BOX_DRY_RUN_STUB_LOG}.cswarm-state"

case "$name" in
  ssh)
    counter=${BOX_DRY_RUN_SSH_COUNTER_FILE:-}
    count=0
    if [ -n "$counter" ]; then
      [ ! -f "$counter" ] || count=$(cat "$counter")
      count=$((count + 1))
      printf '%s\n' "$count" >"$counter"
    fi
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o|-i|-p|-F|-J) [ "$#" -ge 2 ] || fail_unproduced 'ssh flags'; shift 2 ;;
        --) shift; break ;;
        -*) shift ;;
        *) ssh_host=$1; shift; break ;;
      esac
    done
    [ -n "${ssh_host:-}" ] || fail_unproduced 'ssh host'
    remote_command="$*"
    case "$remote_command" in
      *'/bin/bash -s'*|*'bash -s'*)
        if [ "${BOX_DRY_RUN_PART:-mac}" = box ]; then
          # The box lane has the real box-shaped fixture tree. Execute the remote
          # command there; PATH still resolves every external boundary to this
          # same stub set.
          exec /bin/bash -c "$remote_command"
        fi
        remote_input=$(cat)
        case "$remote_input" in
          *'root=/srv/commonswarm/site'*'BOX_EGRESS=PASS'*)
            # Shape sources: M15 (live release and readable app/download files)
            # and M13 (200 JSON/HTML egress with the explicit probe UA) in the
            # measured box-facts JSON artifact.
            base=${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}
            printf '%s\n' \
              'SITE_WINDOW_START_UTC=2026-09-28T01:02:03Z' \
              'SITE_WINDOW_END_UTC=2026-09-28T05:02:03Z' \
              "PREVIOUS_RELEASE=/srv/commonswarm/site/releases/$base" \
              "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/app/index.html" \
              "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/download/index.html" \
              'BOX_EGRESS=PASS user_agent=commonswarm-release-probe/1.0'
            ;;
          *'find /home/commonswarm/stack/release-proofs'*"date -u -d '+4 hours'"*)
            # The two-line clock shape is the recorded box-clock contract in
            # the reviewed HM37 box-window evidence, lines 436-444.
            printf '%s\n' '2026-09-28T01:02:03Z' '2026-09-28T05:02:03Z'
            ;;
          *'PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"'*'SWARM_MCP_PUBLIC_ENABLED'*)
            # This exact B-open remote block has no stdout. Its durable box
            # state is exercised in the box half; the Mac half only verifies
            # that the reviewed remote command is accepted by the transport.
            ;;
          *) fail_unproduced 'ssh remote shell output' ;;
        esac
        ;;
      *'readlink -f /home/commonswarm/edge/current'*)
        # M5 in box-facts-measured.json records this exact symlink target.
        printf '%s\n' "${BOX_DRY_RUN_EXPECTED_EDGE:?measured edge required}"
        ;;
      "date -u +%Y-%m-%dT%H:%M:%SZ"|"date -u '+%Y-%m-%dT%H:%M:%SZ'")
        # The output format is the box-clock contract cited above.
        printf '%s\n' '2026-09-28T01:02:03Z'
        ;;
      *'readlink -f /srv/commonswarm/site/current'*)
        # M15 in box-facts-measured.json records the live site release.
        printf '/srv/commonswarm/site/releases/%s\n' "${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}"
        ;;
      *'test '*'/srv/commonswarm/site/'*) ;;
      *) fail_unproduced 'ssh output' ;;
    esac
    ;;
  scp)
    [ "$#" -eq 2 ] || fail_unproduced 'scp flags'
    case "$2" in
      ops@100.115.66.74:/tmp/*|commonswarm@yulan-vps-1:/tmp/*)
        cp "$1" "${2#*:}"
        ;;
      *) fail_unproduced 'scp target' ;;
    esac
    ;;
  chown|caddy)
    printf 'UNPRODUCED %s result\n' "$name" >&2
    exit 69
    ;;
  sudo)
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -u) shift 2 ;;
        -n|-i) shift ;;
        --) shift; break ;;
        *) break ;;
      esac
    done
    [ "$#" -eq 0 ] || exec "$@"
    ;;
  op)
    printf '%s\n' 'UNPRODUCED credential input' >&2
    exit 69
    ;;
  systemctl)
    case " $* " in
      *' is-active --quiet '*) ;;
      *' is-active '*) printf '%s\n' inactive ;;
      *' show '*) printf '%s\n' success ;;
    esac
    ;;
  docker)
    case " $* " in
      *' ps -q '*)
        case " $* " in
          *'com.docker.compose.project=commonswarm-oauth'*) printf '%s\n' dry-run-oauth ;;
          *'com.docker.compose.service=postgres'*) printf '%s\n' dry-run-postgres ;;
          *) printf '%s\n' dry-run-edge ;;
        esac
        ;;
      *' inspect '*'.Config.Env'*) printf '%s\n' "${BOX_DRY_RUN_OAUTH_DATABASE_HOST_LINE:?OAuth host line required}" ;;
      *' inspect '*'.Image'*)
        case "${@: -1}" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_IMAGE:?OAuth image required}" ;;
          dry-run-postgres) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}" ;;
          *) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}" ;;
        esac
        ;;
      *' inspect '*Health.Status*|*' inspect '*State.Health*)
        case "${@: -1}" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_HEALTH:?OAuth health required}" ;;
          *) printf '%s\n' "${BOX_DRY_RUN_EDGE_HEALTH:?edge health required}" ;;
        esac
        ;;
      *' inspect '*HostConfig.Memory*) printf '%s\n' "${BOX_DRY_RUN_EDGE_MEMORY:?edge memory required}" ;;
      *' inspect '*HostConfig.NetworkMode*) printf '%s\n' "${BOX_DRY_RUN_EDGE_NETWORK:?edge network required}" ;;
      *' inspect '*Mounts*) printf '%s\n' "${BOX_DRY_RUN_EDGE_MOUNTS:?edge mounts required}" ;;
      *' inspect '*working_dir*)
        case "${@: -1}" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_WORKDIR:?OAuth workdir required}" ;;
          *)
            if grep -q '^docker compose .* up .*edge-runtime' "$BOX_DRY_RUN_STUB_LOG"; then
              printf '%s\n' "${BOX_DRY_RUN_CANDIDATE_EDGE:?candidate edge required}/deploy/edge-runtime"
            else
              printf '%s\n' "${BOX_DRY_RUN_EDGE_WORKDIR:?edge workdir required}"
            fi
            ;;
        esac
        ;;
      *' image inspect '*) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}" ;;
      *' run '*)
        printf '%s\n' 'UNPRODUCED database observation' >&2
        exit 69
        ;;
    esac
    ;;
  curl)
    case " $* " in
      *'https://github.com/denoland/deno/releases/download/'*|*'https://release-assets.githubusercontent.com/'*)
      output=''
      headers=''
      head_only=0
      previous=''
      for argument in "$@"; do
        if [ "$previous" = --output ]; then output=$argument; fi
        if [ "$previous" = --dump-header ]; then headers=$argument; fi
        if [ "$argument" = --head ]; then head_only=1; fi
        previous=$argument
      done
      test -n "$output"
      if [ "$head_only" -eq 1 ]; then
        test -n "$headers"
        printf '%s\r\n' 'HTTP/2 302' 'location: https://release-assets.githubusercontent.com/dry-run/deno.zip' >"$headers"
        exit 0
      fi
      cp "${BOX_DRY_RUN_DENO_ZIP_FIXTURE:?Deno zip fixture required}" "$output"
      printf '%s\n' 'https://release-assets.githubusercontent.com/dry-run/deno.zip'
      exit 0
      ;;
    esac
    case " $* " in
      *'127.0.0.1:'*' --data '*|*'127.0.0.1:'*' --data-binary '*|*'127.0.0.1:'*' -d '*)
      printf '%s\n' 'UNPRODUCED loopback POST response' >&2
      exit 69
      ;;
    esac
    case " $* " in
      *'127.0.0.1:'*) printf '%s\n' '{"status":"ok"}'; exit 0 ;;
    esac
    explicit=0
    for argument in "$@"; do
      case "$argument" in
        *User-Agent*|*user-agent*) explicit=1 ;;
      esac
    done
    if [ "$explicit" -eq 1 ]; then
      printf '%s\n' '{"stub":true,"status":200}'
    else
      printf '%s\n' 'error code: 1010'
      exit 22
    fi
    ;;
  psql)
    previous=''
    for argument in "$@"; do
      if [ "$previous" = --file ]; then
        case "$argument" in
          /proof/*|/run/commonswarm-release-apply.sql) ;;
          *) printf '%s\n' 'psql stub: --file must use the bind-mounted container path' >&2; exit 64 ;;
        esac
      fi
      previous=$argument
    done
    printf '%s\n' 'UNPRODUCED database observation' >&2
    exit 69
    ;;
  python3)
    exec /usr/bin/env PYTHONPATH="${BOX_DRY_RUN_PYTHON_FIXTURE:?Python fixture path required}" /usr/bin/python3 "$@"
    ;;
  tar)
    exec /usr/bin/tar "$@"
    ;;
  deno)
    if [ -n "${BOX_DRY_RUN_FAIL_STEP:-}" ] && [ "${BOX_DRY_RUN_FAIL_STEP}" = "${BOX_DRY_RUN_STEP:-}" ]; then
      if [ "${BOX_DRY_RUN_FAIL_STEP:-}" = hm37-hosted-open-ack-control ]; then
        journal="/home/commonswarm/edge/controls/${BOX_DRY_RUN_RELEASE_SHA:?release SHA required}-${BOX_DRY_RUN_WINDOW_ID:?window ID required}/journal/hm37-open-ack-010203.journal.json"
        mkdir -p "${journal%/*}"
        printf '%s\n' '{}' >"$journal"
        chmod 0600 "$journal"
      fi
      printf 'injected dry-run failure: %s\n' "${BOX_DRY_RUN_STEP:-}" >&2
      exit 41
    fi
    case " $* " in
      *' --version '*) printf '%s\n' "${BOX_DRY_RUN_DENO_VERSION:-deno 2.4.5
v8 13.7.152.14-rusty
typescript 5.8.3}" ;;
      *' cache '*) ;;
      *) printf '%s\n' 'UNPRODUCED embedded Deno program result' >&2; exit 69 ;;
    esac
    ;;
  sleep)
    ;;
  cswarm)
    mkdir -p "$cswarm_state_dir"
    chmod 700 "$cswarm_state_dir"
    command_name=${1:-}
    [ -n "$command_name" ] || fail_unproduced 'cswarm command'
    shift
    case "$command_name" in
      status)
        workspace=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --workspace-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm status flags'; workspace=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm status flags' ;;
          esac
        done
        [ -n "$workspace" ] || fail_unproduced 'cswarm status workspace'
        # Output shape: src/cli.ts:2112-2132.
        /usr/bin/python3 - "$workspace" "$cswarm_state_dir/principals.tsv" <<'PY'
import json, pathlib, sys
workspace, state = sys.argv[1:]
agents = []
path = pathlib.Path(state)
if path.exists():
    for raw in path.read_text().splitlines():
        principal, revoked = raw.split("\t")
        agents.append({"principal_id": principal, "revoked": revoked == "true"})
print(json.dumps({
    "identity": {"user_id": "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"},
    "selected_project": {"workspace_id": workspace},
    "warnings": [], "agents": agents,
}, separators=(",", ":")))
PY
        ;;
      principal)
        action=${1:-}; [ -n "$action" ] || fail_unproduced 'cswarm principal command'; shift
        workspace=''; principal=''; seat_name=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --workspace-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm principal flags'; workspace=$2; shift 2 ;;
            --principal-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm principal flags'; principal=$2; shift 2 ;;
            --name) [ "$#" -ge 2 ] || fail_unproduced 'cswarm principal flags'; seat_name=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm principal flags' ;;
          esac
        done
        [ -n "$workspace" ] || fail_unproduced 'cswarm principal workspace'
        case "$action" in
          create)
            [ -n "$seat_name" ] && [ -z "$principal" ] || fail_unproduced 'cswarm principal create arguments'
            counter_file="$cswarm_state_dir/principal-counter"
            principal_count=0
            [ ! -f "$counter_file" ] || principal_count=$(cat "$counter_file")
            principal_count=$((principal_count + 1))
            printf '%s\n' "$principal_count" >"$counter_file"
            principal=$(printf '10000000-0000-4000-8000-%012d' "$principal_count")
            printf '%s\tfalse\n' "$principal" >>"$cswarm_state_dir/principals.tsv"
            # Output shape: src/cli.ts:2544-2568.
            printf '{"message":"Agent identity created.","status":"accepted","principal_id":"%s"}\n' "$principal"
            ;;
          revoke)
            [ -n "$principal" ] && [ -z "$seat_name" ] || fail_unproduced 'cswarm principal revoke arguments'
            /usr/bin/python3 - "$cswarm_state_dir/principals.tsv" "$principal" <<'PY'
import pathlib, sys
path, wanted = pathlib.Path(sys.argv[1]), sys.argv[2]
rows = []
found = False
if path.exists():
    for raw in path.read_text().splitlines():
        principal, revoked = raw.split("\t")
        if principal == wanted:
            revoked, found = "true", True
        rows.append((principal, revoked))
if not found:
    rows.append((wanted, "true"))
path.write_text("".join(f"{principal}\t{revoked}\n" for principal, revoked in rows))
PY
            # Output shape: src/cli.ts:2583-2608.
            printf '{"message":"Agent identity revoked.","status":"accepted","principal_id":"%s","command_event_ids":["30000000-0000-4000-8000-000000000001"]}\n' "$principal"
            ;;
          *) fail_unproduced 'cswarm principal command' ;;
        esac
        ;;
      token)
        action=${1:-}; shift || true
        [ "$action" = mint ] || fail_unproduced 'cswarm token command'
        workspace=''; principal=''; run_id=''; task_id=''; epoch=''; ttl=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --workspace-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; workspace=$2; shift 2 ;;
            --principal-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; principal=$2; shift 2 ;;
            --run-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; run_id=$2; shift 2 ;;
            --task-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; task_id=$2; shift 2 ;;
            --epoch) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; epoch=$2; shift 2 ;;
            --ttl-ms) [ "$#" -ge 2 ] || fail_unproduced 'cswarm token flags'; ttl=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm token flags' ;;
          esac
        done
        [ -n "$workspace" ] && [ -n "$principal" ] && [ -n "$run_id" ] && [ -n "$task_id" ] && [ -n "$epoch" ] && [ -n "$ttl" ] \
          || fail_unproduced 'cswarm token mint arguments'
        # Output shape: agentCredentialArtifact at src/cli.ts:1177-1195.
        printf '{"message":"Agent credential minted.","status":"accepted","principal_id":"%s","token_id":"40000000-0000-4000-8000-%s","run_id":"%s","agent_token":"swm_agent_dry_run_%s","expires_at":"2099-01-01T00:00:00.000Z"}\n' \
          "$principal" "${principal##*-}" "$run_id" "${principal##*-}"
        ;;
      target)
        action=${1:-show}
        if [ "$#" -gt 0 ]; then shift; fi
        [ "$action" = show ] || fail_unproduced 'cswarm target command'
        while [ "$#" -gt 0 ]; do
          case "$1" in --reveal-anon-key|--json) shift ;; *) fail_unproduced 'cswarm target flags' ;; esac
        done
        # Output shape: src/cli.ts:1924-1944.
        printf '%s\n' '{"current_target":{"url":"https://api.commonswarm.com","anon_key_fingerprint":"dry-run","anon_key":"dry-run-anon-key"}}'
        ;;
      setup)
        connection=''; profile=''; host_session=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --connection-file) [ "$#" -ge 2 ] || fail_unproduced 'cswarm setup flags'; connection=$2; shift 2 ;;
            --profile) [ "$#" -ge 2 ] || fail_unproduced 'cswarm setup flags'; profile=$2; shift 2 ;;
            --host-session-id) [ "$#" -ge 2 ] || fail_unproduced 'cswarm setup flags'; host_session=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm setup flags' ;;
          esac
        done
        [ -n "$connection" ] && [ -n "$profile" ] && [ -n "$host_session" ] || fail_unproduced 'cswarm setup arguments'
        # File shapes and 0600 writes: src/cloud/agent-profile.ts:290-349.
        # JSON result shape: src/cloud/agent-setup.ts:74-98.
        /usr/bin/python3 - "$connection" "$profile" <<'PY'
import json, os, pathlib, sys
connection_path, profile_path = map(pathlib.Path, sys.argv[1:])
connection = json.loads(connection_path.read_text())
credential_path = profile_path.parent / "credential.json"
profile = {
    "version": 1, "url": connection["url"], "anon_key": connection["anon_key"],
    "workspace_id": connection["workspace_id"], "principal_id": connection["principal_id"],
    "credential_file": str(credential_path),
}
profile_path.write_text(json.dumps(profile, separators=(",", ":")))
credential_path.write_text(json.dumps(connection["credential"], separators=(",", ":")))
os.chmod(profile_path, 0o600)
os.chmod(credential_path, 0o600)
print(json.dumps({"setup_version": 1, "connected": True, "profile": str(profile_path),
    "principal_id": connection["principal_id"], "workspace_id": connection["workspace_id"]}, separators=(",", ":")))
PY
        ;;
      whoami)
        profile=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --profile) [ "$#" -ge 2 ] || fail_unproduced 'cswarm whoami flags'; profile=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm whoami flags' ;;
          esac
        done
        [ -n "$profile" ] || fail_unproduced 'cswarm whoami profile'
        # Output shape: src/cli.ts:4619-4638.
        /usr/bin/python3 - "$profile" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
print(json.dumps({"credential_valid": True, "workspace_id": profile["workspace_id"],
    "principal_id": profile["principal_id"]}, separators=(",", ":")))
PY
        ;;
      note)
        [ "$#" -gt 0 ] || fail_unproduced 'cswarm note body'
        body=$1; shift; recipient=''; profile=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --to) [ "$#" -ge 2 ] || fail_unproduced 'cswarm note flags'; recipient=$2; shift 2 ;;
            --profile) [ "$#" -ge 2 ] || fail_unproduced 'cswarm note flags'; profile=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm note flags' ;;
          esac
        done
        [ -n "$recipient" ] && [ -n "$profile" ] || fail_unproduced 'cswarm note arguments'
        signal='20000000-0000-4000-8000-000000000001'
        /usr/bin/python3 - "$cswarm_state_dir/pending.json" "$signal" "$body" "$recipient" <<'PY'
import json, pathlib, sys
pathlib.Path(sys.argv[1]).write_text(json.dumps({"id": sys.argv[2], "body": sys.argv[3], "recipient": sys.argv[4]}))
PY
        rm -f "$cswarm_state_dir/pending-consumed"
        # Output shape: src/cli.ts:10750-10764.
        /usr/bin/python3 - "$signal" "$body" <<'PY'
import json, sys
print(json.dumps({"signal": {"id": sys.argv[1], "body": sys.argv[2]}}, separators=(",", ":")))
PY
        ;;
      check)
        profile=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --profile) [ "$#" -ge 2 ] || fail_unproduced 'cswarm check flags'; profile=$2; shift 2 ;;
            --full|--json) shift ;;
            *) fail_unproduced 'cswarm check flags' ;;
          esac
        done
        [ -n "$profile" ] || fail_unproduced 'cswarm check profile'
        # Output shapes: src/cloud/agent-check.ts:285-310 and :389-428.
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/pending.json" "$cswarm_state_dir/pending-consumed" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
pending_path, consumed_path = map(pathlib.Path, sys.argv[2:])
messages = []
if pending_path.exists() and not consumed_path.exists():
    pending = json.loads(pending_path.read_text())
    if pending["recipient"] == profile["principal_id"]:
        messages.append({"id": pending["id"], "body": pending["body"]})
        consumed_path.write_text("observed\n")
print(json.dumps({"checked": True, "workspace_id": profile["workspace_id"], "messages": messages}, separators=(",", ":")))
PY
        ;;
      receipt)
        [ "$#" -gt 0 ] || fail_unproduced 'cswarm receipt signal'
        signal=$1; shift; profile=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --profile) [ "$#" -ge 2 ] || fail_unproduced 'cswarm receipt flags'; profile=$2; shift 2 ;;
            --json) shift ;;
            *) fail_unproduced 'cswarm receipt flags' ;;
          esac
        done
        [ -n "$profile" ] || fail_unproduced 'cswarm receipt profile'
        # Output shape: src/cloud/receipts.ts:275-305.
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/pending.json" "$signal" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
pending = json.loads(pathlib.Path(sys.argv[2]).read_text())
print(json.dumps({"workspace_id": profile["workspace_id"], "signal_id": sys.argv[3], "receipts": [{
    "recipient_agent_principal_id": pending["recipient"], "state": "observed", "outcome": "observed",
    "acked_at": "2026-09-29T01:03:00Z"}]}, separators=(",", ":")))
PY
        ;;
      *) fail_unproduced 'cswarm command' ;;
    esac
    ;;
  *)
    printf 'unhandled dry-run stub: %s\n' "$name" >&2
    exit 69
    ;;
esac
