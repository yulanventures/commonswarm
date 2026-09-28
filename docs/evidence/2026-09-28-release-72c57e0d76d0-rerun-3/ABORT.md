# HM2 rerun 3 — rolled back

Outcome: ROLLED BACK.

The approved release SHA `72c57e0d76d0aa86fe4f811a2cf51499919fed20` passed the exact-SHA gates, backup gate, migration decision/apply/verify/functional checks, cron comparison, edge health checks, loopback and staging probes, metrics/log checks, and public hosted-boundary controls.

The post-release ordinary-local-seat control then stopped in the plan's `hm2-local-mint-after-edge` block. The released `cswarm 0.1.80` mint artifact uses the documented `agent_token` field, while the approved block attempted to read `credential["token"]`. The block exited before local setup, sender mint, the observed-ACK proof, or the wake-eligibility proof. One local credential had been minted before the field lookup failed.

Per the approved failure order, Anvil:

1. Restored edge release `9b085c82352390cf8f0fe515c02b3ccff423476a` and verified health, 2 GiB memory, `commonswarm-net`, exact working directory, loopback/staging probes, a metrics line, and a clean log window.
2. Ran the guarded HM2 schema rollback. Final state is ledger `0` and rollback catalog `t`.
3. Revoked both temporary `0928c` principals; both revocations returned `accepted`.
4. Restarted and verified the recycle timer. Backup and restore timers remained active.
5. Copied back 30 existing files from the 32-file approved manifest. `hm-local-first-ack.txt` and `hm-local-wake-after.txt` do not exist because those controls never ran; they were not fabricated. The original approved manifest is preserved.

No npm publication, site release, MCP auth deployment, hosted grant, or stack-current switch occurred.
