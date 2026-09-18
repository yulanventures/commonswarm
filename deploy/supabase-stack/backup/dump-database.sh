#!/usr/bin/env bash
set -euo pipefail
exec </dev/null
umask 077

# Produces the database part of a recovery set. This is NOT an offsite backup.
# Host clients preserve the HBA-required bridge source address 172.31.0.1.
if [[ $# -ne 1 || "$1" != /* || -e "$1" ]]; then
  echo "usage: dump-database.sh <new absolute artifact directory>" >&2
  exit 64
fi
stack_dir="$(cd "$(dirname "$0")/.." && pwd)"
for tool in node psql pg_dump pg_dumpall sha256sum; do
  command -v "$tool" >/dev/null || { echo "missing required tool: $tool" >&2; exit 1; }
done
[[ "$(pg_dump --version)" == *" 17."* ]] || { echo "PostgreSQL 17 clients required" >&2; exit 1; }
[[ -r /etc/ssl/yulan-internal-ca.pem ]] || { echo "target CA is missing" >&2; exit 1; }
export MIGRATION_ARTIFACT_DIR="$1"
mkdir -m 0700 "$MIGRATION_ARTIFACT_DIR"
protected_dir="$(mktemp -d "${TMPDIR:-/tmp}/commonswarm-backup-credentials.XXXXXX")"
trap 'rm -rf -- "$protected_dir"' EXIT
export PGSERVICEFILE="$protected_dir/service.conf" PGPASSFILE="$protected_dir/pass"
PG_SERVICE_OUTPUT="$PGSERVICEFILE" PG_PASS_OUTPUT="$PGPASSFILE" \
  node "$stack_dir/backup/make-backup-service.mjs"
# Reject libpq environment overrides; all connection fields come from this service.
unset PGHOST PGHOSTADDR PGPORT PGDATABASE PGUSER PGPASSWORD PGSSLMODE PGSSLROOTCERT PGOPTIONS
bash "$stack_dir/migrate/dump-source.sh" backup
PGSERVICE=backup pg_dumpall --globals-only --no-role-passwords \
  >"$MIGRATION_ARTIFACT_DIR/globals.sql" 2>>"$MIGRATION_ARTIFACT_DIR/logs/dump-backup.log"
for name in database.dump roles.sql manifest.txt source-counts.tsv storage-objects.ndjson cron-jobs.ndjson globals.sql storage-backend-objects.ndjson; do
  [[ -f "$MIGRATION_ARTIFACT_DIR/$name" ]] || { echo "incomplete database artifact" >&2; exit 1; }
done
(cd "$MIGRATION_ARTIFACT_DIR" && sha256sum database.dump roles.sql manifest.txt source-counts.tsv storage-objects.ndjson cron-jobs.ndjson globals.sql storage-backend-objects.ndjson > SHA256SUMS)
echo "Database artifact complete; offsite and object-byte backup still required."
