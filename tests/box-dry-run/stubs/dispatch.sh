#!/bin/bash
set -euo pipefail

name=${0##*/}
original_argv=("$@")
: "${BOX_DRY_RUN_STUB_LOG:?stub log required}"
printf '%s' "$name" >>"$BOX_DRY_RUN_STUB_LOG"
printf ' %q' "$@" >>"$BOX_DRY_RUN_STUB_LOG"
printf '\n' >>"$BOX_DRY_RUN_STUB_LOG"

fail_unproduced() {
  printf 'UNPRODUCED %s\n' "$1" >&2
  exit 69
}

unhandled_stub() {
  printf 'unhandled dry-run stub: %s' "$name" >&2
  printf ' %q' "${original_argv[@]}" >&2
  printf '\n' >&2
  exit 69
}

cswarm_state_dir="${BOX_DRY_RUN_STUB_LOG}.cswarm-state"
stub_state_dir="${BOX_DRY_RUN_STUB_LOG}.stub-state"

box_fixture_root() {
  mkdir -p "$stub_state_dir"
  resolved_stub_state_dir=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$stub_state_dir")
  fixture_root_file="$stub_state_dir/ssh-fixture-root"
  if [ -f "$fixture_root_file" ]; then
    fixture_root=$(cat "$fixture_root_file")
  else
    fixture_root=$(mktemp -d "$stub_state_dir/ssh-box.XXXXXX")
    fixture_root=$(/usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$fixture_root")
    printf '%s\n' "$fixture_root" >"$fixture_root_file"
  fi
  case "$fixture_root" in
    "$resolved_stub_state_dir"/ssh-box.??????) ;;
    *) printf 'refusing unsafe fixture root: %s\n' "$fixture_root" >&2; exit 70 ;;
  esac
  printf '%s\n' "$fixture_root"
}

seed_box_fixture() {
  fixture_root=$(box_fixture_root)
  fixture_sha=${BOX_DRY_RUN_RELEASE_SHA:?fixture release SHA required}
  case "$fixture_sha" in *[!0-9a-f]*|'') fail_unproduced 'ssh fixture release SHA' ;; esac
  [ "${#fixture_sha}" -eq 40 ] || fail_unproduced 'ssh fixture release SHA'
  fixture_proof="$fixture_root/home/commonswarm/stack/release-proofs/$fixture_sha"
  mkdir -p "$fixture_proof"

  # Each fixture is copied byte-for-byte from its committed execution evidence:
  # ./docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-worker-boundary.txt
  # ./docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-hosted-control-inputs.txt
  # ./docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-hosted-check-control.json
  # ./docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-revocation-readback.json
  # ./docs/evidence/2026-09-29-release-eb2a87ac4b5a/hm37-close-readback.txt
  fixture_evidence=${BOX_DRY_RUN_COPYBACK_EVIDENCE_DIR:?copy-back evidence fixture required}
  for fixture_member in \
    hm37-worker-boundary.txt \
    hm37-hosted-control-inputs.txt \
    hm37-hosted-check-control.json \
    hm37-revocation-readback.json \
    hm37-close-readback.txt; do
    [ -f "$fixture_evidence/$fixture_member" ] || fail_unproduced 'ssh fixture evidence'
    if [ ! -e "$fixture_proof/$fixture_member" ]; then
      /bin/cp "$fixture_evidence/$fixture_member" "$fixture_proof/$fixture_member"
      chmod 0600 "$fixture_proof/$fixture_member"
    fi
  done

  # M15 in docs/evidence/2026-09-29-box-facts/box-facts-measured.json
  # records the current site release. The committed site release evidence at
  # docs/evidence/2026-09-27-release-9b085c823523 carries the app/download tree
  # shape copied by site-03-pin-previous.
  fixture_site_root="$fixture_root/srv/commonswarm/site"
  fixture_site_release="$fixture_site_root/releases/${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}"
  if [ ! -e "$fixture_site_root/current" ] && [ ! -L "$fixture_site_root/current" ]; then
    mkdir -p "$fixture_site_release/app" "$fixture_site_release/download"
    printf '%s\n' 'dry-run measured app entry' >"$fixture_site_release/app/index.html"
    printf '%s\n' 'dry-run measured download entry' >"$fixture_site_release/download/index.html"
    ln -s "$fixture_site_release" "$fixture_site_root/current"
  fi

  printf '%s\n' "$fixture_root"
}

run_box_fixture_script() {
  remote_input=$1
  shift
  remote_arguments=()
  remote_shell_command=
  if [ "$#" -eq 1 ]; then
    remote_shell_command=$1
  else
    [ "$#" -ge 4 ] && [ "$1" = /bin/bash ] && [ "$2" = -s ] && [ "$3" = -- ] || \
      fail_unproduced 'ssh remote shell output'
    shift 3
    [ "$#" -gt 0 ] || fail_unproduced 'ssh remote shell argument'
    remote_arguments=("$@")
  fi

  fixture_root=$(seed_box_fixture)
  fixture_sha=${BOX_DRY_RUN_RELEASE_SHA:?fixture release SHA required}
  fixture_proof="$fixture_root/home/commonswarm/stack/release-proofs/$fixture_sha"
  if [ -n "$remote_shell_command" ]; then
    parsed_arguments="$fixture_root/remote-arguments"
    if ! /usr/bin/python3 - "$remote_shell_command" >"$parsed_arguments" <<'PY'
import shlex, sys
parts = shlex.split(sys.argv[1])
if parts[:6] != ["sudo", "-n", "-i", "/bin/bash", "-s", "--"] or len(parts) < 7:
    raise SystemExit(1)
for value in parts[6:]:
    if "\n" in value or "\r" in value:
        raise SystemExit(1)
    print(value)
PY
    then
      fail_unproduced 'ssh remote shell output'
    fi
    while IFS= read -r remote_argument || [ -n "$remote_argument" ]; do
      [ -n "$remote_argument" ] || fail_unproduced 'ssh remote shell argument'
      remote_arguments+=("$remote_argument")
    done <"$parsed_arguments"
    [ "${#remote_arguments[@]}" -gt 0 ] || fail_unproduced 'ssh remote shell argument'
  fi

  remote_script="$fixture_root/remote-script.sh"
  printf '%s\n' "$remote_input" | sed \
    -e "s|/tmp/|$fixture_root/tmp/|g" \
    -e "s|/run/|$fixture_root/run/|g" \
    -e "s|/etc/|$fixture_root/etc/|g" \
    -e "s|/home/commonswarm|$fixture_root/home/commonswarm|g" \
    -e "s|/srv/commonswarm|$fixture_root/srv/commonswarm|g" \
    >"$remote_script"
  chmod 0700 "$remote_script"
  remote_output="$fixture_root/remote-output"
  for argument_index in "${!remote_arguments[@]}"; do
    case "${remote_arguments[$argument_index]}" in
      /srv/commonswarm/*)
        remote_arguments[$argument_index]="$fixture_root${remote_arguments[$argument_index]}"
        ;;
      /home/commonswarm/*)
        remote_arguments[$argument_index]="$fixture_root${remote_arguments[$argument_index]}"
        ;;
    esac
  done
  (
    cd "$fixture_root"
    env PATH="${0%/*}:/usr/bin:/bin" BOX_DRY_RUN_PART=box \
      /bin/bash "$remote_script" "${remote_arguments[@]}" >"$remote_output"
  )

  archive_output=no
  if /usr/bin/tar -tf "$remote_output" >/dev/null 2>&1; then archive_output=yes; fi
  case "${BOX_DRY_RUN_COPYBACK_ARCHIVE_VARIANT:-exact}" in
    exact) ;;
    missing)
        [ "$archive_output" = yes ] || unhandled_stub
        /usr/bin/tar -C "$fixture_proof" -cf "$remote_output" \
          hm37-worker-boundary.txt hm37-hosted-control-inputs.txt \
          hm37-hosted-check-control.json hm37-revocation-readback.json
        ;;
    extra)
        [ "$archive_output" = yes ] || unhandled_stub
        printf '%s\n' 'unexpected fixture member' >"$fixture_proof/unexpected.txt"
        /usr/bin/tar -C "$fixture_proof" -cf "$remote_output" \
          hm37-worker-boundary.txt hm37-hosted-control-inputs.txt \
          hm37-hosted-check-control.json hm37-revocation-readback.json \
          hm37-close-readback.txt unexpected.txt
        ;;
    *) unhandled_stub ;;
  esac
  if [ "$archive_output" = yes ]; then
    cat "$remote_output"
  else
    sed "s|$fixture_root||g" "$remote_output"
  fi
}

# These inventories are checked against every executable plan block by
# tests/box-dry-run.test.ts. Keep the dispatch cases and these declarations in
# lockstep; a plan cannot acquire a new external operation by falling through.
# plan-subcommands: systemctl daemon-reload is-active list-timers reload restart show start stop
# plan-flags: systemctl --all --no-pager --property -p --quiet --value
# plan-subcommands: docker compose exec image-inspect inspect logs ps run
# plan-flags: docker --add-host --entrypoint --env -f --filter --format -i --network --no-deps -p --project-directory -q --rm --since --timestamps --volume -d
# plan-options: ssh BatchMode=yes ConnectTimeout=10

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
        -o)
          [ "$#" -ge 2 ] || unhandled_stub
          case "$2" in
            BatchMode=yes|ConnectTimeout=10) shift 2 ;;
            *) unhandled_stub ;;
          esac
          ;;
        --) shift; break ;;
        -*) unhandled_stub ;;
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
          *'install -m 0600 -o root -g root /tmp/hm37-open-ack-control.ts'*'hm37-hosted-control-inputs.txt'*)
            # Verify the five transferred inputs before accepting the remote
            # installation boundary. Box-mode controls verify remote owner and
            # mode separately on the actual target path.
            for transferred in \
              /tmp/hm37-open-ack-control.ts \
              /tmp/hm37-open-ack-deno.json \
              /tmp/hm37-human-session.json \
              /tmp/hm37-worker-boundary.txt \
              /tmp/hm37-hosted-control-inputs.txt; do
              [ -f "$transferred" ] && [ ! -L "$transferred" ] || fail_unproduced 'scp transferred input'
            done
            test "$(shasum -a 256 /tmp/hm37-open-ack-control.ts | awk '{print $1}')" = \
              dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013
            test "$(shasum -a 256 /tmp/hm37-open-ack-deno.json | awk '{print $1}')" = \
              f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b
            rm -f \
              /tmp/hm37-open-ack-control.ts \
              /tmp/hm37-open-ack-deno.json \
              /tmp/hm37-human-session.json \
              /tmp/hm37-worker-boundary.txt \
              /tmp/hm37-hosted-control-inputs.txt
            ;;
          *) run_box_fixture_script "$remote_input" "$@" ;;
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
      *'install -d -m 0700 -o root -g root '*'/run/commonswarm-hm37-'*)
        # The Mac half verifies this transport request. The box half owns the
        # real root-shaped fixture and executes the box blocks there.
        ;;
      'umask 077; : > /tmp/hm37-open-ack-control.ts'|\
      'umask 077; : > /tmp/hm37-open-ack-deno.json'|\
      'umask 077; : > /tmp/hm37-human-session.json')
        target_path=${remote_command##* > }
        : >"$target_path"
        chmod 0600 "$target_path"
        ;;
      *'test '*'/srv/commonswarm/site/'*) ;;
      *) fail_unproduced 'ssh output' ;;
    esac
    ;;
  scp)
    [ "$#" -eq 2 ] || fail_unproduced 'scp flags'
    source_path=$1
    destination=$2
    [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail_unproduced 'scp regular source file'
    case "$destination" in
      ops@100.115.66.74:/tmp/*|commonswarm@100.115.66.74:/tmp/*) ;;
      # Lane 8 carries this measured Tailscale hostname in its existing plan.
      commonswarm@yulan-vps-1:/tmp/*) ;;
      *) fail_unproduced 'scp target' ;;
    esac
    remote=${destination%%:*}
    target_path=${destination#*:}
    target_user=${remote%@*}
    target_host=${remote#*@}
    case "$target_path" in
      /tmp/*/../*|/tmp/../*|*'\n'*) fail_unproduced 'scp target path' ;;
    esac
    [ ! -L "$target_path" ] || fail_unproduced 'scp symlink target'
    if command -v shasum >/dev/null 2>&1; then
      source_sha256=$(shasum -a 256 "$source_path" | awk '{print $1}')
    else
      source_sha256=$(sha256sum "$source_path" | awk '{print $1}')
    fi
    cp "$source_path" "$target_path"
    chmod 0600 "$target_path"
    if [ "${BOX_DRY_RUN_PART:-mac}" = box ]; then
      /usr/bin/chown "$target_user:$target_user" "$target_path"
    fi
    {
      printf 'scp-transfer source_sha256=%s target_user=%q target_host=%q target_path=%q\n' \
        "$source_sha256" "$target_user" "$target_host" "$target_path"
    } >>"$BOX_DRY_RUN_STUB_LOG"
    ;;
  cp)
    cp_arguments=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --reflink=auto) ;;
        *) cp_arguments+=("$1") ;;
      esac
      shift
    done
    exec /bin/cp "${cp_arguments[@]}"
    ;;
  readlink)
    if [ "$#" -eq 2 ] && [ "$1" = -f ]; then
      exec /usr/bin/python3 -c 'import os,sys; value=os.path.realpath(sys.argv[1]); print("/tmp/"+value.removeprefix("/private/tmp/") if value.startswith("/private/tmp/") else value)' "$2"
    fi
    exec /usr/bin/readlink "$@"
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
    # A real token is never part of the harness. The synthetic token reaches
    # only this process from a protected file, matching the service-account
    # boundary without putting it in the plan shell, argv, logs, or output.
    [ -z "${OP_SERVICE_ACCOUNT_TOKEN+x}" ] || exit 69
    if /usr/bin/env | /usr/bin/grep -q '^OP_SESSION_'; then exit 69; fi
    [ -z "${OP_BIOMETRIC_UNLOCK_ENABLED:-}" ] || exit 69
    token_file=${BOX_DRY_RUN_OP_SERVICE_ACCOUNT_TOKEN_FILE:-}
    [ -n "$token_file" ] && [ -f "$token_file" ] && [ ! -L "$token_file" ] || exit 69
    case "$(uname -s)" in
      Darwin) token_mode=$(stat -f '%Lp' "$token_file") ;;
      Linux) token_mode=$(stat -c '%a' "$token_file") ;;
      *) exit 69 ;;
    esac
    [ "$token_mode" = 600 ] || exit 69
    OP_SERVICE_ACCOUNT_TOKEN=$(cat "$token_file")
    export OP_SERVICE_ACCOUNT_TOKEN
    [ -n "${OP_SERVICE_ACCOUNT_TOKEN:-}" ] || exit 69
    [ "$#" -eq 4 ] && [ "$1" = read ] && [ "$3" = --out-file ] || exit 69
    reference=$2
    output=$4
    case "$reference" in op://?*/?*/?*) ;; *) exit 69 ;; esac
    output_parent=${output%/*}
    [ -n "$output" ] && [ "$output_parent" != "$output" ] && \
      [ -d "$output_parent" ] && [ ! -L "$output_parent" ] && [ ! -L "$output" ] || exit 69
    umask 077
    printf '%s\n' \
      'PUBLIC_SUPABASE_URL=https://api.commonswarm.com' \
      'PUBLIC_SUPABASE_ANON_KEY=e30.eyJyb2xlIjoiYW5vbiJ9.dry-run-public-signature' \
      'PUBLIC_H0_LINK_JOIN=1' >"$output"
    chmod 0600 "$output"
    ;;
  systemctl)
    mkdir -p "$stub_state_dir/systemctl"
    systemctl_command=${1:-}
    [ -n "$systemctl_command" ] || unhandled_stub
    shift
    systemctl_state() {
      # M9/M10 in box-facts-measured.json record inactive successful one-shot
      # services and active enabled maintenance timers respectively.
      unit=$1
      state_file="$stub_state_dir/systemctl/${unit//\//_}"
      if [ -f "$state_file" ]; then cat "$state_file"; return; fi
      case "$unit" in
        *.timer|caddy|caddy.service) printf '%s\n' active ;;
        *.service) printf '%s\n' inactive ;;
        *) printf '%s\n' inactive ;;
      esac
    }
    systemctl_set_state() {
      printf '%s\n' "$2" >"$stub_state_dir/systemctl/${1//\//_}"
    }
    case "$systemctl_command" in
      is-active)
        quiet=0
        if [ "${1:-}" = --quiet ]; then quiet=1; shift; fi
        [ "$#" -eq 1 ] || unhandled_stub
        active_state=$(systemctl_state "$1")
        [ "$quiet" -eq 1 ] || printf '%s\n' "$active_state"
        [ "$active_state" = active ] || exit 3
        ;;
      start|stop|restart|reload)
        [ "$#" -gt 0 ] || unhandled_stub
        for unit in "$@"; do
          case "$unit" in -*) unhandled_stub ;; esac
          case "$systemctl_command:$unit" in
            start:*.service) systemctl_set_state "$unit" inactive ;;
            stop:*) systemctl_set_state "$unit" inactive ;;
            reload:*) printf '%s\n' "$unit" >"$stub_state_dir/systemctl/last-reloaded" ;;
            *) systemctl_set_state "$unit" active ;;
          esac
        done
        ;;
      daemon-reload)
        [ "$#" -eq 0 ] || unhandled_stub
        : >"$stub_state_dir/systemctl/daemon-reloaded"
        ;;
      list-timers)
        all=0
        units=()
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --all) all=1 ;;
            -*) unhandled_stub ;;
            *) units+=("$1") ;;
          esac
          shift
        done
        [ "${#units[@]}" -gt 0 ] || unhandled_stub
        # Shape source: M10 in box-facts-measured.json:112-119.
        for unit in "${units[@]}"; do
          printf '%s %s loaded %s enabled\n' \
            'Tue 2026-09-29 09:30:00 UTC' "$unit" "$(systemctl_state "$unit")"
        done
        ;;
      show)
        units=()
        properties=()
        value_only=0
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -p)
              [ "$#" -ge 2 ] || unhandled_stub
              properties+=("$2"); shift
              ;;
            --property=*) properties+=("${1#--property=}") ;;
            --value) value_only=1 ;;
            --no-pager) ;;
            -*) unhandled_stub ;;
            *) units+=("$1") ;;
          esac
          shift
        done
        [ "${#units[@]}" -gt 0 ] || unhandled_stub
        if [ "$value_only" -eq 1 ]; then
          [ "${#units[@]}" -eq 1 ] && [ "${#properties[@]}" -eq 1 ] || unhandled_stub
          case "${properties[0]}" in
            Result) printf '%s\n' success ;;
            InactiveExitTimestampMonotonic)
              count_file="$stub_state_dir/systemctl/service-start-count"
              [ -f "$count_file" ] && cat "$count_file" || printf '%s\n' 100
              ;;
            NextElapseUSecRealtime) printf '%s\n' 'Tue 2026-09-29 09:30:00 UTC' ;;
            *) unhandled_stub ;;
          esac
        else
          # Shape source: M10 in box-facts-measured.json:112-119.
          for unit in "${units[@]}"; do
            printf 'Id=%s\nLoadState=loaded\nActiveState=%s\nUnitFileState=enabled\n\n' \
              "$unit" "$(systemctl_state "$unit")"
          done
        fi
        ;;
      *) unhandled_stub ;;
    esac
    if [ "$systemctl_command" = start ]; then
      count_file="$stub_state_dir/systemctl/service-start-count"
      current=100
      [ ! -f "$count_file" ] || current=$(cat "$count_file")
      printf '%s\n' "$((current + 100))" >"$count_file"
    fi
    ;;
  docker)
    mkdir -p "$stub_state_dir/docker"
    docker_command=${1:-}
    [ -n "$docker_command" ] || unhandled_stub
    shift
    case "$docker_command" in
      ps)
        # Container identities/counts: M17 and production_recheck in
        # box-facts-measured.json; OAuth identity: oauth-runtime.json.
        quiet=0
        filters=' '
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -q) quiet=1 ;;
            --filter)
              [ "$#" -ge 2 ] || unhandled_stub
              filters="$filters$2 "; shift
              ;;
            *) unhandled_stub ;;
          esac
          shift
        done
        [ "$quiet" -eq 1 ] || unhandled_stub
        case " $* " in
          *)
            case "$filters" in
          *'com.docker.compose.project=commonswarm-oauth'*) printf '%s\n' dry-run-oauth ;;
          *'com.docker.compose.service=postgres'*) printf '%s\n' dry-run-postgres ;;
          *) printf '%s\n' dry-run-edge ;;
            esac
        esac
        ;;
      inspect)
        # Edge inspect shapes: M11 in box-facts-measured.json. OAuth image,
        # health, workdir, and env shapes: oauth-image.json/oauth-runtime.json
        # plus HM37's exact Config.Env read.
        [ "${1:-}" = --format ] && [ "$#" -ge 3 ] || unhandled_stub
        format=$2; shift 2
        [ "$#" -ge 1 ] || unhandled_stub
        for target in "$@"; do case "$target" in -*) unhandled_stub ;; esac; done
        target=${@: -1}
        case "$format" in
          *'.Config.Env'*) printf '%s\n' "${BOX_DRY_RUN_OAUTH_DATABASE_HOST_LINE:?OAuth host line required}" ;;
          *'.Image'*)
        case "$target" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_IMAGE:?OAuth image required}" ;;
          dry-run-postgres) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}" ;;
          *) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}" ;;
        esac
          ;;
          *Health.Status*|*State.Health*|*State.Status*)
        case "$target" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_HEALTH:?OAuth health required}" ;;
          *) printf '%s\n' "${BOX_DRY_RUN_EDGE_HEALTH:?edge health required}" ;;
        esac
          ;;
          *HostConfig.Memory*) printf '%s\n' "${BOX_DRY_RUN_EDGE_MEMORY:?edge memory required}" ;;
          *HostConfig.NetworkMode*) printf '%s\n' "${BOX_DRY_RUN_EDGE_NETWORK:?edge network required}" ;;
          *Mounts*) printf '%s\n' "${BOX_DRY_RUN_EDGE_MOUNTS:?edge mounts required}" ;;
          *working_dir*)
        case "$target" in
          dry-run-oauth) printf '%s\n' "${BOX_DRY_RUN_OAUTH_WORKDIR:?OAuth workdir required}" ;;
          *)
            if [ -f "$stub_state_dir/docker/edge-runtime-up" ]; then
              printf '%s\n' "${BOX_DRY_RUN_CANDIDATE_EDGE:?candidate edge required}/deploy/edge-runtime"
            else
              printf '%s\n' "${BOX_DRY_RUN_EDGE_WORKDIR:?edge workdir required}"
            fi
            ;;
        esac
          ;;
          *) unhandled_stub ;;
        esac
        ;;
      image)
        # Image identity shape: M17 in box-facts-measured.json.
        [ "${1:-}" = inspect ] || unhandled_stub
        shift
        [ "${1:-}" = --format ] && [ "$#" -eq 3 ] || unhandled_stub
        printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:?Postgres image required}"
        ;;
      run)
        # The plans use only these Docker-run flags. The database result remains
        # deliberately unproduced; accepting the invocation must not fake SQL.
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --rm) shift ;;
            --network|--add-host|--env|--volume|--entrypoint)
              [ "$#" -ge 2 ] || unhandled_stub; shift 2 ;;
            -*) unhandled_stub ;;
            *) break ;;
          esac
        done
        [ "$#" -gt 0 ] || unhandled_stub
        printf '%s\n' 'UNPRODUCED database observation' >&2
        exit 69
        ;;
      compose)
        # Mutations and their silent shell-facing use are the exact runbook-32,
        # runbook-42, runbook-49, and runbook-52 plan calls. The workdir
        # readback after edge up uses the M11 shape above.
        project=''; project_dir=''; compose_file=''
        while [ "$#" -gt 0 ]; do
          case "$1" in
            -p) [ "$#" -ge 2 ] || unhandled_stub; project=$2; shift 2 ;;
            -f) [ "$#" -ge 2 ] || unhandled_stub; compose_file=$2; shift 2 ;;
            --project-directory) [ "$#" -ge 2 ] || unhandled_stub; project_dir=$2; shift 2 ;;
            *) break ;;
          esac
        done
        compose_command=${1:-}; [ -n "$compose_command" ] || unhandled_stub; shift
        case "$compose_command" in
          config) [ "$#" -eq 1 ] && [ "$1" = -q ] || unhandled_stub ;;
          pull)
            [ "$#" -eq 1 ] || unhandled_stub
            printf '%s\n' "$project:$1" >"$stub_state_dir/docker/last-pulled"
            ;;
          ps)
            if [ "${1:-}" = -q ]; then shift; fi
            [ "$#" -eq 1 ] || unhandled_stub
            case "$project" in
              commonswarm-edge) printf '%s\n' dry-run-edge ;;
              commonswarm-supabase-stack) printf '%s\n' dry-run-postgres ;;
              *) unhandled_stub ;;
            esac
            ;;
          up)
            detached=0; no_deps=0
            while [ "$#" -gt 0 ]; do
              case "$1" in -d) detached=1; shift ;; --no-deps) no_deps=1; shift ;; *) break ;; esac
            done
            [ "$detached" -eq 1 ] && [ "$#" -eq 1 ] || unhandled_stub
            case "$project:$1" in
              commonswarm-edge:edge-runtime) : >"$stub_state_dir/docker/edge-runtime-up" ;;
              commonswarm-supabase-stack:*) printf '%s\n' "$1" >"$stub_state_dir/docker/stack-service-up" ;;
              *) unhandled_stub ;;
            esac
            ;;
          *) unhandled_stub ;;
        esac
        ;;
      logs)
        while [ "$#" -gt 0 ]; do
          case "$1" in
            --timestamps) shift ;;
            --since) [ "$#" -ge 2 ] || unhandled_stub; shift 2 ;;
            -*) unhandled_stub ;;
            *) break ;;
          esac
        done
        [ "$#" -eq 1 ] || unhandled_stub
        ;;
      exec)
        interactive=0
        if [ "${1:-}" = -i ]; then interactive=1; shift; fi
        [ "$#" -ge 3 ] || unhandled_stub
        container=$1; runtime=$2; shift 2
        case "$runtime:$1" in
          node:-e|deno:eval) [ "$#" -eq 2 ] || unhandled_stub ;;
          sh:-c)
            [ "$interactive" -eq 1 ] && [ "$#" -eq 2 ] || unhandled_stub
            sql=$(cat)
            case "$sql" in
              *'BEGIN READ ONLY;'*'revoked_at IS NULL'*)
                printf '%s\n' "$sql" | grep -Eo "[0-9a-f]{8}-[0-9a-f-]{27}" | sort -u | while IFS= read -r principal; do
                  printf '%s=0\n' "$principal"
                done
                ;;
              *) unhandled_stub ;;
            esac
            ;;
          *) unhandled_stub ;;
        esac
        ;;
      *) unhandled_stub ;;
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
    tar_arguments=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --no-xattrs) ;;
        *) tar_arguments+=("$1") ;;
      esac
      shift
    done
    exec /usr/bin/tar "${tar_arguments[@]}"
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
  browser-harness)
    [ "$#" -eq 0 ] || unhandled_stub
    browser_program=$(cat)
    [ -n "$browser_program" ] || unhandled_stub
    [ "${BH_TAB_MARKER:-}" = 0 ] || unhandled_stub
    case "${BU_CDP_URL:-}" in http://127.0.0.1:9335) ;; *) unhandled_stub ;; esac
    # Browser state shapes are grounded in the committed 2026-09-26/27 controls:
    # ./docs/evidence/2026-09-26-item-cp/CP1-LANDING.md:22-29 records the
    # Ridgeio production sign-in, and
    # ./docs/evidence/2026-09-27-prod-controls/RUN/00-human-session.json:1-18
    # records the user, owner label, and Cold Agent Test workspace. The retained
    # starting-workspace shape is K4-8 in box-facts-measured.json:521-533.
    {
      cat <<'PY'
import os, pathlib, urllib.parse

_fixture_user = os.environ.get("BOX_DRY_RUN_BROWSER_USER_ID", "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc")
_fixture_start = "292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
_fixture_control = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
_fixture_selected = _fixture_start
_fixture_width = 1280
_fixture_png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

def new_tab(url):
    return {"url": url}

def wait_for_load():
    return None

def goto_url(url):
    global _fixture_selected
    query = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    if query.get("w"):
        _fixture_selected = query["w"][0]
    return {"url": url}

def cdp(method, **kwargs):
    global _fixture_width
    if method == "Emulation.setDeviceMetricsOverride":
        _fixture_width = kwargs["width"]
    if method == "Page.captureScreenshot":
        return {"data": _fixture_png}
    return {}

def js(source):
    global _fixture_selected
    if "two-factor|2fa|verification code|keychain" in source:
        return False
    if "data-workspace-id=\"c2ea0541-f56d-4c73-bf71-56c5405c4934\"" in source:
        _fixture_selected = _fixture_control
        return True
    if "data-workspace-id=\"292be0f9-ca5d-43ed-a6f7-31354fe7fe56\"" in source:
        _fixture_selected = _fixture_start
        return True
    if "return {userId, selectedWorkspace" in source:
        return {"userId": _fixture_user, "selectedWorkspace": _fixture_selected,
                "workspaceIds": [_fixture_start, _fixture_control], "display": "Ridgeio", "signedOut": False}
    if "return {userId,workspaceId" in source:
        return {"userId": _fixture_user, "workspaceId": _fixture_selected, "workspaceCount": 2,
                "display": "Ridgeio", "signedOut": False, "connectedSurface": True,
                "connectedCreateAction": False, "errors": []}
    if "feed:!!document.querySelector" in source:
        return {"feed": True, "roster": True, "localSeat": True, "h0": True, "workspaceError": False}
    if "performance.getEntriesByType('resource')" in source:
        public = pathlib.Path(os.environ["SITE_EVIDENCE"]) / "site-05-public.txt"
        return [line.split(" ", 1)[1] for line in public.read_text().splitlines() if line.startswith("asset_sha256=")]
    if "data-connected-apps-list" in source:
        return "No apps are connected to this account."
    if "data-connected-apps-status" in source:
        return "Nothing was changed"
    if "data-connected-apps-retry" in source:
        return False
    if "data-connected-apps-dialog" in source and "getBoundingClientRect" in source:
        return {"x": 0, "y": 0, "width": 280, "height": 200, "scale": 1}
    if "railHeight" in source and "scrollWidth" in source:
        return {"innerWidth": _fixture_width, "scrollWidth": _fixture_width, "railHeight": 64,
                "controls": [{"top": 8, "bottom": 48, "left": 8, "right": 48},
                             {"top": 8, "bottom": 48, "left": 56, "right": 96},
                             {"top": 8, "bottom": 48, "left": 104, "right": 144}]}
    if "[aria-checked=\"true\"]" in source:
        return _fixture_selected
    if "data-rail-account" in source:
        return "Ridgeio"
    if "data-panel=\"auth\"" in source:
        return False
    return True
PY
      printf '%s\n' "$browser_program"
    } | /usr/bin/env PYTHONPATH="${BOX_DRY_RUN_PYTHON_FIXTURE:?Python fixture path required}" /usr/bin/python3 -
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
        principal_workspace, principal, revoked = raw.split("\t")
        if principal_workspace == workspace:
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
            printf '%s\t%s\tfalse\n' "$workspace" "$principal" >>"$cswarm_state_dir/principals.tsv"
            # Output shape: src/cli.ts:2544-2568.
            printf '{"message":"Agent identity created.","status":"accepted","principal_id":"%s"}\n' "$principal"
            ;;
          revoke)
            [ -n "$principal" ] && [ -z "$seat_name" ] || fail_unproduced 'cswarm principal revoke arguments'
            /usr/bin/python3 - "$cswarm_state_dir/principals.tsv" "$workspace" "$principal" <<'PY'
import pathlib, sys
path, workspace, wanted = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
rows = []
found = False
if path.exists():
    for raw in path.read_text().splitlines():
        principal_workspace, principal, revoked = raw.split("\t")
        if principal_workspace == workspace and principal == wanted:
            revoked, found = "true", True
        rows.append((principal_workspace, principal, revoked))
if not found:
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
path.write_text("".join(f"{principal_workspace}\t{principal}\t{revoked}\n" for principal_workspace, principal, revoked in rows))
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
        /usr/bin/python3 - "$cswarm_state_dir/principals.tsv" "$workspace" "$principal" <<'PY'
import pathlib, sys
path, workspace, wanted = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3]
found = False
if path.exists():
    for raw in path.read_text().splitlines():
        principal_workspace, principal, revoked = raw.split("\t")
        if principal_workspace == workspace and principal == wanted and revoked == "false":
            found = True
if not found:
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
PY
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
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/principals.tsv" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
state = pathlib.Path(sys.argv[2])
valid = False
if state.exists():
    for raw in state.read_text().splitlines():
        workspace, principal, revoked = raw.split("\t")
        if workspace == profile["workspace_id"] and principal == profile["principal_id"] and revoked == "false":
            valid = True
if not valid:
    # Failure shape: src/cli.ts:10716-10826 and the authenticated identity
    # refusal at src/cloud/agent-check.ts:129-135.
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
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
        signal_counter="$cswarm_state_dir/signal-counter"
        signal_count=0
        [ ! -f "$signal_counter" ] || signal_count=$(cat "$signal_counter")
        signal_count=$((signal_count + 1))
        printf '%s\n' "$signal_count" >"$signal_counter"
        signal=$(printf '20000000-0000-4000-8000-%012d' "$signal_count")
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/principals.tsv" "$cswarm_state_dir/pending.jsonl" "$signal" "$body" "$recipient" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
state, pending = pathlib.Path(sys.argv[2]), pathlib.Path(sys.argv[3])
signal, body, recipient = sys.argv[4:]
principals = {}
if state.exists():
    for raw in state.read_text().splitlines():
        workspace, principal, revoked = raw.split("\t")
        principals[principal] = (workspace, revoked)
sender = principals.get(profile["principal_id"])
target = principals.get(recipient)
if sender != (profile["workspace_id"], "false") or target != (profile["workspace_id"], "false"):
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
record = {"id": signal, "body": body, "recipient": recipient, "workspace_id": profile["workspace_id"]}
with pending.open("a") as output:
    output.write(json.dumps(record, separators=(",", ":")) + "\n")
PY
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
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/principals.tsv" "$cswarm_state_dir/pending.jsonl" "$cswarm_state_dir/observed" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
state, pending_path, observed_dir = map(pathlib.Path, sys.argv[2:])
valid = False
if state.exists():
    for raw in state.read_text().splitlines():
        workspace, principal, revoked = raw.split("\t")
        if workspace == profile["workspace_id"] and principal == profile["principal_id"] and revoked == "false":
            valid = True
if not valid:
    # Failure shape: src/cloud/agent-check.ts:129-135; CLI prefix and exit 1
    # are from src/cli.ts:10716-10826.
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
messages = []
observed_dir.mkdir(exist_ok=True)
if pending_path.exists():
    for raw in pending_path.read_text().splitlines():
        pending = json.loads(raw)
        consumed_path = observed_dir / f'{profile["principal_id"]}-{pending["id"]}'
        if (pending["workspace_id"] == profile["workspace_id"] and
                pending["recipient"] == profile["principal_id"] and not consumed_path.exists()):
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
        /usr/bin/python3 - "$profile" "$cswarm_state_dir/principals.tsv" "$cswarm_state_dir/pending.jsonl" "$cswarm_state_dir/observed" "$signal" <<'PY'
import json, pathlib, sys
profile = json.loads(pathlib.Path(sys.argv[1]).read_text())
state, pending_path, observed_dir = map(pathlib.Path, sys.argv[2:5])
signal = sys.argv[5]
valid = False
if state.exists():
    for raw in state.read_text().splitlines():
        workspace, principal, revoked = raw.split("\t")
        if workspace == profile["workspace_id"] and principal == profile["principal_id"] and revoked == "false":
            valid = True
if not valid:
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
pending = next((json.loads(raw) for raw in pending_path.read_text().splitlines()
    if json.loads(raw)["id"] == signal and json.loads(raw)["workspace_id"] == profile["workspace_id"]), None)
if pending is None:
    print("cswarm: The service did not confirm this agent and workspace. No messages were shown. Ask for the correct connection file.", file=sys.stderr)
    raise SystemExit(1)
observed = (observed_dir / f'{pending["recipient"]}-{pending["id"]}').exists()
receipts = [] if not observed else [{"recipient_agent_principal_id": pending["recipient"],
    "state": "observed", "outcome": "observed", "acked_at": "2026-09-29T01:03:00Z"}]
print(json.dumps({"workspace_id": profile["workspace_id"], "signal_id": signal, "receipts": receipts}, separators=(",", ":")))
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
