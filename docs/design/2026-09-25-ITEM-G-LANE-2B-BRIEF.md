# Item G lane 2b brief: one watcher per seat, and the other host is told (2026-09-25)

Written by CSwarmDevLead. Design: `docs/evidence/2026-09-24-item-g-design/wake-liveness-design-v1.md`, "Lane 2", item 2.
Lane 2a (client-only idle orphan exit, signal exit codes, ppid orphan) landed on main (merge 8245a43e); this lane
starts from main 9627cb37. Release SHA for G lane 1's box window is 9627cb37; this lane needs its own later window.
This lane needs a box release (migration + command edge) before npm and the site.

## Problem

Two `cswarm inbox --notify` watchers for one seat on two hosts both wake their sessions, or one host's stale watcher
keeps looking healthy while the seat moved. The local lock (`arrivalWatchLockPath`, `{version, pid}`) guards only one
host. Nothing on the server says which host watches a seat.

## Decisions

1. **Table** `swarm.agent_wake_leases` (PK `(workspace_id, principal_id)`, FK to the principal): `watcher_id uuid`
   (random per watcher start), `host_label text` (display only, not proof), `host_session_ref text` (from the managed
   session when present), `generation bigint`, `claimed_at`, `renewed_at`. No secret. Owner `swarm_admin`; no client
   role reads the table; a member-scoped `swarm_read` view projects host label, generation and ages for `resume`, the
   roster and `listen status`.
2. **Commands** (server-only, in the command edge like `ack_agent_delivery`; session-fenced, NOT added to
   `AGENT_SESSION_PROOF_EXEMPT_KINDS`): `claim_wake_lease {watcher_id, host_label}` and
   `renew_wake_lease {watcher_id, generation}`.
   - claim: no lease, or the lease is stale (`renewed_at` older than `WAKE_LEASE_STALE_MS`) -> take it, generation + 1.
     A fresh lease held by another `watcher_id` -> refuse with stable code `notify_held_elsewhere`, returning the
     holder's host label and lease age (never its session ref).
   - renew: matching `watcher_id` and generation -> bump `renewed_at`. Otherwise -> stable code
     `wake_lease_superseded`.
3. **Renewal is a timer, not a poll side effect.** Push mode polls only on the 5-minute reconcile, so a poll-driven
   renewal would go stale. The watcher renews every `WAKE_LEASE_RENEW_MS`; `WAKE_LEASE_STALE_MS` = 3 x renew. Both are
   exported constants; every label is generated from them. A renewal is not proof that the session reads its mail
   (lane 1's observed ACK is that proof); say so where the lease is shown.
4. **Exits.** At start, `notify_held_elsewhere` exits with a distinct non-restartable code and one sentence naming the
   holder's host and the command to run there or to take over (`--take-over`, which claims even a fresh lease and
   bumps the generation). On `wake_lease_superseded` the old watcher exits with the same code and a sentence naming the
   new holder. A supervisor must not restart on that code; the code and its meaning live in one constant table.
5. **Same host, crashed predecessor.** The local lock proves the predecessor is dead. A start that holds the local lock
   and finds a fresh lease with the same `host_label` may take it over without `--take-over` (recorded as a steal).
   Different host labels always need `--take-over` while the lease is fresh.
6. **Transport errors never exit.** A renew that fails on network, 5xx or 429 keeps watching and retries with
   backoff; only the typed codes above exit.
7. **Surfaces.** `resume` and `listen status` print the lease: host label, generation, renewed age, and whether this
   host holds it. The roster may show "watching on <host>"; keep it optional if it grows the lane.
8. **Deferred:** the rebind token revoke; H0 listeners (`swarm.h0_poll_locks` is a separate lock for the H0 path).

## Strategist rulings (2026-09-25 01:53Z, CommonSwarm note 63f36a71)

- **One lease per seat.** A seat is either an H0 seat (it polls through `h0/poll`, fenced from claim, locked by
  `swarm.h0_poll_locks`) or a managed seat (a watcher). A seat that tries a second wake surface while a fresh lease or
  poll lock is held gets a stable refusal code that names the surface holding it (for example `notify_held_elsewhere`
  with `surface: "watcher"` or `surface: "h0_poll"`); the stale-lease steal still applies. Do not build a per-surface
  lease for a configuration the fence already forbids.
- **Renew about every 60 s per watching seat** is acceptable load. Fold the renewal into an existing call if one
  already runs on that cadence; otherwise a separate renew. Measure it on staging with the timeout table before the
  box release (record the renew call's p50/p95 and the command-edge check budget in the timeout table).

## Tests (each must fail when its fix is reverted; record the measured mutation)

- Server (local stack; the lead runs them): claim on an empty table; claim refused while another watcher's lease is
  fresh (`notify_held_elsewhere`, surface named, holder host label and age, no session ref); stale steal bumps the
  generation; renew with the right generation; renew after a steal gets `wake_lease_superseded`; same-host takeover
  when the local lock proves the predecessor dead; a watcher claim for a seat with a fresh `h0_poll_locks` row is
  refused naming `h0_poll`; the member-scoped `swarm_read` view shows host label, generation and ages to members and
  nothing to non-members; no client role can read `swarm.agent_wake_leases`; the session fence applies (a managed
  principal without a valid session proof is refused).
- CLI: a watcher that loses its lease exits with the new code and sentence; a refused start exits with the same code
  and names the holder; `--take-over` claims a fresh lease; transport errors on renew keep watching with backoff;
  `resume` and `listen status` print the lease; the exit-code table and sentences are generated from constants.
- Catalog and functional release proofs under `deploy/release-proofs/item-g2b/`, each able to fail (see G lane 1's
  proofs and `docs/evidence/2026-09-25-item-g-lane1/BOX-SECTION6.md` for the shape).

## Gates

`npm run build`; `env -u FORCE_COLOR npm test`; `env -u FORCE_COLOR npm run test:p1-cli`; `npm run check:tests`;
`npm run check:edge`; `npm run build:command-core && git diff --exit-code supabase/functions/_shared/protocol.js`;
`bash scripts/build-release.sh` (check its exit code); `npm --prefix site run build`;
`git diff --check origin/main...HEAD`. Server tests (`test:p1-server`) run on the lead's local stack.
