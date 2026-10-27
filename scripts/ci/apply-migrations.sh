#!/usr/bin/env bash
# Run from the repository root against the disposable CI database only.
set -euo pipefail
export LC_ALL=C
database=${1:-postgresql://supabase_admin@127.0.0.1:54322/postgres}
psql_command=(psql -X -v ON_ERROR_STOP=1 --dbname "$database")
test "$("${psql_command[@]}" -At --command 'SELECT current_user, session_user, rolsuper FROM pg_roles WHERE rolname = current_user')" = 'supabase_admin|supabase_admin|t'
ledger_file=$(mktemp)
trap 'rm -f -- "${ledger_file:?}"' EXIT
# Match CLI 2.118.0's ledger, including upgrading an existing version-only table.
# Creating it as supabase_admin also preserves the workflow's ownership gate.
"${psql_command[@]}" --single-transaction --command '
  CREATE SCHEMA IF NOT EXISTS supabase_migrations;
  CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
  ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS statements text[];
  ALTER TABLE supabase_migrations.schema_migrations ADD COLUMN IF NOT EXISTS name text;
'
for migration in supabase/migrations/*.sql; do
  filename=${migration##*/}
  version=${filename%%_*}
  [[ "$version" =~ ^[0-9]{14}$ ]] || { echo "Invalid migration version: $filename" >&2; exit 1; }
  if [[ "$("${psql_command[@]}" -At --command "SELECT EXISTS (SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = '$version')")" = t ]]; then
    continue
  fi
  echo "Applying migration $filename"
  # The original SQL and ledger insert commit together, as on the box. In
  # particular, top-level LOCK TABLE and SET LOCAL require this transaction.
  # Finish metadata generation before psql starts, so a generator failure cannot
  # commit application DDL without its ledger row.
  node scripts/ci/migration-ledger.mjs "$migration" > "$ledger_file"
  "${psql_command[@]}" --single-transaction --file "$migration" --file "$ledger_file"
done
