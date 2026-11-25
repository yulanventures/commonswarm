#!/bin/bash
# Rendered off production; review and hash the packet before staging it.
set +x; set -euo pipefail; umask 077
B=@@RESERVE@@; S=/srv/commonswarm/site; N=$S/releases/@@RELEASE@@; STEP=guard; FLIPPED=0
# A disconnected SSH client must not interrupt checks or automatic rollback.
trap '' PIPE
exec >> "$B/hostrun.log" 2>&1
assert() { label=$1; shift; "$@" || { printf 'FAIL step=%s assertion=%s\n' "$STEP" "$label"; return 1; }; }
hash() { sha256sum "$1" | cut -d' ' -f1; }
flip() { ln -s "$1" "$S/current.@@RELEASE@@" && mv -Tf "$S/current.@@RELEASE@@" "$S/current"; }
probe() { : > "$B/probe.headers"; curl --silent --show-error --compressed --max-time 20 --max-filesize 16777216 -A CommonSwarmReleaseCheck/1.0 -H 'Cache-Control: no-cache' -D "$B/probe.headers" -o "$B/probe.html" -w '%{http_code}' "https://commonswarm.com$1"; }
has_next_csp() { python3 "$B/refresh-site.py" --check-next-csp "$B/probe.headers"; }
has_next_html_headers() { python3 "$B/refresh-site.py" --check-next-html-headers "$B/probe.headers"; }
rollback() {
  STEP=rollback; local old old_target unchanged=''; old=$(cat "$B/old.link") || return 1
  case $old in /*) assert old-directory test -d "$old";; *) assert old-directory test -d "$S/$old";; esac || return 1
  case $old in /*) old_target=$old;; *) old_target=$S/$old;; esac
  if [[ $(readlink "$S/current") == "$old" ]]; then unchanged=' unchanged'; else
    assert current-is-new test "$(readlink -f "$S/current")" = "$N" || return 1
    python3 "$B/refresh-site.py" "$(readlink -f "$S/current")" "$old_target" || return 1
    flip "$old" || return 1
    assert exact-old-link test "$(readlink "$S/current")" = "$old" || return 1
  fi
  for route in / /app; do assert rollback-httpstatus test "$(probe "$route")" = 200 || return 1; done
  printf 'PASS rollback%s\n' "$unchanged"
}
finish() { rc=$?; trap - EXIT; if ((rc)); then printf 'FAIL step=%s status=%s\n' "$STEP" "$rc"; if ((FLIPPED)); then rollback || printf 'FAIL rollback; retain reserve and lock\n'; fi; fi; exit "$rc"; }
trap finish EXIT; trap 'exit 130' INT; trap 'exit 143' TERM HUP
assert root-user test "$EUID" = 0; assert production-host test "$(hostname -s)" = yulan-vps-1; assert production-marker test ! -e /etc/commonswarm-release/STAGING-ONLY
assert refreshSHA test "$(hash "$B/refresh-site.py")" = '@@REFRESH_SHA@@'
assert reserve-directory test -d "$B"; assert current-symlink test -L "$S/current"; case ${1:-} in deploy) ;; rollback) rollback; exit;; *) exit 2;; esac
STEP=provenance; assert buildSHA test "$(hash "$B/BUILD.json")" = '@@BUILD_SHA@@'; assert artifactSHA test "$(hash "$B/site.tar")" = '@@ARTIFACT_SHA@@'
STEP=record-old; OLD=$(readlink -f "$S/current"); assert old-parent test "${OLD%/*}" = "$S/releases"; assert old-directory test -d "$OLD"; assert fresh-old-record test ! -e "$B/old.link"; readlink "$S/current" > "$B/old.link"
STEP=extract; mkdir "$N"; tar -xf "$B/site.tar" -C "$N" --no-same-owner
STEP=html; assert indexSHA test "$(hash "$N/index.html")" = '@@ROOT_SHA@@'; assert appSHA test "$(hash "$N/app/index.html")" = '@@APP_SHA@@'
if [[ '@@INCLUDE_NEXT@@' == 1 ]]; then assert nextSHA test "$(hash "$N/next/index.html")" = '@@NEXT_SHA@@'; fi
STEP=assets-and-freshness; python3 "$B/refresh-site.py" "$OLD" "$N"
find "$N" -type d -exec chmod 755 {} +; find "$N" -type f -exec chmod 644 {} +
if [[ '@@INCLUDE_NEXT@@' == 1 ]]; then
  for next_route in /next /next/ /next/index.html; do
    STEP=preflip-next-ingress; status=$(probe "$next_route"); printf 'CHECK step=%s path=%s http=%s\n' "$STEP" "$next_route" "$status"
    assert preflip-next-status test "$status" = 404 -o "$status" = 200
    assert preflip-next-csp has_next_csp
  done
fi
STEP=preflip; assert exact-old-link test "$(readlink "$S/current")" = "$(cat "$B/old.link")"; FLIPPED=1
STEP=flip; flip "$N"
for route in / /app; do
  STEP=http-root; expected='@@ROOT_SHA@@'; if [[ $route == /app ]]; then STEP=http-app; expected='@@APP_SHA@@'; fi
  status=$(probe "$route"); printf 'CHECK step=%s http=%s\n' "$STEP" "$status"
  assert httpstatus test "$status" = 200; assert httphash test "$(hash "$B/probe.html")" = "$expected"
done
if [[ '@@INCLUDE_NEXT@@' == 1 ]]; then
  next_ua='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  for next_route in /next /next/ /next/index.html; do
    for next_mode in release-check browser-compressed browser-identity; do
      STEP=http-next; : > "$B/probe.headers"
      case "$next_mode" in
        release-check) status=$(probe "$next_route");;
        browser-compressed) status=$(curl --silent --show-error --compressed --max-time 20 --max-filesize 16777216 -A "$next_ua" -H 'Accept: text/html,application/xhtml+xml' -H 'Cache-Control: no-cache' -D "$B/probe.headers" -o "$B/probe.html" -w '%{http_code}' "https://commonswarm.com$next_route");;
        browser-identity) status=$(curl --silent --show-error --max-time 20 --max-filesize 16777216 -A "$next_ua" -H 'Accept: text/html,application/xhtml+xml' -H 'Accept-Encoding: identity' -H 'Cache-Control: no-cache' -D "$B/probe.headers" -o "$B/probe.html" -w '%{http_code}' "https://commonswarm.com$next_route");;
      esac
      printf 'CHECK step=%s path=%s mode=%s http=%s\n' "$STEP" "$next_route" "$next_mode" "$status"
      assert httpstatus test "$status" = 200; assert httphash test "$(hash "$B/probe.html")" = '@@NEXT_SHA@@'
      assert next-html-headers has_next_html_headers
    done
  done
  for asset in @@NEXT_ASSETS@@; do
    STEP=http-next-asset; status=$(probe "$asset"); printf 'CHECK step=%s path=%s http=%s\n' "$STEP" "$asset" "$status"
    assert httpstatus test "$status" = 200; assert next-asset-hash test "$(hash "$B/probe.html")" = "$(hash "$N$asset")"
    assert next-asset-csp has_next_csp
  done
fi
STEP=verify; assert current-is-new test "$(readlink -f "$S/current")" = "$N"; FLIPPED=0; printf 'PASS deploy revision=@@REVISION@@ H0=@@H0@@ NEXT=@@INCLUDE_NEXT@@\n'
# Rollback (same held Mac release lock): sudo -n bash @@RESERVE@@/SITE-DIRECT.sh rollback
