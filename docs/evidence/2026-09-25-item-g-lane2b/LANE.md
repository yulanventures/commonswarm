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
| EE4 | Resume reads the seat's managed status even without local context files. An unmanaged seat gets its watcher command; managed seats get context guidance. | The unmanaged real CLI resume test found a watcher command and no context requirement. Reverting `src/resume.ts` failed 0/1. |
| EE5 | The shared exit-sentence builder lowercases the first word after the supervisor stop clause. | All five real CLI session refusals check the semicolon boundary. Reverting `src/cloud/wake-lease-constants.ts` failed 0/1. |
| EE6 | SIGTERM/SIGINT handlers are installed before the live-context verification read and removed on every return. | Both signals during a delayed loopback read gave 143/130 and exactly one stop sentence, before any lease claim. Reverting `src/cli.ts` failed 0/1. |
| EE7 | Host-id rotation holds a file lock through the read and write, including copied-file replacement. | Concurrent rotations return the persisted ID; the test also holds the lock and verifies a second start waits. Removing the `withFileLock` wrapper failed 0/1. |
| EE8 | One refusal-command helper adds `cat '<credential-file>' \|` for stdin watchers; the generic signal-stop command remains directly runnable with its existing stdin instruction. Refusals without a command still name the pipe step. | Real stdin watchers check holder, supersession, and all five session refusal kinds. Removing the helper's pipe prefix failed the holder/supersession case 0/1. The existing signal-stop shell restart test also passed after the helper was narrowed. |
| EE9 | A refused path and verified path are compared after `realpath`, including noncanonical path spelling. | The real CLI recognized the same file and printed no different-context command. Reverting `src/cli.ts` failed 0/1. |

Lead verification of `20260926000001-rollback.sql` at a5d0f36d on the local stack, 2026-09-25 about 08:55Z: a `pg_dump -s -n swarm -n swarm_read` before the migration (migration moved aside, `db:reset`) versus after migration plus rollback had **0 non-restrict diff lines**; the migration ledger row count was **0**. With the catalog proof mutated to fail (`agent_wake_leases IS NOT NULL`), rollback exited **3** and both the table and ledger row remained present. These are the lead's measurements; this lane did not apply a migration or run rollback SQL.

Final Fold 8 gates used a temporary HOME, config and state root. Each gate process had a deadline; the site dependency copy was removed and its original symlink restored after the retry. `test:p1-cli` includes a dispatcher baseline that took about six minutes. Both test-gate failures below are process-table sandbox denials, not assertion failures in Fold 8 behavior.

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

## Not established

- The lead measured `test:p1-server` 268/268 at 0c8f21bc on the reset local stack before Fold 4, `npm test` 1008/1008 and `test:p1-cli` 972/972; all other gates exited 0. The lead's later rollback rehearsal is recorded in Fold 8. This lane did not apply a migration or run the server suite after Fold 8.
- Sandbox `ps` and `spawnSync ps` calls return `EPERM`, so the process-table integration cases remain unverified here. The lead's 4509a131 baseline passed `npm test` 1002/1002 and `test:p1-cli` 970/970 outside this sandbox.
- Staging renew-call p50/p95 and the command-edge check budget are **not measured** in `scripts/timeout-table/mapping.json`. The host-contact rule prevents this lane from contacting staging. Measure them before a box release.
- No box migration, edge release, npm publication, site release, or production behavior is established. HezLead and Anvil own the later box window.
- Final `pgrep -fl` exited 3 because this sandbox cannot access `sysmond`; host-wide process absence is therefore not established. Every test child has its own deadline and cleanup, and the full gate wrappers kill process groups on timeout.
