#!/bin/bash
# Sourced by each dry-run child.  It adapts external boundaries only; the
# markdown block following this prelude is executed byte-for-byte as one unit.

case "${BOX_DRY_RUN_CONTROL:-}" in
  historical-*|b912-second-open)
    test() { builtin test "$@" || return 0; }
    export -f test
    ;;
esac
git() {
  case " $* " in
    *' remote get-url origin '*) printf '%s\n' 'https://github.com/yulanventures/commonswarm.git' ;;
    *' fetch origin main '*) return 0 ;;
    *' status --porcelain '*) return 0 ;;
    *' diff --exit-code HEAD -- site deploy/site '*) return 0 ;;
    *) command git "$@" ;;
  esac
}

python3() {
  if [ "${BOX_DRY_RUN_FAIL_STEP:-}" = "${BOX_DRY_RUN_STEP:-}" ]; then
    printf 'injected dry-run failure: %s\n' "$BOX_DRY_RUN_STEP" >&2
    return 41
  fi
  if [ "${BOX_DRY_RUN_CONTROL:-}" = b912-second-open ] && [ "${BOX_DRY_RUN_STEP:-}" = 1-apply-release-directories ]; then
    printf '%s\n' 'STOP: existing release directory cannot be reopened after rollback' >&2
    return 42
  fi
  case "${BOX_DRY_RUN_STEP:-}" in
    hm37-source-identity|hm37-hm6-oauth-precondition|hm37-hm6-oauth-refusal-probe|hm37-backup-gate|hm37-public-boundary-reads|hm37-public-boundaries|site-03*|site-05*)
      command python3 "$@"
      ;;
    *)
      printf '%s\n' 'dry-run python PASS'
      ;;
  esac
}

node() {
  case "${BOX_DRY_RUN_STEP:-}" in
    site-03*|runbook-44) command node "$@" ;;
    hm37-hosted-human-session-input)
      output=${4:?dry-run human-session output missing}
      printf '%s\n' '{"access_token":"dry-run-placeholder"}' >"$output"
      chmod 0600 "$output"
      ;;
    *) printf '%s\n' 'dry-run node PASS' ;;
  esac
}

release_psql() {
  printf '%s\n' "${BOX_DRY_RUN_PSQL_RESULT:-t}"
}

release_psql_ro() {
  case " $* " in
    *"20260928000004"*"count"*) printf '%s\n' 0 ;;
    *"20260928000004-catalog.sql"*) printf '%s\n' f ;;
    *"ORDER BY version"*)
      printf '%s\n' 20260916000001 20260916000002 20260925000001 20260926000001 20260927000001 20260927000002 20260927000003 20260928000001 20260928000002 20260928000003
      ;;
    *) printf '%s\n' "${BOX_DRY_RUN_PSQL_RESULT:-t}" ;;
  esac
}

date() {
  if [ "${BOX_DRY_RUN_CONTROL:-}" = b912-second-open ]; then
    case " $* " in
      *' -d '*'+%s'*) printf '%s\n' 1790557323; return 0 ;;
      *' -d '*'+%Y%m%dT%H%M%SZ'*) printf '%s\n' 20260928T010203Z; return 0 ;;
      *' -d '*'+%H%M%S'*) printf '%s\n' 010203; return 0 ;;
    esac
  fi
  if [ "${BOX_DRY_RUN_PART:-}" = box ]; then
    case " $* " in
      *' -d 2026-09-28T01:02:03Z '*'+%s'*) printf '%s\n' 1790557323; return 0 ;;
      *' -d 2026-09-28T05:02:03Z '*'+%s'*) printf '%s\n' 1790571723; return 0 ;;
      *' -d 2026-09-28T01:02:03Z '*'+%Y%m%dT%H%M%SZ'*) printf '%s\n' 20260928T010203Z; return 0 ;;
      *' -d 2026-09-28T01:02:03Z '*'+%H%M%S'*) printf '%s\n' 010203; return 0 ;;
      *' -d @1790557323 '*'+%Y-%m-%d'*) printf '%s\n' 2026-09-28; return 0 ;;
      *' -d 2026-09-28\ 00:00:00 '*'+%s'*) printf '%s\n' 1790553600; return 0 ;;
      ' -u +%s ') printf '%s\n' 1790560923; return 0 ;;
    esac
  fi
  command date "$@"
}

install() {
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

export -f git python3 node release_psql release_psql_ro date install
