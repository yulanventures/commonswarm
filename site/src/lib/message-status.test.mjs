/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  latestMessagesToAgents,
  messageStatusText,
  parseAgentStatusEvent,
  parseMessageStatus,
} from "./message-status.ts";

const WS = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const OTHER_AGENT = "33333333-3333-4333-8333-333333333333";
const SIGNAL = "44444444-4444-4444-8444-444444444444";
const VIEWER = "55555555-5555-4555-8555-555555555555";

const row = (overrides = {}) => ({
  signal_id: SIGNAL, agent_principal_id: AGENT, delivered: true, seen: true, replied: false, working: null, ...overrides,
});

test("message_status rows parse, and malformed replies are unavailable rather than guessed", () => {
  const until = "2026-11-07T00:02:00.000Z";
  assert.deepEqual(parseMessageStatus({ statuses: [row({ working: { label: "editing", until } })] }), [{
    signalId: SIGNAL, agentPrincipalId: AGENT, delivered: true, seen: true, replied: false,
    working: { label: "editing", until: Date.parse(until) },
  }]);
  assert.deepEqual(parseMessageStatus({ statuses: [] }), []);
  for (const bad of [null, {}, { statuses: {} }, { statuses: [row({ seen: null })] }, { statuses: [row({ signal_id: "x" })] },
    { statuses: [row({ working: { label: "Bash", until } })] }, { statuses: [row({ working: { label: "editing", until: "soon" } })] }]) {
    assert.equal(parseMessageStatus(bad), null);
  }
});

test("the line says Replied, then unexpired Working with its label, then Seen, then Delivered", () => {
  const now = Date.parse("2026-11-07T00:00:00.000Z");
  const base = { signalId: SIGNAL, agentPrincipalId: AGENT, delivered: false, seen: false, replied: false, working: null };
  assert.equal(messageStatusText(base, now), null, "not yet delivered: the receipt covers it");
  assert.equal(messageStatusText({ ...base, delivered: true }, now), "Delivered");
  assert.equal(messageStatusText({ ...base, delivered: true, seen: true }, now), "Seen");
  const working = { ...base, delivered: true, seen: true, working: { label: "running_command", until: now + 60_000 } };
  assert.equal(messageStatusText(working, now), "Working · running a command");
  assert.equal(messageStatusText(working, now + 60_000), "Seen", "an expired Working falls back even if no idle arrived");
  assert.equal(messageStatusText({ ...working, replied: true }, now), "Replied");
});

test("a status event is generic: kind status, working or idle, this workspace; activity frames are not events", () => {
  const event = { version: 1, kind: "status", workspaceId: WS, principalId: AGENT, state: "working", emittedAt: "2026-11-07T00:00:00.000Z" };
  assert.deepEqual(parseAgentStatusEvent(event, WS), { principalId: AGENT, state: "working", emittedAt: Date.parse(event.emittedAt) });
  assert.ok(parseAgentStatusEvent({ ...event, id: "realtime-id" }, WS), "Realtime's own id is allowed");
  for (const bad of [
    { ...event, workspaceId: OTHER_AGENT }, { ...event, state: "editing" }, { ...event, signalId: SIGNAL },
    { ...event, label: "editing" }, { ...event, kind: undefined }, { ...event, version: 2 },
    { version: 1, workspaceId: WS, principalId: AGENT, streamId: SIGNAL, sequence: 1, phase: "prompting", signalId: SIGNAL },
  ]) {
    assert.equal(parseAgentStatusEvent(bad, WS), null);
  }
});

test("only the viewer's latest top-level message to each agent gets a line", () => {
  const signal = (id, at, overrides = {}) => ({
    id, from: VIEWER, fromKind: "user", to: null, toAgent: AGENT, kind: "ask", body: "", about: null, until: null,
    createdAt: at, channelId: null, threadRootId: null, broadcastToChannel: false, ...overrides,
  });
  const older = signal("a0000000-0000-4000-8000-000000000001", "2026-11-07T00:00:00Z");
  const newer = signal("a0000000-0000-4000-8000-000000000002", "2026-11-07T00:01:00Z");
  const toOther = signal("a0000000-0000-4000-8000-000000000003", "2026-11-07T00:00:30Z", { toAgent: OTHER_AGENT });
  const reply = signal("a0000000-0000-4000-8000-000000000004", "2026-11-07T00:02:00Z", { threadRootId: older.id });
  const fromAgent = signal("a0000000-0000-4000-8000-000000000005", "2026-11-07T00:03:00Z", { from: AGENT, fromKind: "agent" });
  const toEveryone = signal("a0000000-0000-4000-8000-000000000006", "2026-11-07T00:04:00Z", { toAgent: null });
  assert.deepEqual(
    latestMessagesToAgents([older, toOther, newer, reply, fromAgent, toEveryone], VIEWER).map((s) => s.id),
    [newer.id, toOther.id],
  );
  assert.deepEqual(latestMessagesToAgents([older], "someone-else"), []);
});
