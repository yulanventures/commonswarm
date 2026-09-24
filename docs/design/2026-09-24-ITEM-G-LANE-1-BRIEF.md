# Item G lane 1 brief: real mail is the probe for an attended seat's wake path (2026-09-24)

Written by CSwarmDevLead. Design: brain topic `wake-liveness-design` v1 (copied to
`docs/evidence/2026-09-24-item-g-design/wake-liveness-design-v1.md`; from an alloy panel judged by the Strategist on
2026-09-14). Order (Strategist, 2026-09-24): I, H release 2, J, then G. This brief covers LANE 1 only and refreshes it
against origin/main f96be7c2; lanes 2 and 3 get their own briefs.

## What is true today (mapped read-only)

- `cswarm check` (profile path, `--hook`, and the MCP `check` tool, which wraps the same `checkAgentMessages`) records
  nothing server-side and sends no delivery ACK (src/cloud/agent-check.ts:137).
- The command edge refuses an unclaimed ACK today: `ackAgentDelivery`'s `queuedObservation` branch returns
  `unavailable` when the row has no lease (supabase/functions/command/durable-delivery.ts:709), and a table CHECK
  requires a lease pair on any acked row except expired / failed_terminal.
- Local branch `lane/wake-liveness` (1dff26b6, 2026-09-14, WIP, paused for item H) holds: `WAKE_STALE_MS =
  IDLE_POLL_MAX_MS * 3` (src/cloud/idle-poll.ts), a migration widening that CHECK for an unclaimed `observed` ack
  (numbered 20260914000001), and the edge branch accepting it with the session fence for managed principals. It merges
  into origin/main with no conflict. It has no client call, no surfaces, no wording, no tests, no arms.
- The client `ackAgentDelivery()` requires a lease id and a listener instance id (src/cloud/delivery.ts), so it cannot
  send the unclaimed shape.
- Item I now supplies the session proof and host session plumbing `check` needs (agent-profile.ts profileSessionContext).
- Receipts for a healthy attended seat say "Not yet delivered to agent <id>" (src/cloud/receipts.ts:172-176), which
  cannot tell a healthy attended seat from an orphaned one.

## Decisions for lane 1

1. **Server (box release).** Take the WIP migration and edge branch from `lane/wake-liveness`, renumbered after the
   newest applied migration (`20260925000001_unclaimed_observed_ack.sql`; the box applies migrations in order and
   `20260914...` is older than ones already applied). The edge accepts an unclaimed `observed` ack only for a directed
   delivery to the calling principal, idempotently, with the session fence for managed principals; it never changes a
   claimed or terminal row. Box-release proofs (catalog + functional) per deploy/RELEASE-TO-BOX.md section 5.
2. **`check` ACKs what it showed.** For each directed ask/note that `check` presented (profile path, `--hook`, and the
   MCP `check` tool), after the local cursor commit (for MCP: after the response was written), send one unclaimed
   `observed` ack with the session proof when the profile is managed. An ack failure never fails `check` and never
   changes its output; it is retried on the next check for rows still unacked (bounded). The new client call is a
   separate function from the leased `ackAgentDelivery`.
3. **One stale threshold.** `WAKE_STALE_MS = 3 x IDLE_POLL_MAX_MS` (180 s). Every label that names it is generated from
   it (AGENTS.md: generated enumerations).
4. **Surfaces say the true state.** A directed delivery that is accepted, unobserved and older than `WAKE_STALE_MS`:
   the sender's receipt says "Accepted <age> ago. The recipient's session has not checked this in <label>." with the
   next step for the recipient's operator; a younger one keeps today's text; an observed one says when it was seen.
   The app roster marks the recipient seat's wake path as stale while such a row exists, and clears it on the ack.
   `listen status` for a seat with no listener says, from a constant, that no listener runs and that attended seats
   are reached through their session check (not an error).
5. **Out of lane 1:** the ppid orphan flag, the closed-reader exit 74 on idle waits, the server wake lease (lane 2), the
   attended canary (lane 3).

## Done for lane 1

Unit, CLI, site and server tests (named by package scripts) for each decision, with mutation controls; the box release
(migration + command edge) through HezLead and Anvil; then npm and the site. Production control (design): post a
directed note to a healthy attended seat and do not run check: within 180 s the receipt and the badge show stale; run
`cswarm check --profile ... --host-session-id ...`: both clear.
