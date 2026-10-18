#!/bin/bash
# Runs only inside the disposable worker, sharing its private DinD namespace.
set -euo pipefail
suite=${1:?suite required}
case "$suite" in server|p1-cli|site|box-dry-run|unit) ;; *) exit 2 ;; esac
test "$CI" = true
test "$STANDALONE_CI" = 1
test "$DOCKER_HOST" = tcp://127.0.0.1:2375
test -n "$CSCI_PROJECT"
umask 077
mkdir -p /tmp/gates
finish() {
  local result=$?
  python3 - <<'PY'
import json
from pathlib import Path
Path('/receipt/gates.json').write_text(json.dumps({p.name: int(p.read_text()) for p in Path('/tmp/gates').iterdir()}, indent=2)+'\n')
PY
  exit "$result"
}
trap finish EXIT
gate() {
  local name=$1 result=0
  shift
  "$@" || result=$?
  printf '%s\n' "$result" >"/tmp/gates/$name"
  return "$result"
}
for attempt in $(seq 1 60); do
  if docker info >/dev/null 2>&1; then break; fi
  sleep 1
done
docker info >/dev/null
# No test may adopt an old service, even in the private daemon.
test -z "$(docker ps -aq)"
python3 - <<'PY'
import socket
for port in [8083, *range(54320, 54330)]:
    with socket.socket() as s:
        s.bind(('0.0.0.0', port))
PY
python3 - <<'PY'
import json, subprocess
commands = {'node':['node','--version'], 'npm':['npm','--version'], 'deno':['deno','--version'],
            'supabase':['supabase','--version'], 'caddy':['caddy','version'],
            'postgres':['/usr/lib/postgresql/17/bin/postgres','--version'],
            'docker':['docker','version','--format','{{.Client.Version}}/{{.Server.Version}}'],
            'playwright':['/opt/playwright/node_modules/.bin/playwright','--version']}
versions = {k: subprocess.check_output(v, text=True).strip() for k,v in commands.items()}
open('/receipt/versions.json','w').write(json.dumps(versions, indent=2)+'\n')
PY
# A fresh project per suite. This is the sole checkout transformation; tests
# still see the requested commit at HEAD. Its exact diff is retained.
python3 - <<'PY'
import os, re
from pathlib import Path
p = Path('supabase/config.toml')
text, count = re.subn(r'^project_id = "[^"]+"$', 'project_id = "'+os.environ['CSCI_PROJECT']+'"', p.read_text(), count=1, flags=re.M)
assert count == 1
p.write_text(text)
PY
git diff -- supabase/config.toml >/receipt/checkout.patch
gate dependencies npm ci
if [[ "$suite" = server || "$suite" = p1-cli || "$suite" = unit ]]; then
  if [[ "$suite" = server ]]; then
    gate mcp-dependencies npm ci --prefix services/mcp-auth --ignore-scripts --no-audit --no-fund
  fi
  gate management-bundle node services/mcp-auth/build-management.mjs
fi
failed=0
case "$suite" in
  server)
    gate edge-image node --import tsx scripts/ci-edge-runtime-image.mjs ensure
    gate stack-start bash -euo pipefail -c 'SUPABASE_DB_MIGRATIONS_ENABLED=false SUPABASE_DB_SEED_ENABLED=false supabase start --ignore-health-check >/dev/null'
    gate migrations bash -euo pipefail -c "$(cat <<'SH'
PGPASSWORD=$(supabase status -o json | python3 -c 'import json,sys; from urllib.parse import urlsplit,unquote; u=urlsplit(json.load(sys.stdin)["DB_URL"]); assert (u.hostname,u.port,u.username,u.path)==("127.0.0.1",54322,"postgres","/postgres"); assert u.password; print(unquote(u.password))')
export PGPASSWORD
test "$(psql -X -v ON_ERROR_STOP=1 -At --dbname postgresql://supabase_admin@127.0.0.1:54322/postgres --command "SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname = current_user")" = 'supabase_admin|supabase_admin|t'
PGOPTIONS='-c search_path="$user",public' supabase migration up --db-url postgresql://supabase_admin@127.0.0.1:54322/postgres
psql -X -v ON_ERROR_STOP=1 --dbname postgresql://supabase_admin@127.0.0.1:54322/postgres --command 'GRANT swarm_admin, swarm_command, swarm_read, swarm_capability TO postgres WITH ADMIN OPTION, INHERIT TRUE, SET TRUE'
psql -X -v ON_ERROR_STOP=1 --dbname postgresql://postgres@127.0.0.1:54322/postgres --file supabase/seed.sql
psql -X -v ON_ERROR_STOP=1 --dbname postgresql://supabase_admin@127.0.0.1:54322/postgres --command "NOTIFY pgrst, 'reload schema'"
SH
)"
    # Ledger assertions use a separate quoted block so SQL remains byte clear.
    gate migration-ledger bash -euo pipefail -c "$(cat <<'SH'
PGPASSWORD=$(supabase status -o json | python3 -c 'import json,sys; from urllib.parse import urlsplit,unquote; u=urlsplit(json.load(sys.stdin)["DB_URL"]); assert (u.hostname,u.port,u.username,u.path)==("127.0.0.1",54322,"postgres","/postgres"); assert u.password; print(unquote(u.password))')
export PGPASSWORD
printf '%s\n' supabase/migrations/*.sql | sed -E 's|.*/([0-9]+)_([^/]+)\.sql$|\1\|\2|' | LC_ALL=C sort >/tmp/expected-migrations
test "$(psql -X -v ON_ERROR_STOP=1 -At --dbname postgresql://supabase_admin@127.0.0.1:54322/postgres --command "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'supabase_migrations.schema_migrations'::regclass")" = supabase_admin
psql -X -v ON_ERROR_STOP=1 -At --dbname postgresql://supabase_admin@127.0.0.1:54322/postgres --command 'SELECT version, name FROM supabase_migrations.schema_migrations ORDER BY version, name' >/tmp/actual-migrations
diff -u /tmp/expected-migrations /tmp/actual-migrations
test "$(psql -X -v ON_ERROR_STOP=1 -At --dbname postgresql://postgres@127.0.0.1:54322/postgres --command "SELECT current_user, session_user, NOT rolsuper, (SELECT count(*) = 4 AND count(DISTINCT roleid) = 4 AND bool_and(admin_option AND inherit_option AND set_option) FROM pg_auth_members WHERE member = 'postgres'::regrole AND roleid IN ('swarm_admin'::regrole, 'swarm_command'::regrole, 'swarm_read'::regrole, 'swarm_capability'::regrole)) FROM pg_roles WHERE rolname = current_user")" = 'postgres|postgres|t|t'
SH
)"
    gate server npm run test:p1-server || failed=1
    # Match workflow !cancelled(): these gates still run after a server failure.
    gate mcp-auth npm --prefix services/mcp-auth test || failed=1
    gate mcp-postgres npm --prefix services/mcp-auth run test:postgres || failed=1
    gate pg17-rehearsal env RUN_PG_REHEARSAL=1 PG_BIN=/usr/lib/postgresql/17/bin node --import tsx --test tests/c1-w2-rehearsal.test.ts || failed=1
    gate docker-stdin env PG_BIN=/usr/lib/postgresql/17/bin C1_DOCKER_PSQL_IMAGE=postgres:17 bash scripts/c1-docker-stdin-check.sh || failed=1
    ;;
  p1-cli) gate p1-cli npm run test:p1-cli || failed=1 ;;
  unit)
    gate standalone-controls node --test tests/standalone-ci-guard.test.mjs || failed=1
    gate unit npm test || failed=1
    ;;
  site)
    gate site-dependencies npm ci --prefix site
    gate site-build npm --prefix site run build
    unset CHROME_BIN
    gate site env RUN_BROWSER_TESTS=1 npm --prefix site run test:ci || failed=1
    ;;
  box-dry-run)
    export BOX_DRY_RUN=1 BOX_DRY_RUN_PART=box
    gate box-guard bash tests/box-dry-run/guard.sh
    for user in commonswarm caddy ops; do
      id -u "$user" >/dev/null 2>&1 || useradd --no-create-home --shell /usr/sbin/nologin "$user"
    done
    if [[ -f tests/p1-cli/site-artifact.test.ts ]]; then
      gate site-artifact node --import tsx --test tests/p1-cli/site-artifact.test.ts || failed=1
    elif [[ "${CSCI_REQUESTED:?requested source required}" = main ]]; then
      gate site-artifact-source test -f tests/p1-cli/site-artifact.test.ts || failed=1
    else
      printf '77\n' >/tmp/gates/site-artifact-not-applicable-at-source
      echo 'site-artifact: not applicable at requested exact source (file absent)'
    fi
    gate box-dry-run npm run test:box-dry-run || failed=1
    ;;
esac
exit "$failed"
