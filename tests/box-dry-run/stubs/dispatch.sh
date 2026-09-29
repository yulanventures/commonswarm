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
    case "${BOX_DRY_RUN_STEP:-}" in
      hm37-read-window-suffix)
        printf '%s\n' 'WINDOW_PRINCIPAL_SUFFIX=010203'
        ;;
      site-01*)
        base=${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}
        printf '%s\n' \
          'measured_at=2026-09-28T01:02:03Z' \
          "previous_release=/srv/commonswarm/site/releases/$base" \
          "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/app/index.html" \
          "0000000000000000000000000000000000000000000000000000000000000000  /srv/commonswarm/site/releases/$base/download/index.html"
        ;;
      site-04*)
        if [ "$count" -le 2 ]; then
          printf '/srv/commonswarm/site/releases/%s\n' "${BOX_DRY_RUN_SITE_BASE_RELEASE:?measured site base required}"
        else
          printf '%s\n' '/srv/commonswarm/site/releases/20260928T010203Z-8b8989f2b29e-deadbeefdeadbeef'
        fi
        ;;
      *)
        printf '%s\n' "${BOX_DRY_RUN_SSH_OUTPUT:-stubbed box response}"
        ;;
    esac
    ;;
  scp|chown|caddy)
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
    printf '%s\n' 'op-placeholder-never-a-secret'
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
      *' ps -q '*) printf '%s\n' dry-run-container ;;
      *' inspect '*'.Config.Env'*) printf '%s=%s\n' "${BOX_DRY_RUN_OAUTH_DATABASE_HOST_ENV_NAME:?OAuth host name required}" db.commonswarm.internal ;;
      *' inspect '*'.Image'*) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:-sha256:0000000000000000000000000000000000000000000000000000000000000000}" ;;
      *' inspect '*Health.Status*) printf '%s\n' healthy ;;
      *' inspect '*State.Health*) printf '%s\n' healthy ;;
      *' inspect '*HostConfig.Memory*) printf '%s\n' "${BOX_DRY_RUN_EDGE_MEMORY:?edge memory required}" ;;
      *' inspect '*HostConfig.NetworkMode*) printf '%s\n' "${BOX_DRY_RUN_EDGE_NETWORK:?edge network required}" ;;
      *' inspect '*Mounts*) printf '%s\n' "${BOX_DRY_RUN_EXPECTED_EDGE:?expected edge required}/deploy/edge-runtime/main /app/main" ;;
      *' inspect '*working_dir*)
        case "${BOX_DRY_RUN_STEP:-}" in
          hm37-hm6-oauth-precondition) printf '%s/deploy/mcp-auth\n' "${BOX_DRY_RUN_OAUTH_RELEASE:?OAuth release required}" ;;
          runbook-33) printf '%s/deploy/edge-runtime\n' "${BOX_DRY_RUN_CANDIDATE_EDGE:?candidate edge required}" ;;
          *) printf '%s\n' "${BOX_DRY_RUN_EXPECTED_EDGE:?expected edge required}/deploy/edge-runtime" ;;
        esac
        ;;
      *' image inspect '*) printf '%s\n' "${BOX_DRY_RUN_POSTGRES_IMAGE_ID:-sha256:0000000000000000000000000000000000000000000000000000000000000000}" ;;
      *' run '*)
        case "${BOX_DRY_RUN_STEP:-} $* " in
          runbook-26*'SELECT count('*20260928000004*) printf '%s\n' 0 ;;
          runbook-26*) printf '%s\n' f ;;
          runbook-28*'SELECT count('*20260928000004*) printf '%s\n' 1 ;;
          runbook-28*) printf '%s\n' t ;;
          *'/proof/20260928000004-catalog.sql'*) printf '%s\n' f ;;
          *'ORDER BY version'*) printf '%s\n' 20260916000001 20260916000002 20260925000001 20260926000001 20260927000001 20260927000002 20260927000003 20260928000001 20260928000002 20260928000003 ;;
          *'SELECT count('*20260928000004*) printf '%s\n' 0 ;;
          *) printf '%s\n' "${BOX_DRY_RUN_PSQL_RESULT:-t}" ;;
        esac
        ;;
    esac
    ;;
  curl)
    if [ "${BOX_DRY_RUN_STEP:-}" = hm37-deno-install ]; then
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
    fi
    if [ "${BOX_DRY_RUN_STEP:-}" = runbook-34 ]; then
      headers=''
      body=''
      previous=''
      for argument in "$@"; do
        case "$previous" in
          -D) headers=$argument ;;
          -o) body=$argument ;;
        esac
        previous=$argument
      done
      [ -z "$headers" ] || printf '%s\n' 'HTTP/1.1 401 Unauthorized' 'content-type: application/json' >"$headers"
      [ -z "$body" ] || printf '%s\n' '{"error":"unauthorized"}' >"$body"
      printf '%s' 401
      exit 0
    fi
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
    printf '%s\n' t
    ;;
  python3)
    exec /usr/bin/python3 "$@"
    ;;
  tar)
    # Archive creation/extraction is outside the state semantics exercised here.
    # The call is still recorded; fixture builders provide the resulting trees.
    case " $* " in
      *' -xOf '*router.ts*) printf '%s\n' 'export const REQUIRED_MAIN_ENV=[]; export const COMMAND_TEST_HOOKS=new Set(); export const FUNCTION_ENV_NAMES={command:[],read:[],capability:[],activity:[],h0:[],mcp:[]};' ;;
      *' -xf - '*) while IFS= read -r _line; do :; done ;;
      *' -xf '*'-C '*)
        destination=''
        previous=''
        for argument in "$@"; do
          if [ "$previous" = -C ]; then destination=$argument; break; fi
          previous=$argument
        done
        if [ -n "$destination" ]; then
          mkdir -p "$destination/deploy/edge-runtime/main" \
            "$destination/deploy/supabase-stack/migrate" \
            "$destination/deploy/supabase-stack/backup" \
            "$destination/deploy/supabase-stack/postgres" \
            "$destination/supabase/migrations" \
            "$destination/services/mcp-auth/src" \
            "$destination/supabase/functions/command" \
            "$destination/supabase/functions/_shared"
          printf '%s\n' 'services: {}' >"$destination/deploy/edge-runtime/compose.yaml"
          printf '%s\n' '// dry-run router fixture' >"$destination/deploy/edge-runtime/main/router.ts"
          printf '%s\n' 'services: {}' >"$destination/deploy/supabase-stack/compose.yaml"
          printf '%s\n' '#!/bin/sh' 'exit 0' >"$destination/deploy/supabase-stack/migrate/run-db-tool.sh"
          chmod 0755 "$destination/deploy/supabase-stack/migrate/run-db-tool.sh"
          if [ -n "${BOX_DRY_RUN_SOURCE_ROOT:-}" ]; then
            cp "$BOX_DRY_RUN_SOURCE_ROOT/supabase/migrations/20260928000003_hm_oauth_store.sql" \
              "$destination/supabase/migrations/20260928000003_hm_oauth_store.sql"
          else
            printf '%s\n' '-- fixture' >"$destination/supabase/migrations/20260928000003_hm_oauth_store.sql"
          fi
          printf '%s\n' '-- fixture' >"$destination/supabase/migrations/20260928000004_hm_hosted_check.sql"
        fi
        ;;
    esac
    ;;
  deno)
    if [ -n "${BOX_DRY_RUN_FAIL_STEP:-}" ] && [ "${BOX_DRY_RUN_FAIL_STEP}" = "${BOX_DRY_RUN_STEP:-}" ]; then
      if [ "${BOX_DRY_RUN_STEP:-}" = hm37-hosted-open-ack-control ]; then
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
      *' run '*' --cleanup-only '*)
        printf '%s\n' '{"ok":true,"mode":"cleanup-only","principal_id":"00000000-0000-4000-8000-000000000001","grant_id":"00000000-0000-4000-8000-000000000002","cleanup":{"seat_revoked":true,"handle_revoked":true,"principal_revoked":true,"grant_revoked":true,"active_agent_tokens":0,"provider_family_active":false,"active_provider_artifacts":0,"authorization_refused":true,"open_refused":true,"ack_refused":true,"completed_at":"2026-09-28T01:02:03.000Z"},"assertions":{"hosted.cleanup-complete":true}}'
        ;;
      *' run '*hm37-open-ack-control.ts*)
        printf '%s\n' '{"ok":true,"mode":"control","grant_id":"00000000-0000-4000-8000-000000000001","seat_id":"00000000-0000-4000-8000-000000000002","principal_id":"00000000-0000-4000-8000-000000000003","observations":{"concurrent_opens_status":[200,200],"active_batches_after_open":1,"committed_cursor_after_open":null,"fresh_open_same_batch":true,"public_open_status":403,"public_ack_status":403,"human_open_status":403,"human_ack_status":403,"request_user_agent":"commonswarm-release-probe/1.0","public_refusal_snapshot_unchanged":true,"repeat_ack_unchanged":true,"empty_batch_id":null,"active_batches_after_empty_open":0,"migration_04_functional":"t","signal_a_id":"00000000-0000-4000-8000-000000000004","concurrent_ordered_ids":["00000000-0000-4000-8000-000000000004"],"batch_a_terminal":{"created_at":"2026-09-28T01:02:03.000Z","signal_id":"00000000-0000-4000-8000-000000000004"},"cursor_after_a":{"created_at":"2026-09-28T01:02:03.000Z","signal_id":"00000000-0000-4000-8000-000000000004"},"cursor_after_b":{"created_at":"2026-09-28T01:02:03.000Z","signal_id":"00000000-0000-4000-8000-000000000005"}},"cleanup":{"seat_revoked":true,"handle_revoked":true,"principal_revoked":true,"grant_revoked":true,"active_agent_tokens":0,"provider_family_active":false,"active_provider_artifacts":0,"authorization_refused":true,"open_refused":true,"ack_refused":true,"completed_at":"2026-09-28T01:02:03.000Z"},"assertions":{"hosted.concurrent-open-single-batch":true,"hosted.ack-a-commits-cursor":true,"hosted.repeat-ack-idempotent":true,"hosted.ack-b-empty-open":true,"hosted.public-unauthenticated-refusal":true,"hosted.public-human-bearer-refusal":true,"hosted.seat-handle-alone-refusal":true,"hosted.visibility-confined":true,"hosted.migration-functional-proof":true,"hosted.cleanup-complete":true}}'
        ;;
      *inventory.ts*) printf '%s\n' '{"required":["SUPABASE_URL"],"optional":[]}' ;;
      *) printf '%s\n' 'dry-run deno PASS' ;;
    esac
    ;;
  sleep)
    ;;
  *)
    printf 'unhandled dry-run stub: %s\n' "$name" >&2
    exit 69
    ;;
esac
