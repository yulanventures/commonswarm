# Listener lane landing: a listener survives a server outage (2026-09-23)

Branch `lane/listener-outage` from main `a9846955`, merged with `git merge --no-ff` onto main `ae99df60`. It ships in
cswarm 0.1.73. The Maker's record, fold by fold, with the invariants and the fatal-answer sets, is `LANE.md` here.

## Why

Measured on the mini on 2026-09-22: no `cswarm listen` process was running. One listener had stopped for good on a
single HTTP 403 during the 2026-09-16 DNS switch (classed `credential_stopped`, no retry); another on an HTTP 500 after
five restarts in 24 s. Nothing restarted them, so a short server problem ended coordination for those seats until a
person noticed. This was the cause behind the operator's "CommonSwarm is not working" report; the service itself
answered normally.

## What it does now

- **A credential stop is confirmed over time:** at least three confirmed-loss answers from OUR edge over at least ten
  minutes (read `forbidden`/`unauthenticated`, command `unauthenticated`, renewal refusals), with transient answers in
  between extending the window. One-shot commands keep the D-004/D-011 behaviour and wording exactly (invariant B).
- **Everything else from the network retries** with capped backoff and a named status: 5xx, timeouts, network errors,
  any status or body a misrouted or foreign host can give (the fatal answers are two explicit sets,
  `READ_FATAL_ANSWERS` and `COMMAND_FATAL_ANSWERS`, each member traced to its edge producer), and every parse error in a
  network response (tagged classes, guarded by an AST test).
- **No wait crosses the renewal deadline** while the token can renew (invariant A; margin 110 s: 30 s server clock
  lead, two 30 s timeouts, two 1 s floors, two 5 s pending writes, 8 s headroom); every wait and restart has a 1 s floor
  between requests (invariant C); claim failures force a read so a revoked seat is classified; a worker turn ends by the
  same margin.
- **Status says what is true:** retry and credential-check states with the next attempt and the real stop time; no
  lapse for a stopped listener or a busy push listener; "ATTENDING: hook" only when a hook is installed in the
  listener's recorded project; the target base URL; named sentences for the H0 seat refusal (`h0_seat_uses_poll`), 426
  `upgrade_required` (update the CLI), session-proof refusals and a local credential-state mismatch.

## Review

14 folds (Grok Maker for the lane and fold 1; Codex gpt-6-sol for folds 2-14; lead fixes), reviewed in 11 rounds by a
Claude Opus 5.5 Checker plus Codex (round 1) or Grok (rounds 2-11); every round before the last found a real case, all
fixed. Final pair: Opus PASS at `0a47a550` (round 10) and on the fold-14 delta (round 11); Grok FAIL at `38fd4d5b`
(one status-truth finding, fixed in fold 14) and PASS on the fold-14 delta. Reviews: `arms/`.

## Live control

Against production through a local fault proxy (`live-control-20260923T0634Z/`): one HTTP 500 and one foreign HTML 403
on the read path; the listener retried twice in 2.7 s, read 200, subscribed to Realtime and stayed `ready`. No message
for the seat was lost.

## Gates

At `e1a94363` (lead): build 0; npm test 961; test:p1-cli 838; check:tests 0; build-release 0; diff-check 0; no
leftover process. The merged tree is gated before the push.

## Not established

- Behaviour during a real DNS failover and under real production clock skew.
- A renewal-path fault live (the live control's token was far from its renewal time).
- `cswarm inbox --follow` still stops on one confirmed read code (not a listener; disclosed in LANE.md).
