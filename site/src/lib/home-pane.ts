import type { HomeRoute } from "./home-route";

/**
 * The screen a route shows. Chat's feed, empty, and error states are that one pane.
 * A missing to-do or agent is not a query value: the route stays todo or agent,
 * and the object read says it is gone.
 */
export type HomePane =
  | "catchup"
  | "new"
  | "chat"
  | "todos"
  | "lists"
  | "files"
  | "wiki"
  | "add-agent"
  | "todo"
  | "agent"
  | "not-found";

/**
 * What the chat pane is showing. The route is still chat.
 * Order matches the channel: a failed load, a load still opening,
 * no agents, then the message list (an unresolved channel or fix cards included),
 * then an empty list. Sample mode paints the list even with no agents.
 */
export type ChatSurface = "feed" | "feed-pending" | "feed-empty" | "feed-error" | "no-agents";

export interface ChatSurfaceInput {
  loadError: boolean;
  pending: boolean;
  sample: boolean;
  agentCount: number;
  signalCount: number;
  unknownChannel: boolean;
  fixCount: number;
}

/** objectFound is read only for a to-do or an agent. Unknown v is already chat once parseRoute has run. */
export function paneForRoute(route: HomeRoute, objectFound = true): HomePane {
  if ((route.view === "todo" || route.view === "agent") && !objectFound) return "not-found";
  return route.view;
}

export function chatSurface(input: ChatSurfaceInput): ChatSurface {
  if (input.loadError) return "feed-error";
  if (input.pending) return "feed-pending";
  if (!input.sample && input.agentCount === 0) return "no-agents";
  if (input.unknownChannel || input.fixCount > 0) return "feed";
  if (input.signalCount === 0) return "feed-empty";
  return "feed";
}
