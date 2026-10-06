import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { personFirstName } from "./home-names.ts";
import { chatSurface, paneForRoute } from "./home-pane.ts";

/** Production functions, plus the Invite screen's real Back listener. */
async function production() {
  const raw = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const handler = script.match(/\[data-close-invite\]"\)\?\.addEventListener\("click", \(\) => \{([\s\S]*?)\}\);/);
  assert.ok(handler, "Invite's Back listener must be the one on the page");
  const names = [
    "showChannelView",
    "applyRoute",
    "resetFreshInviteResult",
    "openInvite",
    "openAgentChoice",
    "openConnect",
    "activateWorkspaceView",
  ];
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const found = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && names.includes(node.name.text) && node.initializer) {
      found.set(node.name.text, `const ${node.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  for (const name of names) assert.ok(found.has(name), name);
  const text = `${names.map((name) => found.get(name)).join("\n")}\nconst pressInviteBack = () => {${handler[1]}};`;
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const source = await production();

function run(setup, body) {
  const channelViews = [
    "no-agents", "agent-choice", "invite", "connect", "feed-pending", "feed-empty",
    "feed-error", "feed", "files", "brain", "objects",
  ].map((name) => ({ hidden: true, dataset: { channelView: name } }));
  const elements = {
    "[data-home-catchup]": { hidden: true },
    "[data-home-route-pane]": { hidden: true },
    ".dashboard__channel": { hidden: false },
    "[data-home-channel-menu]": { hidden: true },
    ".hm-frame": { classList: { toggle() {} } },
    "[data-home-side-slot]": { replaceChildren() {} },
    "[data-channel-name]": { focus() {} },
    "[data-ahp-grid-title]": { focus() {} },
    "agent-host-picker": { reset() {}, setContext() {} },
    "agent-connect": {
      dataset: { state: "ready" },
      querySelector(selector) {
        if (selector === "[data-panel='form']") return { dataset: { hasAgents: "no" } };
        if (selector === "[data-field='name']") return { focus() {} };
        return null;
      },
    },
  };
  const app = { dataset: { channelView: "feed", state: "channel" } };
  const outcome = { navigated: [], painted: [], chrome: [] };
  const context = createContext({
    paneForRoute,
    chatSurface,
    personFirstName,
    elements,
    channelViews,
    app,
    outcome,
    queueMicrotask,
  });
  const prelude = `
    let homeRoute = { view: "chat", workspaceId: "W" };
    let channelOverlay = null;
    let inviteReturnView = "agent-choice";
    let sampleMode = false;
    let activeWorkspaceId = "W";
    let activeChannelId = null;
    let unknownChannelId = null;
    let signalExpiryTimer;
    let connectFocusObserver = null;
    let paintingInsideRoute = false;
    let freshInviteLink = "";
    let freshInviteId = "";
    let freshInviteWorkspaceId = "";
    let channelLoadError = "";
    let channelPending = false;
    let feedReady = true;
    let homePeopleReadState = "ready";
    let householdAccessGeneration = 0;
    let householdListsOpenedGeneration = 0;
    let session = { user: { id: "tom", email: "tom@example.test", user_metadata: {} } };
    let workspaces = [{ id: "W", name: "Home" }];
    let members = [{ userId: "tom", name: "Tom Langridge", role: "owner" }];
    let agents = [{ principalId: "A" }];
    let signals = [];
    const window = { clearTimeout() {}, requestAnimationFrame(fn) { fn(); } };
    const one = (selector) => elements[selector] ?? null;
    const all = (selector) => selector === "[data-channel-view]" ? channelViews : [];
    const accountName = () => "Tom";
    const routeTargetFound = () => true;
    const disarmLiveFeed = () => {};
    const closeMentionPicker = () => {};
    const syncComposerPlacement = () => {};
    const armLiveFeed = () => {};
    const renderHomeSide = () => {};
    const renderHomeCatchUp = () => {};
    const renderChannelHead = () => {};
    const renderFeed = () => {};
    const renderSetupChecklist = () => {};
    const renderFiles = () => {};
    const renderBrain = () => {};
    const openHouseholdView = () => {};
    const loadHomeObject = () => {};
    const stopHostJoinWatch = () => {};
    const syncConnectWorkspace = () => {};
    const homeAgentFixCards = () => [];
    const currentHomePeople = () => ({});
    const routeHref = () => "/app?w=W";
    const keepConnectCredentialVisible = () => false;
    const returnToChannel = () => { outcome.returned = true; };
    const navigateHome = (route, mode) => { outcome.navigated.push({ view: route.view, mode }); };
    const paintWorkspaceChrome = (view) => { outcome.chrome.push(view); };
    const renderHomeObjectPane = () => {
      outcome.painted.push("object");
      elements["[data-home-route-pane]"].hidden = false;
    };
    function finish() {
      outcome.overlay = channelOverlay;
      outcome.view = app.dataset.channelView;
      outcome.channelHidden = elements[".dashboard__channel"].hidden;
      outcome.routeHidden = elements["[data-home-route-pane]"].hidden;
      outcome.visible = channelViews.filter((section) => !section.hidden).map((section) => section.dataset.channelView);
    }
  `;
  runInContext(`${prelude}\n${source}\n${setup}\n${body}\nfinish();`, context);
  return JSON.parse(JSON.stringify(outcome));
}

test("Back to Add an agent leaves Invite and shows Add an agent", () => {
  const result = run(
    `homeRoute = { view: "add-agent", workspaceId: "W" }; app.dataset.channelView = "agent-choice";`,
    `openInvite("agent-choice"); outcome.opened = app.dataset.channelView; pressInviteBack();`,
  );
  assert.equal(result.opened, "invite");
  assert.equal(result.overlay, null);
  assert.equal(result.view, "agent-choice");
  assert.deepEqual(result.visible, ["agent-choice"]);
  assert.equal(result.channelHidden, false);
  assert.deepEqual(result.navigated, []);
});

test("Get a new key on an agent or to-do address shows Connect in the centre", () => {
  const routes = [
    { view: "agent", workspaceId: "W", agentId: "A" },
    { view: "todo", workspaceId: "W", todoId: "T" },
    { view: "todos", workspaceId: "W" },
  ];
  for (const route of routes) {
    const result = run(
      `homeRoute = ${JSON.stringify(route)}; elements[".dashboard__channel"].hidden = true; elements["[data-home-route-pane]"].hidden = false;`,
      "openConnect();",
    );
    assert.equal(result.overlay, "connect", route.view);
    assert.equal(result.view, "connect", route.view);
    assert.deepEqual(result.visible, ["connect"], route.view);
    assert.equal(result.channelHidden, false, route.view);
    assert.equal(result.routeHidden, true, route.view);
    assert.deepEqual(result.painted, [], route.view);
  }

  const chat = run(
    `homeRoute = { view: "chat", workspaceId: "W" };`,
    "openConnect();",
  );
  assert.equal(chat.view, "connect");
  assert.equal(chat.channelHidden, false);
  assert.deepEqual(chat.visible, ["connect"]);
});

test("an agent address without Connect keeps its own pane", () => {
  const result = run(
    `homeRoute = { view: "agent", workspaceId: "W", agentId: "A" }; elements[".dashboard__channel"].hidden = true;`,
    "applyRoute();",
  );
  assert.equal(result.overlay, null);
  assert.equal(result.channelHidden, true);
  assert.equal(result.routeHidden, false);
  assert.deepEqual(result.painted, ["object"]);
  assert.deepEqual(result.visible, []);
});

test("Open Lists from Invite on the Lists address shows Lists", () => {
  const staying = run(
    `homeRoute = { view: "lists", workspaceId: "W" }; channelOverlay = "invite"; app.dataset.channelView = "invite";
     channelViews.forEach((section) => { section.hidden = section.dataset.channelView !== "invite"; });`,
    `activateWorkspaceView("objects");`,
  );
  assert.equal(staying.overlay, null);
  assert.equal(staying.view, "objects");
  assert.deepEqual(staying.visible, ["objects"]);
  assert.equal(staying.channelHidden, false);
  assert.deepEqual(staying.navigated, []);
  assert.deepEqual(staying.chrome, ["objects"]);

  const leaving = run(
    `homeRoute = { view: "chat", workspaceId: "W" }; channelOverlay = "invite"; app.dataset.channelView = "invite";`,
    `activateWorkspaceView("objects");`,
  );
  assert.deepEqual(leaving.navigated, [{ view: "lists", mode: "push" }]);
  assert.equal(leaving.overlay, null);
  assert.deepEqual(leaving.chrome, []);
});
