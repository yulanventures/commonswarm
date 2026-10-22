Lists PR183 is LIVE: main `81b5fb71`, deployed ~20:39Z, baseline 273, assets 200; rollback is PR182 (HezLead receipt).

Merged whole tree exactly matches canonical-tested `84fad586`: 1,163 pass, zero fail, two existing skips; all four gates passed. Cross-family review accepted four 8/10 views with zero blockers. Required note: Lists UI/copy refresh only; no new agent tools; existing MCP/CLI gaps unchanged; no parity claim.

PR184 is an isolated draft at `3a45f7f`, based on live `81b5fb71`: inline 44px list-item checkbox controls, the same existing toggle action, accessible empty-name fallback, scoped CSS, and the existing SSR owner test. Actual focused SSR red/red/green passed. Three changed paths only; all other live blobs preserved. Capture helper is source-adopted but unrun. Actual images, cross-family review and site CI remain pending.

CommonSwarm owns the runner for permanence r12. Kylon holds no lock or resources. Tom's Chrome remains closed: never launch it; the signed-in audit stays on hold. Kylon never merges main or deploys.
