import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { join } from "node:path";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

type Geometry = {
  width: number; scrollWidth: number; cardOverflow: boolean; touchTargets: boolean; smallTargets: string[];
  order: string[]; todoRows: number; checkboxCalls: string[]; hostileElements: number; hostileTitleText: boolean;
  noTodoOrder: string[]; doorOrder: string[]; doorButtons: number; doorCalls: number; doorTitle: string; doorButtonText: string;
  narrowTargets: string[];
  sampleChecks: number; sampleAdd: number; sampleDoor: number; shared: string[];
  streamOverflow: boolean; streamTargets: boolean; dividers: string[]; hostileAuthorText: boolean; extrasCount: number;
};

// CI only: build the production DOM builders and check them in a real layout engine. The shared primitives
// (home-primitives.ts) come from lane P, so this runs after both lanes are merged.
test("W right column and stream decorations have usable geometry and keep hostile text as text", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-workspace-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({ absWorkingDir: root, bundle: true, format: "iife", globalName: "HomeWorkspace", platform: "browser", write: false,
    stdin: { contents: `export * from "./src/lib/home-side-cards"; export * from "./src/lib/home-stream";`, resolveDir: root, loader: "ts" } });
  const script = bundle.outputFiles[0]?.text; assert.ok(script);
  const [tokens, primitives, workspace] = await Promise.all([read("../../styles/tokens.css"), read("../../styles/home/primitives.css"), read("../../styles/home/workspace.css")]);
  const hostile = "<img src=x onerror=\"document.title=1\">";
  const longWord = "Supercalifragilisticexpialidocious".repeat(4);
  const data = { hostile, longWord };
  try {
    await writeFile(fixture, `<!doctype html><html><head><style>
      * { box-sizing: border-box; } body { margin: 0; font-family: sans-serif; }
      ${tokens} ${primitives} ${workspace}
      #column { width: min(22rem, 100%); } #stream { width: 100%; margin: 0; padding: 0; list-style: none; }
    </style></head><body><div id="column"></div><div id="column-no-todos"></div><div id="column-door"></div><div id="column-sample"></div><ol id="stream"></ol>
      <script>${script}</script><script>
      (async () => {
        const data = ${JSON.stringify(data).replace(/</gu, "\\u003c")};
        const person = (id, name, you = false) => ({ id, name, firstName: name.split(' ')[0], initials: name.slice(0, 2).toUpperCase(), you, role: 'member' });
        const agent = (id, label, yours) => ({ id, name: label, label, nestedLabel: label, ownerId: 'tom', ownerFirstName: 'Tom', ownerInitial: 'T', yours, tint: 0, hosted: false, dashed: false,
          state: { kind: 'idle', word: 'Idle', detail: 'Active 2 hours ago', attention: false, fix: { action: null, allowed: false, askWho: null, sentence: '' } } });
        const todo = (n, state = 'open', title = 'To-do ' + n) => ({ id: 'td' + n, title, href: '#td' + n, state, mayComplete: n % 2 === 1, subline: 'Your Claude · ' + n + 'th in line' });
        const card = (kind, n, title) => ({ kind, id: kind + n, title, href: '#' + kind + n, meta: kind + ' meta', who: null });
        const todos = { items: [todo(1, 'open', data.hostile + data.longWord), ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => todo(n)), todo(10, 'done'), todo(11, 'dropped')], allHref: '#todos', canAdd: true };
        const objects = { state: 'ready', lists: [1, 2, 3, 4, 5, 6, 7].map((n) => card('list', n, n === 1 ? data.hostile + data.longWord : 'List ' + n)),
          files: [1, 2, 3].map((n) => card('file', n, 'File ' + n + '.pdf')) };
        const base = { sample: false, workspaceName: 'Home', todos, objects, sharedAgents: [{ agent: agent('a1', 'Your Claude', true), until: null }, { agent: agent('a2', 'Nikki’s Muse', false), until: null }],
          hrefs: { lists: '#lists', files: '#files', wiki: '#wiki' } };
        const checkboxCalls = []; let doorCalls = 0; let completed; const completion = new Promise((resolve) => { completed = resolve; });
        const callbacks = { onComplete: (id) => { checkboxCalls.push(id); completed(); }, onAddTodo: () => {}, onOpenLists: () => { doorCalls += 1; } };
        const mount = (id, vm) => { const element = HomeWorkspace.buildSideCards(document, vm, callbacks); document.getElementById(id).append(element); return element; };
        const keys = (element) => [...element.children].map((child) => child.dataset.sideCard || (child.querySelector('[data-side-link=wiki]') ? 'wiki' : '?'));
        const main = mount('column', base);
        const noTodos = mount('column-no-todos', { ...base, todos: null });
        const door = mount('column-door', { ...base, objects: { state: 'refused' } });
        const sample = mount('column-sample', { ...base, sample: true });

        const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
        const targets = [...document.querySelectorAll('a, button, label.hm-todo-row__check')].filter(shown);
        const smallTargets = targets.filter((element) => element.getBoundingClientRect().height < 43.5).map((element) => element.className || element.tagName);
        const narrowTargets = targets.filter((element) => element.getBoundingClientRect().width < 43.5).map((element) => element.className || element.tagName);
        main.querySelector('[data-side-todo-complete]').click();
        door.querySelector('[data-side-door]').click();

        await completion; // the checkbox reports through a promise; read the calls only after it ran
        const hostileTitle = main.querySelector('[data-side-todo-link=td1] .hm-todo-row__title');
        const cardOverflow = [...document.querySelectorAll('.hm-side-card, .hm-todo-row')].some((element) => element.scrollWidth > element.clientWidth + 1);

        const now = Date.parse('2026-10-05T15:00:00Z');
        const stream = document.getElementById('stream');
        const signals = [
          { id: 's1', kind: 'note', body: 'x', about: null, createdAt: '2026-10-03T10:00:00Z', when: '10:00 am', author: person('p1', data.hostile + ' Rao'), addressedToViewer: false, answered: false, attachments: [] },
          { id: 's2', kind: 'ask', body: data.hostile + ' Which plumber ' + data.longWord + '?', about: 'todo:3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', createdAt: '2026-10-04T10:00:00Z', when: 'Yesterday', author: agent('a2', 'Nikki’s Muse', false),
            addressedToViewer: true, answered: false, attachments: [{ fileId: 'f1', versionN: 1, name: data.longWord + '.pdf', contentType: 'application/pdf', sizeBytes: 214000, href: '#f1' }] },
          { id: 's3', kind: 'note', body: 'plain', about: 'field trial', createdAt: '2026-10-05T10:00:00Z', when: '10:00 am', author: person('me', 'Tom Rao', true), addressedToViewer: false, answered: false, attachments: [] },
        ];
        const context = { workspace: { id: 'w', name: 'Home', href: '#w' }, todos: new Map([['3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', { id: '3f2b8c1e-5d4a-4b6f-9a7e-1c2d3e4f5a6b', title: 'Call the plumber', href: '#t', meta: 'Added by Nikki', who: null, done: false }]]) };
        let extrasCount = 0;
        for (const row of HomeWorkspace.groupByDay(signals, now, 'en-US', 'UTC')) {
          if (row.type === 'divider') { stream.append(HomeWorkspace.buildDayDivider(document, row.label, row.key)); continue; }
          const li = document.createElement('li'); li.append(HomeWorkspace.buildAuthorLine(document, row.item));
          const extras = HomeWorkspace.buildStreamExtras(document, HomeWorkspace.deriveStreamExtras(row.item, context), () => {});
          if (extras) { li.append(extras); extrasCount += 1; }
          stream.append(li);
        }
        const streamTargets = [...stream.querySelectorAll('a, button')].filter(shown).every((element) => element.getBoundingClientRect().height >= 43.5 && element.getBoundingClientRect().width >= 43.5);
        const metrics = { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, cardOverflow, touchTargets: smallTargets.length === 0, smallTargets,
          order: keys(main), todoRows: main.querySelectorAll('[data-side-todo]').length, checkboxCalls, hostileElements: document.querySelectorAll('img').length,
          hostileTitleText: hostileTitle.textContent.includes(data.hostile) && main.querySelector('[data-side-card=lists]').textContent.includes(data.hostile),
          noTodoOrder: keys(noTodos), doorOrder: keys(door), doorButtons: door.querySelectorAll('[data-side-door]').length, doorCalls,
          doorTitle: door.querySelector('[data-side-card=objects] h2').textContent, doorButtonText: door.querySelector('[data-side-door]').textContent, narrowTargets,
          sampleChecks: sample.querySelectorAll('input[type=checkbox]').length, sampleAdd: sample.querySelectorAll('[data-side-add-todo]').length, sampleDoor: sample.querySelectorAll('[data-side-door]').length,
          shared: [...main.querySelectorAll('[data-side-card=shared] p')].map((p) => p.textContent),
          streamOverflow: stream.scrollWidth > document.documentElement.clientWidth + 1, streamTargets,
          dividers: [...stream.querySelectorAll('[data-day-divider]')].map((d) => d.textContent), hostileAuthorText: stream.querySelector('.hm-author__name').textContent.includes(data.hostile), extrasCount };
        document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
      })();
      </script></body></html>`, "utf8");
    const chrome = await findChrome();
    for (const width of [320, 390, 1440]) {
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${width}px: the production builders must finish their DOM work`);
      const geometry = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      assert.equal(geometry.width, width);
      assert.ok(geometry.scrollWidth <= width, `${width}px: no horizontal overflow (${geometry.scrollWidth})`);
      assert.equal(geometry.cardOverflow, false, `${width}px: no card or row overflows its box`);
      assert.deepEqual(geometry.smallTargets, [], `${width}px: every visible link, button and checkbox is at least 44 px tall`);
      assert.deepEqual(geometry.narrowTargets, [], `${width}px: every visible link, button and checkbox is at least 44 px wide, including the short Wiki link`);
      assert.equal(geometry.streamOverflow, false); assert.equal(geometry.streamTargets, true);
      // Order (UI-SPEC 3.3): To-dos, Lists, Files, What's shared here, then the Wiki link.
      assert.deepEqual(geometry.order, ["todos", "lists", "files", "shared", "wiki"]);
      assert.equal(geometry.todoRows, 6, "at most six open to-dos; done and dropped rows never show");
      assert.deepEqual(geometry.checkboxCalls, ["td1"], "the first row has a checkbox and it reports its own to-do");
      // An absent to-dos read removes every To-dos surface; a refused Lists & docs read shows one door in place of Lists and Files.
      assert.deepEqual(geometry.noTodoOrder, ["lists", "files", "shared", "wiki"]);
      assert.deepEqual(geometry.doorOrder, ["todos", "objects", "shared", "wiki"]);
      assert.equal(geometry.doorButtons, 1); assert.equal(geometry.doorCalls, 1);
      assert.equal(geometry.doorTitle, "Turn on Lists & docs", "the door carries the Lists pane's own heading"); assert.equal(geometry.doorButtonText, "Turn on Lists & docs");
      assert.deepEqual([geometry.sampleChecks, geometry.sampleAdd, geometry.sampleDoor], [0, 0, 0], "sample mode renders no actions");
      assert.deepEqual(geometry.shared, ["Everyone in Home sees what is posted here, including what agents post.", "Your Claude can use Lists & docs here, until you withdraw it."]);
      assert.equal(geometry.hostileElements, 0); assert.equal(geometry.hostileTitleText, true); assert.equal(geometry.hostileAuthorText, true);
      assert.deepEqual(geometry.dividers, ["Oct 3", "Yesterday", "Today"]);
      assert.equal(geometry.extrasCount, 1, "only the ask with a file and a known to-do gets extras");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
