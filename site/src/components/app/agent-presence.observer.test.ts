import assert from "node:assert/strict";
import { test } from "node:test";
import {
  agentPresenceLine,
  browserAgentPresenceRows,
} from "../../lib/agent-presence.js";

const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

test("the browser renderer escapes hostile client build controls", () => {
  const row = browserAgentPresenceRows([{
    principal_id: PRINCIPAL,
    last_command_at: "2026-09-26T11:48:00.000Z",
    client_build: "0.1.77\n\u001b[31mforged\u202e",
    watcher_at: null,
    channel_at: null,
    listener_at: null,
    turn_at: null,
    last_ack_via: null,
    last_ack_at: null,
    current_client_build: "0.1.77",
  }]).get(PRINCIPAL);
  const line = agentPresenceLine(row, NOW);
  assert.equal(
    line,
    "none · last call: 12m ago · client build: 0.1.77\\n\\u001b[31mforged\\u202e · unknown",
  );
  assert.doesNotMatch(line ?? "", /\u001b|\u202e/);
});
