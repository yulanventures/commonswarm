# Item J, option A — maker evidence

Branch: `lane/item-j` from `e9fe4fe8`. This lane prepares a change; it has not
landed on `main`, been applied to the box, or been observed live.

## Decisions and implementation

1. One server-owned pending list: `supabase/migrations/20260924000001_pending_access.sql`
   adds `swarm_read.pending_access(uuid)`. It checks live workspace membership,
   enumerates ten output columns, and derives classic principals (including no
   token yet) plus available join credentials. Registrar principals are excluded.
   Issuer display comes from a current membership, with a generic fallback.
   The function grants execute to `authenticated` and `swarm_read`, and denies
   `anon`. The read edge serves `resource: "pending_access"` to a human session
   or a scoped agent credential, with an empty envelope for another workspace.
2. The app's two existing Pending access lists use the new resource on opening
   a workspace and on their existing bounded poll. The row says “Invited, not
   connected · <age>”. A classic token can still be cancelled through the
   separate grant status; a principal without a token and a join code are
   informational rows. `cswarm members` reads the same resource, prints the
   new section and includes `pending` in JSON.
3. Connected remains the server's `agent_tokens.first_used_at`: the first
   authenticated agent call of any kind clears the classic row. Join codes
   clear when exhausted, revoked, or expired. This lane adds no setup-error
   reporting surface; that is option B.

## Controls

- `tests/p1-server/pending-access.test.ts` is in the `test:p1-server` glob. It
  creates two workspaces and asserts both positive and cross-workspace empty
  reads. It checks the exact ten-column result and function output names for
  hash, secret, locator, and token leakage, and checks role grants. Mutation
  controls mark a visible token first used, exhaust a visible join credential,
  and revoke a visible no-token principal; all three must disappear. It also
  seeds expired and revoked join credentials and asserts they stay hidden. The
  local-stack test was written for the lead's isolated database run and was
  not executed here, so its result is not established.
- `tests/p1-cli/pending-access.test.ts` exercises parsing, age, roster text,
  clearing on an empty server snapshot, refusal of a malformed kind, explicit
  JSON projection despite an extra server field, and the exact edge request.
- `tests/p1-cli/citation-drift.test.ts` updates the seven pinned `src/cli.ts`
  line references moved by this change; its one focused test passes.
- `site/src/components/app/access-lifecycle.observer.test.ts` exercises the
  shared row model: both kinds, age, capacity, retention of classic token
  cancellation, and clearing when the polled snapshot removes the rows.

## Local gates

- `npm run build`: exit 0.
- `npm run check:tests`: exit 0.
- `npm run check:edge`: exit 0 (all six checked entry points).
- `npm run build:command-core && git diff --exit-code -- supabase/functions/_shared/protocol.js`: exit 0; protocol bundle unchanged.
- `bash scripts/build-release.sh`: exit 0, shipped bundle executed and reported version `0.1.76`.
- `npm --prefix site run build`: exit 0, 12 pages built.
- Focused CLI/site/citation test invocation: exit 0, 27 passed, 0 failed.
- Dispatch baseline unchanged; there are no changed rows to regenerate.
- `env -u FORCE_COLOR npm test`: exit 1, 962 tests, 960 passed, 2 failed:
  the real `ps` probe and the real resume CLI. This sandbox denies process
  inspection/spawn with `EPERM`.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1, 571 tests, 561 passed,
  9 failed, 1 skipped. This worktree lacks `site/.env`; built-provider controls
  fail. Browser geometry, screenshot evidence, and the 30-second result writer
  also fail in this sandbox. The focused pending-access tests pass.
- `env -u FORCE_COLOR npm run test:p1-cli`: first attempt timed out at 180
  seconds. The final process-group-bounded run exited 1 with 925 tests,
  907 passed and 18 failed. Failing tests cover process inspection/spawn,
  hook locks, receipt CLI subprocesses, a feed body limit, and the real resume
  CLI. None names the new pending resource. The citation-drift failure caused
  by the new `src/cli.ts` lines was fixed; its focused test passes.
- `git diff --cached --check`: exit 0 before commit. The final
  `origin/main...HEAD` range check is reported after the commit.

## Required box release after review and merge

Only HezLead directs and Anvil executes `deploy/RELEASE-TO-BOX.md`. The reviewed
full SHA must first land on `main`. This is an `edge stack` release because it
adds a migration and changes `read`; the site and CLI also need separate
release steps. Supply exact-SHA gate evidence, the migration catalog proof,
the function privilege/output-column proof, and an authenticated functional
probe. Take and verify the required fresh complete database backup. Apply
`20260924000001_pending_access.sql` from the immutable stack release and
verify its ledger/catalog state before recreating the edge runtime from the
same reviewed SHA on `commonswarm-net`. Compare stack runtime files: a
migration-only change does not switch `stack/current`. Release the site after
the edge is verified; build and publish the CLI bundle separately. Verify a
human and an agent in workspace A see A's pending rows and get an empty result
for workspace B, then verify first use, exhaustion, revocation, and expiry.

## Not established

The migration and new read resource have not been applied to a local isolated
stack or to production. No hosted behavior, one-minute poll timing, schema
catalog state, cross-tenant edge request, or box release was measured here.
