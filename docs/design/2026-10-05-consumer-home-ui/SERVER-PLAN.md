# Consumer home UI: server plan (lane/home-ui @ 6b72cd6d)

Read-only plan. No files were edited and nothing was built or run. Line numbers are from 6b72cd6d.

## A. Decisions

**A1. A to-do is a new household *sibling* object: SQL rows plus append-only events.** It is not a fourth `HOUSEHOLD_OBJECT_TYPES` entry and not the governed `TaskState`.
- **Why not a fourth object type:**
  - Every household revision is a Storage blob (`household-object-events.ts:20-23`).
  - Objects share a 500-name quota (`household-object-policy.ts:2`).
  - Authority is only read, create or update (`household-objects.ts:236-242`), so the core cannot express "only the recipient accepts" or "only the owner reorders".
  - Stale writes become merge drafts, not domain refusals (`household-objects.ts:274-285`).
  - A queue reorder would mint N blob revisions.
- **Why not the governed task:** `TaskLifecycle` has no `dropped` (`events.ts:113`). Submit and close need leases and evidence (TASKS:39). TASKS:8-11 requires a canonical amendment first. HUB-V1:33-35 defers tasks.
- **This supersedes TASKS:46-49 ("Do not create a consumer-task table").** See F1.

**A2. Reuse, don't fork:**
- `householdAccessRefusal` (`household-object-policy.ts:55-84`) and `store.access` (`command/household-objects.ts:64-103`) for the credential recheck, hosted grant/binding/seat liveness and content consent.
- `swarm.household_object_audit` for audit.
- `HOUSEHOLD_SURFACE_KINDS` dispatch (`household-integration.ts:12`; `command/index.ts:10775`). This branch sits **after** the session-proof fence at `index.ts:10558`, so managed agents stay fenced (SESSION-IDENTITY:171-175).
- `EventEnvelope` and `SCHEMA_VERSION` (`events.ts:11,34`).
- The tool registry as the single inventory (`household-tool-registry.ts:109`).

**A3. Content operations map onto the existing approval.** Reads map to `read`. Create and comment map to `create`. Everything else maps to `update`. The consent copy is generated from the registry (`registry:286-295`) and will name to-dos and comments.
- PRIVACY:136 says new operations need new consent. This widens nothing, because the household lanes are unmerged and the schema releases after C1 (DECISIONS:31-32). No production approval exists yet.

**A4. Assignment and acceptance** (TASKS:105, :134-135):
- Self-assignment is accepted.
- Assigning to another person is an **offer** that the person decides.
- Assigning to an agent follows that agent's `accepts_from` setting. This setting is the owner's explicit, bounded standing grant that TASKS:135 requires. The default is `owner`.
- A non-owner who asks for "now" always creates an offer, even under `anyone`.
- Assignment never sets Doing.

**A5. Who may steer a queue (move, start now, hold, release): the agent's human owner only.**
- Workspace owners and admins only have **revoke** power over other people's agents (`workspace-commands.ts:1005`). Administration implies no authority over another person's agent (PRIVACY:41, :91-92).
- The agent itself picks work with `todo_start`. It does not reorder.
- Every member with content read access can *see* every queue (SECURITY.md:43). So "only you see the whole queue" copy is not allowed.

**A6. Gates are evaluated on read with the server clock (`clock_timestamp()`). There is no scheduler and no model start** (AGENTS.md:43; TASKS:414). An `at` gate clears when the time passes. An `after` gate clears when the referenced to-do is Done or Dropped. `hold` clears only when a person releases it.

**A7. No merged cross-workspace queue.** A principal belongs to one workspace: `agent_presence` has an FK on `(principal_id, workspace_id)` (20260927000002:12-13), and `hosted_mcp_seats` has one `principal_id` per workspace (20260928000002:43-62). D3 says reconnecting creates a new identity.
- The owner sees one section per workspace.
- To-dos left on a revoked principal stay where they are. They show up in `needs_you` as `agent_removed`. Nothing moves by name.

**A8. Comments live in their own append-only table, not in signals.** A signal with recipients is visible only to the sender and the recipients (`20260905000010_signal_recipients.sql:423-441`), so a tag would hide the comment from everyone else.
- Thread replies stay unaddressable (`composer-address.ts:64-69`). The UI must not claim that a tag in a thread reaches anyone.

**A9. Notices about to-dos are ordinary `post_signal` rows posted in the same transaction.** The command edge injects a closure that calls `resolveSignalWriteTarget` → `enforceSignalRate` → `postSignal` (`index.ts:8846, 5528, 9117`).
- **Delivery path:** `signal_recipients_enqueue_delivery` (20260905000020:223) → `swarm.signal_deliveries` → `signal_deliveries_wake_agent` (20260906000010:196). The hosted seat reads it on `check`; a local agent reads it on inbox claim. People are never woken (`composer-address.ts:17`).
- **Body:** fixed, with no title (TASKS:146-152), because the recipient may lack content approval.
- **Rate limit:** if the notice is rate-limited, the to-do still commits and the result reports `notice: not_sent`.
- **Replay:** a replay returns the stored receipt and posts nothing.

**A10. Agent work status comes from server facts only.**
- **disconnected:** credential facts alone. The principal is revoked; the hosted seat, grant or binding is revoked or inactive; or a local agent has no live token *and* no live renewal grant (off, ended or paused).
- **working:** not disconnected, *and* (a to-do in Doing *or* an unexpired `working-on` signal), *and* `last_activity_at` within 30 minutes.
- **idle:** everything else.
- `working-on` defaults to 24 hours (`index.ts:705`) and is agent-authored (SWARM-CLOUD:189). That is why a recent server-recorded action is required.
- **Hosted seats do not write `agent_presence`** (`index.ts:10537`). So `last_activity_at` is the greatest of:
  - `agent_presence.last_command_at`;
  - the principal's latest signal;
  - `hosted_mcp_check_batches.created_at` or `acknowledged_at` (these exist only when signals were delivered);
  - the principal's latest to-do or object event.
- `oldest_unobserved_at` is reported as "messages waiting since …", never as offline. Waiting messages are normal for turn-only hosted seats (`workspace-reducer.ts:441`; `agent-status.ts:70`).

**A11. Stream cards are interleaved on the client from a read gated by content consent.**
- There is no signal-schema change.
- Signals are readable by every member (`is_member` view). Putting titles in signals would bypass the content-consent check at `household-object-policy.ts:68`.
- List, doc and file activity comes from the committed history in `household_object_streams.projection`. `swarm_command` has only INSERT on `household_object_events` (20261004000002:41), and drafts must stay hidden (`household-object-events.ts:68-71`).

**A12. The overview is a lock-free SQL `SECURITY DEFINER` RPC**, like `signal_delivery_receipts`.
- `store.access` takes `FOR UPDATE` on the workspace row even for reads (`command/household-objects.ts:66`).
- "Last looked" means `max(signal_human_receipts.first_seen_at)` per workspace (20260901000020:8-18). This needs no new table.
- The SQL content check mirrors `householdAccessRefusal` for humans, and a parity test protects it against drift.

## B. Data model and migrations

### `20261006000001_household_todos.sql`

```sql
CREATE TABLE swarm.household_todo_streams (
 workspace_id uuid PRIMARY KEY REFERENCES swarm.workspaces(workspace_id),
 stream_id uuid NOT NULL UNIQUE, last_seq bigint NOT NULL DEFAULT -1);
CREATE TABLE swarm.household_todo_events (
 workspace_id uuid NOT NULL REFERENCES swarm.household_todo_streams(workspace_id),
 seq bigint NOT NULL, event_id uuid NOT NULL UNIQUE, occurred_at timestamptz NOT NULL,
 event jsonb NOT NULL CHECK (octet_length(event::text) <= 65536), PRIMARY KEY (workspace_id, seq));
CREATE TABLE swarm.household_todos (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), todo_id uuid NOT NULL,
 version int NOT NULL CHECK (version >= 1),
 title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200 AND title !~ '[[:cntrl:]]'),
 notes text NOT NULL DEFAULT '' CHECK (char_length(notes) <= 4000),
 state text NOT NULL CHECK (state IN ('open','doing','done','dropped')), due_on date,
 created_by_user uuid NOT NULL, created_by_principal uuid, created_at timestamptz NOT NULL,
 assignee_user uuid, assignee_principal uuid, assigned_by_user uuid, assigned_by_principal uuid,
 assigned_at timestamptz, CHECK (assignee_user IS NULL OR assignee_principal IS NULL),
 offer_id uuid, offer_user uuid, offer_principal uuid, offer_decider uuid,
 offer_start text CHECK (offer_start IN ('queue','now')), offer_gate jsonb,
 offer_by_user uuid, offer_by_principal uuid, offered_at timestamptz,
 CHECK ((offer_id IS NULL) = (offer_decider IS NULL)),
 gate_kind text NOT NULL DEFAULT 'none' CHECK (gate_kind IN ('none','hold','after','at')),
 gate_note text CHECK (char_length(gate_note) <= 200), gate_todo_id uuid, gate_at timestamptz,
 gate_set_by uuid, CHECK ((gate_kind='after') = (gate_todo_id IS NOT NULL)),
 CHECK ((gate_kind='at') = (gate_at IS NOT NULL)),
 queue_rank bigint CHECK (queue_rank IS NULL OR assignee_principal IS NOT NULL),
 state_by_user uuid NOT NULL, state_by_principal uuid, state_at timestamptz NOT NULL,
 last_seq bigint NOT NULL, PRIMARY KEY (workspace_id, todo_id),
 FOREIGN KEY (assignee_principal, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id),
 FOREIGN KEY (offer_principal, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id),
 FOREIGN KEY (workspace_id, assignee_user) REFERENCES swarm.memberships(workspace_id, user_id),
 FOREIGN KEY (workspace_id, offer_user) REFERENCES swarm.memberships(workspace_id, user_id),
 FOREIGN KEY (workspace_id, gate_todo_id) REFERENCES swarm.household_todos(workspace_id, todo_id));
CREATE INDEX household_todos_queue ON swarm.household_todos (workspace_id, assignee_principal, queue_rank) WHERE state IN ('open','doing');
CREATE INDEX household_todos_person ON swarm.household_todos (workspace_id, assignee_user) WHERE state IN ('open','doing');
CREATE INDEX household_todos_offer ON swarm.household_todos (offer_decider) WHERE offer_id IS NOT NULL;
CREATE TABLE swarm.household_comments (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), comment_id uuid NOT NULL,
 target_kind text NOT NULL CHECK (target_kind IN ('todo','list','doc','file')),
 target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 255),
 author_user uuid NOT NULL, author_principal uuid,
 body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
 mentions jsonb NOT NULL CHECK (jsonb_typeof(mentions)='array' AND jsonb_array_length(mentions) <= 8),
 notice_signal_id uuid, seq bigint NOT NULL, created_at timestamptz NOT NULL,
 PRIMARY KEY (workspace_id, comment_id));
CREATE INDEX household_comments_target ON swarm.household_comments (workspace_id, target_kind, target_id, seq);
CREATE TABLE swarm.household_agent_work_policies (
 workspace_id uuid NOT NULL, principal_id uuid NOT NULL,
 accepts_from text NOT NULL CHECK (accepts_from IN ('anyone','owner')),
 set_by_user uuid NOT NULL, set_at timestamptz NOT NULL, PRIMARY KEY (workspace_id, principal_id),
 FOREIGN KEY (principal_id, workspace_id) REFERENCES swarm.agent_principals(principal_id, workspace_id));
CREATE TABLE swarm.household_todo_receipts (
 workspace_id uuid NOT NULL REFERENCES swarm.workspaces(workspace_id), principal uuid NOT NULL,
 command_id text NOT NULL, request_digest text NOT NULL CHECK (request_digest ~ '^[0-9a-f]{64}$'),
 outcome jsonb NOT NULL, created_at timestamptz NOT NULL, PRIMARY KEY (workspace_id, principal, command_id));
```

- **Triggers:** `swarm.prevent_append_only_mutation()` is a BEFORE UPDATE OR DELETE trigger on the events, comments and receipts tables.
- **Ownership, RLS and grants:** copy 20261004000002:32-46 exactly. Each table is `OWNER TO swarm_admin`, has RLS enabled with policy `swarm_command_all`, and gets `REVOKE ALL … FROM PUBLIC, anon, authenticated, swarm_read, swarm_command`. Then grant:

  | Tables | `swarm_command` gets |
  |---|---|
  | streams, todos, policies | SELECT, INSERT, UPDATE |
  | events, comments, receipts | SELECT, INSERT |

- **Lock order:** workspace (through `store.access`) → to-do stream row `FOR UPDATE` → to-do rows.

**Rollback** (verbatim in `supabase/household-todo-reserve/20261006000001-rollback.sql` and `deploy/release-proofs/household-todo/`; it runs only after 000002 is rolled back):

```sql
-- Destroys to-do history; the release procedure exports these six tables first.
DROP TABLE IF EXISTS swarm.household_comments;
DROP TABLE IF EXISTS swarm.household_todo_receipts;
DROP TABLE IF EXISTS swarm.household_agent_work_policies;
DROP TABLE IF EXISTS swarm.household_todos;
DROP TABLE IF EXISTS swarm.household_todo_events;
DROP TABLE IF EXISTS swarm.household_todo_streams;
```

- **`-catalog.sql`** asserts:
  - the exact `swarm_command` privileges above, with no DELETE or TRUNCATE;
  - zero privileges for `anon`, `authenticated` and `swarm_read`;
  - three append-only triggers;
  - RLS on.
- **`-rollback-catalog.sql`** asserts that the six tables are gone and that the `household_object_*` tables, grants and audit rows are unchanged.

### `20261006000002_home_overview.sql`

`swarm.household_human_can_read(p_workspace uuid, p_user uuid) RETURNS boolean` is `STABLE SECURITY DEFINER` with `SET search_path=pg_catalog` and returns true only when all of these hold:
- the membership is live and the workspace is not archived;
- a boundary exists and is `shared`, or the user is its `owner_user_id`;
- a content-role row exists that is not revoked, has a non-null `content_consent_id`, and has role `reader` or `editor`.

That is the human branch of `householdAccessRefusal`, including `rights.revoked_at` (`command/household-objects.ts:99`).

`swarm_read.home_overview() RETURNS jsonb` is a `STABLE SECURITY DEFINER` plpgsql function with `search_path=swarm,pg_catalog`.
- **Viewer:** taken from the `sub` of `request.jwt.claims`, the same pattern as `signal_delivery_receipts`. It returns NULL when there is no sub, when the claims carry `agent_principal_id`, or when the role is not `authenticated`.
- **Messages:** read through the `swarm_read.signals` view itself, so directed-signal filtering is identical.
- **Locks:** none.
- **Bounds:** 50 workspaces, 25 people, 50 agents, 10 asks, 20 assigned and 20 waiting per workspace.
- **Ownership and grants:** owner `swarm_admin`; `REVOKE ALL FROM PUBLIC, anon, swarm_read, swarm_command`; `GRANT EXECUTE ON FUNCTION swarm_read.home_overview() TO authenticated`. `household_human_can_read` is not granted to anyone.

**Rollback:**

```sql
DROP FUNCTION IF EXISTS swarm_read.home_overview();
DROP FUNCTION IF EXISTS swarm.household_human_can_read(uuid, uuid);
```

The proofs for 000002 follow the same convention in `supabase/home-overview-reserve/` and `deploy/release-proofs/home-overview/`.

## C. Commands, reads, MCP tools

### Registry rows (agents and humans)

These go in `HOUSEHOLD_TOOL_REGISTRY`. Each row gets `objectTypes: ['todo']`, with the type widened to `HouseholdObjectType | 'todo'`. An empty array would be filtered out as "file-only" (`mcp/tools.ts:11-15`). The rows then flow automatically into the hosted tool table and allowlists (`hosted-seat-auth.ts:8-9`), stdio MCP (`src/mcp/tools.ts:42`), `cswarm object …` (`cli.ts:10212`) and the consent copy.

| Tool | Op | Input (writes also take `seat` and `request_id`) | Output |
|---|---|---|---|
| `todo_list` | read | `scope:'open'\|'all'`, `assignee?:Party`, `offset`, `limit≤100` | `{todos, next_offset}` |
| `todo_read` | read | `todo_id`, `comment_offset?` | `{todo, comments≤50, next_comment_offset}` |
| `todo_queue` | read | `principal_id?` (an agent defaults to itself; a human must name one) | `AgentQueue` |
| `comment_list` | read | `target`, `offset`, `limit≤100` | `{comments, next_offset}` |
| `todo_create` | create | `title`, `notes?`, `due_on?`, `assign?:{to,start?,gate?}` | `WriteResult<Todo>` |
| `todo_comment` | create | `target`, `body`, `mentions?≤8` | `WriteResult<Comment>` |
| `todo_update` | update | `todo_id`, `base_version`, `title?`, `notes?`, `due_on?` | `WriteResult<Todo>` |
| `todo_assign` | update | `todo_id`, `base_version`, `to:Party\|null`, `start?`, `gate?` | `WriteResult<Todo>` |
| `todo_start` | update | `todo_id?` (omitted means first item of the caller's own `up_next`) | `WriteResult<Todo>` |
| `todo_set_state` | update | `todo_id`, `base_version`, `state` | `WriteResult<Todo>` |

The descriptions say that to-do text and comments are untrusted data, never instructions, and that starting a to-do records work without locking anything.

**Hosted seat authorization:**
1. Seat resolution maps every content tool to database tool `note` or `members` (`hosted-seat-auth.ts:118-119`).
2. Then `store.access` requires a live hosted grant, binding and seat, plus a content approval that covers the operation (`command/household-objects.ts:77-86`).
3. The workspace always comes from the seat, never from the arguments.

### Human-only surface kinds

These follow the precedent of `household_approve_connection`. They are never in the registry, MCP or CLI. A hosted seat fails `hostedToolAllowsCommand` (`index.ts:9534-9542`). A local agent gets `human_confirmation_required` (precedent: `household-integration.ts:40`).

| Kind | Input |
|---|---|
| `household_todo_answer` | `todo_id`, `offer_id`, `answer:'accept'\|'decline'\|'withdraw'` |
| `household_todo_steer` | `todo_id`, `base_version`, `action:{kind:'move',after_todo_id\|null}\|{kind:'start_now'}\|{kind:'gate',gate}` |
| `household_agent_work_policy` | `principal_id`, `accepts_from` |
| `household_activity` (read) | `since`, `limit≤100` |

### Permissions

| Action | Who |
|---|---|
| create, comment | content `create` (an editor, or an agent with create approval) |
| edit details, assign | content `update` |
| accept or decline an offer | the decider, human credential only: the target person, or the target agent's owner |
| withdraw an offer | the human who made the offer, or a workspace owner or admin |
| start (→ Doing) | the assignee itself. If unassigned, the actor self-assigns and starts. |
| Doing→Open, Done, Dropped, reopen | the assignee side (the assignee, or the owner of the assignee agent), the creator (any credential of that user), or a workspace owner or admin. If unassigned: anyone with `update`. |
| steer (move, start now, gate) | the human owner of the assignee agent. A gate may also be released by the user who set it. |
| `accepts_from` | the human owner of the agent |

### What an assignment produces

| Target | Actor | Result |
|---|---|---|
| self, or your own principal | — | accepted, Open |
| a person P | someone else | offer, decided by P |
| agent A | any credential of A's owner | accepted; `now` puts it at the front and sends an ask |
| agent A with `anyone` | others, start `queue` or gated | accepted at the back |
| agent A | others asking `now`, or A has `owner` | offer, decided by A's owner |

- **Accepting** sets the assignee, ranks the to-do at the back (or the front if the offer was `now`) and applies the offer's gate.
- **Reassigning** returns the state to Open and replaces any pending offer (`answer:'replaced'`).
- **Ranks** are per `(workspace, principal)`. A move renumbers the agent's ranked items in one `TodoQueueOrdered` event.
- **Caps:** 200 to-dos in one agent's queue; 1000 open to-dos per workspace.

### Events

Events use `EventEnvelope`, `SCHEMA_VERSION` and a 64 KiB limit:
`TodoCreated`, `TodoDetailsChanged`, `TodoAssigned`, `TodoOffered`, `TodoOfferAnswered`, `TodoStateChanged`, `TodoQueueOrdered`, `TodoGateSet`, `TodoStartAsked`, `TodoCommented`, `AgentWorkPolicySet`.

`version` increments on every field change except `queue_rank`. Refusals are recorded as a receipt plus an audit row, with no event.

### Notices

Each command posts at most one signal. `about` is `todo:<uuid>` or `object:<id>`. The sender is the actor.

| Trigger | Kind | To | Body (fixed text) |
|---|---|---|---|
| accepted assignment to an agent, gate clear | note | the agent | "Added a to-do to your queue." |
| `now` accepted, or `start_now` | ask | the agent | "Please start the to-do at the front of your queue." |
| offer created | ask | the decider | "Asks you to take a to-do." / "Asks for a to-do for your agent." |
| offer answered (when the offerer is not the decider) | note | the offerer | "Accepted your to-do request." / "Declined …" |
| comment with mentions | note | the mentioned people and agents (≤8) | "Mentioned you in a comment." |

### Reads

**`todo_queue` returns:**
- `working`: Doing items, any number;
- `up_next`: Open, accepted and gate clear, ordered by rank;
- `not_yet`: gate not clear, with its kind;
- `requests`: pending offers to this agent;
- the agent's work status, `accepts_from`, and `content_access`, which comes from the agent's live `household_content_connections` approvals. The UI can then say "Claude can't read to-dos here yet."

**`home_overview`, per workspace:**
- **Workspace facts:** name and role.
- **Since you last looked:**
  - `last_seen_at`, the max of the viewer's receipts.
  - `new_messages`: visible signals not authored by the viewer, created after `last_seen_at`, capped at 99. If `last_seen_at` is null, the window is the last 7 days.
- **`content`:** null without `household_human_can_read`. Otherwise:
  - counts of open to-dos;
  - counts of lists, docs and files, taken from the projection's `objects[*].kind`;
  - `new_activity`: other people's to-do events and committed revisions since `last_seen_at`.
- **People:** each person with their agents. Each agent row has its facts plus queue counts; the counts are null without content access.
- **`needs_you`:**
  - `asks`: kind `ask` addressed to the viewer, unexpired, and with no reply from the viewer or the viewer's agents;
  - `assigned`: the viewer's Open and Doing to-dos;
  - `waiting`: offers the viewer decides; `after` gates on the viewer's unfinished to-dos; holds on the viewer's agents; to-dos left on the viewer's revoked agents (`agent_removed`).

  `assigned` and `waiting` are content and appear only with consent.

**Status.** `agentWorkState(facts, now)` lives in `src/protocol/household-todo-policy.ts`. The store uses it for `todo_queue`, and the site uses it for the overview. That keeps one translation, as `agent-status.ts:1-14` requires.

**Honest wording:**
- working: "Working on ‹title›, active N min ago";
- idle, hosted: "Checks messages when you chat with it" (`agent-status.ts:70`);
- an old claim: "Last active 3 h ago; ‹title› is still in Doing";
- never "online", "offline", "waiting for work" or "will start".

### Refusal codes

| Group | Codes |
|---|---|
| Access (existing) | `workspace_access_refused`, `content_consent_required`, `content_read_only`, `connection_access_refused`, `human_confirmation_required` |
| Domain | `todo_not_found`, `target_not_found`, `title_invalid`, `notes_invalid`, `due_invalid`, `comment_invalid`, `mentions_invalid`, `assignee_not_member`, `assignee_removed`, `invalid_transition`, `not_assignee`, `not_permitted`, `owner_only`, `offer_not_pending`, `not_decider`, `not_in_queue`, `gate_invalid`, `gate_cycle`, `queue_empty`, `queue_full`, `todo_limit_reached` |
| Concurrency and limits | stale `base_version` returns `{status:'conflict', current}`; `request_id_reused`; `todo_write_rate_limited` (reuses the 600/2000 per-hour constants under `todo:` bucket keys) |

## D. Client contract: `site/src/lib/home/contract.ts`

```ts
/** Wire contract for the consumer home server surface. UI lanes map FROM these types into
 * their own view models. Times are server time. No DOM, fetch or copy strings here. */
export type Uuid = string;
export type IsoTime = string;
export type LocalDate = string; // YYYY-MM-DD; a deadline only, never a wake

export type Party = { kind: 'user'; id: Uuid } | { kind: 'agent'; id: Uuid };
export interface Actor { user_id: Uuid; principal_id: Uuid | null }

export type TodoState = 'open' | 'doing' | 'done' | 'dropped';
export type TodoStart = 'queue' | 'now';
export type TodoGate =
  | { kind: 'none' } | { kind: 'hold'; note: string | null }
  | { kind: 'after'; todo_id: Uuid } | { kind: 'at'; at: IsoTime };

export interface TodoOffer {
  offer_id: Uuid; to: Party; decider_user_id: Uuid;
  start: TodoStart; gate: TodoGate; by: Actor; at: IsoTime;
}
export interface Todo {
  workspace_id: Uuid; todo_id: Uuid; version: number;
  title: string; notes: string; state: TodoState; due_on: LocalDate | null;
  created_by: Actor; created_at: IsoTime;
  assignee: Party | null; assigned_by: Actor | null; assigned_at: IsoTime | null;
  offer: TodoOffer | null;
  gate: TodoGate; gate_clear: boolean;   // evaluated with the server clock at read time
  queue_position: number | null;         // 1-based within the agent's up_next; else null
  state_by: Actor; state_at: IsoTime; comment_count: number;
}
export interface TodoRef { todo_id: Uuid; title: string; state: TodoState; due_on: LocalDate | null }

export type CommentTarget = { kind: 'todo'; id: Uuid } | { kind: 'list' | 'doc' | 'file'; id: string };
export interface Comment {
  comment_id: Uuid; target: CommentTarget; author: Actor;
  body: string; mentions: Party[]; created_at: IsoTime;
}
export type Notice =
  | { to: Party[]; status: 'sent'; signal_id: Uuid }
  | { to: Party[]; status: 'not_sent'; reason: 'signal_rate_limited' | 'recipient_not_live' };

export type AccessRefusal = 'workspace_access_refused' | 'content_consent_required'
  | 'content_read_only' | 'connection_access_refused' | 'human_confirmation_required';
export type TodoRefusal = AccessRefusal | 'todo_not_found' | 'target_not_found' | 'title_invalid'
  | 'notes_invalid' | 'due_invalid' | 'comment_invalid' | 'mentions_invalid' | 'assignee_not_member'
  | 'assignee_removed' | 'invalid_transition' | 'not_assignee' | 'not_permitted' | 'owner_only'
  | 'offer_not_pending' | 'not_decider' | 'not_in_queue' | 'gate_invalid' | 'gate_cycle'
  | 'queue_empty' | 'queue_full' | 'todo_limit_reached' | 'request_id_reused' | 'todo_write_rate_limited';
export type WriteResult<T> =
  | { status: 'committed'; value: T; notices: Notice[]; replayed: boolean }
  | { status: 'conflict'; current: Todo }
  | { status: 'refused'; reason: TodoRefusal };

export type AgentWork = 'working' | 'idle' | 'disconnected';
export interface AgentWorkFacts {
  transport: 'local' | 'hosted_mcp'; turn_only: boolean;
  connection: 'live' | 'removed' | 'key_off' | 'key_ended' | 'paused';
  last_activity_at: IsoTime | null;            // latest server-recorded action by this agent
  messages_waiting_since: IsoTime | null;
  doing: { todo_id: Uuid; title: string | null; since: IsoTime } | null; // title null without content access
  working_on: { signal_id: Uuid; at: IsoTime; until: IsoTime } | null;
}
export interface AgentWorkStatus { work: AgentWork; facts: AgentWorkFacts } // from agentWorkState()
export interface QueueCounts { working: number; up_next: number; not_yet: number; requests: number }

export interface AgentQueue {
  workspace_id: Uuid; principal_id: Uuid; owner_user_id: Uuid;
  accepts_from: 'anyone' | 'owner'; content_access: 'none' | 'read' | 'read_write';
  status: AgentWorkStatus;
  working: Todo[]; up_next: Todo[]; not_yet: Todo[]; requests: Todo[]; read_at: IsoTime;
}

export interface WorkspaceCatchUp {
  workspace_id: Uuid; name: string; role: 'owner' | 'admin' | 'member';
  last_seen_at: IsoTime | null; new_messages: number;           // capped at 99
  content: { open_todos: number; lists: number; docs: number; files: number; new_activity: number } | null;
  people: Array<{ user_id: Uuid; display_name: string; role: 'owner' | 'admin' | 'member'; is_viewer: boolean;
    agents: Array<{ principal_id: Uuid; name: string; status: AgentWorkStatus; queue: QueueCounts | null }> }>;
  needs_you: {
    asks: Array<{ signal_id: Uuid; from: Party; created_at: IsoTime; until: IsoTime }>;
    assigned: TodoRef[];
    waiting: Array<TodoRef & { reason: 'request' | 'after' | 'hold' | 'agent_removed'; agent_id: Uuid | null }>;
  };
}
export interface HomeOverview { viewer_user_id: Uuid; generated_at: IsoTime; workspaces: WorkspaceCatchUp[] }

export type ActivityEvent = 'created' | 'updated' | 'assigned' | 'requested' | 'accepted' | 'declined'
  | 'started' | 'done' | 'dropped' | 'reopened' | 'commented';
export interface ActivityItem {
  at: IsoTime; key: string; actor: Actor; event: ActivityEvent; title: string;
  object: { kind: 'todo'; id: Uuid } | { kind: 'list' | 'doc' | 'file'; id: string };
}

export interface AssignInput { to: Party; start?: TodoStart; gate?: TodoGate }
export type SteerAction = { kind: 'move'; after_todo_id: Uuid | null } | { kind: 'start_now' }
  | { kind: 'gate'; gate: TodoGate };

export interface HomeServer {
  overview(): Promise<HomeOverview>;                                   // rpc swarm_read.home_overview
  activity(workspaceId: Uuid, since: IsoTime, limit: number): Promise<ActivityItem[]>; // newest first
  listTodos(workspaceId: Uuid, q: { scope: 'open' | 'all'; assignee?: Party; offset: number; limit: number }):
    Promise<{ todos: Todo[]; next_offset: number | null }>;
  readTodo(workspaceId: Uuid, todoId: Uuid, commentOffset?: number):
    Promise<{ todo: Todo; comments: Comment[]; next_comment_offset: number | null }>;
  listComments(workspaceId: Uuid, target: CommentTarget, offset: number, limit: number):
    Promise<{ comments: Comment[]; next_offset: number | null }>;
  agentQueue(workspaceId: Uuid, principalId: Uuid): Promise<AgentQueue>;
  createTodo(workspaceId: Uuid, input: { title: string; notes?: string; due_on?: LocalDate | null;
    assign?: AssignInput }, requestId: string): Promise<WriteResult<Todo>>;
  updateTodo(workspaceId: Uuid, input: { todo_id: Uuid; base_version: number; title?: string;
    notes?: string; due_on?: LocalDate | null }, requestId: string): Promise<WriteResult<Todo>>;
  assignTodo(workspaceId: Uuid, input: { todo_id: Uuid; base_version: number }
    & ({ to: null } | AssignInput), requestId: string): Promise<WriteResult<Todo>>;
  setTodoState(workspaceId: Uuid, input: { todo_id: Uuid; base_version: number; state: TodoState },
    requestId: string): Promise<WriteResult<Todo>>;
  startTodo(workspaceId: Uuid, input: { todo_id: Uuid }, requestId: string): Promise<WriteResult<Todo>>;
  answerRequest(workspaceId: Uuid, input: { todo_id: Uuid; offer_id: Uuid;
    answer: 'accept' | 'decline' | 'withdraw' }, requestId: string): Promise<WriteResult<Todo>>;
  steerQueue(workspaceId: Uuid, input: { todo_id: Uuid; base_version: number; action: SteerAction },
    requestId: string): Promise<WriteResult<Todo>>;
  setWorkPolicy(workspaceId: Uuid, input: { principal_id: Uuid; accepts_from: 'anyone' | 'owner' },
    requestId: string): Promise<WriteResult<{ principal_id: Uuid; accepts_from: 'anyone' | 'owner' }>>;
  comment(workspaceId: Uuid, input: { target: CommentTarget; body: string; mentions: Party[] },
    requestId: string): Promise<WriteResult<Comment>>;
}
```

**How the client calls the server:**
- Registry tools go through `postCommand({kind:'household_tool', tool, arguments:{seat: HOUSEHOLD_LOCAL_SEAT, request_id, …}})`.
- Human-only actions go through `postCommand({kind:'household_todo_*' | 'household_agent_work_policy' | 'household_activity', …})`.
- `overview()` calls `client().schema('swarm_read').rpc('home_overview')`.
- "Seen" stays on the existing `reportBrowserSignalsSeen`.

## E. Lanes

**Hotspots.** One writer, in lane L4, owns all of these:
- `supabase/functions/command/index.ts`
- `supabase/functions/command/household-integration.ts`
- `src/protocol/household-tool-registry.ts`
- `src/protocol/index.ts`
- `scripts/build-admin-types.mjs` (roots list and `emitted.size !== 12`)
- the generated `supabase/functions/_shared/protocol.js` and `*.d.ts`
- the pinned counts: `tests/household-tool-registry.test.ts:49` (8), `tests/hosted-mcp-protocol.test.ts:144,522` (13), and `tests/p1-cli/fixtures/command-dispatch-baseline-counts.json`
- `tests/p1-cli/citation-drift.test.ts` and `tests/p1-cli/mcp-stdio.test.ts`

The Lead alone edits `tests/lists/*` and `package.json`.

**L1 Core (pure). Starts now.**
- **Owns:** new `src/protocol/household-todos.ts` (types, events, `decideTodo`, `reduceTodoEvents`, `evaluateGate`, acceptance rule) and new `src/protocol/household-todo-policy.ts` (limits, `WORK_RECENT_MS = 30 min`, `agentWorkState`, notice `about` prefixes).
- **Tests:** `tests/household-todos.test.ts`, covering the transition and permission matrix, acceptance by policy, gates (at, after, hold, cycle), queue renumbering, deterministic replay and the status table. The Lead registers it in `test.txt`.
- **Checks:** one checker.

**L2 Migration and store. Starts now** against the C and D signatures, with the core injected as dependencies like `createHouseholdObjectStore`.
- **Owns:** `20261006000001_household_todos.sql`; `supabase/household-todo-reserve/*` and `deploy/release-proofs/household-todo/*`; `supabase/functions/command/household-todos.ts` (exporting `createHouseholdTodoStore({core, access, notice})`, with `notice` as a port interface).
- **Tests:**
  - pure: `tests/household-todo-proofs.test.ts`, byte equality between the reserve and release-proof files;
  - CI/docker: `tests/p1-server/household-todos.test.ts`, covering ACLs and RLS, the append-only triggers, rollback plus catalog proofs, foreign-workspace, revoked-principal, reader and no-approval refusals paired with positive controls, a retry yielding one event and one notice, `request_id_reused`, and serialized concurrent moves.
- **Checks:** two checkers.

**L3 Overview and activity. Starts now; merges after L2.**
- **Owns:** `20261006000002_home_overview.sql`, its reserve and proofs, and new `supabase/functions/command/household-activity.ts` (to-do events plus projection history).
- **Tests:**
  - pure: `tests/home-overview-proofs.test.ts`;
  - CI: `tests/p1-server/home-overview.test.ts`, covering parity between `household_human_can_read` and `householdAccessRefusal` over a fixture matrix; content null without consent; only the viewer's live workspaces; directed asks only for the viewer; `last_seen_at` equal to the receipt max; a removed member sees nothing; anon and agent claims get NULL.
- **Checks:** two checkers.

**L4 Integration. After L1, L2 and L3 land.**
- **Owns:** all hotspots above.
- **Work:**
  - add 10 registry rows and widen `objectTypes`;
  - update the consent copy;
  - add the surface kinds and branches;
  - add a `householdNotice` closure beside `postSignal`, passed in at `index.ts:10807`;
  - regenerate the bundle once.
- **Tests:**
  - count updates: 8 to 18 registry rows, 13 to 23 hosted tools, plus the baseline fixture;
  - CI: `tests/p1-server/household-todo-mcp.test.ts`, a hosted round trip (create → assign to agent → `todo_queue` → `todo_start` → done), checking a `signal_deliveries` row for the agent, no second signal on replay, human-only kinds refused for hosted and local agents, and seat A unable to read workspace B.
- **Checks:** two checkers.

**L5 Site contract. Starts now; first commit is the contract alone.**
- **Owns:** `site/src/lib/home/{contract,fixtures,client}.ts`. It does not edit `commonswarm.ts`.
- **Tests:** `site/src/lib/home-contract.test.mjs`. It must sit at this top-level path, because the gate glob is `src/lib/*.test.mjs` (GAP-TABLE:53).
- **Checks:** one checker.

**Order:**
1. L1, L2, L3 and L5 run in parallel; their files are disjoint.
2. Merge L1 → L2 → L3.
3. L4.
4. The UI lanes switch from fixtures to `client.ts`.

The SWARM-CLOUD amendment (to-do object and status definitions) belongs to the Lead or a docs lane.

## F. Open questions for Tom, and risks

1. **Supersede the single task identity in TASKS:46-49 for consumer to-dos?** Recommendation: yes. Governed tasks stay for repository work, a later bridge can link the two, and the decision is recorded in SWARM-CLOUD with HezLead's sign-off.
2. **Should `accepts_from` default to `owner`, so that work from others is a request** until the owner chooses during Add-Agent? Recommendation: yes. It fails closed, and nothing is preselected, matching D5.
3. **"At a set time" sends no ping.** The agent sees the to-do only at its next check, or for hosted agents, its next chat. Recommendation: accept this for v1 with copy like "Joins Claude's queue at 9:00 pm; Claude sees it the next time it checks." The durable reminder dispatcher (TASKS:243-266) becomes a later lane.

**Risks:**
- The workspace `FOR UPDATE` lock serializes household reads and writes.
- The SQL access check can drift from `householdAccessRefusal`; the L3 parity test guards it.
- Hosted activity can only be measured from signals, check batches and events.
- Rolling back after real use destroys to-dos unless they are exported first.

### Critical Files for Implementation
- /Users/yulanbot/work/wt/home-ui/supabase/functions/command/household-integration.ts
- /Users/yulanbot/work/wt/home-ui/supabase/functions/command/household-objects.ts
- /Users/yulanbot/work/wt/home-ui/src/protocol/household-tool-registry.ts
- /Users/yulanbot/work/wt/home-ui/supabase/functions/command/index.ts
- /Users/yulanbot/work/wt/home-ui/supabase/migrations/20261004000002_household_object_streams.sql