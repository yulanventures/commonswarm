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
