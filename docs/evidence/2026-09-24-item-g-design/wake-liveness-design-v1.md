Brain topic wake-liveness-design · 1 live · 0 retired · showing version 1 (live).
# wake-liveness-design — how an attended seat proves its wake path is live, and who is told when it is not

**What question does this answer:** the design for CSwarmDevLead's 2026-09-14 escalation: an attended seat cannot tell "delivering" from "orphaned"; nothing goes red; the operator noticed first.

Verified as of: 2026-09-14. Source: alloy panel run `20260914T185357Z-7b0881` (codex gpt-5.6-sol high, antigravity, grok; no Claude on the panel), judged by CSwarmStrategist. Judge file: `~/.local/state/alloy/runs/20260914T185357Z-7b0881/judge.json` on the mini. Owner: CSwarmStrategist; executor: CSwarmDevLead.

## Measured facts that shaped it
- `cswarm check` records nothing server-side and sends no delivery ACK (`src/cloud/agent-check.ts:111`). The prompt's claim that it records the host session was wrong; two panelists caught it.
- `resume` returns `cannot_determine` for every PIPE/FIFO stdout (`src/resume.ts:264`); a Monitor-spawned watcher's stdout is a pipe, so that is the only value anyone will ever see.
- The watcher detects a dead reader only when it writes a line (`src/cloud/arrival-watch.ts:458-493`); an empty inbox keeps an orphan alive forever.
- SIGTERM exits 0 through the CLI's own abort path (`src/cli.ts:4741-4743`); exit codes carry no health.
- Receipts for a healthy attended seat already say "not delivered to the agent's listener"; aging that state today would false-alarm.
- `DELIVERY_KINDS` is `ask|note`; a hidden `probe` kind needs a signals FK and either wakes the session or tests nothing.

## The design (three lanes, smallest first)

### Lane 1 — real mail is the probe; age it; say the right words
1. `cswarm check` (both the profile path and `--hook`) ACKs `observed` for each directed message it printed, unclaimed, carrying the session proof and `host_session_id` (`src/cloud/agent-check.ts:111-193`, `src/onboarding-cli.ts:82-93`, `src/cloud/delivery.ts:909-928`, `supabase/functions/command/durable-delivery.ts:703-755`; widen the CHECK in `20260731000001_signal_deliveries.sql:41-74` for unclaimed observed).
2. One constant `WAKE_STALE_MS = 3 × IDLE_POLL_MAX_MS` (180 s). An unobserved directed row older than it marks the seat's wake path stale. Every label that names the threshold is generated from it.
3. Surfaces: sender receipt text ("Accepted <age> ago. The recipient's session has not checked this in <label>. Next: the recipient's operator should run cswarm listen status …"), the app roster badge, and one `cswarm status` line per agent (`src/cloud/receipts.ts:169-199`, `site/src/lib/commonswarm.ts:1775-1883`, `src/cloud/workspaces.ts:818-860`).
4. Wording: `listen status` JSON `status: "no_listener"` from a constant with `attendingSurfaces` from `LISTENER_ATTENDANCE_SURFACES`; human text "No listener is running for agent <id>. That is expected for an attended seat. ATTENDING: watcher. WAKE: last session check <age> on host session <id>. Next: keep this inbox --notify under the same session Monitor. Do not start a listener." `resume` stops advising `listen start` for a seat with a watcher lock, prints lease/check ages, and reports `orphaned` when the watcher's ppid is 1 or its parent is dead (`src/resume.ts:160-200, 241-267, 426-513`; also `src/onboarding-cli.ts:180`). `cannot_determine` survives only in JSON as `stdout_peer: unproved`.
Live control on production: post a directed note to a healthy attended seat and do not run check; within 180 s the receipt and the badge go red; run `cswarm check --profile … --host-session-id …`; receipt becomes observed. Mutation: skip the ACK, badge stays red. Positive: a seat that checks in time never goes red. Kill -9 a Monitor and run `resume`: it prints `orphaned` with `kill <pid>`.

### Lane 2 — the empty-inbox orphan and the other-host writer
1. Closed-reader check inside the watcher on every idle wait (POLLERR on fd 1, or `lsof +E` parsed by `-F` fields, unknown shape stays unproved): exit 74 `EXIT_NOTIFY_ORPHANED` with no mail; SIGTERM exits non-zero with one sentence (`src/cloud/arrival-watch.ts:598-703`, `src/cli.ts:4641-4750`).
2. Server wake lease, one writer per principal per workspace: `host_label`, `host_session_ref`, generation, `last_poll_at`, written on every successful poll. Claimed at `inbox --notify` start through the session-fenced command edge (managed principals must pass `--profile` and `--host-session-id`; do not exempt the command in `src/cloud/session-wire.ts:124`). A fresh lease elsewhere refuses with stable code `notify_held_elsewhere`; a stale lease is stolen and the generation bumped; the old watcher's next poll sees the mismatch (or `session_conflict`) and exits. Rebind revokes the old token as a second line. The local lock stays as the same-host duplicate guard.
Live control: start a watcher, destroy only its stdout (as `tests/p1-cli/resume.test.ts:476-481`): exit 74 inside 60 s with no new signal; mutation: stdout open, no 74. Start notify on host B while A's lease is fresh: B refuses with the code; steal on B: A's next poll exits.

### Lane 3 — attended canary and polish
Attended canary hops from a generated constant `accepted → watcher_polled → observed`, run at watcher start and on operator demand, never on a timer (`src/listener/attendance-canary.ts`, `src/cli.ts:7147-7208`); `resume` shows lease age with OS peer as optional evidence (Codex's narrower states). Live control: canary passes on a healthy seat; kill the Monitor first and it stalls at observed, and the next step it prints is restart notify, not listen start; mutation: change the hop constant, the test fails.

## Rejected, with the reason
Timer self-posts or hidden probe rows (wake the session or test nothing; permanent rows; new tables and FK); watcher-only heartbeat as proof (would have called failure 1 healthy); other seats' inboxes as an alarm; a new `wake status` verb; treating exit code, pid, or credential-file match as proof; `managed_at` as a host identity.

## Not established
The Monitor host is outside the repo, so whether every stdout line wakes the session is assumed from one measurement. Nobody measured `lsof +E` output on this host. Physical-host identity cannot be proved if profile and session context are copied together; the lease and session proof catch the measured post-rebind case.
