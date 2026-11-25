#!/bin/bash
# Prove the live ingress enforces a single exact Content-Security-Policy: frame-ancestors 'none'
# header on /next, /next/, and /next/index.html before activating a preview-on release.
# Works while /next is still OFF (Caddy returns 404 carrying the header) or already ON (200).
# With --expect-sha <sha256>, proves all three paths with a browser User-Agent and Accept: text/html
# under both compression and Accept-Encoding: identity return HTTP 200, the exact body SHA-256,
# a text/html content type, exact single frame-ancestors 'none', nosniff, no-referrer, and no-cache.
# Follows no redirects (curl without -L) and uses the shared check in refresh-site.py.
#
# Usage: deploy/site/probe-next-ingress.sh [base-url] [--expect-sha <sha256>]
set +x; set -euo pipefail; umask 077

usage() {
  echo 'Usage: probe-next-ingress.sh [base-url] [--expect-sha <sha256>]' >&2
  exit 2
}

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
BASE_URL=""
EXPECT_SHA=""
HAS_EXPECT_SHA=0
while (($# > 0)); do
  case "$1" in
    --expect-sha)
      (($# >= 2 && HAS_EXPECT_SHA == 0)) || usage
      EXPECT_SHA=$2
      HAS_EXPECT_SHA=1
      shift 2
      ;;
    --expect-sha=*)
      ((HAS_EXPECT_SHA == 0)) || usage
      EXPECT_SHA=${1#--expect-sha=}
      HAS_EXPECT_SHA=1
      shift
      ;;
    -*)
      usage
      ;;
    *)
      [[ -z $BASE_URL ]] || usage
      BASE_URL=$1
      shift
      ;;
  esac
done

BASE_URL=${BASE_URL:-https://commonswarm.com}
BASE_URL=${BASE_URL%/}
[[ $BASE_URL =~ ^https?://[^[:space:]]+$ ]] || usage
if ((HAS_EXPECT_SHA)) && [[ ! $EXPECT_SHA =~ ^[0-9a-f]{64}$ ]]; then
  usage
fi

WORK=$(mktemp -d "${TMPDIR:-/tmp}/probe-next-ingress.XXXXXX")
cleanup() {
  case "$WORK" in */probe-next-ingress.*) rm -rf "$WORK" ;; esac
}
trap cleanup EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

BROWSER_UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

failures=0
if ((HAS_EXPECT_SHA == 0)); then
  for path in /next /next/ /next/index.html; do
    : > "$WORK/headers"
    status=$(curl --silent --show-error --compressed --max-time 20 --max-filesize 16777216 \
      -A CommonSwarmReleaseCheck/1.0 -H 'Cache-Control: no-cache' \
      -D "$WORK/headers" -o /dev/null -w '%{http_code}' "${BASE_URL}${path}") || status=000
    if [[ $status != 404 && $status != 200 ]]; then
      printf 'FAIL path=%s status=%s reason=unexpected-status\n' "$path" "$status" >&2
      failures=$((failures + 1))
      continue
    fi
    if ! reason=$(python3 "$SCRIPT_DIR/refresh-site.py" --check-next-csp "$WORK/headers" 2>&1); then
      printf 'FAIL path=%s status=%s reason=%s\n' "$path" "$status" "${reason:-csp-check-failed}" >&2
      failures=$((failures + 1))
      continue
    fi
    printf 'PASS path=%s status=%s header=frame-ancestors-none\n' "$path" "$status"
  done
else
  for path in /next /next/ /next/index.html; do
    for encoding in compressed identity; do
      : > "$WORK/headers"
      : > "$WORK/body"
      if [[ $encoding == compressed ]]; then
        status=$(curl --silent --show-error --compressed --max-time 20 --max-filesize 16777216 \
          -A "$BROWSER_UA" -H 'Accept: text/html,application/xhtml+xml' -H 'Cache-Control: no-cache' \
          -D "$WORK/headers" -o "$WORK/body" -w '%{http_code}' "${BASE_URL}${path}") || status=000
      else
        status=$(curl --silent --show-error --max-time 20 --max-filesize 16777216 \
          -A "$BROWSER_UA" -H 'Accept: text/html,application/xhtml+xml' -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache' \
          -D "$WORK/headers" -o "$WORK/body" -w '%{http_code}' "${BASE_URL}${path}") || status=000
      fi
      if [[ $status != 200 ]]; then
        printf 'FAIL path=%s encoding=%s status=%s reason=unexpected-status\n' "$path" "$encoding" "$status" >&2
        failures=$((failures + 1))
        continue
      fi
      actual_sha=$(sha256_file "$WORK/body")
      if [[ $actual_sha != "$EXPECT_SHA" ]]; then
        printf 'FAIL path=%s encoding=%s status=%s reason=body-sha-mismatch got=%s\n' "$path" "$encoding" "$status" "$actual_sha" >&2
        failures=$((failures + 1))
        continue
      fi
      if ! reason=$(python3 "$SCRIPT_DIR/refresh-site.py" --check-next-html-headers "$WORK/headers" 2>&1); then
        printf 'FAIL path=%s encoding=%s status=%s reason=%s\n' "$path" "$encoding" "$status" "${reason:-html-headers-check-failed}" >&2
        failures=$((failures + 1))
        continue
      fi
      printf 'PASS path=%s encoding=%s status=%s sha256=%s\n' "$path" "$encoding" "$status" "$actual_sha"
    done
  done
fi

if ((failures > 0)); then
  printf 'FAIL probe-next-ingress failures=%s base=%s\n' "$failures" "$BASE_URL" >&2
  exit 1
fi
printf 'PASS probe-next-ingress base=%s\n' "$BASE_URL"
