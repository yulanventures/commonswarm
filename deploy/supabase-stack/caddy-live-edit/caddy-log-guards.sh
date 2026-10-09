#!/usr/bin/env bash
# Exact log helpers from RELEASE-TO-BOX.md runbook-57. Source after setting CADDY_LOG_EVIDENCE.
  check_caddy_access_log_path() {
    local CADDY_LOG_PATH=$1
    local CADDY_LOG_REAL
    case "$CADDY_LOG_PATH" in /var/log/caddy/?*) ;; *) false ;; esac
    case "$CADDY_LOG_PATH" in
      *'/../'*|*/..|*'/./'*|*/.|*'//'*) false ;;
    esac
    CADDY_LOG_REAL=$(realpath -m -- "$CADDY_LOG_PATH")
    test "$CADDY_LOG_REAL" = "$CADDY_LOG_PATH"
  }
  record_caddy_access_logs() {
    local CADDY_LOG_STAGE=$1
    local CADDY_LOG_EVIDENCE=$2
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift 2
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        test ! -L "$CADDY_LOG_PATH"
        test -f "$CADDY_LOG_PATH"
        test "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" = caddy:caddy
        test "$(stat -c '%a' "$CADDY_LOG_PATH")" = 600
        printf '%s %s owner=%s mode=%s\n' \
          "$CADDY_LOG_STAGE" "$CADDY_LOG_PATH" \
          "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" \
          "$(stat -c '%a' "$CADDY_LOG_PATH")" >>"$CADDY_LOG_EVIDENCE"
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
  }
  prepare_caddy_access_logs() {
    local CADDY_LOG_EVIDENCE=$1
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        if [ -L "$CADDY_LOG_PATH" ]; then
          false
        elif [ -e "$CADDY_LOG_PATH" ]; then
          test -f "$CADDY_LOG_PATH"
          chown caddy:caddy "$CADDY_LOG_PATH"
          chmod 0600 "$CADDY_LOG_PATH"
        else
          install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG_PATH"
        fi
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
    record_caddy_access_logs before-validate "$CADDY_LOG_EVIDENCE" "$@"
  }
