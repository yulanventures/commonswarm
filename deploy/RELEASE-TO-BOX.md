# CommonSwarm release procedure for `yulan-vps-1`

This is the repository procedure for releasing CommonSwarm to the production
box. The cross-repository `hetzner-handoff/HETZNER-OPERATIONS.md` remains the
canonical host-operations runbook. If the two disagree, stop and ask HezLead.

Only **Anvil** (Hermes on the Mac mini) runs box commands, including Docker,
systemd, and symlink changes. **HezLead** directs the window, approves the exact
input SHA and rollback decision, and reads the evidence. **CSwarmDevLead** gets
the reviewed SHA onto `main` and supplies migration catalog checks and function
verification requests. No other seat deploys. CI never deploys.

H0 was the first live use of this procedure on 2026-09-23. Its operator findings
are incorporated below.

The box stays up. Never stop the host, run `docker prune`, use a linked Supabase
command, or use `/home/commonswarm/migration.env` or
`/home/commonswarm/migration-direct.env`. Those two files belong to the deleted
hosted-project cutover; the only exception is the one-time copy of the
`TARGET_DATABASE_URL` line in section 2.

Every box command block is a self-contained Bash subshell of the form
`( set -euo pipefail; ... )`. Paste the whole block into the interactive root
shell, pass it with `sudo -n -i bash -s`, or save it as a `bash -euo pipefail`
script. Use a script file when a terminal refuses pasted content (including
Python bitwise operators). A failed command
stops only that block, not the root shell. Values needed by another block live
in root-only files, never only in shell memory. On every stop, refusal, or abort,
run the "Abort cleanup" block at the end of section 1 before closing the
window; it restarts the edge recycle and backup/restore timers when `window.env`
says this window stopped them.

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
   the archive came from the GitHub remote. The lead may have already written
   `gate-evidence.txt` in the evidence directory. `git archive` reads tracked
   Git objects and has no `--no-xattrs` option; Mac `tar` commands below use
   both `COPYFILE_DISABLE=1` and `--no-xattrs`.

```sh
rm -f "$HOME/.commonswarm-release-window.env"
SHA=<sha>
(
  set -euo pipefail
  check() {
    label="$1"
    shift
    if "$@"; then
      printf '%s: PASS\n' "$label"
    else
      printf '%s: FAIL\n' "$label" >&2
      return 1
    fi
  }
  check 'SHA length' test "${#SHA}" -eq 40
  check 'origin URL' test "$(git remote get-url origin)" = 'https://github.com/yulanventures/commonswarm.git'
  check 'origin/main fetch' git fetch origin main
  check 'exact commit' test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
  check 'SHA on origin/main' git merge-base --is-ancestor "$SHA" origin/main

  SHORT_SHA="$(git rev-parse --short=12 "$SHA")"
  RUN_DAY="$(date -u +%F)"
  EVIDENCE_DIR="$PWD/docs/evidence/${RUN_DAY}-release-${SHORT_SHA}"
  RUN_LOG="$EVIDENCE_DIR/run.log"
  ARCHIVE="/tmp/commonswarm-${SHA}.tar"
  GATE_EVIDENCE="$EVIDENCE_DIR/gate-evidence.txt"
  mkdir -p -m 0700 "$EVIDENCE_DIR"
  chmod 0700 "$EVIDENCE_DIR"
  install -m 0600 /dev/null "$RUN_LOG"
  check 'exact-SHA archive' env COPYFILE_DISABLE=1 git archive --format=tar --output "$ARCHIVE" "$SHA"
  shasum -a 256 "$ARCHIVE" >"$EVIDENCE_DIR/archive.sha256"
  cat "$EVIDENCE_DIR/archive.sha256"

  check 'gate evidence file' test -f "$GATE_EVIDENCE"
  check 'gate evidence SHA' grep -qFx "SHA=$SHA" "$GATE_EVIDENCE"
  check 'command-core gate' grep -qFx 'npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js: PASS' "$GATE_EVIDENCE"
  check 'edge check gate' grep -qFx 'npm run check:edge: PASS' "$GATE_EVIDENCE"
  check 'archive commit id' test "$(git get-tar-commit-id <"$ARCHIVE")" = "$SHA"

  # Written only after every check passed, so a failed preflight leaves no file.
  ( umask 077; printf 'SHA=%q\nSHORT_SHA=%q\nEVIDENCE_DIR=%q\nRUN_LOG=%q\nARCHIVE=%q\n' \
      "$SHA" "$SHORT_SHA" "$EVIDENCE_DIR" "$RUN_LOG" "$ARCHIVE" >"$HOME/.commonswarm-release-window.env" )
  chmod 0600 "$HOME/.commonswarm-release-window.env"
  printf 'window file written\n'
)
```

If the block printed a FAIL, stop: no window file exists, and every later Mac
block refuses to run. Every later Mac block runs in its own `set -euo pipefail`
subshell, starts with `. "$HOME/.commonswarm-release-window.env"` and
`test "$SHA" = <sha>`, and so fails closed after a lost shell. Section 1's
Mac cleanup deletes the file when the window closes.

Record approvals, affected surfaces, the backup-age agreement, commands, exit
codes, and safe verification output in `run.log`. Never record an environment
file, credential, curl authorization file, or secret value.

For a database release, CSwarmDevLead places the reviewed catalog and functional
verification SQL in `EVIDENCE_DIR` before Anvil continues. Derive the
environment-name inventory from the same exact-SHA archive on the Mac.
The archived router's `REQUIRED_MAIN_ENV` (which includes the service-role
key) and database alias rule are the base; the lead
reviews strict checks in each changed function at that SHA and adds any further
required name. Forwarded names without a strict requirement are optional. This
inventory records only names, never values. Set `CHANGED_FUNCTIONS` from the
reviewed diff; a router change checks all five functions:

```sh
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = <sha>
  test -s "$ARCHIVE"
  ROUTER_DIR="$(mktemp -d /tmp/commonswarm-router-XXXXXX)"
  trap 'status=$?; rm -rf "$ROUTER_DIR"; exit "$status"' EXIT
  ROUTER_SOURCE="$ROUTER_DIR/router.ts"
  tar -xOf "$ARCHIVE" deploy/edge-runtime/main/router.ts >"$ROUTER_SOURCE"
  CHANGED_FUNCTIONS='<space-separated changed function names>'
  ROUTER_CHANGED=<yes-or-no>
  ADDITIONAL_REQUIRED_ENV_NAMES='' # Lead lists any new strict function requirements from this SHA.
  if [ "$ROUTER_CHANGED" = yes ]; then CHANGED_FUNCTIONS='command read capability activity h0'; fi
  case "$ROUTER_CHANGED" in yes|no) ;; *) false ;; esac
  cat >"$ROUTER_DIR/inventory.ts" <<'TS'
const { FUNCTION_ENV_NAMES, REQUIRED_MAIN_ENV, COMMAND_TEST_HOOKS } =
  await import(`file://${Deno.args[0]}`);
const selected = Deno.args[1].split(/\s+/).filter(Boolean);
for (const name of selected) {
  if (!(name in FUNCTION_ENV_NAMES)) throw new Error(`unknown function: ${name}`);
}
const alias = 'SWARM_DATABASE_URL|SUPABASE_DB_URL';
const extra = Deno.args[2].split(/\s+/).filter(Boolean);
const forwarded = new Set(selected.flatMap((name) => FUNCTION_ENV_NAMES[name]));
for (const name of extra) {
  if (!forwarded.has(name)) throw new Error(`required name is not forwarded: ${name}`);
}
const required = [...new Set([...REQUIRED_MAIN_ENV, alias, ...extra])];
const optional = [...new Set(selected.flatMap((name) => FUNCTION_ENV_NAMES[name]))]
  .filter((name) => !required.includes(name) && !alias.split('|').includes(name)
    && !COMMAND_TEST_HOOKS.has(name)).sort();
console.log(JSON.stringify({ required: required.sort(), optional }, null, 2));
TS
  deno run --no-config --allow-read="$ROUTER_DIR" "$ROUTER_DIR/inventory.ts" \
    "$ROUTER_SOURCE" "$CHANGED_FUNCTIONS" "$ADDITIONAL_REQUIRED_ENV_NAMES" \
    >"$EVIDENCE_DIR/required-edge-env.json"
  chmod 0600 "$EVIDENCE_DIR/required-edge-env.json"
  tar -xOf "$ARCHIVE" deploy/edge-runtime/main/router.ts \
    | rg -n 'REQUIRED_MAIN_ENV|mainEnvironmentProblems|FUNCTION_ENV_NAMES' \
    >"$EVIDENCE_DIR/edge-env-source-check.txt"
  chmod 0600 "$EVIDENCE_DIR/edge-env-source-check.txt"
)
```

Anvil records the changed-function list from the reviewed diff in `run.log`.
CSwarmDevLead checks the archived `supabase/functions/<name>/index.ts` files
for strict environment failures and confirms `required-edge-env.json` covers
them before transfer. The current command, read, capability, activity, and H0
checks add no requirement beyond that base. Optional forwarded names such as
`SWARM_CAPABILITY_ALLOWED_ORIGINS` and `SWARM_CAPABILITY_URLS` stay off the
required list.

### Apply — Anvil

Upload the archive once. Set `KIND_LIST` to `edge`, `stack`, or `edge stack`.
Any release with migrations uses `stack` in `KIND_LIST` because sections 2–5
read migration files and helpers from `NEW_STACK`. H0 therefore uses
`KIND_LIST='edge stack'`. Building that immutable stack directory does not
itself switch `stack/current`. The guarded switch is the only switch site and
runs only if stack runtime files changed. After the apply block below builds
both release directories, compare them on the box before deciding:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  for RUNTIME_PATH in compose.yaml postgres backup; do
    if diff -qr \
      "$PREVIOUS_STACK/deploy/supabase-stack/$RUNTIME_PATH" \
      "$NEW_STACK/deploy/supabase-stack/$RUNTIME_PATH"; then
      :
    else
      test "$?" -eq 1
      printf 'stack runtime changed: %s\n' "$RUNTIME_PATH"
    fi
  done
)
```

No output and exit status 0 for every path means no stack runtime switch. Any
content difference means HezLead reviews the output and schedules the guarded
switch. A missing path or comparison error is a stop. H0 does not switch
`stack/current` unless this comparison finds a stack runtime change.

On 2026-09-22 HezLead observed that edge release directories are owned by
`commonswarm:commonswarm` with mode `0750`, while stack release directories use
mode `0755`. The block records both previous release paths before any switch,
creates the releases, and writes the durable window state.

```sh
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = <sha>
  test -s "$ARCHIVE"
  scp "$ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release.tar
)
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
    find "$RELEASE_DIR" -type f -name '._*' -delete
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
    printf 'BACKUP_TIMERS_STOPPED=0\n'
  } >"$WINDOW_ENV"
  chmod 0600 "$WINDOW_ENV" "$PROOF_DIR"/*.SHA256SUMS "$PROOF_DIR/box-archive.sha256"
  install -m 0600 -o root -g root /dev/null "$PROOF_DIR/box-run.log"
  printf 'PREVIOUS_EDGE=%s\nPREVIOUS_STACK=%s\n' "$PREVIOUS_EDGE" "$PREVIOUS_STACK" \
    >>"$PROOF_DIR/box-run.log"
)
```

After the apply block has created `PROOF_DIR`, exit the box root shell and SSH
session. Back on the Mac mini, Anvil prepares the proof list. For a database
release, include the SQL files; for an edge release, include the name-only
inventory. HezLead reviews this exact list for secrets before transfer:

```sh
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = <sha>
  test -d "$EVIDENCE_DIR"
  PROOF_LIST="$EVIDENCE_DIR/proof-transfer.list"
  (cd "$EVIDENCE_DIR" && find . -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort) >"$PROOF_LIST"
  printf '%s\n' required-edge-env.json edge-env-source-check.txt >>"$PROOF_LIST"
  chmod 0600 "$PROOF_LIST"
  cat "$PROOF_LIST"
)
```

After HezLead confirms that list, Anvil transfers exactly those files from the
Mac mini:

```sh
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = <sha>
  PROOF_ARCHIVE="/tmp/commonswarm-release-proofs-${SHA}.tar"
  PROOF_LIST="$EVIDENCE_DIR/proof-transfer.list"
  test -s "$PROOF_LIST"
  (cd "$EVIDENCE_DIR" && COPYFILE_DISABLE=1 tar --no-xattrs -cf "$PROOF_ARCHIVE" -T "$PROOF_LIST")
  scp "$PROOF_ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release-proofs.tar
)
```

Reconnect to the box as root. Unpack the transferred proof files only after
HezLead confirms their list contains no secret:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  tar -xf /tmp/commonswarm-release-proofs.tar -C "$PROOF_DIR"
  find "$PROOF_DIR" -type f -name '._*' -delete
  chown -R root:root "$PROOF_DIR"
  find "$PROOF_DIR" -type f -exec chmod 0600 {} +
  if compgen -G "$PROOF_DIR/*.sql" >/dev/null; then
    (cd "$PROOF_DIR" && sha256sum ./*.sql) >"$PROOF_DIR/verification-sql.sha256"
    chmod 0600 "$PROOF_DIR/verification-sql.sha256"
  fi
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
    (cd "$RELEASE_DIR" && sha256sum --quiet --check "$PROOF_DIR/${KIND}.SHA256SUMS")
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
`0600` (a protected editor or a root-owned script is fine); do not generate it
from `find`.

```sh
(
  set -euo pipefail
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = <sha>
  test -d "$EVIDENCE_DIR"
  ssh ops@100.115.66.74 'sudo -n -i bash -s' <<'BOX' | COPYFILE_DISABLE=1 tar --no-xattrs -xf - -C "$EVIDENCE_DIR"
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -f "$PROOF_DIR/copy-back.list"
  test "$(stat -c '%U:%G:%a' "$PROOF_DIR/copy-back.list")" = root:root:600
  grep -qFx 'copy-back.list' "$PROOF_DIR/copy-back.list"
  while IFS= read -r path; do
    test -n "$path"
    while [[ "$path" == ./* ]]; do path="${path#./}"; done
    case "$path" in
      ''|/*|../*|*/../*|*.log|database/logs/*|window.env) false ;;
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

### Mac cleanup — Anvil, when the window closes (success or abort)

```sh
rm -f "$HOME/.commonswarm-release-window.env"
```

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
  if [ "$BACKUP_TIMERS_STOPPED" = 1 ]; then
    systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
    systemctl list-timers --all commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
    sed -i 's/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED=0/' "$PROOF_DIR/window.env"
    printf '%s\n' 'abort cleanup restarted backup/restore timers' >>"$PROOF_DIR/box-run.log"
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
transactional check, the file must end with its own `\gset` on the line after
a query selecting exactly one Boolean column aliased `catalog_ok`. The query
returns one row, whose unaligned value is `t` or `f`; the wrapper refuses every
value other than true. For example, a complete proof file is:

```sql
SELECT to_regclass('swarm.example_table') IS NOT NULL AS catalog_ok
\gset
```

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

If that fails, **STOP** and ask HezLead. Starting a backup is an explicit
option HezLead may choose; it is not the default. If approved, run and wait for
the existing backup service, then repeat the same freshness check. Do not
proceed merely because the service command returned.

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
   (`<version>-catalog.sql`), a functional check (`<version>-functional.sql`)
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

4. Before the first migration, save the current pg_cron job names. Keep the
   database's order in the evidence; the comparison after the last migration
   sorts both sides bytewise.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' \
    >"$PROOF_DIR/cron-before.txt"
)
```

5. For each version in `pending-versions.txt`, in order, set only `VERSION` to
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
same transaction commits. The proof file's own `\gset` turns zero or multiple
rows into a psql error; the wrapper's `\if` and exception branches reject
missing, false, or malformed values. Any failure rolls the transaction back.

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
mount. Complete one version before considering the next. After the last
migration, save the cron job names and compare both snapshots with `LC_ALL=C`
sorting. Set the two expected name lists from the reviewed release plan in
bytewise order (one
name per line; empty when none). H0 expects the one new job shown here.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  EXPECTED_NEW_CRON_JOBS='swarm-purge-h0-poll-batches'
  EXPECTED_REMOVED_CRON_JOBS=''
  release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' \
    >"$PROOF_DIR/cron-after.txt"
  LC_ALL=C sort "$PROOF_DIR/cron-before.txt" >"$PROOF_DIR/cron-before-sorted.txt"
  LC_ALL=C sort "$PROOF_DIR/cron-after.txt" >"$PROOF_DIR/cron-after-sorted.txt"
  comm -13 "$PROOF_DIR/cron-before-sorted.txt" "$PROOF_DIR/cron-after-sorted.txt" \
    >"$PROOF_DIR/cron-added.txt"
  comm -23 "$PROOF_DIR/cron-before-sorted.txt" "$PROOF_DIR/cron-after-sorted.txt" \
    >"$PROOF_DIR/cron-removed.txt"
  test "$(cat "$PROOF_DIR/cron-added.txt")" = "$EXPECTED_NEW_CRON_JOBS"
  test "$(cat "$PROOF_DIR/cron-removed.txt")" = "$EXPECTED_REMOVED_CRON_JOBS"
)
```

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

`commonswarm-edge-recycle.timer` is a box-only unit (not in this repository),
installed by HezLead on 2026-09-22: `OnCalendar=*-*-* 03,09,15,21:30:00 UTC`,
`Persistent=false`; its service runs `docker restart --time 30
commonswarm-edge-edge-runtime-1`. Check it with `systemctl cat
commonswarm-edge-recycle.timer` before the window. Set the approved window's
UTC start and end in the block below. Only if it overlaps the ten minutes on
either side of 03:30, 09:30, 15:30, or 21:30 UTC, stop the timer and start it
after verification.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  WINDOW_START_UTC='<approved-YYYY-MM-DDTHH:MM:SSZ>'
  WINDOW_END_UTC='<approved-YYYY-MM-DDTHH:MM:SSZ>'
  START_EPOCH="$(date -u -d "$WINDOW_START_UTC" +%s)"
  END_EPOCH="$(date -u -d "$WINDOW_END_UTC" +%s)"
  test "$START_EPOCH" -le "$END_EPOCH"
  DAY_EPOCH="$(date -u -d "@$START_EPOCH" +%Y-%m-%d)"
  DAY_EPOCH="$(date -u -d "$DAY_EPOCH 00:00:00" +%s)"
  OVERLAPS=0
  while [ "$DAY_EPOCH" -le "$END_EPOCH" ]; do
    for HOUR in 3 9 15 21; do
      RECYCLE_EPOCH=$((DAY_EPOCH + HOUR * 3600 + 1800))
      if [ "$START_EPOCH" -le "$((RECYCLE_EPOCH + 600))" ] &&
         [ "$END_EPOCH" -ge "$((RECYCLE_EPOCH - 600))" ]; then OVERLAPS=1; fi
    done
    DAY_EPOCH=$((DAY_EPOCH + 86400))
  done
  if [ "$OVERLAPS" = 1 ]; then
    systemctl is-active --quiet commonswarm-edge-recycle.timer
    sed -i 's/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED=1/' "$PROOF_DIR/window.env"
    systemctl stop commonswarm-edge-recycle.timer
    printf '%s\n' 'release window stopped commonswarm-edge-recycle.timer' >>"$PROOF_DIR/box-run.log"
  fi
)
```

Run that block for every window; it records a stopped timer only when the
approved times overlap a protected interval.

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -n "$PREVIOUS_EDGE"
  test -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml"
  test -f "$NEW_EDGE/deploy/edge-runtime/main/router.ts"

  # Prove the archive-derived manifest before adding the box-only override.
  (cd "$NEW_EDGE" && sha256sum --quiet --check "$PROOF_DIR/edge.SHA256SUMS")

  # Observed by HezLead on 2026-09-22: the override lives in the current
  # edge release, whose container mounts use its exact releases/<sha> path.
  test -f "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml"
  cp -a "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" \
    "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  chown commonswarm:commonswarm "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  (cd "$NEW_EDGE" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    >"$PROOF_DIR/edge-with-override.SHA256SUMS"
  chmod 0600 "$PROOF_DIR/edge-with-override.SHA256SUMS"
  (cd "$NEW_EDGE" && sha256sum --quiet --check "$PROOF_DIR/edge-with-override.SHA256SUMS")

  python3 - "$PROOF_DIR/required-edge-env.json" /home/commonswarm/.env <<'PY'
import json, sys

inventory = json.load(open(sys.argv[1]))
required = set(inventory['required'])
optional = set(inventory['optional'])
database_alias = 'SWARM_DATABASE_URL|SUPABASE_DB_URL'
assert database_alias in required
assert not (required & optional)
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
database_names = {'SWARM_DATABASE_URL', 'SUPABASE_DB_URL'}
assert any(values.get(name) for name in database_names), 'one non-empty database URL alias is required'
required.remove(database_alias)
missing = sorted(name for name in required if not values.get(name))
assert not missing, 'missing or empty required names: ' + ', '.join(missing)
assert values.get('SWARM_SELF_SERVE') == '1', 'SWARM_SELF_SERVE must equal 1'
print('required edge environment names are present and non-empty; values not shown')
for name in sorted(optional):
    print(f'optional edge environment {name}: {"present" if values.get(name) else "absent"}')
PY

  cd "$NEW_EDGE/deploy/edge-runtime"
  sudo -u commonswarm env \
    COMMONSWARM_EDGE_NETWORK_MODE=commonswarm-net \
    COMMONSWARM_EDGE_ENV_FILE=/home/commonswarm/.env \
    docker compose -p commonswarm-edge config -q
)
```

The changed-function list and required-name inventory come from the exact-SHA
Mac gate. Optional forwarded names are reported as present or absent and never
stop the release. Test hooks remain forbidden, and either non-empty database
URL alias satisfies the database requirement. The check never prints a value.

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

On the box, run the lead-supplied loopback probes for every changed function, plus the
existing positive controls from `deploy/edge-runtime/RUNBOOK.md`: H0 document,
malformed command, authenticated read, unauthenticated activity, capability,
unknown function, and preflight. If no smoke credential is provisioned on the box,
record the authenticated read as NOT VERIFIED in `run.log` and tell HezLead, who decides
whether that blocks the window (it did not for H0 on 2026-09-23). Also probe `/functions/v1/h0/note`
without authorization using a valid note body: it must return 401, never 500
`h0_command_not_configured`. The authenticated read and H0 document are
positive controls in the same probe run. Run this H0 note loopback probe on
the box:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  STATUS="$(curl -sS -o "$PROOF_DIR/h0-note-unauth.json" -w '%{http_code}' \
    -H 'content-type: application/json' --data-binary '{"body":"release probe"}' \
    http://127.0.0.1:9000/functions/v1/h0/note)"
  test "$STATUS" = 401
)
```

Put authorization in a root-owned mode-`0600` curl config file and remove it
after use. Repeat changed-function probes through
`edge-staging.commonswarm.com` **from the Mac mini**, and retain their status
evidence in `EVIDENCE_DIR`. Cloudflare returns 1010 for that hostname from the box; do not
run staging probes there. Staging is production-backed. Only after
both loopback and staging probes finish, capture the log window that began at
`edge-probe-start.txt` and reject `CONNECT_TIMEOUT` or
`h0 command configuration missing`:

```sh
(
  set -euo pipefail
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  docker logs --since "$(cat "$PROOF_DIR/edge-probe-start.txt")" commonswarm-edge-edge-runtime-1 \
    >"$PROOF_DIR/edge-probe-window.log" 2>&1
  if grep -qE 'CONNECT_TIMEOUT|h0 command configuration missing' "$PROOF_DIR/edge-probe-window.log"; then false; fi
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
  deadline=$(( $(date +%s) + 180 ))
  while [ "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' commonswarm-edge-edge-runtime-1)" != healthy ]; do
    if [ "$(date +%s)" -ge "$deadline" ]; then false; fi
    sleep 2
  done
  curl -fsS http://127.0.0.1:9000/health
)
```

Wait for Docker health and repeat the log and function probes above.
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
`postgres/10-runtime-roles.sh` through that symlink. A restart after a switch
reloads `pg_hba.conf` from the new release. `10-runtime-roles.sh` is mounted
into `/docker-entrypoint-initdb.d/` and runs only when the data directory is
empty, so a restart of the existing database does not run it. The
guard compares them and stops for HezLead if either differs. They were verified
identical between `90e84f0e` and `e38b499f`.

Do not run the forward switch from 03:30 through 04:30 UTC on any day, or from
04:30 through 05:30 UTC on Sunday. Rollback is permitted during those hours;
record its UTC time in `box-run.log`. Both timers are persistent, so crossing a
missed schedule can start work immediately. For the forward switch substitute
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
  printf 'stack switch direction=%s UTC=%s day=%s\n' "$STACK_SWITCH_DIRECTION" "$UTC_HM" "$UTC_DOW" \
    | tee -a "$PROOF_DIR/box-run.log"
  if [ "$STACK_SWITCH_DIRECTION" = apply ]; then
    if (( UTC_MINUTES >= 210 && UTC_MINUTES < 270 )); then false; fi
    if [ "$UTC_DOW" = 7 ] && (( UTC_MINUTES >= 270 && UTC_MINUTES < 330 )); then false; fi
  fi

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

  sed -i 's/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED=1/' "$PROOF_DIR/window.env"
  systemctl stop commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
  while :; do
    BACKUP_STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    RESTORE_STATE="$(systemctl is-active commonswarm-postgres-restore.service || true)"
    case "$BACKUP_STATE:$RESTORE_STATE" in
      inactive:inactive|inactive:failed|failed:inactive|failed:failed) break ;;
      active:*|activating:*|deactivating:*|reloading:*|*:active|*:activating|*:deactivating|*:reloading) sleep 5 ;;
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
  declare -A INACTIVE_EXIT_BEFORE
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    INACTIVE_EXIT_BEFORE["$SERVICE"]="$(systemctl show "$SERVICE" -p InactiveExitTimestampMonotonic --value)"
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
  sed -i 's/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED=0/' "$PROOF_DIR/window.env"
  for SERVICE in commonswarm-postgres-backup.service commonswarm-postgres-restore.service; do
    while :; do
      STATE="$(systemctl is-active "$SERVICE" || true)"
      case "$STATE" in
        activating|deactivating|reloading) sleep 5 ;;
        *) break ;;
      esac
    done
    INACTIVE_EXIT_AFTER="$(systemctl show "$SERVICE" -p InactiveExitTimestampMonotonic --value)"
    ACTIVATED=0
    if [ "$INACTIVE_EXIT_AFTER" != "${INACTIVE_EXIT_BEFORE[$SERVICE]}" ]; then ACTIVATED=1; fi
    printf 'after timer start: %s=%s activated=%s\n' "$SERVICE" "$STATE" "$ACTIVATED" \
      | tee -a "$PROOF_DIR/box-run.log"
    test "$STATE" = inactive
    test "$(systemctl show "$SERVICE" -p Result --value)" = success
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
6. Run the single guarded stack switch and unit sync only when the section 1
   `compose.yaml`, `postgres/`, or `backup/` comparison finds a stack runtime
   change, whether section 7, section 8, or both need it. A migration-only
   release uses `NEW_STACK` without changing `stack/current`.
7. Recreate changed stack images, one service at a time.
8. Run public and authenticated end-to-end verification; archive evidence.

Migration precedes code that needs it. Backfill precedes later migrations. A
new edge must remain compatible with the verified database state at the moment
it is recreated.

**H0 (the first use of this procedure).** `KIND_LIST` is `edge stack`. The
stack release directory is built for its migration files and helpers, and
`stack/current` is switched, through the guarded switch in section 7, only if
the section 1 runtime-file comparison shows changed stack runtime files.
Before the window, confirm the live stack release with
`readlink -f /home/commonswarm/stack/current` (it was `e38b499f` on
2026-09-22 after the unit rollout). The three `20260922*` migrations below come
from CommonSwarm lane 5a; they must be on `main` at the release SHA, with one
catalog proof each, before the window opens. If they are not, section 5 stops.
Order:

1. Ledger backfill for `20260916000001` and `20260916000002` (section 4).
2. Migrations, one at a time, each with its own lead-supplied catalog proof:
   `20260922000001` (poll lock and batch tables), `20260922000002` (the
   waiting-slot column), `20260922000003` (batch retention: the function
   `swarm.h0_poll_batch_retention_days()` and the pg_cron job
   `swarm-purge-h0-poll-batches`).
3. One edge release with `command`, `h0` and the router together (section 6).
   The h0 poll reads tables that the migrations create.

`20260922000003` changes the box's cron job set. Any cron-set comparison after
the upgrade must expect exactly one new job, `swarm-purge-h0-poll-batches`, and
no other change. The migrations are additive, so the old edge keeps working
between steps 2 and 3, and an edge rollback after step 2 is safe.

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
  `CONNECT_TIMEOUT` or `h0 command configuration missing`, or the h0/note
  probe returns anything other than 401;
- a service becomes unhealthy, a functional probe fails, or the previous
  release path is unknown;
- either backup/restore service is still active when a unit rollout would
  switch the stack release;
- the requested action is outside the exact surfaces, commands, and transitions
  in the approved release plan.

On every item above, run section 1's abort cleanup so the edge recycle and
backup/restore timers are restarted when `window.env` says the window stopped
them.

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

## Open follow-ups (Opus Checker round 3, 2026-09-22)

These do not block H0. Fold them together with the findings from the first H0 run.

- The guarded switch accepts a `failed` backup or restore service before it switches, but after the switch it requires `inactive` plus `success`. A drill that failed earlier therefore makes both apply and rollback report failure.
- The stack runtime-file comparison ignores `deploy/supabase-stack/migrate/`, although the backup and the drill run helpers from it through `stack/current`.
- The pasted Mac preflight can still end with exit 0 after a failed check (the window file is then absent, so later Mac blocks refuse), and a second run empties `run.log`. Not fixed yet.
- The test-hook environment names are typed by hand, and `SWARM_ENV=test` is accepted.
