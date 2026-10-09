#!/usr/bin/env bash
set -eEuo pipefail
umask 077
PROOF=${1:?proof required}
shift
. "$(dirname "$0")/caddy-log-guards.sh"
prepare_caddy_access_logs "$PROOF/logs.private" "$@"
