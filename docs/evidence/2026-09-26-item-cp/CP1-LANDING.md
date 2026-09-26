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

## Still to do before the site release

Tom signs in on the web once with Google (the first real Google web round trip), and the same-email linking proof
(a read-only count through HezLead, or Tom's sign-in). Tom's yes on the CP3 copy.
