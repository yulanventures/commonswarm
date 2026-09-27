# Item CP lane CP3: consumer copy and the Grok Bot guide page (landed 2026-09-27)

Brief: `docs/design/2026-09-26-CP-CONSUMER-POSITIONING-BRIEF.md`, section CP3 (v4).

- Copy: `f00a5c00` (Alloy task `108671002a9a461e`: Codex Maker; Grok Checker's last finding, the stale og.png, fixed by
  regenerating it; the lead removed a sentence about same-email accounts per brain v2). A cross-family audit found no
  false public claim. **Tom said yes to the text exactly as sent** (title, meta description, hero headline and subhead,
  sign-in text), relayed by the CSwarm Strategist 2026-09-26.
- Grok Bot page: `9b1f9959` (Alloy task `e91f9e1f040749f2`; two Checker findings fixed) and `99881c8b` (Alloy task
  `48a57df11c13484d`, after an Alloy review panel (Codex) found two gaps: the gateway prerequisite and the second
  wake-test field; Grok 4.7 Checker PASS). Not part of Tom's yes/no; landed after its Alloy review, as the Strategist
  directed.
- Merge `2079b5aa`: mini `gates` exit 0 (`npm test` 1033/1033); Actions site suite 36287112155: 571 of 587, the 15
  failures are main's known set (0 new).

## Release

Released under the binding rule: after the box window for `20260927000001`-`…03` (step 2). A site release from a SHA
with this merge also carries G3e's roster read (it degrades quietly on an older server).

## Open

The design-doc audience sentence ("The product is for anyone who works with AI agents", `docs/design/SWARM-CLOUD.md`)
was flagged by the audit as broader than the setup allows; it is in the design doc only, not on a public page.
Follow-up: narrow it to agents that can run the cswarm tool.
