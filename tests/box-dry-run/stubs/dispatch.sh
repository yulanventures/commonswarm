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
  # An empty array is an unbound variable to bash 3.2 under set -u; a call with no arguments must still exit 69.
  printf ' %q' ${original_argv[@]+"${original_argv[@]}"} >&2
  printf '\n' >&2
  exit 69
}

cswarm_state_dir="${BOX_DRY_RUN_STUB_LOG}.cswarm-state"
stub_state_dir="${BOX_DRY_RUN_STUB_LOG}.stub-state"

# The fixture box root is a directory under the dry run's own temporary directory. Every ssh, scp and rsync
# operation lands there, and nothing else. The harness creates it; a stub never invents one.
require_box_root() {
  box_root_dir=${BOX_DRY_RUN_BOX_ROOT:-}
  [ -n "$box_root_dir" ] && [ -d "$box_root_dir" ] && [ ! -L "$box_root_dir" ] || fail_unproduced 'fixture box root'
}

userland() {
  /usr/bin/python3 "${BOX_DRY_RUN_USERLAND:?box userland required}" "$@"
}

# Path-valued metadata is compared inside the projected box shell. Use the
# same mapping as its script and sourced inputs; SSH strips it on the way out.
path_readback() {
  if [ "${BOX_DRY_RUN_IN_REMOTE:-}" = 1 ] && [ "${BOX_DRY_RUN_PART:-mac}" = mac ]; then
    printf '%s\n' "$1" | userland rewrite
  else
    printf '%s\n' "$1"
  fi
}

# ssh runs the remote command string the way sshd does: one shell, the joined arguments as its command line,
# ssh's standard input as the command's standard input. The command string and standard input are text
# bound for the box, so their box paths are mapped into the fixture box root; the output is shown back with
# the box's own paths.
#
# Containment. A process tree can be put under sandbox-exec exactly once: a process that is already sandboxed
# cannot apply a second profile (sandbox_apply is refused with EPERM, exit 71). So the harness applies ONE
# profile at the top of every Mac-side process tree, and a remote script started by an ssh stub inside a
# contained block runs in that tree. When the stub is called outside a contained tree, it applies the remote
# profile itself (write only inside the fixture box root and the stub logs; no application start; no read of
# the operator's private state). It never runs a remote script uncontained: if the profile cannot be applied,
# the script does not run.
run_in_box() {
  login_user=$1
  remote_command=$2
  [ -z "${BOX_DRY_RUN_IN_REMOTE:-}" ] || unhandled_stub
  if [ "${BOX_DRY_RUN_PART:-mac}" = box ]; then
    # Admission belongs to containedCommand/prepareBoxFixture. This branch is reached
    # only by the block shell on the admitted disposable Linux runner, using its stubs.
    [ "${BOX_DRY_RUN_BOX_ROOT:-}" = / ] && [ "$(uname -s)" = Linux ] && [ "$(id -u)" = 0 ] || unhandled_stub
    remote_prelude="${BOX_DRY_RUN_PYTHON_FIXTURE:?box fixture required}/../prelude.sh"
    [ -f "$remote_prelude" ] || fail_unproduced 'box remote prelude'
    case "$login_user" in ops|commonswarm) ;; *) unhandled_stub ;; esac
    /usr/bin/id -u "$login_user" >/dev/null || fail_unproduced 'box ssh login user'
    remote_home=$(/usr/bin/getent passwd "$login_user" | /usr/bin/cut -d: -f6)
    case "$remote_home" in /*) ;; *) fail_unproduced 'box ssh login home' ;; esac
    remote_support="${BOX_DRY_RUN_PYTHON_FIXTURE%/*}"
    remote_trap=$(mktemp "$remote_support/remote-trap.XXXXXX")
    remote_log=$(mktemp "$remote_support/remote-log.XXXXXX")
    /usr/bin/chown "$login_user:$login_user" "$remote_log"
    chmod 0600 "$remote_log"
    printf 'source %q\n' "$remote_prelude" >"$remote_trap"
    printf '%s\n' 'set -E' \
      'trap '\''block_status=$?; case $- in *e*) printf "__FIRST_FAIL__:%s\n" "$BASH_COMMAND" >&2; exit "$block_status" ;; esac'\'' ERR' >>"$remote_trap"
    chmod 0644 "$remote_trap"
    remote_env=()
    for variable_name in $(compgen -e); do
      case "$variable_name" in
        BOX_DRY_RUN_STUB_LOG) ;;
        BOX_DRY_RUN_*) remote_env+=("$variable_name=${!variable_name}") ;;
      esac
    done
    status=0
    /usr/sbin/runuser -u "$login_user" -- /usr/bin/env -i \
      PATH="$PATH" HOME="$remote_home" LANG=C.UTF-8 TZ=UTC BASH_ENV="$remote_trap" \
      BOX_DRY_RUN_STUB_LOG="$remote_log" BOX_DRY_RUN_ROOT_STUB_LOG="$BOX_DRY_RUN_STUB_LOG" \
      BOX_DRY_RUN_IN_REMOTE=1 BOX_DRY_RUN_REMOTE_USER="$login_user" \
      ${remote_env[@]+"${remote_env[@]}"} /bin/bash -c "$remote_command" || status=$?
    cat "$remote_log" >>"$BOX_DRY_RUN_STUB_LOG"
    rm -f -- "$remote_trap" "$remote_log"
    exit "$status"
  fi
  [ "${BOX_DRY_RUN_PART:-mac}" = mac ] || unhandled_stub
  require_box_root
  box_bin=${BOX_DRY_RUN_BOX_BIN:?box userland bin required}
  ssh_dir="$box_root_dir/.fixture/ssh"
  mkdir -p "$ssh_dir" "$box_root_dir/root" "$box_root_dir/tmp"
  call_dir=$(mktemp -d "$ssh_dir/call.XXXXXX")
  cat >"$call_dir/stdin"
  userland rewrite <"$call_dir/stdin" >"$call_dir/stdin.rewritten"
  printf '%s' "$remote_command" | userland rewrite >"$call_dir/command"
  rewritten_command=$(cat "$call_dir/command")
  remote_env=()
  for variable_name in $(compgen -e); do
    case "$variable_name" in
      BOX_DRY_RUN_REMOTE_SANDBOX_PROFILE|BOX_DRY_RUN_IN_REMOTE|BOX_DRY_RUN_REMOTE_USER|BOX_DRY_RUN_CONTAINED) ;;
      BOX_DRY_RUN_*) remote_env+=("$variable_name=${!variable_name}") ;;
    esac
  done
  remote_shell=(/bin/bash -c "$rewritten_command")
  if [ -z "${BOX_DRY_RUN_CONTAINED:-}" ]; then
    remote_profile=${BOX_DRY_RUN_REMOTE_SANDBOX_PROFILE:-}
    [ -n "$remote_profile" ] || fail_unproduced 'fixture box containment'
    remote_shell=(/usr/bin/sandbox-exec -p "$remote_profile" "${remote_shell[@]}")
  fi
  # A failing box script is reported with its own command and script line, not only an exit status. The record
  # goes to a file through an ERR trap that bash reads from BASH_ENV; it never touches the script's own stdout
  # or stderr, so a script's output is exactly what it printed.
  printf '%s\n' 'set -E' \
    'trap '\''printf "line %s: %s\n" "$LINENO" "$BASH_COMMAND" >>"$BOX_DRY_RUN_FAILURE_RECORD"'\'' ERR' \
    >"$call_dir/failure-trap.sh"
  cat "${BOX_DRY_RUN_USERLAND%/*}/box-source.sh" >>"$call_dir/failure-trap.sh"
  : >"$call_dir/failure-record"
  status=0
  (
    cd "$box_root_dir/root"
    exec /usr/bin/env -i \
      PATH="$box_bin:${0%/*}:/usr/bin:/bin:/usr/sbin:/sbin" \
      HOME="$box_root_dir/root" TMPDIR="$box_root_dir/tmp" LANG=C.UTF-8 TZ=UTC \
      BASH_ENV="$call_dir/failure-trap.sh" BOX_DRY_RUN_FAILURE_RECORD="$call_dir/failure-record" \
      BOX_DRY_RUN_IN_REMOTE=1 BOX_DRY_RUN_REMOTE_USER="$login_user" \
      ${remote_env[@]+"${remote_env[@]}"} \
      "${remote_shell[@]}"
  ) <"$call_dir/stdin.rewritten" >"$call_dir/stdout" 2>"$call_dir/stderr" || status=$?
  userland strip <"$call_dir/stdout"
  userland strip <"$call_dir/stderr" >&2
  if [ "$status" -ne 0 ] && [ -s "$call_dir/failure-record" ]; then
    printf 'dry-run: the box script exited %s. Its last failing commands:\n' "$status" >&2
    /usr/bin/tail -n 3 "$call_dir/failure-record" | userland strip >&2
  fi
  rm -f "$call_dir/stdin" "$call_dir/stdin.rewritten" "$call_dir/command" "$call_dir/stdout" "$call_dir/stderr" \
    "$call_dir/failure-trap.sh" "$call_dir/failure-record"
  rmdir "$call_dir"
  exit "$status"
}

# These inventories are checked against every executable plan block by
# tests/box-dry-run.test.ts. Keep the dispatch cases and these declarations in
# lockstep; a plan cannot acquire a new external operation by falling through.
# plan-subcommands: systemctl daemon-reload is-active list-timers reload restart show start stop
# plan-flags: systemctl --all --no-pager --property -p --quiet --value
# plan-subcommands: docker compose exec image-inspect inspect logs ps run
# plan-flags: docker --add-host --entrypoint --env --env-file -f --filter --format -i --network --no-deps -p --project-directory -q --rm --since --timestamps --volume -d
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
    case "$ssh_host" in
      ops@100.115.66.74|ops@yulan-vps-1) ssh_user=ops ;;
      commonswarm@100.115.66.74|commonswarm@yulan-vps-1) ssh_user=commonswarm ;;
      *) fail_unproduced 'ssh host' ;;
    esac
    # No remote command asks for an interactive login shell. The dry run has no terminal to give it.
    [ "$#" -gt 0 ] || fail_unproduced 'ssh interactive shell'
    run_in_box "$ssh_user" "$*"
    ;;
  scp)
    # The site window transfer preserves its protected source mode. Accept
    # only this plan's flag; destinations still receive the fixture's 0600 mode.
    preserve_times=0
    if [ "${1:-}" = -p ]; then preserve_times=1; shift; fi
    [ "$#" -eq 2 ] || fail_unproduced 'scp flags'
    case "$1" in -*) fail_unproduced 'scp flags' ;; esac
    source_path=$1
    destination=$2
    [ -f "$source_path" ] && [ ! -L "$source_path" ] || fail_unproduced 'scp regular source file'
    case "$destination" in
      ops@100.115.66.74:*|commonswarm@100.115.66.74:*|ops@yulan-vps-1:*|commonswarm@yulan-vps-1:*) ;;
      *) fail_unproduced 'scp target' ;;
    esac
    remote=${destination%%:*}
    target_path=${destination#*:}
    target_user=${remote%@*}
    target_host=${remote#*@}
    case "$target_path" in
      */../*|*/..|*'\n'*) fail_unproduced 'scp target path' ;;
    esac
    if [ "${BOX_DRY_RUN_PART:-mac}" = box ]; then
      case "$target_path" in /tmp/*) ;; *) fail_unproduced 'scp target' ;; esac
      logged_target=$target_path
    else
      # The destination is the box's /tmp. It lands in the fixture box root, and nowhere else.
      require_box_root
      box_root_real=$(cd "$box_root_dir" && pwd -P)
      box_target=$(printf '%s' "$target_path" | userland rewrite)
      case "$box_target" in "$box_root_real"/tmp/*) ;; *) fail_unproduced 'scp target' ;; esac
      logged_target=${box_target#"$box_root_real"}
      target_path=$box_target
    fi
    [ ! -L "$target_path" ] || fail_unproduced 'scp symlink target'
    if command -v shasum >/dev/null 2>&1; then
      source_sha256=$(shasum -a 256 "$source_path" | awk '{print $1}')
    else
      source_sha256=$(sha256sum "$source_path" | awk '{print $1}')
    fi
    if [ "$preserve_times" -eq 1 ]; then
      /bin/cp -p "$source_path" "$target_path"
    else
      /bin/cp "$source_path" "$target_path"
    fi
    chmod 0600 "$target_path"
    if [ "${BOX_DRY_RUN_PART:-mac}" = box ]; then
      /usr/bin/chown "$target_user:$target_user" "$target_path"
    else
      userland record-owner "$target_path" "$target_user" "$target_user"
    fi
    {
      printf 'scp-transfer source_sha256=%s target_user=%q target_host=%q target_path=%q\n' \
        "$source_sha256" "$target_user" "$target_host" "$logged_target"
    } >>"$BOX_DRY_RUN_STUB_LOG"
    ;;
  rsync)
    # Local-to-box (a release upload) and box-local (the box's own retention merge). Both land in the
    # fixture box root. The accepted flag sets are listed in box-userland.py.
    userland rsync "$@"
    ;;
  npm)
    # The site build is a declared non-substitutable surface (fixtures/non-substitutable.json). ci checks the
    # lock file and changes nothing; run build lays down the fixture dist tree. Nothing reaches a registry.
    case "$*" in
      ci)
        [ -f package.json ] && [ -f package-lock.json ] || { printf '%s\n' 'npm ERR! ci needs package.json and package-lock.json' >&2; exit 1; }
        ;;
      'run build')
        [ -f package.json ] && /usr/bin/grep -q '"build"' package.json || { printf '%s\n' 'npm ERR! missing script: build' >&2; exit 1; }
        dist_fixture=${BOX_DRY_RUN_DIST_FIXTURE:-}
        [ -n "$dist_fixture" ] && [ -d "$dist_fixture" ] || fail_unproduced 'site build output'
        mkdir -p dist
        /bin/cp -R "$dist_fixture/." dist/
        ;;
      *) unhandled_stub ;;
    esac
    ;;
  cp)
    cp_flags=()
    cp_operands=()
    for cp_argument in "$@"; do
      case "$cp_argument" in
        --reflink=auto) ;;
        -a) cp_flags+=("$cp_argument") ;;
        -*) unhandled_stub ;;
        *) cp_operands+=("$cp_argument") ;;
      esac
    done
    [ "${#cp_operands[@]}" -eq 2 ] || unhandled_stub
    exec /bin/cp ${cp_flags[@]+"${cp_flags[@]}"} "${cp_operands[@]}"
    ;;
  readlink)
    if [ "$#" -eq 2 ] && [ "$1" = -f ]; then
      exec /usr/bin/python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$2"
    fi
    if [ "$#" -eq 1 ]; then
      case "$1" in -*) unhandled_stub ;; esac
      exec /usr/bin/readlink "$1"
    fi
    unhandled_stub
    ;;
  chown|caddy)
    printf 'UNPRODUCED %s result\n' "$name" >&2
    exit 69
    ;;
  pgrep|ps)
    # A Mac block's view of the host's processes is the fixture's own table, which is empty: the dry run's Mac runs
    # no other release process. It never reads the real process table. The box's ps and pgrep are the box
    # userland's, ahead of this stub on a box script's PATH.
    BOX_DRY_RUN_PROCESS_TABLE=${BOX_DRY_RUN_MAC_PROCESSES:?Mac process table required} userland "$name" "$@"
    ;;
  sudo)
    sudo_user=root
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -u) [ "$#" -ge 2 ] || unhandled_stub; sudo_user=$2; shift 2 ;;
        -n|-i) shift ;;
        --) shift; break ;;
        -*) unhandled_stub ;;
        *) break ;;
      esac
    done
    [ "$#" -gt 0 ] || unhandled_stub
    if [ -n "${BOX_DRY_RUN_IN_REMOTE:-}" ]; then
      case "$sudo_user" in root|ops|commonswarm) ;; *) unhandled_stub ;; esac
      export BOX_DRY_RUN_REMOTE_USER="$sudo_user"
    fi
    if [ "${BOX_DRY_RUN_PART:-}" = box ]; then
      [ "${BOX_DRY_RUN_BOX_ROOT:-}" = / ] && [ "$(uname -s)" = Linux ] || unhandled_stub
      sudo_env=()
      for variable_name in $(compgen -e); do
        case "$variable_name" in BOX_DRY_RUN_*) sudo_env+=("$variable_name=${!variable_name}") ;; esac
      done
      case "$sudo_user" in root|ops|commonswarm) ;; *) unhandled_stub ;; esac
      root_log=$BOX_DRY_RUN_STUB_LOG
      if [ "$sudo_user" = root ]; then root_log=${BOX_DRY_RUN_ROOT_STUB_LOG:-$BOX_DRY_RUN_STUB_LOG}; fi
      exec /usr/bin/sudo -n -u "$sudo_user" /usr/bin/env -i \
        PATH="$PATH" LANG=C.UTF-8 TZ=UTC ${BASH_ENV:+BASH_ENV="$BASH_ENV"} \
        ${sudo_env[@]+"${sudo_env[@]}"} BOX_DRY_RUN_STUB_LOG="$root_log" "$@"
    fi
    exec "$@"
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
    # Read-only probes and refused programs do not own a Docker state product.
    # Allocate state only when a modeled mutation actually writes it.
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
        # The plan names containers by their Compose names (M11 and M17 in box-facts-measured.json).
        case "$target" in
          commonswarm-oauth-oauth-1) target=dry-run-oauth ;;
          commonswarm-edge-edge-runtime-1) target=dry-run-edge ;;
          commonswarm-postgres) target=dry-run-postgres ;;
        esac
        case "$format" in
          '{{range .Config.Env}}{{if eq . "SWARM_MCP_PUBLIC_ENABLED=1"}}enabled{{end}}{{end}}')
            [ "$target" = dry-run-edge ] || unhandled_stub
            case "${BOX_DRY_RUN_EDGE_PUBLIC_ENABLED:?measured edge flag required}" in
              0|unset) ;;
              1) printf '%s' enabled ;;
              *) unhandled_stub ;;
            esac
            ;;
          # M7 measured names only, and the production recheck measured no host
          # value (box-facts-measured.json:83-89, 383-386). Never infer it from extra_hosts.
          *'.Config.Env'*) fail_unproduced 'OAuth database host observation: no measured Config.Env host line' ;;
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
          dry-run-oauth) path_readback "${BOX_DRY_RUN_OAUTH_WORKDIR:?OAuth workdir required}" ;;
          *)
            if [ -f "$stub_state_dir/docker/edge-runtime-up" ]; then
              path_readback "${BOX_DRY_RUN_CANDIDATE_EDGE:?candidate edge required}/deploy/edge-runtime"
            else
              path_readback "${BOX_DRY_RUN_EDGE_WORKDIR:?edge workdir required}"
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
            --network|--add-host|--env|--env-file|--volume|--entrypoint)
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
            mkdir -p "$stub_state_dir/docker"
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
              commonswarm-edge:edge-runtime)
                mkdir -p "$stub_state_dir/docker"
                : >"$stub_state_dir/docker/edge-runtime-up" ;;
              commonswarm-supabase-stack:*)
                mkdir -p "$stub_state_dir/docker"
                printf '%s\n' "$1" >"$stub_state_dir/docker/stack-service-up" ;;
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
          node:-e|deno:eval)
            [ "$#" -eq 2 ] || unhandled_stub
            # Only this environment comparison has a committed readback (hm37-closure.txt:12).
            # All other container programs remain unproduced. Evaluate the comparison against fixture
            # state, so an enabled public endpoint fails rather than receiving a canned passing result.
            if [ "$container" = commonswarm-edge-edge-runtime-1 ] && [ "$runtime:$1" = deno:eval ] &&
               [ "$2" = 'Deno.exit(Deno.env.get("SWARM_MCP_PUBLIC_ENABLED") === "1" ? 1 : 0)' ]; then
              [ "${BOX_DRY_RUN_EDGE_PUBLIC_ENABLED:?edge public-enabled observation required}" != 1 ]
              exit $?
            fi
            # A program run inside a container needs the container. A Mac-side dry run has none, and it does
            # not answer for one.
            if [ "${BOX_DRY_RUN_PART:-mac}" = mac ]; then
              printf '%s\n' 'UNPRODUCED container program result' >&2
              exit 69
            fi
            ;;
          sh:-c)
            [ "$interactive" -eq 1 ] && [ "$#" -eq 2 ] || unhandled_stub
            # No container/database interpreter ran. SQL-shaped stdin cannot
            # establish zero live tokens or any other catalog/functional fact.
            fail_unproduced 'container database observation'
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
      # Official artifact and redirect observations are non-substitutable.
      # Refuse before opening any caller-supplied output, even on HEAD.
      fail_unproduced 'official Deno artifact and redirect observation'
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
    exec /usr/bin/env PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="${BOX_DRY_RUN_PYTHON_FIXTURE:?Python fixture path required}" /usr/bin/python3 "$@"
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
    # The Mac inventory is a local computation, not a hosted control. Run the real pinned binary;
    # accept only the runbook's file-only invocation, with Deno permissions closed to writes and network.
    if [ "${BOX_DRY_RUN_PART:-}" = mac ] && [ "${BOX_DRY_RUN_IN_REMOTE:-}" != 1 ] &&
       [ "$#" -eq 7 ] && [ "$1" = run ] && [ "$2" = --no-config ]; then
      case "$3" in --allow-read=*) inventory_root=${3#--allow-read=} ;; *) unhandled_stub ;; esac
      case "$inventory_root" in "${BOX_DRY_RUN_MAC_TMP:?Mac tmp required}"/commonswarm-router-??????) ;; *) unhandled_stub ;; esac
      [ "$4" = "$inventory_root/inventory.ts" ] && [ "$5" = "$inventory_root/router.ts" ] || unhandled_stub
      inventory_deno="${0%/*}/inventory-deno"
      if [ ! -f "$inventory_deno" ] || [ ! -x "$inventory_deno" ]; then
        printf '%s\n' 'deno unavailable: inventory.ts requires a real local Deno executable' >&2
        exit 69
      fi
      exec "$inventory_deno" run --no-prompt --cached-only --no-lock --no-code-cache --no-check "$2" "$3" "$4" "$5" "$6" "$7"
    fi
    if [ -n "${BOX_DRY_RUN_FAIL_STEP:-}" ] && [ "${BOX_DRY_RUN_FAIL_STEP}" = "${BOX_DRY_RUN_STEP:-}" ]; then
      printf 'injected dry-run failure: %s\n' "${BOX_DRY_RUN_STEP:-}" >&2
      exit 41
    fi
    # Without the actual executable there is no observed version, cache, or
    # program result. Fault injection above changes only status; journals and
    # consumer receipts must be written by the program that owns them.
    fail_unproduced 'Deno executable observation'
    ;;
  sleep)
    ;;
  browser-harness)
    # The dry run does not emulate a browser. Every program is refused, whatever its text. Browser surfaces
    # are declared in fixtures/non-substitutable.json and proved live by Anvil.
    printf '%s\n' 'UNPRODUCED browser session: the dry run does not emulate a browser' >&2
    unhandled_stub
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
