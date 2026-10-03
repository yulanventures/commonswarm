#!/bin/bash
# Sourced by each dry-run child.  It adapts external boundaries only; the
# markdown block following this prelude is executed byte-for-byte as one unit.

box_dry_run_record() {
  : "${BOX_DRY_RUN_STUB_LOG:?stub log required}"
  printf '%s' "$1" >>"$BOX_DRY_RUN_STUB_LOG"
  shift
  printf ' %q' "$@" >>"$BOX_DRY_RUN_STUB_LOG"
  printf '\n' >>"$BOX_DRY_RUN_STUB_LOG"
}

case "${BOX_DRY_RUN_CONTROL:-}" in
  historical-*|b912-second-open)
    test() { builtin test "$@" || return 0; }
    export -f test
    ;;
esac
git() {
  box_dry_run_record git "$@"
  # A dry run never touches the network. The only remote it knows is the repository the plan names; a clone of
  # it is a clone of the dry run's own temporary checkout, with the plan's URL as origin. Every other
  # operation that talks to a remote is refused, not answered.
  local git_arguments=("$@") git_index=0 git_subcommand=''
  while [ "$git_index" -lt "${#git_arguments[@]}" ]; do
    case "${git_arguments[$git_index]}" in
      -C|-c|--git-dir|--work-tree) git_index=$((git_index + 2)) ;;
      -*) git_index=$((git_index + 1)) ;;
      *) git_subcommand=${git_arguments[$git_index]}; break ;;
    esac
  done
  case "$git_subcommand" in
    clone)
      local git_url='' git_destination='' git_flags=() git_argument
      for git_argument in "${git_arguments[@]:$((git_index + 1))}"; do
        case "$git_argument" in
          --no-checkout) git_flags+=("$git_argument") ;;
          -*) printf 'UNPRODUCED git clone flag %s\n' "$git_argument" >&2; return 69 ;;
          *) if [ -z "$git_url" ]; then git_url=$git_argument; else git_destination=$git_argument; fi ;;
        esac
      done
      if [ "$git_url" != https://github.com/yulanventures/commonswarm.git ] || [ -z "$git_destination" ] || [ -z "${BOX_DRY_RUN_SOURCE_CLONE:-}" ]; then
        printf 'UNPRODUCED network git operation: git clone %s\n' "$git_url" >&2
        return 69
      fi
      command git clone --no-hardlinks ${git_flags[@]+"${git_flags[@]}"} "$BOX_DRY_RUN_SOURCE_CLONE" "$git_destination" || return $?
      command git -C "$git_destination" remote set-url origin "$git_url" || return $?
      # The repository's own view of origin/main stands for the remote's main. Without one, the clone has
      # none, and a block that needs it fails on its own check.
      [ -z "${BOX_DRY_RUN_ORIGIN_MAIN:-}" ] || command git -C "$git_destination" update-ref refs/remotes/origin/main "$BOX_DRY_RUN_ORIGIN_MAIN"
      ;;
    fetch)
      # Fetch the harness's measured origin/main object from its temporary clone. This transfers real Git
      # objects and updates the fixture ref; it neither contacts GitHub nor supplies a success-shaped echo.
      if [ "${git_arguments[*]:$git_index}" != 'fetch origin main' ] ||
         [ "$(command git "${git_arguments[@]:0:$git_index}" remote get-url origin)" != https://github.com/yulanventures/commonswarm.git ] ||
         [ -z "${BOX_DRY_RUN_SOURCE_CLONE:-}" ] || [ -z "${BOX_DRY_RUN_ORIGIN_MAIN:-}" ]; then
        printf '%s\n' 'UNPRODUCED exact-SHA checkout preparation' >&2
        return 69
      fi
      command git "${git_arguments[@]:0:$git_index}" fetch --no-tags "$BOX_DRY_RUN_SOURCE_CLONE" \
        "$BOX_DRY_RUN_ORIGIN_MAIN:refs/remotes/origin/main"
      ;;
    pull|push|ls-remote|submodule)
      printf 'UNPRODUCED network git operation: git %s\n' "$git_subcommand" >&2
      return 69
      ;;
    *) command git "$@" ;;
  esac
}

python3() {
  box_dry_run_record python3 "$@"
  if [ -n "${BOX_DRY_RUN_FAIL_STEP:-}" ] && [ "${BOX_DRY_RUN_FAIL_STEP}" = "${BOX_DRY_RUN_STEP:-}" ]; then
    printf 'injected dry-run failure: %s\n' "${BOX_DRY_RUN_STEP:-}" >&2
    return 41
  fi
  if [ "${BOX_DRY_RUN_CONTROL:-}" = b912-second-open ]; then
    printf '%s\n' 'STOP: existing release directory cannot be reopened after rollback' >&2
    return 42
  fi
  command python3 "$@"
}

node() {
  box_dry_run_record node "$@"
  command node "$@"
}

release_psql() {
  box_dry_run_record release_psql "$@"
  printf '%s\n' 'UNPRODUCED database observation' >&2
  return 69
}

release_psql_ro() {
  box_dry_run_record release_psql_ro "$@"
  printf '%s\n' 'UNPRODUCED database observation' >&2
  return 69
}

date() {
  box_dry_run_record date "$@"
  if [ "${BOX_DRY_RUN_CONTROL:-}" = b912-second-open ]; then
    case " $* " in
      *' -d '*'+%s'*) printf '%s\n' 1790557323; return 0 ;;
      *' -d '*'+%Y%m%dT%H%M%SZ'*) printf '%s\n' 20260928T010203Z; return 0 ;;
      *' -d '*'+%H%M%S'*) printf '%s\n' 010203; return 0 ;;
    esac
  fi
  if [ "${BOX_DRY_RUN_PART:-}" = box ]; then
    # The Mac producer and every box consumer share one fixture clock. GNU
    # date on the host would observe a different time from the local writer.
    /usr/bin/python3 "${BOX_DRY_RUN_USERLAND:?box userland required}" date "$@"
    return $?
  fi
  command date "$@"
}

install() {
  box_dry_run_record install "$@"
  if [ "${BOX_DRY_RUN_CONTROL:-}" = b912-second-open ]; then
    filtered=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        -o|-g) shift 2 ;;
        *) filtered[${#filtered[@]}]="$1"; shift ;;
      esac
    done
    command install "${filtered[@]}"
  else
    command install "$@"
  fi
}

export -f box_dry_run_record git python3 node release_psql release_psql_ro date install
