import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRoute, routeHref, parentRoute } from "./home-route.ts";

test("route precedence is to-do, agent, then view; unknown and empty views open chat", () => {
  assert.deepEqual(parseRoute("?w=Home&todo=T&agent=A&v=new"), { view: "todo", workspaceId: "Home", todoId: "T" });
  assert.deepEqual(parseRoute("?w=Home&agent=A&v=todos"), { view: "agent", workspaceId: "Home", agentId: "A" });
  assert.deepEqual(parseRoute("?w=Home&v=unknown&c=C&m=S"), { view: "chat", workspaceId: "Home", channelId: "C", messageId: "S" });
  assert.deepEqual(parseRoute(""), { view: "chat", workspaceId: null });
  assert.deepEqual(parseRoute("?w=Home&todo=&agent=&v=files&c=C&m=S"), { view: "files", workspaceId: "Home" });
  assert.deepEqual(parseRoute("?v=catchup&w=Home"), { view: "catchup" });
});

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

test("parent links return to the containing view or Catch up", () => {
  assert.deepEqual(parentRoute({ view: "todo", workspaceId: "W", todoId: "T" }), { view: "todos", workspaceId: "W" });
  assert.deepEqual(parentRoute({ view: "agent", workspaceId: "W", agentId: "A" }), { view: "chat", workspaceId: "W" });
  assert.deepEqual(parentRoute({ view: "people", workspaceId: "W" }), { view: "chat", workspaceId: "W" });
  for (const view of ["chat", "todos", "lists", "files", "wiki", "add-agent"]) assert.deepEqual(parentRoute({ view, workspaceId: "W" }), { view: "catchup" });
});
