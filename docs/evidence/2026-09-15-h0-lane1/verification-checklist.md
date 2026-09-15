# What the Maker's rework MUST defeat — the union of both arms, round 2

Every line below was PROVEN green by an arm against 9c2c2002. The rework is not done until each
one fails. I verify these myself; I do not take the Maker's word for it.

## Contract completeness (both arms, the core FAIL)
  1. opt("lease_id") instead of req("lease_id", true)            -> must fail
  2. same swap on signal_id / outcome / listener_instance_id     -> must fail
  3. drop a field the wire requires                              -> must fail
  4. add a field the wire does not have                          -> must fail
  5. a variable spread adding an extra wire key                  -> must fail

## Extraction honesty (codex)
  6. a fake exactKeys(...) written INSIDE A COMMENT              -> must fail
  7. lease_id moved into a behaviour-preserving spread           -> must fail
  8. keys.length >= 5 must not be the only completeness check

## Secret leaks — ALL SIX SPELLINGS were green (grok), plus codex's two
  9.  "Join credential is TEST_SECRET_VALUE."
  10. {"joinCredential": "TEST_SECRET_VALUE"}
  11. "Join credential TEST_SECRET_VALUE"     (no separator at all)
  12. "Join credential — TEST_SECRET_VALUE"   (em dash)
  13. "join_credential is TEST_SECRET_VALUE"
  14. "Use TEST_SECRET_VALUE as your join credential"
  15. add (joinCredential?: string) and interpolate it
      -> 15 is the ONLY one a structural control can kill outright: assert via AST that
         h0AgentDocumentDescription takes ZERO parameters. 9-14 are prose and a text check
         cannot be exhaustive, so the file must STOP CLAIMING "any shape" and say which
         control is the real one.

## Leaf control (codex)
  16. import type { X } from/* split */"../cloud/config.js";     -> must fail (AST, not regex)

## Document grammar (codex)
  17. shadow_field: required injected in a different grammar     -> must fail
      (the field test must FAIL on an unparsable line, not SKIP it)

## False claims to delete (both arms)
  18. "ACK is the one verb whose enforcement exists" — FALSE. post_signal is enforced at
      command/index.ts:1759 with interface SignalCommand at :218-237.
  19. "this comment cannot quietly go stale" — FALSE for presence; the test did not read
      the optional marker at all.
  20. "in any shape" on the secret test — FALSE.

## Gate correction (codex, verified by me)
  `FORCE_COLOR=` DOES NOT WORK: an empty variable is still SET and Node still warns, which
  failed ~15 unrelated tests and looked like a lane defect. Use `env -u FORCE_COLOR`.
  Measured: `FORCE_COLOR= node -e '"FORCE_COLOR" in process.env'` -> true.
