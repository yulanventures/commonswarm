import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Invented setup/data only; every lifecycle assertion stays in the observer.
const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const setupScript = `
(() => {
  const { createKylonHost, projectHomeLayout, buildPhoneTopBar } = KylonHostFixture;
  const app = document.querySelector('live-dashboard'), frame = app.querySelector('.hm-frame');
  const context = app.querySelector('[data-home-rail-slot]'), account = app.querySelector('[data-user-menu-root]');
  const frameParent = frame.parentElement, contextParent = context.parentElement;
  const accountParent = account.parentElement, slot = app.querySelector('[data-home-workspace-shell]');
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
  menu = bar.querySelector('.hm-menu'); heading = bar.querySelector('h1');
  slot.replaceChildren(bar); host.syncMenu();
  }
  renderHeader(); host.sync(project(chat));
  window.hostFixtureData = { app, frame, context, account, frameParent, contextParent, accountParent, slot, calls, host, workspace, chat, project, renderHeader, get bar() { return bar; }, get menu() { return menu; }, get heading() { return heading; } };
})();`;

export async function kylonHostFixture(observe: string): Promise<string> {
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, platform: "browser", format: "iife", globalName: "KylonHostFixture", write: false,
  outfile: "kylon-host-fixture.js", external: ["/fonts/*"], stdin: { resolveDir: siteRoot, loader: "ts", contents: `
    export { createKylonHost } from './src/lib/kylon-shell/host.ts';
    export { projectHomeLayout } from './src/lib/kylon-shell/projection.ts';
    export { buildPhoneTopBar } from './src/lib/home-shell.ts';
    import './src/styles/tokens.css'; import './src/styles/home/index.css';
    import './src/styles/kylon-shell.css'; import './src/styles/kylon-layout/index.css';` } });
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
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"></path></svg></button><div data-user-menu hidden></div></div>
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
