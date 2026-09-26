#!/bin/bash
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "usage: current-client-build-sql.sh <sha>" >&2
  exit 2
fi

RELEASE_SHA=$1
PACKAGE_JSON=$(git show "${RELEASE_SHA}:package.json") || {
  echo "current-client-build-sql: SHA does not contain package.json" >&2
  exit 2
}
VERSION=$(printf '%s' "$PACKAGE_JSON" | node -e '
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => input += chunk);
  process.stdin.on("end", () => {
    let value;
    try { value = JSON.parse(input).version; } catch { process.exit(2); }
    if (typeof value !== "string") process.exit(2);
    process.stdout.write(value);
  });
') || {
  echo "current-client-build-sql: package.json has no valid version" >&2
  exit 2
}

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || [ "${#VERSION}" -gt 64 ]; then
  echo "current-client-build-sql: package version is not semver" >&2
  exit 2
fi

printf "INSERT INTO swarm.config (key, value) VALUES ('current_client_build', to_jsonb('%s'::text)) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;\n" "$VERSION"
