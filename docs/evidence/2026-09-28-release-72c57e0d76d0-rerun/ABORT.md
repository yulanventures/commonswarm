# HM2 box window rerun — stopped at local-seat name gate

Release `72c57e0d76d0aa86fe4f811a2cf51499919fed20` was not applied.

The pinned plan hash matched, the exact-SHA archive and reused exact-SHA gates passed, the previously prepared immutable edge and stack release directories were byte-verified, a new four-hour window was recorded, proof files were transferred, stack runtime files were unchanged, and sections 2 verify and 3 passed.

The plan’s `hm2-local-prepare-before-migration` step then stopped on its first `principal create`: the hard-coded name `hm2-local-0928` remains reserved by the principal created and revoked during the first stopped attempt, so production returned `principal_name_taken`. The plan explicitly says to stop on duplicate-name refusal and not silently substitute principals. No principal was created in this attempt.

Section 1 abort cleanup ran. The edge, migration, cron, and post-release controls were not run. Edge and stack current links remain on their prior releases, all three relevant timers are active, transient database session files were removed, the failed protected local control directory was preserved, and the Mac window file was removed. The fresh root proof directory remains available for inspection; copy-back was not attempted because required later artifacts do not exist.

Continuation requires HezLead to approve new unique R/S names or a revised `hm2-local-prepare-before-migration` block for another new window.
