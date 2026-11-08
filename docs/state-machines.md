# State machines

Every place in CommonSwarm where something moves through states. Most have no explicit machine: state comes from a status column, from a mix of timestamps, or from an event-sourced projection. This file is the map. Change it in the same PR as the transition.

**Where** says who enforces a rule:
- **DB:** constraint, trigger or guarded `UPDATE … WHERE`.
- **Server:** the command, read, activity or mcp edge, or a protocol reducer.
- **Client:** the site or CLI only.

Terminal states are marked †.

## Workspaces and membership
| | |
|---|---|
| States | Workspace: live or archived (`workspaces.archived_at`). Member: live or removed (`memberships.revoked_at`), with role owner, admin or member. |
| Transitions | `create_workspace`: a person with a verified email, when `SWARM_SELF_SERVE` is on. A re-send with an existing id is a retry only for a creator who is still a live owner of a live workspace. Invite, accept, remove, change role and archive are server-side; the reducer is `src/protocol/workspace-commands.ts`. |
| Invariants | Each live workspace keeps at least one live owner (server). Archived workspaces admit nobody (DB: `swarm.is_member` and the admission functions). |

## Invitations
| | |
|---|---|
| States | live, consumed†, revoked†, expired† (by clock: `expires_at`) |
| Transitions | Owner or admin invites, TTL up to 7 days. The invitee accepts through a guarded update that consumes the row (server). The household path forces the role to member and requires a matching email and a live inviter. |

## Hosted MCP grants and seats
| | |
|---|---|
| States | Grant: `pending → active → revoked†` (`hosted_mcp_grants.state`; a CHECK ties it to the timestamps). It is also unusable after `connection_expires_at` or once its token family is retired. Seat and handle: live or revoked† (`revoked_at`). |
| Transitions | A person consents and activates. The agent claims a seat (grant row `FOR UPDATE` plus the SQL resolver). A person revokes a seat or grant; the seat can release itself. |
| Invariants | Live seat names are unique per workspace (DB). Seat and principal caps (server). The resolvers fence out seats under a revoked grant or a revoked agent. |

## Agent credentials
| | |
|---|---|
| States | Token: pending (`first_used_at` null), in use, superseded, expired (clock), revoked† (a DB trigger blocks un-revoking). Run, device and principal: live or ended† (`ended_at` / `revoked_at`). OAuth artifact: live or consumed† (compare-and-set). |
| Invariants | First use is stamped once (DB). Revoking a principal revokes its renewal grants and residual tokens (server). Refresh reuse retires the family (OAuth service). |

## Message delivery
| | |
|---|---|
| States | `signal_deliveries`: pending → leased → queued → observed / replied / expired / failed_terminal† (`ack_outcome`). People see delivered, seen, replied, working (`swarm_read.message_status`). |
| Transitions | Enqueue (trigger). Claim (listener; principal lock plus `SKIP LOCKED`). Ack (an update that must match the lease). Lease reset, expiry and failure happen when the same recipient next claims. |
| Invariants | A leased ack needs its lease pair (DB). Messages are append-only (DB trigger on `signals`). |

## To-dos
| | |
|---|---|
| States | `household_todos.state`: open, doing, done, dropped (the CHECK covers values only). Sub-machines on the same row: an offer (`offer_id`…) and a gate (`gate_kind`: none, hold, after or at). |
| Transitions | open ↔ doing; any → done / dropped; done / dropped → open. Only the assignee starts, and only once the gate is clear. Offer accept and decline belong to the decider; withdraw belongs to the offerer or an admin. One reducer: `decideTodo` in `src/protocol/household-todos.ts`, under the stream lock plus rows locked `FOR UPDATE`. |

## Channels
| | |
|---|---|
| States | live or archived† (`channels.archived_at`). `#general` is virtual: `signals.channel_id IS NULL`. |
| Transitions | Members create. The creator, an owner or an admin renames or archives. Members post only to live channels (server). |
| Invariants | Slug shape and per-workspace slug uniqueness, archived channels included (DB). `general` and `all-signals` are reserved (server). |

## Household objects: lists, docs, definitions and uploads
| | |
|---|---|
| States | Derived from `household_object_streams.projection`. Object revisions: the newest 20 live, older ones retired. Conflict drafts. Upload reservations, 15 minutes. Definition: proposed, certified, or proposal pending (certified at an older revision). Artifact: `reserved → committed / draft / released` (a trigger freezes all but reserved). |
| Transitions | One reducer, `src/protocol/household-objects.ts`, under the stream lock. Writes name their base revision; a stale base becomes a conflict draft. Only people certify. |

## Files
| | |
|---|---|
| States | Version: `pending → live → retired`, or `→ purged†` (CHECK). File: active → tombstoned → purged† (`tombstoned_at`, `purged_at`). |
| Transitions | The uploader commits. People tombstone and restore; agents only files they created; restore is possible for 30 days. Cron purges pending versions after 3 hours and tombstoned files after 30 days. |

## Interactive replies (behind `SWARM_INTERACTIVE_REPLIES`)
| | |
|---|---|
| States | Ask: open, answered or expired (derived: `until` and `swarm.ask_answered`). `ui_actions.state`: `pending → approved → completed† / failed†`. |
| Transitions | Only the addressed person answers, under a per-ask advisory lock, with up to 5 attempts each. The sender may re-raise once every 24 hours. |
| Invariants | Completed requires a reply signal; at most one completed answer per ask (DB). |

## Brain memory (behind `SWARM_BRAIN_MEMORY`)
| | |
|---|---|
| States | `memories.status`: active or deleted† (a CHECK ties it to `deleted_at`). Every change appends a `memory_versions` row. |
| Transitions | Save new: no `expected_revision`. Update: `expected_revision` must equal `revision`, and the update is guarded on it. Forget: the original author only. |
| Invariants | One active memory per subject (partial unique index). Identity fields are fixed and revisions increase (trigger). Caps: 500 active, 5000 versions. |

## Presence
No state column. `agent_presence` holds timestamps (`last_command_at`, `watcher_at`, `channel_at`, `listener_at`, `turn_at`) written by the command edge. Three readings derive from them:
- the roster: off, not picking up, active, idle, inactive;
- the wake classifier in `src/cloud/agent-presence.ts`;
- the site chip in `site/src/lib/agent-status.ts`.

Keep their thresholds in step.

## Clients
- **Site boot** uses `data-state` on the app root: loading, signed-out, create, workspace-error, channel. Channel views use `data-channel-view`. Version counters drop stale responses.
- **CLI pending commands** (`src/cloud/pending-command.ts`) keep the command id of an unanswered write so a retry is replayed rather than applied twice.
- **The listener's delivery journal** (`src/listener/delivery-journal.ts`) runs idle → claim pending → leased → ack pending → idle.
