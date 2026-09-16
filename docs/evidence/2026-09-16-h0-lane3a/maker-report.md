## Done

Built the agent join credential on `lane/h0-join-credential`. No commit was made. Production was not accessed.

Limits:

- Seat cap: `1..10`
- TTL: `1..24` hours
- Secret: `swm_join_` plus 32 random bytes
- Locator: separate 16 byte public random value
- Only the SHA-256 secret hash is stored

### Registrar decision

- One registrar per credential.
- Name: `join-registrar-<credential UUID>`
- Device label: `Join registrar <credential UUID>`
- Principal, device, run, and credential are created in one transaction.
- Registrar principals, runs, and devices are filtered from user-facing views.
- Registrars still count toward the existing 50-principal resource limit.
- Revoke ends the registrar run and revokes its principal and device. It does not touch agent seats.

## Files changed

Core:

- [agent_join_credentials migration](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/supabase/migrations/20260916000001_agent_join_credentials.sql:8)
- [command edge](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/supabase/functions/command/index.ts:5425)
- [workspace command types](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/src/protocol/workspace-commands.ts:146)
- [generated protocol bundle](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/supabase/functions/_shared/protocol.js:763)
- [credential redaction](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/src/host/credential-redaction.ts:25)

Tests:

- [pure controls](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/tests/p1-cli/agent-join-credential.test.ts:45)
- [local server controls](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/tests/p1-server/agent-join-credential.test.ts:264)
- [host redaction controls](/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/348bdb35-59a1-416f-9db8-84f388f5c3e0/scratchpad/wt-h0-lane3/tests/host-stderr-tail.test.ts:203)

Line-reference maintenance:

- `tests/p1-cli/citation-drift.test.ts`
- `site/src/lib/agent-connect.ts`
- `site/src/components/connect/agent-connect-mint.observer.test.ts`
- `site/src/pages/acceptable-use.astro`

## Final gates

| Gate | Exit |
|---|---:|
| `npm run build` | 0 |
| `env -u FORCE_COLOR npm test` | 0 — 874 passed |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 — 700 passed |
| `npm run check:tests` | 0 |
| `npm run check:edge` | 0 |
| `git diff --check` | 0 |
| `env -u FORCE_COLOR npm run test:p1-server` | 0 — 194 passed |
| `npm run build:command-core` | 0 |
| Local migration reset and full migration chain | 0 |

## Mutation controls

| Broken property | Test that failed |
|---|---|
| Replay returned a credential field | `mint replay returns no secret` |
| Stored digest replaced with zero bytes | `only the SHA-256 digest is stored` |
| Secret copied into the audit row | `only the SHA-256 digest is stored` |
| Database seat-cap CHECK removed | `seats_used cannot exceed seat_cap in PostgreSQL` |
| Edge TTL maximum changed to 25 hours | `TTL above 24 hours is refused before insert` |
| Commands removed from `HUMAN_ONLY_COMMANDS` | `join mint and revoke are human-only` |
| Registrar device label changed | `mint creates and links one registrar principal, device and run` |
| Registrar view filter removed | `the registrar is absent from the roster` |
| Registrar principal revocation skipped | `revoke ends only the registrar lifecycle` |
| `swm_join_` removed from redaction | Both join redaction controls failed |

All mutations were restored.

## WHAT I DID NOT ESTABLISH

- Registration, polling, acknowledgement, and H0 verbs remain for later lanes.
- No code increments `seats_used` yet. The schema constraint and safe update path are ready for registration.
- The three-host Claude, Codex, and Grok done-test was not run.
- No remote migration, deployment, production request, commit, or push was made.
