import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, routeHref } from "./home-route.ts";

test("all addresses round trip and encoded ids cannot add a query field", () => {
  const cases = [
    [{ view: "catchup" }, "/app?v=catchup"], [{ view: "new" }, "/app?v=new"],
    [{ view: "chat", workspaceId: null }, "/app"],
    [{ view: "chat", workspaceId: "W", channelId: "C", messageId: "S" }, "/app?w=W&c=C&m=S"],
    ...["todos", "lists", "files", "wiki", "add-agent", "people"].map(view => [{ view, workspaceId: "W" }, `/app?w=W&v=${view}`]),
    [{ view: "todo", workspaceId: "W", todoId: "T&agent=A" }, "/app?w=W&todo=T%26agent%3DA"],
    [{ view: "agent", workspaceId: "W / 李", agentId: "A#x" }, "/app?w=W+%2F+%E6%9D%8E&agent=A%23x"],
  ];
  for (const [route, expected] of cases) {
    assert.equal(routeHref(route), expected);
    assert.deepEqual(parseRoute(new URL(expected, "https://example.test").search), route);
  }
});
