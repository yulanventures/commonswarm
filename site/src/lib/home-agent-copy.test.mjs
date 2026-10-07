import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_COPY,
  agentLineEmpty,
  disconnectedBanner,
  doneRecentlyLimit,
  emptyLine,
  fixActionLabel,
  fixControlAllowed,
  footerNote,
  lineTitle,
  notYetNoteGate,
  notYetTimeGate,
  notYetTodoGate,
  ownershipLine,
  setTimeCopy,
  steeringMay,
  waitingLine,
} from "./home-agent-copy.ts";

const steer = { up: true, down: true, startNow: true, notYet: true, release: true };
const BANNED = /online|offline|\bseat\b|\bgrant\b|\btoken\b|\bturn\b|wake path/iu;
test("ownership line marks you without a visibility claim", () => {
  assert.equal(ownershipLine("Tom", true), "Tom’s agent (you)");
  assert.equal(ownershipLine("Nikki", false), "Nikki’s agent");
  assert.equal(ownershipLine("Marcus", true), "Marcus’s agent (you)");
});

test("disconnected banner uses the measured reason from UI-SPEC 3.5", () => {
  assert.equal(
    disconnectedBanner("Key turned off"),
    "Disconnected: key turned off. Nothing in its line moves until it reconnects.",
  );
  assert.equal(
    disconnectedBanner("Key ended"),
    "Disconnected: key ended. Nothing in its line moves until it reconnects.",
  );
});

test("empty line and footer name the agent and the workspace", () => {
  assert.equal(emptyLine("Claude"), "Nothing in Claude’s line. Assign it a to-do from any to-do page.");
  assert.equal(footerNote("Claude", "Home"), "This page shows Claude in Home.");
  assert.equal(AGENT_COPY.notFound, "Nothing with this link in Home.");
});

test("line title and the waiting count use the line vocabulary", () => {
  assert.equal(lineTitle("Claude"), "Claude’s line");
  assert.equal(waitingLine(1), "1 to-do is waiting in its line.");
  assert.equal(waitingLine(6), "6 to-dos are waiting in its line.");
  assert.equal(waitingLine(0), null);
  assert.equal(waitingLine(-1), null);
  assert.equal(waitingLine(1.5), null);
  assert.doesNotMatch(lineTitle("Claude"), /queue/i);
});

test("R4 set-time copy joins the line and never starts a model", () => {
  const line = setTimeCopy("Claude", "9:00 pm");
  assert.equal(line, "Joins Claude’s line at 9:00 pm. Claude sees it the next time it checks.");
  assert.doesNotMatch(line, /starts at/i);
});

test("not-yet gates match the 3.1 hold lines", () => {
  assert.equal(
    notYetTodoGate("Get quotes", "Claude"),
    "On hold until ‘Get quotes’ is done. It stays out of Claude’s line until then, or until someone releases it.",
  );
  assert.equal(notYetTimeGate("Fri, Oct 9, 9:00 am"), "On hold until Fri, Oct 9, 9:00 am.");
  assert.equal(notYetNoteGate("waiting on the landlord’s reply."), "On hold: waiting on the landlord’s reply.");
});

test("sections empty or full, and Done recently keeps five", () => {
  assert.equal(agentLineEmpty({ doingNow: null, upNext: [], notYet: [], atSetTime: [] }), true);
  assert.equal(agentLineEmpty({ doingNow: { id: "t" }, upNext: [], notYet: [], atSetTime: [] }), false);
  assert.equal(agentLineEmpty({ doingNow: null, upNext: [{}], notYet: [], atSetTime: [] }), false);
  assert.equal(agentLineEmpty({ doingNow: null, upNext: [], notYet: [{}], atSetTime: [] }), false);
  assert.equal(agentLineEmpty({ doingNow: null, upNext: [], notYet: [], atSetTime: [{}] }), false);
  const six = ["a", "b", "c", "d", "e", "f"];
  assert.deepEqual(doneRecentlyLimit(six), ["a", "b", "c", "d", "e"]);
  assert.equal(doneRecentlyLimit(six).length, 5);
  assert.equal(six.length, 6);
});

test("steering may is off for someone else's agent, sample mode, and a false page flag", () => {
  assert.deepEqual(steeringMay(true, false, true, steer), steer);
  assert.deepEqual(steeringMay(false, false, true, steer), {
    up: false, down: false, startNow: false, notYet: false, release: false,
  });
  assert.deepEqual(steeringMay(true, true, true, steer), {
    up: false, down: false, startNow: false, notYet: false, release: false,
  });
  assert.deepEqual(steeringMay(true, false, false, steer), {
    up: false, down: false, startNow: false, notYet: false, release: false,
  });
  const original = { ...steer };
  steeringMay(false, false, true, original);
  assert.deepEqual(original, steer);
});

test("fix labels reuse Resume and Get a new key, never a reconnect control", () => {
  assert.equal(fixActionLabel("resume"), "Resume");
  assert.equal(fixActionLabel("new-key"), "Get a new key");
  assert.equal(fixActionLabel("guide-chat"), null);
  assert.equal(fixActionLabel("guide-local"), null);
  assert.equal(fixActionLabel(null), null);
  for (const action of ["resume", "new-key", "guide-chat", "guide-local", null]) {
    const label = fixActionLabel(action);
    if (label) assert.doesNotMatch(label, /reconnect/i);
  }
});

test("fix controls stay on the viewer's own agent and off in sample mode", () => {
  assert.equal(fixControlAllowed(true, false, true), true);
  assert.equal(fixControlAllowed(false, false, true), false);
  assert.equal(fixControlAllowed(true, true, true), false);
  assert.equal(fixControlAllowed(true, false, false), false);
});

test("agent view copy stays in plain words", () => {
  const samples = [
    ownershipLine("Tom", true),
    ownershipLine("Nikki", false),
    disconnectedBanner("Key turned off"),
    emptyLine("Claude"),
    footerNote("Claude", "Home"),
    lineTitle("Claude"),
    waitingLine(1),
    waitingLine(3),
    setTimeCopy("Claude", "9:00 pm"),
    notYetTodoGate("Get quotes", "Claude"),
    ...Object.values(AGENT_COPY),
  ];
  for (const sample of samples) assert.doesNotMatch(sample, BANNED);
});
