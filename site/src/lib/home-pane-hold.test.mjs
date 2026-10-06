import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { channelById } from "./channels.ts";

/** The production function, as text, ready to run with recording stubs. */
async function productionFunction(name) {
  const raw = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let text = "";
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      text = `const ${node.getText(ast)};`;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.match(text, new RegExp(`const ${name} =`));
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const renderChannelSource = await productionFunction("renderChannel");
const refreshChannelsSource = await productionFunction("refreshChannels");

const heldRoutes = [
  { view: "catchup" },
  { view: "todos", workspaceId: "W" },
  { view: "lists", workspaceId: "W" },
  { view: "files", workspaceId: "W" },
  { view: "wiki", workspaceId: "W" },
  { view: "add-agent", workspaceId: "W" },
  { view: "todo", workspaceId: "W", todoId: "T" },
  { view: "agent", workspaceId: "W", agentId: "A" },
];

function paintChannel(route, { agents = [{ id: "agent-1" }], pending = false } = {}) {
  const shown = [];
  const applied = [];
  const panels = [];
  const outcome = {};
  const context = createContext({
    shown,
    applied,
    panels,
    outcome,
    queueMicrotask,
  });
  const prelude = [
    `let homeRoute = ${JSON.stringify(route)};`,
    "let activeWorkspaceView = \"files\";",
    "let channelPending = false;",
    "let feedReady = true;",
    "let sampleMode = false;",
    `let agents = ${JSON.stringify(agents)};`,
    "let signals = [{ id: \"sig-1\" }];",
    "let session = { user: { id: \"U\" } };",
    "const accountName = () => \"Tom\";",
    "const one = (selector) => selector === \"[data-channel-id]\" ? { textContent: \"\" } : selector === \"[data-refresh]\" ? { hidden: true } : selector === \"[data-update-count]\" ? { hidden: true, textContent: \"\" } : null;",
    "const all = () => [];",
    "const renderChannelRail = () => {};",
    "const renderChannelHead = () => {};",
    "const renderSignalCounts = () => {};",
    "const renderWorkspaceList = () => {};",
    "const renderWorkspaceSettingsPanel = () => {};",
    "const renderRoster = () => {};",
    "const showPanel = (name) => { panels.push(name); };",
    "const showChannelView = (name) => { shown.push(name); };",
    "const applyRoute = () => { applied.push(homeRoute.view); };",
  ].join("\n");
  runInContext(`${prelude}\n${renderChannelSource}\nrenderChannel({ id: "W", name: "Home" }, ${pending}); outcome.view = activeWorkspaceView; outcome.pending = channelPending; outcome.ready = feedReady;`, context);
  return { shown, applied, panels, ...outcome };
}

test("a roster paint asks the route renderer and does not choose a channel view", () => {
  assert.match(renderChannelSource, /if \(homeRoute\.view === "new"\)\s*return;\s*showPanel\("channel"\);\s*applyRoute\(\)/);
  assert.doesNotMatch(renderChannelSource, /showChannelView\(/);
  const painted = [
    { view: "catchup" },
    { view: "chat", workspaceId: "W" },
    { view: "todos", workspaceId: "W" },
    { view: "lists", workspaceId: "W" },
    { view: "files", workspaceId: "W" },
    { view: "wiki", workspaceId: "W" },
    { view: "add-agent", workspaceId: "W" },
    { view: "todo", workspaceId: "W", todoId: "T" },
    { view: "agent", workspaceId: "W", agentId: "A" },
  ];
  for (const route of painted) {
    const result = paintChannel(route);
    assert.deepEqual(result.panels, ["channel"], route.view);
    assert.deepEqual(result.shown, [], route.view);
    assert.deepEqual(result.applied, [route.view], route.view);
    assert.equal(result.view, route.view === "chat" ? "signals" : "files", route.view);
  }

  const creating = paintChannel({ view: "new" });
  assert.deepEqual(creating.panels, [], "a late roster paint must leave the creation form up");
  assert.deepEqual(creating.applied, []);
  assert.deepEqual(creating.shown, []);
  assert.equal(creating.view, "files");

  const listsWhileLoading = paintChannel({ view: "lists", workspaceId: "W" }, { agents: [], pending: true });
  assert.deepEqual(listsWhileLoading.applied, ["lists"]);
  assert.deepEqual(listsWhileLoading.shown, []);
  assert.equal(listsWhileLoading.pending, true);
  assert.equal(listsWhileLoading.ready, false);
  assert.equal(listsWhileLoading.view, "files");
});

function settleRefresh(route, mode) {
  const selected = [];
  const rendered = [];
  const outcome = {};
  const context = createContext({
    selected,
    rendered,
    outcome,
    channelById,
    queueMicrotask,
  });
  const rows = mode === "resolved" || mode === "live"
    ? [{ channelId: "C", archivedAt: null }]
    : [{ channelId: "C", archivedAt: "2026-10-06T00:00:00.000Z" }];
  const prelude = [
    "let homeRoute = { view: \"chat\", workspaceId: \"W\" };",
    "let activeWorkspaceId = \"W\";",
    "let requestVersion = 4;",
    "let channelReadGeneration = 0;",
    "let channelListFailed = false;",
    "let channels = [];",
    "let activeChannelId = null;",
    "let unknownChannelId = null;",
    "let workspaceChannels = async () => [];",
    "const activeChannel = () => channelById(channels, activeChannelId);",
    "const selectChannel = (id) => { selected.push(id); activeChannelId = id; unknownChannelId = null; };",
    "const renderChannelRail = () => { rendered.push(\"rail\"); };",
    "const renderChannelHead = () => { rendered.push(\"head\"); };",
    "const renderChannelDialog = () => { rendered.push(\"dialog\"); };",
    "const renderFeed = () => { rendered.push(\"feed\"); };",
    "const applyRoute = () => { rendered.push(\"route\"); };",
  ].join("\n");
  const tail = `
    outcome.done = (async () => {
      activeChannelId = ${mode === "resolved" ? "null" : "\"C\""};
      unknownChannelId = ${mode === "resolved" ? "\"C\"" : "null"};
      channels = ${mode === "resolved" ? "[]" : "[{ channelId: \"C\", archivedAt: null }]"};
      workspaceChannels = () => new Promise((resolve) => {
        queueMicrotask(() => {
          homeRoute = ${JSON.stringify(route)};
          resolve(${JSON.stringify(rows)});
        });
      });
      await refreshChannels("W", requestVersion);
      outcome.activeChannelId = activeChannelId;
      outcome.unknownChannelId = unknownChannelId;
      outcome.channelListFailed = channelListFailed;
    })();
  `;
  runInContext(`${prelude}\n${refreshChannelsSource}\n${tail}`, context);
  return outcome.done.then(() => ({ selected, rendered, ...outcome }));
}

test("a channel read that lands after the address moves does not open chat", async () => {
  assert.match(refreshChannelsSource, /if \(homeRoute\.view !== "chat"\)/);
  assert.match(
    refreshChannelsSource,
    /if \(unknownChannelId !== null && channelById\(channels, unknownChannelId\) !== null\) \{\s*selectChannel\(unknownChannelId\);\s*return;/,
  );
  for (const route of heldRoutes) {
    for (const mode of ["archived", "resolved", "live"]) {
      const result = await settleRefresh(route, mode);
      assert.deepEqual(result.selected, [], `${route.view} ${mode}`);
      assert.deepEqual(result.rendered, ["rail", "head", "dialog", "route"], `${route.view} ${mode}`);
      assert.equal(result.channelListFailed, false, `${route.view} ${mode}`);
      assert.equal(result.unknownChannelId, null, `${route.view} ${mode}`);
      assert.equal(result.activeChannelId, mode === "archived" ? null : "C", `${route.view} ${mode}`);
    }
  }

  const archivedChat = await settleRefresh({ view: "chat", workspaceId: "W" }, "archived");
  assert.deepEqual(archivedChat.selected, [null]);
  assert.equal(archivedChat.activeChannelId, null);
  assert.deepEqual(archivedChat.rendered, []);

  const resolvedChat = await settleRefresh({ view: "chat", workspaceId: "W" }, "resolved");
  assert.deepEqual(resolvedChat.selected, ["C"]);
  assert.equal(resolvedChat.activeChannelId, "C");
  assert.equal(resolvedChat.unknownChannelId, null);
  assert.deepEqual(resolvedChat.rendered, []);

  const liveChat = await settleRefresh({ view: "chat", workspaceId: "W" }, "live");
  assert.deepEqual(liveChat.selected, []);
  assert.equal(liveChat.activeChannelId, "C");
  assert.deepEqual(liveChat.rendered, ["rail", "head", "dialog"]);
});
