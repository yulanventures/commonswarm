#!/usr/bin/env bash
# Write freeze for the N-db window, in layers: the Caddy maintenance block stops public writes at the front door;
# this script adds (1) a statement trigger on every selected-schema table the connecting role may trigger, which
# refuses writes with SQLSTATE 25006 even after SET default_transaction_read_only = off or BEGIN READ WRITE, and
# (2) the database default read-only. It is written for the hosted permission shape: a non-superuser database owner
# that cannot set custom database parameters, cannot add triggers to a few service-owned tables, and cannot SET ROLE
# to every service role (all measured on production 2026-09-17). Enable and disable each run as ONE transaction, so
# a failure leaves the database exactly as it was.
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql
require_vars MIGRATION_ARTIFACT_DIR CUTOVER_CONFIRM
if [[ "$CUTOVER_CONFIRM" != "COMMONSWARM_N_DB_WINDOW" ]]; then
  echo "CUTOVER_CONFIRM must be COMMONSWARM_N_DB_WINDOW" >&2
  exit 1
fi
mode="${1:-}"
database="${2:-source}"
if [[ ( "$mode" != enable && "$mode" != disable ) || ( "$database" != source && "$database" != target ) ]]; then
  echo "usage: source-read-only.sh enable|disable [source|target]" >&2
  exit 64
fi
[[ "$database" == source ]] && require_vars SOURCE_DATABASE_URL || require_vars TARGET_DATABASE_URL
start_log "read-only-$database-$mode"
assert_database_identity "$database" >>"$LOG_FILE" 2>&1

sql_file="$(make_temp_sql)"
trap 'rm -f "$sql_file"' EXIT
schemas="$(selected_schema_csv)"

if [[ "$mode" == enable ]]; then
  # Preflight, read-only: the tables this role cannot put a trigger on. They stay guarded only by the front door and the
  # database default, so the operator must acknowledge that exact list before anything changes.
  unguarded="$(database_psql "$database" --quiet --tuples-only --no-align --command "
    SELECT coalesce(string_agg(format('%s.%s', n.nspname, c.relname), ',' ORDER BY n.nspname, c.relname), '')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY (string_to_array('$schemas', ','))
      AND c.relkind IN ('p', 'r')
      AND NOT (has_table_privilege(current_user, c.oid, 'TRIGGER') OR pg_has_role(current_user, c.relowner, 'USAGE'))
  " 2>>"$LOG_FILE")"
  log "tables this role cannot guard with a trigger: ${unguarded:-none}"
  if [[ "${FREEZE_UNGUARDED_TABLES:-}" != "$unguarded" ]]; then
    log "refusing: set FREEZE_UNGUARDED_TABLES to exactly '${unguarded}' to acknowledge that these tables rely on the front door and the database default"
    exit 65
  fi

  cat >"$sql_file" <<'SQL'
-- Running enable again while frozen must work (an operator retry after a later step failed): the database default is
-- already read-only, so this transaction declares itself read-write. Every statement below is idempotent.
SET TRANSACTION READ WRITE;
CREATE SCHEMA IF NOT EXISTS commonswarm_cutover_probe;
CREATE TABLE IF NOT EXISTS commonswarm_cutover_probe.entries (
  probe_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempted_at timestamptz NOT NULL DEFAULT statement_timestamp()
);
CREATE TABLE IF NOT EXISTS public.commonswarm_cutover_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  frozen boolean NOT NULL
);
INSERT INTO public.commonswarm_cutover_state (singleton, frozen)
VALUES (true, true)
ON CONFLICT (singleton) DO UPDATE SET frozen = EXCLUDED.frozen;
REVOKE ALL ON public.commonswarm_cutover_state FROM PUBLIC;

DO $do$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY[
    'postgres', 'supabase_admin', 'supabase_auth_admin',
    'supabase_storage_admin', 'authenticator', 'anon', 'authenticated',
    'service_role', 'commonswarm_edge', 'swarm_command', 'swarm_read',
    'swarm_capability'
  ]
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA commonswarm_cutover_probe TO %I', role_name);
      EXECUTE format('GRANT INSERT ON commonswarm_cutover_probe.entries TO %I', role_name);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE commonswarm_cutover_probe.entries_probe_id_seq TO %I', role_name);
    END IF;
  END LOOP;
END
$do$;

-- The frozen state lives in a table, not a custom database parameter: a non-superuser owner may not set those.
CREATE OR REPLACE FUNCTION public.commonswarm_cutover_write_guard()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $guard$
BEGIN
  IF (SELECT frozen FROM public.commonswarm_cutover_state WHERE singleton) THEN
    RAISE EXCEPTION 'CommonSwarm cutover write freeze is active'
      USING ERRCODE = '25006';
  END IF;
  RETURN NULL;
END
$guard$;

DO $do$
DECLARE
  row record;
BEGIN
  FOR row IN
    SELECT n.nspname, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE (n.nspname = ANY (string_to_array('__SELECTED_SCHEMAS__', ','))
           OR (n.nspname = 'commonswarm_cutover_probe' AND c.relname = 'entries'))
      AND c.relkind IN ('p', 'r')
      AND NOT (n.nspname = 'public' AND c.relname = 'commonswarm_cutover_state')
      AND (has_table_privilege(current_user, c.oid, 'TRIGGER') OR pg_has_role(current_user, c.relowner, 'USAGE'))
    -- Partitions too: a statement trigger on a partitioned table does not fire for a write made directly to a partition.
    ORDER BY n.nspname, c.relname
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = format('%I.%I', row.nspname, row.relname)::regclass
        AND t.tgname = 'commonswarm_cutover_write_freeze'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER commonswarm_cutover_write_freeze BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION public.commonswarm_cutover_write_guard()',
        row.nspname, row.relname
      );
    END IF;
  END LOOP;
END
$do$;

SELECT format('ALTER DATABASE %I SET default_transaction_read_only = on', current_database())
\gexec
SQL
else
  cat >"$sql_file" <<'SQL'
-- The database default is read-only while frozen; this transaction must be read-write to undo it.
SET TRANSACTION READ WRITE;
-- DROP TRIGGER needs table OWNERSHIP, and hosted `postgres` only holds TRIGGER on service-owned tables such as
-- auth.users: it can add the freeze trigger there but cannot drop it. Dropping the guard function it owns with CASCADE
-- removes every dependent trigger (PostgreSQL checks rights on the dropped object, not on its dependents).
DROP FUNCTION IF EXISTS public.commonswarm_cutover_write_guard() CASCADE;
DROP TABLE IF EXISTS public.commonswarm_cutover_state;
DROP SCHEMA IF EXISTS commonswarm_cutover_probe CASCADE;
SELECT format('ALTER DATABASE %I RESET default_transaction_read_only', current_database())
\gexec
SQL
fi

# The schema list is a constant from lib.sh; it is written into the SQL rather than sent as a connection option,
# which a transaction pooler may refuse.
sed -i.bak "s/__SELECTED_SCHEMAS__/$schemas/g" "$sql_file" && rm -f "$sql_file.bak"
# ONE transaction: a failure anywhere leaves the database unchanged.
database_psql "$database" --single-transaction --file "$sql_file" >>"$LOG_FILE" 2>&1

# Sessions opened before the change keep their old defaults; end them so every new session starts frozen or writable.
# A role may be refused permission to end another role's session; count those instead of aborting.
terminate_sql="$(make_temp_sql)"
cat >"$terminate_sql" <<'SQL'
DO $do$
DECLARE
  session record;
  ended integer := 0;
  refused integer := 0;
BEGIN
  FOR session IN
    SELECT pid FROM pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'
  LOOP
    BEGIN
      IF pg_terminate_backend(session.pid) THEN ended := ended + 1; END IF;
    EXCEPTION WHEN insufficient_privilege THEN
      refused := refused + 1;
    END;
  END LOOP;
  RAISE NOTICE 'older sessions ended: %, refused: %', ended, refused;
END
$do$;
SQL
database_psql "$database" --file "$terminate_sql" >>"$LOG_FILE" 2>&1 ||
  log "ending older sessions failed; a session that survives keeps its old default until it reconnects, and the triggers still apply"
rm -f "$terminate_sql"

state="$(database_psql "$database" --tuples-only --no-align --command 'SHOW transaction_read_only' 2>>"$LOG_FILE")"
expected=off
[[ "$mode" == enable ]] && expected=on
if [[ "$state" != "$expected" ]]; then
  log "$database transaction_read_only is $state; expected $expected"
  exit 1
fi
log "$database transaction_read_only is $state for new sessions"
if [[ "$mode" == enable ]]; then
  log "NEXT: run-db-tool.sh probe-database-freeze.sh \"\$ARTIFACT_DIR\" frozen $database"
  log "UNDO: CUTOVER_CONFIRM=COMMONSWARM_N_DB_WINDOW run-db-tool.sh source-read-only.sh \"\$ARTIFACT_DIR\" disable $database"
fi
log "complete read-only-$database-$mode"
