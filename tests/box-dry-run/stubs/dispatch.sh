#!/bin/bash
set -euo pipefail

name=${0##*/}
: "${BOX_DRY_RUN_STUB_LOG:?stub log required}"
printf '%s' "$name" >>"$BOX_DRY_RUN_STUB_LOG"
printf ' %q' "$@" >>"$BOX_DRY_RUN_STUB_LOG"
printf '\n' >>"$BOX_DRY_RUN_STUB_LOG"

case "$name" in
  ssh)
    if [ "${BOX_DRY_RUN_EXEC_SSH:-0}" = 1 ]; then
      /bin/bash -s -- "${@: -3}"
      exit $?
    fi
    counter=${BOX_DRY_RUN_SSH_COUNTER_FILE:-}
    count=0
    if [ -n "$counter" ]; then
      [ ! -f "$counter" ] || count=$(cat "$counter")
      count=$((count + 1))
      printf '%s\n' "$count" >"$counter"
    fi
    case " $* " in
      *'/srv/commonswarm/site'*'sha256sum'*)
        base=${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}
        printf '%s\n' \
          'measured_at=2026-09-28T01:02:03Z' \
          "previous_release=/srv/commonswarm/site/releases/$base" \
          "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/app/index.html" \
          "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/download/index.html"
        ;;
      *)
        printf '%s\n' 'UNPRODUCED ssh output' >&2
        exit 69
        ;;
    esac
    ;;
  scp|chown|caddy)
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
  *)
    printf 'unhandled dry-run stub: %s\n' "$name" >&2
    exit 69
    ;;
esac
