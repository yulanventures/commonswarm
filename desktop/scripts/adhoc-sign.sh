#!/usr/bin/env bash
# Apple silicon refuses to launch unsigned arm64 apps.
# Ad-hoc signing attaches a local signature without an Apple identity or keychain.
set -euo pipefail

APP_PATH="${1:-}"
if [[ -z "$APP_PATH" || ! -d "$APP_PATH" ]]; then
  echo "Usage: $0 <path-to-.app>" >&2
  exit 1
fi

codesign --force --deep --sign - "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
