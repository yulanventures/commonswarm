- `site/src/components/connect/AgentConnect.astro:265` — PRODUCTION. Flag OFF does not preserve the built app byte-for-byte. The H0 module is always imported. Controlled local builds produced a 21,012-byte AgentConnect script versus 18,749 bytes on `a103a512`. The OFF bundle also contains dormant H0 document code. The test at `h0-link-join.observer.test.ts:240` checks selected controls and methods, not the built artifact.

- `src/protocol/agent-join-limits.ts:102` — PRODUCTION. After revoke, the page still says “Done leaves the invite active.” `AgentConnect.astro:924` clears the secret and adds a revoked status, but does not replace this false sentence.

- `site/src/components/connect/h0-link-join.observer.test.ts:358` — RIGOUR. The one-time-display test calls `concealJoinInvite` and matches source text. It does not run the component through Done or revoke, or check the DOM, storage, and logs after clearing.

VERDICT: FAIL
