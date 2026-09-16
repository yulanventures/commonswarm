# H0 lane 3a — landing record

The agent-join credential: a human-minted, seat-capped, hashed, revocable secret, with a hidden registrar
principal, device and run per credential. Registration (which spends a seat) is a later lane.

## The pair
- antigravity FAILED 165114ee (originally a7741ca3) with four production findings about quotas.
- The fix b2f9b8b0 (originally f7ed3c0f) closed three and decided the fourth (seats not reserved at mint).
- antigravity PASSED b2f9b8b0 with no production findings.
- grok PASSED b2f9b8b0 with no production findings.
The rigour findings of both are fixed in place in the commit after the fix, per the sprint's pacing rule.

## Corrections to landed commit messages (messages are immutable; corrected here)
- b2f9b8b0 says the expiry control "proves both halves in one sequence". It did not. With one live and one
  expired registrar, excluding EITHER leaves the same count, so a review arm inverted the predicate —
  excluding the live registrar and counting the expired one — and the test stayed green. The follow-up
  makes the setup asymmetric (one live, two expired), so correct, inverted, count-all and exclude-all
  implementations each land on a different count. All three wrong ones now fail it, confirmed by mutation.
- b2f9b8b0 says the lock "ALSO closes the same pre-existing race in create_agent_principal". Overstated.
  create_agent_principal already took the workspace's single stream row FOR UPDATE before counting, so
  create-versus-create was serialised. The race the lock closes is MINT (which takes no stream lock) versus
  mint and versus create.
- Expired registrars are no longer COUNTED; they are not REVOKED. Their principal, device and run rows remain,
  hidden. Not a quota bypass, since their ids never leave the mint response.

## What the structural lock test pins, and what it does not
Pins: exactly one count of any form over swarm.agent_principals in the command edge; it lives in
lockAndCountLivePrincipals; the helper takes pg_advisory_xact_lock before that count; both ceiling checks call
it. Does NOT pin: the exclusion SQL itself (the asymmetric server test does), the exact lock key, or that the
helper runs before the insert. The six-concurrent-mint server test is NOT a lock test — with the lock removed
it still passed, because the local runtime does not interleave those transactions.

## Requirement handed to the registration lane
Seats are not reserved at mint. Registration must call lockAndCountLivePrincipals under the same lock and
refuse cleanly at the principal ceiling.

## Citations
Inserting code shifted line numbers other files cite. Remapped from git diff hunks and each prose citation read
against its code. Four citations in site/src/lib/agent-connect.ts and the mint observer test were ALREADY STALE
ON MAIN and are re-pointed at the code their sentences describe. tests/p1-cli/citation-drift.test.ts checks only
its own table, never the prose — filed as a separate task.

## Not established
Registration; the caps (5 per person, 20 per workspace) are chosen, not measured; the lock's effect under real
production concurrency; anything on production — no migration or function from this lane is deployed.
