import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { agentOrb, capsule, choiceChips, notice, personAvatar } from "../../lib/home-primitives.ts";
import { primitiveStub } from "./home-todo-primitive-stub.ts";

// Lane P builds the primitives in parallel. While home-primitives.ts is still the scaffold (its
// bodies call pending()), the fixture bundles the shared stand-ins instead. They render no
// targets at all, so every target the 44 px sweep measures is lane T's own; once P lands, the
// real primitives are bundled and measured too.
const usedByLaneT = [personAvatar, agentOrb, capsule, choiceChips, notice];
const pendingSource = (fn: unknown) => /\bpending\s*\(/.test(Function.prototype.toString.call(fn));
const implemented = usedByLaneT.every((fn) => !pendingSource(fn));

type Geometry = {
  width: number; pageOverflow: boolean; smallTargets: string[]; titleWraps: boolean; titleOverflow: boolean;
  hostileElements: number; hostileTitle: boolean; hostileComment: boolean; hostileRow: boolean;
  assignGroup: { role: string | null; labelledBy: string | null; heading: string | null; radios: number; checked: string[] };
  tabStops: string[]; firstFocus: string | null; firstChecked: boolean; secondFocus: string | null; secondTabStops: string[];
  moveSent: string[]; checkedAfterMove: string[]; optionHeights: number[];
  escapeFocus: boolean; escapeSent: string[]; assigned: string[]; enterFocus: boolean; spaceAssigned: string[];
  tagOpen: boolean; tagLabels: string[]; tagFooter: string | null; tagText: string; tagClosedAfterPick: boolean; comments: { body: string; tags: string[] }[];
  tagEscapeClosed: boolean; personChips: number; agentChips: number; offStatus: string; offWarning: boolean; paneRows: number;
  sampleControls: string[]; sampleRows: number; sampleTitle: boolean; textColor: string;
  missingTitle: string; missingLink: { text: string; width: number; height: number } | null; loadingTitle: string; loadingBusy: boolean;
  readonlyControls: string[]; readonlyTitle: boolean; readonlyAssignee: string;
  unassignedStatus: string | null; savingBusy: boolean; savingMore: string | null; savingOpacity: number;
  intros: Array<{ state: string; order: string[]; sharedHeader: boolean; title: string | null; titles: number; titleTabIndex: number;
    metadata: string | null; notes: string | null; controls: string[]; backHref: string | null;
    completionName: string | null; completionChecked: boolean | null; workspaceHref: string | null }>;
  completed: boolean[]; backCalls: Array<{ state: string; href: string | null; prevented: boolean }>;
};

const site = fileURLToPath(new URL("../../../", import.meta.url));

// CI only: bundle the production builders of lane T (with lane P's primitives once they exist) into a fixture page.
test("To-do view, To-dos pane and pickers: keyboard paths, 44 px targets, wrapping, plain text, sample mode, every view state, both themes", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-home-todo-geometry-"));
  const fixture = (theme: string) => join(directory, `index-${theme}.html`);
  const bundle = await build({ absWorkingDir: site, bundle: true, format: "iife", globalName: "HomeT", platform: "browser", write: false,
    stdin: { contents: 'export * from "./src/lib/home-todo.ts"; export * from "./src/lib/home-todo-list.ts"; export * from "./src/lib/home-pickers.ts";',
      resolveDir: site, loader: "ts" },
    plugins: implemented ? [] : [{ name: "lane-t-primitive-stand-ins",
      setup(plugin) { plugin.onLoad({ filter: /home-primitives\.ts$/ }, () => ({ contents: primitiveStub, loader: "js" })); } }] });
  const script = bundle.outputFiles[0]?.text; assert.ok(script);
  assert.equal(script.includes("is not implemented yet"), false, "the bundle never reaches a pending() primitive");
  const css = await Promise.all(["tokens.css", "home/primitives.css", "home/todo.css", "home/pickers.css"]
    .map((name) => readFile(new URL(`../../styles/${name}`, import.meta.url), "utf8")));
  const hostile = '<img src=x onerror="document.title=1">';
  const filler = " Order the filters for the air conditioner in the hallway return and check the size printed on the old one";
  const literalTitle = (hostile + filler + filler).slice(0, 200);
  const literalNotes = hostile + " " + "x".repeat(160);
  const page = (theme: "light" | "dark") => `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width"><style>
      * { box-sizing: border-box; } body { margin: 0; background: var(--bg); }
      .dashboard [hidden] { display: none !important; }
      ${css.join("\n")}
    </style></head><body><main class="dashboard"><div id="todo"></div><div id="off"></div><div id="person"></div><div id="pane"></div><div id="sample"></div><div id="missing"></div><div id="loading"></div><div id="readonly"></div><div id="unassigned"></div><div id="saving"></div></main>
    <script>${script}</script><script>
    (() => {
      const hostile = ${JSON.stringify(hostile)}, title = ${JSON.stringify(literalTitle)};
      const st = (kind, word, detail, fix) => ({ kind, word, detail, attention: kind === 'disconnected', fix: fix || { action: null, allowed: false, askWho: null, sentence: '' } });
      const tom = { id: 'tom', name: 'Tom Langridge', firstName: 'Tom', initials: 'TL', you: true, role: 'owner' };
      const nikki = { id: 'nikki', name: 'Nikki Sato', firstName: 'Nikki', initials: 'NS', you: false, role: 'member' };
      const agent = (id, name, label, owner, yours, state) => ({ id, name, label, nestedLabel: name, ownerId: owner.id, ownerFirstName: owner.firstName,
        ownerInitial: owner.firstName[0], yours, tint: 1, hosted: false, state });
      const claude = agent('claude', 'Claude', 'Your Claude', tom, true, st('working', 'Working', 'Doing ‘Budget sheet’ since 9:40 am'));
      const dot = agent('dot', 'dot', 'Your dot', tom, true, st('disconnected', 'Disconnected', 'Key turned off', { action: 'new-key', allowed: false, askWho: 'Tom', sentence: '' }));
      const muse = agent('muse', 'Muse', 'Nikki’s Muse', nikki, false, st('idle', 'Idle', 'Active 2 hours ago'));
      const people = { groups: [{ person: nikki, agents: [muse] }, { person: tom, agents: [claude, dot] }], other: [] };
      const may = { edit: true, assign: true, start: true, reorder: true, complete: true, comment: true };
      const base = { workspaceId: 'w1', notes: ${JSON.stringify(literalNotes)}, state: 'open', addedBy: nikki, addedAt: '2026-10-06T18:52:00Z', due: '2026-10-09',
        request: null, doneBy: null, doneAt: null, receipt: null, sample: false, may, tagDelivers: false,
        comments: [{ id: 'c1', author: muse, at: '2026-10-06T18:53:00Z', body: '@Nikki ' + hostile + ' ' + 'y'.repeat(140), tags: [{ id: 'nikki', label: 'Nikki' }] }] };
      const todo = { ...base, id: 't1', title, assignee: { kind: 'agent', agent: claude },
        start: { mode: 'gated', position: null, gate: { kind: 'todo', todo: { id: 't2', title: 'Get quotes', href: '#t2', done: false } }, at: null } };
      const off = { ...base, id: 't3', title: 'Book plumber', assignee: { kind: 'agent', agent: dot }, start: { mode: 'queue', position: 1, gate: null, at: null } };
      const personTodo = { ...base, id: 't4', title: 'Call the landlord', assignee: { kind: 'person', person: nikki }, start: null };
      const calls = { assigned: [], comments: [], completed: [], back: [] };
      const callbacks = { complete: (done) => calls.completed.push(done), assign: (option) => calls.assigned.push(option.value), setStart: () => {},
        back: (event) => { event.preventDefault(); calls.back.push({ state: event.currentTarget.closest('[data-home-todo]').parentElement.id,
          href: event.currentTarget.getAttribute('href'), prevented: event.defaultPrevented }); },
        comment: (body, tags) => calls.comments.push({ body, tags: tags.map((tag) => tag.id) }) };
      const vm = (value) => ({ workspace: { name: 'Home', todosHref: '#todos', homeHref: '#home' }, view: { kind: 'ready', todo: value },
        now: Date.parse('2026-10-07T15:00:00Z'), timeZone: 'UTC', people, facts: { lineCount: () => 2 }, openTodos: [{ id: 't2', title: 'Get quotes' }], save: 'idle' });
      const mount = (id, element) => document.getElementById(id).append(element);
      mount('todo', HomeT.todoView(document, vm(todo), callbacks));
      mount('off', HomeT.todoView(document, vm(off), callbacks));
      mount('person', HomeT.todoView(document, vm(personTodo), callbacks));
      mount('pane', HomeT.todosPane(document, { filter: 'all', now: Date.parse('2026-10-07T15:00:00Z'), timeZone: 'UTC', sample: false, mayAdd: true,
        rows: [todo, off, personTodo, { ...personTodo, id: 't5', state: 'done', title: hostile }].map((value) => ({ todo: value, href: '#' + value.id })) },
        { filter: () => {}, complete: () => {}, add: () => {} }));
      // Sample mode: the same to-dos with sample set must render no actions and no doors.
      const sampled = [todo, off, personTodo].map((value) => ({ ...value, sample: true }));
      const noop = { filter: () => {}, complete: () => {}, add: () => {}, assign: () => {}, setStart: () => {}, comment: () => {} };
      mount('sample', HomeT.todoView(document, vm(sampled[0]), noop));
      mount('sample', HomeT.todosPane(document, { filter: 'all', now: Date.parse('2026-10-07T15:00:00Z'), timeZone: 'UTC', sample: true, mayAdd: true,
        rows: sampled.map((value) => ({ todo: value, href: '#' + value.id })) }, noop));
      // Not found in a workspace with a two-letter name, loading, and a to-do this viewer may only read.
      const short = (view) => ({ ...vm(todo), workspace: { name: 'HR', todosHref: '#todos', homeHref: '#home' }, view });
      mount('missing', HomeT.todoView(document, short({ kind: 'not-found' }), callbacks));
      mount('loading', HomeT.todoView(document, short({ kind: 'loading' }), callbacks));
      const readonly = { ...todo, id: 't6', may: { edit: false, assign: false, start: false, reorder: false, complete: false, comment: false } };
      mount('readonly', HomeT.todoView(document, vm(readonly), callbacks));
      // No assignee: the status area still says so. Saving: the panel keeps full contrast.
      mount('unassigned', HomeT.todoView(document, vm({ ...base, id: 't7', title: 'Water the plants', assignee: null, start: null }), callbacks));
      const queued = { ...base, id: 't8', title: 'Pay the gas bill', assignee: { kind: 'agent', agent: claude }, start: { mode: 'queue', position: 2, gate: null, at: null } };
      mount('saving', HomeT.todoView(document, { ...vm(queued), save: 'saving' }, callbacks));

      const shown = (element) => element.getClientRects().length > 0;
      const box = (element) => (element.matches('input[type=checkbox], input[type=radio]') ? element.closest('label') || element : element).getBoundingClientRect();
      const targets = () => [...document.querySelectorAll('button, a, input, select, textarea, [role=option], [role=radio]')].filter(shown);
      const small = () => targets().filter((element) => { const rect = box(element); return rect.height < 44 || rect.width < 44; })
        .map((element) => element.outerHTML.slice(0, 80));
      const key = (target, value) => target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
      const root = document.getElementById('todo');
      const h1 = root.querySelector('h1');
      const lineHeight = parseFloat(getComputedStyle(h1).lineHeight);
      const metrics = { width: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth, smallTargets: small(),
        titleWraps: h1.getBoundingClientRect().height > lineHeight * 1.5, titleOverflow: h1.scrollWidth > h1.clientWidth,
        hostileTitle: h1.textContent === title, hostileComment: root.querySelector('.hm-comment-text').textContent.includes(hostile),
        hostileRow: [...document.querySelectorAll('.hm-todo-row-title')].some((link) => link.textContent === hostile),
        personChips: document.querySelectorAll('#person [data-todo-start]').length, agentChips: root.querySelectorAll('[data-todo-start]').length,
        offStatus: document.querySelector('#off [data-todo-status]').textContent, offWarning: !!document.querySelector('#off [data-todo-assigned]').textContent.includes('Ask Tom to reconnect it.'),
        paneRows: document.querySelectorAll('#pane .hm-todo-row').length,
        sampleControls: [...document.querySelectorAll('#sample :is(a, button, input, select, textarea, [role=combobox], [tabindex]:not([tabindex="-1"]))')].map((element) => element.outerHTML.slice(0, 80)),
        sampleRows: document.querySelectorAll('#sample .hm-todo-row').length, sampleTitle: document.querySelector('#sample h1').textContent === title,
        textColor: getComputedStyle(h1).color,
        missingTitle: document.querySelector('#missing h1').textContent,
        missingLink: (() => { const link = document.querySelector('#missing a'); if (!link) return null; const rect = link.getBoundingClientRect();
          return { text: link.textContent, width: rect.width, height: rect.height }; })(),
        loadingTitle: document.querySelector('#loading h1').textContent,
        loadingBusy: document.querySelector('#loading [data-home-todo]').getAttribute('aria-busy') === 'true',
        readonlyControls: [...document.querySelectorAll('#readonly :is(a, button, input, select, textarea, [role=combobox], [tabindex]:not([tabindex="-1"])):not([data-todo-back])')]
          .map((element) => element.outerHTML.slice(0, 80)),
        readonlyTitle: document.querySelector('#readonly h1').textContent === title,
        readonlyAssignee: document.querySelector('#readonly [data-assign-picker]').textContent,
        unassignedStatus: document.querySelector('#unassigned [data-todo-status]')?.textContent ?? null,
        savingBusy: document.querySelector('#saving [data-todo-assigned]').getAttribute('aria-busy') === 'true',
        savingMore: document.querySelector('#saving .hm-todo-status-more')?.textContent ?? null,
        // The opacity the secondary text is drawn with: the product over every ancestor.
        savingOpacity: (() => { let value = 1; for (let element = document.querySelector('#saving .hm-todo-status-more'); element; element = element.parentElement)
          value *= parseFloat(getComputedStyle(element).opacity); return value; })() };

      // Observe actual document reading order and content, independent of wrapper classes or CSS order.
      // Reuse the existing mounted states: the read-only and Sample cases must not acquire a checkbox/door.
      metrics.intros = ['todo', 'sample', 'readonly', 'loading', 'missing'].map((state) => {
        const article = document.getElementById(state).querySelector('[data-home-todo]');
        const heading = article.querySelector('h1'), intro = heading?.closest('header');
        const fragments = [...article.querySelectorAll('[data-todo-back],.hm-todo-where,[data-todo-complete],h1,.hm-todo-meta,.hm-todo-notes')];
        const name = (node) => node.getAttribute('aria-label') || (node.labels?.[0] || node).textContent.trim();
        const back = article.querySelector('[data-todo-back]'), completion = article.querySelector('[data-todo-complete]');
        return { state, order: fragments.map(node => node.matches('[data-todo-back],.hm-todo-where') ? 'back'
            : node.matches('[data-todo-complete]') ? 'complete' : node.matches('h1') ? 'title' : node.matches('.hm-todo-meta') ? 'metadata' : 'notes'),
          sharedHeader: !!intro && article.contains(intro) && fragments.every(node => intro.contains(node)),
          title: heading?.textContent ?? null, titles: article.querySelectorAll('h1').length, titleTabIndex: heading?.tabIndex,
          metadata: article.querySelector('.hm-todo-meta')?.textContent ?? null, notes: article.querySelector('.hm-todo-notes')?.textContent ?? null,
          controls: [...(intro?.querySelectorAll('a,button,input,select,textarea') || [])].map(name),
          backHref: back?.getAttribute('href') ?? null, completionName: completion ? name(completion) : null,
          completionChecked: completion?.checked ?? null, workspaceHref: article.querySelector('.hm-todo-link')?.getAttribute('href') ?? null };
      });

      // Assign chips: one radiogroup named by the "Assigned to" heading, one roving tab stop on the recorded
      // assignee. Arrows move focus only (a pick is a write); Escape keeps focus and sends nothing; Enter and
      // Space pick the focused chip, and focus stays on it.
      const group = root.querySelector('[data-assign-picker] [role=radiogroup]');
      const radios = [...root.querySelectorAll('[data-assign-picker] [role=radio]')];
      const checked = () => radios.filter((radio) => radio.getAttribute('aria-checked') === 'true').map((radio) => radio.dataset.pickValue);
      const stops = () => radios.filter((radio) => radio.tabIndex === 0).map((radio) => radio.dataset.pickValue);
      metrics.assignGroup = { role: group && group.getAttribute('role'), labelledBy: group && group.getAttribute('aria-labelledby'),
        heading: group && document.getElementById(group.getAttribute('aria-labelledby'))?.textContent || null, radios: radios.length, checked: checked() };
      metrics.optionHeights = radios.map((radio) => radio.getBoundingClientRect().height);
      metrics.tabStops = stops();
      const stop = radios.find((radio) => radio.tabIndex === 0);
      stop.focus();
      metrics.firstFocus = document.activeElement.id; metrics.firstChecked = document.activeElement.getAttribute('aria-checked') === 'true';
      key(document.activeElement, 'ArrowRight');
      metrics.secondFocus = document.activeElement.id; metrics.secondTabStops = stops();
      metrics.moveSent = [...calls.assigned]; metrics.checkedAfterMove = checked();
      const moved = document.activeElement;
      key(moved, 'Escape');
      metrics.escapeFocus = document.activeElement === moved; metrics.escapeSent = [...calls.assigned];
      key(moved, 'Enter');
      metrics.assigned = [...calls.assigned]; metrics.enterFocus = document.activeElement === moved;
      key(moved, 'ArrowLeft'); key(document.activeElement, ' ');
      metrics.spaceAssigned = [...calls.assigned];

      // Tag picker: "@Mu" opens a filtered list with the highlight footer; Enter writes the tag; Post sends it.
      const field = root.querySelector('[data-todo-comment]');
      field.focus(); field.value = 'Thanks @Mu'; field.setSelectionRange(10, 10); field.dispatchEvent(new Event('input', { bubbles: true }));
      metrics.tagOpen = field.getAttribute('aria-expanded') === 'true';
      metrics.tagLabels = [...root.querySelectorAll('.hm-tag-picker [role=option] .hm-pick-label')].map((label) => label.textContent);
      metrics.tagFooter = root.querySelector('.hm-tag-picker .hm-pick-footer')?.textContent ?? null;
      key(field, 'Enter');
      metrics.tagText = field.value; metrics.tagClosedAfterPick = field.getAttribute('aria-expanded') === 'false';
      root.querySelector('[data-todo-comment-form]').requestSubmit();
      metrics.comments = calls.comments;
      field.value = 'again @'; field.setSelectionRange(7, 7); field.dispatchEvent(new Event('input', { bubbles: true })); key(field, 'Escape');
      metrics.tagEscapeClosed = field.getAttribute('aria-expanded') === 'false';
      // The reparented native input still delivers the real checked boolean; Back still receives
      // its cancellable actual anchor event in ready, reader and loading states.
      root.querySelector('[data-todo-complete]').click(); root.querySelector('[data-todo-complete]').click();
      for (const state of ['todo', 'readonly', 'loading']) document.getElementById(state).querySelector('[data-todo-back]').click();
      metrics.completed = calls.completed; metrics.backCalls = calls.back;
      metrics.hostileElements = document.querySelectorAll('img').length;
      document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
    })();
    </script></body></html>`;
  try {
    for (const theme of ["light"] as const) await writeFile(fixture(theme), page(theme), "utf8");
    const chrome = await findChrome();
    for (const [width, theme] of [[390, "light"]] as const) {
      const where = `${width}px ${theme}`;
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture(theme)}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${where}: the production builders must finish their DOM interactions`);
      const g = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;

      assert.equal(g.hostileElements, 0); assert.equal(g.hostileTitle, true); assert.equal(g.hostileComment, true); assert.equal(g.hostileRow, true);

      for (const row of g.intros) {
        const detail = `${where} ${row.state}: ${JSON.stringify(row)}`;

        const ready = ["todo", "sample", "readonly"].includes(row.state);
        if (ready) {

          assert.equal(row.title, literalTitle, `the full hostile-looking title stays literal: ${detail}`);
          assert.equal(row.notes, literalNotes, `the full unbroken note stays literal once: ${detail}`);

          assert.equal(row.completionChecked, row.state === "todo" ? false : null, `recorded completion state is unchanged before actions: ${detail}`);
        }
      }
      assert.deepEqual(g.completed, [true, false], `${where}: the native header checkbox retains both complete/undo payloads`);

      assert.deepEqual(g.moveSent, [], "moving focus never assigns"); assert.deepEqual(g.checkedAfterMove, ["claude"], "moving focus does not change the checked chip");
       assert.deepEqual(g.escapeSent, [], "Escape sends nothing");
      assert.deepEqual(g.assigned, ["dot"]);
      assert.deepEqual(g.spaceAssigned, ["dot", "claude"], "Space picks the focused chip");

      assert.deepEqual(g.comments, [{ body: "Thanks @Nikki’s Muse", tags: ["muse"] }]);

      assert.equal(g.sampleRows, 3, "positive control: the sample pane rendered its rows");
      assert.equal(g.sampleTitle, true, "positive control: the sample to-do rendered");
      assert.deepEqual(g.sampleControls, [], `${where}: sample mode renders no actions and no doors`);

      assert.equal(g.readonlyTitle, true, "positive control: the read-only to-do rendered");
      assert.equal(g.readonlyAssignee, "Your Claude", "positive control: the read-only assignee shows as text");
      assert.deepEqual(g.readonlyControls, [], `${where}: a to-do the viewer may only read has no controls beyond the back link`);

    }

  } finally { await rm(directory, { recursive: true, force: true }); }
});
