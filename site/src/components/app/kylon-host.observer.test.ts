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
  let heldSearch = null, releasedPeople = null, suspendedHidden = null, doorCounts = null;
  const listeners = () => fixture.mediaQueries.reduce((count, query) => count + query.listeners.size, 0);
  const peopleFacts = () => ({ width: innerWidth, phone: matchMedia('(max-width:52rem)').matches,
    rosterParent: fixture.people.roster?.parentElement?.className, navHidden: context.hidden,
    active: document.activeElement?.outerHTML, accountParent: account.parentElement?.className,
    dialog: { open: app.querySelector('dialog')?.open, modal: app.querySelector('dialog')?.matches(':modal') },
    inert: [...app.querySelectorAll('[inert]')].map(node => node.className), listeners: listeners(),
    doors: [...app.querySelectorAll('[data-people-page-invite],[data-people-page-add-agent]')].map(node => ({
      tag: node.tagName, text: node.textContent, href: node.getAttribute('href'), visible: !!node.getClientRects().length })),
    intents: calls.filter(call => call.kind === 'people-invite' || call.kind === 'people-navigate') });
  const until = async (condition, label) => {
    const deadline = performance.now() + 2000;
    while (!condition()) {
      if (performance.now() >= deadline) throw new Error(label + ': ' + JSON.stringify(peopleFacts()));
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const peopleUnique = () => {
    const ids = [...app.querySelectorAll('[id]')].map(node => node.id);
    return ids.length === new Set(ids).size && app.querySelectorAll('[data-people-context]').length === 1 &&
      app.querySelectorAll('.pd-page-search').length === 1 && app.querySelectorAll('.pd-person-disclosure').length === 1 &&
      app.querySelectorAll('.pd-agent-disclosure').length === 1 && app.querySelectorAll('[data-user-menu-root]').length === 1;
  };
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
  async reopened() {
    app.querySelector('.cs-org-drawer .cs-icon-button').click();
    this.openDrawer();
    await settle();
    const dialog = app.querySelector('dialog');
    check('queued close event preserves reopened modal/inert', dialog.matches(':modal') &&
      [...dialog.parentElement.children].filter(node => node !== dialog).every(node => node.inert));
  },
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
  async peopleStart(hidden) {
    fixture.people.mount(hidden); ({ bar, menu, heading } = fixture); heldSearch = null;
    await this.peoplePlaced(1471, false);
    check('People registers one native responsive owner', listeners() === 2, peopleFacts());
    check('People main keeps actual detail host and context heading once', fixture.people.detail.closest('[data-people-page]') &&
      app.querySelectorAll('#pd-page-title').length === 1 && heading.tagName === 'P', peopleFacts());
    fixture.people.roster.querySelector('.pd-page-back').focus();
  },
  async peopleTyped() {
    await until(() => fixture.people.state.query === 'Invented' && document.activeElement === fixture.people.search, 'native search input and actual rerender');
    check('native search reached actual query callback', calls.some(call => call.kind === 'people-query' && call.value === 'Invented'), peopleFacts());
  },
  peopleHold() {
    const node = fixture.people.search;
    heldSearch = { node, value: node.value, start: node.selectionStart, end: node.selectionEnd };
    check('native caret selection exists before relocation', document.activeElement === node && node.value === 'Invented' &&
      node.selectionStart === 5 && node.selectionEnd === 6, { value: node.value, start: node.selectionStart, end: node.selectionEnd });
  },
  async peoplePlaced(width, hold = true) {
    const phone = width <= 832, p = fixture.people;
    await until(() => innerWidth === width && matchMedia('(max-width:52rem)').matches === phone &&
      p.roster.parentNode === (phone ? p.homeParent : app.querySelector('.cs-org-context-body')) && !app.querySelector('dialog').open && inertRestored(), 'actual People relocation at ' + width);
    const facts = peopleFacts();
    check('People owns one real roster/account/context at ' + width, peopleUnique() && sameNodes() &&
      context.hidden === (phone ? p.priorHidden : true) && p.detail.closest('[data-people-page]') &&
      account.closest(phone ? '.cs-org-phone-account' : '.cs-org-rail-account'), facts);
    if (phone) check('phone roster returns to exact page anchor at ' + width, p.roster.nextSibling === p.homeNext, facts);
    if (hold) check('relocation retains real search focus/value/caret at ' + width, !!heldSearch && p.search === heldSearch.node &&
      document.activeElement === heldSearch.node && p.search.getClientRects().length > 0 && !p.search.closest('[hidden],[inert]') && p.search.value === heldSearch.value &&
      p.search.selectionStart === heldSearch.start && p.search.selectionEnd === heldSearch.end, facts);
  },
  peopleRefresh() {
    const p = fixture.people, previous = p.roster, detail = p.detail;
    renderHeader();
    check('header refresh leaves held People search and caret untouched', p.search === heldSearch.node && document.activeElement === p.search &&
      p.search.selectionStart === heldSearch.start && p.search.selectionEnd === heldSearch.end, peopleFacts());
    p.render();
    check('actual roster refresh releases previous generation without duplicates', !previous.isConnected && p.roster !== previous && peopleUnique() &&
      p.detail === detail && p.search.value === 'Invented' && document.activeElement === p.search, peopleFacts());
    heldSearch = null;
  },
  peopleDrawer() {
    const p = fixture.people, dialog = app.querySelector('dialog');
    check('native drawer keeps phone roster in page and account in modal', dialog.matches(':modal') &&
      p.roster.parentNode === p.homeParent && !dialog.contains(p.roster) && dialog.contains(account) &&
      dialog.contains(document.activeElement) && peopleUnique(), peopleFacts());
  },
  peopleClear() {
    const p = fixture.people;
    p.clear(); ({ bar, menu, heading } = fixture);
    releasedPeople = { node: p.roster, parent: p.homeParent, next: p.homeNext, hidden: p.priorHidden };
    check('leave People restores exact anchor and original nav hidden state', p.roster.parentNode === p.homeParent &&
      p.roster.nextSibling === p.homeNext && context.hidden === p.priorHidden && !app.querySelector('.cs-org-shell').hasAttribute('data-people-composition') &&
      listeners() === 1, peopleFacts());
  },
  async peopleReleased(width) {
    await until(() => innerWidth === width && matchMedia('(max-width:52rem)').matches === (width <= 832), 'released native media query at ' + width);
    check('held native query cannot reproject released roster', releasedPeople.node.parentNode === releasedPeople.parent &&
      releasedPeople.node.nextSibling === releasedPeople.next && context.hidden === releasedPeople.hidden && listeners() === 1, peopleFacts());
  },
  async peopleHeader(options, expected) {
    fixture.people.mount(false, options); ({ bar, menu, heading } = fixture); heldSearch = null;
    await this.peoplePlaced(1471, false);
    const roster = fixture.people.roster, head = roster.querySelector('.pd-page-head');
    const invites = roster.querySelectorAll('[data-people-page-invite]'), adds = roster.querySelectorAll('[data-people-page-add-agent]');
    check('actual header gates ' + expected.label, invites.length === Number(expected.invite) && adds.length === Number(expected.add) &&
      [...invites, ...adds].every(node => head.contains(node) && node.getClientRects().length > 0 && !node.closest('[hidden],[inert]')) &&
      roster.querySelectorAll('.pd-page-actions').length === Number(expected.invite || expected.add), peopleFacts());
    if (expected.invite) check('Invite remains the named button ' + expected.label, invites[0]?.tagName === 'BUTTON' &&
      invites[0].type === 'button' && invites[0].textContent === 'Invite someone', peopleFacts());
    if (expected.add) check('Add retains supplied workspace href ' + expected.label,
      adds[0]?.tagName === 'A' && adds[0].textContent === 'Add an agent' &&
      adds[0].href === new URL(fixture.people.addHref, document.baseURI).href, peopleFacts());
    if (expected.invite && expected.add) this.peopleHeaderOrder();
    // Explicit starting position for the subsequent native Tab/Enter journey, not a return-focus assertion.
    roster.querySelector('.pd-page-back').focus();
    doorCounts = { invite: calls.filter(call => call.kind === 'people-invite').length,
      add: calls.filter(call => call.kind === 'people-navigate').length };
  },
  peopleHeaderOrder() {
    const roster = fixture.people.roster, head = roster.querySelector('.pd-page-head');
    const ordered = [head.querySelector('#pd-page-title'), head.querySelector('[data-people-page-invite]'),
      head.querySelector('[data-people-page-add-agent]'), fixture.people.search, head.querySelector('[role=group][aria-label="Show roster"]'),
      roster.querySelector('.pd-page-main')];
    check('real title, Invite, Add, search, filters, roster DOM order at ' + innerWidth,
      ordered.every(Boolean) && ordered.slice(1).every((node, i) => !!(ordered[i].compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)), peopleFacts());
  },
  peopleDoorFocus(kind) {
    const selector = kind === 'invite' ? '[data-people-page-invite]' : kind === 'add' ? '[data-people-page-add-agent]' : '.pd-page-search';
    const node = fixture.people.roster.querySelector(selector);
    check('native Tab reaches actual People ' + kind, !!node && document.activeElement === node &&
      !!node.getClientRects().length && !node.closest('[hidden],[inert]'), peopleFacts());
    if (kind === 'search') check('native doors emit only their supplied local intents',
      calls.filter(call => call.kind === 'people-invite').length === doorCounts.invite &&
      calls.filter(call => call.kind === 'people-navigate').length === doorCounts.add, peopleFacts());
  },
  async peopleDoorIntent(kind) {
    const label = kind === 'invite' ? 'people-invite' : 'people-navigate';
    await until(() => calls.filter(call => call.kind === label).length > doorCounts[kind], 'native People ' + kind + ' callback');
    const actual = calls.filter(call => call.kind === label);
    check('native People ' + kind + ' invokes original local callback once', actual.length === doorCounts[kind] + 1 &&
      (kind !== 'add' || actual.at(-1).href === new URL(fixture.people.addHref, document.baseURI).href), peopleFacts());
    doorCounts[kind]++;
  },
  peopleHeaderRefresh() {
    const previous = fixture.people.roster; renderHeader(); fixture.people.render();
    check('permitted header refresh preserves one real generation', !previous.isConnected && peopleUnique(), peopleFacts());
    this.peopleHeaderOrder(); fixture.people.roster.querySelector('.pd-page-back').focus();
  },
  peopleUnowned(label) {
    for (const hidden of [false, true]) {
      context.hidden = hidden; // Another owner changes its own node while People owns no roster.
      for (const [phase, act] of [['Chat sync', () => host.sync(project(chat))],
        ['null clear', () => host.peopleContext(null)], ['repeated null clear', () => host.peopleContext(null)]]) {
        act();
        check(label + ' unowned hidden=' + hidden + ' survives ' + phase, context.hidden === hidden && sameNodes() && listeners() === 1 &&
          !app.querySelector('.cs-org-shell').hasAttribute('data-people-composition') && (!releasedPeople ||
          (releasedPeople.node.parentNode === releasedPeople.parent && releasedPeople.node.nextSibling === releasedPeople.next)), peopleFacts());
      }
    }
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
    suspendedHidden = context.hidden; host.suspend();
    check('suspend preserves another owner hidden state after People release', context.hidden === suspendedHidden, peopleFacts());
    check('destroy restores parents', sameNodes() && frame.parentElement === frameParent && context.parentElement === contextParent && account.parentElement === accountParent);
    check('destroy restores exact next siblings and removes held query listeners', frame.nextSibling === fixture.frameNext &&
      context.nextSibling === fixture.contextNext && account.nextSibling === fixture.accountNext && listeners() === 0);
    check('destroy restores menu/H1', menu.parentElement === bar && heading.parentElement === bar);
    check('destroy restores SVG', account.querySelector('svg').getAttribute('viewBox') === '0 0 16 16' && account.querySelector('path').getAttribute('d') === 'm4 6 4 4 4-4');
    check('destroy removes shell/modal', !app.querySelector('.cs-org-shell,dialog'));
    return checks;
  },
  async afterSuspend(width) {
    await until(() => innerWidth === width && matchMedia('(max-width:52rem)').matches === (width <= 832), 'post-suspend native media query');
    check('post-suspend held query leaves restored DOM untouched', frame.parentElement === frameParent && context.parentElement === contextParent &&
      account.parentElement === accountParent && frame.nextSibling === fixture.frameNext && context.nextSibling === fixture.contextNext &&
      account.nextSibling === fixture.accountNext && context.hidden === suspendedHidden && !app.querySelector('.cs-org-shell,dialog') && listeners() === 0, peopleFacts());
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
  const key = async (name: "Tab" | "Enter" | "Escape" | "ArrowLeft", shift = false) => {
    const code = name === "Tab" ? 9 : name === "Enter" ? 13 : name === "Escape" ? 27 : 37;
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", {
      type, key: name, code: name, modifiers: shift ? 8 : 0, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code,
      // Native Enter produces a character event; disclosures activate on that event.
      ...(name === "Enter" && type === "keyDown" ? { text: String.fromCharCode(13), unmodifiedText: String.fromCharCode(13) } : {}),
    });
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
    await evaluate("window.hostObserver.reopened()");
    await key("Escape"); await evaluate("window.hostObserver.escaped()");
    await evaluate("window.hostObserver.openDrawer()");
    await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.hostObserver.resized()");
    await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    await evaluate("window.hostObserver.settle()");
    }
    await evaluate("window.hostObserver.refreshFocus()");
    if (width === 1471) await evaluate('window.hostObserver.peopleUnowned("before first People mount")');
    // One existing host owner, one actual People composition case. Read-only invented data;
    // native CDP search/caret and actual responsive/drawer events, no replacement adapter.
    if (width === 1471) for (const hidden of [false, true]) {
      await evaluate(`window.hostObserver.peopleStart(${hidden})`);
      await key("Tab");
      await send("Input.insertText", { text: "Invented" });
      await evaluate("window.hostObserver.peopleTyped()");
      await key("ArrowLeft"); await key("ArrowLeft"); await key("ArrowLeft", true);
      await evaluate("window.hostObserver.peopleHold()");
      for (const [nextWidth, nextHeight] of [[390, 844], [1471, 900]]) {
        await send("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextHeight, deviceScaleFactor: 1, mobile: false });
        await evaluate(`window.hostObserver.peoplePlaced(${nextWidth})`);
      }
      await evaluate("window.hostObserver.peopleRefresh()");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await evaluate("window.hostObserver.peoplePlaced(390,false)");
      await evaluate("window.hostObserver.openDrawer();window.hostObserver.drawerState()");
      await key("Tab"); await evaluate("window.hostObserver.tabState();window.hostObserver.peopleDrawer()");
      await send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
      await evaluate("window.hostObserver.peoplePlaced(1024,false)");
      await evaluate("window.hostObserver.peopleClear()");
      for (const nextWidth of [320, 1471]) {
        await send("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: nextWidth === 320 ? 568 : 900, deviceScaleFactor: 1, mobile: false });
        await evaluate(`window.hostObserver.peopleReleased(${nextWidth})`);
      }
    }
    if (width === 1471) {
      // Independent expected gate table. Local intent callbacks cannot invite or mint anything.
      for (const row of [
        { label: 'Sample suppresses supplied doors', sample: true, role: 'owner', invite: true, add: true, wantInvite: false, wantAdd: false },
        { label: 'member retains Add only', sample: false, role: 'member', invite: true, add: true, wantInvite: false, wantAdd: true },
        { label: 'admin has both doors', sample: false, role: 'admin', invite: true, add: true, wantInvite: true, wantAdd: true },
        { label: 'missing Invite callback', sample: false, role: 'owner', invite: false, add: true, wantInvite: false, wantAdd: true },
        { label: 'missing Add href', sample: false, role: 'owner', invite: true, add: false, wantInvite: true, wantAdd: false },
        { label: 'owner has both doors', sample: false, role: 'owner', invite: true, add: true, wantInvite: true, wantAdd: true },
      ]) {
        await evaluate(`window.hostObserver.peopleHeader(${JSON.stringify(row)},${JSON.stringify({ label: row.label, invite: row.wantInvite, add: row.wantAdd })})`);
        if (row.label === 'owner has both doors') {
          const nativeDoors = async () => {
            for (const kind of ['invite', 'add']) {
              await key('Tab'); await evaluate(`window.hostObserver.peopleDoorFocus('${kind}')`);
              await key('Enter'); await evaluate(`window.hostObserver.peopleDoorIntent('${kind}')`);
            }
            await key('Tab'); await evaluate("window.hostObserver.peopleDoorFocus('search')");
          };
          await nativeDoors();
          await evaluate('window.hostObserver.peopleHeaderRefresh()');
          await nativeDoors();
          await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
          await evaluate('window.hostObserver.peoplePlaced(390,false)');
          await evaluate('window.hostObserver.peopleHeaderOrder()');
          await evaluate('window.hostObserver.peopleHeaderRefresh()');
          await nativeDoors();
          await send('Emulation.setDeviceMetricsOverride', { width: 1471, height: 900, deviceScaleFactor: 1, mobile: false });
          await evaluate('window.hostObserver.peoplePlaced(1471,false)');
        }
        await evaluate('window.hostObserver.peopleClear()');
      }
      await evaluate('window.hostObserver.peopleUnowned("after active People release")');
    }
    await evaluate("window.hostObserver.finish()");
    const nextWidth = width <= 832 ? 1024 : 390;
    await send("Emulation.setDeviceMetricsOverride", { width: nextWidth, height: 900, deviceScaleFactor: 1, mobile: false });
    const checks = await evaluate(`window.hostObserver.afterSuspend(${nextWidth})`) as Check[];
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
