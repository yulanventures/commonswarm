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
  // The popup is a real todoView/tagPicker in the real standalone scroller. No pane height override.
  // This boundary was absent from primitive/index fixtures; old size containment must fail paint checks.
  const until = async (predicate, label) => {
    const deadline = performance.now() + 2000;
    while (!predicate() && performance.now() < deadline) await new Promise(resolve => requestAnimationFrame(resolve));
    if (!predicate()) throw Error(label + ': ' + JSON.stringify({ width: innerWidth, height: innerHeight, fonts: document.fonts.status,
      phoneMedia: matchMedia('(max-width:52rem)').matches, scheme: getComputedStyle(app).getPropertyValue('--k-shell-scheme'), modal: app.querySelector('dialog')?.open,
      standalone: frame.hasAttribute('data-home-standalone'), field: app.querySelector('[data-todo-comment]')?.outerHTML,
      context: { headerParent: slot.parentElement?.className, railParent: context.parentElement?.tagName,
        sideParent: fixture.side?.parentElement?.tagName, summaries: [...app.querySelectorAll('.cs-todo-context summary')].map(node => node.textContent) } }));
  };
  let todoAccountParent, tagDelivers, contextHomes, contextListeners, contextInventory;
  const visible = node => !!node?.getClientRects().length && !node.closest('[hidden],[inert]');
  const summary = label => [...app.querySelectorAll('.cs-todo-context summary')].find(node => node.textContent === label);
  const inventory = () => [...fixture.side.querySelectorAll('[data-side-card],.hm-side-entry')].filter(node => node.dataset.sideCard !== 'todos')
    .map(node => ({ key: node.dataset.sideCard || 'entry', text: node.textContent, links: [...node.querySelectorAll('a')].map(a => a.getAttribute('href')) }));
  const contextMounted = () => fixture.side.closest('details') === summary('Workspace resources')?.parentElement
    && context.closest('details') === summary('Workspace navigation')?.parentElement
    && slot.parentElement?.classList.contains('cs-todo-context');
  const tagState = () => {
    const field = app.querySelector('[data-todo-comment]'), pop = app.querySelector('.hm-tag-picker .hm-picker-pop');
    return { field, pop, list: pop?.querySelector('[role=listbox]'), active: document.getElementById(field?.getAttribute('aria-activedescendant')) };
  };
  const paint = (el, out = 0) => {
    if (!el) return null;
    const b = el.getBoundingClientRect(), ring = { left: b.left - out, right: b.right + out, top: b.top - out, bottom: b.bottom + out }, clips = [];
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = getComputedStyle(a); if (s.display === 'contents') continue;
      const r = a.getBoundingClientRect(), q = { left: r.left + a.clientLeft, right: r.left + a.clientLeft + a.clientWidth,
        top: r.top + a.clientTop, bottom: r.top + a.clientTop + a.clientHeight };
      if (/hidden|clip|auto|scroll/.test(s.overflowX) && (ring.left < q.left - .5 || ring.right > q.right + .5)
        || /hidden|clip|auto|scroll/.test(s.overflowY) && (ring.top < q.top - .5 || ring.bottom > q.bottom + .5)) clips.push({ className: a.className, bounds: q });
    }
    return { width: b.width, height: b.height, ring, clips, inside: ring.left >= -.5 && ring.top >= -.5 && ring.right <= innerWidth + .5 && ring.bottom <= innerHeight + .5 };
  };
  const rect = node => node.getBoundingClientRect().toJSON();
  const firstLine = node => { const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()].find(r => r.width && r.height)?.toJSON(); };
  const mainBounds = () => { const node = frame.querySelector('.hm-frame__main'), b = rect(node); return { left: b.left + node.clientLeft, right: b.left + node.clientLeft + node.clientWidth }; };
  const column = node => ({ ...rect(node), main: mainBounds() });
  const columnPair = (index, detail) => {
    const desktop = !matchMedia('(max-width:52rem)').matches;
    check('paired actual index/detail content edges', Math.abs(index.left - detail.left) <= .5 && Math.abs(index.right - detail.right) <= .5, { index, detail });
    check(desktop ? 'centered desktop content gutters' : '24px phone content insets', [index, detail].every(b => desktop
      ? Math.abs((b.left - b.main.left) - (b.main.right - b.right)) <= 2
      : Math.abs(b.left - 24) <= .5 && Math.abs(innerWidth - b.right - 24) <= .5), { width: innerWidth, index, detail });
  };
  const color = value => {
    const v = value.trim(), hex = v.match(/^#([0-9a-f]{6})$/i);
    if (hex) return [0, 2, 4].map(at => parseInt(hex[1].slice(at, at + 2), 16)).concat(1);
    const nums = v.match(/[0-9.]+/g)?.map(Number);
    if (!/^rgba?[(]/.test(v) || !nums || nums.length < 3) throw Error('Unsupported measured color: ' + value);
    return [...nums.slice(0, 3), nums[3] ?? 1];
  };
  const equalColor = (a, b) => color(a).every((v, i) => Math.abs(v - color(b)[i]) < .01);
  const surface = node => {
    const mixed = [0, 0, 0]; let alpha = 0;
    for (let n = node; n; n = n.parentElement) {
      const c = color(getComputedStyle(n).backgroundColor), contribution = (1 - alpha) * c[3];
      for (let i = 0; i < 3; i++) mixed[i] += c[i] * contribution;
      alpha += contribution; if (alpha >= .999) return mixed;
    }
    throw Error('No measured opaque surface');
  };
  const contrast = (a, b) => {
    const luminance = rgb => rgb.slice(0, 3).map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
    const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
  };
  const token = (node, name) => getComputedStyle(node).getPropertyValue(name).trim();
  const summaryAppearance = (label, open) => {
    const node = summary(label), style = getComputedStyle(node), icon = getComputedStyle(node, '::before'), marker = getComputedStyle(node, '::marker');
    const m = new DOMMatrixReadOnly(icon.transform === 'none' ? undefined : icon.transform);
    const detail = { open, rect: rect(node), display: style.display, list: style.listStyleType, marker: marker.content,
      webkitMarker: getComputedStyle(node, '::-webkit-details-marker').display, icon: { width: icon.width, height: icon.height, background: icon.backgroundColor, clip: icon.clipPath, transform: icon.transform } };
    check('native summary has product16px secondary chevron: ' + label, style.display !== 'list-item' && style.listStyleType === 'none'
      && ['none', 'normal', '""'].includes(marker.content) && icon.content === '""'
      && parseFloat(icon.width) === 16 && parseFloat(icon.height) === 16 && icon.clipPath !== 'none'
      && equalColor(icon.backgroundColor, token(node, '--k-shell-secondary')), detail);
    check('native chevron rotation ' + label + '/' + open, Math.abs(m.a - (open ? 0 : 1)) < .001 && Math.abs(m.b - (open ? 1 : 0)) < .001
      && Math.abs(m.c - (open ? -1 : 0)) < .001 && Math.abs(m.d - (open ? 0 : 1)) < .001, detail);
  };
  const checkboxAlignment = (input, title, edge) => {
    const box = rect(input), line = firstLine(title), hit = rect(input.closest('label'));
    check('painted checkbox meets content/13px gap/first line', Math.abs(box.left - edge) <= 1 && !!line
      && Math.abs(line.left - box.right - 13) <= 1 && Math.abs((box.top + box.bottom - line.top - line.bottom) / 2) <= 1,
      { width: innerWidth, edge, box, line, hit });
    check('checkbox retains44px nonoverlapping hit owner', !!line && hit.width >= 44 && hit.height >= 44 && hit.right <= line.left + .5, { hit, line });
  };
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
  todoEnter(delivers) {
    tagDelivers = delivers; todoAccountParent = account.parentElement;
    fixture.renderTodo('todo', delivers);
    check('actual detail route sets standalone before mounted return', frame.hasAttribute('data-home-standalone') && host.mounted);
    check('standalone retains mounted account ownership', account.parentElement === todoAccountParent && sameNodes());
  },
  todoFieldFocused() { return document.activeElement === tagState().field; },
  async todoOpened() {
    await until(() => { const s = tagState(); return s.field?.getAttribute('aria-expanded') === 'true'
      && s.list?.querySelectorAll('[role=option]').length === 5 && document.fonts.status === 'loaded'; }, 'actual populated combobox did not open');
    const s = tagState(), main = frame.querySelector(':scope > .hm-frame__main'), pane = app.querySelector('[data-home-route-pane]');
    check('standalone popup has painted height in bounded actual scroller', s.pop.getBoundingClientRect().height > 4 && main.clientHeight > 0,
      { popup: paint(s.pop), pane: { type: getComputedStyle(pane).containerType, height: pane.clientHeight },
        main: { type: getComputedStyle(main).containerType, height: main.clientHeight }, cap: getComputedStyle(s.pop).maxBlockSize });
    const heading = [...document.querySelectorAll('h1')].filter(e => e.getClientRects().length);
    check('standalone has one real main heading and phone context', heading.length === 1 && heading[0].classList.contains('hm-todo-title')
      && (innerWidth > 832 || app.querySelector('.cs-org-phone-title > .hm-phone-bar__title')?.tagName === 'P'));
    return [...s.list.querySelectorAll('[role=option]')].map(e => e.id);
  },
  async todoPaint(previous = null) {
    if (previous) await until(() => tagState().active?.id !== previous, 'native ArrowDown active descendant did not change');
    const s = tagState(), parts = [s.pop, s.pop.querySelector('.hm-pick-heading'), s.active];
    const footer = s.pop.querySelector('.hm-pick-footer');
    check('real tag footer matches delivery contract', tagDelivers ? !footer : !!footer?.textContent.trim()); if (footer) parts.push(footer);
    const geometry = parts.map(e => paint(e));
    check('popup heading/footer/active option fit all real clips and viewport', geometry.every(g => g && g.width > 0 && g.height > 0 && g.inside && !g.clips.length), geometry);
    const option = paint(s.active); check('active native option stays44px', option?.width >= 44 && option?.height >= 44, option);
    const style = getComputedStyle(s.field), ring = paint(s.field, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    check('native textarea focus keeps full2+2 outline', document.activeElement === s.field && s.field.matches(':focus-visible')
      && parseFloat(style.outlineWidth) === 2 && parseFloat(style.outlineOffset) === 2 && ring.width >= 44 && ring.height >= 44 && ring.inside && !ring.clips.length,
      { outline: style.outline, shadow: style.boxShadow, ring });
    return s.active?.id;
  },
  async todoEscaped() {
    await until(() => tagState().field?.getAttribute('aria-expanded') === 'false', 'native Escape did not close picker');
    check('tag Escape retains draft/focus without a write', document.activeElement === tagState().field && tagState().field.value === '@'
      && !calls.some(call => call.kind === 'todo-write'));
    fixture.renderTodo('todos');
    check('index restores route flag/account and real heading', !frame.hasAttribute('data-home-standalone') && account.parentElement === todoAccountParent
      && [...document.querySelectorAll('h1')].filter(e => e.getClientRects().length).length === 1 && !!app.querySelector('[data-home-todos] h1'));
    fixture.restoreTodo(); ({ bar, menu, heading } = fixture);
    check('Chat restores adopted original heading/menu after detail', docked() && !frame.hasAttribute('data-home-standalone') && sameNodes());
  },
  async contextBegin() {
    contextHomes = [context, slot, fixture.side].map(node => ({ node, parent: node.parentNode, next: node.nextSibling, hidden: node.hidden }));
    contextListeners = fixture.listenerCount(); contextInventory = inventory();
    fixture.renderContext('todos');
    await until(() => contextMounted() && !!app.querySelector('[data-home-todos] h1') && document.fonts.status === 'loaded', 'Todo context did not mount original slots');
    check('Todo context owns same header/navigation/resources/account nodes', sameNodes() && contextMounted() && app.querySelector('[data-home-side-slot]') === fixture.side);
    check('native disclosures initially closed, retain original descendants', ['Workspace navigation', 'Workspace resources'].every(label => {
      const node = summary(label); return node?.tagName === 'SUMMARY' && node.parentElement.tagName === 'DETAILS' && !node.parentElement.open;
    }));
    for (const label of ['Workspace navigation', 'Workspace resources']) summaryAppearance(label, false);
    const main = frame.querySelector('.hm-frame__main'), a = frame.getBoundingClientRect(), b = main.getBoundingClientRect();
    check('Todo main uses available working column without permanent resource column', Math.abs(a.width - b.width) <= 1, { frameWidth: a.width, mainWidth: b.width });
    check('ready index retains unique resource facts/URLs and omits only duplicate Todo card', JSON.stringify(inventory()) === JSON.stringify(contextInventory)
      && !fixture.side.querySelector('[data-side-card=todos]'), inventory());
    const indexColumn = column(app.querySelector('[data-home-todos] .hm-todo-rows'));
    for (const view of ['todos', 'todo']) for (const state of ['pending', 'refused', 'failed', 'absent', view === 'todos' ? 'empty' : 'not-found', 'ready']) {
      fixture.renderContext(view, state);
      await until(() => contextMounted() && !!app.querySelector('[data-home-route-pane] h1'), 'Todo context/read state lost its real heading');
      const pane = app.querySelector('[data-home-route-pane]'), text = pane.textContent;
      const expected = state === 'empty' ? 'To-dos' : state === 'not-found' ? 'Nothing with this link in Invented workspace.' : state === 'pending' ? view === 'todo' ? 'Loading this to-do…' : 'To-dos' : state === 'ready'
        ? view === 'todo' ? 'Check the household filters' : 'To-dos' : state === 'absent' && view === 'todo' ? 'Could not load this to-do.' : 'Could not load to-dos.';
      check('whole Todo mode retains ' + view + '/' + state + ' content/context', pane.querySelector('h1').textContent === expected && contextMounted(), { expected, text });
      check('read ' + view + '/' + state + ' resources not discarded', !!fixture.side.querySelector('[data-side-card=shared]') && !!fixture.side.querySelector('.hm-side-entry')
        && (state !== 'pending' || !!fixture.side.querySelector('[aria-busy=true]')));
      if (state === 'empty') check('real empty index stays empty', !pane.querySelector('[data-todo-row]') && text.includes('No to-dos here yet.'));
      if (view === 'todos' && state === 'ready') check('controlled index retains mayAdd false and completion true',
        !pane.querySelector('[data-todo-add]') && pane.querySelectorAll('[data-todo-complete]').length === 1);
    }
    ({ bar, menu, heading } = fixture);
    const back = app.querySelector('[data-todo-back]'), assigned = app.querySelector('[data-todo-assigned] h2');
    columnPair(indexColumn, column(assigned));
    check('Back meets actual paired content edge', Math.abs(indexColumn.left - rect(back).left) <= .5, { indexColumn, back: rect(back) });
    check('mode listener has one active registration beyond original shell', fixture.listenerCount() === contextListeners + 1);
  },
  contextSummaryFocused(label) { return document.activeElement === summary(label); },
  async contextSummaryOpened(label, expected = true) {
    await until(() => summary(label)?.parentElement.open === expected, 'Native disclosure did not toggle: ' + label);
    summaryAppearance(label, expected);
    const node = summary(label), style = getComputedStyle(node), geometry = paint(node, parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset));
    check('native summary target/ring ' + label, node.matches(':focus-visible') && geometry.width >= 44 && geometry.height >= 44
      && parseFloat(style.outlineWidth) === 2 && parseFloat(style.outlineOffset) === 2 && geometry.inside && !geometry.clips.length
      && contrast(color(style.outlineColor), surface(node.parentElement)) >= 3, { geometry, outline: style.outline, surface: surface(node.parentElement) });
  },
  async contextControlsAndRefresh() {
    const before = calls.length, parent = account.parentElement;
    context.querySelector('[data-rail-workspace="fixture-other"]').click();
    context.querySelector('[data-rail-person="context-owner"]').click(); context.querySelector('[data-rail-agent="context-agent"]').click();
    slot.querySelector('.hm-ws-header [data-roster-open]').click();
    const originalMenu = slot.querySelector('.hm-ws-header .hm-menu');
    for (const [label, item] of [['Workspace settings', 'settings'], ['Admin access and history', 'admin-access']]) {
      originalMenu.querySelector('.hm-menu__trigger').click();
      const button = [...originalMenu.querySelectorAll('[role=menuitem]')].find(node => node.textContent === label);
      check('projected header door visible ' + label, visible(button)); button?.click();
      check('projected header callback ' + item, calls.slice(before).filter(call => call.kind === 'menu' && call.item === item).length === 1);
    }
    check('original rail/People callbacks retain exact targets once',
      calls.slice(before).filter(call => call.kind === 'rail-navigate' && call.href === '?w=fixture-other').length === 1
      && calls.slice(before).filter(call => call.kind === 'rail-person' && call.id === 'context-owner').length === 1
      && calls.slice(before).filter(call => call.kind === 'rail-agent' && call.id === 'context-agent').length === 1
      && calls.slice(before).filter(call => call.kind === 'people').length === 1);
    check('original local read-only/writable resource gates retained', fixture.side.querySelectorAll('[data-side-todo-complete]').length === 1
      && !fixture.side.querySelector('[data-side-todo=side-reader] input'));
    fixture.side.querySelector('[data-side-todo-complete]').click(); fixture.side.querySelector('[data-side-add-todo]').click();
    await until(() => calls.slice(before).some(call => call.kind === 'resource-complete'), 'Original local complete callback did not settle');
    check('original resource callbacks retain exact targets once', calls.slice(before).filter(call => call.kind === 'resource-complete' && call.id === 'side-allowed').length === 1
      && calls.slice(before).filter(call => call.kind === 'resource-add').length === 1);
    fixture.renderResources('refused'); const door = fixture.side.querySelector('[data-side-door]');
    check('real refusal remediation remains reachable', visible(door)); door.click();
    check('real refusal callback retained, no invented approval', calls.slice(before).some(call => call.kind === 'resource-access'));
    fixture.renderResources('ready');
    context.querySelector('[data-rail-person="context-owner"]').focus(); fixture.renderRail();
    check('replaced navigation child restores focus to retained native summary', document.activeElement === summary('Workspace navigation'));
    fixture.side.querySelector('[data-side-todo-complete]').focus(); fixture.renderResources();
    check('replaced resource child restores focus to retained native summary', document.activeElement === summary('Workspace resources'));
    const start = fixture.refreshRecords.length, accountMenu = account.querySelector('[data-user-menu]'), option = account.querySelector('[data-local-account-option]');
    accountMenu.hidden = false; option.focus(); fixture.renderHeader(); fixture.renderResources(); fixture.renderRail();
    ({ bar, menu, heading } = fixture);
    check('projected owner refresh preserves unrelated original account popup/focus', account.parentElement === parent && !accountMenu.hidden && document.activeElement === option);
    check('owner refresh restores original slot parents before replacing content', fixture.refreshRecords.slice(start).every(record =>
      contextHomes.some(home => home.node === record.node && home.parent === record.parent)) && fixture.refreshRecords.slice(start).length === 3);
    check('refresh reprojects same slots and keeps native disclosure states', contextMounted() && summary('Workspace navigation').parentElement.open && summary('Workspace resources').parentElement.open);
    check('refresh preserves all unique resource content/URLs', JSON.stringify(inventory()) === JSON.stringify(contextInventory), inventory());
    accountMenu.hidden = true;
  },
  async contextAtPhone() {
    await until(() => innerWidth === 390 && slot.parentElement === contextHomes.find(home => home.node === slot).parent, 'Todo header did not return to original phone location');
    check('phone keeps original slots/menus and one existing drawer', sameNodes() && document.querySelectorAll('.cs-org-drawer').length === 1
      && app.querySelector('.cs-kylon-workspace-menu > .hm-menu') === fixture.menu && context.closest('details') && fixture.side.closest('details'));
    check('resize does not strand focus in hidden/inert context', document.activeElement === document.body || visible(document.activeElement));
  },
  contextDrawerState() {
    const dialog = app.querySelector('.cs-org-drawer');
    check('existing modal owns Todo summaries/resources/account', dialog.matches(':modal') && dialog.contains(summary('Workspace resources'))
      && dialog.contains(fixture.side) && dialog.contains(account) && dialog.contains(document.activeElement));
  },
  async contextReturnedDesktop() {
    await until(() => innerWidth > 832 && contextMounted() && !app.querySelector('.cs-org-drawer').open && inertRestored(), 'Todo desktop resize did not settle');
    check('desktop restores projected header/resources and original account', sameNodes() && contextMounted() && !frame.querySelector('[data-home-side-slot]'));
    fixture.restoreTodo(); ({ bar, menu, heading } = fixture);
    check('leaving Todo restores exact parent/sibling/hidden state', contextHomes.every(home => home.node.parentNode === home.parent && home.node.nextSibling === home.next && home.node.hidden === home.hidden));
    check('leaving Todo removes context without losing resource facts/listener', !app.querySelector('.cs-todo-context')
      && fixture.listenerCount() === contextListeners && JSON.stringify(inventory()) === JSON.stringify(contextInventory));
  },
  async styleIndex() {
    this.styleWrites = calls.filter(call => call.kind === 'todo-write').length;
    fixture.renderContext('todos'); ({ bar, menu, heading } = fixture);
    await until(() => document.fonts.status === 'loaded' && !!app.querySelector('[data-home-todos] [data-todo-complete]'), 'Skinned mixed index not ready');
    const pane = app.querySelector('[data-home-todos]'), rows = pane.querySelector('.hm-todo-rows');
    this.styleColumn = column(rows);
    const filters = [...pane.querySelectorAll('[data-todo-filter]')];
    check('filters are borderless44px tabs with semantic selected fill', filters.length === 2 && filters.every(node => {
      const s = getComputedStyle(node), b = rect(node), borders = [s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth].map(parseFloat);
      return borders.every(v => v === 0) && b.width >= 44 && b.height >= 44 && s.boxShadow === 'none'
        && (node.getAttribute('aria-pressed') === 'true' ? equalColor(s.backgroundColor, token(node, '--k-shell-selected')) : color(s.backgroundColor)[3] === 0);
    }), filters.map(node => ({ text: node.textContent, rect: rect(node), border: getComputedStyle(node).border, fill: getComputedStyle(node).backgroundColor })));
    const input = rows.querySelector('[data-todo-complete]'), title = input.closest('li').querySelector('.hm-todo-row-title');
    checkboxAlignment(input, title, this.styleColumn.left);
    const reader = rows.querySelector('[data-todo-row="main-reader"]');
    check('mixed row rights and text alignment retained', !!reader && !reader.querySelector('input') && !!reader.querySelector('span.hm-todo-check-hit')
      && Math.abs(firstLine(reader.querySelector('.hm-todo-row-title')).left - firstLine(title).left) <= .5);
  },
  async styleDetail() {
    // Same bounded optional VM variant: real read-only index, then real writable detail. No write is made.
    fixture.renderTodo('todos', false, true);
    const reader = app.querySelector('[data-home-todos] .hm-todo-row-title'), indexTitle = app.querySelector('[data-home-todos] h1');
    check('entirely read-only row text meets index heading', !app.querySelector('[data-home-todos] input[type=checkbox]')
      && Math.abs(firstLine(reader).left - firstLine(indexTitle).left) <= 1, { row: firstLine(reader), heading: firstLine(indexTitle) });
    fixture.renderTodo('todo', false, true); ({ bar, menu, heading } = fixture);
    await until(() => document.fonts.status === 'loaded' && app.querySelectorAll('[data-todo-start] .hm-choice').length === 4, 'Controlled native detail controls not ready');
    const assigned = app.querySelector('[data-todo-assigned] h2'), detail = column(assigned);
    columnPair(this.styleColumn, detail);
    check('detail Back meets paired column', Math.abs(rect(app.querySelector('[data-todo-back]')).left - detail.left) <= .5);
    checkboxAlignment(app.querySelector('.hm-todo-done-box'), app.querySelector('.hm-todo-title'), detail.left);
    const choices = [...app.querySelectorAll('[data-todo-start] .hm-choice')], bounds = choices.map(rect), phone = matchMedia('(max-width:52rem)').matches;
    check('start choices retain44px natural labels', bounds.every(b => b.width >= 44 && b.height >= 44) && choices.every(node => {
      const range = document.createRange(); range.selectNodeContents(node.querySelector('.hm-choice-copy')); const b = rect(node);
      const glyphs = [...range.getClientRects()].filter(r => r.width && r.height);
      return glyphs.length > 0 && glyphs.every(r => r.left >= b.left - .5 && r.right <= b.right + .5 && r.top >= b.top - .5 && r.bottom <= b.bottom + .5);
    }), bounds);
    check(phone ? 'phone start choices form equal2x2' : 'desktop start choices keep one row', phone
      ? Math.abs(bounds[0].top - bounds[1].top) <= .5 && Math.abs(bounds[2].top - bounds[3].top) <= .5 && bounds[2].top >= bounds[0].bottom
        && Math.abs(bounds[0].left - bounds[2].left) <= .5 && Math.abs(bounds[1].right - bounds[3].right) <= .5
        && Math.max(...bounds.map(b => b.width)) - Math.min(...bounds.map(b => b.width)) <= 1 && Math.abs(bounds[3].right - detail.right) <= .5
      : bounds.every(b => Math.abs(b.top - bounds[0].top) <= .5), { phone, bounds, detail });
    for (const node of [app.querySelector('.hm-assign-chip[aria-checked="true"]'), app.querySelector('.hm-choice:has(input:checked)')]) {
      const s = getComputedStyle(node), inside = surface(node), outside = surface(node.parentElement), ratios = [inside, outside].map(bg => contrast(color(s.borderLeftColor), bg));
      check('selected actual chip/choice uses distinct olive with3:1 both sides', equalColor(s.borderLeftColor, token(node, '--cs-accent'))
        && parseFloat(s.borderLeftWidth) >= 1 && s.boxShadow === 'none' && ratios.every(ratio => ratio >= 3),
        { text: node.textContent, border: s.border, background: s.backgroundColor, inside, outside, ratios });
    }
  },
  styleFocused(kind) {
    const selector = kind === 'index' ? '[data-home-todos] [data-todo-complete]' : kind === 'chip' ? '.hm-assign-chip[aria-checked="true"]' : '.hm-choice input:checked';
    return document.activeElement === app.querySelector(selector);
  },
  async schemeReady(scheme) {
    await until(() => token(app, '--k-shell-scheme') === scheme && document.fonts.status === 'loaded', 'Actual scheme/fonts did not settle: ' + scheme);
  },
  styleRing(kind) {
    const active = document.activeElement, node = kind === 'chip' ? active : active.closest('label'), s = getComputedStyle(node), geometry = paint(node, parseFloat(s.outlineWidth) + parseFloat(s.outlineOffset));
    const ratios = [surface(node), surface(node.parentElement)].map(bg => contrast(color(s.outlineColor), bg));
    check('native ' + kind + ' retains full distinct2+2 ring/44px', active.matches(':focus-visible') && geometry.width >= 44 && geometry.height >= 44
      && parseFloat(s.outlineWidth) === 2 && parseFloat(s.outlineOffset) === 2 && s.boxShadow === 'none' && geometry.inside && !geometry.clips.length
      && equalColor(s.outlineColor, token(node, '--k-shell-focus')) && ratios.every(ratio => ratio >= 3)
      && (kind === 'index' || !equalColor(s.outlineColor, s.borderLeftColor)), { kind, width: innerWidth, geometry, outline: s.outline, border: s.border, ratios });
    check('native control focus submits no invented writes', calls.filter(call => call.kind === 'todo-write').length === this.styleWrites);
  },
  styleRestore() { fixture.renderResources('ready', 'chat'); fixture.restoreTodo(); ({ bar, menu, heading } = fixture); },
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
    check('destroy balances native shell/Todo listeners', fixture.listenerCount() === 0); fixture.restoreMedia();
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
  const key = async (name: "Tab" | "Escape" | "ArrowDown" | "Enter") => {
    const code = { Tab: 9, Escape: 27, ArrowDown: 40, Enter: 13 }[name];
    for (const type of ["keyDown", "keyUp"]) await send("Input.dispatchKeyEvent", { type, key: name, code: name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  };
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  const nativeTab = async (query: string, label: string) => {
    const deadline = Date.now() + 2000;
    while (!await evaluate(query) && Date.now() < deadline) await key("Tab");
    assert.equal(await evaluate(query), true, `native Tab reaches actual ${label}: ${JSON.stringify(await evaluate("({width:innerWidth,media:matchMedia('(max-width:52rem)').matches,modal:document.querySelector('dialog')?.open,active:document.activeElement?.outerHTML})"))}`);
  };
  const tabSummary = (label: string) => nativeTab(`window.hostObserver.contextSummaryFocused(${JSON.stringify(label)})`, label);
  const scheme = async (value: string) => {
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
    await evaluate(`window.hostObserver.schemeReady(${JSON.stringify(value)})`);
  };
  for (const [width, height] of [[1471, 900], [1024, 900], [833, 900], [390, 844], [320, 568], [735, 424]]) {
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
    if ([1471, 1024].includes(width)) {
      await evaluate("window.hostObserver.contextBegin()");
      for (const theme of ["light", "dark"]) {
        await scheme(theme);
        for (const label of ["Workspace navigation", "Workspace resources"]) {
          await tabSummary(label); await evaluate(`window.hostObserver.contextSummaryOpened(${JSON.stringify(label)}, false)`);
          await key("Enter"); await evaluate(`window.hostObserver.contextSummaryOpened(${JSON.stringify(label)})`);
          await key("Enter"); await evaluate(`window.hostObserver.contextSummaryOpened(${JSON.stringify(label)}, false)`);
        }
      }
      await scheme("light");
      for (const label of ["Workspace navigation", "Workspace resources"]) { await tabSummary(label); await key("Enter"); await evaluate(`window.hostObserver.contextSummaryOpened(${JSON.stringify(label)})`); }
      await evaluate("window.hostObserver.contextControlsAndRefresh()");
      // Native Tab establishes the actual disclosure focus before width relocation; no post-resize correction.
      await tabSummary("Workspace resources");
      await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
      await evaluate("window.hostObserver.contextAtPhone()");
      await evaluate("window.hostObserver.refreshFocus()");
      await evaluate("window.hostObserver.openDrawer();window.hostObserver.contextDrawerState()");
      await tabSummary("Workspace resources"); await key("Enter");
      await evaluate("window.hostObserver.contextSummaryOpened('Workspace resources', false)");
      await key("Enter"); await evaluate("window.hostObserver.contextSummaryOpened('Workspace resources')");
      await key("Escape"); await evaluate("window.hostObserver.escaped()");
      await evaluate("window.hostObserver.openMenu()"); await key("Escape"); await evaluate("window.hostObserver.menuEscaped()");
      await evaluate("window.hostObserver.openDrawer()");
      await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate("window.hostObserver.contextReturnedDesktop()");
    }
    if ([1471, 1024, 390, 320, 735].includes(width)) {
      for (const theme of ["light", "dark"]) {
        await scheme(theme); await evaluate("window.hostObserver.styleIndex()");
        await nativeTab("window.hostObserver.styleFocused('index')", "mixed-index checkbox"); await evaluate("window.hostObserver.styleRing('index')");
        await evaluate("window.hostObserver.styleDetail()");
        for (const kind of ["chip", "choice"]) {
          await nativeTab(`window.hostObserver.styleFocused(${JSON.stringify(kind)})`, `selected ${kind}`);
          await evaluate(`window.hostObserver.styleRing(${JSON.stringify(kind)})`);
        }
        await evaluate("window.hostObserver.styleRestore()");
      }
      await scheme("light");
    }
    if ([1471, 320, 735].includes(width)) for (const delivers of [true, false]) {
      await evaluate(`window.hostObserver.todoEnter(${delivers})`);
      const deadline = Date.now() + 2000;
      while (!await evaluate("window.hostObserver.todoFieldFocused()") && Date.now() < deadline) await key("Tab");
      assert.equal(await evaluate("window.hostObserver.todoFieldFocused()"), true, `${width}px native Tab reaches actual comment field`);
      await send("Input.insertText", { text: "@" });
      const options = await evaluate("window.hostObserver.todoOpened()") as string[], visited = new Set<string>();
      assert.equal(options.length, 5, 'actual populated picker is the negative/positive boundary');
      let previous: string | null = null;
      for (let index = 0; index < options.length; index++) {
        if (index) await key("ArrowDown");
        previous = await evaluate(`window.hostObserver.todoPaint(${JSON.stringify(previous)})`);
        assert.ok(previous); visited.add(previous);
      }
      assert.deepEqual([...visited].sort(), [...options].sort(), 'native arrows reach every actual option');
      await key("Escape"); await evaluate("window.hostObserver.todoEscaped()");
    }
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
