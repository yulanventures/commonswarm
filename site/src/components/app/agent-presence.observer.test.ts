import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  agentPresenceLine,
  browserAgentPresenceRows,
} from "../../lib/agent-presence.js";

const PRINCIPAL = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-26T12:00:00.000Z");

test("the roster presence adapter renders classifier labels and hides a missing view", () => {
  const rows = browserAgentPresenceRows([{
    principal_id: PRINCIPAL,
    last_command_at: "2026-09-26T11:48:00.000Z",
    client_build: "0.1.76",
    watcher_at: "2026-09-26T11:59:00.000Z",
    channel_at: null,
    listener_at: null,
    turn_at: null,
    last_ack_via: "leased",
    last_ack_at: "2026-09-26T11:58:00.000Z",
    current_client_build: "0.1.77",
  }]);
  assert.equal(
    agentPresenceLine(rows.get(PRINCIPAL), NOW),
    "live watcher · last call: 12m ago · client build: 0.1.76 · update available",
  );
  assert.equal(agentPresenceLine(undefined, NOW), null,
    "a server without the view adds no roster copy");
  assert.equal(
    agentPresenceLine(null, NOW),
    "none · last call: never · client build: unknown",
    "an available view with no seat row is different from a missing view",
  );
});

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

test("the live roster pages presence beside wake-path and ignores either missing view", async () => {
  const dashboard = await readFile(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  const roster = dashboard.slice(
    dashboard.indexOf("const roster = async"),
    dashboard.indexOf("const memberRoster = async"),
  );
  assert.match(roster, /Promise\.all\(\[/);
  assert.match(roster, /\.from\("agent_wake_path"\)/);
  assert.match(roster, /\.from\("agent_presence"\)/);
  assert.match(roster, /\.order\("principal_id", \{ ascending: true \}\)/);
  assert.match(roster, /\.range\(presenceOffset, presenceOffset \+ pageSize - 1\)/);
  assert.match(roster, /presenceOffset \+= pageSize/);
  assert.match(roster, /if \(!wakeRead\.error\)/);
  assert.match(roster, /if \(presenceRead\.available\)/,
    "a missing presence view leaves the base roster and wake mark intact");
  assert.match(dashboard, /const presenceLine = agentPresenceLine\(agent\.presence\)/);

  const mutation = roster.replace(
    "if (presenceRead.available)",
    "if (!presenceRead.available)",
  );
  assert.notEqual(mutation, roster, "the compatibility branch is reached by the mutation");
  assert.doesNotMatch(mutation, /if \(presenceRead\.available\)/);
});
