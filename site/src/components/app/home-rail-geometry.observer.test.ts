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
    for (const width of [1440, 900, 390, 320]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 20 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${width}px: the builders must finish and report geometry`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.error, undefined, `${width}px: the builders threw`);
      assert.equal(geometry.width, width);
      assert.ok(geometry.docOverflow <= 0, `${width}px: no horizontal overflow (${geometry.docOverflow}px)`);
      assert.deepEqual(geometry.smallTargets, [], `${width}px: every visible link and button is at least 44 by 44 px`);
      assert.equal(geometry.hostileElements, 0, `${width}px: names render as text`);
      assert.equal(geometry.hostileText, true);
      assert.ok(geometry.menu, `${width}px: a ⋯ menu is visible`);
      assert.equal(geometry.menu.openFocus, "Wiki"); assert.equal(geometry.menu.expanded, "true");
      assert.equal(geometry.menu.escapeClosed, true); assert.equal(geometry.menu.focusBack, true);
      assert.equal(geometry.menu.itemsShown, 3, `${width}px: the open menu shows its three items`);
      assert.deepEqual(geometry.menu.smallItems, [], `${width}px: open menu items are at least 44 by 44 px and the open menu does not overflow`);

      const shownTitles = geometry.titles.filter((title) => title.shown);
      assert.equal(shownTitles.length, 1, `${width}px: exactly one workspace H1 shows`);
      for (const title of shownTitles) {
        assert.equal(title.clipped, false, `${width}px: ${title.selector} wraps and is never cut short`);
        assert.ok(title.lines > 2, `${width}px: the long name runs past two lines, so a clamp would have cut it: ${JSON.stringify(title)}`);
      }

      assert.deepEqual(geometry.latePast.visible, ["w0", "w1", "w2", "w3", "w4", "w7"], "a current workspace past the cap takes the sixth place");
      assert.equal(geometry.latePast.more, "Show 3 more");
      assert.deepEqual(geometry.sample.shellDoors, [], "a sample header and phone bar render no buttons and no menu");
      assert.equal(geometry.sample.menuButtons, 0);
      assert.deepEqual(geometry.sample.railDoors, [], "sample rail rows open nothing and New workspace is left out");

      if (width >= 1024) {
        const rail = geometry.rail;
        assert.ok(rail, "the rail shows at desktop width");
        assert.equal(rail.participantHook, true);
        assert.equal(rail.firstGroupIsViewer, true, "you come first");
        assert.deepEqual(rail.groupAgentCounts, [15, 15, 15], "every agent is nested under its owner");
        assert.equal(rail.otherAgents, 5, "Other agents come last, in their own group");
        assert.equal(rail.presenceDots, 0, "people rows carry no presence dot");
        assert.equal(rail.visibleWorkspaces, 6); assert.equal(rail.moreLabel, "Show 3 more"); assert.equal(rail.currentWorkspace, "w1");
        assert.equal(rail.workspacesVisible, true, "Catch up, the workspaces and New workspace stay in view");
        assert.equal(rail.listOverflowY, "auto");
        assert.ok(rail.listScroll > rail.listClient, `the 50-agent list scrolls inside the rail: ${JSON.stringify(rail)}`);
        assert.ok(rail.listClient >= 112, `the list keeps a usable height: ${JSON.stringify(rail)}`);
        assert.equal(rail.listInsideRail, true, "the list fills only the height the rail has left");
        assert.equal(rail.noteInsideRail, true, "the ownership line stays in view under the list");
      } else if (width <= 832) {
        assert.equal(geometry.rail, null, `${width}px: the phone has no left rail`);
        assert.equal(geometry.phone?.barVisible, true); assert.equal(geometry.phone?.navVisible, true); assert.equal(geometry.phone?.headerHidden, true);
        assert.deepEqual(geometry.phone?.navLabels, ["Chat", "To-dos", "Lists", "Files"]); assert.equal(geometry.phone?.current, "Chat");
      } else {
        assert.ok(geometry.rail, "the tablet keeps the rail");
        assert.equal(geometry.phone?.barVisible, false); assert.equal(geometry.phone?.navVisible, false);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
