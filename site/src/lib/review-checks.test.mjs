import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildReviewChecksReadRequest,
  groupReviewChecksByThreadRoot,
  parseReviewCheckRecord,
  parseReviewChecksReadOutcome,
  parseStampReviewCheckOutcome,
  reviewCheckStampCommand,
  reviewCheckStatusSummary,
  shortReviewSha,
  upsertReviewCheckInMap,
  viewerRequiredStamp,
} from "./review-checks.ts";
import { buildReviewCheckCard } from "./review-check-card.ts";

class FakeNode {
  tagName;
  nodeType = 1;
  ownerDocument;
  parentNode = null;
  children = [];
  attrs = new Map();
  dataset = {};
  className = "";
  id = "";
  tabIndex = 0;
  disabled = false;
  type = "";
  value = "";
  title = "";
  dateTime = "";
  placeholder = "";
  maxLength = 0;
  autocomplete = "";
  listeners = new Map();
  _text = "";

  constructor(tagName, doc) {
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(val) {
    this.children = [];
    this._text = String(val ?? "");
  }
  append(...items) {
    for (const item of items) {
      if (typeof item === "string") {
        this.children.push(item);
      } else if (item) {
        item.parentNode = this;
        this.children.push(item);
      }
    }
  }
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  dispatch(type, event = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
  walk(predicate, out = []) {
    for (const child of this.children) {
      if (typeof child === "string") continue;
      if (predicate(child)) out.push(child);
      child.walk(predicate, out);
    }
    return out;
  }
}

function fakeDocument() {
  const doc = {
    createElement(tag) {
      return new FakeNode(tag, doc);
    },
  };
  return doc;
}

const WS = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONV = "eeeeeeee-eeee-4eee-8eee-000000000001";
const ROOT = "99999999-9999-4999-8999-000000000010";
const CHECK_1 = "11111111-1111-4111-8111-000000000001";
const VIEWER = "33333333-3333-4333-8333-333333333333";
const AGENT_SEC = "22222222-2222-4222-8222-000000000001";
const AGENT_DES = "22222222-2222-4222-8222-000000000002";
const SHA_1 = "a".repeat(40);
const SHA_2 = "b".repeat(40);

function rawCheck(overrides = {}) {
  return {
    check_id: CHECK_1,
    workspace_id: WS,
    subject: { kind: "pr", repo: "yulanventures/commonswarm", ref: "710" },
    head_sha: SHA_1,
    conversation_id: CONV,
    channel_id: null,
    thread_root_id: ROOT,
    required_seats: [
      { kind: "agent", id: AGENT_SEC, name: "HezSec" },
      { kind: "agent", id: AGENT_DES, name: "Designer" },
      { kind: "user", id: VIEWER, name: "Owner" },
    ],
    stamps: [
      {
        seat_kind: "agent",
        seat_id: AGENT_SEC,
        name: "HezSec",
        verdict: "pass",
        head_sha: SHA_1,
        note: "Clean authz",
        stamped_at: "2026-11-20T18:00:00Z",
        stale: false,
        effective_verdict: "pass",
      },
      {
        seat_kind: "agent",
        seat_id: AGENT_DES,
        name: "Designer",
        verdict: "pass",
        head_sha: "0".repeat(40),
        note: "Old head note must not show",
        stamped_at: "2026-11-20T17:00:00Z",
        stale: true,
        effective_verdict: "pending",
      },
      {
        seat_kind: "user",
        seat_id: VIEWER,
        name: "Owner",
        verdict: null,
        head_sha: null,
        note: null,
        stamped_at: null,
        stale: false,
        effective_verdict: "pending",
      },
    ],
    status: "pending",
    satisfied: false,
    satisfied_head_sha: null,
    satisfied_signal_id: null,
    satisfied_at: null,
    created_at: "2026-11-20T17:00:00Z",
    updated_at: "2026-11-20T18:00:00Z",
    ...overrides,
  };
}

test("C3 review checks wire parser validates records, rejects malformed payloads, and classifies unsupported/denied/stale_head", () => {
  const parsed = parseReviewCheckRecord(rawCheck());
  assert.ok(parsed);
  assert.equal(parsed.checkId, CHECK_1);
  assert.equal(shortReviewSha(parsed.headSha), "aaaaaaaaa");
  assert.equal(parsed.stamps.length, 3);
  assert.equal(parsed.stamps[1].stale, true);
  assert.equal(parsed.stamps[1].effectiveVerdict, "pending");

  assert.equal(parseReviewCheckRecord({ ...rawCheck(), head_sha: "not-a-sha" }), null);
  assert.equal(parseReviewCheckRecord({ ...rawCheck(), subject: { kind: "issue", repo: "a/b", ref: "1" } }), null);

  assert.deepEqual(buildReviewChecksReadRequest(WS, { conversationId: CONV, limit: 50 }), {
    resource: "review_checks",
    workspace_id: WS,
    conversation_id: CONV,
    limit: 50,
  });

  assert.deepEqual(reviewCheckStampCommand(CHECK_1, SHA_1.toUpperCase(), "hold", "  Needs witness  "), {
    kind: "review_check_stamp",
    check_id: CHECK_1,
    head_sha: SHA_1,
    verdict: "hold",
    note: "Needs witness",
  });
  assert.deepEqual(reviewCheckStampCommand(CHECK_1, SHA_1, "pass", "   "), {
    kind: "review_check_stamp",
    check_id: CHECK_1,
    head_sha: SHA_1,
    verdict: "pass",
  });

  assert.equal(parseReviewChecksReadOutcome(200, { review_checks: [rawCheck()] }).status, "ready");
  assert.equal(parseReviewChecksReadOutcome(400, { error: "invalid_request" }).status, "unsupported");
  assert.equal(parseReviewChecksReadOutcome(400, { error: "unsupported_resource" }).status, "unsupported");
  assert.equal(parseReviewChecksReadOutcome(404, { error: "unknown_resource" }).status, "unsupported");
  assert.equal(parseReviewChecksReadOutcome(403, { error: "forbidden" }).status, "denied");
  assert.equal(parseReviewChecksReadOutcome(404, { error: "not_found" }).status, "denied");
  assert.equal(parseReviewChecksReadOutcome(200, { review_checks: [{ bad: true }] }).status, "failed");

  const staleOutcome = parseStampReviewCheckOutcome(409, {
    error: "stale_head",
    current_head_sha: SHA_2,
    message: "Head moved",
  });
  assert.equal(staleOutcome.ok, false);
  if (!staleOutcome.ok) {
    assert.equal(staleOutcome.error, "stale_head");
    assert.equal(staleOutcome.currentHeadSha, SHA_2);
    assert.match(staleOutcome.message, /bbbbbbbbb/);
  }

  const okOutcome = parseStampReviewCheckOutcome(200, {
    status: "accepted",
    review_check: rawCheck({ status: "satisfied", satisfied: true }),
    satisfied_now: true,
    satisfied_signal_id: ROOT,
  });
  assert.equal(okOutcome.ok, true);
  if (okOutcome.ok) {
    assert.equal(okOutcome.satisfiedNow, true);
    assert.equal(okOutcome.satisfiedSignalId, ROOT);
  }
});

test("C3 review checks grouping, upsert, summary, and required-seat viewer check", () => {
  const c1 = parseReviewCheckRecord(rawCheck());
  assert.ok(c1);
  assert.ok(viewerRequiredStamp(c1, VIEWER));
  assert.equal(viewerRequiredStamp(c1, "99999999-9999-4999-8999-999999999999"), null);
  assert.equal(viewerRequiredStamp(c1, AGENT_SEC), null, "agent seat is never interactive for user id");

  const summaryPending = reviewCheckStatusSummary(c1);
  assert.equal(summaryPending.label, "Pending");
  assert.equal(summaryPending.countLabel, "1/3");
  assert.equal(summaryPending.tone, "pending");

  const byRoot = groupReviewChecksByThreadRoot([c1, parseReviewCheckRecord(rawCheck({ check_id: "11111111-1111-4111-8111-000000000002", thread_root_id: null }))]);
  assert.equal(byRoot.size, 1);
  assert.equal(byRoot.get(ROOT)?.length, 1);

  const updated = parseReviewCheckRecord(rawCheck({ status: "satisfied", satisfied: true }));
  const next = upsertReviewCheckInMap(byRoot, updated);
  assert.equal(next.get(ROOT)?.[0]?.status, "satisfied");
});

test("buildReviewCheckCard renders status, stale old-head stamp without stale note, viewer-only actions, and safe textContent", () => {
  const doc = fakeDocument();
  const check = parseReviewCheckRecord(
    rawCheck({
      subject: { kind: "pr", repo: "org/<script>alert(1)</script>", ref: "710" },
    }),
  );
  assert.ok(check);
  const stamped = [];
  const drafts = [];
  const card = buildReviewCheckCard(
    doc,
    {
      check,
      viewerUserId: VIEWER,
      draftNote: "Checking edge case",
      error: "Head moved to bbbbbbbbb.",
    },
    {
      onStamp: (c, v, n) => stamped.push({ id: c.checkId, v, n }),
      onDraftChange: (id, note) => drafts.push({ id, note }),
    },
  );

  assert.equal(card.dataset.reviewCheck, CHECK_1);
  assert.equal(card.dataset.reviewStatus, "pending");
  assert.equal(card.dataset.reviewHead, SHA_1);

  const allText = card.textContent;
  assert.ok(allText.includes("org/<script>alert(1)</script>#710"), "untrusted repo kept as literal textContent");
  assert.ok(allText.includes("@ aaaaaaaaa"), "short head SHA rendered");
  assert.ok(allText.includes("Pending"), "overall status pill rendered");
  assert.ok(allText.includes("1/3"), "pass fraction rendered");
  assert.ok(allText.includes("Clean authz"), "current-head note rendered");
  assert.ok(allText.includes("Pending · old pass @ 000000000"), "stale stamp explains old verdict + old SHA");
  assert.ok(!allText.includes("Old head note must not show"), "stale stamp note must NOT display as current");
  assert.ok(allText.includes("Head moved to bbbbbbbbb."), "inline error banner rendered");

  const noteInput = card.walk((n) => n.dataset.reviewCheckNote === CHECK_1)[0];
  assert.ok(noteInput);
  assert.equal(noteInput.value, "Checking edge case");
  noteInput.value = "Updated note";
  noteInput.dispatch("input");
  assert.deepEqual(drafts, [{ id: CHECK_1, note: "Updated note" }]);

  const passBtn = card.walk((n) => n.dataset.reviewStamp === "pass")[0];
  const holdBtn = card.walk((n) => n.dataset.reviewStamp === "hold")[0];
  assert.ok(passBtn && holdBtn);
  assert.equal(passBtn.getAttribute("aria-pressed"), "false");
  assert.equal(holdBtn.getAttribute("aria-pressed"), "false");
  passBtn.dispatch("click");
  assert.deepEqual(stamped, [{ id: CHECK_1, v: "pass", n: "Updated note" }]);

  // Non-required viewer sees strictly read-only card with zero Pass/Hold buttons.
  const readOnlyCard = buildReviewCheckCard(
    doc,
    { check, viewerUserId: "44444444-4444-4444-8444-444444444444" },
    { onStamp: () => {} },
  );
  assert.equal(readOnlyCard.walk((n) => n.dataset.reviewStamp !== undefined).length, 0);
  assert.equal(readOnlyCard.walk((n) => n.dataset.reviewCheckNote !== undefined).length, 0);
});
