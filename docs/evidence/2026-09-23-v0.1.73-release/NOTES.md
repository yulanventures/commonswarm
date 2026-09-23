This release keeps `cswarm listen` running through server trouble.

**A listener no longer stops for good on one bad answer.** Before this release, one HTTP 403 or a short run of 500s could stop a listener permanently, and nothing started it again. Now:
- A network error, a timeout, a 5xx, or an answer from a host that is not CommonSwarm (for example during a DNS change) is retried with a growing wait, capped at 5 minutes, for as long as the listener runs.
- The listener stops for a lost credential only after the server confirms it at least three times over at least ten minutes. Any success in between cancels the stop.
- Before a token expires, the listener renews it in time, and it keeps at least one second between any two requests.
- Refusals that no retry can change still stop the listener, with a sentence that says what to do: an outdated CLI (`upgrade_required`), or a link-joined seat that receives messages through its poll instead of a listener.

**`cswarm listen status` says what is true.** It names the retry or credential-check state, the next attempt and the real stop time, the server address, and the action to take. It no longer reports a claim lapse for a stopped listener or a busy push listener, and it shows "ATTENDING: hook" only when a hook is installed for the listener's project.

Other commands (`check`, `inbox`, `note`, and the rest) keep their existing credential messages.

**What to do:** update, then restart any running listener so that it uses the new binary. A listener that stopped earlier stays stopped until you start it again.
