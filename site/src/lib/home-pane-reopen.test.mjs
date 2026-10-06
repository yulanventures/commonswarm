import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { resolveHomeRoute } from "./home-map.ts";
import { chatSurface, paneForRoute } from "./home-pane.ts";
import { routeHref } from "./home-route.ts";

/** Production functions, as they are written on the page. */
async function production(names) {
  const raw = await readFile(new URL("../components/app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
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
  const text = names.map((name) => found.get(name)).join("\n");
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}

const listsSource = await production(["resetHouseholdSurface", "applyRoute", "openHouseholdView"]);
const navigationSource = await production(["showChannelView", "applyRoute", "navigateHome"]);

function runLists(body) {
  const calls = [];
  const app = { dataset: { channelView: "objects", state: "channel" } };
  const outcome = {};
  const context = createContext({
    calls,
    app,
    outcome,
    paneForRoute,
    chatSurface,
    queueMicrotask,
    Date,
    Promise,
    Map,
  });
  const prelude = `
    let homeRoute = { view: "lists", workspaceId: "W" };
    let channelOverlay = null;
    let sampleMode = false;
    let homePeopleReadState = "ready";
    let householdAccessGeneration = 3;
    let householdListsOpenedGeneration = 3;
    let activeWorkspaceId = "W";
    let activeWorkspaceView = "signals";
    let session = { user: { id: "tom" } };
    let workspaces = [{ id: "W", name: "Home" }];
    let householdAccess = { workspaceId: "W", status: "ok", contentRole: "editor" };
    let householdDashboard = { clear() { calls.push("clear"); } };
    let householdConnections = [];
    let householdConnectionsReadState = "succeeded";
    let householdReceipts = new Map();
    let removedAgents = new Map();
    let removedAgentOwners = new Map();
    let householdAccessRequestedFor = "W";
    const accessReads = { invalidate() {} };
    const connectionReads = { invalidate() {} };
    let paintingInsideRoute = false;
    const elements = {
      "[data-home-catchup]": { hidden: true },
      "[data-home-route-pane]": { hidden: true },
      ".dashboard__channel": { hidden: false },
      "[data-home-channel-menu]": { hidden: true },
      ".hm-frame": { classList: { toggle() {} } },
      "[data-home-side-slot]": { replaceChildren() {} },
    };
    const one = (selector) => elements[selector] ?? null;
    const all = () => [];
    const showChannelView = (name) => { app.dataset.channelView = name; };
    const paintWorkspaceChrome = (view) => { activeWorkspaceView = view; };
    const renderHomeSide = () => {};
    const renderHomeCatchUp = () => {};
    const renderHouseholdAccess = () => { calls.push("card"); };
    const refreshHouseholdAccess = async () => { calls.push("access"); };
    const loadHouseholdConnections = () => { calls.push("connections"); };
    const routeTargetFound = () => true;
    const loadHomeObject = () => {};
    const stopHostJoinWatch = () => {};
    const renderFiles = () => {};
    const renderBrain = () => {};
    const renderChannelHead = () => {};
    const renderFeed = () => {};
    const renderSetupChecklist = () => {};
    const renderHomeObjectPane = () => {};
  `;
  runInContext(`${prelude}\n${listsSource}\n${body}\noutcome.calls = calls.slice(); outcome.view = app.dataset.channelView;`, context);
  return outcome;
}

test("reopening a workspace reloads Lists while the view is still Lists", () => {
  const result = runLists(`
    applyRoute();
    outcome.whileCurrent = calls.slice();
    homePeopleReadState = "pending";
    resetHouseholdSurface();
    applyRoute();
    outcome.whileRosterOpens = calls.slice();
    homePeopleReadState = "ready";
    applyRoute();
    outcome.afterRoster = calls.slice();
    applyRoute();
    outcome.afterBackground = calls.slice();
    app.dataset.channelView = "files";
    applyRoute();
    outcome.afterReturn = calls.slice();
  `);
  assert.deepEqual(result.whileCurrent, []);
  assert.deepEqual(result.whileRosterOpens, ["clear"]);
  assert.deepEqual(result.afterRoster, ["clear", "card", "access"]);
  assert.deepEqual(result.afterBackground, ["clear", "card", "access"]);
  assert.deepEqual(result.afterReturn, ["clear", "card", "access", "card", "access"]);
  assert.equal(result.view, "objects");
});

function runNavigation(setup, body) {
  const channelViews = [
    "no-agents", "agent-choice", "invite", "connect", "feed-pending", "feed-empty",
    "feed-error", "feed", "files", "brain", "objects",
  ].map((name) => ({ hidden: name !== "invite", dataset: { channelView: name } }));
  const elements = {
    "[data-home-catchup]": { hidden: true },
    "[data-home-route-pane]": { hidden: true },
    ".dashboard__channel": { hidden: false },
    "[data-home-channel-menu]": { hidden: true },
    ".hm-frame": { classList: { toggle() {} } },
    "[data-home-side-slot]": { replaceChildren() {} },
    "[data-feed-error]": { textContent: "", hidden: true },
    "[data-composer]": { hidden: true },
    "[data-live-chip]": { hidden: true },
    ".dashboard__feed-view": { scrollTop: 4 },
  };
  const app = { dataset: { channelView: "invite", state: "channel" } };
  const pushed = [];
  const outcome = { pushed };
  const context = createContext({
    app,
    elements,
    channelViews,
    pushed,
    outcome,
    paneForRoute,
    chatSurface,
    resolveHomeRoute,
    routeHref,
    URL,
    Date,
    Promise,
    Error,
    queueMicrotask,
  });
  const prelude = `
    let homeRoute = { view: "lists", workspaceId: "W" };
    let channelOverlay = "invite";
    let sampleMode = false;
    let session = { user: { id: "tom", email: "tom@example.test" } };
    let workspaces = [{ id: "W", name: "Home" }];
    let activeWorkspaceId = "W";
    let homeNavigation = 0;
    let catchUpGeneration = 0;
    let homeDetailGeneration = 0;
    let homeDetailKey = "";
    let homeTodoRead = null;
    let homeQueue = null;
    let homeQueueRead = "pending";
    let homeTodoSave = "idle";
    let homeTodoReceipt = "";
    let homeTodoNotice = null;
    let requestVersion = 4;
    let channelLoadError = "";
    let channelPending = false;
    let feedReady = true;
    let paintingInsideRoute = false;
    let signalExpiryTimer;
    let unknownChannelId = null;
    let agents = [{ principalId: "A" }];
    let signals = [{ id: "sig-1", until: null }];
    let homeScroll = new Map();
    const window = {
      location: { origin: "https://example.test" },
      history: {
        state: { home: true },
        pushState(_state, _title, url) { pushed.push(String(url)); },
        replaceState() {},
      },
      clearTimeout() {},
      requestAnimationFrame(fn) { fn(); },
    };
    const one = (selector) => elements[selector] ?? null;
    const all = (selector) => selector === "[data-channel-view]" ? channelViews : [];
    const keepConnectCredentialVisible = () => false;
    const closeEntityPanel = () => {};
    const closeRosterDialog = () => {};
    const closeWorkspaceDetailsDialog = () => {};
    const openNewWorkspace = () => {};
    const focusHomeView = () => { outcome.focused = true; };
    const openWorkspace = () => { throw new Error("same workspace must not reopen"); };
    const openSampleWorkspace = () => {};
    const applyChannelFromUrl = () => {};
    const syncChannelUrl = () => {};
    const renderHomeRail = () => {};
    const renderHomeShell = () => {};
    const renderChannelRail = () => {};
    const renderHomeSide = () => {};
    const renderHomeCatchUp = () => {};
    const renderChannelHead = () => {};
    const renderFeed = () => { outcome.fed = (outcome.fed ?? 0) + 1; };
    const renderSetupChecklist = () => {};
    const renderHomeObjectPane = () => {};
    const loadHomeObject = () => {};
    const stopHostJoinWatch = () => {};
    const paintWorkspaceChrome = () => {};
    const openHouseholdView = () => { outcome.openedLists = true; };
    const disarmLiveFeed = () => {};
    const armLiveFeed = () => {};
    const closeMentionPicker = () => {};
    const syncComposerPlacement = () => {};
    const routeTargetFound = () => true;
    const homeAgentFixCards = () => [];
    const currentHomePeople = () => ({});
    const readableError = () => "The latest updates did not load.";
    let loadMode = () => Promise.resolve();
    const loadSignals = (...args) => loadMode(...args);
    const snap = () => ({
      view: app.dataset.channelView,
      visible: channelViews.filter((section) => !section.hidden).map((section) => section.dataset.channelView),
      route: homeRoute.view,
      overlay: channelOverlay,
      error: elements["[data-feed-error]"].textContent,
      url: pushed[pushed.length - 1] ?? "",
    });
  `;
  return runInContext(`
    ${prelude}
    ${navigationSource}
    ${setup}
    outcome.done = (async () => { ${body} })();
  `, context).then(() => outcome);
}

test("Back to the channel leaves Invite when the signal read fails", async () => {
  const result = await runNavigation(
    `loadMode = () => new Promise((_, reject) => { outcome.rejectRead = reject; });`,
    `
      const pendingNav = navigateHome({ view: "chat", workspaceId: "W" }, "push");
      outcome.duringRead = snap();
      outcome.rejectRead(new Error("database said something internal"));
      await pendingNav;
      outcome.afterFailure = snap();
    `,
  );
  assert.equal(result.duringRead.route, "chat");
  assert.equal(result.duringRead.overlay, null);
  assert.equal(result.duringRead.url, "/app?w=W");
  assert.deepEqual(result.duringRead.visible, ["feed"]);
  assert.equal(result.duringRead.view, "feed");
  assert.equal(result.afterFailure.route, "chat");
  assert.equal(result.afterFailure.url, "/app?w=W");
  assert.deepEqual(result.afterFailure.visible, ["feed-error"]);
  assert.equal(result.afterFailure.view, "feed-error");
  assert.equal(result.afterFailure.error, "The latest updates did not load. Nothing was changed.");
  assert.equal(result.afterFailure.error.includes("database said"), false);
  assert.equal(result.focused, true);
  assert.equal(result.openedLists, undefined);
});

test("a signal read that fails after the reader has left chat does not paint an error over the new pane", async () => {
  const result = await runNavigation(
    `loadMode = () => new Promise((_, reject) => { outcome.rejectRead = reject; });`,
    `
      const pendingNav = navigateHome({ view: "chat", workspaceId: "W" }, "push");
      homeRoute = { view: "lists", workspaceId: "W" };
      homeNavigation += 1;
      app.dataset.channelView = "objects";
      outcome.rejectRead(new Error("database said something internal"));
      await pendingNav;
      outcome.view = app.dataset.channelView;
      outcome.error = elements["[data-feed-error]"].textContent;
      outcome.route = homeRoute.view;
    `,
  );
  assert.equal(result.view, "objects");
  assert.equal(result.route, "lists");
  assert.equal(result.error, "");
});
