# Storage upload CORS: preserve the live C1 gate

HezLead supplies the exact reviewed SHA landed on main, independent checker/CI
receipt, target identity, approved before/diff hashes, window and rollback
approval. This document prepares a release; it grants no production access.
The assigned release operator runs it. Do not use section 9 / API_CADDY_PAIR:
that whole-file install would remove the live C1 admin-issuance gate.

This edits Caddy only. No stack window, stack/current change, container restart,
timer change, migration or site release is required. A pair uses two filesystem
renames before a single validate and reload; the renames are not an atomic
filesystem transaction. After any interrupted apply, run rollback, then close.
Recovery has no deadline. A failed automatic recovery leaves the lock and proof
in place; stop and report them to HezLead. Never continue forward after FAIL.
The CA file is checked for local TLS probes only. Restore and aborted or
rolled-back close retain identity, input, backup and member checks and remain
admitted if the probe CA disappears or changes.

Prepare root:root 0700 PROOF_DIR with an absolute `mktemp -d
/root/commonswarm-storage-cors.XXXXXX` before preflight. Do not reuse it.
Stage the approved git archive tar files, inputs JSON and plan at root-only
absolute paths. HELPER_DIR is the root:root 0700 directory containing the three
reviewed files in `deploy/supabase-stack/caddy-live-edit/`, extracted from the
approved release archive with root:root 0600 files. Verify them and this plan
against that archive before running; archive SHA-256 and git pax commit comment
are checked again by preflight. The independent checker receipt must bind the
release SHA, plan SHA-256 and archive SHA-256; the maker cannot supply it.
Set INPUTS_FILE, PROOF_DIR, HELPER_DIR and PLAN_FILE in the persistent box shell.
The kit runner accepts the exact fenced rows below; each runs in a subshell.
It can carry PROOF_DIR supplied through its box-env JSON. No secrets enter
inputs, command arguments or transcripts.

Inputs JSON has exactly these keys (strings except REFUSAL_WINDOWS_UTC).
Hashes are measured afresh and approved by HezLead; examples are not approvals.

| Input | Value |
| --- | --- |
| TARGET | production or staging |
| BOX_HOSTNAME | yulan-vps-1 or c1-staging-20261006, freshly measured |
| MEMBERS | production `10 11`; staging `10` |
| RELEASE_SHA / PREVIOUS_SHA | Full exact reviewed release / previous-stack git SHAs |
| RELEASE_ARCHIVE / PREVIOUS_ARCHIVE | Absolute paths to corresponding `git archive --format=tar SHA` files |
| RELEASE_ARCHIVE_SHA256 / PREVIOUS_ARCHIVE_SHA256 | Exact tar byte hashes |
| PLAN_SHA256 | Reviewed document byte hash |
| BEFORE_SHA256_10 / DIFF_SHA256_10 | Live 10-file hash / approved previous-to-live unified diff hash |
| BEFORE_SHA256_11 / DIFF_SHA256_11 | Same for 11; required only with MEMBERS=`10 11` |
| WINDOW_START_UTC / WINDOW_END_UTC | UTC Z bounds; at most 30 minutes; box clock must be inside |
| REFUSAL_WINDOWS_UTC | Explicit list of `[start,end]` UTC Z pairs supplied by HezLead |
| CADDY_CA_FILE / CADDY_CA_SHA256 | Absolute independently verified public local-Caddy trust anchor / its hash |
| CADDYFILE_SHA256 | Measured `/etc/caddy/Caddyfile` hash |
| ROLLBACK_APPROVED | yes, approved for this window |

For the 2026-10-09 production operation, HezLead's explicit refusal list must
include `["2026-10-09T08:55:00Z","2026-10-09T09:40:00Z"]`,
`["2026-10-09T09:41:00Z","2026-10-09T12:00:00Z"]`, and
`["2026-10-09T12:00:00Z","2026-10-09T13:30:00Z"]`. No production window may
overlap any supplied interval, even if apply happens outside the overlap.
The helper interprets input intervals; it contains no date-specific logic.
Recheck the clock before each forward rename and before reload. Staging may
supply an empty refusal list. Never infer an allowed production window.

Staging requires the exact regular root:root 0600 marker
`/etc/commonswarm-release/STAGING-ONLY`, bytes
`c1-staging-disposable-no-production` without newline, and no 11-file.
Production requires hostname yulan-vps-1 and the marker absent.

The lock is `/run/commonswarm-storage-cors.lock`, root 0700, with a 0600 owner
receipt containing PROOF_DIR. Apply acquires it before any live write; recovery
and close require that same ownership. Do not remove another proof's lock.
Stop on concurrent drift. Retain all before/candidate bytes and metadata on the
box through close; no pruning or secret-stage deletion occurs in this plan.

| Step | Admission / outcome |
| --- | --- |
| cors-preflight | Read-only to live config: check identity/window/hashes, stage previous source and private diff, save exact before bytes/metadata, calculate candidates and GET baseline |
| cors-apply | Lock, recheck baselines, stage non-imported `.candidate` files beside live files, rename every member, pre-create access logs, one validate then one reload |
| cors-verify | Local TLS probes on every member; unchanged non-upload status, outside-block hash and admin_gate count |
| cors-rollback | Before or after a partial apply: restore every saved member and metadata, validate/reload, prove all before hashes |
| cors-close | CLOSE_RESULT=success, rolled-back or aborted; verify condition, record safe summary, release owned lock |

Normal order is preflight → apply → verify → close with CLOSE_RESULT=success.
After a failed/uncertain apply or failed verify: rollback → close with
CLOSE_RESULT=rolled-back. Apply automatically attempts that rollback on every
failure, including validation/reload failures; its original FAIL still stops
the runner. After an admitted preflight with no apply attempt, close with
CLOSE_RESULT=aborted proves exact baselines. A preflight failure has no live
mutation and no lock; report its retained proof path and start a fresh proof.

```sh
# step: cors-preflight
# readonly: yes
# host: box /bin/bash 5.2 as root
set +e
(
set -eEuo pipefail
umask 077
trap 'printf "FAIL cors-preflight; STOP\n" >&2' ERR
test "$(id -u)" = 0
test "${BASH_VERSINFO[0]}" -ge 5
: "${INPUTS_FILE:?}" "${PROOF_DIR:?}" "${HELPER_DIR:?}" "${PLAN_FILE:?}"
python3 "$HELPER_DIR/edit-api-pair.py" preflight "$INPUTS_FILE" "$PROOF_DIR" "$HELPER_DIR" "$PLAN_FILE"
)
```

```sh
# step: cors-apply
# readonly: no
# host: box /bin/bash 5.2 as root
set +e
(
set -eEuo pipefail
umask 077
trap 'printf "FAIL cors-apply; retain proof and lock; STOP\n" >&2' ERR
python3 "$HELPER_DIR/edit-api-pair.py" apply "$INPUTS_FILE" "$PROOF_DIR" "$HELPER_DIR" "$PLAN_FILE"
)
```

```sh
# step: cors-verify
# readonly: yes
# host: box /bin/bash 5.2 as root
set +e
(
set -eEuo pipefail
umask 077
trap 'printf "FAIL cors-verify; rollback required; STOP\n" >&2' ERR
python3 "$HELPER_DIR/edit-api-pair.py" verify "$INPUTS_FILE" "$PROOF_DIR" "$HELPER_DIR" "$PLAN_FILE"
)
```

```sh
# step: cors-rollback
# readonly: no
# host: box /bin/bash 5.2 as root
set +e
(
set -eEuo pipefail
umask 077
trap 'printf "FAIL cors-rollback; retain proof and lock; STOP\n" >&2' ERR
python3 "$HELPER_DIR/edit-api-pair.py" rollback "$INPUTS_FILE" "$PROOF_DIR" "$HELPER_DIR" "$PLAN_FILE"
)
```

```sh
# step: cors-close
# readonly: no
# host: box /bin/bash 5.2 as root
set +e
(
set -eEuo pipefail
umask 077
trap 'printf "FAIL cors-close; STOP\n" >&2' ERR
: "${CLOSE_RESULT:?success, rolled-back or aborted required}"
python3 "$HELPER_DIR/edit-api-pair.py" close "$INPUTS_FILE" "$PROOF_DIR" "$HELPER_DIR" "$PLAN_FILE" "$CLOSE_RESULT"
sha256sum "$PROOF_DIR/copyback.json"
)
```

Copy back **only** `PROOF_DIR/copyback.json` through the approved SSH host into
a fresh Mac 0700 evidence folder with a 0600 destination. Compare its SHA-256
to cors-close output. The runner transcript contains only fixed status labels
and hashes. No live site file, before/after file, previous/live diff, private
diagnostic, HTTP body/header or full proof directory may leave the box.
The diff is Python's byte-preserving unified diff, fixed labels `previous` and
`live`, three context lines, no timestamps; an empty diff has SHA-256 of empty
bytes. Changed lines (including insertions inside the Storage block) cannot
touch Storage. Context lines may include it; those bytes remain private.

The editor reuses r2's host-bound candidate rule and its exact access-log
guards. It obtains the new Storage block from the release source, accepting
the live block's tabs or spaces. A member equal to its previous source must
produce the exact new source; production 11 must meet that condition.
The outside-block hash covers the entire C1 gate region byte-for-byte and the
verify row repeats its admin_gate count. HTTP probes use `curl --resolve
HOST:443:127.0.0.1`, `--noproxy '*'` and the supplied CA, never insecure TLS.
Allowed OPTIONS is 204 with the required ACAO/methods/headers/Vary; denied
OPTIONS has no ACAO; bogus-token PUT equals direct Storage's 4xx and has only
the allowed ACAO; non-upload GET equals preflight's baseline status.
