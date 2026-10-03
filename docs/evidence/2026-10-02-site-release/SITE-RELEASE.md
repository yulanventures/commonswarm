# CommonSwarm site release — generalized ON-baseline plan

Box image-build rule: `nice -n 15` plus a hard three-CPU cap, using
`systemd-run --scope -p CPUQuota=300%` around the build workers or a supported
builder quota. Build once per `RELEASE_SHA`, look up a persistent SHA tag,
build only if absent, and verify the image's recorded source SHA before reuse;
unsupported caps or mismatched SHA labels are STOP. See the shared preamble in
[RELEASE-TO-BOX.md](../../../deploy/RELEASE-TO-BOX.md). This site plan builds
static files on the Mac and contains no box image-build step.

**Release:** validated `SITE_RELEASE_SHA`, reviewed and landed on `origin/main`.

**Baseline source:** validated `EXPECTED_SITE_SHA`, reconciled with the box measurement.

**Baseline release:** `BASELINE_DIR`, measured from `/srv/commonswarm/site/current`.
**Status:** executable plan; no operation recorded here has run.

Anvil runs every marked block on the Mac mini under HezLead's direction. Mac
blocks use `/bin/bash` 3.2. They never assign `HOME`, print a credential, run
Docker, deploy a second SHA, change Caddy or DNS, or restart a service.
Mac blocks must not call setuid tools: the worker sandbox refuses them.

Every headless browser launch in this plan or any plan copied from it passes
`--no-sandbox` with `--password-store=basic`, `--use-mock-keychain`, and a fresh
temporary profile: Chromium's macOS seatbelt cannot start inside the release
worker's `sandbox-exec` profile (`~/.config/agent-sandbox/no-real-chrome.sb`),
which supplies containment. Use only Playwright's bundled Chromium, never the
installed Chrome. `scripts/site-task-browser.mjs` from the exact release checkout
is the only thing that launches, probes, or closes that browser. Browser evidence
is optional: a browser failure is `NOT_PROVED` and never rolls back public bytes
that the independent public checks verified. See "Fresh headless Chromium session".

Hosted MCP must be ON. `site2-00-a-close-ingest` now records the live
protected-resource metadata and unauthenticated MCP POST checks that replace
the historical Window A handoff; `site2-03-go-record` repeats them before GO.
No historical Window A or B receipt is an input. Connected apps may be EMPTY or
POPULATED; the full headless-browser control records the actual successful
list state. All browser actions remain view-only; live grant-and-seat revoke
behavior is outside this site release's proof.

## 1. Named prompt inputs

Credential values are never prompt inputs. A value-bearing file is named only
by an absolute path and is read without printing it.

| Name | Supplier and meaning | Exact format |
|---|---|---|
| `GATE_EVIDENCE_FILE` | HezLead, exact-SHA site gates | absolute regular non-symlink nonsecret receipt with `SHA=<SITE_RELEASE_SHA>`, `site build: PASS`, `site tests: PASS`, `site CI: PASS` |
| `SITE_APPROVER` | HezLead | `HezLead` |
| `SITE_PLAN_COMMIT` | HezLead, reviewed plan commit | 40 lowercase hex characters |
| `SITE_RELEASE_SHA` | HezLead/Anvil, reviewed release | 40 lowercase hex; a commit on `origin/main`, descendant of base with a nonempty `site/` delta |
| `EXPECTED_SITE_SHA` | Anvil, expected full baseline source SHA | 40 lowercase hex; a commit and ancestor of release; must equal the uniquely resolved box-recorded source prefix |
| `BASELINE_DIR` | Produced by window open, never supplied or trusted | canonical current release directory measured on the box and retained in the protected window file |
| `SITE_RELEASE_VERSION` | Produced from the exact checkout | root `package.json` version, used for the `/download` version control |
| `SITE_PROMPT_NUMBER` | HezLead | positive decimal integer |
| `SITE_RELEASE_REPO` | Anvil, isolated checkout destination | absolute task-owned empty directory before `site2-00-source-checkout` |
| `SITE_EVIDENCE` | Anvil, protected evidence destination | absolute task-owned empty mode-`0700` directory before `site2-01` |
| `SITE_BUILD_ENV_OP_REFERENCE` | HezLead/Anvil, approved 1Password document reference | `op://Yulan Ventures Infra/ITEM/FIELD` with nonempty item and field segments; no credential value |
| `OP_SERVICE_ACCOUNT_TOKEN_FILE` | Anvil, existing protected 1Password service-account token file | absolute regular non-symlink mode-`0600` file; never a credential value in the prompt |

```prompt-inputs
{"name":"GATE_EVIDENCE_FILE","format":"abs-file:site-gate-evidence","supplier":"HezLead","meaning":"Nonsecret exact-SHA site build, tests and CI PASS receipt."}
{"name":"SITE_APPROVER","format":"literal:HezLead","supplier":"HezLead","meaning":"Approval identity for this site release."}
{"name":"SITE_PLAN_COMMIT","format":"sha40","supplier":"HezLead","meaning":"Reviewed commit containing this generalized plan."}
{"name":"SITE_RELEASE_SHA","format":"sha40","supplier":"HezLead and Anvil","meaning":"Reviewed site release commit."}
{"name":"EXPECTED_SITE_SHA","format":"sha40","supplier":"Anvil","meaning":"Expected full baseline source commit, checked against the measured source."}
{"name":"SITE_PROMPT_NUMBER","format":"decimal-positive","supplier":"HezLead","meaning":"Positive approval-record prompt number."}
{"name":"SITE_RELEASE_REPO","format":"abs-dir","supplier":"Anvil","meaning":"Task-owned empty directory used for the exact-SHA checkout."}
{"name":"SITE_EVIDENCE","format":"abs-dir","supplier":"Anvil","meaning":"Task-owned protected evidence directory."}
{"name":"SITE_BUILD_ENV_OP_REFERENCE","format":"literal:op://Yulan Ventures Infra/CommonSwarm Site/public-build-env","supplier":"HezLead and Anvil","meaning":"Approved 1Password document reference; never a credential value."}
{"name":"OP_SERVICE_ACCOUNT_TOKEN_FILE","format":"abs-file:op-service-account-token","supplier":"Anvil","meaning":"Protected token file used by the noninteractive 1Password service-account workflow."}
```
The gate receipt is parsed as complete lines, following `dcr-archive` in
`docs/evidence/2026-10-02-dcr-release/RELEASE-V2.md`. It is checked before any box
contact and copied into the protected evidence set at open. It supplies proof
of gates already run; this plan never dispatches Actions.

The baseline receipt in the lane-8 plan records `PREVIOUS_RELEASE` from the
box's resolved `current` link. `deploy/site/deploy.sh` records the source as
`git rev-parse --short=12 HEAD` inside that release directory name, rather than
writing a full-SHA file into the static tree. Open measures that recorded prefix
on the box, resolves it uniquely with Git in the exact checkout, and requires
the full result to equal `EXPECTED_SITE_SHA`. An absent, malformed, ambiguous or
mismatching source is STOP. `BASELINE_DIR` is derived from the measurement,
never accepted from an old receipt or prompt; later pin/deploy/close paths
compare against that retained measurement. The full source and directory are
recorded together in `site2-01-open.txt` and the protected window file.

The browser account and two workspace IDs remain the lane-8 approved view-only
control fixtures. Their assertions and reduced-control behavior are unchanged.

## 2. Preparation and window open

### Run order

Run only the marked blocks extracted by step ID under a separately authorized
release assignment. Keep the protected window file until the applicable close
succeeds. No forward retry after any failure without a new HezLead instruction.

| Order | Step | Required result / next action |
|---|---|---|
| 0 | `site2-plan-inputs` | Required full expected site source validated and exported. |
| 1 | `site2-00-source-checkout` | Exact landed commit, base ancestry, nonempty site delta and exact-SHA gates; no window yet. |
| 2 | `site2-01` | Box clock, measured baseline directory/source, protected local and box window files, copied gate receipt. |
| 3 | `site2-00-a-close-ingest` | Current hosted MCP ON receipt; preserves the historical step name. |
| 4 | `site2-00-build-env` | Validated build document through service-account token file; private staging removed. |
| 5 | `site2-02` | Exact source, site inventory/count reconciliation and deletion guards. |
| 6 | `site2-03-browser-session-preflight` | Task-browser controller starts bundled headless Chromium; automatic FULL-CONTROL / REDUCED-CONTROL branch. |
| 7 | `site2-03` | Build environment and selected browser branch validated. |
| 8 | `site2-03-pin-previous` | Measured baseline copied and inventory-proved; pin invocation marker retained even on failure. |
| 9 | `site2-03-go-record` | Lead authorization, exact-SHA gates, MCP ON recheck and verified pin; bounded GO. |
| 10 | `site2-04` | Build/upload/switch once; exact target and retained pin measured. |
| 11 | `site2-05` | Public page/asset bytes and measured release version; automatic rollback on failure. |
| 12 | `site2-05-browser-acceptance` | Controller probe, then browser acceptance; any browser failure is a non-blocking `NOT_PROVED` receipt, never a rollback. |
| 13 | `site2-06` | Rollback public bytes verified or not-needed recorded, then applicable non-blocking browser recheck. |
| 14 | `site2-07-manifest-close` | Task-browser close, receipts, manifest, box pin release and guarded input cleanup; CLOSED only after success. |

### Failure paths

| Trigger | Required marked steps / disposition |
|---|---|
| `site2-00-source-checkout` fails | STOP before opening; report exact failure; no box mutation or close claim. |
| `site2-01` fails before either window file exists | STOP; no release occurred. If either window file was created, retain it and report partial open to HezLead; do not invent cleanup commands. |
| `site2-00-a-close-ingest`, `site2-00-build-env`, `site2-02`, `site2-03-browser-session-preflight` or `site2-03` fails before pin invocation | Stop forward work; `site2-06`, then `site2-07-pre-pin-manifest-close` closes the task browser, verifies baseline unchanged and closes without a pin. A failed preflight already closed its own task browser. |
| `site2-03-pin-previous` fails / disconnects | `site2-browser-close`; retain invocation marker and any pin; HezLead reconciles partial state. Never use pre-pin close or replay the pin step. |
| `site2-03-go-record` fails after a successful pin | `site2-browser-close`; stop before deploy and report to HezLead; retain pin/window. The existing normal close requires a public acceptance or deployment-failure receipt, so do not fabricate either to close. |
| `site2-04` fails / disconnects | `site2-04-reconcile-failure` exactly once: unchanged baseline records failed-before-switch; target current restores pin; a third state STOPs for incident handling. Then `site2-06`, `site2-07-manifest-close` if readbacks pass. |
| `site2-05` public bytes fail | Automatic pin restore; `site2-06`, then `site2-07-manifest-close` only after required rollback receipts pass. |
| Browser acceptance fails (any mode or phase, including controller probe) | Retain explicit NOT_PROVED receipt plus independent public PASS; no rollback; `site2-06`, then `site2-07-manifest-close`. |
| `site2-06` public verification fails | `site2-browser-close`; STOP and retain pin/window/evidence for HezLead; no successful close. A browser recheck failure is NOT_PROVED, never blocking. |
| `site2-04-reconcile-failure` stops on a third state | `site2-browser-close`; incident handling owns the rest. |
| Either close fails | Retain state; guarded-rm refusal reports exact path/message and leaves it. Each close runs the idempotent task-browser close before any box change, so a browser STOP leaves it resumable. `site2-07-manifest-close` may resume only the documented no-box-close-receipt state; partial box close needs HezLead reconciliation. |

```sh
# step: site2-plan-inputs
# host: Mac /bin/bash 3.2 before source checkout/open
set -euo pipefail
python3 - "${EXPECTED_SITE_SHA:-}" <<'PYINPUT'
import re,sys
if not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]): raise SystemExit('FAIL: invalid EXPECTED_SITE_SHA; STOP')
PYINPUT
export EXPECTED_SITE_SHA
```

```sh
# step: site2-00-source-checkout — Mac mini /bin/bash 3.2; Anvil; create isolated exact-SHA checkout
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-00-source-checkout: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${SITE_RELEASE_REPO:?named input missing}"
  : "${SITE_RELEASE_SHA:?named input missing}"
  : "${EXPECTED_SITE_SHA:?named input missing}"
  : "${GATE_EVIDENCE_FILE:?named input missing}"
  case "$SITE_RELEASE_REPO" in /*) ;; *) exit 1 ;; esac
  test "${#SITE_RELEASE_SHA}" -eq 40
  case "$SITE_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  python3 - "${EXPECTED_SITE_SHA:-}" <<'PYINPUT'
import re,sys
if not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]): raise SystemExit('FAIL: invalid EXPECTED_SITE_SHA; STOP')
PYINPUT
  export EXPECTED_SITE_SHA
  test -d "$SITE_RELEASE_REPO" && test ! -L "$SITE_RELEASE_REPO"
  test -z "$(find "$SITE_RELEASE_REPO" -mindepth 1 -maxdepth 1 -print -quit)"
  git clone --no-checkout https://github.com/yulanventures/commonswarm.git "$SITE_RELEASE_REPO"
  git -C "$SITE_RELEASE_REPO" fetch origin main
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse --verify "${SITE_RELEASE_SHA}^{commit}")" = "$SITE_RELEASE_SHA"
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$SITE_RELEASE_SHA" origin/main
  git -C "$SITE_RELEASE_REPO" checkout --detach "$SITE_RELEASE_SHA"
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test "$(git -C "$SITE_RELEASE_REPO" remote get-url origin)" = https://github.com/yulanventures/commonswarm.git
  test -z "$(git -C "$SITE_RELEASE_REPO" status --short --untracked-files=all)"
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse --verify "${EXPECTED_SITE_SHA}^{commit}")" = "$EXPECTED_SITE_SHA"
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA"
  test -n "$(git -C "$SITE_RELEASE_REPO" diff --name-only "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/)"
  python3 - "$GATE_EVIDENCE_FILE" "$SITE_RELEASE_SHA" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
lines=p.read_text().splitlines()
assert [line for line in lines if line.startswith("SHA=")]==["SHA="+sys.argv[2]]
for gate in ("site build", "site tests", "site CI"):
    assert gate+": PASS" in lines, "STOP: exact-SHA site gate missing"
PY
)
```

`site2-01` refuses existing window state, an active release process, a changed
baseline, wrong SSH identity, missing write access, or failed box HTTPS/DNS. It
reads the box UTC clock to the second, calculates end as start plus four hours,
and derives the ID. Nobody types a time or ID.

```sh
# step: site2-01 — Mac mini /bin/bash 3.2; Anvil; open from box clock and verify baseline/access
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-01: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${GATE_EVIDENCE_FILE:?named input missing}"
  : "${SITE_RELEASE_REPO:?named input missing}"
  : "${EXPECTED_SITE_SHA:?named input missing}"
  : "${SITE_RELEASE_SHA:?named input missing}"
  : "${SITE_EVIDENCE:?named input missing}"
  : "${SITE_BUILD_ENV_OP_REFERENCE:?named input missing}"
  : "${OP_SERVICE_ACCOUNT_TOKEN_FILE:?named input missing}"
  test "${#SITE_RELEASE_SHA}" -eq 40
  case "$SITE_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  python3 - "${EXPECTED_SITE_SHA:-}" <<'PYINPUT'
import re,sys
if not re.fullmatch(r'[0-9a-f]{40}',sys.argv[1]): raise SystemExit('FAIL: invalid EXPECTED_SITE_SHA; STOP')
PYINPUT
  export EXPECTED_SITE_SHA
  for input_path in "$GATE_EVIDENCE_FILE" "$SITE_RELEASE_REPO" "$SITE_EVIDENCE"; do
    case "$input_path" in /*) ;; *) exit 1 ;; esac
  done
  test -d "$SITE_EVIDENCE" && test ! -L "$SITE_EVIDENCE"
  test -z "$(find "$SITE_EVIDENCE" -mindepth 1 -maxdepth 1 -print -quit)"
  test "$(stat -f '%Lp' "$SITE_EVIDENCE")" = 700
  test ! -e "$HOME/.commonswarm-site-window.env"
  python3 - "$GATE_EVIDENCE_FILE" "$SITE_RELEASE_SHA" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
lines=p.read_text().splitlines()
assert [line for line in lines if line.startswith("SHA=")]==["SHA="+sys.argv[2]]
for gate in ("site build", "site tests", "site CI"):
    assert gate+": PASS" in lines, "STOP: exact-SHA site gate missing"
PY
  case "$SITE_BUILD_ENV_OP_REFERENCE" in 'op://Yulan Ventures Infra/'?*/?*) ;; *) exit 1 ;; esac
  case "$SITE_BUILD_ENV_OP_REFERENCE" in *$'\n'*) exit 1 ;; esac
  case "$OP_SERVICE_ACCOUNT_TOKEN_FILE" in /*) ;; *) exit 1 ;; esac
  test -f "$OP_SERVICE_ACCOUNT_TOKEN_FILE" && test ! -L "$OP_SERVICE_ACCOUNT_TOKEN_FILE"
  test "$(stat -f '%Lp' "$OP_SERVICE_ACCOUNT_TOKEN_FILE")" = 600
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$SITE_RELEASE_SHA" origin/main
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA"
  test -n "$(git -C "$SITE_RELEASE_REPO" diff --name-only "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/)"
  SITE_RELEASE_VERSION=$(node -p 'require(process.argv[1]).version' "$SITE_RELEASE_REPO/package.json")
  case "$SITE_RELEASE_VERSION" in ''|*[!0-9A-Za-z.+-]*) exit 1 ;; esac
  # Bash holds the executing script open; query open paths without setuid tools.
  python3 - <<'PYLOCALRELEASE'
import subprocess
result = subprocess.run(["lsof", "-nP", "-F", "n"], capture_output=True)
if result.returncode != 0:
    raise SystemExit("STOP: local site release process query unavailable")
if any(line.startswith(b"n") and line.endswith((b"/deploy/site/deploy.sh", b"/finalize-release.sh"))
       for line in result.stdout.splitlines()):
    raise SystemExit("STOP: another local site release process exists")
PYLOCALRELEASE

  box_open_file="$SITE_EVIDENCE/site2-01-box-open.txt"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 /bin/bash -s >"$box_open_file" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-01: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
root=/srv/commonswarm/site
test "$(id -un)" = commonswarm
test ! -e /tmp/commonswarm-site-window.env
test -z "$(find "$root" -maxdepth 1 \( -type f -o -type l \) -name 'current.next*' -print)"
test -z "$(find "$root/releases" -maxdepth 1 \( -type d -o -type l \) -name '.site-window-pin-*' -print)"
python3 - <<'PYBOXRELEASE'
import pathlib
# Linux exposes argv directly; inspect names without executing process tools.
for path in pathlib.Path("/proc").glob("[0-9]*/cmdline"):
    try:
        arguments = path.read_bytes().split(b"\0")
    except FileNotFoundError:
        continue
    except PermissionError:
        raise SystemExit("STOP: box site release process query unavailable")
    if any(arg.endswith((b"deploy/site/deploy.sh", b"finalize-release.sh")) for arg in arguments):
        raise SystemExit("STOP: another box site release process exists")
PYBOXRELEASE
test -w "$root" && test -w "$root/releases"
previous=$(readlink -f "$root/current")
test -L "$root/current"
python3 - "$previous" <<'PY'
import pathlib,re,sys
p=pathlib.Path(sys.argv[1]); root=pathlib.Path("/srv/commonswarm/site/releases").resolve(strict=True)
assert not p.is_symlink() and p.is_dir() and p.resolve(strict=True).parent==root
match=re.fullmatch(r"[0-9]{8}T[0-9]{6}Z-([0-9a-f]{12})-[0-9a-f]{16}",p.name)
assert match
print("BASELINE_SOURCE_PREFIX="+match[1])
PY
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
  box_open=$(cat "$box_open_file")
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
  source_prefix=$(printf '%s\n' "$box_open" | sed -n 's/^BASELINE_SOURCE_PREFIX=//p')
  test "${#source_prefix}" -eq 12
  case "$source_prefix" in *[!0-9a-f]*) exit 1 ;; esac
  measured_source=$(git -C "$SITE_RELEASE_REPO" rev-parse --verify "${source_prefix}^{commit}")
  if test "$measured_source" != "$EXPECTED_SITE_SHA"; then
    printf 'FAIL: EXPECTED_SITE_SHA expected=%s observed=%s; STOP\n' "$EXPECTED_SITE_SHA" "$measured_source" >&2
    exit 1
  fi
  BASELINE_DIR="$previous"
  git -C "$SITE_RELEASE_REPO" merge-base --is-ancestor "$measured_source" "$SITE_RELEASE_SHA"
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
    printf 'EXPECTED_SITE_SHA=%q\n' "$EXPECTED_SITE_SHA"
    printf 'SITE_BUILD_ENV_OP_REFERENCE=%q\n' "$SITE_BUILD_ENV_OP_REFERENCE"
    printf 'OP_SERVICE_ACCOUNT_TOKEN_FILE=%q\n' "$OP_SERVICE_ACCOUNT_TOKEN_FILE"
    printf 'BASELINE_DIR=%q\n' "$BASELINE_DIR"
    printf 'SITE_RELEASE_VERSION=%q\n' "$SITE_RELEASE_VERSION"
    printf 'GATE_EVIDENCE_FILE=%q\n' "$GATE_EVIDENCE_FILE"
  } >"$SITE_WINDOW_FILE"
  chmod 0600 "$SITE_WINDOW_FILE"
  printf '%s\n' "$box_open" >"$SITE_EVIDENCE/site2-01-open.txt"
  printf 'BASELINE_SOURCE_SHA=%s\nBASELINE_DIR=%s\n' "$measured_source" "$BASELINE_DIR" >>"$SITE_EVIDENCE/site2-01-open.txt"
  chmod 0600 "$SITE_EVIDENCE/site2-01-open.txt"
  install -m 0600 "$GATE_EVIDENCE_FILE" "$SITE_EVIDENCE/site2-00-gate-evidence.txt"
  # -p keeps the local 0600 mode; plain scp creates the box copy with the remote umask (0644), which the
  # close step refuses (live, lane 8 try 9). Fixed remote command, no variable arguments.
  scp -p "$SITE_WINDOW_FILE" commonswarm@yulan-vps-1:/tmp/commonswarm-site-window.env >/dev/null
  ssh commonswarm@yulan-vps-1 'chmod 0600 /tmp/commonswarm-site-window.env && test ! -L /tmp/commonswarm-site-window.env && test "$(stat -c %a /tmp/commonswarm-site-window.env)" = 600'
)
```

## 3. Produced inputs and pre-switch gates

```sh
# step: site2-00-a-close-ingest — Mac mini /bin/bash 3.2; Anvil; record current hosted MCP ON state
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-00-a-close-ingest: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  python3 - >"$SITE_EVIDENCE/site2-00-mcp-live.txt" <<'PY'
import json, urllib.error, urllib.request
UA = "commonswarm-release-probe/1.0"
RESOURCE = "https://mcp.commonswarm.com/mcp"
def fetch(url, method="GET", data=None):
    request = urllib.request.Request(url, method=method, data=data, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Content-Type": "application/json", "Accept-Encoding": "identity",
    })
    try:
        return urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        return error
with fetch("https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp") as response:
    if response.status != 200 or response.headers.get_content_type() != "application/json":
        raise SystemExit("STOP: MCP protected-resource metadata must be 200 JSON before GO")
    raw = response.read(1048577)
    if len(raw) > 1048576 or json.loads(raw).get("resource") != RESOURCE:
        raise SystemExit("STOP: MCP protected-resource metadata resource mismatch before GO")
print("MCP_METADATA=PASS status=200 media_type=application/json resource=" + RESOURCE)
with fetch(RESOURCE, method="POST", data=b"{}") as response:
    if response.status != 401:
        raise SystemExit("STOP: unauthenticated MCP POST must be 401 before GO")
print("MCP_POST=PASS status=401 authenticated=no")
print("MCP_LIVE=PASS user_agent=" + UA)
PY
  chmod 0600 "$SITE_EVIDENCE/site2-00-mcp-live.txt"
)
```

```sh
# step: site2-00-build-env — Mac mini /bin/bash 3.2; Anvil; install and validate protected build settings
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-00-build-env: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
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
  node - <<'NODE' >"$SITE_EVIDENCE/site2-00-build-env.txt"
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
  chmod 0600 "$SITE_EVIDENCE/site2-00-build-env.txt"
  rm -r -- "$SITE_BUILD_ENV_TEMP"
  test ! -e "$SITE_BUILD_ENV_TEMP"
  trap - EXIT INT TERM
)
```

`site2-02` produces the full site2-only inventory from the full live base and
verifies the deletion guards at the release SHA. The stale deletion hold is
removed: `deploy.sh:47-116,242-254` and
`finalize-release.sh:35-106,160-215` contain the guards/call sites, while
`tests/p1-cli/site-deletion-safety.test.ts:65-122,183-221` contains refusal and
positive controls.

```sh
# step: site2-02 — Mac mini /bin/bash 3.2; Anvil; exact source and guard reconciliation
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-02: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test "${#SITE_RELEASE_SHA}" -eq 40
  case "$SITE_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  test "${#EXPECTED_SITE_SHA}" -eq 40
  case "$EXPECTED_SITE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  git merge-base --is-ancestor "$SITE_RELEASE_SHA" origin/main
  git merge-base --is-ancestor "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA"
  test -n "$(git diff --name-only "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/)"
  git diff --exit-code HEAD -- site deploy/site tests/p1-cli/site-deletion-safety.test.ts
  git show "$SITE_RELEASE_SHA:deploy/site/deploy.sh" | grep -q guarded_delete
  git show "$SITE_RELEASE_SHA:deploy/site/finalize-release.sh" | grep -q guarded_delete
  git show "$SITE_RELEASE_SHA:tests/p1-cli/site-deletion-safety.test.ts" | \
    grep -q 'deletes valid temporary paths'
  git show "$SITE_RELEASE_SHA:tests/p1-cli/site-deletion-safety.test.ts" | \
    grep -q 'with a valid-delete control'
  umask 077
  git log --format='%H %s' "$EXPECTED_SITE_SHA..$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site2-02-commits.txt"
  git diff --name-status "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site2-02-name-status.txt"
  git diff --numstat "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/ \
    >"$SITE_EVIDENCE/site2-02-numstat.txt"
  commit_count=$(git rev-list --count "$EXPECTED_SITE_SHA..$SITE_RELEASE_SHA" -- site/)
  listed_commit_count=$(wc -l <"$SITE_EVIDENCE/site2-02-commits.txt" | tr -d ' ')
  changed_count=$(git diff --name-only "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA" -- site/ | wc -l | tr -d ' ')
  listed_count=$(wc -l <"$SITE_EVIDENCE/site2-02-name-status.txt" | tr -d ' ')
  test "$commit_count" -eq "$listed_commit_count"
  test "$changed_count" -eq "$listed_count"
  {
    printf 'base=%s\ntarget=%s\n' "$EXPECTED_SITE_SHA" "$SITE_RELEASE_SHA"
    printf 'site_commit_count=%s\nsite_changed_file_count=%s\n' "$commit_count" "$changed_count"
    printf '%s\n' 'DELETE_GUARDS=PASS' 'SOURCE_RECONCILIATION=PASS'
  } >"$SITE_EVIDENCE/site2-02-summary.txt"
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
signed-in and mobile claims as NOT PROVED. Every headless Chromium launch uses
`--no-sandbox`: Chromium's macOS seatbelt cannot initialize inside the release
worker's sandbox. The worker's outer `sandbox-exec` profile
`~/.config/agent-sandbox/no-real-chrome.sb` supplies containment, denying execution
of installed Chrome and reads of real Chrome profiles and the macOS keychain.
Only Playwright's bundled Chromium may run; later CDP controls reuse that process.
A keychain dialog is STOP, never a
click-through or reduced-control fallback.

**Task-browser controller.** `scripts/site-task-browser.mjs`, copied mode 0600
from the clean exact-SHA checkout into the private root, is the only process
that launches, probes, or closes the task browser:

- `start` launches one detached controller. It creates a fresh mode-0700
  `profile-XXXXXX` inside the private root, launches the bundled Chromium
  (refusing anything outside the Playwright cache or under `/Applications`) as
  its own child with `--headless --no-sandbox --password-store=basic
  --use-mock-keychain` and a loopback DevTools port it reads from
  `DevToolsActivePort`, and writes a mode-0600 state file (controller PID,
  browser PID, start time, executable path, profile, random token). Its control
  channel is a mode-0600 Unix socket in the private root, authenticated by that
  token. The controller has a five-hour lifetime cap.
- `probe` asks the controller to prove its own child is alive and its endpoint
  answers as HeadlessChrome, then opens and closes `/app` in a new target. It
  never launches a second browser. Any failure prints
  `TASK_BROWSER_PROBE=NOT_PROVED reason=<category>`.
- `close` is idempotent. A live controller stops its own child (TERM, then KILL,
  only through its child handle), removes the exact profile it created, and
  exits. If the controller and browser are already gone, close passes. If the
  controller is gone and the recorded browser PID still exists, close STOPs
  without signalling it. No block uses `ps`, `pgrep`, `lsof` for ownership, a
  setuid tool, or a PID read from the window file.

Each browser step uses a unique named harness daemon derived from the window ID,
step, and private-root suffix, with its own private runtime directory. Its EXIT
trap stops only that exact named daemon on success or failure. The harness only
attaches to the controller's loopback endpoint; it never launches a browser.
Later controls reuse the controller-owned browser and leave removal to
`site2-07` close or `site2-browser-close`. The controller runs in its own
session with stdin closed, so ending a marked block's process group does not
stop it.
Raw harness output and daemon logs stay under the private secret-staging root
until failure cleanup or window close. Only a sanitized mode-0600 summary is
retained in `SITE_EVIDENCE`: the last numbered STEP, exit code, and filtered
stderr categories, with arbitrary error details withheld. STEP 0 means harness
setup failed before Python started; its one-line cause retains the exit code,
signal when available, and first stderr line with home paths redacted and
sensitive-looking details withheld. Steps 1–13 are attachment, navigation,
document load, app readiness, state snapshot, keychain/challenge check, branch
selection, account label, user identity, starting workspace, workspace switch,
switch wait, and receipt write. STEP 4 requires a non-loading dashboard state
and exactly one visible panel before reading sign-in state. Acceptance and
rollback controls repeat this same attachment and readiness check after navigation
to `/app`; their numbered stages and filtered summaries identify failures without
retaining raw browser output in the public evidence directory.

```sh
# step: site2-03-browser-session-preflight — Mac mini /bin/bash 3.2; Anvil; fresh headless Chromium identity and workspace preflight
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-03-browser-session-preflight: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  umask 077
  test "$(command -v rm)" = "$HOME/.local/bin/rm"
  browser_root="$(mktemp -d /private/tmp/anvil-secret.XXXXXX)"
  case "$browser_root" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
  controller_started=0
  harness_started=0
  keep_browser=0
  task_browser="$browser_root/site-task-browser.mjs"
  cleanup_browser_preflight() {
    status=$?
    trap - EXIT
    if [ "$harness_started" -eq 1 ]; then
      # --reload only stops; these exact name/runtime settings never address default.
      if ! BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
        BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
        BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 \
        browser-harness --reload >"$private_evidence/harness-stop.stdout" \
        2>"$private_evidence/harness-stop.stderr"; then
        printf '%s\n' 'STOP: named preflight daemon cleanup failed; details withheld' >&2
        status=1
        keep_browser=0
      fi
    fi
    if [ "$keep_browser" -eq 1 ] && [ "$status" -eq 0 ]; then exit 0; fi
    if [ "$controller_started" -eq 1 ]; then
      # Only the controller stops its own child browser and removes its profile.
      if ! node "$task_browser" close --state-dir "$browser_root" >"$browser_root/controller-close.txt" 2>&1; then
        printf 'STOP: preflight task-browser close unproved; retain %s and window state for HezLead reconciliation\n' "$browser_root" >&2
        exit 1
      fi
    fi
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
  private_evidence="$browser_root/evidence"
  harness_runtime="$browser_root/harness-runtime"
  harness_name="site2-${SITE_WINDOW_ID}-03-${browser_root##*.}"
  mkdir -m 0700 "$private_evidence" "$harness_runtime"
  harness_stdout="$private_evidence/harness.stdout"
  harness_stderr="$private_evidence/harness.stderr"
  : >"$harness_stdout"; : >"$harness_stderr"
  chmod 0600 "$harness_stdout" "$harness_stderr"
  # The controller comes only from the exact, clean release checkout.
  test "$(git -C "$SITE_RELEASE_REPO" rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  git -C "$SITE_RELEASE_REPO" cat-file -e HEAD:scripts/site-task-browser.mjs
  git -C "$SITE_RELEASE_REPO" diff --exit-code HEAD -- scripts/site-task-browser.mjs
  install -m 0600 "$SITE_RELEASE_REPO/scripts/site-task-browser.mjs" "$task_browser"
  # Resolve Playwright's bundled Chromium without launching it or /Applications.
  chrome="$(node -e 'console.log(require(process.argv[1]).chromium.executablePath())' \
    "$(npm root -g)/playwright")"
  case "$chrome" in "$HOME/Library/Caches/ms-playwright/"*) ;; *) exit 1 ;; esac
  test -x "$chrome"
  CLI_USER_ID="$(cswarm status \
    --workspace-id c2ea0541-f56d-4c73-bf71-56c5405c4934 --json | jq -er '.identity.user_id')"
  test "$CLI_USER_ID" = d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc
  # The detached controller holds Chromium as its own child with a fresh 0700
  # profile, --no-sandbox, --password-store=basic and --use-mock-keychain, and
  # serves a token-authenticated socket inside this private root.
  controller_started=1
  node "$task_browser" start --state-dir "$browser_root" --executable "$chrome" \
    </dev/null >"$browser_root/controller-start.txt" 2>&1
  endpoint="$(sed -n 's/^TASK_BROWSER_ENDPOINT=//p' "$browser_root/controller-start.txt")"
  case "$endpoint" in http://127.0.0.1:[1-9]*) ;; *) exit 1 ;; esac
  case "${endpoint#http://127.0.0.1:}" in *[!0-9]*) exit 1 ;; esac
  {
    printf 'SITE_BROWSER_ROOT=%q\n' "$browser_root"
    printf 'SITE_TASK_BROWSER=%q\n' "$task_browser"
    printf 'SITE_CHROME_ENDPOINT=%q\n' "$endpoint"
  } >>"$SITE_WINDOW_FILE"
  chmod 0600 "$SITE_WINDOW_FILE"
  export CLI_USER_ID SITE_EVIDENCE
  harness_status=0
  harness_started=1
  BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
    BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
    BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 BH_TAB_MARKER=0 \
    browser-harness >"$harness_stdout" 2>"$harness_stderr" <<'PY' || harness_status=$?
import json, os, pathlib, time, urllib.request
expected_user = "d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"
start_workspace = "292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
control_workspace = "c2ea0541-f56d-4c73-bf71-56c5405c4934"
print("STEP 1", flush=True)
endpoint = os.environ["BU_CDP_URL"]
def endpoint_json(path):
    # Loopback only; bypass ambient HTTP proxies. Never print endpoint responses.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(endpoint + path, timeout=5) as response:
        return json.load(response)
version = endpoint_json("/json/version")
attached_version = cdp("Browser.getVersion")
attached_target = current_tab()["targetId"]
if (not version.get("webSocketDebuggerUrl", "").startswith(
        endpoint.replace("http://", "ws://", 1) + "/devtools/browser/")
    or "HeadlessChrome/" not in attached_version.get("userAgent", "")
    or attached_version.get("product") != version.get("Browser")
    or attached_version.get("userAgent") != version.get("User-Agent")
    or not any(target.get("id") == attached_target for target in endpoint_json("/json/list"))):
    raise SystemExit("STOP: STEP 1 endpoint ownership")
print("STEP 2", flush=True)
new_tab("https://commonswarm.com/app")
print("STEP 3", flush=True)
if not wait_for_load(): raise SystemExit("STOP: STEP 3 document load timeout")
print("STEP 4", flush=True)
deadline = time.monotonic() + 30
ready = False
while time.monotonic() < deadline:
    ready = js("""(() => {
      const app=document.querySelector('live-dashboard[data-state]');
      if(!app || !app.dataset.state || app.dataset.state==='loading') return false;
      if(!app.querySelector('[data-panel="signed-out"]')) return false;
      const visible=[...app.querySelectorAll('.dashboard__root > [data-panel]')]
        .filter(panel=>!panel.hidden && panel.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      return visible.length===1 && visible[0].dataset.panel===app.dataset.state;
    })()""")
    if ready: break
    time.sleep(.25)
if not ready: raise SystemExit("STOP: STEP 4 app readiness timeout")
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
        signedOut:!document.querySelector('[data-panel="signed-out"]')?.hasAttribute('hidden')};
    })()""")
print("STEP 5", flush=True)
observed=state()
signin_attempted=False
# A fresh profile has no inherited operator SSO. This view-only control never
# initiates sign-in. Signed-out state selects the existing reduced branch.
print("STEP 6", flush=True)
if js("/keychain/i.test(document.body?.innerText||'')"): raise SystemExit('STOP: STEP 6 keychain dialog')
challenge=js("/two-factor|2fa|verification code/i.test(document.body?.innerText||'')")
print("STEP 7", flush=True)
if observed.get("signedOut") or challenge:
    result={"branch":"REDUCED-CONTROL","signin_attempted":signin_attempted,
      "reason":"signed-out-or-interactive-challenge",
      "signed_in_connected_apps_load":"NOT PROVED","signed_in_empty_state":"NOT PROVED",
      "signed_in_no_creation_action":"NOT PROVED","signed_in_console_clean":"NOT PROVED",
      "mobile_320":"NOT PROVED","mobile_390":"NOT PROVED"}
else:
    print("STEP 8", flush=True)
    if observed["display"] != "Ridgeio": raise SystemExit(1)
    print("STEP 9", flush=True)
    if observed["userId"] != expected_user or observed["userId"] != os.environ["CLI_USER_ID"]: raise SystemExit(1)
    print("STEP 10", flush=True)
    if observed["selectedWorkspace"] != start_workspace: raise SystemExit(1)
    print("STEP 11", flush=True)
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    switched=js("""(() => { const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="c2ea0541-f56d-4c73-bf71-56c5405c4934"]');
      if(!target)return false; target.click(); return true; })()""")
    if not switched: raise SystemExit(1)
    print("STEP 12", flush=True)
    for _ in range(60):
        time.sleep(.5); observed=state()
        if observed.get("selectedWorkspace")==control_workspace: break
    if observed.get("selectedWorkspace") != control_workspace: raise SystemExit(1)
    result={"branch":"FULL-CONTROL","account_label":"Ridgeio",
      "cli_user_id":expected_user,"web_user_id":expected_user,
      "start_workspace_id":start_workspace,"control_workspace_id":control_workspace}
print("STEP 13", flush=True)
path=pathlib.Path(os.environ["SITE_EVIDENCE"])/"site2-03-browser-preflight.json"
path.write_text(json.dumps(result,sort_keys=True,indent=2)+"\n",encoding="utf-8"); path.chmod(0o600)
PY
  python3 - "$harness_stdout" "$harness_stderr" "$harness_status" "$SITE_EVIDENCE" <<'PY'
import collections, pathlib, re, signal, sys
stdout, stderr = map(pathlib.Path, sys.argv[1:3])
code = int(sys.argv[3])
names = {0:"harness setup", 1:"attachment", 2:"navigation", 3:"document load",
    4:"app readiness", 5:"state snapshot", 6:"keychain/challenge", 7:"branch selection",
    8:"account label", 9:"user identity", 10:"starting workspace", 11:"workspace switch",
    12:"switch wait", 13:"receipt write"}
step = 0
with stdout.open(encoding="utf-8", errors="replace") as stream:
    for line in stream:
        match = re.fullmatch(r"STEP ([1-9]|1[0-3])\n?", line)
        if match: step = int(match[1])
# Reject sensitive-looking lines, then emit only fixed categories/line numbers.
# No arbitrary message, source-code line, URL, file path or exception detail passes.
unsafe = re.compile(r"token|jwt|email|cookie|session|bearer|credential|password|secret|"
    r"authorization|localstorage|@|https?://|wss?://|eyJ[A-Za-z0-9_-]*\.|"
    r"[A-Za-z0-9_+/=-]{24,}|[\x00-\x08\x0b-\x1f\x7f]", re.I)
classes = ("RuntimeError", "TimeoutError", "ConnectionError", "ConnectionRefusedError",
    "OSError", "PermissionError", "FileNotFoundError", "KeyError", "ValueError",
    "TypeError", "AssertionError", "SyntaxError", "ImportError", "ModuleNotFoundError")
named = {"STOP: STEP 1 endpoint ownership", "STOP: STEP 3 document load timeout",
    "STOP: STEP 4 app readiness timeout", "STOP: STEP 6 keychain dialog"}
with stderr.open(encoding="utf-8", errors="replace") as stream:
    first_stderr = stream.readline().rstrip("\r\n")
    stream.seek(0)
    tail = collections.deque(stream, maxlen=20)
safe = []
for raw in tail:
    line = raw.rstrip("\n")
    if unsafe.search(line): continue
    if line in named:
        safe.append(line)
        continue
    for kind in classes:
        if line == kind or line.startswith(kind + ":"):
            safe.append(kind + " (details withheld)")
            break
    else:
        match = re.fullmatch(r'\s*File "<string>", line ([0-9]{1,6})(?:, in .*)?', line)
        if match: safe.append("Python line " + match[1])
summary = [f"site2-03-browser-preflight: STEP {step} ({names[step]}); exit code {code}"]
if step == 0 and code != 0:
    signum = -code if code < 0 else code - 128 if 128 < code <= 192 else 0
    if signum:
        try: summary[0] += "; signal " + signal.Signals(signum).name
        except ValueError: pass
    # Redact quoted home paths (including spaces), then unquoted home paths.
    home = re.escape(str(pathlib.Path.home()))
    cause = re.sub(r"([\"'])" + home + r"(?:/[^\r\n]*?)?\1",
        "[HOME]", first_stderr)
    cause = re.sub(home + r"(?:/[^\s\"'<>]*)?", "[HOME]", cause)
    if unsafe.search(cause): cause = "sensitive stderr details withheld"
    summary[0] += "; stderr: " + (cause[:500] or "no stderr emitted")
else:
    summary += ["stderr: " + line for line in safe[-8:]]
    if not safe: summary.append("stderr: no safe detail retained")
text = "\n".join(summary) + "\n"
path = pathlib.Path(sys.argv[4]) / "site2-03-browser-preflight-summary.txt"
path.write_text(text, encoding="utf-8"); path.chmod(0o600)
print(text, end="")
PY
  if [ "$harness_status" -ne 0 ]; then exit "$harness_status"; fi
  keep_browser=1
)
```

`site2-03` validates the build environment and the automatically selected
browser branch. No bearer is exported from Chrome and no revoke is exercised.

```sh
# step: site2-03 — Mac mini /bin/bash 3.2; Anvil; environment and browser-branch validation
# readonly: yes
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-03: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  test -f site/.env && test ! -L site/.env
  test "$(stat -f '%Lp' site/.env)" = 600
  node deploy/site/validate-site-env.mjs site/.env </dev/null
  test -f "$SITE_EVIDENCE/site2-03-browser-preflight.json"
  test ! -L "$SITE_EVIDENCE/site2-03-browser-preflight.json"
  test "$(stat -f '%Lp' "$SITE_EVIDENCE/site2-03-browser-preflight.json")" = 600
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site2-03-browser-preflight.json")"
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
# step: site2-03-pin-previous — Mac mini /bin/bash 3.2; Anvil; pin measured rollback tree
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-03-pin-previous: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  printf -v box_command '%q ' /bin/bash -s -- "$SITE_WINDOW_ID" "$BASELINE_DIR"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
    >"$SITE_EVIDENCE/site2-03-pin.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-03-pin-previous: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
window_id=${1:-}
case "$window_id" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
esac
root=/srv/commonswarm/site
previous=$2
test -f /tmp/commonswarm-site-window.env && test ! -L /tmp/commonswarm-site-window.env
test "$(stat -c '%a' /tmp/commonswarm-site-window.env)" = 600
(
  . /tmp/commonswarm-site-window.env
  test "$SITE_WINDOW_ID" = "$window_id"
  test "$BASELINE_DIR" = "$previous"
)
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
  chmod 0600 "$SITE_EVIDENCE/site2-03-pin.txt"
  previous=$(sed -n 's/^previous_original=//p' "$SITE_EVIDENCE/site2-03-pin.txt")
  pin=$(sed -n 's/^previous_pin=//p' "$SITE_EVIDENCE/site2-03-pin.txt")
  test "$previous" = "$BASELINE_DIR"
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
# step: site2-03-go-record — Mac mini /bin/bash 3.2; Anvil; write exact bounded GO
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-03-go-record: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  : "${SITE_APPROVER:?named input missing}"
  : "${SITE_PLAN_COMMIT:?named input missing}"
  : "${SITE_PROMPT_NUMBER:?named input missing}"
  test "$SITE_APPROVER" = HezLead
  test "${#SITE_PLAN_COMMIT}" -eq 40
  case "$SITE_PLAN_COMMIT" in *[!0-9a-f]*) exit 1 ;; esac
  case "$SITE_PROMPT_NUMBER" in ''|*[!0-9]*|0) exit 1 ;; esac
  test "${#SITE_RELEASE_SHA}" -eq 40
  case "$SITE_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  test "${#EXPECTED_SITE_SHA}" -eq 40
  case "$EXPECTED_SITE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  grep -qFx 'MCP_LIVE=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site2-00-mcp-live.txt"
  python3 - "$SITE_EVIDENCE/site2-00-gate-evidence.txt" "$SITE_RELEASE_SHA" <<'PY'
import pathlib,sys
p=pathlib.Path(sys.argv[1]); assert p.is_absolute() and p.is_file() and not p.is_symlink()
lines=p.read_text().splitlines()
assert [line for line in lines if line.startswith("SHA=")]==["SHA="+sys.argv[2]]
for gate in ("site build", "site tests", "site CI"):
    assert gate+": PASS" in lines, "STOP: exact-SHA site gate missing"
PY
  grep -qFx 'PIN=PASS' "$SITE_EVIDENCE/site2-03-pin.txt"
  grep -qFx 'DELETE_GUARDS=PASS' "$SITE_EVIDENCE/site2-02-summary.txt"
  test -f "$SITE_EVIDENCE/site2-03-browser-preflight.json"
  test ! -e "$SITE_EVIDENCE/GO.txt"
  umask 077
  python3 - >"$SITE_EVIDENCE/site2-03-mcp-live.txt" <<'PY'
import json, urllib.error, urllib.request
UA = "commonswarm-release-probe/1.0"
RESOURCE = "https://mcp.commonswarm.com/mcp"
def fetch(url, method="GET", data=None):
    request = urllib.request.Request(url, method=method, data=data, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Content-Type": "application/json", "Accept-Encoding": "identity",
    })
    try:
        return urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        return error
with fetch("https://mcp.commonswarm.com/.well-known/oauth-protected-resource/mcp") as response:
    if response.status != 200 or response.headers.get_content_type() != "application/json":
        raise SystemExit("STOP: MCP protected-resource metadata must be 200 JSON before GO")
    raw = response.read(1048577)
    if len(raw) > 1048576 or json.loads(raw).get("resource") != RESOURCE:
        raise SystemExit("STOP: MCP protected-resource metadata resource mismatch before GO")
print("MCP_METADATA=PASS status=200 media_type=application/json resource=" + RESOURCE)
with fetch(RESOURCE, method="POST", data=b"{}") as response:
    if response.status != 401:
        raise SystemExit("STOP: unauthenticated MCP POST must be 401 before GO")
print("MCP_POST=PASS status=401 authenticated=no")
print("MCP_LIVE=PASS user_agent=" + UA)
PY
  chmod 0600 "$SITE_EVIDENCE/site2-03-mcp-live.txt"
  {
    printf 'APPROVER=%s\nPLAN_COMMIT=%s\nSHA=%s\nBASE_SHA=%s\nPROMPT_NUMBER=%s\n' \
      "$SITE_APPROVER" "$SITE_PLAN_COMMIT" "$SITE_RELEASE_SHA" "$EXPECTED_SITE_SHA" "$SITE_PROMPT_NUMBER"
    printf '%s\n' 'HOSTED_MCP_ON=yes' 'EXACT_SHA_SITE_GATES=PASS'
    printf '%s\n' 'CONNECTED_APPS_EXPOSURE=accepted-empty-or-populated-view-only' 'LIVE_REVOKE_CONTROL=NOT_PROVED_BY_SITE_RELEASE'
    jq -r '"BROWSER_BRANCH=" + .branch' "$SITE_EVIDENCE/site2-03-browser-preflight.json"
    printf '%s\n' 'ROLLBACK_PIN=verified' 'All release holds resolved'
  } >"$SITE_EVIDENCE/GO.txt"
  chmod 0600 "$SITE_EVIDENCE/GO.txt"
)
```

## 4. Build, upload, switch, and failure reconciliation

```sh
# step: site2-04 — Mac mini /bin/bash 3.2; Anvil; exact-SHA production deployment
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-04: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  cd "$SITE_RELEASE_REPO"
  test "$(git rev-parse HEAD)" = "$SITE_RELEASE_SHA"
  git diff --exit-code HEAD -- site deploy/site
  grep -qFx "SHA=$SITE_RELEASE_SHA" "$SITE_EVIDENCE/GO.txt"
  grep -qFx "BASE_SHA=$EXPECTED_SITE_SHA" "$SITE_EVIDENCE/GO.txt"
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
  test "$previous" = "$BASELINE_DIR"
  test "$pin" = "/srv/commonswarm/site/releases/.site-window-pin-$SITE_WINDOW_ID"
  printf -v box_command '%q ' /bin/bash -s -- "$previous" "$pin"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" <<'BOX'
set -euo pipefail
test "$(readlink -f /srv/commonswarm/site/current)" = "$1"
test -f "$2/app/index.html"
BOX
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
  case "$after" in /srv/commonswarm/site/releases/????????T??????Z-${SITE_RELEASE_SHA:0:12}-????????????????) ;; *) exit 1 ;; esac
  printf -v box_command '%q ' /bin/bash -s -- "$pin"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" <<'BOX'
set -euo pipefail
test -f "$1/app/index.html"
BOX
  printf '%s\n' 'PIN_AFTER_DEPLOY=PASS' >"$SITE_EVIDENCE/pin-after-deploy.txt"
  chmod 0600 "$SITE_EVIDENCE/pin-after-deploy.txt"
)
```

Run `site2-04-reconcile-failure` only after a nonzero/disconnected `site2-04`.
No switch means failed close with no retry; the exact target current means
immediate rollback; a third state stops for incident handling.

```sh
# step: site2-04-reconcile-failure — Mac mini /bin/bash 3.2; Anvil; one-shot no-retry reconciliation
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-04-reconcile-failure: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  previous=$(cat "$SITE_EVIDENCE/previous.original")
  pin=$(cat "$SITE_EVIDENCE/previous.release")
  current=$(ssh -o BatchMode=yes commonswarm@yulan-vps-1 'readlink -f /srv/commonswarm/site/current')
  if test "$current" = "$previous"; then
    printf '%s\n' 'DEPLOYMENT=failed-before-switch' 'RETRY=forbidden' \
      >"$SITE_EVIDENCE/site2-04-reconciliation.txt"
  else
    case "$current" in /srv/commonswarm/site/releases/????????T??????Z-${SITE_RELEASE_SHA:0:12}-????????????????) ;; *) exit 1 ;; esac
    printf -v box_command '%q ' /bin/bash -s -- "$pin" "$current" "$SITE_WINDOW_ID"
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
      >"$SITE_EVIDENCE/rollback-auto.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-04-reconcile-failure: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
pin=$1; failed=$2; window_id=$3; root=/srv/commonswarm/site; next="$root/current.next.$window_id"
test "$pin" = "$root/releases/.site-window-pin-$window_id"
test -f "$pin/app/index.html"; test "$(readlink -f "$root/current")" = "$failed"
test ! -e "$next" && test ! -L "$next"
ln -s "$pin" "$next"; mv -Tf "$next" "$root/current"
test "$(readlink -f "$root/current")" = "$pin"
printf 'rollback_reason=deployment-failure-after-switch\nrestored_release=%s\n' "$pin"
BOX
    printf '%s\n' 'DEPLOYMENT=failed-after-switch' 'RETRY=forbidden' \
      >"$SITE_EVIDENCE/site2-04-reconciliation.txt"
  fi
  chmod 0600 "$SITE_EVIDENCE/site2-04-reconciliation.txt"
  test ! -e "$SITE_EVIDENCE/retry-approved"
)
```

## 5. Post-switch controls

Every scripted public request uses `User-Agent:
commonswarm-release-probe/1.0`. A failed public control automatically restores
the pin. Browser state cannot prevent these page/asset checks from running.

HezLead's acceptance decision table uses the mode selected by `site2-03` only to
choose which browser assertions run. Browser evidence is optional: only
deployment and public page/asset checks may roll back. The receipt still records
whether product assertions started (`ASSERTIONS_STARTED` marker), so a
FULL-CONTROL `NOT_PROVED` after assertions started is visible to HezLead. A
`NOT_PROVED` result requires the separate `site2-05-public.txt` PASS receipt;
it never converts a public-byte or deployment failure into a success.

| Mode | Failure type | Blocking? | Automatic rollback? |
|---|---|---|---|
| Either | Deployment failure or public page/asset byte failure | Yes | Yes (site2-04 reconciliation restores the pin if switched) |
| Either | Any browser step: controller probe, setup, harness, attachment, readiness, assertion or daemon cleanup, before or after assertions started | No; `browser_acceptance=NOT_PROVED reason=<named STEP or STOP line>` | No |
| Either | Browser acceptance passed | No | No |

`site2-06` verifies rollback public bytes before attempting its browser re-check.
Its browser failures record `NOT_PROVED`, are never blocking, and never perform
another rollback. A public-byte verification failure remains blocking in both
modes. No rollback marker means `not-needed`; that path does not require a
running browser.

```sh
# step: site2-05 — Mac mini /bin/bash 3.2; Anvil; public bytes with automatic rollback
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  umask 077
  control_summary="$SITE_EVIDENCE/site2-05-public-summary.txt"
  printf '%s\n' 'site2-05: STEP 0 (control setup); exit code pending' >"$control_summary"
  chmod 0600 "$control_summary"
  finish_public_control() {
    status=$1
    trap - EXIT
    # Covers setup, control, daemon cleanup and rollback failures, even before Python.
    printf 'site2-05: final exit code %s\n' "$status" >>"$control_summary"
    chmod 0600 "$control_summary"
    exit "$status"
  }
  trap 'finish_public_control "$?"' EXIT
  set +e
  trap - ERR
  (
    trap - EXIT
    set -e
    after=$(cat "$SITE_EVIDENCE/after.release")
    printf -v box_command '%q ' /bin/bash -s -- "$after" "$SITE_RELEASE_SHA" "$SITE_RELEASE_VERSION"
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
    >"$SITE_EVIDENCE/site2-05-public.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
expected=$1
python3 - "$expected" "$2" "$3" <<'PY'
import hashlib,json,pathlib,re,sys,urllib.error,urllib.request
UA="commonswarm-release-probe/1.0"; root=pathlib.Path("/srv/commonswarm/site")
release=(root/"current").resolve(strict=True); assert str(release)==sys.argv[1]
assert re.fullmatch(r"\d{8}T\d{6}Z-"+re.escape(sys.argv[2][:12])+r"-[0-9a-f]{16}",release.name)
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
download=(release/"download/index.html").read_bytes(); assert sys.argv[3].encode() in download
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
  )
  control_status=$?
  set -e
  if [ -f "$SITE_EVIDENCE/site2-05-public.txt" ]; then chmod 0600 "$SITE_EVIDENCE/site2-05-public.txt"; fi
  if test "$control_status" -ne 0; then
    pin=$(cat "$SITE_EVIDENCE/previous.release"); after=$(cat "$SITE_EVIDENCE/after.release")
    printf -v box_command '%q ' /bin/bash -s -- "$pin" "$after" "$SITE_WINDOW_ID"
    ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
      >"$SITE_EVIDENCE/rollback-auto.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-05: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
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
release assets, a successful EMPTY or POPULATED Connected apps list, no
creation action, clean console, and
320px/390px one-row geometry. Reduced control stays signed out, proves the
shipped bundle has the surface and no creation action, and records the four
signed-in claims as `NOT PROVED`. All actions are view-only: do not click a
revoke control, create action, or Sign out. The full branch switches back to
the recorded start workspace before it finishes. The decision table above governs
failure: this block never contacts the box and never rolls back. Every completed attempt writes a sanitized summary and mode-0600
`site2-05-browser-acceptance-receipt.txt`, including a named STEP/STOP reason for `NOT_PROVED`.
The receipt records the raw browser exit code separately from the step exit code;
a non-blocking browser failure exits zero so the release continues to close.

```sh
# step: site2-05-browser-acceptance — Mac mini /bin/bash 3.2; Anvil; fresh headless Chromium acceptance
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-05-browser-acceptance: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  umask 077
  control_summary="$SITE_EVIDENCE/site2-05-browser-acceptance-summary.txt"
  printf '%s\n' 'site2-05-browser-acceptance: STEP 0 (control setup); exit code pending' >"$control_summary"
  chmod 0600 "$control_summary"
  finish_browser_acceptance() {
    status=$1
    trap - EXIT
    # Covers setup, control, daemon cleanup and rollback failures, even before Python.
    printf 'site2-05-browser-acceptance: final exit code %s\n' "$status" >>"$control_summary"
    chmod 0600 "$control_summary"
    exit "$status"
  }
  trap 'finish_browser_acceptance "$?"' EXIT
  # Public acceptance is a prerequisite, regardless of browser outcome.
  grep -qFx 'PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site2-05-public.txt"
  test ! -f "$SITE_EVIDENCE/rollback-auto.txt"
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site2-03-browser-preflight.json")"
  case "$branch" in FULL-CONTROL|REDUCED-CONTROL) ;; *) exit 1 ;; esac
  test ! -e "$SITE_EVIDENCE/site2-05-browser-acceptance-assertions-started.txt"
  check_task_browser() {
    browser_reason=
    case "${SITE_BROWSER_ROOT:-}" in /private/tmp/anvil-secret.??????) ;; *) browser_reason='controller missing' ;; esac
    if [ -z "$browser_reason" ] && [ "${SITE_TASK_BROWSER:-}" != "$SITE_BROWSER_ROOT/site-task-browser.mjs" ]; then
      browser_reason='controller missing'
    fi
    if [ -z "$browser_reason" ]; then
      # The controller alone proves its own child browser and endpoint; no PID is read here.
      probe_file="$SITE_BROWSER_ROOT/site2-05-probe.txt"
      if ! node "$SITE_TASK_BROWSER" probe --state-dir "$SITE_BROWSER_ROOT" https://commonswarm.com/app \
        </dev/null >"$probe_file" 2>&1; then
        browser_reason="probe $(sed -n 's/^TASK_BROWSER_PROBE=NOT_PROVED reason=//p' "$probe_file" 2>/dev/null | head -n 1 || true)"
        case "$browser_reason" in 'probe '[a-z]*) ;; *) browser_reason='probe failed' ;; esac
        case "${browser_reason#probe }" in *[!a-z-]*) browser_reason='probe failed' ;; esac
      elif ! grep -qFx "TASK_BROWSER_ENDPOINT=${SITE_CHROME_ENDPOINT:-}" "$probe_file"; then
        browser_reason='endpoint changed'
      fi
    fi
    if [ -n "$browser_reason" ]; then
      printf 'STOP site2-05: task-owned Chromium is not running (%s)\n' "$browser_reason" >>"$control_summary"
      printf 'STOP site2-05: task-owned Chromium is not running (%s)\n' "$browser_reason" >&2
      return 1
    fi
  }
  export SITE_EVIDENCE SITE_CHROME_ENDPOINT
  set +e
  # Capture the complete control failure without echoing its Python/source text.
  trap - ERR
  (
    trap - EXIT
    set -e
    check_task_browser
    umask 077
    case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test -d "$SITE_BROWSER_ROOT" && test ! -L "$SITE_BROWSER_ROOT"
    test "$(stat -f '%Lp' "$SITE_BROWSER_ROOT")" = 700
    endpoint="$SITE_CHROME_ENDPOINT"
    private_evidence="$SITE_BROWSER_ROOT/site2-05-browser-acceptance-evidence"
    harness_runtime="$SITE_BROWSER_ROOT/harness-runtime-05"
    harness_name="site2-${SITE_WINDOW_ID}-05-${SITE_BROWSER_ROOT##*.}"
    mkdir -m 0700 "$private_evidence" "$harness_runtime"
    harness_stdout="$private_evidence/harness.stdout"
    harness_stderr="$private_evidence/harness.stderr"
    : >"$harness_stdout"; : >"$harness_stderr"
    chmod 0600 "$harness_stdout" "$harness_stderr"
    harness_started=0
    cleanup_browser_control() {
      status=$?
      trap - EXIT
      if [ "$harness_started" -eq 1 ]; then
        # --reload only stops; these exact name/runtime settings never address default.
        if ! BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
          BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
          BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 \
          browser-harness --reload >"$private_evidence/harness-stop.stdout" \
          2>"$private_evidence/harness-stop.stderr"; then
          printf '%s\n' 'STOP: named site2-05-browser-acceptance daemon cleanup failed; details withheld' >>"$control_summary"
          printf '%s\n' 'STOP: named site2-05-browser-acceptance daemon cleanup failed; details withheld' >&2
          status=1
        fi
      fi
      # The headless process/profile belong to the window; only close removes them.
      exit "$status"
    }
    trap cleanup_browser_control EXIT
    trap 'exit 130' INT
    trap 'exit 143' TERM
    browser_status=0
    harness_started=1
    BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
      BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
      BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 BH_TAB_MARKER=0 \
      browser-harness >"$harness_stdout" 2>"$harness_stderr" <<'PY' || browser_status=$?
import base64,json,os,pathlib,re,time,urllib.request
print("STEP 1", flush=True)
endpoint = os.environ["BU_CDP_URL"]
def endpoint_json(path):
    # Loopback only; bypass ambient HTTP proxies. Never print endpoint responses.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(endpoint + path, timeout=5) as response:
        return json.load(response)
version = endpoint_json("/json/version")
attached_version = cdp("Browser.getVersion")
attached_target = current_tab()["targetId"]
if (not version.get("webSocketDebuggerUrl", "").startswith(
        endpoint.replace("http://", "ws://", 1) + "/devtools/browser/")
    or "HeadlessChrome/" not in attached_version.get("userAgent", "")
    or attached_version.get("product") != version.get("Browser")
    or attached_version.get("userAgent") != version.get("User-Agent")
    or not any(target.get("id") == attached_target for target in endpoint_json("/json/list"))):
    raise SystemExit("STOP: STEP 1 endpoint ownership")
expected_user="d37e2ff2-2efb-4bdc-b8fb-176ce4bfccbc"; expected_workspace="c2ea0541-f56d-4c73-bf71-56c5405c4934"
start_workspace="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
evidence=pathlib.Path(os.environ["SITE_EVIDENCE"])
print("STEP 2", flush=True)
cdp("Page.addScriptToEvaluateOnNewDocument",source="""
window.__siteControlErrors=[];
addEventListener('error',e=>window.__siteControlErrors.push(String(e.message||'error')));
addEventListener('unhandledrejection',e=>window.__siteControlErrors.push(String(e.reason||'rejection')));
const originalConsoleError=console.error.bind(console);
console.error=(...args)=>{window.__siteControlErrors.push('console.error');originalConsoleError(...args)};
""")
goto_url("https://commonswarm.com/app?w="+expected_workspace)
print("STEP 3", flush=True)
if not wait_for_load(): raise SystemExit("STOP: STEP 3 document load timeout")
print("STEP 4", flush=True)
deadline = time.monotonic() + 30
ready = False
while time.monotonic() < deadline:
    ready = js("""(() => {
      const app=document.querySelector('live-dashboard[data-state]');
      if(!app || !app.dataset.state || app.dataset.state==='loading') return false;
      if(!app.querySelector('[data-panel="signed-out"]')) return false;
      const visible=[...app.querySelectorAll('.dashboard__root > [data-panel]')]
        .filter(panel=>!panel.hidden && panel.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      return visible.length===1 && visible[0].dataset.panel===app.dataset.state;
    })()""")
    if ready: break
    time.sleep(.25)
if not ready: raise SystemExit("STOP: STEP 4 app readiness timeout")
def inspect():
    return js("""(() => {
      let userId=''; for(const key of Object.keys(localStorage)){if(!key.startsWith('sb-')||!key.endsWith('-auth-token'))continue;
      try{const value=JSON.parse(localStorage.getItem(key));if(value?.user?.id)userId=value.user.id;}catch{}}
      const selected=document.querySelector('[data-workspace-list] [data-workspace-id][aria-checked="true"]');
      const dialog=document.querySelector('[data-connected-apps-dialog]');
      return {userId,workspaceId:selected?.dataset.workspaceId||new URL(location.href).searchParams.get('w')||'',
      workspaceCount:document.querySelectorAll('[data-workspace-list] [data-workspace-id]').length,
      display:document.querySelector('[data-rail-account]')?.textContent?.trim()||'',
      signedOut:!document.querySelector('[data-panel="signed-out"]')?.hasAttribute('hidden'),
      connectedSurface:!!document.querySelector('[data-connected-apps-open]'),
      connectedCreateAction:!!dialog&&[...dialog.querySelectorAll('button,a')].some(x=>/^(?:connect\\b|create\\b|add app\\b)/i.test((x.textContent||'').trim())),
      errors:window.__siteControlErrors||[]};})()""")
print("STEP 5", flush=True)
branch=json.loads((evidence/"site2-03-browser-preflight.json").read_text(encoding="utf-8"))["branch"]
observed=inspect()
print("STEP 6", flush=True)
# Durable marker precedes the first product assertion, not infrastructure checks.
marker=evidence/"site2-05-browser-acceptance-assertions-started.txt"
marker.write_text("ASSERTIONS_STARTED\n",encoding="utf-8"); marker.chmod(0o600)
if branch=="FULL-CONTROL":
    print("STEP 7", flush=True)
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
    print("STEP 8", flush=True)
    asset_paths=[]
    for line in (evidence/"site2-05-public.txt").read_text(encoding="utf-8").splitlines():
        match=re.match(r"asset_sha256=[0-9a-f]{64} (/_astro/.+)",line)
        if match: asset_paths.append(match.group(1))
    loaded=js("performance.getEntriesByType('resource').map(entry => new URL(entry.name).pathname)")
    if not asset_paths or not all(path in loaded for path in asset_paths): raise SystemExit(1)
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    print("STEP 9", flush=True)
    js("document.querySelector('[data-user-menu-trigger]').click()")
    js("document.querySelector('[data-connected-apps-open]').click()")
    connected_list={}
    for _ in range(60):
        connected_list=js("""(() => {
          const list=document.querySelector('[data-connected-apps-list]');
          const status=document.querySelector('[data-connected-apps-status]');
          return {text:list?.textContent?.trim()||'',
            cardCount:list?.querySelectorAll(':scope > .dashboard__connected-app').length||0,
            status:status?.textContent?.trim()||'',
            failed:status?.classList.contains('dashboard__form-error')||false};
        })()""")
        if connected_list["failed"] or "Nothing was changed" in connected_list["status"]: break
        if connected_list["text"] and not connected_list["status"]: break
        time.sleep(.5)
    print("STEP 10", flush=True)
    if connected_list["failed"] or connected_list["status"]: raise SystemExit(1)
    if connected_list["text"]=="No apps are connected to this account." and connected_list["cardCount"]==0:
        connected_apps_state="EMPTY"
    elif connected_list["cardCount"]>0 and connected_list["text"]!="No apps are connected to this account.":
        connected_apps_state="POPULATED"
    else:
        raise SystemExit(1)
    if js("!document.querySelector('[data-connected-apps-retry]').hidden"): raise SystemExit(1)
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    if inspect()["connectedCreateAction"] or inspect()["errors"]: raise SystemExit(1)
    print("STEP 11", flush=True)
    dialog_clip=js("""(() => {const r=document.querySelector('[data-connected-apps-dialog]').getBoundingClientRect();
      return{x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()""")
    dialog_png=cdp("Page.captureScreenshot",format="png",fromSurface=True,clip=dialog_clip)["data"]
    dialog_path=evidence/"site2-05-connected-apps.png"; dialog_path.write_bytes(base64.b64decode(dialog_png)); dialog_path.chmod(0o600)
    print("STEP 12", flush=True)
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
        mobile_path=evidence/("site2-05-mobile-%s.png"%width)
        mobile_path.write_bytes(base64.b64decode(mobile_png)); mobile_path.chmod(0o600)
    cdp("Emulation.clearDeviceMetricsOverride")
    if inspect()["workspaceId"]!=expected_workspace: raise SystemExit(1)
    print("STEP 13", flush=True)
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
      "assets_loaded":"PASS","feed_roster_local_h0":"PASS","connected_apps_load":"PASS",
      "connected_apps_list_state":connected_apps_state,"connected_apps_count":connected_list["cardCount"],
      "connection_creation_action_absent":"PASS","console":"PASS","mobile_geometry":geometry,
      "screenshots":["site2-05-connected-apps.png","site2-05-mobile-320.png","site2-05-mobile-390.png"]}
else:
    if not observed["signedOut"] or not observed["connectedSurface"] or observed["connectedCreateAction"]: raise SystemExit(1)
    result={"branch":"REDUCED-CONTROL","signed_out_bundle_connected_apps_surface":"PASS",
      "signed_out_bundle_creation_action_absent":"PASS","signed_in_connected_apps_load":"NOT PROVED",
      "signed_in_empty_state":"NOT PROVED","signed_in_no_creation_action":"NOT PROVED","signed_in_console_clean":"NOT PROVED"}
print("STEP 14", flush=True)
path=evidence/"site2-05-browser.json"; path.write_text(json.dumps(result,sort_keys=True,indent=2)+"\n",encoding="utf-8"); path.chmod(0o600)
PY
    python3 - "$harness_stdout" "$harness_stderr" "$browser_status" "$SITE_EVIDENCE" <<'PY' || { if [ "$browser_status" -eq 0 ]; then browser_status=1; fi; }
import collections, pathlib, re, signal, sys
stdout, stderr = map(pathlib.Path, sys.argv[1:3])
code = int(sys.argv[3])
names = {0:"harness setup", 1:"attachment", 2:"navigation", 3:"document load",
    4:"app readiness", 5:"state snapshot", 6:"branch selection", 7:"identity/workspace",
    8:"assets", 9:"Connected apps view", 10:"Connected apps assertions",
    11:"dialog screenshot", 12:"mobile geometry", 13:"workspace restore", 14:"receipt write"}
step = 0
with stdout.open(encoding="utf-8", errors="replace") as stream:
    for line in stream:
        match = re.fullmatch(r"STEP ([1-9]|1[0-4])\n?", line)
        if match: step = int(match[1])
# Reject sensitive-looking lines, then emit only fixed categories/line numbers.
# No arbitrary message, source-code line, URL, file path or exception detail passes.
unsafe = re.compile(r"token|jwt|email|cookie|session|bearer|credential|password|secret|"
    r"authorization|localstorage|@|https?://|wss?://|eyJ[A-Za-z0-9_-]*\.|"
    r"[A-Za-z0-9_+/=-]{24,}|[\x00-\x08\x0b-\x1f\x7f]", re.I)
classes = ("RuntimeError", "TimeoutError", "ConnectionError", "ConnectionRefusedError",
    "OSError", "PermissionError", "FileNotFoundError", "KeyError", "ValueError",
    "TypeError", "AssertionError", "SyntaxError", "ImportError", "ModuleNotFoundError")
named = {"STOP: STEP 1 endpoint ownership", "STOP: STEP 3 document load timeout",
    "STOP: STEP 4 app readiness timeout"}
with stderr.open(encoding="utf-8", errors="replace") as stream:
    first_stderr = stream.readline().rstrip("\r\n")
    stream.seek(0)
    tail = collections.deque(stream, maxlen=20)
safe = []
for raw in tail:
    line = raw.rstrip("\n")
    if unsafe.search(line): continue
    if line in named:
        safe.append(line)
        continue
    for kind in classes:
        if line == kind or line.startswith(kind + ":"):
            safe.append(kind + " (details withheld)")
            break
    else:
        match = re.fullmatch(r'\s*File "<string>", line ([0-9]{1,6})(?:, in .*)?', line)
        if match: safe.append("Python line " + match[1])
summary = [f"site2-05-browser-acceptance: STEP {step} ({names[step]}); exit code {code}"]
if step == 0 and code != 0:
    signum = -code if code < 0 else code - 128 if 128 < code <= 192 else 0
    if signum:
        try: summary[0] += "; signal " + signal.Signals(signum).name
        except ValueError: pass
    # Redact quoted home paths (including spaces), then unquoted home paths.
    home = re.escape(str(pathlib.Path.home()))
    cause = re.sub(r"([\"'])" + home + r"(?:/[^\r\n]*?)?\1",
        "[HOME]", first_stderr)
    cause = re.sub(home + r"(?:/[^\s\"'<>]*)?", "[HOME]", cause)
    if unsafe.search(cause): cause = "sensitive stderr details withheld"
    summary[0] += "; stderr: " + (cause[:500] or "no stderr emitted")
else:
    summary += ["stderr: " + line for line in safe[-8:]]
    if not safe: summary.append("stderr: no safe detail retained")
text = "\n".join(summary) + "\n"
path = pathlib.Path(sys.argv[4]) / "site2-05-browser-acceptance-summary.txt"
path.write_text(text, encoding="utf-8"); path.chmod(0o600)
print(text, end="")
PY
    if [ "$browser_status" -ne 0 ]; then exit "$browser_status"; fi
  )
  browser_status=$?
  set -e
  python3 - "$SITE_EVIDENCE" site2-05-browser-acceptance "$branch" "$browser_status" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1]); label=sys.argv[2]; branch=sys.argv[3]; code=int(sys.argv[4])
assert branch in {"FULL-CONTROL","REDUCED-CONTROL"}
summary=root/(label+"-summary.txt")
lines=summary.read_text(encoding="utf-8").splitlines()
started=(root/(label+"-assertions-started.txt")).is_file()
reason="STEP 0 (control setup)"
for line in lines:
    match=re.fullmatch(re.escape(label)+r": (STEP [0-9]{1,2} \([A-Za-z /-]+\)); exit code (?:pending|[0-9]+)",line)
    if match: reason=match[1]
    if re.fullmatch(r"STOP site2-0[56]: task-owned Chromium is not running "
                    r"\((?:controller missing|endpoint changed|probe [a-z][a-z-]*)\)",line):
        reason=line
    if line in {"STOP: named site2-05-browser-acceptance daemon cleanup failed; details withheld",
                "STOP: named site2-06 daemon cleanup failed; details withheld",
                "stderr: STOP: STEP 1 endpoint ownership",
                "stderr: STOP: STEP 3 document load timeout",
                "stderr: STOP: STEP 4 app readiness timeout"}:
        reason=line.removeprefix("stderr: ")
# Browser evidence is optional: any browser failure, in either mode or phase,
# is NOT_PROVED and never blocking; only deployment/public checks roll back.
acceptance="PASS" if code==0 else "NOT_PROVED"
rows=["BROWSER_BRANCH="+branch,"browser_acceptance="+acceptance+" reason="+reason,
      "browser_control_exit="+str(code),"assertions_started="+("yes" if started else "no"),
      "blocking=no"]
text="\n".join(rows)+"\n"
receipt=root/(label+"-receipt.txt"); receipt.write_text(text,encoding="utf-8"); receipt.chmod(0o600)
with summary.open("a",encoding="utf-8") as stream: stream.write(text)
summary.chmod(0o600)
PY
  # Never a rollback: public bytes already passed independently in site2-05.
  grep -qFx 'blocking=no' "$SITE_EVIDENCE/site2-05-browser-acceptance-receipt.txt"
)
```

## 6. Rollback verification

`site2-06` always runs before either close path. It records `not-needed`, or
verifies pinned baseline bytes through the public boundary and rechecks the
appropriate browser branch. Public-byte failure stays blocking. The browser
summary and `site2-06-browser-receipt.txt` retain `NOT_PROVED` on any failed
browser re-check, with the original browser exit code and a named STEP/STOP reason.

```sh
# step: site2-06 — Mac mini /bin/bash 3.2; Anvil; verify automatic rollback or record not-needed
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-06: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  . "$HOME/.commonswarm-site-window.env"
  umask 077
  control_summary="$SITE_EVIDENCE/site2-06-browser-summary.txt"
  printf '%s\n' 'site2-06-browser: STEP 0 (control setup); exit code pending' >"$control_summary"
  chmod 0600 "$control_summary"
  finish_rollback_control() {
    status=$1
    trap - EXIT
    # Only the browser phase can be non-blocking; public-byte errors keep status.
    if [ "$rollback_phase" = browser ]; then
      python3 - "$SITE_EVIDENCE" site2-06-browser "$branch" "$status" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1]); label=sys.argv[2]; branch=sys.argv[3]; code=int(sys.argv[4])
assert branch in {"FULL-CONTROL","REDUCED-CONTROL"}
summary=root/(label+"-summary.txt")
lines=summary.read_text(encoding="utf-8").splitlines()
started=(root/(label+"-assertions-started.txt")).is_file()
reason="STEP 0 (control setup)"
for line in lines:
    match=re.fullmatch(re.escape(label)+r": (STEP [0-9]{1,2} \([A-Za-z /-]+\)); exit code (?:pending|[0-9]+)",line)
    if match: reason=match[1]
    if re.fullmatch(r"STOP site2-0[56]: task-owned Chromium is not running "
                    r"\((?:controller missing|endpoint changed|probe [a-z][a-z-]*)\)",line):
        reason=line
    if line in {"STOP: named site2-05-browser-acceptance daemon cleanup failed; details withheld",
                "STOP: named site2-06 daemon cleanup failed; details withheld",
                "stderr: STOP: STEP 1 endpoint ownership",
                "stderr: STOP: STEP 3 document load timeout",
                "stderr: STOP: STEP 4 app readiness timeout"}:
        reason=line.removeprefix("stderr: ")
# Browser evidence is optional: any browser failure, in either mode or phase,
# is NOT_PROVED and never blocking; only deployment/public checks roll back.
acceptance="PASS" if code==0 else "NOT_PROVED"
rows=["BROWSER_BRANCH="+branch,"browser_acceptance="+acceptance+" reason="+reason,
      "browser_control_exit="+str(code),"assertions_started="+("yes" if started else "no"),
      "blocking=no"]
text="\n".join(rows)+"\n"
receipt=root/(label+"-receipt.txt"); receipt.write_text(text,encoding="utf-8"); receipt.chmod(0o600)
with summary.open("a",encoding="utf-8") as stream: stream.write(text)
summary.chmod(0o600)
PY
      if grep -qFx 'blocking=no' "$SITE_EVIDENCE/site2-06-browser-receipt.txt"; then status=0; fi
    fi
    printf 'site2-06-browser: final exit code %s\n' "$status" >>"$control_summary"
    chmod 0600 "$control_summary"
    exit "$status"
  }
  rollback_phase=public
  trap 'finish_rollback_control "$?"' EXIT
  check_task_browser() {
    browser_reason=
    case "${SITE_BROWSER_ROOT:-}" in /private/tmp/anvil-secret.??????) ;; *) browser_reason='controller missing' ;; esac
    if [ -z "$browser_reason" ] && [ "${SITE_TASK_BROWSER:-}" != "$SITE_BROWSER_ROOT/site-task-browser.mjs" ]; then
      browser_reason='controller missing'
    fi
    if [ -z "$browser_reason" ]; then
      # The controller alone proves its own child browser and endpoint; no PID is read here.
      probe_file="$SITE_BROWSER_ROOT/site2-06-probe.txt"
      if ! node "$SITE_TASK_BROWSER" probe --state-dir "$SITE_BROWSER_ROOT" https://commonswarm.com/app \
        </dev/null >"$probe_file" 2>&1; then
        browser_reason="probe $(sed -n 's/^TASK_BROWSER_PROBE=NOT_PROVED reason=//p' "$probe_file" 2>/dev/null | head -n 1 || true)"
        case "$browser_reason" in 'probe '[a-z]*) ;; *) browser_reason='probe failed' ;; esac
        case "${browser_reason#probe }" in *[!a-z-]*) browser_reason='probe failed' ;; esac
      elif ! grep -qFx "TASK_BROWSER_ENDPOINT=${SITE_CHROME_ENDPOINT:-}" "$probe_file"; then
        browser_reason='endpoint changed'
      fi
    fi
    if [ -n "$browser_reason" ]; then
      printf 'STOP site2-06: task-owned Chromium is not running (%s)\n' "$browser_reason" >>"$control_summary"
      printf 'STOP site2-06: task-owned Chromium is not running (%s)\n' "$browser_reason" >&2
      return 1
    fi
  }
  if test ! -f "$SITE_EVIDENCE/rollback-auto.txt"; then
    printf '%s\n' 'rollback=not-needed' >"$SITE_EVIDENCE/site2-06-rollback-verify.txt"
    chmod 0600 "$SITE_EVIDENCE/site2-06-rollback-verify.txt"; exit 0
  fi
  pin=$(cat "$SITE_EVIDENCE/previous.release")
  printf -v box_command '%q ' /bin/bash -s -- "$pin"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
    >"$SITE_EVIDENCE/site2-06-rollback-verify.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-06: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
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
  chmod 0600 "$SITE_EVIDENCE/site2-06-rollback-verify.txt"
  grep -qFx 'ROLLBACK_PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site2-06-rollback-verify.txt"
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site2-03-browser-preflight.json")"
  case "$branch" in FULL-CONTROL|REDUCED-CONTROL) ;; *) exit 1 ;; esac
  test ! -e "$SITE_EVIDENCE/site2-06-browser-assertions-started.txt"
  rollback_phase=browser
  check_task_browser
  export SITE_EVIDENCE
  umask 077
  case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
  test -d "$SITE_BROWSER_ROOT" && test ! -L "$SITE_BROWSER_ROOT"
  test "$(stat -f '%Lp' "$SITE_BROWSER_ROOT")" = 700
  endpoint="$SITE_CHROME_ENDPOINT"
  private_evidence="$SITE_BROWSER_ROOT/site2-06-evidence"
  harness_runtime="$SITE_BROWSER_ROOT/harness-runtime-06"
  harness_name="site2-${SITE_WINDOW_ID}-06-${SITE_BROWSER_ROOT##*.}"
  mkdir -m 0700 "$private_evidence" "$harness_runtime"
  harness_stdout="$private_evidence/harness.stdout"
  harness_stderr="$private_evidence/harness.stderr"
  : >"$harness_stdout"; : >"$harness_stderr"
  chmod 0600 "$harness_stdout" "$harness_stderr"
  harness_started=0
  cleanup_browser_control() {
    status=$?
    trap - EXIT
    if [ "$harness_started" -eq 1 ]; then
      # --reload only stops; these exact name/runtime settings never address default.
      if ! BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
        BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
        BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 \
        browser-harness --reload >"$private_evidence/harness-stop.stdout" \
        2>"$private_evidence/harness-stop.stderr"; then
        printf '%s\n' 'STOP: named site2-06 daemon cleanup failed; details withheld' >>"$control_summary"
        printf '%s\n' 'STOP: named site2-06 daemon cleanup failed; details withheld' >&2
        status=1
      fi
    fi
    # The headless process/profile belong to the window; only close removes them.
    finish_rollback_control "$status"
  }
  trap cleanup_browser_control EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  browser_status=0
  harness_started=1
  BU_NAME="$harness_name" BU_CDP_URL="$endpoint" BU_CDP_WS= BU_BROWSER_ID= \
    BH_RUNTIME_DIR="$harness_runtime" BH_RUNTIME_DIR_SHARED=1 \
    BH_TMP_DIR="$private_evidence" BH_TMP_DIR_SHARED=1 BH_RECORD=0 BH_TAB_MARKER=0 \
    browser-harness >"$harness_stdout" 2>"$harness_stderr" <<'PY' || browser_status=$?
import json,os,pathlib,time,urllib.request
print("STEP 1", flush=True)
endpoint = os.environ["BU_CDP_URL"]
def endpoint_json(path):
    # Loopback only; bypass ambient HTTP proxies. Never print endpoint responses.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(endpoint + path, timeout=5) as response:
        return json.load(response)
version = endpoint_json("/json/version")
attached_version = cdp("Browser.getVersion")
attached_target = current_tab()["targetId"]
if (not version.get("webSocketDebuggerUrl", "").startswith(
        endpoint.replace("http://", "ws://", 1) + "/devtools/browser/")
    or "HeadlessChrome/" not in attached_version.get("userAgent", "")
    or attached_version.get("product") != version.get("Browser")
    or attached_version.get("userAgent") != version.get("User-Agent")
    or not any(target.get("id") == attached_target for target in endpoint_json("/json/list"))):
    raise SystemExit("STOP: STEP 1 endpoint ownership")
workspace="c2ea0541-f56d-4c73-bf71-56c5405c4934"
start="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"
evidence=pathlib.Path(os.environ["SITE_EVIDENCE"])
print("STEP 2", flush=True)
goto_url("https://commonswarm.com/app")
print("STEP 3", flush=True)
if not wait_for_load(): raise SystemExit("STOP: STEP 3 document load timeout")
print("STEP 4", flush=True)
deadline = time.monotonic() + 30
ready = False
while time.monotonic() < deadline:
    ready = js("""(() => {
      const app=document.querySelector('live-dashboard[data-state]');
      if(!app || !app.dataset.state || app.dataset.state==='loading') return false;
      if(!app.querySelector('[data-panel="signed-out"]')) return false;
      const visible=[...app.querySelectorAll('.dashboard__root > [data-panel]')]
        .filter(panel=>!panel.hidden && panel.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}));
      return visible.length===1 && visible[0].dataset.panel===app.dataset.state;
    })()""")
    if ready: break
    time.sleep(.25)
if not ready: raise SystemExit("STOP: STEP 4 app readiness timeout")
print("STEP 5", flush=True)
branch=json.loads((evidence/"site2-03-browser-preflight.json").read_text(encoding="utf-8"))["branch"]
marker=evidence/"site2-06-browser-assertions-started.txt"
marker.write_text("ASSERTIONS_STARTED\n",encoding="utf-8"); marker.chmod(0o600)
if branch=="FULL-CONTROL":
    print("STEP 6", flush=True)
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    if not js("""(() => {const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="c2ea0541-f56d-4c73-bf71-56c5405c4934"]');
      if(!target)return false;target.click();return true})()"""): raise SystemExit(1)
    print("STEP 7", flush=True)
    for _ in range(60):
        selected=js("document.querySelector('[data-workspace-list] [aria-checked=\"true\"]')?.dataset.workspaceId||''")
        if selected==workspace: break
        time.sleep(.5)
    if selected!=workspace: raise SystemExit(1)
    print("STEP 8", flush=True)
    # Workspace is asserted before this rollback-view control.
    if js("document.querySelector('[data-rail-account]')?.textContent?.trim()")!="Ridgeio": raise SystemExit(1)
    print("STEP 9", flush=True)
    js("document.querySelector('[data-workspace-menu-trigger]').click()")
    if not js("""(() => {const target=document.querySelector(
      '[data-workspace-list] [data-workspace-id="292be0f9-ca5d-43ed-a6f7-31354fe7fe56"]');
      if(!target)return false;target.click();return true})()"""): raise SystemExit(1)
    print("STEP 10", flush=True)
    for _ in range(60):
        restored=js("document.querySelector('[data-workspace-list] [aria-checked=\"true\"]')?.dataset.workspaceId||''")
        if restored==start: break
        time.sleep(.5)
    if restored!=start: raise SystemExit(1)
else:
    print("STEP 11", flush=True)
    if not js("!document.querySelector('[data-panel=\"signed-out\"]')?.hasAttribute('hidden')"): raise SystemExit(1)
print("STEP 12", flush=True)
PY
  python3 - "$harness_stdout" "$harness_stderr" "$browser_status" "$SITE_EVIDENCE" <<'PY' || { if [ "$browser_status" -eq 0 ]; then browser_status=1; fi; }
import collections, pathlib, re, signal, sys
stdout, stderr = map(pathlib.Path, sys.argv[1:3])
code = int(sys.argv[3])
names = {0:"harness setup", 1:"attachment", 2:"navigation", 3:"document load",
    4:"app readiness", 5:"branch selection", 6:"workspace switch", 7:"switch wait",
    8:"account label", 9:"workspace restore", 10:"restore wait",
    11:"signed-out assertion", 12:"completed"}
step = 0
with stdout.open(encoding="utf-8", errors="replace") as stream:
    for line in stream:
        match = re.fullmatch(r"STEP ([1-9]|1[0-2])\n?", line)
        if match: step = int(match[1])
# Reject sensitive-looking lines, then emit only fixed categories/line numbers.
# No arbitrary message, source-code line, URL, file path or exception detail passes.
unsafe = re.compile(r"token|jwt|email|cookie|session|bearer|credential|password|secret|"
    r"authorization|localstorage|@|https?://|wss?://|eyJ[A-Za-z0-9_-]*\.|"
    r"[A-Za-z0-9_+/=-]{24,}|[\x00-\x08\x0b-\x1f\x7f]", re.I)
classes = ("RuntimeError", "TimeoutError", "ConnectionError", "ConnectionRefusedError",
    "OSError", "PermissionError", "FileNotFoundError", "KeyError", "ValueError",
    "TypeError", "AssertionError", "SyntaxError", "ImportError", "ModuleNotFoundError")
named = {"STOP: STEP 1 endpoint ownership", "STOP: STEP 3 document load timeout",
    "STOP: STEP 4 app readiness timeout"}
with stderr.open(encoding="utf-8", errors="replace") as stream:
    first_stderr = stream.readline().rstrip("\r\n")
    stream.seek(0)
    tail = collections.deque(stream, maxlen=20)
safe = []
for raw in tail:
    line = raw.rstrip("\n")
    if unsafe.search(line): continue
    if line in named:
        safe.append(line)
        continue
    for kind in classes:
        if line == kind or line.startswith(kind + ":"):
            safe.append(kind + " (details withheld)")
            break
    else:
        match = re.fullmatch(r'\s*File "<string>", line ([0-9]{1,6})(?:, in .*)?', line)
        if match: safe.append("Python line " + match[1])
summary = [f"site2-06-browser: STEP {step} ({names[step]}); exit code {code}"]
if step == 0 and code != 0:
    signum = -code if code < 0 else code - 128 if 128 < code <= 192 else 0
    if signum:
        try: summary[0] += "; signal " + signal.Signals(signum).name
        except ValueError: pass
    # Redact quoted home paths (including spaces), then unquoted home paths.
    home = re.escape(str(pathlib.Path.home()))
    cause = re.sub(r"([\"'])" + home + r"(?:/[^\r\n]*?)?\1",
        "[HOME]", first_stderr)
    cause = re.sub(home + r"(?:/[^\s\"'<>]*)?", "[HOME]", cause)
    if unsafe.search(cause): cause = "sensitive stderr details withheld"
    summary[0] += "; stderr: " + (cause[:500] or "no stderr emitted")
else:
    summary += ["stderr: " + line for line in safe[-8:]]
    if not safe: summary.append("stderr: no safe detail retained")
text = "\n".join(summary) + "\n"
path = pathlib.Path(sys.argv[4]) / "site2-06-browser-summary.txt"
path.write_text(text, encoding="utf-8"); path.chmod(0o600)
print(text, end="")
PY
  if [ "$browser_status" -ne 0 ]; then exit "$browser_status"; fi
)
```

## 7. Manifest, pin release, and close

Closure is mechanical. It rejects credentials, raw HTML, HAR content, email
addresses, and private browser state. It records the browser branch. A public-byte
PASS plus a non-blocking browser `NOT_PROVED` receipt closes as `OUTCOME=released`.
The sanitized acceptance line appears in `CLOSE.txt`, the pin-close receipt, and
`site2-07-outcome.txt` inside the hashed manifest. Signed-in claims keep their
existing `NOT_PROVED` line on this path, even in FULL-CONTROL; closure never
claims a workspace restore or signed-in assertion that the browser did not prove.
On success the pin is guardedly removed. After rollback, `current` first returns to the
measured normal release name; if retention pruned it, the pin is renamed back.
Each close first runs the idempotent task-browser controller close, before any box
change, then removes the private root through guarded rm. The
temporary build `site/.env` is removed at close.

Choose the close by the pin invocation marker, `site2-03-pin.txt`: the pin step
creates it before its SSH call, even if that call fails. If the marker is absent
and `site2-03-pin-previous` never ran, run `site2-06`, then
`site2-07-pre-pin-manifest-close` below. This path needs no `previous.release`
and verifies the live baseline without changing `current`. If the pin step ran,
use `site2-07-manifest-close` instead after the applicable failure
reconciliation and `site2-06`. A partial pin failure needs HezLead reconciliation;
never delete its marker or use the pre-pin path to bypass it. Do not retry the
failed release step within the closing window.

`site2-07-manifest-close` also resumes a close whose SSH command never ran. It
requires no `CLOSE.txt`, an absent or empty regular `site2-07-pin-close.txt`, the
matching Mac and box window files, and the original pin still present. It
revalidates the public/browser/rollback receipts, checks an existing outcome
byte for byte, and regenerates the manifest deterministically. The manifest
excludes itself and `CLOSE.txt`; the final version includes the completed box
pin-close receipt. `CLOSE.txt` is written only after all cleanup succeeds. A
nonempty close receipt, missing pin/window, or unexpected live target stops for
HezLead reconciliation; this block never repeats a partial box close.

Every variable-bearing SSH call constructs one remote command with
`printf -v box_command '%q ' /bin/bash -s -- ...`, then passes only that command
to SSH. Bash on the box recovers each value as a positional argument; the BOX
heredoc remains literal script text on stdin. Free acceptance text is never
passed as unquoted remote command text. Static date/readlink/open calls use
only fixed commands. The close additionally allowlists its values on the box.

`site2-browser-close` is the standalone, idempotent task-browser close for any
failure path that retains window state (see Failure paths). It stops only the
controller-owned browser and removes its profile; the window file, pin, evidence
and private root stay for the applicable close or HezLead. Rerunning it, or a
later `site2-07` close, passes when the browser is already gone.

```sh
# step: site2-browser-close — Mac mini /bin/bash 3.2; Anvil; idempotent task-browser close for any failure path
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-browser-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  test -f "$HOME/.commonswarm-site-window.env" && test ! -L "$HOME/.commonswarm-site-window.env"
  test "$(stat -f '%Lp' "$HOME/.commonswarm-site-window.env")" = 600
  . "$HOME/.commonswarm-site-window.env"
  if [ -n "${SITE_BROWSER_ROOT:-}" ] && [ -d "$SITE_BROWSER_ROOT" ]; then
    case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test ! -L "$SITE_BROWSER_ROOT"
    test "$(stat -f '%Lp' "$SITE_BROWSER_ROOT")" = 700
    test "${SITE_TASK_BROWSER:-}" = "$SITE_BROWSER_ROOT/site-task-browser.mjs"
    if ! node "$SITE_TASK_BROWSER" close --state-dir "$SITE_BROWSER_ROOT" </dev/null; then
      printf '%s\n' 'STOP site2-browser-close: task-browser close unproved; nothing signalled; retain private staging and window state for HezLead reconciliation' >&2
      exit 1
    fi
  else
    printf '%s\n' 'TASK_BROWSER_CLOSE=PASS state=no-task-browser'
  fi
)
```

```sh
# step: site2-07-pre-pin-manifest-close — Mac mini /bin/bash 3.2; Anvil; close a failure before pin invocation
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-07-pre-pin-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  test "$(command -v rm)" = "$HOME/.local/bin/rm"
  test -f "$HOME/.commonswarm-site-window.env"
  test ! -L "$HOME/.commonswarm-site-window.env"
  test "$(stat -f '%Lp' "$HOME/.commonswarm-site-window.env")" = 600
  . "$HOME/.commonswarm-site-window.env"
  test "$SITE_WINDOW_FILE" = "$HOME/.commonswarm-site-window.env"
  case "$SITE_WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
  esac
  for input_path in "$SITE_EVIDENCE" "$SITE_RELEASE_REPO"; do
    case "$input_path" in /*) ;; *) exit 1 ;; esac
    test -d "$input_path"
    test ! -L "$input_path"
  done
  for marker in site2-03-pin.txt previous.release previous.original GO.txt after.release; do
    test ! -e "$SITE_EVIDENCE/$marker"
    test ! -L "$SITE_EVIDENCE/$marker"
  done
  grep -qFx 'rollback=not-needed' "$SITE_EVIDENCE/site2-06-rollback-verify.txt"
  # Reject unsafe evidence before changing either window state file.
  python3 - "$SITE_EVIDENCE" <<'PY'
import pathlib,re,sys
root=pathlib.Path(sys.argv[1]).resolve()
for path in sorted(root.rglob("*")):
    if path.is_symlink(): raise SystemExit(1)
    if path.name=="chrome-launch.log" or path.is_dir(): continue
    if not path.is_file() or path.suffix.lower() in {".html",".har"}: raise SystemExit(1)
    if path.suffix.lower() in {".txt",".json",".log",""}:
        text=path.read_bytes().decode("utf-8"); patterns=(r"Authorization:\s*Bearer",
          r"eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}",
          r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",r"<!doctype\s+html|<html[ >]",r'"log"\s*:\s*\{\s*"version"')
        if any(re.search(pattern,text,re.I) for pattern in patterns): raise SystemExit(1)
PY
  python3 - "$SITE_RELEASE_REPO/site/.env" "$SITE_RELEASE_REPO" <<'PY'
import pathlib,sys
repo=pathlib.Path(sys.argv[2]).resolve(strict=True); target=pathlib.Path(sys.argv[1])
assert repo!=pathlib.Path.home().resolve() and repo!=pathlib.Path("/")
assert target.name==".env" and target.parent.resolve(strict=True)==repo/"site"
assert not target.is_symlink()
if target.exists(): assert target.is_file()
PY
  # Close the task browser before any box change, so a browser STOP leaves this
  # close resumable. Only the controller stops its own child and removes its
  # profile; close is idempotent and passes when both are already gone.
  if [ -n "${SITE_BROWSER_ROOT:-}" ] && [ -d "$SITE_BROWSER_ROOT" ]; then
    case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test ! -L "$SITE_BROWSER_ROOT"
    test "$(stat -f '%Lp' "$SITE_BROWSER_ROOT")" = 700
    test "${SITE_TASK_BROWSER:-}" = "$SITE_BROWSER_ROOT/site-task-browser.mjs"
    if ! node "$SITE_TASK_BROWSER" close --state-dir "$SITE_BROWSER_ROOT" </dev/null; then
      printf '%s\n' 'STOP site2-07-pre-pin-manifest-close: task-browser close unproved; nothing signalled; retain private staging and window state for HezLead reconciliation' >&2
      exit 1
    fi
    if ! rm -r -- "$SITE_BROWSER_ROOT"; then
      printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$SITE_BROWSER_ROOT" >&2
      exit 1
    fi
    test ! -e "$SITE_BROWSER_ROOT"
  fi
  printf -v box_command '%q ' /bin/bash -s -- "$SITE_WINDOW_ID" "$BASELINE_DIR"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
    >"$SITE_EVIDENCE/site2-07-pre-pin-close.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-07-pre-pin-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
window_id=$1; root=/srv/commonswarm/site
case "$window_id" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
esac
previous=$2
test -f /tmp/commonswarm-site-window.env && test ! -L /tmp/commonswarm-site-window.env
test "$(stat -c '%a' /tmp/commonswarm-site-window.env)" = 600
(
  . /tmp/commonswarm-site-window.env
  test "$SITE_WINDOW_ID" = "$window_id"
  test "$BASELINE_DIR" = "$previous"
)
test -L "$root/current"
test "$(readlink -f "$root/current")" = "$previous"
test -d "$previous"
test ! -L "$previous"
test ! -e "$root/releases/.site-window-pin-$window_id"
test ! -L "$root/releases/.site-window-pin-$window_id"
test -z "$(find "$root" -maxdepth 1 \( -type f -o -type l \) -name 'current.next*' -print)"
test -f /tmp/commonswarm-site-window.env
test ! -L /tmp/commonswarm-site-window.env
test "$(stat -c '%a' /tmp/commonswarm-site-window.env)" = 600
rm -f -- /tmp/commonswarm-site-window.env
test ! -e /tmp/commonswarm-site-window.env
test ! -L /tmp/commonswarm-site-window.env
printf 'closed_before_pin=true\nBASELINE_UNCHANGED=PASS\ncurrent_release=%s\noutcome=failed-before-pin\n' "$previous"
BOX
  chmod 0600 "$SITE_EVIDENCE/site2-07-pre-pin-close.txt"
  rm -f -- "$SITE_RELEASE_REPO/site/.env"
  test ! -e "$SITE_RELEASE_REPO/site/.env"
  test ! -L "$SITE_RELEASE_REPO/site/.env"
  # Write the manifest after the box receipt and cleanup; CLOSE.txt stays outside it.
  python3 - "$SITE_EVIDENCE" <<'PY'
import hashlib,json,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]).resolve(); rows=[]
for path in sorted(root.rglob("*")):
    if path.is_symlink(): raise SystemExit(1)
    if path.name in {"chrome-launch.log","manifest.json","CLOSE.txt"} or path.is_dir(): continue
    if not path.is_file(): raise SystemExit(1)
    data=path.read_bytes()
    rows.append({"path":path.relative_to(root).as_posix(),"bytes":len(data),
      "mode":format(stat.S_IMODE(path.stat().st_mode),"04o"),"sha256":hashlib.sha256(data).hexdigest()})
if not rows: raise SystemExit(1)
manifest=root/"manifest.json"; manifest.write_text(json.dumps(rows,sort_keys=True,indent=2)+"\n",encoding="utf-8"); manifest.chmod(0o600)
PY
  manifest_sha=$(shasum -a 256 "$SITE_EVIDENCE/manifest.json" | awk '{print $1}')
  {
    printf 'CLOSED=yes\nOUTCOME=failed-before-pin\nclosed_before_pin=true\n'
    printf 'BASELINE_UNCHANGED=PASS\nPIN_RELEASED=not-created\n'
    printf 'MANIFEST_SHA256=%s\nCLOSED_AT=%s\n' "$manifest_sha" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  } >"$SITE_EVIDENCE/CLOSE.txt"
  chmod 0600 "$SITE_EVIDENCE/CLOSE.txt"
  test "$SITE_WINDOW_FILE" = "$HOME/.commonswarm-site-window.env"
  test -f "$SITE_WINDOW_FILE"
  test ! -L "$SITE_WINDOW_FILE"
  rm -f -- "$SITE_WINDOW_FILE"
  test ! -e "$SITE_WINDOW_FILE"
  test ! -L "$SITE_WINDOW_FILE"
)
```

```sh
# step: site2-07-manifest-close — Mac mini /bin/bash 3.2; Anvil; sanitize, release pin, and close
# readonly: no
# host: Mac mini /bin/bash 3.2 as Anvil; ssh child on box
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL site2-07-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  test "$(command -v rm)" = "$HOME/.local/bin/rm"
  test -f "$HOME/.commonswarm-site-window.env" && test ! -L "$HOME/.commonswarm-site-window.env"
  test "$(stat -f '%Lp' "$HOME/.commonswarm-site-window.env")" = 600
  . "$HOME/.commonswarm-site-window.env"
  test "$SITE_WINDOW_FILE" = "$HOME/.commonswarm-site-window.env"
  test "${#SITE_RELEASE_SHA}" -eq 40
  case "$SITE_RELEASE_SHA" in *[!0-9a-f]*) exit 1 ;; esac
  case "$SITE_WINDOW_ID" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;; *) exit 1 ;;
  esac
  for input_path in "$SITE_EVIDENCE" "$SITE_RELEASE_REPO"; do
    case "$input_path" in /*) ;; *) exit 1 ;; esac
    test -d "$input_path" && test ! -L "$input_path"
  done
  test "$(stat -f '%Lp' "$SITE_EVIDENCE")" = 700
  # Retry only an attempt that has no box-close receipt and no completed close.
  test ! -e "$SITE_EVIDENCE/CLOSE.txt" && test ! -L "$SITE_EVIDENCE/CLOSE.txt"
  test ! -L "$SITE_EVIDENCE/site2-07-pin-close.txt"
  if test -e "$SITE_EVIDENCE/site2-07-pin-close.txt"; then
    test -f "$SITE_EVIDENCE/site2-07-pin-close.txt"
    test ! -s "$SITE_EVIDENCE/site2-07-pin-close.txt"
  fi
  pin=$(cat "$SITE_EVIDENCE/previous.release"); previous=$(cat "$SITE_EVIDENCE/previous.original")
  if test -f "$SITE_EVIDENCE/rollback-auto.txt"; then
    grep -qFx 'ROLLBACK_PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site2-06-rollback-verify.txt"
    outcome=rolled-back
  elif test -f "$SITE_EVIDENCE/site2-04-reconciliation.txt"; then
    grep -qFx 'DEPLOYMENT=failed-before-switch' "$SITE_EVIDENCE/site2-04-reconciliation.txt"; outcome=failed-before-switch
  else
    grep -qFx 'PUBLIC_BYTES=PASS user_agent=commonswarm-release-probe/1.0' "$SITE_EVIDENCE/site2-05-public.txt"
    python3 - "$SITE_EVIDENCE" <<'PY'
import json,pathlib,re,sys
root=pathlib.Path(sys.argv[1]); label="site2-05-browser-acceptance"
branch=json.loads((root/"site2-03-browser-preflight.json").read_text(encoding="utf-8"))["branch"]
assert branch in {"FULL-CONTROL","REDUCED-CONTROL"}
rows=(root/(label+"-receipt.txt")).read_text(encoding="utf-8").splitlines()
assert "BROWSER_BRANCH="+branch in rows and "blocking=no" in rows
acceptance=[line for line in rows if line.startswith("browser_acceptance=")]; assert len(acceptance)==1
if acceptance[0].startswith("browser_acceptance=PASS reason="):
    assert "browser_control_exit=0" in rows
    assert json.loads((root/"site2-05-browser.json").read_text(encoding="utf-8"))["branch"]==branch
else:
    # Optional browser evidence: NOT_PROVED closes as released in either mode/phase.
    assert re.fullmatch(r"browser_acceptance=NOT_PROVED reason=(?:STEP [0-9]{1,2} \([A-Za-z /-]+\)|STOP[^\n]+)",acceptance[0])
PY
    outcome=released
  fi
  test "$pin" = "/srv/commonswarm/site/releases/.site-window-pin-$SITE_WINDOW_ID"
  test "$previous" = "$BASELINE_DIR"
  after=''
  if test "$outcome" = released; then
    grep -qFx 'rollback=not-needed' "$SITE_EVIDENCE/site2-06-rollback-verify.txt"
    after=$(cat "$SITE_EVIDENCE/after.release")
    python3 - "$after" "$SITE_RELEASE_SHA" <<'PY'
import re,sys
assert re.fullmatch(r"/srv/commonswarm/site/releases/[0-9]{8}T[0-9]{6}Z-"+re.escape(sys.argv[2][:12])+r"-[0-9a-f]{16}",sys.argv[1])
PY
  fi
  # Retained outcome must exactly match the receipts; never overwrite a conflict.
  python3 - "$SITE_EVIDENCE" "$outcome" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1]); outcome=sys.argv[2]
expected=("OUTCOME="+outcome+"\n").encode()
if outcome=="released": expected+=(root/"site2-05-browser-acceptance-receipt.txt").read_bytes()
target=root/"site2-07-outcome.txt"
assert not target.is_symlink()
if target.exists(): assert target.is_file() and target.read_bytes()==expected
else: target.write_bytes(expected)
target.chmod(0o600)
PY
  browser_acceptance_line=$(sed -n '/^browser_acceptance=/p' "$SITE_EVIDENCE/site2-07-outcome.txt")
  python3 - "$SITE_RELEASE_REPO" "$SITE_EVIDENCE" <<'PY'
import pathlib,sys
repo=pathlib.Path(sys.argv[1]).resolve(strict=True); root=pathlib.Path(sys.argv[2])
assert repo not in {pathlib.Path("/"),pathlib.Path.home().resolve()}
target=repo/"site/.env"
assert target.parent.resolve(strict=True)==repo/"site" and not target.is_symlink()
if target.exists(): assert target.is_file()
for name in ("manifest.json","site2-07-outcome.txt"):
    path=root/name; assert not path.is_symlink()
    if path.exists(): assert path.is_file()
PY
  write_site_manifest() {
  python3 - "$SITE_EVIDENCE" <<'PY'
import hashlib,json,pathlib,re,stat,sys
root=pathlib.Path(sys.argv[1]).resolve(); rows=[]
for path in sorted(root.rglob("*")):
    if path.is_symlink(): raise SystemExit(1)
    if path.name in {"chrome-launch.log","manifest.json","CLOSE.txt"} or path.is_dir(): continue
    if not path.is_file(): raise SystemExit(1)
    if path.name=="site2-07-pin-close.txt" and path.stat().st_size==0: continue
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
assert json.loads(manifest.read_text(encoding="utf-8"))==rows
for row in rows:
    path=root/row["path"]; data=path.read_bytes()
    assert len(data)==row["bytes"] and hashlib.sha256(data).hexdigest()==row["sha256"]
    assert format(stat.S_IMODE(path.stat().st_mode),"04o")==row["mode"]
PY
  }
  # Close the task browser before any box change, so a browser STOP leaves this
  # close resumable. Only the controller stops its own child and removes its
  # profile; close is idempotent and passes when both are already gone.
  if [ -n "${SITE_BROWSER_ROOT:-}" ] && [ -d "$SITE_BROWSER_ROOT" ]; then
    case "$SITE_BROWSER_ROOT" in /private/tmp/anvil-secret.??????) ;; *) exit 1 ;; esac
    test ! -L "$SITE_BROWSER_ROOT"
    test "$(stat -f '%Lp' "$SITE_BROWSER_ROOT")" = 700
    test "${SITE_TASK_BROWSER:-}" = "$SITE_BROWSER_ROOT/site-task-browser.mjs"
    if ! node "$SITE_TASK_BROWSER" close --state-dir "$SITE_BROWSER_ROOT" </dev/null; then
      printf '%s\n' 'STOP site2-07-manifest-close: task-browser close unproved; nothing signalled; retain private staging and window state for HezLead reconciliation' >&2
      exit 1
    fi
    if ! rm -r -- "$SITE_BROWSER_ROOT"; then
      printf 'STOP: guarded cleanup refused %s; leave it for HezLead\n' "$SITE_BROWSER_ROOT" >&2
      exit 1
    fi
    test ! -e "$SITE_BROWSER_ROOT"
  fi
  write_site_manifest
  printf -v box_command '%q ' /bin/bash -s -- "$pin" "$previous" "$SITE_WINDOW_ID" "$outcome" "$browser_acceptance_line" "$after" "$SITE_RELEASE_SHA" "$BASELINE_DIR"
  ssh -o BatchMode=yes commonswarm@yulan-vps-1 "$box_command" \
    >"$SITE_EVIDENCE/site2-07-pin-close.txt" <<'BOX'
set -euo pipefail
set -E
trap 'printf "FAIL site2-07-manifest-close: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
test "$#" -eq 8
pin=$1; previous=$2; window_id=$3; outcome=$4; browser_acceptance_line=$5; after=$6; release_sha=$7; baseline_dir=$8; root=/srv/commonswarm/site
python3 - "$window_id" "$outcome" "$browser_acceptance_line" "$after" "$release_sha" <<'PY'
import re,sys
window,outcome,acceptance,after,release_sha=sys.argv[1:]
assert re.fullmatch(r"[0-9a-f]{40}",release_sha)
assert re.fullmatch(r"[0-9]{8}T[0-9]{6}Z",window)
assert outcome in {"released","rolled-back","failed-before-switch"}
if outcome=="released":
    assert re.fullmatch(r"browser_acceptance=(?:PASS|NOT_PROVED) reason=(?:STEP [0-9]{1,2} \([A-Za-z /-]+\)|STOP[^\n]+)",acceptance)
    assert re.fullmatch(r"/srv/commonswarm/site/releases/[0-9]{8}T[0-9]{6}Z-"+re.escape(release_sha[:12])+r"-[0-9a-f]{16}",after)
else: assert acceptance==after==""
PY
test "$(id -un)" = commonswarm
test -f /tmp/commonswarm-site-window.env && test ! -L /tmp/commonswarm-site-window.env
test "$(stat -c '%a' /tmp/commonswarm-site-window.env)" = 600
(
  . /tmp/commonswarm-site-window.env
  test "$SITE_WINDOW_ID" = "$3"
  test "$SITE_RELEASE_SHA" = "$release_sha"
  test "$BASELINE_DIR" = "$baseline_dir"
)
test -d "$pin" && test ! -L "$pin"
test -f "$pin/app/index.html"
test "$pin" = "$root/releases/.site-window-pin-$window_id"
test "$previous" = "$baseline_dir"
test -L "$root/current"
current=$(readlink -f "$root/current")
case "$outcome" in
  released) test "$current" = "$after"; test -d "$after" && test ! -L "$after" ;;
  rolled-back) test "$current" = "$pin" ;;
  failed-before-switch) test "$current" = "$previous" ;;
esac
test -z "$(find "$root" -maxdepth 1 \( -type f -o -type l \) -name 'current.next*' -print)"
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
rm -f -- /tmp/commonswarm-site-window.env
test ! -e /tmp/commonswarm-site-window.env && test ! -L /tmp/commonswarm-site-window.env
printf 'pin_released=yes\noutcome=%s\nOUTCOME=%s\n' "$outcome" "$outcome"
if test "$outcome" = released; then printf '%s\n' "$browser_acceptance_line"; fi
BOX
  chmod 0600 "$SITE_EVIDENCE/site2-07-pin-close.txt"
  grep -qFx 'pin_released=yes' "$SITE_EVIDENCE/site2-07-pin-close.txt"
  grep -qFx "OUTCOME=$outcome" "$SITE_EVIDENCE/site2-07-pin-close.txt"
  if test "$outcome" = released; then
    grep -qFx "$browser_acceptance_line" "$SITE_EVIDENCE/site2-07-pin-close.txt"
  fi
  python3 - "$SITE_RELEASE_REPO/site/.env" <<'PY'
import pathlib,sys
build_env=pathlib.Path(sys.argv[1])
if build_env.exists(): assert build_env.is_file() and not build_env.is_symlink()
PY
  rm -f -- "$SITE_RELEASE_REPO/site/.env"
  test ! -e "$SITE_RELEASE_REPO/site/.env"
  rm -f -- "$SITE_WINDOW_FILE"
  test ! -e "$SITE_WINDOW_FILE" && test ! -L "$SITE_WINDOW_FILE"
  write_site_manifest
  manifest_sha=$(shasum -a 256 "$SITE_EVIDENCE/manifest.json" | awk '{print $1}')
  branch="$(jq -er '.branch' "$SITE_EVIDENCE/site2-03-browser-preflight.json")"
  {
    printf 'CLOSED=yes\nOUTCOME=%s\n' "$outcome"
    printf 'BROWSER_BRANCH=%s\n' "$branch"
    if test "$outcome" = released; then printf '%s\n' "$browser_acceptance_line"; fi
    if test "$branch" = FULL-CONTROL && test "$outcome" = released &&
      grep -q '^browser_acceptance=PASS reason=' "$SITE_EVIDENCE/site2-05-browser-acceptance-receipt.txt"; then
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
)
```

## 8. Gap-to-plan mapping

| Audit item | Resolution |
|---|---|
| P2-K1-01 | `site2-01`: box-clock start, derived four-hour end and ID. |
| P2-K1-02 | Named `SITE_EVIDENCE`; `site2-01` creates/verifies `0700`. |
| P2-K1-03 | Named `SITE_RELEASE_REPO`; `site2-00-source-checkout` creates/verifies it. |
| P2-K1-04 | No browser bearer is exported; controls use a fresh headless profile and record signed-in claims as NOT PROVED when signed out. |
| P2-K2-01 | `site2-01` creates the protected evidence directory. |
| P2-K2-02 | `site2-00-source-checkout` creates detached exact-SHA source. |
| P2-K2-03 | Named `SITE_BUILD_ENV_OP_REFERENCE` and service-account token-file path; `site2-00-build-env` creates a private temporary directory, reads with `op read --out-file`, installs and validates the build file, then removes the whole temporary directory. |
| P2-K2-04 | Browser preflight reads only `user.id` from the persisted site session and never writes a token. |
| P2-K2-05 | `site2-00-a-close-ingest` measures live MCP ON; historical A close input retired. |
| P2-K2-06 | `site2-03-go-record` writes bounded `GO.txt`. |
| P2-K2-07 | `site2-03-pin-previous` creates/proves the retention-proof copy; close releases it. |
| P2-K2-08 | `site2-04-reconcile-failure` records state and forbids replay. |
| P2-K2-09 | The marked browser steps use only Anvil's task-owned fresh headless profile and restore its starting workspace. |
| P2-K2-10 | Deploy/public failures auto-switch; browser failures never do; `site2-06` requires public rollback bytes and records browser failures as NOT_PROVED. |
| P2-K2-11 | `site2-07-manifest-close`, or `site2-07-pre-pin-manifest-close` before pin invocation, scans, hashes, closes, and cleans inputs. |
| P2-K3-01 | `site2-01` produces the evidence directory. |
| P2-K3-02 | `site2-00-source-checkout` produces the checkout. |
| P2-K3-03 | `site2-00-build-env` produces `site/.env`. |
| P2-K3-04 | Browser preflight selects full or reduced control automatically; reduced control marks signed-in claims `NOT PROVED`. |
| P2-K3-05 | `site2-00-a-close-ingest` produces the live MCP ON receipt. |
| P2-K3-06 | `site2-03-go-record` produces `GO.txt`. |
| P2-K3-07 | Pin step produces the rollback path consumed by rollback blocks. |
| P2-K3-08 | Browser preflight proves Ridgeio and CLI/web user-ID equality, then switches through the normal workspace switcher or enforces reduced control. |
| P2-K3-09 | Close produces and validates `manifest.json`. |
| P2-K4-01 | `site2-01` proves direct SSH identity and site2-root write access. |
| P2-K4-02 | `site2-01` proves box Python/DNS/HTTPS, exact media types and required User-Agent. |
| P2-K4-03 | Branch selection is automatic from the fresh headless Chromium session; signed-out/2FA state selects reduced control; a keychain dialog is STOP. |
| P2-K5-01 | Live MCP ON check replaces the historical A/B handoff. |
| P2-K5-02 | Static Connected apps exposure acceptance in GO. |
| P2-K5-03 | Lane 8 records successful EMPTY or POPULATED Connected apps; view-only controls do not prove live revoke behavior. |
| P2-K5-04 | Static exact-SHA deletion-guard assertion in `site2-02`. |
| P2-K5-05 | Static hold list consumed by GO; missing evidence stops. |
| P2-K5-06 | Static exact SHA/base authorization consumed by `site2-04`. |
| P2-K5-07 | Static rollback for deploy/public failures only; every browser failure records NOT_PROVED. |
| P2-K5-08 | Static mechanical close after required readbacks. |
| P2-K6 | Empty by audit. |
| Pre-seed: start/evidence | `site2-01` measures time and creates the named destination. |
| Pre-seed: checkout/base | Named checkout/base; source and `site2-02` prove them. |
| Pre-seed: `site/.env` | Named 1Password reference and protected service-account token-file path; the build-env step produces its own temporary output path, installs and proves `site/.env`, and clears the temporary directory. |
| Pre-seed: browser session | Historical K4-8/K4-9 used retained Chrome. The current preflight creates and validates its own fresh headless profile; those historical measurements do not prove this control. |
| Pre-seed: `GO.txt` | GO step produces it from approver, plan commit, release SHA and prompt number. |

## 9. Recorded outcomes

`CLOSE.txt` separately records outcome, browser branch, manifest digest, pin
release, and closure. A pre-pin failure instead records `OUTCOME=failed-before-pin`,
`closed_before_pin=true`, `BASELINE_UNCHANGED=PASS`, and `PIN_RELEASED=not-created`;
it makes no release or browser-acceptance claim. Its manifest includes the box
baseline/close receipt, with `CLOSE.txt` outside the hashed set. The evidence set
separately records build/upload/switch, public bytes, browser controls, and any
rollback. A successful site release
records the pre-GO MCP metadata/401 status check separately from site controls.
Those read-only probes establish public MCP routing and its unauthenticated
challenge; they do not prove an authenticated MCP session or live revoke
behavior. Connected apps evidence records the actual EMPTY or POPULATED list
when full control runs; reduced-control `NOT PROVED` claims remain explicit.

## 10. Changes from the lane-8 plan

This is a generalized copy of
`docs/evidence/2026-09-28-site-hm8/SITE-RELEASE.md`, not a release receipt.
All 16 marked steps remain, with the `site2-` prefix; the former A-close ingest
name remains stable but now measures live MCP ON. The per-hunk ledger below
uses unified-diff context of three lines against that lane-8 file. Line spans
for the generalized body precede this appended ledger.

The historical A edge SHA, DARK result, preparation-seat revocation/count,
and close receipt are retired: they proved completion of a particular earlier
backend window. They are not prerequisites for a future site-only window;
the current hosted MCP ON check they handed off is preserved and repeated at GO.
The one-off retained try-9 close recipe is also retired; generic close resumption,
pre-pin closure, failure reconciliation, rollback (§6), and manifest close (§7)
remain. No account/workspace control fixture or acceptance assertion was dropped.

The boxed source record is a 12-character prefix in the measured release name;
this copy uniquely expands it to the full Git commit before matching EXPECTED_SITE_SHA.
It does not invent a RELEASE_SHA file absent from the deployment helper. The fixed
/download version becomes the selected source version so that control stays useful.
The FULL-CONTROL / REDUCED-CONTROL acceptance table, independent public-byte gate,
parity rulings, service-account build document reference, secret rules, guarded rm,
and scp -p / mode-0600 window handling are retained. The new failure table explicitly
reports existing partial-open/pin/GO/close reconciliation limits rather than creating
new release actions or claiming an unproved close.

**Task-browser controller (2026-10-03, audit item 4).** After the hunk ledger
below was written, the browser blocks moved to `scripts/site-task-browser.mjs`:
the preflight starts the controller instead of a setsid launch and a staged
`browser-process.py`; `site2-05-browser-acceptance` and `site2-06` probe through
it instead of `kill -0`, libproc and a fixed port 9335; both `site2-07` closes
run its idempotent close before any box change; `site2-browser-close` was added
for retained-state failure paths. Browser failures in either mode or phase are
now `NOT_PROVED` and never roll back; `site2-05-browser-acceptance` no longer
contacts the box. Every other marked block is byte-identical. The ledger spans
below describe the earlier generalization and are not updated for this change.

| Hunk | Lane-8 → generalized body (unified-diff span) | Reason |
|---|---|---|
| 1 | `@@ -1,21 +1,20 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Replace fixed target/base/directory and Window A prerequisite with validated release inputs and current MCP ON checks. |
| 2 | `@@ -27,110 +26,181 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Define generic SHA/gate inputs and measured baseline/version outputs; remove historical edge/DARK/prep-seat handoff requirements; document the actual recorded source prefix and add Run order / Failure paths; Validate full SHA commit identities, origin/main ancestry, site delta and exact-SHA receipt in source checkout and window open; Replace fixed target/base SHA tests with validated full lowercase SHA inputs. |
| 3 | `@@ -139,7 +209,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 4 | `@@ -151,7 +221,15 @@` | Measure canonical current directory and its recorded source prefix on the box rather than trust a literal baseline. |
| 5 | `@@ -192,7 +270,13 @@` | Uniquely resolve the measured prefix to a full commit, require equality to EXPECTED_SITE_SHA and base ancestry, and derive BASELINE_DIR. |
| 6 | `@@ -210,11 +294,15 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Retain measured baseline/version and generic gate path in window state; archive full-source baseline and protected gate receipt; preserve scp -p/0600. |
| 7 | `@@ -225,30 +313,52 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Replace the historical handoff-copy step with the same current MCP metadata/unauthenticated POST ON probe used at GO; keep its stable step ID. |
| 8 | `@@ -288,7 +398,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 9 | `@@ -303,14 +413,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 10 | `@@ -318,19 +428,23 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Replace fixed target/base SHA tests with validated full lowercase SHA inputs; Replace literal SHA assertions with lowercase full-SHA validation and require origin/main ancestry plus nonempty site delta. |
| 11 | `@@ -340,22 +454,22 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 12 | `@@ -396,13 +510,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 13 | `@@ -430,7 +544,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 14 | `@@ -445,7 +559,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 15 | `@@ -582,7 +696,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 16 | `@@ -624,11 +738,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 17 | `@@ -637,27 +751,27 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 18 | `@@ -673,26 +787,33 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Transport the measured baseline directory as a quoted positional input and compare with protected box window state before pin/pre-pin closure. |
| 19 | `@@ -716,10 +837,10 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Require the retained measured baseline directory in place of the fixed lane-8 release path. |
| 20 | `@@ -740,13 +861,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 21 | `@@ -755,15 +876,25 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Replace fixed target/base SHA tests with validated full lowercase SHA inputs; Reparse protected exact-SHA gate evidence at GO and use live MCP receipt instead of historical close=PASS. |
| 22 | `@@ -789,13 +920,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Record current hosted MCP ON and exact-SHA site gates, replacing HM37 Window A labels. |
| 23 | `@@ -805,13 +936,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 24 | `@@ -829,7 +960,7 @@` | Require the retained measured baseline directory in place of the fixed lane-8 release path. |
| 25 | `@@ -855,7 +986,7 @@` | Recognize the selected release prefix during deploy/failure reconciliation instead of the lane-8 target prefix. |
| 26 | `@@ -866,33 +997,33 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Recognize the selected release prefix during deploy/failure reconciliation instead of the lane-8 target prefix. |
| 27 | `@@ -902,9 +1033,9 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 28 | `@@ -915,45 +1046,45 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 29 | `@@ -964,18 +1095,18 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Use the validated selected SHA prefix for exact target-name/public-byte or closure checks. |
| 30 | `@@ -989,7 +1120,7 @@` | Check the version measured from the selected source rather than fixed 0.1.80; retain exact public download bytes. |
| 31 | `@@ -1006,7 +1137,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 32 | `@@ -1014,7 +1145,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 33 | `@@ -1035,38 +1166,38 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 34 | `@@ -1091,8 +1222,8 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 35 | `@@ -1110,9 +1241,9 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 36 | `@@ -1129,8 +1260,8 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 37 | `@@ -1207,11 +1338,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 38 | `@@ -1230,7 +1361,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 39 | `@@ -1267,7 +1398,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 40 | `@@ -1283,7 +1414,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 41 | `@@ -1303,14 +1434,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 42 | `@@ -1351,11 +1482,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 43 | `@@ -1363,7 +1494,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 44 | `@@ -1374,14 +1505,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 45 | `@@ -1397,14 +1528,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 46 | `@@ -1418,31 +1549,31 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 47 | `@@ -1453,14 +1584,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 48 | `@@ -1475,9 +1606,9 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 49 | `@@ -1507,22 +1638,22 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 50 | `@@ -1534,11 +1665,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 51 | `@@ -1548,9 +1679,9 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 52 | `@@ -1567,8 +1698,8 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 53 | `@@ -1625,8 +1756,8 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 54 | `@@ -1698,11 +1829,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 55 | `@@ -1716,7 +1847,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 56 | `@@ -1724,18 +1855,18 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 57 | `@@ -1744,19 +1875,6 @@` | Drop only the completed try-9 recovery recipe with its specific evidence/process/release paths; keep generic guarded close-resume behavior. |
| 58 | `@@ -1765,16 +1883,17 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Enforce the preserved protected window-file 0600 contract before pre-pin sourcing. |
| 59 | `@@ -1785,11 +1904,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 60 | `@@ -1812,17 +1931,24 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Transport the measured baseline directory as a quoted positional input and compare with protected box window state before pin/pre-pin closure; Keep the box window file regular/non-symlink and 0600 before sourcing or removal. |
| 61 | `@@ -1832,12 +1958,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Keep the box window file regular/non-symlink and 0600 before sourcing or removal. |
| 62 | `@@ -1853,7 +1980,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 63 | `@@ -1861,7 +1988,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 64 | `@@ -1902,19 +2029,20 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Replace fixed target/base SHA tests with validated full lowercase SHA inputs. |
| 65 | `@@ -1925,30 +2053,30 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 66 | `@@ -1956,14 +2084,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Require the retained measured baseline directory in place of the fixed lane-8 release path; Use the validated selected SHA prefix for exact target-name/public-byte or closure checks. |
| 67 | `@@ -1971,14 +2099,14 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 68 | `@@ -1986,7 +2114,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 69 | `@@ -1998,7 +2126,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 70 | `@@ -2018,22 +2146,23 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Transport the measured baseline directory as a quoted positional input and compare with protected box window state before pin/pre-pin closure; Pass and validate selected full SHA and measured baseline to box close; bound selected-target regex with that SHA. |
| 71 | `@@ -2042,12 +2171,13 @@` | Replace fixed target/base SHA tests with validated full lowercase SHA inputs; Match close inputs to retained box window SHA/baseline and compare previous path with the measured baseline. |
| 72 | `@@ -2077,11 +2207,11 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 73 | `@@ -2105,7 +2235,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 74 | `@@ -2113,7 +2243,7 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 75 | `@@ -2127,13 +2257,13 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic. |
| 76 | `@@ -2154,44 +2284,44 @@` | Use the site2 step/evidence namespace consistently; keep the existing control logic; Update the historical gap mapping for the generic live-state handoff without dropping a mapped control. |
| 77 | Append §10 after §9 | Add this complete per-hunk generalization ledger; no executable block or gate added here. |
