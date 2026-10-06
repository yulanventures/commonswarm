import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { chatSurface, paneForRoute } from "./home-pane.ts";
import { parseRoute } from "./home-route.ts";

const routes = [
  ["?v=catchup", true, "catchup"],
  ["?v=new", true, "new"],
  ["?w=W", true, "chat"],
  ["?w=W&c=C", true, "chat"],
  ["?w=W&c=C&m=S", true, "chat"],
  ["?w=W&v=todos", true, "todos"],
  ["?w=W&v=lists", true, "lists"],
  ["?w=W&v=files", true, "files"],
  ["?w=W&v=wiki", true, "wiki"],
  ["?w=W&v=add-agent", true, "add-agent"],
  ["?w=W&todo=T", true, "todo"],
  ["?w=W&agent=A", true, "agent"],
  ["?w=W&todo=T", false, "not-found"],
  ["?w=W&agent=A", false, "not-found"],
  ["?w=W&v=not-a-pane", true, "chat"],
  ["?w=W&v=lists", false, "lists"],
];

test("the route decides the pane", () => {
  const seen = new Set();
  for (const [search, objectFound, pane] of routes) {
    assert.equal(paneForRoute(parseRoute(search), objectFound), pane, `${search} found=${objectFound}`);
    seen.add(pane);
  }
  for (const pane of ["chat", "todos", "lists", "files", "wiki", "add-agent", "todo", "agent", "not-found"]) {
    assert.equal(seen.has(pane), true, pane);
  }
});

const surfaces = [
  [{ loadError: true, pending: true, sample: false, agentCount: 0, signalCount: 0, unknownChannel: false, fixCount: 0 }, "feed-error"],
  [{ loadError: false, pending: true, sample: false, agentCount: 0, signalCount: 0, unknownChannel: false, fixCount: 0 }, "feed-pending"],
  [{ loadError: false, pending: true, sample: false, agentCount: 2, signalCount: 3, unknownChannel: false, fixCount: 0 }, "feed-pending"],
  [{ loadError: false, pending: false, sample: false, agentCount: 0, signalCount: 0, unknownChannel: false, fixCount: 0 }, "no-agents"],
  [{ loadError: false, pending: false, sample: true, agentCount: 0, signalCount: 2, unknownChannel: false, fixCount: 0 }, "feed"],
  [{ loadError: false, pending: false, sample: false, agentCount: 1, signalCount: 0, unknownChannel: true, fixCount: 0 }, "feed"],
  [{ loadError: false, pending: false, sample: false, agentCount: 1, signalCount: 0, unknownChannel: false, fixCount: 2 }, "feed"],
  [{ loadError: false, pending: false, sample: false, agentCount: 1, signalCount: 0, unknownChannel: false, fixCount: 0 }, "feed-empty"],
  [{ loadError: false, pending: false, sample: false, agentCount: 1, signalCount: 4, unknownChannel: false, fixCount: 0 }, "feed"],
];

test("chat keeps one pane and the load decides which list", () => {
  for (const [input, surface] of surfaces) {
    assert.equal(chatSurface(input), surface, JSON.stringify(input));
  }
});

function callersOf(source, callee) {
  const ast = ts.createSourceFile("dashboard.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const callers = new Set();
  const visit = (node, owner) => {
    let next = owner;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
      ts.isIdentifier(node.name)
    ) {
      next = node.name.text;
    } else if (ts.isFunctionDeclaration(node) && node.name) {
      next = node.name.text;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === callee) {
      callers.add(next ?? "<script>");
    }
    ts.forEachChild(node, (child) => visit(child, next));
  };
  visit(ast, null);
  return [...callers].sort();
}

test("only the route renderer chooses a channel view", async () => {
  const raw = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.deepEqual(callersOf(script, "showChannelView"), ["applyRoute"]);
  const background = [
    "renderFeed",
    "renderUnknownChannel",
    "loadSignals",
    "refreshDeliveryReceipts",
    "refreshLatestSignals",
    "refreshChannels",
    "renderChannel",
    "refreshPendingAccess",
    "renderRoster",
    "openInvite",
    "openConnect",
    "returnToChannel",
    "activateWorkspaceView",
    "keepConnectCredentialVisible",
    "openWorkspace",
    "selectChannel",
  ];
  const callers = new Set(callersOf(script, "showChannelView"));
  for (const name of background) assert.equal(callers.has(name), false, name);
});
