import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

// Invented setup/data only; every lifecycle assertion stays in the observer.
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const setupScript = `
(() => {
  const { createKylonHost, projectHomeLayout, buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav, replaceHomeRegion, todoView, todosPane, buildHomeRail, buildSideCards, routeHref, renderPeopleDialog, createBrainView } = KylonHostFixture;
  const app = document.querySelector('live-dashboard'), frame = app.querySelector('.hm-frame');
  const context = app.querySelector('[data-home-rail-slot]'), account = app.querySelector('[data-user-menu-root]');
  const frameParent = frame.parentElement, contextParent = context.parentElement;
  const frameNext = frame.nextSibling, contextNext = context.nextSibling, accountNext = account.nextSibling;
  const accountParent = account.parentElement, slot = app.querySelector('[data-home-workspace-shell]');
  const side = app.querySelector('[data-home-side-slot]');
  const calls = [], refreshRecords = [], workspace = { id: 'fixture-w', name: 'Invented workspace', todosAvailable: true };
  const refreshing = (owner, node, replace) => {
    const active = () => { const element = document.activeElement; return {
      tag: element?.tagName, id: element?.id, homeFocusKey: element?.dataset?.homeFocusKey,
    }; };
    const record = { owner, node, parent: node.parentNode, next: node.nextSibling,
      rendererHadFocus: node.contains(document.activeElement), rendererBefore: active(), rendererAfter: null, rendererHasFocusAfter: null };
    refreshRecords.push(record);
    try { replace(); } finally { record.rendererAfter = active(); record.rendererHasFocusAfter = node.contains(document.activeElement); }
  };
  // Instrument actual native MQL registrations; never replace their events or matches.
  const originalMatchMedia = window.matchMedia, mediaRecords = [];
  window.matchMedia = query => {
    const media = originalMatchMedia.call(window, query), listeners = new Set();
    const add = media.addEventListener.bind(media), remove = media.removeEventListener.bind(media);
    media.addEventListener = (type, listener, options) => { if (type === 'change') listeners.add(listener); return add(type, listener, options); };
    media.removeEventListener = (type, listener, options) => { if (type === 'change') listeners.delete(listener); return remove(type, listener, options); };
    mediaRecords.push({ media, listeners }); return media;
  };
  const mediaQueries = mediaRecords;
  const host = createKylonHost(app, href => calls.push({ kind: 'navigate', href }));
  const chat = { view: 'chat', workspaceId: workspace.id };
  let homeRoute = chat;
  const layout = host, one = selector => app.querySelector(selector);
  /* ACTUAL_STANDALONE_SYNC */
  const activeWorkspaceId = workspace.id, workspaces = [workspace];
  const navigateHomeHref = href => calls.push({ kind: 'message-back', href });
  const parkPeopleHosts = () => host.peopleContext(null);
  /* ACTUAL_BRAIN_TARGETS */
  const focusHomeView = () => {}; // Read-message focus is owned by the integration observer, not asserted here.
  /* ACTUAL_PANE_MESSAGE */
  const project = route => projectHomeLayout('channel', route, [workspace], false);
  const callbacks = {
  openPeople() { calls.push({ kind: 'people' }); },
  menu(item) { calls.push({ kind: 'menu', item }); },
  feedMenu() { return { channels: [{ id: '', label: 'All messages', current: true }], mayCreateChannel: true,
    filters: [{ value: 'all', label: 'All', current: true }, { value: 'broadcast', label: 'Broadcast', current: false }],
    refresh: { label: 'Refresh observer data' } }; },
  feed(action) { calls.push({ kind: 'feed', action }); },
  };
  const vm = { sample: false, workspaceId: workspace.id, name: workspace.name, people: [], pane: 'chat', todosAvailable: true,
  menu: { settings: true, adminAccess: true }, hrefs: { chat: '?w=fixture-w', todos: '?w=fixture-w&v=todos',
    lists: '?w=fixture-w&v=lists', files: '?w=fixture-w&v=files', wiki: '?w=fixture-w&v=wiki', workspaces: '?v=catchup' } };
  let bar, menu, heading;
  function renderHeader() {
  bar = buildPhoneTopBar(document, vm, callbacks);
  menu = bar.querySelector('.hm-menu'); heading = bar.querySelector('.hm-phone-bar__title');
  host.replaceHeader(() => refreshing('header', slot, () => replaceHomeRegion(slot, "shell", [bar, buildWorkspaceHeader(document, vm, callbacks), buildWorkspaceNav(document, vm, callbacks, "tablet")])));
  }
  const owner = { id: 'context-owner', name: 'Invented Rowan', firstName: 'Rowan', initials: 'IR', you: true, role: 'owner' };
  const agent = { id: 'context-agent', name: 'Atlas', label: 'Your Atlas', nestedLabel: 'Atlas', ownerId: owner.id,
    ownerFirstName: 'Rowan', ownerInitial: 'R', yours: true, tint: 0, hosted: false,
    state: { kind: 'idle', word: 'Idle', detail: 'Invented local display fact', attention: false,
      fix: { action: null, allowed: false, askWho: null, sentence: '' } } };
  const groups = [{ person: owner, agents: [agent] }];
  function renderRail(includePeople = true) {
    host.refreshTodoContext(() => refreshing('navigation', context, () => replaceHomeRegion(context, 'rail', [buildHomeRail(document, {
      sample: false, catchUp: { href: '?v=catchup', current: false, needsYou: null },
      workspaces: [workspace, { id: 'fixture-other', name: 'Invented other workspace' }].map(row => ({ ...row, href: '?w=' + row.id, current: row.id === workspace.id, needsYou: null })),
      people: { title: 'People & agents', groups: includePeople ? groups : [], other: [] },
    }, { navigate: href => calls.push({ kind: 'rail-navigate', href }), openPerson: id => calls.push({ kind: 'rail-person', id }),
      openAgent: id => calls.push({ kind: 'rail-agent', id }) })])));
  }
  function renderResources(state = 'ready', view = homeRoute.view) {
    const objects = state === 'ready' ? { state, lists: [{ kind: 'list', id: 'fixture-list', title: 'Invented supplies', href: '?w=fixture-w&v=lists', meta: 'List', who: null }],
      files: [{ kind: 'file', id: 'fixture-file', title: 'Invented notes.md', href: '?w=fixture-w&v=files', meta: 'File', who: null }] } : { state: state === 'absent' ? 'failed' : state };
    host.refreshTodoContext(() => refreshing('resources', side, () => replaceHomeRegion(side, 'side', [buildSideCards(document, {
      sample: false, workspaceName: workspace.name, todosInMain: view === 'todos' && state === 'ready',
      todos: state === 'pending' || state === 'absent' ? null : { items: [
        { id: 'side-allowed', title: 'Invented editable task', href: '?w=fixture-w&v=todo&t=side-allowed', state: 'open', mayComplete: true, subline: 'Local writable VM' },
        { id: 'side-reader', title: 'Invented read-only task', href: '?w=fixture-w&v=todo&t=side-reader', state: 'open', mayComplete: false, subline: 'Local read-only VM' }],
        allHref: '?w=fixture-w&v=todos', canAdd: state === 'ready', notice: state === 'ready' ? undefined : 'Invented ' + state + ' read result' },
      objects, sharedAgents: [{ agent, until: null }], hrefs: { lists: '?w=fixture-w&v=lists', files: '?w=fixture-w&v=files', wiki: '?w=fixture-w&v=wiki' },
    }, { onComplete: id => calls.push({ kind: 'resource-complete', id }), onAddTodo: () => calls.push({ kind: 'resource-add' }),
      onOpenLists: () => calls.push({ kind: 'resource-access' }) })])));
  }
  renderRail(); renderResources(); renderHeader(); host.sync(project(chat));
  const pane = app.querySelector('[data-home-route-pane]'), original = [...pane.childNodes];
  function renderTodo(view, tagDelivers = false, controls = false) {
    host.peopleContext(null); frame.classList.remove('hm-frame--people'); vm.contextTitle = false;
    homeRoute = { view, workspaceId: workspace.id, todoId: 'bounded' };
    frame.classList.toggle('hm-frame--todo', view === 'todo'); syncStandalonePage();
    vm.pane = 'todos'; host.sync(project(homeRoute)); renderHeader();
    const people = controls ? { groups, other: [] } : { groups: ['Rowan', 'Avery', 'Quinn', 'Morgan', 'Sage'].map((name, i) => ({
      person: { id: 'person-' + i, name, firstName: name, initials: name[0], you: i === 0, role: i ? 'member' : 'owner' }, agents: [] })), other: [] };
    // One controlled style variant; permissions are invented VMs, never a backend result.
    const todo = { id: 'bounded', workspaceId: workspace.id, title: controls ? 'Invented weekly maintenance and household supplies review with every detail retained' : 'Check the household filters', notes: '', state: 'open',
      addedBy: people.groups[0].person, addedAt: '2026-10-21T12:00:00Z', due: null, request: null, doneBy: null, doneAt: null,
      receipt: null, sample: false, may: { edit: controls, assign: controls, start: controls, reorder: false, complete: controls, comment: !controls },
      tagDelivers, comments: [], assignee: controls ? { kind: 'agent', agent } : null,
      start: controls ? { mode: 'queue', position: 1, gate: null, at: null } : null };
    const callbacks = { complete: () => calls.push({ kind: 'todo-write' }), assign: () => calls.push({ kind: 'todo-write' }),
      setStart: () => calls.push({ kind: 'todo-write' }), comment: () => calls.push({ kind: 'todo-write' }) };
    const content = view === 'todo' ? todoView(document, { workspace: { name: workspace.name, todosHref: '?w=fixture-w&v=todos', homeHref: '?w=fixture-w' },
      view: { kind: 'ready', todo }, now: Date.parse('2026-10-21T12:00:00Z'), people, openTodos: [], save: 'idle' }, callbacks)
      : todosPane(document, { filter: 'open', rows: controls ? [{ todo: { ...todo, may: { ...todo.may, complete: false } }, href: '?w=fixture-w&v=todo&t=bounded' }] : [],
        now: 0, sample: !controls, mayAdd: false }, { filter() {}, complete() {}, add() {} });
    replaceHomeRegion(pane, view, [content]); pane.hidden = false;
  }
  function restoreTodo() { homeRoute = chat; syncStandalonePage(); frame.classList.remove('hm-frame--todo');
    pane.replaceChildren(...original); vm.pane = 'chat'; host.sync(project(chat)); renderHeader(); }
  function renderContext(view, state = 'ready') {
    renderTodo(view); renderResources(['empty', 'not-found'].includes(state) ? 'ready' : state, view);
    if (state === 'refused' || state === 'failed' || state === 'absent') homePaneMessage(view === 'todo' && state === 'absent' ? 'Could not load this to-do.' : 'Could not load to-dos.', state === 'absent' ? '' : 'Invented ' + state + ' read result');
    else if (view === 'todos') {
      const todo = { id: 'main-allowed', workspaceId: workspace.id, title: 'Invented main task', notes: '', state: 'open', addedBy: owner,
        addedAt: '2026-10-21T12:00:00Z', due: null, assignee: null, start: null, request: null, doneBy: null, doneAt: null, receipt: null,
        sample: false, may: { edit: true, assign: false, start: false, reorder: false, complete: true, comment: false }, comments: [], tagDelivers: false };
      replaceHomeRegion(pane, 'todos', [todosPane(document, { filter: 'all', rows: state === 'pending' ? null : state === 'empty' ? [] : [
        { todo: { ...todo, title: 'Invented editable task with a long title that must wrap naturally on a narrow screen' }, href: '?w=fixture-w&v=todo&t=main-allowed' },
        { todo: { ...todo, id: 'main-reader', title: 'Invented read-only task', may: { ...todo.may, complete: false } }, href: '?w=fixture-w&v=todo&t=main-reader' }],
        now: 0, sample: false, mayAdd: false }, { filter: value => calls.push({ kind: 'list-filter', value }),
        complete: () => calls.push({ kind: 'todo-write' }), add: () => calls.push({ kind: 'todo-write' }) })]);
    } else if (state === 'pending' || state === 'not-found') replaceHomeRegion(pane, 'todo', [todoView(document, { workspace: { name: workspace.name, todosHref: '?w=fixture-w&v=todos', homeHref: '?w=fixture-w' },
      view: { kind: state === 'pending' ? 'loading' : 'not-found' }, now: 0, people: { groups, other: [] }, openTodos: [], save: 'idle' }, { complete() {}, assign() {}, setStart() {}, comment() {} })]);
  }
  const detail = document.createElement('section'); detail.className = 'pd-detail'; detail.id = 'pd-detail';
  detail.dataset.peopleDetail = ''; detail.hidden = true; detail.setAttribute('aria-labelledby', 'pd-detail-title');
  const peopleState = { selected: null, collapsed: new Set(), showAllAttention: false, query: '', filter: 'all' };
  const peopleModel = { sample: true, workspaceName: workspace.name, pendingFailed: false, invites: [],
    people: [{ id: 'fixture-person', name: 'Invented Person', role: 'owner', own: true, mayRemove: false }],
    agents: [{ id: 'fixture-agent', name: 'Invented Agent', ownerId: 'fixture-person', ownerName: 'Invented Person', model: null,
      app: null, hosted: false, status: { kind: 'idle', label: 'Idle', attention: false, sentence: 'Invented local idle state.' },
      receive: null, lastActive: 'Not reported', technical: [], updateAvailable: false, access: null, accessReadState: 'pending',
      key: null, liveKey: false, own: true, mayManage: false, receipt: '' }] };
  let roster = null, homeParent = null, homeNext = null, priorHidden = false;
  let doors = { invite: false, add: false };
  const addHref = routeHref({ view: 'add-agent', workspaceId: workspace.id });
  function renderPeople() {
    host.peopleContext(null);
    renderPeopleDialog(pane, detail, peopleModel, peopleState, {
      render: renderPeople, action: () => { throw new Error('read-only fixture action'); },
      saveModel: async () => { throw new Error('read-only fixture save'); }, confirm: () => { throw new Error('read-only fixture confirm'); },
    }, { layout: 'page', page: { homeLabel: workspace.name, homeHref: '?w=fixture-w', workspacesHref: '?v=catchup',
      invite: doors.invite ? () => calls.push({ kind: 'people-invite' }) : undefined,
      addAgentHref: doors.add ? addHref : undefined,
      navigate: doors.add ? href => calls.push({ kind: 'people-navigate', href }) : undefined,
      onQuery(value) { peopleState.query = value; calls.push({ kind: 'people-query', value }); renderPeople(); } } });
    roster = pane.querySelector('[data-people-context]'); homeParent = roster.parentNode; homeNext = roster.nextSibling;
    host.peopleContext(roster);
  }
  const people = {
    mount(hidden = false, options = {}) {
      // Preserve original Sample/no-door defaults. These are inputs, not a permission model.
      peopleModel.sample = options.sample ?? true; peopleModel.people[0].role = options.role ?? 'owner';
      doors = { invite: options.invite ?? false, add: options.add ?? false };
      peopleState.query = ''; peopleState.selected = null; peopleState.filter = 'all';
      homeRoute = { view: 'people', workspaceId: workspace.id }; syncStandalonePage();
      vm.pane = 'people'; priorHidden = hidden; context.hidden = hidden; vm.contextTitle = true; frame.classList.add('hm-frame--people');
      renderHeader(); host.sync(project({ view: 'people', workspaceId: workspace.id })); renderPeople();
    },
    render: renderPeople,
    clear() { host.peopleContext(null); homeRoute = chat; syncStandalonePage(); host.sync(project(chat));
      frame.classList.remove('hm-frame--people'); vm.pane = 'chat'; vm.contextTitle = false; renderHeader(); },
    get roster() { return roster; }, get search() { return roster.querySelector('.pd-page-search'); },
    get homeParent() { return homeParent; }, get homeNext() { return homeNext; },
    get priorHidden() { return priorHidden; }, detail, state: peopleState, addHref,
  };
  const wikiSection = app.querySelector('.dashboard__brain-view'), wikiIndex = wikiSection.querySelector('.dashboard__brain-index');
  const wikiHome = { parent: wikiIndex.parentNode, next: wikiIndex.nextSibling };
  const wikiTargets = brainViewTargets();
  const wikiView = createBrainView(wikiTargets, {
    read: async (topic, version) => { calls.push({ kind: 'wiki-read', topic: topic.topic, version }); return '# Invented local Wiki document'; },
    save: async () => { throw Error('Read-only host fixture must not save'); }, now: Date.parse('2026-10-21T12:00:00Z'),
  });
  wikiView.setTopics([{ fileId: 'fixture-wiki-file', name: 'brain--fixture.md', topic: 'fixture', currentVersion: 2,
    sizeBytes: 38, uploadedByKind: 'user', uploadedBy: owner.id, committedAt: '2026-10-21T12:00:00Z', tombstonedAt: null, updaterName: owner.name }]);
  const wiki = { index: wikiIndex, home: wikiHome, targets: wikiTargets,
    mount() { homeRoute = { view: 'wiki', workspaceId: workspace.id }; vm.pane = 'chat'; vm.contextTitle = true;
      pane.hidden = true; wikiSection.parentElement.hidden = false; wikiSection.hidden = false; host.sync(project(homeRoute)); renderHeader(); },
    clear() { homeRoute = chat; vm.pane = 'chat'; vm.contextTitle = false; host.sync(project(chat));
      wikiSection.hidden = true; wikiSection.parentElement.hidden = true; pane.hidden = false; renderHeader(); },
  };
  window.hostFixtureData = { app, frame, context, account, frameParent, contextParent, accountParent, frameNext, contextNext, accountNext, slot, side, calls, host, workspace, chat, project,
    wiki,
    people, mediaQueries, renderHeader, renderRail, renderResources, renderTodo, renderContext, restoreTodo, refreshRecords,
    listenerCount: () => mediaRecords.reduce((n, row) => n + row.listeners.size, 0),
    restoreMedia: () => { window.matchMedia = originalMatchMedia; },
    get bar() { return bar; }, get menu() { return menu; }, get heading() { return heading; } };
})();`;

export async function kylonHostFixture(observe: string): Promise<string> {
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, platform: "browser", format: "iife", globalName: "KylonHostFixture", write: false,
  outfile: "kylon-host-fixture.js", external: ["/fonts/*"], stdin: { resolveDir: siteRoot, loader: "ts", contents: `
    export { createKylonHost } from './src/lib/kylon-shell/host.ts';
    export { projectHomeLayout } from './src/lib/kylon-shell/projection.ts';
    export { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell.ts';
    export { replaceHomeRegion } from './src/lib/home-focus.ts';
    export { todoView } from './src/lib/home-todo.ts'; export { todosPane } from './src/lib/home-todo-list.ts';
    export { buildHomeRail } from './src/lib/home-rail.ts'; export { buildSideCards } from './src/lib/home-side-cards.ts';
    export { renderPeopleDialog } from './src/lib/people-dialog-view.ts';
    export { routeHref } from './src/lib/home-route.ts';
    export { createBrainView } from './src/lib/brain-view.ts';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    import './src/styles/dashboard-decoration.css'; import './src/styles/kylon-shell.css'; import './src/styles/kylon-layout/index.css';
    import './src/styles/kylon-workspace-settings-integration.css'; import './src/styles/kylon-files.css';
    import './src/styles/kylon-people.css'; import './src/styles/dashboard-welcome.css'; import './src/styles/kylon-todos.css'; import './src/styles/kylon-todos-context.css';
    import './src/styles/kylon-wiki.css'; import './src/styles/kylon-wiki-context.css';` } });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
  if (!js || !css) throw new Error("actual host/CSS bundle missing");
  const astro = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const script = astro.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("actual dashboard script missing");
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const fragments = new Map<string, string[]>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["syncStandalonePage", "homePaneMessage", "brainViewTargets"].includes(node.name.text)) {
      const entries = fragments.get(node.name.text) ?? []; entries.push(`const ${node.getText(ast)};`); fragments.set(node.name.text, entries);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  let setup = setupScript;
  for (const [name, marker] of [["syncStandalonePage", "/* ACTUAL_STANDALONE_SYNC */"], ["homePaneMessage", "/* ACTUAL_PANE_MESSAGE */"], ["brainViewTargets", "/* ACTUAL_BRAIN_TARGETS */"]]) {
    const entries = fragments.get(name); if (entries?.length !== 1) throw new Error(`unique actual ${name} lifecycle missing`);
    setup = setup.replace(marker, ts.transpileModule(entries[0], { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  }
  const inline = [...astro.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  if (!inline.includes(".dashboard__frame")) throw new Error("actual inline frame CSS missing");
  const wikiSections = [...astro.matchAll(/<section class="dashboard__brain-view"[\s\S]*?<\/section>/g)];
  if (wikiSections.length !== 1) throw new Error("unique actual Wiki markup missing");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual host observer fixture</title>
    <style>${css}\n${inline}\nhtml,body{margin:0;height:100%}live-dashboard{display:block;height:100dvh}.dashboard__product{height:100dvh}</style></head><body>
    <live-dashboard class="dashboard" data-kylon-shell data-state="channel"><div class="dashboard__root"><section class="dashboard__product">
    <div hidden></div><div hidden></div><div class="hm-frame dashboard__frame"><aside class="hm-frame__rail dashboard__rail">
    <div class="dashboard__rail-foot" data-user-menu-root><button class="dashboard__user-trigger" data-user-menu-trigger type="button" aria-label="Invented account">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button><div data-user-menu hidden><button type="button" data-local-account-option>Local account option</button></div></div>
    <div class="hm-frame__rail-content" data-home-rail-slot><nav aria-label="Invented context"><a href="#fixture">Invented workspace</a></nav></div></aside>
    <div class="hm-frame__main"><div data-home-workspace-shell></div><section class="hm-route-pane" data-home-route-pane><p>Invented local callbacks; no backend.</p></section><div class="dashboard__channel-body" hidden>${wikiSections[0][0]}</div></div><aside class="hm-frame__side" data-home-side-slot aria-label="Workspace cards"></aside>
    </div></section></div></live-dashboard><script>${(js + setup + observe).replace(/<\/script/giu, "<\\/script")}</script></body></html>`;
}

// Disposable browser transport; lifecycle assertions remain in the observer.
type Send = (method: string, params?: Record<string, unknown>) => Promise<any>;
export async function connectKylonObserver(url: string): Promise<{ socket: WebSocket; send: Send }> {
  const socket = new WebSocket(url);
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let sequence = 0;
  const fail = () => { for (const waiter of pending.values()) waiter.reject(new Error("CDP closed")); pending.clear(); };
  socket.addEventListener("close", fail); socket.addEventListener("error", fail);
  socket.addEventListener("message", event => {
  const message = JSON.parse(String(event.data)), waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error("CDP open timeout")); }, 5000);
  socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP open failed")); }, { once: true });
  });
  const send: Send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timeout`)); }, 8000);
  pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
  socket.send(JSON.stringify({ id, method, params }));
  });
  return { socket, send };
}
