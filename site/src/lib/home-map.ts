/** Home integration: wire facts become UI models here, never in DOM builders. */
import { homeAgentState, type HomeAgentStatusInput } from "./agent-status";
import { agentLabel, firstNames, initials, formatWhen, personTint } from "./home-names";
import { foldIdentityName } from "./identity-label";
import { disambiguateVisibleLabels } from "./home-visible-labels";
import { groupParticipantsByOwner, type RailAgent, type RailMember } from "./participant-rail";
import { parseRoute, routeHref, type HomeRoute } from "./home-route";
import { catchUpPeopleSummary, type CatchUpVM, type CatchUpWorkspaceCardVM } from "./home-catchup";
import { RAIL_CATCH_UP_PEOPLE_TITLE, railAgentOwnerPhrase } from "./home-rail";
import type { AgentVM, PersonVM, RailVM, NeedsYouVM } from "./home-types";
import type { AgentWorkStatus, HomeOverview, WorkspaceCatchUp } from "./home/contract";
import type { AgentAccessStatus, Signal } from "./commonswarm";

export interface HomeWorkspace { id: string; name: string }
export interface HomeMapAgent extends RailAgent {
  oldestUnobservedAt?: string | null;
  work?: AgentWorkStatus;
}
export interface HomePeopleInput {
  viewerId: string | null;
  members: RailMember[];
  agents: HomeMapAgent[];
  access: AgentAccessStatus[];
  signals: Signal[];
  now: number;
  sample: boolean;
}
export type HomePeople = NonNullable<RailVM["people"]>;

function applyVisibleLabel(agents: AgentVM[], field: "label" | "nestedLabel"): void {
  const next = disambiguateVisibleLabels(agents.map(agent => ({ id: agent.id, label: agent[field] })));
  for (const agent of agents) {
    const label = next.get(agent.id);
    if (label !== undefined) agent[field] = label;
  }
}

/** Agents whose rail buttons would announce the same owner share one nested-label context.
 *  Two people both shown as "Nikki Smith" are one context; different visible owners are not. */
function applyNestedLabels(agents: readonly AgentVM[]): void {
  const scopes = new Map<string, AgentVM[]>();
  for (const agent of agents) {
    const key = foldIdentityName(railAgentOwnerPhrase(agent) ?? "\0");
    const list = scopes.get(key);
    if (list) list.push(agent);
    else scopes.set(key, [agent]);
  }
  for (const group of scopes.values()) applyVisibleLabel(group, "nestedLabel");
}

export function mapHomePeople(input: HomePeopleInput): HomePeople {
  const names = firstNames(input.members.map(member => ({ id: member.userId, name: member.name })));
  const me = input.members.find(member => member.userId === input.viewerId);
  const elevated = me?.role === "owner" || me?.role === "admin";
  const person = (member: RailMember): PersonVM => ({ id: member.userId, name: member.name,
    firstName: names.get(member.userId) ?? "", initials: initials(member.name), you: member.userId === input.viewerId, role: member.role });
  const agent = (row: HomeMapAgent): AgentVM => {
    const owner = input.members.find(member => member.userId === row.ownerUserId);
    const access = input.access.find(item => item.principalId === row.principalId);
    const raw = row.name.trim() || row.principalId;
    const yours = row.ownerUserId === input.viewerId;
    const work = row.work;
    const workingOn = input.signals.filter(item => item.fromKind === "agent" && item.from === row.principalId && item.kind === "working-on" && Date.parse(item.until ?? "") > input.now)
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0];
    const facts: HomeAgentStatusInput = { own: yours, ownerName: owner?.name ?? null, ownerFirstName: names.get(row.ownerUserId) ?? null,
      mayManage: !!me && (elevated || yours), sample: input.sample, transport: work?.facts.transport ?? row.transport,
      turnOnly: work?.facts.turn_only ?? row.turnOnly, presence: row.presence,
      oldestUnobservedAt: work?.facts.messages_waiting_since ?? row.oldestUnobservedAt,
      revoked: work?.facts.connection === "removed",
      connection: work?.facts.connection,

      grant: access ? { kind: access.grantKind, horizonExpiresAt: access.horizonExpiresAt, boundDeviceId: access.boundDeviceId,
        lastUsedAt: access.lastUsedAt, issuedAt: access.issuedAt, newHostAt: access.newHostAt,
        suspendedAt: access.suspendedAt, revokedAt: access.grantRevokedAt ?? access.revokedAt } : null,
      serverWork: work?.work, lastActionAt: work?.facts.last_activity_at,
      doingTodo: work?.facts.doing ? { title: work.facts.doing.title ?? "a to-do", since: work.facts.doing.since } : null,
      workingOn: workingOn ? { body: workingOn.body, createdAt: workingOn.createdAt, until: workingOn.until! }
        : work?.facts.working_on ? { createdAt: work.facts.working_on.at, until: work.facts.working_on.until } : null };
    const labelInput = { name: raw, ownerId: owner ? row.ownerUserId : null, ownerName: owner?.name, ownerFirstName: names.get(row.ownerUserId), yours };
    return { id: row.principalId, name: raw, label: agentLabel(labelInput), nestedLabel: agentLabel(labelInput, { nested: true }),
      ownerId: owner ? row.ownerUserId : null, ownerFirstName: names.get(row.ownerUserId) ?? null,
      ownerInitial: owner ? Array.from(initials(owner.name))[0] ?? "" : "", yours, tint: personTint(owner ? row.ownerUserId : null, yours) ?? 0,
      hosted: facts.transport === "hosted_mcp", state: homeAgentState(facts, input.now) };
  };
  const result: HomePeople = { title: "People & agents", groups: [], other: [] };
  for (const group of groupParticipantsByOwner(input.members, input.agents, { viewerId: input.viewerId })) {
    if (group.kind === "member") result.groups.push({ person: person(group.member), agents: group.agents.map(agent) });
    else result.other.push(...group.agents.map(agent));
  }
  const alone = [...result.groups.flatMap(group => group.agents), ...result.other];
  applyVisibleLabel(alone, "label");
  applyNestedLabels(alone);
  return result;
}

/** Catch up shows the viewer's own agents from every workspace in one group.
 *  Labels were already settled inside each workspace, so they are settled again
 *  on the combined list. Copies keep a workspace's own labels unchanged. */
export function catchUpRailPeople(entries: readonly { detail?: { people?: HomePeople } }[]): HomePeople {
  const own = entries.flatMap(entry => entry.detail?.people?.groups.filter(group => group.person.you) ?? []);
  const first = own[0];
  const agents = [...new Map(own.flatMap(group => group.agents).map(agent => [agent.id, agent])).values()]
    .map(agent => ({ ...agent }));
  applyVisibleLabel(agents, "nestedLabel");
  return { title: RAIL_CATCH_UP_PEOPLE_TITLE, other: [], groups: first ? [{ person: first.person, agents }] : [] };
}

/** Membership is checked before a workspace is opened. A foreign address falls back to boot. */
export function homeBootRoute(workspaces: readonly HomeWorkspace[]): HomeRoute {
  return workspaces.length === 1 ? { view: "chat", workspaceId: workspaces[0].id } : { view: "catchup" };
}
export function resolveHomeRoute(search: string, workspaces: readonly HomeWorkspace[]): HomeRoute {
  const route = parseRoute(search);
  if (route.view === "catchup" || route.view === "new") return route;
  if ("workspaceId" in route && route.workspaceId && workspaces.some(workspace => workspace.id === route.workspaceId)) return route;
  return homeBootRoute(workspaces);
}
export type HomeReadState = "pending" | "ready" | "failed";
/** A missing object is confirmed only by a successful read in the selected workspace. */
export function homeObjectState(id: string, ids: readonly string[], read: HomeReadState): "checking" | "failed" | "found" | "missing" {
  if (read === "pending") return "checking";
  if (read === "failed") return "failed";
  return ids.includes(id) ? "found" : "missing";
}
export function homeViewTitle(route: HomeRoute, workspaceName?: string): string {
  const labels: Record<HomeRoute["view"], string> = { catchup: "Catch up", new: "New workspace", chat: "Chat", todos: "To-dos", lists: "Lists", files: "Files", wiki: "Wiki", "add-agent": "Add agent", todo: "To-do", agent: "Agent" };
  return [labels[route.view], workspaceName, "CommonSwarm"].filter(Boolean).join(" · ");
}
export function mapHomeRail(workspaces: readonly HomeWorkspace[], route: HomeRoute, people: HomePeople | null, sample: boolean,
  counts: ReadonlyMap<string, number | null> = new Map()): RailVM {
  const allMeasured = workspaces.every(workspace => counts.get(workspace.id) != null);
  return { sample, catchUp: { href: routeHref({ view: "catchup" }), current: route.view === "catchup",
    needsYou: allMeasured ? workspaces.reduce((sum, workspace) => sum + (counts.get(workspace.id) ?? 0), 0) : null },
    workspaces: workspaces.map(workspace => ({ ...workspace, href: routeHref({ view: "chat", workspaceId: workspace.id }),
      current: "workspaceId" in route && route.workspaceId === workspace.id, needsYou: counts.get(workspace.id) ?? null })), people };
}

export interface CatchUpDetail {
  people: HomePeople;
  signals: Signal[];
  /** null means the read was absent, refused, incomplete or failed. */
  openTodos: number | null; lists: number | null; files: number | null;
  newMessages: number | null;
  needsYou?: NeedsYouVM[];
  needsYouComplete?: boolean;
  /** Unexpired asks, assigned to-dos, waiting to-dos, and the viewer's own agent fixes. Omitted when this read did not measure them. */
  measuredNeedsYou?: number;
}
export interface CatchUpData {
  workspace: HomeWorkspace;
  state: CatchUpWorkspaceCardVM["state"];
  detail?: CatchUpDetail;
}
export function initialCatchUpData(workspaces: readonly HomeWorkspace[]): CatchUpData[] {
  return workspaces.map((workspace, index) => ({ workspace, state: index < 8 ? "loading" : "open" }));
}
function homePerson(people: HomePeople, id: string): PersonVM | undefined {
  return people.groups.find(group => group.person.id === id)?.person;
}
function homeAgent(people: HomePeople, id: string): AgentVM | undefined {
  return [...people.groups.flatMap(group => group.agents), ...people.other].find(agent => agent.id === id);
}
function unnamedMember(): PersonVM {
  return { id: "", name: "Workspace member", firstName: "Workspace member", initials: "", you: false, role: "member" };
}
function quotedTitle(title: string): string { return `‘${title}’`; }
function todoOpen(workspaceId: string, todoId: string): NeedsYouVM["primary"] {
  return { label: "Open", href: routeHref({ view: "todo", workspaceId, todoId }) };
}
/** The overview has no reliable assigner. The card names nobody and opens the to-do. */
function assignedNeedsYouCard(todo: { todo_id: string; title: string }, workspace: NeedsYouVM["workspace"]): NeedsYouVM {
  return { id: todo.todo_id, kind: "todo", workspace, from: unnamedMember(), when: "",
    what: `${quotedTitle(todo.title)} is assigned to you.`,
    primary: todoOpen(workspace.id, todo.todo_id) };
}
function waitingNeedsYouCard(todo: { todo_id: string; title: string; agent_id?: string | null; reason?: string }, people: HomePeople, workspace: NeedsYouVM["workspace"]): NeedsYouVM {
  const agent = todo.agent_id ? homeAgent(people, todo.agent_id) : undefined;
  const request = todo.reason === "request";
  return { id: todo.todo_id, kind: request ? "request" : "todo", workspace, from: agent ?? unnamedMember(), when: "",
    what: request ? `${quotedTitle(todo.title)} is waiting for your answer.` : `Waiting on you: ${quotedTitle(todo.title)}.`,
    primary: todoOpen(workspace.id, todo.todo_id) };
}
/** A pending request replaces the assignment card for the same to-do. The id stays one counted item. */
function pushNeed(needsYou: NeedsYouVM[], item: NeedsYouVM, replaceAssignment = false): void {
  const index = needsYou.findIndex(existing => existing.id === item.id);
  if (index < 0) needsYou.push(item);
  else if (replaceAssignment && needsYou[index].kind === "todo") needsYou[index] = item;
}
/** Quote the ask only when its body was read. A missing preview or a departed author still gets a Reply card. */
function askNeedsYouCard(ask: WorkspaceCatchUp["needs_you"]["asks"][number], people: HomePeople, workspace: NeedsYouVM["workspace"], signals: readonly Signal[], now: number): NeedsYouVM | null {
  if (Date.parse(ask.until) <= now) return null;
  const author = ask.from.kind === "agent" ? homeAgent(people, ask.from.id) : homePerson(people, ask.from.id);
  const message = signals.find(signal => signal.id === ask.signal_id && signal.kind === "ask" && signal.from === ask.from.id);
  const from = author ?? unnamedMember();
  const name = "label" in from ? from.label : from.name;
  return { id: ask.signal_id, kind: "ask", workspace, from, when: formatWhen(ask.created_at, now),
    what: message ? `${name} asked you: ‘${message.body}’` : `${name} asked you.`,
    primary: { label: "Reply", href: routeHref({ view: "chat", workspaceId: workspace.id, messageId: ask.signal_id }) } };
}
function countedNeedIds(row: WorkspaceCatchUp, now: number): Set<string> {
  return new Set([
    ...row.needs_you.asks.filter(ask => Date.parse(ask.until) > now).map(ask => ask.signal_id),
    ...row.needs_you.assigned.map(todo => todo.todo_id),
    ...row.needs_you.waiting.map(todo => todo.todo_id),
  ]);
}
export function catchUpDetailFromOverview(row: WorkspaceCatchUp, viewerId: string, now: number, sample: boolean, signals: Signal[] = []): CatchUpDetail {
  const people = mapHomePeople({ viewerId, now, sample, access: [], signals: [],
    members: row.people.map(person => ({ userId: person.user_id, name: person.display_name, role: person.role })),
    agents: row.people.flatMap(person => person.agents.map(agent => ({ principalId: agent.principal_id, name: agent.name,
      ownerUserId: person.user_id, work: agent.status }))) });
  const workspace = { id: row.workspace_id, name: row.name, href: routeHref({ view: "chat", workspaceId: row.workspace_id }) };
  const needsYou: NeedsYouVM[] = [];
  for (const ask of row.needs_you.asks) {
    const card = askNeedsYouCard(ask, people, workspace, signals, now);
    if (card) pushNeed(needsYou, card);
  }
  for (const todo of row.needs_you.assigned) pushNeed(needsYou, assignedNeedsYouCard(todo, workspace));
  for (const todo of row.needs_you.waiting) {
    const card = waitingNeedsYouCard(todo, people, workspace);
    pushNeed(needsYou, card, card.kind === "request");
  }
  const counted = countedNeedIds(row, now);
  return { people, signals, openTodos: row.content?.open_todos ?? null, lists: row.content?.lists ?? null,
    files: row.content?.files ?? null, newMessages: row.last_seen_at === null ? null : row.new_messages, needsYou,
    needsYouComplete: [...counted].every(id => needsYou.some(item => item.id === id)),
    measuredNeedsYou: needsYou.length + homeAgentFixCards(people, workspace).length };
}
/** Reconcile against the membership list, never let an overview add an unauthorized address. */
export function overviewCatchUpData(data: CatchUpData[], overview: HomeOverview, sample: boolean, messages: ReadonlyMap<string, Signal[]> = new Map()): CatchUpData[] {
  return data.map((entry, index) => {
    if (index >= 8) return entry;
    const row = overview.workspaces.find(workspace => workspace.workspace_id === entry.workspace.id);
    return row ? { ...entry, state: "ready", detail: catchUpDetailFromOverview(row, overview.viewer_user_id, Date.parse(overview.generated_at), sample, messages.get(row.workspace_id)) }
      : { ...entry, state: "failed" };
  });
}
export function homeAgentFixCards(people: HomePeople, workspace: NeedsYouVM['workspace']): NeedsYouVM[] {
  return [...people.groups.flatMap(group => group.agents), ...people.other].filter(agent => agent.yours && agent.state.attention).map(agent => ({
    id: `${workspace.id}:${agent.id}`, kind: 'agent-fix', workspace, from: agent, what: `${agent.label} is ${agent.state.word.toLocaleLowerCase()}: ${agent.state.detail.replace(/^./u, char => char.toLocaleLowerCase())}.`, when: '',
    primary: { label: 'What to do', href: routeHref({ view: 'agent', workspaceId: workspace.id, agentId: agent.id }) },
  }));
}
/** Mirrors overview SQL: answers from the viewer or their agents, in threads or directed replies. */
export function homeAskAnswered(askId: string, signals: readonly Signal[], viewerId: string | null, ownAgentIds: readonly string[]): boolean {
  return signals.some(reply => (reply.threadRootId === askId || reply.inReplyTo === askId)
    && (reply.fromKind === "user" ? reply.from === viewerId : reply.fromKind === "agent" && ownAgentIds.includes(reply.from)));
}
function detailNeeds(entry: CatchUpData): NeedsYouVM[] {
  const detail = entry.detail;
  if (!detail) return [];
  const workspace = { ...entry.workspace, href: routeHref({ view: "chat", workspaceId: entry.workspace.id }) };
  const items = [...(detail.needsYou ?? [])];
  items.push(...homeAgentFixCards(detail.people, workspace));
  // Overview needs_you is the only answer check. swarm_read.signals hides the viewer's own
  // directed replies, so a short feed cannot prove an ask is still open.
  return items;
}
/** Rail badge. An overview count is the same card list the subline renders, including a Reply card for an ask whose preview or author is missing. A card list with no tally counts only when that list is complete. Null means the count was not measured. */
export function homeNeedsYouCount(entry: CatchUpData): number | null {
  if (entry.state !== "ready" || !entry.detail) return null;
  if (typeof entry.detail.measuredNeedsYou === "number") return entry.detail.measuredNeedsYou;
  if (entry.detail.needsYou === undefined || entry.detail.needsYouComplete === false) return null;
  return detailNeeds(entry).length;
}
/** The frozen builder cannot express an incomplete needs-you read independently of card detail. */
export interface HomeCatchUpVM extends CatchUpVM { emptySummary: string | null }
export function mapCatchUp(data: readonly CatchUpData[], _viewerId: string | null, viewerName: string, now: number, sample: boolean, expanded = false): HomeCatchUpVM {
  const latest = data.flatMap(entry => (entry.detail?.signals ?? []).filter(signal => signal.until === null || Date.parse(signal.until ?? "") > now).map(signal => {
    const people = entry.detail!.people;
    const author = signal.fromKind === "agent" ? [...people.groups.flatMap(group => group.agents), ...people.other].find(agent => agent.id === signal.from)
      : people.groups.find(group => group.person.id === signal.from)?.person;
    return { id: signal.id, authorLabel: author ? "label" in author ? author.label : author.name : "Workspace member",
      workspace: { name: entry.workspace.name, href: routeHref({ view: "chat", workspaceId: entry.workspace.id, ...(signal.channelId ? { channelId: signal.channelId } : {}), messageId: signal.id }) },
      excerpt: signal.body.slice(0, 240), when: formatWhen(signal.createdAt, now), at: Date.parse(signal.createdAt) };
  })).sort((left, right) => right.at - left.at).slice(0, 8);
  const checks = data.filter(entry => entry.state !== "open");
  const checked = checks.filter(entry => entry.state === "ready").length;
  const complete = data.every(entry => entry.state === "ready" && entry.detail?.needsYou !== undefined && entry.detail.needsYouComplete !== false);
  return { emptySummary: checked < checks.length
      ? `Checked ${checked} of ${checks.length} ${checks.length === 1 ? "workspace" : "workspaces"}.`
      : complete ? null : checks.length ? `Checked ${checked} of ${checks.length} ${checks.length === 1 ? "workspace" : "workspaces"}.` : "Latest",
    sample, viewerFirstName: viewerName.trim().split(/\s+/)[0] || "there", now: new Date(now).toISOString(), needsYouExpanded: expanded,
    needsYou: data.flatMap(entry => detailNeeds(entry)), latest,
    workspaces: data.map(entry => ({ ...entry.workspace, href: routeHref({ view: "chat", workspaceId: entry.workspace.id }), state: entry.state,
      capsules: entry.detail?.people.groups ?? [], peopleSummary: entry.detail ? catchUpPeopleSummary(entry.detail.people.groups.map(group => group.person)) : "",
      openTodos: entry.detail?.openTodos ?? null, lists: entry.detail?.lists ?? null, files: entry.detail?.files ?? null,
      agentsNeedingAttention: entry.detail ? [...entry.detail.people.groups.flatMap(group => group.agents), ...entry.detail.people.other].filter(agent => agent.state.attention).length : null,
      newMessagesSinceLastLooked: entry.detail?.newMessages ?? null })) };
}
/** Workers await the entire workspace read before taking another; never more than three in flight. */
export async function fillCatchUpDetails(data: CatchUpData[], read: (workspace: HomeWorkspace) => Promise<CatchUpDetail>,
  update: (entry: CatchUpData) => void): Promise<void> {
  const queue = data.slice(0, 8); let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
    for (;;) {
      const entry = queue[next++]; if (!entry) return;
      try { update({ ...entry, state: "ready", detail: await read(entry.workspace) }); }
      catch { update({ ...entry, state: "failed" }); }
    }
  }));
}

/** Only an absent rollout endpoint permits compatibility reads. Refused/failed reads stay visible. */
export function homeOverviewUnavailable(status: number, code: string | undefined): boolean {
  return status === 404 || code === "PGRST202" || code === "42883";
}

/** UI-SPEC 1.3: a confirmed missing object has a Home link independent of browser history. */
export function homeNotFound(): { heading: string; label: string; href: string } {
  return { heading: "Nothing with this link in Home.", label: "Home",
    href: routeHref({ view: "catchup" }) };
}
/** Removed files still occupy the read page; their rows do not count as current files. */
export function homeFileCount(rows: readonly { tombstonedAt: string | null }[]): number | null {
  return rows.length >= 500 ? null : rows.filter(row => !row.tombstonedAt).length;
}

// Local integration models: the wire read has no UI permission flags or page models.
import type { Actor, Todo, TodoSummary, Comment, Party, AgentQueue } from './home/contract';
import type { TodoVM, ObjectCardVM, QueueRowVM } from './home-types';
import type { AgentFoundVM } from './home-agent';
import { ownershipLine, notYetTodoGate, notYetNoteGate, setTimeCopy } from './home-agent-copy';
import { todoSubline } from './home-todo-copy';
export interface HomeTodoContext { workspaceId: string; people: HomePeople; viewerId: string | null; editor: boolean; sample: boolean; now: number; details?: ReadonlyMap<string, Todo>; tagDelivers?: boolean }
export function homeParty(party: Party | null, people: HomePeople): PersonVM | AgentVM | null {
  if (!party) return null;
  return party.kind === 'agent' ? [...people.groups.flatMap(group => group.agents), ...people.other].find(agent => agent.id === party.id) ?? null
    : people.groups.find(group => group.person.id === party.id)?.person ?? null;
}
function homeActor(actor: Actor, people: HomePeople): PersonVM | AgentVM {
  return homeParty({ kind: actor.principal_id ? 'agent' : 'user', id: actor.principal_id ?? actor.user_id }, people)
    ?? { id: actor.user_id, name: 'Workspace member', firstName: 'Workspace member', initials: '', you: false, role: 'member' };
}
/** Missing summary metadata stays unknown; it is never attributed to the viewer. */
export function mapHomeTodo(row: Todo | TodoSummary, ctx: HomeTodoContext, known: readonly TodoSummary[] = [], comments: readonly Comment[] = []): TodoVM {
  const full = 'created_by' in row ? row : null;
  const party = row.offer?.to ?? row.assignee;
  const who = homeParty(party, ctx.people);
  const agent = who && 'label' in who ? who : null;
  const me = ctx.people.groups.find(group => group.person.you)?.person;
  const elevated = me?.role === 'owner' || me?.role === 'admin';
  const edit = ctx.editor && !ctx.sample;
  const open = row.state === 'open' || row.state === 'doing';
  const steer = edit && open && !!agent?.yours && !row.offer;
  const canComplete = edit && (row.assignee === null || row.assignee.kind === 'user' && row.assignee.id === ctx.viewerId
    || !!homeParty(row.assignee, ctx.people) && 'label' in homeParty(row.assignee, ctx.people)! && (homeParty(row.assignee, ctx.people) as AgentVM).yours
    || full?.created_by.user_id === ctx.viewerId || elevated);
  const gate = full?.gate ?? row.gate;
  const clear = full ? full.gate_clear : 'clear' in row.gate ? row.gate.clear : false;
  const gateId = gate.kind === 'after' && 'todo_id' in gate ? gate.todo_id : null;
  const prerequisite = known.find(todo => todo.todo_id === gateId);
  const gateVM: TodoVM['start'] = !agent ? null : { mode: gate.kind === 'at' && !clear ? 'at' : gate.kind !== 'none' && !clear ? 'gated' : 'queue',
    position: row.queue_position, at: gate.kind === 'at' && 'at' in gate ? gate.at : null,
    gate: gate.kind === 'after' && gateId ? { kind: 'todo', todo: { id: gateId, title: prerequisite?.title ?? 'another to-do',
      href: routeHref({ view: 'todo', workspaceId: ctx.workspaceId, todoId: gateId }), done: prerequisite?.state === 'done' } }
      : gate.kind === 'at' && 'at' in gate && gate.at ? { kind: 'time', at: gate.at }
      : gate.kind === 'hold' ? { kind: 'note', note: 'note' in gate ? gate.note ?? 'Waiting for release' : 'Waiting for release' } : null };
  const decider = row.offer ? ctx.people.groups.find(group => group.person.id === row.offer!.decider_user_id)?.person : null;
  return { id: row.todo_id, workspaceId: ctx.workspaceId, title: row.title, notes: full?.notes ?? '', state: row.state,
    addedBy: full ? homeActor(full.created_by, ctx.people) : homeActor({ user_id: '', principal_id: null }, ctx.people), addedAt: full?.created_at ?? '', due: row.due_on,
    assignee: who ? 'label' in who ? { kind: 'agent', agent: who } : { kind: 'person', person: who } : null,
    start: gateVM, request: row.offer ? { status: 'pending', ownerFirstName: decider?.firstName ?? 'its owner' } : null,
    doneBy: full && row.state === 'done' ? homeActor(full.state_by, ctx.people) : null, doneAt: row.state === 'done' ? row.state_at : null,
    receipt: null, sample: ctx.sample, may: { edit, assign: edit && open, start: steer, reorder: steer, complete: !!canComplete, comment: edit },
    comments: comments.map(comment => ({ id: comment.comment_id, author: homeActor(comment.author, ctx.people), at: comment.created_at, body: comment.body,
      tags: comment.mentions.flatMap(party => { const who = homeParty(party, ctx.people); return who ? [{ id: party.id, label: 'label' in who ? who.label : who.name }] : []; }) })), tagDelivers: ctx.tagDelivers === true };
}
export function homeTodoCard(todo: TodoVM, now: number): ObjectCardVM {
  return { kind: 'todo', id: todo.id, title: todo.title, href: routeHref({ view: 'todo', workspaceId: todo.workspaceId, todoId: todo.id }),
    meta: todoSubline(todo, { now }), who: todo.assignee?.kind === 'agent' ? todo.assignee.agent : todo.assignee?.person ?? null, done: todo.state === 'done' };
}
export function mapHomeAgentPage(agent: AgentVM, queue: AgentQueue | null, rows: readonly TodoSummary[], ctx: HomeTodoContext,
  workspaceName: string, receive: string, facts: AgentFoundVM['facts'], activity: AgentFoundVM['activity']): AgentFoundVM {
  const mapped = (row: TodoSummary) => {
    const detail = ctx.details?.get(row.todo_id);
    return mapHomeTodo(detail?.version === row.version ? detail : row, ctx, rows);
  };
  const card = (row: TodoSummary) => homeTodoCard(mapped(row), ctx.now);
  const queueRow = (row: TodoSummary, index: number, gated = false): QueueRowVM => {
    const o = card(row); const may = !ctx.sample && ctx.editor && agent.yours;
    return { todoId: row.todo_id, position: row.queue_position ?? index + 1, title: row.title, href: o.href, meta: o.meta,
      may: { up: may && !gated && index > 0, down: may && !gated && index < (queue?.up_next.length ?? 0) - 1,
        startNow: may, notYet: may && !gated, release: may && gated } };
  };
  const doing = queue?.working[0];
  const held = queue?.not_yet.filter(row => row.gate.kind !== 'at') ?? [];
  const at = queue?.not_yet.filter(row => row.gate.kind === 'at') ?? [];
  return { found: true, sample: ctx.sample, homeHref: routeHref({ view: 'chat', workspaceId: ctx.workspaceId }), agent,
    ownership: agent.ownerFirstName ? ownershipLine(agent.ownerFirstName, agent.yours) : 'Owner left', workspaceName, receive,
    doingNow: doing ? { todoId: doing.todo_id, title: doing.title, href: card(doing).href, meta: card(doing).meta, detail: '' } : null,
    upNext: (queue?.up_next ?? []).map((row, i) => queueRow(row, i)),
    notYet: held.map((row, i) => {
      const gate = mapped(row).start?.gate;
      return { ...queueRow(row, i, true), gate: row.gate.kind === 'after'
        ? notYetTodoGate(rows.find(todo => todo.todo_id === row.gate.todo_id)?.title ?? 'another to-do', agent.nestedLabel)
        : notYetNoteGate(gate?.kind === 'note' ? gate.note : 'Waiting for release') };
    }).concat((queue?.requests ?? []).map((row, index) => ({ ...queueRow(row, index, true),
        gate: 'Request pending', may: { up: false, down: false, startNow: false, notYet: false, release: false } }))),
    atSetTime: at.map(row => ({ todoId: row.todo_id, title: row.title, href: card(row).href,
      whenLine: setTimeCopy(agent.nestedLabel, formatWhen(row.gate.at ?? '', ctx.now)) })),
    doneRecently: rows.filter(row => row.state === 'done' && row.assignee?.kind === 'agent' && row.assignee.id === agent.id)
      .sort((a, b) => Date.parse(b.state_at) - Date.parse(a.state_at)).slice(0, 5).map(row => ({ todoId: row.todo_id, title: row.title, href: card(row).href, meta: card(row).meta })),
    facts, activity, may: { steer: !!queue && ctx.editor && agent.yours }, ...(queue ? { workPolicy: queue.accepts_from } : {}) };
}
