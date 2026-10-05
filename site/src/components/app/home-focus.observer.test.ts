import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build } from "esbuild";
import ts from "typescript";
import { browserTest, findChrome, buildChromeArgs, resolveChromePath } from "../../../tests/chrome.js";
import { PendingRefreshGate } from "../../lib/pending-refresh";
import { mapHomePeople } from "../../lib/home-map";

async function focusFixture() {
  const source = await readFile(new URL("LiveDashboard.astro", import.meta.url), "utf8");
  const file = ts.createSourceFile("dashboard.ts", source.match(/<script>([\s\S]*?)<\/script>/u)![1], ts.ScriptTarget.Latest, true);
  const names = ["homeViewerId", "currentHomePeople", "renderHomeRail", "renderHomeShell", "renderHomeCatchUp",
    "wakeMarkKey", "renderRoster", "hasPendingAccess", "refreshPendingAccess"];
  const declarations = new Map<string, string>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(file))) declarations.set(node.name.getText(file), node.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of names) assert.ok(declarations.has(name), `production ${name} is available`);
  const setup = `
    const one = (selector) => document.querySelector(selector);
    let now = Date.parse('2026-10-05T12:00:00Z'); Date.now = () => now;
    const session = {user:{id:'tom'}}, sampleMode = false, accountName = () => 'Tom';
    let workspaces = [{id:'W',name:'Home'},{id:'X',name:'Trip'}];
    let homeRoute = {view:'chat',workspaceId:'W'}, activeWorkspaceId = 'W', requestVersion = 1;
    let members = [{userId:'tom',name:'Tom',role:'owner'}];
    let agents = [{principalId:'A',name:'Claude',ownerUserId:'tom',transport:'hosted_mcp',
      work:{work:'idle',facts:{transport:'hosted_mcp',turn_only:true,connection:'live',last_activity_at:'2026-10-05T11:47:00Z'}}}];
    let people = new Map(), accessStatuses = [], homeWorkClaims = [], pendingInvites = [], pendingAgents = [];
    let pendingAgentsLoadFailed = false, freshInviteWorkspaceId = '', freshInviteId = '';
    let railExpanded = false, catchUpExpanded = false, homeShellKey = '', homeRailKey = '', homeCatchUpKey = '', renderedWakeMarkKey = '';
    let catchUpData = [], rosterReads = 0, rosterRenders = 0;
    const homeOverviewCounts = new Map(), pendingRefreshGate = new PendingRefreshGate(12000,30000);
    const pendingMemberInvites = async () => [], agentAccessStatuses = async () => [];
    const pendingAgentAccess = async () => [], loadPendingAccess = async read => ({rows:await read(),failed:false});
    const memberRoster = async () => { rosterReads++; return {members:[...members],names:new Map()}; };
    const renderMembers = () => {}, renderPendingAccess = () => {}, renderHeaderRoster = () => {}, renderDialogRoster = () => {}, restoreComposerOnEntry = () => {};
    let syncComposerAddress = () => {};
    const renderSetupChecklist = () => { rosterRenders++; };
    const wakePathMark = () => null, shouldRetireFreshInvite = () => false, retireFreshInviteResult = () => {};
    const navigateHomeHref = () => {}, selectHomePerson = () => {}, navigateHome = () => {}, homeBack = () => {}, openRosterDialog = () => {}, openWorkspaceDetailsDialog = () => {};
    const poll = async (elapsed = 30001) => { now += elapsed; await refreshPendingAccess('W',1); return {reads:rosterReads,rendered:rosterRenders}; };
  `;
  const production = (selected = names) => selected.map(name => `const ${declarations.get(name)};`).join("\n");
  return { setup, production };
}

function assertPollCompleted(progress: { reads: number; rendered: number }, expectedReads: number): void {
  assert.equal(progress.reads, expectedReads, "each poll actually completed a roster read");
  assert.equal(progress.rendered, expectedReads + 1, "initial paint and each poll reached the end of renderRoster");
}

test("focus observer fixture ages production status detail and completes both poll renders", async () => {
  const { setup, production } = await focusFixture();
  // Only the DOM paint boundaries are replaced here; the browser uses the real builders.
  const context = createContext({ PendingRefreshGate, mapHomePeople });
  const script = `${setup}
    const renderHomeRail = () => {}, renderHomeShell = () => {};
    ${production(["homeViewerId", "currentHomePeople", "wakeMarkKey", "renderRoster", "hasPendingAccess", "refreshPendingAccess"])}
    renderRoster(); poll;
  `;
  const poll = runInContext(ts.transpileModule(script, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  assert.equal(runInContext("rosterRenders", context), 1, "fixture boot reached the end of renderRoster");
  const detail = () => runInContext("currentHomePeople().groups[0].agents[0].state.detail", context);
  assert.equal(detail(), "Active 13 minutes ago", "fixture starts outside the Active now window");
  for (const [expectedReads, expectedDetail] of [[1, "Active 13 minutes ago"], [2, "Active 14 minutes ago"]] as const) {
    assertPollCompleted(await poll(), expectedReads);
    assert.equal(detail(), expectedDetail, "production mapping crosses a minute boundary during the poll sequence");
  }
  runInContext("syncComposerAddress = () => { throw new Error('fixture render failed'); }", context);
  const interrupted = await poll();
  assert.equal(interrupted.reads, 3, "a failed render still reached the read");
  assert.equal(interrupted.rendered, 3, "a swallowed render failure did not complete another paint");
  assert.throws(() => assertPollCompleted(interrupted, 3), assert.AssertionError, "read success cannot conceal an incomplete render");
});

// Use Chrome's debugging pipe: real Tab events, file fixtures and no HTTP/server/network calls.
browserTest("home refreshes keep rail controls, view headings and workspace menu focus", { timeout: 60_000 }, async () => {
  const { setup, production } = await focusFixture();
  const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fixtureScript = `
    import { buildHomeRail } from './src/lib/home-rail';
    import { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell';
    import { renderCatchUp as buildCatchUp } from './src/lib/home-catchup';
    import { homeStructureKey, replaceHomeRegion, refreshHomeRailTimes, refreshHomeCatchUpTimes } from './src/lib/home-focus';
    import { mapHomePeople, mapHomeRail, mapCatchUp, initialCatchUpData } from './src/lib/home-map';
    import { routeHref } from './src/lib/home-route';
    import { PendingRefreshGate } from './src/lib/pending-refresh';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    ${setup}
    ${production()}
    renderRoster();
    window.fixture = {
      poll,
      rename: () => { workspaces = workspaces.map(w => w.id === 'X' ? {...w,name:'Summer trip'} : w); renderRoster(); },
      removeTrip: () => { workspaces = workspaces.filter(w => w.id !== 'X'); renderRoster(); },
      changeShell: () => { workspaces = workspaces.map(w => w.id === 'W' ? {...w,name:'House'} : w); renderHomeShell(); },
      catchup: () => { homeRoute = {view:'catchup'}; catchUpData = initialCatchUpData(workspaces); renderHomeCatchUp(); },
      fillCard: () => { catchUpData[0] = {...catchUpData[0],state:'open'}; renderHomeCatchUp(); },
      repaint: () => { now += 60000; renderHomeCatchUp(); }
    };
  `;
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, write: false, format: "iife", platform: "browser",
    outfile: "focus.js", stdin: { contents: fixtureScript, resolveDir: siteRoot, loader: "ts" } });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-focus-"));
  const fixturePath = join(directory, "index.html");
  await writeFile(fixturePath, `<!doctype html><html><head><style>${css}
    [hidden] {display:none!important} .hm-phone-bar,.hm-ws-nav {display:none}
    </style></head><body><div data-home-rail-slot></div><div data-home-workspace-shell></div>
    <div data-home-phone-nav></div><section data-home-catchup></section>
    <script>${js.replace(/<\/script/giu, "<\\/script")}</script></body></html>`);
  const chrome = await resolveChromePath(await findChrome());
  const profile = await mkdtemp(join(tmpdir(), "commonswarm-home-focus-profile-"));
  const child = spawn(chrome, buildChromeArgs(["--remote-debugging-pipe", "--window-size=1440,900", "about:blank"], profile, process.env.GITHUB_ACTIONS === "true"),
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const input = child.stdio[3] as import("node:stream").Writable;
  const output = child.stdio[4] as import("node:stream").Readable;
  let sequence = 0, buffered = "";
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let pageLoad: { resolve: () => void; reject: (error: Error) => void } | undefined;
  const rejectPending = (error: Error) => { for (const call of pending.values()) call.reject(error); pending.clear(); pageLoad?.reject(error); };
  child.on("error", rejectPending);
  child.on("exit", () => rejectPending(new Error("fixture browser exited")));
  child.stderr?.resume();
  output.setEncoding("utf8");
  output.on("data", chunk => {
    buffered += chunk;
    let end: number;
    while ((end = buffered.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffered.slice(0, end)); buffered = buffered.slice(end + 1);
      if (message.method === "Page.loadEventFired") pageLoad?.resolve();
      const call = pending.get(message.id);
      if (!call) continue;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(JSON.stringify(message.error))); else call.resolve(message.result);
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++sequence; pending.set(id, { resolve, reject });
    input.write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
  });
  // Own a hard deadline even if a browser exits before the first protocol reply.
  const deadline = setTimeout(() => { rejectPending(new Error("focus fixture deadline")); child.kill("SIGKILL"); }, 45_000);
  try {
    const { targetId } = await send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
    const evaluate = async (expression: string) => {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
      assert.equal(result.exceptionDetails, undefined, JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await send("Page.enable", {}, sessionId);
    const loaded = new Promise<void>((resolve, reject) => { pageLoad = { resolve, reject }; });
    await send("Page.navigate", { url: pathToFileURL(fixturePath).href }, sessionId);
    await loaded; pageLoad = undefined;
    assert.equal(await evaluate("!!window.fixture"), true, "production refresh functions initialized");
    const tab = async () => {
      await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
      await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }, sessionId);
    };
    await tab(); await tab(); await tab();
    assert.equal(await evaluate("document.activeElement.dataset.railWorkspace"), "X", "native Tab enters the Trip control");
    await evaluate("window.original = document.activeElement");
    const statusTitle = () => evaluate("document.querySelector('[data-rail-agent] .hm-status').title");
    assert.equal(await statusTitle(), "Active 13 minutes ago", "initial paint exposes an aging status detail");
    const pollTitles: string[] = [];
    for (const expectedReads of [1, 2]) {
      assertPollCompleted(await evaluate("fixture.poll()"), expectedReads);
      assert.equal(await evaluate("document.activeElement === window.original"), true, "unchanged/time-only polls retain the same DOM control");
      pollTitles.push(await statusTitle());
    }
    assert.deepEqual(pollTitles, ["Active 13 minutes ago", "Active 14 minutes ago"], "time labels refresh across the minute boundary");
    assert.notEqual(pollTitles[0], pollTitles[1], "the two polls exercise a time-only text change");
    await evaluate("fixture.rename()");
    assert.equal(await evaluate("document.activeElement.dataset.railWorkspace"), "X", "a changed workspace keeps its stable focus identity");
    assert.equal(await evaluate("document.activeElement === window.original"), false, "the real change rebuilt the control");
    await evaluate("fixture.removeTrip()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-rail-workspaces-title", "removal falls back to the rail heading");

    await evaluate("document.querySelector('#hm-ws-menu-trigger').click(); window.menuItem = document.activeElement");
    assert.deepEqual(await evaluate("fixture.poll(60001)"), { reads: 3, rendered: 6 }, "the menu poll completes after the initial paint, two polls, rename and removal");
    assert.equal(await statusTitle(), "Active 15 minutes ago", "the open-menu poll crosses another minute boundary");
    assert.equal(await evaluate("document.activeElement === window.menuItem && document.querySelector('#hm-ws-menu-trigger').getAttribute('aria-expanded') === 'true'"), true, "aging detail leaves the menu open");
    await evaluate("fixture.changeShell()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-ws-menu-trigger", "a shell rebuild returns focus to the closed menu's trigger");
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-expanded')"), "false");

    await evaluate("fixture.catchup(); document.querySelector('#hm-catchup-title').focus(); window.heading = document.activeElement; fixture.repaint()");
    assert.equal(await evaluate("document.activeElement === window.heading"), true, "clock-only Catch up repaint preserves the H1 node");
    await evaluate("fixture.fillCard()");
    assert.equal(await evaluate("document.activeElement.id"), "hm-catchup-title", "a returned detail read preserves H1 focus");
    await evaluate("document.querySelector('.hm-catchup-card').focus(); fixture.catchup()");
    assert.equal(await evaluate("document.activeElement.dataset.workspaceId"), "W", "Catch up card identity survives a data rebuild");
    await send("Browser.close");
  } finally {
    clearTimeout(deadline); child.kill("SIGKILL");
    // Keep only task-created CI fixture/profile directories for failure inspection.
  }
});
