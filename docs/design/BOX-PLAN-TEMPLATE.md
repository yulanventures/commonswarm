# Box plan template

Use this shape for a new box window or site release plan. Revise the plan in
place as review findings arrive; do not create a chain of replacement plans.

Every runnable `sh` block starts with a unique `# step:` line. Its second line
is exactly one of these markers:

- `# readonly: yes` reads state and writes only its own evidence or proof files,
  or paths it created with `mktemp` and removes.
- `# readonly: probe` sends write methods only to endpoints expected to refuse
  them. Every request asserts a 4xx or 503 response and uses no credential,
  Authorization or Cookie header, real principal, or real resource ID.
- `# readonly: no` changes box, database, container, Caddy, release, DNS, or
  production state. Failure stops the window and invokes the plan's rollback.

Its third line is `# host:` and names exactly one execution shell: Mac mini
`/bin/bash` 3.2 or box `/bin/bash` 5.2, plus any ssh child on the other host.
Every fenced block is either such a marked `sh` step or explicitly
non-executable (`text`). Prose that requires Anvil to establish, verify, prove,
record, or run something names the step ID that performs it. A judgment with no
command is labeled explicitly as a HezLead decision.

A release-directory verifier may accept only named box-only files whose mode
and SHA-256 are derived from the same source the runbook copies; every other
path or metadata difference stops. Every other window artifact is removed by
that window's close/rollback or has an approved-window-ID name, and no step may
list, glob, or select a `<name>.closed-window-<id>` leftover.

When a window temporarily installs a host runtime that was absent in the
measured baseline, pin and verify the downloaded archive before extraction,
record the installed binary's digest in durable window state, and remove the
binary on both close and rollback only when its current digest matches that
record. A different file is a stop, never a cleanup target. Put dependency
caches under an exact per-window path and remove them on both tails. After the
opening gate, every harness invocation is offline/cached-only.

Dry-run fixtures load measured values from the committed measurement artifact;
they do not maintain a second fixture-value file. A static agreement control
checks every fixture string that names a container image, repository path, or
environment name against repository text or the measurement artifact, and
must reject a same-shaped invented value.

The honest dry run starts every block shell from an empty environment and may
pre-seed only cited measured facts or named prompt inputs with fixed synthetic
values. Stubs return command outputs in measured or source-defined JSON shapes;
they never return a step result. Execute PREP, every main-window state and exit
path, each dependent window, and every browser branch in whole-block order.
`UNPRODUCED` is a dependency defect and the report must be empty. Keep a
separate non-substitutable list for live database, container, HTTP, browser, and
CLI behavior that a dry run cannot prove.

For split windows, persist exactly one receipt at each handoff. The consuming
open block validates the receipt before any change; no second file, inherited
variable, profile discovery, or operator branch choice may carry cross-window
state. Cleanup that owns temporary principals runs on success, rollback,
pre-commit failure, post-commit control failure, and abort.

Split successful reads from refusal probes. Give each half its own step ID and
repeat the shell options, environment sourcing, and working directory so either
block can run alone. Do not split a mutating block merely because it also reads.
The static test rejects known write methods and mutating commands in `yes` and
`probe` blocks, but command review remains the final check.

Public probes to `api.commonswarm.com`, `edge-staging.commonswarm.com`, or
`commonswarm.com` send and record `User-Agent: commonswarm-release-probe/1.0`.
The `mcp.commonswarm.com` non-browser reachability control keeps and records the
client's default User-Agent; loopback may do the same. On every HTTP failure,
save status plus `Server`, `CF-Ray`, and `Content-Type`, and the first 2,048
bytes of a non-JSON body only when it cannot contain a credential. Never save
Authorization, Cookie, Set-Cookie, a token, or a credential-bearing body.
Classify a 403 containing `error code: 1010` as `cloudflare_challenge`.

When `psql` runs in a container, its helper owns host-to-container path mapping.
Callers pass only the guarded host `APPLY_SQL` or a file below `PROOF_DIR`; the
helper maps those to `/run/commonswarm-release-apply.sql` or `/proof/...` and
refuses every other `--file` value.

```sh
# step: example-read
# readonly: yes
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  PROOF_DIR="${PROOF_DIR:?proof directory required}"
  test -f /srv/example/current/RELEASE_SHA
  sha256sum /srv/example/current/RELEASE_SHA >"$PROOF_DIR/release-sha.txt"
)
```

```sh
# step: example-refusal-probe
# readonly: probe
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  PROOF_DIR="${PROOF_DIR:?proof directory required}"
  STATUS="$(curl -sS -o "$PROOF_DIR/refusal.json" -w '%{http_code}' \
    -X POST -H 'content-type: application/json' \
    --data '{"command_id":"00000000-0000-4000-8000-000000000000"}' \
    http://127.0.0.1:9000/functions/v1/command)"
  test "$STATUS" = 403
)
```

```sh
# step: example-mutation
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  systemctl restart example.service
)
```

Write Mac-side blocks for macOS `/bin/bash` 3.2. A heredoc inside `$(...)` is
not portable there: put the heredoc in a function or file, then invoke it from
the command substitution. Guard every file or process-substitution read against
a missing final newline:

```text
IFS= read -r V <F || [ -n "$V" ]
while IFS= read -r X || [ -n "$X" ]; do
  ...
done <F
```

Check exact media types. In particular, `/jwks` answers
`application/jwk-set+json`; do not accept generic JSON as an equivalent result.

Prove that the release SHA is an ancestor of the freshly fetched `origin/main`.
Do not require it to equal the tip, because reviewed releases may legitimately
trail later work on `main`.

An opening gate must be runnable from repository and durable operator inputs.
Do not begin a window with a value described as “not established” that the lead
is expected to invent or supply during execution.

Compile every embedded Python program during review, in addition to checking the
surrounding shell block with `/bin/bash -n`.
