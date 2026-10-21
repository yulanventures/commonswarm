import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

// Invented setup/data only; every lifecycle assertion stays in the observer.
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const setupScript = `
(() => {
  const { createKylonHost, projectHomeLayout, buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav, replaceHomeRegion, todoView, todosPane } = KylonHostFixture;
  const app = document.querySelector('live-dashboard'), frame = app.querySelector('.hm-frame');
  const context = app.querySelector('[data-home-rail-slot]'), account = app.querySelector('[data-user-menu-root]');
  const frameParent = frame.parentElement, contextParent = context.parentElement;
  const accountParent = account.parentElement, slot = app.querySelector('[data-home-workspace-shell]');
  const calls = [], workspace = { id: 'fixture-w', name: 'Invented workspace', todosAvailable: true };
  const host = createKylonHost(app, href => calls.push({ kind: 'navigate', href }));
  const chat = { view: 'chat', workspaceId: workspace.id };
  let homeRoute = chat;
  const layout = host, one = selector => app.querySelector(selector);
  /* ACTUAL_STANDALONE_SYNC */
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
  renderHeader(); host.sync(project(chat));
  const pane = app.querySelector('[data-home-route-pane]'), original = [...pane.childNodes];
  function renderTodo(view, tagDelivers = false) {
    homeRoute = { view, workspaceId: workspace.id, todoId: 'bounded' };
    frame.classList.toggle('hm-frame--todo', view === 'todo'); syncStandalonePage();
    vm.pane = 'todos'; host.sync(project(homeRoute)); renderHeader();
    const people = { groups: ['Rowan', 'Avery', 'Quinn', 'Morgan', 'Sage'].map((name, i) => ({
      person: { id: 'person-' + i, name, firstName: name, initials: name[0], you: i === 0, role: i ? 'member' : 'owner' }, agents: [] })), other: [] };
    const todo = { id: 'bounded', workspaceId: workspace.id, title: 'Check the household filters', notes: '', state: 'open',
      addedBy: people.groups[0].person, addedAt: '2026-10-21T12:00:00Z', due: null, request: null, doneBy: null, doneAt: null,
      receipt: null, sample: false, may: { edit: false, assign: false, start: false, reorder: false, complete: false, comment: true },
      tagDelivers, comments: [], assignee: null, start: null };
    const callbacks = { complete: () => calls.push({ kind: 'todo-write' }), assign: () => calls.push({ kind: 'todo-write' }),
      setStart: () => calls.push({ kind: 'todo-write' }), comment: () => calls.push({ kind: 'todo-write' }) };
    const content = view === 'todo' ? todoView(document, { workspace: { name: workspace.name, todosHref: '?w=fixture-w&v=todos', homeHref: '?w=fixture-w' },
      view: { kind: 'ready', todo }, now: Date.parse('2026-10-21T12:00:00Z'), people, openTodos: [], save: 'idle' }, callbacks)
      : todosPane(document, { filter: 'open', rows: [], now: 0, sample: true, mayAdd: false }, { filter() {}, complete() {}, add() {} });
    replaceHomeRegion(pane, view, [content]); pane.hidden = false;
  }
  function restoreTodo() { homeRoute = chat; syncStandalonePage(); frame.classList.remove('hm-frame--todo');
    pane.replaceChildren(...original); vm.pane = 'chat'; host.sync(project(chat)); renderHeader(); }
  window.hostFixtureData = { app, frame, context, account, frameParent, contextParent, accountParent, slot, calls, host, workspace, chat, project, renderHeader, renderTodo, restoreTodo, get bar() { return bar; }, get menu() { return menu; }, get heading() { return heading; } };
})();`;

export async function kylonHostFixture(observe: string): Promise<string> {
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, platform: "browser", format: "iife", globalName: "KylonHostFixture", write: false,
  outfile: "kylon-host-fixture.js", external: ["/fonts/*"], stdin: { resolveDir: siteRoot, loader: "ts", contents: `
    export { createKylonHost } from './src/lib/kylon-shell/host.ts';
    export { projectHomeLayout } from './src/lib/kylon-shell/projection.ts';
    export { buildPhoneTopBar, buildWorkspaceHeader, buildWorkspaceNav } from './src/lib/home-shell.ts';
    export { replaceHomeRegion } from './src/lib/home-focus.ts';
    export { todoView } from './src/lib/home-todo.ts'; export { todosPane } from './src/lib/home-todo-list.ts';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    import './src/styles/dashboard-decoration.css'; import './src/styles/kylon-shell.css'; import './src/styles/kylon-layout/index.css';
    import './src/styles/kylon-workspace-settings-integration.css'; import './src/styles/kylon-files.css';
    import './src/styles/dashboard-welcome.css'; import './src/styles/kylon-todos.css';` } });
  const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))?.text;
  const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))?.text;
  if (!js || !css) throw new Error("actual host/CSS bundle missing");
  const astro = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const script = astro.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  if (!script) throw new Error("actual dashboard script missing");
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let standalone = "";
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "syncStandalonePage") standalone = `const ${node.getText(ast)};`;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!standalone) throw new Error("actual standalone lifecycle missing");
  const setup = setupScript.replace("/* ACTUAL_STANDALONE_SYNC */", ts.transpileModule(standalone, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
  const inline = [...astro.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(match => match[1]).join("\n");
  if (!inline.includes(".dashboard__frame")) throw new Error("actual inline frame CSS missing");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Actual host observer fixture</title>
    <style>${css}\n${inline}\nhtml,body{margin:0;height:100%}live-dashboard{display:block;height:100dvh}.dashboard__product{height:100dvh}</style></head><body>
    <live-dashboard class="dashboard" data-kylon-shell data-state="channel"><div class="dashboard__root"><section class="dashboard__product">
    <div hidden></div><div hidden></div><div class="hm-frame dashboard__frame"><aside class="hm-frame__rail dashboard__rail">
    <div class="dashboard__rail-foot" data-user-menu-root><button class="dashboard__user-trigger" data-user-menu-trigger type="button" aria-label="Invented account">
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button><div data-user-menu hidden><button type="button" data-local-account-option>Local account option</button></div></div>
    <div class="hm-frame__rail-content" data-home-rail-slot><nav aria-label="Invented context"><a href="#fixture">Invented workspace</a></nav></div></aside>
    <div class="hm-frame__main"><div data-home-workspace-shell></div><section class="hm-route-pane" data-home-route-pane><p>Invented local callbacks; no backend.</p></section></div><aside class="hm-frame__side">Invented side content</aside>
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
