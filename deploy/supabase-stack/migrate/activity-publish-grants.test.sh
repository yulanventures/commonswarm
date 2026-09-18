#!/usr/bin/env bash
# Isolated activity-publish grant/RLS proof. Refuses source/target connection env.
set -euo pipefail

MIGRATE_DIR="$(cd "$(dirname "$0")" && pwd)"
GRANTS_SQL="$MIGRATE_DIR/activity-publish-grants.sql"
SETUP_SQL="$MIGRATE_DIR/activity-publish-grants.isolated-setup.sql"
ASSERT_SQL="$MIGRATE_DIR/activity-publish-grants.isolated-assert.sql"

require_commands() {
  local command
  for command in "$@"; do
    if ! command -v "$command" >/dev/null 2>&1; then
      echo "required command is missing: $command" >&2
      echo "isolated activity-publish tests need local initdb/pg_ctl/psql, not source/target" >&2
      exit 1
    fi
  done
}

if [[ -n "${TARGET_DATABASE_URL:-}" || -n "${SOURCE_DATABASE_URL:-}" ]]; then
  echo "refusing: TARGET_DATABASE_URL/SOURCE_DATABASE_URL is set" >&2
  exit 64
fi
if [[ -n "${PGSERVICEFILE:-}" || -n "${PGSERVICE:-}" ]]; then
  echo "refusing: PGSERVICE/PGSERVICEFILE is set" >&2
  exit 64
fi
if [[ "${PGHOST:-}" == "172.31.0.10" ]]; then
  echo "refusing: PGHOST is the N-db target" >&2
  exit 64
fi

unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSERVICE PGSERVICEFILE PGPASSFILE || true

for path in \
  "$MIGRATE_DIR/prepare-target.sh" \
  "$MIGRATE_DIR/lib.sh" \
  "$MIGRATE_DIR/activity-publish-grants.test.sh" \
  "$GRANTS_SQL" \
  "$SETUP_SQL" \
  "$ASSERT_SQL"
do
  if [[ ! -f "$path" ]]; then
    echo "missing $path" >&2
    exit 1
  fi
done

bash -n "$MIGRATE_DIR/prepare-target.sh"
bash -n "$MIGRATE_DIR/lib.sh"
bash -n "$MIGRATE_DIR/activity-publish-grants.test.sh"

if ! grep -q 'activity-publish-grants.sql' "$MIGRATE_DIR/prepare-target.sh"; then
  echo "prepare-target.sh must run activity-publish-grants.sql" >&2
  exit 1
fi

if grep -Ei \
  -e 'security[[:space:]]+definer' \
  -e 'bypassrls' \
  -e 'grant[[:space:]]+(select|update|delete|truncate|all)\>' \
  -e 'grant[[:space:]]+insert[[:space:]]+on[[:space:]]' \
  -e 'to[[:space:]]+(public|anon|authenticated|service_role)\>' \
  -e 'alter[[:space:]]+role' \
  -e 'set[[:space:]]+role' \
  "$GRANTS_SQL"
then
  echo "activity-publish-grants.sql contains a banned statement" >&2
  exit 1
fi

require_commands initdb pg_ctl psql postgres

WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/activity-publish-isolated.XXXXXX")"
chmod 700 "$WORKDIR"
PGDATA="$WORKDIR/pgdata"
export PGDATA

cleanup() {
  if [[ -d "$PGDATA" ]]; then
    pg_ctl -D "$PGDATA" -m immediate stop >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

initdb -D "$PGDATA" --username=isolated --auth=trust --no-sync >/dev/null

cat >>"$PGDATA/postgresql.conf" <<CONF
listen_addresses = ''
unix_socket_directories = '$WORKDIR'
unix_socket_permissions = 0700
port = 5432
fsync = off
synchronous_commit = off
full_page_writes = off
CONF

pg_ctl -D "$PGDATA" -l "$WORKDIR/pg.log" -w start >/dev/null

isolated_psql() {
  psql -X --set=ON_ERROR_STOP=1 --pset pager=off \
    -h "$WORKDIR" -p 5432 -U isolated -d postgres \
    -c '\set VERBOSITY verbose' \
    -c "SET commonswarm.activity_publish_isolated = '1'" \
    "$@"
}

missing_out="$WORKDIR/missing-role.log"
set +e
psql -X --set=ON_ERROR_STOP=1 --pset pager=off \
  -h "$WORKDIR" -p 5432 -U isolated -d postgres \
  -c '\set VERBOSITY verbose' \
  -f "$GRANTS_SQL" >"$missing_out" 2>&1
missing_st=$?
set -e
if [[ "$missing_st" -eq 0 ]]; then
  echo "expected SQLSTATE 42704 when commonswarm_edge is missing" >&2
  cat "$missing_out" >&2
  exit 1
fi
if ! grep -Eq '42704' "$missing_out"; then
  echo "missing commonswarm_edge did not report SQLSTATE 42704" >&2
  cat "$missing_out" >&2
  exit 1
fi
if ! grep -F 'commonswarm_edge role does not exist' "$missing_out"; then
  echo "missing commonswarm_edge error text mismatch" >&2
  cat "$missing_out" >&2
  exit 1
fi

isolated_psql -f "$SETUP_SQL"

isolated_psql <<'SQL'
DO $pre$
BEGIN
  PERFORM set_config('role', 'commonswarm_edge', true);
  INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
  VALUES (
    gen_random_uuid(),
    '{}'::jsonb,
    'activity',
    'cswarm-activity:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    true,
    'broadcast'
  );
  RAISE EXCEPTION 'pre-grant INSERT succeeded';
EXCEPTION
  WHEN insufficient_privilege THEN
    IF SQLSTATE IS DISTINCT FROM '42501' THEN
      RAISE EXCEPTION 'pre-grant expected SQLSTATE 42501, got %', SQLSTATE;
    END IF;
  WHEN OTHERS THEN
    RAISE EXCEPTION 'pre-grant expected SQLSTATE 42501, got % (%)', SQLSTATE, SQLERRM;
END
$pre$;
SQL

isolated_psql -f "$GRANTS_SQL"
isolated_psql -f "$GRANTS_SQL"
isolated_psql -f "$ASSERT_SQL"

echo "activity-publish-grants isolated proof ok"
