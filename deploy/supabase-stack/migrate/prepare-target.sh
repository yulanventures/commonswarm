#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
source "$(cd "$(dirname "$0")" && pwd)/lib.sh"

require_commands psql
require_vars TARGET_DATABASE_URL MIGRATION_ARTIFACT_DIR POSTGRES_PASSWORD \
  BACKUP_RO_PASSWORD COMMONSWARM_EDGE_DB_PASSWORD JWT_SECRET JWT_EXP
start_log prepare-target

sql_file="$(make_temp_sql)"
trap 'rm -f "$sql_file"' EXIT
cat >"$sql_file" <<'SQL'
\getenv postgres_password POSTGRES_PASSWORD
\getenv backup_password BACKUP_RO_PASSWORD
\getenv edge_password COMMONSWARM_EDGE_DB_PASSWORD
\getenv jwt_secret JWT_SECRET
\getenv jwt_exp JWT_EXP

ALTER ROLE postgres PASSWORD :'postgres_password';
ALTER ROLE authenticator PASSWORD :'postgres_password';
ALTER ROLE supabase_auth_admin PASSWORD :'postgres_password';
ALTER ROLE supabase_storage_admin PASSWORD :'postgres_password';
ALTER ROLE supabase_replication_admin PASSWORD :'postgres_password';
ALTER ROLE supabase_read_only_user PASSWORD :'postgres_password';
ALTER ROLE supabase_admin PASSWORD :'postgres_password';
ALTER DATABASE postgres SET "app.settings.jwt_secret" TO :'jwt_secret';
ALTER DATABASE postgres SET "app.settings.jwt_exp" TO :'jwt_exp';
CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;
ALTER SCHEMA _realtime OWNER TO supabase_admin;

DO $do$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'backup_ro') THEN
    CREATE ROLE backup_ro LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'commonswarm_edge') THEN
    CREATE ROLE commonswarm_edge LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      INHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$do$;

ALTER ROLE backup_ro PASSWORD :'backup_password';
ALTER ROLE commonswarm_edge PASSWORD :'edge_password';
GRANT pg_read_all_data TO backup_ro;
GRANT swarm_command, swarm_read, swarm_capability TO commonswarm_edge;

DO $do$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_authid
    WHERE rolname IN (
      'postgres', 'authenticator', 'supabase_auth_admin',
      'supabase_storage_admin', 'supabase_replication_admin',
      'supabase_read_only_user', 'supabase_admin', 'backup_ro',
      'commonswarm_edge'
    )
      AND (rolpassword IS NULL OR rolpassword !~ '^SCRAM-SHA-256[$]')
  ) THEN
    RAISE EXCEPTION 'one or more runtime roles do not have SCRAM verifiers';
  END IF;
END
$do$;
SQL

target_psql --file "$sql_file" >>"$LOG_FILE" 2>&1
log "runtime role passwords replaced with SCRAM verifiers"
log "backup_ro has pg_read_all_data; pg_hba limits it to 172.31.0.1"
log "commonswarm_edge has only swarm_command, swarm_read, and swarm_capability"
log "complete prepare-target"
