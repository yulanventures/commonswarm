# Item CP lane CP0: the Actions site suite (landed 2026-09-26)

Brief: `docs/design/2026-09-26-CP-CONSUMER-POSITIONING-BRIEF.md`, section CP0.

- Lane commit `9cbab6e9` (Alloy task `73bf468fe36f4e64`: Codex gpt-5.6-sol Maker, Grok 4.7 Checker PASS with no
  findings), squashed and authored by the lead.
- What changed: every site observer that runs Chrome goes through `site/tests/chrome.ts`. In GitHub Actions the
  launcher drops `--single-process --no-zygote`, it reports the child's exit code and signal, and it retries once on
  a signal death. `site/tests/chrome-launch-sweep.test.ts` fails on any direct launch. The provider-button tests read
  the all-providers build from the local fixture server (`site/scripts/provider-fixtures.ts`); no test needs
  `site/.env` or contacts production.
- Local gate (this host runs no browser): the Alloy test ran `scripts/run-gates.sh … site` (site build) and parsed
  the workflow YAML; exit 0.

## Actions site suite

| Run | SHA | Tests | Pass | Fail |
|---|---|---|---|---|
| 36214099402 (main baseline) | `54900214` | 578 | 500 | 77 |
| 36244598675 (this lane) | `9cbab6e9` | 580 | 564 | 15 |

Every one of the 15 failures also fails in the main baseline (set comparison of the `not ok` names: 0 new). On
main they failed at Chrome launch; on the lane Chrome runs and the layout assertions fail. They are follow-ups:

1. **Brain view (7 tests, `brain-view.fixture.ts` users):** "headless Chrome must return the live brain-view
   snapshot". The page does not return its snapshot under Linux Chrome.
2. **Viewport and table wrap (3 tests, `markdown-wordwrap-qa.observer.test.ts`):** "unexpected viewport 500" for a
   390 px request, and a 320 px table measurement plus its CONTROL.
3. **Phone header (5 tests, `mobile-feed-layout`, `feed-composer-clearance` and the account-menu test):** the app bar
   measures 188 px at 390 px and 178 px at 320 px (two rows), so the account menu item "Sign out" has no box. The
   likely cause is wider fallback fonts on the ubuntu runner; not measured.

The acceptance rule in the brief (green, or every remaining failure listed with its cause and also red on main) holds.
