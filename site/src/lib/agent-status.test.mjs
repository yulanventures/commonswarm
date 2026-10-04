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
  assert.equal(turn.receive, "Checks messages at the start of each turn.");
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
