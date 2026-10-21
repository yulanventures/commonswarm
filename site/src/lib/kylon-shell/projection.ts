import { routeHref, type HomeRoute } from "../home-route";

/** Only existing, reachable app routes. Organization identity awaits its authoritative read. */
export function projectHomeLayout(state: string | undefined, route: HomeRoute,
  workspaces: { id: string; name: string; todosAvailable?: boolean }[], sample: boolean) {
  const workspace = "workspaceId" in route ? workspaces.find(item => item.id === route.workspaceId) : undefined;
  const navigation = [{ id: "catchup", label: "Catch up", href: routeHref({ view: "catchup" }), current: route.view === "catchup", icon: "M4 4h16v12h-5l-3 4-3-4H4zM8 8h8M8 12h5" }];
  if (workspace) {
    const views = [
      { id: "chat", label: "Chat", icon: "M4 4h16v12H9l-5 4zM8 8h8M8 12h5" },
      ...(!sample ? [{ id: "people", label: "People & agents", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87" }] : []),
      ...(workspace.todosAvailable ? [{ id: "todos", label: "To-dos", icon: "M9 6h11M9 12h11M9 18h11M3 6l1 1 2-2M3 12l1 1 2-2M3 18l1 1 2-2" }] : []),
      { id: "lists", label: "Lists", icon: "M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" },
      { id: "files", label: "Files", icon: "M3 6h7l2 2h9v12H3z" },
      ...(!sample ? [{ id: "wiki", label: "Wiki", icon: "M4 3h12l4 4v14H4zM14 3v6h6M8 13h8M8 17h6" }] : []),
    ];
    for (const view of views) navigation.push({ ...view,
      href: routeHref({ view: view.id, workspaceId: workspace.id } as HomeRoute), current: route.view === view.id });
  }
  return { enabled: state === "channel", title: route.view === "catchup" ? "Catch up" : "Workspaces", workspaceName: workspace?.name, navigation, people: route.view === "people" };
}
