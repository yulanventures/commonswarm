# Lane B third fold — 2026-10-01

Base: `5cb6f2fc78c43f6b7396e3762c9a828416be27dc`, branch
`lane/b-delegation-authority`. Changes are uncommitted. No push, Actions
dispatch, server suite, Docker, browser, keychain access, secret retrieval,
migration execution, or production operation occurred. HezLead owns the
independent review and authorized CI run.

| Test | Cause with file:line | Fix or disposition |
|---|---|---|
| #2, admin HTTP boundary | `supabase/functions/command/admin-delegation.ts:161` rejects a non-admin resource as an invalid envelope; `:306` refuses before the core can read metadata; `:374` maps that refusal to HTTP 400. The old harness expected 403 at `tests/support/admin-server-harness.mjs:208`. It was already refusing, not accepting the wrong audience. | Correct the exact expectation to `400 invalid_request`. Also require no grant metadata, exactly one refusal audit, no related success events, and the same-path successful read control. See `tests/support/admin-server-harness.mjs:208`. Signed runtime wrong-audience coverage remains unchanged. |
| #5, durable refused-attempt allowance | `src/protocol/admin-authority.ts:71` treats initial runtime credential issuance (no refresh lineage) as a mutation. `supabase/functions/command/admin-delegation.ts:314` durably charges it. The old loop expected 20 additional refusals before exhaustion despite that first charge. Contract `docs/design/2026-10-01-AGENT-ADMIN-GRANT-CONTRACT.md:285` requires authenticated attempts, including refusals, to consume hourly allowance; lifetime issuance budgets count accepted issues (`:287`). | Measure and assert the initial issuance charge, consume the remaining 19 attempts, then require `429 rate_limited`. Assert durable grant/connection/account counts after each refusal, unchanged counts/events on refused retries, charging even the exhausted refusal, and exact surrender without another charge. Require exactly one human audit per refusal. See `tests/support/admin-server-harness.mjs:254`. Rename the server case to distinguish hourly allowance from lifetime budgets. |
| #221, catalog rollback drill | `tests/p1-server/hosted-authority.test.ts:553` runs the HM reserve rollback, whose `deploy/release-proofs/item-hm/20260928000002-rollback.sql:16` restores a constraint permitting only `user`, `agent`, `join`, without removing hosted idempotency receipts. The hosted claim path writes `hosted_grant` at `supabase/functions/command/index.ts:10388`. The rollback and test are identical on local `main` and unchanged since lane B's parent `f0382efc`. Lane B adds no principal kind and stores receipts separately in `swarm.admin_command_results` (`supabase/functions/command/admin-delegation.ts:375`). | Unresolved scope/fact conflict. No lane-B migration or reserve rollback alteration: it would not repair the old HM rollback. Workspace `AGENTS.md` requires stopping when a brief's facts disagree with observed state; task B excludes `deploy/` edits and hosted grant code edits. HezLead needs to correct the diagnosis and assign the HM rollback/fixture repair. The actual database contents were not inspected here. |
| #208, Item L duplicate PUT | `tests/p1-server/file-artifacts.test.ts:1858` pins the second PUT's status/body, including `Duplicate`. The whole case is identical on local `main`; it, `src/cloud/exact-file-put.ts`, and `supabase/functions/command/file-artifacts.ts` have no lane-B diff against `f0382efc`. | Unchanged. Source comparison supports the task's pre-existing-failure diagnosis; no fresh Storage runtime reproduction is claimed. |

No production authorization or rate policy was changed. The two repaired tests
protect existing behavior more precisely. No contract departure was introduced.
The migration diagnosis in item #221 remains a blocker; this is not a claim
that all four requested failures are fixed.

## Gates

Each test/build invocation ran directly, unpiped, under `env HOME="$T"`,
after `T=$(mktemp -d /private/tmp/lane-home.XXXXXX)`. The shell's HOME was never
assigned. Each owned directory was resolved and removed with guarded `rm`,
including the interrupted npm-test directory identified by its invocation log.
No live secrets were staged. The edge retry copied only cached npm packages
into its disposable Deno cache.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | Passed. |
| `npm run check:tests` | 0 | Passed. |
| `npm run check:edge`, fresh cache | 1 | Sandbox DNS prevented npm dependency downloads. |
| `npm run check:edge`, disposable copy of cached npm packages | 0 | All seven script entry points passed. |
| `npm test` | 130 | Interrupted after approximately 3m45s without new output. Summary: 1,133 tests; 1,056 passed, 74 failed, one cancelled, two skipped. All eleven admin protocol cases, the bundle case, and both runtime-proof cases passed. The broad gate is not green. |
| `node --import tsx --test tests/p1-cli/admin-protocol-bundle.test.ts` | 0 | One case passed. |
| `node --import tsx --test tests/p1-cli/test-gate-coverage.test.ts` | 0 | Three cases passed. |
| `git diff --check` | 0 | Passed. |

Unpiped broad-gate output is retained at
`/private/tmp/lane-b3-npm-test.log`. Failures include socket `EPERM` and
release-plan assertions. No baseline broad-gate comparison was run, so these
74 failures are not all asserted to predate the fold.

Protocol sources and generated artifacts are unchanged; regeneration was not
needed. The server harness itself was not executed, as required by the task.
The corrected HTTP and durable-counter assertions therefore await CI proof.

## Files changed and pending verification

- `tests/support/admin-server-harness.mjs` — 28 added, 5 removed lines.
- `tests/p1-server/admin-delegation.test.ts` — one test-label replacement.
- `docs/evidence/2026-10-01-lane-b/FOLD3.md` — this report.

Production/tooling changes: zero. No migration, reserve rollback, policy,
generated bundle, deployment, or site file changed.

All eight server scenarios still need an authorized run:
`runtime`, `boundary`, `lifecycle`, `consent`, `limits`, `expiry`, `failure`,
`storage` in `tests/p1-server/admin-delegation.test.ts`.
Also retain `command.test.ts`, `hosted-authority.test.ts`,
`hosted-check.test.ts`, `hosted-mcp.test.ts`, and the Item L case as server
regressions. #221 needs the separately scoped HM repair; #208 remains the
reported pre-existing Storage failure. HezLead must arrange the independent
cross-family check; no Alloy or delegated reviewer was launched here.
