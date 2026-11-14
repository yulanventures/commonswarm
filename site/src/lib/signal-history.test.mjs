import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextFeedChangeAt, signalEndsWithUntil, signalHasEnded, signalHistoryFilter, signalIsReadable, signalLeavesAt,
} from "./signal-history.ts";
import { isOpenAskToViewer } from "./home-stream.ts";

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const PAST = "2026-11-01T00:00:00.000Z";
const FUTURE = "2026-12-01T00:00:00.000Z";
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const row = (over = {}) => ({ from: OTHER, fromKind: "user", toAgent: null, kind: "note", until: PAST, ...over });

test("a note or an ask stays readable after its until, addressed or not", () => {
  for (const signal of [
    row(),
    row({ kind: "ask" }),
    row({ toAgent: AGENT }),
    row({ from: AGENT, fromKind: "agent" }),
    // An agent writing to a different agent is conversation, not a note to itself.
    row({ from: AGENT, fromKind: "agent", toAgent: OTHER }),
    // A person whose id happens to equal the addressed agent's is still a person.
    row({ from: AGENT, fromKind: "user", toAgent: AGENT }),
  ]) {
    assert.equal(signalIsReadable(signal, NOW), true, JSON.stringify(signal));
    assert.equal(signalLeavesAt(signal), null);
  }
});

test("a working-on status and an agent's note to itself end with their until", () => {
  for (const signal of [
    row({ kind: "working-on" }),
    row({ kind: "working-on", from: AGENT, fromKind: "agent" }),
    row({ from: AGENT, fromKind: "agent", toAgent: AGENT }),
    row({ kind: "ask", from: AGENT, fromKind: "agent", toAgent: AGENT }),
    // A kind this browser does not know is not assumed to be conversation.
    row({ kind: "heartbeat" }),
  ]) {
    assert.equal(signalEndsWithUntil(signal), true, JSON.stringify(signal));
    assert.equal(signalIsReadable(signal, NOW), false);
    assert.equal(signalIsReadable({ ...signal, until: FUTURE }, NOW), true);
    assert.equal(signalLeavesAt({ ...signal, until: FUTURE }), Date.parse(FUTURE));
    assert.equal(signalIsReadable({ ...signal, until: null }, NOW), true, "no until never ends");
  }
});

test("the boundary is exclusive and an unreadable until hides only a row that can end", () => {
  const status = row({ kind: "working-on", until: new Date(NOW).toISOString() });
  assert.equal(signalIsReadable(status, NOW), false, "ends at its until, not after it");
  assert.equal(signalIsReadable(status, NOW - 1), true);
  assert.equal(signalIsReadable(row({ kind: "working-on", until: "not a date" }), NOW), false);
  assert.equal(signalIsReadable(row({ until: "not a date" }), NOW), true);
});

test("the page filter asks for unexpired rows and for conversation of any age", () => {
  assert.equal(signalHistoryFilter("2026-11-13T12:00:00.000Z"),
    "until.is.null,until.gt.2026-11-13T12:00:00.000Z,kind.in.(note,ask)");
});

test("an ask kept as history is ended: it is readable and no longer open to answer", () => {
  const ask = row({ kind: "ask" });
  assert.equal(signalIsReadable(ask, NOW), true);
  assert.equal(signalHasEnded(ask, NOW), true);
  assert.equal(signalHasEnded({ until: FUTURE }, NOW), false);
  assert.equal(signalHasEnded({ until: null }, NOW), false);
  assert.equal(signalHasEnded({ until: "not a date" }, NOW), false);
  const open = { kind: "ask", addressedToViewer: true, answered: false };
  assert.equal(isOpenAskToViewer(open), true);
  assert.equal(isOpenAskToViewer({ ...open, ended: false }), true);
  assert.equal(isOpenAskToViewer({ ...open, ended: true }), false, "no Reply card on an ended ask");
});

test("the feed repaints at the soonest until still ahead, including a note that will stay", () => {
  const SOON = "2026-11-13T12:05:00.000Z";
  // A note stays in the feed after its until, and still has to lose its thread control and choices then.
  assert.equal(signalLeavesAt(row({ until: SOON })), null);
  assert.equal(nextFeedChangeAt([row({ until: SOON })], NOW), Date.parse(SOON));
  assert.equal(nextFeedChangeAt([row({ until: FUTURE }), row({ kind: "ask", until: SOON }), row({ kind: "working-on", until: FUTURE })], NOW),
    Date.parse(SOON));
  // Rows already past their until, with none, or with one that does not parse schedule nothing.
  assert.equal(nextFeedChangeAt([row(), row({ until: null }), row({ until: "not a date" })], NOW), null);
  assert.equal(nextFeedChangeAt([row({ until: new Date(NOW).toISOString() })], NOW), null, "the boundary itself is already past");
  assert.equal(nextFeedChangeAt([], NOW), null);
});
