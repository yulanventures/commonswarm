import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatSurveyAnswerSummary,
  formatSurveyDestination,
  renderWaitingSurvey,
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
