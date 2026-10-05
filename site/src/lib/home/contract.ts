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
