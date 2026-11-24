import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWaitingSurveyState,
  formatSurveyAnswerSummary,
  formatSurveyDestination,
  renderWaitingSurvey,
  runWaitingSurveyBatch,
  surveyDraftKey,
  surveyReadyEntries,
  surveySubmissionFromDraft,
} from "./waiting-survey.ts";
import { renderWaitingPanel } from "./waiting-panel.ts";

class FakeNode {
  tagName;
  nodeType = 1;
  ownerDocument;
  parentNode = null;
  children = [];
  attrs = new Map();
  dataset = {};
  style = {};
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  id = "";
  value = "";
  placeholder = "";
  href = "";
  dateTime = "";
  _text = "";
  listeners = new Map();
  onclick = null;
  onchange = null;

  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }
  get textContent() {
    return this.children.length ? this.children.map(c => c.textContent).join("") : this._text;
  }
  set textContent(v) {
    this._text = String(v);
    this.children = [];
  }
  get options() {
    return this.children.filter(c => c.tagName === "OPTION");
  }
  setAttribute(k, v) {
    const val = String(v);
    this.attrs.set(k, val);
    if (k === "id") this.id = val;
    if (k.startsWith("data-")) {
      const camel = k.slice(5).replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
      this.dataset[camel] = val;
    }
  }
  getAttribute(k) {
    return this.attrs.get(k) ?? null;
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? (this.parentNode.children[i + 1] ?? null) : null;
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    if (!ref) {
      node.parentNode = this;
      this.children.push(node);
      return node;
    }
    const i = this.children.indexOf(ref);
    if (i < 0) throw new Error("NotFoundError");
    node.parentNode = this;
    this.children.splice(i, 0, node);
    return node;
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    this.parentNode.insertBefore(node, this);
    this.parentNode.removeChild(this);
  }
  remove() { this.parentNode?.removeChild(this); }
  closest(sel) {
    let cur = this;
    while (cur) {
      if (cur.matches(sel)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  append(...kids) {
    for (const k of kids) {
      if (k.parentNode) k.parentNode.removeChild(k);
      k.parentNode = this;
      this.children.push(k);
    }
  }
  removeChild(k) {
    const i = this.children.indexOf(k);
    if (i >= 0) {
      this.children.splice(i, 1);
      k.parentNode = null;
    }
  }
  replaceChildren(...kids) {
    for (const c of this.children) {
      if (this.ownerDocument?.activeElement && (c === this.ownerDocument.activeElement || c.querySelectorAll?.("*").includes?.(this.ownerDocument.activeElement))) {
        this.ownerDocument.activeElement = null;
      }
      c.parentNode = null;
    }
    this.children = [];
    this.append(...kids);
  }
  focus() {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  setSelectionRange(start, end) {
    this.selectionStart = start;
    this.selectionEnd = end;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type, extra = {}) {
    const ev = { type, defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; }, ...extra };
    if (type === "click" && typeof this.onclick === "function") this.onclick(ev);
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }
  click() {
    if (this.disabled) return;
    this.dispatch("click");
  }
  matches(selector) {
    if (selector.startsWith("[") && selector.endsWith("]")) {
      const body = selector.slice(1, -1);
      const eq = body.indexOf("=");
      if (eq < 0) {
        const key = body.startsWith("data-") ? body.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase()) : null;
        return this.attrs.has(body) || (key !== null && key in this.dataset);
      }
      const attr = body.slice(0, eq);
      const expected = body.slice(eq + 1).replace(/^"|"$/gu, "");
      const key = attr.startsWith("data-") ? attr.slice(5).replace(/-([a-z])/gu, (_, c) => c.toUpperCase()) : null;
      return this.attrs.get(attr) === expected || (key !== null && this.dataset[key] === expected);
    }
    if (selector.startsWith(".")) {
      return this.className.split(/\s+/u).includes(selector.slice(1));
    }
    return false;
  }
  querySelector(selector) {
    for (const c of this.children) {
      if (c.matches(selector)) return c;
      const nested = c.querySelector(selector);
      if (nested) return nested;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    for (const c of this.children) {
      if (c.matches(selector)) out.push(c);
      out.push(...c.querySelectorAll(selector));
    }
    return out;
  }
}

function makeDoc() {
  const doc = {
    activeElement: null,
    createElement: tag => new FakeNode(doc, tag),
    createElementNS: (_ns, tag) => new FakeNode(doc, tag),
    getElementById: () => null,
  };
  return doc;
}

function makeAsk(id, overrides = {}) {
  return {
    id,
    workspaceId: "ws-1",
    workspaceName: "Rivera Household",
    conversation: { kind: "channel", channelId: "ch-1" },
    channelLabel: "#boiler-quotes",
    from: { id: "a-1", name: "Atlas", label: "Atlas", initials: "A", yours: true, state: { word: "Ready", detail: "", tone: "ok", attention: false } },
    fromKind: "agent",
    fromId: "a-1",
    what: `Question ${id}`,
    when: "2m ago",
    createdAt: "2026-11-19T10:00:00Z",
    until: "2026-11-20T10:00:00Z",
    choices: {
      multi: false,
      options: [
        { id: "opt-a", label: "Harbor Heating", recommended: true, description: "Friday 9am" },
        { id: "opt-b", label: "Northside Boilers" },
      ],
    },
    ...overrides,
  };
}

test("survey helpers build submissions, pair destinations, and format answer summaries", () => {
  assert.equal(surveySubmissionFromDraft(undefined), null);
  assert.equal(surveySubmissionFromDraft({ optionIds: [], otherOpen: true, otherText: "   " }), null);
  assert.deepEqual(
    surveySubmissionFromDraft({ optionIds: ["opt-a"], otherOpen: true, otherText: "  Gate code 1234  " }),
    { optionIds: ["opt-a"], otherText: "Gate code 1234" },
  );

  const q1 = makeAsk("q1");
  const q2 = makeAsk("q2", { workspaceId: "ws-2", workspaceName: "Studio", channelLabel: "#design" });
  const drafts = new Map([
    [surveyDraftKey("ws-1", "q1"), { optionIds: ["opt-a"], otherOpen: false, otherText: "" }],
  ]);
  const ready = surveyReadyEntries([q1, q2], drafts);
  assert.equal(ready.length, 1);
  assert.equal(ready[0].item.id, "q1");
  assert.equal(formatSurveyDestination(q2, "all"), "Studio · #design");
  assert.equal(formatSurveyDestination(q2, "workspace"), "#design");
  assert.equal(
    formatSurveyAnswerSummary(q1.choices.options, { optionIds: ["opt-a"], otherText: "Leave key" }),
    "Harbor Heating · Other: Leave key",
  );
});

test("Waiting on you panel shows Review N only when 2+ questions are visible", () => {
  const doc = makeDoc();
  const host = doc.createElement("aside");
  const place = { workspaceId: "ws-1", workspaceName: "Rivera Household", kind: "channel", channelId: "ch-1", label: "#boiler-quotes" };
  let started = 0;
  const baseHandlers = {
    onScopeChange: () => {},
    onClose: () => {},
    onRetryLoad: () => {},
    onSubmitChoice: () => {},
    onRetryChoice: () => {},
    onDraftChoice: () => {},
    onStartSurvey: () => { started += 1; },
  };
  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [makeAsk("q1")],
    counts: { channel: { min: 1, complete: true }, workspace: { min: 1, complete: true }, all: { min: 1, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, baseHandlers);
  assert.equal(host.querySelector("[data-waiting-review-start]").hidden, true);

  renderWaitingPanel(host, {
    scope: "channel",
    place,
    items: [makeAsk("q1"), makeAsk("q2")],
    counts: { channel: { min: 2, complete: true }, workspace: { min: 2, complete: true }, all: { min: 2, complete: true } },
    loading: false, complete: true, failed: false, statusMessage: "", statusSeq: 0,
  }, baseHandlers);
  const btn = host.querySelector("[data-waiting-review-start]");
  assert.equal(btn.hidden, false);
  assert.equal(btn.textContent, "Review questions");
  assert.equal(btn.getAttribute("aria-label"), null);
  btn.click();
  assert.equal(started, 1);
});

test("renderWaitingSurvey steps with Back/Next/Skip, stages Other drafts quietly, pairs review destinations, sends only filled-in answers, and keeps failed answers editable", () => {
  const doc = makeDoc();
  const body = doc.createElement("div");
  const q1 = makeAsk("q1", { what: "Which boiler quote?" });
  const q2 = makeAsk("q2", { what: "Which paint finish?" });
  const q3 = makeAsk("q3", { workspaceId: "ws-2", workspaceName: "Studio", channelLabel: "#design", what: "Which font size?" });
  const items = [q1, q2, q3];
  const drafts = new Map();
  const skipped = new Set();
  const errors = new Map();
  const steps = [];
  let reviewed = 0;
  let sentPayload = null;
  let editedId = null;

  const handlers = {
    onExit: () => {},
    onStep: idx => steps.push(idx),
    onDraftChange: (item, draft) => { drafts.set(surveyDraftKey(item.workspaceId, item.id), draft); },
    onSkip: item => { skipped.add(item.id); drafts.delete(surveyDraftKey(item.workspaceId, item.id)); },
    onReview: () => { reviewed += 1; },
    onEdit: item => { editedId = item.id; },
    onSendAll: entries => { sentPayload = entries; },
  };

  // Step 1: Back disabled, select Recommended option A, click Next -> index 1.
  renderWaitingSurvey(body, { items, scope: "all", mode: "step", index: 0, drafts, skipped, errors, sending: false }, handlers);
  assert.equal(body.querySelector("[data-waiting-survey-progress]").textContent, "Question 1 of 3");
  assert.equal(body.querySelector("[data-waiting-survey-back]").disabled, true);
  body.querySelector('[data-survey-option="opt-a"]').click();
  assert.deepEqual(drafts.get(surveyDraftKey("ws-1", "q1")).optionIds, ["opt-a"]);
  body.querySelector("[data-waiting-survey-next]").click();
  assert.deepEqual(steps, [1]);

  // Step 2: Skip q2.
  renderWaitingSurvey(body, { items, scope: "all", mode: "step", index: 1, drafts, skipped, errors, sending: false }, handlers);
  assert.equal(body.querySelector("[data-waiting-survey-back]").disabled, false);
  body.querySelector("[data-waiting-survey-skip]").click();
  assert.equal(skipped.has("q2"), true);

  // Step 3: Toggle Something else, type custom answer, click Review answers.
  renderWaitingSurvey(body, { items, scope: "all", mode: "step", index: 2, drafts, skipped, errors, sending: false }, handlers);
  body.querySelector("[data-survey-other-toggle]").click();
  renderWaitingSurvey(body, { items, scope: "all", mode: "step", index: 2, drafts, skipped, errors, sending: false }, handlers);
  const input = body.querySelector("[data-survey-other-input]");
  input.value = "15px body";
  input.dispatch("input");
  assert.equal(drafts.get(surveyDraftKey("ws-2", "q3")).otherText, "15px body");
  assert.equal(body.querySelector("[data-waiting-survey-next]").textContent, "Review answers");
  body.querySelector("[data-waiting-survey-next]").click();
  assert.equal(reviewed, 1);

  // Review screen: pairs destinations, shows 2 ready · 1 skipped, Send 2 answers sends ONLY q1 & q3 (not skipped q2).
  errors.set("q3", "Temporary network error");
  renderWaitingSurvey(body, { items, scope: "all", mode: "review", index: 2, drafts, skipped, errors, sending: false }, handlers);
  const reviewItems = body.querySelectorAll("[data-waiting-survey-item]");
  assert.equal(reviewItems.length, 3);
  assert.equal(reviewItems[0].querySelector(".cs-waiting-card__place").textContent, "Rivera Household · #boiler-quotes");
  assert.equal(reviewItems[0].querySelector(".cs-waiting-survey__answer").textContent, "Harbor Heating");
  assert.ok(reviewItems[1].textContent.includes("Skipped"));
  assert.equal(reviewItems[1].textContent.includes("—"), false, "no em dash in skipped copy");
  assert.equal(reviewItems[2].querySelector(".cs-waiting-card__place").textContent, "Studio · #design");
  assert.equal(reviewItems[2].querySelector(".cs-waiting-survey__answer").textContent, "Other: 15px body");
  assert.equal(reviewItems[2].querySelector(".cs-waiting-card__error").textContent, "Temporary network error");

  // Edit button on failed q3 jumps back to edit it.
  reviewItems[2].querySelector('[data-waiting-survey-edit="q3"]').click();
  assert.equal(editedId, "q3");

  // Send 2 answers submits ONLY q1 and q3.
  const sendBtn = body.querySelector("[data-waiting-survey-send]");
  assert.equal(sendBtn.textContent, "Send 2 answers");
  sendBtn.click();
  assert.deepEqual(sentPayload.map(e => [e.item.id, e.submission]), [
    ["q1", { optionIds: ["opt-a"], otherText: null }],
    ["q3", { optionIds: [], otherText: "15px body" }],
  ]);
});

test("renderWaitingSurvey preserves focused option/toggle across rerenders and preserves focused Other input DOM node during background refreshes", () => {
  const doc = makeDoc();
  const body = doc.createElement("div");
  const q1 = makeAsk("q1", { what: "Which boiler quote?", when: "1m ago" });
  const q2 = makeAsk("q2", { what: "Which paint finish?", when: "2m ago" });
  const drafts = new Map();
  const skipped = new Set();
  const errors = new Map();
  const handlers = {
    onExit: () => {},
    onStep: () => {},
    onDraftChange: (item, draft, quiet) => {
      drafts.set(surveyDraftKey(item.workspaceId, item.id), draft);
      if (!quiet) {
        renderWaitingSurvey(body, { items: [q1, q2], scope: "channel", mode: "step", index: 0, drafts, skipped, errors, sending: false }, handlers);
      }
    },
    onSkip: () => {},
    onReview: () => {},
    onEdit: () => {},
    onSendAll: () => {},
  };

  renderWaitingSurvey(body, { items: [q1, q2], scope: "channel", mode: "step", index: 0, drafts, skipped, errors, sending: false }, handlers);

  // 1. Toggling an option button restores focus to that exact option button (never drops to null/body).
  const optA = body.querySelector('[data-survey-option="opt-a"]');
  optA.focus();
  optA.click();
  const optAAfter = body.querySelector('[data-survey-option="opt-a"]');
  assert.equal(optAAfter.getAttribute("aria-pressed"), "true");
  assert.strictEqual(doc.activeElement, optAAfter, "toggling an option must preserve focus on the toggled option button");

  // 2. Toggling Something else preserves focus on the toggle button.
  const otherToggle = body.querySelector("[data-survey-other-toggle]");
  otherToggle.focus();
  otherToggle.click();
  assert.strictEqual(doc.activeElement, body.querySelector("[data-survey-other-toggle]"),
    "toggling Something else must preserve focus on the toggle button");

  // 3. While typing in Something else, a background refresh (even with updated relative time) skips replaceChildren
  //    and preserves the exact <input> DOM node and caret!
  const otherInput = body.querySelector("[data-survey-other-input]");
  otherInput.focus();
  otherInput.value = "Friday afternoon";
  otherInput.setSelectionRange(6, 6);
  otherInput.dispatch("input");

  const q1Refreshed = makeAsk("q1", { what: "Which boiler quote?", when: "2m ago" });
  renderWaitingSurvey(body, { items: [q1Refreshed, q2], scope: "channel", mode: "step", index: 0, drafts, skipped, errors, sending: false }, handlers);
  assert.strictEqual(body.querySelector("[data-survey-other-input]"), otherInput,
    "background refresh while typing must keep the exact <input> DOM node");
  assert.strictEqual(doc.activeElement, otherInput,
    "background refresh while typing must keep focus on the <input>");

  // 4. Even if an unrelated structural change forces a rerender (e.g., error banner appears), focus + caret restore onto the input.
  errors.set("q1", "Retry needed");
  renderWaitingSurvey(body, { items: [q1Refreshed, q2], scope: "channel", mode: "step", index: 0, drafts, skipped, errors, sending: false }, handlers);
  const restoredInput = body.querySelector("[data-survey-other-input]");
  assert.strictEqual(doc.activeElement, restoredInput, "structural rerender must restore focus onto the Other input");
  assert.equal(restoredInput.selectionStart, 6);
  assert.equal(restoredInput.selectionEnd, 6);
});

test("Check E draft retention on Skip: keeps session draft, restores it on Back, and omits skipped question from final send until re-included", () => {
  const doc = makeDoc();
  const body = doc.createElement("div");
  const q1 = makeAsk("q1", { what: "Which boiler quote?" });
  const q2 = makeAsk("q2", { what: "Which paint finish?" });
  const items = [q1, q2];
  const drafts = new Map();
  const skipped = new Set();
  const errors = new Map();
  const sent = [];
  let mode = "step";
  let index = 0;

  const render = () => {
    renderWaitingSurvey(body, { items, scope: "channel", mode, index, drafts, skipped, errors, sending: false }, handlers);
  };
  const handlers = {
    onExit: () => {},
    onStep: (nextIndex) => {
      if (mode === "step" && nextIndex > index) {
        const cur = items[index];
        if (cur && surveySubmissionFromDraft(drafts.get(surveyDraftKey(cur.workspaceId, cur.id)))) {
          skipped.delete(cur.id);
        }
      }
      mode = "step";
      index = nextIndex;
      render();
    },
    onDraftChange: (item, draft, quiet) => {
      drafts.set(surveyDraftKey(item.workspaceId, item.id), draft);
      skipped.delete(item.id);
      if (!quiet) render();
    },
    onSkip: (item) => {
      skipped.add(item.id);
      if (index >= items.length - 1) mode = "review";
      else index += 1;
      render();
    },
    onReview: () => {
      if (mode === "step") {
        const cur = items[index];
        if (cur && surveySubmissionFromDraft(drafts.get(surveyDraftKey(cur.workspaceId, cur.id)))) {
          skipped.delete(cur.id);
        }
      }
      mode = "review";
      render();
    },
    onEdit: (item) => {
      mode = "step";
      index = items.findIndex(x => x.id === item.id);
      render();
    },
    onSendAll: (entries) => sent.push(entries),
  };

  render();
  // Q1: type "Keep this for later" under Something else, then Skip.
  body.querySelector("[data-survey-other-toggle]").click();
  const q1Input = body.querySelector("[data-survey-other-input]");
  q1Input.value = "Keep this for later";
  q1Input.dispatch("input");
  body.querySelector("[data-waiting-survey-skip]").click();
  assert.equal(index, 1);
  assert.equal(skipped.has("q1"), true);
  assert.equal(drafts.get(surveyDraftKey(q1.workspaceId, q1.id))?.otherText, "Keep this for later");

  // Back to Q1: draft must be restored while Q1 remains skipped until re-included.
  body.querySelector("[data-waiting-survey-back]").click();
  assert.equal(index, 0);
  assert.equal(body.querySelector("[data-survey-other-input]")?.value, "Keep this for later");
  assert.equal(skipped.has("q1"), true);
  assert.equal(surveyReadyEntries(items, drafts, skipped).length, 0);

  // Skip Q1 again, answer Q2, reach Review: Q1 must be omitted from Send 1 answer and marked Skipped.
  body.querySelector("[data-waiting-survey-skip]").click();
  body.querySelector('[data-survey-option="opt-a"]').click();
  body.querySelector("[data-waiting-survey-next]").click();
  assert.equal(mode, "review");
  assert.equal(body.querySelector("[data-waiting-survey-send]").textContent, "Send 1 answer");
  assert.match(body.querySelector('[data-waiting-survey-item="q1"]').textContent, /Skipped/);
  body.querySelector("[data-waiting-survey-send]").click();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map(e => e.item.id), ["q2"]);

  // Re-open Q1 from review (Answer), see draft restored, and click Next to re-include Q1.
  body.querySelector('[data-waiting-survey-edit="q1"]').click();
  assert.equal(mode, "step");
  assert.equal(index, 0);
  assert.equal(body.querySelector("[data-survey-other-input]")?.value, "Keep this for later");
  body.querySelector("[data-waiting-survey-next]").click();
  assert.equal(skipped.has("q1"), false);
  body.querySelector("[data-waiting-survey-next]").click();
  assert.equal(mode, "review");
  assert.equal(body.querySelector("[data-waiting-survey-send]").textContent, "Send 2 answers");
  assert.match(body.querySelector('[data-waiting-survey-item="q1"]').textContent, /Other: Keep this for later/);
});

test("survey step renders Dismiss alongside Skip and shows in-place Dismissed with Undo", () => {
  const doc = makeDoc();
  const body = doc.createElement("div");
  const q1 = makeAsk("q1", { what: "First question?" });
  const q2 = makeAsk("q2", { what: "Second question?" });
  let items = [q1, q2];
  let dismissedNotice = null;
  const dismissed = [];
  const undone = [];

  const render = () => {
    renderWaitingSurvey(
      body,
      { items, scope: "channel", mode: "step", index: 0, drafts: new Map(), skipped: new Set(), errors: new Map(), sending: false, dismissedNotice },
      {
        onExit: () => {},
        onStep: () => {},
        onDraftChange: () => {},
        onSkip: () => {},
        onDismiss: (item) => {
          dismissed.push(item.id);
          items = items.filter(i => i.id !== item.id);
          dismissedNotice = { key: `ask:${item.id}` };
          render();
        },
        onUndoDismiss: (key) => {
          undone.push(key);
          dismissedNotice = { key, pendingUndo: true };
          render();
        },
        onReview: () => {},
        onEdit: () => {},
        onSendAll: () => {},
      },
    );
  };

  render();
  const dismissBtn = body.querySelector('[data-waiting-survey-dismiss="q1"]');
  const skipBtn = body.querySelector("[data-waiting-survey-skip]");
  assert.ok(dismissBtn);
  assert.equal(dismissBtn.tagName, "BUTTON");
  assert.equal(dismissBtn.textContent, "Dismiss");
  assert.ok(skipBtn);
  assert.equal(skipBtn.textContent, "Skip");

  dismissBtn.click();
  assert.deepEqual(dismissed, ["q1"]);
  const notice = body.querySelector('[data-waiting-dismissed="ask:q1"]');
  assert.ok(notice);
  assert.equal(notice.querySelector(".cs-waiting-dismissed__label").textContent, "Dismissed");
  const undoBtn = notice.querySelector('[data-waiting-undo="ask:q1"]');
  assert.ok(undoBtn);
  assert.equal(undoBtn.textContent, "Undo");

  undoBtn.click();
  assert.deepEqual(undone, ["ask:q1"]);
  const undoing = body.querySelector('[data-waiting-undo="ask:q1"]');
  assert.ok(undoing);
  assert.equal(undoing.textContent, "Undoing…");
  assert.equal(undoing.getAttribute("aria-disabled"), "true");
  assert.equal(body.querySelector('[data-waiting-survey-dismiss="q1"]'), null, "Undo does not paint q1 before reload");

  // Reload brings q1 back and clears the dismissed notice.
  items = [q1, q2];
  dismissedNotice = null;
  render();
  assert.equal(body.querySelector('[data-waiting-dismissed="ask:q1"]'), null);
  assert.ok(body.querySelector('[data-waiting-survey-dismiss="q1"]'));
});

test("runWaitingSurveyBatch (C3): retired batch settlement never clears a replacement batch's sending state or unlocks its controls, and a still-owned cancelled batch clears its sending indicator with no error", async () => {
  const outcomes = [
    { label: "success", result: { ok: true, optionIds: ["opt-a"], otherText: null } },
    { label: "404", result: { ok: false, status: 404, error: "not_found", message: "Not found." } },
    { label: "error", result: { ok: false, status: 500, error: "server_error", message: "Stale 500." } },
    { label: "retired", result: { ok: false, status: 0, error: "operation_retired", message: "Action cancelled." } },
  ];

  const q1 = makeAsk("q1", { what: "First question?" });
  const q2 = makeAsk("q2", { what: "Second question?" });
  const entries = [
    { item: q1, submission: { optionIds: ["opt-a"], otherText: null } },
    { item: q2, submission: { optionIds: ["opt-b"], otherText: null } },
  ];

  for (const outcome of outcomes) {
    const doc = makeDoc();
    const body = doc.createElement("div");
    let attemptSeq = 0;
    let loginGen = 1;
    let state = {
      ...createWaitingSurveyState(),
      active: true,
      mode: "review",
      itemIds: ["q1", "q2"],
      placeKey: "ws-1:ch-1",
    };
    const drafts = new Map([
      [surveyDraftKey("ws-1", "q1"), { optionIds: ["opt-a"], otherOpen: false, otherText: "" }],
      [surveyDraftKey("ws-1", "q2"), { optionIds: ["opt-b"], otherOpen: false, otherText: "" }],
    ]);
    const skipped = new Set();
    const errors = new Map();
    const dispatches = [];
    const resolvers = [];
    let renders = 0;
    let completions = 0;

    const renderReview = () => {
      renders += 1;
      renderWaitingSurvey(
        body,
        { items: [q1, q2], scope: "channel", mode: state.mode, index: state.index, drafts, skipped, errors, sending: state.sending },
        { onExit: () => {}, onStep: () => {}, onDraftChange: () => {}, onSkip: () => {}, onReview: () => {}, onEdit: () => {}, onSendAll: () => {} },
      );
    };

    const startBatch = () => {
      const pinnedGen = loginGen;
      return runWaitingSurveyBatch(entries, {
        getState: () => state,
        nextAttemptId: () => (attemptSeq += 1),
        isAlive: () => loginGen === pinnedGen,
        hasActiveSession: () => true,
        sendEntry: (item) => {
          dispatches.push({ loginGen: pinnedGen, itemId: item.id });
          return new Promise(resolve => { resolvers.push(resolve); });
        },
        onEntrySucceeded: (item) => {
          drafts.delete(surveyDraftKey(item.workspaceId, item.id));
          errors.delete(item.id);
        },
        onEntryFailed: (item, msg) => {
          errors.set(item.id, msg);
        },
        onRender: renderReview,
        onComplete: () => {
          completions += 1;
          renderReview();
        },
        failureMessage: "Could not send.",
      });
    };

    // Batch A starts under login 1 and is held on item 1.
    const batchA = startBatch();
    assert.equal(state.sending, true);
    assert.equal(dispatches.length, 1);

    // Same-person login replacement resets survey state synchronously.
    loginGen += 1;
    state = {
      ...createWaitingSurveyState(),
      active: true,
      mode: "review",
      itemIds: ["q1", "q2"],
      placeKey: "ws-1:ch-1",
    };

    // Fresh Batch B starts under login 2 and is held on item 1.
    const batchB = startBatch();
    const attemptBId = state.sendingAttemptId;
    assert.equal(state.sending, true);
    assert.equal(body.querySelector("[data-waiting-survey-send]").textContent, "Sending…");
    assert.equal(body.querySelector("[data-waiting-survey-send]").getAttribute("aria-disabled"), "true");
    assert.equal(body.querySelector("[data-waiting-survey-back]").getAttribute("aria-disabled"), "true");
    assert.equal(dispatches.filter(d => d.loginGen === 2).length, 1, `Survey(${outcome.label}): B dispatched item 1 once`);

    // Release Batch A's held settlement: must do NOTHING to Batch B's sending flag, controls, drafts, or errors.
    const rendersBeforeA = renders;
    resolvers[0](outcome.result);
    await batchA;

    assert.equal(state.sending, true, `Survey(${outcome.label}): B must remain sending`);
    assert.equal(state.sendingAttemptId, attemptBId, `Survey(${outcome.label}): B must still own sendingAttemptId`);
    assert.equal(body.querySelector("[data-waiting-survey-send]").textContent, "Sending…");
    assert.equal(body.querySelector("[data-waiting-survey-send]").getAttribute("aria-disabled"), "true");
    assert.equal(body.querySelector("[data-waiting-survey-back]").getAttribute("aria-disabled"), "true");
    assert.equal(renders, rendersBeforeA, `Survey(${outcome.label}): A must not repaint`);
    assert.equal(completions, 0, `Survey(${outcome.label}): A must not complete`);
    assert.equal(errors.size, 0, `Survey(${outcome.label}): A must set no error`);
    assert.equal(drafts.size, 2, `Survey(${outcome.label}): A must not mutate B drafts`);
    assert.equal(dispatches.filter(d => d.loginGen === 1).length, 1, `Survey(${outcome.label}): A must not send item 2`);
    assert.equal(dispatches.filter(d => d.loginGen === 2).length, 1, `Survey(${outcome.label}): B still dispatched once`);

    // Finish Batch B cleanly.
    resolvers[1]({ ok: true, optionIds: ["opt-a"], otherText: null });
    await Promise.resolve();
    resolvers[2]({ ok: true, optionIds: ["opt-b"], otherText: null });
    await batchB;
    assert.equal(state.sending, false);
    assert.equal(state.sendingAttemptId, null);
    assert.equal(completions, 1);
  }

  // Still-owned cancelled survey batch clears its sending indicator and re-renders controls with no error or completion.
  {
    const doc = makeDoc();
    const body = doc.createElement("div");
    let attemptSeq = 0;
    const state = {
      ...createWaitingSurveyState(),
      active: true,
      mode: "review",
      itemIds: ["q1"],
      placeKey: "ws-1:ch-1",
    };
    const drafts = new Map([
      [surveyDraftKey("ws-1", "q1"), { optionIds: ["opt-a"], otherOpen: false, otherText: "" }],
    ]);
    const errors = new Map();
    let renders = 0;
    let completions = 0;

    const renderReview = () => {
      renders += 1;
      renderWaitingSurvey(
        body,
        { items: [q1], scope: "channel", mode: state.mode, index: state.index, drafts, skipped: new Set(), errors, sending: state.sending },
        { onExit: () => {}, onStep: () => {}, onDraftChange: () => {}, onSkip: () => {}, onReview: () => {}, onEdit: () => {}, onSendAll: () => {} },
      );
    };

    await runWaitingSurveyBatch([entries[0]], {
      getState: () => state,
      nextAttemptId: () => (attemptSeq += 1),
      isAlive: () => true,
      hasActiveSession: () => true,
      sendEntry: async () => ({ ok: false, status: 0, error: "operation_retired", message: "Action cancelled." }),
      onEntrySucceeded: () => { throw new Error("must not succeed"); },
      onEntryFailed: (item, msg) => errors.set(item.id, msg),
      onRender: renderReview,
      onComplete: () => { completions += 1; },
      failureMessage: "Could not send.",
    });

    assert.equal(state.sending, false);
    assert.equal(state.sendingAttemptId, null);
    assert.equal(renders, 2, "Sending… render + cleared indicator render");
    assert.equal(completions, 0, "no completion or data repaint on cancelled batch");
    assert.equal(errors.size, 0, "no stale error on cancelled batch");
    assert.equal(body.querySelector("[data-waiting-survey-send]").textContent, "Send 1 answer");
    assert.equal(body.querySelector("[data-waiting-survey-send]").getAttribute("aria-disabled"), null);
  }
});
