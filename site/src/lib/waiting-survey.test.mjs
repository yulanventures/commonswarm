import assert from "node:assert/strict";
import { test } from "node:test";
import { plainAskReplyCommand } from "./commonswarm.ts";
import { renderWaitingPanel } from "./waiting-panel.ts";
import {
  STALE_ASK_CLOSE_BODY,
  buildPlainAskCard,
  emptySurveyDraft,
  renderWaitingSurvey,
  resolveSurveyDraft,
  surveyDoneMessage,
  surveySendLabel,
} from "./waiting-survey.ts";

class FakeNode {
  tagName;
  ownerDocument;
  parentNode = null;
  children = [];
  attrs = new Map();
  dataset = {};
  style = {};
  className = "";
  id = "";
  hidden = false;
  disabled = false;
  readOnly = false;
  checked = false;
  type = "";
  value = "";
  tabIndex = 0;
  maxLength = 0;
  autocomplete = "";
  placeholder = "";
  dateTime = "";
  noValidate = false;
  listeners = new Map();
  onclick = null;
  onchange = null;
  _text = "";

  constructor(doc, tag) {
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
  }
  get textContent() {
    return this.children.length
      ? this.children.map(c => (typeof c === "string" ? c : c.textContent)).join("")
      : this._text;
  }
  set textContent(v) {
    this._text = String(v ?? "");
    this.children = [];
  }
  get firstChild() { return this.children[0] ?? null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const i = this.parentNode.children.indexOf(this);
    return i >= 0 ? this.parentNode.children[i + 1] ?? null : null;
  }
  get options() { return this.children.filter(c => c instanceof FakeNode && c.tagName === "OPTION"); }
  setAttribute(name, value) {
    if (name === "id") this.id = String(value);
    else if (name === "class") this.className = String(value);
    else this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    if (name === "id") return this.id || null;
    if (name === "class") return this.className || null;
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatchEvent(event) {
    const ev = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, target: this, currentTarget: this, ...event };
    if (ev.type === "click" && typeof this.onclick === "function") this.onclick(ev);
    if (ev.type === "change" && typeof this.onchange === "function") this.onchange(ev);
    for (const fn of [...(this.listeners.get(ev.type) ?? [])]) fn(ev);
    return !ev.defaultPrevented;
  }
  click() { this.dispatchEvent({ type: "click", button: 0 }); }
  focus() { this.ownerDocument.activeElement = this; }
  append(...nodes) {
    for (const n of nodes) {
      if (typeof n === "string") { this.children.push(n); continue; }
      if (n.parentNode) n.remove();
      n.parentNode = this;
      this.children.push(n);
    }
  }
  insertBefore(node, ref) {
    if (node instanceof FakeNode && node.parentNode) node.remove();
    if (node instanceof FakeNode) node.parentNode = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(node);
    else this.children.splice(i, 0, node);
  }
  replaceWith(node) {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i < 0) return;
    if (node instanceof FakeNode) node.parentNode = this.parentNode;
    this.parentNode.children[i] = node;
    this.parentNode = null;
  }
  replaceChildren(...nodes) {
    for (const c of this.children) if (c instanceof FakeNode) c.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }
  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }
  contains(target) {
    let cur = target;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  matches(selector) {
    if (selector.startsWith("[data-")) {
      const m = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/u.exec(selector);
      if (!m) return false;
      const camel = m[1].replace(/-([a-z])/gu, (_, ch) => ch.toUpperCase());
      if (!(camel in this.dataset)) return false;
      return m[2] === undefined ? true : this.dataset[camel] === m[2];
    }
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector) {
    const out = [];
    const visit = (n) => {
      for (const c of n.children) {
        if (!(c instanceof FakeNode)) continue;
        if (c.matches(selector)) out.push(c);
        visit(c);
      }
    };
    visit(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
}

function makeFakeDoc() {
  const doc = {
    activeElement: null,
    createElement: (tag) => new FakeNode(doc, tag),
    getElementById: () => null,
  };
  return doc;
}

function makeAgent(name = "Lead") {
  return {
    id: "agent-1", name, label: name, nestedLabel: name, ownerId: "u1", ownerFirstName: "Owner",
    ownerInitial: "O", yours: true, tint: 0, hosted: false,
    state: { kind: "idle", word: "Idle", detail: "", attention: false, fix: { action: null, allowed: false, askWho: null, sentence: "" } },
  };
}

function makeChoiceAsk(id, what, extra = {}) {
  return {
    id,
    workspaceId: "ws-1",
    workspaceName: "Studio",
    conversation: { kind: "channel", channelId: "ch-1" },
    channelLabel: "#design",
    from: makeAgent("Lead"),
    fromKind: "agent",
    fromId: "agent-1",
    what,
    when: "4m ago",
    createdAt: "2026-11-19T12:00:00Z",
    until: "2026-11-26T12:00:00Z",
    choices: {
      multi: false,
      options: [
        { id: "a", label: "Ship now", recommended: true },
        { id: "b", label: "Wait for review" },
      ],
    },
    ...extra,
  };
}

function makePlainAsk(id, what, extra = {}) {
  return {
    id,
    workspaceId: "ws-1",
    workspaceName: "Studio",
    conversation: { kind: "channel", channelId: "ch-1" },
    channelLabel: "#design",
    from: makeAgent("Builder"),
    fromKind: "agent",
    fromId: "agent-2",
    what,
    when: "2d ago",
    createdAt: "2026-11-17T12:00:00Z",
    until: "2026-11-24T12:00:00Z",
    choices: null,
    ...extra,
  };
}

test("plainAskReplyCommand uses the exact private in_reply_to post_signal shape with zero extra keys", () => {
  const cmd = plainAskReplyCommand("11111111-1111-4111-8111-111111111111", STALE_ASK_CLOSE_BODY);
  assert.deepEqual(Object.keys(cmd).sort(), [
    "about",
    "body",
    "in_reply_to",
    "kind",
    "signal_kind",
    "to_agent_principal_id",
    "to_user_id",
  ]);
  assert.deepEqual(cmd, {
    kind: "post_signal",
    signal_kind: "note",
    body: STALE_ASK_CLOSE_BODY,
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: "11111111-1111-4111-8111-111111111111",
    about: null,
  });
});

test("resolveSurveyDraft, surveySendLabel, and surveyDoneMessage keep skipped items out and format counts truthfully", () => {
  const choice = makeChoiceAsk("q1", "Ship today?");
  const plain = makePlainAsk("q2", "Old plain question?");

  // Single choice selection
  const d1 = { ...emptySurveyDraft(), choice: { selected: ["a"], otherOpen: false, otherText: "" } };
  assert.deepEqual(resolveSurveyDraft(choice, d1), {
    kind: "choice",
    submission: { optionIds: ["a"], otherText: null },
    summary: "Ship now",
  });

  // Skipped question never resolves even when a draft exists in session
  assert.equal(resolveSurveyDraft(choice, { ...d1, skipped: true }), null);

  // Stale close resolves to STALE_ASK_CLOSE_BODY
  const dStale = { ...emptySurveyDraft(), stale: true };
  assert.deepEqual(resolveSurveyDraft(plain, dStale), {
    kind: "stale",
    body: STALE_ASK_CLOSE_BODY,
    summary: "Clear as stale",
  });

  // Plain typed answer rejects whitespace and control characters
  assert.equal(resolveSurveyDraft(plain, { ...emptySurveyDraft(), plainText: "   " }), null);
  assert.equal(resolveSurveyDraft(plain, { ...emptySurveyDraft(), plainText: "bad\u0007text" }), null);
  assert.deepEqual(resolveSurveyDraft(plain, { ...emptySurveyDraft(), plainText: "  Yes, go ahead  " }), {
    kind: "plain",
    body: "Yes, go ahead",
    summary: "Yes, go ahead",
  });

  assert.equal(surveySendLabel([]), "Send answers");
  assert.equal(surveySendLabel([{ resolution: resolveSurveyDraft(choice, d1) }]), "Send 1 answer");
  assert.equal(surveySendLabel([{ resolution: resolveSurveyDraft(plain, dStale) }]), "Clear 1 stale");
  assert.equal(
    surveySendLabel([
      { resolution: resolveSurveyDraft(choice, d1) },
      { resolution: resolveSurveyDraft(plain, dStale) },
    ]),
    "Send 1 · Clear 1 stale",
  );
  assert.equal(surveyDoneMessage(2, 0), "Sent 2 answers");
  assert.equal(surveyDoneMessage(0, 2), "Cleared 2 stale questions");
  assert.equal(surveyDoneMessage(1, 2), "Sent 1 · Cleared 2 stale");
});

test("buildPlainAskCard answers in place, clears as stale, keeps text untrusted, and preserves Retry on error", () => {
  const doc = makeFakeDoc();
  const submitted = [];
  const drafted = [];
  let retried = 0;
  const item = makePlainAsk("q-old", "<img src=x onerror=1> Still needed?");
  const card = buildPlainAskCard(doc, item, "workspace", {
    onSubmitPlain: (ask, body, stale) => submitted.push({ id: ask.id, body, stale }),
    onRetryPlain: () => { retried += 1; },
    onDraftPlain: (ask, text) => drafted.push({ id: ask.id, text }),
  });

  assert.equal(card.querySelector(".cs-waiting-card__question").textContent, "<img src=x onerror=1> Still needed?");
  const sendBtn = card.querySelector("[data-waiting-plain-send]");
  assert.equal(sendBtn.disabled, true, "Send starts disabled until text is typed");

  // Clear as stale sends STALE_ASK_CLOSE_BODY immediately
  card.querySelector("[data-waiting-plain-stale]").click();
  assert.deepEqual(submitted, [{ id: "q-old", body: STALE_ASK_CLOSE_BODY, stale: true }]);

  // Typing enables Send and submits typed text
  const input = card.querySelector("[data-waiting-plain-input]");
  input.value = "Proceed with option A";
  input.dispatchEvent({ type: "input" });
  assert.equal(sendBtn.disabled, false);
  assert.deepEqual(drafted, [{ id: "q-old", text: "Proceed with option A" }]);
  card.querySelector(".cs-waiting-plain__form").dispatchEvent({ type: "submit" });
  assert.deepEqual(submitted[1], { id: "q-old", body: "Proceed with option A", stale: false });

  // Failed state keeps draft editable and offers Retry
  const failedCard = buildPlainAskCard(
    doc,
    makePlainAsk("q-old", "Still needed?", { plain: { error: "Network error", draftText: "Keep me", retryable: true } }),
    "channel",
    { onSubmitPlain() {}, onRetryPlain: () => { retried += 1; }, onDraftPlain() {} },
  );
  assert.equal(failedCard.querySelector("[data-waiting-plain-input]").value, "Keep me");
  assert.equal(failedCard.querySelector(".hm-decision__error").textContent, "Network error");
  failedCard.querySelector("[data-waiting-card-retry]").click();
  assert.equal(retried, 1);
});

test("renderWaitingSurvey steps Back/Skip/Next, keeps session drafts, and Final Review sends only answered/stale items", () => {
  const doc = makeFakeDoc();
  const body = doc.createElement("div");
  const items = [
    makeChoiceAsk("q1", "Ship today?"),
    makeChoiceAsk("q2", "Use dark default?"),
    makePlainAsk("q3", "Old historical prompt without choices"),
  ];
  const drafts = new Map();
  const errors = new Map();
  let step = 0;
  let exits = 0;
  let committed = null;
  const draftKey = (item) => `${item.workspaceId}:${item.id}`;

  const render = (focusHeading = false) => {
    renderWaitingSurvey(
      body,
      { scope: "all", items, step, drafts, errors, sending: false, draftKey },
      {
        onExit: () => { exits += 1; },
        onStep: (next, focus) => { step = next; render(focus); },
        onDraftChange: (item, draft) => { drafts.set(draftKey(item), draft); },
        onSubmitAll: (entries) => { committed = entries; },
      },
      focusHeading,
    );
  };

  render(true);
  assert.equal(body.querySelector("[data-waiting-survey-heading]").textContent, "Question 1 of 3");
  assert.equal(doc.activeElement, body.querySelector("[data-waiting-survey-heading]"), "focus moves to step heading");
  assert.equal(body.querySelector("[data-waiting-survey-back]").disabled, true);

  // Pick option "a" on Q1 -> draft saved, NOT sent yet
  body.querySelector('[data-waiting-survey-option="a"]').click();
  assert.equal(committed, null, "picking an option in survey mode records a draft without sending");
  body.querySelector("[data-waiting-survey-next]").click();
  assert.equal(step, 1);
  assert.equal(body.querySelector("[data-waiting-survey-heading]").textContent, "Question 2 of 3");

  // Draft an option on Q2, then click Skip -> draft stays in session, but Q2 is marked skipped and NOT sent
  body.querySelector('[data-waiting-survey-option="b"]').click();
  body.querySelector("[data-waiting-survey-skip]").click();
  assert.equal(step, 2);
  assert.deepEqual(drafts.get("ws-1:q2").choice.selected, ["b"], "Skip preserves session draft");
  assert.equal(drafts.get("ws-1:q2").skipped, true);

  // Mark historical Q3 as Clear as stale, then click Review
  assert.equal(body.querySelector("[data-waiting-survey-heading]").textContent, "Question 3 of 3");
  assert.equal(body.querySelector("[data-waiting-survey-next]").textContent, "Review");
  body.querySelector('[data-waiting-survey-stale="q3"]').click();
  body.querySelector("[data-waiting-survey-next]").click();

  // Final Review shows ONLY Q1 (choice) and Q3 (stale), paired with destination, and notes 1 skipped
  assert.equal(step, 3);
  assert.equal(body.querySelector("[data-waiting-survey-heading]").textContent, "Review answers");
  const reviewRows = body.querySelectorAll("[data-waiting-survey-review]");
  assert.deepEqual(reviewRows.map(r => r.dataset.waitingSurveyReview), ["q1", "q3"]);
  assert.equal(reviewRows[0].querySelector(".cs-waiting-survey__review-dest").textContent, "Lead · Studio · #design");
  assert.equal(reviewRows[0].querySelector(".cs-waiting-survey__review-answer").textContent, "Ship now");
  assert.equal(reviewRows[1].querySelector(".cs-waiting-survey__review-answer").textContent, "Clear as stale");
  assert.match(body.querySelector(".cs-waiting-survey__skipped").textContent, /1 question skipped/);

  const submitBtn = body.querySelector("[data-waiting-survey-submit]");
  assert.equal(submitBtn.textContent, "Send 1 · Clear 1 stale");
  submitBtn.click();
  assert.equal(committed.length, 2);
  assert.deepEqual(committed.map(e => [e.item.id, e.resolution.kind]), [["q1", "choice"], ["q3", "stale"]]);

  // Edit button jumps straight back to Q1 with draft intact; Back to list keeps drafts
  body.querySelector('[data-waiting-survey-edit="q1"]').click();
  assert.equal(step, 0);
  assert.equal(body.querySelector('[data-waiting-survey-option="a"]').getAttribute("aria-pressed"), "true");
  body.querySelector("[data-waiting-survey-exit]").click();
  assert.equal(exits, 1);
  assert.equal(drafts.size, 3, "exiting survey preserves session drafts");
});

test("renderWaitingPanel exposes Review questions trigger and switches cleanly into survey mode", () => {
  const doc = makeFakeDoc();
  const host = doc.createElement("aside");
  let started = 0;
  const items = [makeChoiceAsk("q1", "First?"), makePlainAsk("q2", "Historical?")];
  const baseVm = {
    scope: "channel",
    place: { workspaceId: "ws-1", workspaceName: "Studio", kind: "channel", channelId: "ch-1", label: "#design" },
    items,
    counts: {
      channel: { min: 2, complete: true },
      workspace: { min: 2, complete: true },
      all: { min: 2, complete: true },
    },
    loading: false,
    complete: true,
    failed: false,
    statusMessage: "",
    statusSeq: 0,
  };
  const handlers = {
    onScopeChange() {},
    onClose() {},
    onRetryLoad() {},
    onSubmitChoice() {},
    onRetryChoice() {},
    onDraftChoice() {},
    onSubmitPlain() {},
    onRetryPlain() {},
    onDraftPlain() {},
    onStartSurvey: () => { started += 1; },
    surveyHandlers: { onExit() {}, onStep() {}, onDraftChange() {}, onSubmitAll() {} },
  };

  renderWaitingPanel(host, baseVm, handlers);
  const trigger = host.querySelector("[data-waiting-review-start]");
  assert.equal(trigger.hidden, false);
  assert.equal(trigger.textContent, "Review questions (2)");
  assert.ok(host.querySelector('[data-waiting-plain-card="q2"]'), "historical plain-text ask renders in list mode");
  trigger.click();
  assert.equal(started, 1);

  renderWaitingPanel(
    host,
    {
      ...baseVm,
      survey: { scope: "channel", items, step: 0, drafts: new Map(), errors: new Map(), sending: false, draftKey: i => i.id },
      focusSurveyHeading: true,
    },
    handlers,
  );
  assert.equal(host.querySelector("[data-waiting-controls]").hidden, true);
  assert.equal(host.querySelector("[data-waiting-survey-heading]").textContent, "Question 1 of 2");
});
