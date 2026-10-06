import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import { browserTest as test } from "../../../tests/chrome.js";
import { findChrome, launchChrome } from "../../../tests/chrome.js";
import { agentOrb, capsule, choiceChips, notice, personAvatar } from "../../lib/home-primitives.ts";

// Lane P builds the primitives in parallel. While home-primitives.ts is still the scaffold (its
// bodies call pending()), the fixture bundles these stand-ins instead. They render no targets at
// all, so every target the 44 px sweep measures is lane T's own; once P lands, the real
// primitives are bundled and measured too.
const primitiveStub = `
const span = (doc, text) => { const el = doc.createElement("span"); el.dataset.hmStub = ""; el.textContent = text; return el; };
export function personAvatar(doc, p) { return span(doc, p.initials); }
export function agentOrb(doc, a) { return span(doc, a.name.slice(0, 1)); }
export function capsule(doc, c) { return span(doc, c.person.name); }
export function statusLine(doc, s) { return span(doc, s.word); }
export function objectCard(doc, o) { return span(doc, o.title); }
export function needsYouCard(doc) { return span(doc, ""); }
export function choiceChips(doc, c) {
  const set = doc.createElement("fieldset"); set.dataset.hmStub = "";
  const legend = doc.createElement("legend"); legend.textContent = c.legend; set.append(legend);
  for (const option of c.options) set.append(span(doc, option.label));
  return set;
}
export function switchRow(doc, s) { return span(doc, s.label); }
export function queueRow(doc, q) { return span(doc, q.title); }
export function notice(doc, text, tone) { const el = doc.createElement("p"); el.dataset.hmStub = ""; el.dataset.tone = tone; el.textContent = text; return el; }
`;
const usedByLaneT = [personAvatar, agentOrb, capsule, choiceChips, notice];
const pendingSource = (fn: unknown) => /\bpending\s*\(/.test(Function.prototype.toString.call(fn));
const implemented = usedByLaneT.every((fn) => !pendingSource(fn));


type Geometry = {
  width: number; pageOverflow: boolean; smallTargets: string[]; titleWraps: boolean; titleOverflow: boolean;
  hostileElements: number; hostileTitle: boolean; hostileComment: boolean; hostileRow: boolean;
  assignOpen: boolean; firstActive: string | null; firstActiveSelected: boolean; secondActive: string | null; optionHeights: number[];
  escapeClosed: boolean; escapeFocus: boolean; assigned: string[]; enterFocus: boolean;
  tagOpen: boolean; tagLabels: string[]; tagFooter: string | null; tagText: string; tagClosedAfterPick: boolean; comments: { body: string; tags: string[] }[];
  tagEscapeClosed: boolean; personChips: number; agentChips: number; offStatus: string; offWarning: boolean; paneRows: number;
  sampleControls: string[]; sampleRows: number; sampleTitle: boolean; textColor: string;
  missingTitle: string; missingLink: { text: string; width: number; height: number } | null; loadingTitle: string; loadingBusy: boolean;
  readonlyControls: string[]; readonlyTitle: boolean; readonlyAssignee: string;
  unassignedStatus: string | null; savingBusy: boolean; savingMore: string | null; savingOpacity: number;
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
  const page = (theme: "light" | "dark") => `<!doctype html><html data-theme="${theme}"><head><meta name="viewport" content="width=device-width"><style>
      * { box-sizing: border-box; } body { margin: 0; background: var(--bg); }
      .dashboard [hidden] { display: none !important; }
      ${css.join("\n")}
    </style></head><body><main class="dashboard"><div id="todo"></div><div id="off"></div><div id="person"></div><div id="pane"></div><div id="sample"></div><div id="missing"></div><div id="loading"></div><div id="readonly"></div><div id="unassigned"></div><div id="saving"></div></main>
    <script>${script}</script><script>
    (() => {
      const hostile = '<img src=x onerror="document.title=1">';
      const filler = ' Order the filters for the air conditioner in the hallway return and check the size printed on the old one';
      const title = (hostile + filler + filler).slice(0, 200);
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
      const base = { workspaceId: 'w1', notes: hostile + ' ' + 'x'.repeat(160), state: 'open', addedBy: nikki, addedAt: '2026-10-06T18:52:00Z', due: '2026-10-09',
        request: null, doneBy: null, doneAt: null, receipt: null, sample: false, may, tagDelivers: false,
        comments: [{ id: 'c1', author: muse, at: '2026-10-06T18:53:00Z', body: '@Nikki ' + hostile + ' ' + 'y'.repeat(140), tags: [{ id: 'nikki', label: 'Nikki' }] }] };
      const todo = { ...base, id: 't1', title, assignee: { kind: 'agent', agent: claude },
        start: { mode: 'gated', position: null, gate: { kind: 'todo', todo: { id: 't2', title: 'Get quotes', href: '#t2', done: false } }, at: null } };
      const off = { ...base, id: 't3', title: 'Book plumber', assignee: { kind: 'agent', agent: dot }, start: { mode: 'queue', position: 1, gate: null, at: null } };
      const personTodo = { ...base, id: 't4', title: 'Call the landlord', assignee: { kind: 'person', person: nikki }, start: null };
      const calls = { assigned: [], comments: [] };
      const callbacks = { complete: () => {}, assign: (option) => calls.assigned.push(option.value), setStart: () => {},
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
      const targets = () => [...document.querySelectorAll('button, a, input, select, textarea, [role=option]')].filter(shown);
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

      // Assign picker: Down opens on the current value, Down moves, Escape closes and keeps focus; Down, Down, Enter picks.
      const trigger = root.querySelector('[data-assign-picker] [role=combobox]');
      trigger.focus(); key(trigger, 'ArrowDown');
      metrics.assignOpen = trigger.getAttribute('aria-expanded') === 'true';
      metrics.firstActive = trigger.getAttribute('aria-activedescendant');
      const first = metrics.firstActive && document.getElementById(metrics.firstActive);
      metrics.firstActiveSelected = !!first && first.getAttribute('aria-selected') === 'true' && first.closest('[role=listbox]').id === trigger.getAttribute('aria-controls');
      metrics.optionHeights = [...root.querySelectorAll('[data-assign-picker] [role=option]')].map((option) => option.getBoundingClientRect().height);
      metrics.smallTargets.push(...small());
      key(trigger, 'ArrowDown'); metrics.secondActive = trigger.getAttribute('aria-activedescendant');
      key(trigger, 'Escape');
      metrics.escapeClosed = trigger.getAttribute('aria-expanded') === 'false' && !trigger.hasAttribute('aria-activedescendant');
      metrics.escapeFocus = document.activeElement === trigger;
      key(trigger, 'ArrowDown'); key(trigger, 'ArrowDown'); key(trigger, 'Enter');
      metrics.assigned = calls.assigned; metrics.enterFocus = document.activeElement === trigger;

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
      metrics.hostileElements = document.querySelectorAll('img').length;
      document.documentElement.dataset.metrics = btoa(unescape(encodeURIComponent(JSON.stringify(metrics))));
    })();
    </script></body></html>`;
  try {
    for (const theme of ["light", "dark"] as const) await writeFile(fixture(theme), page(theme), "utf8");
    const chrome = await findChrome();
    const colors = new Map<string, string>();
    for (const [width, theme] of [[320, "light"], [390, "light"], [1440, "light"], [390, "dark"], [1440, "dark"]] as const) {
      const where = `${width}px ${theme}`;
      const { stdout } = await launchChrome(chrome, ["--allow-file-access-from-files", `--window-size=${width},900`, "--dump-dom", `file://${fixture(theme)}`],
        { maxBuffer: 10 * 1024 * 1024, timeout: 15_000, killSignal: "SIGKILL" });
      const encoded = stdout.match(/^\s*(?:<!doctype html>\s*)?<html\b[^>]*\bdata-metrics="([A-Za-z0-9+/]+={0,2})"/iu)?.[1];
      assert.ok(encoded, `${where}: the production builders must finish their DOM interactions`);
      const g = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Geometry;
      colors.set(`${width}-${theme}`, g.textColor);
      assert.equal(g.width, width);
      assert.equal(g.pageOverflow, false, `${where}: no horizontal overflow`);
      assert.deepEqual(g.smallTargets, [], `${where}: every visible target is at least 44 by 44 px`);
      assert.ok(g.optionHeights.length === 5 && g.optionHeights.every((height) => height >= 44), `${where}: picker rows are 44 px`);
      assert.equal(g.titleWraps, true, `${where}: a 200-character title wraps`); assert.equal(g.titleOverflow, false);
      assert.equal(g.hostileElements, 0); assert.equal(g.hostileTitle, true); assert.equal(g.hostileComment, true); assert.equal(g.hostileRow, true);
      assert.equal(g.assignOpen, true); assert.equal(g.firstActive, "hm-todo-t1-assigned-picker-agent-claude", "opens on the current assignee");
      assert.equal(g.firstActiveSelected, true); assert.equal(g.secondActive, "hm-todo-t1-assigned-picker-agent-dot");
      assert.equal(g.escapeClosed, true); assert.equal(g.escapeFocus, true, "Escape returns focus to the trigger");
      assert.deepEqual(g.assigned, ["dot"]); assert.equal(g.enterFocus, true);
      assert.equal(g.tagOpen, true); assert.deepEqual(g.tagLabels, ["Nikki’s Muse"]);
      assert.equal(g.tagFooter, "A tag here highlights the name. To ask them directly, write in chat.");
      assert.equal(g.tagText, "Thanks @Nikki’s Muse "); assert.equal(g.tagClosedAfterPick, true);
      assert.deepEqual(g.comments, [{ body: "Thanks @Nikki’s Muse", tags: ["muse"] }]);
      assert.equal(g.tagEscapeClosed, true);
      assert.equal(g.personChips, 0, "a person assignee has no start chips"); assert.equal(g.agentChips, 1);
      assert.ok(g.offStatus.includes("1st in line for your dot. dot is disconnected (key turned off), so nothing moves until it reconnects."));
      assert.equal(g.offWarning, true, "a disconnected assignee shows the fix as a warning notice");
      assert.equal(g.paneRows, 4);
      assert.equal(g.sampleRows, 3, "positive control: the sample pane rendered its rows");
      assert.equal(g.sampleTitle, true, "positive control: the sample to-do rendered");
      assert.deepEqual(g.sampleControls, [], `${where}: sample mode renders no actions and no doors`);
      assert.equal(g.missingTitle, "Nothing with this link in HR.");
      assert.ok(g.missingLink, `${where}: the not-found view links back to the workspace`);
      assert.equal(g.missingLink.text, "HR");
      assert.ok(g.missingLink.width >= 44 && g.missingLink.height >= 44, `${where}: a two-letter workspace link is still 44 by 44 px (${g.missingLink.width} by ${g.missingLink.height})`);
      assert.equal(g.loadingTitle, "Loading this to-do…"); assert.equal(g.loadingBusy, true);
      assert.equal(g.readonlyTitle, true, "positive control: the read-only to-do rendered");
      assert.equal(g.readonlyAssignee, "Your Claude", "positive control: the read-only assignee shows as text");
      assert.deepEqual(g.readonlyControls, [], `${where}: a to-do the viewer may only read has no controls beyond the back link`);
      assert.equal(g.unassignedStatus, "Not assigned yet.", `${where}: an open to-do with no assignee says so in its status area`);
      assert.equal(g.savingBusy, true, "positive control: the saving panel is marked busy");
      assert.equal(g.savingMore, "Claude picks up work from its line itself.", "positive control: the measured secondary line rendered");
      assert.equal(g.savingOpacity, 1, `${where}: saving never dims the panel text below its measured contrast`);
    }
    for (const width of [390, 1440]) assert.notEqual(colors.get(`${width}-dark`), colors.get(`${width}-light`), `${width}px: data-theme="dark" switched the palette`);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
