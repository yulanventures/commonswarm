# CommonSwarm site release — HM lane 8

**Release:** `4d6a06509f9abf1aefac8c88ec00280d025df673`

**Baseline source:** `109e4db75f673ddd8003662dc1882159dd72b1b2`

**Baseline release:** `20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5`
**Status:** executable plan; no operation recorded here has run.

Anvil runs every marked block on the Mac mini under HezLead's direction. Mac
blocks use `/bin/bash` 3.2. They never assign `HOME`, print a credential, run
Docker, deploy a second SHA, change Caddy or DNS, or restart a service.

Lane 8 starts only after HM37 WINDOW A closes with
`eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922` live and hosted MCP dark. It does
not wait for WINDOW B. The site SHA is an ancestor of that edge SHA. While MCP
is dark, no hosted connection exists, so customers see Connected apps empty and
cannot reach a revoke. The live grant-and-seat revoke control moves to HM37
WINDOW B before MCP enable; lane 8 keeps only the headless-browser empty-state
control.

## 1. Named prompt inputs

Credential values are never prompt inputs. A value-bearing file is named only
by an absolute path and is read without printing it.

| Name | Supplier and meaning | Exact format |
|---|---|---|
| `HM37_A_CLOSE_RECEIPT` | Anvil, produced only by WINDOW A | absolute regular non-symlink mode-`0600` WINDOW A close receipt; the only A-to-lane-8 handoff |
| `SITE_APPROVER` | HezLead | `HezLead` |
| `SITE_PLAN_COMMIT` | HezLead, reviewed plan commit | 40 lowercase hex characters |
| `SITE_RELEASE_SHA` | HezLead/Anvil, reviewed release | `4d6a06509f9abf1aefac8c88ec00280d025df673` |
| `SITE_BASE_SHA` | Anvil, full SHA from baseline receipt | `109e4db75f673ddd8003662dc1882159dd72b1b2` |
| `SITE_PROMPT_NUMBER` | HezLead | positive decimal integer |
| `SITE_RELEASE_REPO` | Anvil, isolated checkout destination | absolute task-owned empty directory before `site-00-source-checkout` |
| `SITE_EVIDENCE` | Anvil, protected evidence destination | absolute task-owned empty mode-`0700` directory before `site-01` |
| `SITE_BUILD_ENV_OP_REFERENCE` | HezLead/Anvil, approved 1Password document reference | `op://Yulan Ventures Infra/ITEM/FIELD` with nonempty item and field segments; no credential value |
| `OP_SERVICE_ACCOUNT_TOKEN_FILE` | Anvil, existing protected 1Password service-account token file | absolute regular non-symlink mode-`0600` file; never a credential value in the prompt |

```prompt-inputs
{"name":"HM37_A_CLOSE_RECEIPT","format":"abs-file:hm37-a-close-receipt","supplier":"Anvil","meaning":"Protected successful Window A close receipt."}
{"name":"SITE_APPROVER","format":"literal:HezLead","supplier":"HezLead","meaning":"Approval identity for the lane 8 release."}
{"name":"SITE_PLAN_COMMIT","format":"sha40","supplier":"HezLead","meaning":"Reviewed commit containing the lane 8 plan."}
{"name":"SITE_RELEASE_SHA","format":"literal:4d6a06509f9abf1aefac8c88ec00280d025df673","supplier":"HezLead and Anvil","meaning":"Reviewed site release commit."}
{"name":"SITE_BASE_SHA","format":"literal:109e4db75f673ddd8003662dc1882159dd72b1b2","supplier":"Anvil","meaning":"Measured full baseline source commit."}
{"name":"SITE_PROMPT_NUMBER","format":"decimal-positive","supplier":"HezLead","meaning":"Positive approval-record prompt number."}
{"name":"SITE_RELEASE_REPO","format":"abs-dir","supplier":"Anvil","meaning":"Task-owned empty directory used for the exact-SHA checkout."}
{"name":"SITE_EVIDENCE","format":"abs-dir","supplier":"Anvil","meaning":"Task-owned protected evidence directory."}
{"name":"SITE_BUILD_ENV_OP_REFERENCE","format":"literal:op://Yulan Ventures Infra/CommonSwarm Site/public-build-env","supplier":"HezLead and Anvil","meaning":"Approved 1Password document reference; never a credential value."}
{"name":"OP_SERVICE_ACCOUNT_TOKEN_FILE","format":"abs-file:op-service-account-token","supplier":"Anvil","meaning":"Protected token file used by the noninteractive 1Password service-account workflow."}
```
The WINDOW A close receipt contains these exact public lines:

```text
release_sha=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922
edge_live=true
edge_dark=true
prep_seats_revoked=true
prep_active_tokens=0
close=PASS
```

## 2. Preparation and window open

```sh
# step: site-00-source-checkout — Mac mini /bin/bash 3.2; Anvil; create isolated exact-SHA checkout
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-00-source-checkout: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${SITE_RELEASE_REPO:?named input missing}"
  : "${SITE_RELEASE_SHA:?named input missing}"
  : "${SITE_BASE_SHA:?named input missing}"
  case "$SITE_RELEASE_REPO" in /*) ;; *) exit 1 ;; esac
  test "$SITE_RELEASE_SHA" = 4d6a06509f9abf1aefac8c88ec00280d025df673
  test "$SITE_BASE_SHA" = 109e4db75f673ddd8003662dc1882159dd72b1b2
  test -d "$SITE_RELEASE_REPO" && test ! -L "$SITE_RELEASE_REPO"
  test -z "$(find "$SITE_RELEASE_REPO" -mindepth 1 -maxdepth 1 -print -quit)"
  git clone --no-checkout https://github.com/yulanventures/commonswarm.git "$SITE_RELEASE_REPO"
  git -C "$SITE_RELEASE_REPO" checkout --detach "$SITE_RELEASE_SHA"
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test "$(git -C "$SITE_RELEASE_REPO" remote get-url origin)" = https://github.com/yulanventures/commonswarm.git
  test -z "$(git -C "$SITE_RELEASE_REPO" status --short --untracked-files=all)"
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse --verify "${SITE_BASE_SHA}^{commit}")" = "$SITE_BASE_SHA"
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$SITE_BASE_SHA" "$SITE_RELEASE_SHA"
)
```

`site-01` refuses existing window state, an active release process, a changed
baseline, wrong SSH identity, missing write access, or failed box HTTPS/DNS. It
reads the box UTC clock to the second, calculates end as start plus four hours,
and derives the ID. Nobody types a time or ID.

```sh
# step: site-01 — Mac mini /bin/bash 3.2; Anvil; open from box clock and verify baseline/access
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-01: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${HM37_A_CLOSE_RECEIPT:?named input missing}"
  : "${SITE_RELEASE_REPO:?named input missing}"
  : "${SITE_BASE_SHA:?named input missing}"
  : "${SITE_RELEASE_SHA:?named input missing}"
  : "${SITE_EVIDENCE:?named input missing}"
  : "${SITE_BUILD_ENV_OP_REFERENCE:?named input missing}"
  : "${OP_SERVICE_ACCOUNT_TOKEN_FILE:?named input missing}"
  test "$SITE_RELEASE_SHA" = 4d6a06509f9abf1aefac8c88ec00280d025df673
  test "$SITE_BASE_SHA" = 109e4db75f673ddd8003662dc1882159dd72b1b2
  for input_path in "$HM37_A_CLOSE_RECEIPT" "$SITE_RELEASE_REPO" "$SITE_EVIDENCE"; do
    case "$input_path" in /*) ;; *) exit 1 ;; esac
  done
  test -d "$SITE_EVIDENCE" && test ! -L "$SITE_EVIDENCE"
  test -z "$(find "$SITE_EVIDENCE" -mindepth 1 -maxdepth 1 -print -quit)"
  test "$(stat -f '%Lp' "$SITE_EVIDENCE")" = 700
  test ! -e "$HOME/.commonswarm-site-window.env"
  test -f "$HM37_A_CLOSE_RECEIPT" && test ! -L "$HM37_A_CLOSE_RECEIPT"
  test "$(stat -f '%Lp' "$HM37_A_CLOSE_RECEIPT")" = 600
  case "$SITE_BUILD_ENV_OP_REFERENCE" in 'op://Yulan Ventures Infra/'?*/?*) ;; *) exit 1 ;; esac
  case "$SITE_BUILD_ENV_OP_REFERENCE" in *$'\n'*) exit 1 ;; esac
  case "$OP_SERVICE_ACCOUNT_TOKEN_FILE" in /*) ;; *) exit 1 ;; esac
  test -f "$OP_SERVICE_ACCOUNT_TOKEN_FILE" && test ! -L "$OP_SERVICE_ACCOUNT_TOKEN_FILE"
  test "$(stat -f '%Lp' "$OP_SERVICE_ACCOUNT_TOKEN_FILE")" = 600
  for expected in \
    release_sha=eb2a87ac4b5ae357ebc6f1ab45ed37fffaaa4922 \
    edge_live=true edge_dark=true prep_seats_revoked=true \
    prep_active_tokens=0 close=PASS; do
    grep -qFx "$expected" "$HM37_A_CLOSE_RECEIPT"
  done
  if pgrep -f '[d]eploy/site/deploy.sh|[f]inalize-release.sh' >/dev/null 2>&1; then
    printf '%s\n' 'STOP: another local site release process exists' >&2
    exit 1
  fi

  box_open=$(ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-01: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
root=/srv/commonswarm/site
test "$(id -un)" = commonswarm
test ! -e /tmp/commonswarm-site-window.env
test -z "$(find "$root" -maxdepth 1 \( -type f -o -type l \) -name 'current.next*' -print)"
test -z "$(find "$root/releases" -maxdepth 1 \( -type d -o -type l \) -name '.site-window-pin-*' -print)"
if pgrep -f '[d]eploy/site/deploy.sh|[f]inalize-release.sh' >/dev/null 2>&1; then
  printf '%s\n' 'STOP: another box site release process exists' >&2
  exit 1
fi
test -w "$root" && test -w "$root/releases"
previous=$(readlink -f "$root/current")
test "$previous" = "$root/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5"
test -f "$previous/app/index.html" && test -f "$previous/download/index.html"
start=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
end=$(date -u -d "$start + 4 hours" '+%Y-%m-%dT%H:%M:%SZ')
printf 'SITE_WINDOW_START_UTC=%s\nSITE_WINDOW_END_UTC=%s\n' "$start" "$end"
printf 'PREVIOUS_RELEASE=%s\n' "$previous"
sha256sum "$previous/app/index.html" "$previous/download/index.html"
python3 - <<'PY'
import urllib.request
UA = "commonswarm-release-probe/1.0"
for url, media in (
    ("https://commonswarm.com/app", "text/html"),
    ("https://api.commonswarm.com/functions/v1/h0/agent-doc/smoke", "application/json"),
):
    request = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept-Encoding": "identity", "Range": "bytes=0-0",
    })
    with urllib.request.urlopen(request, timeout=15) as response:
        assert response.status in (200, 206)
        assert response.headers.get_content_type() == media
        response.read(1)
print("BOX_EGRESS=PASS user_agent=" + UA)
PY
BOX
  )
  start=$(printf '%s\n' "$box_open" | sed -n 's/^SITE_WINDOW_START_UTC=//p')
  end=$(printf '%s\n' "$box_open" | sed -n 's/^SITE_WINDOW_END_UTC=//p')
  previous=$(printf '%s\n' "$box_open" | sed -n 's/^PREVIOUS_RELEASE=//p')
  case "$start" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;; *) exit 1 ;;
  esac
  case "$end" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]Z) ;; *) exit 1 ;;
  esac
  python3 - "$start" "$end" <<'PY'
import datetime
import sys
start = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ")
end = datetime.datetime.strptime(sys.argv[2], "%Y-%m-%dT%H:%M:%SZ")
assert (end - start).total_seconds() == 14400
PY
  test "$previous" = /srv/commonswarm/site/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5
  SITE_WINDOW_ID=$(printf '%s' "$start" | tr -d ':-')
  case "$SITE_WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
  esac
  SITE_WINDOW_FILE="$HOME/.commonswarm-site-window.env"
  umask 077
  {
    printf 'SITE_WINDOW_START_UTC=%q\n' "$start"
    printf 'SITE_WINDOW_END_UTC=%q\n' "$end"
    printf 'SITE_WINDOW_ID=%q\n' "$SITE_WINDOW_ID"
    printf 'SITE_WINDOW_FILE=%q\n' "$SITE_WINDOW_FILE"
    printf 'SITE_EVIDENCE=%q\n' "$SITE_EVIDENCE"
    printf 'SITE_RELEASE_REPO=%q\n' "$SITE_RELEASE_REPO"
    printf 'SITE_RELEASE_SHA=%q\n' "$SITE_RELEASE_SHA"
    printf 'SITE_BASE_SHA=%q\n' "$SITE_BASE_SHA"
    printf 'SITE_BUILD_ENV_OP_REFERENCE=%q\n' "$SITE_BUILD_ENV_OP_REFERENCE"
    printf 'OP_SERVICE_ACCOUNT_TOKEN_FILE=%q\n' "$OP_SERVICE_ACCOUNT_TOKEN_FILE"
    printf 'HM37_A_CLOSE_RECEIPT=%q\n' "$HM37_A_CLOSE_RECEIPT"
  } >"$SITE_WINDOW_FILE"
  chmod 0600 "$SITE_WINDOW_FILE"
  printf '%s\n' "$box_open" >"$SITE_EVIDENCE/site-01-open.txt"
  chmod 0600 "$SITE_EVIDENCE/site-01-open.txt"
  scp "$SITE_WINDOW_FILE" commonswarm@yulan-vps-1:/tmp/commonswarm-site-window.env >/dev/null
)
```

## 3. Produced inputs and pre-switch gates

```sh
# step: site-00-a-close-ingest — Mac mini /bin/bash 3.2; Anvil; copy WINDOW A close receipt
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-00-a-close-ingest: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  test -f "$HM37_A_CLOSE_RECEIPT" && test ! -L "$HM37_A_CLOSE_RECEIPT"
  test "$(stat -f '%Lp' "$HM37_A_CLOSE_RECEIPT")" = 600
  install -m 0600 "$HM37_A_CLOSE_RECEIPT" "$SITE_EVIDENCE/hm37-a-close-receipt.txt"
  test "$(shasum -a 256 "$HM37_A_CLOSE_RECEIPT" | awk '{print $1}')" = \
    "$(shasum -a 256 "$SITE_EVIDENCE/hm37-a-close-receipt.txt" | awk '{print $1}')"
)
```

```sh
# step: site-00-build-env — Mac mini /bin/bash 3.2; Anvil; install and validate protected build settings
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-00-build-env: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test -z "${OP_SERVICE_ACCOUNT_TOKEN+x}"
  test -z "${OP_BIOMETRIC_UNLOCK_ENABLED:-}"
  if compgen -A variable OP_SESSION_ >/dev/null; then exit 1; fi
  test -f "$OP_SERVICE_ACCOUNT_TOKEN_FILE" && test ! -L "$OP_SERVICE_ACCOUNT_TOKEN_FILE"
  test "$(stat -f '%Lp' "$OP_SERVICE_ACCOUNT_TOKEN_FILE")" = 600
  SITE_BUILD_ENV_TEMP="$(mktemp -d /private/tmp/anvil-secret.XXXXXX)"
  case "$SITE_BUILD_ENV_TEMP" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
  trap 'status=$?; if ! rm -r -- "$SITE_BUILD_ENV_TEMP"; then printf "STOP: guarded cleanup refused %s; leave it for HezLead\n" "$SITE_BUILD_ENV_TEMP" >&2; exit 1; fi; exit "$status"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  SITE_BUILD_ENV_SOURCE="$SITE_BUILD_ENV_TEMP/site-build.env"
  test ! -e "$SITE_BUILD_ENV_SOURCE" && test ! -L "$SITE_BUILD_ENV_SOURCE"
  chmod 0700 "$SITE_BUILD_ENV_TEMP"
  python3 - "$OP_SERVICE_ACCOUNT_TOKEN_FILE" "$SITE_BUILD_ENV_OP_REFERENCE" "$SITE_BUILD_ENV_SOURCE" <<'PY'
import os,pathlib,subprocess,sys
token_file,reference,output=sys.argv[1:]
env=os.environ.copy()
assert not any(name.startswith('OP_SESSION_') for name in env)
env['OP_SERVICE_ACCOUNT_TOKEN']=pathlib.Path(token_file).read_text().strip()
assert env['OP_SERVICE_ACCOUNT_TOKEN']
result=subprocess.run(['op','read',reference,'--out-file',output],env=env,
                      stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
if result.returncode: raise SystemExit('STOP: service-account build-env read failed')
PY
  chmod 0600 "$SITE_BUILD_ENV_SOURCE"
  test -f "$SITE_BUILD_ENV_SOURCE" && test ! -L "$SITE_BUILD_ENV_SOURCE"
  test "$(stat -f '%Lp' "$SITE_BUILD_ENV_SOURCE")" = 600
  test ! -e site/.env
  for override in site/.env.local site/.env.production site/.env.production.local; do
    test ! -e "$override"
  done
  install -m 0600 "$SITE_BUILD_ENV_SOURCE" site/.env
  test "$(grep -Ec '^[A-Za-z_][A-Za-z0-9_]*=' site/.env)" -eq 3
  for name in PUBLIC_SUPABASE_URL PUBLIC_SUPABASE_ANON_KEY PUBLIC_H0_LINK_JOIN; do
    test "$(grep -Ec "^${name}=" site/.env)" -eq 1
  done
  node deploy/site/validate-site-env.mjs site/.env </dev/null
  node - <<'NODE' >"$SITE_EVIDENCE/site-00-build-env.txt"
const fs = require("node:fs");
const values = new Map(fs.readFileSync("site/.env", "utf8").split(/\r?\n/)
  .filter((line) => line.includes("=")).map((line) => {
    const at = line.indexOf("=");
    return [line.slice(0, at), line.slice(at + 1).replace(/^['"]|['"]$/g, "")];
  }));
if (values.get("PUBLIC_SUPABASE_URL") !== "https://api.commonswarm.com") process.exit(1);
if (values.get("PUBLIC_H0_LINK_JOIN") !== "1") process.exit(1);
const parts = (values.get("PUBLIC_SUPABASE_ANON_KEY") || "").split(".");
if (parts.length !== 3) process.exit(1);
const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
if (payload.role !== "anon") process.exit(1);
console.log("BUILD_ENV=PASS url=https://api.commonswarm.com role=anon h0=1");
NODE
  chmod 0600 "$SITE_EVIDENCE/site-00-build-env.txt"
  rm -r -- "$SITE_BUILD_ENV_TEMP"
  test ! -e "$SITE_BUILD_ENV_TEMP"
  trap - EXIT INT TERM
)
```

`site-02` produces the full site-only inventory from the full live base and
verifies the deletion guards at the release SHA. The stale deletion hold is
removed: `deploy.sh:47-116,242-254` and
`finalize-release.sh:35-106,160-215` contain the guards/call sites, while
`tests/p1-cli/site-deletion-safety.test.ts:65-122,183-221` contains refusal and
positive controls.

```sh
# step: site-02 — Mac mini /bin/bash 3.2; Anvil; exact source and guard reconciliation
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-02: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test "$SITE_RELEASE_SHA" = 4d6a06509f9abf1aefac8c88ec00280d025df673
  test "$SITE_BASE_SHA" = 109e4db75f673ddd8003662dc1882159dd72b1b2
  git merge-base --is-ancestor "$SITE_BASE_SHA" "$SITE_RELEASE_SHA"
  git diff --exit-code HEAD -- site deploy/site tests/p1-cli/site-deletion-safety.test.ts
  git show "$SITE_RELEASE_SHA:deploy/site/deploy.sh" | grep -q guarded_delete
  git show "$SITE_RELEASE_SHA:deploy/site/finalize-release.sh" | grep -q guarded_delete
  git show "$SITE_RELEASE_SHA:tests/p1-cli/site-deletion-safety.test.ts" | \
    grep -q 'deletes valid temporary paths'
  git show "$SITE_RELEASE_SHA:tests/p1-cli/site-deletion-safety.test.ts" | \
    grep -q 'with a valid-delete control'
  umask 077
  git log --format='%H %s' "$SITE_BASE_SHA..$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site-02-commits.txt"
  git diff --name-status "$SITE_BASE_SHA" "$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site-02-name-status.txt"
  git diff --numstat "$SITE_BASE_SHA" "$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site-02-numstat.txt"
  commit_count=$(git rev-list --count "$SITE_BASE_SHA..$SITE_RELEASE_SHA" -- site/)
  listed_commit_count=$(wc -l <"$SITE_EVIDENCE/site-02-commits.txt" | tr -d ' ')
  changed_count=$(git diff --name-only "$SITE_BASE_SHA" "$SITE_RELEASE_SHA" -- site/ | wc -l | tr -d ' ')
  listed_count=$(wc -l <"$SITE_EVIDENCE/site-02-name-status.txt" | tr -d ' ')
  test "$commit_count" -eq "$listed_commit_count"
  test "$changed_count" -eq "$listed_count"
  {
    printf 'base=%s\ntarget=%s\n' "$SITE_BASE_SHA" "$SITE_RELEASE_SHA"
    printf 'site_commit_count=%s\nsite_changed_file_count=%s\n' "$commit_count" "$changed_count"
    printf '%s\n' 'DELETE_GUARDS=PASS' 'SOURCE_RECONCILIATION=PASS'
  } >"$SITE_EVIDENCE/site-02-summary.txt"
)
```

### Fresh headless Chromium session

Browser controls use Playwright's bundled Chromium, headless with
`--password-store=basic`, and a fresh mode-0700 profile in the window's
`/private/tmp/anvil-secret.XXXXXX` directory. They never launch an installed
Google Chrome app, read a real profile, or initiate sign-in. This plan's browser
blocks are for a separately assigned browser release task; a read-only audit
must not execute them.

The preflight compares any authenticated web user with the CLI human and the
fixed expected ID, retains the original full-control assertions, and otherwise
selects REDUCED-CONTROL. A fresh signed-out profile therefore reports the
signed-in and mobile claims as NOT PROVED. A keychain dialog is STOP, never a
click-through or reduced-control fallback. Close stops only the task-owned
headless process and removes its private profile through guarded rm.

```sh
# step: site-03-browser-session-preflight — Mac mini /bin/bash 3.2; Anvil; fresh headless Chromium identity and workspace preflight
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-03-browser-session-preflight: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  umask 077
  test "$(command -v rm)" = "$HOME/.local/bin/rm"
  browser_root="$(mktemp -d /private/tmp/anvil-secret.XXXXXX)"
  case "$browser_root" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
  chrome_pid=
  cleanup_browser_preflight() {
    status=$?
    trap - EXIT
    if [ -n "$chrome_pid" ]; then kill "$chrome_pid" 2>/dev/null || true; wait "$chrome_pid" 2>/dev/null || true; fi
    if ! rm -r -- "$browser_root"; then
      printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$browser_root" >&2
      exit 1
    fi
    exit "$status"
  }
  trap cleanup_browser_preflight EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  chmod 0700 "$browser_root"
  profile="$browser_root/browser-profile"
  mkdir -m 0700 "$profile"
  # Resolve Playwright's bundled Chromium without launching it or /Applications.
  chrome="$(node - "$(npm root -g)/playwright" <<'NODE'
const { chromium } = require(process.argv[2]);
console.log(chromium.executablePath());
NODE
  )"
  case "$chrome" in "$HOME/Library/Caches/ms-playwright/"*) ;; *) exit 1 ;; esac
  test -x "$chrome"
  CLI_USER_ID="$(cswarm status \
    --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --json | jq -er '.identity.user_id')"
  test "$CLI_USER_ID" = d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc
  chrome_port=9335
  if lsof -nP -iTCP:"$chrome_port" -sTCP:LISTEN >/dev/null 2>&1; then exit 1; fi
  "$chrome" --headless --user-data-dir="$profile" --password-store=basic --use-mock-keychain \
    --remote-debugging-address=127.0.0.1 --remote-debugging-port="$chrome_port" \
    --no-first-run --no-default-browser-check about:blank \
    >"$browser_root/chromium-launch.log" 2>&1 &
  chrome_pid=$!
  port_file="$profile/DevToolsActivePort"
  tries=0
  while ! curl -fsS --max-time 1 "http://127.0.0.1:${chrome_port}/json/version" >/dev/null 2>&1; do
    tries=$((tries + 1)); test "$tries" -le 100; sleep 0.1
  done
  endpoint="http://127.0.0.1:$chrome_port"
  {
    printf 'SITE_BROWSER_ROOT=%q\n' "$browser_root"
    printf 'SITE_CHROME_BINARY=%q\n' "$chrome"
    printf 'SITE_CHROME_PROFILE=%q\n' "$profile"
    printf 'SITE_CHROME_PID=%q\n' "$chrome_pid"
    printf 'SITE_CHROME_ENDPOINT=%q\n' "$endpoint"
  } >>"$SITE_WINDOW_FILE"
  chmod 0600 "$SITE_WINDOW_FILE"
  export CLI_USER_ID SITE_EVIDENCE
  BU_CDP_URL="$endpoint" BH_TAB_MARKER=0 browser-harness >/dev/null 2>/dev/null <<'PY'
import json, os, pathlib, time
expected_user = "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"
start_workspace = "292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
control_workspace = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
new_tab("https://commonswarm.com/app")
wait_for_load()
def state():
    return js("""(() => {
      let userId='';
      for (const key of Object.keys(localStorage)) {
        if (!key.startsWith('sb-') || !key.endsWith('-auth-token')) continue;
        try { const value=JSON.parse(localStorage.getItem(key)); if(value?.user?.id) userId=value.user.id; } catch {}
      }
      const selected=document.querySelector('[data-workspace-list] [data-workspace-id][aria-checked="true"]');
      const workspaces=[...document.querySelectorAll('[data-workspace-list] [data-workspace-id]')];
      return {userId, selectedWorkspace:selected?.dataset.workspaceId||new URL(location.href).searchParams.get('w')||'',
        workspaceIds:workspaces.map(item=>item.dataset.workspaceId),
        display:document.querySelector('[data-rail-account]')?.textContent?.trim()||'',
        signedOut:!document.querySelector('[data-panel="auth"]')?.hasAttribute('hidden')};
    })()""")
observed=state()
signin_attempted=False
# A fresh profile has no inherited operator SSO. This view-only control never
# initiates sign-in. Signed-out state selects the existing reduced branch.
if js("/keychain/i.test(document.body?.innerText||'')"): raise SystemExit('STOP: keychain dialog')
challenge=js("/two-factor|2fa|verification code/i.test(document.body?.innerText||'')")
if observed.get("signedOut") or challenge:
    result={"branch":"REDUCED-CONTROL","signin_attempted":signin_attempted,
      "reason":"signed-out-or-interactive-challenge",
      "signed_in_connected_apps_load":"NOT PROVED","signed_in_empty_state":"NOT PROVED",
      "signed_in_no_creation_action":"NOT PROVED","signed_in_console_clean":"NOT PROVED",
      "mobile_320":"NOT PROVED","mobile_390":"NOT PROVED"}
else:
    if observed["display"] != "Ridgeio": raise SystemExit(1)
    if observed["userId"] != expected_user or observed["userId"] != os.environ["CLI_USER_ID"]: raise SystemExit(1)
    if observed["selectedWorkspace"] != start_workspace: raise SystemExit(1)
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    switched=js("""(() => { const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="c2ea0541-f56d-4c73-bf71-56c5405c4934"]');
      if(!target)return false; target.click(); return true; })()""")
    if not switched: raise SystemExit(1)
    for _ in range(60):
        time.sleep(.5); observed=state()
        if observed.get("selectedWorkspace")==control_workspace: break
    if observed.get("selectedWorkspace") != control_workspace: raise SystemExit(1)
    result={"branch":"FULL-CONTROL","account_label":"Ridgeio",
      "cli_user_id":expected_user,"web_user_id":expected_user,
      "start_workspace_id":start_workspace,"control_workspace_id":control_workspace}
path=pathlib.Path(os.environ["SITE_EVIDENCE"])/"site-03-browser-preflight.json"
path.write_text(json.dumps(result,sort_keys=True,indent=2)+"\n",encoding="utf-8"); path.chmod(0o600)
PY
  trap - EXIT INT TERM
)
```

`site-03` validates the build environment and the automatically selected
browser branch. No bearer is exported from Chrome and no revoke is exercised.

```sh
# step: site-03 — Mac mini /bin/bash 3.2; Anvil; environment and browser-branch validation
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-03: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test -f site/.env && test ! -L site/.env
  test "$(stat -f '%Lp' site/.env)" = 600
  node deploy/site/validate-site-env.mjs site/.env </dev/null
  test -f "$SITE_EVIDENCE/site-03-browser-preflight.json"
  test ! -L "$SITE_EVIDENCE/site-03-browser-preflight.json"
  test "$(stat -f '%Lp' "$SITE_EVIDENCE/site-03-browser-preflight.json")" = 600
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site-03-browser-preflight.json")"
  case "$branch" in FULL-CONTROL|REDUCED-CONTROL) ;; *) exit 1 ;; esac
)
```

### Retention pin

The pin is a metadata-preserving copy named
`.site-window-pin-$SITE_WINDOW_ID`. The helper's stale selector is
`"$releases"/*.tmp` (`finalize-release.sh:163`), and its five-release selectors
are `"$releases"/20??????T??????Z-????????????-????????????????`
(`finalize-release.sh:190,197`). The hidden pin matches neither. The block
proves relative paths, types, modes, link targets, and file hashes match before
the switch.

```sh
# step: site-03-pin-previous — Mac mini /bin/bash 3.2; Anvil; pin measured rollback tree
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-03-pin-previous: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$SITE_WINDOW_ID" \
    >"$SITE_EVIDENCE/site-03-pin.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-03-pin-previous: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
window_id=${1:-}
case "$window_id" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
esac
root=/srv/commonswarm/site
previous="$root/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5"
pin="$root/releases/.site-window-pin-$window_id"
test "$(readlink -f "$root/current")" = "$previous"
test -d "$previous" && test ! -L "$previous"
test ! -e "$pin" && test ! -L "$pin"
cp -a --reflink=auto "$previous" "$pin"
python3 - "$previous" "$pin" <<'PY'
import hashlib,json,os,pathlib,stat,sys
def manifest(root):
    root=pathlib.Path(root); rows=[]
    for path in sorted(root.rglob("*"),key=lambda item:item.relative_to(root).as_posix()):
        rel=path.relative_to(root).as_posix(); info=path.lstat(); mode=stat.S_IMODE(info.st_mode)
        if path.is_symlink(): rows.append((rel,"link",mode,os.readlink(path)))
        elif path.is_dir(): rows.append((rel,"dir",mode,""))
        elif path.is_file(): rows.append((rel,"file",mode,hashlib.sha256(path.read_bytes()).hexdigest()))
        else: raise SystemExit(1)
    return rows
left=manifest(sys.argv[1]); right=manifest(sys.argv[2]); assert left==right
print("pin_manifest_sha256="+hashlib.sha256(json.dumps(left,separators=(",",":")).encode()).hexdigest())
print("pin_entry_count="+str(len(left)))
PY
test -f "$pin/app/index.html"
printf 'previous_original=%s\nprevious_pin=%s\nPIN=PASS\n' "$previous" "$pin"
BOX
  chmod 0600 "$SITE_EVIDENCE/site-03-pin.txt"
  previous=$(sed -n 's/^previous_original=//p' "$SITE_EVIDENCE/site-03-pin.txt")
  pin=$(sed -n 's/^previous_pin=//p' "$SITE_EVIDENCE/site-03-pin.txt")
  test "$previous" = /srv/commonswarm/site/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5
  test "$pin" = "/srv/commonswarm/site/releases/.site-window-pin-$SITE_WINDOW_ID"
  printf '%s\n' "$previous" >"$SITE_EVIDENCE/previous.original"
  printf '%s\n' "$pin" >"$SITE_EVIDENCE/previous.release"
  chmod 0600 "$SITE_EVIDENCE/previous.original" "$SITE_EVIDENCE/previous.release"
)
```

### GO and static assertions

These are fixed assertions, not window decisions:

- Connected apps exposure with no creation action is accepted for the SHA.
- Gate, SSH/account, source/base, environment, browser branch, and rollback pin
  all pass before GO.
- Deployment approval applies only to the exact release/base pair in `GO.txt`.
- Every failed post-switch control restores the pin automatically; no rollback
  approval is requested.
- A deployment failure is reconciled once; this plan never retries it.

```sh
# step: site-03-go-record — Mac mini /bin/bash 3.2; Anvil; write exact bounded GO
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-03-go-record: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  : "${SITE_APPROVER:?named input missing}"
  : "${SITE_PLAN_COMMIT:?named input missing}"
  : "${SITE_PROMPT_NUMBER:?named input missing}"
  test "$SITE_APPROVER" = HezLead
  test "${#SITE_PLAN_COMMIT}" -eq 40
  case "$SITE_PLAN_COMMIT" in *[!0-9a-f]*) exit 1 ;; esac
  case "$SITE_PROMPT_NUMBER" in ''|*[!0-9]*|0) exit 1 ;; esac
  test "$SITE_RELEASE_SHA" = 4d6a06509f9abf1aefac8c88ec00280d025df673
  test "$SITE_BASE_SHA" = 109e4db75f673ddd8003662dc1882159dd72b1b2
  grep -qFx 'close=PASS' "$SITE_EVIDENCE/hm37-a-close-receipt.txt"
  grep -qFx 'PIN=PASS' "$SITE_EVIDENCE/site-03-pin.txt"
  grep -qFx 'DELETE_GUARDS=PASS' "$SITE_EVIDENCE/site-02-summary.txt"
  test -f "$SITE_EVIDENCE/site-03-browser-preflight.json"
  test ! -e "$SITE_EVIDENCE/GO.txt"
  umask 077
  {
    printf 'APPROVER=%s\nPLAN_COMMIT=%s\nSHA=%s\nBASE_SHA=%s\nPROMPT_NUMBER=%s\n' \
      "$SITE_APPROVER" "$SITE_PLAN_COMMIT" "$SITE_RELEASE_SHA" "$SITE_BASE_SHA" "$SITE_PROMPT_NUMBER"
    printf '%s\n' 'HM37_WINDOW_A_LIVE=yes' 'HM37_MCP_DARK=yes'
    printf '%s\n' 'CONNECTED_APPS_EXPOSURE=accepted-empty-state-only' 'LIVE_REVOKE_CONTROL=HM37_WINDOW_B'
    jq -r '"BROWSER_BRANCH=" + .branch' "$SITE_EVIDENCE/site-03-browser-preflight.json"
    printf '%s\n' 'ROLLBACK_PIN=verified' 'All release holds resolved'
  } >"$SITE_EVIDENCE/GO.txt"
  chmod 0600 "$SITE_EVIDENCE/GO.txt"
)
```

## 4. Build, upload, switch, and failure reconciliation

```sh
# step: site-04 — Mac mini /bin/bash 3.2; Anvil; exact-SHA production deployment
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-04: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  git diff --exit-code HEAD -- site deploy/site
  grep -qFx "SHA=$SITE_RELEASE_SHA" "$SITE_EVIDENCE/GO.txt"
  grep -qFx "BASE_SHA=$SITE_BASE_SHA" "$SITE_EVIDENCE/GO.txt"
  grep -qFx 'All release holds resolved' "$SITE_EVIDENCE/GO.txt"
  box_now=$(ssh -o BatchMode=yes commonswarm@yulan-vps-1 date -u '+%Y-%m-%dT%H:%M:%SZ')
  python3 - "$box_now" "$SITE_WINDOW_END_UTC" <<'PY'
import datetime
import sys
now = datetime.datetime.strptime(sys.argv[1], "%Y-%m-%dT%H:%M:%SZ")
end = datetime.datetime.strptime(sys.argv[2], "%Y-%m-%dT%H:%M:%SZ")
assert now < end
PY
  previous=$(cat "$SITE_EVIDENCE/previous.original")
  pin=$(cat "$SITE_EVIDENCE/previous.release")
  test "$previous" = /srv/commonswarm/site/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5
  test "$pin" = "/srv/commonswarm/site/releases/.site-window-pin-$SITE_WINDOW_ID"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 \
    "test \"\$(readlink -f /srv/commonswarm/site/current)\" = '$previous' && test -f '$pin/app/index.html'"
  test ! -e "$SITE_EVIDENCE/deploy.log"
  set +e
  env -u PUBLIC_SUPABASE_URL -u PUBLIC_SUPABASE_ANON_KEY -u PUBLIC_H0_LINK_JOIN \
    /bin/sh deploy/site/deploy.sh commonswarm@yulan-vps-1 \
    >"$SITE_EVIDENCE/deploy.log" 2>&1
  deploy_status=$?
  set -e
  printf 'deploy_exit=%s\n' "$deploy_status" >"$SITE_EVIDENCE/deploy-status.txt"
  chmod 0600 "$SITE_EVIDENCE/deploy.log" "$SITE_EVIDENCE/deploy-status.txt"
  set +e
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 'readlink -f /srv/commonswarm/site/current' \
    >"$SITE_EVIDENCE/after.release"
  read_status=$?
  set -e
  printf 'after_read_exit=%s\n' "$read_status" >>"$SITE_EVIDENCE/deploy-status.txt"
  chmod 0600 "$SITE_EVIDENCE/after.release"
  if test "$deploy_status" -ne 0 || test "$read_status" -ne 0; then exit 70; fi
  after=$(cat "$SITE_EVIDENCE/after.release")
  case "$after" in /srv/commonswarm/site/releases/????????T??????Z-4d6a06509f9a-????????????????) ;; *) exit 1 ;; esac
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "test -f '$pin/app/index.html'"
  printf '%s\n' 'PIN_AFTER_DEPLOY=PASS' >"$SITE_EVIDENCE/pin-after-deploy.txt"
  chmod 0600 "$SITE_EVIDENCE/pin-after-deploy.txt"
)
```

Run `site-04-reconcile-failure` only after a nonzero/disconnected `site-04`.
No switch means failed close with no retry; the exact target current means
immediate rollback; a third state stops for incident handling.

```sh
# step: site-04-reconcile-failure — Mac mini /bin/bash 3.2; Anvil; one-shot no-retry reconciliation
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-04-reconcile-failure: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  previous=$(cat "$SITE_EVIDENCE/previous.original")
  pin=$(cat "$SITE_EVIDENCE/previous.release")
  current=$(ssh -o BatchMode=yes commonswarm@yulan-vps-1 'readlink -f /srv/commonswarm/site/current')
  if test "$current" = "$previous"; then
    printf '%s\n' 'DEPLOYMENT=failed-before-switch' 'RETRY=forbidden' \
      >"$SITE_EVIDENCE/site-04-reconciliation.txt"
  else
    case "$current" in /srv/commonswarm/site/releases/????????T??????Z-4d6a06509f9a-????????????????) ;; *) exit 1 ;; esac
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$pin" "$current" "$SITE_WINDOW_ID" \
      >"$SITE_EVIDENCE/rollback-auto.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-04-reconcile-failure: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; failed=$2; window_id=$3; root=/srv/commonswarm/site; next="$root/current.next.$window_id"
test "$pin" = "$root/releases/.site-window-pin-$window_id"
test -f "$pin/app/index.html"; test "$(readlink -f "$root/current")" = "$failed"
test ! -e "$next" && test ! -L "$next"
ln -s "$pin" "$next"; mv -Tf "$next" "$root/current"
test "$(readlink -f "$root/current")" = "$pin"
printf 'rollback_reason=deployment-failure-after-switch\nrestored_release=%s\n' "$pin"
BOX
    printf '%s\n' 'DEPLOYMENT=failed-after-switch' 'RETRY=forbidden' \
      >"$SITE_EVIDENCE/site-04-reconciliation.txt"
  fi
  chmod 0600 "$SITE_EVIDENCE/site-04-reconciliation.txt"
  test ! -e "$SITE_EVIDENCE/retry-approved"
)
```

## 5. Post-switch controls

Every scripted public request uses `User-Agent:
commonswarm-release-probe/1.0`. A failed public control automatically restores
the pin.

```sh
# step: site-05 — Mac mini /bin/bash 3.2; Anvil; public bytes with automatic rollback
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  pin=$(cat "$SITE_EVIDENCE/previous.release"); after=$(cat "$SITE_EVIDENCE/after.release")
  set +e
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$after" \
    >"$SITE_EVIDENCE/site-05-public.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
expected=$1
python3 - "$expected" <<'PY'
import hashlib,json,pathlib,re,sys,urllib.error,urllib.request
UA="commonswarm-release-probe/1.0"; root=pathlib.Path("/srv/commonswarm/site")
release=(root/"current").resolve(strict=True); assert str(release)==sys.argv[1]
assert re.fullmatch(r"\d{8}T\d{6}Z-4d6a06509f9a-[0-9a-f]{16}",release.name)
def fetch(path,media):
    request=urllib.request.Request("https://commonswarm.com"+path,headers={
      "Cache-Control":"no-cache","Accept-Encoding":"identity","User-Agent":UA})
    try: response=urllib.request.urlopen(request,timeout=30)
    except urllib.error.HTTPError as error: response=error
    with response:
        raw=response.read(); record={"url":request.full_url,"status":response.status,"user_agent":UA,
          "media_type":response.headers.get_content_type(),"server":response.headers.get("Server"),
          "cf-ray":response.headers.get("CF-Ray")}
    print("probe="+json.dumps(record,sort_keys=True,separators=(",",":")))
    assert record["status"]==200 and record["media_type"]==media; return raw
app=(release/"app/index.html").read_bytes(); assert b"data-connected-apps-open" in app
assert fetch("/app","text/html")==app
download=(release/"download/index.html").read_bytes(); assert b"0.1.80" in download
assert fetch("/download","text/html")==download
home=fetch("/","text/html"); guide=fetch("/guides/grok-bot","text/html")
assert b"CommonSwarm" in home and b"cswarm" in guide and b"Grok" in guide
assets=sorted(set(re.findall(rb'(?:src|href)="(/_astro/[^"]+\.(?:js|css))"',app))); assert assets
for encoded in assets:
    path=encoded.decode(); local=(release/path.lstrip("/")).resolve(strict=True); assert release in local.parents
    data=local.read_bytes(); media="text/css" if path.endswith(".css") else "application/javascript"
    assert fetch(path,media)==data; print("asset_sha256="+hashlib.sha256(data).hexdigest()+" "+path)
print("release="+release.name); print("app_sha256="+hashlib.sha256(app).hexdigest())
print("download_sha256="+hashlib.sha256(download).hexdigest())
print("PUBLIC_BYTES=PASS user_agent="+UA)
PY
BOX
  control_status=$?
  set -e
  chmod 0600 "$SITE_EVIDENCE/site-05-public.txt"
  if test "$control_status" -ne 0; then
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$pin" "$after" "$SITE_WINDOW_ID" \
      >"$SITE_EVIDENCE/rollback-auto.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; failed=$2; window_id=$3; root=/srv/commonswarm/site; next="$root/current.next.$window_id"
test "$pin" = "$root/releases/.site-window-pin-$window_id"; test -f "$pin/app/index.html"
test "$(readlink -f "$root/current")" = "$failed"; test ! -e "$next" && test ! -L "$next"
ln -s "$pin" "$next"; mv -Tf "$next" "$root/current"; test "$(readlink -f "$root/current")" = "$pin"
printf 'rollback_reason=public-control-failure\nrestored_release=%s\n' "$pin"
BOX
    chmod 0600 "$SITE_EVIDENCE/rollback-auto.txt"; exit "$control_status"
  fi
)
```

Full control verifies the signed-in production page, exact owner/workspace,
release assets, empty Connected apps, no creation action, clean console, and
320px/390px one-row geometry. Reduced control stays signed out, proves the
shipped bundle has the surface and no creation action, and records the four
signed-in claims as `NOT PROVED`. All actions are view-only: do not click a
revoke control, create action, or Sign out. The full branch switches back to
the recorded start workspace before it finishes. Failure rolls back
automatically.

```sh
# step: site-05-browser-acceptance — Mac mini /bin/bash 3.2; Anvil; fresh headless Chromium acceptance
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child only for automatic rollback
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-05-browser-acceptance: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  export SITE_EVIDENCE SITE_CHROME_ENDPOINT
  set +e
  BU_CDP_URL="$SITE_CHROME_ENDPOINT" BH_TAB_MARKER=0 browser-harness >/dev/null 2>/dev/null <<'PY'
import base64,json,os,pathlib,re,time
expected_user="d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"; expected_workspace="c2ea0541-f56d-4c73-bf71-56c5405c4934"
start_workspace="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
evidence=pathlib.Path(os.environ["SITE_EVIDENCE"])
branch=json.loads((evidence/"site-03-browser-preflight.json").read_text(encoding="utf-8"))["branch"]
cdp("Page.addScriptToEvaluateOnNewDocument",source="""
window.__siteControlErrors=[];
addEventListener('error',e=>window.__siteControlErrors.push(String(e.message||'error')));
addEventListener('unhandledrejection',e=>window.__siteControlErrors.push(String(e.reason||'rejection')));
const originalConsoleError=console.error.bind(console);
console.error=(...args)=>{window.__siteControlErrors.push('console.error');originalConsoleError(...args)};
""")
goto_url("https://commonswarm.com/app?w="+expected_workspace); wait_for_load()
def inspect():
    return js("""(() => {
      let userId=''; for(const key of Object.keys(localStorage)){if(!key.startsWith('sb-')||!key.endsWith('-auth-token'))continue;
      try{const value=JSON.parse(localStorage.getItem(key));if(value?.user?.id)userId=value.user.id;}catch{}}
      const selected=document.querySelector('[data-workspace-list] [data-workspace-id][aria-checked="true"]');
      const dialog=document.querySelector('[data-connected-apps-dialog]');
      return {userId,workspaceId:selected?.dataset.workspaceId||new URL(location.href).searchParams.get('w')||'',
      workspaceCount:document.querySelectorAll('[data-workspace-list] [data-workspace-id]').length,
      display:document.querySelector('[data-rail-account]')?.textContent?.trim()||'',
      signedOut:!document.querySelector('[data-panel="auth"]')?.hasAttribute('hidden'),
      connectedSurface:!!document.querySelector('[data-connected-apps-open]'),
      connectedCreateAction:!!dialog&&[...dialog.querySelectorAll('button,a')].some(x=>/connect|create|add app/i.test(x.textContent||'')),
      errors:window.__siteControlErrors||[]};})()""")
for _ in range(60):
    observed=inspect()
    if observed.get("signedOut") or observed.get("workspaceId"): break
    time.sleep(1)
if branch=="FULL-CONTROL":
    if observed["userId"]!=expected_user or observed["workspaceId"]!=expected_workspace: raise SystemExit(1)
    if observed["display"]!="Ridgeio": raise SystemExit(1)
    workspace_state=js("""(() => ({
      feed:!!document.querySelector('[data-feed-list]'),
      roster:!!document.querySelector('[data-sidebar-participant-list]'),
      localSeat:/\\bLocal\\b/.test(document.querySelector('[data-sidebar-participant-list]')?.textContent||''),
      h0:!!document.querySelector('agent-connect [data-h0-link-join]'),
      workspaceError:!document.querySelector('[data-panel="workspace-error"]')?.hasAttribute('hidden')
    }))()""")
    if not workspace_state["feed"] or not workspace_state["roster"] or not workspace_state["localSeat"]:
        raise SystemExit(1)
    if not workspace_state["h0"] or workspace_state["workspaceError"]:
        raise SystemExit(1)
    asset_paths=[]
    for line in (evidence/"site-05-public.txt").read_text(encoding="utf-8").splitlines():
        match=re.match(r"asset_sha256=[0-9a-f]{64} (/_astro/.+)",line)
        if match: asset_paths.append(match.group(1))
    loaded=js("performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)")
    if not asset_paths or not all(path in loaded for path in asset_paths): raise SystemExit(1)
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    js("document.querySelector('[data-user-menu-trigger]').click()")
    js("document.querySelector('[data-connected-apps-open]').click()")
    empty=""
    for _ in range(60):
        empty=js("document.querySelector('[data-connected-apps-list]')?.textContent?.trim()||''")
        status=js("document.querySelector('[data-connected-apps-status]')?.textContent?.trim()||''")
        if empty or "Nothing was changed" in status: break
        time.sleep(.5)
    if empty!="No apps are connected to this account.": raise SystemExit(1)
    if js("!document.querySelector('[data-connected-apps-retry]').hidden"): raise SystemExit(1)
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    if inspect()["connectedCreateAction"] or inspect()["errors"]: raise SystemExit(1)
    dialog_clip=js("""(() => {const r=document.querySelector('[data-connected-apps-dialog]').getBoundingClientRect();
      return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()""")
    dialog_png=cdp("Page.captureScreenshot",format="png",fromSurface=True,clip=dialog_clip)["data"]
    dialog_path=evidence/"site-05-connected-empty.png"; dialog_path.write_bytes(base64.b64decode(dialog_png)); dialog_path.chmod(0o600)
    geometry={}
    for width,height in ((320,568),(390,844)):
        cdp("Emulation.setDeviceMetricsOverride",width=width,height=height,deviceScaleFactor=1,mobile=True); time.sleep(.5)
        measured=js("""(() => {const rail=document.querySelector('.dashboard__rail');
        const controls=[document.querySelector('[data-workspace-menu-trigger]'),document.querySelector('[data-workspace-view="signals"]'),
        document.querySelector('[data-user-menu-trigger]')].filter(Boolean).map(node=>{const r=node.getBoundingClientRect();return{top:r.top,bottom:r.bottom,left:r.left,right:r.right};});
        return{innerWidth,scrollWidth:document.documentElement.scrollWidth,railHeight:rail?.getBoundingClientRect().height||0,controls};})()""")
        if measured["innerWidth"]!=width or measured["scrollWidth"]>width or len(measured["controls"])!=3: raise SystemExit(1)
        tops=[item["top"] for item in measured["controls"]]
        if max(tops)-min(tops)>2: raise SystemExit(1)
        geometry[str(width)]=measured
        rail_height=max(1,min(height,int(measured["railHeight"]+1)))
        mobile_png=cdp("Page.captureScreenshot",format="png",fromSurface=True,
          clip={"x":0,"y":0,"width":width,"height":rail_height,"scale":1})["data"]
        mobile_path=evidence/("site-05-mobile-%s.png"%width)
        mobile_path.write_bytes(base64.b64decode(mobile_png)); mobile_path.chmod(0o600)
    cdp("Emulation.clearDeviceMetricsOverride")
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    js("document.querySelector('[data-connected-apps-close]').click()")
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    switched=js("""(() => { const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"]');
      if(!target)return false; target.click(); return true; })()""")
    if not switched: raise SystemExit(1)
    for _ in range(60):
        time.sleep(.5)
        if inspect()["workspaceId"]==start_workspace: break
    if inspect()["workspaceId"]!=start_workspace: raise SystemExit(1)
    result={"branch":"FULL-CONTROL","identity":"PASS","workspace":expected_workspace,
      "start_workspace_id":start_workspace,"restored_workspace_id":start_workspace,
      "assets_loaded":"PASS","feed_roster_local_h0":"PASS","connected_apps_empty_state":"PASS",
      "connection_creation_action_absent":"PASS","console":"PASS","mobile_geometry":geometry,
      "screenshots":["site-05-connected-empty.png","site-05-mobile-320.png","site-05-mobile-390.png"]}
else:
    if not observed["signedOut"] or not observed["connectedSurface"] or observed["connectedCreateAction"]: raise SystemExit(1)
    result={"branch":"REDUCED-CONTROL","signed_out_bundle_connected_apps_surface":"PASS",
      "signed_out_bundle_creation_action_absent":"PASS","signed_in_connected_apps_load":"NOT PROVED",
      "signed_in_empty_state":"NOT PROVED","signed_in_no_creation_action":"NOT PROVED","signed_in_console_clean":"NOT PROVED"}
path=evidence/"site-05-browser.json"; path.write_text(json.dumps(result,sort_keys=True,indent=2)+"\n",encoding="utf-8"); path.chmod(0o600)
PY
  browser_status=$?
  set -e
  if test "$browser_status" -ne 0; then
    pin=$(cat "$SITE_EVIDENCE/previous.release"); after=$(cat "$SITE_EVIDENCE/after.release")
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$pin" "$after" "$SITE_WINDOW_ID" \
      >"$SITE_EVIDENCE/rollback-auto.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-05-browser-acceptance: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; failed=$2; window_id=$3; root=/srv/commonswarm/site; next="$root/current.next.$window_id"
test "$pin" = "$root/releases/.site-window-pin-$window_id"; test -f "$pin/app/index.html"
test "$(readlink -f "$root/current")" = "$failed"; test ! -e "$next" && test ! -L "$next"
ln -s "$pin" "$next"; mv -Tf "$next" "$root/current"; test "$(readlink -f "$root/current")" = "$pin"
printf 'rollback_reason=browser-control-failure\nrestored_release=%s\n' "$pin"
BOX
    chmod 0600 "$SITE_EVIDENCE/rollback-auto.txt"; exit "$browser_status"
  fi
)
```

## 6. Rollback verification

`site-06` always runs. It records `not-needed`, or verifies pinned baseline
bytes through the public boundary and rechecks the appropriate browser branch.

```sh
# step: site-06 — Mac mini /bin/bash 3.2; Anvil; verify automatic rollback or record not-needed
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-06: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  if test ! -f "$SITE_EVIDENCE/rollback-auto.txt"; then
    printf '%s\n' 'rollback=not-needed' >"$SITE_EVIDENCE/site-06-rollback-verify.txt"
    chmod 0600 "$SITE_EVIDENCE/site-06-rollback-verify.txt"; exit 0
  fi
  pin=$(cat "$SITE_EVIDENCE/previous.release")
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$pin" \
    >"$SITE_EVIDENCE/site-06-rollback-verify.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-06: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; test "$(readlink -f /srv/commonswarm/site/current)" = "$pin"
python3 - "$pin" <<'PY'
import pathlib,sys,urllib.request
UA="commonswarm-release-probe/1.0"; release=pathlib.Path(sys.argv[1]); local=(release/"app/index.html").read_bytes()
request=urllib.request.Request("https://commonswarm.com/app",headers={
 "Cache-Control":"no-cache","Accept-Encoding":"identity","User-Agent":UA})
with urllib.request.urlopen(request,timeout=30) as response:
    remote=response.read(); assert response.status==200; assert response.headers.get_content_type()=="text/html"
assert remote==local; print("ROLLBACK_PUBLIC_BYTES=PASS user_agent="+UA)
PY
BOX
  chmod 0600 "$SITE_EVIDENCE/site-06-rollback-verify.txt"
  export SITE_EVIDENCE
  BU_CDP_URL="$SITE_CHROME_ENDPOINT" BH_TAB_MARKER=0 browser-harness >/dev/null 2>/dev/null <<'PY'
import json,os,pathlib,time
workspace="c2ea0541-f56d-4c73-bf71-56c5405c4934"
start="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
evidence=pathlib.Path(os.environ["SITE_EVIDENCE"])
branch=json.loads((evidence/"site-03-browser-preflight.json").read_text(encoding="utf-8"))["branch"]
goto_url("https://commonswarm.com/app"); wait_for_load()
if branch=="FULL-CONTROL":
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    if not js("""(() => {const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="c2ea0541-f56d-4c73-bf71-56c5405c4934"]');
      if(!target)return false;target.click();return true})()"""): raise SystemExit(1)
    for _ in range(60):
        selected=js("document.querySelector('[data-workspace-list] [aria-checked=\"true\"]')?.dataset.workspaceId||''")
        if selected==workspace: break
        time.sleep(.5)
    if selected!=workspace: raise SystemExit(1)
    # Workspace is asserted before this rollback-view control.
    if js("document.querySelector('[data-rail-account]')?.textContent?.trim()")!="Ridgeio": raise SystemExit(1)
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    if not js("""(() => {const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"]');
      if(!target)return false;target.click();return true})()"""): raise SystemExit(1)
    for _ in range(60):
        restored=js("document.querySelector('[data-workspace-list] [aria-checked=\"true\"]')?.dataset.workspaceId||''")
        if restored==start: break
        time.sleep(.5)
    if restored!=start: raise SystemExit(1)
else:
    if not js("!document.querySelector('[data-panel=\"auth\"]')?.hasAttribute('hidden')"): raise SystemExit(1)
PY
)
```

## 7. Manifest, pin release, and close

Closure is mechanical. It rejects credentials, raw HTML, HAR content, email
addresses, and private browser state. It records the browser branch. On success
the pin is guardedly removed. After rollback, `current` first returns to the
measured normal release name; if retention pruned it, the pin is renamed back.
The task-owned headless browser is stopped and its private profile is removed through guarded rm. The
temporary build `site/.env` is removed at close.

```sh
# step: site-07-manifest-close — Mac mini /bin/bash 3.2; Anvil; sanitize, release pin, and close
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site-07-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  pin=$(cat "$SITE_EVIDENCE/previous.release"); previous=$(cat "$SITE_EVIDENCE/previous.original")
  if test -f "$SITE_EVIDENCE/rollback-auto.txt"; then
    grep -qFx 'ROLLBACK_PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site-06-rollback-verify.txt"
    outcome=rolled-back
  elif test -f "$SITE_EVIDENCE/site-04-reconciliation.txt"; then
    grep -qFx 'DEPLOYMENT=failed-before-switch' "$SITE_EVIDENCE/site-04-reconciliation.txt"; outcome=failed-before-switch
  else
    grep -qFx 'PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site-05-public.txt"
    test -f "$SITE_EVIDENCE/site-05-browser.json"; outcome=released
  fi
  python3 - "$SITE_EVIDENCE" <<'PY'
import hashlib,json,pathlib,re,stat,sys
root=pathlib.Path(sys.argv[1]).resolve(); rows=[]
for path in sorted(root.rglob("*")):
    if path.name=="chrome-launch.log" or path.is_dir(): continue
    if path.is_symlink() or not path.is_file(): raise SystemExit(1)
    data=path.read_bytes()
    if path.suffix.lower() in {".html",".har"}: raise SystemExit(1)
    if path.suffix.lower() in {".txt",".json",".log",""}:
        text=data.decode("utf-8"); patterns=(r"Authorization:\s*Bearer",
          r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}",
          r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",r"<!doctype\s+html|<html[ >]",r'"log"\s*:\s*\{\s*"version"')
        if any(re.search(pattern,text,re.I) for pattern in patterns): raise SystemExit(1)
    rows.append({"path":path.relative_to(root).as_posix(),"bytes":len(data),
      "mode":format(stat.S_IMODE(path.stat().st_mode),"04o"),"sha256":hashlib.sha256(data).hexdigest()})
if not rows: raise SystemExit(1)
manifest=root/"manifest.json"; manifest.write_text(json.dumps(rows,sort_keys=True,indent=2)+"\n",encoding="utf-8"); manifest.chmod(0o600)
PY
  manifest_sha=$(shasum -a 256 "$SITE_EVIDENCE/manifest.json" | awk '{print $1}')
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s -- "$pin" "$previous" "$SITE_WINDOW_ID" "$outcome" \
    >"$SITE_EVIDENCE/site-07-pin-close.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site-07-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; previous=$2; window_id=$3; outcome=$4; root=/srv/commonswarm/site
test "$pin" = "$root/releases/.site-window-pin-$window_id"
test "$previous" = "$root/releases/20261001T160313Z-109e4db75f67-0e6aa0bfe4eaf1e5"
current=$(readlink -f "$root/current")
if test "$current" = "$pin"; then
  if test -d "$previous" && test ! -L "$previous"; then target="$previous"
  else test ! -e "$previous" && test ! -L "$previous"; mv "$pin" "$previous"; target="$previous"; pin=''; fi
  next="$root/current.next.$window_id.close"; test ! -e "$next" && test ! -L "$next"
  ln -s "$target" "$next"; mv -Tf "$next" "$root/current"; test "$(readlink -f "$root/current")" = "$target"
fi
if test -n "$pin" && test -d "$pin" && test ! -L "$pin"; then
  python3 - "$pin" "$root/releases" "$window_id" <<'PY'
import pathlib,sys
target=pathlib.Path(sys.argv[1]); root=pathlib.Path(sys.argv[2]).resolve(strict=True); window_id=sys.argv[3]
assert target.name==".site-window-pin-"+window_id and not target.is_symlink()
resolved=target.resolve(strict=True); assert resolved.parent==root and resolved!=pathlib.Path.home().resolve()
PY
  rm -r -- "$pin"
  test ! -e "$pin"
fi
rm -f /tmp/commonswarm-site-window.env
printf 'pin_released=yes\noutcome=%s\n' "$outcome"
BOX
  chmod 0600 "$SITE_EVIDENCE/site-07-pin-close.txt"
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site-03-browser-preflight.json")"
  {
    printf 'CLOSED=yes\nOUTCOME=%s\n' "$outcome"
    printf 'BROWSER_BRANCH=%s\n' "$branch"
    if test "$branch" = FULL-CONTROL; then
      printf '%s\n' \
        'BROWSER_START_WORKSPACE=292be0f9-ca5d-43ed-a6f7-31354fe7fe56' \
        'BROWSER_CONTROL_WORKSPACE=c2ea0541-f56d-4c73-bf71-56c5405c4934' \
        'BROWSER_RESTORED_WORKSPACE=292be0f9-ca5d-43ed-a6f7-31354fe7fe56' \
        'NOT_PROVED=[]'
    else
      printf '%s\n' \
        'NOT_PROVED=[signed-in Connected apps load; signed-in empty state; signed-in no-creation-action; signed-in console clean; 320px header; 390px header]'
    fi
    printf 'MANIFEST_SHA256=%s\nPIN_RELEASED=yes\nCLOSED_AT=%s\n' \
      "$manifest_sha" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$SITE_EVIDENCE/CLOSE.txt"
  chmod 0600 "$SITE_EVIDENCE/CLOSE.txt"
  python3 - "$SITE_RELEASE_REPO/site/.env" <<'PY'
import pathlib,sys
build_env=pathlib.Path(sys.argv[1])
if build_env.exists(): assert build_env.is_file() and not build_env.is_symlink()
PY
  rm -f -- "$SITE_RELEASE_REPO/site/.env"
  test ! -e "$SITE_RELEASE_REPO/site/.env"
  # Close only this block's fresh headless process and private profile.
  if [ -n "${SITE_BROWSER_ROOT:-}" ] && [ -d "$SITE_BROWSER_ROOT" ]; then
    case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test ! -L "$SITE_BROWSER_ROOT"
    test "$SITE_CHROME_PROFILE" = "$SITE_BROWSER_ROOT/browser-profile"
    if kill -0 "$SITE_CHROME_PID" 2>/dev/null; then
      browser_command="$(ps -p "$SITE_CHROME_PID" -o command=)"
      case "$browser_command" in *"$SITE_CHROME_BINARY"*"--user-data-dir=$SITE_CHROME_PROFILE"*) ;; *) exit 1 ;; esac
      kill "$SITE_CHROME_PID"
      for tries in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$SITE_CHROME_PID" 2>/dev/null || break
        sleep 1
      done
      if kill -0 "$SITE_CHROME_PID" 2>/dev/null; then exit 1; fi
    fi
    if ! rm -r -- "$SITE_BROWSER_ROOT"; then
      printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$SITE_BROWSER_ROOT" >&2
      exit 1
    fi
    test ! -e "$SITE_BROWSER_ROOT"
  fi
  rm -f "$SITE_WINDOW_FILE"
)
```

## 8. Gap-to-plan mapping

| Audit item | Resolution |
|---|---|
| P2-K1-01 | `site-01`: box-clock start, derived four-hour end and ID. |
| P2-K1-02 | Named `SITE_EVIDENCE`; `site-01` creates/verifies `0700`. |
| P2-K1-03 | Named `SITE_RELEASE_REPO`; `site-00-source-checkout` creates/verifies it. |
| P2-K1-04 | No browser bearer is exported; controls use a fresh headless profile and record signed-in claims as NOT PROVED when signed out. |
| P2-K2-01 | `site-01` creates the protected evidence directory. |
| P2-K2-02 | `site-00-source-checkout` creates detached exact-SHA source. |
| P2-K2-03 | Named `SITE_BUILD_ENV_OP_REFERENCE` and service-account token-file path; `site-00-build-env` creates a private temporary directory, reads with `op read --out-file`, installs and validates the build file, then removes the whole temporary directory. |
| P2-K2-04 | Browser preflight reads only `user.id` from the persisted site session and never writes a token. |
| P2-K2-05 | Named `HM37_A_CLOSE_RECEIPT`; `site-00-a-close-ingest` validates/copies the sole A-to-lane-8 handoff. |
| P2-K2-06 | `site-03-go-record` writes bounded `GO.txt`. |
| P2-K2-07 | `site-03-pin-previous` creates/proves the retention-proof copy; close releases it. |
| P2-K2-08 | `site-04-reconcile-failure` records state and forbids replay. |
| P2-K2-09 | The marked browser steps use only Anvil's task-owned fresh headless profile and restore its starting workspace. |
| P2-K2-10 | Failed controls auto-switch; `site-06` verifies public/browser rollback. |
| P2-K2-11 | `site-07-manifest-close` scans, hashes, closes, and cleans inputs. |
| P2-K3-01 | `site-01` produces the evidence directory. |
| P2-K3-02 | `site-00-source-checkout` produces the checkout. |
| P2-K3-03 | `site-00-build-env` produces `site/.env`. |
| P2-K3-04 | Browser preflight selects full or reduced control automatically; reduced control marks signed-in claims `NOT PROVED`. |
| P2-K3-05 | `site-00-a-close-ingest` copies the Window A close receipt. |
| P2-K3-06 | `site-03-go-record` produces `GO.txt`. |
| P2-K3-07 | Pin step produces the rollback path consumed by rollback blocks. |
| P2-K3-08 | Browser preflight proves Ridgeio and CLI/web user-ID equality, then switches through the normal workspace switcher or enforces reduced control. |
| P2-K3-09 | Close produces and validates `manifest.json`. |
| P2-K4-01 | `site-01` proves direct SSH identity and site-root write access. |
| P2-K4-02 | `site-01` proves box Python/DNS/HTTPS, exact media types and required User-Agent. |
| P2-K4-03 | Branch selection is automatic from the fresh headless Chromium session; signed-out/2FA state selects reduced control; a keychain dialog is STOP. |
| P2-K5-01 | Named `HM37_A_CLOSE_RECEIPT`; no WINDOW B wait. |
| P2-K5-02 | Static Connected apps exposure acceptance in GO. |
| P2-K5-03 | Live revoke moved to HM37 WINDOW B; lane 8 uses empty state only. |
| P2-K5-04 | Static exact-SHA deletion-guard assertion in `site-02`. |
| P2-K5-05 | Static hold list consumed by GO; missing evidence stops. |
| P2-K5-06 | Static exact SHA/base authorization consumed by `site-04`. |
| P2-K5-07 | Static automatic rollback in both controls and failed-deploy reconciliation. |
| P2-K5-08 | Static mechanical close after required readbacks. |
| P2-K6 | Empty by audit. |
| Pre-seed: start/evidence | `site-01` measures time and creates the named destination. |
| Pre-seed: checkout/base | Named checkout/base; source and `site-02` prove them. |
| Pre-seed: `site/.env` | Named 1Password reference and protected service-account token-file path; the build-env step produces its own temporary output path, installs and proves `site/.env`, and clears the temporary directory. |
| Pre-seed: browser session | Historical K4-8/K4-9 used retained Chrome. The current preflight creates and validates its own fresh headless profile; those historical measurements do not prove this control. |
| Pre-seed: `GO.txt` | GO step produces it from approver, plan commit, release SHA and prompt number. |

## 9. Recorded outcomes

`CLOSE.txt` separately records outcome, browser branch, manifest digest, pin
release, and closure. The evidence set separately records build/upload/switch,
public bytes, browser controls, and any rollback. A successful site release
does not claim hosted MCP availability or live revoke behavior; both remain
WINDOW B work.
