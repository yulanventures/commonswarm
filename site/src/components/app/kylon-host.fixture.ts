import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Invented setup/data only; every lifecycle assertion stays in the observer.
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const setupScript = `
(() => {
  const { createKylonHost, projectHomeLayout, buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav, replaceHomeRegion, renderPeopleDialog, routeHref } = KylonHostFixture;
  const app = document.querySelector('live-dashboard'), frame = app.querySelector('.hm-frame');
  const context = app.querySelector('[data-home-rail-slot]'), account = app.querySelector('[data-user-menu-root]');
  const frameParent = frame.parentElement, contextParent = context.parentElement;
  const frameNext = frame.nextSibling, contextNext = context.nextSibling, accountNext = account.nextSibling;
  const accountParent = account.parentElement, slot = app.querySelector('[data-home-workspace-shell]');
  // Observe registrations on genuine held MediaQueryLists; all operations still use native APIs/events.
  const mediaQueries = [], nativeMatchMedia = window.matchMedia.bind(window);
  window.matchMedia = query => {
    const media = nativeMatchMedia(query), listeners = new Set();
    const add = media.addEventListener.bind(media), remove = media.removeEventListener.bind(media);
    media.addEventListener = (type, listener, options) => { if (type === 'change') listeners.add(listener); add(type, listener, options); };
    media.removeEventListener = (type, listener, options) => { if (type === 'change') listeners.delete(listener); remove(type, listener, options); };
    mediaQueries.push({ media, listeners }); return media;
  };
  const calls = [], workspace = { id: 'fixture-w', name: 'Invented workspace', todosAvailable: true };
  const host = createKylonHost(app, href => calls.push({ kind: 'navigate', href }));
  const chat = { view: 'chat', workspaceId: workspace.id };
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
  host.replaceHeader(() => replaceHomeRegion(slot, "shell", [bar, buildWorkspaceHeader(document, vm, callbacks), buildWorkspaceNav(document, vm, callbacks, "tablet")]));
  }
  // Actual page builder and actual projection; invented data/local intent callbacks only.
  // This is physical host ownership coverage, not a router, sign-in or backend fixture.
  const pane = app.querySelector('[data-home-route-pane]'); pane.className = 'hm-route-pane';
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
      priorHidden = hidden; context.hidden = hidden; vm.contextTitle = true; frame.classList.add('hm-frame--people');
      renderHeader(); host.sync(project({ view: 'people', workspaceId: workspace.id })); renderPeople();
    },
    render: renderPeople,
    clear() { host.peopleContext(null); host.sync(project(chat)); frame.classList.remove('hm-frame--people'); vm.contextTitle = false; renderHeader(); },
    get roster() { return roster; }, get search() { return roster.querySelector('.pd-page-search'); },
    get homeParent() { return homeParent; }, get homeNext() { return homeNext; },
    get priorHidden() { return priorHidden; }, detail, state: peopleState, addHref,
  };
  renderHeader(); host.sync(project(chat));
  window.hostFixtureData = { app, frame, context, account, frameParent, contextParent, accountParent, frameNext, contextNext, accountNext,
    slot, calls, host, workspace, chat, project, renderHeader, people, mediaQueries, get bar() { return bar; }, get menu() { return menu; }, get heading() { return heading; } };
})();`;

export async function kylonHostFixture(observe: string): Promise<string> {
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, platform: "browser", format: "iife", globalName: "KylonHostFixture", write: false,
  outfile: "kylon-host-fixture.js", external: ["/fonts/*"], stdin: { resolveDir: siteRoot, loader: "ts", contents: `
    export { createKylonHost } from './src/lib/kylon-shell/host.ts';
    export { projectHomeLayout } from './src/lib/kylon-shell/projection.ts';
    export { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell.ts';
    export { replaceHomeRegion } from './src/lib/home-focus.ts';
    export { renderPeopleDialog } from './src/lib/people-dialog-view.ts';
    export { routeHref } from './src/lib/home-route.ts';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    import './src/styles/kylon-shell.css'; import './src/styles/kylon-layout/index.css';
    import './src/styles/kylon-people.css';` } });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
  if (!js || !css) throw new Error("actual host/CSS bundle missing");
  const astro = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const inline = [...astro.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  if (!inline.includes(".dashboard__frame")) throw new Error("actual inline frame CSS missing");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual host observer fixture</title>
    <style>${css}\n${inline}\nhtml,body{margin:0;height:100%}live-dashboard{display:block;height:100dvh}.dashboard__product{height:100dvh}</style></head><body>
    <live-dashboard class="dashboard" data-kylon-shell data-state="channel"><div class="dashboard__root"><section class="dashboard__product">
    <div hidden></div><div hidden></div><div class="hm-frame dashboard__frame"><aside class="hm-frame__rail dashboard__rail">
    <div class="dashboard__rail-foot" data-user-menu-root><button class="dashboard__user-trigger" data-user-menu-trigger type="button" aria-label="Invented account">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button><div data-user-menu hidden><button type="button" data-local-account-option>Local account option</button></div></div>
    <div class="hm-frame__rail-content" data-home-rail-slot><nav aria-label="Invented context"><a href="#fixture">Invented workspace</a></nav></div></aside>
    <div class="hm-frame__main"><div data-home-workspace-shell></div><section data-home-route-pane><p>Invented local callbacks; no backend.</p></section></div><aside class="hm-frame__side">Invented side content</aside>
    </div></section></div></live-dashboard><script>${(js + setupScript + observe).replace(/<\/script/giu, "<\\/script")}</script></body></html>`;
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
