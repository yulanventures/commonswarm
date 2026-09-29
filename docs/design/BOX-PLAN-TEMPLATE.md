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

Split successful reads from refusal probes. Give each half its own step ID and
repeat the shell options, environment sourcing, and working directory so either
block can run alone. Do not split a mutating block merely because it also reads.
The static test rejects known write methods and mutating commands in `yes` and
`probe` blocks, but command review remains the final check.

```sh
# step: example-read
# readonly: yes
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
