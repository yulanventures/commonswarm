import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";

/** The production return, executed. Stubs only record what the screen was told to show. */
async function productionReturnToChannel() {
  const raw = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let text = "";
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "returnToChannel" &&
      node.initializer
    ) {
      text = `const ${node.getText(ast)};`;
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.match(text, /navigateHome\(\{ view: "chat"/);
  assert.doesNotMatch(text, /showChannelView\(/);
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const source = await productionReturnToChannel();

function scene(tail = "returnToChannel();") {
  const shown = [];
  const applied = [];
  const navigated = [];
  const loaded = [];
  const target = { hidden: true, textContent: "" };
  const context = createContext({
    shown,
    applied,
    navigated,
    loaded,
    target,
    loadMode: () => Promise.resolve(),
    queueMicrotask,
  });
  const prelude = [
    'let homeRoute = { view: "lists", workspaceId: "W" };',
    'let activeWorkspaceId = "W";',
    "let activeChannelId = null;",
    'let pendingWorkspaceId = "pending";',
    'let channelOverlay = "invite";',
    "let feedReady = true;",
    "let channelPending = false;",
    "let sampleMode = false;",
    'let channelLoadError = "";',
    'let agents = [{ id: "agent-1" }];',
    'let signals = [{ id: "sig-1" }];',
    "let requestVersion = 4;",
    "const showChannelView = (name) => { shown.push(name); };",
    "const applyRoute = () => { applied.push(homeRoute.view); };",
    "const navigateHome = (route) => { navigated.push(route.view + \"|\" + (route.workspaceId ?? \"\") + \"|\" + (route.channelId ?? \"\")); };",
    "const one = () => target;",
    'const readableError = () => "The latest updates did not load.";',
    "const loadSignals = () => { loaded.push(homeRoute.view); return loadMode(); };",
  ].join("\n");
  runInContext(prelude + "\n" + source + "\n" + tail, context);
  return { shown, applied, navigated, loaded, target };
}

const leaving = [
  { view: "lists", workspaceId: "W" },
  { view: "files", workspaceId: "W" },
  { view: "wiki", workspaceId: "W" },
  { view: "todos", workspaceId: "W" },
  { view: "todo", workspaceId: "W", todoId: "T" },
  { view: "agent", workspaceId: "W", agentId: "A" },
  { view: "add-agent", workspaceId: "W" },
  { view: "catchup" },
];

test("Back to the channel changes the address to chat before anything is painted", () => {
  for (const route of leaving) {
    const result = scene(`homeRoute = ${JSON.stringify(route)}; returnToChannel();`);
    assert.deepEqual(result.shown, [], route.view);
    assert.deepEqual(result.applied, [], route.view);
    assert.deepEqual(result.loaded, [], route.view);
    assert.deepEqual(result.navigated, ["chat|W|"], route.view);
  }

  const creating = scene(`homeRoute = { view: "new" }; returnToChannel();`);
  assert.deepEqual(creating.navigated, []);
  assert.deepEqual(creating.applied, []);
  assert.deepEqual(creating.shown, []);

  const noWorkspace = scene(`homeRoute = { view: "catchup" }; activeWorkspaceId = ""; returnToChannel();`);
  assert.deepEqual(noWorkspace.navigated, []);
  assert.deepEqual(noWorkspace.applied, []);

  const chat = scene(`homeRoute = { view: "chat", workspaceId: "W" }; returnToChannel();`);
  assert.deepEqual(chat.navigated, []);
  assert.deepEqual(chat.shown, []);
  assert.deepEqual(chat.applied, ["chat"]);
  assert.deepEqual(chat.loaded, []);

  const chatError = scene(`homeRoute = { view: "chat", workspaceId: "W" }; channelLoadError = "earlier"; feedReady = false; returnToChannel();`);
  assert.deepEqual(chatError.shown, []);
  assert.deepEqual(chatError.applied, ["chat"]);
  assert.deepEqual(chatError.loaded, []);

  const chatEmpty = scene(`homeRoute = { view: "chat", workspaceId: "W" }; feedReady = false; signals = []; returnToChannel();`);
  assert.deepEqual(chatEmpty.shown, []);
  assert.deepEqual(chatEmpty.applied, ["chat"]);
  assert.deepEqual(chatEmpty.loaded, ["chat"]);

  const noAgents = scene(`homeRoute = { view: "chat", workspaceId: "W" }; agents = []; feedReady = false; returnToChannel();`);
  assert.deepEqual(noAgents.shown, []);
  assert.deepEqual(noAgents.applied, ["chat"]);
  assert.deepEqual(noAgents.loaded, []);
});

test("a chat read that fails after the address moves to Lists does not cover Lists", async () => {
  const result = scene(`
    homeRoute = { view: "chat", workspaceId: "W" };
    feedReady = false;
    signals = [];
    loadMode = () => new Promise((_, reject) => {
      queueMicrotask(() => {
        homeRoute = { view: "lists", workspaceId: "W" };
        reject(new Error("database said something internal"));
      });
    });
    returnToChannel();
  `);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(result.shown, []);
  assert.deepEqual(result.applied, ["chat"]);
  assert.equal(result.target.textContent, "The latest updates did not load. Nothing was changed.");
  assert.equal(result.target.textContent.includes("database said"), false);

  const stillChat = scene(`
    homeRoute = { view: "chat", workspaceId: "W" };
    feedReady = false;
    signals = [];
    loadMode = () => Promise.reject(new Error("database said something internal"));
    returnToChannel();
  `);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(stillChat.shown, []);
  assert.deepEqual(stillChat.applied, ["chat", "chat"]);
  assert.equal(stillChat.target.textContent, "The latest updates did not load. Nothing was changed.");
});
