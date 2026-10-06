import assert from "node:assert/strict";
import { test } from "node:test";

import { AGENT_INACTIVE_AFTER_MS, agentStatus } from "./agent-status.ts";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const row = (overrides = {}) => ({
  last_command_at: null,
  client_build: null,
  watcher_at: null,
  channel_at: null,
  listener_at: null,
  turn_at: null,
  last_ack_via: null,
  last_ack_at: null,
  current_client_build: null,
  ...overrides,
});

test("hosted agents say they check when you chat, never that they wake", () => {
  const status = agentStatus({ transport: "hosted_mcp", turnOnly: true, presence: row({ last_command_at: at(60_000) }) }, NOW);
  assert.equal(status.kind, "active");
  assert.equal(status.chip, "Active now");
  assert.equal(status.receive, "Checks messages when you chat with it.");
  assert.doesNotMatch(JSON.stringify(status), /wake|online|listener|seat/iu);
});

test("a local agent with a live push route gets messages as they arrive; a stale one does not", () => {
  const live = agentStatus({ transport: "local", presence: row({ last_command_at: at(30 * 60_000), watcher_at: at(10_000) }) }, NOW);
  assert.equal(live.receive, "Gets messages as they arrive.");
  assert.equal(live.chip, "Active 30 min ago");
  const turn = agentStatus({ transport: "local", presence: row({ last_command_at: at(60_000), turn_at: at(60_000) }) }, NOW);
  assert.equal(turn.receive, "Checks messages each time it starts a task.");
  const unknown = agentStatus({ transport: "local", presence: row({ last_command_at: at(60_000) }) }, NOW);
  assert.equal(unknown.receive, null);
});

test("silence past three days reads as not active, in days", () => {
  const status = agentStatus({ transport: "hosted_mcp", presence: row({ last_command_at: at(AGENT_INACTIVE_AFTER_MS + 86_400_000) }) }, NOW);
  assert.equal(status.kind, "inactive");
  assert.equal(status.chip, "Not active for 4 days");
  // Control just inside the boundary.
  assert.equal(agentStatus({ transport: "hosted_mcp", presence: row({ last_command_at: at(AGENT_INACTIVE_AFTER_MS - 60_000) }) }, NOW).kind, "active");
});

test("revoked and suspended outrank activity; no presence row claims nothing", () => {
  const recent = row({ last_command_at: at(1_000) });
  assert.equal(agentStatus({ transport: "hosted_mcp", presence: recent, revoked: true }, NOW).chip, "Removed");
  assert.equal(agentStatus({ transport: "local", presence: recent, suspended: true }, NOW).chip, "Needs reconnecting");
  const unknown = agentStatus({ transport: "hosted_mcp" }, NOW);
  assert.equal(unknown.kind, "connected");
  assert.equal(unknown.chip, "Connected");
  const never = agentStatus({ transport: "hosted_mcp", presence: null }, NOW);
  assert.equal(never.chip, "Not active yet");
});


import { peopleAgentStatus, peopleAgentActivityTime, agentResumeReceipt } from "./agent-status.ts";
const key = (overrides = {}) => ({ kind: "standing", horizonExpiresAt: null, boundDeviceId: "computer", lastUsedAt: at(60_000), issuedAt: at(30 * 86400000), newHostAt: null, suspendedAt: null, revokedAt: null, ...overrides });
const input = (overrides = {}) => ({ transport: "local", ownerName: "Mei Langridge", own: true, mayManage: true, sample: false, presence: row({ last_command_at: at(1000) }), ...overrides });

test("dialog status precedence: revoked, ended, paused, messages, expiry, new computer, activity", () => {
  const collision = key({ suspendedAt: at(1000), newHostAt: at(1000), revokedAt: at(1000) });
  const oldestUnobservedAt = at(5 * 60000);
  const cases = [
    ["key-off", "Key turned off", { grant: collision, oldestUnobservedAt }],
    ["key-ended", "Key ended", { grant: key({ kind: "timeboxed", horizonExpiresAt: at(1), newHostAt: at(1000) }), oldestUnobservedAt }],
    ["paused", "Paused: unused for 14 days", { grant: key({ suspendedAt: at(1000), newHostAt: at(1000) }), oldestUnobservedAt }],
    ["stale-messages", "Hasn’t picked up messages for 3+ min", { grant: key({ kind: "timeboxed", horizonExpiresAt: at(-86400000), newHostAt: at(1000) }), oldestUnobservedAt }],
    ["key-ends-soon", "Key ends in 1 day", { grant: key({ kind: "timeboxed", horizonExpiresAt: at(-86400000), newHostAt: at(1000) }) }],
    ["new-computer", "Used from a new computer", { grant: key({ newHostAt: at(1000) }) }],
    ["inactive", "Not active for 15 days", { presence: row({ last_command_at: at(15 * 86400000) }) }],
    ["idle", "Not active yet", { presence: null }],
    ["connected", "Connected", { presence: undefined }],
    ["active", "Active now", {}],
    ["active", "Active 2 hours ago", { presence: row({ last_command_at: at(2 * 3600000) }) }],
    ["active", "Active 10 hours ago", { presence: row({ last_command_at: at(10 * 3600000) }) }],
    ["active", "Active 3 hours ago", { presence: row({ last_command_at: at(3 * 3600000) }) }],
  ];
  for (const [kind, label, facts] of cases) { const status = peopleAgentStatus(input(facts), NOW); assert.equal(status.kind, kind); assert.equal(status.label, label); assert.equal(status.attention, ["key-off", "key-ended", "paused", "stale-messages", "key-ends-soon", "new-computer"].includes(kind)); }
  assert.equal(peopleAgentStatus(input({ grant: key({ kind: "timeboxed", horizonExpiresAt: at(-4 * 86400000) }) }), NOW).kind, "active");
});

test("resume is available to managers, new keys to the agent owner, and sample mode has no fixes", () => {
  for (const [own, mayManage, expected] of [[true,true,true],[false,true,true],[false,false,false]]) {
    const paused = peopleAgentStatus(input({ own, mayManage, grant: key({ suspendedAt: at(1000) }) }), NOW);
    assert.equal(paused.fix.action, "resume"); assert.equal(paused.fix.allowed, expected);
    assert.equal(paused.fix.askWho, expected ? null : "Mei");
    const off = peopleAgentStatus(input({ own, mayManage, grant: key({ revokedAt: at(1000) }) }), NOW);
    assert.equal(off.fix.action, "new-key"); assert.equal(off.fix.allowed, own);
  }
  assert.equal(peopleAgentStatus(input({ sample: true, grant: key({ suspendedAt: at(1) }) }), NOW).fix.allowed, false);
  const orphan = peopleAgentStatus(input({ ownerName: null, own: false, mayManage: false, grant: key({ suspendedAt: at(1) }) }), NOW);
  assert.equal(orphan.sentence, "Ask a workspace owner, an admin, or the member who added the agent to resume it.");
});

test("chat-app agents without a key have message guidance and never key states", () => {
  const hosted = peopleAgentStatus(input({ transport: "hosted_mcp", app: "Claude", grant: null, oldestUnobservedAt: at(180000) }), NOW);
  assert.equal(hosted.kind, "stale-messages"); assert.equal(hosted.fix.action, "guide-chat");
  assert.equal(hosted.sentence, "Open the chat app you use it in and say: check CommonSwarm.");
  const local = peopleAgentStatus(input({ oldestUnobservedAt: at(180000) }), NOW);
  assert.equal(local.sentence, "Start its cswarm process."); assert.equal(local.fix.action, "guide-local");
  assert.equal(peopleAgentStatus(input({ oldestUnobservedAt: at(179999) }), NOW).kind, "active");
});

test("resume preserves last activity: idle 15 days becomes inactive, never Active now", () => {
  const facts = input({ presence: row({ last_command_at: at(15 * 86400000) }), grant: key({ suspendedAt: at(1) }) });
  assert.equal(peopleAgentStatus(facts, NOW).kind, "paused");
  const resumed = peopleAgentStatus({ ...facts, grant: { ...facts.grant, suspendedAt: null } }, NOW);
  assert.equal(resumed.label, "Not active for 15 days"); assert.equal(resumed.attention, false);
  assert.equal(peopleAgentActivityTime(facts.presence.last_command_at, NOW), "15 days ago");
  assert.equal(agentResumeReceipt("Codex"), "Resumed. Nothing has reached Codex yet. It renews the next time it starts. Another 14 days without use will pause it again.");
});

import { homeAgentState, WORK_RECENT_MS } from "./agent-status.ts";

test("home work needs recent server activity and an unexpired work claim or Doing to-do", () => {
  assert.equal(WORK_RECENT_MS, 1800000);
  const workingOn = { title: "Budget sheet", createdAt: at(12 * 60000), until: at(-86400000) };
  const doingTodo = { title: "Book plumber", since: at(20 * 60000) };
  for (const facts of [{ workingOn }, { doingTodo }, { workingOn, doingTodo }]) {
    assert.equal(homeAgentState(input(facts), NOW).word, "Working");
    assert.equal(homeAgentState(input({ ...facts, lastActionAt: at(WORK_RECENT_MS) }), NOW).word, "Working");
    assert.equal(homeAgentState(input({ ...facts, workingOn: facts.workingOn ? { ...facts.workingOn, createdAt: at(WORK_RECENT_MS + 1) } : null, doingTodo: facts.doingTodo ? { ...facts.doingTodo, since: at(WORK_RECENT_MS + 1) } : null, presence: null, lastActionAt: at(WORK_RECENT_MS + 1) }), NOW).word, "Idle");
    assert.equal(homeAgentState(input({ ...facts, workingOn: facts.workingOn ? { ...facts.workingOn, createdAt: "invalid" } : null, doingTodo: facts.doingTodo ? { ...facts.doingTodo, since: "invalid" } : null, presence: null, lastActionAt: "invalid" }), NOW).word, "Idle");
    assert.equal(homeAgentState(input({ ...facts, workingOn: facts.workingOn ? { ...facts.workingOn, createdAt: "invalid" } : null, doingTodo: facts.doingTodo ? { ...facts.doingTodo, since: "invalid" } : null, presence: null, lastActionAt: at(-1000) }), NOW).word, "Idle");
  }
  assert.equal(homeAgentState(input({ workingOn: { ...workingOn, until: at(0) } }), NOW).word, "Idle");
  assert.equal(homeAgentState(input(), NOW).word, "Idle");
  assert.equal(homeAgentState(input({ workingOn }), NOW).detail, "Said it’s working on ‘Budget sheet’ · 12 minutes ago");
  const clock = new Date(2026, 9, 5, 10, 0).getTime();
  const doing = homeAgentState(input({ doingTodo: { title: "Book plumber", since: new Date(2026, 9, 5, 9, 40).toISOString() }, lastActionAt: new Date(clock - 60000).toISOString() }), clock);
  assert.equal(doing.detail, "Doing ‘Book plumber’ since 9:40 am");
  assert.equal(homeAgentState(input({ doingTodo: { ...doingTodo, since: at(3 * 3600000) }, presence: null, lastActionAt: at(3 * 3600000) }), NOW).detail, "Last active 3 hours ago; ‘Book plumber’ is still in Doing");
});

test("home disconnect and local message guidance reuse the dialog fixes", () => {
  const workingOn = { title: "Budget sheet", createdAt: at(60000), until: at(-60000) };
  for (const [facts, detail] of [
    [{ revoked: true }, "Removed"], [{ suspended: true }, "Needs reconnecting"],
    [{ grant: key({ revokedAt: at(1) }) }, "Key turned off"],
    [{ grant: key({ kind: "timeboxed", horizonExpiresAt: at(1) }) }, "Key ended"],
    [{ grant: key({ suspendedAt: at(1) }) }, "Paused: unused for 14 days"],
  ]) {
    const s = homeAgentState(input({ ...facts, workingOn, hasWakePath: true, oldestUnobservedAt: at(180000) }), NOW);
    assert.equal(s.kind, "disconnected"); assert.equal(s.word, "Disconnected"); assert.equal(s.detail, detail);
  }
  const paused = homeAgentState(input({ own: false, mayManage: false, grant: key({ suspendedAt: at(1) }) }), NOW);
  assert.equal(paused.fix.action, "resume"); assert.equal(paused.fix.allowed, false); assert.equal(paused.fix.sentence, "Ask Mei to resume it.");
  const sample = homeAgentState(input({ sample: true, grant: key({ revokedAt: at(1) }) }), NOW);
  assert.equal(sample.fix.allowed, false);
  const clock = new Date(2026, 9, 5, 10, 10).getTime();
  const waiting = new Date(2026, 9, 5, 10, 5).toISOString();
  const local = homeAgentState(input({ oldestUnobservedAt: waiting, hasWakePath: true }), clock);
  assert.equal(local.word, "Not picking up"); assert.equal(local.detail, "A message has waited since 10:05 am"); assert.equal(local.fix.action, "guide-local");
  const noPath = homeAgentState(input({ oldestUnobservedAt: waiting }), clock);
  assert.equal(noPath.word, "Idle"); assert.equal(noPath.attention, false);
});

test("hosted waiting messages remain idle and describe the actual person who chats", () => {
  const clock = new Date(2026, 9, 5, 10, 10).getTime();
  const facts = input({ transport: "hosted_mcp", presence: null, own: false, ownerName: "Nikki Cooper", ownerFirstName: "Nikki", oldestUnobservedAt: new Date(2026, 9, 5, 10, 5).toISOString() });
  const status = homeAgentState(facts, clock);
  assert.equal(status.word, "Idle"); assert.equal(status.attention, false); assert.equal(status.fix.action, null);
  assert.equal(status.detail, "Messages waiting since 10:05 am. Checks messages when Nikki chats with it.");
  assert.equal(agentStatus(facts, clock).receive, "Checks messages when Nikki chats with it.");
  assert.equal(peopleAgentStatus({ ...facts, oldestUnobservedAt: null }, clock).sentence, "Checks messages when Nikki chats with it.");
  assert.equal(homeAgentState({ ...facts, oldestUnobservedAt: null }, clock).detail, "No activity reported yet");
  assert.equal(agentStatus({ transport: "hosted_mcp", own: false }, clock).receive, "Checks messages when its owner chats with it.");
});

test("server work wins over work derivation while credential faults still disconnect", () => {
  assert.equal(homeAgentState(input({ serverWork: "working", presence: null }), NOW).word, "Working");
  assert.equal(homeAgentState(input({ serverWork: "idle", grant: key({ revokedAt: at(1) }) }), NOW).word, "Disconnected");
  assert.equal(homeAgentState(input({ serverWork: "idle", grant: key({ revokedAt: at(1) }) }), NOW).attention, true);
  assert.equal(homeAgentState(input({ serverWork: "disconnected" }), NOW).word, "Disconnected");
  assert.equal(homeAgentState(input({ serverWork: "idle", doingTodo: { title: "Plumber" } }), NOW).word, "Idle");
});

test("server work classification preserves credential details and repair guidance", () => {
  const cases = [
    [{ grant: key({ revokedAt: at(1) }) }, "Key turned off", "new-key", "It needs a new key to connect again."],
    [{ grant: key({ kind: "timeboxed", horizonExpiresAt: at(1) }) }, "Key ended", "new-key", "It needs a new key to connect again."],
    [{ grant: key({ suspendedAt: at(1) }) }, "Paused: unused for 14 days", "resume", "Resume it so it can connect again."],
    [{ suspended: true }, "Needs reconnecting", null, "Connect it again from its app."],
    [{ revoked: true }, "Removed", null, "It can no longer read or post."],
  ];
  for (const serverWork of ["idle", "working", "disconnected"]) {
    for (const presence of [row({ last_command_at: at(1000) }), null, undefined]) {
      for (const [facts, detail, action, sentence] of cases) {
        const status = homeAgentState(input({ ...facts, presence, serverWork }), NOW);
        assert.equal(status.kind, "disconnected");
        assert.equal(status.word, "Disconnected");
        assert.equal(status.detail, detail);
        assert.equal(status.attention, true);
        assert.equal(status.fix.action, action);
        assert.equal(status.fix.sentence, sentence);
        assert.equal(status.fix.allowed, action !== null);
      }
    }
  }
  const other = homeAgentState(input({ serverWork: "idle", own: false, grant: key({ revokedAt: at(1) }) }), NOW);
  assert.equal(other.detail, "Key turned off");
  assert.deepEqual(other.fix, { action: "new-key", allowed: false, askWho: "Mei", sentence: "Ask Mei to get a new key." });
  const sample = homeAgentState(input({ serverWork: "idle", sample: true, grant: key({ revokedAt: at(1) }) }), NOW);
  assert.equal(sample.fix.allowed, false);
  assert.equal(sample.fix.sentence, "It needs a new key to connect again.");
  const healthy = homeAgentState(input({ serverWork: "idle" }), NOW);
  assert.equal(healthy.detail, "Active now");
  assert.equal(healthy.attention, false);
  assert.deepEqual(healthy.fix, { action: null, allowed: false, askWho: null, sentence: "" });
});

test("server idle suppresses local stale-message status and its repair notice", () => {
  const facts = input({ hasWakePath: true, oldestUnobservedAt: at(180000) });
  assert.equal(homeAgentState(facts, NOW).word, "Not picking up");
  const idle = homeAgentState({ ...facts, serverWork: "idle" }, NOW);
  assert.equal(idle.word, "Idle");
  assert.equal(idle.detail, "Active now");
  assert.equal(idle.attention, false);
  assert.deepEqual(idle.fix, { action: null, allowed: false, askWho: null, sentence: "" });
});

test("AM12 fresh working-on and Doing timestamps are recent server actions", () => {
  const quiet = input({ presence: null, lastActionAt: at(3 * 3600000) });
  assert.equal(homeAgentState({ ...quiet, workingOn: { title: "Budget", createdAt: at(60000), until: at(-60000) } }, NOW).word, "Working");
  assert.equal(homeAgentState({ ...quiet, doingTodo: { title: "Budget", since: at(60000) } }, NOW).word, "Working");
  assert.equal(homeAgentState({ ...quiet, doingTodo: { title: "Budget", since: at(-1000) } }, NOW).word, "Idle");
});
