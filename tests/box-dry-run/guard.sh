#!/bin/bash
set -euo pipefail

refuse() {
  printf 'REFUSE: %s\n' "$1" >&2
  exit 77
}

[ "${BOX_DRY_RUN:-}" = 1 ] || refuse 'BOX_DRY_RUN=1 is required'
[ "${GITHUB_ACTIONS:-}" = true ] || refuse 'GITHUB_ACTIONS=true is required'
[ "${CI:-}" = true ] || refuse 'CI=true is required'
[ "$(uname -s)" = Linux ] || refuse 'Linux is required'
[ "$(hostname -s)" != yulan-vps-1 ] || refuse 'production hostname is forbidden'
[ "$(id -u)" -eq 0 ] || refuse 'root is required for real-path fixtures'
[ ! -e /home/commonswarm ] && [ ! -L /home/commonswarm ] || refuse '/home/commonswarm existed before the test'
[ ! -e /srv/commonswarm ] && [ ! -L /srv/commonswarm ] || refuse '/srv/commonswarm existed before the test'
printf '%s\n' 'BOX_DRY_RUN_GUARD=PASS'
