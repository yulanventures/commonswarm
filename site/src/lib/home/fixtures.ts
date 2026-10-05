import type {
  ActivityItem,
  Actor,
  AgentQueue,
  AgentWorkStatus,
  Comment,
  HomeOverview,
  IsoTime,
  Party,
  Todo,
  TodoGate,
  TodoState,
  TodoSummary,
  Uuid,
} from './contract.ts';

/** Exported anchor time for fixture-relative timestamps and gate evaluation. */
export const FIXED_NOW: IsoTime = '2026-10-05T18:00:00.000Z';

const ms = (offset: number): IsoTime => new Date(Date.parse(FIXED_NOW) + offset).toISOString();
const hours = (n: number): number => n * 3_600_000;

export const IDS = {
  users: {
    tom: 'a1000001-0001-4000-8000-000000000001' as Uuid,
    nikki: 'a1000001-0001-4000-8000-000000000002' as Uuid,
    priya: 'a1000001-0001-4000-8000-000000000003' as Uuid,
  },
  agents: {
    claude: 'b1000001-0001-4000-8000-000000000001' as Uuid,
    dot: 'b1000001-0001-4000-8000-000000000002' as Uuid,
    muse: 'b1000001-0001-4000-8000-000000000003' as Uuid,
    priyaClaude: 'b1000001-0001-4000-8000-000000000004' as Uuid,
    orphan: 'b1000001-0001-4000-8000-000000000005' as Uuid,
  },
  workspaces: {
    home: 'c1000001-0001-4000-8000-000000000001' as Uuid,
    trip: 'c1000001-0001-4000-8000-000000000002' as Uuid,
    paperwork: 'c1000001-0001-4000-8000-000000000003' as Uuid,
  },
  todos: {
    openUnassigned: 'd1000001-0001-4000-8000-000000000001' as Uuid,
    assignedTom: 'd1000001-0001-4000-8000-000000000002' as Uuid,
    requestNikki: 'd1000001-0001-4000-8000-000000000003' as Uuid,
    claudeUp1: 'd1000001-0001-4000-8000-000000000004' as Uuid,
    claudeUp2: 'd1000001-0001-4000-8000-000000000005' as Uuid,
    claudeUp3: 'd1000001-0001-4000-8000-000000000006' as Uuid,
    claudeDoing: 'd1000001-0001-4000-8000-000000000007' as Uuid,
    gateHold: 'd1000001-0001-4000-8000-000000000008' as Uuid,
    gateAfterBlocked: 'd1000001-0001-4000-8000-000000000009' as Uuid,
    gateAfterClear: 'd1000001-0001-4000-8000-000000000010' as Uuid,
    gateAtFuture: 'd1000001-0001-4000-8000-000000000011' as Uuid,
    gateAtPast: 'd1000001-0001-4000-8000-000000000012' as Uuid,
    done: 'd1000001-0001-4000-8000-000000000013' as Uuid,
    dropped: 'd1000001-0001-4000-8000-000000000014' as Uuid,
    dotDisconnected: 'd1000001-0001-4000-8000-000000000015' as Uuid,
    requestClaude: 'd1000001-0001-4000-8000-000000000016' as Uuid,
    tomAfterBlocked: 'd1000001-0001-4000-8000-000000000017' as Uuid,
    tripOpen: 'd1000001-0001-4000-8000-000000000018' as Uuid,
    paperOpen: 'd1000001-0001-4000-8000-000000000019' as Uuid,
    orphanRemoved: 'd1000001-0001-4000-8000-000000000020' as Uuid,
  },
  offers: {
    nikki: 'e1000001-0001-4000-8000-000000000001' as Uuid,
    claude: 'e1000001-0001-4000-8000-000000000002' as Uuid,
  },
  comments: {
    mention: 'f1000001-0001-4000-8000-000000000001' as Uuid,
    thread: 'f1000001-0001-4000-8000-000000000002' as Uuid,
  },
  signals: {
    askPriya: 's1000001-0001-4000-8000-000000000001' as Uuid,
  },
} as const;

const { users: U, agents: A, workspaces: W, todos: T, offers: O, comments: C, signals: S } = IDS;

const actor = (userId: Uuid, principalId: Uuid | null = null): Actor => ({
  user_id: userId,
  principal_id: principalId,
});

const user = (id: Uuid): Party => ({ kind: 'user', id });
const agentParty = (id: Uuid): Party => ({ kind: 'agent', id });

const gateNone = (): TodoGate => ({ kind: 'none' });

function todo(
  todoId: Uuid,
  workspaceId: Uuid,
  title: string,
  fields: Partial<Todo> & Pick<Todo, 'state' | 'gate' | 'gate_clear'>,
): Todo {
  return {
    workspace_id: workspaceId,
    todo_id: todoId,
    version: fields.version ?? 1,
    title,
    notes: fields.notes ?? '',
    state: fields.state,
    due_on: fields.due_on ?? null,
    created_by: fields.created_by ?? actor(U.tom),
    created_at: fields.created_at ?? ms(-hours(48)),
    assignee: fields.assignee ?? null,
    assigned_by: fields.assigned_by ?? null,
    assigned_at: fields.assigned_at ?? null,
    offer: fields.offer ?? null,
    gate: fields.gate,
    gate_clear: fields.gate_clear,
    queue_position: fields.queue_position ?? null,
    state_by: fields.state_by ?? actor(U.tom),
    state_at: fields.state_at ?? ms(-hours(1)),
    comment_count: fields.comment_count ?? 0,
  };
}

/** Summary projection shared by the sample list and agent line. Details stay in readTodo. */
export function todoSummary(row: Todo): TodoSummary {
  return {
    todo_id: row.todo_id, version: row.version, title: row.title, state: row.state,
    due_on: row.due_on, assignee: row.assignee,
    offer: row.offer ? {
      offer_id: row.offer.offer_id, to: row.offer.to,
      decider_user_id: row.offer.decider_user_id, start: row.offer.start,
    } : null,
    gate: {
      kind: row.gate.kind, clear: row.gate_clear,
      todo_id: row.gate.kind === 'after' ? row.gate.todo_id : null,
      at: row.gate.kind === 'at' ? row.gate.at : null,
    },
    queue_position: row.queue_position, comment_count: row.comment_count, state_at: row.state_at,
  };
}

const claudeStatus: AgentWorkStatus = {
  work: 'working',
  facts: {
    transport: 'hosted_mcp',
    turn_only: true,
    connection: 'live',
    last_activity_at: ms(-minutes(12)),
    messages_waiting_since: null,
    doing: { todo_id: T.claudeDoing, title: 'Sort receipts for October', since: ms(-minutes(25)) },
    working_on: null,
  },
};

const dotStatus: AgentWorkStatus = {
  work: 'disconnected',
  facts: {
    transport: 'local',
    turn_only: false,
    connection: 'key_off',
    last_activity_at: ms(-hours(30)),
    messages_waiting_since: ms(-hours(2)),
    doing: null,
    working_on: null,
  },
};

const museStatus: AgentWorkStatus = {
  work: 'idle',
  facts: {
    transport: 'hosted_mcp',
    turn_only: true,
    connection: 'live',
    last_activity_at: ms(-hours(3)),
    messages_waiting_since: null,
    doing: null,
    working_on: null,
  },
};

const priyaClaudeStatus: AgentWorkStatus = {
  work: 'idle',
  facts: {
    transport: 'hosted_mcp',
    turn_only: true,
    connection: 'live',
    last_activity_at: ms(-hours(5)),
    messages_waiting_since: null,
    doing: null,
    working_on: null,
  },
};

const orphanStatus: AgentWorkStatus = {
  work: 'disconnected',
  facts: {
    transport: 'local',
    turn_only: false,
    connection: 'removed',
    last_activity_at: ms(-hours(72)),
    messages_waiting_since: null,
    doing: null,
    working_on: null,
  },
};

function minutes(n: number): number {
  return n * 60_000;
}

const homeTodos: Todo[] = [
  todo(T.openUnassigned, W.home, 'Plan weekend errands', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
  }),
  todo(T.assignedTom, W.home, 'Renew car registration', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: user(U.tom),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(6)),
  }),
  todo(T.requestNikki, W.home, 'Pick up dry cleaning', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    offer: {
      offer_id: O.nikki,
      to: user(U.nikki),
      decider_user_id: U.nikki,
      start: 'queue',
      gate: gateNone(),
      by: actor(U.tom),
      at: ms(-hours(4)),
    },
  }),
  todo(T.claudeUp1, W.home, 'Summarize the insurance letter', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(10)),
    queue_position: 1,
  }),
  todo(T.claudeUp2, W.home, 'Draft reply to school notice', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(9)),
    queue_position: 2,
  }),
  todo(T.claudeUp3, W.home, 'Check calendar conflicts for Thursday', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(8)),
    queue_position: 3,
  }),
  todo(T.claudeDoing, W.home, 'Sort receipts for October', {
    state: 'doing',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(7)),
    state_by: actor(U.tom, A.claude),
    state_at: ms(-minutes(25)),
  }),
  todo(T.gateHold, W.home, 'Wait for Tom to approve paint colors', {
    state: 'open',
    gate: { kind: 'hold', note: 'Hold until the samples arrive' },
    gate_clear: false,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(5)),
  }),
  todo(T.gateAfterBlocked, W.home, 'File taxes after W-2 arrives', {
    state: 'open',
    gate: { kind: 'after', todo_id: T.tomAfterBlocked },
    gate_clear: false,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(5)),
  }),
  todo(T.gateAfterClear, W.home, 'Send thank-you notes after party', {
    state: 'open',
    gate: { kind: 'after', todo_id: T.done },
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(4)),
    queue_position: 4,
  }),
  todo(T.gateAtFuture, W.home, 'Join Claude’s line at 9:00 pm', {
    state: 'open',
    gate: { kind: 'at', at: ms(hours(3)) },
    gate_clear: false,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(3)),
  }),
  todo(T.gateAtPast, W.home, 'Review pantry inventory', {
    state: 'open',
    gate: { kind: 'at', at: ms(-hours(2)) },
    gate_clear: true,
    assignee: agentParty(A.claude),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(3)),
    queue_position: 5,
  }),
  todo(T.done, W.home, 'Book dentist appointment', {
    state: 'done',
    gate: gateNone(),
    gate_clear: true,
    assignee: user(U.tom),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(72)),
    state_at: ms(-hours(20)),
  }),
  todo(T.dropped, W.home, 'Old idea for a garage sale', {
    state: 'dropped',
    gate: gateNone(),
    gate_clear: true,
    state_at: ms(-hours(48)),
  }),
  todo(T.dotDisconnected, W.home, 'Sync local notes folder', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.dot),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(36)),
    queue_position: 1,
  }),
  todo(T.requestClaude, W.home, 'Research summer camps for Priya', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    offer: {
      offer_id: O.claude,
      to: agentParty(A.claude),
      decider_user_id: U.tom,
      start: 'now',
      gate: gateNone(),
      by: actor(U.priya),
      at: ms(-hours(2)),
    },
  }),
  todo(T.tomAfterBlocked, W.home, 'Collect W-2 from employer portal', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: user(U.tom),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(12)),
  }),
  todo(T.orphanRemoved, W.home, 'Finish archived project notes', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: agentParty(A.orphan),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(100)),
  }),
];

const tripTodos: Todo[] = [
  todo(T.tripOpen, W.trip, 'Confirm rental car pickup', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
    assignee: user(U.tom),
    assigned_by: actor(U.tom),
    assigned_at: ms(-hours(15)),
  }),
];

const paperTodos: Todo[] = [
  todo(T.paperOpen, W.paperwork, 'Scan passport renewal form', {
    state: 'open',
    gate: gateNone(),
    gate_clear: true,
  }),
];

const homeComments: Comment[] = [
  {
    comment_id: C.mention,
    target: { kind: 'todo', id: T.claudeDoing },
    author: actor(U.nikki),
    body: 'Can you loop in Tom when the totals look right?',
    mentions: [user(U.tom), agentParty(A.claude)],
    created_at: ms(-minutes(40)),
  },
  {
    comment_id: C.thread,
    target: { kind: 'todo', id: T.assignedTom },
    author: actor(U.tom),
    body: 'Tagged Nikki for a second opinion.',
    mentions: [user(U.nikki)],
    created_at: ms(-hours(3)),
  },
];

homeTodos.find((row) => row.todo_id === T.claudeDoing)!.comment_count = 1;
homeTodos.find((row) => row.todo_id === T.assignedTom)!.comment_count = 1;

const homeSummaries = homeTodos.map(todoSummary);

const claudeQueue: AgentQueue = {
  workspace_id: W.home,
  principal_id: A.claude,
  owner_user_id: U.tom,
  accepts_from: 'owner',
  content_access: 'read_write',
  status: claudeStatus,
  working: homeSummaries.filter((row) => row.todo_id === T.claudeDoing),
  up_next: homeSummaries.filter((row) =>
    [T.claudeUp1, T.claudeUp2, T.claudeUp3, T.gateAfterClear, T.gateAtPast].includes(row.todo_id)),
  not_yet: homeSummaries.filter((row) =>
    [T.gateHold, T.gateAfterBlocked, T.gateAtFuture].includes(row.todo_id)),
  requests: homeSummaries.filter((row) => row.todo_id === T.requestClaude),
  read_at: FIXED_NOW,
  next_offset: { working: null, up_next: null, not_yet: null, requests: null },
};

const dotQueue: AgentQueue = {
  workspace_id: W.home,
  principal_id: A.dot,
  owner_user_id: U.tom,
  accepts_from: 'owner',
  content_access: 'read_write',
  status: dotStatus,
  working: [],
  up_next: homeSummaries.filter((row) => row.todo_id === T.dotDisconnected),
  not_yet: [],
  requests: [],
  read_at: FIXED_NOW,
  next_offset: { working: null, up_next: null, not_yet: null, requests: null },
};

const museQueue: AgentQueue = {
  workspace_id: W.home,
  principal_id: A.muse,
  owner_user_id: U.nikki,
  accepts_from: 'owner',
  content_access: 'read',
  status: museStatus,
  working: [],
  up_next: [],
  not_yet: [],
  requests: [],
  read_at: FIXED_NOW,
  next_offset: { working: null, up_next: null, not_yet: null, requests: null },
};

const homeActivity: ActivityItem[] = [
  {
    at: ms(-minutes(25)),
    key: `${W.home}:${T.claudeDoing}:started`,
    actor: actor(U.tom, A.claude),
    event: 'started',
    title: 'Sort receipts for October',
    object: { kind: 'todo', id: T.claudeDoing },
  },
  {
    at: ms(-hours(4)),
    key: `${W.home}:${T.requestNikki}:requested`,
    actor: actor(U.tom),
    event: 'requested',
    title: 'Pick up dry cleaning',
    object: { kind: 'todo', id: T.requestNikki },
  },
  {
    at: ms(-hours(6)),
    key: `${W.home}:${T.assignedTom}:assigned`,
    actor: actor(U.tom),
    event: 'assigned',
    title: 'Renew car registration',
    object: { kind: 'todo', id: T.assignedTom },
  },
  {
    at: ms(-hours(20)),
    key: `${W.home}:${T.done}:done`,
    actor: actor(U.tom),
    event: 'done',
    title: 'Book dentist appointment',
    object: { kind: 'todo', id: T.done },
  },
  {
    at: ms(-hours(48)),
    key: `${W.home}:list-groceries:updated`,
    actor: actor(U.nikki),
    event: 'updated',
    title: 'Groceries',
    object: { kind: 'list', id: 'list-groceries' },
  },
];

const homeOverview: HomeOverview = {
  viewer_user_id: U.tom,
  generated_at: FIXED_NOW,
  workspaces: [
    {
      workspace_id: W.home,
      name: 'Home',
      role: 'owner',
      last_seen_at: ms(-hours(8)),
      new_messages: 3,
      content: { open_todos: 16, lists: 2, docs: 1, files: 4, new_activity: 0 },
      people: [
        {
          user_id: U.tom,
          display_name: 'Tom Langridge',
          role: 'owner',
          is_viewer: true,
          agents: [
            { principal_id: A.claude, name: 'Claude', status: claudeStatus, queue: { working: 1, up_next: 5, not_yet: 3, requests: 1 } },
            { principal_id: A.dot, name: 'dot', status: dotStatus, queue: { working: 0, up_next: 1, not_yet: 0, requests: 0 } },
          ],
        },
        {
          user_id: U.nikki,
          display_name: 'Nikki Langridge',
          role: 'member',
          is_viewer: false,
          agents: [
            { principal_id: A.muse, name: 'Muse', status: museStatus, queue: { working: 0, up_next: 0, not_yet: 0, requests: 0 } },
          ],
        },
        {
          user_id: U.priya,
          display_name: 'Priya Shah',
          role: 'member',
          is_viewer: false,
          agents: [
            { principal_id: A.priyaClaude, name: 'Claude', status: priyaClaudeStatus, queue: { working: 0, up_next: 0, not_yet: 0, requests: 0 } },
          ],
        },
      ],
      needs_you: {
        asks: [
          {
            signal_id: S.askPriya,
            from: user(U.priya),
            created_at: ms(-hours(1)),
            until: ms(hours(23)),
          },
        ],
        assigned: [
          { todo_id: T.assignedTom, title: 'Renew car registration', state: 'open', due_on: null },
          { todo_id: T.tomAfterBlocked, title: 'Collect W-2 from employer portal', state: 'open', due_on: null },
        ],
        waiting: [
          { todo_id: T.requestClaude, title: 'Research summer camps for Priya', state: 'open', due_on: null, reason: 'request', agent_id: A.claude },
          { todo_id: T.gateAfterBlocked, title: 'File taxes after W-2 arrives', state: 'open', due_on: null, reason: 'after', agent_id: A.claude },
          { todo_id: T.gateHold, title: 'Wait for Tom to approve paint colors', state: 'open', due_on: null, reason: 'hold', agent_id: A.claude },
          { todo_id: T.orphanRemoved, title: 'Finish archived project notes', state: 'open', due_on: null, reason: 'agent_removed', agent_id: A.orphan },
        ],
      },
    },
    {
      workspace_id: W.trip,
      name: 'Summer trip',
      role: 'owner',
      last_seen_at: null,
      new_messages: 0,
      content: { open_todos: 1, lists: 1, docs: 0, files: 2, new_activity: 0 },
      people: [
        {
          user_id: U.tom,
          display_name: 'Tom Langridge',
          role: 'owner',
          is_viewer: true,
          agents: [],
        },
        {
          user_id: U.nikki,
          display_name: 'Nikki Langridge',
          role: 'member',
          is_viewer: false,
          agents: [],
        },
      ],
      needs_you: {
        asks: [],
        assigned: [{ todo_id: T.tripOpen, title: 'Confirm rental car pickup', state: 'open', due_on: null }],
        waiting: [],
      },
    },
    {
      workspace_id: W.paperwork,
      name: 'My paperwork',
      role: 'member',
      last_seen_at: ms(-hours(30)),
      new_messages: 12,
      content: null,
      people: [
        {
          user_id: U.nikki,
          display_name: 'Nikki Langridge',
          role: 'owner',
          is_viewer: false,
          agents: [],
        },
        {
          user_id: U.tom,
          display_name: 'Tom Langridge',
          role: 'member',
          is_viewer: true,
          agents: [],
        },
      ],
      needs_you: { asks: [], assigned: [], waiting: [] },
    },
  ],
};

/** Synthetic message metadata only; never customer content or credentials. */
export interface FixtureMessage {
  signal_id: Uuid;
  author: Actor;
  created_at: IsoTime;
  recipients: Party[] | null; // null is a workspace message; otherwise viewer must be addressed
}

export interface HomeFixtures {
  fixedNow: IsoTime;
  overview: HomeOverview;
  todosByWorkspace: Record<Uuid, Todo[]>;
  commentsByWorkspace: Record<Uuid, Comment[]>;
  queues: Record<Uuid, AgentQueue>;
  activityByWorkspace: Record<Uuid, ActivityItem[]>;
  messagesByWorkspace: Record<Uuid, FixtureMessage[]>;
  otherAgents: Array<{ principal_id: Uuid; name: string; status: AgentWorkStatus }>;
}

export const HOME_FIXTURES: HomeFixtures = {
  fixedNow: FIXED_NOW,
  overview: homeOverview,
  todosByWorkspace: {
    [W.home]: homeTodos,
    [W.trip]: tripTodos,
    [W.paperwork]: paperTodos,
  },
  commentsByWorkspace: {
    [W.home]: homeComments,
    [W.trip]: [],
    [W.paperwork]: [],
  },
  queues: {
    [A.claude]: claudeQueue,
    [A.dot]: dotQueue,
    [A.muse]: museQueue,
  },
  activityByWorkspace: {
    [W.home]: homeActivity,
    [W.trip]: [],
    [W.paperwork]: [],
  },
  messagesByWorkspace: {
    [W.home]: [
      { signal_id: S.askPriya, author: actor(U.priya), created_at: ms(-hours(1)), recipients: [user(U.tom)] },
      { signal_id: 'home-nikki-note', author: actor(U.nikki), created_at: ms(-hours(2)), recipients: null },
      { signal_id: 'home-muse-note', author: actor(U.nikki, A.muse), created_at: ms(-hours(3)), recipients: [user(U.tom)] },
      { signal_id: 'home-own-note', author: actor(U.tom), created_at: ms(-hours(1)), recipients: null },
      { signal_id: 'home-own-agent-note', author: actor(U.tom, A.claude), created_at: ms(-hours(1)), recipients: null },
      { signal_id: 'home-old-note', author: actor(U.nikki), created_at: ms(-hours(9)), recipients: null },
      { signal_id: 'home-boundary-note', author: actor(U.nikki), created_at: ms(-hours(8)), recipients: null },
      { signal_id: 'home-other-recipient', author: actor(U.priya), created_at: ms(-hours(1)), recipients: [user(U.nikki)] },
    ],
    [W.trip]: [
      { signal_id: 'trip-old-note', author: actor(U.nikki), created_at: ms(-hours(8 * 24)), recipients: null },
      { signal_id: 'trip-boundary-note', author: actor(U.nikki), created_at: ms(-hours(7 * 24)), recipients: null },
      { signal_id: 'trip-own-note', author: actor(U.tom), created_at: ms(-hours(1)), recipients: null },
    ],
    [W.paperwork]: Array.from({ length: 12 }, (_, index) => ({
      signal_id: `paperwork-note-${index + 1}`, author: actor(U.nikki),
      created_at: ms(-hours(index + 1)), recipients: null,
    })),
  },
  otherAgents: [{ principal_id: A.orphan, name: 'Orphan', status: orphanStatus }],
};

/** Evaluate whether a gate is clear at a given server time. */
export function gateClearAt(gate: TodoGate, states: ReadonlyMap<Uuid, TodoState>, now: IsoTime): boolean {
  switch (gate.kind) {
    case 'none':
      return true;
    case 'hold':
      return false;
    case 'after': {
      const state = states.get(gate.todo_id);
      return state === 'done' || state === 'dropped';
    }
    case 'at':
      return now >= gate.at;
    default:
      return false;
  }
}
