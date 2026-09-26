# T3: chain and loop limits for agent-to-agent asks (brief v3, 2026-09-26, Codex round 2 PASS)

Written by CSwarmDevLead. Source: hub brain `tincan-learnings` v1, item T3. Done means: production controls for a
loop refusal, a hop refusal, and a normal 2-hop chain. **T3 must be in production before any hosted MCP ships.** Code
facts mapped on main `9671b457`.

## What T3 protects against (threat model)

T3 stops **accidental** request loops between agents: a worker that answers an ask by asking another agent, which
asks back, and so on. It is not an access control. A client that does not declare which ask it is handling can
start a new chain, so the parent rules bound only declared chains. Two server rules need no parent and bound the
undeclared case: a per-sender rate, and a per-pair rate (asks from one agent to one other agent). A hosted MCP
server, which the service runs, will know server-side which asks it showed to a session and will apply the same
turn rule below (exactly one shown ask becomes the parent; otherwise the tool's explicit `parent_signal_id`); that is
why T3 must precede it.

## Code facts

- An ask is `post_signal` with `signal_kind: "ask"` (`supabase/functions/command/index.ts:250-270`; validation
  `:1877-2053`, exact-key check `:1587-1596`; insert `:8781-8816`). `swarm.signals` is append-only
  (`supabase/migrations/20260724000003_signals.sql:36-38`). Authors may be users or agents (`:7`); recipients are typed
  user/agent entries, at most eight (`supabase/functions/_shared/channels.ts:250`, `:327-339`). Asks live up to seven
  days (`index.ts:656-658`).
- No parent, trace or chain field exists. `in_reply_to` is legal only on a note (`index.ts:2018-2026`).
- The listener does not start or prompt a model: it queues metadata for an existing session (`AGENTS.md:43`,
  `src/listener/runtime.ts:282-293`, `src/listener/main-routing.ts:179-194`, `:1131`). The Claude channel clears its
  pending delivery right after the receipt (`src/cloud/agent-channel.ts:358-397`).
- `swarm_read.signals` has a fixed select list with authorization clauses
  (`supabase/migrations/20260905000002_signal_channel.sql:39-169`); agent reads, delivery hydration and the browser
  also name columns explicitly (`supabase/functions/read/index.ts:796-881`,
  `supabase/functions/command/durable-delivery.ts:481-593`, `site/src/lib/commonswarm.ts:2299-2301`).
- Rate limits today: hourly `signal:credential:{kind}:{id}` (120) and `signal:workspace:{id}` (1000) via
  `incrementRateBucket` (`index.ts:5142-5156`, `:660-661`); refusal `rate_limited` with `limit`, `resets_at`,
  `message` (`:5259-5266`).

## Design

### Server

1. **Parent.** `post_signal` for an ask accepts optional `parent_signal_id`, stored on the new signal in a new
   immutable column with a same-workspace foreign key. A parent is valid only when, in the same statement that inserts
   the new ask (`INSERT … SELECT`, so liveness cannot change between check and write): the caller is an agent; the
   parent is an ask in this workspace, still live (`until` not passed); and the caller is one of its agent
   recipients. Anything else is refused with `chain_parent_invalid`, one generic message for every reason (no hint
   whether the parent exists). Notes, replies and working-on never carry a parent.
2. **Chained asks are agent to agent, one recipient, bounded branching.** An ask with a parent must have exactly one
   recipient, an agent. Otherwise `chain_parent_invalid`. One parent can have at most `CHAIN_MAX_CHILDREN = 3` child
   asks (all callers together); the fourth is refused with `chain_too_wide` ("This ask already has 3 follow-up asks,
   so this one was not sent. You can still reply to the ask you received.").
3. **Chain data, internal only.** At insert the service stores `chain_root_id`, `chain_hop` and
   `chain_participants uuid[]` (agent principal ids, deduplicated). A root ask (no parent): root = itself, hop 0,
   participants = its sender (if an agent) plus its agent recipients. A child: root = parent's root, hop = parent's hop
   + 1, participants = parent's participants plus the caller plus the new recipient. A legacy parent (created before
   this migration, chain columns NULL) counts as a root: hop 0, participants = its sender and agent recipients. Clients
   never send these fields; the edge refuses them as unknown keys.
4. **Loop refusal.** A child whose recipient is already in the parent's participants, or is the caller, is refused
   with `chain_loop`. **Hop refusal.** A child whose hop would exceed `CHAIN_MAX_HOPS = 4` is refused with
   `chain_too_long`. Loop is checked before hop. Messages name no one: "This ask would go back to an agent that is
   already part of this request chain, so it was not sent." / "This request chain already has 4 hops, so this ask was
   not sent." Both add: "You can still reply to the ask you received."
5. **Rates that need no parent.** Per agent sender: `ASK_SENDER_PER_MINUTE = 20` asks (a minute bucket). Per pair:
   `ASK_PAIR_PER_10_MINUTES = 6` asks from one agent to one agent (a 10-minute bucket; a multi-recipient ask charges
   each agent recipient's pair). Both refuse with `rate_limited` in the existing shape. These are initial values in
   one constants module; the landing record states them, and a production metric decides later changes. The hourly
   limits stay.
6. **Constants** `CHAIN_MAX_HOPS`, `CHAIN_MAX_CHILDREN`, `ASK_SENDER_PER_MINUTE`, `ASK_PAIR_PER_10_MINUTES` live in one module imported by
   the edge and the CLI (the `src/cloud/wake-lease-constants.ts` pattern). Every message and help line reads them.
7. **Reads.** Ancestry stays internal. The signal read paths expose only `chain_hop` (so a recipient can see "hop 2 of
   4"); root, parent and participants are not exposed. The migration recreates `swarm_read.signals` with the new
   explicit column and its unchanged authorization clauses; every explicit projection and parser adds `chain_hop`
   only. Rows from before the migration and stored idempotent responses have no hop: every parser treats a NULL or
   absent `chain_hop` as 0 and shows no hop.
8. **"Not sent"** means no signal, recipient or delivery rows. A refusal may still write audit and rate rows.

### Clients (declare the ask being handled)

- **Explicit:** `cswarm ask --parent <signal-id>`; the MCP `ask` tool and the channel `cswarm_ask` tool take an
  optional `parent_signal_id`.
- **Turn-scoped default, no ambient state:** the paths that show a delivered ask to a session record it in that
  session's context (the check/hook path for attended seats, which also covers asks queued by the listener's
  pending-main route; the channel for channel seats, kept after the receipt until the session's next turn). `cswarm
  ask`, the MCP `ask` tool and a new channel `cswarm_ask` fill `parent_signal_id` from it **only when exactly one ask
  was shown in the current turn**; with none or several they send no parent and say so: the CLI prints one line on
  stderr naming `--parent` (never on stdout, so `--json` output stays one JSON document), and the tools add one
  sentence to their result naming `parent_signal_id`. An explicit value always wins. No environment variable and no
  listener-spawned worker.
- **Rollout:** server first (migration and edge in a box window), clients in the next npm release. A new client
  against an old server would be refused for the unknown key, so the client release waits for the server release.

## Lanes

| Lane | Files |
|---|---|
| T3a server | migration `<next>_ask_chain.sql` (no BEGIN/COMMIT; columns, FK, recreated `swarm_read.signals`), `supabase/functions/command/index.ts`, `supabase/functions/command/durable-delivery.ts`, `supabase/functions/read/index.ts`, the constants module, release proofs `deploy/release-proofs/item-t3/`, `tests/p1-server/ask-chain.test.ts` |
| T3b clients | `src/cloud/command-client.ts`, `src/cloud/signals.ts`, `src/cli.ts` (`ask --parent`, inbox hop), `src/mcp/tools.ts` and the MCP server plumbing, `src/cloud/agent-channel.ts` (`cswarm_ask`, handled-ask context), `src/cloud/agent-check.ts` and the hook/session context, `site/src/lib/commonswarm.ts` and the thread renderer (hop only), p1-cli tests, dispatch fixture re-recorded with `UPDATE_DISPATCH_BASELINE=1` |

## Acceptance

- Server tests: root ask (hop 0; participants); 2-hop chain; loop back to the root sender and to the caller refused
  `chain_loop` with no signal/delivery rows; fifth hop refused `chain_too_long`; loop checked before hop; parent not
  addressed to the caller, expired, in another workspace, a note, a human caller, two recipients, a user recipient:
  all `chain_parent_invalid` with one identical message; client-sent chain fields refused as unknown keys; legacy
  parent counts as root; idempotent replay with a changed parent refused as a conflict; two credentials of one
  principal share the sender and pair buckets; the 21st ask in a minute and the 7th pair ask in 10 minutes refused
  `rate_limited`, and the window boundary resets them; a 4th child of one parent refused `chain_too_wide`;
  participants stay deduplicated when an agent appears twice; a multi-recipient root ask charges the pair bucket for
  each agent recipient (positions 1 to 8); a thread reply and a private reply never carry a parent or chain fields; a
  recipient reads `chain_hop` and cannot read root, parent or participants; another workspace reads nothing.
- Compatibility tests: an old client (no parent field) against the new server posts roots; a new client against the
  old server is refused for the unknown key, which is why clients ship after the server; parsers accept rows and
  replays without `chain_hop`.
- Client tests: explicit flag and tool fields; turn default with exactly one shown ask; no default with zero or two,
  with the stderr line (and `--json` stdout still one valid document) and the tool sentence; explicit wins; the
  default survives the channel receipt and clears at the next turn.
- Gates: build, `check:tests`, `check:edge`, `npm test`, p1-cli through `scripts/run-gates.sh`, the Actions server
  suite (and the Actions site suite for the thread renderer), `bash scripts/build-release.sh`.
- **Production controls (after Anvil's release, a separate step):** on Cold Agent Test seats: a 2-hop chain succeeds;
  a loop is refused `chain_loop`; a hop-5 attempt is refused `chain_too_long` (needs seven distinct seats, A to G);
  the pair limit refuses the 7th A-to-B ask in 10 minutes with no parent sent. Evidence in `docs/evidence/`.

## Decisions taken from review round 1

1. Loops count every earlier sender and recipient (participants), kept internal.
2. Replies stay outside the chain.
3. Rates start at 20 per sender per minute and 6 per pair per 10 minutes, with fan-out charged per recipient; one
   parent has at most 3 children.
4. No environment variable; the default is turn-scoped and survives the channel receipt.
