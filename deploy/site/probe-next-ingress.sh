#!/bin/bash
# Prove the live ingress enforces Content-Security-Policy: frame-ancestors 'none'
# on /next, /next/, and /next/index.html before activating a preview-on release.
# Works while /next is still OFF (Caddy returns 404 carrying the header) or already ON (200).
#
# Usage: deploy/site/probe-next-ingress.sh [base-url]
set +x; set -euo pipefail; umask 077

BASE_URL=${1:-https://commonswarm.com}
BASE_URL=${BASE_URL%/}
[[ $# -le 1 && $BASE_URL =~ ^https?://[^[:space:]]+$ ]] || {
  echo 'Usage: probe-next-ingress.sh [base-url]' >&2
  exit 2
}

WORK=$(mktemp -d "${TMPDIR:-/tmp}/probe-next-ingress.XXXXXX")
cleanup() {
  case "$WORK" in */probe-next-ingress.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

failures=0
for path in /next /next/ /next/index.html; do
  status=$(curl --silent --show-error --compressed --max-time 20 --max-filesize 16777216 \
    -A CommonSwarmReleaseCheck/1.0 -H 'Cache-Control: no-cache' \
    -D "$WORK/headers" -o /dev/null -w '%{http_code}' "${BASE_URL}${path}") || status=000
  if [[ $status != 404 && $status != 200 ]]; then
    printf 'FAIL path=%s status=%s reason=unexpected-status\n' "$path" "$status" >&2
    failures=$((failures + 1))
    continue
  fi
  if ! tr -d '\r' < "$WORK/headers" | grep -Eiq "^content-security-policy:.*frame-ancestors[[:space:]]+'none'"; then
    printf 'FAIL path=%s status=%s reason=missing-frame-ancestors-none\n' "$path" "$status" >&2
    failures=$((failures + 1))
    continue
  fi
  printf 'PASS path=%s status=%s header=frame-ancestors-none\n' "$path" "$status"
done

if ((failures > 0)); then
  printf 'FAIL probe-next-ingress failures=%s base=%s\n' "$failures" "$BASE_URL" >&2
  exit 1
fi
printf 'PASS probe-next-ingress base=%s\n' "$BASE_URL"
