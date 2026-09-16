#!/usr/bin/env bash
set -euo pipefail
exec </dev/null

for name in POSTGRES_PASSWORD JWT_SECRET JWT_EXP BACKUP_RO_PASSWORD; do
  if [[ -z "${!name:-}" ]]; then
    echo "required environment variable is empty: ${name}" >&2
    exit 1
  fi
done

sql_file="$(mktemp)"
trap 'rm -f "$sql_file"' EXIT
chmod 0600 "$sql_file"
cat >"$sql_file" <<'SQL'
\getenv postgres_password POSTGRES_PASSWORD
\getenv jwt_secret JWT_SECRET
\getenv jwt_exp JWT_EXP
\getenv backup_password BACKUP_RO_PASSWORD

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
END
$do$;
ALTER ROLE backup_ro PASSWORD :'backup_password';
GRANT pg_read_all_data TO backup_ro;
SQL

PGPASSWORD="$POSTGRES_PASSWORD" psql \
  --set=ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" \
  --dbname "$POSTGRES_DB" \
  --file "$sql_file" \
  >/dev/null
echo "CommonSwarm runtime roles and database JWT settings are ready."
