# HM2 box window rerun 3 — stopped at transactional catalog gate

Release `72c57e0d76d0aa86fe4f811a2cf51499919fed20` was not applied.

The pinned plan hash matched. Anvil reran both exact-SHA gates in a clean detached worktree; both passed. Section 1 reused the already-created immutable edge and stack directories only after full manifest verification, recorded a new four-hour window, transferred the reviewed proof files, and confirmed no stack runtime change. Sections 2–3 passed. By HezLead approval after the prior `principal_name_taken` stop, the sole plan-step change appended `b` to both hard-coded names; `hm2-name-suffix.diff` records the exact change. Both principals were created and passed the pre-migration local-seat baseline.

The complete backup gate passed with `verified_at=2026-09-28T03:55:22.215479+00:00` and the agreed 22-hour maximum age. Section 5 found exactly one pending version, `20260928000002`, and the decision gate returned the required successful `ledger=0 catalog=f` result.

The transactional apply then stopped because the same catalog proof returned false after the migration DDL and ledger insert, before commit. PostgreSQL rolled the transaction back. A separate read-only reconciliation proved `ledger=0 catalog=f`; `edge/current` and `stack/current` remain on `9b085c82352390cf8f0fe515c02b3ccff423476a` and `e38b499fc29a01935333e38f66c4e68ac7e1f81e`. No edge switch, functional proof, cron-after comparison, edge probes, or post-release controls ran.

Section 1 abort cleanup verified the edge recycle, backup, and restore timers active. Both `b`-suffixed temporary principals were revoked through Tom’s production session, and database readback found both revoked. No agent token was minted. Transient database session files were removed, the protected local control directory and root proof directory were preserved, and ordinary copy-back was not attempted because the curated manifest’s later artifacts do not exist.
