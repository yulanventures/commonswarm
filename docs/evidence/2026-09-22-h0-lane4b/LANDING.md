# H0 lane 4b landing: the app's "Add an agent" on the link-join (2026-09-22)

Branch `lane/h0-app-join` from main `a103a512`, merged with `git merge --no-ff` onto main `a9846955`. Nothing in this
lane is live: the path is OFF unless the site is built with `PUBLIC_H0_LINK_JOIN=1`, and the h0 edge function is not
on the box yet.

## What it does (flag on)

The signed-in human mints a join credential (`mint_agent_join_credential`), sees the paste from `src/h0/paste.ts`
(the credential plus the public document URL `<service base>/functions/v1/h0/agent-doc/<locator>`), copies it, and can
revoke it while it is shown. The credential is shown once: Done, Revoke and `pagehide` clear it from the page. The
limit refusal branches on the edge's `scope` (5 live invites per person in a workspace, 20 per workspace) with numbers
from `src/protocol/agent-join-limits.ts`, which a test checks against the command edge and the migration. Mint and
revoke use the site's shared `postCommand` (deadline through the body read, dead-session clear on 401).

With the flag off the page behaves as on main: the invite module is loaded only through a flag-on dynamic import.
Measured by the lead at `cd9f0ffe`: a default site build has 0 files containing `joinCredential`, `agent-doc` or
`mint_agent_join_credential`; a flag-on build has 1.

## Commits

| SHA | author | what |
|---|---|---|
| `ce33faaf`, `ee23c7f9` | Grok Maker | the gated invite and its tests |
| `5aaf123f` | lead | timeout-table mapping (later reverted to main's version in `f8adbdfb`) |
| `c747a2ee` | Grok Maker | fold 1: late revoke state, revoked copy, flag-off bundle, independent tests |
| `76855ae0` | Grok Maker | fold 2: limit copy by scope, revoke-before-Done notice, shared postCommand, lost-mint copy |
| `8320ed3e` | lead | revert fold 2's change to the shared postCommand 401 path (it changed every app command) |
| `f8adbdfb` | lead | "in this workspace" for the per-person limit; timeout-table test back to main's version |
| `cd9f0ffe` | Codex Maker (committed by the lead: the sandbox could not write the git index) | clear a shown invite on pagehide; comments |

## Review (arms/)

| round | SHA | arm A | arm B | ruling |
|---|---|---|---|---|
| 1 | `ee23c7f9` | antigravity FAIL (2 PRODUCTION, 1 refuted: `#forget` does clear the prompt; limits helper is reached) | Codex FAIL (flag-off bundle 21,012 vs 18,749 bytes; revoked copy) | fold 1 |
| 2 | `c747a2ee` | Opus FAIL (limit copy blames the person and says "revoke one") | Codex FAIL (same, plus the deadline cleared before the body) | fold 2 |
| 3 | `76855ae0` | Opus FAIL (per-person limit is per workspace) | Codex FAIL (shared 401 path changed with the flag off; pagehide) | lead fixes; pagehide ruled pre-existing |
| 4 | `f8adbdfb` | Opus PASS | Codex FAIL (pagehide: rejected the ruling) | ruling reversed: fold 3 |
| 5 | `cd9f0ffe` | Opus PASS | Grok PASS | land |

Round 1 used antigravity; from 2026-09-22 the operator's model (brain `operating-model` v11) makes Gemini not a review
arm, so rounds 2-5 use a Claude Opus 5.5 Checker plus the other family.

## Gates

At `cd9f0ffe` (lead): build 0; npm test 897; test:p1-cli 826 + 1 load-timing failure in `timeout-table.test.ts`
(the file equals main's; it passed 3 of 3 alone, load average 9-11); check:tests 0; site build (flag off) 0 with 0 H0
files; site test 567; site build (flag on) 0 with 1 H0 file; diff-check 0. The merged tree is gated again before the
push.

## Not established

- The flow against a running command edge, and in a real browser (no DOM library in the site tests; the component
  test drives the class with a fake document).
- A back-forward cache restore in a real browser (the pagehide handler follows the standard; not observed).
- The wording tried with a real agent.

## Follow-ups

- The token prompt on main has no `pagehide` cleanup either (a token clears when it is used; a join credential has no
  used-signal, which is why this lane added it for invites). Decide whether the token prompt needs it.
- No surface lists or revokes a join credential after Done; the copy says so. A list/revoke surface is not built.
