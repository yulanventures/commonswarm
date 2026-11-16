import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { buildChoiceCard, type ChoiceCardVM } from "../../lib/choice-card";
import { parseAskChoices, type AskChoiceState, type ChoiceDraft, type ChoiceSubmission } from "../../lib/choices";
import { needsYouCard, NEEDS_YOU_CHOICE_ACTION } from "../../lib/home-primitives";
import { signalHasEnded } from "../../lib/signal-history";
import { deriveStreamExtras } from "../../lib/home-stream";
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
const form = (root: FakeElement) => root.one(el => el.tagName === "FORM");
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
  assert.equal(root.tagName, "DIV");
  assert.equal(root.find(el => el.tagName === "FORM").length, 1, "one form, holding only the rows");
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
  form(root).fire("submit");
  assert.equal(submits.length, 0);
  input.value = "  Next week  "; input.fire("input");
  assert.equal(submit.disabled, false);
  assert.equal(drafts.at(-1)!.otherText, "  Next week  ");
  assert.equal(input.fire("keydown", { key: "Escape" }).defaultPrevented, false, "Escape keeps typed text");
  assert.equal(form(root).fire("submit").defaultPrevented, true);
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
  assert.equal(submit.parentElement, form(root));
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
  form(root).fire("submit");
  assert.deepEqual(submits, [{ optionIds: ["ship", "skip"], otherText: "and the flue test" }]);
  boxes[0]!.checked = false; boxes[0]!.fire("change"); boxes[1]!.checked = false; boxes[1]!.fire("change");
  input.value = ""; input.fire("input");
  assert.equal(submit.disabled, true, "Other ticked but empty, nothing else: nothing to send");
  // Enter on a checkbox toggles it like Space; it never submits the card.
  const enter = boxes[2]!.fire("keydown", { key: "Enter" });
  assert.deepEqual([enter.defaultPrevented, boxes[2]!.checked, submit.disabled, submits.length], [true, true, false, 1]);
  boxes[2]!.fire("keydown", { key: "Enter" });
  assert.equal(boxes[2]!.checked, false);
});

test("single choice: Other text sends only while its field is open", () => {
  const { root, submits } = card({ state: state(), draft: { selected: [], otherOpen: false, otherText: "kept from before" } });
  const submit = root.one(el => el.dataset.decisionSubmit !== undefined);
  assert.equal(submit.disabled, true);
  form(root).fire("submit");
  assert.equal(submits.length, 0);
  root.one(el => el.dataset.decisionOtherTrigger !== undefined).fire("click");
  assert.equal(submit.disabled, false, "opening the field brings the kept text back");
  form(root).fire("submit");
  assert.deepEqual(submits, [{ optionIds: [], otherText: "kept from before" }]);
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
  form(pending.root).fire("submit");
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
  const repliedThenEnded = card({ state: state(), repliedInWords: true, ended: true });
  assert.deepEqual([repliedThenEnded.root.dataset.decisionState, repliedThenEnded.root.one(has("hm-decision__foot")).textContent], ["replied", "Answered"],
    "an answer in words stays answered after the ask's until passes");
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
  assert.equal(form(decision).find(el => el.className === "dashboard__message-markdown").length, 0, "the question is outside the form: nothing in it can submit an answer");
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

test("in the feed, Other text typed before a rebuild is in the rebuilt card, and its Submit sends that text", () => {
  const f = feed();
  (f.context.choiceRows as Map<string, AskChoiceState>).set(SIGNAL, state());
  const first = f.row({}).children[0] as FakeElement;
  first.one(el => el.dataset.decisionOtherTrigger !== undefined).fire("click");
  const typed = first.one(el => el.dataset.decisionOtherInput !== undefined);
  typed.value = "Harbor, but after 10am"; typed.fire("input");
  // The feed's poll rebuilds every row: the old card is gone, the new one is built from the draft.
  const rebuilt = f.row({}).children[0] as FakeElement;
  assert.notEqual(rebuilt, first);
  const input = rebuilt.one(el => el.dataset.decisionOtherInput !== undefined);
  const trigger = rebuilt.one(el => el.dataset.decisionOtherTrigger !== undefined);
  const submit = rebuilt.one(el => el.dataset.decisionSubmit !== undefined);
  assert.deepEqual([input.value, trigger.getAttribute("aria-expanded"), rebuilt.one(has("hm-decision__other-field")).hidden, submit.disabled],
    ["Harbor, but after 10am", "true", false, false]);
  form(rebuilt).fire("submit");
  assert.deepEqual(f.sent, [[SIGNAL, { optionIds: [], otherText: "Harbor, but after 10am" }]]);
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

// Live arrivals: refreshChoices, its batch and the waiting state lifted from the dashboard, with a stub read.
const ASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const askSignal = (id: string, createdAt: string, extra: Record<string, unknown> = {}) =>
  ({ id, kind: "ask", from: "agent-1", fromKind: "agent", to: "zoe", toAgent: null, threadRootId: null, inReplyTo: null,
    until: "2999-01-01T00:00:00Z", createdAt, ...extra });
function live() {
  let clock = 1_000_000;
  const reads: string[][] = []; const paints: number[] = [];
  const pending: Array<{ ids: string[]; settle: (rows: unknown) => void }> = [];
  const context: Record<string, unknown> = {
    Date: { now: () => clock, parse: Date.parse }, sampleMode: false, session: { user: { id: "zoe" } }, activeWorkspaceId: "W", requestVersion: 1,
    signals: [askSignal(ASK_A, "2026-11-16T10:00:00Z")], choiceRows: new Map(), choiceDrafts: new Map(),
    choiceCheckedAt: 0, choiceGeneration: 0, ASK_CHOICES_BATCH: 50,
    choiceCheckedIds: new Set(), choiceCheckedReplyIds: new Set(), choiceFailedIds: new Set(), choiceInFlight: { ids: new Set(), replies: new Set() },
    choiceBatchMemo: null, addAgentViewOpen: () => false, renderFeed: () => paints.push(1),
    askChoices: (_workspace: string, ids: string[]) => { reads.push([...ids]); return new Promise(settle => pending.push({ ids, settle })); },
  };
  runInNewContext(lift(["choiceDraftKey", "choiceBatchIds", "choiceRepliesToOpen", "choiceAwaitsCheck", "refreshChoices"]), context);
  const refresh = () => (context.refreshChoices as (w: string, v: number) => Promise<void>)("W", 1);
  const awaits = (id: string) => (context.choiceAwaitsCheck as (id: string) => boolean)(id);
  // The stub resolves the read with parsed rows, as askChoices does.
  const settle = async (data: unknown) => { pending.shift()!.settle(data === null ? null : parseAskChoices(data)); await new Promise(done => setImmediate(done)); };
  return { context, reads, paints, refresh, awaits, settle, tick: (ms: number) => { clock += ms; } };
}
const choiceRow = (id: string, answer: unknown = null) => ({ signal_id: id, options: [{ id: "ship", label: "Ship" }, { id: "wait", label: "Wait" }], answer });

test("a new ask inside the 20 s window is read at once; nothing new waits for the throttle", async () => {
  const l = live();
  const first = l.refresh(); await l.settle({ asks: [] }); await first;
  assert.deepEqual(l.reads, [[ASK_A]]);
  l.tick(2_000);
  await l.refresh();
  assert.equal(l.reads.length, 1, "nothing new: throttled");
  l.context.signals = [...(l.context.signals as unknown[]), askSignal(ASK_B, "2026-11-16T10:00:05Z")];
  const second = l.refresh();
  assert.deepEqual(l.reads[1], [ASK_B, ASK_A], "the new ask is read at once, two seconds after the last read");
  void l.refresh();
  assert.equal(l.reads.length, 2, "an ask already in the read on its way is not news");
  await l.settle({ asks: [choiceRow(ASK_B)] }); await second;
  assert.equal((l.context.choiceRows as Map<string, AskChoiceState>).has(ASK_B), true);
  l.tick(21_000);
  void l.refresh();
  assert.equal(l.reads.length, 3, "after 20 s the ordinary re-read still runs");
});

test("a reply to an open choice ask is read at once, once", async () => {
  const l = live();
  const first = l.refresh(); await l.settle({ asks: [choiceRow(ASK_A)] }); await first;
  l.tick(1_000);
  l.context.signals = [...(l.context.signals as unknown[]), { id: "reply-1", kind: "note", from: "amy", fromKind: "user", to: null, toAgent: "agent-1",
    threadRootId: null, inReplyTo: ASK_A, until: "2999-01-01T00:00:00Z", createdAt: "2026-11-16T10:00:09Z" }];
  const again = l.refresh();
  assert.equal(l.reads.length, 2, "a teammate's answer re-reads without waiting");
  await l.settle({ asks: [choiceRow(ASK_A, { option_id: "wait", option_ids: ["wait"], other_text: null,
    actor_user_id: "11111111-1111-4111-8111-111111111111", by_viewer: false, at: "2026-11-16T10:00:09Z" })] });
  await again;
  assert.equal((l.context.choiceRows as Map<string, AskChoiceState>).get(ASK_A)!.answer!.optionIds[0], "wait");
  assert.ok(l.paints.length > 0, "the answered card is painted");
  l.tick(1_000);
  await l.refresh();
  assert.equal(l.reads.length, 2, "a reply already seen is not news");
});

test("an ask waits, without a Reply card, until its first read settles; a choice ask then paints its card", async () => {
  const l = live();
  assert.equal(l.awaits(ASK_A), true, "unchecked: waiting");
  const extras = deriveStreamExtras({ id: ASK_A, kind: "ask", body: "Ship?", about: null, createdAt: "2026-11-16T10:00:00Z", when: "10:00",
    author: { id: "amy", name: "Amy", firstName: "Amy", initials: "A", you: false, role: "member" }, addressedToViewer: true, answered: false,
    choices: l.awaits(ASK_A), attachments: [] }, { workspace: { id: "W", name: "Home", href: "/app?w=W" }, todos: new Map() });
  assert.equal(extras.ask, null, "no Reply card while the first read is out");
  const f = feed();
  const body = f.doc.createElement("div"); const question = f.doc.createElement("div"); question.className = "dashboard__message-markdown"; body.append(question);
  (f.context.appendChoices as (...args: unknown[]) => void)(body, askSignal(SIGNAL, "2026-11-16T10:00:00Z"), question, false, true);
  const shell = body.children[0] as FakeElement;
  assert.deepEqual([shell.className, shell.dataset.decisionState, shell.textContent, shell.children.length], ["hm-decision", "checking", "", 1],
    "a quiet box around the question: no words, no controls");
  const run = l.refresh();
  assert.equal(l.awaits(ASK_A), true, "still waiting while the read is out");
  const paintsBefore = l.paints.length;
  await l.settle({ asks: [choiceRow(ASK_A)] }); await run;
  assert.equal(l.awaits(ASK_A), false);
  assert.equal(l.paints.length, paintsBefore + 1, "painted once the read lands");
});

test("a plain ask gets its Reply card when the read settles, a failed read included, and a failure doesn't loop", async () => {
  const l = live();
  const ok = l.refresh(); await l.settle({ asks: [] }); await ok;
  assert.equal(l.awaits(ASK_A), false, "no choices: Reply paints");
  assert.equal(l.paints.length, 1, "the waiting ask is repainted even though no rows changed");

  const broken = live();
  const run = broken.refresh(); await broken.settle(null); await run;
  assert.equal(broken.awaits(ASK_A), false, "a failed read still lets Reply paint");
  assert.equal(broken.paints.length, 1);
  assert.equal((broken.context.choiceCheckedIds as Set<string>).has(ASK_A), false, "a failed read checks nothing");
  broken.tick(2_000);
  await broken.refresh();
  assert.equal(broken.reads.length, 1, "a failed ask is not news: it waits for the throttle");
  broken.tick(19_000);
  const retry = broken.refresh();
  assert.equal(broken.reads.length, 2, "and retries after it");
  await broken.settle({ asks: [choiceRow(ASK_A)] }); await retry;
  assert.equal((broken.context.choiceRows as Map<string, AskChoiceState>).has(ASK_A), true);
});
