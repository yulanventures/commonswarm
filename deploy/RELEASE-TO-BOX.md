# CommonSwarm release procedure for `yulan-vps-1`
Mac blocks must not call setuid/setgid tools.

Every box image build must run at `nice -n 15` with a hard three-CPU cap:
`systemd-run --scope -p CPUQuota=300%` with the build workers in that scope,
or a builder-supported equivalent. A scope around only the Docker client does
not cap daemon-owned build workers. For the existing `docker build`, use
`DOCKER_BUILDKIT=0 nice -n 15 docker build --cpu-period=100000 --cpu-quota=300000`;
the legacy builder runs Dockerfile steps sequentially under that quota. Its
multi-stage OAuth Dockerfile needs no BuildKit-only features. If the installed
builder cannot enforce the cap, STOP; never retry uncapped. See
[Docker's builder options](https://docs.docker.com/reference/cli/docker/image/build/).
Build each image once per reviewed `RELEASE_SHA` (the OAuth plan calls it
`OAUTH_RELEASE_SHA`): look up a persistent local SHA tag first, build only when
absent, record `org.opencontainers.image.revision` on creation, and verify that
label equals the reviewed SHA before reuse or deployment. A mismatched label
is STOP. Retain the tag across retries/windows and deploy the immutable image
ID. Plans using pinned images or static-site builds add no box image build.

This is the repository procedure for releasing CommonSwarm to the production
box. The cross-repository `hetzner-handoff/HETZNER-OPERATIONS.md` remains the
canonical host-operations runbook. If the two disagree, stop and ask HezLead.

Only **Anvil** (Hermes on the Mac mini) runs box commands, including Docker,
systemd, and symlink changes. **HezLead** directs the window, approves the exact
input SHA and rollback decision, and reads the evidence. **CSwarmDevLead** gets
the reviewed SHA onto `main` and supplies migration catalog checks and function
verification requests. No other seat deploys. CI never deploys.

Before an OAuth authorization-service or MCP edge release, the server suite
must be green at the exact reviewed release SHA. This includes the HTTP
OAuth/MCP contract in
`services/mcp-auth/test-postgres/oauth-mcp-contract.test.js`, named in the
literal `test:postgres` list and run by the server workflow's MCP auth step.
It drives both CIMD and RFC 7591 clients through discovery, sign-in, consent,
PKCE token exchange, and the actual Deno MCP handler's initialize/tools/list.
A result from another SHA, a skipped test, or only the service-free auth tests
does not satisfy this release gate. HezLead authorizes any needed Actions run.

H0 was the first live use of this procedure on 2026-09-23. Its operator findings
are incorporated below.

The box stays up. Never stop the host, run `docker prune`, use a linked Supabase
command, or use `/home/commonswarm/migration.env`; the historical
`/home/commonswarm/migration-direct.env` must never be read. Those two files
belong to the deleted hosted-project cutover. Section 2 verifies the current
target-only source instead.

Every box command block is a self-contained Bash subshell of the form
`( set -euo pipefail; ... )`. Paste the whole block into the interactive root
shell, pass it with `sudo -n -i bash -s`, or save it as a `bash -euo pipefail`
script. Use a script file when a terminal refuses pasted content (including
Python bitwise operators). A failed command
stops only that block, not the root shell. Values needed by another block live
in root-only files, never only in shell memory. On every stop, refusal, or abort,
run the "Abort cleanup" block at the end of section 1 before closing the
window; it restarts the edge recycle and backup/restore timers when `window.env`
says this window stopped them. After curated copy-back, every success or abort
runs `runbook-60`, then `runbook-61`, then Mac `runbook-12`; only that sequence
closes the window and makes its active fixed-name state unavailable to the next
window.

## Site release

A release may cover the stack, edge runtime, site, CLI, and/or migrations. For a
site release, read [`deploy/site/RUNBOOK.md`](site/RUNBOOK.md) and use
[`deploy/site/deploy.sh`](site/deploy.sh) as the site procedure; do not duplicate
their steps here. Before running it, confirm that the deploy runs as the
`commonswarm` user on `yulan-vps-1` by invoking
`deploy/site/deploy.sh commonswarm@yulan-vps-1` (the `ops` user cannot write
`/srv/commonswarm/site`). For that short hostname, compare the fingerprint from
`ssh-keyscan -t ed25519 yulan-vps-1 | ssh-keygen -lf -` with the fingerprint
recorded by HezLead before adding it to `known_hosts`.

Every site release must build from the exact release commit and preserve the
build settings used by the previous site release, including
`PUBLIC_H0_LINK_JOIN=1` in the `site/.env` read by the build (as used for the
0.1.77 and 0.1.78 site releases). For a CLI release, use the
`release/<version>` commit so `/download` shows the new version. That commit is
not a later `main` snapshot, so the handoff must list what it includes and what
later changes on `main` it leaves out. A site built from a SHA on `main` carries
every change on `main` up to that SHA, so that handoff must list what it carries.
A site release that depends on a server change follows that server's window.

## 1. Common release preparation

### Window plan rules

When a release is split across PREP, Window A, Window B, and a dependent site
lane, handoffs are receipts, never inherited shell state. PREP emits one
`PREP_RECEIPT_PATH`; Window A authenticates every receipt-bound seat before its
first change and owns revocation, zero-active-token readback, and guarded seat
directory removal on every ending. Window A's close receipt is the only input
that may unlock Window B or the dependent site lane. A dry run executes the
selected whole blocks in their documented order from an empty environment and
must report no `UNPRODUCED` dependency.

Browser release controls use headless Playwright's bundled Chromium or
agent-browser with a fresh task-owned profile and `--password-store=basic`,
only in an explicitly assigned browser task. Never start installed Google
Chrome, use a real profile, or read the macOS keychain. Controls record the
starting workspace, switch through the product's workspace switcher, assert
the control workspace before every action, remain view-only, and restore the
starting workspace. A signed-out profile selects the plan's reduced branch;
a keychain dialog is STOP. Remove the task-owned profile through guarded rm
when the window closes.

Every window plan that mints a control, seed, or proof principal must append the
per-run `WINDOW_PRINCIPAL_SUFFIX` to every such name and use that one value in
every minting step. The box's GNU `date` computes it once from the approved
`WINDOW_START_UTC` written to `window.env`:

```sh
# step: runbook-01
# readonly: yes
# host: box /bin/bash 5.2 as root
if [ -z "${WINDOW_START_UTC:-}" ]; then
  printf 'STOP: WINDOW_START_UTC is required (HezLead-approved YYYY-MM-DDTHH:MM:SSZ)\n' >&2
  false
else
  case "$WINDOW_START_UTC" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z)
      WINDOW_START_EPOCH="$(date -u -d "$WINDOW_START_UTC" +%s 2>/dev/null || printf invalid)"
      case "$WINDOW_START_EPOCH" in
        (*[!0-9]*|'')
          unset WINDOW_START_EPOCH
          printf 'STOP: WINDOW_START_UTC must be a valid ISO-8601 UTC time\n' >&2
          false
          ;;
        (*)
          unset WINDOW_START_EPOCH
          WINDOW_PRINCIPAL_SUFFIX="$(date -u -d "$WINDOW_START_UTC" +%H%M%S)"
          ;;
      esac
      ;;
    *) printf 'STOP: WINDOW_START_UTC must be an ISO-8601 UTC time in YYYY-MM-DDTHH:MM:SSZ form\n' >&2; false ;;
  esac
fi
```

On a re-run, set a new window start and use the resulting fresh names without
editing the plan. Never revoke and reuse a principal name across runs. The
non-secret release evidence `window-principal-suffix.txt` records the suffix
used.

The same approved start defines `WINDOW_ID` as `YYYYMMDDTHHMMSSZ`. Every
window artifact is either removed by that window's close/rollback or is moved
or created under a name containing this ID. A closed proof directory has the
exact name `<sha>.closed-window-<window-id>`; steps address the active exact-SHA
name only and must never list, glob, or select a `*.closed-window-*` path.

The release-directory verifier permits only archive entries, `RELEASE_SHA`,
and the known edge-only `deploy/edge-runtime/compose.override.yaml`. It derives
that file's expected SHA-256 and mode from the exact previous-release source
that `runbook-31` copies. Its evidence line records the relative path, digest,
and `accepted known box-only file`; every unknown path or metadata, type,
ownership, symlink, mode, target, or content mismatch remains a stop.

#### Window artifact inventory

| Path or object | Class | Created by | Removed or accepted by |
|---|---|---|---|
| `/home/commonswarm/{edge,stack}/releases/<sha>` and `RELEASE_SHA` | A: archive plus accepted box-only file | `1-apply-release-directories`; override added by `runbook-31` | Same verifier; only the source-derived edge override may be extra |
| Active `/home/commonswarm/stack/release-proofs/<sha>` including `window.env`, timer markers, copy-back list, journals/evidence and checksums | B: per-window name on close | `runbook-03`, `1-apply-release-directories`, later proof steps | `runbook-61` moves it to `<sha>.closed-window-<window-id>` after copy-back and transient cleanup |
| `docs/evidence/<day>-release-<short-sha>-<window-id>/` and its manifest/log/archive records | B: per-window name | `runbook-02`, `runbook-07`, copy-back | Retained by its exact per-window name |
| Mac `/tmp/commonswarm-<sha>-<window-id>.tar`, `/tmp/commonswarm-<sha>-<window-id>.window.env`, `/tmp/commonswarm-release-proofs-<sha>-<window-id>.tar`, and `$HOME/.commonswarm-release-window.env` | B: removed by close/rollback | `runbook-02`, `runbook-08` | `runbook-12` |
| Box `/tmp/commonswarm-release.tar`, `/tmp/commonswarm-release-window.env`, and `/tmp/commonswarm-release-proofs.tar` | B: removed by close/rollback | `1-upload-release-archive`, `runbook-08` | `runbook-60` |
| `/run/commonswarm-release-<sha>-{service.conf,pass,apply.sql,session.sh}` | B: removed by close/rollback | `runbook-17` | `runbook-60` |
| `mktemp` router, Caddy-drift, boundary-read and boundary-probe paths | B: removed by owning block | `runbook-04`, Caddy drift steps, item plan probes | Each block's guarded `trap` |
| Caddy `*.tmp.<sha>` candidates and stack unit-before directory inside the active proof directory | B: removed/moved or per-window on close | Caddy/guarded-stack steps | Atomic move/rollback; proof-directory close by `runbook-61` |
| HM37 Mac input root, box control root/journal, and `/run/commonswarm-hm37-<window-id>` staging | B: per-window name | HM37 input/stage/transfer steps | Retained or removed only under the exact approved `WINDOW_ID`; the next window uses a different exact name |
| HM37 `/usr/local/bin/deno`, `/run/commonswarm-deno-<window-id>`, and the box control root's `deno-cache` | B: temporary runtime/cache; measured baseline has no Deno | `hm37-deno-install`, then `hm37-hosted-control-stage` | Install-step trap removes download scratch; `hm37-deno-remove` checks the recorded binary digest before removing the binary and per-window cache on close or rollback |

### Preflight — CSwarmDevLead, HezLead, then Anvil

1. CSwarmDevLead names one full 40-character `<sha>`, its reviewed PR, the
   affected surfaces, and any required catalog/function verification files.
   The SHA must already be on `main`. The lead also supplies gate evidence
   recorded at that exact SHA. It must include both
   `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`
   and `npm run check:edge`, plus the other gates required by the change.
2. HezLead approves that SHA and an agreed maximum backup age in seconds when a
   database backup is required.
3. Anvil runs `runbook-02` and `runbook-04` on the Mac mini from this
   repository. `runbook-02` proves the archive came from the GitHub remote;
   `runbook-04` checks edge environment names only when `KIND_LIST` contains
   `edge`, otherwise it reports "not applicable" and exits 0. The lead must have
   already written
   `gate-evidence.txt` in the evidence directory, whose name uses the UTC date on
   which the preflight runs (`docs/evidence/<UTC date>-release-<12-char sha>-<window-id>/`,
   or the same name under `EVIDENCE_ROOT` when the item plan's open receipt names
   one; see the note after `runbook-02`). `git archive` reads tracked
   Git objects and has no `--no-xattrs` option; Mac `tar` commands below use
   both `COPYFILE_DISABLE=1` and `--no-xattrs`.

```sh
# step: runbook-02
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
rm -f "$HOME/.commonswarm-release-window.env"
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-02: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  SHA="$RELEASE_SHA"
  WINDOW_OPEN_RECEIPT="/tmp/commonswarm-release-open-${RELEASE_SHA}.env"
  test -f "$WINDOW_OPEN_RECEIPT"
  test ! -L "$WINDOW_OPEN_RECEIPT"
  test "$(stat -f %Lp "$WINDOW_OPEN_RECEIPT")" = 600
  unset EVIDENCE_ROOT RELEASE_REPO
  . "$WINDOW_OPEN_RECEIPT"
  test "$SHA" = "$RELEASE_SHA"
  if [ -n "${RELEASE_REPO:-}" ]; then
    # An item plan that cloned its own release checkout names it in the open
    # receipt. Every git command below, the archive, and the evidence-root
    # guard then refer to that checkout and not to the caller's directory.
    case "$RELEASE_REPO" in /*) ;; *) false ;; esac
    cd "$RELEASE_REPO"
  fi
  case "$WINDOW_START_UTC" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
    *) false ;;
  esac
  DERIVED_WINDOW_ID="$(printf '%s' "$WINDOW_START_UTC" | tr -d ':-')"
  test "$WINDOW_ID" = "$DERIVED_WINDOW_ID"
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
  case "$WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  check 'origin URL' test "$(git remote get-url origin)" = 'https://github.com/yulanventures/commonswarm.git'
  check 'origin/main fetch' git fetch origin main
  check 'exact commit' test "$(git rev-parse "${SHA}^{commit}")" = "$SHA"
  check 'SHA on origin/main' git merge-base --is-ancestor "$SHA" origin/main

  SHORT_SHA="$(git rev-parse --short=12 "$SHA")"
  RUN_DAY="$(date -u +%F)"
  EVIDENCE_DIR="${EVIDENCE_ROOT:-$PWD/docs/evidence}/${RUN_DAY}-release-${SHORT_SHA}-${WINDOW_ID}"
  if [ -n "${EVIDENCE_ROOT:-}" ]; then
    # An item plan that names EVIDENCE_ROOT keeps its release checkout clean, so
    # the evidence directory is absolute and never inside this checkout.
    case "$EVIDENCE_ROOT" in /*) ;; *) false ;; esac
    case "$EVIDENCE_DIR" in "$PWD"|"$PWD"/*) false ;; esac
  fi
  RUN_LOG="$EVIDENCE_DIR/run.log"
  ARCHIVE="/tmp/commonswarm-${SHA}-${WINDOW_ID}.tar"
  BOX_WINDOW_INPUT="/tmp/commonswarm-${SHA}-${WINDOW_ID}.window.env"
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
  ( umask 077; printf 'SHA=%q\nWINDOW_START_UTC=%q\nWINDOW_END_UTC=%q\nWINDOW_ID=%q\nWINDOW_PRINCIPAL_SUFFIX=%q\nBACKUP_MAX_AGE_SECONDS=%q\nSHORT_SHA=%q\nEVIDENCE_DIR=%q\nRUN_LOG=%q\nARCHIVE=%q\nBOX_WINDOW_INPUT=%q\n' \
      "$SHA" "$WINDOW_START_UTC" "$WINDOW_END_UTC" "$WINDOW_ID" \
      "$WINDOW_PRINCIPAL_SUFFIX" "$BACKUP_MAX_AGE_SECONDS" "$SHORT_SHA" \
      "$EVIDENCE_DIR" "$RUN_LOG" "$ARCHIVE" "$BOX_WINDOW_INPUT" >"$HOME/.commonswarm-release-window.env" )
  if [ -n "${RELEASE_REPO:-}" ]; then
    printf 'RELEASE_REPO=%q\n' "$RELEASE_REPO" >>"$HOME/.commonswarm-release-window.env"
  fi
  chmod 0600 "$HOME/.commonswarm-release-window.env"
  ( umask 077; printf 'SHA=%q\nWINDOW_START_UTC=%q\nWINDOW_END_UTC=%q\nWINDOW_ID=%q\nWINDOW_PRINCIPAL_SUFFIX=%q\nBACKUP_MAX_AGE_SECONDS=%q\n' \
      "$SHA" "$WINDOW_START_UTC" "$WINDOW_END_UTC" "$WINDOW_ID" \
      "$WINDOW_PRINCIPAL_SUFFIX" "$BACKUP_MAX_AGE_SECONDS" >"$BOX_WINDOW_INPUT" )
  chmod 0600 "$BOX_WINDOW_INPUT"
  printf 'window file written\n'
)
```

If the block printed a FAIL, stop: no window file exists, and every later Mac
block refuses to run. Every later Mac block runs in its own `set -euo pipefail`
subshell, starts with `. "$HOME/.commonswarm-release-window.env"` and
`test "$SHA" = <sha>`, and so fails closed after a lost shell. Section 1's
Mac cleanup deletes the file when the window closes.

When the open receipt names `EVIDENCE_ROOT` (an item plan sets it when its
release checkout must stay clean), `runbook-02` creates the evidence directory
under that root instead of `$PWD/docs/evidence`. The directory name is the same
and the path is persisted in the window file, so every later block reads one
value. A receipt with no `EVIDENCE_ROOT` keeps the checkout-relative default.
When the receipt names `RELEASE_REPO`, `runbook-02` changes into that checkout
first, so the origin URL, the fetch, the archive, and the guard that keeps the
evidence directory outside the checkout all describe the checkout the plan
proved clean.

Record approvals, affected surfaces, the backup-age agreement, commands, exit
codes, and safe verification output in `run.log`. Never record an environment
file, credential, curl authorization file, or secret value.

Immediately after `1-apply-release-directories` has derived and persisted the
window identity, and before any database, service, timer, symlink, or Caddy
mutation, Anvil runs `runbook-03` on the box to create the copy-back manifest.
Set `KIND_LIST` to the same approved surfaces used by the apply block,
list every pending migration version, and list the subset whose functional
proof produces a `.txt` file during this window. Set `NO_MIGRATIONS=no` for a
migration release; both version lists must be non-empty. For a stack-only image
release, use `KIND_LIST='stack'`, `NO_MIGRATIONS=yes`, `MIGRATION_VERSIONS=''`,
and `FUNCTIONAL_VERSIONS=''` in the durable `item-resolved-inputs.env` on both
hosts. Both lists must be present and empty with `yes`; a missing input, an
invalid switch value, or a non-empty list stops the block. Its copy-back manifest
then contains no migration entries. Set the five named switches
when the window includes the section 4 H0 ledger backfill, the guarded stack
switch, the section 8 backup-status proof, the section 9 API Caddy pair, or the
section 9 MCP Caddy site.

The five switches select whole runbook blocks. `yes` includes the named group;
`no` skips every step in that group:

| Switch | Whole-block step group |
|---|---|
| `H0_LEDGER_BACKFILL` | `runbook-18`, `runbook-19`, `runbook-20` |
| `GUARDED_STACK_SWITCH` | `runbook-48` |
| `BACKUP_STATUS_PROOF` | `runbook-54`, `runbook-55` |
| `API_CADDY_PAIR` | `runbook-56`, `runbook-57`, `runbook-58`, `runbook-59` |
| `MCP_CADDY_RELEASE` | `runbook-mcp-caddy-preflight`, `runbook-mcp-caddy-apply`, `runbook-mcp-caddy-verify`, `runbook-mcp-caddy-rollback` |

Add exact relative paths from the item's box plan to `ITEM_COPY_BACK_FILES`; this is the only place to append
item-specific evidence. Do not add `run.log`, `box-run.log`, `window.env`, any
other `*.log`, any `*.err` file (the copy-back block handles those), or anything
under `database/logs/`. The edge and stack recreate steps append only their
bounded `<container>.<release-sha>.docker.log` files after capturing them. The
initial manifest is built only from the explicit arrays below, never from
`find`:

```sh
# step: runbook-03
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-03: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  unset NO_MIGRATIONS
  . "$PROOF_DIR/item-resolved-inputs.env"
  : "${KIND_LIST:?resolved item input missing}"
  : "${H0_LEDGER_BACKFILL:?resolved item input missing}"
  : "${GUARDED_STACK_SWITCH:?resolved item input missing}"
  : "${BACKUP_STATUS_PROOF:?resolved item input missing}"
  : "${API_CADDY_PAIR:?resolved item input missing}"
  : "${MCP_CADDY_RELEASE:?resolved item input missing}"
  : "${NO_MIGRATIONS:?resolved item input missing}"
  : "${MIGRATION_VERSIONS?resolved item input missing}"
  : "${FUNCTIONAL_VERSIONS?resolved item input missing}"
  case "$NO_MIGRATIONS" in
    yes) test -z "$MIGRATION_VERSIONS"; test -z "$FUNCTIONAL_VERSIONS" ;;
    no) test -n "$MIGRATION_VERSIONS"; test -n "$FUNCTIONAL_VERSIONS" ;;
    *) false ;;
  esac
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  LIST_INPUT="$MIGRATION_VERSIONS"
  MIGRATION_VERSIONS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then MIGRATION_VERSIONS[${#MIGRATION_VERSIONS[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  LIST_INPUT="$FUNCTIONAL_VERSIONS"
  FUNCTIONAL_VERSIONS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then FUNCTIONAL_VERSIONS[${#FUNCTIONAL_VERSIONS[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  if [ "$NO_MIGRATIONS" = no ]; then
    test -n "${MIGRATION_VERSIONS[*]:-}"
    test -n "${FUNCTIONAL_VERSIONS[*]:-}"
  fi
  ITEM_COPY_BACK_FILES=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    test -n "$VALUE" && ITEM_COPY_BACK_FILES[${#ITEM_COPY_BACK_FILES[@]}]="$VALUE"
  done <"$PROOF_DIR/item-copy-back-files.list"
  COPY_BACK_LIST="$PROOF_DIR/copy-back.list"
  COPY_BACK_FILES=(
    copy-back.list
    gate-evidence.txt
    box-archive.sha256
    window-principal-suffix.txt
  )

  test "${#SHA}" -eq 40
  case "$WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  case " ${KIND_ARRAY[*]} " in
    *' edge '*|*' stack '*) ;;
    *) false ;;
  esac
  for KIND in "${KIND_ARRAY[@]}"; do
    case "$KIND" in edge|stack) ;; *) false ;; esac
  done
  for SWITCH in "$H0_LEDGER_BACKFILL" "$GUARDED_STACK_SWITCH" "$BACKUP_STATUS_PROOF" "$API_CADDY_PAIR" "$MCP_CADDY_RELEASE"; do
    case "$SWITCH" in yes|no) ;; *) false ;; esac
  done
  install -d -m 0700 -o root -g root "$PROOF_DIR"
  case " ${KIND_ARRAY[*]} " in
    *' edge '*)
      COPY_BACK_FILES+=(
        edge.SHA256SUMS
        edge.release-dir-state.txt
        known-box-only-files.txt
        edge-with-override.SHA256SUMS
        required-edge-env.json
        edge-env-source-check.txt
        edge-probe-start.txt
        h0-note-unauth.json
      )
      ;;
  esac
  case " ${KIND_ARRAY[*]} " in
    *' stack '*) COPY_BACK_FILES+=(stack.SHA256SUMS stack.release-dir-state.txt) ;;
  esac
  if [ "$H0_LEDGER_BACKFILL" = yes ]; then
    COPY_BACK_FILES+=(h0-ledger-before.txt h0-ledger-after.txt)
  fi
  if [ "$GUARDED_STACK_SWITCH" = yes ]; then
    case " ${KIND_ARRAY[*]} " in *' stack '*) ;; *) false ;; esac
    COPY_BACK_FILES+=(stack-switch-timers.txt)
  fi
  if [ "$BACKUP_STATUS_PROOF" = yes ]; then
    COPY_BACK_FILES+=(backup-status.json)
  fi
  if [ "$API_CADDY_PAIR" = yes ]; then
    case " ${KIND_ARRAY[*]} " in *' stack '*) ;; *) false ;; esac
    COPY_BACK_FILES+=(
      caddy-before-10-commonswarm-api.caddy
      caddy-before-11-commonswarm-edge-staging.caddy
      caddy-after-10-commonswarm-api.caddy
      caddy-after-11-commonswarm-edge-staging.caddy
      caddy-drift-check.txt
      caddy-log-files.txt
    )
  fi
  if [ "$MCP_CADDY_RELEASE" = yes ]; then
    case " ${KIND_ARRAY[*]} " in *' stack '*) ;; *) false ;; esac
    COPY_BACK_FILES+=(
      mcp-caddy-before.caddy
      mcp-caddy-before-state.txt
      mcp-caddy-candidate.caddy
      mcp-caddy-after.caddy
      mcp-caddy-drift-check.txt
      mcp-caddy-log-files.txt
    )
  fi
  if [ "${#MIGRATION_VERSIONS[@]}" -gt 0 ]; then
    COPY_BACK_FILES+=(
      migration-files.txt
      migration-files.sha256
      ledger-before.txt
      pending-versions.txt
      migration-state-before.txt
      migration-state-after.txt
      cron-before.txt
      cron-after.txt
      cron-before-sorted.txt
      cron-after-sorted.txt
      cron-added.txt
      cron-removed.txt
      verification-sql.sha256
    )
  fi
  for VERSION in "${MIGRATION_VERSIONS[@]}"; do
    case "$VERSION" in (*[!0-9]*|'') false ;; esac
    test "${#VERSION}" -eq 14
    COPY_BACK_FILES+=("${VERSION}-catalog.sql" "${VERSION}-functional.sql")
  done
  for VERSION in "${FUNCTIONAL_VERSIONS[@]}"; do
    case "$VERSION" in (*[!0-9]*|'') false ;; esac
    test "${#VERSION}" -eq 14
    printf '%s\n' "${MIGRATION_VERSIONS[@]}" | grep -qFx "$VERSION"
    COPY_BACK_FILES+=("${VERSION}-functional.txt")
  done
  COPY_BACK_FILES+=("${ITEM_COPY_BACK_FILES[@]}")

  for path in "${COPY_BACK_FILES[@]}"; do
    test -n "$path"
    case "$path" in
      /*|./*|../*|*/../*|*.log|*.err|database/logs/*|*/database/logs/*|window.env|*/window.env) false ;;
    esac
  done
  test -z "$(printf '%s\n' "${COPY_BACK_FILES[@]}" | LC_ALL=C sort | uniq -d)"
  install -m 0600 -o root -g root /dev/null "$COPY_BACK_LIST"
  printf '%s\n' "${COPY_BACK_FILES[@]}" >"$COPY_BACK_LIST"
  test "$(stat -c '%U:%G:%a' "$COPY_BACK_LIST")" = root:root:600
  grep -qFx 'copy-back.list' "$COPY_BACK_LIST"
)
```

For a database release, CSwarmDevLead places the reviewed catalog and functional
verification SQL in `EVIDENCE_DIR` before Anvil continues. For an edge release,
derive the environment-name inventory from the same exact-SHA archive on the Mac.
The archived router's `REQUIRED_MAIN_ENV` (which includes the service-role
key) and database alias rule are the base; the lead
reviews strict checks in each changed function at that SHA and adds any further
required name. Forwarded names without a strict requirement are optional. This
inventory records only names, never values. Set `CHANGED_FUNCTIONS` from the
reviewed diff; a router change checks all six prepared function names, including
the dark `mcp` name:

```sh
# step: runbook-04
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-04: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-release-window.env"
  : "${RELEASE_SHA:?named release SHA required}"
  test "$SHA" = "$RELEASE_SHA"
  unset KIND_LIST
  . "$EVIDENCE_DIR/item-resolved-inputs.env"
  : "${KIND_LIST:?resolved item input missing}"
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  for KIND in "${KIND_ARRAY[@]}"; do
    case "$KIND" in edge|stack) ;; *) false ;; esac
  done
  case " ${KIND_ARRAY[*]} " in
    *' edge '*) ;;
    *) printf 'runbook-04: not applicable (KIND_LIST has no edge)\n'; exit 0 ;;
  esac
  test -s "$ARCHIVE"
  ROUTER_DIR="$(mktemp -d /tmp/commonswarm-router-XXXXXX)"
  case "$ROUTER_DIR" in /tmp/commonswarm-router-??????) ;; *) false ;; esac
  trap 'status=$?; rm -r -- "$ROUTER_DIR"; exit "$status"' EXIT
  ROUTER_SOURCE="$ROUTER_DIR/router.ts"
  tar -xOf "$ARCHIVE" deploy/edge-runtime/main/router.ts >"$ROUTER_SOURCE"
  : "${CHANGED_FUNCTIONS:?resolved item input missing}"
  : "${ROUTER_CHANGED:?resolved item input missing}"
  ADDITIONAL_REQUIRED_ENV_NAMES='' # Lead lists any new strict function requirements from this SHA.
  if [ "$ROUTER_CHANGED" = yes ]; then CHANGED_FUNCTIONS='command read capability activity h0 mcp'; fi
  case "$ROUTER_CHANGED" in yes|no) ;; *) false ;; esac
  LIST_INPUT="$CHANGED_FUNCTIONS"
  CHANGED_FUNCTION_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then CHANGED_FUNCTION_ARRAY[${#CHANGED_FUNCTION_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${CHANGED_FUNCTION_ARRAY[*]:-}"
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
    "$ROUTER_SOURCE" "${CHANGED_FUNCTION_ARRAY[*]}" "$ADDITIONAL_REQUIRED_ENV_NAMES" \
    >"$EVIDENCE_DIR/required-edge-env.json"
  chmod 0600 "$EVIDENCE_DIR/required-edge-env.json"
  tar -xOf "$ARCHIVE" deploy/edge-runtime/main/router.ts \
    | grep -nE 'REQUIRED_MAIN_ENV|mainEnvironmentProblems|FUNCTION_ENV_NAMES' \
    >"$EVIDENCE_DIR/edge-env-source-check.txt"
  chmod 0600 "$EVIDENCE_DIR/edge-env-source-check.txt"
)
```

Runbook step `runbook-04` records the changed-function list from the reviewed
diff in `run.log`; HezLead decides whether the list matches the approved scope.
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
runs only if stack runtime files changed. Run `runbook-05` only after
`1-apply-release-directories` below has built the requested release directories
and persisted `window.env`. For `KIND_LIST='stack'` it builds only the stack release
directory; the same comparison applies. Compare them on the box before deciding:

```sh
# step: runbook-05
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
mode `0755`. The block records both previous release paths before any switch and
writes the durable window state. A missing release directory is created exactly
as before. An existing directory is never extracted over, deleted, repaired, or
otherwise changed: the block reuses it only after matching its full `RELEASE_SHA`,
archive file hashes, complete path inventory and count, symlink targets and
containment, owner, group, and modes. A mismatch is a stop. The same verifier is
used for both the edge and stack release directories.

`RELEASE_DIR_STATE` in `window.env` is `created` or `reused` when all requested
surfaces have that state, and `mixed` when one was created and the other reused.
`EDGE_RELEASE_DIR_STATE` and `STACK_RELEASE_DIR_STATE` preserve each requested
surface's exact state; an unrequested surface is `not-requested`. The proof
directory also holds `edge.release-dir-state.txt` or
`stack.release-dir-state.txt`, each containing the corresponding
`RELEASE_DIR_STATE=created` or `RELEASE_DIR_STATE=reused` result.

A diagnostic-only window runs section 1's preflight, copy-back manifest, archive
upload/apply, release verification, proof transfer/copy-back, and abort cleanup,
then the Mac cleanup, plus only the read-only diagnostic blocks named in its
approved plan. It skips the mutation and switch steps in sections 2 through 8.
Its section 1 apply uses the reviewed existing release through the `reused`
path; a diagnostic-only window never needs a fresh release directory.

Set the approved UTC window start and end once in this block; every later box
block reads them from `window.env`.

```sh
# step: 1-upload-release-archive
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL 1-upload-release-archive: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-release-window.env"
  : "${RELEASE_SHA:?named release SHA required}"
  test "$SHA" = "$RELEASE_SHA"
  test -s "$ARCHIVE"
  test -s "$BOX_WINDOW_INPUT"
  scp "$ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release.tar
  scp "$BOX_WINDOW_INPUT" ops@100.115.66.74:/tmp/commonswarm-release-window.env
)
```

Verify a noninteractive root shell on the box with `1-open-root-shell`.
For each later box block, pass the complete block to a fresh
`ssh ops@100.115.66.74 'sudo -n -i /bin/bash -s'` invocation or execute it
in a box root shell. This check exits after verifying root access; later
blocks load their own persisted state.

```sh
# step: 1-open-root-shell
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil; box /bin/bash 5.2 as root via ssh
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL 1-open-root-shell: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  ssh ops@100.115.66.74 'sudo -n -i /bin/bash -s' <<'BOX'
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL 1-open-root-shell: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  test "$(id -u)" -eq 0
)
BOX
)
```

Then prepare or verify each requested immutable release directory and write the
window state:

```sh
# step: 1-apply-release-directories
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL 1-apply-release-directories: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . /tmp/commonswarm-release-window.env
  test "$SHA" = "$RELEASE_SHA"
  : "${WINDOW_END_UTC:?load the box-clock-derived window end from the open receipt}"
  ARCHIVE=/tmp/commonswarm-release.tar
  : "${KIND_LIST:?resolved item input missing}"
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  : "${EXPECTED_ARCHIVE_SHA256:?archive digest missing from resolved box input}"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  NEW_EDGE="/home/commonswarm/edge/releases/${SHA}"
  NEW_STACK="/home/commonswarm/stack/releases/${SHA}"
  PREVIOUS_EDGE="$(readlink -f /home/commonswarm/edge/current)"
  PREVIOUS_STACK="$(readlink -f /home/commonswarm/stack/current)"
  test -n "$PREVIOUS_EDGE"
  test -n "$PREVIOUS_STACK"
  case " ${KIND_ARRAY[*]} " in
    *' edge '*|*' stack '*) ;;
    *) false ;;
  esac
  for KIND in "${KIND_ARRAY[@]}"; do
    case "$KIND" in edge|stack) ;; *) false ;; esac
  done
  for T in "$WINDOW_START_UTC" "$WINDOW_END_UTC"; do
    case "$T" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
      *) false ;;
    esac
    date -u -d "$T" +%s >/dev/null
  done
  DERIVED_WINDOW_ID="$(date -u -d "$WINDOW_START_UTC" +%Y%m%dT%H%M%SZ)"
  test "$WINDOW_ID" = "$DERIVED_WINDOW_ID"
  WINDOW_PRINCIPAL_SUFFIX="$(date -u -d "$WINDOW_START_UTC" +%H%M%S)"
  RECYCLE_TIMER_STOPPED=0
  BACKUP_TIMERS_STOPPED=0
  RELEASE_DIR_STATE=''
  EDGE_RELEASE_DIR_STATE=not-requested
  STACK_RELEASE_DIR_STATE=not-requested
  RELEASE_OWNER=commonswarm
  RELEASE_GROUP=commonswarm
  PROOF_OWNER=root
  PROOF_GROUP=root
  for VALUE in "$SHA" "$KIND_LIST" "$WINDOW_START_UTC" "$WINDOW_END_UTC" "$WINDOW_ID" "$WINDOW_PRINCIPAL_SUFFIX" "$NEW_EDGE" "$NEW_STACK" "$PREVIOUS_EDGE" "$PREVIOUS_STACK" "$RECYCLE_TIMER_STOPPED" "$BACKUP_TIMERS_STOPPED"; do case "$VALUE" in *"'"*) false ;; esac; done

  install -d -m 0700 -o root -g root "$PROOF_DIR"
  sha256sum "$ARCHIVE" >"$PROOF_DIR/box-archive.sha256"
  BOX_ARCHIVE_LINE="$(cat "$PROOF_DIR/box-archive.sha256")"
  test "${BOX_ARCHIVE_LINE%% *}" = "$EXPECTED_ARCHIVE_SHA256"

  install -m 0600 -o "$PROOF_OWNER" -g "$PROOF_GROUP" /dev/null \
    "$PROOF_DIR/known-box-only-files.txt"

  prepare_release_directory() {
    KIND="$1"
    RELEASE_DIR="$2"
    RELEASE_MODE="$3"
    KNOWN_BOX_ONLY_SOURCE=''
    if [ "$KIND" = edge ]; then
      KNOWN_BOX_ONLY_SOURCE="$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml"
      test -f "$KNOWN_BOX_ONLY_SOURCE"
      test ! -L "$KNOWN_BOX_ONLY_SOURCE"
    fi
    if [ ! -e "$RELEASE_DIR" ] && [ ! -L "$RELEASE_DIR" ]; then
      RELEASE_DIR_RESULT=created
      install -d -m "$RELEASE_MODE" -o "$RELEASE_OWNER" -g "$RELEASE_GROUP" "$RELEASE_DIR"
      tar -xf "$ARCHIVE" -C "$RELEASE_DIR"
      APPLEDOUBLE="$(find "$RELEASE_DIR" -name '._*' -print -quit)"
      test -z "$APPLEDOUBLE"
      printf '%s\n' "$SHA" >"$RELEASE_DIR/RELEASE_SHA"
      chmod 0644 "$RELEASE_DIR/RELEASE_SHA"
      chown -R "$RELEASE_OWNER:$RELEASE_GROUP" "$RELEASE_DIR"
      chmod "$RELEASE_MODE" "$RELEASE_DIR"
    else
      RELEASE_DIR_RESULT=reused
    fi

    export ARCHIVE RELEASE_DIR RELEASE_MODE SHA RELEASE_OWNER RELEASE_GROUP KIND \
      KNOWN_BOX_ONLY_SOURCE PROOF_DIR
    python3 - <<'PY'
import hashlib
import os
import pwd
import grp
import stat
import sys
import tarfile
from pathlib import PurePosixPath

archive = os.environ["ARCHIVE"]
release_dir = os.path.abspath(os.environ["RELEASE_DIR"])
release_dir_real = os.path.realpath(release_dir)
release_mode = int(os.environ["RELEASE_MODE"], 8)
sha = os.environ["SHA"]
owner_uid = pwd.getpwnam(os.environ["RELEASE_OWNER"]).pw_uid
group_gid = grp.getgrnam(os.environ["RELEASE_GROUP"]).gr_gid

def stop(message):
    raise SystemExit(f"release directory verification failed: {message}")

def clean_name(raw):
    name = raw.rstrip("/")
    if not name or name == ".":
        return None
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        stop(f"unsafe archive path: {raw!r}")
    return path.as_posix()

def contained_symlink(path, target):
    if os.path.isabs(target):
        return False
    resolved = os.path.realpath(os.path.join(os.path.dirname(path), target))
    try:
        return os.path.commonpath([release_dir_real, resolved]) == release_dir_real
    except ValueError:
        return False

expected = {}
with tarfile.open(archive, "r:*") as release_archive:
    for member in release_archive.getmembers():
        name = clean_name(member.name)
        if name is None:
            continue
        if name in expected:
            stop(f"duplicate archive path: {name}")
        if ".git" in PurePosixPath(name).parts and member.isdir():
            stop(f"archive contains .git directory: {name}")
        if member.isdir():
            expected[name] = ("directory", member.mode & 0o7777, None, None)
        elif member.isfile():
            source = release_archive.extractfile(member)
            if source is None:
                stop(f"cannot read archive file: {name}")
            digest = hashlib.sha256(source.read()).hexdigest()
            expected[name] = ("file", member.mode & 0o7777, digest, None)
        elif member.issym():
            expected[name] = ("symlink", member.mode & 0o7777, None, member.linkname)
        else:
            stop(f"unsupported archive entry type: {name}")

if "RELEASE_SHA" in expected:
    stop("archive unexpectedly contains RELEASE_SHA")
expected["RELEASE_SHA"] = (
    "file",
    0o644,
    hashlib.sha256((sha + "\n").encode()).hexdigest(),
    None,
)

known_box_only = {}
known_source = os.environ["KNOWN_BOX_ONLY_SOURCE"]
if os.environ["KIND"] == "edge":
    known_relative = "deploy/edge-runtime/compose.override.yaml"
    try:
        source_stat = os.lstat(known_source)
    except FileNotFoundError:
        stop(f"known box-only source is missing: {known_source}")
    if not stat.S_ISREG(source_stat.st_mode):
        stop(f"known box-only source is not a regular file: {known_source}")
    source_hash = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    source_descriptor = os.open(known_source, flags)
    with os.fdopen(source_descriptor, "rb") as source_file:
        for chunk in iter(lambda: source_file.read(1024 * 1024), b""):
            source_hash.update(chunk)
    known_box_only[known_relative] = (
        "file",
        stat.S_IMODE(source_stat.st_mode),
        source_hash.hexdigest(),
        None,
    )

try:
    root_stat = os.lstat(release_dir)
except FileNotFoundError:
    stop("directory is missing")
if not stat.S_ISDIR(root_stat.st_mode):
    stop("path is not a directory")
if root_stat.st_uid != owner_uid or root_stat.st_gid != group_gid:
    stop("directory owner or group differs")
if stat.S_IMODE(root_stat.st_mode) != release_mode:
    stop(
        f"directory mode differs: expected {release_mode:o}, "
        f"found {stat.S_IMODE(root_stat.st_mode):o}"
    )

actual = {}
def scan(directory, relative_parent=""):
    for entry in os.scandir(directory):
        relative = f"{relative_parent}/{entry.name}" if relative_parent else entry.name
        item_stat = entry.stat(follow_symlinks=False)
        if stat.S_ISDIR(item_stat.st_mode):
            kind = "directory"
        elif stat.S_ISREG(item_stat.st_mode):
            kind = "file"
        elif stat.S_ISLNK(item_stat.st_mode):
            kind = "symlink"
        else:
            stop(f"unsupported filesystem entry type: {relative}")
        actual[relative] = (kind, item_stat)
        if kind == "directory":
            if entry.name == ".git":
                stop(f".git directory is present: {relative}")
            scan(entry.path, relative)

scan(release_dir)
missing = sorted(set(expected) - set(actual), key=os.fsencode)
extra = set(actual) - set(expected)
unknown_extra = sorted(extra - set(known_box_only), key=os.fsencode)
accepted_box_only = sorted(extra & set(known_box_only), key=os.fsencode)
if missing or unknown_extra:
    stop(
        f"path inventory differs: expected_count={len(expected)} "
        f"actual_count={len(actual)} missing={missing!r} extra={unknown_extra!r}"
    )
for relative in accepted_box_only:
    expected[relative] = known_box_only[relative]

for relative in sorted(expected, key=os.fsencode):
    expected_kind, expected_mode, expected_digest, expected_target = expected[relative]
    actual_kind, item_stat = actual[relative]
    path = os.path.join(release_dir, *PurePosixPath(relative).parts)
    if actual_kind != expected_kind:
        stop(f"entry type differs: {relative}")
    if item_stat.st_uid != owner_uid or item_stat.st_gid != group_gid:
        stop(f"owner or group differs: {relative}")
    if actual_kind == "symlink":
        target = os.readlink(path)
        if not contained_symlink(path, target):
            stop(f"symlink leaves release directory: {relative} -> {target}")
    actual_mode = stat.S_IMODE(item_stat.st_mode)
    if actual_mode != expected_mode:
        stop(
            f"mode differs: {relative}: expected {expected_mode:o}, "
            f"found {actual_mode:o}"
        )
    if actual_kind == "file":
        file_hash = hashlib.sha256()
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        descriptor = os.open(path, flags)
        with os.fdopen(descriptor, "rb") as current:
            for chunk in iter(lambda: current.read(1024 * 1024), b""):
                file_hash.update(chunk)
        if file_hash.hexdigest() != expected_digest:
            if relative == "RELEASE_SHA":
                stop(f"RELEASE_SHA differs from window SHA {sha}")
            stop(f"file hash differs: {relative}")
    elif actual_kind == "symlink":
        if target != expected_target:
            stop(f"symlink target differs: {relative}")

with open(os.path.join(os.environ["PROOF_DIR"], "known-box-only-files.txt"), "a", encoding="utf-8") as evidence:
    for relative in accepted_box_only:
        digest = expected[relative][2]
        evidence.write(f"{relative} sha256={digest} accepted known box-only file\n")

print(
    f"release directory verified: entries={len(actual)} "
    f"files={sum(1 for value in actual.values() if value[0] == 'file')}"
)
PY
    (cd "$RELEASE_DIR" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
      >"$PROOF_DIR/${KIND}.SHA256SUMS"
    (cd "$RELEASE_DIR" && sha256sum --quiet --strict --check "$PROOF_DIR/${KIND}.SHA256SUMS")
    install -m 0600 -o "$PROOF_OWNER" -g "$PROOF_GROUP" /dev/null "$PROOF_DIR/${KIND}.release-dir-state.txt"
    printf 'RELEASE_DIR_STATE=%s\n' "$RELEASE_DIR_RESULT" \
      >"$PROOF_DIR/${KIND}.release-dir-state.txt"
  }

  for KIND in "${KIND_ARRAY[@]}"; do
    if [ "$KIND" = edge ]; then
      prepare_release_directory edge "$NEW_EDGE" 0750
      EDGE_RELEASE_DIR_STATE="$RELEASE_DIR_RESULT"
    else
      prepare_release_directory stack "$NEW_STACK" 0755
      STACK_RELEASE_DIR_STATE="$RELEASE_DIR_RESULT"
    fi
    if [ -z "$RELEASE_DIR_STATE" ]; then
      RELEASE_DIR_STATE="$RELEASE_DIR_RESULT"
    elif [ "$RELEASE_DIR_STATE" != "$RELEASE_DIR_RESULT" ]; then
      RELEASE_DIR_STATE=mixed
    fi
  done

  WINDOW_ENV="$PROOF_DIR/window.env"
  {
    printf '%s=%q\n' SHA "$SHA"
    printf '%s=%q\n' KIND_LIST "$KIND_LIST"
    printf '%s=%q\n' WINDOW_START_UTC "$WINDOW_START_UTC"
    printf '%s=%q\n' WINDOW_END_UTC "$WINDOW_END_UTC"
    printf '%s=%q\n' WINDOW_ID "$WINDOW_ID"
    printf '%s=%q\n' WINDOW_PRINCIPAL_SUFFIX "$WINDOW_PRINCIPAL_SUFFIX"
    printf '%s=%q\n' NEW_EDGE "$NEW_EDGE"
    printf '%s=%q\n' NEW_STACK "$NEW_STACK"
    printf '%s=%q\n' PREVIOUS_EDGE "$PREVIOUS_EDGE"
    printf '%s=%q\n' PREVIOUS_STACK "$PREVIOUS_STACK"
    printf '%s=%q\n' RECYCLE_TIMER_STOPPED "$RECYCLE_TIMER_STOPPED"
    printf '%s=%q\n' BACKUP_TIMERS_STOPPED "$BACKUP_TIMERS_STOPPED"
    printf '%s=%q\n' RELEASE_DIR_STATE "$RELEASE_DIR_STATE"
    printf '%s=%q\n' EDGE_RELEASE_DIR_STATE "$EDGE_RELEASE_DIR_STATE"
    printf '%s=%q\n' STACK_RELEASE_DIR_STATE "$STACK_RELEASE_DIR_STATE"
  } >"$WINDOW_ENV"
  install -m 0600 -o root -g root /dev/null "$PROOF_DIR/window-principal-suffix.txt"
  printf 'WINDOW_PRINCIPAL_SUFFIX=%q\n' "$WINDOW_PRINCIPAL_SUFFIX" >"$PROOF_DIR/window-principal-suffix.txt"
  chmod 0600 "$WINDOW_ENV" "$PROOF_DIR"/*.SHA256SUMS "$PROOF_DIR"/*.release-dir-state.txt "$PROOF_DIR/box-archive.sha256" "$PROOF_DIR/window-principal-suffix.txt" "$PROOF_DIR/known-box-only-files.txt"
  install -m 0600 -o root -g root /dev/null "$PROOF_DIR/box-run.log"
  printf 'PREVIOUS_EDGE=%s\nPREVIOUS_STACK=%s\n' "$PREVIOUS_EDGE" "$PREVIOUS_STACK" \
    >>"$PROOF_DIR/box-run.log"
)
```

After the apply block has created `PROOF_DIR`, exit the box root shell and SSH
session. Back on the Mac mini, Anvil prepares the proof list. For a database
release, include the SQL files; for an edge release, include the name-only
inventory. `runbook-07` reads `KIND_LIST` from the Mac's durable item inputs:
for `KIND_LIST='stack'` its proof list retains `gate-evidence.txt` and any
reviewed SQL files, and omits `required-edge-env.json` and
`edge-env-source-check.txt`. HezLead reviews this exact list for secrets before
transfer:

```sh
# step: runbook-07
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-07: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = "$RELEASE_SHA"
  test -d "$EVIDENCE_DIR"
  unset KIND_LIST
  . "$EVIDENCE_DIR/item-resolved-inputs.env"
  : "${KIND_LIST:?resolved item input missing}"
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  for KIND in "${KIND_ARRAY[@]}"; do
    case "$KIND" in edge|stack) ;; *) false ;; esac
  done
  PROOF_LIST="$EVIDENCE_DIR/proof-transfer.list"
  (cd "$EVIDENCE_DIR" && find . -maxdepth 1 -type f -name '*.sql' -print | LC_ALL=C sort) >"$PROOF_LIST"
  printf '%s\n' gate-evidence.txt >>"$PROOF_LIST"
  case " ${KIND_ARRAY[*]} " in
    *' edge '*) printf '%s\n' required-edge-env.json edge-env-source-check.txt >>"$PROOF_LIST" ;;
  esac
  chmod 0600 "$PROOF_LIST"
  cat "$PROOF_LIST"
)
```

After HezLead confirms that list, Anvil transfers exactly those files from the
Mac mini:

```sh
# step: runbook-08
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-08: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_ARCHIVE="/tmp/commonswarm-release-proofs-${SHA}-${WINDOW_ID}.tar"
  PROOF_LIST="$EVIDENCE_DIR/proof-transfer.list"
  test -s "$PROOF_LIST"
  (cd "$EVIDENCE_DIR" && COPYFILE_DISABLE=1 tar --no-xattrs -cf "$PROOF_ARCHIVE" -T "$PROOF_LIST")
  scp "$PROOF_ARCHIVE" ops@100.115.66.74:/tmp/commonswarm-release-proofs.tar
)
```

Reconnect to the box as root. Unpack the transferred proof files only after
HezLead confirms their list contains no secret:

```sh
# step: runbook-09
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-09: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  tar -xf /tmp/commonswarm-release-proofs.tar -C "$PROOF_DIR"
  # Resource-fork metadata is unexpected after the no-xattrs Mac archive.
  test -z "$(find "$PROOF_DIR" -type f -name '._*' -print -quit)"
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
# step: runbook-10
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-10: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  : "${KIND_LIST:?resolved item input missing}"
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  for KIND in "${KIND_ARRAY[@]}"; do
    if [ "$KIND" = edge ]; then RELEASE_DIR="$NEW_EDGE"; else RELEASE_DIR="$NEW_STACK"; fi
    test "$(cat "$RELEASE_DIR/RELEASE_SHA")" = "$SHA"
    test ! -e "$RELEASE_DIR/.git"
    test "$(stat -c '%U:%G' "$RELEASE_DIR")" = 'commonswarm:commonswarm'
    stat -c '%a %n' "$RELEASE_DIR"
    (cd "$RELEASE_DIR" && sha256sum --quiet --strict --check "$PROOF_DIR/${KIND}.SHA256SUMS")
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
`docs/evidence/<UTC-date>-release-<short-sha>/`, or into the `EVIDENCE_DIR`
that the window file names when the item plan set `EVIDENCE_ROOT`. CSwarmDevLead
reviews and commits that evidence afterwards, first copying an `EVIDENCE_ROOT`
directory into `docs/evidence/` on a repository branch; the evidence must
contain no secrets and no complete environment file. Use only the root-owned
`copy-back.list` created by
the section 1 preflight block. It includes itself and the applicable standard
evidence plus the exact item-specific paths from the box plan. Logs are never
copied because they may contain request data, except for the bounded outgoing
container logs that the edge and stack recreate steps append by exact name. If
the list is missing at copy-back time, stop and ask HezLead; do not reconstruct
it from the directory.
Before copying, remove any EMPTY `*.err` file in `$PROOF_DIR`
(for example an empty `functional.err`); a non-empty `.err` file is evidence:
the copy-back block appends its exact basename to the existing manifest and
copies it back. The window is closed by HezLead; Anvil runs copy-back
`runbook-11`, box cleanup `runbook-60`, proof closure `runbook-61`, and Mac
cleanup `runbook-12`, and reports each one.

An abort can come before `runbook-02` has written the window file. No box
release state exists then, so `runbook-11` says that no window file exists and
copies nothing, and `runbook-12` removes only the exact per-window scratch files
that the open receipt names. Both read that receipt only after the same
regular-file, non-symlink, mode-`0600` checks as `runbook-02`. `runbook-11`
takes the no-window-file path only when the box window input that `runbook-02`
writes right after the window file is also absent; when it is present the window
file was lost, and `runbook-11` stops so HezLead decides. Any abort after the
window file exists reads it as before.

```sh
# step: runbook-11
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-11: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  if [ ! -f "$HOME/.commonswarm-release-window.env" ]; then
    # runbook-02 writes the window file, then the box window input, and no box
    # release state exists before them. Only an open receipt with no box window
    # input proves the window stopped before runbook-02 finished; a box window
    # input without its window file is a lost window file, and the block stops.
    WINDOW_OPEN_RECEIPT="/tmp/commonswarm-release-open-${RELEASE_SHA}.env"
    test -f "$WINDOW_OPEN_RECEIPT"
    test ! -L "$WINDOW_OPEN_RECEIPT"
    test "$(stat -f %Lp "$WINDOW_OPEN_RECEIPT")" = 600
    . "$WINDOW_OPEN_RECEIPT"
    test "$SHA" = "$RELEASE_SHA"
    test ! -e "/tmp/commonswarm-${SHA}-${WINDOW_ID}.window.env"
    printf 'runbook-11: no window file and no box window input for %s; nothing to copy back\n' "$RELEASE_SHA"
    exit 0
  fi
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = "$RELEASE_SHA"
  test -d "$EVIDENCE_DIR"
  ssh ops@100.115.66.74 "sudo -n -i bash -s -- '$RELEASE_SHA'" <<'BOX' | COPYFILE_DISABLE=1 tar --no-xattrs -xf - -C "$EVIDENCE_DIR"
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-11: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  RELEASE_SHA="$1"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -f "$PROOF_DIR/copy-back.list"
  test "$(stat -c '%U:%G:%a' "$PROOF_DIR/copy-back.list")" = root:root:600
  grep -qFx 'copy-back.list' "$PROOF_DIR/copy-back.list"
  shopt -s nullglob
  for ERR_FILE in "$PROOF_DIR"/*.err; do
    ERR_NAME="${ERR_FILE##*/}"
    if [ ! -s "$ERR_FILE" ]; then
      rm -f -- "$ERR_FILE"
    elif ! grep -qFx "$ERR_NAME" "$PROOF_DIR/copy-back.list"; then
      printf '%s\n' "$ERR_NAME" >>"$PROOF_DIR/copy-back.list"
    fi
  done
  shopt -u nullglob
  test "$(stat -c '%U:%G:%a' "$PROOF_DIR/copy-back.list")" = root:root:600
  test -z "$(LC_ALL=C sort "$PROOF_DIR/copy-back.list" | uniq -d)"
  while IFS= read -r path || [ -n "$path" ]; do
    test -n "$path"
    while [[ "$path" == ./* ]]; do path="${path#./}"; done
    case "$path" in
      ''|/*|../*|*/../*|database/logs/*|*/database/logs/*|window.env|*/window.env) false ;;
      *.docker.log)
        LOG_CONTAINER="${path%%.*}"
        LOG_SHA="${path#*.}"
        LOG_SHA="${LOG_SHA%.docker.log}"
        case "$LOG_CONTAINER" in
          commonswarm-edge-edge-runtime-1|commonswarm-postgres|commonswarm-gotrue|commonswarm-postgrest|commonswarm-realtime|commonswarm-storage-api) ;;
          *) false ;;
        esac
        case "$LOG_SHA" in (*[!0-9a-f]*|'') false ;; esac
        test "${#LOG_SHA}" -eq 40
        ;;
      *.log) false ;;
    esac
    test -f "$PROOF_DIR/$path"
    if [[ "$path" == *.docker.log ]]; then
      test "$(stat -c '%U:%G:%a' "$PROOF_DIR/$path")" = root:root:600
      test "$(wc -c <"$PROOF_DIR/$path")" -le 10485760
    fi
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
# step: runbook-12
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-12: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  if [ -f "$HOME/.commonswarm-release-window.env" ]; then
    . "$HOME/.commonswarm-release-window.env"
  else
    # Stopped before runbook-02 finished: only the open receipt exists. It names
    # the same SHA and window ID, so the exact per-window scratch names follow.
    WINDOW_OPEN_RECEIPT="/tmp/commonswarm-release-open-${RELEASE_SHA}.env"
    test -f "$WINDOW_OPEN_RECEIPT"
    test ! -L "$WINDOW_OPEN_RECEIPT"
    test "$(stat -f %Lp "$WINDOW_OPEN_RECEIPT")" = 600
    . "$WINDOW_OPEN_RECEIPT"
    ARCHIVE="/tmp/commonswarm-${SHA}-${WINDOW_ID}.tar"
    BOX_WINDOW_INPUT="/tmp/commonswarm-${SHA}-${WINDOW_ID}.window.env"
  fi
  test "$SHA" = "$RELEASE_SHA"
  rm -f "$ARCHIVE" "$BOX_WINDOW_INPUT" "/tmp/commonswarm-release-proofs-${SHA}-${WINDOW_ID}.tar"
  rm -f "$HOME/.commonswarm-release-window.env"
)
```

### Abort cleanup — Anvil runs `runbook-13` on every stop, refusal, or abort

This is safe after a lost shell because it reads the durable state. It does not
hide the failing block's evidence. If the window stopped before
`1-apply-release-directories` created the proof directory, no timer has been
stopped: the block says there is no active proof directory and restores nothing.
A proof directory whose `window.env` is missing still stops the block.

```sh
# step: runbook-13
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-13: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  ACTIVE_PROOF="/home/commonswarm/stack/release-proofs/${RELEASE_SHA}"
  if [ ! -e "$ACTIVE_PROOF" ] && [ ! -L "$ACTIVE_PROOF" ]; then
    # 1-apply-release-directories creates the proof directory before any timer
    # stops, so a window with no proof directory has no timer to restart.
    printf 'runbook-13: no active proof directory for %s; no timer state to restore\n' "$RELEASE_SHA"
    exit 0
  fi
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i "s/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED='0'/" "$PROOF_DIR/window.env"
    printf '%s\n' 'abort cleanup restarted commonswarm-edge-recycle.timer' >>"$PROOF_DIR/box-run.log"
  fi
  if [ "$BACKUP_TIMERS_STOPPED" = 1 ]; then
    systemctl start commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
    systemctl list-timers --all commonswarm-postgres-backup.timer commonswarm-postgres-restore.timer
    sed -i "s/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED='0'/" "$PROOF_DIR/window.env"
    printf '%s\n' 'abort cleanup restarted backup/restore timers' >>"$PROOF_DIR/box-run.log"
  fi
)
```

## 2. One-time database release credential setup

### Preflight — HezLead

The current target-only source is `/etc/commonswarm-release/target.env`. It was
measured on the box as a root-owned mode-`0600` regular file. The historical
`/home/commonswarm/migration-direct.env` must never be read by a release. A
reviewed equivalent is acceptable only when the item plan names its absolute
path, verifies the same one-assignment contract and installs it through a
separately reviewed marked block before `runbook-14`.

### Apply — Anvil

Verify the existing target-only file in place. This block does not rewrite or
print it:

```sh
# step: runbook-14
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-14: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  TARGET_SOURCE=/etc/commonswarm-release/target.env
  test -f "$TARGET_SOURCE"
  test ! -L "$TARGET_SOURCE"
  test "$(stat -c '%U:%G:%a' "$TARGET_SOURCE")" = root:root:600
  python3 - <<'PY'
from pathlib import Path
src = Path('/etc/commonswarm-release/target.env')
lines = [line for line in src.read_text().splitlines()
         if line and not line.startswith('#')]
assert len(lines) == 1, 'expected exactly one non-comment assignment'
name, value = lines[0].split('=', 1)
assert name == 'TARGET_DATABASE_URL'
assert value and not value.startswith(('"', "'"))
print('target.env verified (value not shown)')
PY
)
```

### Verify — Anvil

This checks names and shape without printing the URL.

```sh
# step: runbook-15
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-15: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-16
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-16: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
root-only session helper survives a lost shell. In every database block, source
`window.env` first and the session helper second; never reverse or omit that
order. `release_psql_ro` forces catalog and functional proof calls into
read-only transactions with `PGOPTIONS`. Both helpers accept `--file` only with
the host `APPLY_SQL` path or a host file below `PROOF_DIR`; they map those paths
to `/run/commonswarm-release-apply.sql` or `/proof/...` themselves and refuse
all other file arguments.

```sh
# step: runbook-17
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-17: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  STACK_RELEASE="$NEW_STACK"
  MIGRATE="$STACK_RELEASE/deploy/supabase-stack/migrate"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  PGSERVICE_FILE="/run/commonswarm-release-${SHA}-service.conf"
  PGPASS_FILE="/run/commonswarm-release-${SHA}-pass"
  APPLY_SQL="/run/commonswarm-release-${SHA}-apply.sql"
  DB_SESSION="/run/commonswarm-release-${SHA}-session.sh"
  PSQL_IMAGE=public.ecr.aws/supabase/postgres:17.6.1.147
  PSQL_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$PSQL_IMAGE")"
  case "$PSQL_IMAGE_ID" in sha256:*) ;; *) false ;; esac
  case "${PSQL_IMAGE_ID#sha256:}" in ''|*[!0-9a-f]*) false ;; esac
  test "${#PSQL_IMAGE_ID}" -eq 71
  POSTGRES_CIDS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    test -n "$VALUE" && POSTGRES_CIDS[${#POSTGRES_CIDS[@]}]="$VALUE"
  done < <(docker ps -q \
    --filter label=com.docker.compose.project=commonswarm-supabase-stack \
    --filter label=com.docker.compose.service=postgres)
  test "${#POSTGRES_CIDS[@]}" -eq 1
  test "$(docker inspect --format '{{.Image}}' "${POSTGRES_CIDS[0]}")" = "$PSQL_IMAGE_ID"
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
PSQL_IMAGE='public.ecr.aws/supabase/postgres:17.6.1.147'

release_psql() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$APPLY_SQL") CONTAINER_FILE=/run/commonswarm-release-apply.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql: --file must name APPLY_SQL or a PROOF_DIR file' >&2; return 2 ;;
        esac
        PSQL_ARGS[${#PSQL_ARGS[@]}]=--file
        PSQL_ARGS[${#PSQL_ARGS[@]}]="$CONTAINER_FILE"
        shift 2
        ;;
      -f|-f?*|--file=*) printf '%s\n' 'release_psql: use separate --file and host path arguments' >&2; return 2 ;;
      *) PSQL_ARGS[${#PSQL_ARGS[@]}]="$1"; shift ;;
    esac
  done
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
    "$PSQL_IMAGE" \
    -X --set=ON_ERROR_STOP=1 "${PSQL_ARGS[@]}"
}

release_psql_ro() {
  PSQL_ARGS=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --file)
        test "$#" -ge 2
        case "$2" in
          "$APPLY_SQL") CONTAINER_FILE=/run/commonswarm-release-apply.sql ;;
          "$PROOF_DIR"/*)
            PROOF_RELATIVE=${2#"$PROOF_DIR"/}
            case "$PROOF_RELATIVE" in ''|/*|*'/../'*|../*|*/..|*'/./'*|./*|*/.|*'//'*) return 2 ;; esac
            CONTAINER_FILE="/proof/$PROOF_RELATIVE"
            ;;
          *) printf '%s\n' 'release_psql_ro: --file must name APPLY_SQL or a PROOF_DIR file' >&2; return 2 ;;
        esac
        PSQL_ARGS[${#PSQL_ARGS[@]}]=--file
        PSQL_ARGS[${#PSQL_ARGS[@]}]="$CONTAINER_FILE"
        shift 2
        ;;
      -f|-f?*|--file=*) printf '%s\n' 'release_psql_ro: use separate --file and host path arguments' >&2; return 2 ;;
      *) PSQL_ARGS[${#PSQL_ARGS[@]}]="$1"; shift ;;
    esac
  done
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
    "$PSQL_IMAGE" \
    -X --set=ON_ERROR_STOP=1 "${PSQL_ARGS[@]}"
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

### Preflight — CSwarmDevLead supplies `runbook-18`; Anvil runs it; HezLead approves

```sh
# step: runbook-18
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-18: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  release_psql_ro --file "$APPLY_SQL"

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
# step: runbook-19
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-19: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  release_psql --file "$APPLY_SQL"
)
```

The ledger insert and catalog proof are in one transaction. A duplicate version,
catalog mismatch, lock timeout, statement timeout, or unexpected required ledger
column rolls the transaction back.

### Verify — Anvil; HezLead reads before and after

```sh
# step: runbook-20
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-20: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  release_psql_ro --file "$APPLY_SQL"
)
```

The `after` file must contain exactly the two ordered versions. Keep both files
in the release evidence.

For a later backfill, CSwarmDevLead replaces the H0 verifier with that
version's reviewed catalog query and replaces the literal version list. The
same transaction must run the catalog proof before inserting the version, and
the before/after ledger output is mandatory. There is no generic “mark applied”
command.

### Rollback — explicit HezLead decision; Anvil executes the named forward correction

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
must be measured from the live catalog; do not infer object state from the filename. For the
transactional check, the file must end with its own `\gset` on the line after
a query selecting exactly one Boolean column aliased `catalog_ok`. The query
returns one row, whose unaligned value is `t` or `f`; the wrapper refuses every
value other than true. For example, a complete proof file is:

```text
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
# step: runbook-21
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-21: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  : "${BACKUP_MAX_AGE_SECONDS:?HezLead-approved backup age required}"
  case "$BACKUP_MAX_AGE_SECONDS" in ''|*[!0-9]*) false ;; esac
  test "$BACKUP_MAX_AGE_SECONDS" -gt 0
  BACKUP_STATUS=/var/backups/commonswarm-postgres/status.json
  BACKUP_WAIT_MAX_SECONDS=14400
  BACKUP_WAIT_DEADLINE=$(( $(date +%s) + BACKUP_WAIT_MAX_SECONDS ))
  while :; do
    BACKUP_STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    case "$BACKUP_STATE" in
      inactive|failed) break ;;
      active|activating|deactivating|reloading)
        BACKUP_WAIT_NOW="$(date +%s)"
        if (( BACKUP_WAIT_NOW >= BACKUP_WAIT_DEADLINE )); then
          printf 'STOP: backup service remained %s for %s seconds; ask HezLead.\n' \
            "$BACKUP_STATE" "$BACKUP_WAIT_MAX_SECONDS" >&2
          exit 1
        fi
        BACKUP_WAIT_SECONDS=5
        if (( BACKUP_WAIT_DEADLINE - BACKUP_WAIT_NOW < BACKUP_WAIT_SECONDS )); then
          BACKUP_WAIT_SECONDS=$(( BACKUP_WAIT_DEADLINE - BACKUP_WAIT_NOW ))
        fi
        sleep "$BACKUP_WAIT_SECONDS"
        ;;
      *) false ;;
    esac
  done
  test "$(systemctl show commonswarm-postgres-backup.service --property=Result --value)" = success
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
# step: runbook-22
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-22: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  BACKUP_WAIT_MAX_SECONDS=14400
  BACKUP_WAIT_DEADLINE=$(( $(date +%s) + BACKUP_WAIT_MAX_SECONDS ))
  systemctl start commonswarm-postgres-backup.service
  while :; do
    BACKUP_STATE="$(systemctl is-active commonswarm-postgres-backup.service || true)"
    case "$BACKUP_STATE" in
      inactive|failed) break ;;
      active|activating|deactivating|reloading)
        BACKUP_WAIT_NOW="$(date +%s)"
        if (( BACKUP_WAIT_NOW >= BACKUP_WAIT_DEADLINE )); then
          printf 'STOP: backup service remained %s for %s seconds; ask HezLead.\n' \
            "$BACKUP_STATE" "$BACKUP_WAIT_MAX_SECONDS" >&2
          exit 1
        fi
        BACKUP_WAIT_SECONDS=5
        if (( BACKUP_WAIT_DEADLINE - BACKUP_WAIT_NOW < BACKUP_WAIT_SECONDS )); then
          BACKUP_WAIT_SECONDS=$(( BACKUP_WAIT_DEADLINE - BACKUP_WAIT_NOW ))
        fi
        sleep "$BACKUP_WAIT_SECONDS"
        ;;
      *) false ;;
    esac
  done
  test "$(systemctl show commonswarm-postgres-backup.service -p Result --value)" = success
)
```

2. Enumerate the release files and record their checksums. Confirm the target
   identity before any database write.

```sh
# step: runbook-23
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-23: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-24
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-24: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-25
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-25: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-26
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-26: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  . "/run/commonswarm-release-${SHA}-session.sh"
  IFS= read -r VERSION <"$PROOF_DIR/pending-versions.txt" || [ -n "$VERSION" ]
  test "$(wc -l <"$PROOF_DIR/pending-versions.txt" | tr -d ' ')" -eq 1
  case "$VERSION" in (*[!0-9]*|'') false ;; esac
  test "${#VERSION}" -eq 14
  grep -Fx "$VERSION" "$PROOF_DIR/pending-versions.txt"
  MIGRATION_MATCHES=()
  while IFS= read -r MIGRATION_MATCH || [ -n "$MIGRATION_MATCH" ]; do
    test -n "$MIGRATION_MATCH" && MIGRATION_MATCHES[${#MIGRATION_MATCHES[@]}]="$MIGRATION_MATCH"
  done < <(
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
  CATALOG_BEFORE="$(release_psql_ro -Atq --file "$APPLY_SQL")"
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
# step: runbook-27
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-27: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  release_psql --file "$APPLY_SQL"
)
```

Read the exit code before continuing. Never batch two migration files into one
transaction: the repository's compatibility reasoning assumes one file per
transaction.

### Verify — Anvil; HezLead reads each result

```sh
# step: runbook-28
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-28: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  CATALOG_AFTER="$(release_psql_ro -Atq --file "$APPLY_SQL")"
  printf 'version=%s ledger=%s catalog=%s\n' "$VERSION" "$LEDGER_AFTER" "$CATALOG_AFTER" \
    | tee -a "$PROOF_DIR/migration-state-after.txt" | tee -a "$PROOF_DIR/box-run.log"
  test "$LEDGER_AFTER" = 1
  test "$CATALOG_AFTER" = t
  # These functional proofs need observations from the NEW edge. These
  # versions run after section 6 and their seeded command, never at this step.
  if [ "$VERSION" != 20260925000001 ] && [ "$VERSION" != 20260926000001 ] \
    && [ "$VERSION" != 20260927000001 ] && [ "$VERSION" != 20260927000002 ] \
    && [ "$VERSION" != 20260927000003 ]; then
    release_psql_ro --file "$PROOF_DIR/${VERSION}-functional.sql" \
      >"$PROOF_DIR/${VERSION}-functional.txt"
  fi
)
```

That last command passes the lead-supplied host file
`$PROOF_DIR/<version>-functional.sql`; the helper maps it to the `/proof`
read-only container mount. Complete one version before considering the next. After the last
migration, save the cron job names and compare both snapshots with `LC_ALL=C`
sorting. Set the two expected name lists from the reviewed release plan in
bytewise order (one
name per line; empty when none). The lead supplies both lists with the release; for H0 the new list was `swarm-purge-h0-poll-batches` and the removed list was empty.

```sh
# step: runbook-29
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-29: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  . "/run/commonswarm-release-${SHA}-session.sh"
  . "$PROOF_DIR/item-resolved-inputs.env"
  : "${EXPECTED_NEW_CRON_JOBS:?resolved item input missing}"
  : "${EXPECTED_REMOVED_CRON_JOBS:?resolved item input missing}"
  LIST_INPUT="$EXPECTED_NEW_CRON_JOBS"
  EXPECTED_NEW_CRON_JOB_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then EXPECTED_NEW_CRON_JOB_ARRAY[${#EXPECTED_NEW_CRON_JOB_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  LIST_INPUT="$EXPECTED_REMOVED_CRON_JOBS"
  EXPECTED_REMOVED_CRON_JOB_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then EXPECTED_REMOVED_CRON_JOB_ARRAY[${#EXPECTED_REMOVED_CRON_JOB_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test "$EXPECTED_NEW_CRON_JOBS" = none
  test "$EXPECTED_REMOVED_CRON_JOBS" = none
  test "${#EXPECTED_NEW_CRON_JOB_ARRAY[@]}" -eq 1
  test "${#EXPECTED_REMOVED_CRON_JOB_ARRAY[@]}" -eq 1
  test "${EXPECTED_NEW_CRON_JOB_ARRAY[0]}" = none
  test "${EXPECTED_REMOVED_CRON_JOB_ARRAY[0]}" = none
  EXPECTED_NEW_CRON_JOB_ARRAY=()
  EXPECTED_REMOVED_CRON_JOB_ARRAY=()
  release_psql_ro -Atq --command 'SELECT jobname FROM cron.job ORDER BY jobname;' \
    >"$PROOF_DIR/cron-after.txt"
  LC_ALL=C sort "$PROOF_DIR/cron-before.txt" >"$PROOF_DIR/cron-before-sorted.txt"
  LC_ALL=C sort "$PROOF_DIR/cron-after.txt" >"$PROOF_DIR/cron-after-sorted.txt"
  LC_ALL=C comm -13 "$PROOF_DIR/cron-before-sorted.txt" "$PROOF_DIR/cron-after-sorted.txt" \
    >"$PROOF_DIR/cron-added.txt"
  LC_ALL=C comm -23 "$PROOF_DIR/cron-before-sorted.txt" "$PROOF_DIR/cron-after-sorted.txt" \
    >"$PROOF_DIR/cron-removed.txt"
  test "$(cat "$PROOF_DIR/cron-added.txt")" = "${EXPECTED_NEW_CRON_JOB_ARRAY[*]-}"
  test "$(cat "$PROOF_DIR/cron-removed.txt")" = "${EXPECTED_REMOVED_CRON_JOB_ARRAY[*]-}"
)
```

### Rollback — explicit HezLead decision; Anvil executes the named migration correction

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

### Preflight — CSwarmDevLead supplies probes; Anvil runs `runbook-30`; HezLead approves

`commonswarm-edge-recycle.timer` is a box-only unit (not in this repository),
installed by HezLead on 2026-09-22: `OnCalendar=*-*-* 03,09,15,21:30:00 UTC`,
`Persistent=false`; its service runs `docker restart --time 30
commonswarm-edge-edge-runtime-1`. Check it with `systemctl cat
commonswarm-edge-recycle.timer` before the window. The block below reads the
approved UTC start and end saved in `window.env`. Only if the window overlaps
the ten minutes on either side of 03:30, 09:30, 15:30, or 21:30 UTC, stop the
timer and start it after verification.

```sh
# step: runbook-30
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-30: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  for T in "$WINDOW_START_UTC" "$WINDOW_END_UTC"; do
    case "$T" in
      [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;;
      *) false ;;
    esac
  done
  START_EPOCH="$(date -u -d "$WINDOW_START_UTC" +%s)"
  END_EPOCH="$(date -u -d "$WINDOW_END_UTC" +%s)"
  NOW_EPOCH="$(date -u +%s)"
  test "$START_EPOCH" -le "$END_EPOCH"
  test "$START_EPOCH" -le "$NOW_EPOCH"
  test "$NOW_EPOCH" -le "$END_EPOCH"
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
    sed -i "s/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED='1'/" "$PROOF_DIR/window.env"
    systemctl stop commonswarm-edge-recycle.timer
    printf '%s\n' 'release window stopped commonswarm-edge-recycle.timer' >>"$PROOF_DIR/box-run.log"
  fi
)
```

Run that block for every window; it records a stopped timer only when the
approved times overlap a protected interval.

```sh
# step: runbook-31
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-31: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -n "$PREVIOUS_EDGE"
  test -f "$NEW_EDGE/deploy/edge-runtime/compose.yaml"
  test -f "$NEW_EDGE/deploy/edge-runtime/main/router.ts"

  # Prove the archive-derived manifest before adding the box-only override.
  (cd "$NEW_EDGE" && sha256sum --quiet --strict --check "$PROOF_DIR/edge.SHA256SUMS")

  # Observed by HezLead on 2026-09-22: the override lives in the current
  # edge release, whose container mounts use its exact release directory path.
  test -f "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml"
  cp -a "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" \
    "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  chown commonswarm:commonswarm "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml"
  OVERRIDE_SHA256="$(sha256sum "$PREVIOUS_EDGE/deploy/edge-runtime/compose.override.yaml" | awk '{print $1}')"
  test "$(sha256sum "$NEW_EDGE/deploy/edge-runtime/compose.override.yaml" | awk '{print $1}')" = "$OVERRIDE_SHA256"
  BOX_ONLY_LINE="deploy/edge-runtime/compose.override.yaml sha256=${OVERRIDE_SHA256} accepted known box-only file"
  if ! grep -qFx "$BOX_ONLY_LINE" "$PROOF_DIR/known-box-only-files.txt"; then
    printf '%s\n' "$BOX_ONLY_LINE" >>"$PROOF_DIR/known-box-only-files.txt"
  fi
  (cd "$NEW_EDGE" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) \
    >"$PROOF_DIR/edge-with-override.SHA256SUMS"
  chmod 0600 "$PROOF_DIR/edge-with-override.SHA256SUMS"
  (cd "$NEW_EDGE" && sha256sum --quiet --strict --check "$PROOF_DIR/edge-with-override.SHA256SUMS")

  python3 - "$PROOF_DIR/required-edge-env.json" /home/commonswarm/.env <<'PY'
import json, pathlib, pwd, stat, sys

inventory = json.load(open(sys.argv[1]))
required = set(inventory['required'])
optional = set(inventory['optional'])
database_alias = 'SWARM_DATABASE_URL|SUPABASE_DB_URL'
assert database_alias in required
assert not (required & optional)
env_path = pathlib.Path(sys.argv[2])
env_stat = env_path.stat()
assert stat.S_ISREG(env_stat.st_mode), 'edge environment must be a regular file'
assert stat.S_IMODE(env_stat.st_mode) == 0o600, 'edge environment must be mode 0600'
assert pwd.getpwuid(env_stat.st_uid).pw_name in {'root', 'commonswarm'}, \
    'edge environment owner must be root or commonswarm'
values = {}
for raw in env_path.open():
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
# step: runbook-32
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-32: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -n "$PREVIOUS_EDGE"

  save_outgoing_container_logs() {
    CONTAINER_NAME="$1"
    RELEASE_DIR="$2"
    LOG_MAX_BYTES=10485760
    OUTGOING_SHA="$(cat "$RELEASE_DIR/RELEASE_SHA")"
    case "$OUTGOING_SHA" in (*[!0-9a-f]*|'') false ;; esac
    test "${#OUTGOING_SHA}" -eq 40
    LOG_NAME="${CONTAINER_NAME}.${OUTGOING_SHA}.docker.log"
    LOG_PATH="$PROOF_DIR/$LOG_NAME"
    install -m 0600 -o root -g root /dev/null "$LOG_PATH"
    { docker logs --timestamps "$CONTAINER_NAME" 2>&1 || true; } \
      | tail -c "$LOG_MAX_BYTES" >"$LOG_PATH"
    chmod 0600 "$LOG_PATH"
    test "$(stat -c '%U:%G:%a' "$LOG_PATH")" = root:root:600
    test "$(wc -c <"$LOG_PATH")" -le "$LOG_MAX_BYTES"
    if ! grep -qFx "$LOG_NAME" "$PROOF_DIR/copy-back.list"; then
      printf '%s\n' "$LOG_NAME" >>"$PROOF_DIR/copy-back.list"
    fi
  }

  save_outgoing_container_logs commonswarm-edge-edge-runtime-1 "$PREVIOUS_EDGE"
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
# step: runbook-33
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-33: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
  ( umask 077; date -u +%Y-%m-%dT%H:%M:%SZ >"$PROOF_DIR/edge-probe-start.txt" )
  chmod 0600 "$PROOF_DIR/edge-probe-start.txt"
)
```

On the box, run the lead-supplied loopback probes for every changed function, plus the
existing positive controls from `deploy/edge-runtime/RUNBOOK.md`: H0 document,
malformed command, authenticated read, unauthenticated activity, capability,
unknown function, and preflight. If no smoke credential is provisioned on the box,
record the authenticated read as NOT VERIFIED in `run.log` and tell HezLead, who decides
whether that blocks the window (it did not for H0 on 2026-09-23). Without that
read, no probe reaches the database, so the edge-to-database path and the later
`CONNECT_TIMEOUT` log check are NOT VERIFIED too, unless the lead supplies a
credential-free database probe: `h0/note` with a well-formed but unknown
`Authorization: Bearer swm_agt_` followed by 43 base64url characters that match no
real token (for example 43 times `A`; do not use `+`, `/` or `=`, which are refused
before any database work) must return 401 after the token
lookup in `swarm.agent_tokens`. Record which of the two applied in `run.log`. Also probe `/functions/v1/h0/note`
without authorization using a valid note body: it must return 401, never 500
`h0_command_not_configured`. The authenticated read and H0 document are
positive controls in the same probe run. Run this H0 note loopback probe on
the box:

```sh
# step: runbook-34
# readonly: probe
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-34: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  HEADERS="$PROOF_DIR/h0-note-unauth.headers"
  STATUS="$(curl -sS -D "$HEADERS" -o "$PROOF_DIR/h0-note-unauth.json" -w '%{http_code}' \
    -H 'content-type: application/json' --data-binary '{"body":"release probe"}' \
    http://127.0.0.1:9000/functions/v1/h0/note)"
  python3 - "$STATUS" "$HEADERS" "$PROOF_DIR/h0-note-unauth.json" \
    >"$PROOF_DIR/h0-note-unauth-result.json" <<'PY'
import json, pathlib, sys
status, header_path, body_path = sys.argv[1:]
headers = {}
for raw in pathlib.Path(header_path).read_text(errors="replace").splitlines():
    if ":" in raw:
        name, value = raw.split(":", 1)
        if name.lower() in ("server", "cf-ray", "content-type"):
            headers[name.lower()] = value.strip()
body = pathlib.Path(body_path).read_bytes()
media = headers.get("content-type", "").split(";", 1)[0].strip().lower()
record = {"pass": status == "401", "status": int(status), "headers": headers}
if media != "application/json":
    record["body_prefix"] = body[:2048].decode("utf-8", "replace")
print(json.dumps(record, indent=2))
if status != "401": raise SystemExit(1)
PY
  test "$STATUS" = 401
  rm -f "$HEADERS"
)
```

Put authorization in a root-owned mode-`0600` curl config file and remove it
after use. Repeat changed-function probes through
`edge-staging.commonswarm.com` **from the Mac mini**, with explicit recorded
`User-Agent: commonswarm-release-probe/1.0`, and retain status, `Server`,
`CF-Ray`, `Content-Type`, and safe bounded failure-body evidence in
`EVIDENCE_DIR`. Cloudflare returns 1010 for Python urllib's default User-Agent;
classify that response as `cloudflare_challenge` and do not
run staging probes there. Staging is production-backed. Only after
both loopback and staging probes finish, capture the log window that began at
`edge-probe-start.txt` and reject `CONNECT_TIMEOUT` or
`h0 command configuration missing`:

```sh
# step: runbook-35
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-35: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  docker logs --since "$(cat "$PROOF_DIR/edge-probe-start.txt")" commonswarm-edge-edge-runtime-1 \
    >"$PROOF_DIR/edge-probe-window.log" 2>&1
  if grep -qE 'CONNECT_TIMEOUT|h0 command configuration missing' "$PROOF_DIR/edge-probe-window.log"; then false; fi
)
```

The log is box-only and must not appear in `copy-back.list`.

For migration `20260925000001`, run its functional proof only after this edge
release is verified. Anvil does NOT seed on the box. After HezLead reports "edge
switched and healthy", CSwarmDevLead runs
`deploy/release-proofs/item-g/g-seed.sh <bundle> <seed-dir> https://api.commonswarm.com <workspace-id>`
from the Mac mini with the two seats minted for the window (see the item's box plan,
`docs/evidence/2026-09-25-item-g-lane1/BOX-SECTION6.md` rows 3-6) and sends
HezLead `SEED_NOTE_ID=<uuid>` or the STOP line. HezLead passes the id to Anvil.
Anvil runs `runbook-36` and saves its proof output as section 5 does:

```sh
# step: runbook-36
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-36: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  SEED_NOTE_ID='<uuid-from-HezLead>'
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -v item_g_seed_signal_id="$SEED_NOTE_ID" \
    --file "$PROOF_DIR/20260925000001-functional.sql" \
    >"$PROOF_DIR/20260925000001-functional.txt"
)
```

A missing seed is a failed proof. Do not run this proof in section 5's pre-edge
Verify step.

For migration `20260926000001`, run the item G lane 2b renew gate after the new
edge is healthy. The lead sends HezLead `G2B_PRINCIPAL_ID=<uuid>` and the time
of the last successful renew. Within three minutes of that renew, Anvil runs
`runbook-37`:

```sh
# step: runbook-37
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-37: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  G2B_PRINCIPAL_ID='<uuid-from-the-renew-gate>'
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -v item_g2b_principal_id="$G2B_PRINCIPAL_ID" \
    --file "$PROOF_DIR/20260926000001-functional.sql" \
    >"$PROOF_DIR/20260926000001-functional.txt"
)
```

The proof must exit zero before the lead releases the gate's lease. Do not run
this proof in section 5's pre-edge Verify step.

For migration `20260927000001`, use the new edge to create one human-authored
signal and one private reply with a status. Record the workspace, signal,
reply, and author user ids, then run:

```sh
# step: runbook-38
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-38: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  ITEM_G3C_WORKSPACE_ID='<workspace-uuid>'
  ITEM_G3C_SIGNAL_ID='<signal-uuid>'
  ITEM_G3C_REPLY_ID='<reply-uuid>'
  ITEM_G3C_AUTHOR_USER_ID='<author-user-uuid>'
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -v item_g3c_workspace_id="$ITEM_G3C_WORKSPACE_ID" \
    -v item_g3c_signal_id="$ITEM_G3C_SIGNAL_ID" \
    -v item_g3c_reply_id="$ITEM_G3C_REPLY_ID" \
    -v item_g3c_author_user_id="$ITEM_G3C_AUTHOR_USER_ID" \
    --file "$PROOF_DIR/20260927000001-functional.sql" \
    >"$PROOF_DIR/20260927000001-functional.txt"
  test "$(cat "$PROOF_DIR/20260927000001-functional.txt")" = t
)
```

This proof never runs from section 5's automatic functional-proof step. A
missing id, invisible reply, or reply without a status fails the proof.

For migration `20260927000002`, use a dedicated live agent seat to make one
successful routed command through the new edge (`claim_wake_lease`,
`renew_wake_lease`, routed `claim_agent_inbox`, or `touch_presence`). Keep its
credential in a root-owned file and do not put it in arguments or logs. Then run
the functional proof exactly as follows; it uses session-level settings and no
outer transaction:

```sh
# step: runbook-39
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-39: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  ITEM_G3D_PRINCIPAL_ID='<principal-uuid>'
  ITEM_G3D_WORKSPACE_ID='<workspace-uuid>'
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -v item_g3d_principal_id="$ITEM_G3D_PRINCIPAL_ID" \
    -v item_g3d_workspace_id="$ITEM_G3D_WORKSPACE_ID" \
    --file "$PROOF_DIR/20260927000002-functional.sql" \
    >"$PROOF_DIR/20260927000002-functional.txt"
  test "$(cat "$PROOF_DIR/20260927000002-functional.txt")" = t
)
```

This proof never runs from section 5's automatic functional-proof step. A
missing variable, a wrong seat/workspace pair, or no route timestamp from the
last three minutes fails the proof.

For migration `20260927000003`, use dedicated live seats to create a root ask,
its child, and that child's child through the new command edge. Record the
workspace, all three signal ids, and a member user who owns one of the seats.
Then run the functional proof exactly as follows; it uses session-level
settings, performs only reads, and has no outer transaction:

```sh
# step: runbook-40
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-40: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  ITEM_T3_WORKSPACE_ID='<workspace-uuid>'
  ITEM_T3_ROOT_SIGNAL_ID='<root-signal-uuid>'
  ITEM_T3_HOP1_SIGNAL_ID='<first-child-signal-uuid>'
  ITEM_T3_HOP2_SIGNAL_ID='<second-child-signal-uuid>'
  ITEM_T3_READER_USER_ID='<reader-user-uuid>'
  . /home/commonswarm/stack/release-proofs/<sha>/window.env
  . "/run/commonswarm-release-${SHA}-session.sh"
  release_psql_ro -v item_t3_workspace_id="$ITEM_T3_WORKSPACE_ID" \
    -v item_t3_root_signal_id="$ITEM_T3_ROOT_SIGNAL_ID" \
    -v item_t3_hop1_signal_id="$ITEM_T3_HOP1_SIGNAL_ID" \
    -v item_t3_hop2_signal_id="$ITEM_T3_HOP2_SIGNAL_ID" \
    -v item_t3_reader_user_id="$ITEM_T3_READER_USER_ID" \
    --file "$PROOF_DIR/20260927000003-functional.sql" \
    >"$PROOF_DIR/20260927000003-functional.txt"
  test "$(cat "$PROOF_DIR/20260927000003-functional.txt")" = t
)
```

This proof never runs from section 5's automatic functional-proof step. A
missing value, a row outside the named workspace, a broken chain, or a reader
who cannot see all three asks fails the proof.

If the recycle timer was stopped, restart and verify it before closing a
successful release:

```sh
# step: runbook-41
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-41: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i "s/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED='0'/" "$PROOF_DIR/window.env"
  fi
)
```

### Rollback — Anvil at HezLead's direction

```sh
# step: runbook-42
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-42: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  test -n "$PREVIOUS_EDGE"

  save_outgoing_container_logs() {
    CONTAINER_NAME="$1"
    RELEASE_DIR="$2"
    LOG_MAX_BYTES=10485760
    OUTGOING_SHA="$(cat "$RELEASE_DIR/RELEASE_SHA")"
    case "$OUTGOING_SHA" in (*[!0-9a-f]*|'') false ;; esac
    test "${#OUTGOING_SHA}" -eq 40
    LOG_NAME="${CONTAINER_NAME}.${OUTGOING_SHA}.docker.log"
    LOG_PATH="$PROOF_DIR/$LOG_NAME"
    install -m 0600 -o root -g root /dev/null "$LOG_PATH"
    { docker logs --timestamps "$CONTAINER_NAME" 2>&1 || true; } \
      | tail -c "$LOG_MAX_BYTES" >"$LOG_PATH"
    chmod 0600 "$LOG_PATH"
    test "$(stat -c '%U:%G:%a' "$LOG_PATH")" = root:root:600
    test "$(wc -c <"$LOG_PATH")" -le "$LOG_MAX_BYTES"
    if ! grep -qFx "$LOG_NAME" "$PROOF_DIR/copy-back.list"; then
      printf '%s\n' "$LOG_NAME" >>"$PROOF_DIR/copy-back.list"
    fi
  }

  OUTGOING_EDGE="$(readlink -f /home/commonswarm/edge/current)"
  test -n "$OUTGOING_EDGE"
  save_outgoing_container_logs commonswarm-edge-edge-runtime-1 "$OUTGOING_EDGE"
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
# step: runbook-43
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-43: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  if [ "$RECYCLE_TIMER_STOPPED" = 1 ]; then
    systemctl start commonswarm-edge-recycle.timer
    systemctl list-timers commonswarm-edge-recycle.timer
    sed -i "s/^RECYCLE_TIMER_STOPPED=.*/RECYCLE_TIMER_STOPPED='0'/" "$PROOF_DIR/window.env"
  fi
)
```

### Record a published npm client build — Anvil; HezLead approves

Only after the npm package for this exact release SHA has been published and
that publication is recorded in the release evidence, generate the database
statement from the Git object on the Mac mini. No operator types a version:

```sh
# step: runbook-44
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-44: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "$HOME/.commonswarm-release-window.env"
  test "$SHA" = "$RELEASE_SHA"
  scripts/current-client-build-sql.sh "$SHA" \
    >"$EVIDENCE_DIR/current-client-build.sql"
  chmod 0600 "$EVIDENCE_DIR/current-client-build.sql"
)
```

Repeat section 1's proof-list review and transfer for that reviewed SQL file;
do not copy it around the review. On the box, confirm the target identity as in
section 5 and apply the statement only through the write helper:

```sh
# step: runbook-45
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-45: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  . "/run/commonswarm-release-${SHA}-session.sh"
  COMMONSWARM_MIGRATION_ENV_FILE=/etc/commonswarm-release/target.env \
    "$MIGRATE/run-db-tool.sh" assert-database-identity.sh "$PROOF_DIR/database" target
  release_psql --file "$PROOF_DIR/current-client-build.sql"
)
```

Do not run this step for an unpublished package. A server or site release alone
does not change `current_client_build`.

OAuth service release: written with HM lane 6's box plan, when the service exists.

## 7. Stack or edge image pin bump

### Preflight — Anvil; HezLead approves; Tom additionally approves PostgreSQL

Identify the changed service from the reviewed compose diff. Stack service names
are `postgres`, `gotrue`, `postgrest`, `realtime`, and `storage-api`; edge uses
`edge-runtime`. A PostgreSQL image change requires a fresh verified backup from
section 5 and Tom's explicit approval before pull or recreate.

A stack-only image release uses section 1 with `KIND_LIST='stack'` and explicit
`NO_MIGRATIONS=yes` with both version lists empty; `runbook-04` reports "not
applicable" and the proof list omits the edge environment files.

```sh
# step: runbook-46
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-46: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  test -n "$PREVIOUS_STACK"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" config -q
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" pull '<stack-service>'
)
```

For an edge image bump, first carry and validate the box override as in section
6, then pull with:

```sh
# step: runbook-47
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-47: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-48
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-48: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  UNITS_BEFORE="$PROOF_DIR/units-before"
  STACK_SWITCH_DIRECTION='<apply-or-rollback>'
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

  sed -i "s/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED='1'/" "$PROOF_DIR/window.env"
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
  sed -i "s/^BACKUP_TIMERS_STOPPED=.*/BACKUP_TIMERS_STOPPED='0'/" "$PROOF_DIR/window.env"
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
# step: runbook-49
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-49: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  STACK_SERVICE='<stack-service>'
  case "$STACK_SERVICE" in
    postgres) STACK_CONTAINER=commonswarm-postgres ;;
    gotrue) STACK_CONTAINER=commonswarm-gotrue ;;
    postgrest) STACK_CONTAINER=commonswarm-postgrest ;;
    realtime) STACK_CONTAINER=commonswarm-realtime ;;
    storage-api) STACK_CONTAINER=commonswarm-storage-api ;;
    *) false ;;
  esac
  test "$(readlink -f /home/commonswarm/stack/current)" = "$NEW_STACK"

  save_outgoing_container_logs() {
    CONTAINER_NAME="$1"
    RELEASE_DIR="$2"
    LOG_MAX_BYTES=10485760
    OUTGOING_SHA="$(cat "$RELEASE_DIR/RELEASE_SHA")"
    case "$OUTGOING_SHA" in (*[!0-9a-f]*|'') false ;; esac
    test "${#OUTGOING_SHA}" -eq 40
    LOG_NAME="${CONTAINER_NAME}.${OUTGOING_SHA}.docker.log"
    LOG_PATH="$PROOF_DIR/$LOG_NAME"
    install -m 0600 -o root -g root /dev/null "$LOG_PATH"
    { docker logs --timestamps "$CONTAINER_NAME" 2>&1 || true; } \
      | tail -c "$LOG_MAX_BYTES" >"$LOG_PATH"
    chmod 0600 "$LOG_PATH"
    test "$(stat -c '%U:%G:%a' "$LOG_PATH")" = root:root:600
    test "$(wc -c <"$LOG_PATH")" -le "$LOG_MAX_BYTES"
    if ! grep -qFx "$LOG_NAME" "$PROOF_DIR/copy-back.list"; then
      printf '%s\n' "$LOG_NAME" >>"$PROOF_DIR/copy-back.list"
    fi
  }

  save_outgoing_container_logs "$STACK_CONTAINER" "$PREVIOUS_STACK"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" \
    up -d --no-deps "$STACK_SERVICE"
)
```

### Verify — Anvil; HezLead reads before the next service

```sh
# step: runbook-50
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-50: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  STACK_PROJECT="$NEW_STACK/deploy/supabase-stack"
  docker compose -p commonswarm-supabase-stack --project-directory "$STACK_PROJECT" ps '<stack-service>'
  test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' '<container-name>')" = healthy
  docker logs --since 60s '<container-name>'
)
```

Require `healthy`, no new boot/database error, and the lead-supplied service
probe. Established container names are `commonswarm-postgres`,
`commonswarm-gotrue`, `commonswarm-postgrest`, `commonswarm-realtime`, and
`commonswarm-storage-api`. Also run these established loopback checks where
applicable:

```sh
# step: runbook-51
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-51: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-52
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-52: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-53
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-53: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  STACK_SERVICE='<stack-service>'
  case "$STACK_SERVICE" in
    postgres) STACK_CONTAINER=commonswarm-postgres ;;
    gotrue) STACK_CONTAINER=commonswarm-gotrue ;;
    postgrest) STACK_CONTAINER=commonswarm-postgrest ;;
    realtime) STACK_CONTAINER=commonswarm-realtime ;;
    storage-api) STACK_CONTAINER=commonswarm-storage-api ;;
    *) false ;;
  esac
  test -n "$PREVIOUS_STACK"
  test "$(readlink -f /home/commonswarm/stack/current)" = "$PREVIOUS_STACK"

  save_outgoing_container_logs() {
    CONTAINER_NAME="$1"
    RELEASE_DIR="$2"
    LOG_MAX_BYTES=10485760
    OUTGOING_SHA="$(cat "$RELEASE_DIR/RELEASE_SHA")"
    case "$OUTGOING_SHA" in (*[!0-9a-f]*|'') false ;; esac
    test "${#OUTGOING_SHA}" -eq 40
    LOG_NAME="${CONTAINER_NAME}.${OUTGOING_SHA}.docker.log"
    LOG_PATH="$PROOF_DIR/$LOG_NAME"
    install -m 0600 -o root -g root /dev/null "$LOG_PATH"
    { docker logs --timestamps "$CONTAINER_NAME" 2>&1 || true; } \
      | tail -c "$LOG_MAX_BYTES" >"$LOG_PATH"
    chmod 0600 "$LOG_PATH"
    test "$(stat -c '%U:%G:%a' "$LOG_PATH")" = root:root:600
    test "$(wc -c <"$LOG_PATH")" -le "$LOG_MAX_BYTES"
    if ! grep -qFx "$LOG_NAME" "$PROOF_DIR/copy-back.list"; then
      printf '%s\n' "$LOG_NAME" >>"$PROOF_DIR/copy-back.list"
    fi
  }

  save_outgoing_container_logs "$STACK_CONTAINER" "$NEW_STACK"
  docker compose -p commonswarm-supabase-stack \
    --project-directory "$PREVIOUS_STACK/deploy/supabase-stack" \
    up -d --no-deps "$STACK_SERVICE"
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
# step: runbook-54
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-54: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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
# step: runbook-55
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-55: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
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

## 9. Caddy site releases

### API pair

The API Caddy surface is always two files. The repository source pair maps to
the box pair as follows:

| Mode | `/etc/caddy/sites/10-commonswarm-api.caddy` | `/etc/caddy/sites/11-commonswarm-edge-staging.caddy` |
|---|---|---|
| live | `commonswarm-api.caddy` | `commonswarm-edge-staging.caddy` |
| maintenance | `commonswarm-api-maintenance.caddy` | `commonswarm-edge-staging-maintenance.caddy` |

Never install or restore one member without the other. A pair change performs
one validation after both files are on disk and one reload after validation.
The access-log directory already exists on the box; these steps do not change
its owner or mode. Before validation, derive log files from the exact installed
site files, refuse paths outside `/var/log/caddy/`, and create or repair each
regular log file as `caddy:caddy` mode `0600` without replacing existing
content.

### Preflight — Anvil; HezLead approves

Set `API_CADDY_PAIR=yes` in section 1's copy-back manifest. This release uses a
stack archive because the source files live under `deploy/supabase-stack/`.
The preflight saves both installed files and rejects drift in either one. For
the first release of the split, it derives both expected installed files from
the previous combined source by changing only its site-label line. Later
releases compare each installed file to its own previous-release source.

```sh
# step: runbook-56
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-56: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  : "${KIND_LIST:?resolved item input missing}"
  LIST_INPUT="$KIND_LIST"
  KIND_ARRAY=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    if [ -n "$VALUE" ]; then KIND_ARRAY[${#KIND_ARRAY[@]}]="$VALUE"; fi
  done < <(printf '%s\n' "$LIST_INPUT" | tr ' \t' '\n')
  test -n "${KIND_ARRAY[*]:-}"
  case " ${KIND_ARRAY[*]} " in *' stack '*) ;; *) false ;; esac
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  SITE_DIR=/etc/caddy/sites
  API_SITE="$SITE_DIR/10-commonswarm-api.caddy"
  STAGING_SITE="$SITE_DIR/11-commonswarm-edge-staging.caddy"
  API_BEFORE="$PROOF_DIR/caddy-before-10-commonswarm-api.caddy"
  STAGING_BEFORE="$PROOF_DIR/caddy-before-11-commonswarm-edge-staging.caddy"
  DRIFT_PROOF="$PROOF_DIR/caddy-drift-check.txt"
  test -f "$API_SITE"
  test -f "$STAGING_SITE"
  install -m 0600 -o root -g root "$API_SITE" "$API_BEFORE"
  install -m 0600 -o root -g root "$STAGING_SITE" "$STAGING_BEFORE"

  if [ -f "$PREVIOUS_STACK/deploy/supabase-stack/commonswarm-edge-staging.caddy" ]; then
    cmp -s "$PREVIOUS_STACK/deploy/supabase-stack/commonswarm-api.caddy" "$API_SITE"
    cmp -s "$PREVIOUS_STACK/deploy/supabase-stack/commonswarm-edge-staging.caddy" "$STAGING_SITE"
  else
    COMBINED="$PREVIOUS_STACK/deploy/supabase-stack/commonswarm-api.caddy"
    test "$(grep -c '^api\.commonswarm\.com, edge-staging\.commonswarm\.com {$' "$COMBINED")" -eq 1
    DRIFT_DIR="$(mktemp -d /tmp/commonswarm-caddy-drift.XXXXXX)"
    case "$DRIFT_DIR" in /tmp/commonswarm-caddy-drift.??????) ;; *) false ;; esac
    trap 'status=$?; find "$DRIFT_DIR" -depth -delete; exit "$status"' EXIT
    sed 's/^api\.commonswarm\.com, edge-staging\.commonswarm\.com {$/api.commonswarm.com {/' \
      "$COMBINED" >"$DRIFT_DIR/10-commonswarm-api.caddy"
    sed 's/^api\.commonswarm\.com, edge-staging\.commonswarm\.com {$/edge-staging.commonswarm.com {/' \
      "$COMBINED" >"$DRIFT_DIR/11-commonswarm-edge-staging.caddy"
    cmp -s "$DRIFT_DIR/10-commonswarm-api.caddy" "$API_SITE"
    cmp -s "$DRIFT_DIR/11-commonswarm-edge-staging.caddy" "$STAGING_SITE"
  fi
  install -m 0600 -o root -g root /dev/null "$DRIFT_PROOF"
  printf '%s\n' \
    '10-commonswarm-api.caddy: PASS' \
    '11-commonswarm-edge-staging.caddy: PASS' >"$DRIFT_PROOF"
)
```

Both `cmp` calls are required. A difference is a stop for HezLead to reconcile;
do not overwrite unexplained box state.

### Apply — Anvil

Set `CADDY_MODE` to the approved `live` or `maintenance` state. The two
candidate files are copied to non-imported temporary names, moved into place as
a pair, validated once, and reloaded once. If validation or reload fails, stop
and run the rollback block; Caddy keeps serving its last successfully loaded
configuration until that rollback completes.

```sh
# step: runbook-57
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-57: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  CADDY_MODE='<live-or-maintenance>'
  case "$CADDY_MODE" in
    live)
      API_SOURCE="$NEW_STACK/deploy/supabase-stack/commonswarm-api.caddy"
      STAGING_SOURCE="$NEW_STACK/deploy/supabase-stack/commonswarm-edge-staging.caddy"
      ;;
    maintenance)
      API_SOURCE="$NEW_STACK/deploy/supabase-stack/commonswarm-api-maintenance.caddy"
      STAGING_SOURCE="$NEW_STACK/deploy/supabase-stack/commonswarm-edge-staging-maintenance.caddy"
      ;;
    *) false ;;
  esac
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  SITE_DIR=/etc/caddy/sites
  API_SITE="$SITE_DIR/10-commonswarm-api.caddy"
  STAGING_SITE="$SITE_DIR/11-commonswarm-edge-staging.caddy"
  API_TEMP="$SITE_DIR/.10-commonswarm-api.${SHA}.candidate"
  STAGING_TEMP="$SITE_DIR/.11-commonswarm-edge-staging.${SHA}.candidate"
  CADDY_LOG_EVIDENCE="$PROOF_DIR/caddy-log-files.txt"
  check_caddy_access_log_path() {
    local CADDY_LOG_PATH=$1
    local CADDY_LOG_REAL
    case "$CADDY_LOG_PATH" in /var/log/caddy/?*) ;; *) false ;; esac
    case "$CADDY_LOG_PATH" in
      *'/../'*|*/..|*'/./'*|*/.|*'//'*) false ;;
    esac
    CADDY_LOG_REAL=$(realpath -m -- "$CADDY_LOG_PATH")
    test "$CADDY_LOG_REAL" = "$CADDY_LOG_PATH"
  }
  record_caddy_access_logs() {
    local CADDY_LOG_STAGE=$1
    local CADDY_LOG_EVIDENCE=$2
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift 2
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        test ! -L "$CADDY_LOG_PATH"
        test -f "$CADDY_LOG_PATH"
        test "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" = caddy:caddy
        test "$(stat -c '%a' "$CADDY_LOG_PATH")" = 600
        printf '%s %s owner=%s mode=%s\n' \
          "$CADDY_LOG_STAGE" "$CADDY_LOG_PATH" \
          "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" \
          "$(stat -c '%a' "$CADDY_LOG_PATH")" >>"$CADDY_LOG_EVIDENCE"
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
  }
  prepare_caddy_access_logs() {
    local CADDY_LOG_EVIDENCE=$1
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        if [ -L "$CADDY_LOG_PATH" ]; then
          false
        elif [ -e "$CADDY_LOG_PATH" ]; then
          test -f "$CADDY_LOG_PATH"
          chown caddy:caddy "$CADDY_LOG_PATH"
          chmod 0600 "$CADDY_LOG_PATH"
        else
          install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG_PATH"
        fi
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
    record_caddy_access_logs before-validate "$CADDY_LOG_EVIDENCE" "$@"
  }
  cmp -s "$PROOF_DIR/caddy-before-10-commonswarm-api.caddy" "$API_SITE"
  cmp -s "$PROOF_DIR/caddy-before-11-commonswarm-edge-staging.caddy" "$STAGING_SITE"
  test "$(grep -c '^api\.commonswarm\.com {$' "$API_SOURCE")" -eq 1
  test "$(grep -c '^edge-staging\.commonswarm\.com {$' "$STAGING_SOURCE")" -eq 1
  test "$(grep -c '^edge-staging\.commonswarm\.com {$' "$API_SOURCE")" -eq 0
  test "$(grep -c '^api\.commonswarm\.com {$' "$STAGING_SOURCE")" -eq 0
  install -m 0644 -o root -g root "$API_SOURCE" "$API_TEMP"
  install -m 0644 -o root -g root "$STAGING_SOURCE" "$STAGING_TEMP"
  mv -f "$API_TEMP" "$API_SITE"
  mv -f "$STAGING_TEMP" "$STAGING_SITE"
  install -m 0600 -o root -g root "$API_SITE" \
    "$PROOF_DIR/caddy-after-10-commonswarm-api.caddy"
  install -m 0600 -o root -g root "$STAGING_SITE" \
    "$PROOF_DIR/caddy-after-11-commonswarm-edge-staging.caddy"
  install -m 0600 -o root -g root /dev/null "$CADDY_LOG_EVIDENCE"
  prepare_caddy_access_logs "$CADDY_LOG_EVIDENCE" \
    "$API_SITE" "$STAGING_SITE"
  VALIDATE_STATUS=0
  sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || VALIDATE_STATUS=$?
  record_caddy_access_logs after-validate "$CADDY_LOG_EVIDENCE" \
    "$API_SITE" "$STAGING_SITE"
  test "$VALIDATE_STATUS" -eq 0
  systemctl reload caddy
)
```

### Verify — Anvil; HezLead reads

```sh
# step: runbook-58
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-58: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  cmp -s "$PROOF_DIR/caddy-after-10-commonswarm-api.caddy" \
    /etc/caddy/sites/10-commonswarm-api.caddy
  cmp -s "$PROOF_DIR/caddy-after-11-commonswarm-edge-staging.caddy" \
    /etc/caddy/sites/11-commonswarm-edge-staging.caddy
  test -s "$PROOF_DIR/caddy-log-files.txt"
  systemctl is-active --quiet caddy
)
```

Verify both hostnames through their public HTTPS paths. `caddy-log-files.txt`
records each path and its owner and mode both before and after validation. The
Caddy source files, drift proof, and this metadata proof are the only Caddy
artifacts in the copy-back list; request logs stay on the box.

### Rollback — Anvil at HezLead's direction

The rollback refuses intervening drift in either installed file, restores both
preflight backups, validates once, and reloads once.

```sh
# step: runbook-59
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-59: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  SITE_DIR=/etc/caddy/sites
  API_SITE="$SITE_DIR/10-commonswarm-api.caddy"
  STAGING_SITE="$SITE_DIR/11-commonswarm-edge-staging.caddy"
  API_TEMP="$SITE_DIR/.10-commonswarm-api.${SHA}.rollback"
  STAGING_TEMP="$SITE_DIR/.11-commonswarm-edge-staging.${SHA}.rollback"
  CADDY_LOG_EVIDENCE="$PROOF_DIR/caddy-log-files.txt"
  check_caddy_access_log_path() {
    local CADDY_LOG_PATH=$1
    local CADDY_LOG_REAL
    case "$CADDY_LOG_PATH" in /var/log/caddy/?*) ;; *) false ;; esac
    case "$CADDY_LOG_PATH" in
      *'/../'*|*/..|*'/./'*|*/.|*'//'*) false ;;
    esac
    CADDY_LOG_REAL=$(realpath -m -- "$CADDY_LOG_PATH")
    test "$CADDY_LOG_REAL" = "$CADDY_LOG_PATH"
  }
  record_caddy_access_logs() {
    local CADDY_LOG_STAGE=$1
    local CADDY_LOG_EVIDENCE=$2
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift 2
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        test ! -L "$CADDY_LOG_PATH"
        test -f "$CADDY_LOG_PATH"
        test "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" = caddy:caddy
        test "$(stat -c '%a' "$CADDY_LOG_PATH")" = 600
        printf '%s %s owner=%s mode=%s\n' \
          "$CADDY_LOG_STAGE" "$CADDY_LOG_PATH" \
          "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" \
          "$(stat -c '%a' "$CADDY_LOG_PATH")" >>"$CADDY_LOG_EVIDENCE"
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
  }
  prepare_caddy_access_logs() {
    local CADDY_LOG_EVIDENCE=$1
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        if [ -L "$CADDY_LOG_PATH" ]; then
          false
        elif [ -e "$CADDY_LOG_PATH" ]; then
          test -f "$CADDY_LOG_PATH"
          chown caddy:caddy "$CADDY_LOG_PATH"
          chmod 0600 "$CADDY_LOG_PATH"
        else
          install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG_PATH"
        fi
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
    record_caddy_access_logs rollback-before-validate "$CADDY_LOG_EVIDENCE" "$@"
  }
  cmp -s "$PROOF_DIR/caddy-after-10-commonswarm-api.caddy" "$API_SITE"
  cmp -s "$PROOF_DIR/caddy-after-11-commonswarm-edge-staging.caddy" "$STAGING_SITE"
  install -m 0644 -o root -g root \
    "$PROOF_DIR/caddy-before-10-commonswarm-api.caddy" "$API_TEMP"
  install -m 0644 -o root -g root \
    "$PROOF_DIR/caddy-before-11-commonswarm-edge-staging.caddy" "$STAGING_TEMP"
  mv -f "$API_TEMP" "$API_SITE"
  mv -f "$STAGING_TEMP" "$STAGING_SITE"
  if [ -L "$CADDY_LOG_EVIDENCE" ]; then
    false
  elif [ -e "$CADDY_LOG_EVIDENCE" ]; then
    test -f "$CADDY_LOG_EVIDENCE"
    chown root:root "$CADDY_LOG_EVIDENCE"
    chmod 0600 "$CADDY_LOG_EVIDENCE"
  else
    install -m 0600 -o root -g root /dev/null "$CADDY_LOG_EVIDENCE"
  fi
  prepare_caddy_access_logs "$CADDY_LOG_EVIDENCE" \
    "$API_SITE" "$STAGING_SITE"
  VALIDATE_STATUS=0
  sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || VALIDATE_STATUS=$?
  record_caddy_access_logs rollback-after-validate "$CADDY_LOG_EVIDENCE" \
    "$API_SITE" "$STAGING_SITE"
  test "$VALIDATE_STATUS" -eq 0
  systemctl reload caddy
  cmp -s "$PROOF_DIR/caddy-before-10-commonswarm-api.caddy" "$API_SITE"
  cmp -s "$PROOF_DIR/caddy-before-11-commonswarm-edge-staging.caddy" "$STAGING_SITE"
)
```

### MCP site

Use these blocks when installing or replacing the rendered
`commonswarm-mcp.caddy` site. Set `MCP_CADDY_RELEASE=yes` in section 1's
copy-back manifest. Before preflight, the item plan records the one approved
installed path as `MCP_CADDY_SITE` and the approved loopback port as
`MCP_OAUTH_HOST_PORT` in root-owned `window.env`. The path may name only one
regular file immediately below `/etc/caddy/sites/`. The source is always read
from the exact `NEW_STACK` release; the item plan must not supply a second copy.

#### Preflight — Anvil; HezLead approves

The preflight saves the installed file or records that it was absent. Apply
re-checks that exact state before changing the site, so an intervening edit is
a stop.

```sh
# step: runbook-mcp-caddy-preflight
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-mcp-caddy-preflight: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  : "${MCP_CADDY_SITE:?approved MCP Caddy site path missing}"
  case "$MCP_CADDY_SITE" in /etc/caddy/sites/*.caddy) ;; *) false ;; esac
  test "$(dirname -- "$MCP_CADDY_SITE")" = /etc/caddy/sites
  test ! -L "$MCP_CADDY_SITE"
  MCP_BEFORE="$PROOF_DIR/mcp-caddy-before.caddy"
  MCP_BEFORE_STATE="$PROOF_DIR/mcp-caddy-before-state.txt"
  if [ -e "$MCP_CADDY_SITE" ]; then
    test -f "$MCP_CADDY_SITE"
    install -m 0600 -o root -g root "$MCP_CADDY_SITE" "$MCP_BEFORE"
    printf '%s\n' present >"$MCP_BEFORE_STATE"
  else
    install -m 0600 -o root -g root /dev/null "$MCP_BEFORE"
    printf '%s\n' absent >"$MCP_BEFORE_STATE"
  fi
  chown root:root "$MCP_BEFORE_STATE"
  chmod 0600 "$MCP_BEFORE_STATE"
)
```

#### Apply — Anvil

The candidate is rendered from the approved release source by replacing only
its five port placeholders. The installed file is then the exact input used to
derive and prepare its access-log paths. Validation runs once as `caddy`, its
post-validation owner/mode check runs even when validation fails, and reload
runs once only after both checks pass.

```sh
# step: runbook-mcp-caddy-apply
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-mcp-caddy-apply: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  MCP_SOURCE="$NEW_STACK/deploy/supabase-stack/commonswarm-mcp.caddy"
  MCP_BEFORE="$PROOF_DIR/mcp-caddy-before.caddy"
  MCP_BEFORE_STATE="$PROOF_DIR/mcp-caddy-before-state.txt"
  MCP_CANDIDATE="$PROOF_DIR/mcp-caddy-candidate.caddy"
  MCP_AFTER="$PROOF_DIR/mcp-caddy-after.caddy"
  MCP_DRIFT_PROOF="$PROOF_DIR/mcp-caddy-drift-check.txt"
  CADDY_LOG_EVIDENCE="$PROOF_DIR/mcp-caddy-log-files.txt"
  : "${MCP_CADDY_SITE:?approved MCP Caddy site path missing}"
  : "${MCP_OAUTH_HOST_PORT:?approved MCP OAuth port missing}"
  case "$MCP_CADDY_SITE" in /etc/caddy/sites/*.caddy) ;; *) false ;; esac
  test "$(dirname -- "$MCP_CADDY_SITE")" = /etc/caddy/sites
  case "$MCP_OAUTH_HOST_PORT" in (*[!0-9]*|'') false ;; esac
  test "$MCP_OAUTH_HOST_PORT" -ge 3490
  test "$MCP_OAUTH_HOST_PORT" -le 3499
  test -f "$MCP_SOURCE"
  test ! -L "$MCP_CADDY_SITE"
  case "$(cat "$MCP_BEFORE_STATE")" in
    present) cmp -s "$MCP_BEFORE" "$MCP_CADDY_SITE" ;;
    absent) test ! -e "$MCP_CADDY_SITE" ;;
    *) false ;;
  esac
  install -m 0600 -o root -g root /dev/null "$MCP_DRIFT_PROOF"
  printf '%s\n' 'MCP Caddy site: PASS' >"$MCP_DRIFT_PROOF"
  python3 - "$MCP_SOURCE" "$MCP_CANDIDATE" "$MCP_OAUTH_HOST_PORT" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text()
destination = Path(sys.argv[2])
port = sys.argv[3]
placeholder = "{$MCP_OAUTH_HOST_PORT}"
assert source.count(placeholder) == 5
destination.write_text(source.replace(placeholder, port))
PY
  chown root:root "$MCP_CANDIDATE"
  chmod 0600 "$MCP_CANDIDATE"
  MCP_TEMP="/etc/caddy/sites/.commonswarm-mcp.${SHA}.candidate"
  install -m 0644 -o root -g root "$MCP_CANDIDATE" "$MCP_TEMP"
  mv -f "$MCP_TEMP" "$MCP_CADDY_SITE"
  install -m 0600 -o root -g root "$MCP_CADDY_SITE" "$MCP_AFTER"

  check_caddy_access_log_path() {
    local CADDY_LOG_PATH=$1
    local CADDY_LOG_REAL
    case "$CADDY_LOG_PATH" in /var/log/caddy/?*) ;; *) false ;; esac
    case "$CADDY_LOG_PATH" in
      *'/../'*|*/..|*'/./'*|*/.|*'//'*) false ;;
    esac
    CADDY_LOG_REAL=$(realpath -m -- "$CADDY_LOG_PATH")
    test "$CADDY_LOG_REAL" = "$CADDY_LOG_PATH"
  }
  record_caddy_access_logs() {
    local CADDY_LOG_STAGE=$1
    local CADDY_LOG_EVIDENCE=$2
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift 2
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        test ! -L "$CADDY_LOG_PATH"
        test -f "$CADDY_LOG_PATH"
        test "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" = caddy:caddy
        test "$(stat -c '%a' "$CADDY_LOG_PATH")" = 600
        printf '%s %s owner=%s mode=%s\n' \
          "$CADDY_LOG_STAGE" "$CADDY_LOG_PATH" \
          "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" \
          "$(stat -c '%a' "$CADDY_LOG_PATH")" >>"$CADDY_LOG_EVIDENCE"
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
  }
  prepare_caddy_access_logs() {
    local CADDY_LOG_EVIDENCE=$1
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        if [ -L "$CADDY_LOG_PATH" ]; then
          false
        elif [ -e "$CADDY_LOG_PATH" ]; then
          test -f "$CADDY_LOG_PATH"
          chown caddy:caddy "$CADDY_LOG_PATH"
          chmod 0600 "$CADDY_LOG_PATH"
        else
          install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG_PATH"
        fi
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
    record_caddy_access_logs before-validate "$CADDY_LOG_EVIDENCE" "$@"
  }
  install -m 0600 -o root -g root /dev/null "$CADDY_LOG_EVIDENCE"
  prepare_caddy_access_logs "$CADDY_LOG_EVIDENCE" "$MCP_CADDY_SITE"
  VALIDATE_STATUS=0
  sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || VALIDATE_STATUS=$?
  record_caddy_access_logs after-validate "$CADDY_LOG_EVIDENCE" "$MCP_CADDY_SITE"
  test "$VALIDATE_STATUS" -eq 0
  systemctl reload caddy
)
```

#### Verify — Anvil; HezLead reads

```sh
# step: runbook-mcp-caddy-verify
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-mcp-caddy-verify: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  cmp -s "$PROOF_DIR/mcp-caddy-after.caddy" "$MCP_CADDY_SITE"
  test -s "$PROOF_DIR/mcp-caddy-log-files.txt"
  systemctl is-active --quiet caddy
)
```

Verify the approved public MCP paths from the item plan. The metadata evidence
records every derived path and its owner and mode before and after validation;
the access log itself remains on the box.

#### Rollback — Anvil at HezLead's direction

Rollback refuses drift from the applied file. It restores the saved regular
file, or removes only the approved site path when preflight proved the site was
initially absent. A restored file receives the same dynamic log guard before
the one validation and one reload.

```sh
# step: runbook-mcp-caddy-rollback
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-mcp-caddy-rollback: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${SHA}"
  MCP_BEFORE="$PROOF_DIR/mcp-caddy-before.caddy"
  MCP_BEFORE_STATE="$PROOF_DIR/mcp-caddy-before-state.txt"
  MCP_AFTER="$PROOF_DIR/mcp-caddy-after.caddy"
  CADDY_LOG_EVIDENCE="$PROOF_DIR/mcp-caddy-log-files.txt"
  if [ -L "$CADDY_LOG_EVIDENCE" ]; then
    false
  elif [ -e "$CADDY_LOG_EVIDENCE" ]; then
    test -f "$CADDY_LOG_EVIDENCE"
    chown root:root "$CADDY_LOG_EVIDENCE"
    chmod 0600 "$CADDY_LOG_EVIDENCE"
  else
    install -m 0600 -o root -g root /dev/null "$CADDY_LOG_EVIDENCE"
  fi
  : "${MCP_CADDY_SITE:?approved MCP Caddy site path missing}"
  case "$MCP_CADDY_SITE" in /etc/caddy/sites/*.caddy) ;; *) false ;; esac
  test "$(dirname -- "$MCP_CADDY_SITE")" = /etc/caddy/sites
  test ! -L "$MCP_CADDY_SITE"
  cmp -s "$MCP_AFTER" "$MCP_CADDY_SITE"
  MCP_TEMP="/etc/caddy/sites/.commonswarm-mcp.${SHA}.rollback"
  case "$(cat "$MCP_BEFORE_STATE")" in
    present)
      install -m 0644 -o root -g root "$MCP_BEFORE" "$MCP_TEMP"
      mv -f "$MCP_TEMP" "$MCP_CADDY_SITE"
      ;;
    absent)
      unlink "$MCP_CADDY_SITE"
      ;;
    *) false ;;
  esac

  check_caddy_access_log_path() {
    local CADDY_LOG_PATH=$1
    local CADDY_LOG_REAL
    case "$CADDY_LOG_PATH" in /var/log/caddy/?*) ;; *) false ;; esac
    case "$CADDY_LOG_PATH" in
      *'/../'*|*/..|*'/./'*|*/.|*'//'*) false ;;
    esac
    CADDY_LOG_REAL=$(realpath -m -- "$CADDY_LOG_PATH")
    test "$CADDY_LOG_REAL" = "$CADDY_LOG_PATH"
  }
  record_caddy_access_logs() {
    local CADDY_LOG_STAGE=$1
    local CADDY_LOG_EVIDENCE=$2
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift 2
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        test ! -L "$CADDY_LOG_PATH"
        test -f "$CADDY_LOG_PATH"
        test "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" = caddy:caddy
        test "$(stat -c '%a' "$CADDY_LOG_PATH")" = 600
        printf '%s %s owner=%s mode=%s\n' \
          "$CADDY_LOG_STAGE" "$CADDY_LOG_PATH" \
          "$(stat -c '%U:%G' "$CADDY_LOG_PATH")" \
          "$(stat -c '%a' "$CADDY_LOG_PATH")" >>"$CADDY_LOG_EVIDENCE"
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
  }
  prepare_caddy_access_logs() {
    local CADDY_LOG_EVIDENCE=$1
    local CADDY_SITE_FILE CADDY_LOG_PATH CADDY_SITE_LOG_COUNT
    shift
    test "$#" -gt 0
    for CADDY_SITE_FILE in "$@"; do
      test -f "$CADDY_SITE_FILE"
      CADDY_SITE_LOG_COUNT=0
      while IFS= read -r CADDY_LOG_PATH || [ -n "$CADDY_LOG_PATH" ]; do
        CADDY_SITE_LOG_COUNT=$((CADDY_SITE_LOG_COUNT + 1))
        check_caddy_access_log_path "$CADDY_LOG_PATH"
        if [ -L "$CADDY_LOG_PATH" ]; then
          false
        elif [ -e "$CADDY_LOG_PATH" ]; then
          test -f "$CADDY_LOG_PATH"
          chown caddy:caddy "$CADDY_LOG_PATH"
          chmod 0600 "$CADDY_LOG_PATH"
        else
          install -o caddy -g caddy -m 0600 /dev/null "$CADDY_LOG_PATH"
        fi
      done < <(awk '$1 == "output" && $2 == "file" { print $3 }' "$CADDY_SITE_FILE")
      test "$CADDY_SITE_LOG_COUNT" -gt 0
    done
    record_caddy_access_logs rollback-before-validate "$CADDY_LOG_EVIDENCE" "$@"
  }
  if [ "$(cat "$MCP_BEFORE_STATE")" = present ]; then
    prepare_caddy_access_logs "$CADDY_LOG_EVIDENCE" "$MCP_CADDY_SITE"
  else
    printf '%s\n' 'rollback-before-validate site=absent log-paths=none' \
      >>"$CADDY_LOG_EVIDENCE"
  fi
  VALIDATE_STATUS=0
  sudo -u caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || VALIDATE_STATUS=$?
  if [ "$(cat "$MCP_BEFORE_STATE")" = present ]; then
    record_caddy_access_logs rollback-after-validate "$CADDY_LOG_EVIDENCE" \
      "$MCP_CADDY_SITE"
  else
    printf '%s\n' 'rollback-after-validate site=absent log-paths=none' \
      >>"$CADDY_LOG_EVIDENCE"
  fi
  test "$VALIDATE_STATUS" -eq 0
  systemctl reload caddy
  case "$(cat "$MCP_BEFORE_STATE")" in
    present) cmp -s "$MCP_BEFORE" "$MCP_CADDY_SITE" ;;
    absent) test ! -e "$MCP_CADDY_SITE" ;;
    *) false ;;
  esac
)
```

## 10. Multi-part release order and stop conditions

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
8. Install and verify the API Caddy pair with section 9 when either pair source
   changed. Use section 9's MCP blocks when `commonswarm-mcp.caddy` changed.
9. After an npm package is published, record its exact-SHA client build with
   section 6's generated-SQL step. Skip this for releases with no npm publish.
10. Run public and authenticated end-to-end verification; archive evidence.

Migration precedes code that needs it. Backfill precedes later migrations. A
new edge must remain compatible with the verified database state at the moment
it is recreated.

**H0 (the first use of this procedure, released 2026-09-23).** `KIND_LIST` is `edge stack`. The
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

### Rollback — explicit HezLead decision; Anvil executes `runbook-mcp-caddy-rollback`

Rollback only the component whose rollback is defined and whose previous
release was recorded. If rollback cannot be proved safe, keep the box up, stop
further changes, preserve the logs, and escalate to HezLead. Never improvise a
full restore, delete a release, prune Docker, or point anything back to hosted
Supabase, Railway, or Vercel.

After either a successful close or an abort, remove the root-only transient
database files and upload archives. This does not remove release evidence. When
the window stopped before the proof directory existed, the names derive from the
named release SHA and the same files are removed:

```sh
# step: runbook-60
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-60: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  ACTIVE_PROOF="/home/commonswarm/stack/release-proofs/${RELEASE_SHA}"
  if [ -e "$ACTIVE_PROOF" ] || [ -L "$ACTIVE_PROOF" ]; then
    . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  else
    # A window that stopped before 1-apply-release-directories has no window
    # file on the box, but its upload files can exist. Every name below derives
    # from the named release SHA.
    SHA="$RELEASE_SHA"
  fi
  test "$SHA" = "$RELEASE_SHA"
  rm -f \
    "/run/commonswarm-release-${SHA}-service.conf" \
    "/run/commonswarm-release-${SHA}-pass" \
    "/run/commonswarm-release-${SHA}-apply.sql" \
    "/run/commonswarm-release-${SHA}-session.sh" \
    /tmp/commonswarm-release.tar \
    /tmp/commonswarm-release-window.env \
    /tmp/commonswarm-release-proofs.tar
)
```

After copy-back and `runbook-60`, close the active proof directory by its exact
name. A prior closed directory is never removed, listed, globbed, or selected;
an existing destination is a stop for HezLead. With no active proof directory
the block says so and closes nothing.

```sh
# step: runbook-61
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL runbook-61: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/${RELEASE_SHA}"
  if [ ! -e "$PROOF_DIR" ] && [ ! -L "$PROOF_DIR" ]; then
    printf 'runbook-61: no active proof directory for %s; nothing to close\n' "$RELEASE_SHA"
    exit 0
  fi
  . "$PROOF_DIR/window.env"
  test "$SHA" = "$RELEASE_SHA"
  case "$WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  CLOSED_PROOF_DIR="${PROOF_DIR}.closed-window-${WINDOW_ID}"
  test ! -e "$CLOSED_PROOF_DIR"
  test ! -L "$CLOSED_PROOF_DIR"
  mv -- "$PROOF_DIR" "$CLOSED_PROOF_DIR"
  test -d "$CLOSED_PROOF_DIR"
  test ! -e "$PROOF_DIR"
)
```

## Open follow-ups (Opus Checker round 3, 2026-09-22; still open after the H0 fold)

These do not block a release. Fold them in a later change.

- The guarded switch accepts a `failed` backup or restore service before it switches, but after the switch it requires `inactive` plus `success`. A drill that failed earlier therefore makes both apply and rollback report failure.
- The stack runtime-file comparison ignores `deploy/supabase-stack/migrate/`, although the backup and the drill run helpers from it through `stack/current`.
- A second run of the Mac preflight empties `run.log`. (A failed check now makes the pasted preflight exit 1 in bash and zsh.)
- The test-hook environment names are typed by hand, and `SWARM_ENV=test` is accepted.
