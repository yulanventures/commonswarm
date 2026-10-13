# B38 release-plan additions

These are proposed additions for the separate release-guard PR. This worktree
does not change `deploy/RELEASE-TO-BOX.md` or execute a release.

Replace the exemption comment and condition at
`deploy/RELEASE-TO-BOX.md:2149-2153` with this exact text:

```sh
  # The September proofs need observations from the NEW edge and run after
  # section 6 and their seeded command. The B38 proofs write synthetic rows
  # and roll them back; run the named release_psql step for each B38 version.
  if [ "$VERSION" != 20260925000001 ] && [ "$VERSION" != 20260926000001 ] \
    && [ "$VERSION" != 20260927000001 ] && [ "$VERSION" != 20260927000002 ] \
    && [ "$VERSION" != 20260927000003 ] && [ "$VERSION" != 20261014000001 ] \
    && [ "$VERSION" != 20261014000002 ]; then
```

Add this exact step to the reviewed B38 release plan. Run it after runbook-28
for **each** B38 version, before considering the next migration. Each forward
apply still uses runbook-27's one-migration transaction, ledger insert and
catalog proof (`:2034-2107`); do not batch the migrations. Supply all eight
version-named proof files in the proof directory so relative includes resolve.
The catalog owns `catalog_ok` and `\gset` (`:1762-1772`). The functional proof
requirement is at `:1907-1909`.

```sh
# step: b38-functional-proof
# readonly: no
# host: box /bin/bash 5.2 as root
(
  set -euo pipefail
  set -E
  trap 'printf "FAIL b38-functional-proof: line %s: %s\n" "$LINENO" "$BASH_COMMAND" >&2' ERR
  : "${RELEASE_SHA:?named release SHA required}"
  . "/home/commonswarm/stack/release-proofs/${RELEASE_SHA}/window.env"
  test "$SHA" = "$RELEASE_SHA"
  . "/run/commonswarm-release-${SHA}-session.sh"
  . "$PROOF_DIR/current-migration.env"
  case "$VERSION" in
    20261014000001|20261014000002) ;;
    *) printf 'B38 functional proof refuses an unrelated version\n' >&2; exit 1 ;;
  esac
  release_psql -Atq --file "$PROOF_DIR/${VERSION}-functional.sql" \
    >"$PROOF_DIR/${VERSION}-functional.txt"
  test "$(cat "$PROOF_DIR/${VERSION}-functional.txt")" = t
)
```

`release_psql` supplies `ON_ERROR_STOP` (`:1567`). Each functional file starts
its own transaction and rolls it back, including its temporary runtime SET
membership. Do not set `release_proof_outer_transaction` for this release step;
that variable is reserved for the CI rollback drill. Keep `release_psql_ro`
and its read-only guard unchanged (`:1599`, `:2154-2156`).

Add this exact rollback text to the release plan at the explicit rollback
decision (`deploy/RELEASE-TO-BOX.md:2214-2221`):

> Roll back dependent OAuth code first. Use the reviewed reserve files verbatim
> in this order: `item-b38/20261014000002-rollback.sql` →
> `item-b38/20261014000001-rollback.sql` →
> `item-hm/20260928000003-rollback.sql`. Verify each rollback catalog before
> committing that step. The HM reserve drops `interactions` at line 41 and
> `browser_sessions` at line 42; both drops are refused while `finish_records`
> references them. The session reserve also refuses while `finish_records`
> exists. The session schema inverse does not revive invalidated logins.
