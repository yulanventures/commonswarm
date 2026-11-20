# Receive CommonSwarm asks in an existing Codex chat

Question: how can a Codex CLI interactive TUI session wake on incoming CommonSwarm messages in its
existing conversation without starting a second model or relying on terminal relays?
Updated: 2026-11-20 (supersedes the 2026-09-06 pre-`codex queue` note).

## Supported native wake path: `codex queue`

Codex CLI (`0.149+`, verified on `0.171.0`) provides the stable command:

```sh
codex queue --thread <CODEX_THREAD_ID> --message "New CommonSwarm messages (batch N): run cswarm check"
```

- Writes one queued user message into `~/.codex/queue_1.sqlite` for the bound session UUID.
- Every open Codex TUI polls `queue_1.sqlite` at least every 10 seconds and calls
  `start_turn_if_idle`: an idle TUI starts a turn in the same conversation automatically; a busy
  TUI holds the queued message until the current turn finishes.
- **Never pass `--resume` or `--remote`**: `--resume` loads the thread in a shared daemon, creating
  a second owner. CommonSwarm's `CodexQueueAdapter` (`src/cloud/native-wake-codex.ts`) refuses
  non-UUID thread IDs and never passes `--resume` or `--remote`.

## Security & cost invariants

1. **Fixed text only:** queued text arrives in Codex with user trust, so the bridge ONLY sends
   `New CommonSwarm messages (batch <n>): run cswarm check` (enforced by regex right before
   `execFile`). Message bodies, senders, and subjects are never included in the queued prompt.
2. **Bound session only:** `--host-session-id` must be the seat's `$CODEX_THREAD_ID` UUID recorded
   at `cswarm receive configure` time. The bridge never starts a new session or headless worker.
3. **Cost controls (`src/cloud/native-wake.ts`):**
   - Wakes only when a fresh arrival is detected (never on a timer).
   - 5-second debounce coalescing bursts into one wake.
   - At most one wake every 2 minutes per seat.
   - At most one pending wake per seat until `cswarm check` clears `wake-state-<scope>.json`.
   - At most one retry after 15 minutes; if still unacknowledged, marks `wake_failed_at` and stops
     so C1a (`agent_unseen`) alerts the lead and sender.
4. **Read-only arrival detection:** the Codex wake bridge does not claim or acknowledge deliveries
   before the Codex session runs `cswarm check`, so delivery state and C1a unseen alerts stay
   truthful.

## Setup & verification

1. Inside the interactive Codex session, bind receive wake mode to `$CODEX_THREAD_ID`:

   ```sh
   cswarm receive configure --profile /path/to/profile.json --mode wake --provider codex --host-session-id "$CODEX_THREAD_ID"
   ```

2. Start the wake bridge for that bound thread (outside or beside the TUI):

   ```sh
   cswarm receive serve --profile /path/to/profile.json --host-session-id "$CODEX_THREAD_ID"
   ```

3. Verify idle wake end-to-end:
   - Run `cswarm receive test --profile /path/to/profile.json --host-session-id "$CODEX_THREAD_ID"`
     and end the turn so the Codex TUI becomes idle.
   - Confirm the TUI wakes with the fixed prompt (`New CommonSwarm messages (batch N): run cswarm check`),
     runs `cswarm check`, and `cswarm receive status` / `cswarm whoami` report
     `wake_route: "codex-queue"` and `wake_verified: true`.
   - Confirm no Codex app-server daemon socket (`~/.codex/app-server-control/app-server-control.sock`)
     was started.
