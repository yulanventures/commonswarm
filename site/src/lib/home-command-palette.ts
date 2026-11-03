import type { TodoSummary } from "./home/contract";

export type CommandPaletteCategory =
  | "teammate"
  | "channel"
  | "lead"
  | "action";

export type CommandPaletteAction =
  | { type: "teammate"; entityKind: "agent" | "person"; id: string }
  | { type: "channel"; slug: string }
  | { type: "set-lead"; principalId: string | null }
  | { type: "open-skills" }
  | { type: "navigate"; view: "chat" | "todos" | "lists" | "files" | "wiki" | "people" }
  | { type: "connect-agent" }
  | { type: "new-channel" }
  | { type: "cycle-theme" };

export interface CommandPaletteItem {
  id: string;
  category: CommandPaletteCategory;
  label: string;
  subtitle?: string;
  badge?: string;
  keywords: string[];
  action: CommandPaletteAction;
}

export interface CommandPaletteAgentInput {
  principalId: string;
  name: string;
  model: string | null;
  transport: "local" | "hosted_mcp";
  turnOnly: boolean;
  revokedAt: string | null;
}

export interface CommandPaletteMemberInput {
  userId: string;
  name: string;
}

export interface CommandPaletteChannelInput {
  slug: string;
  purpose?: string | null;
  archivedAt?: string | null;
}

export interface CommandPaletteBuildInput {
  agents: readonly CommandPaletteAgentInput[];
  members: readonly CommandPaletteMemberInput[];
  channels: readonly CommandPaletteChannelInput[];
  leadAgentPrincipalId: string | null;
  maySetLead: boolean;
  themeLabel?: string;
}

export interface AgentRoutineItem {
  todoId: string;
  title: string;
  badge: string;
  kind: "doing" | "routine" | "queued";
}

export interface AgentRoutinesSummary {
  doingNow: AgentRoutineItem[];
  routines: AgentRoutineItem[];
  upNext: AgentRoutineItem[];
}

const CATEGORY_TITLES: Record<CommandPaletteCategory, string> = {
  teammate: "Teammates",
  channel: "Group chats",
  lead: "Workspace lead",
  action: "Workspace & tools",
};

export function buildCommandPaletteItems(
  input: CommandPaletteBuildInput,
): CommandPaletteItem[] {
  const items: CommandPaletteItem[] = [];
  const activeAgents = input.agents.filter((agent) => !agent.revokedAt);

  for (const agent of activeAgents) {
    const isLead = input.leadAgentPrincipalId === agent.principalId;
    const subtitleParts: string[] = [];
    if (agent.model) subtitleParts.push(agent.model);
    subtitleParts.push(agent.transport === "hosted_mcp" ? "Connector" : "Local agent");
    items.push({
      id: `teammate:agent:${agent.principalId}`,
      category: "teammate",
      label: agent.name,
      subtitle: subtitleParts.join(" · "),
      badge: isLead ? "LEAD" : "AGENT",
      keywords: [
        agent.name,
        "agent",
        "dm",
        "message",
        agent.model ?? "",
        isLead ? "lead" : "",
      ],
      action: { type: "teammate", entityKind: "agent", id: agent.principalId },
    });
  }

  for (const member of input.members) {
    items.push({
      id: `teammate:person:${member.userId}`,
      category: "teammate",
      label: member.name,
      subtitle: "Workspace member",
      badge: "PERSON",
      keywords: [member.name, "person", "member", "teammate"],
      action: { type: "teammate", entityKind: "person", id: member.userId },
    });
  }

  items.push({
    id: "channel:__all__",
    category: "channel",
    label: "All messages",
    subtitle: "Workspace-wide stream",
    badge: "STREAM",
    keywords: ["all", "stream", "feed", "channel", "messages"],
    action: { type: "channel", slug: "__all__" },
  });

  for (const channel of input.channels) {
    if (channel.archivedAt) continue;
    items.push({
      id: `channel:${channel.slug}`,
      category: "channel",
      label: `#${channel.slug}`,
      subtitle: channel.purpose?.trim() || "Group chat",
      badge: "GROUP",
      keywords: [channel.slug, `#${channel.slug}`, "channel", "group", channel.purpose ?? ""],
      action: { type: "channel", slug: channel.slug },
    });
  }

  if (input.maySetLead) {
    for (const agent of activeAgents) {
      if (agent.transport === "hosted_mcp" || agent.turnOnly) continue;
      if (input.leadAgentPrincipalId === agent.principalId) continue;
      items.push({
        id: `lead:set:${agent.principalId}`,
        category: "lead",
        label: `Set ${agent.name} as workspace lead`,
        subtitle: "Responds to untagged channel messages",
        badge: "LEAD",
        keywords: ["set", "lead", "workspace lead", "primary", agent.name],
        action: { type: "set-lead", principalId: agent.principalId },
      });
    }
    if (input.leadAgentPrincipalId) {
      const currentLead = activeAgents.find(
        (agent) => agent.principalId === input.leadAgentPrincipalId,
      );
      if (currentLead) {
        items.push({
          id: "lead:clear",
          category: "lead",
          label: `Remove ${currentLead.name} as workspace lead`,
          subtitle: "Stop auto-routing untagged channel messages",
          badge: "LEAD",
          keywords: ["remove", "clear", "lead", "workspace lead", currentLead.name],
          action: { type: "set-lead", principalId: null },
        });
      }
    }
  }

  items.push(
    {
      id: "action:skills",
      category: "action",
      label: "Workspace skills",
      subtitle: "Shared agent playbooks and suggestions",
      badge: "SKILLS",
      keywords: ["skills", "playbooks", "instructions", "memory", "suggestions"],
      action: { type: "open-skills" },
    },
    {
      id: "action:todos",
      category: "action",
      label: "To-dos & routines",
      subtitle: "Tasks, scheduled runs, and agent queues",
      badge: "ROUTINES",
      keywords: ["todos", "to-dos", "tasks", "routines", "schedule", "queue"],
      action: { type: "navigate", view: "todos" },
    },
    {
      id: "action:lists",
      category: "action",
      label: "Lists & docs",
      subtitle: "Shared workspace lists and documents",
      keywords: ["lists", "docs", "documents", "shared"],
      action: { type: "navigate", view: "lists" },
    },
    {
      id: "action:files",
      category: "action",
      label: "Files",
      subtitle: "Shared workspace files and artifacts",
      keywords: ["files", "uploads", "artifacts"],
      action: { type: "navigate", view: "files" },
    },
    {
      id: "action:wiki",
      category: "action",
      label: "Wiki",
      subtitle: "Workspace knowledge pages",
      keywords: ["wiki", "knowledge", "pages", "brain"],
      action: { type: "navigate", view: "wiki" },
    },
    {
      id: "action:people",
      category: "action",
      label: "People & agents",
      subtitle: "Manage members, agent keys, and permissions",
      keywords: ["people", "agents", "members", "roster", "permissions"],
      action: { type: "navigate", view: "people" },
    },
    {
      id: "action:connect-agent",
      category: "action",
      label: "Add an agent",
      subtitle: "Connect Claude, Codex, Grok, or a terminal agent",
      keywords: ["add", "connect", "agent", "bot", "new agent"],
      action: { type: "connect-agent" },
    },
    {
      id: "action:new-channel",
      category: "action",
      label: "New group chat",
      subtitle: "Create a channel in this workspace",
      keywords: ["new", "create", "channel", "group chat"],
      action: { type: "new-channel" },
    },
    {
      id: "action:theme",
      category: "action",
      label: input.themeLabel ? `Switch theme (${input.themeLabel})` : "Switch theme",
      subtitle: "Cycle Dark, Light, and System appearance",
      keywords: ["theme", "dark", "light", "appearance", "color"],
      action: { type: "cycle-theme" },
    },
  );

  return items;
}

export function filterCommandPaletteItems(
  items: readonly CommandPaletteItem[],
  rawQuery: string,
): CommandPaletteItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return [...items];
  const tokens = query.split(/\s+/).filter(Boolean);

  const scored: Array<{ item: CommandPaletteItem; score: number }> = [];
  for (const item of items) {
    const labelLower = item.label.toLowerCase();
    const subtitleLower = (item.subtitle ?? "").toLowerCase();
    const haystack = [
      labelLower,
      subtitleLower,
      item.badge?.toLowerCase() ?? "",
      ...item.keywords.map((k) => k.toLowerCase()),
    ].join(" ");

    if (!tokens.every((token) => haystack.includes(token))) continue;

    let score = 0;
    if (labelLower === query) score += 100;
    else if (labelLower.startsWith(query)) score += 60;
    else if (labelLower.includes(query)) score += 30;
    if (item.category === "teammate") score += 10;
    if (item.badge === "LEAD") score += 5;
    scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((entry) => entry.item);
}

export function renderCommandPaletteList(
  doc: Document,
  container: HTMLElement,
  items: readonly CommandPaletteItem[],
  activeIndex: number,
  onSelect: (item: CommandPaletteItem) => void,
): void {
  container.replaceChildren();
  if (items.length === 0) {
    const empty = doc.createElement("p");
    empty.className = "cp-empty";
    empty.dataset.commandPaletteEmpty = "";
    empty.textContent = "No matching teammates, channels, or actions.";
    container.append(empty);
    return;
  }

  let currentCategory: CommandPaletteCategory | null = null;
  let currentGroupList: HTMLUListElement | null = null;

  items.forEach((item, index) => {
    if (item.category !== currentCategory || !currentGroupList) {
      currentCategory = item.category;
      const section = doc.createElement("section");
      section.className = "cp-group";
      section.dataset.commandPaletteGroup = item.category;
      const heading = doc.createElement("h3");
      heading.className = "cp-group__title";
      heading.textContent = CATEGORY_TITLES[item.category];
      currentGroupList = doc.createElement("ul");
      currentGroupList.className = "cp-group__list";
      section.append(heading, currentGroupList);
      container.append(section);
    }

    const li = doc.createElement("li");
    li.className = "cp-item";
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "cp-item__button";
    if (index === activeIndex) {
      button.classList.add("cp-item__button--active");
      button.setAttribute("aria-selected", "true");
    } else {
      button.setAttribute("aria-selected", "false");
    }
    button.dataset.commandPaletteItem = item.id;
    button.dataset.commandPaletteIndex = String(index);

    const copy = doc.createElement("span");
    copy.className = "cp-item__copy";
    const title = doc.createElement("span");
    title.className = "cp-item__label";
    title.textContent = item.label;
    copy.append(title);
    if (item.subtitle) {
      const sub = doc.createElement("span");
      sub.className = "cp-item__subtitle";
      sub.textContent = item.subtitle;
      copy.append(sub);
    }
    button.append(copy);

    if (item.badge) {
      const badge = doc.createElement("span");
      badge.className =
        item.badge === "LEAD"
          ? "cp-item__badge cp-item__badge--lead"
          : "cp-item__badge";
      badge.textContent = item.badge;
      button.append(badge);
    }

    button.addEventListener("click", () => onSelect(item));
    li.append(button);
    currentGroupList.append(li);
  });
}

function formatRoutineGateBadge(
  todo: TodoSummary,
  byId: ReadonlyMap<string, TodoSummary>,
): string {
  if (todo.gate.kind === "at" && todo.gate.at) {
    const parsed = new Date(todo.gate.at);
    if (!Number.isNaN(parsed.getTime())) {
      return `Scheduled · ${parsed.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      })}`;
    }
    return "Scheduled";
  }
  if (todo.gate.kind === "after" && todo.gate.todo_id) {
    const prereq = byId.get(todo.gate.todo_id);
    return prereq ? `After “${prereq.title}”` : "After prerequisite";
  }
  if (todo.gate.kind === "hold") {
    return "On hold";
  }
  return "Queued";
}

export function summarizeAgentRoutines(
  principalId: string,
  todos: readonly TodoSummary[],
): AgentRoutinesSummary {
  const byId = new Map<string, TodoSummary>();
  for (const todo of todos) byId.set(todo.todo_id, todo);

  const assigned = todos.filter(
    (todo) =>
      todo.assignee?.kind === "agent" &&
      todo.assignee.id === principalId &&
      (todo.state === "doing" || todo.state === "open"),
  );

  const doingNow: AgentRoutineItem[] = [];
  const routines: AgentRoutineItem[] = [];
  const upNextRaw: TodoSummary[] = [];

  for (const todo of assigned) {
    if (todo.state === "doing") {
      doingNow.push({
        todoId: todo.todo_id,
        title: todo.title,
        badge: "Working now",
        kind: "doing",
      });
    } else if (todo.gate.kind !== "none" && !todo.gate.clear) {
      routines.push({
        todoId: todo.todo_id,
        title: todo.title,
        badge: formatRoutineGateBadge(todo, byId),
        kind: "routine",
      });
    } else {
      upNextRaw.push(todo);
    }
  }

  upNextRaw.sort(
    (a, b) => (a.queue_position ?? 999) - (b.queue_position ?? 999),
  );
  const upNext: AgentRoutineItem[] = upNextRaw.map((todo, idx) => ({
    todoId: todo.todo_id,
    title: todo.title,
    badge: `#${todo.queue_position ?? idx + 1} in queue`,
    kind: "queued",
  }));

  return { doingNow, routines, upNext };
}

export interface AgentRoutinesSectionCallbacks {
  onOpenTodo: (todoId: string) => void;
  onOpenAgentQueue: () => void;
  onOpenSkills: () => void;
}

export function buildAgentRoutinesSection(
  doc: Document,
  summary: AgentRoutinesSummary,
  callbacks: AgentRoutinesSectionCallbacks,
): HTMLElement {
  const section = doc.createElement("section");
  section.className = "dashboard__entity-section";
  section.dataset.entityRoutinesSection = "";

  const title = doc.createElement("h3");
  title.textContent = "Routines & queue";
  section.append(title);

  const allItems = [
    ...summary.doingNow,
    ...summary.routines,
    ...summary.upNext.slice(0, 3),
  ];

  if (allItems.length === 0) {
    const empty = doc.createElement("p");
    empty.dataset.entityRoutinesEmpty = "";
    empty.textContent = "No active tasks or scheduled routines.";
    section.append(empty);
  } else {
    const list = doc.createElement("ul");
    list.className = "dashboard__entity-agent-list dashboard__entity-routines-list";
    list.dataset.entityRoutinesList = "";
    for (const item of allItems) {
      const li = doc.createElement("li");
      li.className = "dashboard__entity-routine-item";
      const btn = doc.createElement("button");
      btn.type = "button";
      btn.className = "dashboard__entity-link dashboard__entity-routine-link";
      btn.dataset.entityRoutineTodo = item.todoId;
      btn.textContent = item.title;
      btn.addEventListener("click", () => callbacks.onOpenTodo(item.todoId));
      const badge = doc.createElement("span");
      badge.className = "dashboard__entity-badge";
      badge.dataset.entityRoutineKind = item.kind;
      badge.textContent = item.badge;
      li.append(btn, badge);
      list.append(li);
    }
    section.append(list);
  }

  const actions = doc.createElement("div");
  actions.className = "dashboard__entity-actions-row";

  const openQueueBtn = doc.createElement("button");
  openQueueBtn.type = "button";
  openQueueBtn.className = "dashboard__entity-lead-button";
  openQueueBtn.dataset.entityOpenAgent = "";
  openQueueBtn.textContent = "Queue & settings";
  openQueueBtn.addEventListener("click", callbacks.onOpenAgentQueue);

  const openSkillsBtn = doc.createElement("button");
  openSkillsBtn.type = "button";
  openSkillsBtn.className = "dashboard__entity-lead-button";
  openSkillsBtn.dataset.entityOpenSkills = "";
  openSkillsBtn.textContent = "Workspace skills";
  openSkillsBtn.addEventListener("click", callbacks.onOpenSkills);

  actions.append(openQueueBtn, openSkillsBtn);
  section.append(actions);

  return section;
}
