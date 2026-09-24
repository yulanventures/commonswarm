# Item G lane 1 — Maker evidence

Branch: `lane/item-g-lane1`. Specification: `docs/design/2026-09-24-ITEM-G-LANE-1-BRIEF.md`, decisions 1–4 only. This is source and local verification evidence, not a production release record.

The initial implementation notes below describe `bb229da9`. Fold 1 supersedes their statements about row-bound proof on never-claimed mail, unconditional stale marks, queued replay proof, and the pre-migration seed.

## Decisions and implementation

1. Migration `20260925000001_unclaimed_observed_ack.sql` widens the delivery CHECK for an unclaimed `observed` row and adds the member-scoped `swarm_read.agent_wake_path` aggregate. That view includes only directed ask/note deliveries with no current or former lease. The command edge accepts the separate `unclaimed: true` observation shape only for a directed ask/note to the caller, with a current row-bound session proof when managed. It sets `delivered_at`, `acked_at`, `surfaced_at`, and `ack_outcome` on an untouched row. Replay is idempotent. A claimed or terminal row is refused without change. The existing queued hook promotion remains separate; its managed proof is checked before even an idempotent replay response. Typed refusals remain `delivery_unavailable`, `delivery_ack_conflict`, `delivery_not_surfaced`, and `session_conflict` as appropriate. The new server read is `swarm_read.agent_wake_path`; the app never reads `swarm.signal_deliveries` directly.
2. `checkAgentMessages` records a bounded, rotating local queue only after presentation and cursor commit. It calls `observeUnclaimedAgentDelivery` separately from the leased ACK. The profile and `--hook` paths use the direct commit; MCP defers commit and ACK until the stdio response write. Failed ACKs do not change successful check output or status, and later checks retry pending IDs. The profile's selected managed session proof is bound to the request. A failed output does not enter the ACK queue.
3. `WAKE_STALE_MS` remains derived from `IDLE_POLL_MAX_MS * 3`. `WAKE_STALE_LABEL` is generated from that value. The app's 30-second roster refresh is a separate display cadence recorded in the timeout table.
4. A sender's receipt keeps the young pending sentence, gives an aged unobserved sentence and an operator next step, and shows the observed timestamp. The roster's member-scoped aggregate marks a stale wake path in the header and dialog and clears after ACK on refresh. The existing visible-workspace timer also repaints when a cached timestamp crosses the threshold. `listen status` with no listener uses `NO_LISTENER_STATUS` and `NO_LISTENER_STATUS_SENTENCE`; `listen stop` keeps its existing absent-target result. H0's poll/ack parser still omits the check-only unclaimed field; its documentation tests now compare against that parser's own body type.

## Box release order

After cross-family review and landing an exact SHA on `main`, HezLead directs Anvil to apply migration `20260925000001`, then release the command edge on the box. Afterward a dedicated test seat must send one unclaimed observed ACK, then receive a new directed note left unchecked. Pass that exact note ID as `item_g_seed_signal_id` to the functional proof. The catalog proof checks the schema. Only after migration and edge verification should npm and the site be released. The roster tolerates a missing view. CI and merge do not deploy any surface.

## Proof files and mutation controls

- `20260925000001-catalog.sql`: read-only one-Boolean `catalog_ok` with its own `\gset`. Against the local pre-migration catalog it returned `f` (the roster view was absent). In a rolled-back local transaction containing the final migration it returned `t` and the functional proof passed. Replacing its `min(d.enqueued_at)` view predicate with an impossible marker returned `f` in that transaction.
- `20260925000001-functional.sql`: read-only seeded-row control for the view's positive and anonymous-negative paths. Mutating the positive row predicate to `WHERE false AND ...` raised `no seeded directed unclaimed delivery for wake-path view proof`. The local view remained absent after rollback. Both mutations reached the same catalog and seeded-row paths as the positive controls.
- Server tests cover unclaimed success, replay, wrong principal, claimed and terminal-row refusal, managed session proof, and the member-scoped roster mark clearing on ACK. The positive and negative calls reach the same command edge. These tests are written for the local stack; their runtime result is pending the lead's exclusive database slot.
- CLI and root tests cover the exact unclaimed command shape, presentation ordering, retry after a failed ACK, bounded rotation past refusals, the selected managed profile's proof on the ACK itself, and the stale receipt boundary. A direct command-edge unit control presents a wrong row session proof and a matching proof through the same unclaimed branch, proving the refusal reaches that row fence. The receipt's younger value is the boundary mutation control.
- MCP tests check post-write observation and a failed-write control. Site tests check the shared threshold and verify that the app actually queries the aggregate; replacing the query target is the mutation control.

## Gates

Every test command had an outer process-group timeout and an isolated temporary HOME. `npm run build`, `npm run check:tests`, `npm run check:edge`, `npm run build:command-core` followed by an unchanged generated bundle, `bash scripts/build-release.sh`, and `npm --prefix site run build` exited 0. Focused client, CLI, MCP, receipt, and site tests passed 145/145; the corrected H0, receipt, citation, and wake-path contracts passed 94/94.

`npm test` exited 1: 965 tests, 963 passed, 2 failed because this sandbox denied `ps` with `EPERM`. The first full `test:p1-cli` run exited 1: 923 passed, 9 failed. Six were citation, H0 contract, or receipt expectations corrected afterward and passed in the focused rerun; three were `ps` sandbox failures. The final full CLI gate exited 1: 932 tests, 929 passed, 3 failed, all because this sandbox denied `ps` with `EPERM`. Focused final runs passed 94/94 contract tests, 20/20 managed-profile tests, 52/52 hook-routing tests, and 31/31 delivery-client tests. `npm --prefix site test` exited 1 on the final build: 576 tests, 496 passed, 79 failed, 1 skipped. Headless Chrome aborted under this sandbox, and provider-button controls need `site/.env`, absent in this worktree. The two new wake-path site tests passed. The standalone site build initially needed `npm --prefix site ci` in this worktree; no deployment was made.

The command dispatch baseline was regenerated twice from the loopback fixture (2/2 tests each time). Both runs produced byte-identical baseline and counts files: SHA-256 `38bf1d93286cccad41c7f74d9009d0b67b31a3d7fdf0cc78c9d94792ac406e85` and `5d5f7f20d51cbf1868cb093f23af9d42c5586f5859369effced7199fa1ccf938`. Only rows `listen.status` and `policy.host-session.listen.status.keep` changed, each from JSON `status: "not_found"` to `status: "no_listener"`; the counts file was unchanged.

## Not established

- No production host was contacted, and no production done-test was run. The box migration, command edge, npm package, and site are not released by this lane.
- The lead's local-stack server suite and cross-family review are outstanding. The release proofs validate schema and read behavior in a rolled-back local transaction; live command behavior needs the server tests and release control.
- The app's full visual geometry suite is not established in this sandbox. The new pure roster threshold test passes; the complete site gate's failing controls are recorded above rather than called green.

## Fold 1 — 2026-09-25

The Opus and Grok round-1 reviews failed. This fold implements the lead's G1–G9 rulings. The source tests below are in existing package gates; the local SQL probes ran against loopback PostgreSQL with `lock_timeout = 1s`, inside transactions rolled back afterward. A read verified the old local view was restored and `swarm.wake_path_release` was absent. No box state was read or changed.

| Ruling | Change | Regression test and mutation result |
|---|---|---|
| G1 | An enqueued managed row has no session binding. The unclaimed ACK requires a current command proof and rejects only an existing *different* row binding. | `delivery-client.test.ts` uses a NULL-bound row, missing proof, and different bound session: passed; reverting the fence failed the test. In the rolled-back local stack, `ackAgentDelivery` accepted the current proof and refused a different row binding. `managed-delivery.test.ts` checks the real HTTP flow after the lead's reset; its old generation negative is explicitly the general fence. |
| G2 | Migration records its cutoff in `swarm.wake_path_release`. The view requires a prior post-cutoff unclaimed observed ACK, then counts only post-cutoff, live, unleased, unacked directed ask/note rows. The receipt wrapper adds a row-specific `wake_path_observing` Boolean; absent/false stays neutral. The dated brief correction retains the retired decision wording. | `delivery-client.test.ts` pins the view predicates; `delivery-receipts.test.ts` checks unknown versus stale. Removing the view cutoff or receipt eligibility made the focused tests fail. Rolled-back local view controls passed unknown, known-stale, expired-excluded, pre-cutoff-excluded, and ACK-clears. `managed-delivery.test.ts` covers those cases after the lead's reset. |
| G3 | Observation runs after output and cursor commit. Each ACK gets only its then-remaining deadline; a named 50 ms floor skips late attempts. The final queue write uses that remaining budget. The profile and hook share this path. | `agent-onboarding.test.ts` holds a second ACK in flight past the first's delay and checks return before simulated forced-exit text, with output unchanged. Replacing the remaining budget with a fresh full timeout failed the test. |
| G4 | Only transport and 5xx errors retry. Other typed refusals leave the queue immediately. Transient retry metadata caps attempts at 3 and age at 24 hours. | `agent-onboarding.test.ts` shows N 409 refusals produce N ACK requests across five later checks, plus attempt and age caps; treating a 409 as transient failed the focused test. |
| G5 | The new lease-free shape requires `observed` and `last_error_code IS NULL`. The constraint is added `NOT VALID` and then validated. Catalog proof checks definition and validation, including competing lease requirements. | `delivery-client.test.ts` pins both SQL clauses; removing the error-code condition failed. In a rolled-back local transaction, error-free observed succeeded, observed with `provider_refused` failed CHECK 23514, and the catalog proof returned false for the old definition under the same constraint name. |
| G6 | Functional proof requires `item_g_seed_signal_id`, checks that exact eligible post-cutoff row for an active principal whose owner is still a member, excludes competing mail, and checks exact view time plus nonmember and anonymous reads. | `delivery-client.test.ts` pins the seed and exclusions; removing the seed predicate failed. The rolled-back local proof passed its exact seed and failed with its intended eligibility or competing-mail error for missing, pre-cutoff, expired, revoked, owner-left, and competing-row seeds. |
| G7 | Queued `observed` replay returns idempotently before the row session comparison, as it did before this lane. | `delivery-client.test.ts` replays with a different session and passes; disabling the early replay failed it. |
| G8 | A wake-view read error returns the app roster without a mark. The absent-listener sentence scopes itself to the checked state directory through one constant. | `wake-path.observer.test.ts` and `delivery-client.test.ts` pin both clauses; restoring the throw or the unscoped sentence failed their focused tests. `hook-routing.test.ts` checks rendered copy. |
| G9 | The MCP deferred commit ACKs only IDs through the last visible response row. | `mcp-stdio.test.ts` now checks the ACK ID sequence after a capped response. Replacing the visible prefix with all presented rows failed this test (the mutation that previously passed 42/42). |

The functional box proof's seed procedure changed: after migration and command-edge release, use a dedicated test seat to send one observed ACK, then send the pinned note and leave it unchecked. Supply its ID with psql `-v item_g_seed_signal_id=<uuid>`. The proof cannot be run against the old pre-cutoff seed.

### Fold 1 gates

- `npm run build`: exit 0. `npm run check:tests`: exit 0. `npm run check:edge`: exit 0.
- `npm run build:command-core` plus `git diff --exit-code supabase/functions/_shared/protocol.js`: exit 0, generated bundle unchanged. `bash scripts/build-release.sh`: exit 0, executable bundle check passed. `npm --prefix site run build`: exit 0, 12 pages.
- `env -u FORCE_COLOR npm test`: exit 1, 970 tests, 968 pass, 2 sandbox failures (`ps EPERM`, resume `spawn EPERM`).
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 1, 935 tests, 932 pass, 3 sandbox failures (two `ps EPERM` and resume `spawn EPERM`). The amended receipt and wake-path controls passed.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1, 576 tests, 499 pass, 76 fail, 1 skipped. The wake-path tests passed. Browser geometry tests aborted in headless Chrome; local provider-button controls lacked untracked `site/.env`.
- Dispatch baseline regenerated twice from loopback fixtures: 2/2 each run, exit 0, byte-identical SHA-256 `38bf1d93286cccad41c7f74d9009d0b67b31a3d7fdf0cc78c9d94792ac406e85` (rows) and `5d5f7f20d51cbf1868cb093f23af9d42c5586f5859369effced7199fa1ccf938` (counts). Against `origin/main`, only `listen.status` and `policy.host-session.listen.status.keep` change from `not_found` to `no_listener`; this fold did not change either file.
- `git diff --check origin/main...HEAD`: exit 0. Local identity check: exit 0, four address fields. Local agent-trailer check: exit 0, both fold commits.

### Still to establish

The lead owns `db:reset` and the full server suite after this fold. The rolled-back local probes validate schema, view, proof, and the in-process edge; they do not establish the served HTTP path on a reset stack. No production release or hosted turn latency was measured.

## Fold 2 — 2026-09-25

The Opus and Grok round-2 reviews failed. This fold supersedes Fold 1's G4 claim that transient failures stop after three attempts, G5's implied low-lock validation claim, and G6's pre-edge functional-proof order. All database probes below used only the local stack and rolled back their writes. The lead retains the exclusive `db:reset` and full server-suite run.

| Ruling | Change | Test and mutation result |
|---|---|---|
| H1 | Missing `item_g_seed_signal_id` raises a SQL exception. Section 5 skips this version's functional proof; section 6 runs it only after the new edge is verified and a dedicated seat's first directed note has an unclaimed observed ACK, followed by a second directed note left unchecked. The second UUID is supplied with `-v item_g_seed_signal_id=<uuid>`. Both notes use the box loopback command endpoint with credentials held in root-owned files. | Local `psql -v ON_ERROR_STOP=1`: missing seed exits 3 with `item_g_seed_signal_id is required`; substituting the old `\\quit 1` exits 0 with the same message. `managed-delivery.test.ts` adds a psql positive seed and nonzero checks for missing, unknown, revoked, departed-owner, pre-cutoff, expired, already observed, competing, omitted-view, and missing member-gate cases. Its reset-stack run remains with the lead. |
| H2 | The shared server eligibility source excludes an older unobserved row after the same seat observes a later-enqueued signal. Client attempts and first-attempt time are committed before each request; transient transport, timeout, 5xx, 429, and 401 failures retain the ID with backoff until 24 hours. Typed 409, 403, 404, and `invalid_request` refusals remove it. | Client tests: 25/25 focused pass. Removing the pre-request write made the deadline test fail (exit 1); the fast 409 was removed while the timed-out second ID retained attempt 1 and a future retry time. In a rolled-back SQL probe, the later-observed mutation changed both view and receipt for one row from false/false to true/true. Reset-stack server assertions are pending the lead. |
| H3 | The wake-state server test moves the cutoff to one hour before its rows and restores the prior value in `finally`. It also sets a seconds-old cutoff in the same test to prove the four-minute-old row is excluded, then moves it back to prove inclusion. | Rolled-back local mutation probe: the four-minute-old row was absent with a seconds-old cutoff and present when the cutoff moved one hour earlier (false → true). The server test's reset-stack run remains with the lead. |
| H4 | Kept one migration. Its comment now states that `DROP`/`ADD NOT VALID` holds `AccessExclusiveLock` through `VALIDATE` and commit. Removed the source-text test claiming no validation lock. | A rolled-back local probe copied 100,000 delivery-shaped rows into a temporary table: validation took 9.6 ms and held `AccessExclusiveLock`, `RowExclusiveLock`, and `ShareUpdateExclusiveLock`. A server test measures that lock and checks the corrected comment. Replacing `holds ACCESS EXCLUSIVE` with the old no-lock claim changed its comment assertion from true to false. This is local timing, not a box window estimate. |
| H5 | Added `swarm_read.agent_wake_path_deliveries` as the single eligibility source. The roster aggregates it and receipt `wake_path_observing` queries the same view for the exact signal and principal. | Server tests compare view rows and receipt bits for unknown, pre-cutoff, expired, live, acknowledged, later-observed, revoked, and claimed rows. The local later-observed predicate mutation changed view and receipt together (false/false to true/true). Reset-stack suite pending. |
| H6 | Revoked `PUBLIC`, `anon`, `authenticated`, and `swarm_read` EXECUTE on the renamed inner receipt function, matching the earlier rename migration. Catalog proof and server test inspect privileges. | Rolled-back catalog proof was true with the fix and false after re-granting inner EXECUTE to `authenticated`. |
| H7 | Deleted fold tests that only matched migration, proof, and view source text while claiming database behavior. Added local-stack server assertions for constraint behavior and validation, both wake-path surfaces, receipt privileges, and psql proof exit codes. | Rolled-back migration plus catalog proof returned true. The direct database mutations above changed observable results. The new served HTTP server tests await the lead's reset and suite. |

The 100,000-row lock measurement is a planning input for HezLead; the box's table size, IO, concurrent traffic, and actual exclusive-lock window are not established. The functional proof has not run on the box. No production host was contacted and no production surface was released.

### Fold 2 gates

All test gates had a process-group timeout and an isolated temporary `HOME`; the wrappers reaped their direct child processes. Process-list inspection was unavailable here (`pgrep`: `sysmond service not found`). `npm run build`, `npm run check:tests`, `npm run check:edge`, `npm run build:command-core` with an unchanged generated bundle, `bash scripts/build-release.sh`, and `npm --prefix site run build` each exited 0. The release script's artifact execute-check now passes an explicit loopback `--url` to comply with this lane's CLI rule.

- `env -u FORCE_COLOR npm test`: exit 1; 967 tests, 965 pass, 2 sandbox failures (`ps`/resume `spawn EPERM`).
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 1; 938 tests, 935 pass, 3 sandbox failures (`ps EPERM`). Focused agent-onboarding: 25/25 pass; focused MCP visible-prefix control: 1/1 pass after rebuilding `dist/`.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1; 576 tests, 499 pass, 76 fail, 1 skipped. Headless Chrome aborted under this sandbox; local provider-button controls still lack the untracked `site/.env`.
- `git diff --check`: exit 0 before commit. `git diff --check origin/main...HEAD`: exit 0 after the commit.

The reset-stack server suite, production lock window, box functional proof, and hosted behavior remain unestablished. The lead runs `db:reset` and that suite after this fold; this lane did not reset or stop the local stack.

## Fold 3 — 2026-09-25

The Opus round-3 review failed on agent-sender receipts. The lead's `fad542e0` and `321c5406` test-fixture commits are the starting point for this fold. This section supersedes Fold 2's H3 cutoff-test claim and H5 shared-view design. The migration was replayed inside a transaction against the local fold-2 stack and rolled back; its updated catalog proof returned `true`. The served HTTP server suite still requires the lead's reset stack.

| Ruling | Change | Test and mutation |
|---|---|---|
| I1 | `swarm.wake_path_eligible_deliveries` holds the sole eligibility predicate, owned by `swarm_admin` with no client-role SELECT grants. The receipt SECURITY DEFINER wrapper reads it after its existing author check. `swarm_read.agent_wake_path_deliveries` adds `swarm.is_member(workspace_id, auth.uid())` for the roster. The catalog proof checks the private ACLs and both dependencies. | New server test posts directed signals as an agent and as the owner, makes their delivery rows stale for a known seat, and checks each sender's authorized receipt bit. It also checks that a nonmember receives no receipt or roster row. Reverting the receipt query to the member-gated view makes the agent assertion false; removing the roster membership gate makes the nonmember assertion fail; granting SELECT on the private view fails the catalog test. Reset-stack execution pending. |
| I2 | Kept the release-cutoff predicate as an explicit guard. ~~It is redundant by construction with a known seat's post-cutoff observed ACK and the later-observed rule.~~ **CORRECTED in the lead fold below: the cutoff is load-bearing.** Removed tests that claimed to isolate the cutoff when they actually passed through the known-seat or later-observed filters. | No independent cutoff mutation test is claimed. (Superseded: the lead fold adds one.) |
| I3 | The functional box proof selects the seed and competing mail from the same private eligibility view. Its separate owner-membership check remains. | Server proof test now marks a later signal observed with `delivered_at` and `surfaced_at`; the seed must fail with `seed signal is not an eligible live unobserved delivery for a known, active seat`. Reverting to the copied predicate makes that assertion fail with the old `wake-path view omitted exact seeded unobserved delivery` message. Reset-stack execution pending. |
| I4 | Added no index. | Opus measured 36 ms with 50,000 observed rows, 200 known seats, and five stale rows per seat in one workspace. Its plan showed a sequential scan of 50,000 `signal_deliveries later` rows feeding a hash anti join, plus 50,000 indexed observed-seat reads through `signal_deliveries_terminal_acked`. Follow up with HezLead for the production row count before deciding on the proposed `(workspace_id, recipient_agent_principal_id, enqueued_at)` partial index for unclaimed observed rows. |

The box functional proof, served HTTP server tests, production observed-row count, production query cost, and live stale-receipt behavior are not established by this fold. No production host was contacted.

### Fold 3 gates

Every gate ran with an outer process-group timeout and a temporary `HOME`; the wrapper killed remaining processes in its group. `npm run build` exited 0; `npm run check:tests` exited 0; `npm run check:edge` exited 0; `npm run build:command-core` exited 0 and `git diff --exit-code supabase/functions/_shared/protocol.js` exited 0; `bash scripts/build-release.sh` exited 0; `npm --prefix site run build` exited 0. The rolled-back local migration replay and catalog proof exited 0 with `catalog_ok=t`. Local process-list inspection itself failed (`sysmond service not found`), so independent global process absence was not established.

- `env -u FORCE_COLOR npm test`: exit 1; 967 tests, 965 passed, 2 failed on sandbox `spawn EPERM`.
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 1; 938 tests, 935 passed, 3 failed on sandbox `ps`/`spawn EPERM`.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1; 576 tests, 499 passed, 76 failed, 1 skipped. Headless Chrome aborted (`SIGABRT`) in the failing browser tests.
- `git diff --check origin/main...HEAD`: exit 0 after the fold commits.

## Fold 4 — 2026-09-25

The Grok round-3 review found two remaining defects. This fold starts at `b178c470` and changes the lane migration, check-state retry queue, and their regression tests. The lead's local stack remains reserved for server tests; this fold did not reset, stop, or query it.

| Ruling | Change | Test and mutation |
|---|---|---|
| K1 | The private shared eligibility view joins each later delivery to its signal and compares `(created_at, id)` in the same order as `cswarm check`. Only a later unclaimed observed ACK of a directed ask/note can heal earlier mail. Roster and receipt still read that single view. | `managed-delivery.test.ts` adds a delayed additional recipient: its earlier-created signal is enqueued after a later-created pending ask. The pending ask must remain in the view and receipt. A separate test inserts an observed `working-on` delivery for a listed recipient after a pending ask and requires both surfaces to remain eligible. The existing later-ask ACK test requires a genuine heal. Reverting the tuple comparison fails the inverted-order assertion; removing the kind filter fails the `working-on` assertion; removing the heal fails the existing assertion. These server tests are written but await the lead's local stack, so mutation outcomes are reasoned from the assertions, not measured here. |
| K2 | Retry metadata is filtered to queued IDs on state read and every write, including successful or terminal removal and the 200-ID cap on direct and deferred cursor commits. | `agent-onboarding.test.ts` pushes 205 failed ACKs through the queue and asserts the retry map is bounded and a subset of the last 200 IDs. It also checks retry removal after aged and terminal drops. The focused cap test passed 1/1; replacing the prune helper with the old whole-map copy failed 1/1 with `retry metadata belongs only to queued ids`. |

The later-observed heal rule is only as safe as check's cursor. The separate [same-millisecond inbox cursor task](../../design/2026-09-25-CHECK-CURSOR-MILLISECOND-TASK.md) records a read-edge skip when two microsecond-distinct rows share one JSON millisecond and their UUID order is inverted. This fold does not change the read edge.

### Fold 4 gates

All test commands used a process-group timeout and a temporary `HOME`; the wrapper kills remaining processes in that group. `npm run build`: exit 0. `npm run check:tests`: exit 0. `npm run check:edge`: exit 0. `npm run build:command-core`: exit 0, and the generated bundle diff: exit 0. `bash scripts/build-release.sh`: exit 0, with an explicit loopback `--url` on its artifact check. `npm --prefix site run build`: exit 0, 12 pages.

- `env -u FORCE_COLOR npm test`: exit 1; 967 tests, 965 passed, 2 failed on sandbox `spawn EPERM`.
- `env -u FORCE_COLOR npm --prefix site test`: exit 1; 576 tests, 499 passed, 76 failed, 1 skipped. The browser tests aborted Chrome with `SIGABRT` in this sandbox.
- `env -u FORCE_COLOR npm run test:p1-cli`: exit 1; 939 tests, 936 passed, 3 failed on sandbox `ps`/`spawn EPERM`. The first 240-second run timed out before a complete count; the second bounded run finished with this count.
- `git diff --check origin/main...HEAD`: exit 0 after the fold commits.

The served server tests, box migration and command release, production cursor safety, production lock window, and live behavior remain unestablished. No production host was contacted.

## Lead fold — 2026-09-24 (a3736201 and the next commit)

The lead ran the fold-4 server tests on the reset local stack. Three fixtures could not pass as the Maker wrote them;
`a3736201` fixes them. The Opus round-4 review of `a3736201` (FAIL) found one PRODUCTION and four RIGOUR defects; the
next commit fixes all five. This section supersedes Fold 4's "reasoned, not measured" mutation claims and I2's
redundancy claim.

| Finding | Change | Test and mutation (measured on the reset local stack) |
|---|---|---|
| Fixtures (`a3736201`) | The late-recipient fixtures disable `signal_recipients_same_transaction` inside their rolled-back transaction; the non-ask/note fixture marks its enqueued delivery observed instead of inserting a duplicate row; the functional-proof mutations target the member gate as a `WHERE` clause and assert that they find it once. | `managed-delivery.test.ts` 20/20. A migration whose heal rule compares `enqueued_at` instead of `(created_at, id)` fails only "check order wins ..."; a migration without the later ask/note filter fails only "an observed non-ask/note delivery cannot heal directed mail". The migration was restored (`cmp` equal) and the stack reset again. |
| R4-F1 PRODUCTION | The catalog proof pinned the fold-2 text `later.enqueued_at > d.enqueued_at` and returned `f` on the fold-4 view, so section 5 would stop after the migration. It now requires the release cutoff, the `(created_at, id)` tuple, the later kind filter, and the absence of the old enqueue rule. | New server test runs the proof file on the installed view (`t`) and on three rolled-back view mutations: enqueue-order heal, no later kind filter, no release cutoff (each `f`). Restoring the old proof line fails the test at "catalog proof on installed". |
| R4-F2 RIGOUR | The migration comment and I2 said the release cutoff was redundant. It is load-bearing: a seat that is behind at release can ACK old mail first, and only the cutoff keeps its next old message out. The comment now says so. | New server test: two pre-release asks, cutoff set after both, the older one ACKed observed; the newer one is not eligible and its receipt is not observing. In a rolled-back transaction the view without the cutoff returns exactly that message. A migration without the cutoff was not reset and run (the in-test mutation measures the same predicate). |
| R4-F3 RIGOUR | LANE.md did not record the lead's fixture fix. | This section. |
| R4-F4 RIGOUR | Fixture comments called the late-recipient and non-ask/note rows "historical". Production inverts signal and enqueue order only inside one posting transaction (milliseconds) and cannot hold the non-ask/note row. The comments now say so. | Comment only. The Opus arm answered the brief's question: the rule is not over-constrained, because `(created_at, id)` is `cswarm check`'s own order. |
| R4-F5 RIGOUR | The check-cursor follow-up task named only the same-millisecond skip. It now also names the commit-order skip (reasoned from code by the Opus arm, not measured). | Doc only. |

### Lead fold gates (a3736201; reset local stack)

- `test:p1-server`: 257 tests, 256 pass, 1 fail: "B1 21 brain puts ..." got a 502 from the local edge runtime
  (`file-artifacts.test.ts:534`). That file rerun alone: 21/21. The lane does not touch brain or file code.
- `npm test`: the ten failures are `host-acp-*` timing tests under parallel file runs at load 4-12. The four
  `host-acp-*` files with `--test-concurrency=1` pass 84/84 on the lane and on main `4d4cb3f7`.
- After the R4 fixes: `managed-delivery.test.ts` 22/22. The full gates for the new commit are in its landing record.

Not established: the box migration and command release, the production row count and query cost of the heal join,
the commit-order cursor skip (reasoned only), and live behavior. No production host was contacted.
