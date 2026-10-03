#!/bin/bash
# Offline validation and deterministic ZIP construction; no services or credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 scripts/chatgpt-package.py "$@"
