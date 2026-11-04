#!/usr/bin/env bash
# Release gate for the PDF parser worker (MCP parity 1b). Run on the box BEFORE setting
# SWARM_FILE_TEXT_TOKEN on the production edge. It starts a THROWAWAY edge container from
# the pinned image with this release's main and functions, the production env file and a
# throwaway token, installs deploy/edge-runtime/file-text-probe/index.ts in place of the
# parser, asks main for one extraction from inside the container, and prints outcome
# labels only (never a value read). The production edge container is not touched.
#
#   deploy/edge-runtime/file-text-probe.sh [/home/commonswarm/.env]
#
# Exit 0: every secret-bearing path is unreadable (denied or NotFound), network/env/write
# are denied, subprocesses do not run. Exit 3: the parser must stay disabled; do not
# broaden permissions. Exit 2: the probe could not run; treat as not passed.
set -euo pipefail

env_file="${1:-/home/commonswarm/.env}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
image="$(sed -n 's/^[[:space:]]*image:[[:space:]]*\(public\.ecr\.aws\/supabase\/edge-runtime:[^[:space:]]*\)[[:space:]]*$/\1/p' "$here/compose.yaml" | head -n 1)"
[[ -n "$image" ]] || { echo '{"probe":"no_image_pin"}'; exit 2; }
[[ -r "$env_file" ]] || { echo '{"probe":"env_file_unreadable"}'; exit 2; }

work="$(mktemp -d /tmp/file-text-probe.XXXXXX)"
name="file-text-probe-$(basename "$work" | tr -dc 'a-zA-Z0-9')"
container=""
cleanup() {
  # Only a container this run created, by its ID: never by name, which another run could own.
  if [[ -n "$container" ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  # Only the directory this script created.
  if [[ "$work" == /tmp/file-text-probe.* && -d "$work" ]]; then rm -rf -- "$work"; fi
}
trap cleanup EXIT

umask 077
cp -R "$repo/supabase/functions" "$work/functions"
cp "$here/file-text-probe/index.ts" "$work/functions/file-text/index.ts"
token="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf 'SWARM_FILE_TEXT_TOKEN=%s\n' "$token" > "$work/token.env"

# The same image, entrypoint, command, mounts and memory limit as compose.yaml. No port is
# published and the default bridge is used: the probe needs neither the database nor Kong.
container="$(docker run -d --name "$name" --init --memory 512m \
  --env-file "$env_file" --env-file "$work/token.env" \
  -v "$here/main:/home/deno/main:ro" \
  -v "$here/bootstrap.sh:/home/deno/deploy/bootstrap.sh:ro" \
  -v "$here/h0-deno.json:/home/deno/deploy/h0-deno.json:ro" \
  -v "$work/functions:/home/deno/functions-source:ro" \
  -v "$repo/src:/var/src:ro" \
  --entrypoint /bin/bash "$image" /home/deno/deploy/bootstrap.sh \
  start --main-service /home/deno/main --port 9000 --policy per_worker --max-parallelism 4)" \
  || { container=""; echo '{"probe":"container_not_created"}'; exit 2; }
[[ "$container" =~ ^[0-9a-f]{12,64}$ ]] || { container=""; echo '{"probe":"container_not_created"}'; exit 2; }

ready=0
for _ in $(seq 1 60); do
  if docker exec "$container" /usr/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000 && printf "GET /health HTTP/1.0\r\n\r\n" >&3 && IFS= read -r s <&3 && [[ "$s" == *" 200 "* ]]' >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 1
done
[[ "$ready" == 1 ]] || { echo '{"probe":"edge_not_ready"}'; exit 2; }

# A one-page PDF; the probe ignores its content.
pdf=$'%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
raw="$(printf 'POST /__internal/file-text HTTP/1.0\r\nHost: 127.0.0.1\r\nx-commonswarm-file-text: %s\r\nContent-Type: application/pdf\r\nContent-Length: %s\r\nConnection: close\r\n\r\n%s' \
  "$token" "${#pdf}" "$pdf" | docker exec -i "$container" /usr/bin/bash -c 'exec 3<>/dev/tcp/127.0.0.1/9000; cat >&3; cat <&3')"

python3 - "$raw" <<'PY'
import json, sys
raw = sys.argv[1]
status = raw.split(" ", 2)[1] if raw.startswith("HTTP/") else "none"
body = raw.split("\r\n\r\n", 1)[1] if "\r\n\r\n" in raw else ""
try:
    results = json.loads(json.loads(body)["text"])
except Exception:
    print(json.dumps({"probe": "no_result", "status": status}))
    sys.exit(2)
# The complete, exact outcome set: a missing key never passes.
READS = ["read_own_source", "read_proc_self_environ", "read_proc_1_environ", "read_staged_mcp",
         "read_source_mcp", "read_main", "read_repo_src", "read_bootstrap"]
EXPECTED = set(["net", "env", "write", "run"] + READS)
labels = {k: v for k, v in results.items() if isinstance(v, str) and len(v) <= 40}
unreadable = ("denied", "error:NotFound")
failures = []
if status != "200":
    failures.append("status")
if set(results) != EXPECTED or set(labels) != EXPECTED:
    failures.append("outcome_keys")
failures += [k for k in ("net", "env", "write") if labels.get(k) != "denied"]
failures += [k for k in READS if labels.get(k) not in unreadable]
# Subprocesses must explicitly fail: denied, or an error from an unsupported API.
run = labels.get("run")
if run is None or not (run == "denied" or run.startswith("error:")):
    failures.append("run")
print(json.dumps({"probe": "pass" if not failures else "fail", "outcomes": labels, "failures": failures}, sort_keys=True))
sys.exit(0 if not failures else 3)
PY
