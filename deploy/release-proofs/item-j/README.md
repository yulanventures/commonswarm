# Item J release proofs

These follow `deploy/RELEASE-TO-BOX.md` section 5. Copy both SQL files into the
root of the exact-SHA release proof directory before applying migration
`20260924000001`. The catalog query returns one Boolean `catalog_ok` and ends
with its own `\gset`. The functional file is a read-only check for
`release_psql_ro --file`. Only HezLead and Anvil run the box procedure.
