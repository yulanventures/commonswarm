# Lane B fold 6: p1-cli failures

Base: `a24a4371`. Comparison requested by the brief: `6b549ef6..a24a4371`.
No commit, push, Actions dispatch, browser, Docker, production operation,
keychain access, or secret staging was performed. HezLead owns independent review.

| Test | Cause and evidence | Result |
|---|---|---|
| `tests/p1-cli/admin-worker-boundary.test.ts` | The test launches Deno at line 6, but `.github/workflows/server-suite.yml:78` installed Deno only for the server suite; the second setup step at line 82 covered only server-repeat. The p1-cli job at line 199 ran without installing Deno. Hiding Deno from PATH reproduced a launch failure before any handler import. The child has `error.code=ENOENT` and absent output fields, so the previous assertion's stdout/stderr concatenation also obscured the cause. A positive control with the normal PATH exited 0 in the same probe. | Include p1-cli in the existing pinned Deno setup step. Add `assert.ifError(run.error)` at test line 12 to expose launch failures; retain both the exit-0 and success-marker assertions. The real handler harness passed directly before and after the change. |
| `tests/p1-cli/agent-channel.test.ts` | Not a lane B behavior change. The test, `src/cloud/agent-channel.ts`, `src/cloud/agent-receive.ts`, CLI, local MCP, listener, and channel HTTP clients are unchanged from the requested main SHA. `supabase/functions/mcp/protocol.ts` is also unchanged. The test uses its own HTTP server (`agent-channel.test.ts:110`), so the changed edge HTTP handlers and their admin credential classifier are outside its execution path. A likely existing race is the fixture's signal insertion at lines 261–266: after the second ACK, an empty claim can run before insertion; `agent-channel.ts:40` sets a 30-second poll interval, and lines 510–518 record the empty claim without a wake topic. The test's default eventual deadline is only 10 seconds (`agent-channel.test.ts:28`). The ACK resets polling at `agent-channel.ts:459`, which makes the outcome depend on scheduling. Quiet polling explains empty stderr. | Leave channel source and test unchanged. Likely flaky on main by code reading, not proven by a local timeout reproduction. The direct local run failed earlier with loopback `listen EPERM` at test line 187, so it could not reach the CI timeout. |

The other changed cloud modules do not change the channel path:
`src/cloud/files.ts` changes only a comment; the new `unauthenticated` entry in
`src/cloud/mcp-register-refusals.ts` is consumed during connection registration,
not receive serving. The CLI imports the protocol index, whose added exports
contain pure definitions and no startup I/O. No changed backend handler is
imported by the stdio receive loop. This excludes a new lane B handler denial
or authentication fallback as the cause of this mocked-channel timeout.

## Gates

Commands ran directly with `env HOME=/private/tmp/lane-home.ymTTfm` after that
directory was created by `mktemp -d /private/tmp/lane-home.XXXXXX`. The shell HOME
was never assigned. Node was v26.7.0; Deno was 2.9.4. The installed Node 22
binary could not start because its Homebrew simdutf library is missing (exit 134);
no machine configuration was changed to repair it.

| Command | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | Passed. |
| `npm run check:tests` | 0 | Passed. |
| `npm run check:edge`, fresh disposable cache | 1 | Sandbox DNS blocked npm package downloads. |
| `npm run check:edge`, cached npm packages copied into disposable DENO_DIR | 0 | All seven entry points passed. |
| `npm test` | 1 | Interrupted after about 182 seconds without progress. Summary: 1,134 tests, 1,057 passed, 74 failed, one cancelled, two skipped. Admin tests passed, including the worker boundary test. Failures include socket EPERM and release-plan assertions. No broad baseline run was made; not every failure is claimed to predate this fold. |
| `node --import tsx --test tests/p1-cli/admin-worker-boundary.test.ts` | 0 | Passed before and after the fix. |
| Same admin test with Deno hidden from PATH | 1 | Before the diagnostic change, absent child output obscured the launch error; afterward the failure explicitly identifies `spawnSync deno ENOENT`. |
| `node --import tsx --test tests/p1-cli/agent-channel.test.ts` | 1 | Two pure cases passed; stdio case failed before channel launch because the sandbox refuses the fixture's loopback listener. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | Passed. |
| `git diff --check` | 0 | Passed. |

The broad gate used blocking stand-ins for Docker, OrbStack and Supabase, as
required on this host. Its unpiped output is retained in the ignored
`scratchpad/fold-b6/npm-test.log`. No production or listener code changed.
Protocol regeneration was unnecessary. The disposable home and copied cache
were resolved and removed with guarded rm after testing.

## Handoff

Changed files:

- `.github/workflows/server-suite.yml`: install the already-pinned Deno setup for p1-cli.
- `tests/p1-cli/admin-worker-boundary.test.ts`: expose child launch errors.
- `docs/evidence/2026-10-01-lane-b/FOLD6.md`: this report.

HezLead must arrange the cross-family review and p1-cli CI verification; this
worker did not dispatch a run. Existing server proof remains pending for
`tests/p1-server/admin-delegation.test.ts` and its
`tests/support/admin-server-harness.mjs`. No grant-contract behavior changed.
