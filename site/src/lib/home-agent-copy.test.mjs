import assert from "node:assert/strict";
import { test } from "node:test";
import { WAKE_STALE_MS } from "../../../src/cloud/idle-poll.ts";
import { peopleAgentStatus } from "./agent-status.ts";
import { STANDING_IDLE_PAUSE_DAYS } from "./standing-grants.ts";
import {
  AGENT_COPY,
  agentLineEmpty,
  disconnectedBanner,
  disconnectDetail,
  doneRecentlyLimit,
  emptyLine,
  fixActionLabel,
  fixControlAllowed,
  footerNote,
  homeAgentStatusCopy,
  hostedWaitingDetail,
  IDLE_CHIPS,
  notPickingUpDetail,
  notYetNoteGate,
  notYetTimeGate,
  notYetTodoGate,
  ownershipLine,
  receiveSentence,
  setTimeCopy,
  staleDoingDetail,
  steeringMay,
  workingDoingDetail,
  workingOnDetail,
} from "./home-agent-copy.ts";

const steer = { up: true, down: true, startNow: true, notYet: true, release: true };
const BANNED = /online|offline|\bseat\b|\bgrant\b|\btoken\b|\bturn\b|wake path/iu;
const NOW = Date.parse("2026-10-05T12:00:00.000Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const ONE_SECOND = 1_000;
const FOUR_MINUTES = 4 * 60_000;
const facts = (overrides = {}) => ({
  disconnect: null, hosted: true, localInbox: false, waitingSince: null, staleMessages: false,
  doingTitle: null, doingSince: null, workingOnTitle: null, workingOnWhen: null,
  recentAction: false, lastActive: null, idleChip: "Active 2 hours ago",
  ...overrides,
});
const peopleFacts = (overrides = {}) => ({
  transport: "local", ownerName: "Tom Langridge", own: true, mayManage: true, sample: false,
  presence: null, grant: null, ...overrides,
});

test("ownership line marks you without a visibility claim", () => {
  assert.equal(ownershipLine("Tom", true), "Tom’s agent (you)");
  assert.equal(ownershipLine("Nikki", false), "Nikki’s agent");
  assert.equal(ownershipLine("Marcus", true), "Marcus’s agent (you)");
});

test("receive sentence names the owner for someone else's chat-app agent", () => {
  assert.equal(
    receiveSentence({ hosted: true, yours: true, ownerFirstName: "Tom", livePush: false, checksOnTask: true }),
    "Checks messages when you chat with it.",
  );
  assert.equal(
    receiveSentence({ hosted: true, yours: false, ownerFirstName: "Nikki", livePush: false, checksOnTask: true }),
    "Checks messages when Nikki chats with it.",
  );
  assert.equal(
    receiveSentence({ hosted: false, yours: true, ownerFirstName: "Tom", livePush: true, checksOnTask: false }),
    "Gets messages as they arrive.",
  );
  assert.equal(
    receiveSentence({ hosted: false, yours: true, ownerFirstName: "Tom", livePush: false, checksOnTask: true }),
    "Checks messages each time it starts a task.",
  );
  assert.equal(
    receiveSentence({ hosted: false, yours: true, ownerFirstName: "Tom", livePush: false, checksOnTask: false }),
    "Message checks have not been reported.",
  );
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

test("R1 disconnected details are the credential facts, including the pause constant", () => {
  assert.equal(STANDING_IDLE_PAUSE_DAYS, 14);
  assert.equal(disconnectDetail("key-off"), "Key turned off");
  assert.equal(disconnectDetail("key-ended"), "Key ended");
  assert.equal(disconnectDetail("paused"), "Paused: unused for 14 days");
  assert.equal(disconnectDetail("needs-reconnecting"), "Needs reconnecting");
  assert.equal(disconnectDetail("removed"), "Removed");
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      disconnect: "key-off", hosted: false, localInbox: true, waitingSince: "10:05 am",
      staleMessages: true, doingTitle: "Book plumber", doingSince: "9:40 am",
      workingOnTitle: "Budget sheet", workingOnWhen: "12 minutes ago", recentAction: true,
      lastActive: "3 hours ago",
    })),
    { kind: "disconnected", word: "Disconnected", detail: "Key turned off" },
  );
});

test("R1 Not picking up is only for a local agent with a receive path; a chat-app wait is Idle", () => {
  assert.equal(notPickingUpDetail("10:05 am"), "A message has waited since 10:05 am");
  assert.equal(hostedWaitingDetail("10:05 am"), "Messages waiting since 10:05 am");
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      hosted: false, localInbox: true, waitingSince: "10:05 am", staleMessages: true,
    })),
    { kind: "disconnected", word: "Not picking up", detail: "A message has waited since 10:05 am" },
  );
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      waitingSince: "10:05 am", idleChip: "Not active yet",
    })),
    { kind: "idle", word: "Idle", detail: "Messages waiting since 10:05 am" },
  );
  assert.notEqual(
    homeAgentStatusCopy(facts({
      hosted: true, localInbox: true, waitingSince: "10:05 am", staleMessages: true,
      idleChip: "Not active yet",
    })).word,
    "Not picking up",
  );
});

test("R1 Not picking up reuses peopleAgentStatus stale-messages, not any waiting clock", () => {
  assert.ok(ONE_SECOND < WAKE_STALE_MS);
  assert.ok(FOUR_MINUTES >= WAKE_STALE_MS);
  const freshPeople = peopleAgentStatus(peopleFacts({ oldestUnobservedAt: ago(ONE_SECOND) }), NOW);
  assert.notEqual(freshPeople.kind, "stale-messages");
  assert.equal(freshPeople.attention, false);
  const freshCopy = homeAgentStatusCopy(facts({
    hosted: false, localInbox: true, waitingSince: "10:05 am",
    staleMessages: freshPeople.kind === "stale-messages",
  }));
  assert.notEqual(freshCopy.word, "Not picking up");
  assert.deepEqual(freshCopy, { kind: "idle", word: "Idle", detail: "Active 2 hours ago" });
  const waitingOnly = homeAgentStatusCopy(facts({
    hosted: false, localInbox: true, waitingSince: "10:05 am", staleMessages: false,
  }));
  assert.notEqual(waitingOnly.word, "Not picking up");
  const stalePeople = peopleAgentStatus(peopleFacts({ oldestUnobservedAt: ago(FOUR_MINUTES) }), NOW);
  assert.equal(stalePeople.kind, "stale-messages");
  assert.equal(stalePeople.attention, true);
  const staleCopy = homeAgentStatusCopy(facts({
    hosted: false, localInbox: true, waitingSince: "10:05 am",
    staleMessages: stalePeople.kind === "stale-messages",
  }));
  assert.deepEqual(staleCopy, {
    kind: "disconnected", word: "Not picking up", detail: "A message has waited since 10:05 am",
  });
  const hostedStalePeople = peopleAgentStatus(peopleFacts({
    transport: "hosted_mcp", oldestUnobservedAt: ago(FOUR_MINUTES),
  }), NOW);
  assert.equal(hostedStalePeople.kind, "stale-messages");
  const hostedCopy = homeAgentStatusCopy(facts({
    hosted: true, localInbox: false, waitingSince: "10:05 am",
    staleMessages: hostedStalePeople.kind === "stale-messages",
  }));
  assert.deepEqual(hostedCopy, {
    kind: "idle", word: "Idle", detail: "Messages waiting since 10:05 am",
  });
  assert.notEqual(hostedCopy.word, "Not picking up");
});

test("R1 Working needs a recent action; a stale Doing row stays Idle", () => {
  assert.equal(workingDoingDetail("Book plumber", "9:40 am"), "Doing ‘Book plumber’ since 9:40 am");
  assert.equal(
    workingOnDetail("Budget sheet", "12 minutes ago"),
    "Said it’s working on ‘Budget sheet’ · 12 minutes ago",
  );
  assert.equal(
    staleDoingDetail("3 hours ago", "X"),
    "Last active 3 hours ago; ‘X’ is still in Doing",
  );
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      doingTitle: "Book plumber", doingSince: "9:40 am", recentAction: true, lastActive: "9:40 am",
    })),
    { kind: "working", word: "Working", detail: "Doing ‘Book plumber’ since 9:40 am" },
  );
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      workingOnTitle: "Budget sheet", workingOnWhen: "12 minutes ago", recentAction: true,
    })),
    { kind: "working", word: "Working", detail: "Said it’s working on ‘Budget sheet’ · 12 minutes ago" },
  );
  const stale = homeAgentStatusCopy(facts({
    doingTitle: "X", doingSince: "9:40 am", workingOnTitle: "Budget sheet",
    workingOnWhen: "12 minutes ago", lastActive: "3 hours ago",
  }));
  assert.deepEqual(stale, { kind: "idle", word: "Idle", detail: "Last active 3 hours ago; ‘X’ is still in Doing" });
  assert.notEqual(stale.word, "Working");
});

test("R1 Working outranks waiting messages for both hosted and local agents", () => {
  const hostedWork = homeAgentStatusCopy(facts({
    waitingSince: "10:05 am", staleMessages: true, doingTitle: "Book plumber",
    doingSince: "9:40 am", recentAction: true, lastActive: "9:40 am",
  }));
  assert.deepEqual(hostedWork, {
    kind: "working", word: "Working", detail: "Doing ‘Book plumber’ since 9:40 am",
  });
  assert.notEqual(hostedWork.word, "Idle");
  const hostedOn = homeAgentStatusCopy(facts({
    waitingSince: "10:05 am", staleMessages: true, workingOnTitle: "Budget sheet",
    workingOnWhen: "12 minutes ago", recentAction: true,
  }));
  assert.deepEqual(hostedOn, {
    kind: "working", word: "Working", detail: "Said it’s working on ‘Budget sheet’ · 12 minutes ago",
  });
  const localWork = homeAgentStatusCopy(facts({
    hosted: false, localInbox: true, waitingSince: "10:05 am", staleMessages: true,
    doingTitle: "Book plumber", doingSince: "9:40 am", recentAction: true, lastActive: "9:40 am",
  }));
  assert.deepEqual(localWork, {
    kind: "working", word: "Working", detail: "Doing ‘Book plumber’ since 9:40 am",
  });
  assert.notEqual(localWork.word, "Not picking up");
  assert.deepEqual(
    homeAgentStatusCopy(facts({
      waitingSince: "10:05 am", doingTitle: "Book plumber", doingSince: "9:40 am",
      lastActive: "3 hours ago",
    })),
    { kind: "idle", word: "Idle", detail: "Messages waiting since 10:05 am" },
  );
});

test("R1 idle chips are the measured activity lines, including no presence row", () => {
  for (const chip of IDLE_CHIPS) {
    assert.deepEqual(
      homeAgentStatusCopy(facts({ idleChip: chip })),
      { kind: "idle", word: "Idle", detail: chip },
    );
  }
  assert.equal(IDLE_CHIPS[3], "No activity reported yet");
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
    receiveSentence({ hosted: true, yours: false, ownerFirstName: "Nikki", livePush: false, checksOnTask: true }),
    disconnectedBanner("Key turned off"),
    emptyLine("Claude"),
    footerNote("Claude", "Home"),
    setTimeCopy("Claude", "9:00 pm"),
    notYetTodoGate("Get quotes", "Claude"),
    workingDoingDetail("Book plumber", "9:40 am"),
    workingOnDetail("Budget sheet", "12 minutes ago"),
    staleDoingDetail("3 hours ago", "X"),
    notPickingUpDetail("10:05 am"),
    hostedWaitingDetail("10:05 am"),
    ...Object.values(AGENT_COPY),
    ...IDLE_CHIPS,
    disconnectDetail("paused"),
  ];
  for (const sample of samples) assert.doesNotMatch(sample, BANNED);
});
