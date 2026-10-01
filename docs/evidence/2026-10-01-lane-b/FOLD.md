# Lane B fold report — 2026-10-01

Base: `42ff957ad06f68989f05c37de3a590f2176c4621`, branch
`lane/b-delegation-authority`. Changes remain in the working tree. No commit,
push, Actions dispatch, Docker, browser, keychain access, deployment, migration
application, or production contact occurred. HezLead owns the independent check.

| Finding | Disposition | Reason and evidence |
|---|---|---|
| MUSTFIX: exported runtime entry trusts caller-supplied identity | Fixed | The entry accepts a credential instead of identity fields (`supabase/functions/command/index.ts:13214`). The transaction itself verifies it, including direct adapter calls (`supabase/functions/command/admin-delegation.ts:150`). ES256 signature, pinned issuer/JWKS, exact admin audience, five-minute maximum lifetime, and signed owner/grant/connection/client claims are required (`supabase/functions/command/admin-runtime-auth.ts:235`, `:265`, `:271`). |
| MUSTFIX: owner lookup uses disclosed consent identifiers as proof | Fixed | Lookup now uses signed owner, grant, connection, client and resource (`supabase/functions/command/admin-delegation.ts:198`). The locked account rechecks binding and credential expiry before decisions and idempotent returns (`:229`). Failure audit also verifies proof and the durable binding (`:383`, `:413`). Consent identifiers alone cannot select the runtime actor. |
| MUSTFIX: server scenarios were not run | Awaits-CI | Retained the seven scenarios and added a runtime-auth scenario (`tests/p1-server/admin-delegation.test.ts:11`). Updated the real-adapter harness to sign test proofs and exercise forged identities, attacker signatures, wrong audience, expiry, owner/client/connection/grant substitution, direct adapter bypass, and refresh possession without proof (`tests/support/admin-server-harness.mjs:92`). The task forbids running this stack here. This is pending verification, not a code defect. |
| MUSTFIX: bundle test absent from literal npm test gate | Fixed | Added the existing bundle test and new service-free signature tests to the literal `test` list (`package.json:23`). The bundle test passed both directly and in the broad gate. |

NOTEs were assessed without expanding the assignment. Existing HTTP/reducer/RLS
separation and lifecycle defenses remain. CSRF on web revoke needs the future site
integration review; account recovery and the empty-workspace grant are intentional
in this lane. No NOTE required a separate code change.

Every required gate ran directly, unpiped, under `env HOME="$T"`, with a newly
created `mktemp -d /private/tmp/lane-home.XXXXXX` directory. The shell's HOME was
never assigned. Each owned directory was resolved and removed with guarded rm;
the interrupted run's directory was identified through its task-specific npm log
and removed separately. Edge checks copied only cached npm packages into the
disposable Deno cache. No live secrets were staged.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | Passed. |
| `npm test` | 130 | Interrupted after about 4m15s without new output. Flushed summary: 1,133 tests, 1,055 passed, 75 failed, one cancelled, two skipped. All eleven admin core tests, the bundle test, and both new signature tests passed. This is not a green full gate. |
| `npm run check:edge` | 0 | Passed, including a repeat after tightening failure-audit binding. |
| `npm run check:tests` | 0 | Passed. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | One test passed. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | Three tests passed. |
| `git diff --check` | 0 | Passed. |

The full gate output contains socket `EPERM` errors and release-plan assertions;
the box dry-run file was cancelled on interruption. No baseline comparison was
run, so the 75 failures are not all asserted to predate this fold. The unpiped
captured output is `/private/tmp/lane-b-fold-npm-test.log`.

Files changed in this fold:

- `package.json`
- `supabase/functions/command/admin-runtime-auth.ts` (new)
- `supabase/functions/command/admin-delegation.ts`
- `supabase/functions/command/index.ts`
- `tests/admin-runtime-auth.test.ts` (new)
- `tests/p1-server/admin-delegation.test.ts`
- `tests/support/admin-server-harness.mjs`
- `docs/evidence/2026-10-01-lane-b/FOLD.md` (this report)

Server verification still required: all eight scenarios in
`tests/p1-server/admin-delegation.test.ts` (runtime, boundary, lifecycle, consent,
limits, expiry, failure, storage), plus the existing `command.test.ts`,
`hosted-authority.test.ts`, `hosted-check.test.ts`, and `hosted-mcp.test.ts`
regressions. No server scenario or rollback was executed here.

Remaining integration boundary: the unchanged OAuth provider supports only the
MCP audience (`services/mcp-auth/src/provider.js:85`). It cannot currently mint
the required admin runtime proof. Issuance fails closed until separate admin
consent/provider integration supplies a signed `at+jwt` with the exact admin
audience and owner (`sub`), admin `grant_id`, `connection_id`, and `client_id`
bindings. The protected runtime credential store and concrete delivery transport
also remain outside this fold. No end-to-end OAuth or release readiness is
claimed. No policy constant or grant deadline changed; protocol sources and the
generated bundle were unchanged, so regeneration was unnecessary.
