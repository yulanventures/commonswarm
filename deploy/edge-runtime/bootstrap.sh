#!/usr/bin/env bash
set -euo pipefail

staged_functions=/var/tmp/commonswarm-functions
mkdir -p "$staged_functions"
cp -R /home/deno/functions-source/. "$staged_functions/"
cp /home/deno/deploy/h0-deno.json "$staged_functions/h0/deno.json"
chmod -R a-w "$staged_functions"

exec /usr/local/bin/edge-runtime "$@"
