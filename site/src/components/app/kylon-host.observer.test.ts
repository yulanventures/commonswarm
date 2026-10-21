/** CI-only actual host; invented callbacks, no backend. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { kylonHostFixture, connectKylonObserver } from "./kylon-host.fixture.js";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
/* Host owner: pure builders miss menu/grid/SVG/modal/ring regressions. No production test seam. */
type Check = { name: string; pass: boolean; detail?: unknown };

const fixtureScript = `
(() => {
  const fixture = window.hostFixtureData;
  const { app, frame, context, account, frameParent, contextParent, accountParent, slot, calls, host, workspace, chat, project } = fixture;
  let { bar, menu, heading } = fixture;
  const checks = [];
  const check = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  const renderHeader = () => { fixture.renderHeader(); ({ bar, menu, heading } = fixture); };
  const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const sameNodes = () => frame === app.querySelector('.hm-frame') && context === app.querySelector('[data-home-rail-slot]') && account === app.querySelector('[data-user-menu-root]');
  const inertRestored = () => [...app.querySelector('.cs-org-shell').children].every(node => !node.inert);
  function docked() {
  return app.querySelector('.cs-kylon-workspace-menu > .hm-menu') === menu &&
    app.querySelector('.cs-org-phone-title > h1') === heading && document.querySelectorAll('#hm-phone-title').length === 1;
  }
  window.hostObserver = {
  checks, settle,
  async initial() {
    await settle();
    check('same mounted host nodes', sameNodes());
    check('original menu/H1 once', docked());
    host.sync(project({ view: 'files', workspaceId: workspace.id }));
    check('setTitle retains original H1/menu', docked());
    host.sync(project(chat));
    if (innerWidth > 832) {
    check('52px product rail', Math.abs(app.querySelector('.cs-org-rail').getBoundingClientRect().width - 52) < 0.5);
    check('responsive context width', Math.abs(app.querySelector('.cs-org-context-parking').getBoundingClientRect().width - (innerWidth >= 1400 ? 390 : 280)) < 0.5);
    }
    check('legacy tablet nav hidden', [...app.querySelectorAll('.hm-ws-nav')].every(node => !node.getClientRects().length));
    const label = app.querySelector('.cs-org-identity-copy').textContent;
    check('truthful identity', label === 'Workspaces' + workspace.name, label);
    host.syncMenu(false);
    check('menu/H1 restore to phone bar', menu.parentElement === bar && heading.parentElement === bar);
    host.syncMenu(); check('cached controls re-dock', docked());
    if (innerWidth <= 832) {
    const trigger = menu.querySelector('.hm-menu__trigger');
    const box = trigger.getBoundingClientRect();
    check('44px menu target', box.width >= 44 && box.height >= 44, { width: box.width, height: box.height });
    for (const [label, item] of [['Workspace settings', 'settings'], ['Admin access and history', 'admin-access']]) {
      trigger.click();
      const button = [...menu.querySelectorAll('[role=menuitem]')].find(node => node.textContent === label);
      check(label + ' visible', !!button && button.getClientRects().length > 0);
      button?.click(); check(label + ' callback', calls.some(call => call.kind === 'menu' && call.item === item));
    }
    trigger.click();
    const refresh = [...menu.querySelectorAll('[role=menuitem]')].find(node => node.textContent === 'Refresh observer data');
    check('feed Refresh present', !!refresh); refresh?.click();
    check('feed Refresh callback', calls.some(call => call.kind === 'feed' && call.action.kind === 'refresh'));
    trigger.click();
    const broadcast = [...menu.querySelectorAll('[role=menuitemradio]')].find(node => node.textContent === 'Broadcast');
    check('feed filter present', !!broadcast); broadcast?.click();
    check('feed filter callback', calls.some(call => call.kind === 'feed' && call.action.kind === 'filter' && call.action.value === 'broadcast'));
    }
    return checks;
  },
  openMenu() { menu.querySelector('.hm-menu__trigger').click(); },
  menuEscaped() { check('menu Escape returns focus', menu.querySelector('.hm-menu__list').hidden && document.activeElement === menu.querySelector('.hm-menu__trigger')); },
  openDrawer() { const opener = app.querySelector('.cs-org-phone-bar > button'); opener.focus(); opener.click(); },
  drawerState() {
    const dialog = app.querySelector('dialog');
    check('native modal focused', dialog.matches(':modal') && dialog.contains(document.activeElement));
    check('siblings inert', [...dialog.parentElement.children].filter(node => node !== dialog).every(node => node.inert));
  },
  tabState() { check('native Tab contained', app.querySelector('dialog').contains(document.activeElement)); },
  productRing() {
    const active = document.activeElement, scroller = app.querySelector('.cs-org-context-scroll'), dialog = app.querySelector('dialog');
    const b = active.getBoundingClientRect(), style = getComputedStyle(active), out = Math.max(0, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    const ring = { left: b.left - out, right: b.right + out, top: b.top - out, bottom: b.bottom + out };
    const bounds = [scroller, dialog].map(node => { const r = node.getBoundingClientRect(); return { left: r.left + node.clientLeft,
    right: r.left + node.clientLeft + node.clientWidth, top: r.top + node.clientTop, bottom: r.top + node.clientTop + node.clientHeight }; });
    check('native Tab product outline', active.matches('.cs-org-product:focus-visible') && parseFloat(style.outlineWidth) >= 2 && style.boxShadow === 'none', { tag: active.tagName, className: active.className, outline: style.outline, shadow: style.boxShadow });
    check('product ring fits scrollport/modal, both axes', bounds.every(q => ring.left >= q.left - 0.5 && ring.right <= q.right + 0.5 && ring.top >= q.top - 0.5 && ring.bottom <= q.bottom + 0.5), { ring, bounds });
  },
  escaped() {
    check('Escape restores opener/inert', !app.querySelector('dialog').open && inertRestored() && document.activeElement === app.querySelector('.cs-org-phone-bar > button'));
  },
  async resized() {
    const dialog = app.querySelector('dialog'), deadline = performance.now() + 2000;
    while ((dialog.open || !inertRestored()) && performance.now() < deadline) {
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    check('resize closes modal/restores inert', !dialog.open && inertRestored(), {
      width: innerWidth, phoneMedia: matchMedia('(max-width:52rem)').matches,
      dialogOpen: dialog.open, modal: dialog.matches(':modal'),
      inert: [...app.querySelector('.cs-org-shell').children].map(node => ({ tag: node.tagName, className: node.className, inert: node.inert })),
    });
    check('resize retains host nodes', sameNodes());
  },
  refreshFocus() {
    if (innerWidth <= 832) for (const kind of ['trigger', 'item', 'heading']) {
      const trigger = menu.querySelector('.hm-menu__trigger');
      if (kind === 'heading') heading.focus();
      else if (kind === 'item') trigger.click(); else trigger.focus();
      renderHeader();
      check('structural refresh retains ' + kind + ' focus', document.activeElement === (kind === 'heading' ? heading : menu.querySelector('.hm-menu__trigger')));
    }
    const unrelated = app.querySelector('[data-user-menu]'), option = unrelated.querySelector('[data-local-account-option]');
    unrelated.hidden = false; option.focus(); renderHeader();
    check('header refresh preserves unrelated account popup and focus', !unrelated.hidden && document.activeElement === option);
    unrelated.hidden = true;
  },
  async finish() {
    host.syncMenu(false); slot.replaceChildren(); frame.classList.add('hm-frame--catchup');
    host.sync(project({ view: 'catchup' })); await settle();
    const columns = getComputedStyle(frame).gridTemplateColumns;
    check('Catchup one column', columns.trim().split(/\\s+/).length === 1, columns);
    check('Catchup clears menu/H1', !app.querySelector('.cs-kylon-workspace-menu > .hm-menu') && !app.querySelector('.cs-org-phone-title > h1'));
    frame.classList.remove('hm-frame--catchup'); host.sync(project(chat)); renderHeader();
    const previousMenu = menu, previousHeading = heading; renderHeader();
    check('header replaces menu/H1', docked() && !previousMenu.isConnected && !previousHeading.isConnected);
    host.suspend();
    check('destroy restores parents', sameNodes() && frame.parentElement === frameParent && context.parentElement === contextParent && account.parentElement === accountParent);
    check('destroy restores menu/H1', menu.parentElement === bar && heading.parentElement === bar);
    check('destroy restores SVG', account.querySelector('svg').getAttribute('viewBox') === '0 0 16 16' && account.querySelector('path').getAttribute('d') === 'm4 6 4 4 4-4');
    check('destroy removes shell/modal', !app.querySelector('.cs-org-shell,dialog'));
    return checks;
  },
  };
})();`;
test("Kylon host actions, headings, modal focus and teardown", { timeout: 90_000 }, async () => {
  const html = await kylonHostFixture(fixtureScript);
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-kylon-host-")), owned = await realpath(directory);
  let socket: WebSocket | undefined, settled: Promise<void> | undefined, launchFailure: unknown;
  try {
  const fixture = join(directory, "index.html"), profile = join(directory, "profile");
  await writeFile(fixture, html);
  const launched = launchChrome(await findChrome(), [`--user-data-dir=${profile}`, "--remote-debugging-port=0", "about:blank"], { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, killSignal: "SIGKILL" });
  settled = launched.then(() => undefined, error => { launchFailure = error; });
  let port: string | undefined;
  for (let attempt = 0; attempt < 150 && !port; attempt++) {
    if (launchFailure) throw launchFailure;
    try { port = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; } catch { /* Starting. */ }
    if (!port) await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(port, "browser DevTools");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) })).json() as { type: string; webSocketDebuggerUrl: string }[];
  const target = targets.find(item => item.type === "page"); assert.ok(target);
  const connected = await connectKylonObserver(target.webSocketDebuggerUrl); socket = connected.socket;
  const send = connected.send;
  const evaluate = async (expression: string) => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    assert.equal(value.exceptionDetails, undefined, JSON.stringify(value.exceptionDetails)); return value.result?.value;
  };
  const key = async (name: "Tab" | "Escape") => {
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: name === "Tab" ? 9 : 27, nativeVirtualKeyCode: name === "Tab" ? 9 : 27 });
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const [width, height] of [[1471, 900], [833, 900], [390, 844], [320, 568]]) {
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await send("Page.navigate", { url: pathToFileURL(fixture).href + `?case=${width}` });
    let ready = false;
    for (let attempt = 0; attempt < 100 && !ready; attempt++) { ready = await evaluate(`location.search === "?case=${width}" && !!window.hostObserver`); if (!ready) await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(ready, true, `${width}px host fixture initialized`);
    await evaluate("window.hostObserver.initial()");
    if (width <= 832) {
    await evaluate("window.hostObserver.openMenu()"); await key("Escape"); await evaluate("window.hostObserver.menuEscaped()");
    await evaluate("window.hostObserver.openDrawer();window.hostObserver.drawerState()"); await key("Tab"); await evaluate("window.hostObserver.tabState()");
    // Primary390px ring regression.
    if (width === 390) await evaluate("window.hostObserver.productRing()");
    await key("Escape"); await evaluate("window.hostObserver.escaped()");
    await evaluate("window.hostObserver.openDrawer()");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.hostObserver.resized()");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.hostObserver.settle()");
    }
    await evaluate("window.hostObserver.refreshFocus()");
    const checks = await evaluate("window.hostObserver.finish()") as Check[];
    assert.ok(Array.isArray(checks) && checks.length > 0, `${width}px must reach lifecycle checks`);
    for (const check of checks) assert.equal(check.pass, true, `${width}px ${check.name}: ${JSON.stringify(check.detail)}`);
  }
  } finally {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 999999, method: "Browser.close" }));
  await settled; socket?.close();
  assert.equal(dirname(owned), await realpath(tmpdir()), "cleanup canonical temp root");
  assert.ok(basename(owned).startsWith("commonswarm-kylon-host-"), "owned cleanup only");
  await rm(owned, { recursive: true, force: true });
  }
});
