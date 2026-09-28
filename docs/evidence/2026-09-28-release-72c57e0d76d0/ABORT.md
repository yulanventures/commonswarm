# HM2 box window — stopped at backup gate

Release `72c57e0d76d0aa86fe4f811a2cf51499919fed20` was not applied.

The exact plan hash matched, both exact-SHA gates passed, immutable edge and stack release directories were prepared, and the database session and pre-migration local-seat baseline passed. The required section 5 backup freshness check then failed: the scheduled backup service reported success but its status contract had `ok=false`, no byte-verification booleans, and no `verified_at` value.

Per the approved plan, execution stopped before migration decision/apply and before any edge switch. Section 1 abort cleanup verified all timers active. Both temporary principals were revoked and read back as revoked. The HM2 ledger count remains zero; edge/current and stack/current remain on their previous releases. Transient database files were removed. Copy-back was not attempted because later required artifacts were never produced; the root-only box proof directory remains available for inspection.
