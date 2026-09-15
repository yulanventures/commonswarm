Findings:

- [P1] [tests/p1-cli/h0-verbs.test.ts:39](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/tests/p1-cli/h0-verbs.test.ts:39>) — ACK extraction finds the correct current keys, and moving the anchor fails loudly. But it is still a text regex:
  - A fake `exactKeys(...)` inside a comment plus a wrong table passed 10/10.
  - Moving `lease_id` into a behavior-preserving spread and removing it from the table passed 10/10.
  - `keys.length >= 5` detects emptiness, not incomplete extraction.

- [P1] [tests/p1-cli/h0-verbs.test.ts:60](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/tests/p1-cli/h0-verbs.test.ts:60>) — ACK is not fully checked against enforcement. Changing `lease_id` from required+nullable to omittable+non-null passed 10/10. Only `last_error_code` and `surfaced` semantics are pinned.

- [P1] [tests/p1-cli/h0-verbs.test.ts:102](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/tests/p1-cli/h0-verbs.test.ts:102>) — The secret test does not cover “any shape.” Colon and equals forms failed, but `Use TEST_SECRET_VALUE as your join credential` passed 10/10. Adding an optional credential argument produced a document containing the secret while all tests passed.

- [P1] [tests/p1-cli/h0-verbs.test.ts:115](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/tests/p1-cli/h0-verbs.test.ts:115>) — All requested normal import forms failed. But this legal import passed 10/10:
  `import type { CloudTarget } from/* split */"../cloud/config.js";`
  A Deno probe then failed with TS2307. The claimed leaf property is not controlled.

- [P1] [src/h0/verbs.ts:18](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/src/h0/verbs.ts:18>) — “ACK is the one verb whose enforcement exists” is false. Ask, note, working-on, and reply map to enforced `post_signal` behavior at [command/index.ts:1759](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/supabase/functions/command/index.ts:1759>) and [cli.ts:3982](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/src/cli.ts:3982>). Removing required `body` from `ask` and adding `made_up_field` passed 10/10.

- [P2] [tests/p1-cli/h0-verbs.test.ts:67](</private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/arms-h-codex/tree/tests/p1-cli/h0-verbs.test.ts:67>) — Exact-format field injection failed, but `shadow_field: required` passed 10/10. The test controls one rendering grammar, not every field the document names.

Gates:

- `FORCE_COLOR= npm run test:p1-cli`: exit 1, 15 warning-caused failures. An empty variable is still set.
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 0, 688/688. All 10 H0 tests ran.
- `npm test`: exit 0, 874/874. No H0 test ran.
- Build, `check:tests`, `check:edge`, clean Deno import probe, and `git diff --check`: exit 0.
- Restored SHA: `9c2c20023be8f0a9fda66a4ee639c889d04a9cc8`; worktree clean.

VERDICT: FAIL — The ACK extractor, secret guard, leaf guard, and other-verb admission all fail under proven mutations that remain green.
