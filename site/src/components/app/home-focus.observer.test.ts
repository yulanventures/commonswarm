import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { focusFixture } from "./home-focus.fixture.js";

type CdpSend = (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<Record<string, unknown>>;

const DEVTOOLS_COMMAND_MS = 15_000;

function connectDevtools(url: string): Promise<{ socket: WebSocket; send: CdpSend }> {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  let next = 0;
  const failPending = (message: string) => {
    const waiters = [...pending.values()];
    pending.clear();
    for (const waiter of waiters) waiter.reject(new Error(message));
  };
  const send: CdpSend = (method, params = {}, sessionId) => new Promise((resolveSocket, rejectSocket) => {
    if (socket.readyState !== WebSocket.OPEN) {
      rejectSocket(new Error(`DevTools ${method} was not sent: socket is not open`));
      return;
    }
    const id = ++next;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      rejectSocket(new Error(`DevTools ${method} did not answer within 15 seconds`));
    }, DEVTOOLS_COMMAND_MS);
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolveSocket(value); },
      reject: (error) => { clearTimeout(timer); rejectSocket(error); },
    });
    try {
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    } catch (error) {
      pending.delete(id);
      clearTimeout(timer);
      rejectSocket(error instanceof Error ? error : new Error(`DevTools ${method} was not sent`));
    }
  });
  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
    if (!message.id || !pending.has(message.id)) return;
    const waiter = pending.get(message.id)!;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message ?? "DevTools command failed"));
    else waiter.resolve(message.result ?? {});
  });
  // A closed socket never delivers the answer. Rejecting here is what lets Browser.close finish:
  // Chrome exits and takes the socket with it, so the command response does not arrive.
  socket.addEventListener("close", () => failPending("DevTools socket closed"));
  socket.addEventListener("error", () => failPending("DevTools socket failed"));
  return new Promise((resolveSocket, rejectSocket) => {
    const timer = setTimeout(() => {
      rejectSocket(new Error("DevTools socket did not open within 10 seconds"));
      socket.close();
    }, 10_000);
    const finish = (failed: Error | undefined, value?: { socket: WebSocket; send: CdpSend }) => {
      clearTimeout(timer);
      if (failed) rejectSocket(failed);
      else resolveSocket(value!);
    };
    socket.addEventListener("open", () => finish(undefined, { socket, send }));
    socket.addEventListener("error", () => finish(new Error("DevTools socket failed")));
    socket.addEventListener("close", () => finish(new Error("DevTools socket closed before it opened")));
  });
}

async function readDevtoolsPort(profile: string, stopped: () => boolean): Promise<{ port: string; path: string } | undefined> {
  const file = join(profile, "DevToolsActivePort");
  const started = Date.now();
  while (!stopped()) {
    if (Date.now() - started >= 15_000) throw new Error("Chrome did not write DevToolsActivePort within 15 seconds");
    try {
      const [port, browserPath] = (await readFile(file, "utf8")).split("\n");
      if (port?.trim() && browserPath?.trim()) return { port: port.trim(), path: browserPath.trim() };
    } catch {
      // Chrome writes this file once the debugging port is listening.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  return undefined;
}

async function waitForChromeExit(settled: Promise<void>): Promise<void> {
  await new Promise<void>((resolveWait, rejectWait) => {
    const timer = setTimeout(() => rejectWait(new Error("Chrome did not exit within 15 seconds of Browser.close")), 15_000);
    settled.then(() => { clearTimeout(timer); resolveWait(); }, () => { clearTimeout(timer); resolveWait(); });
  });
}

async function evaluate(send: CdpSend, sessionId: string, expression: string): Promise<unknown> {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  const details = result.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined;
  if (details) throw new Error(details.exception?.description || details.text || "page evaluation failed");
  return (result.result as { value?: unknown } | undefined)?.value;
}

async function removeOwnedProfile(profile: string): Promise<void> {
  const root = resolve(tmpdir());
  const target = resolve(profile);
  if (target.startsWith(`${root}${sep}`) && target.includes(`${sep}commonswarm-home-focus-profile-`)) {
    await rm(target, { recursive: true, force: true });
  }
}

// File fixtures use the shared CI launcher; all expectations stay in the host test.
test("home refreshes keep rail controls, view headings and workspace menu focus", { timeout: 60_000 }, async () => {
  const { setup, production } = await focusFixture();
  const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const fixtureScript = `
    import { buildHomeRail } from './src/lib/home-rail';
    import { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell';
    import { renderCatchUp as buildCatchUp } from './src/lib/home-catchup';
    import { homeStructureKey, replaceHomeRegion, refreshHomeRailTimes, refreshHomeCatchUpTimes } from './src/lib/home-focus';
    import { mapHomePeople, mapHomeRail, mapCatchUp, initialCatchUpData, catchUpRailPeople } from './src/lib/home-map';
    import { routeHref } from './src/lib/home-route';
    import { PendingRefreshGate } from './src/lib/pending-refresh';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    ${setup}
    ${production()}
    renderRoster();
    window.runFocusChecks = async () => {
    window.fixture = {
      poll,
      rename: () => { workspaces = workspaces.map(w => w.id === 'X' ? {...w,name:'Summer trip'} : w); renderRoster(); },
      removeTrip: () => { workspaces = workspaces.filter(w => w.id !== 'X'); renderRoster(); },
      changeShell: () => { workspaces = workspaces.map(w => w.id === 'W' ? {...w,name:'House'} : w); renderHomeShell(); },
      catchup: () => { homeRoute = {view:'catchup'}; catchUpData = initialCatchUpData(workspaces); renderHomeCatchUp(); },
      fillCard: () => { catchUpData[0] = {...catchUpData[0],state:'open'}; renderHomeCatchUp(); },
      repaint: () => { now += 60000; renderHomeCatchUp(); }
    };
      const checks = [];
      const assert = {
        equal: (actual, expected, name) => checks.push({ actual, expected, name }),
        deepEqual: (actual, expected, name) => checks.push({ actual, expected, name }),
        notEqual: (actual, expected, name) => checks.push({ actual, expected, name, different: true })
      };
      const assertPollCompleted = (progress, reads) => {
        assert.equal(progress.reads, reads, 'each poll completed a roster read');
        assert.equal(progress.rendered, reads + 1, 'each poll reached the end of renderRoster');
      };
      const evaluate = async expression => (0, eval)(expression);
    assert.equal(await evaluate("!!window.fixture"), true, "production refresh functions initialized");
    const sequential = [...document.querySelectorAll('a[href],button,input,select,textarea,[tabindex]')]
      .filter(node => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0);
    assert.equal(sequential[2]?.dataset.railWorkspace, "X", "the third native keyboard target is the Trip link");
    assert.equal(await evaluate("document.activeElement.dataset.railWorkspace"), "X", "three Tab keys landed on the Trip link");
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

      return checks;
    };
    document.documentElement.dataset.focusReady = "1";
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
  const profile = await mkdtemp(join(tmpdir(), "commonswarm-home-focus-profile-"));
  let socket: WebSocket | undefined;
  let stopPortRead = false;
  let portWaitOver = false;
  const launched = launchChrome(await findChrome(), [
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--window-size=1440,900",
    pathToFileURL(fixturePath).href,
  ], { maxBuffer: 10 * 1024 * 1024, timeout: 45_000, killSignal: "SIGKILL" });
  const chromeSettled = launched.then(() => undefined, () => undefined);
  const chromeEndedFirst = chromeSettled.then(() => {
    if (!portWaitOver) throw new Error("Chrome exited before DevToolsActivePort was written");
  });
  try {
    const endpoint = await Promise.race([
      readDevtoolsPort(profile, () => stopPortRead).then((value) => { portWaitOver = true; return value; }),
      chromeEndedFirst,
    ]);
    portWaitOver = true;
    stopPortRead = true;
    if (!endpoint) throw new Error("Chrome exited before DevToolsActivePort was written");
    const connected = await connectDevtools(`ws://127.0.0.1:${endpoint.port}${endpoint.path.startsWith("/") ? endpoint.path : `/${endpoint.path}`}`);
    socket = connected.socket;
    const targets = await connected.send("Target.getTargets") as { targetInfos?: Array<{ targetId: string; type: string; url: string }> };
    const page = targets.targetInfos?.find((target) => target.type === "page" && target.url.startsWith("file:"));
    assert.ok(page, "the fixture page did not open");
    const attached = await connected.send("Target.attachToTarget", { targetId: page.targetId, flatten: true }) as { sessionId?: string };
    const sessionId = attached.sessionId;
    assert.ok(sessionId, "the fixture page did not attach");
    await connected.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
    await connected.send("Page.bringToFront", {}, sessionId);
    const readyDeadline = Date.now() + 10_000;
    let ready = false;
    while (Date.now() < readyDeadline) {
      ready = await evaluate(connected.send, sessionId, "document.documentElement.dataset.focusReady === '1'") === true;
      if (ready) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
    assert.equal(ready, true, "the fixture did not finish painting");
    for (let step = 0; step < 3; step += 1) {
      await connected.send("Input.dispatchKeyEvent", {
        type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      }, sessionId);
      await connected.send("Input.dispatchKeyEvent", {
        type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9,
      }, sessionId);
    }
    assert.equal(
      await evaluate(connected.send, sessionId, "document.activeElement?.dataset?.railWorkspace ?? ''"),
      "X",
      "three Tab keys land on the Trip workspace",
    );
    const checks = await evaluate(connected.send, sessionId, "window.runFocusChecks()") as
      { actual: unknown; expected: unknown; name: string; different?: boolean }[];
    assert.ok(Array.isArray(checks), "focus checks did not return");
    assert.equal(checks.length, 23, "every focus and poll expectation must run");
    for (const check of checks) {
      if (check.different) assert.notDeepEqual(check.actual, check.expected, check.name);
      else assert.deepEqual(check.actual, check.expected, check.name);
    }
    // Browser.close ends the browser before DevTools can answer, so waiting on that command
    // never settles. The process exit is the completion signal, and it has its own deadline.
    void connected.send("Browser.close").catch(() => undefined);
    await waitForChromeExit(chromeSettled);
  } finally {
    portWaitOver = true;
    stopPortRead = true;
    socket?.close();
    await chromeSettled;
    await removeOwnedProfile(profile);
  }
});
