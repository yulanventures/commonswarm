/** Home integration: wire facts become UI models here, never in DOM builders. */
import { homeAgentState, type HomeAgentStatusInput } from "./agent-status";
import { agentLabel, agentTint, firstNames, initials, formatWhen } from "./home-names";
import { identityDisplayLabel } from "./identity-label";
import { groupParticipantsByOwner, type RailAgent, type RailMember } from "./participant-rail";
import { parseRoute, routeHref, type HomeRoute } from "./home-route";
import { catchUpPeopleSummary, type CatchUpVM, type CatchUpWorkspaceCardVM } from "./home-catchup";
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

export function mapHomePeople(input: HomePeopleInput): HomePeople {
  const names = firstNames(input.members.map(member => ({ id: member.userId, name: member.name })));
  const me = input.members.find(member => member.userId === input.viewerId);
  const elevated = me?.role === "owner" || me?.role === "admin";
  const person = (member: RailMember): PersonVM => ({ id: member.userId, name: member.name,
    firstName: names.get(member.userId) ?? "", initials: initials(member.name), you: member.userId === input.viewerId, role: member.role });
  const agent = (row: HomeMapAgent): AgentVM => {
    const owner = input.members.find(member => member.userId === row.ownerUserId);
    const access = input.access.find(item => item.principalId === row.principalId);
    const name = identityDisplayLabel({ id: row.principalId, name: row.name }, input.agents.map(item => ({ id: item.principalId, name: item.name })));
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
    const labelInput = { name, ownerId: owner ? row.ownerUserId : null, ownerName: owner?.name, ownerFirstName: names.get(row.ownerUserId), yours };
    return { id: row.principalId, name, label: agentLabel(labelInput), nestedLabel: agentLabel(labelInput, { nested: true }),
      ownerId: owner ? row.ownerUserId : null, ownerFirstName: names.get(row.ownerUserId) ?? null,
      ownerInitial: owner ? Array.from(initials(owner.name))[0] ?? "" : "", yours, tint: agentTint(row.principalId),
      hosted: facts.transport === "hosted_mcp", state: homeAgentState(facts, input.now) };
  };
  const result: HomePeople = { title: "People & agents", groups: [], other: [] };
  for (const group of groupParticipantsByOwner(input.members, input.agents, { viewerId: input.viewerId })) {
    if (group.kind === "member") result.groups.push({ person: person(group.member), agents: group.agents.map(agent) });
    else result.other.push(...group.agents.map(agent));
  }
  return result;
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
}
export interface CatchUpData {
  workspace: HomeWorkspace;
  state: CatchUpWorkspaceCardVM["state"];
  detail?: CatchUpDetail;
}
export function initialCatchUpData(workspaces: readonly HomeWorkspace[]): CatchUpData[] {
  return workspaces.map((workspace, index) => ({ workspace, state: index < 8 ? "loading" : "open" }));
}
export function catchUpDetailFromOverview(row: WorkspaceCatchUp, viewerId: string, now: number, sample: boolean, signals: Signal[] = []): CatchUpDetail {
  const people = mapHomePeople({ viewerId, now, sample, access: [], signals: [],
    members: row.people.map(person => ({ userId: person.user_id, name: person.display_name, role: person.role })),
    agents: row.people.flatMap(person => person.agents.map(agent => ({ principalId: agent.principal_id, name: agent.name,
      ownerUserId: person.user_id, work: agent.status }))) });
  const workspace = { id: row.workspace_id, name: row.name, href: routeHref({ view: "chat", workspaceId: row.workspace_id }) };
  const needsYou: NeedsYouVM[] = [];
  for (const ask of row.needs_you.asks) {
    const author = ask.from.kind === "agent" ? people.groups.flatMap(group => group.agents).find(agent => agent.id === ask.from.id)
      : people.groups.find(group => group.person.id === ask.from.id)?.person;
    const message = signals.find(signal => signal.id === ask.signal_id && signal.kind === "ask" && signal.from === ask.from.id);
    if (!author || !message || Date.parse(ask.until) <= now) continue;
    needsYou.push({ id: ask.signal_id, kind: "ask", workspace, from: author,
      what: `${"label" in author ? author.label : author.name} asked you: ‘${message.body}’`, when: formatWhen(ask.created_at, now),
      primary: { label: "Reply", href: routeHref({ view: "chat", workspaceId: row.workspace_id, messageId: ask.signal_id }) } });
  }
  return { people, signals, openTodos: row.content?.open_todos ?? null, lists: row.content?.lists ?? null,
    files: row.content?.files ?? null, newMessages: row.last_seen_at === null ? null : row.new_messages, needsYou,
    needsYouComplete: row.needs_you.assigned.length === 0 && row.needs_you.waiting.length === 0 &&
      row.needs_you.asks.filter(ask => Date.parse(ask.until) > now).every(ask => needsYou.some(item => item.id === ask.signal_id)) };
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
function detailNeeds(entry: CatchUpData, viewerId: string | null, now: number): NeedsYouVM[] {
  const detail = entry.detail;
  if (!detail) return [];
  const workspace = { ...entry.workspace, href: routeHref({ view: "chat", workspaceId: entry.workspace.id }) };
  const agents = [...detail.people.groups.flatMap(group => group.agents), ...detail.people.other];
  const items = [...(detail.needsYou ?? [])];
  for (const agent of agents.filter(agent => agent.yours && agent.state.attention)) {
    items.push({ id: `${entry.workspace.id}:${agent.id}`, kind: "agent-fix", workspace, from: agent,
      what: `${agent.label}: ${agent.state.detail}.`, when: "", primary: { label: "What to do",
        href: routeHref({ view: "agent", workspaceId: entry.workspace.id, agentId: agent.id }) } });
  }
  for (const signal of detail.signals) {
    if (signal.kind !== "ask" || signal.to !== viewerId || !Number.isFinite(Date.parse(signal.until ?? "")) || Date.parse(signal.until ?? "") <= now || detail.signals.some(reply => reply.threadRootId === signal.id && reply.from === viewerId)) continue;
    const from = signal.fromKind === "agent" ? agents.find(agent => agent.id === signal.from)
      : detail.people.groups.find(group => group.person.id === signal.from)?.person;
    if (!from) continue;
    if (items.some(item => item.id === signal.id)) continue;
    items.push({ id: signal.id, kind: "ask", workspace, from,
      what: `${"label" in from ? from.label : from.name} asked you: ‘${signal.body}’`, when: formatWhen(signal.createdAt, now),
      primary: { label: "Reply", href: routeHref({ view: "chat", workspaceId: entry.workspace.id, ...(signal.channelId ? { channelId: signal.channelId } : {}), messageId: signal.id }) } });
  }
  return items;
}
/** The frozen builder cannot express an incomplete needs-you read independently of card detail. */
export interface HomeCatchUpVM extends CatchUpVM { emptySummary: string | null }
export function mapCatchUp(data: readonly CatchUpData[], viewerId: string | null, viewerName: string, now: number, sample: boolean, expanded = false): HomeCatchUpVM {
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
    needsYou: data.flatMap(entry => detailNeeds(entry, viewerId, now)), latest,
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
