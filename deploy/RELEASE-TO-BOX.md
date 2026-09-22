# CommonSwarm release procedure for `yulan-vps-1`

This is the repository procedure for releasing CommonSwarm to the production
box. The cross-repository `hetzner-handoff/HETZNER-OPERATIONS.md` remains the
canonical host-operations runbook. If the two disagree, stop and ask HezLead.

Only **Anvil** (Hermes on the Mac mini) runs box commands, including Docker,
systemd, and symlink changes. **HezLead** directs the window, approves the exact
input SHA and rollback decision, and reads the evidence. **CSwarmDevLead** gets
the reviewed SHA onto `main` and supplies migration catalog checks and function
verification requests. No other seat deploys. CI never deploys.

No section below has yet been run end to end exactly as written. H0 is the
first use. HezLead must fold the first run's findings back into this procedure
before its next use.

The box stays up. Never stop the host, run `docker prune`, use a linked Supabase
command, or use `/home/commonswarm/migration.env` or
`/home/commonswarm/migration-direct.env`. Those two files belong to the deleted
hosted-project cutover; the only exception is the one-time copy of the
`TARGET_DATABASE_URL` line in section 2.

Every box command block is a self-contained Bash subshell of the form
`( set -euo pipefail; ... )`. Paste the whole block into the interactive root
shell, or save its contents as a `bash -euo pipefail` script. A failed command
stops only that block, not the root shell. Values needed by another block live
in root-only files, never only in shell memory. On every stop, refusal, or abort,
run the "Abort cleanup" block at the end of section 1 before closing the
window; it restarts the edge recycle timer when `window.env` says this window
stopped it.

## 1. Common release preparation

### Preflight — CSwarmDevLead, HezLead, then Anvil

1. CSwarmDevLead names one full 40-character `<sha>`, its reviewed PR, the
   affected surfaces, and any required catalog/function verification files.
   The SHA must already be on `main`. The lead also supplies gate evidence
   recorded at that exact SHA. It must include both
   `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`
   and `npm run check:edge`, plus the other gates required by the change.
2. HezLead approves that SHA and an agreed maximum backup age in seconds when a
   database backup is required.
3. Anvil runs these commands on the Mac mini from this repository. They prove
   the archive came from the GitHub remote and create the evidence directory.

```sh
SHA=<sha>
test "${#SHA}" -eq 40
test "$(git remote get-url origin)" = 'https://github.com/yulanventures/commonswarm.git'
git fetch origin main
test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
git merge-base --is-ancestor "$SHA" origin/main

SHORT_SHA="$(git rev-parse --short=12 "$SHA")"
RUN_DAY="$(date -u +%F)"
EVIDENCE_DIR="$PWD/docs/evidence/${RUN_DAY}-release-${SHORT_SHA}"
install -d -m 0700 "$EVIDENCE_DIR"
RUN_LOG="$EVIDENCE_DIR/run.log"
install -m 0600 /dev/null "$RUN_LOG"

ARCHIVE="/tmp/commonswarm-${SHA}.tar"
git archive --format=tar --output "$ARCHIVE" "$SHA"
shasum -a 256 "$ARCHIVE" >"$EVIDENCE_DIR/archive.sha256"
cat "$EVIDENCE_DIR/archive.sha256"

GATE_EVIDENCE="$EVIDENCE_DIR/gate-evidence.txt"
test -f "$GATE_EVIDENCE"
grep -Fx "SHA=$SHA" "$GATE_EVIDENCE"
grep -Fx 'npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS' "$GATE_EVIDENCE"
grep -Fx 'npm run check:edge: PASS' "$GATE_EVIDENCE"
```

Record approvals, affected surfaces, the backup-age agreement, commands, exit
codes, and safe verification output in `run.log`. Never record an environment
file, credential, curl authorization file, or secret value.

For a database release, CSwarmDevLead places the reviewed catalog and functional
verification SQL in `EVIDENCE_DIR` before Anvil continues. After creating
`PROOF_DIR` below, Anvil transfers that directory without adding credentials:

```sh
PROOF_ARCHIVE="/tmp/commonswarm-release-proofs-${SHA}.tar"
(cd "$EVIDENCE_DIR" && tar -cf "$PROOF_ARCHIVE" ./*.sql)
scp "$PROOF_ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release-proofs.tar
```

### Apply — Anvil

Upload the archive once. Set `KIND_LIST` to `edge`, `stack`, or `edge stack`.
On 2026-09-22 HezLead observed that edge release directories are owned by
`commonswarm:commonswarm` with mode `0750`, while stack release directories use
mode `0755`. The block records both previous release paths before any switch,
creates the releases, and writes the durable window state.

```sh
scp "$ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release.tar
ssh ops@100.115.66.74
sudo -n -i

(
  set -euo pipefail
  SHA=<sha>
  KIND_LIST='<edge|stack|edge stack>'
  ARCHIVE=/tmp/commonswarm-release.tar
  EXPECTED_ARCHIVE_SHA256=<sha256-from-Mac-evidence>
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  NEW_EDGE="/home/commonswarm/edge/releases/${SHA}"
  NEW_STACK="/home/commonswarm/stack/releases/${SHA}"
  PREVIOUS_EDGE="$(readlink -f /home/commonswarm/edge/current)"
  PREVIOUS_STACK="$(readlink -f /home/commonswarm/stack/current)"
  test -n "$PREVIOUS_EDGE"
  test -n "$PREVIOUS_STACK"
  case " $KIND_LIST " in
    *' edge '*|*' stack '*) ;;
    *) false ;;
  esac
  for KIND in $KIND_LIST; do
    case "$KIND" in edge|stack) ;; *) false ;; esac
  done

  install -d -m 0700 -o root -g root "$PROOF_DIR"
  sha256sum "$ARCHIVE" >"$PROOF_DIR/box-archive.sha256"
  BOX_ARCHIVE_LINE="$(cat "$PROOF_DIR/box-archive.sha256")"
  test "${BOX_ARCHIVE_LINE%% *}" = "$EXPECTED_ARCHIVE_SHA256"

  for KIND in $KIND_LIST; do
    if [ "$KIND" = edge ]; then
      RELEASE_DIR="$NEW_EDGE"
      RELEASE_MODE=0750
    else
      RELEASE_DIR="$NEW_STACK"
      RELEASE_MODE=0755
    fi
    test ! -e "$RELEASE_DIR"
    install -d -m "$RELEASE_MODE" -o commonswarm -g commonswarm "$RELEASE_DIR"
    tar -xf "$ARCHIVE" -C "$RELEASE_DIR"
    printf '%s\n' "$SHA" >"$RELEASE_DIR/RELEASE_SHA"
    chown -R commonswarm:commonswarm "$RELEASE_DIR"
    chmod "$RELEASE_MODE" "$RELEASE_DIR"
    (cd "$RELEASE_DIR" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
      >"$PROOF_DIR/${KIND}.SHA256SUMS"
  done

  WINDOW_ENV="$PROOF_DIR/window.env"
  {
    printf 'SHA=%q\n' "$SHA"
    printf 'KIND_LIST=%q\n' "$KIND_LIST"
    printf 'NEW_EDGE=%q\n' "$NEW_EDGE"
    printf 'NEW_STACK=%q\n' "$NEW_STACK"
    printf 'PREVIOUS_EDGE=%q\n' "$PREVIOUS_EDGE"
    printf 'PREVIOUS_STACK=%q\n' "$PREVIOUS_STACK"
    printf 'RECYCLE_TIMER_STOPPED=0\n'
  } >"$WINDOW_ENV"
  chmod 0600 "$WINDOW_ENV" "$PROOF_DIR"/*.SHA256SUMS "$PROOF_DIR/box-archive.sha256"
  install -m 0600 -o root -g root /dev/null "$PROOF_DIR/box-run.log"
  printf 'PREVIOUS_EDGE=%s\nPREVIOUS_STACK=%s\n' "$PREVIOUS_EDGE" "$PREVIOUS_STACK" \
    >>"$PROOF_DIR/box-run.log"
)
```

For a database release, unpack the transferred verification files only after
HezLead confirms their list contains no secret:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  tar -xf /tmp/commonswarm-release-proofs.tar -C "$PROOF_DIR"
  chown -R root:root "$PROOF_DIR"
  find "$PROOF_DIR" -type f -exec chmod 0600 {} +
  (cd "$PROOF_DIR" && sha256sum ./*.sql) >"$PROOF_DIR/verification-sql.sha256"
  chmod 0600 "$PROOF_DIR/verification-sql.sha256"
)
```

### Verify — Anvil; HezLead reads

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  for KIND in $KIND_LIST; do
    if [ "$KIND" = edge ]; then RELEASE_DIR="$NEW_EDGE"; else RELEASE_DIR="$NEW_STACK"; fi
    test "$(cat "$RELEASE_DIR/RELEASE_SHA")" = "$SHA"
    test ! -e "$RELEASE_DIR/.git"
    test "$(stat -c '%U:%G' "$RELEASE_DIR")" = 'commonswarm:commonswarm'
    stat -c '%a %n' "$RELEASE_DIR"
    (cd "$RELEASE_DIR" && sha256sum --check "$PROOF_DIR/${KIND}.SHA256SUMS")
  done
)
```

The final `stat` must report `750` for edge or `755` for stack. HezLead compares
the box archive checksum to the Mac copy and confirms the full SHA in
`RELEASE_SHA`. A short SHA is never a release identity.

### Rollback / abort — Anvil at HezLead's direction

Before a symlink or service change, abort means leave the new immutable release
directory in place for inspection and do not use it. After an apply, each
surface-specific section below restores the previous symlink and recreates from
the previous release directory. Do not delete either release during the window.

After the window, Anvil copies the curated proof files back to
`docs/evidence/<UTC-date>-release-<short-sha>/`. CSwarmDevLead reviews and
commits that evidence afterwards; the evidence must contain no secrets and no
complete environment file. Before copying, HezLead writes the exact approved
relative paths, one per line, to `$PROOF_DIR/copy-back.list`; it must include
itself. Logs are never copied because they may contain request data. The list
must not contain `window.env`, anything under `database/logs/`, or any name
ending in `.log`. Create the list with a protected editor as root and mode
`0600`; do not generate it from `find`.

```sh
(
  set -euo pipefail
  ssh ops@100.115.66.74 'sudo -n -i bash -s' <<'BOX' | tar -xf - -C "$EVIDENCE_DIR"
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -f "$PROOF_DIR/copy-back.list"
  test "$(stat -c '%U:%G:%a' "$PROOF_DIR/copy-back.list")" = root:root:600
  grep -Fx 'copy-back.list' "$PROOF_DIR/copy-back.list"
  while IFS= read -r path; do
    test -n "$path"
    case "$path" in
      /*|../*|*/../*|*.log|database/logs/*|window.env) false ;;
    esac
    test -f "$PROOF_DIR/$path"
  done <"$PROOF_DIR/copy-back.list"
  tar -C "$PROOF_DIR" -cf - -T "$PROOF_DIR/copy-back.list"
)
BOX
)
```

The Mac's `archive.sha256` and the box's `box-archive.sha256` therefore remain
distinct.

### Abort cleanup — Anvil runs this on every stop, refusal, or abort

This is safe after a lost shell because it reads the durable state. It does not
hide the failing block's evidence.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i 's/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED=0/' "$PROOF_DIR/window.env"
    printf '%s\n' 'abort cleanup restarted commonswarm-edge-recycle.timer' >>"$PROOF_DIR/box-run.log"
  fi
)
```

## 2. One-time database release credential setup

### Preflight — HezLead

HezLead decision (2026-09-22): the only copy of the current `supabase_admin`
target URL on the box is the `TARGET_DATABASE_URL` line of the root-only file
`/home/commonswarm/migration-direct.env`. Copy that one line, once, with the
script below. It never prints the value and never reads any `SOURCE_*` line.
After this step, no release command reads either historical migration env file.

### Apply — Anvil

Using an approved protected editor or secret-file workflow that does not print
the value, create a target-only file with exactly one assignment,
`TARGET_DATABASE_URL=...`:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  install -d -m 0700 -o root -g root /etc/commonswarm-release
  install -m 0600 -o root -g root /dev/null /etc/commonswarm-release/target.env
  python3 - <<'PY'
from pathlib import Path
src = Path('/home/commonswarm/migration-direct.env')
lines = [l for l in src.read_text().splitlines() if l.startswith('TARGET_DATABASE_URL=')]
assert len(lines) == 1, 'expected exactly one TARGET_DATABASE_URL line'
Path('/etc/commonswarm-release/target.env').write_text(lines[0] + '\n')
print('target.env written (value not shown)')
PY
  chown root:root /etc/commonswarm-release/target.env
  chmod 0600 /etc/commonswarm-release/target.env
)
```

### Verify — Anvil

This checks names and shape without printing the URL.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  python3 - <<'PY'
from pathlib import Path
p = Path('/etc/commonswarm-release/target.env')
lines = [line for line in p.read_text().splitlines() if line and not line.startswith('#')]
assert len(lines) == 1
name, value = lines[0].split('=', 1)
assert name == 'TARGET_DATABASE_URL' and value and not value.startswith(('"', "'"))
PY
  test "$(stat -c '%U:%G:%a' /etc/commonswarm-release/target.env)" = 'root:root:600'
)
```

Then use the repository identity gate against the exact stack release:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  MIGRATE="$NEW_STACK/deploy/supabase-stack/migrate"
  ARTIFACT_DIR="/home/commonswarm/stack/release-proofs/${SHA}/database"
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$ARTIFACT_DIR" target
)
```

### Rollback — Anvil

There is no service state to roll back. If verification fails, stop. Repair the
approved target-only file; never fall back to a historical file.

## 3. Database session used by migrations

Run this once for the window. It uses the repository's
`make-pg-service.mjs` convention: the URL stays in a mode-`0600` file, the
password stays in a libpq pass file, and neither appears in argv. The generated
root-only session helper survives a lost shell. Every database block sources it
after `window.env`. `release_psql_ro` forces catalog and functional proof calls
into read-only transactions with `PGOPTIONS`.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  STACK_RELEASE="$NEW_STACK"
  MIGRATE="$STACK_RELEASE/deploy/supabase-stack/migrate"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  PGSERVICE_FILE="/run/commonswarm-release-${SHA}-service.conf"
  PGPASS_FILE="/run/commonswarm-release-${SHA}-pass"
  APPLY_SQL="/run/commonswarm-release-${SHA}-apply.sql"
  DB_SESSION="/run/commonswarm-release-${SHA}-session.sh"
  install -m 0600 -o root -g root /dev/null "$PGSERVICE_FILE"
  install -m 0600 -o root -g root /dev/null "$PGPASS_FILE"
  install -m 0600 -o root -g root /dev/null "$APPLY_SQL"
  unset SOURCE_DATABASE_URL TARGET_DATABASE_URL

  PG_SERVICE_OUTPUT="$PGSERVICE_FILE" \
  PG_PASS_OUTPUT="$PGPASS_FILE" \
  COMMONSWARM_ENV_FILE=/home/commonswarm/.env \
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    node "$MIGRATE/make-pg-service.mjs"

  cat >"$DB_SESSION" <<'BASH'
STACK_RELEASE="$NEW_STACK"
MIGRATE="$STACK_RELEASE/deploy/supabase-stack/migrate"
PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
PGSERVICE_FILE="/run/commonswarm-release-${SHA}-service.conf"
PGPASS_FILE="/run/commonswarm-release-${SHA}-pass"
APPLY_SQL="/run/commonswarm-release-${SHA}-apply.sql"

release_psql() {
  docker run --rm \
    --network commonswarm-net \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --env PGSERVICE=target \
    --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
    --env PGPASSFILE=/run/commonswarm-pg-pass \
    --volume "$PGSERVICE_FILE:/run/commonswarm-pg-service.conf:ro" \
    --volume "$PGPASS_FILE:/run/commonswarm-pg-pass:ro" \
    --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
    --volume "$STACK_RELEASE/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$APPLY_SQL:/run/commonswarm-release-apply.sql:ro" \
    --entrypoint psql \
    public.ecr.aws/supabase/postgres:17.6.1.147 \
    -X --set=ON_ERROR_STOP=1 "$@"
}

release_psql_ro() {
  docker run --rm \
    --network commonswarm-net \
    --add-host db.commonswarm.internal:172.31.0.10 \
    --env PGSERVICE=target \
    --env PGSERVICEFILE=/run/commonswarm-pg-service.conf \
    --env PGPASSFILE=/run/commonswarm-pg-pass \
    --env 'PGOPTIONS=-c default_transaction_read_only=on' \
    --volume "$PGSERVICE_FILE:/run/commonswarm-pg-service.conf:ro" \
    --volume "$PGPASS_FILE:/run/commonswarm-pg-pass:ro" \
    --volume /etc/ssl/yulan-internal-ca.pem:/etc/ssl/yulan-internal-ca.pem:ro \
    --volume "$STACK_RELEASE/supabase/migrations:/migrations:ro" \
    --volume "$MIGRATE:/work/migrate:ro" \
    --volume "$PROOF_DIR:/proof:ro" \
    --volume "$APPLY_SQL:/run/commonswarm-release-apply.sql:ro" \
    --entrypoint psql \
    public.ecr.aws/supabase/postgres:17.6.1.147 \
    -X --set=ON_ERROR_STOP=1 "$@"
}
BASH
  chmod 0600 "$DB_SESSION"
)
```

## 4. Ledger backfill

Use this named step only when a migration's catalog is proven present and its
ledger row is absent. Never use it to make an unknown or partial catalog look
applied. The first use is versions `20260916000001` and `20260916000002`, whose
H0 objects were applied by `apply-h0-upgrade.sh` without ledger rows.

### Preflight — CSwarmDevLead supplies the check; Anvil runs it; HezLead approves

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target

  cat >"$APPLY_SQL" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
\i /work/migrate/verify-h0-catalog.sql
ROLLBACK;
SQL
  release_psql_ro --file /run/commonswarm-release-apply.sql

  release_psql_ro -Atq --command \
    "SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('20260916000001','20260916000002') ORDER BY version;" \
    >"$PROOF_DIR/h0-ledger-before.txt"
  tee -a "$PROOF_DIR/box-run.log" <"$PROOF_DIR/h0-ledger-before.txt"
  test ! -s "$PROOF_DIR/h0-ledger-before.txt"
)
```

The repository's H0 verifier checks both H0 tables, both guard functions,
dependencies, views, privileges, indexes, constraints, triggers, and policies.
The surrounding transaction is rolled back so this preflight cannot apply or
retain anything. For this first backfill, the `before` file must contain neither
version. The migration hashes were pinned by `apply-h0-upgrade.sh`; confirm the
release checksum manifest before using its verifier.

### Apply — Anvil, after HezLead says proceed

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  cat >"$APPLY_SQL" <<'SQL'
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
\i /work/migrate/verify-h0-catalog.sql
DO $ledger_shape$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations' AND column_name = 'version'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations' AND column_name <> 'version'
      AND is_nullable = 'NO' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'schema_migrations cannot accept a version-only ledger row';
  END IF;
END
$ledger_shape$;
INSERT INTO supabase_migrations.schema_migrations (version)
VALUES ('20260916000001'), ('20260916000002');
COMMIT;
SQL

  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target
  release_psql --file /run/commonswarm-release-apply.sql
)
```

The ledger insert and catalog proof are in one transaction. A duplicate version,
catalog mismatch, lock timeout, statement timeout, or unexpected required ledger
column rolls the transaction back.

### Verify — Anvil; HezLead reads before and after

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -Atq --command \
    "SELECT version FROM supabase_migrations.schema_migrations WHERE version IN ('20260916000001','20260916000002') ORDER BY version;" \
    >"$PROOF_DIR/h0-ledger-after.txt"
  tee -a "$PROOF_DIR/box-run.log" <"$PROOF_DIR/h0-ledger-after.txt"
  test "$(cat "$PROOF_DIR/h0-ledger-after.txt")" = \
    "$(printf '%s\n' 20260916000001 20260916000002)"
  cat >"$APPLY_SQL" <<'SQL'
BEGIN;
\i /work/migrate/verify-h0-catalog.sql
ROLLBACK;
SQL
  release_psql_ro --file /run/commonswarm-release-apply.sql
)
```

The `after` file must contain exactly the two ordered versions. Keep both files
in the release evidence.

For a later backfill, CSwarmDevLead replaces the H0 verifier with that
version's reviewed catalog query and replaces the literal version list. The
same transaction must run the catalog proof before inserting the version, and
the before/after ledger output is mandatory. There is no generic “mark applied”
command.

### Rollback — HezLead decides; Anvil executes

A committed, truthful ledger backfill is not deleted during the release. If the
transaction fails, it rolls back. If later evidence shows the catalog proof was
wrong, stop writes as directed by the operations runbook and use a reviewed
forward correction. Do not remove ledger rows ad hoc.

## 5. Schema migration

List every file from `supabase/migrations/*.sql` in bytewise filename order and
compare it with the ledger. A version that already has a ledger row is applied
and is skipped; the ledger's known failure is missing rows, never extra rows.
For each version with NO ledger row, CSwarmDevLead must supply
`$PROOF_DIR/<version>-catalog.sql`. It must be a read-only, error-safe catalog
query returning exactly one unaligned value: `t` only when that migration's real
catalog/data postcondition is complete, otherwise `f`. A generic catalog query
is **not established**; do not infer object state from the filename. For the
transactional check, the file must leave one row and one Boolean column named
`catalog_ok` in psql's query buffer (no terminating semicolon); the wrapper
executes it with `\gset` and refuses every value other than true.

### Preflight — Anvil; HezLead approves the result

1. Prove a fresh complete backup. Here “complete” means the fields actually
   written by `backup/run-backup.sh`: `ok`, `database_bytes_verified`, and
   `object_bytes_verified` are true, and `verified_at` is within the age agreed
   with HezLead. That is the repository's **COMPLETE** status contract: the file
   has no literal `state: COMPLETE` field, and it is published only after the
   remote `COMPLETE.json` marker is verified.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  BACKUP_MAX_AGE_SECONDS=<agreed-seconds>
  BACKUP_STATUS=/var/backups/commonswarm-postgres/status.json
  python3 - "$BACKUP_STATUS" "$BACKUP_MAX_AGE_SECONDS" <<'PY'
import datetime, json, sys
data = json.load(open(sys.argv[1]))
assert data.get('ok') is True
assert data.get('database_bytes_verified') is True
assert data.get('object_bytes_verified') is True
verified = datetime.datetime.fromisoformat(data['verified_at'].replace('Z', '+00:00'))
age = (datetime.datetime.now(datetime.timezone.utc) - verified).total_seconds()
assert -300 <= age < int(sys.argv[2])
assert data.get('destination', '').startswith('r2:yulan-vps-1-backups/000-commonswarm-postgres/')
PY
)
```

If that fails, run and wait for the existing backup service, then repeat the
same check. Do not proceed merely because the service command returned.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  systemctl start commonswarm-postgres-backup.service
  while systemctl is-active --quiet commonswarm-postgres-backup.service; do sleep 5; done
  test "$(systemctl show commonswarm-postgres-backup.service -p Result --value)" = success
)
```

2. Enumerate the release files and record their checksums. Confirm the target
   identity before any database write.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  find "$STACK_RELEASE/supabase/migrations" -maxdepth 1 -type f -name '*.sql' -print \
    | LC_ALL=C sort | tee "$PROOF_DIR/migration-files.txt"
  (cd "$STACK_RELEASE" && sha256sum supabase/migrations/*.sql) \
    | tee "$PROOF_DIR/migration-files.sha256"
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target
)
```

3. List the versions that have no ledger row. Only these need a catalog proof
   and a decision. Any pending version older than the newest ledger row is a
   stop until CSwarmDevLead explains it (it may need the Ledger backfill).

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -Atq --command \
    "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;" \
    >"$PROOF_DIR/ledger-before.txt"
  sed -E 's#.*/##; s/_.*//' "$PROOF_DIR/migration-files.txt" | LC_ALL=C sort \
    | comm -23 - "$PROOF_DIR/ledger-before.txt" | tee "$PROOF_DIR/pending-versions.txt"
)
```

4. For each version in `pending-versions.txt`, in order, set only `VERSION` to
   the next HezLead-approved value. The block generates `MIGRATION_FILE` from
   `migration-files.txt`; never type a migration filename by hand. It persists
   the pair for the apply and verify blocks.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  VERSION=<next-approved-version-from-pending-versions.txt>
  case "$VERSION" in (*[!0-9]*|'') false ;; esac
  test "${#VERSION}" -eq 14
  grep -Fx "$VERSION" "$PROOF_DIR/pending-versions.txt"
  mapfile -t MIGRATION_MATCHES < <(
    sed -E 's#.*/##' "$PROOF_DIR/migration-files.txt" | awk -v prefix="${VERSION}_" 'index($0, prefix) == 1'
  )
  test "${#MIGRATION_MATCHES[@]}" -eq 1
  MIGRATION_FILE="${MIGRATION_MATCHES[0]}"
  test -f "$STACK_RELEASE/supabase/migrations/$MIGRATION_FILE"
  test -f "$PROOF_DIR/${VERSION}-catalog.sql"
  test -f "$PROOF_DIR/${VERSION}-functional.sql"
  {
    printf 'VERSION=%q\n' "$VERSION"
    printf 'MIGRATION_FILE=%q\n' "$MIGRATION_FILE"
  } >"$PROOF_DIR/current-migration.env"
  chmod 0600 "$PROOF_DIR/current-migration.env"

  LEDGER_COUNT="$(release_psql_ro -Atq --command \
    "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$VERSION';")"
  cat >"$APPLY_SQL" <<SQL
\i /proof/${VERSION}-catalog.sql
\gset
\if :{?catalog_ok}
SELECT :'catalog_ok' = 't' AS catalog_is_t, :'catalog_ok' = 'f' AS catalog_is_f
\gset
\if :catalog_is_t
  \echo t
\else
  \if :catalog_is_f
    \echo f
  \else
    \echo invalid
  \endif
\endif
\else
  \echo invalid
\endif
SQL
  CATALOG_BEFORE="$(release_psql_ro -Atq --file /run/commonswarm-release-apply.sql)"
  printf 'version=%s ledger=%s catalog=%s\n' "$VERSION" "$LEDGER_COUNT" "$CATALOG_BEFORE" \
    | tee -a "$PROOF_DIR/migration-state-before.txt" | tee -a "$PROOF_DIR/box-run.log"
  case "$LEDGER_COUNT:$CATALOG_BEFORE" in
    0:f) ;;
    *) false ;;
  esac
)
```

Use this decision table and stop on every other result:

| Ledger | Catalog | Action |
|---:|:---:|---|
| `0` | `f` | Apply this file. |
| `0` | `t` | **REFUSE.** Run the separately reviewed named Ledger backfill for this version first. |
| `1` | any | **STOP.** A pending version gained a ledger row during the window. |

Any count other than `0` or `1`, or output other than `t` or `f`, is a stop.

### Apply — Anvil, one file at a time

The wrapper verifies that a version-only ledger row is valid on the live ledger,
runs the migration, inserts its ledger row, and proves the catalog before the
same transaction commits. `\gset` and `\if` turn zero rows, multiple rows,
missing variables, false, or malformed output into a psql error or a raised
exception, so the transaction rolls back.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  . "$PROOF_DIR/current-migration.env"
  test -n "$VERSION"
  test -n "$MIGRATION_FILE"
  cat >"$APPLY_SQL" <<SQL
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '5min';
DO \$ledger_shape\$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations' AND column_name = 'version'
  ) OR EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'supabase_migrations'
      AND table_name = 'schema_migrations' AND column_name <> 'version'
      AND is_nullable = 'NO' AND column_default IS NULL
  ) THEN
    RAISE EXCEPTION 'schema_migrations cannot accept a version-only ledger row';
  END IF;
END
\$ledger_shape\$;
\i /migrations/$MIGRATION_FILE
INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('$VERSION');
\i /proof/${VERSION}-catalog.sql
\gset
\if :{?catalog_ok}
SELECT :'catalog_ok' = 't' AS catalog_is_t
\gset
\if :catalog_is_t
\else
DO \$catalog_mismatch\$
BEGIN
  RAISE EXCEPTION 'catalog proof failed for version $VERSION';
END
\$catalog_mismatch\$;
\endif
\else
DO \$catalog_missing\$
BEGIN
  RAISE EXCEPTION 'catalog proof returned no catalog_ok value for version $VERSION';
END
\$catalog_missing\$;
\endif
COMMIT;
SQL

  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target
  release_psql --file /run/commonswarm-release-apply.sql
)
```

Read the exit code before continuing. Never batch two migration files into one
transaction: the repository's compatibility reasoning assumes one file per
transaction.

### Verify — Anvil; HezLead reads each result

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  . "$PROOF_DIR/current-migration.env"
  LEDGER_AFTER="$(release_psql_ro -Atq --command \
    "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version = '$VERSION';")"
  cat >"$APPLY_SQL" <<SQL
\i /proof/${VERSION}-catalog.sql
\gset
\if :{?catalog_ok}
SELECT :'catalog_ok' = 't' AS catalog_is_t, :'catalog_ok' = 'f' AS catalog_is_f
\gset
\if :catalog_is_t
  \echo t
\else
  \if :catalog_is_f
    \echo f
  \else
    \echo invalid
  \endif
\endif
\else
  \echo invalid
\endif
SQL
  CATALOG_AFTER="$(release_psql_ro -Atq --file /run/commonswarm-release-apply.sql)"
  printf 'version=%s ledger=%s catalog=%s\n' "$VERSION" "$LEDGER_AFTER" "$CATALOG_AFTER" \
    | tee -a "$PROOF_DIR/migration-state-after.txt" | tee -a "$PROOF_DIR/box-run.log"
  test "$LEDGER_AFTER" = 1
  test "$CATALOG_AFTER" = t
  release_psql_ro --file "/proof/${VERSION}-functional.sql" \
    >"$PROOF_DIR/${VERSION}-functional.txt"
)
```

That last command is the exact invocation of the lead-supplied host file
`$PROOF_DIR/<version>-functional.sql`; `/proof` is its read-only container
mount. Complete one version before considering the next.

### Rollback — HezLead decides; Anvil executes

Prefer a reviewed forward fix. Run a down-migration only when it was supplied
and reviewed in the same PR as the up-migration. A full restore requires Tom's
explicit approval and is never the reflex for a failed migration. A failed
transaction needs no rollback; first prove it left neither ledger nor catalog
postcondition. Never edit the ledger to conceal partial state.

## 6. Edge-function or router release

This covers a new function such as `h0` and changes under
`deploy/edge-runtime/main/`. `edge-staging.commonswarm.com` reaches the same
production services and database; it is a route check, not an isolated test.
HezLead observed on 2026-09-22 that the live edge container mounts files from
the exact `/home/commonswarm/edge/releases/<sha>/` directory, not through the
`current` symlink, and that the box-only override is
`<current edge release>/deploy/edge-runtime/compose.override.yaml`.

### Preflight — CSwarmDevLead supplies probes; Anvil runs; HezLead approves

Do not start within ten minutes either side of 03:30, 09:30, 15:30, or 21:30
UTC. If the window overlaps, stop `commonswarm-edge-recycle.timer` for the
release and start it after verification.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  systemctl is-active --quiet commonswarm-edge-recycle.timer
  sed -i 's/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED=1/' "$PROOF_DIR/window.env"
  systemctl stop commonswarm-edge-recycle.timer
  printf '%s\n' 'release window stopped commonswarm-edge-recycle.timer' >>"$PROOF_DIR/box-run.log"
)
```

Run that command only when the window overlaps the protected interval; record
that it must be restarted before closing the window.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -n "$PREVIOUS_EDGE"
  test -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml"
  test -f "$NEW_EDGE/deploy/edge-runtime/main/router.ts"

  # Prove the archive-derived manifest before adding the box-only override.
  (cd "$NEW_EDGE" && sha256sum --check "$PROOF_DIR/edge.SHA256SUMS")

  # Observed by HezLead on 2026-09-22: the override lives in the current
  # edge release, whose container mounts use its exact releases/<sha> path.
  test -f "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml"
  cp -a "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" \
    "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  chown commonswarm:commonswarm "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  (cd "$NEW_EDGE" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    >"$PROOF_DIR/edge-with-override.SHA256SUMS"
  chmod 0600 "$PROOF_DIR/edge-with-override.SHA256SUMS"
  (cd "$NEW_EDGE" && sha256sum --check "$PROOF_DIR/edge-with-override.SHA256SUMS")

  CHANGED_FUNCTIONS='<space-separated changed function names>'
  if [ '<router changed: yes or no>' = yes ]; then
    CHANGED_FUNCTIONS='command read capability activity h0'
  fi
  REQUIRED_ENV_JSON="/run/commonswarm-release-${SHA}-required-env.json"
  docker run --rm --entrypoint deno \
    --env "CHANGED_FUNCTIONS=$CHANGED_FUNCTIONS" \
    --volume "$NEW_EDGE/deploy/edge-runtime/main:/work:ro" \
    public.ecr.aws/supabase/edge-runtime:v1.73.13 \
    eval --no-config '
      import { FUNCTION_ENV_NAMES, mainEnvironmentProblems } from "file:///work/router.ts";
      const names = new Set();
      mainEnvironmentProblems((name) => {
        names.add(name);
        return name === "SWARM_SELF_SERVE" ? "1" : "present";
      });
      for (const fn of (Deno.env.get("CHANGED_FUNCTIONS") ?? "").split(/\s+/).filter(Boolean)) {
        if (!(fn in FUNCTION_ENV_NAMES)) throw new Error(`unknown function: ${fn}`);
        for (const name of FUNCTION_ENV_NAMES[fn]) names.add(name);
      }
      console.log(JSON.stringify([...names].sort()));
    ' >"$REQUIRED_ENV_JSON"

  python3 - "$REQUIRED_ENV_JSON" /home/commonswarm/.env <<'PY'
import json, sys

required = set(json.load(open(sys.argv[1])))
values = {}
for raw in open(sys.argv[2]):
    line = raw.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    if line.startswith('export '):
        line = line[7:].lstrip()
    name, value = line.split('=', 1)
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
        value = value[1:-1]
    values[name.strip()] = value

test_hooks = {
    'SWARM_CMD_TEST_SLEEP_AFTER_STEP',
    'SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP',
}
assert not (test_hooks & values.keys()), 'test-only command hook is present'
required -= test_hooks
database_names = {'SWARM_DATABASE_URL', 'SUPABASE_DB_URL'}
if required & database_names:
    assert any(values.get(name) for name in database_names), 'one non-empty database URL alias is required'
    required -= database_names
missing = sorted(name for name in required if not values.get(name))
assert not missing, 'missing or empty required names: ' + ', '.join(missing)
assert values.get('SWARM_SELF_SERVE') == '1', 'SWARM_SELF_SERVE must equal 1'
print('required edge environment names are present and non-empty; values not shown')
PY
  rm -f "$REQUIRED_ENV_JSON"

  cd "$NEW_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge config -q
)
```

The changed-function list comes from the reviewed diff. If the router changed,
check all five functions. The source-owned `FUNCTION_ENV_NAMES` and
`mainEnvironmentProblems` inventories decide which names are required; test
hooks remain forbidden, and either non-empty database URL alias satisfies the
database requirement. The check never prints a value.

### Apply — Anvil

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  test -n "$PREVIOUS_EDGE"
  ln -sfn "$NEW_EDGE" /home/commonswarm/edge/current
  cd "$NEW_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge up -d edge-runtime
)
```

`COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net` is load-bearing. Without it the
runtime cannot reach `db.commonswarm.internal`.

### Verify — Anvil; HezLead reads

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' commonswarm-edge-edge-runtime-1)" != healthy ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then false; fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:9000/health
  test "$(docker inspect --format '{{.HostConfig.Memory}}' commonswarm-edge-edge-runtime-1)" = 2147483648
  test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' commonswarm-edge-edge-runtime-1)" = commonswarm-net
  test "$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' commonswarm-edge-edge-runtime-1)" \
    = "$NEW_EDGE/deploy/edge-runtime"
  date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-probe-start.txt"
)
```

Then run the lead-supplied loopback probes for every changed function, plus the
existing positive controls from `deploy/edge-runtime/RUNBOOK.md`: H0 document,
malformed command, authenticated read, unauthenticated activity, capability,
unknown function, and preflight. Put authorization in a root-owned mode-`0600`
curl config file and remove it after use. Repeat changed-function probes through
`edge-staging.commonswarm.com`; remember it is production-backed. Only after
both loopback and staging probes finish, capture the log window that began at
`edge-probe-start.txt` and reject `CONNECT_TIMEOUT`:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  docker logs --since "$(cat "$PROOF_DIR/edge-probe-start.txt")" commonswarm-edge-edge-runtime-1 \
    >"$PROOF_DIR/edge-probe-window.log" 2>&1
  if grep -q CONNECT_TIMEOUT "$PROOF_DIR/edge-probe-window.log"; then false; fi
)
```

The log is box-only and must not appear in `copy-back.list`.

If the recycle timer was stopped, restart and verify it before closing a
successful release:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i 's/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED=0/' "$PROOF_DIR/window.env"
  fi
)
```

### Rollback — Anvil at HezLead's direction

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  test -n "$PREVIOUS_EDGE"
  ln -sfn "$PREVIOUS_EDGE" /home/commonswarm/edge/current
  cd "$PREVIOUS_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge up -d edge-runtime
  curl -fsS http://127.0.0.1:9000/health
)
```

Wait for Docker health and repeat the no-`CONNECT_TIMEOUT` and function probes.
Restart `commonswarm-edge-recycle.timer` if it was stopped:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i 's/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED=0/' "$PROOF_DIR/window.env"
  fi
)
```

## 7. Stack or edge image pin bump

### Preflight — Anvil; HezLead approves; Tom additionally approves PostgreSQL

Identify the changed service from the reviewed compose diff. Stack service names
are `postgres`, `gotrue`, `postgrest`, `realtime`, and `storage-api`; edge uses
`edge-runtime`. A PostgreSQL image change requires a fresh verified backup from
section 5 and Tom's explicit approval before pull or recreate.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  test -n "$PREVIOUS_STACK"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" config -q
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" pull <stack-service>
)
```

For an edge image bump, first carry and validate the box override as in section
6, then pull with:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  cd "$NEW_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge pull edge-runtime
)
```

### Guarded stack switch and unit sync — the only `stack/current` switch

Sections 7 and 8 both use this one step, once per release. If both image and
unit changes are present, run it before the first stack service recreate and do
not run it again in section 8. It follows the order Anvil used for the
`e38b499f` unit rollout on 2026-09-22 around 19:46Z: stack current moved from
`90e84f0e` to `e38b499f`, installed units were saved under
`/root/commonswarm-units-bak-20260922T194623Z/`, no drift was found, timers were
rescheduled, and the containers remained healthy.

HezLead observed on 2026-09-22 that every stack container's Compose working
directory is `/home/commonswarm/stack/current/deploy/supabase-stack`.
`commonswarm-postgres` bind-mounts `postgres/pg_hba.conf` and
`postgres/10-runtime-roles.sh` through that symlink. Therefore the next plain
PostgreSQL restart after a switch loads those files from the new release. The
guard compares them and stops for HezLead if either differs. They were verified
identical between `90e84f0e` and `e38b499f`.

Do not run this switch from 03:30 through 04:30 UTC on any day, or from 04:30
through 05:30 UTC on Sunday. Both timers are persistent, so crossing a missed
schedule can start work immediately. For the forward switch substitute
`apply`; for rollback substitute `rollback`. Rollback reads
`PREVIOUS_STACK` only from `window.env`, refuses an empty value, and restores
the installed unit copies saved before the forward switch.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  UNITS_BEFORE="$PROOF_DIR/units-before"
  STACK_SWITCH_DIRECTION=<apply-or-rollback>
  test -n "$PREVIOUS_STACK"

  UTC_HM="$(date -u +%H%M)"
  UTC_DOW="$(date -u +%u)"
  UTC_MINUTES=$((10#${UTC_HM%??} * 60 + 10#${UTC_HM#??}))
  if (( UTC_MINUTES >= 210 && UTC_MINUTES < 270 )); then false; fi
  if [ "$UTC_DOW" = 7 ] && (( UTC_MINUTES >= 270 && UTC_MINUTES < 330 )); then false; fi

  for RELATIVE_PATH in postgres/pg_hba.conf postgres/10-runtime-roles.sh; do
    if ! cmp -s \
      "$PREVIOUS_STACK/deploy/supabase-stack/$RELATIVE_PATH" \
      "$NEW_STACK/deploy/supabase-stack/$RELATIVE_PATH"; then
      printf 'STOP: stack switch changes %s; ask HezLead\n' "$RELATIVE_PATH" \
        | tee -a "$PROOF_DIR/box-run.log" >&2
      false
    fi
  done

  UNIT_NAMES=(
    commonswarm-postgres-backup.service
    commonswarm-postgres-backup.timer
    commonswarm-postgres-restore.service
    commonswarm-postgres-restore.timer
  )
  case "$STACK_SWITCH_DIRECTION" in
    apply)
      test "$(readlink -f /home/commonswarm/stack/current)" = "$PREVIOUS_STACK"
      test ! -e "$UNITS_BEFORE"
      install -d -m 0700 -o root -g root "$UNITS_BEFORE"
      for UNIT in "${UNIT_NAMES[@]}"; do
        test -f "/etc/systemd/system/$UNIT"
        install -m 0644 -o root -g root "/etc/systemd/system/$UNIT" "$UNITS_BEFORE/$UNIT"
      done
      TARGET_STACK="$NEW_STACK"
      UNIT_SOURCE="$NEW_STACK/deploy/supabase-stack/backup"
      ;;
    rollback)
      test -d "$UNITS_BEFORE"
      TARGET_STACK="$PREVIOUS_STACK"
      UNIT_SOURCE="$UNITS_BEFORE"
      ;;
    *) false ;;
  esac
  test -n "$TARGET_STACK"
  for UNIT in "${UNIT_NAMES[@]}"; do test -f "$UNIT_SOURCE/$UNIT"; done

  systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
  while :; do
    BACKUP_STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    RESTORE_STATE="$(systemctl is-active commonswarm-postgres-restore.service || true)"
    case "$BACKUP_STATE:$RESTORE_STATE" in
      inactive:inactive|inactive:failed|failed:inactive|failed:failed) break ;;
      active:*|activating:*|*:active|*:activating) sleep 5 ;;
      *) false ;;
    esac
  done
  printf 'before stack switch: backup=%s restore=%s\n' "$BACKUP_STATE" "$RESTORE_STATE" \
    | tee -a "$PROOF_DIR/box-run.log"

  ln -sfn "$TARGET_STACK" /home/commonswarm/stack/current
  for UNIT in "${UNIT_NAMES[@]}"; do
    if ! cmp -s "$UNIT_SOURCE/$UNIT" "/etc/systemd/system/$UNIT"; then
      install -m 0644 -o root -g root "$UNIT_SOURCE/$UNIT" "/etc/systemd/system/$UNIT"
    fi
  done
  systemctl daemon-reload
  declare -A ACTIVE_ENTER_BEFORE
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    ACTIVE_ENTER_BEFORE["$SERVICE"]="$(systemctl show "$SERVICE" -p ActiveEnterTimestampMonotonic --value)"
  done
  systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
  systemctl list-timers --all commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer \
    | tee "$PROOF_DIR/stack-switch-timers.txt"

  NOW_EPOCH="$(date -u +%s)"
  for TIMER in commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer; do
    NEXT="$(systemctl show "$TIMER" -p NextElapseUSecRealtime --value)"
    test -n "$NEXT"
    test "$(date -u -d "$NEXT" +%s)" -gt "$NOW_EPOCH"
  done
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    STATE="$(systemctl is-active "$SERVICE" || true)"
    ACTIVE_ENTER_AFTER="$(systemctl show "$SERVICE" -p ActiveEnterTimestampMonotonic --value)"
    ACTIVATED=0
    if [ "$ACTIVE_ENTER_AFTER" != "${ACTIVE_ENTER_BEFORE[$SERVICE]}" ]; then ACTIVATED=1; fi
    printf 'after timer start: %s=%s activated=%s\n' "$SERVICE" "$STATE" "$ACTIVATED" \
      | tee -a "$PROOF_DIR/box-run.log"
    case "$STATE" in
      active|activating)
        while systemctl is-active --quiet "$SERVICE"; do sleep 5; done
        test "$(systemctl show "$SERVICE" -p Result --value)" = success
        ;;
      inactive|failed) ;;
      *) false ;;
    esac
    if [ "$ACTIVATED" = 1 ]; then
      test "$(systemctl show "$SERVICE" -p Result --value)" = success
    fi
  done
  test "$(readlink -f /home/commonswarm/stack/current)" = "$TARGET_STACK"
)
```

If a timer did start work, the block records it and lets it finish; it never
kills the service. Use section 6's apply command for an edge image bump.

### Apply — Anvil

After the guarded forward switch, recreate **one changed stack service at a
time**. Do not issue a full-stack `up` for an image-only release.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$NEW_STACK"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" \
    up -d --no-deps <stack-service>
)
```

### Verify — Anvil; HezLead reads before the next service

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" ps <stack-service>
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' <container-name>)" = healthy
  docker logs --since 60s <container-name>
)
```

Require `healthy`, no new boot/database error, and the lead-supplied service
probe. Established container names are `commonswarm-postgres`,
`commonswarm-gotrue`, `commonswarm-postgrest`, `commonswarm-realtime`, and
`commonswarm-storage-api`. Also run these established loopback checks where
applicable:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  curl -fsS http://127.0.0.1:18001/health
  curl -fsS http://127.0.0.1:18004/status
  curl -fsS --head -H 'Host: realtime-dev' http://127.0.0.1:18003/api/ping
)
```

No public version endpoint is established for PostgREST or Realtime. Container
health plus the lead's functional query is the required proof; do not invent a
version claim. Only after one service passes may Anvil recreate the next.

After recreating PostgreSQL, all dependents must be healthy before continuing:
GoTrue, PostgREST, Realtime, Storage API, and an authenticated edge database
probe supplied by the lead. Put authorization only in the root-owned
`/run/commonswarm-smoke.curl`; the request body contains no credential.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  for CONTAINER in commonswarm-gotrue commonswarm-postgrest commonswarm-realtime commonswarm-storage-api; do
    deadline=$(( $(date +%s) + 180 ))
    while [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER")" != healthy ]; do
      if [ "$(date +%s)" -ge "$deadline" ]; then false; fi
      sleep 2
    done
  done
  curl -fsS --config /run/commonswarm-smoke.curl \
    --data-binary @"/home/commonswarm/stack/release-proofs/${SHA}/edge-db-probe.json" \
    http://127.0.0.1:9000/functions/v1/read
)
```

### Rollback — Anvil at HezLead's direction

Run the shared guarded switch block with `STACK_SWITCH_DIRECTION=rollback`,
then recreate the affected service from `PREVIOUS_STACK`. The shared block is
the only reverse symlink switch and restores the saved installed units.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  test -n "$PREVIOUS_STACK"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$PREVIOUS_STACK"
  docker compose -p commonswarm-supabase-stack \
    --project-directory "$PREVIOUS_STACK/deploy/supabase-stack" \
    up -d --no-deps <stack-service>
)
```

Verify the restored service before touching another. For edge, use section 6's
previous-release recreate. A PostgreSQL rollback or restore still requires
Tom's explicit approval; do not treat the data directory as an image artifact.

## 8. Host backup/restore unit change

This follows the exact unit/helper rollout order recorded above for `e38b499f`.
The release switch and conditional unit copies are one coordinated operation
because the units execute helpers through `/home/commonswarm/stack/current`.

### Preflight — Anvil; HezLead approves

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  test -n "$PREVIOUS_STACK"
  test -f "$NEW_STACK/deploy/supabase-stack/backup/commonswarm-postgres-backup.service"
  test -f "$NEW_STACK/deploy/supabase-stack/backup/commonswarm-postgres-backup.timer"
  test -f "$NEW_STACK/deploy/supabase-stack/backup/commonswarm-postgres-restore.service"
  test -f "$NEW_STACK/deploy/supabase-stack/backup/commonswarm-postgres-restore.timer"
)
```

### Apply — Anvil

Run the shared guarded stack switch with `STACK_SWITCH_DIRECTION=apply` unless
section 7 already ran it for this release. It stops both timers, waits for both
services, saves the installed units, switches once, copies only changed units,
reloads systemd, restarts the timers, proves their next runs are in the future,
and lets any unexpectedly activated service finish. Never start the restore
service as a rollout shortcut; that runs a real drill.

### Verify — Anvil; HezLead reads

`list-timers` must show both timers. The unit/helper rollout is not fully proved
until the next backup run publishes a new complete status. After the next timer
run (or a separately approved manual backup), run the section 5 freshness check
and record:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  systemctl show commonswarm-postgres-backup.service -p Result --value
  python3 -m json.tool /var/backups/commonswarm-postgres/status.json \
    >"/home/commonswarm/stack/release-proofs/${SHA}/backup-status.json"
  chmod 0600 "/home/commonswarm/stack/release-proofs/${SHA}/backup-status.json"
)
```

The JSON contains no credential, but keep it private on the box until HezLead
reviews it. The `verified_at` must be later than the unit rollout and the three
success flags from section 5 must be true.

### Rollback — Anvil at HezLead's direction

Run the shared guarded stack switch with `STACK_SWITCH_DIRECTION=rollback`. It
reads and validates `PREVIOUS_STACK` from `window.env`, uses the same service
guard in reverse, and restores all four saved files from `units-before/`.

## 9. Multi-part release order and stop conditions

### Preflight — HezLead sets the order; Anvil reads it back

For a release containing several parts, use this order:

1. Prepare immutable stack and edge release directories and evidence.
2. Prove a fresh complete backup when schema, PostgreSQL, or recovery units are
   involved.
3. Run required **Ledger backfill** steps.
4. Apply and verify schema migrations, one file at a time.
5. Release edge code that depends on that schema.
6. Run the single guarded stack switch and unit sync when the stack release
   changes, whether section 7, section 8, or both need it.
7. Recreate changed stack images, one service at a time.
8. Run public and authenticated end-to-end verification; archive evidence.

Migration precedes code that needs it. Backfill precedes later migrations. A
new edge must remain compatible with the verified database state at the moment
it is recreated.

### Apply — Anvil; HezLead authorizes every transition

Do not proceed to the next numbered part until the current part's apply and
verify sections are green.

### Verify — Anvil; HezLead reads the accumulated evidence

A success-shaped command output is not evidence when Docker health, ledger
state, catalog state, or a functional probe still fails. Reconcile every
affected surface with the approved SHA and its postcondition before closing the
window.

### Stop conditions — every seat

Stop the window immediately on any of these:

- the SHA is not the approved full SHA on `main`, an archive checksum differs,
  or a release directory already exists with different contents;
- target identity fails, the target-only file is unavailable, or a historical
  migration file would be needed;
- backup status is stale/incomplete, or PostgreSQL lacks Tom's approval;
- ledger and catalog disagree, a required catalog/function query is missing,
  or a migration transaction, timeout, or verification fails;
- the edge override is missing, Compose validation fails, the edge is not on
  `commonswarm-net`, Docker health is not `healthy`, or logs show
  `CONNECT_TIMEOUT`;
- a service becomes unhealthy, a functional probe fails, or the previous
  release path is unknown;
- either backup/restore service is still active when a unit rollout would
  switch the stack release;
- the requested action is outside the exact surfaces, commands, and transitions
  in the approved release plan.

On every item above, run section 1's abort cleanup so
`commonswarm-edge-recycle.timer` is restarted when `window.env` says the
window stopped it.

### Rollback — HezLead decides; Anvil executes

Rollback only the component whose rollback is defined and whose previous
release was recorded. If rollback cannot be proved safe, keep the box up, stop
further changes, preserve the logs, and escalate to HezLead. Never improvise a
full restore, delete a release, prune Docker, or point anything back to hosted
Supabase, Railway, or Vercel.

After either a successful close or an abort, remove the root-only transient
database files. This does not remove release evidence:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  rm -f \
    "/run/commonswarm-release-${SHA}-service.conf" \
    "/run/commonswarm-release-${SHA}-pass" \
    "/run/commonswarm-release-${SHA}-apply.sql" \
    "/run/commonswarm-release-${SHA}-session.sh"
)
```
