# Item CP lane CP1: Google first and primary on /app sign-in (landed 2026-09-26)

Brief: `docs/design/2026-09-26-CP-CONSUMER-POSITIONING-BRIEF.md`, section CP1 (v4, brain `consumer-positioning` v2).

- Lane commit `c0b1f004` on `2a8dfcc2` (Alloy task `d5fc2b8504b54635`: Codex Maker, Checker PASS), squashed and
  authored by the lead.
- `PROVIDERS` is google, then github. `ProviderButtons` takes optional `primaryClass` and `secondaryClass`; only the
  /app sign-in host passes them. On /app the provider buttons come first, then the "or" divider, then the email form
  (its button is now secondary). /invite and re-authentication keep one class. The page script still binds the email
  form by `.dashboard__email` (`LiveDashboard.astro:7574`); `data-auth-view="choices"` moved to the wrapper.
- No "last used" hint and no empty-account message (accounts match by email, brain v2).

## Actions site suite

| Run | SHA | Tests | Pass | Fail |
|---|---|---|---|---|
| 36244598675 (CP0, same failures as main) | `9cbab6e9` | 580 | 564 | 15 |
| 36248946758 (this lane) | `c0b1f004` | 582 | 566 | 15 |

The 15 failures are the same set (set comparison: 0 new, 0 fixed); they are item CP follow-up 2.

## Before the site release

- **Google web round trip: DONE** (Anvil for Tom, 2026-09-27, live site): a Google sign-in as tom@chartingalpha.com
  returned to /app signed in. It is a NEW account, because Tom's usual account (GitHub Ridgeio) uses a different email;
  that is the expected result under brain v2. Evidence: `/Users/yulanbot/anvil-work/uat-20260927/` on the mini.
- **Same-email linking: NOT ESTABLISHED.** HezLead's read-only count on production (2026-09-26): 0 accounts with both
  a Google and a GitHub identity (any Google 2, any GitHub 3). No same-email pair exists to prove it; this does not
  block the release (Strategist ruling 2026-09-27).
- Tom's yes on the CP3 copy: given 2026-09-26 (see `CP3-LANDING.md`).
