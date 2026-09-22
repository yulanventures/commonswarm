- **PRODUCTION — `site/src/components/connect/AgentConnect.astro:314,943`:** A minted credential stays in the DOM until Done or Revoke. The component does not clear it on `pagehide`. If the browser restores the page from its back cache, the credential can be read again. This breaks the one-time display requirement.
- **PRODUCTION — `site/src/lib/commonswarm.ts:553`:** The shared command path changes with the flag off. If local sign-out throws after a 401, this code now reports an expired session; main reports an unknown outcome. Existing app commands use this path, so flag-off behavior is not the same as main.
- **RIGOUR — `site/src/components/connect/h0-link-join.observer.test.ts:328`:** The flag-off test checks selected controls, headings, and copy text. It does not compare the full output with main, so it cannot prove the required byte-for-byte match.

The targeted pure tests passed: 1 limit test, 19 invite tests, and 15 timeout tests. The worktree is clean. I did not build the site or contact a service.

VERDICT: FAIL
