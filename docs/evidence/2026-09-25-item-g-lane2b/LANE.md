# Item G lane 2b — maker record

Branch `lane/item-g-lane2b`. This record covers source and isolated local checks. It is not a box, staging, or npm release record. No production host or real workspace was contacted. No migration was applied by this lane. The lead owns the exclusive local-stack server run.

## Decisions, change, test, mutation

| Brief decision | Change | Test | Mutation result |
|---|---|---|---|
| One lease per seat; no credential in it | `20260926000001_agent_wake_leases.sql` stores one `(workspace_id, principal_id)` row with random watcher UUID, display host, session reference, generation and timestamps. The raw table is server-only. `swarm_read.agent_wake_leases` is member scoped and projects host, generation and ages. An agent-token read function returns only the presenting seat's row. | `managed-delivery.test.ts` tests own read, member and nonmember view, no client table privilege. | Lead reset-stack run: managed-delivery 27/27. Member gate, raw-table revoke and exact token-filter mutations remain reasoned. Catalog rollback-only REVOKE mutation was measured and returned false as intended. |
| Claim, stale steal, renew, session fence | Command edge has `claim_wake_lease` and `renew_wake_lease` before reducer validation, after authentication, route and revocation checks. Neither is session-proof exempt. A transactional SQL function serializes per-seat claims, bumps generation on steal, refuses fresh remote holders, and renews only matching watcher/generation. | `managed-delivery.test.ts` tests empty claim, fresh refusal with label/age and no session ref, same-host steal, explicit takeover, stale steal, valid renew, superseded renew and missing managed-session proof. `protocol-workspace.test.ts` inventory proves both kinds stay inside the session fence. | Lead reset-stack run: managed-delivery 27/27. Server branch reversions remain reasoned except the fresh H0 lease mutation below. Protocol inventory's existing undeclared-kind mutation control failed in `npm test`. |
| One H0 or watcher wake surface | Claim checks a fresh `h0_poll_locks` row. H0 poll takes the same advisory transaction lock and refuses a fresh watcher row. Renew also refuses a fresh H0 poll, so a stale watcher cannot revive its lease. | `managed-delivery.test.ts` tests watcher refusal naming `h0_poll`. `h0-poll-ack.test.ts` tests H0 refusal naming `watcher`, then a stale lease allows polling. | Lead reset-stack runs: managed-delivery 27/27 and h0-poll-ack 19/19. Removing the H0 fresh-lease refusal changed its assertion from expected 409 to actual 200. Claim and renew cross-surface reversions remain reasoned. |
| Timer renewal and transport resilience | `WAKE_LEASE_RENEW_MS` is 60 seconds and stale time is three renewals. A timer renews independently of the arrival read loop, including push mode. Transport, 5xx and 429 failures retry with bounded exponential backoff; only typed lease loss stops it. | `wake-lease.test.ts` timer test and real loopback `wake-lease-cli.test.ts` supersession test. | Measured: disabling the timer, treating a generic transport Error as lease loss, or changing the 3× stale factor each changed a 3/3 passing focused run to 2 pass / 1 fail. Removing the CLI's supersession throw changed 4/4 pass to 3 pass / 1 fail. |
| Distinct nonrestartable exit and operator sentence | One constant table maps both lease refusals to exit 76. The sentence names the holder and directs stop there or explicit `--take-over`. H0 poll cannot be overridden by that flag. | `wake-lease.test.ts` and `wake-lease-cli.test.ts` cover refused start, supersession, host, exit and restart warning. | Measured: changing the refusal code to 1 or hiding the holder changed 3/3 pass to 2 pass / 1 fail. |
| Same-host dead predecessor and explicit remote takeover (pre-fold; superseded below) | The prior implementation sent client-asserted `local_lock_held` and used the display hostname. Fold 1 replaces this with a stable private host UUID plus the local lock. | Original local lock and CLI controls. | The original mutations were measured before this fold; they no longer describe the current claim wire shape. |
| Read-only status surfaces | `resume` and `listen status` print host, generation, renewed age and local ownership. Ownership compares the server watcher UUID with a live local lock, not the host label. Copy says renewal does not prove mail observation; only observed ACK does. Roster display is deferred as allowed by the brief. | `resume.test.ts`, `wake-lease-cli.test.ts`, `wake-lease.test.ts`. | Measured: suppressing the resume lease line changed its focused 1/1 pass to 0/1; forcing status ownership true changed 4/4 pass to 3 pass / 1 fail; replacing read generation with zero changed 3/3 pass to 2 pass / 1 fail. |
| Release controls | `deploy/release-proofs/item-g2b/` contains a catalog Boolean and a read-only seeded functional proof. The timeout inventory maps the 15-second command and read budgets and names the command edge's 5-second lock budget. | `managed-delivery.test.ts` tests catalog positive and rollback-only missing privilege, plus functional positive, missing seed and wrong seed. `timeout-table.test.ts` inventory passed 18/18. | Lead reset-stack run measured catalog positive and rollback-only REVOKE (catalog false), plus functional positive, missing seed and wrong seed (nonzero). Other proof mutations remain reasoned. |

## Fold 1

Opus round 1 failed with three production findings. These changes follow rulings N1–N7. No production host or real workspace was contacted, and this lane did not apply a migration. Client mutations below were run with a passing positive control and a reverted source variant under temporary HOME and state directories; every run had a deadline and child cleanup. The lead subsequently ran the changed server files on the exclusive reset stack at c6b02afe; only the specific mutations named as measured below are established.

| Ruling | Change | Test and measured mutation |
|---|---|---|
| N1 | Fold 1 stopped typed session-fence refusals during renew and retried only transport, 5xx and 429. Its shared seat-moved sentence and fixed exit 76 were superseded by Fold 2. | Pure fake edge and real loopback CLI cover `session_conflict`, `session_expired`, `session_retired`, `session_proof_invalid`, `session_proof_missing`. Reverting the typed-code classifier: focused 1/1 pass → 0/1. |
| N2 | SIGINT, SIGTERM and orphan exit 74 release by watcher UUID plus generation with a two-second request timeout; crashes leave the lease. A 0600 state-directory host UUID replaces `local_lock_held` and hostname as the same-host key. The local lock is acquired before claiming; host label remains display-only. | CLI clean stop → immediate restart and crash → same-host restart; server same hostname with different UUIDs must refuse. Removing release: 1/1 → 0/1. Randomizing host UUID on each start: 1/1 → 0/1. Server claim/release mutations remain reasoned. |
| N3 | Token-authenticated unmanaged seats can claim, renew and release. The session fence still guards managed seats. | Loopback CLI proves unmanaged `inbox --notify` claims and renews; server test proves unmanaged token claim, renew, conditional release and immediate restart. Lead measured the managed-only guard mutation on the reset stack: expected 200, actual 403. |
| N4 | Transient start claim failures retry with bounded backoff and one stderr notice; typed refusals still exit. | Loopback 503, 503, success then renew. Removing retry: focused 1/1 → 0/1. |
| N5 | Server test asserts renew is refused while a fresh H0 poll lock exists. Resume fixture records and refuses any command POST, with a direct positive control of that refusal. | Removing resume POST recording: focused 1/1 → 0/1. Removing the SQL renew H0 check would change expected 409 to 200; server mutation remains reasoned. The real resume CLI control is still affected by sandbox `spawn EPERM`. |
| N6 | Edge derives `host_session_ref` from the verified managed-session proof and sends null for unmanaged seats. | Server test compares stored value with the proved session UUID; reverting to client body or null would fail that assertion. Server mutation remains reasoned. |
| N7 | Wake-seat advisory lock uses a two-key namespace with class id `1936142697` and a workspace/principal hash; the agent-name lock now has class id `1936142698` and a workspace/name hash. Distinct fixed first keys make a cross-class collision negligible; a collision only serializes transactions. | Server test checks both definitions and their distinct class/key pairs. Reverting either lock to its old first key would fail a definition assertion; server mutation remains reasoned. |

At c6b02afe, the lead reset the local stack and measured `test:p1-server` 268/268, `npm test` 997/997 and `test:p1-cli` 968/968, all exit 0; every other requested gate exited 0. Restoring the managed-only guard failed the unmanaged-seat claim (expected 200, actual 403). The lead also measured the H0 fresh-lease mutation (expected 409, actual 200), catalog REVOKE and functional positive and negative seed probes.

## Fold 2

Opus round 2 found one production copy/exit defect and four rigour defects. This fold was developed against loopback fixtures and temporary state roots. Managed watchers now need `--session-context <path>` or a profile with a live host session before the claim. A missing or invalid proof at start is a usage error; the corrected command is printed. No production host or real workspace was contacted, and no migration was applied by this lane.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| S1 | A single rule table gives each session code its own sentence and exit. Start proof errors use 64; renewal proof loss uses 76. The notify usage line names `--session-context`. | Pure and loopback CLI tests pin each code, phase, remedy and exit. Replacing the `session_expired` sentence with `session_conflict` text changed 1 pass / 0 fail to 0 pass / 1 fail. Restoring the dispatcher’s fixed 76 likewise failed the start CLI test (expected 64, actual 76). |
| S2 | Signal aborts during claim backoff and an in-flight claim finish through the existing one-line signal stop and exits 143/130. | Loopback CLI controls passed for both points; reverting either the backoff or in-flight signal finish changed its targeted test from 1 pass / 0 fail to 0 pass / 1 fail. |
| S3 | The local lock is keyed by workspace and principal within one state root, across profile IDs. A host UUID is stored with a SHA-256 machine fingerprint; a copied file with a different readable fingerprint rotates the host UUID. If the machine ID is unreadable, the prior file stays and `resume` says it could not verify the host. | Pure lock, copied-ID, and resume tests passed. Reintroducing profile ID in the lock path and ignoring the fingerprint each made their focused tests exit 1. |
| S4 | An invalid, nonprivate or malformed host ID file is replaced with one stderr notice naming its path. | The malformed-content and mode test passed; changing the repair branch to throw made it exit 1. |
| S5 | The server test computes wake and name keys from separate subjects. A pure source control checks separate classes and subject expressions. Copy now calls a hash collision negligible. | Pure source control passed; changing the name lock class to the wake class made it exit 1. The SQL server test awaits the lead's exclusive-stack run. |

The focused positive controls passed: support wake/arrival 39/39, CLI wake lease 11/11, and the isolated resume case 1/1. Each of nine paired probes ran its positive control (1/1), changed one source file, observed 0/1 under the reversion, then restored the source. The probes cover S1 twice, S2 twice, S3 three times, S4 once and S5 once; each child had a deadline. These mutation results establish that the targeted controls can fail; they do not establish hosted behavior.

## Fold 3

At 4509a131 on the reset local stack, the lead measured `test:p1-server` 268/268, `npm test` 1002/1002, and `test:p1-cli` 970/970; all other requested gates exited 0. Round 3 returned Opus PASS with five rigour findings and Grok FAIL with two production findings and one rigour finding. The changes below address rulings T1–T7. A state directory shared across machines is unsupported; each machine needs its own state directory. This lane contacted no production host or real workspace and applied no migration.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| T1 | macOS reads the machine id through `/usr/sbin/ioreg`; Linux reads `/etc/machine-id`. A host-id file with no hash keeps its host UUID when a hash becomes readable and gains the hash. Only a different stored hash rotates the UUID. | Host adoption and absolute-tool tests each passed 1/1; reverting each fix made its test fail 0/1. |
| T2 | `resume` and this record state the separate-state-directory requirement. | The resume and record assertions each passed 1/1; reverting either sentence made its test fail 0/1. |
| T3 | A new watcher holds both the seat lock and the previous release's per-profile lock through its lifetime. | The old-name contention test passed 1/1; omitting acquisition of that lock failed 0/1. |
| T4 | `resume` reads whether the host-id file exists and distinguishes present, missing, and unreadable files when the machine id cannot be read. | The file-presence and missing-file wording tests each passed 1/1; reverting either fix failed 0/1. |
| T5 | The twelve-client-mutation paragraph below is labeled as Fold 1 evidence. | The record assertion passed 1/1; removing the label failed 0/1. |
| T6 | Start proof refusals exit 76 with the supervisor stop clause. The remedy names a supplied context path or tells the operator to obtain the current path from `cswarm session start` output, without a runnable-looking placeholder. | The session-refusal test passed 1/1; restoring exit 64 or the placeholder remedy each failed 0/1. Loopback CLI start refusals passed 5/5. |
| T7 | One constant supplies the supervisor stop clause for every exit-76 lease sentence, including session expiry and renewal proof loss. | The all-rules assertion passed 1/1; removing the central clause failed 0/1. |

Each of the eleven paired probes ran under a temporary HOME and state root with a process-group deadline. The focused support and loopback CLI suite passed 54/54. The full resume test file still has a sandbox `spawn EPERM` failure in its process-table integration case; the focused Fold 3 resume cases passed.

## Fold 2 gates

The Fold 2 full test gates used a temporary HOME and state directory and a process-group timeout. No full gate timed out. The site build's initial attempt could not write Vite cache through the dependency symlink outside the writable worktree; a local dependency copy made the retry pass, and the original symlink was restored. At c6b02afe, before Fold 2, the lead measured `test:p1-server` 268/268, `npm test` 997/997 and `test:p1-cli` 968/968, all exit 0, with every other requested gate exit 0.

| Gate | Exit | Fold 2 count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,002 tests: 1,000 pass, 2 sandbox `ps` `spawn EPERM` failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 970 tests: 967 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. The dispatch baseline and lane controls pass. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with a loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 0 retry | 12 static pages. Direct attempt hit symlink cache `EPERM`; writable dependency copy passed, original symlink restored. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0, checked after the lane commits. |

The loopback command-dispatch baseline contains 1,330 rows: 41 zero-exit and 1,289 nonzero-exit. Fold 2 updates the 337 usage rows for the required `--session-context` option; no outcome count changed. The full baseline rerun is recorded in the final CLI gate below.

Fold 1 client mutations: twelve were run with a positive control and a reverted source variant, then restored. Nine whole-file positive runs passed 3/3 or 4/4 and each mutant failed one test; the resume line was isolated because its full file has an unrelated `ps` sandbox failure, and passed 1/1 before mutation, failed 0/1 after. The two dead-local-lock variants each passed 1/1 before mutation and failed 0/1 after. Lead later measured managed-delivery 27/27, h0-poll-ack 19/19, one H0 fresh-lease mutation, catalog REVOKE and functional positive/negative seed probes. The other server mutations remain reasoned.

## Fold 3 gates

Every full test invocation used a temporary HOME and state directory and a process-group deadline. A first CLI gate attempt reached 219 emitted cases and exceeded its 240-second wrapper deadline while the 1,330-row dispatch baseline was running; the wrapper killed its process group. The rerun allowed 900 seconds and completed. The citation guard initially failed at three `src/cli.ts` line references shifted by this fold; those references were updated and the focused guard passed 1/1. The final full test counts are below.

| Gate | Exit | Fold 3 count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,008 tests: 1,006 pass, 2 sandbox `ps` `spawn EPERM` failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 972 tests: 969 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. The dispatch baseline completed. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with a loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 0 retry | 12 static pages. Direct attempt hit the external dependency symlink's Vite cache `EPERM`; a temporary writable dependency copy passed, and the original symlink was restored. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0, checked after the lane commits. |

## Fold 4

At 0c8f21bc, the lead measured `test:p1-server` 268/268, `npm test` 1008/1008, and `test:p1-cli` 972/972 on the reset local stack; all other gates exited 0. Opus round 4 failed on one measured production remedy; Grok passed with two rigour notes. This fold changes client code, tests, and the timeout citation only. No production host or real workspace was contacted, and no migration was applied by this lane.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| W1 | Fold 4 printed one locally discovered context in a complete watcher command. Its `--profile` branch was dead code because profile expansion removed that flag before the handler. Its `cswarm resume` fallback claimed resume would show a live context path, which it did not at 7007917e. Fold 5 replaces both claims below. | The Fold 4 loopback fixture accepted the printed command. Round 5 measured the fallback and profile defects with the real CLI; Fold 4's passing control did not cover them. |
| W2 | The CLI passes the supplied `--session-context` path through the lease refusal boundary. | A real 0600 context reached the loopback refusal sentence. Omitting that argument at the claim call changed 1/1 pass to 0/1. |
| W3 | `resume` names the arrival-cursor directory holding `host-id` only when the machine id cannot be read, and JSON includes `host_id_file_state`. | The resume tests check the exact directory, relevant-condition gating, and missing/present JSON values. Suppressing the directory line and nulling the JSON field separately each changed 1/1 pass to 0/1. |
| W4 | The machine-id timeout citation points to the two-second `/usr/sbin/ioreg` call. | The citation test reads the cited source line. Restoring the legacy-lock citation changed 1/1 pass to 0/1. |
| W5 | `listen` accepts a running watcher holding either the seat lock or the legacy per-profile lock. | The real CLI test has a no-lock refusal positive control and checks each held lock. Ignoring the legacy lock changed 1/1 pass to 0/1. |

Each mutation invocation ran its positive test against the fixed source, then changed one file, observed the targeted failure, and restored the source. All test processes had deadlines and cleanup.

### Fold 4 gates

The full test gates used temporary HOME, config, and state directories with process-group deadlines. The first full runs exposed two stale copy assertions and shifted citations; focused reruns passed after correction. The final full counts are below.

| Gate | Exit | Fold 4 count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,008 tests: 1,006 pass, 2 sandbox `ps` `spawn EPERM` failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 975 tests: 972 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. The dispatch baseline completed. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both commands exited 0; generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked. |
| `npm --prefix site run build` | 1 direct; 0 retry | Direct build hit the external dependency symlink's Vite cache `EPERM`; a temporary writable dependency copy built 12 pages, and the original symlink was restored. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0, checked after the lane commits. |

## Fold 5

Opus round 5 failed on the fallback remedy after following it through the real CLI. This fold makes resume's local context report and the refusal sentence use the same secure-file and server-live check. A file with local proof fields alone is not called live. The lane contacted only loopback fixtures, used temporary HOME/config/state directories, and made no migration or production change.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| Z1 | `resume` reports the current seat's verified live managed context path in text and `live_session_context_paths` JSON, or explicitly says no live session on this host was verified. If the read service cannot verify a candidate, it says verification is unavailable. The refusal fallback points to that resume output. Resume's watcher advice no longer prints a bare command that omits the context. | A real loopback CLI test follows the refusal into real `resume` text and JSON with no context, a verified context, a stale context, a removed file, and another seat's file. It asserts no watcher command appears in resume. Changing the resume context label made the focused test change 1/1 pass to 0/1. The test supplies a temporary empty `ps` executable because this sandbox refuses the host `ps` spawn. |
| Z2 | The dead `args.optional("profile")` branch is removed. The handler remembers whether the operator used `--profile` before expansion, restricts verified candidates to that profile's host session, and identifies a refused profile context accurately. It never repeats the just-refused profile command. | The real CLI starts through a host-bound profile against a loopback refusal, verifies the host context path is named without a command, then invalidates the server session and verifies the fallback. Forcing the source to say `operator` made the focused test change 1/1 pass to 0/1. |
| Z3 | Refusal copy distinguishes the operator's explicit `--session-context` from the profile's host session context and starts in lower case after a semicolon. The stdin form tells the operator to pipe the same credential on stdin; it prints no incomplete command. A command with `--session-context` is printed only after the secure local file, target, principal, credential file, and server live session id and generation agree. | Real CLI explicit-context, profile, stdin, stale-context, removed-file, and other-seat tests exercise the sentences. The existing printed-command control executes the full command against loopback. Removing the stdin pipe step, bypassing server-live matching, and bypassing seat identity each changed a passing focused 1/1 control to 0/1. |

All five mutations ran a passing focused control before the source change, a failing control under the mutation, and restored the source. Each test had a deadline and cleaned up its child. This fold changes only client code, CLI/pure tests, and this record. It does not establish hosted behavior or run the exclusive server suite.

### Fold 5 gates

The full test commands used a temporary HOME, config, and state root with process-group deadlines. The direct site build could not unlink Vite cache through the dependency symlink outside this worktree; a retry used a temporary writable dependency copy, built 12 pages, and restored the original symlink.

| Gate | Exit | Count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,008 tests: 1,006 pass, 2 sandbox `ps` `spawn EPERM` failures. Citation guard passed after line references were corrected. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 978 tests: 975 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. New refusal, resume, profile, and stdin controls passed. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both commands exited 0; generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 0 retry | 12 static pages with the temporary writable dependency copy. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0 after Fold 5 commits. |

## Fold 6

Grok round 5 found two defects beyond the Fold 5 rulings. This fold uses only temporary local homes and loopback fixtures. It contacts no production host or real workspace and applies no migration.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| AA1 | Context discovery carries the secure file path it read and rejects a document naming another seat. Live-session verification, profile selection, and listener context handling use that path instead of rebuilding a default filename. | The real CLI writes `custom-name.json`, follows the printed refusal command, and observes a second loopback claim from that file. The profile test also uses a non-default filename. Rebuilding the default path in verification changed the targeted control from 1/1 pass to 0/1; it found no verified context. |
| AA2 | Every exit-76 lease sentence places the shared supervisor stop clause before command text, so the CLI error cap cannot remove it. | The real CLI uses a synthetic 1,100-character anon key, reaches the 1,000-character cap, exits 76, and retains the stop clause. Restoring the clause after the long command changed the targeted control from 1/1 pass to 0/1. |

The five-second live-session status read is now inventoried in the timeout table. Its hosted budget is not measured by this lane. The citation guard was updated for four `src/cli.ts` lines shifted by this fold.

### Fold 6 gates

| Gate | Exit | Count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,008 tests: 1,006 pass, 2 sandbox `ps` `spawn EPERM` failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 979 tests: 976 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. Timeout-table file passed 19/19, and both Fold 6 CLI controls passed. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both commands exited 0; generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 0 retry | Direct attempt hit external dependency symlink cache `EPERM`; temporary writable dependency copy built 12 pages, then the original symlink was restored. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0 after the Fold 6 code commits; repeated after this record commit. |

## Fold 7

HezLead requires a reserve SQL rollback before the box window. The lane added `deploy/release-proofs/item-g2b/20260926000001-rollback.sql` and its catalog proof. The migration creates one table, one view, five functions and one policy; it creates no explicit index or trigger and replaces nothing. The table's primary-key index and internal foreign-key triggers disappear with the table. The rollback drops the view and functions before the policy and table, deletes the migration ledger row, then commits only when the included catalog proof is `t`. On `f`, it rolls back and raises an error under `ON_ERROR_STOP`. Its header requires EDGE rollback first and HezLead's decision, and names the write helper. This lane did not apply or roll back the migration.

| Change | Test | Mutation |
|---|---|---|
| Rollback drops all eight named objects created by the migration, with an absence check for each and for the implicit primary-key index and migration ledger row. | `tests/agent-wake-rollback.test.ts` derives the named objects and function signatures from the migration's `CREATE` statements; focused run passed 1/1. It is in the literal `npm test` script. | In the same test invocation, removing each of the eight `DROP` statements in memory makes coverage fail. The lead's local-stack rollback verification is recorded in Fold 8. |

Every gate process had a deadline and used temporary HOME, config and state directories. The full suites' only failed cases are the same sandbox `ps` spawn denials recorded in earlier folds. The first site build could not unlink Vite cache through the dependency symlink outside this worktree. A first retry copied dependencies into `scratchpad/`, where Astro could not resolve two packages from its expected parent path. The final retry used a temporary writable copy at `site/node_modules`, built successfully, and restored the original symlink.

| Gate | Exit | Count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,009 tests: 1,007 pass, 2 sandbox `spawn EPERM` failures. New rollback test passed. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 979 tests: 976 pass, 3 sandbox `ps` / `spawnSync ps EPERM` failures. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both commands exited 0; generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 1 first retry; 0 final retry | Final build generated 12 static pages with a writable local dependency copy; the original symlink was restored. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0 after the Fold 7 code commits; repeated after this record commit. |

## Fold 8

Round 6 returned Opus FAIL and Grok FAIL. This fold finishes the stopped partial edits and addresses EE1–EE9. The loopback tests use temporary HOME and state directories; no production host or real workspace was contacted. Each new test has a deadline. For EE1–EE6 and EE9, its named focused test passed on the fixed source, then failed 0/1 with the relevant source file temporarily replaced by its a5d0f36d version. EE7 and EE8 passed on the fixed source and each failed 0/1 when the lock or refusal-command pipe was removed directly. All source mutations were restored.

| Ruling | Change | Focused test and measured reversion |
|---|---|---|
| EE1 | Sanitize but do not cut a generated `WakeLeaseLostError`; other errors retain the 1,000-character cap. | The real CLI printed an over-1,100-character refusal with its complete exit clause. The test ran the printed command against the loopback edge, which accepted its live session proof. Reverting `src/cli.ts` failed 0/1. |
| EE2 | Multiple verified files have an ambiguity sentence and no restart command. | The real CLI found two files for one live session, printed no command, and `resume` listed both. Reverting `src/cli.ts` failed 0/1. |
| EE3 | `resume --profile` reads and prints verified live context paths and explicit verification state. | The profile watcher refusal led to real profile resume JSON with the expected context line and path. Reverting `src/onboarding-cli.ts` failed 0/1. |
| EE4 (command proof superseded by Fold 10 II4) | Resume reads the seat's managed status even without local context files. An unmanaged seat gets watcher advice; managed seats get context guidance. | The unmanaged real CLI resume test found a command and no context requirement. Round 7 showed that punctuation attached to this command made it fail when pasted; Fold 9 corrects it. Reverting `src/resume.ts` failed 0/1. |
| EE5 | The shared exit-sentence builder lowercases the first word after the supervisor stop clause. | All five real CLI session refusals check the semicolon boundary. Reverting `src/cloud/wake-lease-constants.ts` failed 0/1. |
| EE6 | SIGTERM/SIGINT handlers are installed before the live-context verification read and removed on every return. | Both signals during a delayed loopback read gave 143/130 and exactly one stop sentence, before any lease claim. Reverting `src/cli.ts` failed 0/1. |
| EE7 (lock proof superseded by Fold 10 II2) | Host-id rotation holds a file lock through the read and write, including copied-file replacement. | Concurrent rotations return the persisted ID; the test also holds the lock and verifies a second start waits. Removing the `withFileLock` wrapper failed 0/1. |
| EE8 (copy superseded by Fold 10 II6) | One refusal-command helper added a `cat` placeholder for stdin watchers. The generic signal-stop command also had punctuation attached. Both looked pasteable but could fail when pasted; Fold 9 removes stdin commands and separates the signal-stop command. | Real stdin watchers checked holder, supersession, and all five session refusal kinds. Removing the helper's pipe prefix failed the then-current holder/supersession assertion 0/1. The old signal-stop shell test stripped punctuation before running its command. |
| EE9 | A refused path and verified path are compared after `realpath`, including noncanonical path spelling. | The real CLI recognized the same file and printed no different-context command. Reverting `src/cli.ts` failed 0/1. |

Lead verification of `20260926000001-rollback.sql` at a5d0f36d on the local stack, 2026-09-25 about 08:55Z: a `pg_dump -s -n swarm -n swarm_read` before the migration (migration moved aside, `db:reset`) versus after migration plus rollback had **0 non-restrict diff lines**; the migration ledger row count was **0**. With the catalog proof mutated to fail (`agent_wake_leases IS NOT NULL`), rollback exited **3** and both the table and ledger row remained present. These are the lead's measurements; this lane did not apply a migration or run rollback SQL.

Final Fold 8 gates used a temporary HOME, config and state root. Each gate process had a deadline; the site dependency copy was removed and its original symlink restored after the retry. `test:p1-cli` includes a dispatcher baseline that took about six minutes. The sandbox process-table denials below masked a separate Fold 8 assertion failure. At f13a7b19 the lead ran the gates on the local stack: `npm test` passed 1,008/1,009 and `test:p1-cli` passed 985/986. Both failed only `resume.test.ts:542`: the extra `members` read violated the pinned request list. That was a real behavior failure, not a sandbox denial.

| Gate | Exit | Count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0. |
| `env -u FORCE_COLOR npm test` | 1 | 1,009 tests: 1,007 pass, 2 `spawn EPERM` process-table failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | 986 tests: 983 pass, 3 `ps` / `spawnSync ps EPERM` process-table failures. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0. |
| `npm run check:edge` | 0 | Six edge entry points checked; errors: 0. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file bundle built and execute-checked with loopback `--url`. |
| `npm --prefix site run build` | 1 direct; 0 retry | Direct build hit the external dependency symlink cache `EPERM`; temporary writable dependency copy built 12 pages. |
| `git diff --check origin/main...HEAD` | 0 | Whitespace errors: 0 before this record commit; repeated after it. |

## Fold 9

Round 7 returned Opus FAIL and Grok FAIL. The rule for this fold is that a printed command must run exactly as printed or no command is printed. Tests used a loopback read and command edge, temporary HOME/config/state directories, and `/bin/sh -c` on each tested watcher command line. No production host or real workspace was contacted.

| Ruling | Change | Focused proof and deliberate reversion |
|---|---|---|
| GG1 (restart and command coverage superseded by Fold 10 II1/II4) | `printedCommand` ends prose before a standalone command line. Resume's unmanaged and orphan advice, signal-stop, and lease-refusal advice use it. Resume no longer attaches a period to a workspace id. The human resume digest removes its `<topic>` command placeholder. | The signal-stop shell restart, unmanaged resume shell start, non-stdin takeover shell start, and long proof-remedy shell start each reached the loopback edge. The orphan `kill` line ran through `/bin/sh` and stopped its temporary child. Reverting the helper failed the signal-stop test 0/1; restoring the digest placeholder failed the resume-output test 0/1. |
| GG2 (stdin copy superseded by Fold 10 II6) | A stdin watcher's credential source is unknown, so holder, supersession, and signal-stop output gives a worded retry step with the agent token on stdin and no pasteable command or `<credential-file>` placeholder. File-credential refusals retain a runnable command. | The stdin holder/supersession test finds no command line or placeholder; the non-stdin takeover command claims on loopback through `/bin/sh`. Restoring a stdin command failed the stdin test 0/1. |
| GG3 | The credential-form resume reuses session status from its authenticated first `members` response. The pinned read-resource expectation at `resume.test.ts:542` is unchanged. | A loopback identity-read test counted exactly one `members` request and no second status request. Removing the reused status failed that test 0/1. The pinned real-CLI test is still subject to this sandbox's `ps` denial; the lead's outside-sandbox rerun is needed to prove its unchanged expectation. |
| GG4 (credential faults superseded by Fold 10 II8) | Profile resume treats a missing credential file as an unverifiable context, names the missing path, prints the receive snapshot, and exits 0. Other credential errors still propagate. | A real profile resume with a missing file exited 0 with the named file and `authenticated_now: false`. Removing the missing-file fallback failed 0/1. |
| GG5 (renewal remedy superseded by Fold 10 II3) | The live-context read raises a typed HTTP-status error. Profile resume describes 401/403 as service refusal of an expired or revoked credential and points to its turn check to renew. Other HTTP errors say the service returned an error; only transport failures use the reachable-service wording. | Loopback 401, 403, 503, and dropped-connection cases passed. Removing the typed refusal classification failed the focused test 0/1. No error-message text is used for classification. |
| GG6 (lock creation and stale rules superseded by Fold 10 II2) | The host-id lock records pid, host name, and creation time. A dead pid, foreign host, empty owner, or file older than five minutes is taken over. Five minutes is far above the lock's local file-I/O hold; an empty file gets 100 ms for an in-progress owner write. A live-lock timeout names the host-id rotation lock. | All four stale states recovered in under two seconds; a live lock timed out with the correct name. Reverting the timeout name failed 0/1. Removing the host-id stale policy made the stale test exceed a three-second mutation deadline; its process group was killed and the source restored. |
| GG7 (timeout row superseded by Fold 10 II9) | The five-second session-status row cites `live-session-context.ts:43` and states that live-session verification runs on every resume, with the credential-form result reused and a profile read when a context file exists. The machine-id citation was also shifted to its actual ioreg line after the helper import. | A one-off probe found `timeoutMs: 5_000` at cited line 43 and failed when the citation was reverted to line 36. The existing timeout-table check does not catch a citation that points to the wrong existing line; no new checker was added. |

The Fold 9 `npm test` run passed 1,008/1,010, exit 1. Its two failures were sandbox `spawn EPERM` process-table cases; the added loopback read-count test passed. A later `npm test` run after the orphan test passed 1,008/1,011, exit 1: the same two sandbox denials and one temporarily added `--url` beside `--profile`, which the watcher correctly rejected. That test edit was reverted and its focused case passed 1/1. The first `test:p1-cli` run passed 987/992, exit 1: three `ps` sandbox denials and two shifted source-shape citations, both corrected and passed in a focused rerun. The next run passed 988/992, exit 1: the same three denials and one loopback read transport failure; that read passed 1/1 in isolation. The last full run passed 989/993, exit 1: three `ps` denials and a dispatch-baseline subprocess that lost `tsx` when the shared repository directory disappeared during the run. After installing dependencies locally, the lane-focused suite passed 61/62, exit 1; its only failure was the same sandbox `ps` denial.

| Gate | Exit | Count or observation |
|---|---:|---|
| `npm run build` | 0 | TypeScript errors: 0, including after local dependency recovery. |
| `env -u FORCE_COLOR npm test` | 1 | Latest full run: 1,008/1,011; two sandbox `spawn EPERM` failures and the subsequently fixed profile test edit. Earlier clean-source run: 1,008/1,010 with only the two sandbox failures. |
| `env -u FORCE_COLOR npm run test:p1-cli` | 1 | Latest full run: 989/993; three sandbox `ps` failures and one missing shared `tsx` module. The missing module followed deletion of the shared checkout during the gate. |
| `npm run check:tests` | 0 | Test TypeScript errors: 0, including after local dependency recovery. |
| `npm run check:edge` | 0 | Six edge entry points checked, errors: 0, including after local dependency recovery. |
| `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js` | 0 | Both parts exited 0 before the Git root disappeared; generated protocol diff: 0 files. |
| `bash scripts/build-release.sh` | 0 | Single-file CLI bundle built and execute-checked, including after local dependency recovery. |
| `npm --prefix site run build` | 0 | 12 static pages built before the shared repository disappeared. |
| `git diff --check origin/main...HEAD` | unavailable | The shared Git root and this worktree's admin directory disappeared before this check and the requested commits. |

The host incident interrupted this fold after the measurements above. The surviving source and tests were recovered in commit `897d58fb` on `lane/item-g-lane2b-fold9`, over `68cbd8c9` (the recovered f13a7b19 file tree). The original per-fold Git history is unavailable; the prior patch and archive were rescue artifacts, not release inputs.

Recovery verification on this worktree ran only the requested build, test type check, and lane files. `npm run build` and `npm run check:tests` exited 0. The focused `wake-lease-cli` run passed 25/26; the unrelated transient-claim retry test missed its renew/third-claim timing assertion and failed again when isolated. The seven GG1–GG5 CLI cases passed 6/7 in one run, with the unmanaged shell start missing its three-second claim deadline; that case passed 1/1 when isolated. The five signal-stop and orphan shell cases passed 5/5; the GG3 one-read case passed 1/1; support, host-id rotation, and citation-drift files passed 13/13. A combined lane run was interrupted after timing failures and a pending resume test; it is not a gate result. The unchanged real-resume resource-list case failed before its assertion because the sandbox returned `spawn EPERM`. The focused tests exercised only loopback URLs and temporary HOME/config/state roots. `git diff --check 68cbd8c9..HEAD` found no whitespace errors. No server test or full suite was run during recovery.

The preceding Fold 9 mutation results were measured before the incident and preserved in commit `897d58fb`; recovery reran the fixed-source controls, not the destructive source mutations. The five-second citation points to `timeoutMs: 5_000` at `live-session-context.ts:43`. Fold 15 moved the machine-id `ioreg` line to `arrival-watch.ts:259`; Fold 16 moved it to `:264` and pinned it with a source-line test. Fold 17 moves that citation to `:268`. The earlier `:255`, `:259`, and `:264` references are superseded.

## Fold 10

Round 8 returned Codex FAIL and Opus FAIL. This fold uses temporary homes and a loopback read/command edge only. The listener restart test runs its exact printed line through `/bin/sh`, delays the original listener's stop by 1.2 seconds, observes the replacement in `ready` state, saves its [status JSON](fold10-listener-status.json), then stops it. No model was started by the listener. The prior Fold 8 and Fold 9 rows named above are superseded where their outcome or proof was incomplete.

| Ruling | Change | Test and measured reversion |
|---|---|---|
| II1 (superseded by Fold 11 MM1) | `listen stop --wait` polls until `stopped`, fails with the current state on failure or after 30 seconds, and the resume restart prints one shell line with `--wait` and both `--state-dir` flags. | The detached loopback listener restart passed 1/1 after its slow stop. Removing the wait behavior failed 0/1: the shell's start saw `stopping`. Removing the printed flag failed 0/1. |
| II2 (superseded by Fold 11 MM2–MM4) | Host-id lock creation writes a complete 0600 owner record to a private temp file and links it atomically onto the lock path. The record includes process start time. Incomplete records have a two-second grace; a reused pid is stale; EPERM is held. Timeout names the lock path and the next step. | The atomic owner, concurrent rotation, pid reuse, malformed, EPERM, and timeout tests passed. Replacing atomic link with an empty `wx` lock failed 0/1; disabling pid reuse detection failed 0/1; removing malformed grace failed 0/1; treating EPERM as stale failed 0/1. |
| II3 (superseded by Fold 11 MM5) | Profile resume reads the same lineage successor store as the turn check, falling back to the setup file token. A refused saved credential advises a turn check and setup if renewal fails. | A loopback fixture accepted only the renewed token and answered 401 to the setup token; the profile snapshot found the live context. Returning to the setup token failed 0/1. The 401/403 copy control also passed. |
| II4 (listener branch superseded by Fold 11 MM1) | The H0 holder and unread-inbox printed commands now have shell-execution controls, alongside II1's listener restart control. | All three printed commands reached loopback through `/bin/sh`. Removing the H0 command failed 0/1; adding a bad flag to the inbox command failed 0/1; II1's wait mutation failed as recorded above. |
| II5 | The shared exit-sentence builder removes a terminal prose period before `; exit N`. | Every exit-76 code and phase is checked. Removing the period trim failed 0/1 on `.; exit 76`. |
| II6 (superseded by Fold 11 MM6) | The stdin retry step is generated once by the shared builder; both credential forms use the same supersession step. | The actual CLI stdin refusal and the shared sentence test passed. Restoring the second stdin step failed 0/1 with two steps; removing the shared supersession restart failed 0/1. |
| II7 (superseded by Fold 11 MM7) | The client strips terminal controls and limits the server host label to 120 characters before building a lease error. | A synthetic server response with escape, newline, bidi control, and 500 characters produced a safe bounded error. Removing the sanitizer failed 0/1. |
| II8 | A wrong-agent or unparseable profile credential yields a reasoned, unauthenticated snapshot with exit 0. | Both real profile resume cases passed. Restoring the throw failed 0/1 on wrong-agent with exit 1. |
| II9 | The five-second read row names every watcher start that finds a host context file. | The timeout-row test passed; restoring the prior row failed 0/1. |

The first lane-file run passed 73/75. Its two failures were the sandbox's existing `spawn EPERM` process-table case and seven shifted `src/cli.ts` citation lines; those citations were corrected. The final lane-file run passed 74/76. Its failures were the same sandbox `spawn EPERM` case and an existing watcher fixture's ten-second timeout under concurrent load; that watcher test passed 1/1 when rerun alone. All Fold 10 controls passed in the final run. Focused reversion checks are recorded above.

| Gate | Exit | Result |
|---|---:|---|
| `npm run build` | 0 | TypeScript build passed. |
| `npm run check:tests` | 0 | Test type check passed. |
| Five lane test files with temporary HOME | 1 | 74/76; one sandbox `spawn EPERM`, one concurrent-load timeout that passed 1/1 alone. |
| `git diff --check` | 0 | No whitespace errors. |

## Fold 11

Round 9 Codex and Opus both returned FAIL. This fold addresses MM1–MM8 on the lane worktree at 02646896. The lead's `gates-r10.log` has `npm test` 1016/1016 and `test:p1-cli` 991/1001. Two timeout mapping failures were real; `runTable` was blocked by the same mapping mismatch. The dispatcher baseline difference was an **intended printed-text change**: the `listen stop` help line gained `[--state-dir <path>] [--wait]`. The regenerated fixture changes that line in exactly **337 of 1,330 rows**; [fold11-dispatch-entries.txt](fold11-dispatch-entries.txt) names every changed entry. The dispatcher baseline passed 2/2 after regeneration. The other eight lead gate failures include loopback failures under host load; this lane did not establish that each is environmental.

| Ruling | Change | Control and measured reversion |
|---|---|---|
| MM1 (superseded by Fold 12 PP1/PP3) | `stop --wait` starts one 30-second deadline and the timeout names state and PID. The Fold 11 loop could mistake a slow control reply for socket closure and rewrite a live `stopping` status to `failed`; its PID check did not detect reuse. | The printed restart passed 3/3 with dead sentinel PIDs. That control did not reach the live-PID wait or deadline paths. Restoring the prior failed-state rejection failed the dead branch 0/1. |
| MM2 (superseded by Fold 12 PP2/PP3) | Host-id stale reclaim uses a unique rename behind an exclusive reclaim gate. Fold 11 left a crashed gate behind and skipped the deadline while waiting on one. | Two stale-lock contenders returned the one persisted host ID. The recorded unlink reversion failed only a source-text assertion; its behavioral half still passed. Fold 12 replaces that assertion. |
| MM3 (control superseded by Fold 12 PP3) | The `ps` start-time probe fixes `LC_ALL=C`, and host-id lock timeout names owner PID. | The Fold 11 ps runner returned canned output for a spawned child. Removing `LC_ALL=C` failed that injected-runner control 0/1. Actual `/bin/ps` execution was denied by this sandbox. |
| MM4 | Unsupported `link` errors use exclusive final-path create, write and fsync. A retransmitted `EEXIST` compares the complete record. Dead-PID temp files are cleared while holding the lock. | Injected EPERM, ENOTSUP, ENOSYS, EXDEV and retransmitted EEXIST all passed, as did temp cleanup. Removing EPERM fallback failed 0/1. |
| MM5 (scope superseded by Fold 13 UU1) | All successor-store reads used the read-only path, including renewal readers. Resume handled invalid records with a reasoned snapshot and exit 0. | Malformed record, absent directory, unchanged bytes and mode passed for resume. The control did not exercise renewal's read-error degradation. |
| MM6 | Supersession tells both credential forms to stop this watcher and use the surface holding the lease. | Shared sentence and real CLI controls passed. Restoring “start it again” failed 0/1. |
| MM7 (expanded by Fold 12 PP5) | Human and JSON `listen status` host labels use the lease-error sanitizer, including C1 and bidi removal. Resume still emitted its JSON host label raw. | Loopback status controls passed. Restoring the raw listen-status JSON label failed 0/1. |
| MM8 (corrected by Fold 12 PP4) | The HEAD mapping had both CLI timers but paired the 100 ms stop poll with the hook description and the 250 ms hook timer with the stop description. It omitted the 30-second stop bound. The dispatcher fixture records the intended help line above. | The exact-inventory table passed 19/19 because it checked IDs, not the paired meanings. Removing a timer row failed inventory 0/1; the swapped meanings were not covered. The dispatcher fixture passed 2/2 after regeneration. |

The final six lane files passed 101/102. The one failure was the known sandbox `spawn EPERM` case in the read-only resume process-table control. The dispatcher baseline passed 2/2 separately, the build and test type check exited 0, and the timeout table passed 19/19. This lane did not run the full CLI or service-free suites; the lead owns those gates.

## Fold 12

Round 10 Opus returned FAIL at b4919452. The lead reported green gates there: `npm test` 1018/1018 and `test:p1-cli` 1008/1008. This fold addresses the six rulings without contacting a production host or applying a migration.

| Ruling | Change | Behavioral control and measured reversion |
|---|---|---|
| PP1 (superseded by Fold 13 UU2/UU5) | `stop --wait` reads the stored status without calling the mutating fallback. A timed-out control query stays unknown. Completion requires refused socket connection and the recorded PID's absence or start-time mismatch; a recorded `stopped` state returns immediately. The one deadline reports state and PID. | A real child and a 300 ms control reply kept `stopping` unchanged until both socket and child exited. A live stuck child reached the bounded timeout with its PID and unchanged status. A simulated reused PID returned while that child lived. Restoring the mutating fallback failed 0/1 (`failed` instead of `stopping`); disabling start-time comparison failed 0/1 on the reused PID. |
| PP2 (superseded by Fold 13 UU3/UU4) | The reclaim gate was a directory created before its owner record was written. A live gate obeyed the caller's deadline; a dead owner's gate was moved away and removed. | The earlier dead-owner test passed, but round 11 found incomplete and foreign gates that blocked later starts and a race that could remove a replacement owner. |
| PP3 (gate and ps controls superseded by Fold 13 UU4/UU6) | The wait controls use live children. Stale takeover has a hook after the stale decision. The ps test invoked real `/bin/ps` but compared its result with another parse of the same output. | The earlier publication-race control passed. `/bin/ps` returned sandbox `EPERM` here, so the real-time comparison remained unmeasured. |
| PP4 | The HEAD timer mapping pairs the 100 ms stop poll with occurrence 1 and the 250 ms hook stdin timer with occurrence 2. `LISTENER_STOP_WAIT_TIMEOUT_MS` adds the 30-second bound. | The enumerated values and mapped operations are asserted together. Swapping the operation names failed 0/1; the timeout-table file passed 19/19. |
| PP5 | Resume human and JSON lease labels both call `sanitizeWakeHostLabel`; its separate host-label use of `safeText` is gone. | A C1, bidi, CSI and overlength label becomes the same bounded value in both outputs. Restoring raw JSON failed 0/1 (311 characters instead of 120). |
| PP6 (reverted by Fold 13 UU1) | Resume alone selected the read-only successor-store reader, but renewal reads changed an owned 0755 directory to 0700 and surfaced malformed records. | The directory repair and fail-closed control pinned regressions. Opus corrected its round-10 R6 premise: main's `readSecureJsonFile` **never repaired an existing directory**. `existingSecureDirectory` rejected every existing mode except 0700 before `secureDirectory` could chmod a newly created directory. Main's renewal readers swallowed read errors and degraded when the store was unusable. |

`npm run build` and `npm run check:tests` exited 0. The four lane files with a temporary HOME ran 95 tests: 93 passed, one skipped because this sandbox denies `/bin/ps`, and one pre-existing read-only resume process-table control failed because the sandbox denies `spawn` with `EPERM`. The timeout-table file passed 19/19 separately. No full suite was run on this fold.

## Fold 13

Round 11 Codex and Opus both returned FAIL at b903d100. The lead's Fold 12 gates measured `npm test` 1020/1021 and `test:p1-cli` 1013/1015. The failures were the renewal degradation regression and seven drifted citations. This fold uses only temporary homes, temporary state directories and loopback fixtures.

| Ruling | Change | Focused control and measured reversion |
|---|---|---|
| UU1 | Restored main's `readSecureJsonFile` body byte for byte. Existing 0755 directories are rejected without chmod. Restored the three renewal `.catch(() => null)` reads and `agentSession`'s locked read and no-renewal degradation. Resume retains its read-only reader. | Direct secure-read mode control, renewal mode/degradation control, and the lead's previously failing stdin signal degradation control passed. Replacing the secure read with chmod failed 0/1 (no expected rejection). |
| UU2 | On refused socket plus gone PID, `stop --wait` returns the same `failed`/`unclean_exit` derivation used by effective status, without writing it. | Real printed restart after crash and during stop printed `Listener failed` and `CONNECTED: no` for the stop step, then started a new loopback listener. Stored status stayed `stopping` in the direct control. Returning the stored record failed 0/1 (`stopping` instead of `failed`). |
| UU3 (crash control superseded by Fold 14 XX6) | Build the reclaim gate in a private temp directory, fsync its complete owner file, and rename the directory into place. Empty, partial, and foreign-host gates have a two-second grace before reclaim. Gate timeout names the recorded owner PID. | The injected thrown-error control did not model a killed process. Fold 14 uses SIGKILL and verifies cleanup. |
| UU4 (gate contention control superseded by Fold 14 XX3) | After renaming a stale gate to a unique path, compare the moved owner with the observed owner before removal. Release also moves and checks the ownerId before deleting its own gate. | Injected replacement retained the new owner. Fold 14 adds three live contenders and an in-place check. The brief move-away window on a stale decision remains a residual. |
| UU5 (recording control superseded by Fold 14 XX7) | Status records the PID's process start separately from supervisor `startedAt`; wait compares that start with the PID probe. EPERM remains alive unless the independent start probe proves reuse. Socket and ps timeouts use the same remaining deadline. | A real child more than two seconds older than supervisor startup stayed live until the true state/PID timeout; the `ps` value in that test was injected. Replacing the comparison with supervisor `startedAt` failed 0/1. Fold 14 controls the supervisor's recorded value. |
| UU6 (real `ps` result established in lead's Fold 13 gate) | The real `/bin/ps` control compares parsed PID start with the timestamp taken before spawning the child, within two seconds. | The lane sandbox skipped it, but the lead's gate at 80a6915f ran and passed the real `/bin/ps` child probe (`gates-r13.log:1674`, skipped 0). The Fold 14 supervisor-recording probe is separate. |
| UU7 | Updated the four shifted import citations; the three executable-path citations retained their current lines after restoring `agentSession`. | Citation-drift passed. Restoring one old line failed 0/1 with a reported drift. |

Codex finding 3 is **ruled not a defect**. The anon key in a printed command is the published public key. Agent tokens do not appear on argv or in printed commands by design. No credential exposure change was made for that finding.

The focused final lane run passed 18/19 with one skip (`/bin/ps` denied by sandbox), zero failures. A broader lane-file run before the final output assertion correction passed 107/111, skipped one real-ps control, and failed two new assertions that included the replacement listener's valid `CONNECTED: yes` output plus the existing read-only resume `spawn EPERM` sandbox case. The two output assertions were corrected and passed in the focused rerun. `npm run build` and `npm run check:tests` exited 0 after the implementation. No full suite, server test, box operation, migration, or release was run.

## Fold 14

Round 12 Codex found the watcher lock's empty-file publication race. Opus found six residuals and a false timeout-table inventory; the lead's Fold 13 gate at 80a6915f measured `npm test` 1023/1023 and `test:p1-cli` 1020/1023. The three failures share the missing `storage.ts:timeoutMs#2` and stale `storage.ts:timeout` mapping. That lead run also passed the real child `/bin/ps` probe, correcting Fold 13's stale “not established” claim. The earlier Fold 12 gates were run and red; they are not pending.

| Ruling | Change | Focused control and measured reversion |
|---|---|---|
| XX1 (takeover superseded by Fold 15 AC1) | Seat and legacy watcher locks use the same complete-record publisher as the host-id lock. It fsyncs a private 0600 file, then publishes by hard link or an atomic symlink fallback. A young incomplete legacy record gets a two-second grace. | Both lock paths stayed absent while a writer was paused; exactly one contender acquired. Restoring an empty exclusive file before the injected pause failed 0/1. |
| XX2 | Replaced the stale storage timeout row with `timeoutMs` and `timeoutMs#2`; corrected the two CLI timer citations and shifted source citations. | The three timeout-table tests passed. Restoring the stale mapping key failed 0/1 with exactly the lead's missing/stale pair. |
| XX3 (incomplete-gate decision superseded by Fold 15 AC2) | A contender reads a live gate at its path. A changed owner gets one retry under the caller's deadline; remaining failures name the gate path and the recovery step. | Three contenders left a live gate's inode, bytes, and path intact. Treating a complete live owner as abandoned failed 0/1: all three entered the protected work. A transient release-owner change recovered on retry; removing that retry failed 0/1. A replacement-owner race waits to a path-specific timeout. A stale gate still has a short move-away window before its moved owner can be checked; a displaced `.stale` or `.done` directory is cleaned after its mover dies. |
| XX4 (superseded by Fold 16 AF1) | Fold 14 checked PID start after EPERM and reclaimed an uninspectable owner after 60 seconds. That age policy could remove a live owner; Fold 16 preserves an owner whose PID is live or cannot be inspected. | The historical aged-owner mutation results describe Fold 14 only. Fold 16's live-owner controls replace them. |
| XX5 | Gate timeout calls the path a reclaim gate directory and gives `rm -r -- '<path>'` after verifying the owner is gone. | Sentence test passed; replacing recursive removal with plain `rm` failed 0/1. |
| XX6 | Dead-PID temp cleanup includes `.reclaim.<pid>.<hex>.tmp` directories and stranded `.stale`/`.done` directories. | A real child was killed with SIGKILL while its complete gate sat in a private temp directory. The next lock holder removed that directory. Reverting the `.reclaim.` match failed 0/1. |
| XX7 | Added a supervisor status control against real `/bin/ps` where available, with a deterministic process-age assertion before the probe. | Replacing the supervisor's recorded process start with `Date.now()` failed 0/1. The real `ps` portion skipped here on sandbox EPERM; it awaits the lead's unrestricted gate. |

`npm run build` and `npm run check:tests` passed. The watcher, host-id, and timeout-table lane files ran 77 tests: 75 passed, 2 real-`ps` cases skipped, 0 failed. The wake-lease and resume lane files ran 68 tests: 67 passed, 1 pre-existing real resume CLI control failed here at sandbox `spawn EPERM`. No full suite was run by this lane.

## Fold 15

Round 13 Codex found one production takeover race and three rigour defects; Opus found the same race plus gate replacement and citation defects. This fold changes only those six rulings. No production host, real workspace, database, or release surface was contacted.

| Ruling | Change | Behavioral test and measured reversion |
|---|---|---|
| AC1 (superseded by Fold 16 AF1) | Fold 15 serialized seat and legacy watcher takeover with a per-path gate. Fold 16 moves all file-lock removal through the shared moved-owner check. | Fold 15's two-takeover, changed-owner, incomplete-file and killed-temp controls passed as recorded. Fold 16 adds live-owner and symlink controls. |
| AC2 (superseded by Fold 16 AF7) | Fold 15 re-statted only the incomplete-gate branch and compared device and inode. | Its incomplete-gate replacement control passed. Fold 16 checks complete and incomplete owners, including the record id and timestamps. |
| AC3 (superseded by Fold 16 AF1/AF7) | Fold 15 used directory ctime for a newly published gate's uninspectable-owner age, but other lock paths still aged from earlier timestamps. | Its fresh-gate timestamp control passed. Fold 16 protects live and uninspectable PIDs beyond 60 seconds and uses publication metadata for incomplete gates. |
| AC4 (extended by Fold 16 AF1/AF9) | Fold 15 made `withFileLock` publish a complete record for every general caller, including credential refresh. It did not change its path-based age-out and release removals or clean every killed publisher's temp. | The paused-writer control passed. Fold 16 adds moved-owner removal and dead-PID temp cleanup for every caller. |
| AC5 (superseded by Fold 16 AF4/AF8) | Fold 15 added four sentence variants, but its CLI selected “this watcher” from a stored generation before release. Its other-surface branch was unreachable at the stop sentence, and an aborted in-flight claim could be called unclaimed. | The copy-only mutation passed; it did not reach the CLI's other-surface selection. The focused resume 2/2 below excluded the idle-watcher SIGINT/SIGTERM cases. |
| AC6 (superseded by Fold 16 AF2) | Fold 15 cited `cli.ts:5011-5017`, `wake-lease.ts:60,63`, and `arrival-watch.ts:259`. The following CLI changes moved those lines. | The Fold 15 citation control passed at its SHA; Fold 16 repins the current source lines and adds HEAD mapping checks. |

The six Fold 15 mutation probes each ran one focused test with temporary HOME and returned exit 1; the fixed controls returned exit 0. At b68ef319, the lead measured `npm test` 1026/1029 and `test:p1-cli` 1028/1032. The red cases included citation drift, both idle-watcher signal tests, and the transient-claim retry test. Fold 15's focused resume 2/2 did not run those idle-watcher tests. Fold 14's XX1 and XX3 claims were superseded by AC1–AC2; XX4 is superseded by Fold 16 AF1.

## Fold 16

Round 14 found the credential age-out production race and the remaining lock, copy, citation, and test gaps. This fold changes local client code and evidence only. No production host, real workspace, database, migration, or release surface was contacted.

`src/cloud/storage.ts` is the single lock implementation for this lane. `withFileLock` uses it for the host-id lock, credential lock, and `watch-takeover-*` lock; it also creates and removes their `.reclaim` gates. `arrival-watch.ts` calls the same module's complete-record publisher and moved-owner removal for both the seat and legacy lock. The lock-site inventory is six: host-id rotation, seat watcher, legacy watcher, credential refresh, watcher takeover gate, and reclaim gate. The file-lock, watcher, and gate tests cover two contenders on a dead owner and an intact self-PID record after a simulated 61 seconds. A live or uninspectable PID is preserved; a confirmed dead PID or a mismatched PID start can be reclaimed. Incomplete gate grace uses directory ctime; incomplete host-id lock grace uses the published path's mtime, including the symlink fallback. General lock age uses the published path's ctime. The old “uninspectable owner expires at 60 seconds” rule is superseded.

| Ruling | Change | Behavioral control and measured reversion |
|---|---|---|
| AF1 | File-lock age-out, stale takeover, normal release, exit-hook release, watcher takeover and watcher release move the path before checking the moved owner. Complete records publish atomically. The active symlink target is retained until the lock is moved. | Host/credential/takeover locks, seat/legacy locks, and host/takeover reclaim gates serialize dead-owner contenders and retain aged self-PID records. Reverting moved-owner removal or restoring a plain age-based unlink each changed a focused pass to exit 1. |
| AF2 | Citation pins now resolve to `cli.ts:6581`, `:6607`, `:7229`; HEAD timeout rows resolve to `cli.ts:7504`, `:8294`, `:5020-5025`, `storage.ts:589`, and `arrival-watch.ts:264`. The timeout-table test checks the first three HEAD rows against source tokens. | Citation-drift and timeout-table controls passed. Restoring an old CLI citation or the old HEAD timer row each changed a focused pass to exit 1. |
| AF3 | Idle-watcher signal tests expect the last-known state after a successful claim whose fake release does not confirm deletion. The transient-claim retry test allows its two backoffs and watcher startup to finish. | SIGINT/SIGTERM idle-watcher and transient retry controls passed. Reverting claimed state or transient retry each failed a focused control. |
| AF4 (corrected by Fold 17 AM1) | The CLI records claim, renewal-loss and release observations. It prints “nothing is watching” only after `released: true`; a failed or `released: false` response preserves the last-known-holder warning. The edge answers a superseded release with `released: false`, while a managed-seat session fence can refuse release. | The Fold 16 release-409 fixtures modeled a response the edge does not send for takeover. Fold 17 replaces them with `released: false` and session-refusal controls. |
| AF5 | Dead-PID cleanup skips a live lock symlink's target. An ownerless timeout gives the exact `rm -- '<path>'` step; the wait-for-owner step appears only when the PID probe finds a live owner. | A real killed publisher left a symlink target intact until takeover; an ownerless timeout named its path and removal step. Deleting the target early or restoring the false wait sentence each failed a focused control. |
| AF6 | One `fileLockTimeoutSentence` builder names the actual lock or gate, path, PID evidence and removal step. The credential phrase is reserved for the credential key. | Six lock/gate kinds passed one builder test; restoring the generic credential phrase failed it. |
| AF7 | Gate comparison reads the initial owner, re-stats in both branches, and compares device, inode, ctime, mtime, bytes and owner id before stale removal. | Complete directory replacement and same-inode owner-id replacement stayed intact. Removing the owner-id comparison failed the latter control. |
| AF8 | An abort during an in-flight claim reports an unknown claim result and its possible three-minute lease. | Loopback SIGINT claim test passed; reverting to “had not claimed” failed it. |
| AF9 | Dead-PID private-temp cleanup runs after every `withFileLock` acquire. | A real SIGKILLed general-lock publisher left `.tmp`; the next acquisition removed it. Restricting cleanup to host-id locks failed the control. |

AC4 changed all 21 `withFileLock` call sites, not just credential refresh. Enumerated from `src/cloud/` and `src/listener/` at this fold: `arrival-watch.ts` 2 (host-id, watch-takeover); `storage.ts` 1 (credential store); `agent-credential.ts` 1 (successor); `agent-receive.ts` 3 (receive and hook); `agent-channel.ts` 1 (channel start); `agent-profile.ts` 1 (setup); `agent-check.ts` 3 (turn check and deferred cursor); `delivery-journal.ts` 2; `hook.ts` 4 (surface and global state); `brain-digest.ts` 1; `main-routing.ts` 2. These sum to 21. Every call now gets complete publication, moved-owner removal, and next-acquire dead-temp cleanup. Added fsync and publication latency on the turn-check path has not been measured.

Fourteen paired focused mutations passed their fixed control and failed after one reversion (exit 1), then restored the source: AF1 two, AF2 two, AF3 two, AF4 two, AF5 two, and one each for AF6–AF9. Each used a temporary HOME and a test-level timeout. The lead owns the full gates.

Final scoped verification: `npm run build` and `npm run check:tests` exited 0, and `git diff --check` found no whitespace errors. The seven lane test files ran 170 cases: 167 passed, 2 real-`ps` cases skipped because this sandbox denies `/bin/ps`, and the existing read-only resume CLI control failed at sandbox `spawn EPERM`. Specifically, host-id rotation passed 28/30 with two skips; arrival-watch 44/44; wake-lease CLI 35/35; resume 33/34; arrival-notify 2/2; citation-drift 4/4; timeout-table 21/21. The transient claim retry and both idle-watcher signal tests passed. No full suite was run.

## Not established

- Fold 16's full service-free, CLI, server, edge, site and release gates await the lead. At b68ef319 the lead measured `npm test` 1026/1029 and `test:p1-cli` 1028/1032. This lane did not run a full suite. The supervisor-versus-real-`ps` control is not measured outside this sandbox yet.
- This sandbox's existing real resume CLI control fails at `spawn EPERM`. No claim about its behavior on an unrestricted runner follows from that failure.
- The stale-gate move-away window after a stale decision remains. The owner comparison prevents deleting a changed gate, and the bounded retry gives a recovery step; this lane does not claim a proof of exclusion for every interleaving.
- Staging renew-call p50/p95, production behavior, box migration, edge release, npm publication and site release were not measured. The host-contact rule bars staging access here; HezLead and Anvil own the later box window.
- `pgrep` cannot access `sysmond` in this sandbox, so host-wide process absence is not established. Each new child test kills and awaits its child in cleanup.

## Fold 17

The lead verified round-15 Opus F1–F3 at `4f940979` and ruled them blocking. This fold changes only those findings, the two cited timeout rows, the Fold 16 evidence claims, and their controls. The lead's baseline at `4f940979` was `npm test` 1031/1031, `test:p1-cli` 1040/1040, and a clean wrapper-home check. No production host, real workspace, database, migration, or release surface was contacted here.

| Ruling | Change | Control and measured reversion |
|---|---|---|
| AM1 | A typed session refusal now has its own stop state and retains the refusal's existing next step. Only holder and supersession codes select watcher or H0 state. Release fixtures now use edge-shaped `released: false` and session refusals. | The loopback release test passed; restoring the old surface assignment failed it with “another watcher holds this inbox” (exit 1). |
| AM2 | Every transient claim failure leaves the claim result unknown, including no status, 429 and 5xx. The stop sentence tells the operator to check the seat's wake lease. | A 15-second claim timeout followed by SIGTERM passed; restoring `unclaimed` failed with “had not claimed” (exit 1). The 503 backoff test also expects unknown. |
| AM3 | General locks publish process start time. An aged foreign-host record and a reused local PID can be reclaimed; a matching live local owner stays. Turn-check lock timeout retains the lock path, owner PID and host, and exact removal command. | The general-lock test passed; restoring foreign-host protection and removing PID-start comparison each failed it (exit 1). The turn-check timeout test passed; restoring the generic retry sentence failed it (exit 1). |
| AM4 | HEAD timeout citations now point to `storage.ts:488` for `pidStartMs` and `:33,590-591` for `LOCK_TIMEOUT_MS`; the release, machine-id and shifted CLI timer citations also follow their moved lines. | The timeout-table source-token test passed; reverting either storage citation separately failed it (exit 1). |
| AM5 | Fold 16 evidence now says a superseded release returns `released: false`, distinguishes host-id mtime from general-lock ctime, and identifies the aged-live controls as self-PID records. | The Fold 16 evidence control passed; restoring the release-409 claim failed it (exit 1). AM1 and AM3 provide the corresponding behavioral controls. |

Verification used temporary HOME for each lane test invocation. Seven complete lane files passed on the final sources: wake-lease CLI 36/36, host-id rotation 29 passed with two real-`ps` skips, check-budget 12/12, timeout-table 21/21, citation-drift 5/5, arrival-watch 44/44, and arrival-notify 2/2. Three focused resume sentence tests passed. An earlier combined parallel run produced timing failures under load; a first complete wake-lease run had one 12-second timeout, and its isolated case plus the complete rerun passed. `npm run build`, `npm run check:tests`, and `git diff --check` passed. No full suite ran in this lane.

The lead still owns the full service-free, CLI, server, edge, site and release gates at the Fold 17 SHA. Real `/bin/ps` controls and host-wide process absence are not established in this sandbox. The non-blocking round-14 and round-15 findings are inventoried in `FOLLOW-UPS.md`.

## Fold 18

Round 16 Codex and Opus found the same production regression in general-lock reclamation. The lead ruled AO1 blocking and placed Opus R2–R7 and Codex's non-blocking text in `FOLLOW-UPS.md`. This fold changes the general-lock owner decision, its tests, and citations moved by that change. No production host, real workspace, database, migration, or release surface was contacted.

| Ruling | Change | Behavioral test and measured reversion |
|---|---|---|
| AO1: reused main-format PID | A same-host PID whose process start is more than two seconds after `createdAt` is stale at once, even without `startTime`. | A main-format record with a live reused PID was reclaimed. Restoring Fold 17's `startTime` decision made the focused test time out (pass 1/1 to fail 1/1). |
| AO1: live owner | A process that started no later than `createdAt + 2_000` retains its general lock regardless of publication age or the optional `startTime`. | An aged current-process record with an unrelated earlier `startTime` remained; the Fold 17 decision removed it (pass 1/1 to fail 1/1). |
| AO1: EPERM | `EPERM` still probes PID start and applies the same creation-time rule. | Injected `EPERM` for PID 1 and a deterministic start lookup: the reused record was reclaimed and the live record retained. Restoring Fold 17's EPERM branch failed this test (pass 1/1 to fail 1/1). |
| AO1: unreadable or missing time | An unreadable PID start or nonnumeric `createdAt` falls back to the general lock's 60-second publication bound. | A pure decision control kept the record at 59,999 ms and reclaimed it at 60,000 ms; replacing the fallback with indefinite retention failed it (pass 1/1 to fail 1/1). |
| AO1: incomplete record | A parsed `null` general-lock record also follows publication age. | A fresh `null` record was kept and an aged one reclaimed; removing the guard failed with a TypeError (pass 1/1 to fail 1/1). |

General-lock removal still uses the shared reclaim gate and rename-then-verify path. The optional `startTime` is still published but no longer decides general-lock staleness. HEAD timeout-table citations for `pidStartMs` and the two lock-timeout rows were moved with `storage.ts`.

The complete `host-id-rotation.test.ts` lane file passed 34/36 with two real-`/bin/ps` cases skipped by this sandbox. `npm run build` and `npm run check:tests` passed. Citation-drift and timeout-table lane files were rerun after the moved-line edits. Every test invocation used a temporary HOME and a test-level timeout. No full suite ran in this lane.

The lead still owns full service-free, CLI, server, edge, site, and release gates for this SHA. Real `/bin/ps` behavior for another PID, host-wide process absence, and production behavior are not established here.

## Fold 19

Round 17 Codex found an unreadable general-lock record that remained stuck after its 60-second publication bound. The lead verified this lane-introduced production regression as AR2 and limited this fold to that ruling, its tests, moved citations, and the non-blocking review inventory in `FOLLOW-UPS.md`. No production host, real workspace, database, migration, or release surface was contacted.

| Ruling | Change | Behavioral test and measured reversion |
|---|---|---|
| AR2: unreadable lock record | A failed record read now reaches the age decision. At the bound, the existing reclaim gate moves the entry and verifies its `lstat` device and inode, plus its target if it is a symlink. An unreadable directory at the lock path can be removed after the move. | A directory with an orphaned child, a symlink to a directory, and a mode-000 file where the runner cannot read it remain below 60 seconds and yield at the bound. On `a353ee53`, the focused test timed out at the bound (0/1); on Fold 19 it passed (1/1). |
| AR2: changed owner during takeover | A moved unreadable entry that has become readable is restored and never removed, even when it retains its inode. | The pre-rename hook changes an unreadable directory, and a mode-000 file where supported, into a readable live record. On `a353ee53`, the hook was never reached (0/1); on Fold 19 it ran and the live record survived (1/1). |

`npm run build`, `npm run check:tests`, and `git diff --check` passed. The complete `host-id-rotation.test.ts` lane file passed 36/38 with two real-`/bin/ps` cases skipped by this sandbox. `citation-drift.test.ts` passed 5/5. HEAD storage timeout citations moved with the source and `timeout-table.test.ts` passed 21/21 after repinning. Every lane test used a temporary HOME and each test has a timeout. No full suite ran in this lane.

The lead still owns the full service-free, CLI, server, edge, site, and release gates for the Fold 19 SHA. Real `/bin/ps` behavior for another PID, host-wide process absence, and production behavior are not established here.
