# Item J release proofs

These follow `deploy/RELEASE-TO-BOX.md` section 5. Copy both SQL files into the
root of the exact-SHA release proof directory before applying migration
`20260924000001`. The catalog query returns one Boolean `catalog_ok` and ends
with its own `\gset`. The functional file is a read-only check for
`release_psql_ro --file`. Its positive control requires a live member in an
unarchived workspace to have at least one pending row. HezLead must arrange
that seed through the normal product path before the release window; the proof
fails closed if no such row exists. It then checks that the same workspace
returns zero rows without a member identity. The catalog pins the function
body digest as well as its signature and grants. Only HezLead and Anvil run
the box procedure.
