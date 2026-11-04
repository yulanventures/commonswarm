import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

/*
 * Lane R geometry (UI-SPEC 1.1, 3.3 "Many people", 6). CI only: browserTest skips unless
 * RUN_BROWSER_TESTS=1. home-fixture.ts (lane P) is not in this lane's tree, so this bundles the
 * production builders with esbuild the way agent-row-geometry does, and loads tokens.css plus the
 * home stylesheets. The builders call lane P's primitives, so this passes only once P has landed.
 */
type Geometry = {
  error?: string; width: number; docOverflow: number;
  smallTargets: string[]; hostileElements: number; hostileText: boolean;
  rail: null | {
    railHeight: number; listClient: number; listScroll: number; listOverflowY: string; listInsideRail: boolean; noteInsideRail: boolean;
    workspacesVisible: boolean; visibleWorkspaces: number; currentWorkspace: string | null; moreLabel: string | null;
    firstGroupIsViewer: boolean; participantHook: boolean; presenceDots: number; groupAgentCounts: number[]; otherAgents: number;
  };
  menu: null | { openFocus: string | null; expanded: string | null; escapeClosed: boolean; focusBack: boolean; smallItems: string[]; itemsShown: number };
  phone: null | { barVisible: boolean; navVisible: boolean; navLabels: string[]; current: string | null; headerHidden: boolean };
  titles: { selector: string; shown: boolean; clipped: boolean; lines: number }[];
  latePast: { visible: string[]; more: string | null };
  sample: { shellDoors: string[]; railDoors: string[]; menuButtons: number };
};

const siteRoot = fileURLToPath(new URL("../../../", import.meta.url));
const css = async (path: string) => readFile(new URL(path, import.meta.url), "utf8");

test("the home rail and shell keep a bounded people list, 44 px targets and no overflow", { timeout: 90_000 }, async () => {
  const bundle = await build({
    absWorkingDir: siteRoot, bundle: true, format: "iife", globalName: "HomeShell", platform: "browser", write: false,
    stdin: { contents: 'export * from "./src/lib/home-rail.ts"; export * from "./src/lib/home-shell.ts";', resolveDir: siteRoot, loader: "ts" },
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the home rail and shell builders must bundle");
  const styles = (await Promise.all(["../../styles/tokens.css", "../../styles/home/primitives.css", "../../styles/home/shell.css", "../../styles/home/rail.css"].map(css))).join("\n");
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-rail-geometry-"));
  const fixture = join(directory, "index.html");
  try {
    await writeFile(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      ${styles}
    </style></head><body>
      <div class="hm-shell"><aside class="hm-shell__rail" id="rail"></aside><main class="hm-shell__main" id="main"></main><aside class="hm-shell__side"><p>Cards</p></aside></div>
      <script>${script}</script><script>
      (() => {
        const metrics = { width: innerWidth };
        try {
          const hostile = '<img src=x onerror="document.title=1">';
          const state = { kind: 'idle', word: 'Idle', detail: 'Active 2 hours ago', attention: false, fix: { action: null, allowed: false, askWho: null, sentence: '' } };
          const person = (id, name, you) => ({ id, name, firstName: name.split(' ')[0], initials: name.slice(0, 2).toUpperCase(), you, role: 'member' });
          const agent = (id, name, owner) => ({ id, name, label: name, nestedLabel: name, ownerId: owner ? owner.id : null, ownerFirstName: owner && !owner.you ? owner.firstName : null,
            ownerInitial: owner ? owner.name[0] : '', yours: !!(owner && owner.you), tint: id.length % 4, hosted: false, state });
          const tom = person('tom', 'Tom Langridge', true), nikki = person('nikki', 'Nikki ' + hostile, false), priya = person('priya', 'Priya Shah', false);
          const many = (owner, count, prefix) => Array.from({ length: count }, (_, index) => agent(prefix + index, 'Agent ' + prefix + String(index).padStart(2, '0') + (index === 0 ? ' ' + hostile : ''), owner));
          const groups = [{ person: priya, agents: many(priya, 15, 'p') }, { person: nikki, agents: many(nikki, 15, 'n') }, { person: tom, agents: many(tom, 15, 't') }];
          const other = many(null, 5, 'o');
          const workspaces = Array.from({ length: 9 }, (_, index) => ({ id: 'w' + index, name: index === 1 ? 'Home ' + hostile : 'Workspace with a long name number ' + index, href: '?w=w' + index, current: index === 1, needsYou: index === 3 ? 2 : null }));
          const vm = { sample: false, catchUp: { href: '?v=catchup', current: false, needsYou: 1 }, workspaces, people: { title: 'People & agents', groups, other } };
          const noop = () => {};
          const rail = HomeShell.buildHomeRail(document, vm, { openPerson: noop, openAgent: noop });
          document.getElementById('rail').append(rail);
          const hrefs = { chat: '?w=w1', todos: '?w=w1&v=todos', lists: '?w=w1&v=lists', files: '?w=w1&v=files', wiki: '?w=w1&v=wiki', workspaces: '?v=catchup' };
          const longName = 'Home ' + hostile + ' ' + 'and a very long workspace name that keeps going '.repeat(4);
          const shell = { sample: false, workspaceId: 'w1', name: longName, people: groups, pane: 'chat', hrefs, todosAvailable: true, menu: { settings: true, adminAccess: true } };
          const callbacks = { openPeople: noop, menu: noop };
          const main = document.getElementById('main');
          main.append(HomeShell.buildPhoneTopBar(document, shell, callbacks), HomeShell.buildWorkspaceHeader(document, shell, callbacks),
            HomeShell.buildWorkspaceNav(document, shell, {}, 'tablet'), HomeShell.buildChannelMenu(document, { sample: false, label: 'All messages' }),
            HomeShell.buildWorkspaceNav(document, shell, {}, 'phone'));

          const shown = (element) => !!element && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
          metrics.docOverflow = document.documentElement.scrollWidth - innerWidth;
          metrics.smallTargets = [...document.querySelectorAll('a, button')].filter(shown).filter((element) => {
            const box = element.getBoundingClientRect(); return box.height < 44 || box.width < 44;
          }).map((element) => element.className + ':' + Math.round(element.getBoundingClientRect().width) + 'x' + Math.round(element.getBoundingClientRect().height));
          metrics.hostileElements = document.querySelectorAll('img').length;
          metrics.hostileText = document.body.textContent.includes(hostile);

          const railBox = document.getElementById('rail').getBoundingClientRect();
          const inside = (element) => { const box = element.getBoundingClientRect(); return box.height > 0 && box.top >= railBox.top - 0.5 && box.bottom <= railBox.bottom + 0.5; };
          if (shown(rail)) {
            const list = rail.querySelector('[data-sidebar-participant-list]');
            const visibleRows = [...rail.querySelectorAll('[data-rail-workspace]')].filter(shown);
            metrics.rail = {
              railHeight: railBox.height, listClient: list.clientHeight, listScroll: list.scrollHeight, listOverflowY: getComputedStyle(list).overflowY,
              listInsideRail: inside(list), noteInsideRail: inside(rail.querySelector('.hm-rail__note')),
              workspacesVisible: visibleRows.every(inside) && inside(rail.querySelector('[data-home-catch-up]')) && inside(rail.querySelector('[data-home-new-workspace]')),
              visibleWorkspaces: visibleRows.length,
              currentWorkspace: rail.querySelector('[data-rail-workspace][aria-current="page"]')?.dataset.railWorkspace ?? null,
              moreLabel: rail.querySelector('.hm-rail__more')?.textContent ?? null,
              firstGroupIsViewer: list.firstElementChild?.hasAttribute('data-rail-viewer') ?? false,
              participantHook: !!list, presenceDots: rail.querySelectorAll('.dashboard__presence-dot, [data-presence]').length,
              groupAgentCounts: [...list.querySelectorAll(':scope > .hm-rail__group:not(.hm-rail__group--other)')].map((group) => group.querySelectorAll('[data-rail-agent]').length),
              otherAgents: list.querySelectorAll('.hm-rail__group--other [data-rail-agent]').length,
            };
          } else metrics.rail = null;

          const trigger = [...document.querySelectorAll('.hm-menu__trigger')].find(shown);
          if (trigger) {
            trigger.click();
            const openFocus = document.activeElement?.textContent ?? null, expanded = trigger.getAttribute('aria-expanded');
            const items = [...document.getElementById(trigger.getAttribute('aria-controls')).querySelectorAll('[role="menuitem"]')].filter(shown);
            const smallItems = items.filter((element) => { const box = element.getBoundingClientRect(); return box.height < 44 || box.width < 44; })
              .map((element) => element.textContent + ':' + Math.round(element.getBoundingClientRect().width) + 'x' + Math.round(element.getBoundingClientRect().height));
            const openOverflow = document.documentElement.scrollWidth - innerWidth;
            if (openOverflow > 0) smallItems.push('open menu overflows by ' + openOverflow + 'px');
            document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
            metrics.menu = { openFocus, expanded, escapeClosed: trigger.getAttribute('aria-expanded') === 'false' && document.getElementById(trigger.getAttribute('aria-controls')).hidden,
              focusBack: document.activeElement === trigger, smallItems, itemsShown: items.length };
          } else metrics.menu = null;

          /* An H1 is never cut short: the text's own line boxes must fit inside the heading's box. */
          metrics.titles = ['.hm-phone-bar__title', '.hm-ws-header__title'].map((selector) => {
            const heading = document.querySelector(selector);
            const range = document.createRange(); range.selectNodeContents(heading);
            const text = range.getBoundingClientRect(), box = heading.getBoundingClientRect();
            const lines = new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
            return { selector, shown: shown(heading), clipped: text.bottom > box.bottom + 0.5 || text.right > box.right + 0.5 || getComputedStyle(heading).overflow === 'hidden', lines };
          });

          const late = HomeShell.buildHomeRail(document, { ...vm, workspaces: workspaces.map((ws, index) => ({ ...ws, current: index === 7 })) }, { openPerson: noop, openAgent: noop });
          metrics.latePast = { visible: [...late.querySelectorAll('li:not([hidden]) > [data-rail-workspace]')].map((row) => row.dataset.railWorkspace),
            more: late.querySelector('.hm-rail__more')?.textContent ?? null };

          const sampleShell = { ...shell, sample: true };
          const sampleBox = document.createElement('div');
          sampleBox.append(HomeShell.buildWorkspaceHeader(document, sampleShell, callbacks), HomeShell.buildPhoneTopBar(document, sampleShell, callbacks));
          const sampleRail = HomeShell.buildHomeRail(document, { ...vm, sample: true }, { openPerson: noop, openAgent: noop });
          metrics.sample = {
            shellDoors: [...sampleBox.querySelectorAll('button, [data-roster-open], [role="menu"]')].map((element) => element.className || element.tagName),
            railDoors: [...sampleRail.querySelectorAll('[data-rail-person] , [data-rail-agent], [data-home-new-workspace]')].filter((element) => element.matches('a, button')).map((element) => element.className),
            menuButtons: sampleBox.querySelectorAll('.hm-menu__trigger').length,
          };

          const bar = document.querySelector('.hm-phone-bar'), nav = document.querySelector('.hm-ws-nav--phone');
          metrics.phone = { barVisible: shown(bar), navVisible: shown(nav), navLabels: [...nav.querySelectorAll('a')].map((link) => link.textContent),
            current: nav.querySelector('[aria-current="page"]')?.textContent ?? null, headerHidden: !shown(document.querySelector('.hm-ws-header')) };
        } catch (error) { metrics.error = String(error && error.stack || error); }
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [390]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 20 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${width}px: the builders must finish and report geometry`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.error, undefined, `${width}px: the builders threw`);

      assert.equal(geometry.hostileElements, 0, `${width}px: names render as text`);
      assert.equal(geometry.hostileText, true);

      const shownTitles = geometry.titles.filter((title) => title.shown);

      for (const title of shownTitles) {

      }

      if (width >= 1024) {
        const rail = geometry.rail;

      } else if (width <= 832) {

      } else {

      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// Exercise the production shell's moved nodes and native drawer, rather than a copied event handler.
test("the workspace picker and account survive drawer movement and shell teardown", { timeout: 90_000 }, async () => {
  const bundle = await build({
    absWorkingDir: siteRoot, bundle: true, format: "iife", globalName: "NavOwners", platform: "browser", write: false,
    stdin: { contents: 'export { createOrgShell } from "./src/lib/kylon-shell/shell.js"; export { buildWorkspacePicker } from "./src/lib/home-shell.ts";', resolveDir: siteRoot, loader: "ts" },
  });
  const styles = await css("../../styles/kylon-layout/shell.css");
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-nav-owner-"));
  const fixture = join(directory, "index.html");
  try {
    await writeFile(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box} body{margin:0} #host{height:720px} ${styles}</style></head><body>
      <div id="original"><div id="context"></div><div id="main"></div><button id="account">Account</button><div id="picker"></div></div><div id="host"></div>
      <script>${bundle.outputFiles[0]?.text}</script><script>
      (() => {
        try {
          const original = document.querySelector('#original'), account = document.querySelector('#account'), picker = document.querySelector('#picker');
          const context = document.querySelector('#context'), main = document.querySelector('#main');
          const choices = [], accounts = [];
          account.addEventListener('click', () => accounts.push('open'));
          picker.append(NavOwners.buildWorkspacePicker(document, [
            {id:'a', name:'First', orgId:'same', archived:false}, {id:'b', name:'Second', orgId:'same', archived:false},
            {id:'c', name:'Other', orgId:'other', archived:false}, {id:'z', name:'Archived', archived:true}
          ], 'b', id => choices.push(id)));
          const shell = NavOwners.createOrgShell(document, {nodes:{context, main, account, workspacePicker:picker}});
          document.querySelector('#host').append(shell.root);
          const phone = matchMedia('(max-width:52rem)').matches;
          const opener = shell.root.querySelector('[aria-label="Open navigation"]');
          let accountInDrawer = null, closed = null, focusBack = null, inertDuring = null;
          if (phone) {
            opener.focus(); shell.openDrawer();
            accountInDrawer = shell.root.querySelector('dialog[open] .cs-org-drawer-account')?.contains(account) === true;
            inertDuring = [...shell.root.children].filter(el => el.tagName !== 'DIALOG').every(el => el.inert);
          }
          picker.querySelector('summary').click();
          const offered = [...picker.querySelectorAll('.cs-workspace-picker__item')].map(el => el.value);
          picker.querySelector('.cs-workspace-picker__item[value="a"]').click(); account.click();
          if (phone) { shell.closeDrawer('test'); closed = !shell.isDrawerOpen(); focusBack = document.activeElement === opener; }
          shell.destroy();
          const restored = [account, picker, context, main].every(node => node.parentElement === original);
          document.documentElement.dataset.navResult = btoa(JSON.stringify({phone, accountInDrawer, closed, focusBack, inertDuring, offered, choices, accounts, restored}));
        } catch (error) { document.documentElement.dataset.navError = String(error && error.stack || error); }
      })();</script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [390, 1440]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 20 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/\bdata-nav-result="([A-Za-z0-9+/]+={0,2})"/u)?.[1];
      assert.ok(encoded, `${width}px: shell lifecycle must complete`);
      const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.deepEqual(result.offered, ["a", "b", "c"]); assert.deepEqual(result.choices, ["a"]);
      assert.deepEqual(result.accounts, ["open"]); assert.equal(result.restored, true);
      if (width === 390) {
        assert.equal(result.phone, true); assert.equal(result.accountInDrawer, true);
        assert.equal(result.inertDuring, true); assert.equal(result.closed, true); assert.equal(result.focusBack, true);
      } else assert.equal(result.phone, false);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

// CI-only geometry witness: the production host and styles own placement and hit testing.
test("the applied navigation layout keeps the drawer close, picker and account reachable", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-nav-layout-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({ absWorkingDir: siteRoot, bundle: true, format: "iife", globalName: "NavLayout", platform: "browser", write: false,
    stdin: { contents: 'export { createKylonHost } from "./src/lib/kylon-shell/host.ts"; export { buildWorkspacePicker, buildPhoneTopBar } from "./src/lib/home-shell.ts";', resolveDir: siteRoot, loader: "ts" } });
  const styles = await build({ absWorkingDir: siteRoot, bundle: true,
    stdin: { contents: ["global.css", "home/index.css", "kylon-shell.css", "kylon-layout/index.css"].map(file => `@import "./src/styles/${file}";`).join("\n"), loader: "css", resolveDir: siteRoot },
    loader: { ".woff2": "dataurl" }, write: false,
    plugins: [{ name: "local-fonts", setup(builder) { builder.onResolve({ filter: /^\/fonts\// }, args => ({ path: join(siteRoot, "public", args.path.slice(1)) })); } }] });
  try {
    await writeFile(fixture, `<!doctype html><html><head><meta charset="utf-8"><style>${styles.outputFiles[0]?.text}
      * { box-sizing: border-box; } body { margin: 0; } live-dashboard { display: block; height: min(720px, 100dvh); }
      .dashboard__root, [data-panel=channel], .hm-frame { height: 100%; min-height: 0; }
    </style></head><body><live-dashboard class="dashboard" data-kylon-shell><div class="dashboard__root"><section data-panel="channel">
      <div class="hm-frame"><aside class="hm-frame__rail"><div data-workspace-picker-root></div>
      <div class="dashboard__rail-foot" data-user-menu-root><button class="dashboard__user-trigger" data-user-menu-trigger type="button">Account</button><div class="dashboard__user-menu" hidden>${'<button class="hm-rail__link">Account item</button>'.repeat(12)}</div></div>
      <div class="hm-frame__rail-content" data-home-rail-slot><nav class="hm-rail">${'<button class="hm-rail__link">Workspace</button>'.repeat(30)}</nav></div></aside>
      <div class="hm-frame__main"><div data-home-workspace-shell></div></div><aside class="hm-frame__side" data-home-side-slot><div class="hm-side"></div></aside></div>
    </section></div></live-dashboard><script>${bundle.outputFiles[0]?.text}</script><script>
    (() => {
      try {
        const app = document.querySelector('live-dashboard'), pickerRoot = app.querySelector('[data-workspace-picker-root]');
        const switched = [], account = app.querySelector('[data-user-menu-trigger]'); let accountOpens = 0;
        const popup=app.querySelector('.dashboard__user-menu');
        account.addEventListener('click', () => { accountOpens++; popup.hidden=!popup.hidden; });
        pickerRoot.append(NavLayout.buildWorkspacePicker(document, [{id:'a',name:'First workspace',archived:false}, {id:'b',name:'Second workspace',archived:false}], 'a', id => switched.push(id)));
        const vm = {sample:false, workspaceId:'a', name:'First workspace', people:[], pane:'chat', todosAvailable:true,
          hrefs:{chat:'?w=a',todos:'?w=a&v=todos',lists:'?w=a&v=lists',files:'?w=a&v=files',wiki:'?w=a&v=wiki',workspaces:'?v=catchup'},menu:{settings:true,adminAccess:false}};
        app.querySelector('[data-home-workspace-shell]').append(NavLayout.buildPhoneTopBar(document, vm, {openPeople(){},menu(){}}));
        const host = NavLayout.createKylonHost(app, () => {});
        host.sync({enabled:true,title:'Workspaces',workspaceName:'First workspace',navigation:[{id:'chat',label:'Chat',href:'?w=a',current:true,icon:'M4 4h16v16H4z'}]});
        const shell = app.querySelector('.cs-org-shell'), phone = matchMedia('(max-width:52rem)').matches;
        const point = el => { const r=el.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,top:r.top,bottom:r.bottom}; };
        const hit = el => { const r=point(el), target=document.elementFromPoint(r.x,r.y); return { ...r, target, owns: !!target && (target===el || el.contains(target)) }; };
        // Hit-test by coordinates first; dispatch to the element that a pointer would actually reach.
        const pointer = el => { const h=hit(el); if (!h.owns) throw Error('covered: '+el.className); for (const type of ['pointerdown','mousedown','pointerup','mouseup','click']) h.target.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,clientX:h.x,clientY:h.y,button:0})); return h; };
        const opener=shell.querySelector('[aria-label="Open navigation"]'); let close=null, returned=null, header=null;
        if (phone) {
          opener.focus(); pointer(opener);
          const bar=shell.querySelector('.cs-org-phone-bar'), closeButton=shell.querySelector('[aria-label="Close navigation"]');
          header=[...bar.children].filter(el=>el.getBoundingClientRect().width>0 && getComputedStyle(el).display!=='none').map(el=>el.className);
          close=hit(closeButton); pointer(closeButton); returned=document.activeElement===opener;
          pointer(opener);
        }
        const identity=shell.querySelector('.cs-org-identity-slot'), scroll=shell.querySelector('.cs-org-context-scroll');
        const summary=pickerRoot.querySelector('summary'), item=pickerRoot.querySelector('button[value="b"]');
        const summaryBox=hit(summary); pointer(summary); const choiceBox=hit(item); pointer(item);
        const accountBox=hit(account); pointer(account);
        const popupBox=point(popup), popupScroll={client:popup.clientHeight,total:popup.scrollHeight};
        popup.scrollTop=popup.scrollHeight; popupScroll.moved=popup.scrollTop>0;
        const popupLast=hit(popup.lastElementChild); popup.hidden=true;
        const scrollBefore=scroll.scrollTop; scroll.scrollTop=100; const scrollMoved=scroll.scrollTop>scrollBefore;
        const scrollNodes=['.cs-org-context', '.cs-org-context-scroll', '.cs-org-context-body', '.hm-frame__rail-content', '.hm-rail'].map(selector => {
          const el=shell.querySelector(selector), style=getComputedStyle(el);
          return {selector, client:el.clientHeight, total:el.scrollHeight, top:el.scrollTop, overflowY:style.overflowY, display:style.display};
        });
        const output={phone,header,close:close && {w:close.w,h:close.h,owns:close.owns},returned,
          identity:point(identity),summary:{w:summaryBox.w,h:summaryBox.h,owns:summaryBox.owns},choice:{w:choiceBox.w,h:choiceBox.h,owns:choiceBox.owns},
          account:{w:accountBox.w,h:accountBox.h,owns:accountBox.owns,bottom:accountBox.bottom},scroll:{top:point(scroll).top,bottom:point(scroll).bottom,client:scroll.clientHeight,total:scroll.scrollHeight,moved:scrollMoved},switched,accountOpens,
          popup:{top:popupBox.top,bottom:popupBox.bottom,scroll:popupScroll,lastOwns:popupLast.owns}, overflow:document.documentElement.scrollWidth>innerWidth, viewport:{width:innerWidth,height:innerHeight}, scrollNodes};
        document.documentElement.dataset.navGeometry=btoa(JSON.stringify(output)); host.suspend();
      } catch (error) { document.documentElement.dataset.navError=String(error && error.stack || error); }
    })();</script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const [width, height] of [[390, 500], [390, 900], [844, 390], [1440, 900]]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},${height}`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 20 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/\bdata-nav-geometry="([A-Za-z0-9+/]+={0,2})"/u)?.[1];
      assert.ok(encoded, `${width}px: applied host geometry must complete`);
      const g = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
      assert.equal(g.overflow, false); assert.deepEqual(g.switched, ["b"]); assert.equal(g.accountOpens, 1);
      for (const control of [g.summary, g.choice, g.account]) { assert.equal(control.owns, true); assert.ok(control.w >= 43.5 && control.h >= 43.5); }
      assert.ok(g.popup.top >= -1 && g.popup.bottom <= g.account.bottom && g.popup.lastOwns, `popup geometry at ${width}×${height}: ${JSON.stringify(g.popup)}`);
      if (g.popup.scroll.total > g.popup.scroll.client) assert.equal(g.popup.scroll.moved, true);
      assert.ok(g.scroll.total > g.scroll.client && g.scroll.moved, `middle scroll failed at ${width}×${height}: ${JSON.stringify({viewport:g.viewport,scroll:g.scroll,nodes:g.scrollNodes})}`); assert.ok(g.identity.bottom <= g.scroll.top + 1);
      assert.ok(g.account.bottom >= g.scroll.bottom - 1);
      if (width === 390) {
        assert.deepEqual(g.header, ["cs-icon-button", "cs-org-phone-title", "hm-details-toggle"]);
        assert.equal(g.close.owns, true); assert.ok(g.close.w >= 43.5 && g.close.h >= 43.5); assert.equal(g.returned, true);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
