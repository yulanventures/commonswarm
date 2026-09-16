# H0 lane 3b — register_agent_seat — landing record

Landed on main 2026-09-16 as a merge of the reviewed SHA **08fbb0cd** (one commit on fca81374). Made by Codex
(gpt-5.6-sol, xhigh) in four rounds; committed by the lead with declared trailers.

## Pair on the exact SHA 08fbb0cd

| arm | family | verdict |
|---|---|---|
| grok (worktree; gates, full server suite 220/220, live mutations) | xai | PASS |
| antigravity (security review of the authority code, inlined) | gemini | PASS |

Round 1 (8f76c8a8) was FAIL from both. The lead checked every PRODUCTION claim against the code:
- CONFIRMED, fixed: a same-attempt retry replaced a token a human revoked before first use (before the fix:
  200 and a secret that then failed authentication, 403).
- CONFIRMED (grok, live 200), ruled INTENDED by the Strategist: an H0 seat renews through its grant; the grant
  horizon and seat expiry are now one instant and replacements are capped at it. The round-1 claim "nothing
  renews a seat" was false and was corrected in the commit.
- REFUTED: register/revoke deadlock (revoke runs before the stream lock and never takes it); renewal past 30
  days; stored-response replay (spec §5); humanRights escalation (the human mint passes the same constant);
  missing FK unique.
Earlier, before any pair: the lead found that a removed member's invite still registered seats (fixed, round 2).

## RIGOUR findings owed as a follow-up commit series (pacing rule: no new pair)

1. Retry liveness for an EXPIRED unused token, an ENDED run and a REVOKED grant is enforced but untested
   (grok removed the token-expiry clauses; the revoke tests stayed green, and a backdated probe got 200).
2. A registered token used on the READ edge works live; no committed test covers it.
3. Unbounded unused-token replacement churn within the credential's 24-hour life (antigravity).
4. An invite whose workspace was archived gets a 500 (the reducer's authz refusal is thrown) instead of the
   uniform 403 (antigravity).
5. Stale citations in site/src/lib/agent-connect.ts: HUMAN_ONLY_COMMANDS (workspace-commands.ts range),
   src/cli.ts:1145 and :1173, src/cloud/auth.ts:342 (grok). The cli.ts ones move again when item H lane 1
   lands; fix after it.

## NOT ESTABLISHED

- Nothing is deployed: the two H0 migrations are not on production, and the h0 function does not forward
  POST /register yet.
- Lock correctness under real concurrency (proved structurally; the local edge runtime does not interleave).
- Renewal on production.
