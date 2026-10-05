export const HOME_WORKSPACE_VIEWS = ["chat", "todos", "lists", "files", "wiki", "add-agent"] as const;
export type HomeWorkspaceView = typeof HOME_WORKSPACE_VIEWS[number];
export type HomeRoute = { view: "catchup" | "new" }
  | { view: HomeWorkspaceView; workspaceId: string | null; channelId?: string; messageId?: string }
  | { view: "todo"; workspaceId: string | null; todoId: string }
  | { view: "agent"; workspaceId: string | null; agentId: string };

/** Parsing is navigation only. The integration layer must check workspace membership. */
export function parseRoute(search: string): HomeRoute {
  const params = new URLSearchParams(search);
  const workspaceId = params.get("w") || null;
  const todoId = params.get("todo"), agentId = params.get("agent"), view = params.get("v");
  if (todoId) return { view: "todo", workspaceId, todoId };
  if (agentId) return { view: "agent", workspaceId, agentId };
  if (view === "catchup" || view === "new") return { view };
  const selected = HOME_WORKSPACE_VIEWS.find(value => value === view) ?? "chat";
  return { view: selected, workspaceId, ...(selected === "chat" ? {
    ...(params.get("c") ? { channelId: params.get("c")! } : {}),
    ...(params.get("m") ? { messageId: params.get("m")! } : {}),
  } : {}) };
}

export function routeHref(route: HomeRoute): string {
  const params = new URLSearchParams();
  if (route.view === "catchup" || route.view === "new") params.set("v", route.view);
  else if ("workspaceId" in route) {
    if (route.workspaceId) params.set("w", route.workspaceId);
    if (route.view === "todo") params.set("todo", route.todoId);
    else if (route.view === "agent") params.set("agent", route.agentId);
    else if (route.view !== "chat") params.set("v", route.view);
    else {
      if (route.channelId) params.set("c", route.channelId);
      if (route.messageId) params.set("m", route.messageId);
    }
  }
  const query = params.toString();
  return `/app${query ? `?${query}` : ""}`;
}

export function parentRoute(route: HomeRoute): HomeRoute {
  if (route.view === "todo") return { view: "todos", workspaceId: route.workspaceId };
  if (route.view === "agent") return { view: "chat", workspaceId: route.workspaceId };
  return { view: "catchup" };
}
