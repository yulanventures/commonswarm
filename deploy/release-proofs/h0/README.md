# H0 release proofs

These files follow `deploy/RELEASE-TO-BOX.md` section 5, "Schema migration",
under the catalog proof contract and the per-version verify block. Each
`<version>-catalog.sql` ends with its own `\gset` after a one-row Boolean
`catalog_ok` query. Each `<version>-functional.sql` is a read-only check for
`release_psql_ro --file`. Transfer the six SQL files into the root of the
release proof directory before the per-version blocks run.
