import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildChoiceCard, type ChoiceCardVM } from "../../lib/choice-card";
import { parseAskChoices, type AskChoiceState, type ChoiceDraft, type ChoiceSubmission } from "../../lib/choices";
import { needsYouCard, NEEDS_YOU_CHOICE_ACTION } from "../../lib/home-primitives";
import { signalHasEnded } from "../../lib/signal-history";
import type { NeedsYouVM } from "../../lib/home-types";

/* The decision card (lib/choice-card.ts) and the feed's use of it (LiveDashboard appendChoices), run against a small
   fake DOM: no browser. Layout, focus rings and the caret across a real feed rebuild need the browser captures. */

type Listener = (event: FakeEvent) => void;
type FakeEvent = { type: string; key?: string; defaultPrevented: boolean; preventDefault(): void; stopPropagation(): void };
class FakeElement {
  tagName: string; children: Array<FakeElement | string> = []; parentElement: FakeElement | null = null;
  className = ""; dataset: Record<string, string> = {}; attrs = new Map<string, string>(); listeners = new Map<string, Listener[]>();
  id = ""; type = ""; disabled = false; checked = false; value = ""; hidden = false; readOnly = false; tabIndex = 0;
  [key: string]: unknown;
  private ownText = "";
  constructor(tag: string, readonly doc: FakeDocument) { this.tagName = tag.toUpperCase(); }
  get textContent(): string { return this.ownText + this.children.map(child => typeof child === "string" ? child : child.textContent).join(""); }
  set textContent(text: string) { this.ownText = text; this.children = []; }
  set innerHTML(_: string) { throw new Error("innerHTML used"); }
  append(...nodes: Array<FakeElement | string>) { for (const n of nodes) { if (typeof n !== "string") { n.remove(); n.parentElement = this; } this.children.push(n); } }
  prepend(...nodes: Array<FakeElement | string>) { for (const n of [...nodes].reverse()) { if (typeof n !== "string") { n.remove(); n.parentElement = this; } this.children.unshift(n); } }
  remove() { if (this.parentElement) { const p = this.parentElement; p.children = p.children.filter(child => child !== this); this.parentElement = null; } }
  replaceWith(other: FakeElement) { const p = this.parentElement!; const index = p.children.indexOf(this); other.remove(); p.children[index] = other; other.parentElement = p; this.parentElement = null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  addEventListener(type: string, fn: Listener) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  fire(type: string, init: { key?: string } = {}): FakeEvent {
    const event: FakeEvent = { type, ...init, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
    for (const fn of this.listeners.get(type) ?? []) fn(event);
    return event;
  }
  focus() { this.doc.activeElement = this; }
  /** Every descendant element, depth first. */
  all(): FakeElement[] { return this.children.flatMap(child => typeof child === "string" ? [] : [child, ...child.all()]); }
  find(match: (el: FakeElement) => boolean): FakeElement[] { return this.all().filter(match); }
  one(match: (el: FakeElement) => boolean): FakeElement { const found = this.find(match); assert.ok(found[0], "element"); return found[0]!; }
}
class FakeDocument {
  activeElement: FakeElement | null = null;
  createElement(tag: string) { return new FakeElement(tag, this); }
  createElementNS(_ns: string, tag: string) { return new FakeElement(tag, this); }
}
const has = (cls: string) => (el: FakeElement) => el.className.split(" ").includes(cls);
const asDoc = (doc: FakeDocument) => doc as unknown as Document;
const asEl = (el: HTMLElement) => el as unknown as FakeElement;

const SIGNAL = "44444444-4444-4444-8444-444444444444";
const OPTIONS = [
  { id: "ship", label: "<img src=x onerror=alert(1)> Ship it", description: "Today, before the visit" },
  { id: "wait", label: "Wait for tomorrow" },
  { id: "skip", label: "Skip it", recommended: true },
];
const state = (extra: Partial<AskChoiceState> = {}): AskChoiceState => ({ signalId: SIGNAL, multi: false, options: OPTIONS, answer: null, ...extra });
function card(vm: Partial<ChoiceCardVM> & { state: AskChoiceState }) {
  const doc = new FakeDocument(); const submits: ChoiceSubmission[] = []; const drafts: ChoiceDraft[] = [];
  const root = asEl(buildChoiceCard(asDoc(doc), { interactive: true, ended: false, ...vm },
    { submit: s => submits.push(s), draft: d => drafts.push(d) }));
  return { doc, root, submits, drafts };
}

test("an open single-choice card: recommended first, descriptions as a second line, a tap answers", () => {
  const { root, submits } = card({ state: state() });
  assert.equal(root.tagName, "FORM");
  assert.equal(root.dataset.decisionState, "open");
  const buttons = root.find(el => el.tagName === "BUTTON" && el.dataset.decisionOption !== undefined);
  assert.deepEqual(buttons.map(b => b.dataset.decisionOption), ["skip", "ship", "wait"], "recommended first, the rest in order");
  assert.equal(buttons[0]!.one(has("hm-decision__tag")).textContent, "Recommended");
  assert.equal(buttons[1]!.one(has("hm-decision__label")).textContent, OPTIONS[0]!.label, "labels are text");
  assert.equal(buttons[1]!.one(has("hm-decision__description")).textContent, "Today, before the visit");
  assert.ok(buttons.every(b => b.type === "button" && b.className === "hm-decision__option"));
  buttons[2]!.fire("click");
  assert.deepEqual(submits, [{ optionIds: ["wait"], otherText: null }]);
  // Other is the last row of the same stack, and never an input inside a button.
  const list = root.one(has("hm-decision__options"));
  const last = list.children.at(-1) as FakeElement;
  assert.ok(last.dataset.decisionOther !== undefined);
  for (const control of root.find(el => el.tagName === "BUTTON")) assert.equal(control.find(el => el.tagName === "INPUT" || el.tagName === "BUTTON").length, 0);
});

test("Other expands to a labelled field, Enter or Submit sends its text, and Escape on an empty field collapses back to Other", () => {
  const { doc, root, submits, drafts } = card({ state: state() });
  const trigger = root.one(el => el.dataset.decisionOtherTrigger !== undefined);
  const field = root.one(has("hm-decision__other-field"));
  const input = root.one(el => el.dataset.decisionOtherInput !== undefined);
  const submit = root.one(el => el.dataset.decisionSubmit !== undefined);
  assert.equal(trigger.textContent, "Other…");
  assert.deepEqual([trigger.getAttribute("aria-expanded"), trigger.getAttribute("aria-controls"), field.hidden], ["false", field.id, true]);
  assert.equal(input.getAttribute("aria-label"), "Other answer");
  trigger.fire("click");
  assert.deepEqual([trigger.getAttribute("aria-expanded"), field.hidden, doc.activeElement === input], ["true", false, true]);
  assert.equal(submit.disabled, true, "nothing to send yet");
  root.fire("submit");
  assert.equal(submits.length, 0);
  input.value = "  Next week  "; input.fire("input");
  assert.equal(submit.disabled, false);
  assert.equal(drafts.at(-1)!.otherText, "  Next week  ");
  assert.equal(input.fire("keydown", { key: "Escape" }).defaultPrevented, false, "Escape keeps typed text");
  assert.equal(root.fire("submit").defaultPrevented, true);
  assert.deepEqual(submits, [{ optionIds: [], otherText: "Next week" }]);
  input.value = ""; input.fire("input");
  assert.equal(input.fire("keydown", { key: "Escape" }).defaultPrevented, true);
  assert.deepEqual([field.hidden, trigger.getAttribute("aria-expanded"), doc.activeElement === trigger], [true, "false", true]);
});

test("a multi-select card builds a draft with native checkboxes and sends it once with one Submit", () => {
  const { doc, root, submits } = card({ state: state({ multi: true }) });
  assert.equal(root.dataset.decisionMode, "multi");
  const boxes = root.find(el => el.tagName === "INPUT" && el.type === "checkbox" && el.dataset.decisionOption !== undefined);
  assert.deepEqual(boxes.map(b => b.dataset.decisionOption), ["skip", "ship", "wait"]);
  assert.ok(boxes.every(b => b.parentElement!.tagName === "LABEL"), "each checkbox is labelled by its row");
  const submits_ = root.find(el => el.dataset.decisionSubmit !== undefined);
  assert.equal(submits_.length, 1, "one Submit for the card");
  const submit = submits_[0]!;
  assert.equal(submit.parentElement, root);
  assert.equal(submit.disabled, true);
  boxes[1]!.checked = true; boxes[1]!.fire("change");
  boxes[0]!.checked = true; boxes[0]!.fire("change");
  assert.equal(submit.disabled, false);
  assert.equal(submits.length, 0, "ticking never sends");
  const other = root.one(el => el.dataset.decisionOtherTrigger !== undefined);
  assert.equal(other.type, "checkbox");
  other.checked = true; other.fire("change");
  const input = root.one(el => el.dataset.decisionOtherInput !== undefined);
  assert.equal(doc.activeElement, input);
  input.value = "and the flue test"; input.fire("input");
  root.fire("submit");
  assert.deepEqual(submits, [{ optionIds: ["ship", "skip"], otherText: "and the flue test" }]);
  boxes[0]!.checked = false; boxes[0]!.fire("change"); boxes[1]!.checked = false; boxes[1]!.fire("change");
  input.value = ""; input.fire("input");
  assert.equal(submit.disabled, true, "Other ticked but empty, nothing else: nothing to send");
});

test("a rebuild puts the draft back; pending blocks every path but keeps focus targets; a refusal shows beside the card", () => {
  const draft = { selected: ["wait"], otherOpen: true, otherText: "maybe" };
  const again = card({ state: state({ multi: true }), draft });
  const boxes = again.root.find(el => el.tagName === "INPUT" && el.type === "checkbox");
  assert.deepEqual(boxes.map(b => [b.dataset.decisionOption ?? "other", b.checked]), [["skip", false], ["ship", false], ["wait", true], ["other", true]]);
  assert.equal(again.root.one(el => el.dataset.decisionOtherInput !== undefined).value, "maybe");
  assert.equal(again.root.one(has("hm-decision__other-field")).hidden, false);

  const pending = card({ state: state(), pending: true, draft: { selected: [], otherOpen: true, otherText: "soon" } });
  assert.equal(pending.root.dataset.decisionState, "pending");
  assert.equal(pending.root.getAttribute("aria-busy"), "true");
  for (const control of pending.root.find(el => el.tagName === "BUTTON")) {
    assert.equal(control.getAttribute("aria-disabled"), "true"); assert.equal(control.disabled, false, "still focusable");
    control.fire("click");
  }
  pending.root.fire("submit");
  assert.equal(pending.submits.length, 0, "a pending ask takes no second answer");
  assert.equal(pending.root.one(el => el.dataset.decisionOtherInput !== undefined).readOnly, true);
  assert.equal(pending.root.one(el => el.getAttribute("role") === "status").textContent, "Sending…");
  const multiPending = card({ state: state({ multi: true }), pending: true });
  assert.equal(multiPending.root.find(el => el.tagName === "INPUT" && el.type === "checkbox")[0]!.fire("click").defaultPrevented, true);

  const refused = card({ state: state(), error: "This kind of answer can't be sent here yet. Pick one of the options instead.", draft: { selected: [], otherOpen: true, otherText: "x" } });
  const alert = refused.root.one(el => el.getAttribute("role") === "alert");
  assert.equal(alert.textContent, "This kind of answer can't be sent here yet. Pick one of the options instead.");
  assert.equal(refused.root.one(el => el.dataset.decisionOtherInput !== undefined).value, "x", "the draft stays for a retry");
});

test("an answered card keeps every row, read-only, marks what was chosen, and names who and when", () => {
  const [parsed] = parseAskChoices({ asks: [{ signal_id: SIGNAL, multi: true, options: OPTIONS,
    answer: { option_id: "ship", option_ids: ["ship", "wait"], other_text: "and lunch", by_viewer: true, at: "2026-11-16T10:00:00Z" } }] })!;
  const { root } = card({ state: parsed!, chooser: "you", answeredAt: { text: "10:00 AM", iso: "2026-11-16T10:00:00Z" } });
  assert.equal(root.tagName, "DIV");
  assert.equal(root.dataset.decisionState, "answered");
  assert.equal(root.find(el => ["BUTTON", "INPUT", "LABEL"].includes(el.tagName)).length, 0, "no controls");
  const items = root.find(el => el.tagName === "LI");
  assert.deepEqual(items.map(li => [li.dataset.decisionOption ?? "other", li.dataset.chosen]),
    [["skip", "false"], ["ship", "true"], ["wait", "true"], ["other", "true"]], "every offered row stays, Other shows its text");
  assert.equal(items[1]!.one(has("hm-decision__mark")).textContent, "✓");
  assert.equal(items[1]!.one(has("hm-sr-only")).textContent, ", chosen", "chosen is said in words too");
  assert.equal(items[1]!.one(has("hm-decision__description")).textContent, "Today, before the visit");
  assert.equal(items[3]!.one(has("hm-decision__description")).textContent, "and lunch");
  const foot = root.one(has("hm-decision__foot"));
  assert.equal(foot.textContent, "Chosen by you · 10:00 AM");
  assert.equal(foot.one(el => el.tagName === "TIME").dateTime, "2026-11-16T10:00:00Z");

  const amys = state({ answer: { optionId: "wait", optionIds: ["wait"], otherText: null, byViewer: false, actorUserId: null, at: null } });
  const theirs = card({ state: amys, chooser: "Amy" });
  assert.equal(theirs.root.one(has("hm-decision__foot")).textContent, "Chosen by Amy", "no time until the server gives one");
  // An answer wins over expiry and over being someone else's card.
  assert.equal(card({ state: amys, ended: true, interactive: false }).root.dataset.decisionState, "answered");
});

test("expired, answered in words and not-yours cards are read-only with every row", () => {
  const expired = card({ state: state(), ended: true });
  assert.equal(expired.root.dataset.decisionState, "expired");
  assert.equal(expired.root.one(has("hm-decision__foot")).textContent, "Expired · Not answered");
  assert.deepEqual(expired.root.find(el => el.tagName === "LI").map(li => li.dataset.chosen), ["false", "false", "false"]);
  const replied = card({ state: state(), repliedInWords: true });
  assert.equal(replied.root.one(has("hm-decision__foot")).textContent, "Answered");
  const notYours = card({ state: state(), interactive: false });
  assert.equal(notYours.root.dataset.decisionState, "readonly");
  assert.equal(notYours.root.find(has("hm-decision__foot")).length, 0);
  assert.deepEqual(notYours.root.find(el => el.tagName === "LI").map(li => li.dataset.decisionOption), ["skip", "ship", "wait"]);
  assert.equal(notYours.root.find(el => ["BUTTON", "INPUT"].includes(el.tagName)).length, 0);
});

test("Waiting on you shows the same card, with Other in place of Reply, and sends through the card", () => {
  const doc = new FakeDocument();
  const n: NeedsYouVM = { id: SIGNAL, kind: "ask", workspace: { id: "W", name: "Home", href: "/app?w=W" },
    from: { id: "amy", name: "Amy", firstName: "Amy", initials: "A", you: false, role: "member" }, what: "Amy asked you: ‘Ship?’", when: "1 hour ago",
    primary: { label: "Reply", href: "/app?w=W&m=x" }, choices: { options: OPTIONS, multi: false } };
  const answers: Array<[ChoiceSubmission, string]> = []; const actions: string[] = [];
  const root = asEl(needsYouCard(asDoc(doc), n, action => actions.push(action), { submit: (s, item) => answers.push([s, item.id]) }));
  const decision = root.one(has("hm-decision"));
  assert.equal(root.find(has("hm-actions")).length, 0, "no separate Reply");
  assert.ok(decision.find(el => el.dataset.decisionOtherTrigger !== undefined).length === 1);
  decision.find(el => el.tagName === "BUTTON" && el.dataset.decisionOption === "ship")[0]!.fire("click");
  assert.deepEqual(answers, [[{ optionIds: ["ship"], otherText: null }, SIGNAL]]);
  // Without card handlers a single fixed answer still reaches the old action.
  const legacy = asEl(needsYouCard(asDoc(doc), n, action => actions.push(action)));
  legacy.find(el => el.tagName === "BUTTON" && el.dataset.decisionOption === "wait")[0]!.fire("click");
  assert.deepEqual(actions, [`${NEEDS_YOU_CHOICE_ACTION}wait`]);
  const sample = asEl(needsYouCard(asDoc(doc), { ...n, sample: true } as NeedsYouVM, () => {}));
  assert.equal(sample.find(has("hm-decision")).length, 0, "samples get no card");
});

// The feed: appendChoices lifted from the dashboard, run with the real card builder.
const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
const file = ts.createSourceFile("dashboard.ts", dashboard.match(/<script>([\s\S]*?)<\/script>/u)![1]!, ts.ScriptTarget.Latest, true);
function lift(names: string[]): string {
  const found = new Map<string, ts.VariableDeclaration>();
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(file)) && !found.has(node.name.getText(file))) found.set(node.name.getText(file), node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of names) assert.ok(found.get(name), name);
  return ts.transpile(names.map(name => `var ${found.get(name)!.getText(file)};`).join("\n"), { target: ts.ScriptTarget.ES2022 });
}
function feed(viewer = "zoe") {
  const doc = new FakeDocument(); const sent: Array<[string, ChoiceSubmission]> = [];
  const context: Record<string, unknown> = {
    document: doc, Date, Intl, session: { user: { id: viewer } }, activeWorkspaceId: "W", sampleMode: false,
    choiceRows: new Map<string, AskChoiceState>(), choiceErrors: new Map(), choiceDrafts: new Map(), choiceIsPending: () => false,
    buildChoiceCard, signalHasEnded, entityName: (entity: { id: string }) => ({ amy: "Amy", zoe: "Zoe" } as Record<string, string>)[entity.id] ?? "Someone",
    sendChoice: (id: string, submission: ChoiceSubmission) => sent.push([id, submission]),
  };
  runInNewContext(lift(["choiceDraftKey", "choiceViewerMayAnswer", "choiceChooserName", "choiceAnsweredAt", "appendChoices"]), context);
  const row = (signal: Record<string, unknown>, replied = false) => {
    const body = doc.createElement("div"); const question = doc.createElement("div"); question.className = "dashboard__message-markdown";
    question.textContent = "Which quote?"; body.append(question);
    (context.appendChoices as (...args: unknown[]) => void)(body, { id: SIGNAL, kind: "ask", from: "agent-1", fromKind: "agent", to: viewer, toAgent: null,
      until: "2999-01-01T00:00:00Z", createdAt: "2026-11-16T09:00:00Z", ...signal }, question, replied);
    return body;
  };
  return { doc, context, sent, row };
}

test("in the feed the question moves into the card, and only the person it asks (or anyone on a channel ask) can answer", () => {
  const f = feed();
  (f.context.choiceRows as Map<string, AskChoiceState>).set(SIGNAL, state());
  const body = f.row({});
  const decision = body.children[0] as FakeElement;
  assert.ok(has("hm-decision")(decision), "the card takes the question's place");
  assert.equal((decision.children[0] as FakeElement).className, "dashboard__message-markdown", "the question is the card's first line");
  assert.equal(decision.dataset.decisionState, "open");
  decision.find(el => el.tagName === "BUTTON" && el.dataset.decisionOption === "wait")[0]!.fire("click");
  assert.deepEqual(f.sent, [[SIGNAL, { optionIds: ["wait"], otherText: null }]]);

  const readonly = (signal: Record<string, unknown>) => (f.row(signal).children[0] as FakeElement).dataset.decisionState;
  assert.equal(readonly({ to: "amy" }), "readonly", "someone else's ask");
  assert.equal(readonly({ to: null, from: "zoe", fromKind: "user" }), "readonly", "the viewer's own ask");
  assert.equal(readonly({ to: null, toAgent: "agent-2" }), "readonly", "an ask to an agent");
  assert.equal(readonly({ to: null, toAgent: null }), "open", "a channel ask, for any person reading it");
  assert.equal(readonly({ until: "2000-01-01T00:00:00Z" }), "expired");
  assert.equal((f.row({}, true).children[0] as FakeElement).dataset.decisionState, "replied");

  const plain = feed(); const plainBody = plain.row({});
  assert.equal((plainBody.children[0] as FakeElement).className, "dashboard__message-markdown", "no stored choices, no card");
});

test("in the feed a draft survives a rebuild, and the answer names its chooser from the server", () => {
  const f = feed();
  const rows_ = f.context.choiceRows as Map<string, AskChoiceState>;
  rows_.set(SIGNAL, state({ multi: true }));
  const first = f.row({}).children[0] as FakeElement;
  const box = first.find(el => el.tagName === "INPUT" && el.dataset.decisionOption === "wait")[0]!;
  box.checked = true; box.fire("change");
  const rebuilt = f.row({}).children[0] as FakeElement;
  assert.equal(rebuilt.find(el => el.tagName === "INPUT" && el.dataset.decisionOption === "wait")[0]!.checked, true);

  rows_.set(SIGNAL, state({ answer: { optionId: "wait", optionIds: ["wait"], otherText: null, byViewer: false, actorUserId: "amy", at: "2026-11-16T10:00:00Z" } }));
  const answered = f.row({ to: null }).children[0] as FakeElement;
  assert.match(answered.one(has("hm-decision__foot")).textContent, /^Chosen by Amy · /u);
  rows_.set(SIGNAL, state({ answer: { optionId: "wait", optionIds: ["wait"], otherText: null, byViewer: false, actorUserId: null, at: null } }));
  assert.equal((f.row({ to: "amy" }).children[0] as FakeElement).one(has("hm-decision__foot")).textContent, "Chosen by Amy", "a v1 answer is its addressee's");
  assert.equal((f.row({}).children[0] as FakeElement).tabIndex, -1, "an answered card can hold focus after its rows are gone");
});
