/**
 * Rename and Reconnect (Add an agent PR C, web).
 *
 * Runs the real code against a small fake DOM: the Add an agent panel's element class (its <script>,
 * transpiled, imports replaced by the real lib functions) for the joined card, and the real People &
 * agents builder (renderPeopleDialog, page layout) for agent rows. The rename command itself is a
 * stub whose answer each case holds and releases.
 *
 * Fake DOM limits, covered by the browser audit instead (app.people.rename): Enter submitting the form
 * is dispatched as the form's submit event, and Escape is dispatched on the form, where a real key
 * press in the field bubbles to. Layout, clipboard permission and focus rings need a browser.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { agentJoinedSentence, agentNameIsAppName, joinPrompt, joinedListsOffer, reconnectPrompt, takenAgentName } from "../../lib/agent-hosts";
import { buildAgentRenameField, RenameAttempts, type RenameOutcome } from "../../lib/agent-rename";
import { renderPeopleDialog, type PeopleDialogAgent, type PeopleDialogCallbacks, type PeopleDialogModel, type PeopleDialogState } from "../../lib/people-dialog-view";

// renderPeopleDialog checks `instanceof HTMLInputElement` when it restores focus.
Object.assign(globalThis, { HTMLInputElement: class { static [Symbol.hasInstance](value: unknown) { return (value as { tag?: string })?.tag === "input"; } } });

type Listener = (event: FakeEvent) => void;
interface FakeEvent { type: string; key?: string; defaultPrevented: boolean; stopped: boolean; preventDefault(): void; stopPropagation(): void }
const event = (type: string, init: { key?: string } = {}): FakeEvent => ({
  type, ...init, defaultPrevented: false, stopped: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
});

/* Tree, attributes, events and focus. Selectors: one compound of tag, #id, .class and [attr] or
   [attr="value"]; anything else (descendants, pseudo-classes) matches nothing, as in household-redesign. */
function fakeDom() {
  const roots: El[] = [];
  const doc: any = { activeElement: null as El | null, body: null };
  class El {
    children: El[] = []; parent: El | null = null; dataset: Record<string, string> = {}; attributes: Record<string, string> = {};
    className = ""; id = ""; hidden = false; disabled = false; readOnly = false; open = false; value = ""; type = ""; htmlFor = "";
    maxLength = -1; autocomplete = ""; spellcheck = true; noValidate = false; tabIndex = 0; title = ""; href = ""; selected = false;
    ownerDocument = doc; listeners = new Map<string, Listener[]>(); #text = "";
    classList = {
      add: (...names: string[]) => { this.className = [...new Set([...this.className.split(" ").filter(Boolean), ...names])].join(" "); },
      remove: (...names: string[]) => { this.className = this.className.split(" ").filter(name => !names.includes(name)).join(" "); },
      contains: (name: string) => this.className.split(" ").includes(name),
      toggle: (name: string, force?: boolean) => { const on = force ?? !this.classList.contains(name); if (on) this.classList.add(name); else this.classList.remove(name); return on; },
    };
    constructor(public tag: string) {}
    get textContent(): string { return this.children.length ? this.children.map(child => child.textContent).join("") : this.#text; }
    set textContent(value: string) { this.children = []; this.#text = String(value ?? ""); }
    get childElementCount() { return this.children.filter(child => child.tag !== "#text").length; }
    get isConnected(): boolean { let node: El | null = this; while (node.parent) node = node.parent; return roots.includes(node); }
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    hasAttribute(name: string) { return name in this.attributes; }
    removeAttribute(name: string) { delete this.attributes[name]; }
    toggleAttribute(name: string, force?: boolean) { if (force === false) delete this.attributes[name]; else this.attributes[name] = ""; return force !== false; }
    #adopt(nodes: El[]) { for (const node of nodes) { node.parent?.children.splice(node.parent.children.indexOf(node), 1); node.parent = this; } return nodes; }
    append(...nodes: El[]) { this.children.push(...this.#adopt(nodes)); }
    prepend(...nodes: El[]) { this.children.unshift(...this.#adopt(nodes)); }
    after(...nodes: El[]) { const parent = this.parent; if (!parent) return; const at = parent.children.indexOf(this); parent.#adopt(nodes); parent.children.splice(at + 1, 0, ...nodes); }
    insertBefore(node: El, ref: El | null) { this.#adopt([node]); const at = ref ? this.children.indexOf(ref) : -1; if (at < 0) this.children.push(node); else this.children.splice(at, 0, node); return node; }
    replaceChildren(...nodes: El[]) { for (const child of this.children) child.parent = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]); }
    dispatch(fired: FakeEvent) { for (const listener of this.listeners.get(fired.type) ?? []) listener(fired); return fired; }
    click() { if (!this.disabled) this.dispatch(event("click")); }
    focus() { doc.activeElement = this; }
    select() { this.selected = true; }
    setSelectionRange() {}
    scrollIntoView() {}
    showModal() { this.open = true; }
    getClientRects() { return [{}]; }
    getBoundingClientRect() { return { width: 10, height: 10 }; }
    closest() { return null; }
    contains(node: El | null) { return !!node && (this === node || this.descendants().includes(node)); }
    descendants(): El[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
    matches(selector: string): boolean {
      const parts = /^([a-z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]+\])*)$/i.exec(selector.trim());
      if (!parts) return false;
      const [, tag, id, classes, attrs] = parts;
      if (tag && this.tag !== tag) return false;
      if (id && this.id !== id.slice(1)) return false;
      for (const name of (classes ?? "").split(".").filter(Boolean)) if (!this.classList.contains(name)) return false;
      for (const [, name, , quoted] of (attrs ?? "").matchAll(/\[([\w-]+)(=(["']?)(.*?)\3)?\]/g).map(match => [match[0], match[1], match[2], match[4]] as const)) {
        const actual = name!.startsWith("data-")
          ? this.dataset[name!.slice(5).replace(/-([a-z])/g, (_m, letter: string) => letter.toUpperCase())]
          : name === "open" ? (this.open ? "" : undefined) : this.attributes[name!];
        if (actual === undefined) return false;
        if (quoted !== undefined && actual !== quoted) return false;
      }
      return true;
    }
    querySelectorAll(selector: string) { return this.descendants().filter(node => node.matches(selector)); }
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
  }
  doc.createElement = (tag: string) => new El(tag);
  doc.createElementNS = (_namespace: string, tag: string) => new El(tag);
  doc.createTextNode = (text: string) => Object.assign(new El("#text"), { textContent: text });
  doc.getElementById = (id: string) => roots.flatMap(root => [root, ...root.descendants()]).find(node => node.id === id) ?? null;
  doc.querySelector = (selector: string) => roots.flatMap(root => [root, ...root.descendants()]).find(node => node.matches(selector)) ?? null;
  doc.createRange = () => ({ selectNodeContents() {} });
  doc.getSelection = () => ({ removeAllRanges() {}, addRange() {} });
  const root = (tag: string) => { const element = new El(tag); roots.push(element); return element; };
  const el = (tag: string, data: Record<string, string> = {}, children: El[] = []) => {
    const element = new El(tag); Object.assign(element.dataset, data); element.append(...children); return element;
  };
  return { doc, El, root, roots, el };
}

/* ------------------------------------------------------------------------------------------------ */
/* The joined card in the Add an agent panel                                                         */
/* ------------------------------------------------------------------------------------------------ */

const PICKER = readFileSync(new URL("./AgentHostPicker.astro", import.meta.url), "utf8");
const PICKER_SCRIPT = (() => {
  const script = PICKER.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const file = ts.createSourceFile("picker.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const kept = file.statements.filter(statement => !ts.isImportDeclaration(statement)).map(statement => statement.getFullText(file));
  return ts.transpileModule(kept.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
})();

const TAKEN = "Another agent in this workspace already uses that name, ignoring case. Choose another.";

function picker() {
  const dom = fakeDom();
  let defined: any;
  const context = createContext({
    HTMLElement: dom.El, document: dom.doc,
    CustomEvent: class { type: string; detail: unknown; constructor(type: string, init?: { detail?: unknown }) { this.type = type; this.detail = init?.detail; } },
    customElements: { get: () => undefined, define: (_name: string, element: unknown) => { defined = element; } },
    window: { setTimeout: () => 0, clearTimeout() {}, getSelection: () => null },
    CSS: { escape: (value: string) => value },
    navigator: { clipboard: { writeText: async () => {} } },
    agentJoinedSentence, agentNameIsAppName, joinPrompt, joinedListsOffer, takenAgentName, buildAgentRenameField,
    addAgentStore: () => null, lastHost: () => "", rememberLastHost() {},
  });
  runInContext(PICKER_SCRIPT, context);
  assert.ok(defined, "the panel's element class is defined");
  const element = new defined();
  element.tag = "agent-host-picker";
  dom.roots.push(element);
  element.setAttribute("workspace-name", "Home");
  const { el } = dom;
  const title = el("h2", { ahpJoinedTitle: "" }, [el("span", { ahpJoinedName: "" }), el("span", { ahpJoinedRest: "" })]);
  const renameButton = el("button", { ahpRename: "" }); renameButton.hidden = true;
  element.append(
    el("div", { ahpView: "form" }),
    el("section", { ahpJoined: "" }, [title, el("div", { ahpRenameSlot: "" }), el("button", { ahpDone: "" }), el("button", { ahpApprove: "" }),
      el("button", { ahpAnother: "" }), renameButton, el("p", { ahpApproveStatus: "" })]),
  );
  element.connectedCallback();
  const sent: Array<[string, string]> = [];
  const answers: Array<(outcome: RenameOutcome) => void> = [];
  const q = (selector: string) => element.querySelector(selector);
  return {
    dom, element, sent, q,
    title: () => q("[data-ahp-joined-title]").textContent as string,
    name: () => q("[data-ahp-joined-name]"),
    renameButton: () => q("[data-ahp-rename]"),
    field: () => q("form[data-agent-rename]"),
    input: () => q("input[data-rename-input]"),
    error: () => q("p[data-rename-error]"),
    useServer: () => { element.renameAgent = (principalId: string, name: string) => { sent.push([principalId, name]); return new Promise<RenameOutcome>(resolve => answers.push(resolve)); }; },
    answer: async (outcome: RenameOutcome) => { answers.shift()!(outcome); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); },
    type: (value: string) => { const input = q("input[data-rename-input]"); input.value = value; input.dispatch(event("input")); },
    submit: () => q("form[data-agent-rename]").dispatch(event("submit")),
  };
}

test("joined card: an agent named after its app opens with Rename focused and asks for its own name", () => {
  for (const name of ["Claude", "codex", " Claude Code ", "ChatGPT"]) {
    const p = picker();
    p.useServer();
    p.element.showJoined({ name, principalId: "p1", canApprove: false, hosted: true });
    assert.ok(p.field(), `${name}: the rename field is open`);
    assert.equal(p.field().querySelector("label").textContent, "Give this session its own name");
    assert.ok(p.dom.doc.activeElement === p.input(), `${name}: focus is in the field`);
    assert.equal(p.input().value, name);
    assert.equal(p.input().selected, true, "the old name is selected, so typing replaces it");
    assert.equal(p.renameButton().hidden, true);
  }
  const own = picker();
  own.useServer();
  own.element.showJoined({ name: "RidgeHQ Lead", principalId: "p1", canApprove: false, hosted: true });
  assert.equal(own.field(), null, "a session with its own name opens on the sentence");
  assert.ok(own.dom.doc.activeElement === own.q("[data-ahp-joined-title]"));
  assert.equal(own.renameButton().hidden, false, "Rename is offered");
  assert.equal(own.title(), "RidgeHQ Lead joined Home.");
});

test("joined card: Rename saves, the title follows and focus moves to the new name", async () => {
  const p = picker();
  p.useServer();
  p.element.showJoined({ name: "Claude", principalId: "p1", canApprove: false, hosted: true });
  p.type("RidgeHQ Lead");
  p.submit();
  assert.deepEqual(p.sent, [["p1", "RidgeHQ Lead"]]);
  assert.equal(p.field().querySelector("button[data-rename-save]").disabled, true, "Save waits for the answer");
  p.submit();
  assert.equal(p.sent.length, 1, "a second Enter while waiting sends nothing");
  await p.answer({ ok: true });
  assert.equal(p.title(), "RidgeHQ Lead joined Home.");
  assert.equal(p.field(), null);
  assert.ok(p.dom.doc.activeElement === p.name(), "focus is on the new name");
  assert.equal(p.renameButton().hidden, false);
  // Saving the name it already has sends nothing and closes the field.
  p.renameButton().click();
  p.submit();
  assert.equal(p.sent.length, 1);
  assert.equal(p.field(), null);
});

test("joined card: a taken name shows the server's sentence and keeps the draft; Escape keeps the old name", async () => {
  const p = picker();
  p.useServer();
  p.element.showJoined({ name: "Scout", principalId: "p1", canApprove: true, hosted: false });
  p.renameButton().click();
  assert.equal(p.field().querySelector("label").textContent, "Name");
  assert.ok(p.dom.doc.activeElement === p.input());
  p.type("lead");
  p.submit();
  await p.answer({ ok: false, message: TAKEN });
  assert.equal(p.error().textContent, TAKEN);
  assert.equal(p.error().hidden, false);
  assert.equal(p.input().value, "lead", "the draft stays");
  assert.equal(p.input().getAttribute("aria-invalid"), "true");
  assert.ok(p.dom.doc.activeElement === p.input());
  assert.equal(p.title(), "Scout joined Home.");
  p.type("lead 2");
  assert.equal(p.error().hidden, true, "typing clears the refusal");
  const escape = p.field().dispatch(event("keydown", { key: "Escape" }));
  assert.equal(escape.defaultPrevented && escape.stopped, true, "Escape stays with the field, never closes an outer dialog");
  assert.equal(p.field(), null);
  assert.equal(p.title(), "Scout joined Home.");
  assert.ok(p.dom.doc.activeElement === p.renameButton());
  assert.equal(p.sent.length, 1);
  // Cancel does the same for touch.
  p.renameButton().click();
  p.field().querySelector("button[data-rename-cancel]").click();
  assert.equal(p.field(), null);
});

test("joined card: without a rename handler there is no Rename, and a late answer after Add another changes nothing", async () => {
  const bare = picker();
  bare.element.showJoined({ name: "Claude", principalId: "p1", canApprove: false, hosted: true });
  assert.equal(bare.field(), null);
  assert.equal(bare.renameButton().hidden, true);
  const p = picker();
  p.useServer();
  p.element.showJoined({ name: "Claude", principalId: "p1", canApprove: false, hosted: true });
  p.type("Planner");
  p.submit();
  p.q("[data-ahp-another]").click();
  await p.answer({ ok: true });
  assert.equal(p.field(), null);
  assert.equal(p.name().textContent, "Claude", "the card moved on; the answer does not write into it");
});

/* ------------------------------------------------------------------------------------------------ */
/* People & agents rows                                                                              */
/* ------------------------------------------------------------------------------------------------ */

const status = { kind: "active", label: "Active", attention: false, sentence: "", fix: { allowed: false, action: null } } as unknown as PeopleDialogAgent["status"];
const agent = (id: string, overrides: Partial<PeopleDialogAgent> = {}): PeopleDialogAgent => ({
  id, name: id, rawName: id, ownerId: "alex", ownerName: "Alex Rivera", model: null, app: null, hosted: false, status, receive: null,
  lastActive: "Not reported", technical: [], updateAvailable: false, access: null, accessReadState: "succeeded", key: null, liveKey: false,
  own: true, mayManage: true, receipt: "", ...overrides,
});

function people(agents: PeopleDialogAgent[], options: { sample?: boolean; rename?: boolean; renameWith?: (id: string, name: string, editor: number) => Promise<RenameOutcome> } = {}) {
  const dom = fakeDom();
  const root = dom.root("section"), detail = dom.root("section");
  const model: PeopleDialogModel = { people: [{ id: "alex", name: "Alex Rivera", role: "owner", own: true, mayRemove: false },
    { id: "sam", name: "Sam Lee", role: "member", own: false, mayRemove: true }], agents, invites: [], sample: options.sample === true, pendingFailed: false, workspaceName: "Home" };
  const state: PeopleDialogState = { selected: null, query: "" };
  const sent: Array<[string, string]> = [], actions: Array<[string, string]> = [];
  const answers: Array<(outcome: RenameOutcome) => void> = [];
  const callbacks: PeopleDialogCallbacks = {
    render: () => renderPeopleDialog(root as never, detail as never, model, state, callbacks, { page: { homeLabel: "Home", homeHref: "/app" } }),
    action: (action, id) => { actions.push([action, id]); }, saveModel: async () => {}, confirm: () => {},
    ...(options.rename === false ? {} : { rename: options.renameWith ?? ((id: string, name: string) => { sent.push([id, name]); return new Promise<RenameOutcome>(resolve => answers.push(resolve)); }) }),
  };
  callbacks.render();
  const row = (id: string) => root.querySelector(`li[data-agent-row="${id}"]`);
  const control = (key: string): any => root.querySelectorAll("[data-pd-focus]").find((node: any) => node.dataset.pdFocus === key) ?? null;
  return {
    dom, root, model, state, sent, actions, row, control, render: callbacks.render,
    field: (id: string) => row(id)?.querySelector("form[data-agent-rename]") ?? null,
    input: (id: string) => row(id)?.querySelector("input[data-rename-input]") ?? null,
    answer: async (outcome: RenameOutcome) => { answers.shift()!(outcome); for (let turn = 0; turn < 5; turn++) await new Promise(resolve => setImmediate(resolve)); },
  };
}

test("People rows: Rename shows only where the viewer may rename, and never in a sample", () => {
  const p = people([agent("Scout"), agent("Dot", { ownerId: "sam", ownerName: "Sam Lee", own: false, mayManage: true }),
    agent("Muse", { ownerId: "sam", ownerName: "Sam Lee", own: false, mayManage: false })]);
  assert.ok(p.control("rename-Scout"), "the agent's owner may rename it");
  assert.ok(p.control("rename-Dot"), "a workspace owner or admin may rename another person's agent");
  assert.equal(p.control("rename-Muse"), null, "a member may not rename another person's agent");
  assert.equal(people([agent("Scout")], { sample: true }).control("rename-Scout"), null, "never in a sample");
  assert.equal(people([agent("Scout")], { rename: false }).control("rename-Scout"), null, "no rename callback, no control");
});

test("People rows: Rename opens with the agent's own name, saves, and focus moves to the renamed row", async () => {
  const p = people([agent("Scout", { name: "Scout · 1a2b3c4d", rawName: "Scout" })]);
  p.control("rename-Scout").click();
  assert.equal(p.input("Scout").value, "Scout", "the field holds the name, not the label with its id suffix");
  assert.ok(p.dom.doc.activeElement === p.input("Scout"));
  p.input("Scout").value = "Planner";
  p.input("Scout").dispatch(event("input"));
  p.field("Scout").dispatch(event("submit"));
  assert.deepEqual(p.sent, [["Scout", "Planner"]]);
  assert.equal(p.field("Scout").querySelector("button[data-rename-save]").disabled, true);
  assert.ok(p.dom.doc.activeElement === p.input("Scout"), "a re-render while waiting keeps focus in the field");
  p.model.agents[0] = { ...p.model.agents[0]!, name: "Planner", rawName: "Planner" }; // the page applies the accepted name
  await p.answer({ ok: true });
  assert.equal(p.field("Scout"), null);
  assert.ok(p.dom.doc.activeElement === p.dom.doc.getElementById("pd-agent-Scout"));
  assert.match(p.dom.doc.activeElement.textContent, /Planner/, "focus is on the row that now carries the new name");
});

test("People rows: a taken name keeps the draft across re-renders with the server's sentence; Escape cancels", async () => {
  const p = people([agent("Scout"), agent("Lead")]);
  p.control("rename-Scout").click();
  p.input("Scout").value = "lead";
  p.input("Scout").dispatch(event("input"));
  p.field("Scout").dispatch(event("submit"));
  await p.answer({ ok: false, message: TAKEN });
  assert.equal(p.row("Scout").querySelector("p[data-rename-error]").textContent, TAKEN);
  assert.equal(p.input("Scout").value, "lead");
  assert.ok(p.dom.doc.activeElement === p.input("Scout"));
  p.input("Scout").value = "lead two";
  p.input("Scout").dispatch(event("input"));
  p.model.agents.push(agent("Orbit")); // a roster refresh repaints the page
  p.render();
  assert.equal(p.input("Scout").value, "lead two", "the draft survives a refresh");
  const escape = p.field("Scout").dispatch(event("keydown", { key: "Escape" }));
  assert.equal(escape.defaultPrevented && escape.stopped, true, "Escape closes the field, not the People dialog");
  assert.equal(p.field("Scout"), null);
  assert.ok(p.dom.doc.activeElement === p.dom.doc.getElementById("pd-agent-Scout"));
  assert.equal(p.sent.length, 1);
});

// Designer P2 on #479: an answer belongs to the field that sent it, not to whichever field the agent has now.
test("People rows: after Cancel and Rename again, the earlier attempt's late answer leaves the new field alone", async () => {
  for (const late of [{ ok: false, message: "Refusal from old attempt" }, { ok: true }] as RenameOutcome[]) {
    const p = people([agent("Scout")]);
    const type = (value: string) => { p.input("Scout").value = value; p.input("Scout").dispatch(event("input")); };
    p.control("rename-Scout").click();
    type("Old attempt");
    p.field("Scout").dispatch(event("submit"));
    assert.deepEqual(p.sent, [["Scout", "Old attempt"]]);
    p.field("Scout").querySelector("button[data-rename-cancel]").click(); // the answer is still out
    p.control("rename-Scout").click();
    type("New draft");
    await p.answer(late);
    assert.equal(p.input("Scout")?.value, "New draft", `${late.ok ? "accepted" : "refused"}: the new draft stays`);
    assert.equal(p.row("Scout").querySelector("p[data-rename-error]").hidden, true, "no refusal from the earlier attempt");
    assert.equal(p.field("Scout").querySelector("button[data-rename-save]").disabled, false, "the new field is not waiting");
    assert.ok(p.dom.doc.activeElement === p.input("Scout"), "focus stays in the new field");
    // The new field's own save still works and is answered on its own.
    p.field("Scout").dispatch(event("submit"));
    assert.deepEqual(p.sent.at(-1), ["Scout", "New draft"]);
    await p.answer({ ok: false, message: TAKEN });
    assert.equal(p.row("Scout").querySelector("p[data-rename-error]").textContent, TAKEN);
    assert.equal(p.input("Scout").value, "New draft");
  }
});

test("People rows: Reconnect gives a hosted agent its sentence, a local agent a new setup prompt, and others nothing", async () => {
  const written: string[] = [];
  Object.defineProperty(globalThis.navigator, "clipboard", { value: { writeText: async (text: string) => { written.push(text); } }, configurable: true });
  try {
    const p = people([agent("Lead", { hosted: true }), agent("Scout"), agent("Dot", { ownerId: "sam", ownerName: "Sam Lee", own: false, mayManage: true }),
      agent("Wren", { status: { ...status, attention: true, kind: "key-off", label: "Key off", sentence: "Its key is off.", fix: { allowed: true, action: "new-key" } } as never })]);
    assert.equal(p.control("reconnect-Dot"), null, "another person's agent is reconnected by its owner, not here");
    assert.equal(p.control("reconnect-Wren"), null, "a row whose repair is already Get a new key does not repeat it");
    assert.ok(p.control("new-key-Wren"), "that repair is still there");
    p.control("reconnect-Lead").click();
    const sentence = p.row("Lead").querySelector("div[data-reconnect-sentence]");
    assert.ok(sentence);
    const expected = reconnectPrompt({ workspace: "Home", name: "Lead" });
    assert.equal(expected, "Reconnect to my \"Home\" workspace on CommonSwarm as \"Lead\". Reuse that agent; don't make a new one.");
    assert.equal(sentence.querySelector("p").textContent, expected);
    assert.ok(p.dom.doc.activeElement === p.control("reconnect-copy-Lead"), "focus lands on Copy");
    p.control("reconnect-copy-Lead").click();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(written, [expected]);
    assert.equal(p.control("reconnect-copy-Lead").textContent, "Copied");
    assert.deepEqual(p.actions, [], "a hosted reconnect sends nothing: the agent reconnects from its own app");
    p.control("reconnect-close-Lead").click();
    assert.equal(p.row("Lead").querySelector("div[data-reconnect-sentence]"), null);
    p.control("reconnect-Scout").click();
    assert.deepEqual(p.actions, [["new-key", "Scout"]], "a local agent gets a new setup prompt for the same identity");
    assert.equal(people([agent("Lead", { hosted: true })], { sample: true }).control("reconnect-Lead"), null, "never in a sample");
  } finally {
    Reflect.deleteProperty(globalThis.navigator, "clipboard");
  }
});

/* ------------------------------------------------------------------------------------------------ */
/* One command id per attempt                                                                        */
/* ------------------------------------------------------------------------------------------------ */

test("rename command ids: fresh per attempt, the same only to retry an unanswered one", () => {
  let next = 0;
  const fresh = () => `id-${++next}`;
  const attempts = new RenameAttempts();
  const first = attempts.commandId("alex:W:p1", "Lead", fresh);
  assert.equal(attempts.commandId("alex:W:p1", "Lead", fresh), first, "no answer yet: Save again replays the same command");
  assert.notEqual(attempts.commandId("alex:W:p1", "Planner", fresh), first, "an edited name is a new attempt");
  attempts.settle("alex:W:p1");
  assert.equal(attempts.commandId("alex:W:p1", "Planner", fresh), "id-3", "after an answer, the same name is a new attempt");
  assert.equal(attempts.commandId("alex:W:p2", "Planner", fresh), "id-4", "another agent never shares an id");
});

/* ------------------------------------------------------------------------------------------------ */
/* The dashboard's own People rename callback and reload                                             */
/* ------------------------------------------------------------------------------------------------ */

/* Designer P2 on #479 R2: an accepted answer from a cancelled field refreshes the page through the
   dashboard's real callback and reloadPeopleDialog, which used to focus the row now and in the next
   frame, pulling focus out of a newer field. Only the field that sent the rename may move focus. */
const DASHBOARD_PEOPLE = (() => {
  const raw = readFileSync(new URL("../app/LiveDashboard.astro", import.meta.url), "utf8");
  const script = raw.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const ast = ts.createSourceFile("dashboard.ts", script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const parts: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ["reloadPeopleDialog", "peopleDialogFocusTarget"].includes(node.name.text)) {
      parts.push(`const ${node.getText(ast)};`);
    }
    // The People page's rename callback is a property of renderDialogRoster's callbacks object.
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "rename" && node.initializer.getText(ast).includes("renameAgentHere")) {
      parts.push(`const renameCallback = ${node.initializer.getText(ast)};`);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.equal(parts.length, 3, "the reload, its focus target and the rename callback");
  return ts.transpileModule(parts.join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
})();

function dashboardPeople() {
  const frames: Array<() => void> = [];
  const replies: Array<(outcome: RenameOutcome) => void> = [];
  let context: ReturnType<typeof createContext>;
  const p = people([agent("Scout")], {
    renameWith: (id, name, editor) => runInContext(`renameCallback(${JSON.stringify(id)}, ${JSON.stringify(name)}, ${editor})`, context) as Promise<RenameOutcome>,
  });
  context = createContext({
    peopleDialogState: p.state, peopleDialogCanAct: (_model: unknown, action: string) => action === "rename",
    peopleDialogModel: () => p.model, peopleDialogReceipts: new Map(), document: p.dom.doc,
    renameAgentHere: () => new Promise<RenameOutcome>(resolve => replies.push(resolve)),
    openWorkspace: async () => undefined, peopleDialogOpen: () => true, renderDialogRoster: () => p.render(),
    one: (selector: string) => p.dom.doc.querySelector(selector),
    window: { requestAnimationFrame: (fn: () => void) => { frames.push(fn); return 1; } },
  });
  runInContext(`let activeWorkspaceId = "W", session = { user: { id: "alex" } }, rosterFilter = "";`, context);
  runInContext(DASHBOARD_PEOPLE, context);
  const settle = async () => { for (let turn = 0; turn < 8; turn++) await new Promise(resolve => setImmediate(resolve)); };
  const type = (value: string) => { p.input("Scout").value = value; p.input("Scout").dispatch(event("input")); };
  return { p, frames, replies, settle, type };
}

test("People rename through the dashboard: a cancelled field's accepted answer never takes focus from a newer field", async () => {
  const d = dashboardPeople();
  d.p.control("rename-Scout").click();
  d.type("Old attempt");
  d.p.field("Scout").dispatch(event("submit"));
  d.p.field("Scout").querySelector("button[data-rename-cancel]").click();
  d.p.control("rename-Scout").click();
  d.type("New draft");
  assert.ok(d.p.dom.doc.activeElement === d.p.input("Scout"));
  d.replies.shift()!({ ok: true }); // the cancelled attempt's rename was accepted after all
  await d.settle();
  assert.ok(d.p.dom.doc.activeElement === d.p.input("Scout"), "the reload leaves focus in the newer field");
  while (d.frames.length) d.frames.shift()!();
  assert.ok(d.p.dom.doc.activeElement === d.p.input("Scout"), "and so does its next frame");
  assert.equal(d.p.input("Scout").value, "New draft");
  assert.equal(d.p.field("Scout").querySelector("button[data-rename-save]").disabled, false);
  // Control: the field that sent the rename, still open, ends on the renamed row.
  d.p.field("Scout").dispatch(event("submit"));
  d.replies.shift()!({ ok: true });
  await d.settle();
  while (d.frames.length) d.frames.shift()!();
  assert.equal(d.p.field("Scout"), null);
  assert.ok(d.p.dom.doc.activeElement === d.p.dom.doc.getElementById("pd-agent-Scout"), "the sender's own success moves focus to the row");
});
