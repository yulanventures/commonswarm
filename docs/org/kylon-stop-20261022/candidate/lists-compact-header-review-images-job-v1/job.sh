#!/bin/sh
# SOURCE ONLY / UNRUN. Reuses exercised invitation-inbox-v2 lifecycle.
set -eu
# Exact adopted objects; no environment overrides. This grants no shared-lock slot.
CANDIDATE_CSS=site/src/styles/kylon-lists.css
LISTS_HEAD=9ed6cda1796a7124df805e392ee8386412d2c9c2
LISTS_TREE=9fc23475f2384098df486c58484af9634ea69e5c
LISTS_BASE=3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb
LISTS_BASE_TREE=601c359061d8d3f9de9882e6391c9dbde965346c
[ "$LISTS_HEAD" = 9ed6cda1796a7124df805e392ee8386412d2c9c2 ] || exit 1
[ "$LISTS_TREE" = 9fc23475f2384098df486c58484af9634ea69e5c ] || exit 1
[ "$LISTS_BASE" = 3a45f7f67ff8fb50a17de4a2ce2d7cafd20e20fb ] || exit 1
[ "$LISTS_BASE_TREE" = 601c359061d8d3f9de9882e6391c9dbde965346c ] || exit 1
[ "$CANDIDATE_CSS" = site/src/styles/kylon-lists.css ] || exit 1
case "$LISTS_HEAD:$CANDIDATE_CSS" in *UNFROZEN*) echo 'UNFROZEN candidate head' >&2; exit 1;; esac
# All checks above the first process/filesystem operation; no environment override.
[ "${#LISTS_HEAD}" -eq 40 ] || exit 1
case "$LISTS_HEAD" in *[!0-9a-f]*) echo 'UNFROZEN invalid candidate pin' >&2; exit 1;; esac
case "$CANDIDATE_CSS" in site/src/styles/*.css) :;; *) exit 1;; esac
css_name=${CANDIDATE_CSS#site/src/styles/}; css_name=${css_name%.css}
case "$css_name" in ''|*[!a-z0-9-]*) exit 1;; esac
test "$(id -u)" = 65534
test "$(uname -s)" = Linux
cd /tmp/qa
test -z "$(ls -A /tmp/qa)"
mkdir bootstrap-home bootstrap-tmp camera-home camera-tmp cache sources deps tools proofs records configs
: > /tmp/qa/global.npmrc
trap 'code=$?; if test "$code" -ne 0; then echo "Lists image job stopped with exit $code; inspect retained logs and partial image index" > /tmp/qa/records/job-failure.txt; fi' EXIT
run() {
  env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/qa/bootstrap-home TMPDIR=/tmp/qa/bootstrap-tmp \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
    npm_config_cache=/tmp/qa/cache/npm npm_config_userconfig=/dev/null npm_config_globalconfig=/tmp/qa/global.npmrc \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright "$@"
}
for lane in lists; do
  head="$LISTS_HEAD"
  mkdir "/tmp/qa/sources/$lane"
  run git -c core.hooksPath=/dev/null -c credential.helper= -C "/tmp/qa/sources/$lane" init --quiet
  run git -c core.hooksPath=/dev/null -c credential.helper= -C "/tmp/qa/sources/$lane" fetch --depth=1 https://github.com/yulanventures/commonswarm.git "$head"
  run git -c core.hooksPath=/dev/null -c credential.helper= -C "/tmp/qa/sources/$lane" checkout --quiet --detach FETCH_HEAD
  run git -c core.hooksPath=/dev/null -c credential.helper= -C "/tmp/qa/sources/$lane" fetch --depth=1 https://github.com/yulanventures/commonswarm.git "$LISTS_BASE"
done
# Exact single candidate dependency lock; no shared cache writes.
cp sources/lists/site/package.json sources/lists/site/package-lock.json deps/
run npm --prefix /tmp/qa/deps ci --ignore-scripts --no-audit --no-fund
cp /inputs/tools/package.json /inputs/tools/package-lock.json tools/
run npm --prefix /tmp/qa/tools ci --ignore-scripts --no-audit --no-fund
# No npm lifecycle scripts, browser download, build, test runner, or app transport.
exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/qa/camera-home TMPDIR=/tmp/qa/camera-tmp \
  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright ASTRO_DISABLE_UPDATE_CHECK=true ASTRO_TELEMETRY_DISABLED=1 CI=1 \
  node /inputs/camera.mjs
