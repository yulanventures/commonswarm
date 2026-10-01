# HM lanes 3 and 7 — hosted-control box window B

**Release SHA:** `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`
**Required window-A result:** the close receipt records that this release is live,
healthy, and DARK.
**Status:** PLAN. Every named input below is validated before window state is
created.

Window B runs later than window A and has its own dry run, box-clock identity,
GO record, proof directory, controls, cleanup, and close receipt. It must pass
before any MCP-enable plan may open. It does not apply a migration, move a
release symlink, change Caddy, enable public MCP, or deploy anything.

## 1. Named prompt inputs and fixed decisions

Credential values are never prompt inputs. Paths name protected files; their
contents remain private.

| Name | Supplier | Exact format and expected value |
|---|---|---|
| `APPROVER` | HezLead | Exact string `HezLead`. |
| `PLAN_COMMIT` | HezLead/Anvil | Full lowercase 40-hex reviewed commit for this B plan. |
| `RELEASE_SHA` | HezLead/Anvil | Full lowercase 40-hex; exactly `eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922`. |
| `PROMPT_NUMBER` | HezLead | Positive decimal. |
| `BACKUP_MAX_AGE_SECONDS` | HezLead | Positive decimal seconds; expected `86400`. |
| `HM37_A_CLOSE_RECEIPT` | Anvil, produced only by Window A | Absolute path to Window A's copied, mode-`0600` close receipt; the only A-to-B handoff. |
| `HUMAN_LOGIN_PREFLIGHT` | Anvil | Absolute path to the protected pre-window PASS/STOP receipt made with the 1Password service-account workflow. |
| `HUMAN_SESSION_SOURCE` | Anvil | Absolute path to the protected mode-0600 human-session JSON. |
| `HARNESS_SOURCE` | Anvil | Absolute path to the reviewed `hm37-open-ack-control.ts`. |
| `IMPORT_MAP_SOURCE` | Anvil | Absolute path to the reviewed `hm37-open-ack-deno.json`. |
| `SCHEMA_ROLLBACK_APPROVAL` | HezLead, pre-given rollback permission | Exact `yes` or `no`; `yes` permits only the reserve block's own previous-edge, zero-history, and guarded-inverse checks. |

The Anvil prompt supplies these values. The file inputs are protected paths;
their contents are not prompt text and are never printed.

```prompt-inputs
{"name":"APPROVER","format":"literal:HezLead","supplier":"HezLead","meaning":"Approval identity for Window B."}
{"name":"PLAN_COMMIT","format":"sha40","supplier":"HezLead and Anvil","meaning":"Reviewed commit containing the Window B plan."}
{"name":"RELEASE_SHA","format":"literal:eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922","supplier":"HezLead and Anvil","meaning":"Reviewed release commit pinned for Window B."}
{"name":"PROMPT_NUMBER","format":"decimal-positive","supplier":"HezLead","meaning":"Positive approval-record prompt number."}
{"name":"BACKUP_MAX_AGE_SECONDS","format":"decimal-positive","supplier":"HezLead","meaning":"Maximum acceptable verified backup age in seconds."}
{"name":"HM37_A_CLOSE_RECEIPT","format":"abs-file:hm37-a-close-receipt","supplier":"Anvil","meaning":"Protected successful Window A close receipt."}
{"name":"HUMAN_LOGIN_PREFLIGHT","format":"abs-file:human-login-preflight","supplier":"Anvil","meaning":"Protected noninteractive human-login preflight receipt."}
{"name":"HUMAN_SESSION_SOURCE","format":"abs-file:human-session","supplier":"Anvil","meaning":"Protected human-session JSON staged for the hosted control."}
{"name":"HARNESS_SOURCE","format":"abs-file:harness-source","supplier":"Anvil","meaning":"Reviewed hosted-control harness source file."}
{"name":"IMPORT_MAP_SOURCE","format":"abs-file:import-map-source","supplier":"Anvil","meaning":"Reviewed Deno import-map source file."}
{"name":"SCHEMA_ROLLBACK_APPROVAL","format":"enum:yes|no","supplier":"HezLead","meaning":"Pre-given permission to attempt the reserved rollback; the block still requires its own previous-edge and empty-history proof."}
```

The approved failure map is static: hosted cleanup assertion S2, hosted
visibility assertion S4, and both hosted bearer/seat-handle assertions S5 invoke
full edge-first rollback. Harness/setup failures invoke cleanup only. An unknown
assertion ID performs guarded cleanup and then stops for a plan correction. No
operator or approver classifies a failure during the window.

## 2. Pre-window human and A-close gates

The human receipt is measured before B opens. It must name only Cold Agent Test
workspace `c2ea0541-f56d-4c73-bf71-56c5405c4934`, the production target, a
successful current login, and the noninteractive 1Password service-account
method. Any keychain dialog, interactive sign-in, or 2FA result is `STOP`.

```sh
# step: hm37b-human-preflight
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  : "${HUMAN_LOGIN_PREFLIGHT:?absolute protected receipt required}"
  case "$HUMAN_LOGIN_PREFLIGHT" in /*) ;; *) false ;; esac
  test -f "$HUMAN_LOGIN_PREFLIGHT"
  test ! -L "$HUMAN_LOGIN_PREFLIGHT"
  test "$(stat -f %Su:%Sg:%Lp "$HUMAN_LOGIN_PREFLIGHT")" = "$(id -un):$(id -gn):600"
  grep -qFx 'result=PASS' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'auth_method=1password_service_account' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'target=https://api.commonswarm.com' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'workspace_id=c2ea0541-f56d-4c73-bf71-56c5405c4934' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'workspace_count=1' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'keychain_dialog=no' "$HUMAN_LOGIN_PREFLIGHT"
  grep -qFx 'two_factor_prompt=no' "$HUMAN_LOGIN_PREFLIGHT"
)
```

Before `hm37b-open-inputs` creates its first window receipt, run both live
dependency preflights below. They write no durable output. The human session
comes from the same protected `HUMAN_SESSION_SOURCE` prepared through the
documented noninteractive 1Password service-account/token-file workflow; this
block never reads a keychain, starts a login, refreshes a session or invokes
`op`. Its fresh mode-0700 `/private/tmp/anvil-secret.XXXXXX` directory is removed
through guarded `rm` on success, failure or interruption. A guard refusal is
STOP with the directory left for HezLead, never a reason to bypass the guard.

`hm37b-hosted-auth-dependency-preflight` sends that session only on SSH stdin to
a root Python process on the box. That process reads the actual control's
`/home/commonswarm/.env` in memory and makes the authenticated GET used by
`verifiedHuman()` in `deploy/release-proofs/item-hm/hm37-open-ack-control.ts`.
It requires the production URL, a confirmed human user and a UUID identity;
it does not accept the earlier PASS receipt as proof of current authentication.
The exact cached Deno `getUser`/`getClaims` and database clients are checked
again after runtime staging, before the control journal or any authority
mutation. Tokens, keys, user documents and connection errors are never printed
or placed in argv or exported to the shell environment.

`hm37b-deno-artifact-dependency-preflight` downloads the official Linux Deno
2.9.7 ZIP on the box and compares its bytes to M19's measured digest in
`docs/evidence/2026-09-29-box-facts/box-facts-measured.json`. It preserves the
install block's exact URL, single measured HTTPS redirect host and hash; it
neither installs nor executes the downloaded binary. The existing install
block independently repeats the download/hash and owner/mode checks, so a
preflight success cannot authorize changed bytes later.

Both whole blocks are NOT EXECUTED by the contained dry run: they require the
live production authentication endpoint or official artifact and box runtime.
Replacement proof is their zero exit in the live window after the stated
assertions; there is no receipt to seed or later consume. Failure is a setup
failure under the existing cleanup-only map: stop before opening B, run the
owning temporary-directory trap, and leave the closed A release live. No
journal, installed Deno or B proof state exists to roll back yet. If durable
window state exists on a resumed failure, use the existing abort cleanup and
the recorded Deno removal guard, never forge a successful close receipt.

```sh
# step: hm37b-hosted-auth-dependency-preflight
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only ssh Python child on box as root
(
  set -euo pipefail
  umask 077
  : "${HUMAN_SESSION_SOURCE:?absolute protected session path required}"
  test "$(command -v rm)" = "$HOME/.local/bin/rm"
  case "$HUMAN_SESSION_SOURCE" in /*) ;; *) false ;; esac
  test -f "$HUMAN_SESSION_SOURCE"
  test ! -L "$HUMAN_SESSION_SOURCE"
  test "$(stat -f %Su:%Sg:%Lp "$HUMAN_SESSION_SOURCE")" = "$(id -un):$(id -gn):600"
  SECRET_ROOT="$(mktemp -d /private/tmp/anvil-secret.XXXXXX)"
  cleanup_secret_preflight() {
    STATUS=$?
    trap - EXIT
    case "$SECRET_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test -d "$SECRET_ROOT" && test ! -L "$SECRET_ROOT" || exit 1
    test "$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$SECRET_ROOT")" = "$SECRET_ROOT" || exit 1
    if ! rm -r -- "$SECRET_ROOT"; then
      printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$SECRET_ROOT" >&2
      exit 1
    fi
    test ! -e "$SECRET_ROOT" || exit 1
    exit "$STATUS"
  }
  trap cleanup_secret_preflight EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  case "$SECRET_ROOT" in /private/tmp/anvil-secret.??????) ;; *) false ;; esac
  chmod 0700 "$SECRET_ROOT"
  test "$(stat -f %Su:%Sg:%Lp "$SECRET_ROOT")" = "$(id -un):$(id -gn):700"
  cp "$HUMAN_SESSION_SOURCE" "$SECRET_ROOT/human-session.json"
  chmod 0600 "$SECRET_ROOT/human-session.json"
  cat >"$SECRET_ROOT/auth-probe.py" <<'PY'
import json, pathlib, pwd, re, stat, sys, urllib.request

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

def probe():
    path = pathlib.Path('/home/commonswarm/.env')
    info = path.lstat()
    assert stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600
    assert info.st_uid == pwd.getpwnam('commonswarm').pw_uid
    values = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip()
        assert re.fullmatch(r'[A-Z][A-Z0-9_]*', key)
        assert not value.startswith(('"', "'"))
        values[key] = value
    assert values['SUPABASE_URL'] == 'https://api.commonswarm.com'
    assert values['SUPABASE_ANON_KEY']
    session = json.load(sys.stdin)
    assert set(session) == {'access_token'}
    assert isinstance(session['access_token'], str) and len(session['access_token']) >= 32
    request = urllib.request.Request(values['SUPABASE_URL'] + '/auth/v1/user',
        headers={'apikey': values['SUPABASE_ANON_KEY'],
                 'Authorization': 'Bearer ' + session['access_token'],
                 'User-Agent': 'commonswarm-release-probe/1.0'}, method='GET')
    with urllib.request.build_opener(NoRedirect()).open(request, timeout=30) as response:
        assert response.status == 200
        user = json.loads(response.read(1024 * 1024))
    assert user.get('email_confirmed_at') is not None
    assert re.fullmatch(r'[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
                        user.get('id', ''), re.I)

try:
    probe()
except BaseException:
    print('STOP: live hosted human authentication preflight failed', file=sys.stderr)
    sys.exit(1)
PY
  # Only program text enters argv. The credential document travels on stdin.
  REMOTE_COMMAND="$(python3 - "$SECRET_ROOT/auth-probe.py" <<'PY'
import pathlib, shlex, sys
print('sudo -n -i python3 -c ' + shlex.quote(pathlib.Path(sys.argv[1]).read_text()))
PY
  )"
  ssh ops@100.115.66.74 "$REMOTE_COMMAND" <"$SECRET_ROOT/human-session.json"
)
```

```sh
# step: hm37b-deno-artifact-dependency-preflight
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only ssh child on box /bin/bash 5.2 as root
(
  set -euo pipefail
  ssh ops@100.115.66.74 'sudo -n -i /bin/bash -s' <<'BOX'
set -euo pipefail
umask 077
DENO_ZIP_SHA256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
DENO_URL=https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip
test "$(stat -c '%U:%G:%a' /usr/local/bin)" = root:root:755
test ! -e /usr/local/bin/deno
test ! -L /usr/local/bin/deno
DOWNLOAD_ROOT="$(mktemp -d /tmp/commonswarm-deno-preflight.XXXXXX)"
cleanup_artifact_preflight() {
  STATUS=$?
  trap - EXIT
  case "$DOWNLOAD_ROOT" in /tmp/commonswarm-deno-preflight.??????) ;; *) exit 1 ;; esac
  test -d "$DOWNLOAD_ROOT" && test ! -L "$DOWNLOAD_ROOT" || exit 1
  test "$(readlink -f "$DOWNLOAD_ROOT")" = "$DOWNLOAD_ROOT" || exit 1
  if ! rm -r -- "$DOWNLOAD_ROOT"; then
    printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$DOWNLOAD_ROOT" >&2
    exit 1
  fi
  test ! -e "$DOWNLOAD_ROOT" || exit 1
  exit "$STATUS"
}
trap cleanup_artifact_preflight EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 0700 "$DOWNLOAD_ROOT"
test "$(stat -c '%U:%G:%a' "$DOWNLOAD_ROOT")" = root:root:700
curl --fail --silent --head --proto '=https' --max-time 30 \
  --dump-header "$DOWNLOAD_ROOT/redirect.headers" --output /dev/null "$DENO_URL"
test "$(grep -ic '^location:' "$DOWNLOAD_ROOT/redirect.headers")" -eq 1
REDIRECT_URL="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print}' "$DOWNLOAD_ROOT/redirect.headers")"
case "$REDIRECT_URL" in https://release-assets.githubusercontent.com/*) ;; *) false ;; esac
curl --fail --silent --proto '=https' --max-time 120 \
  --output "$DOWNLOAD_ROOT/deno.zip" --write-out '%{url_effective}\n' \
  "$REDIRECT_URL" >"$DOWNLOAD_ROOT/effective-url.txt"
test "$(cat "$DOWNLOAD_ROOT/effective-url.txt")" = "$REDIRECT_URL"
test "$(sha256sum "$DOWNLOAD_ROOT/deno.zip" | awk '{print $1}')" = "$DENO_ZIP_SHA256"
BOX
)
```

```sh
# step: hm37b-open-inputs
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; read-only ssh child on box
(
  set -euo pipefail
  umask 077
  : "${APPROVER:?named prompt input required}"
  : "${PLAN_COMMIT:?named prompt input required}"
  : "${RELEASE_SHA:?named prompt input required}"
  : "${PROMPT_NUMBER:?named prompt input required}"
  : "${BACKUP_MAX_AGE_SECONDS:?named prompt input required}"
  : "${HM37_A_CLOSE_RECEIPT:?absolute A close receipt required}"
  test "$APPROVER" = HezLead
  test "$RELEASE_SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  case "$PLAN_COMMIT" in (*[!0-9a-f]*|'') false ;; esac
  test "${#PLAN_COMMIT}" -eq 40
  case "$PROMPT_NUMBER" in (*[!0-9]*|'') false ;; esac
  test "$PROMPT_NUMBER" -gt 0
  case "$BACKUP_MAX_AGE_SECONDS" in (*[!0-9]*|'') false ;; esac
  test "$BACKUP_MAX_AGE_SECONDS" -gt 0
  case "$HM37_A_CLOSE_RECEIPT" in /*) ;; *) false ;; esac
  test -f "$HM37_A_CLOSE_RECEIPT"
  test ! -L "$HM37_A_CLOSE_RECEIPT"
  test "$(stat -f %Lp "$HM37_A_CLOSE_RECEIPT")" = 600
  grep -qFx "release_sha=$RELEASE_SHA" "$HM37_A_CLOSE_RECEIPT"
  grep -qFx 'edge_live=true' "$HM37_A_CLOSE_RECEIPT"
  grep -qFx 'edge_dark=true' "$HM37_A_CLOSE_RECEIPT"
  grep -qFx 'prep_seats_revoked=true' "$HM37_A_CLOSE_RECEIPT"
  grep -qFx 'prep_active_tokens=0' "$HM37_A_CLOSE_RECEIPT"
  grep -qFx 'close=PASS' "$HM37_A_CLOSE_RECEIPT"

  CLOCK_SCRIPT="$(mktemp /tmp/hm37b-box-clock.XXXXXX)"
  case "$CLOCK_SCRIPT" in /tmp/hm37b-box-clock.??????) ;; *) false ;; esac
  trap 'rm -f -- "$CLOCK_SCRIPT"' EXIT
  cat >"$CLOCK_SCRIPT" <<'BOX'
set -euo pipefail
RELEASE_SHA="${1:?named release SHA required}"
case "$RELEASE_SHA" in (*[!0-9a-f]*|'') false ;; esac
test "${#RELEASE_SHA}" -eq 40
PROOF_DIR="/home/commonswarm/stack/release-proofs/$RELEASE_SHA"
# Refuse any proof path for this release: an open window, stale proof, or dangling link.
test ! -e "$PROOF_DIR"
test ! -L "$PROOF_DIR"
# Other releases are checked by the running-window process marker, not their proofs.
RUNNING="$(ps -eo pid=,args= | awk '$0 !~ /awk/ && $0 ~ /(RELEASE-TO-BOX|deploy\/site\/deploy|commonswarm-release-window)/ {print; exit}')"
test -z "$RUNNING"
date -u +%Y-%m-%dT%H:%M:%SZ
date -u -d '+4 hours' +%Y-%m-%dT%H:%M:%SZ
BOX
  CLOCK="$(ssh ops@100.115.66.74 "sudo -n -i /bin/bash -s -- '$RELEASE_SHA'" <"$CLOCK_SCRIPT")"
  rm -f -- "$CLOCK_SCRIPT"
  trap - EXIT
  WINDOW_START_UTC="$(printf '%s\n' "$CLOCK" | sed -n '1p')"
  WINDOW_END_UTC="$(printf '%s\n' "$CLOCK" | sed -n '2p')"
  test -n "$WINDOW_START_UTC"
  test -n "$WINDOW_END_UTC"
  WINDOW_ID="$(printf '%s' "$WINDOW_START_UTC" | tr -d ':-')"
  WINDOW_PRINCIPAL_SUFFIX="$(printf '%s' "$WINDOW_START_UTC" | sed -E 's/.*T([0-9]{6})Z/\1/')"
  case "$WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  OPEN_RECEIPT="/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  test ! -e "$OPEN_RECEIPT"
  printf 'SHA=%q\nWINDOW_START_UTC=%q\nWINDOW_END_UTC=%q\nWINDOW_ID=%q\nWINDOW_PRINCIPAL_SUFFIX=%q\nBACKUP_MAX_AGE_SECONDS=%q\n'     "$RELEASE_SHA" "$WINDOW_START_UTC" "$WINDOW_END_UTC" "$WINDOW_ID"     "$WINDOW_PRINCIPAL_SUFFIX" "$BACKUP_MAX_AGE_SECONDS" >"$OPEN_RECEIPT"
  chmod 0600 "$OPEN_RECEIPT"
)
```

The same open block refuses an open window or stale proof path for `RELEASE_SHA`
and any running release process matched by `RUNNING`. Other releases' proof
directories are read-only historical evidence; their presence does not require
closing, moving, or touching them. The operator never types either time: the first timestamp
is the box clock to the second and the second is exactly four hours later.

```sh
# step: hm37b-box-open
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child opens B state on box
(
  set -euo pipefail
  : "${RELEASE_SHA:?named prompt input required}"
  OPEN_RECEIPT="/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  test -f "$OPEN_RECEIPT"
  scp "$OPEN_RECEIPT" ops@100.115.66.74:/tmp/commonswarm-hm37b-open.env
  ssh ops@100.115.66.74 'sudo -n -i /bin/bash -s' <<'BOX'
set -euo pipefail
. /tmp/commonswarm-hm37b-open.env
test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
test ! -e "$PROOF_DIR"
install -d -m 0700 -o root -g root "$PROOF_DIR"
install -m 0600 -o root -g root /tmp/commonswarm-hm37b-open.env "$PROOF_DIR/window.env"
{
  printf 'PREVIOUS_EDGE=%q\n' /home/commonswarm/edge/releases/72c57e0d76d0aa86fe4f811a2cf51499919fed20
  printf 'NEW_EDGE=%q\n' "/home/commonswarm/edge/releases/$SHA"
  printf 'NEW_STACK=%q\n' "/home/commonswarm/stack/releases/$SHA"
  printf 'PREVIOUS_STACK=%q\n' /home/commonswarm/stack/releases/ad964ed158181ba1692dd05895f36fa7a1f87d3f
  printf 'PROOF_DIR=%q\n' "$PROOF_DIR"
  printf "RECYCLE_TIMER_STOPPED='0'\nBACKUP_TIMERS_STOPPED='0'\n"
} >>"$PROOF_DIR/window.env"
rm -f /tmp/commonswarm-hm37b-open.env
test "$(readlink -f /home/commonswarm/edge/current)" =   "/home/commonswarm/edge/releases/$SHA"
test "$(cat /home/commonswarm/edge/current/RELEASE_SHA)" = "$SHA"
docker exec commonswarm-edge-edge-runtime-1 deno eval   'Deno.exit(Deno.env.get("SWARM_MCP_PUBLIC_ENABLED") === "1" ? 1 : 0)'
BOX
)
```

```sh
# step: hm37b-go-record
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  : "${APPROVER:?named prompt input required}"
  : "${PLAN_COMMIT:?named prompt input required}"
  : "${RELEASE_SHA:?named prompt input required}"
  : "${PROMPT_NUMBER:?named prompt input required}"
  test "$APPROVER" = HezLead
  case "$PLAN_COMMIT" in (*[!0-9a-f]*|'') false ;; esac
  test "${#PLAN_COMMIT}" -eq 40
  test "$RELEASE_SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  case "$PROMPT_NUMBER" in (*[!0-9]*|'') false ;; esac
  test "$PROMPT_NUMBER" -gt 0
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$RELEASE_SHA"
  . "$PROOF_DIR/window.env"
  test ! -e "$PROOF_DIR/GO.txt"
  printf '%s\n'     "APPROVER=$APPROVER"     "PLAN_COMMIT=$PLAN_COMMIT"     "RELEASE_SHA=$RELEASE_SHA"     "PROMPT_NUMBER=$PROMPT_NUMBER"     'HM37_A_CLOSE_RECEIPT=accepted'     >"$PROOF_DIR/GO.txt"
  chown root:root "$PROOF_DIR/GO.txt"
  chmod 0600 "$PROOF_DIR/GO.txt"
)
```

## 3. Reviewed inputs, transfer, and runtime staging

```sh
# step: hm37b-control-review
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  umask 077
  : "${HARNESS_SOURCE:?absolute reviewed harness path required}"
  : "${IMPORT_MAP_SOURCE:?absolute reviewed import-map path required}"
  for SOURCE in "$HARNESS_SOURCE" "$IMPORT_MAP_SOURCE"; do
    case "$SOURCE" in /*) ;; *) false ;; esac
    test -f "$SOURCE"
    test ! -L "$SOURCE"
  done
  test "$(shasum -a 256 "$HARNESS_SOURCE" | awk '{print $1}')" =     dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013
  test "$(shasum -a 256 "$IMPORT_MAP_SOURCE" | awk '{print $1}')" =     f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b
  . "/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  EVIDENCE_DIR="$PWD/docs/evidence/$(date -u +%F)-release-${RELEASE_SHA:0:12}-${WINDOW_ID}"
  mkdir -p -m 0700 "$EVIDENCE_DIR"
  printf '%s\n'     "release_sha=$RELEASE_SHA"     'worker_boundary_review=PASS'     'harness_sha256=dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013'     'import_map_sha256=f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b'     >"$EVIDENCE_DIR/hm37-worker-boundary.txt"
  cp "$EVIDENCE_DIR/hm37-worker-boundary.txt"     "$EVIDENCE_DIR/hm37-hosted-control-inputs.txt"
  chmod 0600 "$EVIDENCE_DIR/hm37-worker-boundary.txt"     "$EVIDENCE_DIR/hm37-hosted-control-inputs.txt"
)
```

```sh
# step: hm37b-stage-transfer
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  umask 077
  : "${HUMAN_SESSION_SOURCE:?absolute protected session path required}"
  : "${HARNESS_SOURCE:?absolute harness path required}"
  : "${IMPORT_MAP_SOURCE:?absolute import-map path required}"
  . "/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  EVIDENCE_DIR="$PWD/docs/evidence/$(date -u +%F)-release-${RELEASE_SHA:0:12}-${WINDOW_ID}"
  test -f "$HUMAN_SESSION_SOURCE"
  test ! -L "$HUMAN_SESSION_SOURCE"
  test "$(stat -f %Lp "$HUMAN_SESSION_SOURCE")" = 600
  STAGING_ROOT="/run/commonswarm-hm37-${WINDOW_ID}"
  ssh ops@100.115.66.74 "sudo -n -i install -d -m 0700 -o root -g root '$STAGING_ROOT'"
  ssh ops@100.115.66.74 "umask 077; : > /tmp/hm37-open-ack-control.ts"
  scp "$HARNESS_SOURCE" ops@100.115.66.74:/tmp/hm37-open-ack-control.ts
  ssh ops@100.115.66.74 "umask 077; : > /tmp/hm37-open-ack-deno.json"
  scp "$IMPORT_MAP_SOURCE" ops@100.115.66.74:/tmp/hm37-open-ack-deno.json
  ssh ops@100.115.66.74 "umask 077; : > /tmp/hm37-human-session.json"
  scp "$HUMAN_SESSION_SOURCE" ops@100.115.66.74:/tmp/hm37-human-session.json
  scp "$EVIDENCE_DIR/hm37-worker-boundary.txt" ops@100.115.66.74:/tmp/hm37-worker-boundary.txt
  scp "$EVIDENCE_DIR/hm37-hosted-control-inputs.txt" ops@100.115.66.74:/tmp/hm37-hosted-control-inputs.txt
  ssh ops@100.115.66.74 "sudo -n -i /bin/bash -s -- '$STAGING_ROOT'" <<'BOX'
set -euo pipefail
STAGING_ROOT="$1"
install -m 0600 -o root -g root /tmp/hm37-open-ack-control.ts   "$STAGING_ROOT/hm37-open-ack-control.ts"
install -m 0600 -o root -g root /tmp/hm37-open-ack-deno.json   "$STAGING_ROOT/hm37-open-ack-deno.json"
install -m 0600 -o root -g root /tmp/hm37-human-session.json   "$STAGING_ROOT/human-session.json"
PROOF_DIR=/home/commonswarm/stack/release-proofs/eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
install -m 0600 -o root -g root /tmp/hm37-worker-boundary.txt "$PROOF_DIR/hm37-worker-boundary.txt"
install -m 0600 -o root -g root /tmp/hm37-hosted-control-inputs.txt "$PROOF_DIR/hm37-hosted-control-inputs.txt"
rm -f /tmp/hm37-open-ack-control.ts /tmp/hm37-open-ack-deno.json \
  /tmp/hm37-human-session.json /tmp/hm37-worker-boundary.txt \
  /tmp/hm37-hosted-control-inputs.txt
test "$(stat -c '%U:%G:%a' "$STAGING_ROOT")" = root:root:700
for FILE in hm37-open-ack-control.ts hm37-open-ack-deno.json human-session.json; do
  test "$(stat -c '%U:%G:%a' "$STAGING_ROOT/$FILE")" = root:root:600
done
test "$(sha256sum "$STAGING_ROOT/hm37-open-ack-control.ts" | awk '{print $1}')" =   dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013
test "$(sha256sum "$STAGING_ROOT/hm37-open-ack-deno.json" | awk '{print $1}')" =   f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b
BOX
)
```

The runtime order is fixed:
`hm37-deno-install` → `hm37-hosted-control-stage` →
`hm37b-hosted-runtime-dependency-preflight` → `hm37-hosted-open-ack-control` → result/readback blocks →
`hm37-deno-remove`. A failure before install completes runs its trap. Any later
failure runs `hm37-hosted-control-cleanup-only` when a journal exists and then
`hm37-deno-remove`.

```sh
# step: hm37-validate-local-credential
# readonly: yes
# host: box /bin/bash 5.2 as root
# Legacy step id retained: B validates the staged protected human credential.
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  SESSION="/run/commonswarm-hm37-${WINDOW_ID}/human-session.json"
  test -f "$SESSION"
  test ! -L "$SESSION"
  test "$(stat -c '%U:%G:%a' "$SESSION")" = root:root:600
  python3 - "$SESSION" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
assert set(value) == {"access_token"}
assert isinstance(value["access_token"], str) and value["access_token"]
print("protected_session_shape=PASS")
PY
)
```

```sh
# step: hm37-hosted-human-session-input
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
# Runs on the Mac mini as Anvil, under /bin/bash 3.2, before protected transfer.
(
  set -euo pipefail
  : "${RELEASE_SHA:?named release SHA required}"
  : "${HUMAN_SESSION_SOURCE:?absolute protected session input required}"
  case "$HUMAN_SESSION_SOURCE" in /*) ;; *) false ;; esac
  . "/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  INPUT_ROOT="$HOME/.config/cswarm/box-hm37-${WINDOW_ID}"
  test ! -L "$INPUT_ROOT"
  test -f "$HUMAN_SESSION_SOURCE"
  test ! -L "$HUMAN_SESSION_SOURCE"
  test "$(stat -f %Lp "$HUMAN_SESSION_SOURCE")" = 600
  python3 - "$HUMAN_SESSION_SOURCE" <<'PY'
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
assert set(value) == {"access_token"}
assert isinstance(value["access_token"], str) and value["access_token"]
PY
  printf 'protected human session validated for approved transfer\n'
)
```

Stage the reviewed files beside the immutable release, build the second
protected input without printing it, and pre-cache dependencies before the
opening gate closes. `CONTROL_ROOT` is window state, not a release directory
and not copied as evidence.

The measured box baseline has no `/usr/local/bin/deno`. Install the reviewed
runtime while network access is still permitted. The download may contact only
the hard-coded GitHub URL and its measured
`release-assets.githubusercontent.com` redirect. The later cache fill may
contact only `registry.npmjs.org`.

```sh
# step: hm37-deno-install
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash before the opening gate closes.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  DENO_PATH=/usr/local/bin/deno
  DENO_ZIP_SHA256=c6527f24f4b16031d3ae4fa9f658d5f11534c8d84ce7dc8502420280919c3490
  DENO_URL=https://github.com/denoland/deno/releases/download/v2.9.7/deno-x86_64-unknown-linux-gnu.zip
  # v2.9.7 render_version includes channel, build profile and target:
  # https://github.com/denoland/deno/blob/0c071246a412575e07423263404a5d13e7ed6aa2/cli/args/flags.rs#L759-L773
  DENO_VERSION_PATTERN='^deno 2\.9\.7( \(stable, release, x86_64-unknown-linux-gnu\))?$'
  DOWNLOAD_ROOT="/run/commonswarm-deno-${WINDOW_ID}"
  case "$DOWNLOAD_ROOT" in /run/commonswarm-deno-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) false ;; esac
  test "$(stat -c '%U:%G:%a' /usr/local/bin)" = root:root:755

  RECORDED_DENO_SHA256=${DENO_INSTALLED_BINARY_SHA256:-}
  if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
    test -n "$RECORDED_DENO_SHA256"
    test -f "$DENO_PATH"
    test ! -L "$DENO_PATH"
    test "$(stat -c '%U:%G:%a' "$DENO_PATH")" = root:root:755
    test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$RECORDED_DENO_SHA256"
    [[ "$("$DENO_PATH" --version | sed -n '1p')" =~ $DENO_VERSION_PATTERN ]]
    exit 0
  fi

  if [ -n "$RECORDED_DENO_SHA256" ]; then
    case "$RECORDED_DENO_SHA256" in (*[!0-9a-f]*|'') false ;; esac
    test "${#RECORDED_DENO_SHA256}" -eq 64
  fi
  test ! -e "$DOWNLOAD_ROOT"
  install -d -m 0700 -o root -g root "$DOWNLOAD_ROOT"
  cleanup_download() {
    case "$DOWNLOAD_ROOT" in
      /run/commonswarm-deno-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z)
        find "$DOWNLOAD_ROOT" -xdev -depth -delete
        ;;
      *) return 1 ;;
    esac
  }
  trap cleanup_download EXIT
  REDIRECT_HEADERS="$DOWNLOAD_ROOT/redirect.headers"
  curl --fail --silent --show-error --head --proto '=https' --max-time 30 \
    --dump-header "$REDIRECT_HEADERS" --output /dev/null "$DENO_URL"
  test "$(grep -ic '^location:' "$REDIRECT_HEADERS")" -eq 1
  REDIRECT_URL="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/^[^:]*:[[:space:]]*/, ""); sub(/\r$/, ""); print}' "$REDIRECT_HEADERS")"
  case "$REDIRECT_URL" in https://release-assets.githubusercontent.com/*) ;; *) false ;; esac
  EFFECTIVE_URL="$DOWNLOAD_ROOT/effective-url.txt"
  curl --fail --silent --show-error --proto '=https' --max-time 120 \
    --output "$DOWNLOAD_ROOT/deno.zip" --write-out '%{url_effective}\n' \
    "$REDIRECT_URL" >"$EFFECTIVE_URL"
  test "$(cat "$EFFECTIVE_URL")" = "$REDIRECT_URL"
  test "$(sha256sum "$DOWNLOAD_ROOT/deno.zip" | awk '{print $1}')" = "$DENO_ZIP_SHA256"
  python3 - "$DOWNLOAD_ROOT/deno.zip" "$DOWNLOAD_ROOT/deno" <<'PY'
import os
import shutil
import stat
import sys
import zipfile

archive, output = sys.argv[1:]
with zipfile.ZipFile(archive) as source:
    assert source.namelist() == ["deno"]
    info = source.getinfo("deno")
    assert not stat.S_ISLNK(info.external_attr >> 16)
    fd = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o700)
    with os.fdopen(fd, "wb") as target, source.open(info) as binary:
        shutil.copyfileobj(binary, target)
        target.flush()
        os.fsync(target.fileno())
os.chmod(output, 0o755)
PY
  INSTALLED_SHA256="$(sha256sum "$DOWNLOAD_ROOT/deno" | awk '{print $1}')"
  case "$INSTALLED_SHA256" in (*[!0-9a-f]*|'') false ;; esac
  test "${#INSTALLED_SHA256}" -eq 64
  if [ -n "$RECORDED_DENO_SHA256" ]; then
    test "$INSTALLED_SHA256" = "$RECORDED_DENO_SHA256"
  else
    printf 'DENO_INSTALLED_BINARY_SHA256=%q\n' "$INSTALLED_SHA256" >>"$PROOF_DIR/window.env"
  fi
  python3 - "$DOWNLOAD_ROOT/deno" "$DENO_PATH" <<'PY'
import os
import shutil
import sys

source, target = sys.argv[1:]
fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755)
with os.fdopen(fd, "wb") as output, open(source, "rb") as binary:
    shutil.copyfileobj(binary, output)
    output.flush()
    os.fsync(output.fileno())
os.chmod(target, 0o755)
PY
  test -f "$DENO_PATH"
  test ! -L "$DENO_PATH"
  test "$(stat -c '%U:%G:%a' "$DENO_PATH")" = root:root:755
  test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$INSTALLED_SHA256"
  [[ "$("$DENO_PATH" --version | sed -n '1p')" =~ $DENO_VERSION_PATTERN ]]
  cleanup_download
  trap - EXIT
  test ! -e "$DOWNLOAD_ROOT"
)
```

```sh
# step: hm37-hosted-control-stage
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after the accepted files arrive.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  STAGING_ROOT="/run/commonswarm-hm37-${WINDOW_ID}"
  HARNESS="$CONTROL_ROOT/hm37-open-ack-control.ts"
  DENO_CONFIG="$CONTROL_ROOT/hm37-open-ack-deno.json"
  test "$(cat "$RELEASE_ROOT/RELEASE_SHA")" = "$SHA"
  test -f /usr/local/bin/deno
  test ! -L /usr/local/bin/deno
  test -x /usr/local/bin/deno
  test "$(stat -c %U /usr/local/bin/deno)" = root
  test ! -e "$CONTROL_ROOT"
  install -d -m 0700 "$CONTROL_ROOT" "$CONTROL_ROOT/journal" "$CONTROL_ROOT/deno-cache"
  install -m 0600 "$STAGING_ROOT/hm37-open-ack-control.ts" "$HARNESS"
  install -m 0600 "$STAGING_ROOT/hm37-open-ack-deno.json" "$DENO_CONFIG"
  install -m 0600 "$STAGING_ROOT/human-session.json" "$CONTROL_ROOT/human-session.json"
  test "$(sha256sum "$HARNESS" | awk '{print $1}')" = dcef7ccd8c825f4b011a8f1c36b665be7c8c3d84fc086021a862591092ab3013
  test "$(sha256sum "$DENO_CONFIG" | awk '{print $1}')" = f0902bd4f2fe745b853ad2c9d0b4bbce7364ae94b2f70504fe13129b7fa7411b
  OAUTH_CIDS=()
  while IFS= read -r VALUE || [ -n "$VALUE" ]; do
    test -n "$VALUE" && OAUTH_CIDS[${#OAUTH_CIDS[@]}]="$VALUE"
  done < <(docker ps -q \
    --filter label=com.docker.compose.project=commonswarm-oauth \
    --filter label=com.docker.compose.service=oauth)
  test "${#OAUTH_CIDS[@]}" -eq 1
  MCP_OAUTH_DATABASE_HOST_LINE="$(docker inspect --format \
    '{{range .Config.Env}}{{if eq (index (split . "=") 0) "MCP_OAUTH_DATABASE_HOST"}}{{println .}}{{end}}{{end}}' \
    "${OAUTH_CIDS[0]}")"
  case "$MCP_OAUTH_DATABASE_HOST_LINE" in MCP_OAUTH_DATABASE_HOST=?*) ;; *) false ;; esac
  MCP_OAUTH_DATABASE_HOST=${MCP_OAUTH_DATABASE_HOST_LINE#MCP_OAUTH_DATABASE_HOST=}
  python3 - "$CONTROL_ROOT/oauth-database.json" "$MCP_OAUTH_DATABASE_HOST" <<'PY'
import json, os, pathlib, sys
out = pathlib.Path(sys.argv[1])
host = sys.argv[2]
credentials = json.loads(pathlib.Path(
    "/etc/commonswarm-oauth/database-credentials").read_text())
service = {}
for line in pathlib.Path("/etc/commonswarm-oauth/service.env").read_text().splitlines():
    if line and not line.lstrip().startswith("#") and "=" in line:
        key, value = line.split("=", 1)
        service[key] = value
document = {
    "host": host,
    "port": int(service.get("MCP_OAUTH_DATABASE_PORT", "5432")),
    "database": service["MCP_OAUTH_DATABASE_NAME"],
    "user": credentials["user"],
    "password": credentials["password"],
    "ssl_ca": pathlib.Path("/etc/ssl/yulan-internal-ca.pem").read_text(),
}
fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as handle:
    json.dump(document, handle, separators=(",", ":"))
    handle.write("\n")
    handle.flush()
    os.fsync(handle.fileno())
PY
  test "$(stat -c %a "$CONTROL_ROOT/human-session.json")" = 600
  test "$(stat -c %a "$CONTROL_ROOT/oauth-database.json")" = 600
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno cache --no-lock \
    --config "$DENO_CONFIG" "$HARNESS" \
    "$RELEASE_ROOT/services/mcp-auth/src/postgres-adapter.js" \
    "$RELEASE_ROOT/supabase/functions/command/index.ts" \
    "$RELEASE_ROOT/supabase/functions/_shared/hosted-seat-auth.ts" \
    "$RELEASE_ROOT/supabase/functions/_shared/database-options.ts"
  /usr/local/bin/deno --version >"$CONTROL_ROOT/deno-version.txt"
  chmod 0600 "$CONTROL_ROOT/deno-version.txt"
)
```

The HTTP preflight above runs before B creates any durable state. The following
additional check must wait until `hm37-hosted-control-stage`: the measured box
has no host Deno, and that block supplies the cached pinned Supabase/postgres
imports and the protected OAuth database config from the running container.
These are the actual inputs read by `verifiedHuman()`, `oauthPoolConfig()` and
`execute()` in the reviewed control source, not a replacement role or target.
The probe repeats `getUser`/`getClaims`, verifies the confirmed human identity,
authenticates both database clients and reads the exact workspace membership,
capacity and fresh-name precondition. Both database transactions explicitly
become read only before any query. It creates no journal, grant, seat, token,
signal or receipt, and runs before the hosted control's first durable mutation.

This whole block is also NOT EXECUTED by the contained dry run: the replacement
proof is the live zero exit from these authentication and read-only database
checks. It has no output to seed or consume. Failure takes the existing
setup/cleanup-only path: do not start the control; remove the recorded Deno
through `hm37-deno-remove`, run `runbook-60` and `hm37b-protected-cleanup`, and
retain the failed window for the existing abort/manifest closure procedure.
Never write `close=PASS` or roll back A for a dependency/setup failure. If a
journal already exists on an interrupted run, the existing journal cleanup and
failure-dispatch tail takes precedence before runtime removal.

```sh
# step: hm37b-hosted-runtime-dependency-preflight
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  test "$SHA" = eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  test "$(cat "$RELEASE_ROOT/RELEASE_SHA")" = "$SHA"
  test -f /home/commonswarm/.env
  test ! -L /home/commonswarm/.env
  test "$(stat -c '%U:%G:%a' /home/commonswarm/.env)" = commonswarm:commonswarm:600
  test -f /usr/local/bin/deno
  test ! -L /usr/local/bin/deno
  test "$(stat -c '%U:%G:%a' /usr/local/bin/deno)" = root:root:755
  test "$(sha256sum /usr/local/bin/deno | awk '{print $1}')" = "${DENO_INSTALLED_BINARY_SHA256:?recorded installed hash required}"
  for FILE in "$CONTROL_ROOT/human-session.json" "$CONTROL_ROOT/oauth-database.json"; do
    test -f "$FILE"
    test ! -L "$FILE"
    test "$(stat -c '%U:%G:%a' "$FILE")" = root:root:600
  done
  # Read the environment file inside the process. No secret is exported.
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno run --cached-only --no-lock \
    --config "$CONTROL_ROOT/hm37-open-ack-deno.json" \
    --allow-env --allow-net \
    --allow-read="/home/commonswarm/.env,$RELEASE_ROOT,$CONTROL_ROOT" \
    - "$RELEASE_ROOT" "$CONTROL_ROOT" "$WINDOW_PRINCIPAL_SUFFIX" <<'TS'
import { createClient } from "npm:@supabase/supabase-js@2.110.8";
import postgres from "npm:postgres@3.4.9";

const pools: ReturnType<typeof postgres>[] = [];
let failed = false;
function require(value: unknown): asserts value {
  if (!value) throw new Error("dependency preflight refused");
}
try {
  const [releaseRoot, controlRoot, suffix] = Deno.args;
  require(releaseRoot && controlRoot && suffix && /^[0-9]{6}$/.test(suffix));
  const env: Record<string, string> = {};
  for (const raw of Deno.readTextFileSync("/home/commonswarm/.env").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    require(split > 0);
    const name = line.slice(0, split).trim(), value = line.slice(split + 1).trim();
    require(/^[A-Z][A-Z0-9_]*$/.test(name) && !/^["']/.test(value));
    env[name] = value;
  }
  require(env.SUPABASE_URL === "https://api.commonswarm.com" && env.SUPABASE_ANON_KEY);
  const session = JSON.parse(Deno.readTextFileSync(`${controlRoot}/human-session.json`));
  require(Object.keys(session).sort().join(",") === "access_token");
  require(typeof session.access_token === "string" && session.access_token.length >= 32);
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { fetch: (input, init) => fetch(input, {
      ...init, redirect: "error", signal: AbortSignal.timeout(30_000),
    }) },
  });
  const [userResult, claimsResult] = await Promise.all([
    client.auth.getUser(session.access_token), client.auth.getClaims(session.access_token),
  ]);
  const user = userResult.data.user, claims = claimsResult.data?.claims;
  require(!userResult.error && !claimsResult.error && user && claims);
  require(user.email_confirmed_at != null && claims.sub === user.id);
  require(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(user.id));
  const { withDatabaseTls } = await import(`${releaseRoot}/supabase/functions/_shared/database-options.ts`);
  const url = env.SWARM_DATABASE_URL ?? env.SUPABASE_DB_URL;
  require(url);
  const tls = withDatabaseTls({ prepare: false, max: 1, idle_timeout: 3, connect_timeout: 5,
    statement_timeout: 10_000, query_timeout: 10_000 },
    env.SWARM_DATABASE_TLS_CA_B64);
  const edge = postgres(url, tls);
  pools.push(edge);
  const oauth = JSON.parse(Deno.readTextFileSync(`${controlRoot}/oauth-database.json`));
  require(Object.keys(oauth).sort().join(",") === "database,host,password,port,ssl_ca,user");
  for (const name of ["host", "database", "user", "password"]) {
    require(typeof oauth[name] === "string" && oauth[name]);
  }
  require(Number.isSafeInteger(oauth.port) && oauth.port >= 1 && oauth.port <= 65535);
  require(typeof oauth.ssl_ca === "string" && oauth.ssl_ca.includes("-----BEGIN CERTIFICATE-----"));
  const provider = postgres({ host: oauth.host, port: oauth.port, database: oauth.database,
    username: oauth.user, password: oauth.password,
    ssl: { ca: oauth.ssl_ca, rejectUnauthorized: true },
    application_name: "commonswarm-hm37-control", max: 2,
    statement_timeout: 10_000, query_timeout: 10_000, connect_timeout: 5 });
  pools.push(provider);
  const workspace = "c2ea0541-f56d-4c73-bf71-56c5405c4934";
  await edge.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    const [identity] = await tx`SELECT inet_server_addr() = inet '172.31.0.10'
      AND current_setting('transaction_read_only') = 'on'
      AND NOT pg_is_in_recovery()
      AND (SELECT count(*) FROM pg_db_role_setting AS setting
        CROSS JOIN LATERAL unnest(setting.setconfig) AS item
        WHERE setting.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND setting.setrole = 0 AND item = 'commonswarm.stack_identity=n-db-target-v1') = 1 AS ok`;
    require(identity?.ok === true);
    await tx`SELECT set_config('role', 'swarm_command', true),
      set_config('search_path', 'swarm, commonswarm_oauth, pg_catalog', true),
      set_config('lock_timeout', '5s', true), set_config('statement_timeout', '10s', true)`;
    const [access] = await tx`SELECT EXISTS (
      SELECT 1 FROM swarm.workspaces w JOIN swarm.memberships m ON m.workspace_id = w.workspace_id
      WHERE w.workspace_id = ${workspace}::uuid AND w.archived_at IS NULL
        AND m.user_id = ${user.id}::uuid AND m.revoked_at IS NULL) AS allowed,
      (SELECT count(*)::int FROM swarm.agent_principals
        WHERE workspace_id = ${workspace}::uuid AND revoked_at IS NULL) AS live_principals,
      EXISTS (SELECT 1 FROM swarm.agent_principals WHERE workspace_id = ${workspace}::uuid
        AND name = ${"hm37-hosted-" + suffix}) AS name_taken`;
    require(access?.allowed === true && access.live_principals < 50 && access.name_taken === false);
  });
  await provider.begin(async (tx) => {
    await tx`SET TRANSACTION READ ONLY`;
    const [identity] = await tx`SELECT inet_server_addr() = inet '172.31.0.10'
      AND current_user = ${oauth.user} AND current_database() = ${oauth.database}
      AND current_setting('transaction_read_only') = 'on'
      AND EXISTS (SELECT 1 FROM pg_stat_ssl WHERE pid = pg_backend_pid() AND ssl) AS ok`;
    require(identity?.ok === true);
    await tx`SELECT model, artifact_id_hash, payload, consumed_at, grant_id, expires_at
      FROM commonswarm_oauth.provider_artifacts WHERE false`;
  });
} catch {
  failed = true;
} finally {
  const closed = await Promise.allSettled(pools.map((pool) => pool.end({ timeout: 2 })));
  if (closed.some((result) => result.status === "rejected")) failed = true;
}
if (failed) {
  console.error("STOP: live hosted runtime dependency preflight failed");
  Deno.exit(1);
}
TS
)
```

Run only after the migration and edge gates that section 9 observes are live.
The suffix comes from the existing root-owned window file. Sourcing the edge
environment exports secrets only to the Deno process; the command line remains
secret-free. The one stdout document is safe evidence. The private journal is
never copied.

```sh
# step: hm37-hosted-open-ack-control
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash; no container or service is restarted.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  case "$WINDOW_PRINCIPAL_SUFFIX" in
    [0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) false ;;
  esac
  set -a
  . /home/commonswarm/.env
  set +a
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno run --cached-only --no-lock \
    --config "$CONTROL_ROOT/hm37-open-ack-deno.json" \
    --allow-env --allow-net \
    --allow-read="$RELEASE_ROOT,$CONTROL_ROOT" \
    --allow-write="$CONTROL_ROOT/journal" \
    "$CONTROL_ROOT/hm37-open-ack-control.ts" \
    --release-root "$RELEASE_ROOT" \
    --journal-dir "$CONTROL_ROOT/journal" \
    --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 \
    --human-session-file "$CONTROL_ROOT/human-session.json" \
    --oauth-database-config-file "$CONTROL_ROOT/oauth-database.json" \
    >"$PROOF_DIR/hm37-hosted-check-control.json"
  chmod 0600 "$PROOF_DIR/hm37-hosted-check-control.json"
)
```

If the shell is lost, rerun cleanup from the recorded private journal. This is
idempotent and still verifies complete revocation before returning zero.

```sh
# step: hm37-hosted-control-cleanup-only
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after a lost shell or interrupted control.
(
  set -euo pipefail
  umask 077
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  RELEASE_ROOT="/home/commonswarm/edge/releases/$SHA"
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  JOURNAL="$CONTROL_ROOT/journal/hm37-open-ack-${WINDOW_PRINCIPAL_SUFFIX}.journal.json"
  test "$(stat -c %a "$JOURNAL")" = 600
  set -a
  . /home/commonswarm/.env
  set +a
  DENO_NO_UPDATE_CHECK=1 DENO_DIR="$CONTROL_ROOT/deno-cache" /usr/local/bin/deno run --cached-only --no-lock \
    --config "$CONTROL_ROOT/hm37-open-ack-deno.json" \
    --allow-env --allow-net \
    --allow-read="$RELEASE_ROOT,$CONTROL_ROOT" \
    --allow-write="$CONTROL_ROOT/journal" \
    "$CONTROL_ROOT/hm37-open-ack-control.ts" \
    --release-root "$RELEASE_ROOT" \
    --human-session-file "$CONTROL_ROOT/human-session.json" \
    --oauth-database-config-file "$CONTROL_ROOT/oauth-database.json" \
    --cleanup-only "$JOURNAL" \
    >"$PROOF_DIR/hm37-hosted-cleanup-recovery.json"
  chmod 0600 "$PROOF_DIR/hm37-hosted-cleanup-recovery.json"
)
```

After copy-back on every successful close and every rollback/abort tail, remove
the per-window Deno cache and return `/usr/local/bin/deno` to the measured absent
baseline. An unknown or changed file is never removed.

```sh
# step: hm37-deno-remove
# readonly: no
# host: box /bin/bash 5.2 as root
# Runs on yulan-vps-1 as Anvil under sudo -n -i bash after copy-back on close or rollback.
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  DENO_PATH=/usr/local/bin/deno
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  DENO_DIR="$CONTROL_ROOT/deno-cache"
  case "$DENO_DIR" in
    "/home/commonswarm/edge/controls/${SHA}-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z/deno-cache) ;;
    *) false ;;
  esac
  RECORDED_DENO_SHA256=${DENO_INSTALLED_BINARY_SHA256:-}
  if [ -z "$RECORDED_DENO_SHA256" ]; then
    if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
      printf 'STOP: %s exists but window.env has no installed Deno sha256; refusing to remove an unknown file\n' \
        "$DENO_PATH" >&2
      exit 1
    fi
    if [ -e "$DENO_DIR" ] || [ -L "$DENO_DIR" ]; then
      printf 'STOP: %s exists but window.env has no installed Deno sha256; refusing to remove an unknown path\n' \
        "$DENO_DIR" >&2
      exit 1
    fi
    printf 'deno_remove=%q\n' not-installed >>"$PROOF_DIR/window.env"
    exit 0
  fi
  case "$RECORDED_DENO_SHA256" in (*[!0-9a-f]*|'') false ;; esac
  test "${#RECORDED_DENO_SHA256}" -eq 64
  if [ -e "$DENO_PATH" ] || [ -L "$DENO_PATH" ]; then
    test -f "$DENO_PATH"
    test ! -L "$DENO_PATH"
    test "$(sha256sum "$DENO_PATH" | awk '{print $1}')" = "$RECORDED_DENO_SHA256"
    rm -f -- "$DENO_PATH"
  fi
  test ! -e "$DENO_PATH"
  test ! -L "$DENO_PATH"
  if [ -e "$DENO_DIR" ] || [ -L "$DENO_DIR" ]; then
    test -d "$DENO_DIR"
    test ! -L "$DENO_DIR"
    find "$DENO_DIR" -xdev -depth -delete
  fi
  test ! -e "$DENO_DIR"
  printf "DENO_REMOVED='1'\n" >>"$PROOF_DIR/window.env"
)
```


## 4. Hosted assertions and live revoke control

The hosted harness is the LIVE disposable grant-and-seat revoke control on
Cold Agent Test. It creates a disposable grant and seat through released
authority entry points, exercises open/ACK, revokes the seat and grant, and
then reads back seat, handle, principal, provider-family and token state. This
must pass before any customer can have a connection.

```sh
# step: hm37b-live-revoke-readback
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  python3 - "$PROOF_DIR/hm37-hosted-check-control.json"     >"$PROOF_DIR/hm37-revocation-readback.json" <<'PY'
import json, sys, uuid
source = json.load(open(sys.argv[1]))
assert source["ok"] is True and source["mode"] == "control"
assert source["workspace_id"] == "c2ea0541-f56d-4c73-bf71-56c5405c4934"
for field in ("grant_id", "seat_id", "principal_id"):
    uuid.UUID(source[field])
cleanup = source["cleanup"]
expected = {
    "seat_revoked": True,
    "handle_revoked": True,
    "principal_revoked": True,
    "grant_revoked": True,
    "active_agent_tokens": 0,
    "provider_family_active": False,
    "active_provider_artifacts": 0,
    "authorization_refused": True,
    "open_refused": True,
    "ack_refused": True,
}
for key, value in expected.items():
    assert cleanup[key] == value, (key, cleanup[key])
assertions = source["assertions"]
required = {
    "hosted.cleanup-complete",
    "hosted.visibility-confined",
    "hosted.public-human-bearer-refusal",
    "hosted.seat-handle-alone-refusal",
}
assert required <= set(assertions)
print(json.dumps({
    "pass": True,
    "workspace_id": source["workspace_id"],
    "grant_id": source["grant_id"],
    "seat_id": source["seat_id"],
    "principal_id": source["principal_id"],
    "assertion_ids": sorted(required),
    "cleanup": expected,
}, indent=2))
PY
  chmod 0600 "$PROOF_DIR/hm37-revocation-readback.json"
)
```

```sh
# step: hm37b-failure-dispatch
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  FAILURE_JSON="$PROOF_DIR/hm37-hosted-cleanup-recovery.json"
  test -f "$FAILURE_JSON"
  python3 - "$FAILURE_JSON" >"$PROOF_DIR/hm37b-failure-action.txt" <<'PY'
import json, sys
value = json.load(open(sys.argv[1]))
assertion_id = value.get("error", {}).get("assertion_id")
if assertion_id is None and value.get("ok") is True:
    assertion_id = "control.harness"
mapping = {
    "control.harness": ("control", "cleanup-only"),
    "hosted.public-unauthenticated-refusal": ("S1", "full-rollback"),
    "hosted.cleanup-complete": ("S2", "full-rollback"),
    "hosted.visibility-confined": ("S4", "full-rollback"),
    "hosted.public-human-bearer-refusal": ("S5", "full-rollback"),
    "hosted.seat-handle-alone-refusal": ("S5", "full-rollback"),
    "hosted.concurrent-open-single-batch": ("control", "cleanup-only"),
    "hosted.ack-a-commits-cursor": ("control", "cleanup-only"),
    "hosted.repeat-ack-idempotent": ("control", "cleanup-only"),
    "hosted.ack-b-empty-open": ("control", "cleanup-only"),
    "hosted.migration-functional-proof": ("control", "cleanup-only"),
}
classification, action = mapping.get(assertion_id, ("unknown", "cleanup-then-stop"))
print(f"assertion_id={assertion_id}")
print(f"class={classification}")
print(f"action={action}")
if classification == "unknown":
    raise SystemExit(2)
PY
  chmod 0600 "$PROOF_DIR/hm37b-failure-action.txt"
)
```

For `full-rollback`, execute complete `runbook-42` to restore
`72c57e0d76d0aa86fe4f811a2cf51499919fed20`, verify it healthy and DARK, then
run the reserved schema block only if the pre-given
`SCHEMA_ROLLBACK_APPROVAL=yes`. That input authorizes only an attempt: the
block independently verifies the previous edge and its own cursor/batch counts.
A nonempty count is STOP whatever the input says: do not run the schema
inverse; record and report it. `cleanup-only` leaves
`eb2a87ac…` live and DARK. This is the block-owned action map; no HezLead
classification is requested during B.

```sh
# step: hm37b-outgoing-log-review
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  : "${OUTGOING_LOG:?exact bounded outgoing log path required}"
  : "${SECRET_SCAN_RESULT:?exact secret-scan result file required}"
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  test -f "$OUTGOING_LOG"
  test ! -L "$OUTGOING_LOG"
  test "$(stat -c '%U:%G:%a' "$OUTGOING_LOG")" = root:root:600
  test -f "$SECRET_SCAN_RESULT"
  SCAN="$(sed -n '1p' "$SECRET_SCAN_RESULT")"
  case "$SCAN" in
    PASS) printf 'outgoing_log=copy-approved\n' >"$PROOF_DIR/hm37b-log-disposition.txt" ;;
    FAIL)
      printf 'outgoing_log=retained-on-box-not-copied\n'         >"$PROOF_DIR/hm37b-log-disposition.txt"
      sed -i "\|$(basename "$OUTGOING_LOG")|d" "$PROOF_DIR/copy-back.list"
      ;;
    *) false ;;
  esac
  chmod 0600 "$PROOF_DIR/hm37b-log-disposition.txt"
)
```

A failed scan therefore records the omission, leaves the log on the box at
0600, and does not stop B. Run this block only on the full-rollback tail after
`runbook-42` has captured an outgoing log; the successful path has no outgoing
container and skips it.

## 5. Automatic closure

```sh
# step: hm37b-protected-cleanup
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  CONTROL_ROOT="/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  STAGING_ROOT="/run/commonswarm-hm37-${WINDOW_ID}"
  case "$CONTROL_ROOT" in
    "/home/commonswarm/edge/controls/${SHA}-"[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  case "$STAGING_ROOT" in
    /run/commonswarm-hm37-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) false ;;
  esac
  if [ -e "$CONTROL_ROOT" ]; then
    test -d "$CONTROL_ROOT"
    test ! -L "$CONTROL_ROOT"
    find "$CONTROL_ROOT" -xdev -depth -delete
  fi
  if [ -e "$STAGING_ROOT" ]; then
    test -d "$STAGING_ROOT"
    test ! -L "$STAGING_ROOT"
    find "$STAGING_ROOT" -xdev -depth -delete
  fi
  test ! -e "$CONTROL_ROOT"
  test ! -e "$STAGING_ROOT"
)
```

```sh
# step: hm37b-close-readback
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  test "$(readlink -f /home/commonswarm/edge/current)" =     "/home/commonswarm/edge/releases/$SHA"
  test "$(cat /home/commonswarm/edge/current/RELEASE_SHA)" = "$SHA"
  test "$(docker inspect --format '{{.State.Health.Status}}' commonswarm-edge-edge-runtime-1)" = healthy
  docker exec commonswarm-edge-edge-runtime-1 deno eval     'Deno.exit(Deno.env.get("SWARM_MCP_PUBLIC_ENABLED") === "1" ? 1 : 0)'
  test ! -e /usr/local/bin/deno
  test ! -e "/home/commonswarm/edge/controls/${SHA}-${WINDOW_ID}"
  test ! -e "/run/commonswarm-hm37-${WINDOW_ID}"
  python3 - "$PROOF_DIR/hm37-hosted-check-control.json"     "$PROOF_DIR/hm37-revocation-readback.json"     >"$PROOF_DIR/hm37-close-readback.txt" <<'PY'
import json, sys
control, revoke = (json.load(open(path)) for path in sys.argv[1:])
assert control["ok"] is True
assert revoke["pass"] is True
print("release_sha=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922")
print("edge_live=true")
print("edge_dark=true")
print("hosted_controls=true")
print("live_grant_and_seat_revoke=true")
print("cleanup=true")
print("deno_removed=true")
print("protected_staging_removed=true")
print("close=PASS")
PY
  chmod 0600 "$PROOF_DIR/hm37-close-readback.txt"
)
```

A passing `hm37b-close-readback` automatically authorizes close. A failed
readback is STOP and report; it never produces a success-shaped receipt.

```sh
# step: hm37b-copyback
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil; read-only ssh child on box
(
  set -euo pipefail
  umask 077
  : "${RELEASE_SHA:?named release SHA required}"
  . "/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  EVIDENCE_DIR="$PWD/docs/evidence/$(date -u +%F)-release-${RELEASE_SHA:0:12}-${WINDOW_ID}"
  mkdir -p -m 0700 "$EVIDENCE_DIR"
  FILES='hm37-worker-boundary.txt hm37-hosted-control-inputs.txt hm37-hosted-check-control.json hm37-revocation-readback.json hm37-close-readback.txt'
  COPYBACK_TEMP="$(mktemp -d /tmp/commonswarm-hm37b-copyback.XXXXXX)"
  case "$COPYBACK_TEMP" in /tmp/commonswarm-hm37b-copyback.??????) ;; *) false ;; esac
  trap 'status=$?; find "$COPYBACK_TEMP" -depth -delete; exit "$status"' EXIT
  COPYBACK_ARCHIVE="$COPYBACK_TEMP/evidence.tar"
  test ! -e "$COPYBACK_ARCHIVE"
  ssh ops@100.115.66.74 "sudo -n -i /bin/bash -s -- '$RELEASE_SHA'" \
    >"$COPYBACK_ARCHIVE" <<'BOX'
(
  set -euo pipefail
  RELEASE_SHA="$1"
  case "$RELEASE_SHA" in (*[!0-9a-f]*|'') false ;; esac
  test "${#RELEASE_SHA}" -eq 40
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$RELEASE_SHA"
  FILES='hm37-worker-boundary.txt hm37-hosted-control-inputs.txt hm37-hosted-check-control.json hm37-revocation-readback.json hm37-close-readback.txt'
  for FILE in $FILES; do
    case "$FILE" in */*|.*|'') false ;; esac
    test -f "$PROOF_DIR/$FILE"
    test ! -L "$PROOF_DIR/$FILE"
  done
  tar -C "$PROOF_DIR" -cf - $FILES
)
BOX
  test -s "$COPYBACK_ARCHIVE"
  test "$(env COPYFILE_DISABLE=1 tar --no-xattrs -tf "$COPYBACK_ARCHIVE" | LC_ALL=C sort)" = \
    "$(printf '%s\n' $FILES | LC_ALL=C sort)"
  env COPYFILE_DISABLE=1 tar --no-xattrs -xf "$COPYBACK_ARCHIVE" -C "$EVIDENCE_DIR"
  for FILE in $FILES; do
    test -f "$EVIDENCE_DIR/$FILE"
    chmod 0600 "$EVIDENCE_DIR/$FILE"
  done
  (cd "$EVIDENCE_DIR" && shasum -a 256 $FILES) \
    >"$EVIDENCE_DIR/hm37b-copyback.sha256"
  chmod 0600 "$EVIDENCE_DIR/hm37b-copyback.sha256"
  find "$COPYBACK_TEMP" -depth -delete
  test ! -e "$COPYBACK_TEMP"
  trap - EXIT
)
```

```sh
# step: hm37b-manifest-close
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  SHA=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
  PROOF_DIR="/home/commonswarm/stack/release-proofs/$SHA"
  . "$PROOF_DIR/window.env"
  grep -qFx 'close=PASS' "$PROOF_DIR/hm37-close-readback.txt"
  test ! -e "${PROOF_DIR}.closed-window-${WINDOW_ID}"
  mv "$PROOF_DIR" "${PROOF_DIR}.closed-window-${WINDOW_ID}"
  test -d "${PROOF_DIR}.closed-window-${WINDOW_ID}"
  test ! -e "$PROOF_DIR"
)
```

```sh
# step: hm37b-mac-cleanup
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  : "${RELEASE_SHA:?named release SHA required}"
  : "${HUMAN_SESSION_SOURCE:?exact protected session path required}"
  OPEN_RECEIPT="/tmp/commonswarm-hm37b-open-${RELEASE_SHA}.env"
  . "$OPEN_RECEIPT"
  test -f "$HUMAN_SESSION_SOURCE"
  test ! -L "$HUMAN_SESSION_SOURCE"
  test "$(stat -f %Lp "$HUMAN_SESSION_SOURCE")" = 600
  rm -f -- "$HUMAN_SESSION_SOURCE"
  rm -f -- "$OPEN_RECEIPT"
  test ! -e "$HUMAN_SESSION_SOURCE"
  test ! -e "$OPEN_RECEIPT"
)
```

The successful order is:

```text
hm37b-human-preflight hm37b-hosted-auth-dependency-preflight
hm37b-deno-artifact-dependency-preflight hm37b-open-inputs hm37b-box-open hm37b-go-record
runbook-14 runbook-15 runbook-16 runbook-17
hm37b-control-review hm37-hosted-human-session-input hm37b-stage-transfer
hm37-validate-local-credential hm37-deno-install hm37-hosted-control-stage
hm37b-hosted-runtime-dependency-preflight
hm37-hosted-open-ack-control hm37b-live-revoke-readback hm37-deno-remove
runbook-60 hm37b-protected-cleanup hm37b-close-readback hm37b-copyback
hm37b-manifest-close
hm37b-mac-cleanup
```

On interruption after a journal exists, run
`hm37-hosted-control-cleanup-only`, `hm37b-failure-dispatch`, the mapped
edge action, `hm37-deno-remove`, the applicable readback, and close only when
that readback passes. No B step enables MCP or starts lane 8.
